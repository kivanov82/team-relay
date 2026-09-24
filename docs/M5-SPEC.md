# Milestone 5: install, pick your team, sign in, done

Status: spec, 24 Sep 2026. Extends M1–M4 (with their corrections). Where this contradicts an
earlier milestone, this wins.

Kiril's decision (24 Sep 2026, in the thread): joining must be "install the plugin, choose a
team from a list, sign in with Google, done". No clone, no gcloud, no install questions.

## 1. The member's experience

1. `/plugin marketplace add kivanov82/team-relay` then `/plugin install team-relay@team-relay-dev`.
   No `userConfig` questions.
2. `/team-relay:login` (the SessionStart line suggests it while not connected). The browser
   opens on the relay; the member signs in with Google, sees the teams their account belongs
   to (one: preselected), confirms. The browser says "Connected. You can close this tab."
3. The plugin stores its own credential and connects. The answering session
   (`/team-relay:answering` prints the one command to start it) and the local console reuse the
   same credential.

## 2. The login flow (loopback + PKCE, RFC 8252 style)

No device codes (they can be phished): the one-time code only ever travels to a listener on
the member's own machine, and is useless without the PKCE verifier held by the plugin.

1. **Plugin** (tool `login`, asker channel): generate `code_verifier` (43–128 chars) and
   `code_challenge = BASE64URL(SHA256(verifier))`, a random `state` (32 bytes), start an HTTP
   listener on `127.0.0.1:0` (path `/callback`, 5 min lifetime, one request), open the browser
   (`open` / `xdg-open`, the URL never in a process argument: same redirect-file trick as
   M2 §7.7) at
   `{relay}/v1/login/start?port=<p>&state=<s>&code_challenge=<c>&code_challenge_method=S256&device=<label>`
   (`device`: `^[A-Za-z0-9 ._()-]{1,64}$`, e.g. "Claude Code on <hostname>"). Also returns the
   URL in the tool result in case no browser opens.
2. **Relay `GET /v1/login/start`** (no auth; per-IP rate limit 20/min): validates params
   (port 1024–65535; state/challenge shapes), creates a login document
   (`logins/{id}`: challenge, port, state, device, expire_at now+10 min, step `google`), sets
   cookie `trl=<id>` (`HttpOnly; Secure; SameSite=Lax; Path=/v1/login; Max-Age=600`), and
   redirects to Google's authorization endpoint with `client_id`, `redirect_uri =
   {relay}/v1/login/callback`, `response_type=code`, `scope=openid email`, `state=<id>`,
   `nonce` (stored), and its own PKCE (S256, verifier stored), `prompt=select_account`.
3. **Relay `GET /v1/login/callback`**: `state` must equal the cookie's login id and be at step
   `google` and unexpired; exchange the code at Google's token endpoint (client secret from
   Secret Manager); verify the `id_token` (Google JWKS, `iss` accounts.google.com,
   `aud == client_id`, `nonce`, `email_verified is True`); find every team where
   `google:<email>` is a member principal. None: an error page ("This Google account is not on
   any team. Ask the team owner to add <email>.") and the login is closed. Otherwise step
   `choose`, and render the chooser.
4. **Chooser page** (server-rendered, strict CSP, a small same-origin stylesheet, no scripts):
   the account email, the device label and the warning "Only continue if you just ran
   /team-relay:login in your own Claude Code", one radio per team (team id, your member id),
   preselected when there is one, and Continue / Cancel. Form `POST /v1/login/choose` with the
   login's CSRF token (random, stored, compared in constant time) and the cookie.
5. **Relay `POST /v1/login/choose`**: CSRF, cookie, step `choose`, team is one of the
   account's teams → mint a one-time authorization code (32 bytes; stored hashed with team,
   member, expire_at now+2 min; step `done`), clear the cookie, and `303` redirect to
   `http://127.0.0.1:<port>/callback?code=<code>&state=<state>`. Nothing but `127.0.0.1` is
   ever a redirect target.
6. **Plugin listener**: `state` must match (constant time); answers the browser with a small
   "Connected, you can close this tab" page; then `POST {relay}/v1/login/token`
   `{"code", "code_verifier"}`.
