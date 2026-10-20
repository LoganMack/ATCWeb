-- Alpha Touring Challenge — admin user management helpers
--
-- Admin > Users now shows each login's email address and can delete a user.
-- Email lives in auth.users, which the REST API never exposes, so both needs
-- go through SECURITY DEFINER functions that check is_admin() themselves.

-- Every login's email, for the Users list.
create or replace function public.admin_list_user_emails()
returns table (id uuid, email text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can list user emails' using errcode = 'insufficient_privilege';
  end if;
  return query select u.id, u.email::text from auth.users u;
end;
$$;

revoke all on function public.admin_list_user_emails() from public;
grant execute on function public.admin_list_user_emails() to authenticated;

-- Deletes a login (and, by cascade, its profile). Admins can't delete themselves.
-- Their incident reports are kept (reporter detached) rather than cascade-deleted;
-- appeals, activity-log rows and driver audit columns already detach on delete.
create or replace function public.admin_delete_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete users' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot delete your own account' using errcode = 'invalid_parameter_value';
  end if;
  update public.incident_reports set reporter_id = null where reporter_id = p_user_id;
  delete from auth.users where id = p_user_id;
  if not found then
    raise exception 'No such user' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.admin_delete_user(uuid) from public;
grant execute on function public.admin_delete_user(uuid) to authenticated;
