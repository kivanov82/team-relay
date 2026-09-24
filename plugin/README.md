# team-relay (Claude Code plugin)

Lets the members of a small team ask each other's Claude Code sessions questions, and ask a
teammate to run one of a fixed set of named, parameterised operations (a *capability*). The
answer is pushed into the asker's session over a Claude Code channel. The contract is
`../docs/M1-SPEC.md` (this plugin is its §8, as corrected in §11) and `../docs/M2-SPEC.md`
§2 and §4 (Google identity, answering-session reads, tool events, the console).

Each member runs two sessions:

- **Working session** (your normal `claude`): the plugin's `relay` channel in *asker* role.
  Tools `list_teammates`, `ask_question`, `invoke_capability`, `request_status`; answers,
  "no response yet" and "acknowledged but not answered" notices arrive as
  `<channel source="relay" ...>` events.
- **Answering session** (`bin/answerer`): a separate, locked-down `claude` that receives
  teammates' questions and capability calls, acknowledges, answers and replies.

## Install

The repository root is a marketplace (`.claude-plugin/marketplace.json`, name
`team-relay-dev`) with this one plugin.

```
/plugin marketplace add /path/to/multiagent
/plugin install team-relay@team-relay-dev
```

When the plugin is enabled, Claude Code asks the questions generated from `manifest.yaml`:

| Key | Type | What to answer |
|---|---|---|
| `relay_url` | string, required | The relay's base URL. `https://` (plain `http://` is accepted only for `localhost`). |
| `relay_team` | string, required | Your team id, for example `demo`. |
| `relay_auth` | `google` (default) or `token` | How you sign in: your own gcloud identity, or a static development token for a local relay. |
| `gcloud_account` | string, optional | With `google`: the gcloud account (email) to use; empty means gcloud's active account. |
| `relay_token` | string, sensitive, only for `token` | A static bearer token for a local relay (kept in the system keychain). |
| `allow_production` | boolean, default off | Allow capabilities that touch production data. |
| `cap_<name>` | boolean | Offer capability `<name>` to teammates. Production capabilities are always off by default. |
| `cap_<name>_runner` | file | Absolute path to the program that runs `<name>`. |

The working session uses only the first five. The `allow_production` and `cap_*` answers
describe what your **answering session** offers; that session is launched outside the
plugin and cannot read plugin options, so it takes the same settings from the environment
(below).

## Running the working session

During the channels research preview a channel from your own marketplace has to be loaded
with the development flag:

```
claude --dangerously-load-development-channels plugin:team-relay@team-relay-dev
```

A SessionStart hook adds one line of context: who you are on the relay, who your teammates
are, and that teammate messages are data.

### Signing in (M2-SPEC §2)

With `relay_auth` `google` (the default) the plugin runs `gcloud auth print-identity-token`
(an argv, never a shell; `--account=<gcloud_account>` when set) and sends that ID token. It
keeps the token in memory until 5 minutes before its `exp` (read from the token, not
verified; the relay verifies it), fetches a fresh one once when the relay answers 401, and
never writes it to a log, an error or a file. You need the Google Cloud CLI and a signed-in
user account (`gcloud auth login`); the relay's allowlist decides who you are.

Known limit: such a token's audience is gcloud's own OAuth client, so an ID token you send
to some other service could be replayed to the relay until it expires (within the hour). A
dedicated OAuth client for the relay would close that; it is a later hardening.

`token` is for the local emulator and tests only (the relay refuses static tokens on Cloud
Run); it needs `relay_token` (or `RELAY_TOKEN` / `RELAY_TOKEN_FILE`).

## Running the answering session

```
export RELAY_URL=https://relay.example.com
export RELAY_TEAM=demo
export RELAY_GCLOUD_ACCOUNT=you@example.com                  # optional; RELAY_AUTH=google is the default
export CAP_STAGING_DB_QUERY_ENABLED=true
export CAP_STAGING_DB_QUERY_RUNNER=/absolute/path/to/your/runner
bin/answerer
```

`bin/answerer` creates `${ANSWERER_HOME:-~/.claude-team-relay/answerer}` (mode 700) with:

