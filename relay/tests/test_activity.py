"""M2-SPEC §3.5 (the activity feed, with participant masking) and §3.6 (the directory's 24-hour
stats), through the HTTP API, on both stores."""

from __future__ import annotations

from datetime import timedelta

import pytest

from relay import service as service_module
from relay.clock import format_time

from .conftest import START, Api, auth

pytestmark = pytest.mark.anyio

T0 = "2026-09-23T12:00:00.000Z"


def at(seconds: float) -> str:
    return format_time(START + timedelta(seconds=seconds))  # type: ignore[return-value]


def ids(feed: dict) -> list[str]:
    return [e["request_id"] for e in feed["requests"]]


# The shape --------------------------------------------------------------------------------------


async def test_the_feed_entry_for_the_asker(api: Api):
    await api.publish("bob")
    rid = await api.invoke(dataset="orders", limit=5)
    api.clock.advance(1)
    await api.consume("bob", "inbox")
    api.clock.advance(1)
    await api.ack("bob", rid)
    api.clock.advance(1)
    await api.post(
        "bob",
        f"/requests/{rid}/events",
        {"tool": "staging_db_query", "status": "ok", "duration_ms": 850},
    )
    await api.post("bob", f"/requests/{rid}/progress", {"text": "half", "pct": 50})
    api.clock.advance(1)
    await api.reply("bob", rid, text="5 rows")
    api.clock.advance(1)
    await api.consume("alice", "replies")

    feed = await api.activity("alice")
    assert feed["server_time"] == at(5) and feed["next_since"] == at(5)
    assert feed["requests"] == [
        {
            "request_id": rid,
            "kind": "capability",
            "asker": "alice",
            "broadcast": False,
            "created_at": T0,
            "updated_at": at(5),
            "ack_deadline": at(120),
            "answer_deadline": at(1800),
            "expire_at": at(604800),
            "capability": {
                "name": "staging_db_query",
                "environment": "staging",
                "params": {"dataset": "orders", "limit": 5},
            },
            "question": None,
            "recipients": {
                "bob": {
                    "status": "answered",
                    "delivered_at": at(1),
                    "acked_at": at(2),
                    "answered_at": at(4),
                    "answer_delivered_at": at(5),
                    "tools": [
                        {
                            "tool": "staging_db_query",
                            "status": "ok",
                            "at": at(3),
                            "duration_ms": 850,
                        }
                    ],
                    "progress_count": 1,
                    "last_progress_pct": 50,
                    "answer_preview": "5 rows",
                }
            },
            "participant": True,
        }
    ]


async def test_a_fresh_question_has_empty_recipient_state(api: Api):
    rid = await api.ask(to=["bob"], question="Is the deploy green?")
    entry = await api.feed_entry("alice", rid)
    assert entry["question"] == "Is the deploy green?" and entry["capability"] is None
    assert entry["recipients"]["bob"] == {
        "status": "pending",
        "delivered_at": None,
        "acked_at": None,
        "answered_at": None,
        "answer_delivered_at": None,
        "tools": [],
        "progress_count": 0,
        "last_progress_pct": None,
        "answer_preview": None,
    }
    assert entry["updated_at"] == entry["created_at"] == T0


# Masking ----------------------------------------------------------------------------------------


