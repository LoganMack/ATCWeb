-- Alpha Touring Challenge — driver-submitted incident APPEALS
--
-- Once a round's incident report is posted (0092), anyone can open an
-- incident's details popup on the Incident Report page and press "Submit
-- Appeal" for as long as the "Incident Appeal Window" is open (admin > Site
-- Properties, site_settings key 'incident_appeal_period_hours', default 24).
-- The window counts from the moment the report was POSTED (new column
-- round_incident_status.posted_at below), because that's when drivers can
-- first see the incident. Rounds posted before this migration (including the
-- pre-ATC18-R3 backfill) have no posted_at, so their appeal window is closed.
--
-- An appeal is a free-text message plus up to 3 files (max 10 MB each, held
-- in the private 'incident-appeals' storage bucket). Like incident reports
-- (0091) it is submitted through a SECURITY DEFINER function so signed-out
-- visitors can appeal too; only admins can read, update or delete appeals and
-- their files. The window itself is enforced in the app
-- (src/lib/incidentAppeals.ts), not here.

-- 1. When a round was posted --------------------------------------------------
alter table round_incident_status add column if not exists posted_at timestamptz;

-- Rounds already posted before this change keep posted_at = null (appeals closed).

-- 2. The appeals themselves ---------------------------------------------------
create table if not exists incident_appeals (
  id uuid primary key,
  subsession_id bigint not null,
  penalty_id uuid not null references penalties (id) on delete cascade,
  message text not null,
  -- [{ "path": "<appeal id>/1-clip.mp4", "name": "clip.mp4", "size": 123, "type": "video/mp4" }, ...]
  files jsonb not null default '[]'::jsonb,
  submitter_id uuid references auth.users (id) on delete set null,
  submitter_name text,
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now()
);

create index if not exists incident_appeals_subsession_idx on incident_appeals (subsession_id);
create index if not exists incident_appeals_penalty_idx on incident_appeals (penalty_id);

alter table incident_appeals enable row level security;

drop policy if exists "admin read incident_appeals" on incident_appeals;
create policy "admin read incident_appeals" on incident_appeals for select using (is_admin());
drop policy if exists "admin update incident_appeals" on incident_appeals;
create policy "admin update incident_appeals" on incident_appeals for update using (is_admin());
drop policy if exists "admin delete incident_appeals" on incident_appeals;
create policy "admin delete incident_appeals" on incident_appeals for delete using (is_admin());

-- 3. Submission function (open to signed-out visitors) -----------------------
create or replace function public.submit_incident_appeal(
  p_id uuid,
  p_penalty_id uuid,
  p_message text,
  p_files jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_subsession bigint;
begin
  if p_id is null then raise exception 'invalid id'; end if;
  if coalesce(btrim(p_message), '') = '' or length(p_message) > 4000 then raise exception 'invalid message'; end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 3 then
    raise exception 'invalid files';
  end if;

  select subsession_id into v_subsession from penalties where id = p_penalty_id;
  if v_subsession is null then raise exception 'unknown incident'; end if;

  if v_uid is not null then
    -- A login linked to a roster driver (Admin > Users > Driver) is named after that driver.
    select coalesce(d.name, p.display_name, u.email) into v_name
    from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
    where u.id = v_uid;
  end if;

  insert into incident_appeals (id, subsession_id, penalty_id, message, files, submitter_id, submitter_name)
  values (p_id, v_subsession, p_penalty_id, btrim(p_message), p_files, v_uid, v_name);

  return p_id;
end;
$$;

revoke all on function public.submit_incident_appeal(uuid, uuid, text, jsonb) from public;
grant execute on function public.submit_incident_appeal(uuid, uuid, text, jsonb) to anon, authenticated;

-- 4. Private storage bucket for the attached files ---------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'incident-appeals', 'incident-appeals', false, 10485760,
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm', 'video/quicktime', 'text/plain']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Anyone may upload (the app checks the appeal window first); only admins may read or delete.
drop policy if exists "anyone upload incident-appeals" on storage.objects;
create policy "anyone upload incident-appeals" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'incident-appeals');
drop policy if exists "admin read incident-appeals" on storage.objects;
create policy "admin read incident-appeals" on storage.objects
  for select using (bucket_id = 'incident-appeals' and is_admin());
drop policy if exists "admin delete incident-appeals" on storage.objects;
create policy "admin delete incident-appeals" on storage.objects
  for delete using (bucket_id = 'incident-appeals' and is_admin());

-- 5. Appeal window setting ----------------------------------------------------
insert into site_settings (setting_key, value)
values ('incident_appeal_period_hours', '24')
on conflict (setting_key) do nothing;
