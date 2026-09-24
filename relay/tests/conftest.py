"""Shared fixtures. Synthetic identities only (alice, bob, carol in team demo; dave in team
other; one read-only delegate per team, M3-SPEC §2); tokens are throwaway strings that
exist only in this file."""

from __future__ import annotations

import hashlib
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from relay.app import create_app
from relay.auth import StaticVerifier, Unauthenticated
from relay.config import Settings, load_schema, parse_team_config
from relay.store import Store
from relay.store_memory import MemoryStore

RELAY_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = RELAY_ROOT.parent
SCHEMA_PATH = REPO_ROOT / "schema" / "manifest.schema.json"
PLUGIN_MANIFEST = REPO_ROOT / "plugin" / "manifest.yaml"

TOKENS = {
    "alice": "dev-token-alice-0001",
    "bob": "dev-token-bob-0002",
    "carol": "dev-token-carol-0003",
    "dave": "dev-token-dave-0004",
}
START = datetime(2026, 9, 23, 12, 0, 0, tzinfo=UTC)

# Each member also has a Google principal: the email a delegate names in
# X-Relay-On-Behalf-Of resolves through it (M3-SPEC §2).
EMAILS = {m: f"{m}@example.com" for m in TOKENS}

# The read-only delegates (M3-SPEC §2), one per team. Their principals are Google service
# accounts, which the static verifier cannot produce, so the test apps use DelegateVerifier.
DELEGATE_TOKENS = {"demo": "dev-token-console-demo-0005", "other": "dev-token-console-other-0006"}
DELEGATES = {
    "demo": "google:console-demo@example-project.iam.gserviceaccount.com",
    "other": "google:console-other@example-project.iam.gserviceaccount.com",
}


def principal(token: str) -> str:
    return "token:sha256:" + hashlib.sha256(token.encode()).hexdigest()


class DelegateVerifier:
    """The static verifier, except that a delegate's token yields its Google principal (in
    production the Google verifier does that from the service account's ID token)."""

    def __init__(self) -> None:
        self._static = StaticVerifier()
        self._delegates = {DELEGATE_TOKENS[t]: DELEGATES[t] for t in DELEGATE_TOKENS}

    async def principal(self, token: str) -> str:
        if not token:
            raise Unauthenticated("empty_token")
        return self._delegates.get(token) or await self._static.principal(token)


def team_config_data(**limits: int) -> dict[str, Any]:
    data: dict[str, Any] = {
        "teams": [
            {
                "id": "demo",
                "members": [
                    {"id": m, "principals": [principal(TOKENS[m]), f"google:{EMAILS[m]}"]}
                    for m in ("alice", "bob", "carol")
                ],
            },
            {
                "id": "other",
                "members": [
                    {
                        "id": "dave",
                        "principals": [principal(TOKENS["dave"]), f"google:{EMAILS['dave']}"],
                    }
                ],
            },
        ],
        "audit_retention_days": 30,
    }
    if limits:
        data["limits"] = limits
    return data


def with_delegates(data: dict[str, Any]) -> dict[str, Any]:
    """``data`` with one read-only delegate for each of its first two teams, by their
    current ids (DELEGATES["demo"] for the first, DELEGATES["other"] for the second)."""
    first, second = data["teams"][0]["id"], data["teams"][1]["id"]
    data["delegates"] = [
        {"principal": DELEGATES["demo"], "team": first, "scope": "read"},
        {"principal": DELEGATES["other"], "team": second, "scope": "read"},
    ]
    return data


