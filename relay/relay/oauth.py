"""The relay's own Google sign-in (M5-SPEC §2 steps 2–3, §5).

:class:`GoogleOAuthProvider` builds the authorization URL (authorization code, the relay's
own PKCE S256 and a nonce, ``scope=openid email``, ``prompt=select_account``), exchanges a
code at Google's token endpoint with the client secret and the PKCE verifier, and verifies
the ID token it gets back: RS256 against Google's JWKS (cached for its Cache-Control
lifetime), ``iss`` Google, ``aud`` (and ``azp`` when present) the client id, ``exp`` in the
future, ``iat`` not in the future. The nonce and ``email_verified`` are the login's to check
(:mod:`relay.login`).

Google's endpoints are fixed here. Tests inject a provider object through
``create_app(..., oauth=...)``: a subclass whose ``authorization_url`` points at a fake and
whose HTTP transport answers the token and JWKS URLs in-process. Nothing in the
environment can point the relay at another identity provider.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlencode

import anyio.to_thread
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from .auth import CERTS_MIN_REFRESH, GOOGLE_ISSUERS, certs_lifetime
from .config import OAuthClient

GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"

HTTP_TIMEOUT = 10
MAX_RESPONSE_BYTES = 256 * 1024
MAX_ID_TOKEN_LENGTH = 4096
# Google's clock and ours: an ID token issued "in the future" by up to this much is fine.
IAT_SKEW_SECONDS = 60
JWT_SHAPE = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")


class OAuthError(Exception):
    """Sign-in with Google did not work. ``reason`` is a short code for the stdout log."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


# A blocking HTTP call: (method, url, headers, body) -> response. Runs in a worker thread.
Transport = Callable[[str, str, Mapping[str, str], bytes | None], HttpResponse]


def requests_transport(
    method: str, url: str, headers: Mapping[str, str], body: bytes | None
) -> HttpResponse:
    import requests

    with requests.request(
        method,
        url,
        headers=dict(headers),
        data=body,
        timeout=HTTP_TIMEOUT,
        allow_redirects=False,
        stream=True,
    ) as response:
        data = bytearray()
        for chunk in response.iter_content(16384):
            data.extend(chunk)
            if len(data) > MAX_RESPONSE_BYTES:
                raise OAuthError("response_too_large")
        return HttpResponse(
            status=response.status_code,
            headers={k.lower(): v for k, v in response.headers.items()},
            body=bytes(data),
        )


class OAuthProvider(Protocol):
    client_id: str

    def authorization_url(
        self, *, redirect_uri: str, state: str, nonce: str, code_challenge: str
    ) -> str: ...

    async def exchange(self, *, code: str, redirect_uri: str, code_verifier: str) -> str:
        """The ID token for ``code``, or :class:`OAuthError`."""
        ...

    async def verify_id_token(self, id_token: str) -> Mapping[str, Any]:
        """The verified claims, or :class:`OAuthError`."""
        ...


