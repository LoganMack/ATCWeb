-- repair-migration-history.sql  (one-off: run once in the Supabase SQL editor; this is not a migration)
--
-- Why: the database's migration history (supabase_migrations.schema_migrations) listed 58
-- migrations under timestamp versions (20260810133127 ...) because they were applied through
-- the Supabase dashboard/tools, while the repo's files are numbered 0001, 0002 ... The
-- Supabase GitHub check compares the two and fails with "Remote migration versions not
-- found in local migrations directory". Everything in the repo has in fact been applied, so
-- this rewrites the history to list exactly the repo's files (this is what
-- `supabase migration repair` does).
--
-- Before running: rename the four duplicate-numbered files so every file has a unique
-- version (see the PR notes), and merge the new migration files from this PR.
--
-- It keeps a backup of the old table, and it all happens in one transaction.

begin;

create table if not exists supabase_migrations.schema_migrations_backup_20261008 as
  table supabase_migrations.schema_migrations;

truncate supabase_migrations.schema_migrations;

insert into supabase_migrations.schema_migrations (version, name) values
  ('0001', 'init'),
  ('0002', 'auth_admin'),
  ('0003', 'calendar'),
  ('00031', 'security_fixes'),
  ('0004', 'curated_races'),
  ('00041', 'champions'),
  ('0005', 'driver_iracing_id'),
  ('00051', 'round_overrides'),
  ('0006', 'champion_photos_expand'),
  ('0007', 'race_links'),
  ('0008', 'team_rosters'),
  ('0009', 'car_logos'),
  ('0010', 'circuit_layouts'),
  ('0011', 'driver_signup_date'),
  ('0012', 'circuit_location'),
  ('0013', 'circuit_layout_lap_record_seconds'),
  ('0014', 'penalties'),
  ('0015', 'penalty_details'),
  ('0016', 'penalty_appeals'),
  ('0017', 'news_round_season'),
  ('0018', 'curated_rounds_layout'),
  ('0019', 'team_season_logos'),
  ('0020', 'penalty_racing_incident'),
  ('0021', 'circuit_layout_image'),
  ('0022', 'circuit_layout_corners'),
  ('0023', 'event_sim_times'),
  ('0024', 'season_logos_and_page_banners'),
  ('0025', 'race_links_photo_album'),
  ('0026', 'site_settings'),
  ('0027', 'hall_of_fame'),
  ('0028', 'manual_results_import'),
  ('0029', 'driver_nationality'),
  ('0030', 'drop_penalties_old'),
  ('0031', 'scoring_rulesets_default'),
  ('0032', 'fix_recalculate_race_scores'),
  ('0033', 'naked_aggression_bonus'),
  ('0034', 'recalculate_season_scores'),
  ('0035', 'events_rounds_categories'),
  ('0036', 'round_test_flag'),
  ('0037', 'class_and_scoring_fixes'),
  ('0038', 'class_podium_race2'),
  ('0039', 'driver_admin_overhaul'),
  ('0040', 'inactivity_90d_or_12_rounds'),
  ('0041', 'driver_settings'),
  ('0042', 'hall_of_fame_photos'),
  ('0043', 'organizations'),
  ('0044', 'driver_season_car_numbers'),
  ('0045', 'team_rosters_in_scoring'),
  ('0046', 'remove_team_fallback'),
  ('0047', 'sync_results_with_roster'),
  ('0048', 'race_number_points_overrides'),
  ('0049', 'media_page'),
  ('0050', 'weather_conditions_expanded'),
  ('0051', 'activity_log'),
  ('0052', 'delta_team_enabled'),
  ('0053', 'track_guides'),
  ('0054', 'test_session_no_race_required'),
  ('0055', 'news_tags'),
  ('0056', 'penalty_session_type'),
  ('0057', 'driver_ai_flag'),
  ('0058', 'class_season_fallback_fix'),
  ('0059', 'penalty_points_warning_dropdown'),
  ('0060', 'sync_results_recalculates_history'),
  ('0061', 'backfill_missing_race_scores'),
  ('0062', 'scoring_ruleset_can_drop_final_round'),
  ('0063', 'driver_never_raced_inactivity'),
  ('0064', 'posters_sunset_team_graphics'),
  ('0065', 'circuit_layout_corners_backfill'),
  ('0066', 'roster_sync_timeout_fix'),
  ('0067', 'ruleset_overhaul_and_bonuses'),
  ('0068', 'rescore_all_for_bonus_overhaul'),
  ('0069', 'manual_awards'),
  ('0070', 'meetup_drivers'),
  ('0071', 'race_wet_affected'),
  ('0072', 'backfill_events_from_rounds'),
  ('00721', 'fix_security_definer_views'),
  ('00722', 'tighten_security_definer_function_grants'),
  ('00723', 'revoke_public_execute_gap_on_definer_functions'),
  ('00724', 'fix_rls_initplan_dedupe_policies_add_fk_indexes'),
  ('0073', 'holiday_iracing_events'),
  ('0074', 'backfill_championship_categories'),
  ('0075', 'fix_duplicate_championship_events'),
  ('0076', 'backfill_event_layouts_from_timeline'),
  ('0077', 'page_views'),
  ('0078', 'curated_rounds_event_id_and_practice_results'),
  ('0079', 'curated_rounds_event_id_backfill_by_date'),
  ('0080', 'page_views_status_and_stats'),
  ('0081', 'drop_unused_views_and_columns'),
  ('0082', 'news_post_drivers'),
  ('0083', 'page_views_hourly_today'),
  ('0084', 'circuit_layout_lap_record_car'),
  ('0085', 'drop_circuit_layout_lap_record_car'),
  ('0086', 'remove_provisional_status'),
  ('0087', 'remove_featured_broadcast_setting'),
  ('0088', 'log_user_creation'),
  ('0089', 'season_light_logo'),
  ('00891', 'delete_atc18_oulton_abandoned_race'),
  ('00892', 'link_atc18_oulton_round_to_round_2'),
  ('0090', 'incident_reports'),
  ('0091', 'incident_reports_anonymous_submit'),
  ('00911', 'atc18_r3_layout_and_delete_bad_oulton_round'),
  ('0092', 'incident_posting'),
  ('0093', 'incident_appeals'),
  ('0094', 'reporter_name_from_driver'),
  ('0095', 'admin_user_management'),
  ('0096', 'incident_report_reviews'),
  ('0097', 'security_hardening'),
  ('0098', 'signup_requests'),
  ('00981', 'circuit_coordinates'),
  ('0099', 'incident_review_conflict_of_interest'),
  ('0100', 'review_multiple_fault_drivers'),
  ('0101', 'kudos');

commit;

-- Run this LAST, and only after 0102_security_advisor_fixes.sql has been applied:
--   insert into supabase_migrations.schema_migrations (version, name) values ('0102', 'security_advisor_fixes');
