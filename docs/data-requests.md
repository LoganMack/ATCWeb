# Data export and deletion requests

How an admin handles a driver's request to see (export) or remove (delete) the personal data the site holds about them. There is no self-service button; an admin runs these steps by hand. Answer within 30 days and keep a short note of what was done and when (outside the database, for example in the admin channel).

## 1. Identify the person

Confirm the request comes from the person themselves (for example from the email address on their account, or from their Discord account to the admin). Then find their ids. In the Supabase SQL editor, run as the project owner:

```sql
-- Replace the email. Returns the login id, profile and linked roster driver.
select u.id as user_id, u.email, u.created_at, u.last_sign_in_at,
       p.display_name, p.role, p.driver_id, p.iracing_cust_id, p.iracing_name,
       d.name as driver_name
from auth.users u
left join public.profiles p on p.id = u.id
left join public.drivers d on d.id = p.driver_id
where lower(u.email) = lower('driver@example.com');
```

A driver who never made a login only has a roster row in `drivers` (and possibly a `signup_requests` row from the Discord bot); find them by name or iRacing customer id instead.

## 2. Export: gather everything

Every query below is read-only. Replace `:user_id` and `:driver_id` with the ids from step 1 (or drop the lines for an id the person doesn't have) and send the results to the person as CSV or JSON.

```sql
-- Account and profile
select id, email, created_at, last_sign_in_at from auth.users where id = :user_id;
select * from public.profiles where id = :user_id;

-- Roster entry and per-season data
select * from public.drivers where id = :driver_id;
select * from public.driver_season_classes where driver_id = :driver_id;
select * from public.driver_season_car_numbers where driver_id = :driver_id;
select * from public.team_rosters where driver_id = :driver_id;

-- Things they submitted while signed in
select * from public.incident_reports where reporter_id = :user_id;
select * from public.incident_appeals where submitter_id = :user_id;
select * from public.incident_report_reviews where reviewer_id = :user_id;
select * from public.kudos where author_id = :user_id;
select * from public.race_interviews where driver_id = :driver_id or submitter_id = :user_id;

-- Discord sign-up requests (matched by name or iRacing id, since there is no login link)
select * from public.signup_requests where driver_id = :driver_id;

-- Admin activity that names them (kept, see section 4)
select created_at, actor_name, action, entity_type, entity_label, details
from public.activity_log
where entity_id in (:user_id::text, :driver_id::text) or actor_id = :user_id;
```

Race results (`curated_*_results`, `race_scores`) and penalties are league records about races, not the account; include them in an export if asked, but they are not deleted (see section 5).

Storage files belonging to them:

| Bucket | Where their files are |
|---|---|
| `photos` | `driver-avatars/<driver_id>/…` (their own profile photos); admin-uploaded photos are listed in `drivers.photo_url` |
| `race-interviews` | `<driver_id>/<subsession_id>.<ext>` (and older clips at the paths in `race_interviews.audio_path`) |
| `incident-appeals` | `<user_id>/<appeal id>/…`, also listed in `incident_appeals.files` |

Download them from the Supabase dashboard (Storage) and include them in the export.

## 3. Delete: remove the account and its files

1. **Login and profile.** In the admin panel, Users, delete the user. That calls `admin_delete_user`, which clears their id from `incident_reports.reporter_id` and deletes the `auth.users` row; the `profiles` row is deleted with it. Rows that pointed at the user by `on delete set null` (appeals, interviews, round penalties, sign-up decisions) keep the record but lose the link; rows `on delete cascade` (kudos, steward reviews) are removed.
2. **Roster entry.** If they also want to leave the roster, delete or anonymise the driver in Admin, Drivers. Deleting a driver who has race results removes them from historical results and standings, so for a past racer prefer renaming the driver to "Former driver" and clearing the bio, photo and iRacing id.
3. **Names copied into records.** Some tables keep a copy of the name at the time of writing: `incident_reports.reporter_name`, `incident_appeals.submitter_name`, `incident_report_reviews.reviewer_name`, `kudos.author_name`. Clear them for this person:

   ```sql
   update public.incident_reports set reporter_name = null where reporter_name = 'Their Name';
   update public.incident_appeals set submitter_name = null where submitter_name = 'Their Name';
   ```

4. **Storage files.** Delete their folders from the three buckets in the table above (Supabase dashboard, Storage).
5. **Discord sign-up requests.** Delete their `signup_requests` rows if the request covers them.

Check afterwards by re-running the export queries: they should return nothing (or only the anonymised roster row).

## 4. What is kept: the activity log

`activity_log` rows are an audit trail of admin actions and are **kept** when a person asks to be deleted (owner decision, security fixes FR7.2). Since the security fixes, deleting a user logs only their user id. Rows written before that change may still contain the deleted person's email in `details`; they are left unchanged by decision, and removed only if the person specifically asks:

```sql
update public.activity_log set details = 'User deleted' where entity_type = 'user' and entity_id = :user_id::text;
```

## 5. iRacing customer ids are public (decision)

iRacing customer ids (`drivers.iracing_cust_id`, `curated_*_results.cust_id`) stay publicly readable. iRacing itself publishes these ids with every official and league result, so hiding them here would protect nothing, and results pages link to iRacing by them. Decided by the owner during the 2026-10 security review (SEC-15, Q7 A); future reviews should not raise it again unless the site starts showing ids iRacing does not already publish.
