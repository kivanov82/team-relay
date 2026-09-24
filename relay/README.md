# relay

The team relay of `docs/M1-SPEC.md` (sections 1 to 7, with its §11 corrections) and
`docs/M2-SPEC.md` §1 to §3 (with the relay's part of its §7 corrections) and the read-only
delegates of `docs/M3-SPEC.md` §2: FastAPI, stateless, with Firestore as the per-member mailbox. No
background workers: deadlines fire lazily when the asker polls `replies` or anyone reads a
request.

## Layout

| Path | What |
|---|---|
| `relay/config.py` | team config (`RELAY_TEAM_CONFIG`), limits, `audit_retention_days`, read-only `delegates` (M3 §2), settings from env |
| `relay/auth.py` | the `google` verifier (§2, §11.8, M2 §2: a list of audiences) and the `static` one, which refuses to start under `K_SERVICE` |
| `relay/jsonutil.py` | the strict body parser (§11.9), canonical JSON and hashing |
| `relay/models.py` | request bodies, strict, `extra="forbid"` |
| `relay/manifest.py` | schema validation, the §3.3 checks, RE2 patterns (§11.1), param validation with defaults (§3.5, §11.2) |
| `relay/store.py` | the store protocol: `create_request`, `mutate_request`, `set_cursor`, `count_quota` and reads; `stamp_deliveries`, the one delivery-time rule both stores run (M2 §3.2); `monotonic_updated_at` (M2 §7.1) |
| `relay/store_memory.py`, `relay/store_firestore.py` | the two stores; one contract suite covers both |
| `relay/service.py` | the state machine, the sweep (§4), audit (§7), tool events, the activity feed and the directory's stats (M2 §3); store-agnostic |
| `relay/app.py` | `create_app(settings, store)`; `relay.app:app` builds one from env; authentication, including a delegate's `X-Relay-On-Behalf-Of` and its four routes (M3 §2) |
| `firestore.indexes.json` | the one composite index, for the sweep (`asker ASC, next_deadline ASC`); the feed and the stats need none |
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

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_TEAM_CONFIG` | required | path to the team YAML (`../config/team.example.yaml` shape); on Cloud Run the mounted secret `/secrets/team/team.yaml` |
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
| `reads_per_minute` | 120 | reads of `/activity` and `/directory` together, per member and calendar minute (M2-SPEC §7.3) |

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
  a team that is not in the file, a `scope` other than `read`, a principal that is also a
  member's, the same principal twice (for one team or two), any other key, more than 10.
- **Authentication:** a delegate must send exactly one `X-Relay-On-Behalf-Of: <email>`; the
  relay resolves `google:<email lowercased>` to a member of the delegate's own team. Missing,
  repeated, malformed, unknown or another team's member: `401 unauthenticated`, logged as
  `auth_rejected` with `delegate` and a reason (`missing_on_behalf`, `repeated_on_behalf`,
  `unknown_on_behalf`), never the email or the token. From then on that member is the caller
  for every rule: masking and visibility, the read budget (`reads_per_minute` is the
  member's, shared with their own reads), the other-team `404`.
- **Authorisation:** a delegate may call only `GET` `/v1/teams/{team}/me`, `/directory`,
  `/activity` and `/requests/{id}` (`DELEGATE_ROUTES` in `relay/app.py`, matched on the route
  template). Every other route, including stream reads (which would move presence and
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
  `messages`, `requests`, `progress`, `idempotency`, `audit`, `counters`, for example
  `gcloud firestore fields ttls update expire_at --collection-group=messages --enable-ttl`.
  Reads already ignore expired documents, because TTL deletion lags (a day or more).
- `max-instances` is not a correctness requirement: every invariant is a Firestore
  transaction, and no state lives in the process.

## Deliberately not done

- No background sweeper, by design (§4): an asker who never polls `replies` gets no notices
  until they do, or until someone reads the request.
- The read budget costs one small transaction per `/activity` or `/directory` read (the
  counter document), like the request limits; it is the price of a limit that holds across
  instances.
- Only the per-minute counts above are limited. Idempotent replays, acks that change
  nothing and reply replays are audited without a cap (each needs a request the caller
  created or was sent).
- The long-poll cap is per instance by design (it protects the process, it is not delivery
  state); across N instances a member can hold up to N x `concurrent_polls` polls.
- No `RELAY_STORE=memory` switch: the process built from env always uses Firestore; the
  memory store exists for tests through `create_app(settings, store)`.
- Unauthenticated attempts go to the stdout log only (no team to file them under), as §7 says.
