# team-relay (Claude Code plugin)

Lets the members of a small team ask each other's Claude Code sessions questions, and ask a
teammate to run one of a fixed set of named, parameterised operations (a *capability*). The
answer is pushed into the asker's session over a Claude Code channel. The contract is
`../docs/M1-SPEC.md` (this plugin is its §8, as corrected in §11), `../docs/M2-SPEC.md`
§2 and §4 (Google identity, tool events, the console), `../docs/M4-SPEC.md` (what the
answering session may read, and how a member grants more), `../docs/M5-SPEC.md` (install
with no questions, sign in with `/team-relay:login`) and `../docs/M6-SPEC.md` (owners manage
members in the console).

Each member runs two sessions:

- **Working session** (your normal `claude`): the plugin's `relay` channel in *asker* role.
  Tools `list_teammates`, `ask_question`, `invoke_capability`, `request_status`, and
  `login`, `logout`, `whoami` for signing in; answers,
  "no response yet" and "acknowledged but not answered" notices arrive as
  `<channel source="relay" ...>` events.
- **Answering session** (`bin/answerer`): a separate, locked-down `claude` that receives
  teammates' questions and capability calls, acknowledges, answers and replies.

## Install

The repository root is a marketplace (`.claude-plugin/marketplace.json`, name
`team-relay-dev`) with this one plugin.

```
/plugin marketplace add <github-owner>/team-relay      # or a local clone's path
/plugin install team-relay@team-relay-dev
```

There are no install questions (`.claude-plugin/plugin.json` has no `userConfig`): the relay
URL defaults to the plugin's own relay (`relay.default.json`, the one place it is written),
and capabilities are enabled where they run, in the answering session's environment.

Commands (`commands/*.md`, namespaced by the plugin name):

| Command | What it does |
|---|---|
| `/team-relay:login [relay-url]` | Calls the `login` tool: signs this computer in (below). A URL signs in to another relay. |
| `/team-relay:answering` | Prints the one command that starts your answering session (`"${CLAUDE_PLUGIN_ROOT}/bin/answerer"`), and the settings that share folders and offer capabilities (generated from `manifest.yaml`). |
| `/team-relay:console` | Prints the command that opens the local console (`"${CLAUDE_PLUGIN_ROOT}/bin/console" --open`). |

## Running the working session

During the channels research preview a channel from your own marketplace has to be loaded
with the development flag:

```
claude --dangerously-load-development-channels plugin:team-relay@team-relay-dev
```

A SessionStart hook adds one line of context: who you are on the relay and who your
teammates are, or `Not connected: run /team-relay:login`.

### Signing in (M5-SPEC §2, §6)

`/team-relay:login` runs the asker channel's `login` tool, loopback + PKCE in the style of
RFC 8252 (no device codes, so nothing to phish):

1. It makes a PKCE verifier (64 base64url characters) and its S256 challenge, a random
   `state` (32 bytes), and an HTTP listener on **127.0.0.1 only**, on a free port, for
   **one request** and at most **5 minutes**.
2. It opens your browser at `{relay}/v1/login/start?port&state&code_challenge&device`,
   through a private mode-600 redirect file (the URL never appears in a process argument,
   M2-SPEC §7.7; `TEAM_RELAY_OPEN_COMMAND` names another opener), and returns the URL at once
   in the tool result, in case no browser opens.
3. On the relay you sign in with Google, see the teams your account belongs to, and choose
   one. The relay sends the browser to `http://127.0.0.1:<port>/callback?code&state`.
4. The listener takes exactly that request (`GET /callback`, `Host: 127.0.0.1:<port>`, the
   `state` compared in constant time; anything else ends the sign-in; Cancel on the chooser
   comes back as `?error=access_denied` and ends it as "sign-in cancelled"), shows
   "Connected. You can close this tab.", and exchanges the code and the verifier at `POST
   {relay}/v1/login/token` for a device credential (`trc_…`).
5. The credential is stored in `$XDG_CONFIG_HOME/team-relay/credentials.json` (default
   `~/.config/team-relay/`), `{relay_url, team, member, credential, expires_at}`, the
   directory mode 700 and the file mode 600, written atomically. A file or directory others
   could read, one owned by someone else, or a symlink is refused, never used. The channel
   pushes a `<channel source="relay" type="status">` line saying you are signed in, and its
   stream starts without a restart.

