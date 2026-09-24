# Milestone 2: deploy, Google identity, the answering session reads, the console

Status: spec, 23 Sep 2026. Extends `M1-SPEC.md` (which, with its §11 corrections, still
binds everything not changed here). Contract between the relay, the plugin and the console.

Kiril's decisions (23 Sep 2026, in the thread):
1. Deploy the relay to Cloud Run in the owner's Google Cloud project.
2. A team of three members, identified by their Google accounts. Real identities live only in
   `config/team.local.yaml` (git-ignored) and in Secret Manager, never in git.
3. The answering session may read local files (`Read`, `Glob`, `Grep`).
4. The audit log keeps sha256 and length only, 90 days (unchanged).
5. A console: connected agents and their details, a live view of communication both ways,
   which tools were used. Clean, compact, professional.

## 1. Deployment shape

| Thing | Name |
|---|---|
| Project, region | the owner's project, `europe-west3` |
| Cloud Run service | `team-relay`, `--no-allow-unauthenticated` (Cloud Run IAM invoker in front, granted to the three members only), `--min-instances=0 --max-instances=3`, `--timeout=60`, 1 CPU, 512 Mi |
| Firestore | named database `team-relay`, native mode, `europe-west3`, delete protection on; TTL on `expire_at` for every collection group that carries it; composite index `requests (asker ASC, next_deadline ASC)` |
| Runtime SA | `team-relay-runtime`: `roles/datastore.user` conditioned on the `team-relay` database; accessor on its own secret; log writer |
| Build SA | `team-relay-builder`: writer on `team-relay-images` only; its own EU build bucket `<project>-team-relay-build` (7-day lifecycle, public access prevention) |
| Images | Artifact Registry `team-relay-images` (keep last 10), tagged by git sha |
| Team config | secret `team-relay-team-config` (the YAML), mounted as a file at `/secrets/team/team.yaml` |

Relay env on Cloud Run: `RELAY_AUTH_MODE=google`, `RELAY_AUDIENCE` (see §2),
`RELAY_FIRESTORE_DATABASE=team-relay`, `GOOGLE_CLOUD_PROJECT=<project>`,
`RELAY_TEAM_CONFIG=/secrets/team/team.yaml`, `RELAY_HOST=0.0.0.0`.

Health: Cloud Run reserves some `*z` paths at its front end, so the relay also serves
`GET /v1/health` (same body as `/healthz`, no auth at the app; Cloud Run IAM still applies).

## 2. Google identity end to end

- Client: a member's own gcloud user identity. The client obtains an ID token by running
  `gcloud auth print-identity-token` (argv array, never a shell; `--account=<RELAY_GCLOUD_ACCOUNT>`
  when set), caches it until 5 minutes before its `exp` (read from the JWT payload, not
  verified client-side), and refreshes on a 401 once before backing off. The token never
  appears in logs, errors or files.
- Such a token's audience is gcloud's OAuth client id `32555940559.apps.googleusercontent.com`.
  Cloud Run IAM accepts it for user accounts. The relay's `RELAY_AUDIENCE` becomes a
  comma-separated list; the deploy sets it to that client id plus the service URL. Issuer,
  signature, expiry, `email_verified is True` and the allowlist still decide who you are.
  (Known limit, stated in the README: a gcloud ID token a member sends to some other service
  could be replayed here until it expires, within the hour. A dedicated OAuth client for the
  relay would close that; it needs a console step from Kiril, so it is a later hardening.)
- `RELAY_AUTH` on the client: `google` (default) or `token` (static dev token, for the
  emulator and tests only; the relay refuses static mode on Cloud Run already).

## 3. Relay additions

### 3.1 Presence per session
The stream poll records presence per stream: `presence.inbox` (the answering session) and
`presence.replies` (the working session), each `{last_seen}`; written at most once per 15 s
per member and stream. The directory (§3.4 of M1) gains, per member:
```json
"sessions": {"working": {"last_seen": "…"|null}, "answering": {"last_seen": "…"|null}}
```
`last_seen` on the member stays (the max of the two) for compatibility.

