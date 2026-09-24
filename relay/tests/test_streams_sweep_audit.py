"""Streams and cursors (M1-SPEC §3.6, §3.7), long-poll, the deadline sweep (§4) and the
audit trail (§7)."""

from __future__ import annotations

import asyncio
import dataclasses
import time
from datetime import timedelta

import pytest

from relay.jsonutil import content_digest

from .conftest import auth
from .helpers import T, ack, ask, capability_body, get, post, publish, reply, status, stream

pytestmark = pytest.mark.anyio


# Streams -------------------------------------------------------------------------------------


async def test_unknown_stream_is_404(client):
    for name in ("outbox", "INBOX", "replies2"):
        r = await get(client, "alice", f"/streams/{name}")
        assert r.status_code == 404 and r.json() == {"error": "not_found"}
        r = await post(client, "alice", f"/streams/{name}/cursor", {"acked_seq": 0})
        assert r.status_code == 404


@pytest.mark.parametrize(
    "params",
    [
        {"after": "-1"},
        {"after": "x"},
        {"wait": "26"},
        {"wait": "1.5"},
        {"limit": "0"},
        {"limit": "101"},
        {"limit": ""},
    ],
)
async def test_bad_query_parameters_are_400(client, params):
    r = await get(client, "bob", "/streams/inbox", **params)
    assert r.status_code == 400 and r.json()["error"] == "invalid_query"


async def test_after_limit_and_the_stored_cursor(client):
    for i in range(5):
        await ask(client, question=f"q{i}")
    page = await stream(client, "bob", "inbox", limit=2)
    assert [m["seq"] for m in page["messages"]] == [1, 2] and page["head"] == 5
    page = await stream(client, "bob", "inbox", after=3)
    assert [m["data"]["question"] for m in page["messages"]] == ["q3", "q4"]

    r = await post(client, "bob", "/streams/inbox/cursor", {"acked_seq": 2})
    assert r.status_code == 200 and r.json() == {"cursor": 2}
    page = await stream(client, "bob", "inbox")  # omitted `after` means the stored cursor
    assert [m["seq"] for m in page["messages"]] == [3, 4, 5] and page["cursor"] == 2
    page = await stream(client, "bob", "inbox", after=0)  # an explicit after wins
    assert len(page["messages"]) == 5

    # The cursor only moves forward, and never past the head.
    assert (await post(client, "bob", "/streams/inbox/cursor", {"acked_seq": 1})).json() == {
        "cursor": 2
    }
    r = await post(client, "bob", "/streams/inbox/cursor", {"acked_seq": 6})
    assert r.status_code == 400 and r.json()["error"] == "beyond_head"
    assert (await post(client, "bob", "/streams/inbox/cursor", {"acked_seq": 5})).json() == {
        "cursor": 5
    }
    # Streams are per member: carol's cursor is untouched.
    assert (await stream(client, "carol", "inbox"))["cursor"] == 0


async def test_cursor_body_rules(client):
    for body in (
        {"acked_seq": -1},
        {"acked_seq": "1"},
        {"acked_seq": 1.0},
        {},
        {"acked_seq": 0, "member": "carol"},
    ):
        r = await post(client, "bob", "/streams/inbox/cursor", body)
        assert r.status_code == 422, body
    r = await post(client, "bob", "/streams/replies/cursor", {"acked_seq": 1})
    assert r.status_code == 400 and r.json()["error"] == "beyond_head"


async def test_cursor_moves_are_not_audited(client, memory_store):
    await ask(client)
    before = len(await memory_store.list_audit("demo"))
    await post(client, "bob", "/streams/inbox/cursor", {"acked_seq": 1})
    await post(client, "bob", "/streams/inbox/cursor", {"acked_seq": 9})
    assert len(await memory_store.list_audit("demo")) == before


async def test_expired_messages_are_not_returned(client, clock):
    await ask(
        client,
        ack_timeout_seconds=60,
        answer_timeout_seconds=60,
        ttl_seconds=60,
        question="short-lived",
    )
    await ask(client, question="long-lived")
    clock.advance(60)
    page = await stream(client, "bob", "inbox")
    assert [m["data"]["question"] for m in page["messages"]] == ["long-lived"]
    assert page["head"] == 2


# Long-poll -----------------------------------------------------------------------------------