With no stored sign-in the channel starts anyway, waits quietly (it looks for the file every
2 s, so a login from another session counts too), and every teammate tool answers `Not
connected: run /team-relay:login`. A credential the relay refuses (401: signed out, expired,
or removed from the team) is never retried in a loop: the tools and a status line say to run
`/team-relay:login` again, and a new login reconnects. `whoami` says who you are signed in
as; `logout` revokes the credential at the relay (`DELETE /credentials/self`) and deletes the
file. The credential is only ever sent to the relay it came from.

`RELAY_AUTH` (when set) wins over the stored credential: `google` signs in with your gcloud
identity (`gcloud auth print-identity-token`, an argv, never a shell; `--account=` with
`RELAY_GCLOUD_ACCOUNT`), cached until 5 minutes before its `exp` and refreshed once on a 401;
it needs `RELAY_TEAM` (and `RELAY_URL` for another relay). `token` is for the local emulator
and tests only (the relay refuses static tokens on Cloud Run). Unset, the credential file is
used when there is one, else `google`.

## Running the answering session

```
# after /team-relay:login: no relay settings needed
export CAP_STAGING_DB_QUERY_ENABLED=true
export CAP_STAGING_DB_QUERY_RUNNER=/absolute/path/to/your/runner
export ANSWERER_READ_DIRS=~/src/orders-service:~/notes/runbooks   # optional: folders it may read without asking
bin/answerer
```

**Nothing is readable by default** (M4-SPEC §1). The answering session reads a local file
only when it is inside a folder you share, or when you allow it at the moment it is needed:

- **Shared folders** (`ANSWERER_READ_DIRS`, optional, `:`-separated, at most 16, `~/`
  allowed): readable without asking. Share folders deliberately: a teammate's question can
  ask for anything in them. Each entry must be an existing directory (after `~` and symlinks
  are resolved) that is not `/`, not your home directory, not above it, and not inside
  `ANSWERER_HOME`, `~/.claude`, `CLAUDE_CONFIG_DIR` or a credential location on the deny list
  below; otherwise `bin/answerer` refuses to start, naming the entry and the reason. Their
  names (the basename only, never the path; characters outside `A-Z a-z 0-9 . _ -` become
  `_`) are published to your team with your capabilities, so the console shows
  "Shares: orders-service, runbooks".
- **Grants, per request:** any other `Read`, `Glob` or `Grep` opens Claude Code's own
  permission dialog in the answering session's terminal, naming the path. Allow it once,
  allow that folder for the rest of the session, or deny it. A desktop notification tells you
  when the dialog is waiting, and the asker's console shows "waiting for <you> to allow
  access" (below). Grants last at most for the session: `bin/answerer` starts every session
  with none (it removes the working directory's `.claude/settings.local.json`, where "don't
  ask again" is saved).
- **Never:** credentials and other secrets on the deny list stay unreadable whatever you
  answer (deny rules beat an approval), and no dialog can enable `Bash`, `Write`, `Edit`,
  `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent` or `Task`.

`bin/answerer` creates `${ANSWERER_HOME:-~/.claude-team-relay/answerer}` (mode 700) with:

- `mcp.json`: the `relay` channel in *answerer* role and the `capabilities` server, with the
  settings passed explicitly. With the stored sign-in (the default after `/team-relay:login`;
  `dist/credential-info.js` checks the file by the same rules and prints only its relay,
  team and member) the servers get `RELAY_AUTH=credential` and `RELAY_CREDENTIALS_FILE`, its
  absolute path, and the relay and team come from it (`RELAY_URL` / `RELAY_TEAM`, when set,
  must agree). Without one and with `RELAY_AUTH=google` no token is stored:
  the servers run gcloud themselves (`PATH`, `RELAY_GCLOUD_ACCOUNT` and any `CLOUDSDK_*`
  settings are passed through), and a `token` file left by an earlier token-mode run is
  removed. With `RELAY_AUTH=token` the token is handed over as `RELAY_TOKEN_FILE`; a
  `RELAY_TOKEN` value is written to `token` (mode 600) and never into `mcp.json`, and it is
  removed from the session's environment.
- `settings.json`:
  - `permissions.defaultMode` `default` (Claude Code's Manual mode: anything not allowed
    prompts), with auto mode and bypass mode disabled for the session
    (`disableAutoMode`, `disableBypassPermissionsMode`); the command also passes
    `--permission-mode default`;
  - allows `mcp__relay__*`, `mcp__capabilities__*` and one `Read(//<folder>/**)` per shared
    folder (the physical path, glob characters escaped). There is no bare `Read`, `Glob` or
    `Grep` allow: Claude Code applies `Read` rules to `Glob` and `Grep`;
  - denies `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent`, `Task`;
  - denies reading credential stores and other secrets with `Read(...)` path rules only.
    Claude Code evaluates path rules for `Read` (and applies them to `Glob` and `Grep`); a
    `Glob(...)` or `Grep(...)` path rule is accepted but never consulted, so there are none
    (M2-SPEC §7.5). In the home directory: `~/.ssh/**`, `~/.gnupg/**`, `~/.aws/**`,
    `~/.config/gcloud/**`, `~/.azure/**`, `~/.kube/**`, `~/.docker/**`, `~/.netrc`,
    `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.claude/**`,
    `~/.claude-team-relay/**`, `~/.config/team-relay/**` (the relay's own credential),
    `~/Library/Keychains/**`, `~/.config/gh/**`,
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
    mode), the credential file and its directory (also `$XDG_CONFIG_HOME/team-relay` when
    set), `CLOUDSDK_CONFIG` and your own `CLAUDE_CONFIG_DIR` when set (literal paths, with
    glob characters escaped);
  - `PostToolUse`, `PostToolUseFailure` and `PermissionRequest` hooks (exec form,
    `"async": true`, so they run in the background and never delay a tool call or a dialog)
    running `node dist/tool-event.js --config $ANSWERER_HOME/tool-event.json` (below);
  - a `Notification` hook for `permission_prompt` only (exec form, async) running
    `node dist/notify-desktop.js` (below).
- `tool-event.json`: the hook's relay settings (URL, team, sign-in mode, account, token file
  or credential file path, state directory); no secret.
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
owned by you and never a symlink), or from `ANSWERER_WORKDIR` when set (an absolute path).

