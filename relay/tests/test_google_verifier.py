"""The Google verifier (M1-SPEC §2, corrected by §11.8): real RS256 tokens signed with a
throwaway key, a fake certificate endpoint that counts its fetches, and an injected clock
for the caches. Nothing here reaches the network."""

from __future__ import annotations

import json
import threading
import time
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from google.auth import crypt
from google.auth import jwt as google_jwt

from relay import auth as auth_module
from relay.app import create_app
from relay.auth import (
    CERTS_DEFAULT_TTL,
    CERTS_MAX_TTL,
    CERTS_MIN_REFRESH,
    CERTS_MIN_TTL,
    MAX_TOKEN_LENGTH,
    GoogleVerifier,
    Unauthenticated,
    certs_lifetime,
)
from relay.config import Settings, load_schema, parse_team_config
from relay.errors import ApiError
from relay.store_memory import MemoryStore

from .conftest import SCHEMA_PATH

pytestmark = pytest.mark.anyio

AUDIENCE = "https://relay.example.test"


def _keypair() -> tuple[str, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public = (
        key.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    return private, public


KEY1_PRIVATE, KEY1_PUBLIC = _keypair()
KEY2_PRIVATE, KEY2_PUBLIC = _keypair()
STRANGER_PRIVATE, _ = _keypair()


def make_token(
    private: str = KEY1_PRIVATE, kid: str = "k1", lifetime: int = 3600, **claims: Any
) -> str:
    now = int(time.time())
    payload = {
        "iss": "https://accounts.google.com",
        "aud": AUDIENCE,
        "email": "alice@example.com",
        "email_verified": True,
        "sub": "104593728194712345678",
        "iat": now - 10,
        "exp": now + lifetime,
        **claims,
    }
    payload = {k: v for k, v in payload.items() if v is not None}
    signer = crypt.RSASigner.from_string(private, key_id=kid)
    return google_jwt.encode(signer, payload).decode()


class FakeResponse:
    def __init__(self, status: int, data: bytes, headers: dict[str, str]) -> None:
        self.status = status
        self.data = data
        self.headers = headers


class FakeCertsEndpoint:
    """Google's certificate endpoint, counting fetches and the threads they ran on."""

    def __init__(self, certs: dict[str, str] | None = None, max_age: int | None = 100) -> None:
        self.certs = certs if certs is not None else {"k1": KEY1_PUBLIC}
        self.max_age = max_age
        self.status = 200
        self.raise_error: Exception | None = None
        self.fetches = 0
        self.threads: list[int] = []

    def __call__(self, url: str, method: str = "GET", **kwargs: Any) -> FakeResponse:
        self.fetches += 1
        self.threads.append(threading.get_ident())
        assert url == auth_module.GOOGLE_CERTS_URL and method == "GET"
        assert kwargs.get("timeout")  # never an unbounded fetch
        if self.raise_error is not None:
            raise self.raise_error
        headers = {}
        if self.max_age is not None:
            headers["Cache-Control"] = f"public, max-age={self.max_age}, must-revalidate"
        return FakeResponse(self.status, json.dumps(self.certs).encode(), headers)


class Clock:
    def __init__(self) -> None:
        self.now = time.time()

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def endpoint() -> FakeCertsEndpoint:
    return FakeCertsEndpoint()


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def verifier(endpoint: FakeCertsEndpoint, clock: Clock) -> GoogleVerifier:
    return GoogleVerifier(AUDIENCE, transport=endpoint, clock=clock)


@pytest.fixture
def decodes(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Counts full signature verifications."""
    calls: list[str] = []
    real = auth_module.jwt.decode

    def counting(token: str, **kwargs: Any) -> Any:
        calls.append(token)
        return real(token, **kwargs)

    monkeypatch.setattr(auth_module.jwt, "decode", counting)
    return calls


# Verification ---------------------------------------------------------------------------------


async def test_valid_token_resolves_the_lowercased_email(verifier):
    assert await verifier.principal(make_token(email="Alice@Example.COM")) == (
        "google:alice@example.com"
    )


async def test_verify_returns_the_principal_and_the_sub(verifier, decodes):
    token = make_token(email="Bob@Example.com", sub="118000000000000000001")
    verified = await verifier.verify(token)
    assert (verified.principal, verified.sub) == ("google:bob@example.com", "118000000000000000001")
    assert await verifier.verify(token) == verified  # from the cache, sub included
    assert await verifier.principal(token) == "google:bob@example.com"
    assert len(decodes) == 1


@pytest.mark.parametrize(
    "token, reason",
    [
        (lambda: make_token(email_verified=False), "email_not_verified"),
        (lambda: make_token(email_verified="true"), "email_not_verified"),
        (lambda: make_token(email_verified=None), "email_not_verified"),
        (lambda: make_token(iss="https://evil.example"), "wrong_issuer"),
        (lambda: make_token(email=None), "no_email"),
        # M6-SPEC §7.2: the account's sub is what a roster email is bound to.
        (lambda: make_token(sub=None), "no_sub"),
        (lambda: make_token(sub=""), "no_sub"),
        (lambda: make_token(sub=12345), "no_sub"),
        (lambda: make_token(sub="x" * 256), "no_sub"),
        (lambda: make_token(aud="https://other.example"), "InvalidValue"),
        (lambda: make_token(lifetime=-100), "InvalidValue"),  # expired
        (lambda: make_token(private=STRANGER_PRIVATE), "MalformedError"),  # bad signature
    ],
)
async def test_refusals(verifier, token, reason):
    with pytest.raises(Unauthenticated) as exc:
        await verifier.principal(token())
    assert exc.value.reason == reason


@pytest.mark.parametrize(
    "token",
    [
        "",
        "not-a-jwt",
        "a.b",
        "a.b.c.d",
        "a..c",
        "a.b.c=",  # padding is not base64url in a JWT
        "a+b.c.d",
        "a.b.c\n",
        "é.b.c",
        "a" * (MAX_TOKEN_LENGTH - 3) + ".b.c",
        "eyJ.b.c",  # the header segment is not decodable
        "W10.b.c",  # the header is JSON but not an object ("[]")
        "eyJraWQiOjF9.b.c",  # kid is not a string ({"kid":1})
    ],
)
async def test_malformed_tokens_are_refused_before_any_network_call(verifier, endpoint, token):
    with pytest.raises(Unauthenticated):
        await verifier.principal(token)
    assert endpoint.fetches == 0


async def test_deeply_nested_header_is_refused_without_a_fetch(verifier, endpoint):
    import base64

    header = base64.urlsafe_b64encode(b"[" * 2500).decode().rstrip("=")
    with pytest.raises(Unauthenticated):
        await verifier.principal(header + ".b.c")
    assert endpoint.fetches == 0


# The certificate cache ------------------------------------------------------------------------


async def test_certificates_are_fetched_once_per_cache_lifetime(verifier, endpoint, clock):
    for email in ("alice@example.com", "bob@example.com", "carol@example.com"):
        await verifier.principal(make_token(email=email))
    assert endpoint.fetches == 1
    clock.now += 99
    await verifier.principal(make_token(email="dave@example.com"))
    assert endpoint.fetches == 1
    clock.now += 2  # past max-age=100
    await verifier.principal(make_token(email="erin@example.com"))
    assert endpoint.fetches == 2


async def test_concurrent_misses_share_one_fetch(verifier, endpoint):
    import asyncio

    tokens = [make_token(email=f"user{i}@example.com") for i in range(8)]
    await asyncio.gather(*(verifier.principal(t) for t in tokens))
    assert endpoint.fetches == 1


async def test_the_fetch_runs_off_the_event_loop(verifier, endpoint):
    await verifier.principal(make_token())
    assert endpoint.threads and endpoint.threads[0] != threading.get_ident()


@pytest.mark.parametrize(
    "header, seconds",
    [
        (None, CERTS_DEFAULT_TTL),
        ("", CERTS_DEFAULT_TTL),
        ("public, must-revalidate", CERTS_DEFAULT_TTL),
        ("public, max-age=19800, must-revalidate, no-transform", 19800),
        ("max-age=0", CERTS_MIN_TTL),
        ("max-age=5", CERTS_MIN_TTL),
        ("max-age=99999999", CERTS_MAX_TTL),
        ('max-age="300"', 300),
        ("s-maxage=10, max-age=400", 400),
        ("max-age=abc", CERTS_DEFAULT_TTL),
    ],
)
def test_certs_lifetime(header, seconds):
    assert certs_lifetime(header) == seconds


async def test_missing_cache_control_defaults_to_an_hour(clock):
    endpoint = FakeCertsEndpoint(max_age=None)
    verifier = GoogleVerifier(AUDIENCE, transport=endpoint, clock=clock)
    await verifier.principal(make_token(email="a@example.com"))
    clock.now += CERTS_DEFAULT_TTL - 1
    await verifier.principal(make_token(email="b@example.com"))
    assert endpoint.fetches == 1
    clock.now += 2
    await verifier.principal(make_token(email="c@example.com"))
    assert endpoint.fetches == 2


async def test_an_unknown_key_refetches_but_not_more_than_every_few_minutes(clock):
    endpoint = FakeCertsEndpoint(max_age=86400)
    verifier = GoogleVerifier(AUDIENCE, transport=endpoint, clock=clock)
    await verifier.principal(make_token())
    rotated = make_token(private=KEY2_PRIVATE, kid="k2", email="bob@example.com")
    # Google has not published k2 yet, and the last fetch is recent: no refetch.
    with pytest.raises(Unauthenticated):
        await verifier.principal(rotated)
    assert endpoint.fetches == 1
    endpoint.certs = {"k1": KEY1_PUBLIC, "k2": KEY2_PUBLIC}
    clock.now += CERTS_MIN_REFRESH - 1
    with pytest.raises(Unauthenticated):
        await verifier.principal(rotated)
    assert endpoint.fetches == 1
    clock.now += 2
    assert await verifier.principal(rotated) == "google:bob@example.com"
    assert endpoint.fetches == 2
    # A flood of made-up key ids cannot turn into a flood of fetches.
    for i in range(20):
        with pytest.raises(Unauthenticated):
            await verifier.principal(make_token(kid=f"made-up-{i}", email=f"x{i}@example.com"))
    assert endpoint.fetches == 2


@pytest.mark.parametrize(
    "breakage",
    [
        lambda e: setattr(e, "status", 500),
        lambda e: setattr(e, "raise_error", OSError("unreachable")),
        lambda e: setattr(e, "certs", []),
        lambda e: setattr(e, "certs", {"k1": 7}),
    ],
)
async def test_certificate_fetch_failure_is_503(verifier, endpoint, breakage):
    breakage(endpoint)
    with pytest.raises(ApiError) as exc:
        await verifier.principal(make_token())
    assert exc.value.status == 503 and exc.value.code == "auth_unavailable"


# The verified-token cache ---------------------------------------------------------------------


async def test_a_verified_token_is_cached_until_its_exp(verifier, endpoint, clock, decodes):
    token = make_token(lifetime=600)
    for _ in range(5):
        assert await verifier.principal(token) == "google:alice@example.com"
    assert len(decodes) == 1 and endpoint.fetches == 1
    clock.now += 590
    await verifier.principal(token)
    assert len(decodes) == 1
    clock.now += 20  # past exp: verified again (and refused by the real expiry check if due)
    await verifier.principal(token)
    assert len(decodes) == 2


async def test_refused_tokens_are_not_cached(verifier, decodes):
    token = make_token(email_verified=False)
    for _ in range(3):
        with pytest.raises(Unauthenticated):
            await verifier.principal(token)
    assert len(decodes) == 3


async def test_the_verified_cache_is_bounded(endpoint, clock, decodes):
    verifier = GoogleVerifier(AUDIENCE, transport=endpoint, clock=clock, cache_size=2)
    a, b, c = (make_token(email=f"{n}@example.com") for n in "abc")
    for token in (a, b, c):
        await verifier.principal(token)
    assert len(decodes) == 3
    await verifier.principal(c)
    await verifier.principal(b)
    assert len(decodes) == 3  # b and c are still cached
    await verifier.principal(a)  # a was evicted
    assert len(decodes) == 4


async def test_the_cache_key_is_the_whole_token(verifier, decodes):
    token = make_token()
    await verifier.principal(token)
    head, payload, signature = token.split(".")
    forged = ".".join([head, payload, signature[:-2] + ("AA" if signature[-2:] != "AA" else "BB")])
    with pytest.raises(Unauthenticated):
        await verifier.principal(forged)
    assert len(decodes) == 2


def test_google_verifier_needs_an_audience():
    with pytest.raises(ValueError):
        GoogleVerifier("")


# Through the app ------------------------------------------------------------------------------


@pytest.fixture
async def google_client(endpoint, clock, capsys):
    data = {
        "teams": [
            {
                "id": "demo",
                "members": [
                    {"id": "alice", "role": "owner", "principals": ["google:alice@example.com"]},
                    {"id": "bob", "principals": ["google:bob@example.com"]},
                ],
            }
        ]
    }
    settings = Settings(
        team_config=parse_team_config(data),
        manifest_schema=load_schema(SCHEMA_PATH),
        auth_mode="google",
        audiences=(AUDIENCE,),
    )
    verifier = GoogleVerifier(AUDIENCE, transport=endpoint, clock=clock)
    app = create_app(settings, MemoryStore(), verifier=verifier)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://relay"
    ) as c:
        yield c


async def test_app_accepts_a_valid_token(google_client):
    token = make_token(email="Alice@Example.com")
    r = await google_client.get("/v1/teams/demo/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200 and r.json()["member"] == "alice"


@pytest.mark.parametrize(
    "token, reason",
    [
        (lambda: make_token(email_verified=False), "email_not_verified"),
        (lambda: make_token(email="mallory@example.com"), "unknown_principal"),
        (lambda: make_token(private=STRANGER_PRIVATE), "MalformedError"),
        (lambda: "garbage.token.value", "malformed_token"),
        (lambda: "garbage", "malformed_token"),
    ],
)
async def test_app_refusals_are_401_and_never_log_the_token(google_client, capsys, token, reason):
    value = token()
    r = await google_client.get("/v1/teams/demo/me", headers={"Authorization": f"Bearer {value}"})
    assert r.status_code == 401 and r.json() == {"error": "unauthenticated"}
    out = capsys.readouterr().out
    assert json.loads(out.strip().splitlines()[-1])["reason"] == reason
    assert value not in out


async def test_app_certificate_outage_is_503(google_client, endpoint):
    endpoint.status = 503
    token = make_token()
    r = await google_client.get("/v1/teams/demo/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 503 and r.json()["error"] == "auth_unavailable"


async def test_app_polls_do_not_refetch_or_reverify(google_client, endpoint, decodes):
    token = make_token(email="bob@example.com")
    for _ in range(10):
        r = await google_client.get(
            "/v1/teams/demo/streams/inbox", headers={"Authorization": f"Bearer {token}"}
        )
        assert r.status_code == 200
    assert endpoint.fetches == 1 and len(decodes) == 1
