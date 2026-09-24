"""Abuse limits (M1-SPEC §11.7): per-sender request and broadcast rates and the cap on
audited refusals, counted in the store; per-instance concurrent long-polls."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

import httpx
import pytest

from relay.app import create_app
from relay.config import Limits, Settings, load_schema, load_team_config, parse_team_config
from relay.errors import ConfigError
from relay.store_memory import MemoryStore

from .conftest import REPO_ROOT, SCHEMA_PATH, FakeClock, auth, team_config_data
from .helpers import ack, ask, get, post, question_body, reply, stream

pytestmark = pytest.mark.anyio


def make_client(store: MemoryStore, clock: FakeClock, raise_errors: bool = True, **limits: int):
    settings = Settings(
        team_config=parse_team_config(team_config_data(min_ack_timeout_seconds=2, **limits)),
        manifest_schema=load_schema(SCHEMA_PATH),
        auth_mode="static",
    )
    app = create_app(settings, store, clock=clock, poll_interval=0.02)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=raise_errors)
    return app, httpx.AsyncClient(transport=transport, base_url="http://relay")


@pytest.fixture
async def limited(memory_store, clock) -> AsyncIterator[httpx.AsyncClient]:
    _, c = make_client(
        memory_store,
        clock,
        requests_per_minute=4,
        broadcasts_per_minute=2,
        audited_refusals_per_minute=3,
    )
    async with c:
        yield c


# Config ----------------------------------------------------------------------------------------


def test_limit_defaults():
    config = load_team_config(REPO_ROOT / "config" / "team.example.yaml")
    assert config.limits == Limits(
        min_ack_timeout_seconds=10,
        min_answer_timeout_seconds=60,
        requests_per_minute=30,
        broadcasts_per_minute=5,
        audited_refusals_per_minute=60,
        concurrent_polls=2,
        reads_per_minute=120,
    )


def test_limits_are_configurable():
    config = parse_team_config(
        team_config_data(
            requests_per_minute=100,
            broadcasts_per_minute=10,
            audited_refusals_per_minute=500,
            concurrent_polls=4,
            reads_per_minute=600,
        )
    )
    assert config.limits.requests_per_minute == 100
    assert config.limits.broadcasts_per_minute == 10
    assert config.limits.audited_refusals_per_minute == 500
    assert config.limits.concurrent_polls == 4
    assert config.limits.reads_per_minute == 600


@pytest.mark.parametrize(
    "limits",
    [
        {"requests_per_minute": 0},
        {"broadcasts_per_minute": -1},
        {"audited_refusals_per_minute": 0},
        {"concurrent_polls": 0},
        {"concurrent_polls": 101},
        {"reads_per_minute": 0},
        {"reads_per_minute": 10001},
        {"requests_per_minute": "30"},
        {"requests_per_hour": 30},
    ],
)
def test_bad_limits_are_a_startup_error(limits):
    with pytest.raises(ConfigError, match="limits"):
        parse_team_config(team_config_data(**limits))


# Request rate ------------------------------------------------------------------------------------


async def test_the_default_is_30_requests_a_minute_per_sender(client, clock, memory_store):
    for i in range(30):
        await ask(client, question=f"q{i}")
    r = await post(client, "alice", "/requests", question_body())
    assert r.status_code == 429 and r.json()["error"] == "rate_limited"
    assert "30 requests" in r.json()["detail"]
    assert (await stream(client, "bob", "inbox", limit=100))["head"] == 30  # nothing written
    audit = await memory_store.list_audit("demo")
    assert [(a.actor, a.outcome, a.detail) for a in audit[-1:]] == [
        ("alice", "refused", "429 rate_limited")
    ]
    await ask(client, "bob", to=["alice"])  # per sender: bob is unaffected
    clock.advance(60)  # a new minute
    await ask(client)


async def test_the_default_is_5_broadcasts_a_minute_within_the_30(client, clock):
    for _ in range(5):
        await ask(client, to="*")
    r = await post(client, "alice", "/requests", question_body(to="*"))
    assert r.status_code == 429 and r.json()["error"] == "rate_limited"
    assert "5 broadcasts" in r.json()["detail"]
    for _ in range(25):  # the refused broadcast did not count; directed ones still go
        await ask(client)
    r = await post(client, "alice", "/requests", question_body())
    assert r.status_code == 429 and "30 requests" in r.json()["detail"]


async def test_broadcasts_count_against_the_request_limit(limited, clock):
    await ask(limited, to="*")
    await ask(limited, to="*")
    await ask(limited)
    await ask(limited)
    r = await post(limited, "alice", "/requests", question_body())
    assert r.status_code == 429 and "4 requests" in r.json()["detail"]
    clock.advance(60)
    await ask(limited, to="*")


async def test_replays_do_not_count(limited):
    first = question_body(idempotency_key="replay-key-1")
    assert (await post(limited, "alice", "/requests", first)).status_code == 201
    for _ in range(3):
        await ask(limited)
    # The limit is reached, but a retry of a request that was created is still answered,
    # and does not count.
    for _ in range(3):
        r = await post(limited, "alice", "/requests", first)
        assert r.status_code == 200 and r.json()["created"] is False
    r = await post(limited, "alice", "/requests", question_body())
    assert r.status_code == 429


async def test_the_window_is_a_calendar_minute(limited, clock):
    clock.advance(50)  # 12:00:50
    for _ in range(4):
        await ask(limited)
    assert (await post(limited, "alice", "/requests", question_body())).status_code == 429
    clock.advance(10)  # 12:01:00, a new window
    await ask(limited)


async def test_rate_limits_hold_across_instances_sharing_a_store(memory_store, clock):
    app1, c1 = make_client(memory_store, clock, requests_per_minute=3)
    app2, c2 = make_client(memory_store, clock, requests_per_minute=3)
    async with c1, c2:
        await ask(c1)
        await ask(c2)
        await ask(c1)
        r = await post(c2, "alice", "/requests", question_body())
        assert r.status_code == 429


async def test_concurrent_creates_never_pass_the_limit(limited):
    rs = await asyncio.gather(
        *(post(limited, "alice", "/requests", question_body()) for _ in range(10))
    )
    assert sorted(r.status_code for r in rs) == [201] * 4 + [429] * 6


# Audited refusals ------------------------------------------------------------------------------


async def test_refusals_beyond_the_cap_go_to_stdout_only(limited, memory_store, clock, capsys):
    capsys.readouterr()
    for _ in range(5):
        r = await post(limited, "alice", "/requests", {"kind": "nope"})
        assert r.status_code == 422  # the response itself never changes
    refused = [a for a in await memory_store.list_audit("demo") if a.outcome == "refused"]
    assert len(refused) == 3
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]
    spilled = [line for line in lines if line["event"] == "refusal_not_audited"]
    assert len(spilled) == 2
    assert spilled[0]["actor"] == "alice" and spilled[0]["detail"] == "422 invalid_body"
    assert spilled[0]["action"] == "request.create" and spilled[0]["team"] == "demo"
    # Per sender: bob's refusals are still audited.
    await post(limited, "bob", "/requests", {"kind": "nope"})
    refused = [a for a in await memory_store.list_audit("demo") if a.outcome == "refused"]
    assert [a.actor for a in refused] == ["alice"] * 3 + ["bob"]
    # A new minute audits again.
    clock.advance(60)
    await post(limited, "alice", "/requests", {"kind": "nope"})
    refused = [a for a in await memory_store.list_audit("demo") if a.outcome == "refused"]
    assert len(refused) == 5


async def test_the_default_cap_is_60_audited_refusals_a_minute(client, memory_store):
    rid = "rq_" + "0" * 32
    for _ in range(65):
        r = await ack(client, "bob", rid)
        assert r.status_code == 404
    refused = [a for a in await memory_store.list_audit("demo") if a.outcome == "refused"]
    assert len(refused) == 60


async def test_other_team_refusals_share_the_cap(limited, memory_store):
    for _ in range(5):
        r = await limited.post("/v1/teams/other/requests", headers=auth("alice"), json={})
        assert r.status_code == 404
    refused = [a for a in await memory_store.list_audit("demo") if a.outcome == "refused"]
    assert len(refused) == 3


async def test_successes_are_never_capped(limited, memory_store):
    for _ in range(5):
        await post(limited, "alice", "/requests", {"kind": "nope"})
    rid = (await ask(limited))["request_id"]
    await ack(limited, "bob", rid)
    await reply(limited, "bob", rid)
    actions = [a.action for a in await memory_store.list_audit("demo") if a.outcome != "refused"]
    assert actions == [
        "request.create",
        "envelope.deliver",
        "request.ack",
        "request.reply",
        "envelope.deliver",
    ]


# Concurrent long-polls ---------------------------------------------------------------------------


async def _wait_for_polls(app, key, count: int) -> None:
    for _ in range(500):
        if app.state.service._polls.get(key, 0) == count:
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"expected {count} polls in flight")


async def test_a_third_concurrent_long_poll_is_429(memory_store, clock):
    app, c = make_client(memory_store, clock)
    async with c:
        polls = [
            asyncio.create_task(get(c, "bob", "/streams/inbox", wait=1)),
            asyncio.create_task(get(c, "bob", "/streams/inbox", wait=1)),
        ]
        await _wait_for_polls(app, ("demo", "bob", "inbox"), 2)
        r = await get(c, "bob", "/streams/inbox", wait=1)
        assert r.status_code == 429 and r.json()["error"] == "too_many_polls"
        # Not counted: a read that does not wait, another stream, another member.
        assert (await get(c, "bob", "/streams/inbox", wait=0)).status_code == 200
        assert (await get(c, "bob", "/streams/inbox")).status_code == 200
        others = await asyncio.gather(
            get(c, "bob", "/streams/replies", wait=1), get(c, "carol", "/streams/inbox", wait=1)
        )
        assert [r.status_code for r in others] == [200, 200]
        assert [r.status_code for r in await asyncio.gather(*polls)] == [200, 200]
        # Slots are released when the polls end.
        assert app.state.service._polls == {}
        assert (await get(c, "bob", "/streams/inbox", wait=1)).status_code == 200


async def test_poll_slots_are_released_on_errors(memory_store, clock, monkeypatch):
    app, c = make_client(memory_store, clock, raise_errors=False, concurrent_polls=1)

    async def broken(*args, **kwargs):
        raise RuntimeError("store down")

    async with c:
        monkeypatch.setattr(memory_store, "read_stream", broken)
        r = await get(c, "bob", "/streams/inbox", wait=1)
        assert r.status_code == 500
        assert app.state.service._polls == {}
        monkeypatch.undo()
        assert (await get(c, "bob", "/streams/inbox", wait=1)).status_code == 200


async def test_the_poll_limit_is_configurable(memory_store, clock):
    app, c = make_client(memory_store, clock, concurrent_polls=1)
    async with c:
        first = asyncio.create_task(get(c, "alice", "/streams/replies", wait=1))
        await _wait_for_polls(app, ("demo", "alice", "replies"), 1)
        r = await get(c, "alice", "/streams/replies", wait=1)
        assert r.status_code == 429 and r.json()["error"] == "too_many_polls"
        assert (await first).status_code == 200


async def test_a_refused_poll_is_not_audited(memory_store, clock):
    app, c = make_client(memory_store, clock, concurrent_polls=1)
    async with c:
        first = asyncio.create_task(get(c, "bob", "/streams/inbox", wait=1))
        await _wait_for_polls(app, ("demo", "bob", "inbox"), 1)
        assert (await get(c, "bob", "/streams/inbox", wait=1)).status_code == 429
        await first
    assert await memory_store.list_audit("demo") == []


# The read budget (M2-SPEC §7.3) -------------------------------------------------------------------


async def test_the_read_budget_is_configurable_and_per_member(memory_store, clock):
    _, c = make_client(memory_store, clock, reads_per_minute=3)
    async with c:
        for path in ("/activity", "/directory", "/activity"):
            assert (await get(c, "alice", path)).status_code == 200
        r = await get(c, "alice", "/directory")
        assert r.status_code == 429
        assert r.json() == {
            "error": "rate_limited",
            "detail": "At most 3 reads of the activity feed and the directory a minute; "
            "try again shortly.",
        }
        assert (await get(c, "bob", "/directory")).status_code == 200
        clock.advance(60)
        assert (await get(c, "alice", "/directory")).status_code == 200


async def test_a_refused_read_is_logged_not_audited(memory_store, clock, capsys):
    _, c = make_client(memory_store, clock, reads_per_minute=1)
    async with c:
        await get(c, "alice", "/activity")
        before = await memory_store.list_audit("demo")
        capsys.readouterr()
        assert (await get(c, "alice", "/activity")).status_code == 429
        assert await memory_store.list_audit("demo") == before
        lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line]
        refused = [line for line in lines if line["event"] == "read_refused"]
        assert len(refused) == 1
        assert refused[0]["member"] == "alice" and refused[0]["endpoint"] == "activity"
        assert refused[0]["team"] == "demo" and refused[0]["severity"] == "WARNING"


async def test_the_read_budget_holds_across_instances_sharing_a_store(memory_store, clock):
    _, c1 = make_client(memory_store, clock, reads_per_minute=3)
    _, c2 = make_client(memory_store, clock, reads_per_minute=3)
    async with c1, c2:
        assert (await get(c1, "alice", "/activity")).status_code == 200
        assert (await get(c2, "alice", "/directory")).status_code == 200
        assert (await get(c1, "alice", "/directory")).status_code == 200
        assert (await get(c2, "alice", "/activity")).status_code == 429


async def test_concurrent_reads_never_pass_the_budget(memory_store, clock):
    _, c = make_client(memory_store, clock, reads_per_minute=4)
    async with c:
        rs = await asyncio.gather(*(get(c, "alice", "/activity") for _ in range(10)))
        assert sorted(r.status_code for r in rs) == [200] * 4 + [429] * 6


async def test_a_bad_read_still_counts(memory_store, clock):
    # The budget is taken first, so malformed queries cannot be sent without limit either.
    _, c = make_client(memory_store, clock, reads_per_minute=2)
    async with c:
        assert (await get(c, "alice", "/activity", limit="0")).status_code == 400
        assert (await get(c, "alice", "/activity", since="x")).status_code == 400
        assert (await get(c, "alice", "/activity")).status_code == 429


async def test_an_unauthenticated_or_other_team_read_is_not_counted(memory_store, clock):
    _, c = make_client(memory_store, clock, reads_per_minute=1)
    async with c:
        r = await c.get("/v1/teams/demo/activity", headers={"Authorization": "Bearer nope"})
        assert r.status_code == 401
        r = await c.get("/v1/teams/other/activity", headers=auth("alice"))
        assert r.status_code == 404
        assert (await get(c, "alice", "/activity")).status_code == 200