Before anything else the launcher removes the working directory's
`.claude/settings.local.json` (and `.claude/` when that leaves it empty): outside a git
repository, that is where Claude Code saves a "don't ask again" answer, and grants must not
outlive the session. It never removes through a symlink or in a directory you do not own. It
then refuses to start, before writing anything, when `ANSWERER_READ_DIRS` has an entry it
refuses (above), or when the working directory:

- is inside `$HOME` (compared after resolving symlinks; a `TMPDIR` inside `$HOME` needs
  `ANSWERER_WORKDIR`),
- is not empty (anything besides that one file), or
- or any ancestor contains `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`,
  `.claude/rules/`, `.claude/settings.json` or `.claude/settings.local.json`.

It then runs `claude --mcp-config … --strict-mcp-config --settings … --permission-mode default
--disallowedTools Bash Write Edit NotebookEdit WebFetch WebSearch Agent Task
--dangerously-load-development-channels server:relay` from that directory. Extra arguments are passed through to `claude`.
`bin/answerer --print-command` writes the files and prints the command instead of running it.

At startup the answering channel publishes your discovery payload: the manifest restricted
to the capabilities this session will actually run, and `shares`, the names of your shared
folders (an empty list when you share none), validated against the same schema the relay
uses.

**These are permission rules, not an OS sandbox.** Claude Code enforces them for its own
file tools; nothing stops another process your user runs from reading a file. Whatever is in
a shared folder, and whatever you allow in a dialog, a teammate can ask for and the session
can read. The deny rules cover the usual credential stores, not every secret on your machine
(a key under another name, a database dump, a document), so do not share a folder that
holds one, and read the path in a dialog before you allow it. The instructions tell the
session never to try to read credentials and never to send secrets to teammates, but that is
an instruction to a model, not a boundary.

### Seeing a grant happen (M4-SPEC §2)

- **You:** when a permission dialog has waited about six seconds (Claude Code's timing for
  `permission_prompt` notifications), `dist/notify-desktop.js` shows a desktop notification
  with a fixed text, "Team relay: your answering session is waiting for your permission", via
  `osascript` on macOS or `notify-send` on Linux when it is installed (nothing elsewhere). It
  reads the hook input only to check that it is a permission prompt; no text from the hook
  input or from a teammate is ever passed to the notifier, and it runs no shell. It always
  exits 0 and gives up after 3 s.
