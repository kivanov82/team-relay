# Milestone 3: the hosted console

Status: spec, 24 Sep 2026. Extends `M1-SPEC.md` and `M2-SPEC.md` (with their corrections).

Kiril's decision (24 Sep 2026, in the thread): host the console at one URL the three members
open in a browser, behind Google sign-in, instead of (in addition to) the local
`bin/console`.

## 1. Shape

```
browser ──IAP (Google sign-in, the 3 members)──▶ Cloud Run team-relay-console
                                                          │ verifies the IAP JWT → viewer email
                                                          │ own SA ID token (metadata server)
                                                          │ + X-Relay-On-Behalf-Of: <viewer email>
                                                          ▼
                                              Cloud Run team-relay (Cloud Run IAM + app allowlist)
```

- Service `team-relay-console`, `europe-west3`, `--no-allow-unauthenticated --iap`, runtime
  SA `team-relay-console` (no project roles beyond log writing; `roles/run.invoker` on the
  `team-relay` service only). Users: `roles/iap.httpsResourceAccessor` on the console
  service for the three members, nobody else. The IAP service agent gets `run.invoker` on the
  console service. IAP uses a custom OAuth client (the members are outside the project's
  organisation), configured on this service only, never project-wide.
- Read-only, exactly as the local console: the four GETs, nothing that sends, acks or replies.

## 2. Relay: read-only delegates

- Team config gains a top-level `delegates:` list:
  ```yaml
  delegates:
    - principal: "google:team-relay-console@<project>.iam.gserviceaccount.com"
      team: <team id>
      scope: read
  ```
  A delegate principal may not also be a member principal (startup error). `scope` has one
  value, `read`.
- A request authenticated as a delegate must carry `X-Relay-On-Behalf-Of: <email>`; the relay
  resolves `google:<email lowercased>` to a member of the delegate's team (else `401`,
  logged). The caller is then that member for every rule (masking, visibility, read budget).
- Delegates may call only `GET` `/v1/teams/{team}/me`, `/directory`, `/activity` and
  `/requests/{id}`. Anything else, including stream reads (which would move presence and
  cursors) and every mutation: `403 forbidden`, logged. A member principal that sends
  `X-Relay-On-Behalf-Of` gets `400` (the header is only meaningful for delegates).
- Structured logs of delegated reads carry `delegate=<principal>` and `member=<id>`; no
  audit entry (reads are not audited).

## 3. The hosted console server

`plugin/src/console-server.ts` gains a hosted mode (`CONSOLE_MODE=hosted`), used only by the
container:
- Listens on `0.0.0.0:$PORT`. No console key (IAP is the gate); the `Host` check becomes an
  exact match on `CONSOLE_PUBLIC_HOST` (the service's run.app host).
- Every request, static files included, must carry `x-goog-iap-jwt-assertion`, verified with
  Google's IAP public keys (`https://www.gstatic.com/iap/verify/public_key-jwk`, cached per
  Cache-Control, ES256 only), issuer `https://cloud.google.com/iap`, audience `IAP_AUDIENCE`
  (the Cloud Run IAP audience for this service; verify the exact format in Google's
  "signed headers" documentation), `exp`/`iat` with at most 30 s skew, and an `email` claim.
  Anything else: `401` with no detail. The email is lower-cased and sent as
  `X-Relay-On-Behalf-Of`.
- Relay credentials: `RELAY_AUTH=metadata` fetches an ID token for audience `RELAY_URL` from
  the metadata server (`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=…&format=full`,
  header `Metadata-Flavor: Google`), cached until 5 min before `exp`, refreshed once on 401.
- Same strict CSP, no CORS, the same four proxied GETs, `GET /healthz`-style probe not needed
  (Cloud Run starts on the port).
- Container: `console/Dockerfile` or `plugin/Dockerfile.console`, `node:22-slim` pinned by the
  digest, non-root, copies only `plugin/dist/console-server.js`
  and `plugin/dist/console/`, no npm install at runtime.

## 4. The console UI

- No key in the URL is valid in hosted mode: the UI calls `/api/*` without `X-Console-Key`.
  A `401`/`403` from the console server shows the existing "missing or refused key" screen
  locally, and a "Your session has expired, reload to sign in again" screen when the response
  is not JSON (IAP redirects an expired session to Google).
- The header shows the viewer (from `/api/me`) as today.

## 5. Gates

- Relay: delegate tests on both stores (allowed GETs, forbidden everything else, header rules,
  masking as the viewer, read budget counted against the viewer, config validation);
  `scripts/test-relay.sh` green, ruff clean.
- Plugin: hosted-mode tests with a locally generated ES256 key set standing in for Google's
  (valid, wrong audience, wrong issuer, expired, missing email, missing header, wrong alg),
  metadata-token fetch against a fake metadata server, Host rule, no key needed; existing
  local-mode behaviour unchanged. Typecheck, tests, build, generate --check, `scripts/e2e.sh`.
- Console: tests for the keyless path and the expired-session screen; build.
- Deploy: unauthenticated request to the console URL is redirected to Google sign-in (not
  served); the operator cannot read through the console; after Kiril's OAuth client is set,
  a member sees their team.