# The plugin's manifest shape, copied so the API tests do not move when the plugin's example
# does; test_manifest.py checks the real plugin/manifest.yaml separately.
MANIFEST: dict[str, Any] = {
    "version": 1,
    "capabilities": [
        {
            "name": "staging_db_query",
            "title": "Query the staging database",
            "description": "Read-only lookup against one staging dataset, at most 100 rows.",
            "environment": "staging",
            "default_enabled": False,
            "timeout_seconds": 120,
            "params": {
                "dataset": {
                    "type": "enum",
                    "values": ["users", "orders", "events"],
                    "description": "Which staging dataset to read.",
                },
                "filter": {
                    "type": "string",
                    "max_length": 200,
                    "pattern": "^[A-Za-z0-9_ =<>!.,'-]*$",
                    "description": "A simple field comparison.",
                },
                "limit": {
                    "type": "integer",
                    "min": 1,
                    "max": 100,
                    "default": 20,
                    "description": "Maximum rows to return.",
                },
            },
            "required": ["dataset"],
        },
        {
            "name": "service_health",
            "title": "Check a service's health",
            "description": "Reports the health of one named service.",
            "environment": "staging",
            "params": {
                "service": {
                    "type": "enum",
                    "values": ["api", "worker", "web"],
                    "description": "Which service to check.",
                }
            },
            "required": ["service"],
        },
    ],
}