- **The asker and the team:** the `PermissionRequest` hook posts a tool event with
  `status: "waiting"` (the tool's name only, never the path) to the request being answered.
  The console shows "waiting for <you> to allow access" in amber until the next event for
  that tool arrives. If you deny, no event follows (Claude Code runs no hook for a denied
  dialog), so the console shows the waiting state until the next tool event or the answer.

### Tool events (M2-SPEC §4.3)

Every tool call in the answering session (and every failed one), and every permission
request, runs `dist/tool-event.js`.
It takes the tool's name from the hook input (an `mcp__<server>__` prefix stripped; the
relay's own `ack_question` and `reply` are skipped), finds the most recently acknowledged
open request in `state/active.json` (none open: nothing is sent), and posts
`{"tool", "status": "ok"|"error"|"waiting", "duration_ms"}` to that request's
`/requests/{id}/events` (`waiting` for a permission request, with no duration). Claude Code's hook input carries `duration_ms` (the tool's run time)
on both events, so it is sent when present. The tool's input, output and error text are
never sent. The hook runs asynchronously, the script always exits 0 and gives up after 3 s,
so a slow or unreachable relay never holds up the session. A request past its answer deadline
is no longer open, so tool calls after it are not reported.

### Environment

| Name | Used by | Meaning |
|---|---|---|
| `RELAY_URL` | both servers, `bin/answerer` | Relay base URL. From the stored sign-in by default; otherwise the plugin's default relay. |
| `RELAY_TEAM` | both servers, `bin/answerer` | Team id. From the stored sign-in by default; needed for `google` and `token`. |
| `RELAY_AUTH` | both servers, `bin/answerer`, `bin/console` | Unset: the stored credential if there is one, else `google`. `credential`, `google` (`gcloud auth print-identity-token`) or `token`; `metadata` (the runtime service account) for the hosted console. |
| `RELAY_CREDENTIALS_FILE` | every part | Optional: the credential file's absolute path. Default `$XDG_CONFIG_HOME/team-relay/credentials.json` or `~/.config/team-relay/credentials.json`. |
| `TEAM_RELAY_OPEN_COMMAND` | `login`, `bin/console --open` | Optional: an absolute path to the program that opens the browser, given only the redirect file's path (tests use a stub). |
| `RELAY_GCLOUD_ACCOUNT` | both servers, `bin/answerer`, `bin/console` | Optional, with `google`: `--account=` for gcloud (an email address). |
| `RELAY_TOKEN_FILE` / `RELAY_TOKEN` | both servers, `bin/answerer`, `bin/console` | Only with `token`: bearer token; the file wins, trailing newline stripped, re-read on every request. |
| `RELAY_ROLE` | channel | `asker` or `answerer`. |
| `MANIFEST_PATH` | answerer channel, capability server | Defaults to this plugin's `manifest.yaml`. |
| `ALLOW_PRODUCTION` | answerer channel, capability server | Only the exact value `true` allows production capabilities. |
| `CAP_<NAME>_ENABLED` | answerer channel, capability server | Only `true` enables `<name>` (`NAME` is the capability name uppercased). |
| `CAP_<NAME>_RUNNER` | answerer channel, capability server | Absolute path of an executable regular file. |
| `ANSWERER_READ_DIRS` | `bin/answerer` | Optional: the folders the answering session reads without asking, `:`-separated, at most 16 (`~/` allowed). Refused entries stop the launcher. Their basenames are published as `shares`. |
| `ANSWERER_SHARES` | answerer channel | Set by `bin/answerer`: the JSON list of shared folder names to publish. |
| `ANSWERER_HOME` | `bin/answerer` | Where the session's configuration lives (`mcp.json`, `settings.json`, `tool-event.json`, `config/`, `state/`). Default `~/.claude-team-relay/answerer`. |
| `ANSWERER_STATE_DIR` | answerer channel | Set by `bin/answerer` to `$ANSWERER_HOME/state`: where `active.json` is kept. |
| `CONSOLE_PORT` | `bin/console` | Default 4317; `0` picks a free port. |
| `JOIN_MARKETPLACE` | console server | Optional: what the join panel tells new members to `/plugin marketplace add` (a GitHub `owner/repo`, or a plain `https://` URL). |
| `JOIN_REPO_URL` | console server | Optional: the `https://` URL of this repository; a GitHub URL becomes the marketplace source when `JOIN_MARKETPLACE` is unset. |
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
bin/console --open            # your team, with your stored sign-in (or the RELAY_* settings above)
```

`bin/console` runs `node dist/console-server.js`, which binds **127.0.0.1 only** and prints
`http://127.0.0.1:<port>/#k=<key>`; the key is 32 random bytes made for this launch and
travels in the URL fragment, which the browser never sends to a server. The console sends
it back as `X-Console-Key` on every API call. The server:

- refuses any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS
  rebinding), any `/api/*` call without the key (401) or with a wrong one (403, compared in
  constant time), and any call the browser marks cross-site; it sends no CORS headers;