async def test_wait_returns_when_a_message_arrives(client):
    async def later() -> None:
        await asyncio.sleep(0.15)
        await ask(client)

    started = time.monotonic()
    page, _ = await asyncio.gather(stream(client, "bob", "inbox", wait=5), later())
    elapsed = time.monotonic() - started
    assert [m["type"] for m in page["messages"]] == ["question"]
    assert elapsed < 2


async def test_wait_returns_empty_after_the_wait(client):
    started = time.monotonic()
    page = await stream(client, "bob", "inbox", wait=1)
    elapsed = time.monotonic() - started
    assert page == {"messages": [], "cursor": 0, "head": 0}
    assert 0.9 <= elapsed < 2


async def test_wait_zero_returns_at_once(client):
    started = time.monotonic()
    await stream(client, "bob", "inbox", wait=0)
    assert time.monotonic() - started < 0.5


async def test_long_poll_stops_when_the_client_disconnects(client):
    service = client._transport.app.state.service  # type: ignore[attr-defined]
    from relay.service import Caller

    calls = 0

    async def gone() -> bool:
        nonlocal calls
        calls += 1
        return True

    started = time.monotonic()
    page = await service.read_stream(Caller("demo", "bob"), "inbox", None, "25", None, gone)
    assert time.monotonic() - started < 1
    assert calls == 1 and page["messages"] == []


async def test_a_deadline_passing_during_a_long_poll_is_delivered(client, clock):
    await ask(client, ack_timeout_seconds=10)

    async def later() -> None:
        await asyncio.sleep(0.1)
        clock.advance(10)

    page, _ = await asyncio.gather(stream(client, "alice", "replies", wait=5), later())
    assert [m["type"] for m in page["messages"]] == ["no_response"]


# The sweep -----------------------------------------------------------------------------------


async def test_no_response_is_written_exactly_once(client, clock, memory_store):
    rid = (await ask(client, ack_timeout_seconds=10))["request_id"]
    clock.advance(9)
    assert (await stream(client, "alice", "replies"))["messages"] == []
    clock.advance(1)
    first = await stream(client, "alice", "replies")
    second = await stream(client, "alice", "replies")
    assert [m["type"] for m in first["messages"]] == ["no_response"]
    assert second["messages"] == first["messages"] and second["head"] == 1
    [env] = first["messages"]
    assert env["from"] == "relay" and env["to"] == "alice" and env["request_id"] == rid
    assert env["data"] == {"member": "bob", "detail": "No response yet from bob."}
    doc = await memory_store.get_request("demo", rid)
    assert doc.recipients["bob"].status == "no_response" and doc.next_deadline is None


async def test_concurrent_sweeps_write_one_notice(client, clock):
    await ask(client, to=["bob", "carol"], ack_timeout_seconds=10)
    clock.advance(10)
    pages = await asyncio.gather(*(stream(client, "alice", "replies") for _ in range(4)))
    assert all(p["head"] == 2 for p in pages)
    types = [(m["type"], m["data"]["member"]) for m in pages[-1]["messages"]]
    assert types == [("no_response", "bob"), ("no_response", "carol")]


async def test_timed_out_after_ack_and_late_ack_after_no_response(client, clock, memory_store):
    rid = (
        await ask(client, to=["bob", "carol"], ack_timeout_seconds=10, answer_timeout_seconds=100)
    )["request_id"]
    await ack(client, "bob", rid)
    doc = await memory_store.get_request("demo", rid)
    assert doc.next_deadline == doc.ack_deadline  # carol still pending

    clock.advance(10)
    await stream(client, "alice", "replies")  # carol: no_response
    doc = await memory_store.get_request("demo", rid)
    assert doc.next_deadline == doc.answer_deadline  # only bob's answer deadline remains

    assert (await ack(client, "carol", rid)).json() == {"status": "acked"}  # late ack
    clock.advance(90)
    page = await stream(client, "alice", "replies")
    assert [(m["type"], m["data"]["member"]) for m in page["messages"]] == [
        ("no_response", "carol"),
        ("timed_out", "bob"),
        ("timed_out", "carol"),
    ]
    assert page["messages"][1]["data"]["detail"] == "bob acknowledged but has not answered yet."
    doc = await memory_store.get_request("demo", rid)
    assert doc.next_deadline is None
    assert (await ack(client, "bob", rid)).json() == {"status": "timed_out"}  # unchanged


async def test_answered_recipients_never_get_notices(client, clock):
    rid = (await ask(client, ack_timeout_seconds=10, answer_timeout_seconds=60))["request_id"]
    await reply(client, "bob", rid)
    clock.advance(3600)
    page = await stream(client, "alice", "replies")
    assert [m["type"] for m in page["messages"]] == ["answer"]


