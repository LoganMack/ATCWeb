-- Driver privacy, expand step (U4 driver-privacy, US9.1-US9.3, US5.4, US5.5; contracts C3, C5 as amended,
-- C6; rules BR9.1-BR9.10, BR9.19).
--
-- What: eleven read-only masked views, one per public table that holds a driver's name, photo, iRacing
-- customer id, a copied name or the free text US9.3 lists:
--   drivers_shown, curated_race_results_shown, curated_qualifying_shown, curated_practice_results_shown,
--   kudos_shown, news_posts_shown, circuit_layouts_shown, penalties_shown, round_penalties_shown,
--   champion_photos_shown, hall_of_fame_photos_shown.
-- Each keeps its base table's column names (key and foreign-key columns unchanged, so PostgREST embeds
-- such as drivers_shown(...) still resolve) and returns masked values for a driver whose linked account
-- turned on "Hide Driver Name from Anonymous Users", when the caller is neither an admin nor signed in
-- with a linked driver. drivers_shown adds is_hidden and profile_private; the three results views add
-- roster_driver_id. Behind them sit one private view (the hidden set) and three pure helpers.
--
-- Why views and not computed columns (functional design F3 A): a computed column takes a whole-row
-- argument, which Postgres checks against every column for the caller, so it cannot coexist with closed
-- raw columns in the contract step. The views run as their owner (security_invoker = false), so the
-- contract step can later make the base tables admin-only to read while every reader keeps working.
-- They are security barriers, so a caller's filter never runs before the view's own row filter.
--
-- Why the hidden set is a view, not a definer function: Postgres checks EXECUTE on every function a view
-- calls against the caller, not the view's owner, so a definer function behind the views would have to be
-- executable by anon, and it returns exactly the names it hides. A view is read with the owner's rights,
-- so private.hidden_drivers needs no grant at all. The three helpers do need EXECUTE for the callers; they
-- are pure functions of their arguments and sit in the private schema, which PostgREST does not expose.
--
-- Expand only: no table, policy or grant on the base tables changes, so the code on main keeps working
-- while this applies. Masking takes effect only once the readers move to the views (same pull request)
-- and an account turns a toggle on. The contract step (20261030120000_driver_privacy_contract.sql, a later
-- pull request) narrows the base tables' select policies to admins.
--
-- Cost (BR9.19): the caller's privilege is an uncorrelated subquery inside the hidden set, so it runs once
-- per statement, and for a privileged caller the hidden set is empty without reading account_settings.
-- The prose name lists are uncorrelated scalar subqueries, also evaluated once per statement.
--
-- Undo: supabase/down/20261029120000_driver_privacy_views.down.sql drops the views and the helpers. If
-- the contract step has been applied, run its down script first.

-- 1. The hidden set (BR9.1, BR9.2, BR9.11) -------------------------------------------------------------
--    Drivers whose linked account hides the name or the profile, for an unprivileged caller only.
--    Privileged = an admin, or an account linked to a driver (the same role test as private.is_admin).
create view private.hidden_drivers as
select
  d.id as driver_id,
  p.id as profile_id,
  d.name as full_name,
  s.hide_name as name_hidden,
  (s.hide_name or s.hide_profile) as profile_private
from public.drivers d
join public.profiles p on p.driver_id = d.id
join public.account_settings s on s.profile_id = p.id
where (s.hide_name or s.hide_profile)
  and not exists (
    select 1
    from public.profiles v
    where v.id = (select auth.uid())
      and (v.role = 'admin' or v.driver_id is not null)
  );

comment on view private.hidden_drivers is
  'Drivers hidden from the current caller (U4): empty for admins and linked drivers. Read only by the *_shown views.';

revoke all on table private.hidden_drivers from public, anon, authenticated, service_role;

-- 2. Pure helpers ------------------------------------------------------------------------------------

-- Replaces every full name of two or more words with 'Hidden Driver' (BR9.7): case-insensitive, whole
-- words, any run of whitespace between the words, longest name first so "Dana Example Jr" goes before
-- "Dana Example". Lookarounds instead of word boundaries, so a name ending in punctuation ("Jr.") still
-- matches. One combined pattern per 100 names, so the regex cache holds a handful of patterns at most.
create function private.mask_names(p_text text, p_names text[]) returns text
  language plpgsql immutable parallel safe
  set search_path = ''
