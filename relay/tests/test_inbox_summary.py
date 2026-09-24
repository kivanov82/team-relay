"""M7-SPEC §1: GET /inbox/summary (what waits for the member's answering session) and the
directory's ``inbox_waiting``, through the HTTP API on both stores (``scripts/test-relay.sh``
runs the Firestore half against the emulator). Synthetic identities only."""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from typing import Any

import pytest

from relay.service import INBOX_SUMMARY_CAP, new_message_id
from relay.store import Envelope

from .conftest import (
    DELEGATES,
    EMAILS,
    START,
    Api,
    FakeClock,
    open_api,
)
from .test_store_contract import audit, make_request, record_for

pytestmark = pytest.mark.anyio

T0 = "2026-09-23T12:00:00.000Z"
EMPTY = {
    "pending": 0,
    "more": False,
    "oldest_at": None,
    "from": [],
    "answering": {"last_seen": None},
}


def at(seconds: int) -> str:
    minutes, secs = divmod(seconds, 60)
    return f"2026-09-23T12:{minutes:02d}:{secs:02d}.000Z"


async def summary(api: Api, member: str) -> dict[str, Any]:
    r = await api.get(member, "/inbox/summary")
    assert r.status_code == 200, r.text
    return r.json()


async def plant(api: Api, to: str, sender: str, *, ttl: timedelta = timedelta(days=7)) -> None:
    """One question from ``sender`` in ``to``'s inbox, written straight into the store (so a
    sender need not be on the roster, and many can be written quickly)."""
    doc = make_request(api.team, asker=sender, recipients=(to,))
    now = api.clock.current
    env = Envelope(
        id=new_message_id(),
        team=api.team,
        stream="inbox",
        type="question",
        sender=sender,
        to=to,
        request_id=doc.request_id,
        broadcast=False,
        time=now,
        expire_at=now + ttl,
        data={"question": "What is the status?"},
    )
    key = "k-" + uuid.uuid4().hex
    entries = [audit(api.team, request_id=doc.request_id)]
    outcome = await api.store.create_request(
        api.team, key, record_for(doc), doc, [env], entries, now
    )
    assert outcome.created


# The summary ------------------------------------------------------------------------------------


async def test_an_empty_inbox(api: Api):
    assert await summary(api, "bob") == EMPTY


async def test_counts_senders_and_the_oldest_waiting_message(api: Api):
    await api.ask("alice", to=["bob"])
    api.clock.advance(5)
    await api.ask("carol", to=["bob"])
    api.clock.advance(5)
    await api.ask("alice", to=["bob", "carol"])
    await api.publish("bob")
    await api.invoke("carol", to="bob")  # a capability call waits too

    assert await summary(api, "bob") == {
        "pending": 4,
        "more": False,
        "oldest_at": T0,
        "from": ["alice", "carol"],  # distinct, in the order they first wrote
        "answering": {"last_seen": None},
    }
    # Each member's own inbox only.
    got = await summary(api, "carol")
    assert got["pending"] == 1 and got["from"] == ["alice"] and got["oldest_at"] == at(10)
    assert await summary(api, "alice") == EMPTY


async def test_what_the_answering_session_consumed_is_no_longer_waiting(api: Api):
    first = await api.ask("alice", to=["bob"])
    api.clock.advance(3)
    await api.ask("carol", to=["bob"])
    page = await api.stream("bob", "inbox")
    assert (await api.cursor("bob", "inbox", page["messages"][0]["seq"])).status_code == 200
    assert page["messages"][0]["request_id"] == first

    got = await summary(api, "bob")
    assert got["pending"] == 1 and got["from"] == ["carol"] and got["oldest_at"] == at(3)
    # The answering session's poll is its presence.
    assert got["answering"] == {"last_seen": at(3)}

    await api.consume("bob", "inbox")
    got = await summary(api, "bob")
    assert {k: got[k] for k in ("pending", "more", "oldest_at", "from")} == {
        "pending": 0,
        "more": False,
        "oldest_at": None,
        "from": [],
    }


async def test_expired_messages_are_skipped(api: Api):
    await api.ask("alice", to=["bob"], answer_timeout_seconds=60, ttl_seconds=60)
    api.clock.advance(30)
    await api.ask("carol", to=["bob"])
    api.clock.advance(31)  # the first has expired, the second has not

    got = await summary(api, "bob")
    assert got["pending"] == 1 and got["from"] == ["carol"] and got["oldest_at"] == at(30)

    api.clock.advance(7 * 86400)  # the default ttl: everything has expired
    assert await summary(api, "bob") == EMPTY


async def test_the_count_stops_at_50_and_says_there_are_more(api: Api):
    senders = [f"sender{i}" for i in range(7)]
    for i in range(INBOX_SUMMARY_CAP):
        await plant(api, "bob", senders[i % len(senders)])
        api.clock.advance(1)
    got = await summary(api, "bob")
    # Exactly 50: all counted, nothing more.
    assert got["pending"] == 50 and got["more"] is False
    assert got["from"] == senders[:5]  # at most five names
    assert got["oldest_at"] == T0

    await plant(api, "bob", "sender9")
    got = await summary(api, "bob")
    assert got["pending"] == 50 and got["more"] is True

    # The directory's count is capped the same way.
    assert (await api.directory("alice"))["bob"]["inbox_waiting"] == 50


async def test_more_is_about_the_stream_past_the_read(api: Api):
    """The read stops at 50 (M7-SPEC §1), so ``more`` says the stream holds messages past
    it; only unexpired messages are ever in the count."""
    for _ in range(INBOX_SUMMARY_CAP - 1):
        await plant(api, "bob", "alice")
    await plant(api, "bob", "carol", ttl=timedelta(seconds=5))
    await plant(api, "bob", "carol")
    got = await summary(api, "bob")
    assert got["pending"] == 50 and got["more"] is True
    api.clock.advance(6)  # one inside the read has expired: the 51st moves into it
    got = await summary(api, "bob")
    assert got["pending"] == 50 and got["more"] is False


