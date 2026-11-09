-- Polls: admin-authored polls with sections, options and option images (polls unit U2; FR1.1-FR1.11, NFR3;
-- rules BR1.1-BR6.1; ADR-005, ADR-010).
--
-- What:
--   1. public.polls, public.poll_sections and public.poll_options. Positions are unique per poll and per
--      section through constraints deferred to commit, so one save can swap or reorder rows. Option names
--      are unique per section ignoring case, checked by save_poll under the poll row lock (a unique index
--      cannot be deferred, so it would refuse a rename swap).
--   2. Row Level Security: everyone reads posted polls with their sections and options; drafts are read only
--      by full admins. Table grants are select only, and polls.created_by is left out of the column grant.
--   3. private.poll_has_votes(): always false until the voting PR replaces its body (BR5.3).
--   4. public.create_poll, save_poll, set_poll_posted and delete_poll: SECURITY DEFINER, full admins only
--      (private.is_full_admin(); private.is_admin() is also true for Staff). save_poll locks the poll row,
--      refuses a stale editor, validates the whole payload, writes it and returns the image paths it no
--      longer references, so the caller can delete those files.
--   5. The public poll-images bucket (PNG, JPEG, WebP, 5 MB) with write, delete and list for full admins.
--
-- Why in the database: who may write a poll, what a valid poll is and when it may be posted or deleted are
-- access and business rules (team rule), so they hold whatever the page sends. Refusals raise a stable
-- message with errcode P0001 that src/lib/db/polls.ts maps to friendly text: not_allowed, not_found,
-- invalid:<field>:<reason>, stale, closing_passed, posted_cannot_delete, locked_by_votes.
--
-- Contracts for later units: U3's schedule-vote notification trigger fires on the change into posted with
-- is_schedule_vote (compare OLD and NEW, as save_poll and set_poll_posted update the row) and references
-- polls(id) on delete cascade (BR6.1). The voting PR's vote cast takes `for share` on the poll row, so no
-- vote lands between save_poll's lock check and its writes (BR5.3).
--
-- Expand only: new tables, functions, a bucket and its policies; nothing existing changes, so the code on
-- main keeps working. Undo with supabase/down/20261115120001_polls.down.sql (empty the bucket first).

-- 1. Tables (BR1.1-BR1.4, BR2.1-BR2.3) ---------------------------------------------------------------------

create table public.polls (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  closes_at timestamptz,
  is_schedule_vote boolean not null default false,
  status text not null default 'draft',
  posted_at timestamptz,
  first_posted_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint polls_title_check check (char_length(title) between 1 and 120 and title = btrim(title)),
  constraint polls_description_check check (
    description is null or (char_length(description) between 1 and 2000 and description = btrim(description))
  ),
  constraint polls_status_check check (status in ('draft', 'posted')),
  constraint polls_posted_at_check check ((status = 'posted') = (posted_at is not null)),
  constraint polls_first_posted_at_check check (status <> 'posted' or first_posted_at is not null)
);

comment on table public.polls is
  'Admin-authored polls (polls U2). Written only through create_poll, save_poll, set_poll_posted and delete_poll.';

create index polls_created_at_idx on public.polls (created_at desc);
create index polls_created_by_idx on public.polls (created_by);

create table public.poll_sections (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls (id) on delete cascade,
  name text not null,
  answer_type text not null,
  position integer not null,
  constraint poll_sections_name_check check (char_length(name) between 1 and 120 and name = btrim(name)),
  constraint poll_sections_answer_type_check check (answer_type in ('single', 'multiple', 'stars')),
  constraint poll_sections_position_check check (position >= 0),
  constraint poll_sections_position_key unique (poll_id, position) deferrable initially deferred
);

comment on table public.poll_sections is
  'One question of a poll with its answer type: single (Pick one), multiple (Pick several) or stars (1-5).';

create table public.poll_options (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.poll_sections (id) on delete cascade,
  name text not null,
  image_path text,
  position integer not null,
  constraint poll_options_name_check check (char_length(name) between 1 and 120 and name = btrim(name)),
  -- The shape only; save_poll checks that the folder is this option's own poll (BR4.3).
  constraint poll_options_image_path_check check (
    image_path is null
    or image_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]+-[0-9]+\.(png|jpg|webp)$'
  ),
  constraint poll_options_position_check check (position >= 0),
  constraint poll_options_position_key unique (section_id, position) deferrable initially deferred
);

