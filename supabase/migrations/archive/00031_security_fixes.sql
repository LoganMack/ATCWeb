-- Alpha Touring Challenge — security fix: profile role self-escalation
--
-- Found 2026-07-25 while bringing the Tier 1 refactor up in WSL. Live in
-- production; this migration closes it. See HANDOFF.md "Security items".
--
-- (An earlier draft of this file also RLS-locked the raw `races`/`seasons`
-- tables. That half is now obsolete: `races` is dropped in 0005, and `seasons`
-- is the legitimate 0001 app table meant to stay publicly readable. Only the
-- profile trigger below remains.)

-- ---------------------------------------------------------------------------
-- 1. Profile role self-escalation
-- ---------------------------------------------------------------------------
--
-- THE HOLE: the "update own profile" policy in 0002_auth_admin.sql is
--
--     create policy "update own profile" on profiles
--       for update using (auth.uid() = id);
--
-- It has no WITH CHECK, so Postgres reuses the USING expression as the check —
-- meaning a user may update their own row to *anything*, including
-- `role = 'admin'`. Any signed-in driver could `PATCH /rest/v1/profiles?id=eq.<self>`
-- with `{"role":"admin"}` and grant themselves the admin bit that gates every
-- write policy in 0002. RLS is the security boundary here (see HANDOFF §1), so
-- this is a full privilege escalation, reachable with only the public anon key.
--
-- WHY A TRIGGER AND NOT JUST A BETTER WITH CHECK: an RLS policy's WITH CHECK
-- only ever sees the NEW row — it cannot reference the OLD row, so it can't
-- express "the role column did not change". A BEFORE UPDATE trigger can see
-- both OLD and NEW, so that's the reliable place to enforce it.
--
-- We intentionally leave the "update own profile" policy permissive: users must
-- still be able to edit their own display_name (and, later, link their own
-- driver row). The trigger only guards the `role` column specifically.
--
-- Admins are unaffected: is_admin() is true for them, so the "assign roles"
-- screen keeps working. (The app's separate "can't demote yourself" guard from
-- Tier 1 is a UX safeguard on top of this, not a substitute for it.)

create or replace function public.prevent_role_self_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only fire on an actual role change; ordinary profile edits (display_name,
  -- driver_id, iracing_*) leave role untouched and pass straight through.
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'Only an admin can change a profile role'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_prevent_role_self_escalation on public.profiles;
create trigger profiles_prevent_role_self_escalation
  before update on public.profiles
  for each row execute function public.prevent_role_self_escalation();
