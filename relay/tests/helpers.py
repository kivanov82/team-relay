"""Small request builders for the API tests."""

from __future__ import annotations

import uuid
from typing import Any

import httpx

from .conftest import MANIFEST, auth

T = "/v1/teams/demo"


def question_body(to: Any = ("bob",), question: str = "Where is the deploy log?", **extra: Any):
    return {
        "idempotency_key": extra.pop("idempotency_key", "key-" + uuid.uuid4().hex),
        "kind": "question",
        "to": list(to) if isinstance(to, tuple | list) else to,
        "question": question,
        **extra,
    }


def capability_body(member: str = "bob", name: str = "staging_db_query", **extra: Any):
    params = extra.pop("params", {"dataset": "users"})
    return {
        "idempotency_key": extra.pop("idempotency_key", "key-" + uuid.uuid4().hex),
        "kind": "capability",
        "to": [member],
        "capability": {"name": name, "params": params},
        **extra,
    }


async def post(client: httpx.AsyncClient, member: str, path: str, body: Any) -> httpx.Response:
    return await client.post(T + path, headers=auth(member), json=body)


async def get(client: httpx.AsyncClient, member: str, path: str, **params: Any) -> httpx.Response:
    return await client.get(T + path, headers=auth(member), params=params)


async def ask(client: httpx.AsyncClient, member: str = "alice", **kw: Any) -> dict[str, Any]:
    r = await post(client, member, "/requests", question_body(**kw))
    assert r.status_code == 201, r.text
    return r.json()


async def publish(client: httpx.AsyncClient, member: str = "bob", manifest=MANIFEST) -> None:
    r = await client.put(f"{T}/members/{member}/manifest", headers=auth(member), json=manifest)
    assert r.status_code == 200, r.text


async def stream(client: httpx.AsyncClient, member: str, name: str, **params: Any):
    r = await get(client, member, f"/streams/{name}", **params)
    assert r.status_code == 200, r.text
    return r.json()


async def ack(client, member: str, request_id: str) -> httpx.Response:
    return await post(client, member, f"/requests/{request_id}/ack", None)


async def reply(
    client,
    member: str,
    request_id: str,
    text: str = "It is in the bucket.",
    key: str | None = None,
    data: Any = None,
) -> httpx.Response:
    body: dict[str, Any] = {"idempotency_key": key or "reply-" + uuid.uuid4().hex, "text": text}
    if data is not None:
        body["data"] = data
    return await post(client, member, f"/requests/{request_id}/reply", body)


async def status(client, member: str, request_id: str) -> httpx.Response:
    return await get(client, member, f"/requests/{request_id}")
