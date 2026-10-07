# Discord sign-ups → website roster

Design for routing driver sign-ups from the ATC Discord bot into the website, so the website is the single source of truth for the roster and car numbers.

## Goals

- Drivers keep signing up in Discord with `/atcsignup`.
- The website decides whether requested numbers are free, using its own rules.
- Sign-ups wait in a queue until an admin approves or rejects them on the website.
- Nobody retypes sign-ups by hand, and the bot's own database stops being a source of truth for the roster.

## Out of scope

- Team registration. `/atcregisterteam` stays as it is today (a Discord embed); teams are a separate project.
- Linking drivers to Discord accounts. The Discord user is stored on the sign-up request only, so the bot can DM a rejection.
- Announcing approvals in Discord.

## Flow

1. **A driver runs `/atcsignup`** in the sign-up channel with:
   - `name`: driver name (required)
   - `numbers`: 1–3 car numbers in order of preference (required)
   - `iracing_id`: iRacing customer ID (optional; admins can look it up)
2. **The bot calls `POST /api/bot/signups`.** The website checks the numbers in order, using the same rule as `set_driver_car_number()`: a number is free unless its holder's status is anything other than Inactive. A number held by the person signing up doesn't count as taken (same iRacing ID, or the same name when either side has no iRacing ID), so a current driver can re-sign with their own number. Each Discord user has at most one pending sign-up: signing up again replaces it (`replaced_previous: true`).
   - **At least one is free:** the request is saved as `pending`. The response names the number they'd get, plus who holds any earlier choices that are taken. The bot relays this to the driver (ephemeral reply).
   - **All are taken:** nothing is saved. The response lists each number and its holder, and the bot tells the driver to pick different numbers.
   - **Staff verification:** as today, the bot also posts the sign-up embed in the staff channel. It then reacts to that embed with 🤖 once the website has saved the request, or ❌ if it wasn't saved (all numbers taken, invalid input, or the website couldn't be reached). The embed gains a line saying which, e.g. "Website: pending, #2" or "Website: not saved, all numbers taken".
3. **An admin reviews it** at **Admin → Sign-ups**.
   - Each pending request shows the name, numbers, iRacing ID, Discord user and submission time.
   - **Returning drivers** are spotted by matching iRacing ID, or case-insensitive name when either side has no iRacing ID (two different IDs are two different people). The page shows "Looks like returning driver X (status, current number)".
   - **Number clashes** with other pending requests are flagged ("#33 is also requested by another pending sign-up").
   - **Approve:** the admin can correct the name and iRacing ID and picks a class (default Alpha).
     - **New driver:** a roster entry is created with today's `sign_up_date`, the rookie flag, and the first of their requested numbers that is free *at approval time*.
     - **Returning driver:** the existing entry is reactivated: Active if they've raced before, New if not, and Veterans stay Veteran. Their original `sign_up_date` is left alone. They keep their current number if they still hold one; otherwise they get the first free number from this request. An existing iRacing ID is never replaced; if the sign-up gives a different one, approval stops and asks the admin to check.
     - **Either way,** `last_signed_up_at` is set to now (see "Change to automatic status").
     - **If none of their numbers is free any more,** Approve is blocked and the admin rejects instead.
   - **Reject:** the admin picks a reason ("Your number choices are no longer available", "Duplicate sign-up", …) or writes one.
4. **The driver is told about a rejection.** Every few minutes the bot calls `GET /api/bot/signups/decisions`. For each rejection it DMs the driver with the reason, then confirms delivery with `POST /api/bot/signups/decisions/ack` so the DM is never repeated. Approvals are silent.

## API

All endpoints live under `src/pages/api/bot/`. Every request must include `Authorization: Bearer <BOT_API_TOKEN>`; anything else gets `401`. The bot only makes outgoing HTTPS requests, so the Raspberry Pi needs no open ports.

### `POST /api/bot/signups`

Request:

```json
{
  "discord_user_id": "123456789012345678",
  "discord_username": "janedoe",
  "name": "Jane Doe",
  "numbers": [1, 2, 3],
  "iracing_id": 123456
}
```

Responses:

```json
{ "status": "pending", "request_id": "…", "assigned_number": 2,
  "taken": [{ "number": 1, "holder": "John Smith" }], "replaced_previous": false }
```

```json
{ "status": "all_taken",
  "taken": [{ "number": 1, "holder": "John Smith" }, { "number": 2, "holder": "…" }, { "number": 3, "holder": "…" }] }
```

