# Milestone 7: say when questions are waiting

Status: spec, 24 Sep 2026. Extends M1–M6 (with their corrections).

Kiril's report (24 Sep 2026): a question sent to him while his answering session was not
running waited, correctly, in his inbox, but nothing told him. Delivery is durable already
(the inbox keeps it until an answering session acks it); what is missing is visibility.

## 1. Relay

- `GET /v1/teams/{team}/inbox/summary` (a member for themself; a delegate on behalf of its
  member): `{"pending": n, "oldest_at": "…"|null, "from": ["alice", …], "answering":
  {"last_seen": …|null}}`. `pending` counts unexpired messages after the member's `inbox`
  cursor (read at most 50; `pending` is then "50+" as the integer 50 plus
  `"more": true`). `from` is the distinct senders, at most 5. Never writes presence, never
  moves a cursor, counts against the read budget.
- The directory entry for each member gains `inbox_waiting` (the same count, at most 50),
  cached with the directory stats (10 s). Team-wide metadata, like presence.

## 2. Plugin

- The asker channel (a channel session) checks the summary at connect, right after a
  sign-in, and every 60 s. When `pending > 0` and the member's answering session is not
  online (its `last_seen` older than 45 s or null), it pushes one status event: "<n>
  question(s) from <names> waiting for you. Start your answering session: <command>"
  (the command `/team-relay:answering` prints). It repeats only when the count or senders
  change, or once an hour while it stays unchanged. Nothing when the answering session is
  online.
- `whoami` includes `inbox_waiting` and the same sentence. The SessionStart line includes it
  (a quick summary call with a 3 s budget; silence on failure).
- `login_wait`'s success message appends the sentence when questions are waiting.

## 3. Console

- Agent cards show "<n> waiting" (amber) when `inbox_waiting > 0` and the answering session
  is not online. The viewer's own count shows in the header ("2 questions waiting for you"),
  from `/api/me` plus the summary (add `GET /api/inbox/summary` to the console server's
  read-only proxy, hosted and local).

## 4. Gates

Relay tests on both stores (counts, expired messages skipped, the 50 cap, no presence write,
delegate path, directory field and cache); plugin tests (notice rules: shown, suppressed when
answering online, repeated only on change or hourly, login_wait sentence, whoami, SessionStart);
console tests (card badge, header line); e2e: a question to a member without an answering
session produces the notice in their channel working session and is then delivered once when
the answering session starts.