comment on table public.poll_options is
  'One option of a poll section, with an optional image stored as a path in the poll-images bucket.';

-- 2. Reads (BR5.1, BR5.2) ------------------------------------------------------------------------------------

alter table public.polls enable row level security;
alter table public.poll_sections enable row level security;
alter table public.poll_options enable row level security;

create policy polls_select on public.polls
  for select to anon, authenticated
  using (status = 'posted' or (select private.is_full_admin()));

create policy poll_sections_select on public.poll_sections
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.polls p
      where p.id = poll_sections.poll_id and (p.status = 'posted' or (select private.is_full_admin()))
    )
  );

create policy poll_options_select on public.poll_options
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.poll_sections s
      join public.polls p on p.id = s.poll_id
      where s.id = poll_options.section_id and (p.status = 'posted' or (select private.is_full_admin()))
    )
  );

-- Supabase grants every new public table to anon and authenticated by default, so start from nothing.
revoke all on table public.polls, public.poll_sections, public.poll_options from public, anon, authenticated;
grant select (id, title, description, closes_at, is_schedule_vote, status, posted_at, first_posted_at,
              created_at, updated_at)
  on table public.polls to anon, authenticated;
grant select on table public.poll_sections, public.poll_options to anon, authenticated;

-- 3. The vote lock (BR5.3) -----------------------------------------------------------------------------------

create function private.poll_has_votes(p_poll_id uuid) returns boolean
  language sql stable
  set search_path = ''
  as $$ select false; $$;

comment on function private.poll_has_votes(uuid) is
  'True once a poll has votes, which locks its sections, options and answer types (BR5.3). Always false until '
  'the voting PR replaces this body; casting a vote must take FOR SHARE on the poll row.';

revoke all on function private.poll_has_votes(uuid) from public, anon, authenticated;

-- Leading and trailing whitespace removed, as the editor's trim() does.
create function private.poll_trim(p_text text) returns text
  language sql immutable
  set search_path = ''
  as $$ select regexp_replace(coalesce(p_text, ''), '^\s+|\s+$', '', 'g'); $$;

revoke all on function private.poll_trim(text) from public, anon, authenticated;

-- 4. Validation of a save_poll payload (BR1.1-BR1.3, BR2.4, BR4.3, BR5.6) -------------------------------------
-- Raises invalid:<field>:<reason> for the first problem; fields are 1-based, e.g. section.2.option.3.name.

create function private.poll_check_payload(p_poll_id uuid, p_poll jsonb, p_stored_closes_at timestamptz)
  returns void
  language plpgsql stable
  set search_path = ''
  as $$
declare
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_image constant text := '^' || p_poll_id::text || '/[A-Za-z0-9_-]+-[0-9]+\.(png|jpg|webp)$';
  v_sections jsonb;
  v_section jsonb;
  v_options jsonb;
  v_option jsonb;
  v_closes timestamptz;
  v_text text;
  v_field text;
  v_names text[];
  v_section_ids uuid[] := '{}';
  v_option_ids uuid[] := '{}';
  v_id uuid;
  v_min integer;
