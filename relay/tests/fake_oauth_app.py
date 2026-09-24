"""Serve the relay with a fake Google sign-in, for end-to-end tests (M5-SPEC §8).

    cd relay && RELAY_TEAM_CONFIG=/path/team.yaml .venv/bin/python -m tests.fake_oauth_app \\
        [--port 8090] [--email alice@example.com]

- Binds 127.0.0.1 only; refuses to start on Cloud Run (``K_SERVICE`` set).
- ``RELAY_PUBLIC_URL`` is ``http://127.0.0.1:<port>``; the team file's ``token:sha256:``
  principals work as in ``RELAY_AUTH_MODE=static`` (the only mode here).
- Store: the Firestore emulator when ``FIRESTORE_EMULATOR_HOST`` is set (project
  ``GOOGLE_CLOUD_PROJECT``, default ``demo-relay``), otherwise an in-process MemoryStore.
- Google: ``GET /v1/login/start`` redirects the browser to ``/__fake_google/authorize`` on this
  same server, which approves at once and redirects to ``/v1/login/callback`` with a code. The
  account is ``?email=`` on that authorize URL when present, else ``--email`` /
  ``FAKE_OAUTH_EMAIL``; with neither the authorize page answers 400. ``?email_verified=false``
  signs in an unverified account. The token exchange and the ID token's signature and claims
  then run the relay's production code against an in-process fake (``tests.fake_google``).

A headless client drives the whole login with plain HTTP (no redirects followed for it):
GET start (keep the ``trl`` cookie from ``Set-Cookie``) → GET the ``Location`` (the fake
authorize URL, optionally with ``&email=``) → GET its ``Location`` (the relay's callback) with
``Cookie: trl=…`` → read the chooser's hidden ``csrf`` input and a ``team`` radio value → POST
``/v1/login/choose`` (``application/x-www-form-urlencoded``: ``csrf``, ``team``,
``action=continue``) with the cookie → the ``303`` ``Location`` is
``http://127.0.0.1:<port>/callback?code=…&state=…``.

Google ID tokens (M9-SPEC §2, §4, §5: ``/v1/me/teams``, ``POST /v1/teams``, the admin routes
and delegates need a Google identity): ``GET /__fake_google/id_token?email=<email>`` answers
``{"id_token": "..."}``, signed by the fake's key, for that verified email (its ``sub`` is the
one the login flow gives the same email, so both are the same account). The relay accepts such
a token as a Google ID token; a delegate's is one for its service account's email (the team
file's ``delegates`` principal). Any other bearer token is a static one, as before.

This module lives under ``tests/`` and is not in the image: nothing in production can reach it.
"""

from __future__ import annotations

import argparse
import os
import sys
from urllib.parse import urlencode

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response

from relay.app import create_app
from relay.auth import JWT_SHAPE, StaticVerifier, Unauthenticated, Verified
from relay.config import (
    Settings,
    load_schema,
    load_team_config,
    normalise_email,
)
from relay.config import (
    default_schema_path as _default_schema,
)
from relay.errors import ConfigError
from relay.log import log_event
from relay.oauth import OAuthError
from relay.store import Store
from relay.store_memory import MemoryStore

from .fake_google import FakeGoogle, FakeGoogleProvider, Grant

AUTHORIZE_PATH = "/__fake_google/authorize"
ID_TOKEN_PATH = "/__fake_google/id_token"


class FakeIdTokenVerifier:
    """A JWT-shaped bearer token is a Google ID token signed by the fake (verified by the
    relay's own ID token code: signature, issuer, audience, expiry) with a verified email;
    anything else is a static token."""

    def __init__(self, provider: FakeGoogleProvider) -> None:
        self._provider = provider
        self._static = StaticVerifier()

    async def principal(self, token: str) -> str:
        return (await self.verify(token)).principal

    async def verify(self, token: str) -> Verified:
        if JWT_SHAPE.fullmatch(token or "") is None:
            return await self._static.verify(token)
        try:
            claims = await self._provider.verify_id_token(token)
        except OAuthError as exc:
            raise Unauthenticated(exc.reason) from None
        email = normalise_email(claims.get("email"))
        sub = claims.get("sub")
        if email is None or claims.get("email_verified") is not True or not isinstance(sub, str):
            raise Unauthenticated("fake_id_token_claims")
        return Verified("google:" + email, sub)


def build_app(team_config: str, port: int, default_email: str | None) -> FastAPI:
    if os.environ.get("K_SERVICE"):
        raise ConfigError("the fake OAuth relay never runs on Cloud Run (K_SERVICE is set)")
    public_url = f"http://127.0.0.1:{port}"
    settings = Settings(
        team_config=load_team_config(team_config),
        manifest_schema=load_schema(os.environ.get("RELAY_MANIFEST_SCHEMA") or _default_schema()),
        auth_mode="static",
        public_url=public_url,
    )
    store: Store
    if os.environ.get("FIRESTORE_EMULATOR_HOST"):
        from relay.store_firestore import FirestoreStore

        store = FirestoreStore(project=os.environ.get("GOOGLE_CLOUD_PROJECT") or "demo-relay")
    else:
        store = MemoryStore()
    fake = FakeGoogle()
    provider = FakeGoogleProvider(fake, authorize_url=public_url + AUTHORIZE_PATH)
    app = create_app(settings, store, oauth=provider, verifier=FakeIdTokenVerifier(provider))
    callback = public_url + "/v1/login/callback"

    @app.get(ID_TOKEN_PATH)
    async def fake_id_token(request: Request) -> Response:
        email = normalise_email(request.query_params.get("email"))
        if email is None:
            return JSONResponse({"error": "no_email", "detail": "Pass ?email=."}, 400)
        grant = Grant(email=email, nonce="", code_challenge="", redirect_uri="")
        claims = fake.id_token_claims(grant)
        claims.pop("nonce")
        return JSONResponse({"id_token": fake.sign(claims)})

    @app.get(AUTHORIZE_PATH)
    async def fake_authorize(request: Request) -> Response:
        q = request.query_params
        params = {name: q.get(name) or "" for name in ("redirect_uri", "state", "nonce")}
        params["code_challenge"] = q.get("code_challenge") or ""
        if params["redirect_uri"] != callback or q.get("client_id") != fake.client_id:
            return JSONResponse({"error": "invalid_request"}, 400)
        email = normalise_email(q.get("email") or default_email)
        if email is None:
            return JSONResponse({"error": "no_email", "detail": "Pass ?email= or --email."}, 400)
        verified = q.get("email_verified", "true") != "false"
        code = fake.authorize(params, email, email_verified=verified)
        location = f"{callback}?{urlencode({'code': code, 'state': params['state']})}"
        return RedirectResponse(location, status_code=302)

    app.state.fake_google = fake
    return app


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m tests.fake_oauth_app")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8090")))
    parser.add_argument("--email", default=os.environ.get("FAKE_OAUTH_EMAIL") or None)
    args = parser.parse_args(argv)
    config = os.environ.get("RELAY_TEAM_CONFIG")
    if not config:
        sys.exit("RELAY_TEAM_CONFIG is required")
    if not 1024 <= args.port <= 65535:
        sys.exit("--port must be within 1024..65535")
    try:
        app = build_app(config, args.port, args.email)
    except ConfigError as exc:
        sys.exit(f"cannot start: {exc}")
    log_event("fake_oauth_relay", url=f"http://127.0.0.1:{args.port}")
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=args.port,
        server_header=False,
        timeout_keep_alive=30,
        log_level=os.environ.get("RELAY_LOG_LEVEL", "warning"),
    )


if __name__ == "__main__":
    main()
