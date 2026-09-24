"""M2-SPEC §3.1 (presence per session) and §3.2 (delivery times), through the HTTP API, on both
stores (``scripts/test-relay.sh`` runs the Firestore half against the emulator)."""

from __future__ import annotations

import pytest

from .conftest import Api

pytestmark = pytest.mark.anyio

T0 = "2026-09-23T12:00:00.000Z"


def at(seconds: int) -> str:
    minutes, secs = divmod(seconds, 60)
    return f"2026-09-23T12:{minutes:02d}:{secs:02d}.000Z"


# §3.1 -------------------------------------------------------------------------------------------


async def test_presence_is_recorded_per_session_and_throttled(api: Api):
    async def bob() -> dict:
        return (await api.directory("alice"))["bob"]

    assert (await bob())["sessions"] == {
        "working": {"last_seen": None},
        "answering": {"last_seen": None},
    }
    await api.stream("bob", "inbox")  # the answering session polls
    entry = await bob()
    assert entry["sessions"] == {"working": {"last_seen": None}, "answering": {"last_seen": T0}}
    assert entry["last_seen"] == T0

    api.clock.advance(14)
    await api.stream("bob", "inbox")  # within 15 s of the last write: not written
    await api.stream("bob", "replies")  # the working session has its own interval
    entry = await bob()
    assert entry["sessions"] == {
        "working": {"last_seen": at(14)},
        "answering": {"last_seen": T0},
    }
    assert entry["last_seen"] == at(14)  # the later of the two

    api.clock.advance(1)
    await api.stream("bob", "inbox")  # 15 s after the last write: written
    await api.stream("bob", "replies")  # 1 s after its last write: not written
    entry = await bob()
    assert entry["sessions"] == {
        "working": {"last_seen": at(14)},
        "answering": {"last_seen": at(15)},
    }
    assert entry["last_seen"] == at(15)

    api.clock.advance(14)
    await api.stream("bob", "replies")
    assert (await bob())["sessions"]["working"] == {"last_seen": at(29)}


async def test_presence_is_the_callers_own(api: Api):
    await api.stream("alice", "replies")
    await api.stream("alice", "inbox")
    directory = await api.directory("bob")
    assert directory["alice"]["sessions"] == {
        "working": {"last_seen": T0},
        "answering": {"last_seen": T0},
    }
    assert directory["carol"]["sessions"] == {
        "working": {"last_seen": None},
        "answering": {"last_seen": None},
    }
    assert "bob" not in directory  # never the caller


async def test_a_refused_read_records_no_presence(api: Api):
    r = await api.get("bob", "/streams/inbox", limit="0")
    assert r.status_code == 400
    assert (await api.directory("alice"))["bob"]["sessions"]["answering"] == {"last_seen": None}


# §3.2 -------------------------------------------------------------------------------------------


async def test_delivered_at_is_stamped_when_the_answering_session_moves_its_cursor(api: Api):
    rid = await api.ask(to=["bob", "carol"])
    api.clock.advance(2)
    [message] = await api.consume("bob", "inbox")
    assert message["request_id"] == rid
    api.clock.advance(1)
    await api.stream("carol", "inbox")  # read, but the cursor has not moved: not delivered
    entry = await api.feed_entry("alice", rid)
    assert entry["recipients"]["bob"]["delivered_at"] == at(2)
    assert entry["recipients"]["carol"]["delivered_at"] is None
    assert entry["updated_at"] == at(2)

    api.clock.advance(1)
    await api.cursor("carol", "inbox", 1)
    entry = await api.feed_entry("alice", rid)
    assert entry["recipients"]["carol"]["delivered_at"] == at(4)
    assert entry["recipients"]["bob"]["delivered_at"] == at(2)
    assert entry["updated_at"] == at(4)