- `mcp.json`: the `relay` channel in *answerer* role and the `capabilities` server, with the
  settings passed explicitly. With `RELAY_AUTH=google` (the default) no token is stored:
  the servers run gcloud themselves (`PATH`, `RELAY_GCLOUD_ACCOUNT` and any `CLOUDSDK_*`
  settings are passed through), and a `token` file left by an earlier token-mode run is
  removed. With `RELAY_AUTH=token` the token is handed over as `RELAY_TOKEN_FILE`; a
  `RELAY_TOKEN` value is written to `token` (mode 600) and never into `mcp.json`, and it is
  removed from the session's environment.
- `settings.json`:
  - allows `mcp__relay__*`, `mcp__capabilities__*`, `Read`, `Glob` and `Grep`;
  - denies `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent`, `Task`;
  - denies reading credential stores and other secrets with `Read(...)` path rules only.
    Claude Code evaluates path rules for `Read` (and applies them to `Glob` and `Grep`); a
    `Glob(...)` or `Grep(...)` path rule is accepted but never consulted, so there are none
    (M2-SPEC §7.5). In the home directory: `~/.ssh/**`, `~/.gnupg/**`, `~/.aws/**`,
    `~/.config/gcloud/**`, `~/.azure/**`, `~/.kube/**`, `~/.docker/**`, `~/.netrc`,
    `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.claude/**`,
    `~/.claude-team-relay/**`, `~/Library/Keychains/**`, `~/.config/gh/**`,
    `~/.zsh_history`, `~/.bash_history`, `~/.*_history`,
    `~/Library/Application Support/**/Cookies*`, `~/Library/Application Support/Firefox/**`,
    `~/Library/Application Support/Google/Chrome/**`, `~/.terraform.d/**`,
    `~/.cargo/credentials*`, `~/.vault-token`, `~/.pgpass`, `~/.config/solana/**`,
    `~/.foundry/**`, `~/.ethereum/**`;
  - anywhere, each as written (`**/x`), home-anchored (`~/**/x`) and root-anchored
    (`//**/x`), because a `**/x` rule resolves from the session's (empty) working directory:
    `.env`, `.env.*`, `.envrc`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`, `*.pfx`,
    `*.keystore`, `*.jks`, `credentials.json`, `*.tfvars`, `keystore/**`;
  - and the session's own files: `~/.claude.json`, `ANSWERER_HOME`, the token file (token
    mode) and `CLOUDSDK_CONFIG` when set (literal paths, with glob characters escaped);
  - `PostToolUse` and `PostToolUseFailure` hooks (exec form, `"async": true`, so they run
    in the background and never delay a tool call) running
    `node dist/tool-event.js --config $ANSWERER_HOME/tool-event.json` (below).
- `tool-event.json`: the hook's relay settings (URL, team, sign-in mode, account or token
  file path, state directory); no secret.
- `state/` (mode 700): `active.json`, the requests this session has acknowledged and not yet
  answered (ids and times only, each with its answer deadline), written atomically by the
  answering channel, which clears it when it starts. An entry past its answer deadline is
  dropped whenever the file is read (M2-SPEC §7.6). The deadline comes from the question or
  capability call the channel pushed, else the ack response, else `GET /requests/{id}`; when
  none of them gives one, the longest answer window the relay allows (24 h from the ack).
- `config/`: the session's own `CLAUDE_CONFIG_DIR`, so none of your memory, `CLAUDE.md`,
  plugins or hooks load. The first run there needs a login (or Vertex env, which passes
  through).

The session's working directory is **not** under `ANSWERER_HOME`: Claude Code loads memory
files from every ancestor of its working directory, which `CLAUDE_CONFIG_DIR` does not cover,
and your home directory holds your own `~/.claude/`. So it runs from
`${TMPDIR:-/tmp}/team-relay-answerer-<uid>/work` (both levels mode 700, created when missing,
owned by you and never a symlink), or from `ANSWERER_WORKDIR` when set (an absolute path). The
launcher refuses to start, before writing anything, when the working directory:

- is inside `$HOME` (compared after resolving symlinks; a `TMPDIR` inside `$HOME` needs
  `ANSWERER_WORKDIR`),
- is not empty, or
- or any ancestor contains `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`,
  `.claude/rules/`, `.claude/settings.json` or `.claude/settings.local.json`.

It then runs `claude --mcp-config … --strict-mcp-config --settings … --disallowedTools Bash
Write Edit NotebookEdit WebFetch WebSearch Agent Task --dangerously-load-development-channels
server:relay` from that directory. Extra arguments are passed through to `claude`.
`bin/answerer --print-command` writes the files and prints the command instead of running it.

At startup the answering channel publishes your discovery payload: the manifest restricted
to the capabilities this session will actually run.

**Reading files is a guard rail, not a sandbox.** The answering session can read any file
your user can read, except what the deny rules above name; a teammate's question can ask
for any file. The deny rules cover the usual credential stores, not every secret on your
machine (a key under another name, a database dump, a document). The instructions tell the
session never to send secrets to teammates, but that is an instruction to a model, not a
boundary. If a directory holds something no teammate may see, keep it out of reach of the
user that runs the answering session.

### Tool events (M2-SPEC §4.3)

Every tool call in the answering session (and every failed one) runs `dist/tool-event.js`.
It takes the tool's name from the hook input (an `mcp__<server>__` prefix stripped; the
relay's own `ack_question` and `reply` are skipped), finds the most recently acknowledged
open request in `state/active.json` (none open: nothing is sent), and posts
`{"tool", "status": "ok"|"error", "duration_ms"}` to that request's
`/requests/{id}/events`. Claude Code's hook input carries `duration_ms` (the tool's run time)
on both events, so it is sent when present. The tool's input, output and error text are
never sent. The hook runs asynchronously, the script always exits 0 and gives up after 3 s,
so a slow or unreachable relay never holds up the session. A request past its answer deadline
is no longer open, so tool calls after it are not reported.

### Environment

| Name | Used by | Meaning |
|---|---|---|
| `RELAY_URL` | both servers, `bin/answerer` | Relay base URL. |
| `RELAY_TEAM` | both servers, `bin/answerer` | Team id. |
| `RELAY_AUTH` | both servers, `bin/answerer`, `bin/console` | `google` (default: `gcloud auth print-identity-token`) or `token`; `metadata` (the runtime service account) for the hosted console. |
| `RELAY_GCLOUD_ACCOUNT` | both servers, `bin/answerer`, `bin/console` | Optional, with `google`: `--account=` for gcloud (an email address). |
| `RELAY_TOKEN_FILE` / `RELAY_TOKEN` | both servers, `bin/answerer`, `bin/console` | Only with `token`: bearer token; the file wins, trailing newline stripped, re-read on every request. |
| `RELAY_ROLE` | channel | `asker` or `answerer`. |
| `MANIFEST_PATH` | answerer channel, capability server | Defaults to this plugin's `manifest.yaml`. |
| `ALLOW_PRODUCTION` | answerer channel, capability server | Only the exact value `true` allows production capabilities. |
| `CAP_<NAME>_ENABLED` | answerer channel, capability server | Only `true` enables `<name>` (`NAME` is the capability name uppercased). |
| `CAP_<NAME>_RUNNER` | answerer channel, capability server | Absolute path of an executable regular file. |
| `ANSWERER_HOME` | `bin/answerer` | Where the session's configuration lives (`mcp.json`, `settings.json`, `tool-event.json`, `config/`, `state/`). Default `~/.claude-team-relay/answerer`. |
| `ANSWERER_STATE_DIR` | answerer channel | Set by `bin/answerer` to `$ANSWERER_HOME/state`: where `active.json` is kept. |
| `CONSOLE_PORT` | `bin/console` | Default 4317; `0` picks a free port. |
| `JOIN_REPO_URL` | console server | Optional: the `https://` URL of this repository, shown to new members in the console's join panel as the one to clone. |
| `CONSOLE_MODE` | console server | `local` (default) or `hosted` (the container only). |
| `PORT`, `CONSOLE_PUBLIC_HOST`, `IAP_AUDIENCE` | hosted console | Listening port (default 8080), the exact public host, the IAP audience. |
| `ANSWERER_WORKDIR` | `bin/answerer` | The session's working directory: absolute, outside `$HOME`, empty. Default `${TMPDIR:-/tmp}/team-relay-answerer-<uid>/work`. |

A capability is offered only when it is enabled, its runner is an executable regular file,
and it is staging data or `ALLOW_PRODUCTION=true`.

A capability tool runs only for the request it names. Before starting the runner the
capability server reads `GET /requests/{request_id}` from the relay as you and requires a
directed (not broadcast) capability request for that same capability, addressed to you, not
yet answered by you and not expired, whose params equal the tool's arguments after defaults
(compared key-order-independently). Anything else is a tool error and the runner never
starts, so the answering Claude cannot be talked into running a capability for a broadcast
question, for another capability's request or with other params.

### Writing a runner

A runner is any executable. It is started **without a shell and without arguments**, with
only `PATH`, `HOME`, `LANG` and `CAPABILITY_NAME` in its environment. It reads one JSON line
on stdin, `{"capability": …, "params": {…}, "request_id": "rq_…"}` (params already validated
against the manifest, defaults filled), and prints one JSON **object** (at most 64 KiB) on
stdout; it becomes the reply's `data`, so an array, string, number or `null` is a tool error. Lines on stderr of the form `{"progress": "text", "pct": 40}` are reported to the
relay as progress (visible through `request_status`, never pushed into anyone's session);
other stderr lines go to the capability server's log. The manifest's `timeout_seconds` is
enforced with SIGTERM, then SIGKILL 5 s later. `test/fixtures/fake-runner.mjs` is a
synthetic example.

## The console (M2-SPEC §4.4)

```
bin/console --demo --open     # a synthetic team (demo: alice, bob, carol), no relay needed
bin/console --open            # your team, with the RELAY_* settings above
```

`bin/console` runs `node dist/console-server.js`, which binds **127.0.0.1 only** and prints
`http://127.0.0.1:<port>/#k=<key>`; the key is 32 random bytes made for this launch and
travels in the URL fragment, which the browser never sends to a server. The console sends
it back as `X-Console-Key` on every API call. The server:

- refuses any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS
  rebinding), any `/api/*` call without the key (401) or with a wrong one (403, compared in
  constant time), and any call the browser marks cross-site; it sends no CORS headers;
- proxies exactly four read-only GETs to the relay with your own credentials:
  `/api/me`, `/api/directory`, `/api/activity` (`since`, `limit`) and `/api/requests/{id}`.
  Nothing else is proxied and no other method is accepted: nothing can be sent, acked or
  replied from the console;
- answers `GET /api/join` itself, never asking the relay, behind the same key (IAP when
  hosted): `{"relay_url", "team", "repo_url", "marketplace": "team-relay-dev", "plugin":
  "team-relay"}` from `RELAY_URL`, `RELAY_TEAM` and `JOIN_REPO_URL` (`null` when unset;
  demo values with `--demo`). The console's *Join the team* panel builds its install steps
  from it. Nothing in it is secret; a `JOIN_REPO_URL` that is not a plain `https://` URL
  (no credentials, query or fragment) stops the server at startup;
- with `--open`, opens the console without putting the key in any process's arguments
  (which other local users can list): it writes a mode-600 HTML file that redirects to the
  URL into a private temp directory (mode 700), hands the browser opener (`open` on macOS,
  `xdg-open` on Linux) that file's path, and deletes it after 10 s or when the server
  stops, whichever is first (M2-SPEC §7.7);
- serves the built console from `dist/console/` (built from `../console/`) under a strict
  CSP (`default-src 'self'`, no inline script or style, no external requests), and a
  placeholder page when that directory is missing.

`--demo` serves a scripted, looping stream in the relay's own shapes: every minute a
directed question, a capability call with progress and a tool event, a broadcast one
teammate never acknowledges (`no_response`), a question between two teammates (you see its
metadata, not its text), an acknowledged question that is never answered (`timed_out`), a
capability call between two teammates, and a broadcast to you and a teammate that you both
answer (you see only your own answer). It follows the relay's rules too (M2-SPEC §7): each
request's `updated_at` strictly increases, a feed page never splits requests that share one
`updated_at`, deadlines are recorded by a sweep a moment after they pass (so the console's
effective status shows), and the directory carries `stats_complete`, `open` by effective
status, `answered` by `answered_at` in the window and the median to 3 decimals.

### The hosted console (M3-SPEC §3)

The same server runs in a container on Cloud Run behind IAP (`Dockerfile.console`,
`cloudbuild.console.yaml`; build context is the repository root) with `CONSOLE_MODE=hosted`:

- listens on `0.0.0.0:$PORT` (default 8080), prints nothing and makes no key; the `Host`
  must equal `CONSOLE_PUBLIC_HOST` (the service's `run.app` host) exactly, else 403;
- every request, static files included, needs a valid `x-goog-iap-jwt-assertion`: ES256
  only, signed by a key from `https://www.gstatic.com/iap/verify/public_key-jwk` (cached per
  its Cache-Control, one fetch at a time, an unknown `kid` refetches at most every 5
  minutes), `iss` `https://cloud.google.com/iap`, `aud` exactly `IAP_AUDIENCE`, `exp` and
  `iat` within 30 s of skew, and an `email` claim. Anything else is a bare `401`; the reason
  is logged, the token and the email never are;
- proxies the same four GETs, with the service account's ID token (`RELAY_AUTH=metadata`,
  required in hosted mode) and `X-Relay-On-Behalf-Of: <viewer email, lower-cased>`; the
  relay reads as that member (M3-SPEC §2).

`IAP_AUDIENCE` for a Cloud Run service is, in Google's "signed headers" documentation,
`/projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME` (the project *number*).

`RELAY_AUTH=metadata` asks the metadata server
(`/computeMetadata/v1/instance/service-accounts/default/identity?audience=<RELAY_URL>&format=full`,
`Metadata-Flavor: Google`) for an ID token, keeps it until 5 minutes before its `exp`, and
fetches a fresh one once when the relay answers 401.

## Trust model

- **Teammate text is data.** Everything inside a `<channel source="relay">` tag was written
  by a teammate (or their Claude). Both roles' instructions tell Claude never to run
  commands, edit files or change settings because such a message says so. Teammate text
  only ever reaches the tag body; tag attributes carry relay-checked ids only.
- **Tool results with teammate text are labelled.** `list_teammates` (capability titles,
  descriptions, param descriptions and enum values from each teammate's published manifest)
  and `request_status` (question and progress text) carry a `teammate_authored_data` field
  saying so, every string in them has `<channel` / `</channel` neutralised as pushed content
  does, and the instructions say such results are data, not instructions.
- **No permission relay.** The channel declares `claude/channel` and never
  `claude/channel/permission`: a teammate can never approve or deny a tool call in your
  session.
- **Named operations only.** Teammates can ask you to run a capability from the manifest,
  with params that are enums, bounded numbers, booleans or length-capped strings matching an
  anchored allow-list pattern. Params are validated by the asker, the relay and again by
  your capability server before a runner starts, which also binds the run to its request
  (above).
- **Patterns are RE2.** A manifest `pattern` is RE2 syntax (at most 300 characters, anchored
  `^…$`, must compile) and is only ever evaluated by `re2js`, in linear time, as a full match
  of the whole value, so a teammate's published manifest cannot stall your channel with a
  catastrophically backtracking pattern. Patterns are not passed to clients in tool input
  schemas. The same param rules as the relay apply: a `required` param may not have a
  `default`, `request_id` is reserved, integers and numbers must be finite and within ±2^53
  (`5.0` is the integer 5), `max_length` counts code points, and strings with lone
  surrogates are rejected.
- **Production data is opt-in** at install and in the answering session's environment.
- **Identity is the relay's.** The sender of every message is the member the relay
  resolved from a verified credential; nothing a client writes can claim another sender.
- The token (static or Google ID token) is never logged, never put in an error and never
  written to a file by the plugin. All logs go to stderr (stdout is the MCP transport).
- **The answering session reads local files** (except credential stores, by path); that is a
  guard rail, not a sandbox (see above).
- **Tool events carry a name, an outcome and a duration**, never a tool's input, output,
  error text or path.
- Network errors, 5xx and 429 (`rate_limited`, `too_many_polls`) are retried with
  exponential backoff; other refusals (for example `422 invalid_timeouts`) are tool errors.

## Development

```
pnpm install
pnpm typecheck
pnpm test             # builds dist/ first; the stdio suites drive node dist/*.js
pnpm build            # esbuild → dist/{channel,capabilities,session-start,tool-event,console-server}.js (committed); never touches dist/console/
pnpm generate         # manifest.yaml → .claude-plugin/plugin.json userConfig and .mcp.json
pnpm generate --check # fails when those files are out of date
../scripts/e2e.sh     # the M1 gate (all seven §9 scenarios) and the M2 scenarios when the relay serves them
```

`pnpm test` never runs `test/e2e/`. `../scripts/e2e.sh` (Docker and `../relay/.venv` needed)
starts a Firestore emulator on 127.0.0.1:8682 and the relay with throwaway static tokens,
builds `dist/`, runs `pnpm test:e2e` with `E2E=1`, and tears everything down on exit.

After changing `manifest.yaml`, run `pnpm generate` and commit the result; after changing
`src/`, run `pnpm build` and commit `dist/`.
