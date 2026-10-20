-- Alpha Touring Challenge — Kudos: shared highlights from a round
--
-- The positive counterpart to incident reports (0090): signed-in users share
-- a good racing moment (session, lap, turn, the cars involved, an optional
-- description and clip link) from a round's Kudos page
-- (src/pages/results/[subsessionId]/kudos.astro). No steward review, no
-- status and no submission window — every kudos is public the moment it's
-- shared, so anyone can find the moment and watch it back.
--
-- Submission goes through submit_kudos() (SECURITY DEFINER, signed-in users
-- only), which validates the input, keeps kudos + cars atomic, and snapshots
-- the author's name. Unlike submit_incident_report, the name never falls
-- back to the login's email — kudos are public, so an email would leak.
-- The author or an admin can delete a kudos; nobody edits one.

create table if not exists kudos (
  id uuid primary key default gen_random_uuid(),
  subsession_id bigint not null,
  -- Same encoding as incident reports: 'race:N' | 'qualifying:0' | 'practice:0'.
  session text not null,
  lap integer not null check (lap between 0 and 10000),
  turn text not null check (length(turn) between 1 and 80),
  description text check (description is null or length(description) <= 2000),
  -- ~* (case-insensitive): phones often auto-capitalize "Https://".
  clip_url text check (clip_url is null or (length(clip_url) <= 500 and clip_url ~* '^https?://\S+$')),
  author_id uuid not null references auth.users (id) on delete cascade,
  author_name text,
  created_at timestamptz not null default now()
);

create index if not exists kudos_subsession_idx on kudos (subsession_id);
create index if not exists kudos_author_idx on kudos (author_id);

create table if not exists kudos_drivers (
  kudos_id uuid not null references kudos (id) on delete cascade,
  driver_id uuid not null references drivers (id) on delete cascade,
  primary key (kudos_id, driver_id)
);

create index if not exists kudos_drivers_driver_idx on kudos_drivers (driver_id);

alter table kudos enable row level security;
alter table kudos_drivers enable row level security;

drop policy if exists "public read kudos" on kudos;
create policy "public read kudos" on kudos for select using (true);

drop policy if exists "public read kudos_drivers" on kudos_drivers;
create policy "public read kudos_drivers" on kudos_drivers for select using (true);

-- kudos_drivers rows go with their kudos (on delete cascade).
drop policy if exists "author or admin delete kudos" on kudos;
create policy "author or admin delete kudos" on kudos
  for delete using (is_admin() or author_id = (select auth.uid()));

create or replace function public.submit_kudos(
  p_subsession_id bigint,
  p_session text,
  p_lap integer,
  p_turn text,
  p_description text,
  p_clip_url text,
  p_driver_ids uuid[]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_uid uuid := auth.uid();
  v_name text;
  v_clip text := nullif(btrim(coalesce(p_clip_url, '')), '');
begin
  if v_uid is null then raise exception 'sign in to share kudos'; end if;
  if p_session is null or p_session !~ '^(race:[0-9]+|qualifying:0|practice:0)$' then
    raise exception 'invalid session';
  end if;
  if p_lap is null or p_lap < 0 then raise exception 'invalid lap'; end if;
  if coalesce(btrim(p_turn), '') = '' or length(p_turn) > 80 then raise exception 'invalid turn'; end if;
  if p_description is not null and length(p_description) > 2000 then raise exception 'description too long'; end if;
  if v_clip is not null and (length(v_clip) > 500 or v_clip !~* '^https?://\S+$') then
    raise exception 'invalid clip link';
  end if;
  if p_driver_ids is null or cardinality(p_driver_ids) = 0 or cardinality(p_driver_ids) > 100 then
    raise exception 'at least one car is required';
  end if;
  if not exists (select 1 from curated_rounds where subsession_id = p_subsession_id) then
    raise exception 'unknown round';
  end if;
  -- A race session must be one this round actually ran (race_scores has a row
  -- per driver per race), so a direct RPC call can't file 'race:99'.
  if p_session like 'race:%' and not exists (
    select 1 from race_scores
    where subsession_id = p_subsession_id and race_number = split_part(p_session, ':', 2)::int
  ) then
    raise exception 'invalid session';
  end if;
  if p_lap > 10000 then raise exception 'invalid lap'; end if;

  -- Linked driver's name, else display name — never the email (see above).
  select coalesce(d.name, p.display_name) into v_name
  from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
  where u.id = v_uid;

  insert into kudos (subsession_id, session, lap, turn, description, clip_url, author_id, author_name)
  values (p_subsession_id, p_session, p_lap, btrim(p_turn), nullif(btrim(coalesce(p_description, '')), ''), v_clip, v_uid, v_name)
  returning id into v_id;

  -- Only cars that raced in this round (same set as the dialog's picker);
  -- anything else is dropped, and none left aborts the whole kudos.
  insert into kudos_drivers (kudos_id, driver_id)
  select v_id, d.id from drivers d
  where d.id = any (p_driver_ids)
    and exists (select 1 from race_scores rs where rs.subsession_id = p_subsession_id and rs.driver_id = d.id);
  if not found then raise exception 'no valid cars'; end if;

  return v_id;
end;
$$;

revoke all on function public.submit_kudos(bigint, text, integer, text, text, text, uuid[]) from public, anon;
grant execute on function public.submit_kudos(bigint, text, integer, text, text, text, uuid[]) to authenticated;
