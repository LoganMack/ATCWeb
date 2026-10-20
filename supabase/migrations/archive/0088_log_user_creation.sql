-- Alpha Touring Challenge — log new user accounts in the activity log
--
-- handle_new_user() (0002_auth_admin.sql) already fires reliably for EVERY
-- new auth.users row — self-service sign-up (src/pages/signup.astro),
-- confirmed or not, and any future account-creation path (e.g. an eventual
-- "Login with iRacing" identity) — so it's the single most robust place to
-- record "a user account was created," per Logan: "the activity log should
-- also show when users are created."
--
-- App-level code (signup.astro) used to write its own activity_log row
-- immediately after sign-up, but only reached that code when Supabase's
-- email-confirmation requirement is OFF (no session/access-token exists yet
-- otherwise, and the RLS insert policy needs one — see 0051's own comment).
-- That app-level call is removed in this same change; this trigger replaces
-- it as the single, unconditional source of "user added" log rows, `security
-- definer` letting it write past activity_log's RLS exactly the way it
-- already writes past profiles' RLS just above.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');

  insert into public.activity_log (actor_id, actor_name, action, entity_type, entity_label, entity_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.email, 'Unknown'),
    'add',
    'user',
    coalesce(new.raw_user_meta_data ->> 'display_name', new.email, 'Unknown'),
    new.id::text
  );

  return new;
end;
$$;