`assigned_number` is the number they'd get if approved now. It isn't reserved: it's re-checked at approval. A `400` with a message covers invalid input (no name, no valid numbers, more than 3, `discord_user_id` not sent as a string, and so on). `discord_user_id` must be a JSON string: Discord IDs are too large for JSON numbers.

### `GET /api/bot/signups/decisions`

Returns rejections whose DM hasn't been confirmed yet:

```json
{ "rejections": [{ "request_id": "…", "discord_user_id": "…", "name": "Jane Doe", "reason": "…" }] }
```

### `POST /api/bot/signups/decisions/ack`

```json
{ "request_ids": ["…"] }
```

Marks those rejections as delivered.

## Data

New table `signup_requests`:

| Column | Notes |
|---|---|
| `id` | uuid |
| `discord_user_id`, `discord_username` | Who submitted; used only for the rejection DM |
| `name` | As submitted |
| `iracing_cust_id` | Optional |
| `requested_numbers` | Integer array, preference order, 1–3 entries |
| `status` | `pending` / `approved` / `rejected` |
| `reason` | Rejection reason |
| `driver_id` | The roster entry created or reactivated on approval |
| `decided_by`, `decided_at` | Which admin, when |
| `notified_at` | When the bot confirmed the rejection DM |
| `created_at` | |

Access: admins only (RLS). The API endpoints are the only other way in.

**Writing from the API.** The endpoints run on Cloudflare with no signed-in user, so they can't use an admin's token. They use the Supabase service-role key, stored as a Cloudflare **secret** (never in `wrangler.jsonc` or the repo), and call database functions (`submit_signup_request`, `pending_signup_rejections`, `ack_signup_rejections`) that only the service role may execute. The number check and submission happen inside the database function, so the rule lives in one place.

**Secrets** (Cloudflare, set with `wrangler secret put`):

- `BOT_API_TOKEN`: shared with the bot's `.env`
- `SUPABASE_SERVICE_ROLE_KEY`

## Change to automatic status

`sync_driver_statuses()` marks New/Active drivers Inactive based on time since their **last race**. A returning driver reactivated on approval, or a brand-new driver who hasn't raced yet, would be flipped back to Inactive on the next sync and lose their number.

**Fix:** a new column, `drivers.last_signed_up_at`, set every time a sign-up for that driver is approved. Inactivity is measured from whichever is later, the driver's last race or `last_signed_up_at`, so an approval restarts the clock.

- `sign_up_date` keeps meaning "when they first joined" and is never overwritten for a returning driver.
- The existing `updated_at` column can't be used for this: it changes on *any* edit to the driver (a photo, a bio, a class fix), which would keep inactive drivers looking active.

## Bot changes (`atc_discord_bot`)

- `/atcsignup`: add an optional `iracing_id` option, call `POST /api/bot/signups` instead of querying the bot database, and relay the response. Keep the staff-channel embed, adding the website outcome line and the 🤖 / ❌ reaction.
- New background task: poll for rejections every few minutes, DM each driver, then ack.
- Remove `/staff_add_new_driver`, `/staff_update_driver` and `/staff_add_team`.
- New `.env` values: `WEBSITE_API_URL`, `BOT_API_TOKEN`.

## For Logan to review

- **Service-role key on Cloudflare.** The bot endpoints need the Supabase service-role key (full database access, bypasses RLS) stored as a Cloudflare secret. It never reaches the browser, the repo or the Pi, and it's only used to call the three sign-up database functions, which only the service role can execute. This is the standard pattern for server-side Supabase access, but it's the first time this site would hold that key.
- **Secrets aren't vars.** Per the README, `wrangler.jsonc`'s `vars` block replaces dashboard *variables* on every deploy. The two values here must be set as *secrets* (`wrangler secret put`), which deploys don't touch. Worth confirming on the first deploy.
- **Migration.** Adds `signup_requests`, `drivers.last_signed_up_at`, the sign-up database functions, and a change to `sync_driver_statuses()` (inactivity measured from the later of last race and `last_signed_up_at`).
- **Number rule.** The website's rule becomes the only one. The bot's old protection (last holder raced within 90 days, has 75+ appearances, or is a champion) goes away; anything like it would need to live in the website's Veteran handling.

## Build order

1. **Website:** migration (`signup_requests`, database functions, status-sync change), the three API endpoints, the Admin → Sign-ups page.
2. **Bot:** `/atcsignup` rewrite, rejection DMs, removal of the staff commands.
3. **Go live:** run the migration, set the Cloudflare secrets, add the token to the Pi's `.env`, deploy both.