async def test_a_non_participant_sees_metadata_but_no_text_or_params(api: Api):
    await api.publish("bob")
    question = await api.ask(to=["bob"], question="What is in the secret bucket?")
    call = await api.invoke(dataset="users")
    for rid in (question, call):
        await api.post("bob", f"/requests/{rid}/events", {"tool": "Read", "status": "ok"})
        await api.post("bob", f"/requests/{rid}/progress", {"text": "private step", "pct": 10})
        await api.reply("bob", rid, text="the private answer")

    carol = {e["request_id"]: e for e in (await api.activity("carol"))["requests"]}
    assert set(carol) == {question, call}
    for entry in carol.values():
        assert entry["participant"] is False
        assert entry["question"] is None
        bob = entry["recipients"]["bob"]
        assert bob["answer_preview"] is None
        # Metadata stays visible.
        assert bob["status"] == "answered" and bob["answered_at"] == T0
        assert bob["tools"] == [{"tool": "Read", "status": "ok", "at": T0, "duration_ms": None}]
        assert bob["progress_count"] == 1 and bob["last_progress_pct"] == 10
        assert entry["asker"] == "alice"
    assert carol[call]["capability"] == {
        "name": "staging_db_query",
        "environment": "staging",
        "params": None,
    }
    text = repr(carol)
    for secret in ("secret bucket", "private answer", "private step", "users"):
        assert secret not in text

    for member in ("alice", "bob"):  # both participants see the text
        entries = {e["request_id"]: e for e in (await api.activity(member))["requests"]}
        assert entries[question]["question"] == "What is in the secret bucket?"
        assert entries[question]["participant"] is True
        assert entries[call]["capability"]["params"] == {"dataset": "users", "limit": 20}
        assert entries[question]["recipients"]["bob"]["answer_preview"] == "the private answer"


async def test_on_a_broadcast_a_recipient_sees_only_their_own_answer_preview(api: Api):
    rid = await api.ask(to="*", question="Who has the staging key?")
    await api.reply("bob", rid, text="bob's answer")
    await api.reply("carol", rid, text="carol's answer")

    alice = await api.feed_entry("alice", rid)
    assert alice["broadcast"] is True
    assert {m: s["answer_preview"] for m, s in alice["recipients"].items()} == {
        "bob": "bob's answer",
        "carol": "carol's answer",
    }
    for me, other in (("bob", "carol"), ("carol", "bob")):
        entry = await api.feed_entry(me, rid)
        assert entry["participant"] is True
        assert entry["question"] == "Who has the staging key?"
        assert entry["recipients"][me]["answer_preview"] == f"{me}'s answer"
        assert entry["recipients"][other]["answer_preview"] is None
        assert entry["recipients"][other]["status"] == "answered"  # metadata


async def test_the_feed_is_per_team(api: Api):
    await api.ask(to=["bob"])
    r = await api.client.get("/v1/teams/other/activity", headers=auth("dave"))
    assert r.status_code == 200 and r.json()["requests"] == []
    r = await api.client.get(api.url("/activity"), headers=auth("dave"))
    assert r.status_code == 404 and r.json() == {"error": "not_found"}
    assert (await api.client.get(api.url("/activity"))).status_code == 401


# since, limit, next_since -----------------------------------------------------------------------


async def test_the_feed_is_incremental(api: Api):
    first = await api.ask(to=["bob"])
    feed = await api.activity("alice")
    assert ids(feed) == [first] and feed["next_since"] == T0
    again = await api.activity("alice", since=feed["next_since"])
    assert again["requests"] == [] and again["next_since"] == T0

    api.clock.advance(1)
    await api.ack("bob", first)
    api.clock.advance(1)
    second = await api.ask(to=["carol"])
    feed = await api.activity("alice", since=T0)
    assert ids(feed) == [first, second]  # ascending by updated_at
    assert [e["updated_at"] for e in feed["requests"]] == [at(1), at(2)]
    assert feed["next_since"] == at(2)
    feed = await api.activity("alice", since=at(1))
    assert ids(feed) == [second]


async def test_an_omitted_since_is_the_last_24_hours(api: Api):
    old = await api.ask(to=["bob"])
    api.clock.advance(24 * 3600)
    assert ids(await api.activity("alice")) == []  # updated exactly 24 h ago: not after
    recent = await api.ask(to=["bob"])
    feed = await api.activity("alice")
    assert ids(feed) == [recent]
    assert ids(await api.activity("alice", since="2026-09-01T00:00:00Z")) == [old, recent]