def _b64decode(segment: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
    except (binascii.Error, ValueError):
        raise OAuthError("malformed_id_token") from None


def _b64int(value: Any) -> int:
    if not isinstance(value, str) or not value:
        raise ValueError("not a base64url integer")
    return int.from_bytes(_b64decode(value), "big")


@dataclass
class _Keys:
    keys: dict[str, rsa.RSAPublicKey]
    fetched_at: float
    expires_at: float


class GoogleOAuthProvider:
    authorization_endpoint = GOOGLE_AUTHORIZATION_ENDPOINT
    token_endpoint = GOOGLE_TOKEN_ENDPOINT
    jwks_url = GOOGLE_JWKS_URL

    def __init__(
        self,
        client: OAuthClient,
        *,
        transport: Transport = requests_transport,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.client_id = client.client_id
        self._secret = client.client_secret
        self._transport = transport
        self._clock = clock
        self._keys: _Keys | None = None
        self._keys_lock = asyncio.Lock()

    def authorization_url(
        self, *, redirect_uri: str, state: str, nonce: str, code_challenge: str
    ) -> str:
        query = urlencode(
            {
                "client_id": self.client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": "openid email",
                "state": state,
                "nonce": nonce,
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
                "prompt": "select_account",
            }
        )
        return f"{self.authorization_endpoint}?{query}"

    async def _call(
        self, method: str, url: str, headers: Mapping[str, str], body: bytes | None
    ) -> HttpResponse:
        try:
            return await anyio.to_thread.run_sync(self._transport, method, url, headers, body)
        except OAuthError:
            raise
        except Exception:  # the transport's own errors, whatever their class; never echoed
            raise OAuthError("google_unreachable") from None

    # Token exchange ---------------------------------------------------------------------------
    async def exchange(self, *, code: str, redirect_uri: str, code_verifier: str) -> str:
        body = urlencode(
            {
                "grant_type": "authorization_code",
                "code": code,
                "client_id": self.client_id,
                "client_secret": self._secret,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            }
        ).encode("ascii")
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        }
        response = await self._call("POST", self.token_endpoint, headers, body)
        if response.status != 200:
            raise OAuthError(f"token_status_{response.status}")
        try:
            data = json.loads(response.body)
        except ValueError:
            raise OAuthError("token_not_json") from None
        id_token = data.get("id_token") if isinstance(data, dict) else None
        if not isinstance(id_token, str) or not id_token:
            raise OAuthError("no_id_token")
        return id_token

    # ID token ---------------------------------------------------------------------------------
    async def _fetch_keys(self) -> _Keys:
        response = await self._call("GET", self.jwks_url, {"Accept": "application/json"}, None)
        if response.status != 200 or len(response.body) > MAX_RESPONSE_BYTES:
            raise OAuthError("jwks_unavailable")
        try:
            data = json.loads(response.body)
            entries = data["keys"]
            if not isinstance(entries, list):
                raise ValueError("keys is not a list")
            keys: dict[str, rsa.RSAPublicKey] = {}
            for jwk in entries:
                if not isinstance(jwk, dict) or jwk.get("kty") != "RSA":
                    continue
                if jwk.get("use", "sig") != "sig" or jwk.get("alg", "RS256") != "RS256":
                    continue
                kid = jwk.get("kid")
                if not isinstance(kid, str) or not kid:
                    continue
                numbers = rsa.RSAPublicNumbers(_b64int(jwk.get("e")), _b64int(jwk.get("n")))
                keys[kid] = numbers.public_key()
        except (ValueError, KeyError, TypeError, OAuthError):
            raise OAuthError("jwks_invalid") from None
        if not keys:
            raise OAuthError("jwks_invalid")
        now = self._clock()
        ttl = certs_lifetime(response.headers.get("cache-control"))
        return _Keys(keys=keys, fetched_at=now, expires_at=now + ttl)

    async def _key(self, kid: str) -> rsa.RSAPublicKey:
        async with self._keys_lock:
            now = self._clock()
            cached = self._keys
            fresh = cached is not None and now < cached.expires_at
            if cached is not None and fresh and kid in cached.keys:
                return cached.keys[kid]
            if cached is None or not fresh or now - cached.fetched_at >= CERTS_MIN_REFRESH:
                cached = self._keys = await self._fetch_keys()
            key = cached.keys.get(kid)
            if key is None:
                raise OAuthError("unknown_kid")
            return key

    async def verify_id_token(self, id_token: str) -> Mapping[str, Any]:
        if len(id_token) > MAX_ID_TOKEN_LENGTH or JWT_SHAPE.fullmatch(id_token) is None:
            raise OAuthError("malformed_id_token")
        head_b64, payload_b64, sig_b64 = id_token.split(".")
        try:
            header = json.loads(_b64decode(head_b64))
            claims = json.loads(_b64decode(payload_b64))
        except (ValueError, RecursionError):
            raise OAuthError("malformed_id_token") from None
        if not isinstance(header, dict) or not isinstance(claims, dict):
            raise OAuthError("malformed_id_token")
        if header.get("alg") != "RS256":
            raise OAuthError("wrong_alg")
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise OAuthError("no_kid")
        key = await self._key(kid)
        try:
            key.verify(
                _b64decode(sig_b64),
                f"{head_b64}.{payload_b64}".encode("ascii"),
                padding.PKCS1v15(),
                hashes.SHA256(),
            )
        except InvalidSignature:
            raise OAuthError("bad_signature") from None
        now = self._clock()
        if claims.get("iss") not in GOOGLE_ISSUERS:
            raise OAuthError("wrong_issuer")
        if claims.get("aud") != self.client_id:
            raise OAuthError("wrong_audience")
        if "azp" in claims and claims["azp"] != self.client_id:
            raise OAuthError("wrong_azp")
        exp, iat = claims.get("exp"), claims.get("iat")
        for value in (exp, iat):
            if isinstance(value, bool) or not isinstance(value, int):
                raise OAuthError("bad_times")
        if now >= exp:  # type: ignore[operator]
            raise OAuthError("expired")
        if iat > now + IAT_SKEW_SECONDS:  # type: ignore[operator]
            raise OAuthError("issued_in_the_future")
        return claims


def pkce_challenge(verifier: str) -> str:
    """``BASE64URL(SHA256(verifier))`` without padding (RFC 7636 S256)."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
