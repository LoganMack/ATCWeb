-- dump-platform-objects.sql (a tool script, not a migration; it never changes the database)
--
-- Prints, as executable SQL, the objects the site created inside Supabase-managed schemas.
-- `supabase db dump --schema public,private` cannot isolate these without dumping whole managed
-- schemas, so this is the second part of the schema baseline and of every schema comparison:
--   1. CREATE EXTENSION IF NOT EXISTS for extensions a new Supabase project does not already have
--   2. INSERT ... ON CONFLICT for storage.buckets rows (a bucket is configuration, not data)
--   3. CREATE POLICY for policies in the storage schema (storage.objects)
--   4. the site's non-internal triggers on auth.users, with their functions
--   5. ALTER DEFAULT PRIVILEGES entries for the public and private schemas
--
-- Run it with:  psql "$DB_URL" -X -At -v ON_ERROR_STOP=1 -f supabase/tools/dump-platform-objects.sql
-- Output is one statement per row, in a fixed order, so two runs on equal databases match.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset footer off

-- One SELECT and nothing else: it is read-only by construction, and no command tag (BEGIN, SET)
-- can end up in the output between statements.
with
-- Extensions already present (or managed by Supabase) on a new project, so not emitted:
-- plpgsql, pgcrypto, uuid-ossp, pg_stat_statements, pg_graphql, supabase_vault, pgsodium, pgjwt.
extensions as (
  select
    1 as section,
    e.extname::text as sort_key,
    format('CREATE EXTENSION IF NOT EXISTS %I WITH SCHEMA %I;', e.extname, n.nspname) as stmt
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname not in (
    'plpgsql', 'pgcrypto', 'uuid-ossp', 'pg_stat_statements', 'pg_graphql',
    'supabase_vault', 'pgsodium', 'pgjwt'
  )
),
buckets as (
  select
    2 as section,
    b.id::text as sort_key,
    format(
      'INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) '
      'VALUES (%L, %L, %s, %s, %s) '
      'ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, public = EXCLUDED.public, '
      'file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;',
      b.id,
      b.name,
      coalesce(b.public, false)::text,
      coalesce(b.file_size_limit::text, 'NULL'),
      case
        when b.allowed_mime_types is null then 'NULL'
        else quote_literal(b.allowed_mime_types::text) || '::text[]'
      end
    ) as stmt
  from storage.buckets b
),
policies as (
  select
    3 as section,
    p.tablename || '/' || p.policyname as sort_key,
    format(
      'CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;',
      p.policyname,
      p.schemaname,
      p.tablename,
      p.permissive,
      p.cmd,
      (
        select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ' order by r)
        from unnest(p.roles) as r
      ),
      case when p.qual is not null then ' USING (' || p.qual || ')' else '' end,
      case when p.with_check is not null then ' WITH CHECK (' || p.with_check || ')' else '' end
    ) as stmt
  from pg_policies p
  where p.schemaname = 'storage'
),
auth_triggers as (
  select t.oid, t.tgname, t.tgfoid, t.tgenabled
  from pg_trigger t
  where t.tgrelid = 'auth.users'::regclass
    and not t.tgisinternal
),
trigger_functions as (
  -- The function first, so the trigger that calls it can be created after it.
  select distinct
    4 as section,
    tf.tgfoid::regprocedure::text || '/1' as sort_key,
    rtrim(pg_get_functiondef(tf.tgfoid), E'\n') || ';' as stmt
  from auth_triggers tf
),
triggers as (
  select
    4 as section,
    t.tgfoid::regprocedure::text || '/2/' || t.tgname as sort_key,
    regexp_replace(pg_get_triggerdef(t.oid), '^CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER') || ';' as stmt
  from auth_triggers t
  union all
  select
    4,
    t.tgfoid::regprocedure::text || '/3/' || t.tgname,
    format('ALTER TABLE auth.users DISABLE TRIGGER %I;', t.tgname)
  from auth_triggers t
  where t.tgenabled = 'D'
),
-- A per-schema default ACL only ever adds to the global defaults, so its entries map exactly to
-- GRANT statements (this is how pg_dump reconstructs them too). An entry owned by a role the
-- current user cannot act for (such as supabase_admin) cannot be re-created by the baseline, so
-- it is printed as a comment for a human to review instead of as a statement that would fail.
default_acls as (
  select
    d.defaclrole,
    pg_get_userbyid(d.defaclrole) as owner_role,
    n.nspname,
    case d.defaclobjtype
      when 'r' then 'TABLES'
      when 'S' then 'SEQUENCES'
      when 'f' then 'FUNCTIONS'
      when 'T' then 'TYPES'
    end as object_kind,
    a.grantee,
    a.privilege_type,
    a.is_grantable
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) as a
  where n.nspname in ('public', 'private')
    and d.defaclobjtype in ('r', 'S', 'f', 'T')
),
default_privileges as (
  select
    5 as section,
    concat_ws('/', da.owner_role, da.nspname, da.object_kind, coalesce(g.rolname, 'PUBLIC'), da.privilege_type) as sort_key,
    case when pg_has_role(current_user, da.defaclrole, 'USAGE') then '' else '-- TODO(review): not reproducible as the dumping role: ' end
      || format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT %s ON %s TO %s%s;',
        da.owner_role,
        da.nspname,
        da.privilege_type,
        da.object_kind,
        case when da.grantee = 0 then 'PUBLIC' else quote_ident(g.rolname) end,
        case when da.is_grantable then ' WITH GRANT OPTION' else '' end
      ) as stmt
  from default_acls da
  left join pg_roles g on g.oid = da.grantee
)
select stmt
from (
  select 0 as section, '' as sort_key, '-- Generated by supabase/tools/dump-platform-objects.sql' as stmt
  union all select * from extensions
  union all select * from buckets
  union all select * from policies
  union all select * from trigger_functions
  union all select * from triggers
  union all select * from default_privileges
) as everything
order by section, sort_key collate "C", stmt collate "C";