async def test_limit_and_paging(api: Api):
    made = []
    for _ in range(5):
        made.append(await api.ask(to=["bob"]))
        api.clock.advance(1)
    feed = await api.activity("alice", limit="2")
    assert ids(feed) == made[:2] and feed["next_since"] == at(1)
    feed = await api.activity("alice", limit="2", since=feed["next_since"])
    assert ids(feed) == made[2:4] and feed["next_since"] == at(3)
    feed = await api.activity("alice", limit="2", since=feed["next_since"])
    assert ids(feed) == made[4:] and feed["next_since"] == at(4)


async def test_a_page_never_splits_requests_with_the_same_updated_at(api: Api):
    first = await api.ask(to=["bob"])
    api.clock.advance(1)
    tied = sorted([await api.ask(to=["bob"]), await api.ask(to=["carol"])])  # same instant
    api.clock.advance(1)
    last = await api.ask(to=["bob"])

    # limit 2 would end between the two tied requests: the page stops before them.
    feed = await api.activity("alice", limit="2", since="2026-09-01T00:00:00Z")
    assert ids(feed) == [first] and feed["next_since"] == T0
    feed = await api.activity("alice", limit="2", since=feed["next_since"])
    assert ids(feed) == tied and feed["next_since"] == at(1)
    feed = await api.activity("alice", limit="2", since=feed["next_since"])
    assert ids(feed) == [last]

    # A page that is one whole group returns all of it, even beyond the limit.
    feed = await api.activity("alice", limit="1", since=T0)
    assert ids(feed) == tied and feed["next_since"] == at(1)


async def test_a_whole_group_page_is_capped_at_the_max_group(api: Api, monkeypatch):
    # M2-SPEC §7.10: a page may exceed `limit` to keep a group whole, up to 500 requests.
    assert service_module.ACTIVITY_MAX_GROUP == 500
    monkeypatch.setattr(service_module, "ACTIVITY_MAX_GROUP", 2)
    tied = sorted([await api.ask(to=["bob"]) for _ in range(3)])  # one instant
    feed = await api.activity("alice", limit="1", since="2026-09-01T00:00:00Z")
    assert ids(feed) == tied[:2] and feed["next_since"] == T0


async def test_expired_requests_are_passed_but_never_returned(api: Api):
    short = await api.ask(
        to=["bob"], ack_timeout_seconds=60, answer_timeout_seconds=60, ttl_seconds=60
    )
    api.clock.advance(1)
    kept = await api.ask(to=["bob"])
    api.clock.advance(60)
    feed = await api.activity("alice", limit="1", since="2026-09-01T00:00:00Z")
    assert feed["requests"] == [] and feed["next_since"] == T0  # moved past it anyway
    feed = await api.activity("alice", limit="1", since=feed["next_since"])
    assert ids(feed) == [kept]
    assert short not in ids(await api.activity("alice"))


@pytest.mark.parametrize(
    "params",
    [
        {"limit": "0"},
        {"limit": "201"},
        {"limit": "-1"},
        {"limit": "x"},
        {"limit": ""},
        {"since": "yesterday"},
        {"since": "2026-09-23"},
        {"since": "2026-09-23T12:00:00"},  # no zone
        {"since": "2026-09-23 12:00:00Z"},
        {"since": "2026-09-23T25:00:00Z"},
        {"since": "2026-02-30T12:00:00Z"},
        {"since": "2026-W39-3T12:00:00Z"},
        {"since": "2026-09-23T12:00:00.Z"},
        {"since": "2026-09-23T12:00:00Z" + " " * 30},
        {"since": ""},
    ],
)
async def test_bad_query_parameters_are_400(api: Api, params: dict[str, str]):
    r = await api.get("alice", "/activity", **params)
    assert r.status_code == 400 and r.json()["error"] == "invalid_query"


