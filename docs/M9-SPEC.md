# Milestone 9: anyone can create a team

Status: spec, 24 Sep 2026. Extends M1–M8 (with their corrections).

Kiril's decision (24 Sep 2026, in the thread): "Anyone who signs in, with limits such as 3
teams per account and 50 members per team, plus an admin view to delete teams."

## 1. Teams live in Firestore

- `teams/{team}`: `{id, name, created_by_member, created_by_email_sha256, created_at,
  status: "active"|"deleted", roster_version, ...}`. Team ids `^[a-z][a-z0-9-]{2,31}$`
  (lower case, starts with a letter, 3–32 chars), unique; reserved: `admin`, `api`, `login`,
  `v1`, `health`, `static`, `www`, `team`, `teams`, `relay`, `console`, `demo`, `test`, and
  every team id in the config file. Display `name`: 1–60 characters, no control characters,
  shown escaped everywhere.
- Config-file teams stay (seeded as today) and are ordinary teams otherwise; they cannot be
  deleted through the API (`409 seed_team`).
- A `deleted` team is refused everywhere immediately (`404`), its credentials stop working,
  and its data is removed: the delete endpoint marks it deleted and revokes credentials in one
  transaction, then removes the team's documents in bounded batches in the same request
  (and a follow-up call resumes if it could not finish); the team id stays reserved for 31
  days.

## 2. Creating a team

- `POST /v1/teams` `{id, name, owner_member_id}`: the caller is identified by a Google
  identity (a Google ID token; a delegate on behalf of an email; or the login flow, §3) — not a
  device credential, which is team-bound. The caller becomes the team's first owner with
  `owner_member_id` and their email. Audited (email hash only).
- Limits (config `limits:`, these defaults): at most **3 teams created per Google account**
  (counted by `created_by_email_sha256` over active teams; deleting one frees a slot), at most
  **50 members per team** (M6), at most 10 team creations per account per day and 30 per client
  IP per hour. Over a limit: `429 rate_limited` or `409 team_limit` with a clear detail.
- `GET /v1/me/teams` (Google identity): the teams the account belongs to
  `[{team, name, member, role}]` — used by the console's team switcher.

## 3. The login flow

- After Google sign-in, an account on no team sees: "You're not on a team yet. Ask a team
  owner to add <email>, or create one." with a small form (team name → suggested id, editable;
  your member id → suggested from the email). Creating it makes them owner and continues to
  the chooser with the new team preselected.
- The chooser gains a "Create a new team" link (same form) for accounts that are on teams.
- Same CSRF, cookie and step rules as the rest of the flow (M5 §2).

## 4. Admins

- Config gains `admins: ["google:<email>", ...]` (relay-wide). Admin is not a team role and
  does not grant access to any team's data.
- `GET /v1/admin/teams` (admin, Google identity or delegate on behalf of an admin): every
  team with `{id, name, status, created_at, created_by_member, members, owners,
  last_activity_at}` (no emails, no content). `DELETE /v1/admin/teams/{team}` with body
  `{"confirm": "<team id>"}`. Audited in a relay-wide admin audit
  (`admin_audit/{auto}`, actor email hash, action, team, time).

## 5. The hosted console becomes multi-team

- The console's delegate is no longer bound to one team: config `team: "*"` for a delegate
  means "any team the on-behalf-of email belongs to" (still read + manage-roster only for
  owners, per team). A per-team delegate keeps working as before.
- The console server gains `GET /api/teams` (proxy of `/v1/me/teams`), `POST /api/teams`
  (create), `GET /api/admin/teams`, `DELETE /api/admin/teams/{team}` (same CSRF rules as the
  roster routes), and every existing `/api/*` route takes the team from a `team` query
  parameter or `X-Relay-Team` header validated against the viewer's teams.
  `RELAY_TEAM` becomes the default team only.
- UI: a team switcher in the header (the viewer's teams; remembers the last one), "Create
  team" (name, id, your member id), the not-on-team page offers "Create a team", and an
  **Admin** page for admins: the teams table and a delete button that asks for the team id to
  be typed. Keep the design language.

## 6. Gates

Relay: team store on both stores (create, limits, reserved ids, uniqueness under concurrency,
delete with credential revocation and batched removal, resume), login flow create paths,
`/v1/me/teams`, admin endpoints and audit, delegate `"*"` rules; `scripts/test-relay.sh`.
Plugin/console: proxy routes and team parameter validation, switcher, create form, admin page,
not-on-team create; e2e: a new account creates a team, invites a member, both sign in and
exchange a question; an admin deletes the team and both are refused.
