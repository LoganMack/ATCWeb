-- Alpha Touring Challenge — activity_log
--
-- One row per admin-side mutation across the site, powering the new
-- /admin/activity-log tab. Deliberately a single flat table (not one per
-- entity type) so the log page can list/filter everything with one query —
-- entity_type + entity_label carry enough context per row to render a
-- readable line ("Driver — Jielin Kuo" / "Ruleset — 2026 Standard") without
-- needing to join back into a dozen different tables.
--
-- action is constrained to exactly the three verbs Logan asked to filter by.
-- entity_type is intentionally NOT constrained by a check() — new entity
-- kinds (or one-off categories like 'import') can be logged without a
-- migration; the admin UI's category filter only cares about 'import' and
-- 'incident' as special cases and treats everything else as "All".
--
-- file_url/file_name are only set on import rows (entity_type = 'import') —
-- see the 'imports' storage bucket below — so the activity log row itself
-- can offer a "Download" link back to the exact spreadsheet that was
-- uploaded, without keeping a separate table just for that.
create table activity_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_id uuid references profiles(id) on delete set null,
  -- Denormalized on purpose — a profile can be renamed or deleted later, but
  -- the log should keep reading "who did this" exactly as it was at the
  -- time, same reasoning as e.g. news_posts.author_name.
  actor_name text not null,
  action text not null check (action in ('add', 'edit', 'delete')),
  entity_type text not null,
  entity_label text,
  entity_id text,
  details text,
  file_url text,
  file_name text
);

create index activity_log_created_at_idx on activity_log (created_at desc);
create index activity_log_action_idx on activity_log (action);
create index activity_log_entity_type_idx on activity_log (entity_type);

alter table activity_log enable row level security;

-- Admin-only read (the log page itself is already gated by middleware.ts,
-- this is the belt-and-suspenders DB-level backstop every other admin table
-- in this project has).
create policy "admin read activity_log" on activity_log for select using (is_admin());

-- Insert needs to allow one non-admin case: a brand-new self-registered
-- account (src/pages/signup.astro) logging its own "user added" entry
-- immediately after creation, before any admin role exists for it — same
-- shape as "admin insert profiles" (0002_auth_admin.sql)'s
-- `is_admin() or auth.uid() = id` escape hatch for exactly that moment.
create policy "insert activity_log" on activity_log for insert with check (is_admin() or auth.uid() = actor_id);

-- ---------------------------------------------------------------------------
-- Storage — an 'imports' bucket holding the raw spreadsheet uploaded for
-- each bulk import (Events/Circuits/News/Race Results on /admin/import, and
-- the Incident Report page's CSV importer), so an activity_log row for an
-- import can link back to the exact file that was uploaded. Public read
-- (same pattern as logos/photos/banners in 0002/0024) — none of these
-- spreadsheets contain anything more sensitive than what's already public
-- elsewhere on the site (event schedules, circuit info, news posts, race
-- results/incidents) — admin-only write.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('imports', 'imports', true)
on conflict (id) do nothing;

create policy "public read imports" on storage.objects for select using (bucket_id = 'imports');
create policy "admin write imports" on storage.objects for insert with check (bucket_id = 'imports' and is_admin());
create policy "admin update imports" on storage.objects for update using (bucket_id = 'imports' and is_admin());
create policy "admin delete imports" on storage.objects for delete using (bucket_id = 'imports' and is_admin());