begin
  if p_poll is null or jsonb_typeof(p_poll) <> 'object' then
    raise exception 'invalid:poll:format' using errcode = 'P0001';
  end if;

  if char_length(private.poll_trim(p_poll ->> 'title')) not between 1 and 120 then
    raise exception 'invalid:title:length' using errcode = 'P0001';
  end if;
  if char_length(private.poll_trim(p_poll ->> 'description')) > 2000 then
    raise exception 'invalid:description:length' using errcode = 'P0001';
  end if;
  if coalesce(jsonb_typeof(p_poll -> 'is_schedule_vote'), 'null') not in ('boolean', 'null') then
    raise exception 'invalid:is_schedule_vote:format' using errcode = 'P0001';
  end if;

  if coalesce(p_poll ->> 'closes_at', '') <> '' then
    begin
      v_closes := (p_poll ->> 'closes_at')::timestamptz;
    exception when others then
      raise exception 'invalid:closes_at:format' using errcode = 'P0001';
    end;
    -- An unchanged closing date that has since passed is kept (BR2.4).
    if v_closes is distinct from p_stored_closes_at and v_closes <= now() then
      raise exception 'invalid:closes_at:past' using errcode = 'P0001';
    end if;
  end if;

  v_sections := p_poll -> 'sections';
  if v_sections is null or jsonb_typeof(v_sections) <> 'array'
     or jsonb_array_length(v_sections) not between 1 and 20 then
    raise exception 'invalid:sections:count' using errcode = 'P0001';
  end if;

  for i in 0 .. jsonb_array_length(v_sections) - 1 loop
    v_section := v_sections -> i;
    v_field := 'section.' || (i + 1);
    if jsonb_typeof(v_section) <> 'object' then
      raise exception 'invalid:%:format', v_field using errcode = 'P0001';
    end if;
    if char_length(private.poll_trim(v_section ->> 'name')) not between 1 and 120 then
      raise exception 'invalid:%.name:length', v_field using errcode = 'P0001';
    end if;
    if coalesce(v_section ->> 'answer_type', '') not in ('single', 'multiple', 'stars') then
      raise exception 'invalid:%.answer_type:value', v_field using errcode = 'P0001';
    end if;

    v_text := nullif(v_section ->> 'id', '');
    if v_text is not null then
      if v_text !~ v_uuid then
        raise exception 'invalid:%.id:format', v_field using errcode = 'P0001';
      end if;
      v_id := v_text::uuid;
      if v_id = any (v_section_ids) then
        raise exception 'invalid:%.id:duplicate', v_field using errcode = 'P0001';
      end if;
      if not exists (select 1 from public.poll_sections s where s.id = v_id and s.poll_id = p_poll_id) then
        raise exception 'invalid:%.id:foreign', v_field using errcode = 'P0001';
      end if;
      v_section_ids := v_section_ids || v_id;
    end if;

    v_options := v_section -> 'options';
    v_min := case when v_section ->> 'answer_type' = 'stars' then 1 else 2 end;
    if v_options is null or jsonb_typeof(v_options) <> 'array'
       or jsonb_array_length(v_options) not between v_min and 30 then
      raise exception 'invalid:%.options:count', v_field using errcode = 'P0001';
    end if;

    v_names := '{}';
    for j in 0 .. jsonb_array_length(v_options) - 1 loop
      v_option := v_options -> j;
      v_field := 'section.' || (i + 1) || '.option.' || (j + 1);
      if jsonb_typeof(v_option) <> 'object' then
        raise exception 'invalid:%:format', v_field using errcode = 'P0001';
      end if;
      v_text := private.poll_trim(v_option ->> 'name');
      if char_length(v_text) not between 1 and 120 then
        raise exception 'invalid:%.name:length', v_field using errcode = 'P0001';
      end if;
      if lower(v_text) = any (v_names) then
        raise exception 'invalid:%.name:duplicate', v_field using errcode = 'P0001';
      end if;
      v_names := v_names || lower(v_text);

      v_text := nullif(v_option ->> 'id', '');
      if v_text is not null then
        if v_text !~ v_uuid then
          raise exception 'invalid:%.id:format', v_field using errcode = 'P0001';
        end if;
        v_id := v_text::uuid;
        if v_id = any (v_option_ids) then
          raise exception 'invalid:%.id:duplicate', v_field using errcode = 'P0001';
        end if;
        if not exists (
          select 1 from public.poll_options o
          join public.poll_sections s on s.id = o.section_id
          where o.id = v_id and s.poll_id = p_poll_id
        ) then
          raise exception 'invalid:%.id:foreign', v_field using errcode = 'P0001';
        end if;
        v_option_ids := v_option_ids || v_id;
      end if;

      v_text := nullif(v_option ->> 'image_path', '');
      if v_text is not null and v_text !~ v_image then
        raise exception 'invalid:%.image:path', v_field using errcode = 'P0001';
      end if;
    end loop;
  end loop;
end;
$$;

revoke all on function private.poll_check_payload(uuid, jsonb, timestamptz) from public, anon, authenticated;

-- The poll's questions and options as one string (ids, answer types and order), for the vote lock.
create function private.poll_structure(p_poll_id uuid) returns text
  language sql stable
  set search_path = ''
  as $$
  select coalesce(string_agg(s.id::text || ':' || s.answer_type || '[' || coalesce((
    select string_agg(o.id::text, ',' order by o.position) from public.poll_options o where o.section_id = s.id
  ), '') || ']', ';' order by s.position), '')
  from public.poll_sections s
  where s.poll_id = p_poll_id;
$$;

revoke all on function private.poll_structure(uuid) from public, anon, authenticated;