async def test_sweep_only_touches_the_callers_requests(client, clock):
    await ask(client, "carol", to=["bob"], ack_timeout_seconds=10)
    clock.advance(10)
    assert (await stream(client, "alice", "replies"))["messages"] == []
    assert [m["type"] for m in (await stream(client, "carol", "replies"))["messages"]] == [
        "no_response"
    ]


async def test_deadlines_after_expiry_never_fire(client, clock, memory_store):
    # ack <= answer <= ttl (§11.4), so at most the deadlines coincide with expire_at, and a
    # deadline at expire_at never fires.
    rid = (await ask(client, ack_timeout_seconds=60, answer_timeout_seconds=60, ttl_seconds=60))[
        "request_id"
    ]
    doc = await memory_store.get_request("demo", rid)
    assert doc.next_deadline is None
    clock.advance(200)
    assert (await stream(client, "alice", "replies"))["head"] == 0


# Audit ---------------------------------------------------------------------------------------


async def test_audit_trail_hashes_content_and_never_copies_it(client, clock, memory_store):
    secret_question = "What is the staging password rotation plan?"
    secret_answer = "Rotation happens on the first Monday."
    await publish(client)
    rid = (
        await ask(client, to=["bob", "carol"], question=secret_question, ack_timeout_seconds=10)
    )["request_id"]
    await ack(client, "bob", rid)
    await post(client, "bob", f"/requests/{rid}/progress", {"text": "looking it up", "pct": 10})
    r = await reply(client, "bob", rid, text=secret_answer, data={"note": "private detail"})
    message_id = r.json()["message_id"]
    clock.advance(10)
    await stream(client, "alice", "replies")  # carol: no_response notice
    await ack(client, "carol", "rq_" + "0" * 32)  # refused
    cap = await post(client, "alice", "/requests", capability_body())
    assert cap.status_code == 201

    entries = await memory_store.list_audit("demo")
    summary = [(e.actor, e.action, e.outcome) for e in entries]
    assert summary == [
        ("bob", "manifest.publish", "published"),
        ("alice", "request.create", "created"),
        ("alice", "envelope.deliver", "delivered"),
        ("alice", "envelope.deliver", "delivered"),
        ("bob", "request.ack", "acked"),
        ("bob", "request.progress", "recorded"),
        ("bob", "request.reply", "answered"),
        ("bob", "envelope.deliver", "delivered"),
        ("relay", "deadline.notice", "delivered"),
        ("carol", "request.ack", "refused"),
        ("alice", "request.create", "created"),
        ("alice", "envelope.deliver", "delivered"),
    ]

    everything = repr([dataclasses.asdict(e) for e in entries])
    for text in (
        secret_question,
        secret_answer,
        "private detail",
        "looking it up",
        "staging_db_query",
        "No response yet",
    ):
        assert text not in everything

    for e in entries:
        assert e.team == "demo"
        assert e.expire_at == e.time + timedelta(days=30)  # audit_retention_days
        if e.outcome != "refused" and e.action != "request.ack":  # an ack carries no content
            assert e.content_sha256 is not None and len(e.content_sha256) == 64
            assert e.content_length and e.content_length > 0

    reply_entry = entries[6]
    assert reply_entry.message_id == message_id and reply_entry.to == ["alice"]
    assert (reply_entry.content_sha256, reply_entry.content_length) == content_digest(
        {"text": secret_answer, "data": {"note": "private detail"}}
    )
    delivered = entries[2:4]
    assert [d.to for d in delivered] == [["bob"], ["carol"]]
    assert all(d.envelope_type == "question" and d.request_id == rid for d in delivered)
    notice = entries[8]
    assert notice.envelope_type == "no_response" and notice.to == ["alice"]
    assert entries[9].detail == "404 not_found" and entries[9].content_sha256 is None
    assert entries[11].envelope_type == "capability_call"


