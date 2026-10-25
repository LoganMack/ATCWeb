-- Liveries on the own profile (profile-liveries FR5.1-FR5.11, NFR1-NFR4).
--
-- What: a league driver keeps their iRacing paint files per season. This migration adds:
--   * public.liveries, one row per base livery (.tga, optional .mip spec map), owned by the account
--     (profile_id) and recording its driver; at most one active livery per account and season (partial
--     unique index liveries_one_active_per_season);
--   * private.liveries_before_write(), the before insert or update trigger that sets driver_id, refuses a
--     fourth livery in a season (LIMIT_REACHED), clears is_active when the season changes, and refuses a
--     row or a spec map whose stored files are missing (FILES_MISSING);
--   * public.set_my_livery_active(id), which clears the caller's other active livery of that season and
--     sets this one in one transaction;
--   * the private storage bucket liveries (21 MB per object, gzip / WebP / JPEG only) with owner and admin
--     policies. Objects live at <profile_id>/<livery_id>/base.tga.gz | spec.mip.gz | thumb | preview.
--
-- Why in the database: who may read and change a livery, the 3-per-season limit and the single active
-- livery are access and business rules (team rule), so Row Level Security, column grants and the trigger
-- decide them whatever the page sends. Refusals are raised as '<CODE>: <message>', which
-- src/lib/liveries.ts reads. The browser uploads straight to Storage through signed upload URLs (the
-- Worker never carries file bytes), so the row is written only after its files exist, and the trigger
-- checks that they do.
--
-- Expand only: a new table, functions, bucket and policies; nothing existing changes. A season that holds
-- liveries cannot be deleted (no cascade), so stored files are never orphaned. Undo with
-- supabase/down/20261106120000_liveries.down.sql (delete the stored files first).

-- 1. The table (FR5.2-FR5.4, FR5.7, FR5.10). The id is chosen by the browser so the storage paths exist
--    before the row does.
create table public.liveries (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  driver_id uuid references public.drivers (id) on delete set null,
  season_id uuid not null references public.seasons (id),
  tga_name text not null,
  tga_size bigint not null,
  mip_name text,
  mip_size bigint,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint liveries_tga_name_check check (char_length(tga_name) between 5 and 200 and lower(tga_name) like '%.tga'),
  constraint liveries_tga_size_check check (tga_size between 1 and 20971520),
  constraint liveries_mip_name_check check (char_length(mip_name) between 5 and 200 and lower(mip_name) like '%.mip'),
  constraint liveries_mip_size_check check (mip_size between 1 and 20971520),
  constraint liveries_mip_pair_check check ((mip_name is null) = (mip_size is null))
);

comment on table public.liveries is
  'iRacing paint files per account and season (profile-liveries FR5). Files are in the private liveries bucket.';

-- Serves the owner's list and the per-season count; the partial unique index keeps one active per season.
create index liveries_profile_season_idx on public.liveries (profile_id, season_id);
create index liveries_season_id_idx on public.liveries (season_id);
create index liveries_driver_id_idx on public.liveries (driver_id);
create unique index liveries_one_active_per_season on public.liveries (profile_id, season_id) where is_active;

create trigger liveries_set_updated_at
  before update on public.liveries
  for each row execute function public.set_updated_at();

-- 2. Owner and admin access (FR5.11; NFR1). Only accounts linked to a driver may add a livery.
alter table public.liveries enable row level security;

create policy liveries_select on public.liveries
  for select to authenticated
  using (profile_id = (select auth.uid()) or public.is_admin());

create policy liveries_insert on public.liveries
  for insert to authenticated
  with check (
    profile_id = (select auth.uid())
    and exists (
      select 1 from public.profiles p where p.id = (select auth.uid()) and p.driver_id is not null
    )
  );

create policy liveries_update on public.liveries
  for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

create policy liveries_delete on public.liveries
  for delete to authenticated
  using (profile_id = (select auth.uid()));

-- Supabase grants every new public table to anon and authenticated by default, so start from nothing.
-- profile_id comes from its default and driver_id from the trigger; the base file never changes.
revoke all on table public.liveries from public, anon, authenticated;
grant select, delete on table public.liveries to authenticated;
grant insert (id, season_id, tga_name, tga_size) on table public.liveries to authenticated;
grant update (season_id, is_active, mip_name, mip_size) on table public.liveries to authenticated;