7. **Relay `POST /v1/login/token`** (no auth; rate limited): code unused, unexpired, and
   `BASE64URL(SHA256(verifier)) == challenge` → mark used, create a device credential and
   return `{"credential": "trc_<43 base64url chars>", "team", "member", "relay_url",
   "expires_at"}`. Wrong or reused: `400 invalid_grant` (a reused code also revokes the
   credential it minted, if any).

## 3. Device credentials

- Stored hashed: `teams/{team}/credentials/{sha256}`: member, device label, created_at,
  last_used_at (written at most every 10 min), expire_at (90 days after last use, rolling;
  the TTL policy covers it), revoked.
- `Authorization: Bearer trc_…` authenticates as that member of that team (the URL team must
  match, else `404`). Cached in-process for at most 60 s, so revocation lands within a minute.
- A member removed from the team config: their credentials stop working immediately (the
  member lookup fails), even before expiry.
- `DELETE /v1/teams/{team}/credentials/self` revokes the calling credential (logout).
  `GET /v1/teams/{team}/credentials` lists the caller's own devices (label, created, last
  used); `DELETE /v1/teams/{team}/credentials/{id}` revokes one of the caller's own
  (id = the first 16 hex of the hash).
- Google ID tokens and delegates keep working unchanged (the hosted console, and gcloud users).

## 4. Teams and identities

- A Google principal may now be a member of several teams (one member id per team). The URL's
  team decides which membership applies; a principal without a membership in that team gets
  `404`. Member ids are unique within a team (no longer across teams).

## 5. Deployment changes

- The relay is deployed `--allow-unauthenticated`: the browser must reach the login pages
  before anyone is signed in. Every other endpoint authenticates in the app as before
  (credential, Google ID token, or delegate). `scripts/smoke.sh`: unauthenticated API call is
  the app's `401`; `/v1/login/start` without params is `400`.
- OAuth client for the relay's login: the existing Web client (Kiril adds the redirect URI
  `{relay}/v1/login/callback`). Its id and secret live in a new secret
  `team-relay-oauth-client` (JSON), mounted into the relay; nothing in the repository.
  Google endpoints are fixed in code; tests inject a fake OAuth provider through the app
  factory, never through production configuration.

## 6. The plugin

- `plugin.json` has no required `userConfig`; the relay URL defaults to the deployed relay
  (in the plugin, public) and can be overridden by `/team-relay:login <relay-url>`.
- Credential file: `~/.config/team-relay/credentials.json` (dir 700, file 600, atomic
  writes): `{relay_url, team, member, credential, expires_at}`. `RELAY_AUTH` default becomes:
  the credential file if present, else `google` (gcloud) as today. The answering session's
  read deny list adds `~/.config/team-relay/**`.
- Tools (asker channel): `login({relay_url?})`, `logout()`, `whoami()`. Commands:
  `commands/login.md` (`/team-relay:login`), `commands/answering.md`
  (`/team-relay:answering`: prints the command to start the answering session, with
  `${CLAUDE_PLUGIN_ROOT}`), `commands/console.md` (`/team-relay:console`).
- The channel's stream loop waits quietly for a credential when none exists and starts as
  soon as `login` stores one (no restart needed).
- The capability `userConfig` questions move out of the install: capabilities are enabled
  where they run, in the answering session's environment (as `bin/answerer` already reads
  them). The manifest still drives the capability enum and the discovery payload.

## 7. The console

The join panel becomes the three steps of §1, with copy buttons; nothing else changes.

## 8. Gates

- Relay: the whole flow against a fake OAuth provider (valid; state/cookie mismatch; replayed
  Google code; bad nonce; unverified email; not on any team; CSRF missing/wrong; choose a team
  you are not in; code reuse revokes; wrong verifier; expired login, code, credential;
  redirect target only 127.0.0.1; rate limits); credentials (auth, 60 s cache, revoke, list,
  rolling expiry, removed member); multi-team principals; both stores;
  `scripts/test-relay.sh`.
- Plugin: login tool against a fake relay (browser opener stubbed; listener only 127.0.0.1;
  state mismatch refused; one request; timeout), credential file modes and atomicity, the auth
  default, stream loop waiting for a credential, commands, no userConfig questions;
  `scripts/e2e.sh` adds the full login flow with the fake OAuth provider.
- Console: join panel; build.
- Deploy: smoke checks above; Kiril signs in once for real.
