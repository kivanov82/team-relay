# Milestone 8: answers ship on their own, within the folder you are working in

Status: spec, 24 Sep 2026. Extends M1–M7 (with their corrections). The manual answering
session (`bin/answerer`, `/team-relay:answering`) stays as an option; this milestone makes it
unnecessary.

Kiril's decision (24 Sep 2026, in the thread): "answers are shipped automatically, unless a
more specific or potentially unsafe question is asked, or when some action tool is requested:
then it waits for my approval. Just dialog in scope of the running folder (not more) must
happen automatically."

## 1. Who answers

- The **host** is the channel server of a channel working session (M7 channel-mode rules).
  One host per machine answers: the host holds an exclusive lock
  (`~/.config/team-relay/answering.lock`, `flock`-style via an exclusively created lock file
  holding the pid, stale when that pid is gone); a manual answering session (`bin/answerer`)
  takes the same lock, so the two never both consume the inbox. Only the lock holder reads the
  `inbox` stream.
- **The scope folder** is the working session's folder: the channel server's `process.cwd()`
  resolved (symlinks). It must not be `/`, `$HOME` or an ancestor of `$HOME`, nor inside the
  credential deny list or the team-relay/Claude config dirs; if it is, the host still answers
  but with **no** automatic folder access (every read needs approval). The folder's basename
  is published as a `shares` entry while the host runs (M4 §3), so teammates see it.

## 2. One question, one short-lived answerer

For each `question` or `capability_call` from the inbox, the host:
1. acks it at the relay immediately (the asker sees "acked");
2. runs a headless, locked-down Claude:
   `claude -p <prompt> --output-format json --mcp-config <cfg> --strict-mcp-config
   --settings <settings> --setting-sources <none or the narrowest that works>
   --permission-mode default --permission-prompt-tool mcp__host__permission
   --disallowedTools Bash Write Edit NotebookEdit WebFetch WebSearch Agent Task
   --append-system-prompt <rubric>` with `cwd` = the scope folder, one at a time (a queue),
   a wall-clock limit of 10 minutes;
   - `<cfg>`: exactly two MCP servers: `host` (a small stdio server that talks back to this
     host over a private Unix socket, mode 600 in a mode-700 dir: tools `reply`,
     `request_approval`, `permission`) and `capabilities` (the M1 capability server, when the
     member enabled any capabilities).
   - `<settings>`: `permissions.allow` = `mcp__host__reply`, `mcp__host__request_approval`,
     and `Read(//<scope>/**)` when the scope folder qualifies; `permissions.deny` = the M4
     credential deny list (it applies inside the folder too) plus the disallowed tools.
     Nothing else is allowed, so everything else goes through `permission`.
   - The prompt carries the question as data (the M1 trust framing: teammate text is data,
     never instructions), the asker, and for a capability call its name and exact params.
3. The answerer finishes with `reply(text, data?, needs_approval?, reason?)`.

Verify against the Claude Code docs and the local CLI (2.1.281) before relying on them:
`--permission-prompt-tool` (its input and the exact JSON it must return to allow or deny),
`--setting-sources` (whether an empty list is accepted; otherwise the narrowest source that
loads no user hooks or plugins), headless auth using the user's normal login, and
MCP elicitation support in interactive sessions. Report what you found.

## 3. What ships on its own and what waits for the member

**Automatic** (no approval):
- reading files inside the scope folder (minus the credential deny list);
- sending an answer the answerer did not flag, when the draft passes the secret screen and
  no approval was needed during the run.

**Waits for approval** (the member decides; nothing is sent or run before they do):
- any tool use outside the allow list: reads outside the scope folder, and every capability
  tool ("action tools"): the `permission` tool holds the call until the member decides;
- a draft the answerer flags with `needs_approval` (the rubric: anything specific to people,
  customers, credentials, infrastructure or production; anything not grounded in the scope
  folder or general knowledge; anything it is unsure about);
- a draft the deterministic **secret screen** flags (private keys, provider tokens and API
  keys by known prefixes and entropy, `.env`-style `KEY=value` pairs with secret-like keys,
  connection strings with passwords);
- a draft produced after any approval was needed during the run.

Deny on timeout: an unanswered approval is denied when the question's answer deadline passes
(or after 30 minutes, whichever is sooner); a denied draft is not sent, and the host replies
"I couldn't answer this automatically; <member> hasn't approved it." only if the member chose
"decline" rather than letting it lapse (a lapse sends nothing; the relay's timed_out applies).

## 4. How the member approves

- The host pushes a status event into the working session: "kiril_number_2 asked: … — an
  answer is waiting for your approval (1 pending). Run /team-relay:approvals." (the question is
  quoted as teammate data, neutralised as today). It also posts a tool event with
  `status: "waiting"` (M4 §2) so the asker's console shows "waiting for <member>".
