-- Driver privacy, contract step (U4 driver-privacy, US9.2, US5.4; rules BR9.16, BR9.17, BR9.20; NFR1.4,
-- NFR1.6, NFR8.3, NFR8.4).
--
-- What: the eleven base tables behind the masked views become readable only by admins (and the service
-- role, which bypasses policies). Anon and non-admin signed-in callers read them only through the *_shown
-- views added by 20261029120000_driver_privacy_views.sql, which run as their owner and re-apply each base
-- policy's row filter. Each table's public select policy is replaced by "admin read <table>":
--   drivers, curated_race_results, curated_qualifying, curated_practice_results, circuit_layouts,
--   champion_photos, hall_of_fame_photos ("public read"), kudos ("public read kudos"), news_posts
--   ("read news"), penalties ("posted or admin read penalties"), round_penalties ("posted or admin read
--   round_penalties").
--
-- Why: until now the toggles masked only what the site renders; anyone with the public key could still
-- read a hidden driver's real name, photo and customer id from the raw tables. Narrowing the select
-- policies (not column grants, which do nothing against the baseline's table-level grants) closes that,
-- while admin reads and every insert, update and delete policy and grant stay exactly as they were.
--
-- Caller-side reads of these tables, found by scanning every policy, invoker view and invoker function:
--   * the select policies on penalty_involved_drivers and penalty_offense_links read public.penalties as
--     the caller, so they would return nothing to non-admins once penalties is narrowed. They now call
--     private.penalty_is_posted, a definer helper with the same posted-round test;
--   * deleting your own kudos (src/lib/kudos.ts, return=representation) must still see the row, so kudos
--     gains "author read own kudos";
--   * public.driver_last_race and public.get_missing_race_results_count are read only on admin pages;
--   * private.scoring_compute, private.scoring_rounds_for_driver_seasons and private.build_round_stats run
--     only inside definer functions; private.hidden_drivers is read only by the definer views.
--
-- Guard (BR9.17): the migration stops unless all eleven views exist, so it can never run ahead of the
-- expand step. Production must already run the code that reads through the views (#127).
--
-- Undo: supabase/down/20261103120000_driver_privacy_contract.down.sql restores every original policy. Run it
-- before the expand step's down script.

-- 1. Guard ---------------------------------------------------------------------------------------------
do $$
declare
  v_view text;
begin
  foreach v_view in array array['drivers_shown', 'curated_race_results_shown', 'curated_qualifying_shown',
    'curated_practice_results_shown', 'kudos_shown', 'news_posts_shown', 'circuit_layouts_shown',
    'penalties_shown', 'round_penalties_shown', 'champion_photos_shown', 'hall_of_fame_photos_shown'] loop
    if to_regclass('public.' || v_view) is null then
      raise exception 'PR 1 views missing: %', v_view;
    end if;
  end loop;
end $$;

-- 2. Dependent policies first --------------------------------------------------------------------------
--    Policies run as the caller, so anon and authenticated execute the helper; as a definer it reads
--    penalties whatever the caller's own policies allow, and it returns only a boolean.
create function private.penalty_is_posted(p_penalty_id uuid) returns boolean
  language sql stable security definer
  set search_path = ''
  as $$
  select exists (
    select 1
    from public.penalties p
    join public.round_incident_status s on s.subsession_id = p.subsession_id
    where p.id = p_penalty_id and s.posted
  );
$$;

comment on function private.penalty_is_posted(uuid) is
  'True when the penalty''s round is posted. Used by the penalty_involved_drivers and penalty_offense_links select policies, which run as the caller and cannot read public.penalties after the contract step.';

revoke all on function private.penalty_is_posted(uuid) from public;
grant execute on function private.penalty_is_posted(uuid) to anon, authenticated, service_role;

drop policy "posted or admin read penalty_involved_drivers" on public.penalty_involved_drivers;
create policy "posted or admin read penalty_involved_drivers" on public.penalty_involved_drivers
  for select
  using ((select public.is_admin()) or private.penalty_is_posted(penalty_id));

drop policy "posted or admin read penalty_offense_links" on public.penalty_offense_links;
create policy "posted or admin read penalty_offense_links" on public.penalty_offense_links
  for select
  using ((select public.is_admin()) or private.penalty_is_posted(penalty_id));

-- 3. The eleven base tables become admin-only to read (BR9.16; NFR1.4) -----------------------------------
drop policy "public read" on public.drivers;
create policy "admin read drivers" on public.drivers for select using ((select public.is_admin()));

drop policy "public read" on public.curated_race_results;
create policy "admin read curated_race_results" on public.curated_race_results
  for select using ((select public.is_admin()));

drop policy "public read" on public.curated_qualifying;
create policy "admin read curated_qualifying" on public.curated_qualifying
  for select using ((select public.is_admin()));

drop policy "public read" on public.curated_practice_results;
create policy "admin read curated_practice_results" on public.curated_practice_results
  for select using ((select public.is_admin()));

drop policy "public read" on public.circuit_layouts;
create policy "admin read circuit_layouts" on public.circuit_layouts for select using ((select public.is_admin()));

drop policy "public read" on public.champion_photos;
create policy "admin read champion_photos" on public.champion_photos for select using ((select public.is_admin()));

drop policy "public read" on public.hall_of_fame_photos;
create policy "admin read hall_of_fame_photos" on public.hall_of_fame_photos
  for select using ((select public.is_admin()));

drop policy "public read kudos" on public.kudos;
create policy "admin read kudos" on public.kudos for select using ((select public.is_admin()));

drop policy "read news" on public.news_posts;
create policy "admin read news_posts" on public.news_posts for select using ((select public.is_admin()));

drop policy "posted or admin read penalties" on public.penalties;
create policy "admin read penalties" on public.penalties for select using ((select public.is_admin()));

drop policy "posted or admin read round_penalties" on public.round_penalties;
create policy "admin read round_penalties" on public.round_penalties for select using ((select public.is_admin()));

-- 4. Own-row read that a non-admin write needs ------------------------------------------------------------
--    "author or admin delete kudos" deletes with a WHERE clause and return=representation, which needs
--    the row to be visible to the author.
create policy "author read own kudos" on public.kudos
  for select to authenticated
  using (author_id = (select auth.uid()));
