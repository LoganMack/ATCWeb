-- Computed track records and Text poll questions with Circuits options (intent 261115-records-nav-polls;
-- FR1, FR5, FR6, NFR1, NFR3, NFR4; rules BR1.1, BR1.3, BR1.9, BR5.1, BR5.2, BR6.3, BR6.4).
--
-- What:
--   1. public.round_best_laps_shown: the fastest lap of each round within each class, one row per
--      (subsession, class), with the class empty for a result that has no scored class. It reads the masked
--      curated_race_results_shown, so a hidden driver is "Hidden Driver" with a stand-in cust_id, takes the
--      class from race_score_results (joined on subsession, race and driver, so a multi-race round never
--      repeats a result) and the track, layout and start time from curated_rounds. Rounds flagged exhibition
--      or test in round_overrides and laps that are empty or zero are left out. Ties go to the lower race
--      number, then the lower finish position.
--   2. poll_sections.text_max_length (1-500), set exactly when the answer type is the new 'text'.
--   3. poll_options.layout_id, a Circuits pick (on delete set null), never together with an uploaded image.
--   4. private.poll_check_payload and public.save_poll replaced with the same signatures: a Text question has
--      a max length and no options; an option's layout must exist, appear once per question and never come
--      with an image. Refusals use the existing invalid:<field>:<reason> codes (text_max_length:range,
--      layout:foreign, layout:duplicate, layout:image).
--
-- Why: track records were typed by hand and went stale; pages now compute them from league laps, and this
-- view gives them one small row set instead of every race result (NFR1: Workers Free CPU budget). It runs as
-- its owner like the other _shown views, so hidden-driver masking comes from the results view and is never
-- redone. Per-question layout uniqueness is checked in save_poll under the poll row lock, as duplicate names
-- are, because a unique index cannot be deferred and would refuse a swap of two rows' layouts mid-save.
--
-- Expand only: a new view, two nullable columns and widened checks. A payload without the new fields (the
-- code on main) validates and saves exactly as before. Undo with
-- supabase/down/20261118120000_records_text_polls.down.sql, which refuses while Text questions or Circuits
-- options exist.

-- 1. Round best laps (BR1.1, BR1.3, BR1.9) ------------------------------------------------------------------

create view public.round_best_laps_shown with (security_invoker = false, security_barrier = true) as
select distinct on (r.subsession_id, s.class_id)
  r.subsession_id,
  s.class_id,
  r.best_lap_ten_thousandths,
  r.race_number,
  r.finish_position,
  r.cust_id,
  r.roster_driver_id,
  r.display_name,
  r.car_name,
  cr.track_name,
  cr.layout,
  cr.start_time
from public.curated_race_results_shown r
join public.curated_rounds cr on cr.subsession_id = r.subsession_id
left join public.race_score_results s
  on s.subsession_id = r.subsession_id
  and s.race_number = r.race_number
  and s.driver_id = r.roster_driver_id
where r.best_lap_ten_thousandths > 0
  and not exists (
    select 1 from public.round_overrides o
    where o.subsession_id = r.subsession_id and (o.is_exhibition or o.is_test)
  )
order by r.subsession_id, s.class_id, r.best_lap_ten_thousandths, r.race_number, r.finish_position;

comment on view public.round_best_laps_shown is
  'Fastest lap per round and class (class null = no scored class) from the masked race results; exhibition '
  'and test rounds and empty laps left out. Pages build track records from it.';

revoke all on table public.round_best_laps_shown from public, anon, authenticated;
grant select on table public.round_best_laps_shown to anon, authenticated;

-- 2. Text questions (BR5.1, BR5.2) ---------------------------------------------------------------------------

alter table public.poll_sections add column text_max_length integer;

alter table public.poll_sections drop constraint poll_sections_answer_type_check;
alter table public.poll_sections
  add constraint poll_sections_answer_type_check check (answer_type in ('single', 'multiple', 'stars', 'text'));
alter table public.poll_sections
  add constraint poll_sections_text_max_length_check check (text_max_length between 1 and 500);
alter table public.poll_sections
  add constraint poll_sections_text_max_length_type_check check ((answer_type = 'text') = (text_max_length is not null));

comment on table public.poll_sections is
  'One question of a poll with its answer type: single (Pick one), multiple (Pick several), stars (1-5) or '
  'text (a free answer of at most text_max_length characters, with no options).';

-- 3. Circuits options (BR6.3, BR6.5) -------------------------------------------------------------------------

alter table public.poll_options
  add column layout_id uuid references public.circuit_layouts (id) on delete set null;
alter table public.poll_options
  add constraint poll_options_layout_or_image_check check (layout_id is null or image_path is null);

create index poll_options_layout_id_idx on public.poll_options (layout_id);

