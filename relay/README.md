# relay

The team relay of `docs/M1-SPEC.md` (sections 1 to 7, with its §11 corrections) and
`docs/M2-SPEC.md` §1 to §3 (with the relay's part of its §7 corrections), the read-only
delegates of `docs/M3-SPEC.md` §2, the sign-in and device credentials of `docs/M5-SPEC.md`
§2 to §5, the roster of `docs/M6-SPEC.md` §1 to §3 and the teams anyone can create of
`docs/M9-SPEC.md` §1 to §5 (the relay's part): FastAPI, stateless, with Firestore as the
per-member mailbox, the roster and the teams. No background workers: deadlines fire lazily when the
asker polls `replies` or anyone reads a request.

## Layout

| Path | What |
|---|---|
| `relay/config.py` | team config (`RELAY_TEAM_CONFIG`): teams and their seed members, limits, `audit_retention_days`, `delegates` (M3 §2, M6 §3); settings from env, the OAuth client file and `RELAY_PUBLIC_URL` (M5 §5) |
| `relay/roster.py` | the roster (M6 §1): the per-team cache validated by `roster_version`, the seed upsert, and the pure change functions with every invariant |
| `relay/teams.py` | teams (M9): which teams exist (the file's, and the created ones by their record), creating one, `/v1/me/teams`, the admin listing, deletion and its batched removal |
| `relay/credentials.py` | device credentials (M5 §3): minting, hashing, the 60 s cache, the rolling expiry |
| `relay/oauth.py` | the relay's own Google sign-in (M5 §2): fixed endpoints, the code exchange, RS256 ID token verification over Google's JWKS |
| `relay/login.py` | the login flow (M5 §2): start, callback, chooser POST, token, and creating a team from it (M9 §3); per-IP rate limits |
| `relay/pages.py` | the login pages and their stylesheet: escaped, no scripts, strict CSP |
| `relay/auth.py` | the `google` verifier (§2, §11.8, M2 §2: a list of audiences) and the `static` one, which refuses to start under `K_SERVICE` |
| `relay/jsonutil.py` | the strict body parser (§11.9), canonical JSON and hashing |
| `relay/models.py` | request bodies, strict, `extra="forbid"` |
| `relay/manifest.py` | schema validation, the §3.3 checks, RE2 patterns (§11.1), param validation with defaults (§3.5, §11.2) |
| `relay/store.py` | the store protocol: `create_request`, `mutate_request`, `set_cursor`, `count_quota`, `mutate_roster`, `mutate_login`, `redeem_code`, `create_team`, `delete_team`, `purge_team` and reads; `stamp_deliveries`, the one delivery-time rule both stores run (M2 §3.2); `monotonic_updated_at` (M2 §7.1) |
| `relay/store_memory.py`, `relay/store_firestore.py` | the two stores; one contract suite covers both |
| `relay/service.py` | the state machine, the sweep (§4), audit (§7), tool events, the activity feed and the directory's stats (M2 §3); store-agnostic |
| `relay/app.py` | `create_app(settings, store, oauth=…)`; `relay.app:app` builds one from env; authentication (device credentials, Google ID tokens, static tokens, delegates with `X-Relay-On-Behalf-Of`, the any-team delegate), the delegate routes (M3 §2, M6 §3, M9 §5), the account and admin routes (M9 §2, §4), the login pages (M5 §2) |
| `firestore.indexes.json` | the one composite index, for the sweep (`asker ASC, next_deadline ASC`); the feed, the stats, the roster, the credentials and the teams need none |
| `tests/fake_google.py`, `tests/fake_oauth_app.py` | a fake Google for the tests, and a launcher that serves the relay with it for the plugin's e2e (below) |
| `Dockerfile` | the Cloud Run image |

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"

# a Firestore emulator in Docker on 127.0.0.1:8681
export FIRESTORE_EMULATOR_HOST="$(../scripts/emulator.sh start 8681 ma-fs-dev)"
export GOOGLE_CLOUD_PROJECT=demo-relay

# static tokens are for local development only; the config holds their SHA-256
printf %s "$MY_DEV_TOKEN" | shasum -a 256   # -> token:sha256:<hex> in the team file
RELAY_AUTH_MODE=static RELAY_TEAM_CONFIG=../config/team.local.yaml .venv/bin/python -m relay

../scripts/emulator.sh stop ma-fs-dev
```

`python -m relay` serves `relay.app:app` with uvicorn (`uvicorn relay.app:app` works too).

## Tests

```bash
../scripts/test-relay.sh      # starts an emulator on 8681 (container ma-fs-test), runs everything, stops it
.venv/bin/pytest -q           # without an emulator the Firestore half is skipped, with the reason
.venv/bin/ruff check .
```

The example team file tests read `../config/team.example.yaml`; `RELAY_TEST_EXAMPLE_CONFIG`
points them at another copy (tests only).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_TEAM_CONFIG` | required | path to the team YAML (`../config/team.example.yaml` shape, M6 below); on Cloud Run the mounted secret `/secrets/team/team.yaml` |
| `RELAY_PUBLIC_URL` | unset; required on Cloud Run | the relay's own origin, e.g. `https://team-relay-….run.app` (no path, query or fragment; a trailing slash is dropped). Google's redirect URI is `{RELAY_PUBLIC_URL}/v1/login/callback`. `https` always, except `http://127.0.0.1` or `http://localhost` off Cloud Run |
| `RELAY_OAUTH_CLIENT_FILE` | unset; required on Cloud Run | path to the relay's OAuth client, a JSON object with string `client_id` and `client_secret` (other keys ignored); on Cloud Run the mounted secret `team-relay-oauth-client`. Goes with `RELAY_PUBLIC_URL`: both or neither. Without them the login pages answer `404` |
| `RELAY_AUTH_MODE` | `google` | `google` or `static`; `static` is refused when `K_SERVICE` is set |
| `RELAY_AUDIENCE` | required for `google` | the accepted ID token audiences, comma-separated (on Cloud Run: gcloud's OAuth client id and the service URL); whitespace around an entry is dropped, an empty entry is a startup error |
| `RELAY_MANIFEST_SCHEMA` | `../schema/manifest.schema.json` from this directory | the image sets `/app/schema/manifest.schema.json` |
| `GOOGLE_CLOUD_PROJECT` | from ADC | Firestore project |
| `RELAY_FIRESTORE_DATABASE` | `(default)` | Firestore database id (`team-relay` on Cloud Run) |
| `FIRESTORE_EMULATOR_HOST` | unset | use the emulator (local only) |
| `PORT` | `8080` | listen port |
| `RELAY_HOST` | `127.0.0.1` | listen address; the image sets `0.0.0.0` |
| `RELAY_LOG_LEVEL` | `info` | uvicorn log level |

The team config file also carries `audit_retention_days` (default 90) and a `limits:`
block, all optional:

| Key under `limits:` | Default | Meaning |
|---|---|---|
| `min_ack_timeout_seconds` | 10 | lower bound for a request's `ack_timeout_seconds` |
| `min_answer_timeout_seconds` | 60 | lower bound for a request's `answer_timeout_seconds` |
| `requests_per_minute` | 30 | requests one member may create per calendar minute (broadcasts included) |
| `broadcasts_per_minute` | 5 | broadcasts one member may create per calendar minute |
| `audited_refusals_per_minute` | 60 | refused mutations per member per minute written to the audit log; the rest go to stdout (`refusal_not_audited`) |
| `concurrent_polls` | 2 | long-polls (`wait > 0`) at once per member and stream, per relay instance |
| `reads_per_minute` | 120 | reads of `/activity`, `/directory` and `/inbox/summary` together, per member and calendar minute (M2-SPEC §7.3, M7-SPEC §1) |
| `login_starts_per_minute` | 20 | `GET /v1/login/start` per client IP and calendar minute (M5-SPEC §2) |
| `login_pages_per_minute` | 30 | `GET /v1/login/callback` and `POST /v1/login/choose` together, per client IP and minute |
| `login_tokens_per_minute` | 20 | `POST /v1/login/token` per client IP and minute |
| `roster_mutations_per_hour` | 30 | roster changes (add, patch, remove) per owner and calendar hour (M6-SPEC §2); refusals do not count |
| `teams_per_account` | 3 | teams one Google account has created and not deleted (M9-SPEC §2); deleting one frees the slot |
| `members_per_team` | 50 | members per team, at most 50 (a broadcast writes one envelope per member in one transaction); the seed obeys it too |
| `team_creations_per_account_per_day` | 10 | team creations per Google account and calendar day (UTC); refusals do not count |
| `team_creations_per_ip_per_hour` | 30 | team creations per client IP and calendar hour (not counted for a delegate, whose address is the console's) |

`reads_per_minute` is also the budget of the account routes (`/v1/me/teams`, `POST
/v1/teams`, `/v1/admin/teams`), per Google account and minute (M9).

## The team file and the roster (M6-SPEC §1, 24 Sep 2026)

Membership lives in Firestore (`teams/{team}/roster/{member}`: `member`, `emails` (1..5
lower-cased Google emails), `role` (`owner` or `member`), `added_by`, `added_at`,
`updated_at`, `subs` (`[{email, sub}]`, the Google account each email is bound to);
`teams/{team}.roster_version` counts every change). The team file keeps the
teams, each team's **seed** members, `limits`, `audit_retention_days` and `delegates`:

```yaml
teams:
  - id: demo
    members:
      - id: alice
        role: owner
        principals:
          - "google:alice@example.com"
      - id: bob
        principals:
          - "google:bob@example.com"
      - id: carol
        principals:
          - "google:carol@example.com"
delegates:
  - principal: "google:team-relay-console@<project>.iam.gserviceaccount.com"
    team: demo
    scope: [read, manage-roster]
```

- **The seed, read this way:** when a team is first used (at startup, and lazily before its
  roster is first read), every file member whose id the roster does not hold is added with
  its `role` (default `member`) and the emails of its `google:` principals. An entry already
  on the roster is never changed by the file: never demoted, never re-promoted, its emails
  never merged; nobody is ever removed by it. A seed whose email another entry holds, whose
  id is retired (below) for other emails, or that would pass 50 members is skipped and
  logged (`roster_seeded`). Idempotent: a second start writes nothing.
- **Startup errors:** a team without a `role: owner`, a role other than `owner`/`member`,
  more than 5 `google:` principals on a member, a member id twice in one team, a principal
  twice in one team, anything the M1–M3 rules already refused. A principal (and a member
  id) may appear in several teams, once per team (M5-SPEC §4).
- **`token:sha256:` principals** (static development tokens) never enter the roster. They
  resolve to the member the file names for the URL's team, and only while that member is on
  the roster.
- **A member listed in the file cannot be removed through the API** (`409 seed_member`):
  the seed would add them back at the next start. Take them out of the file first. They can
  be demoted, and their emails changed, and that sticks.
- **Resolution:** a `google:<email>` principal (a Google ID token, a delegate's
  `X-Relay-On-Behalf-Of`, the login) is the roster entry of the URL's team whose `emails`
  hold the email. A principal on another team but not this one gets `404`; on no team,
  `401`. Each process caches a team's roster and trusts it for at most 30 s by its clock,
  then validates it with one read of `roster_version` (a full reload only when it moved).
  A change made through this process takes effect at once there; on other instances within
  30 s. `GET /roster` always validates.
- **401 versus 404** (M6-SPEC §7.4, pinned by `tests/test_review_corrections.py`): whatever
  the kind of bearer (Google ID token, static token, device credential), a principal that is
  on no team at all is `401 unauthenticated`; one on another team but not the URL's is
  `404 not_found`. A removed member (on no team) is `401`.
- **Accounts are bound by Google `sub`** (M6-SPEC §7.2). The first successful relay sign-in
  with a roster email records that Google account's `sub` on the entry (`subs`; audited
  `roster.bind`, actor the member, the email's hash). From then on that email belongs to that
  account: a sign-in by another account with the same email ends at the callback with "This
  email now belongs to a different Google account" and "Ask the owner." (logged
  `login_refused` `sub_mismatch`; never the sub). The binding is recorded (or checked again)
  at `POST /v1/login/choose` in one roster transaction, so of two first sign-ins racing only
  one binds, and the other is refused before a code is minted. **Removing the email clears
  its binding**; removing the member deletes the entry and its bindings. Neither the seed nor
  any other change touches a binding.
  - **Google ID tokens (gcloud users):** the token's `sub` is checked against the binding
    (another account: `401`, or `404` when the principal is a member elsewhere); an unbound
    email is bound by its first call to its own team (not by a call to another team's URL).
    The verifier refuses an ID token without a `sub`.
  - **Delegates** (the hosted console): the delegate's token is the console's service
    account; `X-Relay-On-Behalf-Of` names the member by email only, so there is no member
    `sub` on that path to bind or check. The console's IAP identity is the check there.
- **Invariants,** checked inside the transaction that writes: at least one owner; an email
  in at most one entry of a team; member ids `^[a-z][a-z0-9_]{1,31}$`, unique in the team;
  at most 50 members; 1..5 emails an entry (a token-only seed member may have none); a
  delegate's email is never a member's.
- **Retired ids:** removing a member retires their id (`teams/{team}/retired/{member}`,
  with the SHA-256 of every email it had, `expire_at` 31 days, longer than any request can
  live). While retired, the id is given again only with one of those emails (the same person
  coming back); anyone else is `409 member_id_retired`. Otherwise a new person under an old
  id would read that id's inbox and requests. Re-adding keeps the record, so a later removal
  remembers every email the id ever had.

### Roster endpoints (M6-SPEC §2)

Owner role required for the mutations (else `403 forbidden`), checked against the roster the
transaction reads. Every change is audited (`roster.add`, `roster.email_add`,
`roster.email_remove`, `roster.role`, `roster.remove`; the sign-in's `roster.bind`) with
`actor`, the `member` it is about and `email_sha256` (never an email); refusals are audited
like any refused mutation.

- `GET /v1/teams/{team}/roster` → `{"members": [{member, emails, role, added_by, added_at}],
  "roster_version"}`, by member id. An owner sees every email; anyone else sees only their
  own (`emails: null` for the others). Delegates may read it (masked as the member named).
- `POST /v1/teams/{team}/roster` `{member, email, role?}` (`role` defaults to `member`) →
  `201` with the entry. `409 member_exists`, `409 email_taken`, `409 team_full`,
  `409 member_id_retired`; `422 invalid_body` for a bad id or email, a delegate's email, or any
  other field.
- `PATCH /v1/teams/{team}/roster/{member}` `{add_email?, remove_email?, role?}` (at least
  one) → `200` with the entry; a change that changes nothing writes nothing. `409
  email_taken`, `409 too_many_emails`, `409 no_such_email`, `409 last_email` (removing the
  only email, unless the same call adds one), `409 last_owner` (demoting the last owner);
  `404` for an unknown member.
  - **No identity handover by email** (M6-SPEC §7.1): `add_email` is accepted only on the
    caller's own entry (an owner adding their own second Google account). On anyone else's
    entry the whole call is `403 forbidden` ("… remove and re-add the member"), whatever else
    it asks, so an owner can never sign in as someone else through an email of their own.
    Through a delegate the caller is the owner it names, so the same rule holds.
  - **`remove_email` revokes**, in the same transaction, every live credential of that
    member minted through that email (credentials record `email_sha256`), and also any of
    their live credentials that records no email (minted before it was recorded; it may have
    come through that email). Credentials minted through the member's other emails keep
    working.
- `DELETE /v1/teams/{team}/roster/{member}` → `200 {"removed": member}`: the entry is
  deleted, the id retired, and every live device credential of the member revoked, in one
  transaction. `409 last_owner`, `409 seed_member`, `404`.
- Rate limit: `limits.roster_mutations_per_hour` (30) successful changes per owner and
  calendar hour, counted in the same transaction: `429 rate_limited`.
- `GET /v1/teams/{team}/me` also returns the caller's `role`.

### Delegates that manage the roster (M6-SPEC §3)

`scope` is `read` (as in M3) or a list holding `read` and optionally `manage-roster`. With
`manage-roster` a delegate may also call `POST /roster`, `PATCH` and `DELETE
/roster/{member}` (`ROSTER_MUTATIONS` in `relay/app.py`); the service then requires the
member it names to be an owner, as for anyone. Its changes are audited with the owner as the
actor and `via delegate` in the detail, and logged as `delegated_change`. Everything else
stays read-only (`403`).

## Signing in from Claude Code (M5-SPEC §2, 24 Sep 2026)

Loopback + PKCE, RFC 8252 style. The login pages need no credentials; everything else
authenticates as before.

1. `GET /v1/login/start?port&state&code_challenge&code_challenge_method=S256&device`: port
   1024..65535 (no leading zero), `state` `^[A-Za-z0-9_-]{32,128}$`, `code_challenge`
   43 base64url characters, `device` `^[A-Za-z0-9 ._()-]{1,64}$`; each exactly once, else
   `400` (an HTML page). Creates `logins/{sha256(login id)}` (the plugin's port, state,
   challenge and device; the relay's own nonce and PKCE verifier for Google; step `google`;
   `expire_at` in 10 minutes), sets `trl=<login id>; HttpOnly; Secure; SameSite=Lax;
   Path=/v1/login; Max-Age=600` and redirects (`302`) to Google with `client_id`,
   `redirect_uri={RELAY_PUBLIC_URL}/v1/login/callback`, `response_type=code`,
   `scope=openid email`, `state=<login id>`, `nonce`, `code_challenge` (S256),
   `prompt=select_account`.
2. `GET /v1/login/callback`: the `trl` cookie must equal `state` (constant time), and the
   login must be at step `google` and unexpired; it moves to `exchanging` in one transaction,
   so a replayed callback stops there. The code is exchanged at Google's token endpoint with
   the client secret and the relay's PKCE verifier; the ID token is verified (RS256 over
   Google's JWKS, cached for its `Cache-Control`; `iss` Google; `aud` and `azp` the client id;
   `exp` in the future; `iat` at most 60 s ahead), then the nonce (constant time) and
   `email_verified is True`, and a `sub` (1..255 printable ASCII). Any failure closes the
   login. An email bound, on any of its teams, to another Google account: `403`, "This email
   now belongs to a different Google account" (M6-SPEC §7.2). Otherwise step `choose` (the
   email and the `sub` kept on the login) and the chooser, or, for an account on no team
   (M9-SPEC §3), `200` "You're not on a team yet. Ask a team owner to add <email>, or create
   one." with the create form (below).
3. The chooser: the account, the device, the warning, one radio per team (team id and
   member id; preselected only when there is exactly one team, M6-SPEC §7.5; with several
   the radios are required and nothing is chosen for the member), Continue / Cancel, and a
   closed "Create a new team" (`<details>`, no script) with the create form. A team's display
   name is shown beside its id when it has one. A fresh CSRF token (only its hash is stored),
   the same in both forms.
4. `POST /v1/login/choose` (`application/x-www-form-urlencoded`: `csrf`, `team`, `action`;
   nothing else, each once, at most 4 KiB): the cookie, step `choose`, the CSRF token, an
   `Origin` (when sent) equal to `RELAY_PUBLIC_URL`, a team from the chooser, and the account
   still on that team's roster with its email bound to this account's `sub` (bound now if
   this is the email's first sign-in; one roster transaction). Mints a one-time code (32
   bytes; `login_codes/{sha256}`, team, member, the email, the plugin's challenge,
   `expire_at` in 2 minutes), marks the login `done`, clears
   the cookie and redirects `303` to `http://127.0.0.1:<port>/callback?code=…&state=…`.
   **Cancel** closes the login and redirects to `http://127.0.0.1:<port>/callback?
   error=access_denied&state=…` so the plugin's listener can stop waiting. Nothing but
   `http://127.0.0.1:<port>/callback` is ever a redirect target.
   **Create a team** (M9-SPEC §3): `POST /v1/login/create` (form: `csrf`, `name`, `team`,
   `member`, `action` = `create` or `cancel`; nothing else, each once) with the same cookie,
   `Origin`, CSRF and step (`choose`, unexpired) checks. It creates the team (as `POST
   /v1/teams` below, with the signed-in account as owner, its email bound to the login's
   `sub`, the per-IP limit counted against the browser's address), adds it to the login's
   choices and answers the chooser with the new team preselected (even among several).
   `team` left empty is made from the name (lower case, `-` for anything else, `team-` in
   front when needed). A refused creation answers the page again with the refusal's status
   (`422`, `409`, `429`), its message and the member's own input (escaped; a left-empty id
   shows the one made from the name, to edit). `cancel` ends the login like the chooser's
   Cancel. The created team is kept even if the login then expires.
5. `POST /v1/login/token` `{"code", "code_verifier"}` (verifier 43..128 RFC 7636 characters):
   the code unused, unexpired and `BASE64URL(SHA256(verifier)) == challenge` → the code is
   marked used and a device credential minted (recording the SHA-256 of the email signed in
   with): `200 {"credential": "trc_…", "team", "member", "email", "relay_url",
   "expires_at"}` (`Cache-Control: no-store`); `email` is the Google account's email,
   lower-cased, so the plugin can say who the member became (M5-SPEC §9.3). Unknown, expired or wrong verifier
   (which burns the code): `400 {"error": "invalid_grant"}`. A code presented a second time
   also revokes the credential it minted. A malformed body: `400 invalid_request`. A code
   for a team deleted since the choice: `400 invalid_grant`, nothing minted (the
   redemption's transaction reads the team).

- **The pages** are server-rendered with every value escaped, one same-origin stylesheet
  (`/v1/login/style.css`), no scripts, no images, and `Content-Security-Policy: default-src
  'none'; style-src 'self'; img-src 'self'; form-action 'self' http://127.0.0.1:*;
  frame-ancestors 'none'; base-uri 'none'` (browsers apply `form-action` to the redirect after
  the chooser's POST, hence the loopback source), `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin` (no Referer leaves the relay; `no-referrer` would make
  browsers send `Origin: null` on the chooser's POST, whose `Origin` the relay checks),
  `Cache-Control: no-store`. The stylesheet is linked as `style.css?v=<content hash>`.
- **Rate limits** per client IP (`limits.login_*`, defaults: start 20, callback and choose
  together 30, token 20 a minute), counted in the store
  (`login_limits/{kind}.{sha256(ip)[:32]}.{minute}`; the address itself is never stored):
  `429`.
- **The client IP.** Off Cloud Run the socket peer. On Cloud Run (`K_SERVICE` set) the
  **right-most** `X-Forwarded-For` entry: Google's front end appends the address the
  connection came from, so that entry is the only one a client cannot write; anything left of
  it is client-supplied and would let anyone pick their own bucket. (If Google ever put its
  own address last, every client would share one bucket: logins would be limited globally,
  never bypassed.) IPv6 counts per /64. To check the derivation on the live service, every
  login start logs `x_forwarded_for_hops`, the number of `X-Forwarded-For` entries it saw
  over all such headers (never an address), once, on the event that ends it
  (`login_started`, `login_refused` `bad_start`, or `login_rate_limited`); compare it with
  the number of entries a test client sent.
- **Logs** never carry a code, a credential, a cookie, a state, an email or an IP: login
  events carry the first 12 hex of the login's key, team, member and the credential's public
  id.
- **Google endpoints** are fixed in `relay/oauth.py`. Tests pass a provider object to
  `create_app(..., oauth=...)`; nothing in the environment can point the relay at another
  identity provider.

## Device credentials (M5-SPEC §3)

- `Bearer trc_<43 base64url>`: 32 random bytes. Stored only as its SHA-256
  (`teams/{team}/credentials/{sha256}`: member, device, created_at, last_used_at,
  expire_at, revoked, revoked_at, `email_sha256` of the email it was minted through); its
  public id is the first 16 hex of that hash.
- Taking that email off the member revokes it in the same transaction (M6-SPEC §7.1), and a
  credential whose recorded email is no longer on its entry is refused (`401`) even on an
  instance whose credential cache has not seen the revocation yet: within that instance's
  30 s roster cache instead of its 60 s credential cache.
- It is its member on its team only: another team in the URL is `404` (audited on a
  mutation, like any member's). Since M9 every credential also writes a pointer
  (`credential_teams/{sha256}`: team, `expire_at` rolling with the credential's), so a
  credential of a team the API created is found whatever team the URL names; lookups read
  the URL's team, the file's teams and the pointer in one batch. A credential of a deleted
  team is `401` at once, on every instance (its team's record is read on each request). It stops working when the member leaves the roster (within
  30 s on other instances, at once here), and a member removed and added again does not
  revive credentials minted before the re-add (a credential is valid only if minted no
  earlier than the roster entry was added).
- Verified credentials are cached per process for at most 60 s: a revocation made on
  another instance lands within a minute, one made here at once. Use rolls `expire_at` to 90
  days after the last use, written at most every 10 minutes.
- At most 20 live credentials per member: minting another revokes the least recently used
  (audited `credential.revoke`, `device limit`).
- `GET /v1/teams/{team}/credentials` → `{"credentials": [{id, device, created_at,
  last_used_at, expires_at, current}]}`: the caller's own live devices, most recently used
  first (at most 100). `DELETE /v1/teams/{team}/credentials/self` revokes the credential the
  call came with (`400 not_a_credential` otherwise); `DELETE /v1/teams/{team}/credentials/{id}`
  one of the caller's own by public id (anyone else's, unknown or already revoked: `404`).
  Both return `{"revoked": id}` and are audited (`credential.revoke`). Delegates may not call
  them.
- Google ID tokens, static tokens and delegates keep working (ID tokens now also carry the
  `sub` check above).

## Teams anyone can create (M9-SPEC, 24 Sep 2026)

Anyone who signs in with Google can create a team and becomes its first owner; relay admins
list and delete teams. The team file's teams (**seed teams**) are seeded as before and are
ordinary teams otherwise, except that the API never deletes them.

### What is stored

- `teams/{team}`: `{id, name, status ("active" | "deleted"), seed, created_at,
  created_by_member, created_by_email_sha256, roster_version, members, owners, deleted_at,
  deleted_by_email_sha256, reserved_until, purge_complete}`. `members`/`owners` are the
  roster's counts, written by every roster change. A seed team's record is filled at startup
  (and before the admin listing); a document with only `roster_version` (before M9) reads as
  an active seed team. A seed record the file no longer lists is not a team, as before M9.
  Team documents never expire.
- `accounts/{sha256(email)}`: `{memberships: [{team, member}], created: [team ids]}`, for the
  teams the API created only (the file's teams are found from the file). Kept exact in the
  same transactions: every roster change that moves an email's membership rewrites its
  account document; creating and deleting keep `created`; the removal takes a deleted team's
  memberships off. "Which teams is this email on" is one read, then each named team's roster
  decides.
- `admin_audit/{auto}`: `{time, actor_email_sha256, action, team, outcome, detail,
  expire_at}` (kept 400 days): `team.create` (`created`, the creator's hash) and
  `team.delete` (`deleted`, or `resumed` for a follow-up call; the admin's hash). Never an
  email, never content. It outlives the team; the team's own audit (`team.create`, actor the
  owner, the email's hash) goes with the team.
- `credential_teams/{sha256}`: `{team, expire_at}`, every credential's pointer (below).

### Creating a team

`POST /v1/teams` `{"id"?, "name", "owner_member_id"}` → `201`:

```json
{"team": "platform", "name": "Platform", "status": "active",
 "created_at": "2026-09-24T12:00:00.000Z", "member": "alice", "role": "owner"}
```

- **Who:** a Google identity only: a Google ID token (the caller's email; their `sub` is bound
  on the owner entry at once), the any-team delegate with `manage-teams` on behalf of an email
  (`X-Relay-On-Behalf-Of`; bound at the owner's first own sign-in), or the login flow's form
  (above). A device credential (bound to its team) or a static token: `403
  google_identity_required`; a bad or missing bearer `401`; a delegate without
  `manage-teams` `403 forbidden`; the on-behalf header from a non-delegate `400`.
- **Validation (`422 invalid_body`):** `id` `^[a-z][a-z0-9-]{2,31}$` (made from the name when
  absent); `name` 1..60 characters after trimming, none of them a control, format (bidi
  overrides, zero-width), private-use, unassigned or line/paragraph separator character;
  `owner_member_id` `^[a-z][a-z0-9_]{1,31}$`; nothing else. The owner's email may not be a
  delegate's.
- **Refusals:** `409 team_id_reserved` for `admin api login v1 health static www team teams
  relay console demo test`, every id in the team file, and an id deleted less than 31 days
  ago; `409 team_exists` for a live team (a former file team still in the store included);
  `409 team_limit` at `teams_per_account` teams created and not deleted; `429 rate_limited`
  over `team_creations_per_account_per_day` or `team_creations_per_ip_per_hour`.
- **One transaction** reads the team and the creator's account, then writes the team, its
  owner entry, the account (`created` and the membership), the counters and both audits. Two
  creations of one id: one wins, the other is `409 team_exists`; concurrent creations by one
  account never pass its limit.

### `GET /v1/me/teams`

A Google ID token, or a delegate on behalf of an email (a per-team delegate sees its own team
only):

```json
{"teams": [{"team": "demo", "name": "Demo", "member": "alice", "role": "owner"}],
 "admin": false, "teams_created": 1, "max_teams_created": 3, "suggested_member": "alice"}
```

The file's teams first (file order), then the created ones by id, each roster validated
against its version. With an ID token, a team where that email is bound to another Google
account is left out. `GET /v1/teams/{team}/me` also returns the team's `name`.

### Admins (M9-SPEC §4)

`admins: ["google:<email>", ...]` in the team file (at most 20; never a delegate). Admin is
relay-wide and not a team role: it reads no team's data. By a Google ID token, or through the
any-team delegate with `manage-teams` on behalf of an admin's email; anyone else `403
forbidden`.

- `GET /v1/admin/teams?after=<team id>&limit=<1..1000, default 200>` → `{"teams": [row, ...],
  "next": <team id> | null}`. The file's teams first (on the first page only), then the
  created ones by id after `after`, `limit` of them; `next` is the `after` of the following
  page. A row: `{id, name, status, seed, created_at, created_by_member, members, owners,
  last_activity_at}` (`last_activity_at`: the latest change of any of the team's requests, or
  null), plus `removal` (`complete` | `pending`), `deleted_at` and `reserved_until` for a
  deleted team, listed while its id is reserved or its removal pending. No email, no content.
- `DELETE /v1/admin/teams/{team}` with the body `{"confirm": "<team id>"}` → `200 {"team",
  "status": "deleted", "removal": "complete" | "pending", "deleted_at", "reserved_until"}`.
  `422 confirm_mismatch` unless the body is exactly that; `409 seed_team` for a team of the
  file; `404` for no such team.
  1. One transaction marks the team deleted (`reserved_until` 31 days on), frees its creator's
     slot and writes the admin audit. From then on every request naming the team is refused,
     on every instance at once: a created team's record is read on each request that names it
     (a seed team needs no read). Its device credentials are `401`; a member's Google ID token
     `404` or `401` (by their other teams); the any-team delegate `404`. A roster change, a
     sign-in's binding or a credential mint for it fails inside its own transaction.
  2. The same request removes the team's documents in transactions of at most 400, each
     first checking the team is still deleted: the roster (its emails leave the account
     index), the credentials with their pointers, then everything else under `teams/{team}`
     (requests and progress, streams and messages, members, idempotency, audit, counters,
     retired ids), at most 2000 documents a call. `"removal": "pending"` means that budget ran
     out: the same `DELETE` again resumes (audited `resumed`). The record stays, marked
     `purge_complete` when nothing is left.
  3. Before a deleted id is created again (31 days on), a removal pass runs again (so anything
     a request racing the deletion wrote goes too), and the new team's `roster_version`
     continues the old one's, so no instance's cached roster of the old team can pass for the
     new one's.

### The any-team delegate (M9-SPEC §5)

```yaml
admins:
  - "google:admin@example.com"
delegates:
  - principal: "google:team-relay-console@<project>.iam.gserviceaccount.com"
    team: "*"
    scope: [read, manage-roster, manage-teams]
```

With `team: "*"` the delegate acts in the team the URL names, for the member of that team its
`X-Relay-On-Behalf-Of` email is: `403 not_a_member` when the email is not on that team, `404`
when the team is not a team (or not any more). Everything else is as for a per-team delegate:
only the delegate routes, and the roster mutations only with `manage-roster` and only when
that member is an owner of that team. `manage-teams` (only with `team: "*"`, a startup error
otherwise) adds `POST /v1/teams` and the admin routes (for an admin's email). A per-team
delegate keeps working as before. A team in the file may carry an optional `name` (1..60
characters, as above; its id otherwise).

## The fake OAuth relay for end-to-end tests

`tests/fake_oauth_app.py` serves the relay with a fake Google, so the plugin's e2e can run the
whole login headlessly. It lives under `tests/` and is not in the image.

```bash
cd relay
RELAY_TEAM_CONFIG=/path/to/team.yaml .venv/bin/python -m tests.fake_oauth_app --port 8090 --email alice@example.com
```

Google identities for the account, admin and delegate routes (M9): `GET
/__fake_google/id_token?email=<email>` answers `{"id_token": "…"}` signed by the fake's key
(verified email; the `sub` the login flow gives the same email). The launcher accepts such a
token as a Google ID token (the relay's own RS256 checks against the fake's JWKS); a
delegate's is one for its service account's email as the team file names it. Any other
bearer is a static token, as before.

| Setting | Default | Meaning |
|---|---|---|
| `RELAY_TEAM_CONFIG` | required | the team file; its `token:sha256:` principals work as in `RELAY_AUTH_MODE=static` (the only mode here) |
| `--port` / `PORT` | 8090 | listen port on 127.0.0.1 (the only address); `RELAY_PUBLIC_URL` is `http://127.0.0.1:<port>` |
| `--email` / `FAKE_OAUTH_EMAIL` | none | the Google account the fake approves when the authorize URL names none |
| `FIRESTORE_EMULATOR_HOST`, `GOOGLE_CLOUD_PROJECT` | unset, `demo-relay` | use the Firestore emulator; otherwise an in-process MemoryStore |
| `RELAY_LOG_LEVEL` | `warning` | uvicorn log level |

It refuses to start when `K_SERVICE` is set. The flow, with plain HTTP and no redirects
followed automatically:

1. `GET /v1/login/start?port=<listener>&state=<s>&code_challenge=<c>&code_challenge_method=S256&device=<label>`
   → `302`; keep `trl=<value>` from `Set-Cookie`.
2. `GET` the `Location` (`/__fake_google/authorize?…` on the same server); append
   `&email=<address>` to sign in as someone else, `&email_verified=false` for an unverified
   account → `302` to `/v1/login/callback?code=…&state=…`.
3. `GET` that `Location` with `Cookie: trl=<value>` → `200`, the chooser. Read the
   `<input type="hidden" name="csrf" value="…">` and the `<input type="radio" name="team"
   value="…">` values (HTML-escaped).
4. `POST /v1/login/choose` with `Cookie: trl=<value>`, `Content-Type:
   application/x-www-form-urlencoded`, body `csrf=…&team=…&action=continue` → `303` to
   `http://127.0.0.1:<listener>/callback?code=…&state=…` (the plugin's listener).
5. `POST /v1/login/token` `{"code", "code_verifier"}` → the credential.

The cookie is `Secure`; browsers accept it on `http://127.0.0.1`, headless clients must send
it themselves (as above).

## Manifest shares (M4-SPEC §3, 24 Sep 2026)

- A manifest may carry an optional top-level `shares`: at most 16 objects `{"name": ...}`,
  `name` matching `^[A-Za-z0-9._-]{1,64}$` (a folder's basename, never a path), no other key.
  The schema refuses equal entries (`uniqueItems`) and the relay's own check refuses a name
  used twice (compared exactly, so `Docs` and `docs` are two shares): `422 invalid_manifest`.
- The directory returns the manifest as published, `shares` included and in order; a
  manifest published without it comes back without it.
- The schema's own patterns (`shares`, identifiers, enum values) read a final `$` as the end
  of the string, as JSON Schema and the plugin do; Python's `re` alone would also accept a
  trailing newline.

## Read-only delegates (M3-SPEC §2, 24 Sep 2026)

The hosted console reads the relay as a delegate: a service principal that reads a team's
views on behalf of one member at a time. The team file gains an optional top-level list:

```yaml
delegates:
  - principal: "google:team-relay-console@<project>.iam.gserviceaccount.com"
    team: <team id>
    scope: read
```

- **Startup errors:** a principal that is not `google:<email>` (lower-cased like members'),
  a team that is not in the file (or `"*"`, M9), a `scope` other than `read` (M6, M9: or a
  list with `read` and `manage-roster` and, only for `"*"`, `manage-teams`), a principal that is also a
  member's, the same principal twice (for one team or two), any other key, more than 10.
- **Authentication:** a delegate must send exactly one `X-Relay-On-Behalf-Of: <email>`; the
  relay resolves `google:<email lowercased>` to a member of the delegate's own team. Missing,
  repeated, malformed, unknown or another team's member: `401 unauthenticated`, logged as
  `auth_rejected` with `delegate` and a reason (`missing_on_behalf`, `repeated_on_behalf`,
  `unknown_on_behalf`), never the email or the token. From then on that member is the caller
  for every rule: masking and visibility, the read budget (`reads_per_minute` is the
  member's, shared with their own reads), the other-team `404`.
- **Authorisation:** a delegate may call only `GET` `/v1/teams/{team}/me`, `/directory`,
  `/activity`, `/requests/{id}`, `/roster` (M6) and `/inbox/summary` (M7)
  (`DELEGATE_ROUTES` in `relay/app.py`, matched on the route template). Every other route, including stream reads (which would move presence and
  cursors), cursor moves, manifests and every request mutation: `403 forbidden`, before the
  body is read. Order of refusals: `401` → `404` (another team's URL) → `403`.
- **Logs, not audit:** each delegated read logs `delegated_read` with `delegate`, `team`,
  `member` and `path`; a refused one `delegate_refused` with `status`. Neither is audited: reads
  are never audited, and the member named did not attempt a refused mutation. A delegated
  `GET /requests/{id}` may still fire a due deadline, as any read of a request does; that
  notice is audited as the relay's own.
- **A member that sends `X-Relay-On-Behalf-Of`** (any value, even empty or their own email)
  gets `400 bad_request`, logged as `on_behalf_refused`, not audited; the header means
  something only from a delegate.
- A delegate's principal is a Google identity, so delegates work only in `google` mode; the
  tests stand one in with a verifier that maps a test token to a service-account principal.

## The inbox summary (M7-SPEC §1, 24 Sep 2026)

A question sent while its recipient's answering session is not running waits in their inbox
(delivery is durable); this says so.

- `GET /v1/teams/{team}/inbox/summary`, the caller's own inbox (a delegate: the member it
  names): `{"pending": n, "more": bool, "oldest_at": "…"|null, "from": ["alice", …],
  "answering": {"last_seen": "…"|null}}`. `pending` counts unexpired messages after the
  member's `inbox` cursor, reading at most 50 (so at most 50); `more` is true when that read
  was full and the stream holds later messages (they may have expired since). `oldest_at` is
  the oldest counted message's time; `from` its distinct senders in order, at most 5;
  `answering.last_seen` the answering session's presence.
- A peek: it never moves a cursor (not even past expired messages), stamps no delivery and
  writes no presence, so any session may call it. It is not a stream read (no long-poll, no
  poll cap). It counts against `reads_per_minute`; over it, `429 rate_limited` (stdout only).
  The store's `read_stream(..., advance=False)` is the primitive (both stores, in the
  contract tests).
- The directory's entries gain `inbox_waiting` (the same count, at most 50), computed with
  the team's stats and cached with them for 10 s: team-wide metadata, like presence. A member
  added since the cached entry was computed shows `0` until it is recomputed.

## Endpoints added in M2 (23 Sep 2026)

- `GET /v1/health`: `{"ok": true}`, no credentials (Cloud Run's front end reserves some paths
  ending in `z`, so `/healthz` may never reach the app there).
- `POST /v1/teams/{team}/requests/{id}/events`, recipient only (anyone else `404`): body
  `{"tool": "^[A-Za-z0-9_.:-]{1,64}$", "status": "ok"|"error"|"waiting", "duration_ms": 0..3600000|null}`,
  nothing else (`extra="forbid"`, so no input, output or path can be sent). `201 {"seq": n}`.
  `waiting` (M4-SPEC §2): the answering session is waiting for its member to allow a tool;
  it is stored, capped, audited and kept out of the streams exactly like `ok` and `error`.
  Appended to the recipient's `tools` and to the progress list as `kind: "tool"` (one `seq`
  for both kinds); never an envelope. At most 50 per recipient (`429 too_many_tool_events`),
  a budget separate from progress's 200. Past `expire_at`: `410`. Audited as `request.event`
  (hash and length only); refusals are audited like any other mutation's.
- `GET /v1/teams/{team}/requests/{id}`: each progress entry now has one shape,
  `{seq, member, kind, text, pct, tool, status, duration_ms, time}` (nulls where a kind has
  none).
- `GET /v1/teams/{team}/activity?since=&limit=`, any member of the team. `since` is RFC 3339
  with a zone (`Z` or an offset; omitted: the last 24 hours), `limit` 1..200 (default 100).
  Returns `{"requests": [...], "next_since", "server_time"}`, ascending by `updated_at`. See
  the M2 spec §3.5 for an entry's shape; this relay also returns `participant`.
- `GET /v1/teams/{team}/directory`: each entry gains `sessions` and `stats`, and the body
  gains `stats_complete`.

## Behaviour worth knowing (M2-SPEC, 23 Sep 2026)

- **Presence:** a stream read records `presence.<stream>.last_seen` (`inbox` is the answering
  session, `replies` the working session) at most once per 15 s per member and stream, before
  it waits. The directory shows them as `sessions.answering` and `sessions.working`; the old
  `last_seen` is the later of the two. (This replaces M1's once-a-minute `last_seen`.)
- **Delivery times:** when a cursor moves (`POST .../cursor`, and the automatic advance past
  expired messages), the same transaction reads the first 100 messages it passed and stamps,
  on each live request, the recipient's `delivered_at` (a question or capability call in
  `inbox`) or the answering recipient's `answer_delivered_at` (an answer in `replies`).
  Notices stamp nothing. First write wins. A cursor jump past more than 100 messages leaves
  the rest unstamped. An envelope expires with its request, so the automatic advance (which
  only passes expired messages) finds nothing live to stamp in practice; the rule is the same.
- **`updated_at`** is set on every write to a request: create, an ack that changes the
  status, reply, progress, tool event, a deadline notice, a delivery stamp. Reads and refusals
  leave it alone. Requests written before M2 have none and never appear in the feed.
- **`updated_at` is monotonic** (M2-SPEC §7.1): every rewrite of a request, in both stores,
  stamps it inside the writing transaction as `max(now, previous + 1 ms)`, the previous value
  being the one that transaction read (`monotonic_updated_at` in `store.py`, applied by
  `mutate_request` and by the delivery stamps of a cursor advance). A retried transaction, or
  an instance whose clock is behind another's, therefore never writes a value older than a
  change that committed first. Only `updated_at` is floored: `acked_at`, `answered_at`,
  `delivered_at` and the rest keep the writer's own clock. Across documents commits can
  still land out of timestamp order; the console re-polls from `next_since` minus 30 s.
- **Answer preview:** a reply stores its first 2000 code points on the recipient's entry.
- **Feed masking:** metadata is team-wide. The question, the capability params and answer
  previews go to participants only; within a request a recipient sees only their own answer
  preview (as in §3.11, where a recipient sees only their own entry), the asker sees all.
- **Feed paging:** `next_since` is the `updated_at` of the last request read, expired ones
  included (they are passed, not returned, so a page of expired requests cannot stall the
  feed), or `since` when nothing was read. A page never splits requests that share one
  `updated_at` (millisecond precision): it stops before such a group, and a page that is one
  whole group returns all of it (up to 500), which can exceed `limit`. Deadlines are not swept
  by the feed: a `pending` past its ack deadline shows as `pending` until the asker polls or
  someone reads the request.
- **Feed cost:** one query per poll, `updated_at > since` ordered by `updated_at` (limit + 1
  documents), and a second equality query on `updated_at` only when a page is one group. Both
  are served by Firestore's automatic single-field index; no composite index is needed.
- **Directory stats** (`asked`, `answered`, `open`, `median_answer_seconds`) come from one
  read of the team's requests updated in the last 24 hours, newest first, at most 500
  documents, expired ones left out. `asked` counts requests created in the window, `answered`
  replies given in it (with the median from a request's creation to the reply), `open`
  requests where the member is a recipient still `pending` before the ack deadline or `acked`
  before the answer deadline (M2-SPEC §7.2: the directory does not run the sweep, so a
  `pending` past its ack deadline, which the sweep will turn into `no_response`, is not open;
  the feed still reports the stored status). Beyond 500 requests in a day the counts cover
  the 500 most recently updated only, and `stats_complete` is `false`; every directory
  response carries `stats_complete`.
- **Stats cache** (M2-SPEC §7.3): each process keeps a team's stats for 10 s by its clock
  and serves every member's directory from them (a clock that went back makes the entry
  stale). Presence, manifests and the feed are never cached. The cache is derived data, not
  delivery state: with several instances each has its own, and a change can take up to 10 s
  to show in `stats`.
- **Read budget** (M2-SPEC §7.3): `/activity` and `/directory` share one budget per member,
  `limits.reads_per_minute` (default 120) per calendar minute, counted in the store (counter
  documents like the other limits, so it holds across instances) before the query is parsed.
  Over it: `429 rate_limited`. A refused read is logged to stdout (`read_refused`), never
  audited (reads are not mutations). Other reads (`/me`, streams, a request) are not counted.
  The console's polling (the feed every 3 s, the directory every 10 s) uses 26 a minute.
- **Feed pages** (M2-SPEC §7.10): a page may exceed `limit` to keep an equal-`updated_at`
  group whole, up to 500 requests; more than 500 requests with one `updated_at` (one
  millisecond) would leave the rest unread; at a team's request rates that does not happen in
  practice.
- **Audiences:** a Google ID token must carry one of the `RELAY_AUDIENCE` entries (exact
  match; an array-valued `aud` is refused). The verified-token cache is keyed on the SHA-256 of
  the accepted audience set and the token. Known limit: a member's gcloud ID token carries
  gcloud's own client id as its audience, so a token that member sends to some other service
  could be replayed here until it expires (within the hour). A dedicated OAuth client for the
  relay would close that; it needs a console step, so it is a later hardening.

## Behaviour worth knowing (M1-SPEC §11, 23 Sep 2026)

- **Manifest patterns are RE2** (`google-re2`, imported as `re2`): they must compile in RE2,
  be anchored `^...$`, be at most 300 characters and not use `\C`; a value must match the
  whole pattern. RE2 runs in linear time, so no teammate's pattern can stall the event loop.
- **Params:** a `required` param may not declare a `default`; `request_id` is reserved;
  `integer` accepts any integral JSON number (`5.0` is stored as `5`); integers and numbers
  beyond ±2^53 are refused; `max_length` counts code points.
- **Bodies:** every body goes through one strict parser. Lone surrogates (escaped or raw),
  numbers that overflow to infinity, integers beyond Python's digit limit and nesting deeper
  than 64 levels are `400 invalid_json`, audited like any refused mutation. A question must
  hold a non-whitespace character (JavaScript's `trim()` set); `ack_timeout_seconds` above
  `answer_timeout_seconds` is `422 invalid_timeouts`.
- **Rate limits** are counted in the store (Firestore counter documents under
  `teams/{team}/counters/`, one per member, kind and minute), in the same transaction that
  creates the request, so they hold across instances and a refused request writes nothing.
  Over a limit: `429 rate_limited`. Idempotent replays do not count. A third concurrent
  long-poll on one stream is `429 too_many_polls` (in-process, per instance; reads with
  `wait=0` are not counted).
- **Expired backlog:** a stream read that starts at the stored cursor (no `after`, or `after`
  equal to it) moves the cursor past the run of expired messages right after it, never past
  an unexpired one, so a stream cannot stall behind more than 1000 expired messages (one read
  scans at most 1000). The response's `cursor` is the stored cursor after that move.
- **Google verification:** a bearer token that is not three base64url segments of at most
  4096 characters is refused before any network call. Google's certificates are fetched off
  the event loop and cached for their `Cache-Control` `max-age` (1 hour if absent, bounded to
  1 minute .. 1 day); a token naming an unknown key refetches at most every 5 minutes. A
  verified token's principal is cached under the SHA-256 of the audience set and the token
  until its `exp` (LRU of 1024). Issuer, audience, signature, expiry and `email_verified is True` are checked before
  anything is cached; the team file is consulted on every request.

## Deploy notes

- Build from `multiagent/`: `docker build -f relay/Dockerfile .`. The image holds no team
  config; mount it (Secret Manager volume) and point `RELAY_TEAM_CONFIG` at it. The M2 shape
  (service, database, env) is in `docs/M2-SPEC.md` §1.
- Create the composite index from `firestore.indexes.json` before the first sweep runs. The
  activity feed and the stats use only single-field indexes on `updated_at`, which Firestore
  creates automatically (do not add a single-field exemption for `updated_at`).
- Switch on TTL for the `expire_at` field on every collection group that carries it:
  `messages`, `requests`, `progress`, `idempotency`, `audit`, `counters`, (M5, M6)
  `credentials`, `logins`, `login_codes`, `login_limits`, `retired`, and (M9)
  `credential_teams`, `admin_audit`, for example
  `gcloud firestore fields ttls update expire_at --collection-group=messages --enable-ttl`.
  Reads already ignore expired documents, because TTL deletion lags (a day or more).
- `max-instances` is not a correctness requirement: every invariant is a Firestore
  transaction, and no state lives in the process (the roster and credential caches are
  bounded in time: 30 s and 60 s).
- M5/M6: the service runs `--allow-unauthenticated` (the login pages must be reachable
  before sign-in); every other route authenticates in the app. It needs `RELAY_PUBLIC_URL`
  (the service URL) and `RELAY_OAUTH_CLIENT_FILE` pointing at the mounted secret
  `team-relay-oauth-client` (JSON `client_id`, `client_secret`); the OAuth client's
  authorised redirect URI is `{RELAY_PUBLIC_URL}/v1/login/callback`. Smoke:
  `GET /v1/login/start` without parameters is `400`; an unauthenticated API call is `401`.
- M9: no new index (the team listing orders by document id; the removal's queries have no
  filter). `teams`, `accounts` and roster documents never expire (a deleted team's record is
  kept, the id reserved 31 days, then given again only after a fresh removal pass; an
  account document is deleted when it holds nothing). Team creations count in `login_limits`.

## Deliberately not done

- No background sweeper, by design (§4): an asker who never polls `replies` gets no notices
  until they do, or until someone reads the request.
- The read budget costs one small transaction per `/activity`, `/directory` or
  `/inbox/summary` read (the counter document), like the request limits; it is the price of a limit that holds across
  instances.
- Only the per-minute counts above are limited. Idempotent replays, acks that change
  nothing and reply replays are audited without a cap (each needs a request the caller
  created or was sent).
- The long-poll cap is per instance by design (it protects the process, it is not delivery
  state); across N instances a member can hold up to N x `concurrent_polls` polls.
- No `RELAY_STORE=memory` switch: the process built from env always uses Firestore; the
  memory store exists for tests through `create_app(settings, store)`.
- Unauthenticated attempts go to the stdout log only (no team to file them under), as §7 says.
- An unknown `trc_` credential costs one batched Firestore read (the URL's team, one document
  per configured team and the pointer) before its `401`; unknown credentials are not cached (random ones would miss a cache
  anyway). With the relay open to the internet (M5-SPEC §5) this is a cost, not an access,
  exposure; Cloud Armor or a per-IP limit on `401`s would be the next step if it ever
  matters.
- A directory recomputation (at most every 10 s per team and instance) reads each member's
  inbox (at most 50 messages each) besides the stats query: a cost that grows with the team,
  bounded by the roster cap.
- The console's "not on this team" page (M6-SPEC §4) sees the M3 contract: a delegated call
  for an email on no roster is `401 unauthenticated`, as before.
- A request that authenticated just before its team was deleted may still write (a
  message, presence) after the batched removal has passed; nobody can read it (the team is
  refused), and it is removed by the removal pass that runs before the id is given again.
  Roster changes and credential mints check the team inside their own transaction, so none
  of them lands after the deletion.
- The admin listing reads one small query per team for `last_activity_at` (16 at a time);
  a page is at most 1000 teams.