async def test_refusals_on_mutations_are_audited(client, clock, memory_store):
    rid = (
        await ask(
            client, to=["bob"], ack_timeout_seconds=60, answer_timeout_seconds=60, ttl_seconds=60
        )
    )["request_id"]
    await client.put(f"{T}/members/carol/manifest", headers=auth("bob"), json={})  # 403
    await post(
        client, "carol", f"/requests/{rid}/reply", {"idempotency_key": "reply-key-99", "text": "x"}
    )  # 404
    await post(client, "alice", "/requests", {"kind": "question", "from": "bob"})  # 422
    await reply(client, "bob", rid, key="reply-key-98")
    await reply(client, "bob", rid, key="reply-key-97")  # 409
    clock.advance(60)
    await post(client, "bob", f"/requests/{rid}/progress", {"text": "late"})  # 410
    refused = [
        (e.actor, e.action, e.detail, e.request_id)
        for e in await memory_store.list_audit("demo")
        if e.outcome == "refused"
    ]
    assert refused == [
        ("bob", "manifest.publish", "403 forbidden", None),
        ("carol", "request.reply", "404 not_found", rid),
        ("alice", "request.create", "422 invalid_body", None),
        ("bob", "request.reply", "409 already_answered", rid),
        ("bob", "request.progress", "410 expired", rid),
    ]


async def test_reads_are_not_audited(client, memory_store):
    rid = (await ask(client))["request_id"]
    before = len(await memory_store.list_audit("demo"))
    await get(client, "alice", "/me")
    await get(client, "alice", "/directory")
    await get(client, "alice", f"/requests/{rid}")
    await get(client, "carol", f"/requests/{rid}")  # a refused read
    await stream(client, "bob", "inbox")
    assert len(await memory_store.list_audit("demo")) == before


# Expired backlog through the API (§11.5) -------------------------------------------------------


async def test_an_expired_backlog_moves_the_stored_cursor(client, clock):
    for i in range(3):
        await ask(
            client,
            question=f"short-{i}",
            ack_timeout_seconds=60,
            answer_timeout_seconds=60,
            ttl_seconds=60,
        )
    await ask(client, question="long")
    clock.advance(60)
    page = await stream(client, "bob", "inbox")
    assert [m["data"]["question"] for m in page["messages"]] == ["long"]
    assert page["cursor"] == 3 and page["head"] == 4
    # An explicit `after` below the cursor reads but does not move it.
    page = await stream(client, "bob", "inbox", after=0)
    assert page["cursor"] == 3


async def test_a_long_poll_behind_an_expired_backlog_still_delivers(client, clock):
    for i in range(3):
        await ask(
            client,
            question=f"short-{i}",
            ack_timeout_seconds=60,
            answer_timeout_seconds=60,
            ttl_seconds=60,
        )
    clock.advance(60)
    poll = asyncio.create_task(get(client, "bob", "/streams/inbox", wait=2))
    await asyncio.sleep(0.1)
    await ask(client, question="fresh")
    body = (await poll).json()
    assert [m["data"]["question"] for m in body["messages"]] == ["fresh"]
    assert body["cursor"] == 3


# §11.6: the exact cursor and ack responses -------------------------------------------------------


async def test_cursor_returns_the_stored_cursor_after_the_update(client):
    for _ in range(3):
        await ask(client)
    path = "/streams/inbox/cursor"
    assert (await post(client, "bob", path, {"acked_seq": 2})).json() == {"cursor": 2}
    assert (await post(client, "bob", path, {"acked_seq": 1})).json() == {"cursor": 2}
    assert (await post(client, "bob", path, {"acked_seq": 0})).json() == {"cursor": 2}
    assert (await post(client, "bob", path, {"acked_seq": 2})).json() == {"cursor": 2}
    assert (await post(client, "bob", path, {"acked_seq": 3})).json() == {"cursor": 3}


async def test_ack_returns_the_recipients_resulting_status(client, clock):
    # pending -> acked
    rid = (await ask(client, to=["bob", "carol"], ack_timeout_seconds=10))["request_id"]
    r = await ack(client, "bob", rid)
    assert r.status_code == 200 and r.json() == {"status": "acked"}
    assert (await ack(client, "bob", rid)).json() == {"status": "acked"}
    # no_response -> acked
    clock.advance(10)
    await stream(client, "alice", "replies")
    assert (await status(client, "alice", rid)).json()["recipients"]["carol"]["status"] == (
        "no_response"
    )
    assert (await ack(client, "carol", rid)).json() == {"status": "acked"}
    # answered stays answered
    await reply(client, "bob", rid)
    assert (await ack(client, "bob", rid)).json() == {"status": "answered"}
    # timed_out stays timed_out
    clock.advance(1800)
    await stream(client, "alice", "replies")
    assert (await ack(client, "carol", rid)).json() == {"status": "timed_out"}