async def test_answer_delivered_at_is_stamped_when_the_asker_moves_its_cursor(api: Api):
    rid = await api.ask(to=["bob"])
    api.clock.advance(5)
    await api.reply("bob", rid)
    entry = await api.feed_entry("alice", rid)
    assert entry["recipients"]["bob"]["answered_at"] == at(5)
    assert entry["recipients"]["bob"]["answer_delivered_at"] is None  # not yet read

    api.clock.advance(2)
    [answer] = await api.consume("alice", "replies")
    assert answer["type"] == "answer"
    entry = await api.feed_entry("alice", rid)
    assert entry["recipients"]["bob"]["answer_delivered_at"] == at(7)
    assert entry["updated_at"] == at(7)


async def test_capability_calls_are_stamped_when_delivered(api: Api):
    await api.publish("bob")
    rid = await api.invoke()
    api.clock.advance(3)
    [call] = await api.consume("bob", "inbox")
    assert call["type"] == "capability_call"
    assert (await api.feed_entry("alice", rid))["recipients"]["bob"]["delivered_at"] == at(3)


async def test_notices_set_no_delivery_time_and_a_late_answer_does(api: Api):
    rid = await api.ask(to=["carol"], ack_timeout_seconds=2)
    api.clock.advance(3)
    [notice] = await api.consume("alice", "replies")  # the sweep writes it, alice reads it
    assert notice["type"] == "no_response"
    entry = await api.feed_entry("alice", rid)
    assert entry["recipients"]["carol"]["status"] == "no_response"
    assert entry["recipients"]["carol"]["answer_delivered_at"] is None

    api.clock.advance(10)
    await api.reply("carol", rid)
    api.clock.advance(1)
    [answer] = await api.consume("alice", "replies")
    assert answer["type"] == "answer" and answer["from"] == "carol"
    assert (await api.feed_entry("alice", rid))["recipients"]["carol"]["answer_delivered_at"] == at(
        14
    )


async def test_delivery_times_are_never_overwritten(api: Api):
    rid = await api.ask(to=["bob"])
    api.clock.advance(1)
    await api.consume("bob", "inbox")
    await api.reply("bob", rid)
    await api.consume("alice", "replies")
    first = await api.feed_entry("alice", rid)
    assert first["recipients"]["bob"]["delivered_at"] == at(1)
    assert first["recipients"]["bob"]["answer_delivered_at"] == at(1)

    api.clock.advance(30)
    # The same acks again, and acks below the cursor: the cursor does not move, nothing is
    # stamped, and updated_at stays.
    for member, name in (("bob", "inbox"), ("alice", "replies")):
        for seq in (1, 0):
            r = await api.cursor(member, name, seq)
            assert r.status_code == 200 and r.json() == {"cursor": 1}
    assert await api.feed_entry("alice", rid) == first


async def test_the_automatic_advance_stamps_nothing_for_expired_requests(api: Api):
    # §11.5 moves bob's cursor past the expired question; an envelope expires with its
    # request, so there is nothing live to stamp, and the expired request is left alone.
    gone = await api.ask(
        to=["bob"], ack_timeout_seconds=60, answer_timeout_seconds=60, ttl_seconds=60
    )
    api.clock.advance(30)
    live = await api.ask(to=["bob"])
    api.clock.advance(31)
    page = await api.stream("bob", "inbox")
    assert [m["request_id"] for m in page["messages"]] == [live] and page["cursor"] == 1
    stored = await api.store.get_request(api.team, gone)
    assert stored.recipients["bob"].delivered_at is None
    assert stored.updated_at == stored.created_at
    assert (await api.feed_entry("alice", live))["recipients"]["bob"]["delivered_at"] is None
    await api.cursor("bob", "inbox", 2)
    assert (await api.feed_entry("alice", live))["recipients"]["bob"]["delivered_at"] == at(61)


async def test_a_cursor_beyond_the_head_stamps_nothing(api: Api):
    rid = await api.ask(to=["bob"])
    r = await api.cursor("bob", "inbox", 2)
    assert r.status_code == 400 and r.json()["error"] == "beyond_head"
    assert (await api.feed_entry("alice", rid))["recipients"]["bob"]["delivered_at"] is None
