"""Drive the login flow of M5-SPEC §2 by hand, step by step, as the plugin and a browser
would, against the fake Google of ``tests.fake_google``. Every step returns what the next
one needs, so a test can stop anywhere and tamper with any part."""

from __future__ import annotations

import base64
import hashlib
import re
import secrets
from dataclasses import dataclass
from html import unescape
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx

from .conftest import EMAILS, Api
from .fake_google import FakeGoogle, authorization_params

LISTENER_PORT = 54321
DEVICE = "Claude Code on test-host"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def new_verifier() -> str:
    return b64url(secrets.token_bytes(32))


def challenge_of(verifier: str) -> str:
    return b64url(hashlib.sha256(verifier.encode("ascii")).digest())


def cookie_from(response: httpx.Response, name: str = "trl") -> str | None:
    for header in response.headers.get_list("set-cookie"):
        first = header.split(";", 1)[0]
        key, _, value = first.partition("=")
        if key.strip() == name:
            return value.strip() or None
    return None


def set_cookie_header(response: httpx.Response, name: str = "trl") -> str:
    matches = [h for h in response.headers.get_list("set-cookie") if h.startswith(name + "=")]
    assert len(matches) == 1, matches
    return matches[0]


def hidden_csrf(html: str) -> str:
    match = re.search(r'<input type="hidden" name="csrf" value="([^"]*)">', html)
    assert match, html
    return unescape(match.group(1))


def team_values(html: str) -> list[str]:
    found = re.findall(r'<input type="radio" name="team" value="([^"]*)"', html)
    return [unescape(v) for v in found]


@dataclass
class Started:
    response: httpx.Response
    cookie: str
    params: dict[str, str]  # the Google authorization URL's query
    verifier: str
    state: str
    port: int


@dataclass
class Chooser:
    started: Started
    response: httpx.Response
    csrf: str
    teams: list[str]


def start_query(
    *,
    port: int | str = LISTENER_PORT,
    state: str | None = None,
    challenge: str | None = None,
    method: str = "S256",
    device: str = DEVICE,
    verifier: str | None = None,
) -> tuple[dict[str, Any], str, str]:
    verifier = verifier or new_verifier()
    state = state or b64url(secrets.token_bytes(32))
    query = {
        "port": str(port),
        "state": state,
        "code_challenge": challenge or challenge_of(verifier),
        "code_challenge_method": method,
        "device": device,
    }
    return query, verifier, state


async def start(client: httpx.AsyncClient, **kw: Any) -> Started:
    query, verifier, state = start_query(**kw)
    r = await client.get("/v1/login/start", params=query)
    assert r.status_code == 302, r.text
    cookie = cookie_from(r)
    assert cookie
    return Started(
        response=r,
        cookie=cookie,
        params=authorization_params(r.headers["location"]),
        verifier=verifier,
        state=state,
        port=int(query["port"]),
    )


async def callback(
    client: httpx.AsyncClient,
    started: Started,
    code: str | None,
    *,
    cookie: str | None = "",
    state: str | None = "",
    extra: dict[str, str] | None = None,
) -> httpx.Response:
    """GET the relay's callback as Google's redirect would. ``cookie``/``state`` default to
    the login's own; None leaves them out."""
    cookie = started.cookie if cookie == "" else cookie
    state = started.params["state"] if state == "" else state
    query: dict[str, str] = {**(extra or {})}
    if code is not None:
        query["code"] = code
    if state is not None:
        query["state"] = state
    headers = {"Cookie": f"trl={cookie}"} if cookie is not None else {}
    return await client.get("/v1/login/callback?" + urlencode(query), headers=headers)


async def google(
    client: httpx.AsyncClient, fake: FakeGoogle, started: Started, email: str, **grant: Any
) -> httpx.Response:
    code = fake.authorize(started.params, email, **grant)
    return await callback(client, started, code)


async def to_chooser(
    client: httpx.AsyncClient, fake: FakeGoogle, email: str, **start_kw: Any
) -> Chooser:
    started = await start(client, **start_kw)
    r = await google(client, fake, started, email)
    assert r.status_code == 200, r.text
    return Chooser(started=started, response=r, csrf=hidden_csrf(r.text), teams=team_values(r.text))


async def choose(
    client: httpx.AsyncClient,
    cookie: str | None,
    fields: dict[str, str],
    *,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    all_headers = {"Content-Type": "application/x-www-form-urlencoded", **(headers or {})}
    if cookie is not None:
        all_headers["Cookie"] = f"trl={cookie}"
    return await client.post("/v1/login/choose", content=urlencode(fields), headers=all_headers)


def loopback(response: httpx.Response) -> tuple[str, dict[str, str]]:
    """The 303's target and its query (one value per name)."""
    assert response.status_code == 303, response.text
    location = response.headers["location"]
    parts = urlsplit(location)
    query = {k: v[0] for k, v in parse_qs(parts.query).items()}
    return f"{parts.scheme}://{parts.netloc}{parts.path}", query


async def continue_as(client: httpx.AsyncClient, chooser: Chooser, team: str) -> dict[str, str]:
    r = await choose(
        client, chooser.started.cookie, {"csrf": chooser.csrf, "team": team, "action": "continue"}
    )
    target, query = loopback(r)
    assert target == f"http://127.0.0.1:{chooser.started.port}/callback"
    assert query["state"] == chooser.started.state
    return query


async def token(client: httpx.AsyncClient, code: str, verifier: str) -> httpx.Response:
    return await client.post("/v1/login/token", json={"code": code, "code_verifier": verifier})


async def login(
    api: Api,
    member: str = "alice",
    *,
    email: str | None = None,
    team: str | None = None,
    client: httpx.AsyncClient | None = None,
    device: str = DEVICE,
) -> dict[str, Any]:
    """The whole flow; returns the token response's JSON (``credential`` and the rest)."""
    assert api.fake is not None
    client = client or api.client
    chooser = await to_chooser(client, api.fake, email or EMAILS[member], device=device)
    query = await continue_as(client, chooser, team or api.team)
    r = await token(client, query["code"], chooser.started.verifier)
    assert r.status_code == 200, r.text
    return r.json()


def bearer(credential: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {credential}"}