-- 4. Validation and save (BR5.1, BR5.2, BR6.3, BR6.4) --------------------------------------------------------
-- Copied from 20261115120001_polls.sql; the changes are the text answer type, text_max_length and layout_id.

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
  v_layouts uuid[];
  v_section_ids uuid[] := '{}';
  v_option_ids uuid[] := '{}';
  v_id uuid;
  v_min integer;
  v_max integer;
  v_is_text boolean;
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
    if coalesce(v_section ->> 'answer_type', '') not in ('single', 'multiple', 'stars', 'text') then
      raise exception 'invalid:%.answer_type:value', v_field using errcode = 'P0001';
    end if;
    v_is_text := v_section ->> 'answer_type' = 'text';

    -- A Text question needs a whole number from 1 to 500; other types ignore the field (BR5.1). The shape
    -- is checked before the cast, because OR does not promise to stop at the first true operand.
    if v_is_text then
      v_text := v_section ->> 'text_max_length';
      if jsonb_typeof(v_section -> 'text_max_length') is distinct from 'number' or v_text !~ '^[0-9]{1,3}$' then
        raise exception 'invalid:%.text_max_length:range', v_field using errcode = 'P0001';
      end if;
      if v_text::integer not between 1 and 500 then
        raise exception 'invalid:%.text_max_length:range', v_field using errcode = 'P0001';
      end if;
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

    -- A Text question takes no options (missing counts as none); the others keep their counts (BR5.2).
    v_options := v_section -> 'options';
    if v_is_text and v_options is null then
      v_options := '[]'::jsonb;
    end if;
    v_min := case v_section ->> 'answer_type' when 'text' then 0 when 'stars' then 1 else 2 end;
    v_max := case when v_is_text then 0 else 30 end;
    if v_options is null or jsonb_typeof(v_options) <> 'array' then
      raise exception 'invalid:%.options:count', v_field using errcode = 'P0001';
    end if;
    if jsonb_array_length(v_options) not between v_min and v_max then
      raise exception 'invalid:%.options:count', v_field using errcode = 'P0001';
    end if;

    v_names := '{}';
    v_layouts := '{}';
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

      -- A Circuits pick: an existing layout, once per question, with no uploaded image (BR6.3, BR6.4).
      v_text := nullif(v_option ->> 'layout_id', '');
      if v_text is not null then
        if v_text !~ v_uuid then
          raise exception 'invalid:%.layout:foreign', v_field using errcode = 'P0001';
        end if;
        v_id := v_text::uuid;
        if not exists (select 1 from public.circuit_layouts l where l.id = v_id) then
          raise exception 'invalid:%.layout:foreign', v_field using errcode = 'P0001';
        end if;
        if v_id = any (v_layouts) then
          raise exception 'invalid:%.layout:duplicate', v_field using errcode = 'P0001';
        end if;
        if nullif(v_option ->> 'image_path', '') is not null then
          raise exception 'invalid:%.layout:image', v_field using errcode = 'P0001';
        end if;
        v_layouts := v_layouts || v_id;
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
  v_options jsonb;
  v_section_id uuid;
  v_option_id uuid;
  v_max_length integer;
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
    -- Stored only for Text, so the table's type check holds whatever else the payload carries.
    v_max_length := case when v_section ->> 'answer_type' = 'text'
                         then (v_section ->> 'text_max_length')::integer end;
    if v_section_id is null then
      insert into public.poll_sections (poll_id, name, answer_type, text_max_length, position)
      values (p_poll_id, private.poll_trim(v_section ->> 'name'), v_section ->> 'answer_type', v_max_length, i)
      returning id into v_section_id;
    else
      update public.poll_sections set
        name = private.poll_trim(v_section ->> 'name'),
        answer_type = v_section ->> 'answer_type',
        text_max_length = v_max_length,
        position = i
      where id = v_section_id and poll_id = p_poll_id;
    end if;
    v_kept_sections := v_kept_sections || v_section_id;

    v_options := coalesce(v_section -> 'options', '[]'::jsonb);
    for j in 0 .. jsonb_array_length(v_options) - 1 loop
      v_option := v_options -> j;
      v_option_id := nullif(v_option ->> 'id', '')::uuid;
      if v_option_id is null then
        insert into public.poll_options (section_id, name, image_path, layout_id, position)
        values (v_section_id, private.poll_trim(v_option ->> 'name'), nullif(v_option ->> 'image_path', ''),
                nullif(v_option ->> 'layout_id', '')::uuid, j)
        returning id into v_option_id;
      else
        update public.poll_options set
          section_id = v_section_id,
          name = private.poll_trim(v_option ->> 'name'),
          image_path = nullif(v_option ->> 'image_path', ''),
          layout_id = nullif(v_option ->> 'layout_id', '')::uuid,
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
  'ids from another poll and anything the rules refuse (including a Text question''s max length and a '
  'layout picked twice in one question); returns the image paths no longer referenced.';

-- create or replace keeps the grants; restated so the file stands on its own.
revoke all on function private.poll_check_payload(uuid, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.save_poll(uuid, timestamptz, jsonb) from public, anon;
grant execute on function public.save_poll(uuid, timestamptz, jsonb) to authenticated;