class FakeClock:
    def __init__(self, start: datetime = START) -> None:
        self.current = start

    def __call__(self) -> datetime:
        return self.current

    def advance(self, seconds: float) -> None:
        self.current += timedelta(seconds=seconds)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def _not_cloud_run(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("K_SERVICE", raising=False)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def settings() -> Settings:
    return Settings(
        team_config=parse_team_config(with_delegates(team_config_data(min_ack_timeout_seconds=2))),
        manifest_schema=load_schema(SCHEMA_PATH),
        auth_mode="static",
    )


@pytest.fixture
def memory_store() -> MemoryStore:
    return MemoryStore()


@pytest.fixture
async def client(
    settings: Settings, memory_store: MemoryStore, clock: FakeClock
) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(
        settings, memory_store, clock=clock, poll_interval=0.02, verifier=DelegateVerifier()
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://relay") as c:
        yield c


def auth(member: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKENS[member]}"}


def delegate_auth(on_behalf: str | None, team: str = "demo") -> dict[str, str]:
    """The headers the hosted console sends: its own token and the viewer's email."""
    headers = {"Authorization": f"Bearer {DELEGATE_TOKENS[team]}"}
    if on_behalf is not None:
        headers["X-Relay-On-Behalf-Of"] = on_behalf
    return headers


def unique_team() -> str:
    return "t" + uuid.uuid4().hex[:20]


def emulator_host() -> str | None:
    return os.environ.get("FIRESTORE_EMULATOR_HOST") or None


NO_EMULATOR = "FIRESTORE_EMULATOR_HOST is not set; run scripts/test-relay.sh to include Firestore"


@dataclass
class Api:
    """The HTTP API over one store, for tests that must hold on both stores. The team id is
    unique per test (``unique_team()``), so Firestore tests never see each other's data;
    alice, bob and carol are its members, dave is alone in team ``other``."""

    client: httpx.AsyncClient
    team: str
    store: Store
    clock: FakeClock
    app: FastAPI

    def url(self, path: str) -> str:
        return f"/v1/teams/{self.team}{path}"

    async def get(self, member: str, path: str, **params: Any) -> httpx.Response:
        return await self.client.get(self.url(path), headers=auth(member), params=params)

    async def post(self, member: str, path: str, body: Any) -> httpx.Response:
        return await self.client.post(self.url(path), headers=auth(member), json=body)

    async def ask(self, member: str = "alice", **body: Any) -> str:
        payload = {
            "idempotency_key": "key-" + uuid.uuid4().hex,
            "kind": "question",
            "to": body.pop("to", ["bob"]),
            "question": body.pop("question", "Where is the deploy log?"),
            **body,
        }
        r = await self.post(member, "/requests", payload)
        assert r.status_code == 201, r.text
        return r.json()["request_id"]

    async def invoke(self, member: str = "alice", to: str = "bob", **params: Any) -> str:
        payload = {
            "idempotency_key": "key-" + uuid.uuid4().hex,
            "kind": "capability",
            "to": [to],
            "capability": {"name": "staging_db_query", "params": params or {"dataset": "users"}},
        }
        r = await self.post(member, "/requests", payload)
        assert r.status_code == 201, r.text
        return r.json()["request_id"]

    async def publish(self, member: str = "bob") -> None:
        r = await self.client.put(
            self.url(f"/members/{member}/manifest"), headers=auth(member), json=MANIFEST
        )
        assert r.status_code == 200, r.text

    async def reply(self, member: str, request_id: str, text: str = "In the bucket.") -> None:
        body = {"idempotency_key": "reply-" + uuid.uuid4().hex, "text": text}
        r = await self.post(member, f"/requests/{request_id}/reply", body)
        assert r.status_code == 200, r.text

    async def ack(self, member: str, request_id: str) -> httpx.Response:
        return await self.post(member, f"/requests/{request_id}/ack", None)

    async def stream(self, member: str, name: str, **params: Any) -> dict[str, Any]:
        r = await self.get(member, f"/streams/{name}", **params)
        assert r.status_code == 200, r.text
        return r.json()

    async def cursor(self, member: str, name: str, seq: int) -> httpx.Response:
        return await self.post(member, f"/streams/{name}/cursor", {"acked_seq": seq})

    async def consume(self, member: str, name: str) -> list[dict[str, Any]]:
        """What a channel does: read from the stored cursor, then ack every message."""
        messages = (await self.stream(member, name))["messages"]
        for env in messages:
            r = await self.cursor(member, name, env["seq"])
            assert r.status_code == 200, r.text
        return messages

    async def activity(self, member: str = "alice", **params: Any) -> dict[str, Any]:
        r = await self.get(member, "/activity", **params)
        assert r.status_code == 200, r.text
        return r.json()

    async def feed_entry(self, member: str, request_id: str) -> dict[str, Any]:
        entries = [
            e for e in (await self.activity(member))["requests"] if e["request_id"] == request_id
        ]
        assert len(entries) == 1, entries
        return entries[0]

    async def directory(self, member: str = "alice") -> dict[str, dict[str, Any]]:
        r = await self.get(member, "/directory")
        assert r.status_code == 200, r.text
        return {m["member"]: m for m in r.json()["members"]}

    async def delegated(
        self,
        method: str,
        path: str,
        on_behalf: str | None = EMAILS["alice"],
        *,
        delegate: str = "demo",
        **kwargs: Any,
    ) -> httpx.Response:
        """A request as the team's delegate (``delegate="other"``: team other's) on behalf
        of the member with email ``on_behalf`` (None: no header)."""
        headers = {**delegate_auth(on_behalf, delegate), **kwargs.pop("headers", {})}
        return await self.client.request(method, self.url(path), headers=headers, **kwargs)


@asynccontextmanager
async def open_api(kind: str, clock: FakeClock, **limits: int) -> AsyncIterator[Api]:
    """An :class:`Api` over a fresh ``kind`` store ("memory" or "firestore") for a unique
    team, with the team's delegate configured and ``limits`` applied."""
    if kind == "memory":
        store: Store = MemoryStore()
    else:
        if not emulator_host():
            pytest.skip(NO_EMULATOR)
        from relay.store_firestore import FirestoreStore

        store = FirestoreStore(project=os.environ.get("GOOGLE_CLOUD_PROJECT", "demo-relay"))
    team = unique_team()
    data = team_config_data(min_ack_timeout_seconds=2, **limits)
    data["teams"][0]["id"] = team
    with_delegates(data)
    settings = Settings(
        team_config=parse_team_config(data),
        manifest_schema=load_schema(SCHEMA_PATH),
        auth_mode="static",
    )
    app = create_app(settings, store, clock=clock, poll_interval=0.02, verifier=DelegateVerifier())
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://relay"
        ) as c:
            yield Api(client=c, team=team, store=store, clock=clock, app=app)
    finally:
        await store.aclose()


@pytest.fixture(params=["memory", "firestore"])
async def api(request: pytest.FixtureRequest, clock: FakeClock) -> AsyncIterator[Api]:
    async with open_api(request.param, clock) as opened:
        yield opened
