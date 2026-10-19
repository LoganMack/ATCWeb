-- Read-only regression checks for migrations 0114-0116 (security fixes SEC-03..SEC-13).
-- Run in the Supabase SQL editor after each rollout step. Every row whose
-- `after` migration has been applied must read PASS; rows for a later step are
-- expected to read FAIL until that step is applied.
-- Covers NFR2.1 (page views), NFR2.4 (interview uploads), NFR2.10 (search
-- path), NFR2.11 (interview RPC grants) and NFR2.12 (private imports bucket).

with checks(nfr, after_migration, description, ok) as (
  -- NFR2.1 page views
  select 'NFR2.1', '0114', 'record_page_view exists, is SECURITY DEFINER with a pinned search_path',
    exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'record_page_view' and p.prosecdef
        and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
    )
  union all
  select 'NFR2.1', '0114', 'record_page_view limits to 30 views per visitor hash per 60 s',
    exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'record_page_view'
        and p.prosrc like '%interval ''60 seconds''%' and p.prosrc like '%>= 30%'
    )
  union all
  select 'NFR2.1', '0114', 'anon can execute record_page_view',
    coalesce(has_function_privilege('anon', to_regprocedure('public.record_page_view(text,text,text,integer)'), 'execute'), false)
  union all
  select 'NFR2.1', '0114', 'index on page_views (visitor_hash, viewed_at)',
    exists (
      select 1 from pg_indexes
      where schemaname = 'public' and tablename = 'page_views'
        and indexdef like '%(visitor_hash, viewed_at)%'
    )
  union all
  select 'NFR2.1', '0115', 'no insert policy on page_views',
    not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'page_views' and cmd in ('INSERT', 'ALL'))

  -- NFR2.4 interview uploads
  union all
  select 'NFR2.4', '0114', 'owner select policy on race-interviews',
    exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'driver read own race-interviews' and cmd = 'SELECT' and qual like '%foldername%')
  union all
  select 'NFR2.4', '0114', 'owner update policy on race-interviews, only while unsubmitted',
    exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'driver replace own unsubmitted race-interviews' and cmd = 'UPDATE'
            and qual like '%foldername%' and qual like '%is_race_interview_path_submitted%'
            and with_check like '%is_race_interview_path_submitted%')
  union all
  select 'NFR2.4', '0114', 'submit_race_interview accepts the <driver id>/<round>.<ext> path',
    exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'submit_race_interview'
        and position('{36}/[0-9]+\.(webm|mp4|ogg)$' in p.prosrc) > 0 and p.prosrc like '%v_driver::text%'
    )
  union all
  select 'NFR2.4', '0115', 'race-interviews insert policy is scoped to the caller''s driver folder',
    exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'driver upload own race-interviews' and cmd = 'INSERT' and with_check like '%foldername%')
    and not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'driver upload race-interviews')
  union all
  select 'NFR2.4', '0116', 'submit_race_interview no longer accepts the old <id>.<ext> path',
    exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'submit_race_interview'
        and position('{36}\.(webm' in p.prosrc) = 0
    )

  -- NFR2.10 search path
  union all
  select 'NFR2.10', '0114', 'clear_incident_report_dismissal_reason has a pinned search_path',
    exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'clear_incident_report_dismissal_reason'
        and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
    )

  -- NFR2.11 interview RPC grants
  union all
  select 'NFR2.11', '0114', 'anon cannot execute submit_race_interview',
    not has_function_privilege('anon', 'public.submit_race_interview(uuid,bigint,text,text,integer)', 'execute')
  union all
  select 'NFR2.11', '0114', 'anon cannot execute has_submitted_race_interview',
    not has_function_privilege('anon', 'public.has_submitted_race_interview(bigint)', 'execute')
  union all
  select 'NFR2.11', '0114', 'authenticated can still execute both interview RPCs',
    has_function_privilege('authenticated', 'public.submit_race_interview(uuid,bigint,text,text,integer)', 'execute')
    and has_function_privilege('authenticated', 'public.has_submitted_race_interview(bigint)', 'execute')

  -- NFR2.12 imports bucket
  union all
  select 'NFR2.12', '0114', 'admin-only read policy on imports',
    exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'admin read imports' and cmd = 'SELECT' and qual like '%is_admin%')
  union all
  select 'NFR2.12', '0115', 'imports bucket is private',
    exists (select 1 from storage.buckets where id = 'imports' and public = false)
  union all
  select 'NFR2.12', '0115', 'public read policy on imports removed',
    not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                and policyname = 'public read imports')
)
select nfr, after_migration, description, case when ok then 'PASS' else 'FAIL' end as result
from checks
order by after_migration, nfr, description;