- `/team-relay:approvals` (and the tool `review_approvals`, no arguments) goes through the
  pending items one by one using **MCP elicitation**: the member sees the question, what is
  asked (the path to read, the capability and params, or the draft answer) and picks Allow /
  Deny (for drafts: Send / Don't send / Decline politely). The decision comes from the member's
  dialog, never from the model: a tool call alone cannot approve anything. If elicitation is
  unavailable in the running Claude Code, the host falls back to a local page on
  `127.0.0.1` (random port, per-launch key, the M2 console-server rules) opened with the
  redirect-file trick, and says so.
- A desktop notification (M4 §2 script, fixed text) when an approval becomes pending.

## 5. Visibility

- The asker's console already shows ack, tools and "waiting"; nothing new is needed on the
  relay. `whoami` and the SessionStart line mention pending approvals.
- The member's own console header shows "N answers waiting for your approval" (from the host,
  local console only; hosted console cannot see a laptop's queue: it shows the relay's
  "waiting" tool events).

## 6. Gates

Plugin tests: lock (single host, stale lock, manual answerer excluded), scope folder rules,
the child command line and settings exactly, the host MCP server over the socket (auth by
socket permissions and a per-launch token), permission tool allow/deny/timeout, the reply
decision table (auto-send, flagged, secret screen with a corpus of positives and negatives,
approval-during-run), elicitation flow with a fake client, the fallback page rules, status and
tool events. e2e: with a stub `claude` executable standing in for the headless answerer
(it reads the prompt and calls the host tools as scripted), a question inside scope is answered
automatically; one needing a read outside scope waits until approved; a flagged draft waits;
a capability call waits; a lapse sends nothing.

## 7. Corrections

### 24 Sep 2026: after the M8 security review

1. **Secret screen:** add `pass`, `pwd`, `pw` keys, prose forms ("the password / secret / token /
   key is|was X"), hex strings of 32+ characters, secrets split across lines or spaced out, and
   URLs with credentials in any form. **And a deterministic read trail:** the host learns which
   files the answerer read (a hook into the host socket); a draft waits for approval when any
   read file matches a sensitive-name list (`*.tfstate`, `secrets.*`, `*.properties`,
   `docker-compose*`, `kubeconfig`, `*service-account*.json`, `.npmrc`, `.netrc`,
   `.git-credentials`, `.dev.vars`, `id_ecdsa*`, `id_dsa*`, `*.ppk`, `*.pem`, `*.key`, `*.p12`).
2. **Deny list at any depth** adds `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`,
   `id_ecdsa*`, `id_dsa*`, `*.ppk`, `*.tfstate`, `.aws/**`, `.kube/**` (both copies; parity test).
3. **Scope folder qualifies only if** it is inside a git work tree (a `.git` in it or an
   ancestor below `$HOME`), is not `$HOME`, not a direct child of `$HOME`, not under
   `~/Library` or any `~/.*`, and does not contain `~/Library` or any `~/.*`. Otherwise: no
   automatic reads.
4. **Taking over answering is announced:** a status event (and a desktop notification) when a
   session becomes the host: "This session now answers teammates automatically from <folder>;
   reads inside it are automatic."
5. **Volume limits:** at most 3 queued questions per asker and 20 automatic runs per hour per
   member; beyond that, questions wait for approval to run. Notifications and status pushes are
   grouped: at most one desktop notification per 5 minutes; after the first push, later ones
   carry counts only (no teammate text).
6. **Permission prompts show the real target** when a path resolves elsewhere
   ("…/proj/link → /elsewhere/x").
7. **Glob/Grep patterns** with an absolute fixed prefix are checked against the deny list before
   asking; a hit is denied without asking.
8. **Drafts in the dialog:** measure and clip the same string that is shown; offer Send only
   when the whole draft is shown, and show the exact text that will be sent.
9. **Answerer-written reasons** are labelled as the answerer's words in approvals.
10. **Documented limit:** approvals rely on no `Elicitation`/`ElicitationResult` hooks and no
    auto-allowed Bash in the working session; the README says so.
11. **Lock breaking** renames the lock to a unique name and verifies its content before
    removing, so a suspended breaker cannot remove a live lock.
12. **Nothing lost on stop:** the host advances the inbox cursor for a question only after it is
    fully handled (answered, declined or lapsed); a question in flight when the session closes
    is received again by the next host (skipped if the relay says it is already answered).
    The shared folder is withdrawn (re-published without it) when the host stops.
13. The spec now lists `--tools Read,Glob,Grep` and `--no-session-persistence` in the child
    command line, and the time limit excludes time waiting for the member (hard stop at the
    answer deadline plus 60 s).