- proxies five GETs to the relay with your own credentials: `/api/me`, `/api/directory`,
  `/api/activity` (`since`, `limit`), `/api/requests/{id}` and `/api/roster` (M6-SPEC §2);
- proxies an owner's roster changes and nothing else (M6-SPEC §3): `POST /api/roster`
  `{member, email, role?}`, `PATCH /api/roster/{member}` `{add_email?, remove_email?, role?}`
  and `DELETE /api/roster/{member}`. Each needs `Content-Type: application/json` (else 415)
  and `Sec-Fetch-Site: same-origin` (else 403, before anything is read), a body of at most
  4 KiB that is checked here (known fields only, a member id, lower-cased emails) before it is
  sent on once, never retried. The relay decides whether you are an owner. Every other
  method and path is refused: nothing can be sent, acked or replied from the console;
- passes a relay refusal on as `502 {"error": "relay_refused", "relay_status",
  "relay_error", "detail"}`, so the Members panel can say why a change was refused;
- answers `GET /api/join` itself, never asking the relay, behind the same key (IAP when
  hosted): `{"relay_url", "team", "repo_url", "marketplace_source", "marketplace":
  "team-relay-dev", "plugin": "team-relay", "default_relay"}` from the relay and team in use,
  `JOIN_MARKETPLACE` and `JOIN_REPO_URL` (`null` when unset; demo values with `--demo`);
  `default_relay` says whether a bare `/team-relay:login` reaches this relay. The console's
  *Join the team* panel builds its three steps from it. Nothing in it is secret; a
  `JOIN_REPO_URL` or `JOIN_MARKETPLACE` that is not plain stops the server at startup;
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
- proxies the same routes, with the service account's ID token (`RELAY_AUTH=metadata`,
  required in hosted mode) and `X-Relay-On-Behalf-Of: <viewer email, lower-cased>`; the
  relay acts as that member (M3-SPEC §2; roster changes need the delegate's `manage-roster`
  scope and an owner, M6-SPEC §3);
- answers `403 {"error": "not_on_team", "email"}` when the relay says the signed-in account is
  on no roster of the team (its `403 not_a_member`; IAP admits any Google account, M6-SPEC
  §5), and the console shows "You're not on this team yet. Ask the owner to add <email>."
  with no data. A plain `401` from the relay is the console's own sign-in failing (a setup
  problem) and is shown as such;

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
- **Production data is opt-in** in the answering session's environment.
- **Identity is the relay's.** The sender of every message is the member the relay
  resolved from a verified credential; nothing a client writes can claim another sender.
- The token (device credential, static or Google ID token) is never logged, never put in an
  error or a tool result. The only file the plugin writes one to is the credential file
  (mode 600). All logs go to stderr (stdout is the MCP transport).
- **The answering session reads nothing by default**: only folders you share, and files or
  folders you allow in Claude Code's own dialog for that session; credential stores stay
  denied whatever you answer. These are permission rules, not an OS sandbox (see above).
- **The desktop notice is fixed text**; no teammate or hook-input text reaches it.
- **Tool events carry a name, an outcome (`ok`, `error`, or `waiting` for your permission)
  and a duration**, never a tool's input, output, error text or path.
- Network errors, 5xx and 429 (`rate_limited`, `too_many_polls`) are retried with
  exponential backoff; other refusals (for example `422 invalid_timeouts`) are tool errors.

## Development

```
pnpm install
pnpm typecheck
pnpm test             # builds dist/ first; the stdio suites drive node dist/*.js
pnpm build            # esbuild → dist/{channel,capabilities,session-start,tool-event,notify-desktop,console-server,credential-info}.js (committed); never touches dist/console/
pnpm generate         # manifest.yaml → commands/answering.md, and plugin.json (no userConfig) and .mcp.json
pnpm generate --check # fails when those files are out of date
../scripts/e2e.sh     # the M1 gate, the M2 scenarios, and the M5/M6 sign-in and roster scenarios when the relay serves them
```

`pnpm test` never runs `test/e2e/`. `../scripts/e2e.sh` (Docker and `../relay/.venv` needed)
starts a Firestore emulator on 127.0.0.1:8682 and the relay with throwaway static tokens,
builds `dist/`, runs `pnpm test:e2e` with `E2E=1`, and tears everything down on exit.

After changing `manifest.yaml`, run `pnpm generate` and commit the result; after changing
`src/`, run `pnpm build` and commit `dist/`.
