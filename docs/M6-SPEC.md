# Milestone 6: the owner manages members in the console

Status: spec, 24 Sep 2026. Built together with M5; extends M1–M5.

Kiril's decision (24 Sep 2026, in the thread): add members by (Google) email from the console
instead of editing files and the OAuth test-user list.

## 1. The roster lives in Firestore

- `teams/{team}/roster/{member}`: `{member, emails: [lower-cased google emails, 1..5], role:
  "owner"|"member", added_by, added_at, updated_at}`. `teams/{team}` gains
  `{roster_version}` incremented on every change.
- The team config file keeps: the list of teams, each team's **seed owners** (member id and
  emails), `limits`, `audit_retention_days`, `delegates`. On startup the relay upserts the seed
  owners into the roster (role owner; never removes anyone; idempotent). Everything else about
  membership comes from the roster. A team with no roster document for a principal has no such
  member, whatever the file says.
- Resolution (credential, Google ID token, delegate on-behalf-of): principal `google:<email>`
  → the roster entry in the URL's team whose `emails` contains it. Cached per team for at
  most 30 s, keyed on `roster_version` (a cheap read of `teams/{team}` validates the cache),
  so an added member works and a removed member is refused within 30 s.
- A removed member's device credentials are revoked in the same transaction as the removal.
- Invariants, enforced transactionally: a team always has at least one owner; an email belongs
  to at most one member per team; member ids `^[a-z][a-z0-9_]{1,31}$`, unique per team; at most
  50 members per team.

## 2. Owner endpoints (relay)

Owner role required (else `403`), audited (actor, action, member id, email **hash** only):
- `GET /v1/teams/{team}/roster` → `{members: [{member, emails, role, added_by, added_at}]}`.
  Members (non-owners) may read it too, without emails except their own (emails of others
  masked to `null`).
- `POST /v1/teams/{team}/roster` `{member, email, role?: "member"}` → `201` (member id taken or
  email already present: `409`).
- `PATCH /v1/teams/{team}/roster/{member}` `{add_email?, remove_email?, role?}`.
- `DELETE /v1/teams/{team}/roster/{member}` → removes and revokes credentials; an owner cannot
  remove the last owner (`409`).
Rate limit: 30 roster mutations per owner per hour.

## 3. Delegates may manage for an owner

The hosted console's delegate gains scope `manage-roster` in addition to `read` (config:
`scope: [read, manage-roster]`). With it, and only when the on-behalf-of member is an owner,
the delegate may call the §2 mutations; everything else stays read-only. The console server
proxies exactly `GET/POST /api/roster`, `PATCH/DELETE /api/roster/{member}` (hosted and local),
requires `Content-Type: application/json`, `Sec-Fetch-Site: same-origin` for non-GET, and
the local key or IAP as today.

## 4. Console

- A **Members** panel (owners only; members see a read-only list of names and roles): add by
  email (with a suggested member id from the local part, editable), remove (with a confirm
  step naming the person), make/unmake owner. Errors shown inline. The join panel tells an
  owner how to invite: "Add their Google email here, then send them the install steps."
- A signed-in Google account that is not on the team: a clear "You're not on this team yet.
  Ask the owner to add <email>." page and no data.

## 5. IAP and the consent screen

- The hosted console's IAP access becomes `allAuthenticatedUsers` (any signed-in Google
  account reaches the page; the relay decides membership, §4 page for non-members).
  `scripts/deploy-console.sh` reconciles that binding instead of per-member ones.
- Kiril switches the OAuth consent screen to "In production" (scopes are only `openid` and
  `email`, so no Google verification), after which no test-user list is needed. Documented
  in the README's "Run your own relay".

## 6. Gates

- Relay: roster store operations on both stores (invariants, transactions, cache and
  `roster_version`, seed upsert, credential revocation on removal), owner endpoints and
  masking, delegate `manage-roster` only for owners, rate limit, audit hashing;
  `scripts/test-relay.sh`.
- Plugin: console server proxy rules for the roster routes (methods, content type,
  Sec-Fetch-Site, key/IAP); e2e: owner adds a member, the new member logs in (M5 flow with the
  fake provider) and appears in the directory; removal revokes within 30 s.
- Console: Members panel for owner and member views, not-on-team page; tests; build.
