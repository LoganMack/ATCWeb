-- Editable wording for the three notification emails (FR2.1-FR2.7, NFR2; rules BR2.1, BR2.2, BR2.6 of the
-- email templates design).
--
-- What: public.email_templates holds at most one row per email kind (appeal_reviewed, report_posted,
-- event_reminder) with an optional subject, main message (lead) and link text. A missing row or a null field
-- means the built-in wording, so an empty table sends exactly today's emails. The admin panel's Email section
-- saves a row (upsert on kind) or deletes it to reset to the defaults; the scheduled sender reads the rows
-- with the service role once per batch. Placeholders such as {round} are checked by the site at save and again
-- when an email is rendered; the database checks only the lengths and line breaks.
--
-- Why in the database: only accounts with panel access (Admin or Staff, public.is_admin()) may read or change
-- the wording, so Row Level Security enforces it (team rule). updated_at and updated_by are stamped by a
-- trigger so the record of who last changed a template cannot be forged by the caller.
--
-- Expand only: a new table that the code on main never reads. Undo with
-- supabase/down/20261113120001_email_templates.down.sql.

create table public.email_templates (
  kind text primary key
    constraint email_templates_kind_check check (kind in ('appeal_reviewed', 'report_posted', 'event_reminder')),
  -- One line of 1 to 150 characters.
  subject text
    constraint email_templates_subject_check check (
      subject is null
      or (
        char_length(subject) between 1 and 150
        and btrim(subject) <> ''
        and position(E'\n' in subject) = 0
        and position(E'\r' in subject) = 0
      )
    ),
  -- 1 to 1000 characters; line breaks allowed (shown as <br> in the HTML part).
  lead text
    constraint email_templates_lead_check check (
      lead is null or (char_length(lead) between 1 and 1000 and btrim(lead, E' \t\r\n') <> '')
    ),
  -- One line of 1 to 60 characters.
  link_text text
    constraint email_templates_link_text_check check (
      link_text is null
      or (
        char_length(link_text) between 1 and 60
        and btrim(link_text) <> ''
        and position(E'\n' in link_text) = 0
        and position(E'\r' in link_text) = 0
      )
    ),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);

comment on table public.email_templates is
  'Optional wording for each notification email (subject, lead, link text); a missing row or null field means the built-in wording. Read and written by panel-access accounts and the service role only.';

create index email_templates_updated_by_idx on public.email_templates (updated_by);

-- Every save is stamped with its time and the signed-in caller (kept as-is for service-role writes).
create function private.stamp_email_template() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  -- The ON DELETE SET NULL of updated_by, when the account that last saved it is deleted: not a save.
  if tg_op = 'UPDATE' and new.updated_by is null and old.updated_by is not null
     and (new.subject, new.lead, new.link_text) is not distinct from (old.subject, old.lead, old.link_text) then
    return new;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

revoke all on function private.stamp_email_template() from public, anon, authenticated, service_role;

create trigger email_templates_stamp
  before insert or update on public.email_templates
  for each row
  execute function private.stamp_email_template();

alter table public.email_templates enable row level security;

create policy "panel read email_templates" on public.email_templates
  for select to authenticated
  using ((select public.is_admin()));

create policy "panel insert email_templates" on public.email_templates
  for insert to authenticated
  with check ((select public.is_admin()));

create policy "panel update email_templates" on public.email_templates
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "panel delete email_templates" on public.email_templates
  for delete to authenticated
  using ((select public.is_admin()));

-- Supabase grants every new public table to anon and authenticated by default, so start from nothing.
revoke all on table public.email_templates from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.email_templates to authenticated, service_role;
