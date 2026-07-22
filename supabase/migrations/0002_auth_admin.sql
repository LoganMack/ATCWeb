-- Alpha Touring Challenge — auth, admin roles, teams status, storage
--
-- Adds a `profiles` table linked 1:1 to Supabase Auth users, an admin role
-- used by RLS write policies, an active/inactive flag on teams, and public
-- Storage buckets for team logos + driver photos.
--
-- IDENTITY DESIGN NOTE: `profiles` is keyed to auth.users(id), not to email.
-- iracing_cust_id/iracing_name columns are here so that once iRacing
-- re-opens OAuth client registration (see https://oauth.iracing.com/oauth2/book/
-- — registration is currently paused), a real "Login with iRacing" method
-- can populate/link this same table without a schema change or touching any
-- of the admin/RLS logic built around it. For now, every profile is created
-- via Supabase's own email/password auth (see handle_new_user() below); the
-- iRacing columns just sit null until that integration exists. iRacing's
-- profile endpoint only ever returns cust_id + display name, no email —
-- that's the whole reason it's the GDPR-friendly choice for later.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'driver' check (role in ('admin', 'driver')),
  display_name text,
  driver_id uuid references drivers(id) on delete set null, -- links a login to a roster row, for future "edit my own bio/livery" self-service
  iracing_cust_id bigint unique,   -- reserved for iRacing OAuth, not used yet
  iracing_name text,               -- reserved for iRacing OAuth, not used yet
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at before update on profiles
  for each row execute function set_updated_at();

alter table profiles enable row level security;

-- Auto-create a `profiles` row (default role 'driver') whenever someone
-- signs up through Supabase Auth, so every authenticated user always has a
-- profile without extra app-side plumbing.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper used throughout this file's RLS policies: is the current request
-- from an authenticated admin? `security definer` so it can read `profiles`
-- from inside other tables' policies without every policy needing its own
-- grant on `profiles`.
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- A user can read/update their own profile; admins can read/update anyone's
-- (needed for the admin "assign roles" screen).
create policy "read own profile" on profiles for select using (auth.uid() = id);
create policy "read all profiles as admin" on profiles for select using (is_admin());
create policy "update own profile" on profiles for update using (auth.uid() = id);
create policy "admin manage profiles" on profiles for update using (is_admin());
create policy "admin insert profiles" on profiles for insert with check (is_admin() or auth.uid() = id);

-- ---------------------------------------------------------------------------
-- teams.status — active / inactive, for the new public Teams page
-- ---------------------------------------------------------------------------

alter table teams add column status text not null default 'active' check (status in ('active', 'inactive'));

-- ---------------------------------------------------------------------------
-- Admin write policies — teams / drivers / news_posts
-- The public "read" policies created in 0001 are untouched; these purely
-- ADD write access (and, for news, draft-visibility) for authenticated
-- admins. Postgres OR's multiple permissive policies for the same command
-- together, so admins keep the public read access too.
-- ---------------------------------------------------------------------------

create policy "admin write teams" on teams for insert with check (is_admin());
create policy "admin update teams" on teams for update using (is_admin());
create policy "admin delete teams" on teams for delete using (is_admin());

create policy "admin write drivers" on drivers for insert with check (is_admin());
create policy "admin update drivers" on drivers for update using (is_admin());
create policy "admin delete drivers" on drivers for delete using (is_admin());

create policy "admin write news" on news_posts for insert with check (is_admin());
create policy "admin update news" on news_posts for update using (is_admin());
create policy "admin delete news" on news_posts for delete using (is_admin());
-- Admins need to see drafts too, not just published posts.
create policy "admin read all news" on news_posts for select using (is_admin());

-- ---------------------------------------------------------------------------
-- Storage — team logos + driver photos. Public read (so <img> tags work
-- with no auth), admin-only write.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

create policy "public read logos" on storage.objects for select using (bucket_id = 'logos');
create policy "admin write logos" on storage.objects for insert with check (bucket_id = 'logos' and is_admin());
create policy "admin update logos" on storage.objects for update using (bucket_id = 'logos' and is_admin());
create policy "admin delete logos" on storage.objects for delete using (bucket_id = 'logos' and is_admin());

create policy "public read photos" on storage.objects for select using (bucket_id = 'photos');
create policy "admin write photos" on storage.objects for insert with check (bucket_id = 'photos' and is_admin());
create policy "admin update photos" on storage.objects for update using (bucket_id = 'photos' and is_admin());
create policy "admin delete photos" on storage.objects for delete using (bucket_id = 'photos' and is_admin());

-- ---------------------------------------------------------------------------
-- Bootstrap the first admin — run this AFTER you sign up an account (see
-- README, "Setting up the first admin"). Commented out because it needs
-- your real auth user UUID filled in; safe to leave in this file forever.
-- ---------------------------------------------------------------------------
-- update profiles set role = 'admin' where id = '<your-auth-user-uuid>';
