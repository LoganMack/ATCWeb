-- Admin > Seasons gets a "Recalculate" button (per Logan) so a season's
-- race_scores can be refreshed without going round-by-round through the
-- Race Results admin, or without me running SQL by hand. This wraps the
-- existing recalculate_race_scores(subsession_id) — which already knows how
-- to score (or, for a non-official round, blank-score) a single round — in
-- a loop over every curated_rounds row for a season.
--
-- Deliberately NOT one big transaction that aborts on the first bad round:
-- some of these historical rounds may have data-quality gaps (a driver
-- without an iracing_cust_id match, a missing format, etc.) that make
-- recalculate_race_scores() raise for that one round specifically. A whole
-- season shouldn't fail to recalculate over one bad apple, and Logan needs
-- to know WHICH round failed and why to go fix it — so this catches each
-- round's exception individually and returns it as a row, right alongside
-- the rounds that succeeded, rather than raising to the caller.
create or replace function public.recalculate_season_scores(p_season_id uuid)
returns table(subsession_id bigint, rows_written int, error_message text)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_subsession_id bigint;
  v_written int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can recalculate scores'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.seasons where id = p_season_id) then
    raise exception 'No such season: %', p_season_id;
  end if;

  for v_subsession_id in
    select cr.subsession_id
    from public.curated_rounds cr
    where cr.season_id = p_season_id
    order by cr.round_number nulls last, cr.start_time
  loop
    begin
      v_written := public.recalculate_race_scores(v_subsession_id);
      subsession_id := v_subsession_id;
      rows_written := v_written;
      error_message := null;
      return next;
    exception when others then
      subsession_id := v_subsession_id;
      rows_written := null;
      error_message := sqlerrm;
      return next;
    end;
  end loop;
  return;
end;
$$;