-- The same string built from a payload; a new section or option (no id) never matches a stored one.
create function private.poll_payload_structure(p_poll jsonb) returns text
  language sql immutable
  set search_path = ''
  as $$
  select coalesce(string_agg(coalesce(nullif(s.value ->> 'id', ''), 'new') || ':' || (s.value ->> 'answer_type')
    || '[' || coalesce((
      select string_agg(coalesce(nullif(o.value ->> 'id', ''), 'new'), ',' order by o.ordinality)
      from jsonb_array_elements(s.value -> 'options') with ordinality o
    ), '') || ']', ';' order by s.ordinality), '')
  from jsonb_array_elements(p_poll -> 'sections') with ordinality s;
$$;

revoke all on function private.poll_payload_structure(jsonb) from public, anon, authenticated;

-- 5. Writes (BR2.1-BR2.5, BR5.1, BR5.3, BR5.5, BR5.6) -----------------------------------------------------------

create function public.create_poll(p_title text) returns uuid
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_title text := private.poll_trim(p_title);
  v_id uuid;
begin
  if not private.is_full_admin() then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if char_length(v_title) not between 1 and 120 then
    raise exception 'invalid:title:length' using errcode = 'P0001';
  end if;
  insert into public.polls (title, created_by) values (v_title, (select auth.uid())) returning id into v_id;
  return v_id;
end;
$$;

comment on function public.create_poll(text) is
  'Full admins: a new draft poll with this title and no sections, so images can be uploaded under its id.';

revoke all on function public.create_poll(text) from public, anon;
grant execute on function public.create_poll(text) to authenticated;

create function public.save_poll(p_poll_id uuid, p_expected_updated_at timestamptz, p_poll jsonb)
  returns text[]
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_poll public.polls%rowtype;
  v_old_paths text[];
  v_sections jsonb;
  v_section jsonb;
  v_option jsonb;
  v_section_id uuid;
  v_option_id uuid;
  v_kept_sections uuid[] := '{}';
  v_kept_options uuid[] := '{}';
  v_description text;
  v_unused text[];
begin
  if not private.is_full_admin() then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;

  -- The row lock serialises saves, posts and (later) votes on this poll.
  select * into v_poll from public.polls p where p.id = p_poll_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_poll.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale' using errcode = 'P0001';
  end if;

  perform private.poll_check_payload(p_poll_id, p_poll, v_poll.closes_at);

  if private.poll_has_votes(p_poll_id)
     and private.poll_structure(p_poll_id) <> private.poll_payload_structure(p_poll) then
    raise exception 'locked_by_votes' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(o.image_path), '{}') into v_old_paths
  from public.poll_options o
  join public.poll_sections s on s.id = o.section_id
  where s.poll_id = p_poll_id and o.image_path is not null;

  v_description := nullif(private.poll_trim(p_poll ->> 'description'), '');
  update public.polls set
    title = private.poll_trim(p_poll ->> 'title'),
    description = v_description,
    closes_at = nullif(p_poll ->> 'closes_at', '')::timestamptz,
    is_schedule_vote = coalesce((p_poll ->> 'is_schedule_vote')::boolean, false),
    updated_at = now()
  where id = p_poll_id;

  -- Positions follow the payload order (BR1.4); the deferred unique constraints allow swaps.
  v_sections := p_poll -> 'sections';
  for i in 0 .. jsonb_array_length(v_sections) - 1 loop
    v_section := v_sections -> i;
    v_section_id := nullif(v_section ->> 'id', '')::uuid;
    if v_section_id is null then
      insert into public.poll_sections (poll_id, name, answer_type, position)
      values (p_poll_id, private.poll_trim(v_section ->> 'name'), v_section ->> 'answer_type', i)
      returning id into v_section_id;
    else
      update public.poll_sections set
        name = private.poll_trim(v_section ->> 'name'),
        answer_type = v_section ->> 'answer_type',
        position = i
      where id = v_section_id and poll_id = p_poll_id;
    end if;
    v_kept_sections := v_kept_sections || v_section_id;

    for j in 0 .. jsonb_array_length(v_section -> 'options') - 1 loop
      v_option := v_section -> 'options' -> j;
      v_option_id := nullif(v_option ->> 'id', '')::uuid;
      if v_option_id is null then
        insert into public.poll_options (section_id, name, image_path, position)
        values (v_section_id, private.poll_trim(v_option ->> 'name'), nullif(v_option ->> 'image_path', ''), j)
        returning id into v_option_id;
      else
        update public.poll_options set
          section_id = v_section_id,
          name = private.poll_trim(v_option ->> 'name'),
          image_path = nullif(v_option ->> 'image_path', ''),
          position = j
        where id = v_option_id;
      end if;
      v_kept_options := v_kept_options || v_option_id;
    end loop;
  end loop;

  delete from public.poll_options o
  using public.poll_sections s
  where s.id = o.section_id and s.poll_id = p_poll_id and o.id <> all (v_kept_options);
  delete from public.poll_sections s where s.poll_id = p_poll_id and s.id <> all (v_kept_sections);

  -- Files the poll no longer points at; the caller deletes them (BR4.2).
  select coalesce(array_agg(distinct p.path), '{}') into v_unused
  from unnest(v_old_paths) as p (path)
  where not exists (
    select 1 from public.poll_options o
    join public.poll_sections s on s.id = o.section_id
    where s.poll_id = p_poll_id and o.image_path = p.path
  );
  return v_unused;