@pytest.mark.parametrize(
    "since",
    [
        "2026-09-23T11:59:59Z",
        "2026-09-23T11:59:59.999z",
        "2026-09-23t13:59:59.5+02:00",
        "2026-09-23T11:59:59.999999999Z",  # nanoseconds are truncated, never rounded up
    ],
)
async def test_since_is_rfc_3339_with_any_zone(api: Api, since: str):
    rid = await api.ask(to=["bob"])
    assert ids(await api.activity("alice", since=since)) == [rid]
    assert ids(await api.activity("alice", since="2026-09-23T14:00:00+02:00")) == []


async def test_next_since_is_since_when_nothing_is_new(api: Api):
    feed = await api.activity("alice", since="2026-09-23T14:00:00+02:00")
    assert feed == {"requests": [], "next_since": T0, "server_time": T0}
    feed = await api.activity("alice")
    assert feed["next_since"] == at(-24 * 3600)


# updated_at on every change ----------------------------------------------------------------------


async def test_updated_at_moves_on_every_change_and_only_then(api: Api):
    rid = await api.ask(to=["bob"])

    async def updated() -> str:
        return (await api.feed_entry("alice", rid))["updated_at"]

    steps = [
        (lambda: api.ack("bob", rid), at(1)),
        (lambda: api.ack("bob", rid), at(1)),  # unchanged: no write
        (lambda: api.post("bob", f"/requests/{rid}/progress", {"text": "a"}), at(3)),
        (
            lambda: api.post("bob", f"/requests/{rid}/events", {"tool": "Read", "status": "ok"}),
            at(4),
        ),
        (lambda: api.consume("bob", "inbox"), at(5)),  # delivered_at
        (lambda: api.get("alice", f"/requests/{rid}"), at(5)),  # a read
        (lambda: api.post("carol", f"/requests/{rid}/progress", {"text": "a"}), at(5)),  # 404
        (lambda: api.reply("bob", rid), at(8)),
        (
            lambda: api.post(
                "bob", f"/requests/{rid}/reply", {"idempotency_key": "other-key-1", "text": "b"}
            ),
            at(8),
        ),  # 409
        (lambda: api.consume("alice", "replies"), at(10)),  # answer_delivered_at
    ]
    for i, (step, expected) in enumerate(steps, start=1):
        api.clock.advance(1)
        await step()
        assert await updated() == expected, i


async def test_the_sweep_moves_updated_at(api: Api):
    rid = await api.ask(to=["bob"], ack_timeout_seconds=2)
    api.clock.advance(3)
    await api.stream("alice", "replies")  # the asker's poll runs the sweep
    entry = await api.feed_entry("carol", rid)
    assert entry["recipients"]["bob"]["status"] == "no_response"
    assert entry["updated_at"] == at(3)


# §3.6 directory stats ----------------------------------------------------------------------------


async def test_directory_stats_over_the_last_24_hours(api: Api):
    answered = [await api.ask(to=["bob"]) for _ in range(4)]
    for rid, seconds in zip(answered, (10, 30, 40, 100), strict=True):
        api.clock.current = START + timedelta(seconds=seconds)
        await api.reply("bob", rid)
    api.clock.current = START + timedelta(seconds=200)
    pending = await api.ask(to=["bob", "carol"])
    await api.ack("carol", pending)
    await api.ask("carol", to=["alice"])

    bob_view = await api.directory("bob")
    assert bob_view["alice"]["stats"] == {
        "asked": 5,
        "answered": 0,
        "open": 1,
        "median_answer_seconds": None,
    }
    assert bob_view["carol"]["stats"] == {
        "asked": 1,
        "answered": 0,
        "open": 1,  # acked, not answered
        "median_answer_seconds": None,
    }
    alice_view = await api.directory("alice")
    assert alice_view["bob"]["stats"] == {
        "asked": 0,
        "answered": 4,
        "open": 1,
        "median_answer_seconds": 35.0,  # of 10, 30, 40 and 100
    }
    r = await api.get("alice", "/directory")
    assert r.json()["stats_complete"] is True


