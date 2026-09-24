# Milestone 4: reads are granted, not assumed

Status: spec, 24 Sep 2026. Replaces M2-SPEC §4.2 and §7.5 (the answering session's reads).
Everything else in M1–M3 and their corrections still binds.

Kiril's decisions (24 Sep 2026, in the thread): the M2 read access (everything except a
blocklist of credential paths) is too risky. Reads must be allowlisted, and **the member who
was asked can grant access to a specific file or folder** when a question needs it.

## 1. The answering session's reads

- **Default: nothing.** The answering session reads no local file unless it is inside a folder
  the member shares or the member approves it at the moment it is needed.
- **Shared folders (optional, standing):** `ANSWERER_READ_DIRS`, a `:`-separated list of
  directories. Each is expanded (`~`), resolved (symlinks), and must be an existing directory
  that is not `/`, not `$HOME` itself, not an ancestor of `$HOME`, and not inside
  `ANSWERER_HOME`, the Claude config dirs or any credential location on the deny list;
  otherwise `bin/answerer` refuses to start and says which entry and why. Each becomes
  `permissions.allow` `Read(//<abs>/**)` (escaped as today). At most 16.
- **Grants (per request, by the member):** the session runs in Claude Code's normal
  permission mode (not `dontAsk`, not auto). A `Read`, `Glob` or `Grep` outside the shared
  folders opens Claude Code's own permission dialog in the answering session's terminal,
  naming the path; the member allows once, allows that folder for the session, or denies.
  Grants last at most for the session: `bin/answerer` starts every session with no
  persisted grants (it removes `work/.claude/settings.local.json` if a previous session's
  "don't ask again" left one, and still refuses any other content in `work/`).
- **Never:** the credential deny list of M2 §7.5 stays as `permissions.deny` `Read(...)` rules,
  which beat any approval. `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`,
  `WebSearch`, `Agent`, `Task` stay in `--disallowedTools` and `permissions.deny` (no dialog
  can enable them).
- Verify against https://code.claude.com/docs/en/permissions and /iam: which permission mode
  gives "prompt for anything not allowed" (the CLI's choices are `acceptEdits`, `auto`,
  `bypassPermissions`, `manual`, `dontAsk`, `plan`); that reads outside the working directory
  prompt rather than pass; and that deny rules beat an interactive approval.
- The instructions string (answerer) says: shared folders are readable; for anything else,
  try the read and the member will be asked; never try to read credentials; if access is
  denied, answer without it or say you could not.

## 2. Seeing a grant happen

- **The member:** a `Notification` hook in the answerer's `settings.json` (exec form, async)
  runs `node <plugin>/dist/notify-desktop.js`, which shows a local desktop notification with a
  **fixed** text ("Team relay: your answering session is waiting for your permission") via
  `osascript` on macOS or `notify-send` on Linux when present; it never interpolates any text
  from the hook payload or from teammates. Only for permission notifications
  (`notification_type` / matcher `permission_prompt`; verify the field against
  https://code.claude.com/docs/en/hooks). Exits 0 always.
- **The asker and the team:** a `PermissionRequest` hook (async) posts a tool event with
  `status: "waiting"` for the current request (same attribution rules as M2 §4.3). The relay's
  tool-event `status` accepts `ok | error | waiting`. The console shows a recipient whose most
  recent tool event is `waiting` as "waiting for <member> to allow access" (amber, on the
  step track and in the detail sheet); the next `ok`/`error` event for that tool clears it.
  Nothing about the path is ever sent.

## 3. Showing what is shared

- The manifest schema gains an optional top-level `shares` list:
  `[{"name": "^[A-Za-z0-9._-]{1,64}$"}]`, at most 16, unique names. The answering session
  publishes the **basenames** of `ANSWERER_READ_DIRS` there with its capabilities (never full
  paths). The relay validates it with the same schema; the directory returns it inside
  `manifest` as today.
- The console's agent card shows "Shares: a, b" (or "Shares nothing") per member.

## 4. Docs

`README.md` (security table and join steps), `plugin/README.md`, and the console's join panel
say what §1 says: nothing is readable by default; share folders deliberately; grant specific
files or folders when asked; credentials are never readable; this is permission rules, not an
OS sandbox.

## 5. Gates

- Relay: `waiting` status accepted (and nothing else new); both stores; `scripts/test-relay.sh`.
- Plugin: `bin/answerer` settings content (permission mode; no bare `Read`/`Glob`/`Grep` allow;
  one `Read(//…/**)` per shared dir; deny list intact; hooks present, exec form, async); every
  `ANSWERER_READ_DIRS` refusal; grants file removed at start and other content still refused;
  notify-desktop script never interpolates payload text (argv checked with a stub `osascript`);
  PermissionRequest → `waiting` event; `shares` published as basenames. Typecheck, tests,
  build, `generate --check`, `scripts/e2e.sh` (add: a `waiting` event shows on the feed).
- Console: shares on cards; waiting state on the track and in the sheet; cleared by the next
  event; tests; build; screenshots refreshed.
