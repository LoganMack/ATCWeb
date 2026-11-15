-- Undoes 20261118120000_records_text_polls.sql: restores private.poll_check_payload and public.save_poll as
-- 20261115120001_polls.sql wrote them, drops poll_options.layout_id, poll_sections.text_max_length with
-- their checks, restores the three-type answer check and the table comment, and drops round_best_laps_shown.
--
-- It refuses to run while any Text question or any option with a layout exists, because dropping the columns
-- would silently lose them: change those questions to another type, or those options to Text, in the poll
-- editor (or delete the draft polls) first. Revert the site code first, so nothing reads the view or sends
-- the new fields.

do $$
declare
  v_text integer := (select count(*) from public.poll_sections where answer_type = 'text');
  v_layout integer := (select count(*) from public.poll_options where layout_id is not null);
begin
  if v_text > 0 or v_layout > 0 then
    raise exception 'Refusing to undo 20261118120000_records_text_polls: remove % Text question(s) and % option(s) with a layout first',
      v_text, v_layout;
  end if;
end $$;

create or replace function private.poll_check_payload(p_poll_id uuid, p_poll jsonb, p_stored_closes_at timestamptz)
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

  -- The type is checked before the length: jsonb_array_length raises on a non-array, and OR does not
  -- promise to stop at the first true operand.
  v_sections := p_poll -> 'sections';
  if v_sections is null or jsonb_typeof(v_sections) <> 'array' then
    raise exception 'invalid:sections:count' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_sections) not between 1 and 20 then
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
    if v_options is null or jsonb_typeof(v_options) <> 'array' then
      raise exception 'invalid:%.options:count', v_field using errcode = 'P0001';
    end if;
    if jsonb_array_length(v_options) not between v_min and 30 then
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

create or replace function public.save_poll(p_poll_id uuid, p_expected_updated_at timestamptz, p_poll jsonb)
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

drop index public.poll_options_layout_id_idx;
alter table public.poll_options drop constraint poll_options_layout_or_image_check;
alter table public.poll_options drop column layout_id;

alter table public.poll_sections drop constraint poll_sections_text_max_length_type_check;
alter table public.poll_sections drop constraint poll_sections_text_max_length_check;
alter table public.poll_sections drop constraint poll_sections_answer_type_check;
alter table public.poll_sections
  add constraint poll_sections_answer_type_check check (answer_type in ('single', 'multiple', 'stars'));
alter table public.poll_sections drop column text_max_length;

comment on table public.poll_sections is
  'One question of a poll with its answer type: single (Pick one), multiple (Pick several) or stars (1-5).';

drop view public.round_best_laps_shown;