as $$
declare
  v_names text[];
  v_pattern text;
  v_out text := p_text;
begin
  if p_text is null or p_text = '' or p_names is null or cardinality(p_names) = 0 then
    return p_text;
  end if;

  select array_agg(t.n order by length(t.n) desc, t.n)
    into v_names
  from (
    select distinct regexp_replace(regexp_replace(u.x, '^[[:space:]]+|[[:space:]]+$', '', 'g'),
                                   '[[:space:]]+', ' ', 'g') as n
    from unnest(p_names) as u (x)
    where u.x is not null
  ) t
  -- A one-word name is not masked in prose (a known limit shown to the owner).
  where position(' ' in t.n) > 0;

  if v_names is null then
    return p_text;
  end if;

  for i in 1 .. cardinality(v_names) by 100 loop
    -- Every character that is not a letter, digit or space is escaped (in a Postgres ARE a backslash
    -- before a non-alphanumeric character means that character), then each space matches any whitespace.
    select string_agg(
             replace(regexp_replace(c.n, '([^[:alnum:] ])', '\\\1', 'g'), ' ', '[[:space:]]+'),
             '|' order by c.ord)
      into v_pattern
    from unnest(v_names[i:i + 99]) with ordinality as c (n, ord);

    v_out := regexp_replace(v_out, '(?<![[:alnum:]_])(?:' || v_pattern || ')(?![[:alnum:]_])', 'Hidden Driver', 'gi');
  end loop;

  return v_out;
end;
$$;

-- Turns a news mention @[Display Name](<driver id>) of a listed driver into plain 'Hidden Driver' (BR9.9),
-- before the page's renderer would turn it into a profile link. Same mention shape as MENTION_PATTERN in
-- src/lib/db/news.ts.
create function private.mask_mentions(p_text text, p_driver_ids uuid[]) returns text
  language sql immutable parallel safe
  set search_path = ''
as $$
  select case
    when p_text is null or p_driver_ids is null or cardinality(p_driver_ids) = 0 then p_text
    else regexp_replace(
      p_text,
      '@\[[^]]*\]\((?:' || (select string_agg(u.id::text, '|') from unnest(p_driver_ids) as u (id)) || ')\)',
      'Hidden Driver',
      'gi')
  end;
$$;

-- A hidden driver's stand-in customer id (F2 A): negative, so it can never be a real iRacing id, and
-- derived only from the driver's public id, so it reveals nothing. drivers_shown and the results views
-- give the same driver the same value, which keeps the site's cust_id joins working. 52 bits, so it stays
-- exact as a JavaScript number.
create function private.hidden_cust_id(p_driver_id uuid) returns bigint
  language sql immutable parallel safe
  set search_path = ''
as $$
  select -1 - ('x' || lpad(substr(md5(p_driver_id::text), 1, 13), 16, '0'))::bit(64)::bigint;
$$;