async def test_the_summary_writes_no_presence_and_moves_no_cursor(api: Api):
    rid = await api.ask("alice", to=["bob"], answer_timeout_seconds=60, ttl_seconds=60)
    api.clock.advance(61)  # expired, right at bob's cursor: a stream read would skip past it
    live = await api.ask("carol", to=["bob"])

    for _ in range(3):
        assert (await summary(api, "bob"))["pending"] == 1

    # Nothing was written: the cursor is where it was, no delivery was stamped, and neither
    # of bob's sessions was seen.
    peek = await api.store.read_stream(
        api.team, "bob", "inbox", None, 50, api.clock.current, advance=False
    )
    assert peek.cursor == 0 and peek.head == 2
    for request_id in (rid, live):
        doc = await api.store.get_request(api.team, request_id)
        assert doc is not None and doc.recipients["bob"].delivered_at is None
    entry = (await api.directory("alice"))["bob"]
    assert entry["last_seen"] is None
    assert entry["sessions"] == {"working": {"last_seen": None}, "answering": {"last_seen": None}}

    # The answering session still gets the live question, once.
    messages = await api.consume("bob", "inbox")
    assert [m["request_id"] for m in messages] == [live]


# The read budget --------------------------------------------------------------------------------


@pytest.fixture(params=["memory", "firestore"])
async def budget_api(request: pytest.FixtureRequest, clock: FakeClock):
    async with open_api(request.param, clock, reads_per_minute=3) as opened:
        yield opened


async def test_the_summary_counts_against_the_read_budget(budget_api: Api, capsys):
    api = budget_api
    assert (await api.get("bob", "/inbox/summary")).status_code == 200
    assert (await api.get("bob", "/directory")).status_code == 200
    assert (await api.get("bob", "/activity")).status_code == 200
    r = await api.get("bob", "/inbox/summary")
    assert r.status_code == 429 and r.json()["error"] == "rate_limited"
    refused = [
        json.loads(line)
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("{") and '"read_refused"' in line
    ]
    assert [(e["member"], e["endpoint"]) for e in refused] == [("bob", "inbox_summary")]
    # Not audited: a read is not a mutation.
    assert not [e for e in await api.store.list_audit(api.team) if e.outcome == "refused"]
    # Per member.
    assert (await api.get("alice", "/inbox/summary")).status_code == 200
    api.clock.advance(60)
    assert (await api.get("bob", "/inbox/summary")).status_code == 200


# Through the console's delegate -----------------------------------------------------------------


async def test_a_delegate_reads_the_member_it_names(api: Api, capsys):
    await api.ask("alice", to=["bob"])
    capsys.readouterr()
    r = await api.delegated("GET", "/inbox/summary", EMAILS["bob"])
    assert r.status_code == 200, r.text
    assert r.json()["pending"] == 1 and r.json()["from"] == ["alice"]
    r = await api.delegated("GET", "/inbox/summary", EMAILS["alice"])
    assert r.status_code == 200 and r.json() == EMPTY

    lines = [
        json.loads(line)
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("{") and '"delegated_read"' in line
    ]
    assert [(e["member"], e["delegate"]) for e in lines] == [
        ("bob", DELEGATES["demo"]),
        ("alice", DELEGATES["demo"]),
    ]
    assert all(e["path"] == f"/v1/teams/{api.team}/inbox/summary" for e in lines)
    # No presence for anyone, and bob's question is still waiting.
    entry = (await api.directory("carol"))["bob"]
    assert entry["sessions"]["answering"] == {"last_seen": None}
    assert (await summary(api, "bob"))["pending"] == 1


async def test_another_teams_delegate_reads_nothing_here(api: Api):
    r = await api.delegated("GET", "/inbox/summary", EMAILS["bob"], delegate="other")
    assert r.status_code == 403 and r.json()["error"] == "not_a_member"
    r = await api.delegated("GET", "/inbox/summary", EMAILS["dave"], delegate="other")
    assert r.status_code == 404


async def test_the_summary_needs_a_caller(api: Api):
    r = await api.client.get(api.url("/inbox/summary"))
    assert r.status_code == 401


# The directory ----------------------------------------------------------------------------------


async def test_the_directory_names_each_teammates_waiting_count(api: Api):
    await api.ask("alice", to=["bob"])
    await api.ask("alice", to=["bob", "carol"])
    view = await api.directory("carol")
    assert view["bob"]["inbox_waiting"] == 2
    assert view["alice"]["inbox_waiting"] == 0
    # Team-wide metadata, like presence: every member sees the same counts.
    assert (await api.directory("alice"))["carol"]["inbox_waiting"] == 1


async def test_the_directory_count_is_cached_with_the_stats(api: Api):
    await api.ask("alice", to=["bob"])
    assert (await api.directory("carol"))["bob"]["inbox_waiting"] == 1

    api.clock.current = START + timedelta(seconds=5)
    await api.ask("alice", to=["bob"])
    await api.consume("bob", "inbox")  # presence is never cached; the count is
    api.clock.current = START + timedelta(seconds=9.999)
    view = await api.directory("carol")
    assert view["bob"]["inbox_waiting"] == 1  # the cached count
    assert view["bob"]["sessions"]["answering"]["last_seen"] == at(5)
    assert (await summary(api, "bob"))["pending"] == 0  # the summary is never cached

    api.clock.current = START + timedelta(seconds=10)  # 10 s old: recomputed
    assert (await api.directory("carol"))["bob"]["inbox_waiting"] == 0