end;
$$;

comment on function public.save_poll(uuid, timestamptz, jsonb) is
  'Full admins: replace a poll''s fields, sections and options in one transaction. Refuses a stale editor, '
  'ids from another poll and anything the rules refuse; returns the image paths no longer referenced.';

revoke all on function public.save_poll(uuid, timestamptz, jsonb) from public, anon;
grant execute on function public.save_poll(uuid, timestamptz, jsonb) to authenticated;

create function public.set_poll_posted(p_poll_id uuid, p_posted boolean) returns void
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_poll public.polls%rowtype;
begin
  if not private.is_full_admin() then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  select * into v_poll from public.polls p where p.id = p_poll_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if coalesce(p_posted, false) then
    if v_poll.status = 'posted' then
      return;
    end if;
    if v_poll.closes_at is not null and v_poll.closes_at <= now() then
      raise exception 'closing_passed' using errcode = 'P0001';
    end if;
    -- A draft whose first save never landed has no sections, and a poll needs at least one (BR1.2).
    if not exists (select 1 from public.poll_sections s where s.poll_id = p_poll_id) then
      raise exception 'invalid:sections:count' using errcode = 'P0001';
    end if;
    update public.polls set
      status = 'posted',
      posted_at = now(),
      first_posted_at = coalesce(first_posted_at, now())
    where id = p_poll_id;
  else
    if v_poll.status = 'draft' then
      return;
    end if;
    update public.polls set status = 'draft', posted_at = null where id = p_poll_id;
  end if;
end;
$$;

comment on function public.set_poll_posted(uuid, boolean) is
  'Full admins: Post (refused once the closing date has passed) or Unpost a poll. first_posted_at is set once.';

revoke all on function public.set_poll_posted(uuid, boolean) from public, anon;
grant execute on function public.set_poll_posted(uuid, boolean) to authenticated;

create function public.delete_poll(p_poll_id uuid) returns void
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_status text;
begin
  if not private.is_full_admin() then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  select p.status into v_status from public.polls p where p.id = p_poll_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status = 'posted' then
    raise exception 'posted_cannot_delete' using errcode = 'P0001';
  end if;
  delete from public.polls where id = p_poll_id;
end;
$$;

comment on function public.delete_poll(uuid) is
  'Full admins: delete a draft poll with its sections and options. The caller then clears its image folder.';

revoke all on function public.delete_poll(uuid) from public, anon;
grant execute on function public.delete_poll(uuid) to authenticated;

-- 6. Option images (BR4.1-BR4.3) ------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('poll-images', 'poll-images', true, 5242880, '{image/png,image/jpeg,image/webp}'::text[])
on conflict (id) do update set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public files are read by URL without a policy; listing, writing and deleting are for full admins, and new
-- files must sit at <poll id>/<name>-<timestamp>.<ext>.
create policy "full admin upload poll images" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'poll-images'
    and private.is_full_admin()
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]+-[0-9]+\.(png|jpg|webp)$'
  );

create policy "full admin replace poll images" on storage.objects
  for update to authenticated
  using (bucket_id = 'poll-images' and private.is_full_admin())
  with check (
    bucket_id = 'poll-images'
    and private.is_full_admin()
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]+-[0-9]+\.(png|jpg|webp)$'
  );

create policy "full admin delete poll images" on storage.objects
  for delete to authenticated
  using (bucket_id = 'poll-images' and private.is_full_admin());

create policy "full admin read poll images" on storage.objects
  for select to authenticated
  using (bucket_id = 'poll-images' and private.is_full_admin());