-- The views call these as the caller, so the callers need EXECUTE (see the header).
revoke all on function private.mask_names(text, text[]) from public, anon, authenticated, service_role;
revoke all on function private.mask_mentions(text, uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.hidden_cust_id(uuid) from public, anon, authenticated, service_role;
grant execute on function private.mask_names(text, text[]) to anon, authenticated, service_role;
grant execute on function private.mask_mentions(text, uuid[]) to anon, authenticated, service_role;
grant execute on function private.hidden_cust_id(uuid) to anon, authenticated, service_role;

-- 3. drivers_shown (BR9.3, BR9.11) -------------------------------------------------------------------
create view public.drivers_shown with (security_invoker = false, security_barrier = true) as
select
  d.id,
  d.car_number,
  case when h.name_hidden then 'Hidden Driver' else d.name end as name,
  d.status_id,
  d.class_id,
  d.team_id,
  d.is_rookie,
  d.car,
  d.appearances,
  d.starts,
  d.seasons_count,
  d.penalty_points,
  d.penalty_points_max,
  case when h.name_hidden then null else d.photo_url end as photo_url,
  case when h.profile_private then null else d.bio end as bio,
  d.created_at,
  d.updated_at,
  case
    when d.iracing_cust_id is null then null
    when h.name_hidden then private.hidden_cust_id(d.id)
    else d.iracing_cust_id
  end as iracing_cust_id,
  d.sign_up_date,
  d.on_probation,
  d.probation_started_at,
  d.is_hall_of_fame,
  d.nationality_1,
  d.nationality_2,
  d.starting_irating,
  d.created_by,
  d.updated_by,
  d.is_ai,
  d.last_signed_up_at,
  coalesce(h.name_hidden, false) as is_hidden,
  coalesce(h.profile_private, false) as profile_private
from public.drivers d
left join private.hidden_drivers h on h.driver_id = d.id;

comment on view public.drivers_shown is
  'drivers for pages (U4): "Hidden Driver", no photo, bio or real customer id for a driver hidden from this caller.';

-- 4. The iRacing results views (BR9.4) ----------------------------------------------------------------
--    roster_driver_id is the matching drivers.id (null for an unrostered entrant, who is never hidden). It
--    is written as an expression, not a bare column, so PostgREST does not take these views for another
--    drivers relation (every foreign key to drivers.id would otherwise point at them too).
create view public.curated_race_results_shown with (security_invoker = false, security_barrier = true) as
select
  r.subsession_id,
  r.race_number,
  case when h.name_hidden then private.hidden_cust_id(rd.id) else r.cust_id end as cust_id,
  case when h.name_hidden then 'Hidden Driver' else r.display_name end as display_name,
  r.car_name,
  r.car_class_name,
  r.finish_position,
  r.starting_position,
  r.laps_complete,
  r.laps_led,
  r.interval_ten_thousandths,
  r.average_lap_ten_thousandths,
  r.best_lap_ten_thousandths,
  r.incidents,
  r.reason_out,
  r.penalty_points,
  r.adjusted_position,
  r.created_at,
  r.updated_at,
  case when rd.id is null then null else rd.id end as roster_driver_id
from public.curated_race_results r
left join public.drivers rd on rd.iracing_cust_id = r.cust_id
left join private.hidden_drivers h on h.driver_id = rd.id;

create view public.curated_qualifying_shown with (security_invoker = false, security_barrier = true) as
select
  r.subsession_id,
  case when h.name_hidden then private.hidden_cust_id(rd.id) else r.cust_id end as cust_id,
  case when h.name_hidden then 'Hidden Driver' else r.display_name end as display_name,
  r.car_class_name,
  r.qual_position,
  r.best_lap_ten_thousandths,
  r.created_at,
  r.updated_at,
  case when rd.id is null then null else rd.id end as roster_driver_id
from public.curated_qualifying r
left join public.drivers rd on rd.iracing_cust_id = r.cust_id
left join private.hidden_drivers h on h.driver_id = rd.id;

create view public.curated_practice_results_shown with (security_invoker = false, security_barrier = true) as
select
  r.subsession_id,
  case when h.name_hidden then private.hidden_cust_id(rd.id) else r.cust_id end as cust_id,
  case when h.name_hidden then 'Hidden Driver' else r.display_name end as display_name,
  r.car_class_name,
  r.best_lap_ten_thousandths,
  r.laps,
  r.created_at,
  r.updated_at,
  case when rd.id is null then null else rd.id end as roster_driver_id
from public.curated_practice_results r
left join public.drivers rd on rd.iracing_cust_id = r.cust_id
left join private.hidden_drivers h on h.driver_id = rd.id;

comment on view public.curated_race_results_shown is
  'curated_race_results for pages (U4): a hidden roster driver shows as "Hidden Driver" with a stand-in cust_id.';
comment on view public.curated_qualifying_shown is
  'curated_qualifying for pages (U4): a hidden roster driver shows as "Hidden Driver" with a stand-in cust_id.';
comment on view public.curated_practice_results_shown is
  'curated_practice_results for pages (U4): a hidden roster driver shows as "Hidden Driver" with a stand-in cust_id.';

-- 5. Copied names (BR9.5, BR9.6) -----------------------------------------------------------------------
create view public.kudos_shown with (security_invoker = false, security_barrier = true) as
select
  k.id,
  k.subsession_id,
  k.session,
  k.lap,
  k.turn,
  k.description,
  k.clip_url,
  k.author_id,
  case
    when k.author_id = any (array(
      select h.profile_id from private.hidden_drivers h where h.name_hidden
    )) then 'Hidden Driver'
    else k.author_name
  end as author_name,
  k.created_at
from public.kudos k;

create view public.circuit_layouts_shown with (security_invoker = false, security_barrier = true) as
select
  c.id,
  c.circuit_id,
  c.name,
  c.length_km,
  case
    -- Whitespace runs are collapsed on both sides, as in mask_names.
    when regexp_replace(lower(btrim(c.lap_record_holder)), '[[:space:]]+', ' ', 'g') = any (array(
      select regexp_replace(lower(btrim(h.full_name)), '[[:space:]]+', ' ', 'g') from private.hidden_drivers h where h.name_hidden
    )) then 'Hidden Driver'
    else c.lap_record_holder
  end as lap_record_holder,
  c.lap_record_date,
  c.created_at,
  c.updated_at,
  c.lap_record_seconds,
  c.image_url,
  c.corners,
  c.pit_entry_difficulty,
  c.pit_entry_note,
  c.pit_entry_x,
  c.pit_entry_y,
  c.pit_exit_difficulty,
  c.pit_exit_note,
  c.pit_exit_x,
  c.pit_exit_y
from public.circuit_layouts c;

comment on view public.kudos_shown is
  'kudos for pages (U4): the author name reads "Hidden Driver" when the author''s linked driver is hidden.';
comment on view public.circuit_layouts_shown is
  'circuit_layouts for pages (U4): a lap record holder equal to a hidden driver''s full name reads "Hidden Driver".';

-- 6. Prose (BR9.6, BR9.7, BR9.9) and the base policies' row filters (BR9.16) ---------------------------
--    news: published rows, or every row for an admin ("read news"). Penalties and round penalties: posted
--    rounds, or every row for an admin ("posted or admin read penalties" / "... round_penalties").
create view public.news_posts_shown with (security_invoker = false, security_barrier = true) as
select
  n.id,
  n.slug,
  n.title,
  n.excerpt,
  private.mask_names(
    private.mask_mentions(
      n.body,
      (select coalesce(array_agg(h.driver_id), '{}') from private.hidden_drivers h where h.name_hidden)
    ),
    (select coalesce(array_agg(h.full_name), '{}') from private.hidden_drivers h where h.name_hidden)
  ) as body,
  n.cover_image_url,
  case
    when regexp_replace(lower(btrim(n.author_name)), '[[:space:]]+', ' ', 'g') = any (array(
      select regexp_replace(lower(btrim(h.full_name)), '[[:space:]]+', ' ', 'g') from private.hidden_drivers h where h.name_hidden
    )) then 'Hidden Driver'
    else n.author_name
  end as author_name,
  n.status,
  n.season_id,
  n.published_at,
  n.created_at,
  n.updated_at,
  n.round_subsession_id,
  n.season_label
from public.news_posts n
where n.status = 'published' or (select public.is_admin());

create view public.penalties_shown with (security_invoker = false, security_barrier = true) as
select
  p.id,
  p.subsession_id,
  p.race_number,
  p.driver_id,
  p.incident_number,
  p.lap,
  private.mask_names(
    p.description,
    (select coalesce(array_agg(h.full_name), '{}') from private.hidden_drivers h where h.name_hidden)
  ) as description,
  p.time_penalty_seconds,
  p.points_penalty,
  p.penalty_points,
  p.created_at,
  p.updated_at,
  p.is_warning,
  p.is_appealed,
  private.mask_names(
    p.appeal_result,
    (select coalesce(array_agg(h.full_name), '{}') from private.hidden_drivers h where h.name_hidden)
  ) as appeal_result,
  p.appeal_time_penalty_seconds,
  p.appeal_points_penalty,
  p.appeal_penalty_points,
  p.session_type
from public.penalties p
where (select public.is_admin())
   or exists (
     select 1 from public.round_incident_status s where s.subsession_id = p.subsession_id and s.posted
   );

create view public.round_penalties_shown with (security_invoker = false, security_barrier = true) as
select
  rp.id,
  rp.subsession_id,
  rp.driver_id,
  rp.kind,
  private.mask_names(
    rp.note,
    (select coalesce(array_agg(h.full_name), '{}') from private.hidden_drivers h where h.name_hidden)
  ) as note,
  rp.served_subsession_id,
  rp.created_by,
  rp.created_at,
  rp.updated_at
from public.round_penalties rp
where (select public.is_admin())
   or exists (
     select 1 from public.round_incident_status s where s.subsession_id = rp.subsession_id and s.posted
   );

comment on view public.news_posts_shown is
  'news_posts for pages (U4): published rows (all for admins); hidden drivers'' full names and mentions masked.';
comment on view public.penalties_shown is
  'penalties for pages (U4): posted rounds (all for admins); hidden drivers'' full names masked in the text.';
comment on view public.round_penalties_shown is
  'round_penalties for pages (U4): posted rounds (all for admins); hidden drivers'' full names masked in the note.';

-- 7. Driver images (BR9.10): a hidden driver's champion and Hall of Fame photos are left out. -----------
create view public.champion_photos_shown with (security_invoker = false, security_barrier = true) as
select
  c.id,
  c.season_id,
  c.class_id,
  c.driver_id,
  c.image_url,
  c.sort_order,
  c.created_at,
  c.updated_at
from public.champion_photos c
where c.driver_id <> all (array(
  select h.driver_id from private.hidden_drivers h where h.name_hidden
));

create view public.hall_of_fame_photos_shown with (security_invoker = false, security_barrier = true) as
select
  f.id,
  f.driver_id,
  f.image_url,
  f.sort_order,
  f.created_at,
  f.updated_at
from public.hall_of_fame_photos f
where f.driver_id <> all (array(
  select h.driver_id from private.hidden_drivers h where h.name_hidden
));

comment on view public.champion_photos_shown is
  'champion_photos for pages (U4): a driver hidden from this caller has no photos.';
comment on view public.hall_of_fame_photos_shown is
  'hall_of_fame_photos for pages (U4): a driver hidden from this caller has no photos.';

-- 8. Read-only for everyone (NFR1.2). The default privileges would grant ALL, and a single-table view is
--    auto-updatable and would write as its owner, so start from nothing and grant select only.
revoke all on table public.drivers_shown from public, anon, authenticated, service_role;
revoke all on table public.curated_race_results_shown from public, anon, authenticated, service_role;
revoke all on table public.curated_qualifying_shown from public, anon, authenticated, service_role;
revoke all on table public.curated_practice_results_shown from public, anon, authenticated, service_role;
revoke all on table public.kudos_shown from public, anon, authenticated, service_role;
revoke all on table public.news_posts_shown from public, anon, authenticated, service_role;
revoke all on table public.circuit_layouts_shown from public, anon, authenticated, service_role;
revoke all on table public.penalties_shown from public, anon, authenticated, service_role;
revoke all on table public.round_penalties_shown from public, anon, authenticated, service_role;
revoke all on table public.champion_photos_shown from public, anon, authenticated, service_role;
revoke all on table public.hall_of_fame_photos_shown from public, anon, authenticated, service_role;

grant select on table public.drivers_shown to anon, authenticated, service_role;
grant select on table public.curated_race_results_shown to anon, authenticated, service_role;
grant select on table public.curated_qualifying_shown to anon, authenticated, service_role;
grant select on table public.curated_practice_results_shown to anon, authenticated, service_role;
grant select on table public.kudos_shown to anon, authenticated, service_role;
grant select on table public.news_posts_shown to anon, authenticated, service_role;
grant select on table public.circuit_layouts_shown to anon, authenticated, service_role;
grant select on table public.penalties_shown to anon, authenticated, service_role;
grant select on table public.round_penalties_shown to anon, authenticated, service_role;
grant select on table public.champion_photos_shown to anon, authenticated, service_role;
grant select on table public.hall_of_fame_photos_shown to anon, authenticated, service_role;