### 3.2 Delivery times
When a cursor advances (M1 §3.7, and the automatic advance of §11.5), the relay reads the
messages in `(old, new]` (bounded to 100) and, per request, records in the same transaction
the recipient's `delivered_at` (an `inbox` question or capability call reached the answering
session) or `answer_delivered_at` (a `replies` answer reached the asker's working session).
First write wins; never overwritten.

### 3.3 Tool events
`POST /v1/teams/{team}/requests/{request_id}/events`, recipient only (else `404`), body
`{"tool": "^[A-Za-z0-9_.:-]{1,64}$", "status": "ok"|"error", "duration_ms": 0..3600000|null}`.
Appended to the recipient's entry on the request document as
`tools: [{tool, status, at, duration_ms}]` (at most 50 per recipient; beyond that `429`),
and to the request's progress subcollection with `kind: "tool"`. Never a stream, never
pushed. Existing progress entries get `kind: "progress"`. Audited like progress.
No tool input, output or path is ever sent: the name, the outcome and the duration only.

### 3.4 Answer preview
A reply stores `answer_preview` (the first 2000 characters of the text) on the recipient's
entry, so the request document carries the whole exchange for the console without reading
anyone's stream.

### 3.5 The activity feed
`GET /v1/teams/{team}/activity?since=&limit=`, any member of the team. Every request
document carries `updated_at` (set on every change). Returns requests with
`updated_at > since` (RFC 3339; omitted = the last 24 h), ascending by `updated_at`, at most
`limit` (1..200, default 100), unexpired only, and `next_since` = the last `updated_at`
returned (or `since` when none). Team-wide **metadata** is visible to every member; **text
and params** only to the request's participants (asker and recipients):

```json
{"requests": [{
   "request_id": "rq_…", "kind": "question"|"capability", "asker": "kiril",
   "broadcast": false, "created_at": "…", "updated_at": "…",
   "ack_deadline": "…", "answer_deadline": "…", "expire_at": "…",
   "capability": {"name": "staging_db_query", "environment": "staging", "params": {…}|null},
   "question": "…"|null,
   "recipients": {"luke": {
       "status": "pending"|"acked"|"answered"|"no_response"|"timed_out",
       "delivered_at": …|null, "acked_at": …|null, "answered_at": …|null,
       "answer_delivered_at": …|null,
       "tools": [{"tool": "Read", "status": "ok", "at": "…", "duration_ms": 12}],
       "progress_count": 2, "last_progress_pct": 40|null,
       "answer_preview": "…"|null }},
   "participant": true
 }],
 "next_since": "…", "server_time": "…"}
```
For a non-participant `question`, `capability.params` and every `answer_preview` are `null`
(the capability name and environment stay visible). Costs: one indexed query on
`updated_at` per poll (single-field index, automatic); the console polls every 3 s.

### 3.6 Directory stats
Each directory entry gains `stats` over the last 24 h, computed from the same feed data the
relay already reads: `{"asked": n, "answered": n, "open": n, "median_answer_seconds": x|null}`
(`open` = requests where this member is a recipient with status `pending` or `acked`). The
directory is team-wide metadata like the feed.

## 4. Plugin additions

### 4.1 Google identity (§2) in `relay-client.ts`
`RELAY_AUTH=google|token`, `RELAY_GCLOUD_ACCOUNT` optional. `userConfig` gains `relay_auth`
(string, options `google`, `token`, default `google`) and `gcloud_account` (string, optional);
`relay_token` becomes optional (required only when `relay_auth` is `token`, checked at start).
`bin/answerer` and `bin/console` pass these through. The capability server uses the same
client.

### 4.2 The answering session reads (Kiril's decision 3)
`Read`, `Glob`, `Grep` leave the deny list and join the allow list. Still denied: `Bash`,
`Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent`, `Task`. Because a
teammate's question can ask for any file, reads of credential stores stay denied in
`settings.json` (`permissions.deny` with path rules): `~/.ssh/**`, `~/.gnupg/**`,
`~/.aws/**`, `~/.config/gcloud/**`, `~/.azure/**`, `~/.kube/**`, `~/.docker/**`,
`~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.claude/**`,
`~/.claude-team-relay/**`, `~/Library/Keychains/**`, `**/.env`, `**/.env.*`, `**/*.pem`,
`**/*.key`, `**/id_rsa*`, `**/id_ed25519*`, for each of `Read`, `Glob` and `Grep`. The
instructions string says secrets are never to be sent to teammates. The README states plainly
that this is a guard rail, not a sandbox.

### 4.3 Tool events from the answering session
- The answerer channel records its open requests in `$ANSWERER_STATE_DIR/active.json`
  (`bin/answerer` sets `ANSWERER_STATE_DIR=$ANSWERER_HOME/state`, mode 700): a request id is
  added on `ack_question`, removed on `reply`; written atomically (temp file + rename).
- `bin/answerer`'s `settings.json` gains `PostToolUse` and `PostToolUseFailure` hooks
  running `node <plugin>/dist/tool-event.js` (exec form). It reads the hook JSON from stdin,
  takes `tool_name`, strips an `mcp__<server>__` prefix, ignores the relay's own tools
  (`ack_question`, `reply`), attributes the event to the most recently acked open request
  (none open: nothing is sent), and posts §3.3 with `status` and, when the hook payload
  carries timing, `duration_ms`. It never sends tool input or output, exits 0 always, and
  gives up after 3 s.
- Capability tools report too (their name is the capability's).

### 4.4 The console server
`plugin/bin/console` runs `node dist/console-server.js`:
- Binds `127.0.0.1` only (port `CONSOLE_PORT`, default 4317; `0` picks a free one) and
  prints the URL `http://127.0.0.1:<port>/#k=<key>`, where `key` is 32 random bytes per launch.
  `--open` opens it in the default browser.
- Rejects any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS
  rebinding) and any `/api/*` request without `X-Console-Key: <key>` (compared in constant
  time). No CORS headers. Static files get a strict CSP (`default-src 'self'`), no external
  requests at all.
- Read-only proxy: `GET /api/me`, `/api/directory`, `/api/activity`, `/api/requests/{id}`
  map to the relay's `/v1/teams/{team}/…` with the member's credentials (§4.1). Nothing else is
  proxied; there is no way to send, ack or reply from the console.
- `--demo` serves a synthetic team (`demo`: alice, bob, carol) with a scripted, looping stream
  of activity instead of calling a relay, for development and screenshots.
- Serves the built console from `dist/console/`.

## 5. The console (UI)

`console/`: React 19 + Vite + TypeScript strict + Tailwind v4 + shadcn/ui + TanStack Query
(the platform's stack), fonts self-hosted, zero external requests; builds into
`plugin/dist/console/` (committed with the rest of `dist/`). Reads the key from the URL
fragment once, keeps it in memory, and removes it from the address bar.

What it shows (clean, compact, professional; light and dark):
- **Header:** team, you, relay connection state and round-trip time, last update.
- **Team map (the hero):** the members as nodes; an edge animates while a request is in
  flight between two members, in the direction it is travelling (question out, answer back);
  broadcast fans out. Node rings show session presence.
- **Agents:** one compact card per member: working and answering session presence
  (online < 45 s, idle < 5 min, offline), capabilities with a staging/production badge, and
  the 24 h stats.
- **Live activity:** newest first, one row per request: kind, asker → recipients, a
  per-recipient step track (sent, delivered, acked, tools, answered, returned) with the
  current step highlighted, elapsed time, and status. Filters: all / mine / open.
- **Request detail (sheet):** the timeline with timestamps and the latency of each hop, the
  tools used with outcomes and durations, progress, and (participants only) the question,
  params and answer previews.
- Polls `/api/activity` every 3 s (incremental via `since`) and `/api/directory` every 10 s;
  pauses when the tab is hidden; shows a clear state when the relay is unreachable.

## 6. Gates

- Relay: `scripts/test-relay.sh` green, nothing skipped; ruff clean.
- Plugin: typecheck, unit tests, `generate --check`, build; `scripts/e2e.sh` extended with:
  presence per session, `delivered_at`/`answer_delivered_at`, tool events from the hook
  script (driven with a synthetic hook payload), the activity feed's participant masking
  (carol, a non-participant, sees metadata but no text or params).
- Console: typecheck, Vitest component tests on fixtures, build; screenshots of the demo
  mode at desktop and narrow widths, light and dark, checked by eye.
- Deploy: `/v1/health` through Cloud Run IAM with an operator-minted ID token; an allowlist
  miss gets the app's `401`; an unauthenticated call gets Cloud Run's `403`.

## 7. Corrections

### 23 Sep 2026: after the M2 review

1. **`updated_at` is monotonic.** It is stamped inside the store transaction as
   `max(now, previous updated_at + 1 ms)`, so a retried transaction cannot write an older
   value than a change that committed first. The console re-polls from `next_since` minus 30 s
   of overlap (the merge is idempotent), which covers commits that land out of timestamp
   order across documents.
2. **Effective status.** The feed and the directory do not run the sweep, so they report the
   stored status. The directory's `stats.open` counts a recipient as open only while its
   relevant deadline (`ack_deadline` for `pending`, `answer_deadline` for `acked`) is in the
   future. The console derives the same thing from `server_time`: a `pending` past its ack
   deadline shows as no response, an `acked` past its answer deadline as timed out, and neither
   animates on the map.
3. **Read cost.** The directory's 24 h stats are cached per team for 10 s in the process
   (derived data, not delivery state). `/activity` and `/directory` count against a per-member
   read budget of 120 per minute (`limits.reads_per_minute`), over which `429 rate_limited`.
4. **The tool-event hook is async** (`"async": true`), so it never delays a tool call.
5. **Read deny list (§4.2).** `Glob(...)` and `Grep(...)` path rules are dropped: Claude Code
   does not evaluate them (it applies `Read` rules to Glob and Grep). The `Read` list adds:
   `~/.config/gh/**`, `~/.zsh_history`, `~/.bash_history`, `~/.*_history`, `**/.envrc`,
   `~/Library/Application Support/**/Cookies*`, `~/Library/Application Support/Firefox/**`,
   `~/Library/Application Support/Google/Chrome/**`, `~/.terraform.d/**`,
   `~/.cargo/credentials*`, `~/.vault-token`, `~/.pgpass`, `**/*.p12`, `**/*.pfx`,
   `**/*.keystore`, `**/*.jks`, `**/credentials.json`, `**/*.tfvars`, `~/.config/solana/**`,
   `~/.foundry/**`, `~/.ethereum/**`, `**/keystore/**`, each in both the home-anchored and the
   root-anchored form where a project-relative rule would miss it.
6. **Stale open requests.** `active.json` records each request's answer deadline; entries past
   it are dropped when read, and the answerer clears the file at start.
7. **`--open` does not put the key in process arguments.** It writes a mode-600 HTML file in a
   private temp dir that redirects to the URL with the fragment, opens that file, and deletes it
   after 10 s.
8. **Console text for a masked co-recipient answer** is "Only the asker sees this answer", not
   "No answer yet"; the dev mock masks exactly like the relay.
9. **Membership changes.** The deploy pins the secret's numeric version. Removing a member is
   updating `config/team.local.yaml`, then `scripts/gcp-bootstrap.sh` (new secret version),
   then `scripts/deploy.sh` (new revision on that version, invoker bindings reconciled).
10. **Feed pages** may exceed `limit` to keep an equal-`updated_at` group whole (at most 500);
    `stats_complete` is part of the directory response. The demo matches the relay's shapes and
    rules, including these.