async def test_directory_open_counts_a_recipient_only_before_its_deadline(api: Api, monkeypatch):
    # M2-SPEC §7.2. Neither the directory nor the feed runs the sweep: the feed keeps
    # reporting the stored status, while `open` already leaves out a recipient whose
    # relevant deadline has passed. (No stats cache here: the checks are 1 ms apart.)
    monkeypatch.setattr(service_module, "STATS_CACHE_TTL", timedelta(0))
    rid = await api.ask(to=["bob", "carol"], ack_timeout_seconds=20, answer_timeout_seconds=60)
    await api.ack("carol", rid)

    async def opened() -> tuple[int, int]:
        view = await api.directory("alice")
        return view["bob"]["stats"]["open"], view["carol"]["stats"]["open"]

    async def statuses() -> tuple[str, str]:
        entry = await api.feed_entry("alice", rid)
        return entry["recipients"]["bob"]["status"], entry["recipients"]["carol"]["status"]

    assert await opened() == (1, 1)
    api.clock.current = START + timedelta(seconds=19.999)
    assert await opened() == (1, 1)
    api.clock.current = START + timedelta(seconds=20)  # bob's ack deadline: no longer open
    assert await opened() == (0, 1)
    assert await statuses() == ("pending", "acked")  # the feed is unchanged
    api.clock.current = START + timedelta(seconds=59.999)
    assert await opened() == (0, 1)
    api.clock.current = START + timedelta(seconds=60)  # carol's answer deadline
    assert await opened() == (0, 0)
    assert await statuses() == ("pending", "acked")

    await api.stream("alice", "replies")  # the asker's poll runs the sweep
    assert await statuses() == ("no_response", "timed_out")
    assert await opened() == (0, 0)


async def test_stats_complete_is_part_of_every_directory_response(api: Api, monkeypatch):
    # M2-SPEC §7.10.
    r = await api.get("alice", "/directory")
    assert set(r.json()) == {"members", "stats_complete"}
    assert r.json()["stats_complete"] is True  # nothing at all: complete
    monkeypatch.setattr(service_module, "STATS_READ_CAP", 1)
    monkeypatch.setattr(service_module, "STATS_CACHE_TTL", timedelta(0))
    await api.ask(to=["bob"])
    assert (await api.get("alice", "/directory")).json()["stats_complete"] is False
    r = await api.client.get("/v1/teams/other/directory", headers=auth("dave"))
    assert r.json() == {"members": [], "stats_complete": True}


async def test_directory_stats_leave_out_old_and_expired_requests(api: Api):
    old = await api.ask(to=["bob"], answer_timeout_seconds=86400)
    await api.ask(to=["bob"], ack_timeout_seconds=60, answer_timeout_seconds=60, ttl_seconds=60)
    api.clock.advance(25 * 3600)
    await api.reply("bob", old)  # created 25 h ago, answered now
    fresh = await api.ask(to=["bob"])
    api.clock.advance(3)
    await api.reply("bob", fresh)
    stats = await api.directory("carol")
    assert stats["alice"]["stats"]["asked"] == 1  # only `fresh` was created in the window
    assert stats["bob"]["stats"] == {
        "asked": 0,
        "answered": 2,  # answers given in the window, whenever the request was created
        "open": 0,  # the expired one is left out, though it never got an answer
        "median_answer_seconds": (25 * 3600 + 3) / 2,  # of 90000 and 3
    }
    api.clock.advance(24 * 3600)
    assert (await api.directory("carol"))["bob"]["stats"] == {
        "asked": 0,
        "answered": 0,
        "open": 0,
        "median_answer_seconds": None,
    }


async def test_directory_stats_read_at_most_the_cap(api: Api, monkeypatch):
    monkeypatch.setattr(service_module, "STATS_READ_CAP", 2)
    for _ in range(3):
        await api.ask(to=["bob"])
        api.clock.advance(1)
    r = await api.get("carol", "/directory")
    body = r.json()
    assert body["stats_complete"] is False
    alice = next(m for m in body["members"] if m["member"] == "alice")
    assert alice["stats"]["asked"] == 2  # the two most recently updated only