-- 3. The write rules (FR5.3, FR5.4, FR5.7; NFR1). A definer so it can read profiles and storage.objects
--    whatever the caller's own policies allow.
create function private.liveries_before_write() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_folder text := new.profile_id::text || '/' || new.id::text || '/';
  v_count integer;
begin
  if tg_op = 'INSERT' then
    select p.driver_id into new.driver_id from public.profiles p where p.id = new.profile_id;
  end if;

  if tg_op = 'INSERT' or new.season_id is distinct from old.season_id then
    -- Two uploads from one account take turns, so neither sees a stale count.
    perform pg_advisory_xact_lock(hashtextextended('liveries:' || new.profile_id::text, 0));
    select count(*) into v_count
    from public.liveries l
    where l.profile_id = new.profile_id and l.season_id = new.season_id and l.id <> new.id;
    if v_count >= 3 then
      raise exception 'LIMIT_REACHED: a season holds at most 3 liveries' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.season_id is distinct from old.season_id then
    new.is_active := false;
  end if;

  if tg_op = 'INSERT' and (
    select count(*) from storage.objects o
    where o.bucket_id = 'liveries'
      and o.name in (v_folder || 'base.tga.gz', v_folder || 'thumb', v_folder || 'preview')
  ) < 3 then
    raise exception 'FILES_MISSING: upload the livery files first' using errcode = 'P0001';
  end if;

  if new.mip_name is not null
    and (tg_op = 'INSERT' or new.mip_name is distinct from old.mip_name or new.mip_size is distinct from old.mip_size)
    and not exists (
      select 1 from storage.objects o where o.bucket_id = 'liveries' and o.name = v_folder || 'spec.mip.gz'
    ) then
    raise exception 'FILES_MISSING: upload the spec map first' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function private.liveries_before_write() is
  'Sets driver_id, enforces 3 liveries per season, clears is_active on a season move and checks stored files.';

revoke all on function private.liveries_before_write() from public, anon, authenticated;

create trigger liveries_before_write
  before insert or update on public.liveries
  for each row execute function private.liveries_before_write();

-- 4. Set active (FR5.7). Runs as the caller, so the update policy and column grants still apply; the same
--    advisory lock as the trigger makes two calls for one account take turns.
create function public.set_my_livery_active(p_id uuid) returns void
  language plpgsql
  set search_path = ''
  as $$
declare
  v_season uuid;
begin
  select l.season_id into v_season
  from public.liveries l
  where l.id = p_id and l.profile_id = (select auth.uid());
  if v_season is null then
    raise exception 'NOT_OWNER: this is not your livery' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('liveries:' || (select auth.uid())::text, 0));
  update public.liveries l set is_active = false
  where l.profile_id = (select auth.uid()) and l.season_id = v_season and l.is_active and l.id <> p_id;
  update public.liveries l set is_active = true where l.id = p_id;
end;
$$;

comment on function public.set_my_livery_active(uuid) is
  'Makes the caller''s livery p_id the active one of its season, clearing the previous one (FR5.7).';

revoke all on function public.set_my_livery_active(uuid) from public, anon;
grant execute on function public.set_my_livery_active(uuid) to authenticated;

-- 5. The private bucket (NFR2). 21 MB leaves room for gzip overhead on a 20 MB file.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('liveries', 'liveries', false, 22020096, '{application/gzip,image/webp,image/jpeg}'::text[])
on conflict (id) do update set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 6. Storage policies (FR5.11; NFR1). The owner works only in their own folder and only with the four file
--    names; uploading needs a linked driver. Replacing the spec map is an upsert, which needs update too.
create policy "owner upload own liveries" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'liveries'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 2
    and storage.filename(name) in ('base.tga.gz', 'spec.mip.gz', 'thumb', 'preview')
    and exists (
      select 1 from public.profiles p where p.id = (select auth.uid()) and p.driver_id is not null
    )
  );

create policy "owner read own liveries" on storage.objects
  for select to authenticated
  using (bucket_id = 'liveries' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "owner replace own liveries" on storage.objects
  for update to authenticated
  using (bucket_id = 'liveries' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (
    bucket_id = 'liveries'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 2
    and storage.filename(name) in ('base.tga.gz', 'spec.mip.gz', 'thumb', 'preview')
  );

create policy "owner delete own liveries" on storage.objects
  for delete to authenticated
  using (bucket_id = 'liveries' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "admin read liveries" on storage.objects
  for select to authenticated
  using (bucket_id = 'liveries' and public.is_admin());
