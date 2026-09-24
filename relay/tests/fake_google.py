"""A stand-in for Google's sign-in (M5-SPEC §5: tests inject a fake provider through the app
factory, never through the environment).

:class:`FakeGoogle` holds a throwaway RSA key and answers, in-process, the two URLs the
relay's :class:`~relay.oauth.GoogleOAuthProvider` calls: the token endpoint (checking the
client, the redirect URI and the PKCE verifier, and refusing a code used twice, as Google
does) and the JWKS. :class:`FakeGoogleProvider` is the real provider with that transport and
an authorization URL pointing at a fake consent page, so everything the relay does with
Google's answer (the exchange, the RS256 signature, iss/aud/azp/exp/iat, then nonce and
email_verified in the login) runs the production code.

Synthetic identities only; nothing here reaches the network.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlencode

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from relay.config import OAuthClient
from relay.oauth import (
    GOOGLE_JWKS_URL,
    GOOGLE_TOKEN_ENDPOINT,
    GoogleOAuthProvider,
    HttpResponse,
)

CLIENT_ID = "123456789012-fake.apps.googleusercontent.com"
CLIENT_SECRET = "fake-client-secret-not-a-real-one"
FAKE_AUTHORIZE_URL = "https://accounts.fake.example/o/oauth2/v2/auth"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _uint(value: int) -> str:
    return b64url(value.to_bytes((value.bit_length() + 7) // 8, "big"))


@dataclass
class Grant:
    """One consent: what Google would put in the ID token for this code."""

    email: str
    nonce: str
    code_challenge: str
    redirect_uri: str
    email_verified: Any = True
    used: bool = False
    # Test hooks: claims to override or drop, and a header to override, in the ID token.
    claims: dict[str, Any] = field(default_factory=dict)
    drop: tuple[str, ...] = ()
    header: dict[str, Any] = field(default_factory=dict)


class FakeGoogle:
    def __init__(
        self,
        clock: Callable[[], float] = time.time,
        client_id: str = CLIENT_ID,
        client_secret: str = CLIENT_SECRET,
    ) -> None:
        self.clock = clock
        self.client_id = client_id
        self.client_secret = client_secret
        self.kid = "fake-kid-" + secrets.token_hex(4)
        self._key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.grants: dict[str, Grant] = {}
        self.token_calls = 0
        self.jwks_calls = 0
        self.jwks_status = 200

    # The consent page -------------------------------------------------------------------------
    def authorize(self, params: Mapping[str, str], email: str, **grant: Any) -> str:
        """Approve the request an authorization URL carried (its query ``params``) as
        ``email``; return the code Google would send back."""
        code = "4/" + b64url(secrets.token_bytes(24))
        self.grants[code] = Grant(
            email=email,
            nonce=params["nonce"],
            code_challenge=params["code_challenge"],
            redirect_uri=params["redirect_uri"],
            **grant,
        )
        return code

    # Signing ----------------------------------------------------------------------------------
    def jwks(self) -> dict[str, Any]:
        numbers = self._key.public_key().public_numbers()
        return {
            "keys": [
                {
                    "kty": "RSA",
                    "alg": "RS256",
                    "use": "sig",
                    "kid": self.kid,
                    "n": _uint(numbers.n),
                    "e": _uint(numbers.e),
                }
            ]
        }

    def sign(
        self,
        claims: Mapping[str, Any],
        header: Mapping[str, Any] | None = None,
        key: rsa.RSAPrivateKey | None = None,
    ) -> str:
        head = {"alg": "RS256", "kid": self.kid, "typ": "JWT", **(header or {})}
        signing_input = (
            b64url(json.dumps(head).encode()) + "." + b64url(json.dumps(dict(claims)).encode())
        )
        signature = (key or self._key).sign(
            signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256()
        )
        return signing_input + "." + b64url(signature)

    def id_token_claims(self, grant: Grant) -> dict[str, Any]:
        now = int(self.clock())
        claims: dict[str, Any] = {
            "iss": "https://accounts.google.com",
            "azp": self.client_id,
            "aud": self.client_id,
            "sub": hashlib.sha256(grant.email.encode()).hexdigest()[:21],
            "email": grant.email,
            "email_verified": grant.email_verified,
            "nonce": grant.nonce,
            "iat": now,
            "exp": now + 3600,
        }
        claims.update(grant.claims)
        for name in grant.drop:
            claims.pop(name, None)
        return claims

    # The HTTP transport the provider uses ------------------------------------------------------
    def transport(
        self, method: str, url: str, headers: Mapping[str, str], body: bytes | None
    ) -> HttpResponse:
        if method == "GET" and url == GOOGLE_JWKS_URL:
            self.jwks_calls += 1
            return HttpResponse(
                self.jwks_status,
                {"cache-control": "public, max-age=3600"},
                json.dumps(self.jwks()).encode(),
            )
        if method == "POST" and url == GOOGLE_TOKEN_ENDPOINT:
            self.token_calls += 1
            return self._token(body or b"")
        return HttpResponse(404, {}, b"{}")

    def _token(self, body: bytes) -> HttpResponse:
        form = {k: v[0] for k, v in parse_qs(body.decode("ascii")).items() if len(v) == 1}

        def error(code: str) -> HttpResponse:
            return HttpResponse(400, {}, json.dumps({"error": code}).encode())

        if form.get("grant_type") != "authorization_code":
            return error("unsupported_grant_type")
        if (form.get("client_id"), form.get("client_secret")) != (
            self.client_id,
            self.client_secret,
        ):
            return error("invalid_client")
        grant = self.grants.get(form.get("code", ""))
        if grant is None or grant.used:
            return error("invalid_grant")  # Google refuses a code used twice
        grant.used = True
        if form.get("redirect_uri") != grant.redirect_uri:
            return error("redirect_uri_mismatch")
        verifier = form.get("code_verifier", "")
        if b64url(hashlib.sha256(verifier.encode()).digest()) != grant.code_challenge:
            return error("invalid_grant")
        id_token = self.sign(self.id_token_claims(grant), grant.header)
        return HttpResponse(
            200,
            {"content-type": "application/json"},
            json.dumps(
                {"id_token": id_token, "access_token": "unused", "token_type": "Bearer"}
            ).encode(),
        )


class FakeGoogleProvider(GoogleOAuthProvider):
    """The production provider with the fake's transport, sending the browser to
    ``authorize_url`` instead of Google's consent page."""

    def __init__(self, fake: FakeGoogle, authorize_url: str = FAKE_AUTHORIZE_URL) -> None:
        super().__init__(
            OAuthClient(client_id=fake.client_id, client_secret=fake.client_secret),
            transport=fake.transport,
            clock=fake.clock,
        )
        self.authorization_endpoint = authorize_url


def authorization_params(location: str) -> dict[str, str]:
    """The query of an authorization URL, one value per name (asserted)."""
    query = location.split("?", 1)[1]
    params = parse_qs(query, keep_blank_values=True)
    assert all(len(v) == 1 for v in params.values()), params
    return {k: v[0] for k, v in params.items()}


def callback_query(code: str, state: str) -> str:
    return urlencode({"code": code, "state": state})