async def test_directory_stats_leave_out_expired_requests_inside_the_window(api: Api):
    short = {"ack_timeout_seconds": 60, "answer_timeout_seconds": 60, "ttl_seconds": 60}
    rid = await api.ask(to=["bob"], **short)
    await api.reply("bob", rid)
    await api.ask(to=["carol"], **short)
    live = await api.directory("bob")
    assert live["alice"]["stats"]["asked"] == 2 and live["carol"]["stats"]["open"] == 1
    assert (await api.directory("alice"))["bob"]["stats"]["answered"] == 1
    api.clock.advance(60)  # both expire, well inside the 24-hour window
    assert (await api.directory("bob"))["alice"]["stats"]["asked"] == 0
    assert (await api.directory("bob"))["carol"]["stats"]["open"] == 0
    assert (await api.directory("alice"))["bob"]["stats"] == {
        "asked": 0,
        "answered": 0,
        "open": 0,
        "median_answer_seconds": None,
    }


# §7.3 the stats cache and the read budget --------------------------------------------------------


def count_stats_reads(api: Api, monkeypatch) -> list[str]:
    """Record the team of every stats read (the directory's one query) the store serves."""
    teams: list[str] = []
    real = api.store.requests_updated_after

    async def counted(team, since, limit, *, descending=False):
        teams.append(team)
        return await real(team, since, limit, descending=descending)

    monkeypatch.setattr(api.store, "requests_updated_after", counted)
    return teams


async def test_directory_stats_are_cached_per_team_for_10_seconds(api: Api, monkeypatch):
    reads = count_stats_reads(api, monkeypatch)
    await api.ask(to=["bob"])
    assert (await api.directory("carol"))["alice"]["stats"]["asked"] == 1
    assert reads == [api.team]

    api.clock.advance(5)
    await api.ask(to=["bob"])
    await api.stream("bob", "inbox")  # presence is never cached
    api.clock.current = START + timedelta(seconds=9.999)
    for member in ("alice", "bob", "carol"):  # every member's directory shares the entry
        view = await api.directory(member)
        if member != "alice":
            assert view["alice"]["stats"]["asked"] == 1  # still the cached count
    assert view["bob"]["sessions"]["answering"]["last_seen"] == at(5)
    assert reads == [api.team]

    api.clock.current = START + timedelta(seconds=10)  # 10 s old: stale
    assert (await api.directory("carol"))["alice"]["stats"]["asked"] == 2
    assert reads == [api.team] * 2

    api.clock.current = START + timedelta(seconds=4)  # a clock that went back: stale too
    await api.directory("carol")
    assert reads == [api.team] * 3  # recomputed

    # Another team has its own entry (dave is alone in team `other`).
    r = await api.client.get("/v1/teams/other/directory", headers=auth("dave"))
    assert r.status_code == 200 and r.json() == {"members": [], "stats_complete": True}
    assert reads == [api.team] * 3 + ["other"]


async def test_the_read_budget_is_120_a_minute_shared_by_the_feed_and_the_directory(api: Api):
    for i in range(120):
        path = "/activity" if i % 2 else "/directory"
        r = await api.get("alice", path)
        assert r.status_code == 200, (i, r.text)
    for path in ("/activity", "/directory"):
        r = await api.get("alice", path)
        assert r.status_code == 429 and r.json()["error"] == "rate_limited"
    # Per member; other reads are not counted.
    assert (await api.get("bob", "/activity")).status_code == 200
    assert (await api.get("alice", "/me")).status_code == 200
    assert (await api.get("alice", "/streams/inbox")).status_code == 200
    api.clock.advance(60)  # the next calendar minute
    assert (await api.get("alice", "/activity")).status_code == 200
