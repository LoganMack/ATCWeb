-- Alpha Touring Challenge — Sync Results with Roster, moved server-side
--
-- The Drivers admin page's "Sync Results with Roster" button (see
-- src/lib/raceResultsImport.ts's syncResultsWithRoster) originally did its
-- work entirely from the Worker: page through ALL of curated_race_results
-- (a couple thousand rows even a season or two in), then issue one
-- create/update REST call per unrostered driver found. Every one of those
-- is a subrequest against Cloudflare's per-invocation subrequest limit
-- (https://developers.cloudflare.com/workers/wrangler/configuration/#limits
-- — 50 on a Free plan, and not something a config change alone can raise
-- past that) — a single click could burn through dozens of them just
-- paging the results table, then more per driver created/linked, and
-- Logan hit "Too many subrequests by single Worker invocation" running it
-- for real.
--
-- Folding the whole thing into one Postgres function collapses that down
-- to exactly ONE subrequest (one POST to /rest/v1/rpc/sync_results_with_
-- roster) no matter how much data or how many drivers it touches — same
-- "do the heavy lifting in the database, call it opportunistically from
-- the Worker" pattern already used by recalculate_race_scores(),
-- sync_driver_statuses(), and sync_rookie_status().
--
-- This also fixes a real correctness gap in the original version: it never
-- excluded exhibition rounds/seasons, so AI drivers and one-off exhibition
-- entrants (Logan: "sometimes those include AI drivers") were fair game to
-- get synced in as fake roster entries. This version applies the exact
-- same two-tier exhibition rule the rest of the app already uses —
-- round_overrides.is_exhibition (see 0005_round_overrides.sql) for a
-- flagged round inside an otherwise-real season, and curated_rounds.
-- season_label not matching the ATCxx pattern (see results.ts's
-- isChampionshipSeason()) for a whole non-championship season — a round
-- with no season_label at all is treated as NOT exhibition-via-season,
-- same as isChampionshipSeason()'s own null-handling, so it's only ever
-- excluded if round_overrides explicitly flags it.
create or replace function public.sync_results_with_roster()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_default_class_id integer;
  v_new_status_id     integer;
  v_created           text[] := '{}';
  v_linked            text[] := '{}';
  v_entrant           record;
  v_match_count        integer;
  v_match_id           uuid;
  v_match_name         text;
  v_created_name       text;
begin
  if not is_admin() then
    raise exception 'Only an admin can sync results with the roster'
      using errcode = 'insufficient_privilege';
  end if;

  -- Same defaults the admin New Driver form itself falls back to: lowest
  -- sort_order class (Alpha), and the "New" status — which self-corrects to
  -- Active/Veteran/Inactive the next time sync_driver_statuses() runs
  -- (opportunistically, on every Drivers admin page load) now that this
  -- driver has real race history reachable via their iracing_cust_id.
  select id into v_default_class_id from public.driver_classes order by sort_order asc limit 1;
  select id into v_new_status_id from public.driver_statuses where name = 'New';
  if v_default_class_id is null or v_new_status_id is null then
    raise exception 'driver_classes/driver_statuses is missing required rows';
  end if;

  -- Every cust_id that raced in a real, non-exhibition round but has no
  -- drivers row with a matching iracing_cust_id — this is the join
  -- recalculate_race_scores() itself needs (see 0045_team_rosters_in_
  -- scoring.sql's entrant CTE) in order to score them at all. One
  -- representative display_name per cust_id — their most recent result's
  -- name, in case it changed between imports (e.g. an iRacing name change).
  for v_entrant in
    select
      rr.cust_id,
      (array_agg(rr.display_name order by rr.subsession_id desc))[1] as display_name
    from public.curated_race_results rr
    join public.curated_rounds cr on cr.subsession_id = rr.subsession_id
    where (cr.season_label is null or cr.season_label ~* '^ATC[0-9]+$')
      and not exists (
        select 1 from public.round_overrides ro
        where ro.subsession_id = rr.subsession_id and ro.is_exhibition
      )
      and not exists (
        select 1 from public.drivers d where d.iracing_cust_id = rr.cust_id
      )
    group by rr.cust_id
  loop
    -- Link onto an existing driver only when EXACTLY one candidate matches
    -- by exact (case-insensitive, trimmed) name and doesn't already have a
    -- cust_id of their own — ambiguous (0 or 2+ matches) falls through to
    -- creating a new row instead, same as the original client-side version.
    -- A driver just linked earlier in this same loop naturally won't match
    -- again here (their iracing_cust_id is no longer null), so two
    -- different unrostered cust_ids sharing a display_name can never both
    -- link onto the same driver.
    select count(*) into v_match_count
    from public.drivers d
    where d.iracing_cust_id is null
      and lower(trim(d.name)) = lower(trim(v_entrant.display_name));

    if v_match_count = 1 then
      select d.id, d.name into v_match_id, v_match_name
      from public.drivers d
      where d.iracing_cust_id is null
        and lower(trim(d.name)) = lower(trim(v_entrant.display_name));

      update public.drivers set iracing_cust_id = v_entrant.cust_id where id = v_match_id;
      v_linked := array_append(v_linked, v_match_name);
    else
      insert into public.drivers (name, iracing_cust_id, class_id, status_id, is_rookie)
      values (v_entrant.display_name, v_entrant.cust_id, v_default_class_id, v_new_status_id, true)
      returning name into v_created_name;
      v_created := array_append(v_created, v_created_name);
    end if;
  end loop;

  return jsonb_build_object('created', to_jsonb(v_created), 'linked', to_jsonb(v_linked));
end;
$$;
