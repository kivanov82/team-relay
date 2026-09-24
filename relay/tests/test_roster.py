"""The roster (M6-SPEC §1–§3, gates in §6) on both stores: the store operations and their
invariants, the seed upsert, the cache and roster_version, credential revocation on
removal, the owner endpoints and masking, the rate limit, audit hashing, delegates with
manage-roster, and multi-team principals (M5-SPEC §4)."""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

import pytest

from relay.config import normalise_email, parse_team_config
from relay.errors import ApiError
from relay.roster import RETIRED_ID_LIFETIME, ROSTER_CACHE_TTL, plan_seed
from relay.service import MAX_TTL
from relay.store import (
    AuditEntry,
    CredentialRecord,
    Quota,
    QuotaExceeded,
    RetiredId,
    RosterChange,
    RosterEntry,
    RosterState,
)

from .conftest import (
    DELEGATES,
    EMAILS,
    TOKENS,
    Api,
    FakeClock,
    accept_invitation,
    auth,
    open_api,
    principal,
    team_config_data,
)
from .login_helpers import bearer, login, to_chooser

pytestmark = pytest.mark.anyio


def _sha(email: str) -> str:
    return hashlib.sha256(email.encode()).hexdigest()


async def _roster(api: Api, member: str = "alice", headers: dict[str, str] | None = None):
    r = await api.client.get(api.url("/roster"), headers=headers or auth(member))
    assert r.status_code == 200, r.text
    return {m["member"]: m for m in r.json()["members"]}


async def _add(
    api: Api, member: str, email: str, *, by: str = "alice", accept: bool = True, **extra: Any
):
    """Add ``member`` (an invitation, M9-SPEC §7.2) and, with ``accept``, have them accept it
    at once with their own Google account; the add's response either way."""
    r = await api.client.post(
        api.url("/roster"), headers=auth(by), json={"member": member, "email": email, **extra}
    )
    if accept and r.status_code == 201:
        await accept_invitation(api.client, api.team, email)
    return r


async def _patch(api: Api, member: str, body: dict[str, Any], by: str = "alice"):
    return await api.client.patch(api.url(f"/roster/{member}"), headers=auth(by), json=body)


async def _delete(api: Api, member: str, by: str = "alice"):
    return await api.client.delete(api.url(f"/roster/{member}"), headers=auth(by))


# The store primitive -------------------------------------------------------------------------


def _entry(member: str, emails: list[str], role: str, clock: FakeClock) -> RosterEntry:
    now = clock.current
    return RosterEntry(member, emails, role, "alice", now, now)


async def test_mutate_roster_bumps_the_version_only_on_a_change(api: Api):
    team = "r" + uuid.uuid4().hex[:20]
    store, clock = api.store, api.clock
    assert await store.roster_version(team) == 0
    assert (await store.read_roster(team)).entries == {}
    outcome = await store.mutate_roster(
        team,
        lambda state: RosterChange(
            result=state.version, put=[_entry("x", ["x@e.com"], "owner", clock)]
        ),
        clock.current,
    )
    assert (outcome.result, outcome.version) == (0, 1)
    assert await store.roster_version(team) == 1
    outcome = await store.mutate_roster(team, lambda s: RosterChange(result="same"), clock.current)
    assert (outcome.result, outcome.version) == ("same", 1)
    assert await store.roster_version(team) == 1
    state = await store.read_roster(team)
    assert state.version == 1 and state.entries["x"].emails == ["x@e.com"]
    assert state.entries["x"].added_at == clock.current


async def test_mutate_roster_raising_writes_nothing(api: Api):
    team = "r" + uuid.uuid4().hex[:20]

    def boom(state: RosterState) -> RosterChange[None]:
        raise ApiError(409, "nope")

    with pytest.raises(ApiError):
        await api.store.mutate_roster(team, boom, api.clock.current)
    assert await api.store.roster_version(team) == 0


async def test_mutate_roster_counts_quotas_only_on_a_change(api: Api):
    team = "r" + uuid.uuid4().hex[:20]
    clock = api.clock
    quota = Quota(key="q." + uuid.uuid4().hex, limit=1, expire_at=clock.current)

    def put(member: str):
        return lambda s: RosterChange(result=None, put=[_entry(member, [], "owner", clock)])

    await api.store.mutate_roster(team, lambda s: RosterChange(result=None), clock.current, [quota])
    await api.store.mutate_roster(team, put("a"), clock.current, [quota])
    with pytest.raises(QuotaExceeded):
        await api.store.mutate_roster(team, put("b"), clock.current, [quota])
    assert set((await api.store.read_roster(team)).entries) == {"a"}


async def test_a_removal_revokes_the_members_live_credentials_in_the_same_transaction(api: Api):
    team = "r" + uuid.uuid4().hex[:20]
    clock = api.clock
    now = clock.current
    await api.store.mutate_roster(
        team,
        lambda s: RosterChange(
            result=None,
            put=[
                _entry("x", ["x@e.com"], "owner", clock),
                _entry("y", ["y@e.com"], "member", clock),
            ],
        ),
        now,
    )
    keys = {}
    for member in ("x", "y"):
        key = uuid.uuid4().hex * 2
        keys[member] = key
        from relay.store import Redemption

        record = CredentialRecord(key, team, member, "d", now, now, now.replace(year=2027))
        await api.store.redeem_code(
            "code-" + key, lambda doc, r=record: Redemption(result=None, credential=r), now
        )
    audit = AuditEntry(now, team, "x", "roster.remove", "removed", now.replace(year=2027))
    outcome = await api.store.mutate_roster(
        team, lambda s: RosterChange(result=None, remove=["y"], audit=[audit]), now
    )
    assert outcome.revoked == [keys["y"]]
    assert set((await api.store.read_roster(team)).entries) == {"x"}
    y = await api.store.find_credential([team], keys["y"])
    x = await api.store.find_credential([team], keys["x"])
    assert y.revoked and y.revoked_at == now and not x.revoked
    assert [e.action for e in await api.store.list_audit(team)] == ["roster.remove"]


# Seeding ---------------------------------------------------------------------------------------


async def test_the_seed_is_upserted_on_first_use(api: Api):
    roster = await _roster(api)
    assert list(roster) == ["alice", "bob", "carol"]
    assert roster["alice"]["role"] == "owner" and roster["bob"]["role"] == "member"
    assert roster["alice"]["emails"] == ["alice@example.com"]
    assert roster["alice"]["added_by"] == "relay"
    assert await api.store.roster_version(api.team) == 1


async def test_the_seed_is_idempotent_and_never_removes_or_demotes(api: Api):
    await _roster(api)
    assert (await _add(api, "erin", "erin@example.com")).status_code == 201
    assert (await _patch(api, "alice", {"role": "member"}, by="alice")).status_code == 409
    assert (await _patch(api, "bob", {"role": "owner"})).status_code == 200
    assert (await _patch(api, "alice", {"role": "member"})).status_code == 200  # bob is owner
    version = await api.store.roster_version(api.team)
    # A new instance seeds again: nothing to do, nothing written.
    async with api.instance() as (other, _):
        r = await other.get(api.url("/roster"), headers=auth("bob"))
        roster = {m["member"]: m for m in r.json()["members"]}
    assert await api.store.roster_version(api.team) == version
    assert roster["alice"]["role"] == "member"  # not re-promoted
    assert "erin" in roster  # not removed


def test_the_seed_skips_a_member_whose_email_is_taken(clock: FakeClock):
    config = parse_team_config(team_config_data())
    taken = RosterEntry("zed", ["bob@example.com"], "owner", "alice", clock.current, clock.current)
    change = plan_seed(config, "demo", clock.current)(RosterState(3, {"zed": taken}))
    assert change.result == (["alice", "carol"], ["bob"])
    assert [e.member for e in change.put] == ["alice", "carol"]


def test_the_seed_stops_at_fifty_members(clock: FakeClock):
    config = parse_team_config(team_config_data())
    now = clock.current
    full = {f"m{i:02d}": RosterEntry(f"m{i:02d}", [], "member", "x", now, now) for i in range(50)}
    change = plan_seed(config, "demo", now)(RosterState(9, full))
    assert change.result == ([], ["alice", "bob", "carol"]) and not change.changed


# The owner endpoints ------------------------------------------------------------------------


async def test_an_owner_adds_a_member_who_then_works(api: Api):
    r = await _add(api, "erin", "Erin@Example.com")
    assert r.status_code == 201, r.text
    assert r.json() == {
        "member": "erin",
        "emails": ["erin@example.com"],
        "role": "member",
        "added_by": "alice",
        "added_at": "2026-09-23T12:00:00.000Z",
        "status": "invited",
    }
    # Accepted (by _add), at once on this instance: in the directory, a valid recipient, and
    # able to sign in.
    directory = await api.directory("alice")
    assert "erin" in directory and directory["erin"]["stats"]["asked"] == 0
    rid = await api.ask("alice", to=["erin"])
    cred = bearer((await login(api, "erin", email="erin@example.com"))["credential"])
    r = await api.client.get(api.url("/me"), headers=cred)
    assert r.json() == {
        "team": api.team,
        "name": api.team,
        "member": "erin",
        "teammates": ["alice", "bob", "carol"],
        "role": "member",
    }
    r = await api.client.get(api.url(f"/requests/{rid}"), headers=cred)
    assert r.status_code == 200


async def test_add_with_role_owner(api: Api):
    r = await _add(api, "erin", "erin@example.com", role="owner")
    assert r.status_code == 201 and r.json()["role"] == "owner"


@pytest.mark.parametrize(
    "body, status, error",
    [
        ({"member": "Erin", "email": "e@example.com"}, 422, "invalid_body"),
        ({"member": "e", "email": "e@example.com"}, 422, "invalid_body"),
        ({"member": "erin", "email": "not-an-email"}, 422, "invalid_body"),
        ({"member": "erin", "email": " erin@example.com"}, 422, "invalid_body"),
        ({"member": "erin", "email": "a,b@example.com"}, 422, "invalid_body"),
        ({"member": "erin", "email": "erin@example.com", "role": "admin"}, 422, "invalid_body"),
        ({"member": "erin", "email": "erin@example.com", "extra": 1}, 422, "invalid_body"),
        ({"member": "erin"}, 422, "invalid_body"),
        ([], 422, "invalid_body"),
        # a delegate's principal is never a member's (M3-SPEC §2)
        ({"member": "erin", "email": DELEGATES["demo"].removeprefix("google:")}, 422,
         "invalid_body"),
        # taken
        ({"member": "bob", "email": "new@example.com"}, 409, "member_exists"),
        ({"member": "erin", "email": "BOB@example.com"}, 409, "email_taken"),
    ],
)  # fmt: skip
async def test_add_refusals(api: Api, body: Any, status: int, error: str):
    r = await api.client.post(api.url("/roster"), headers=auth("alice"), json=body)
    assert (r.status_code, r.json()["error"]) == (status, error), r.text
    refused = [e for e in await api.store.list_audit(api.team) if e.outcome == "refused"]
    assert [(e.action, e.detail) for e in refused] == [("roster.add", f"{status} {error}")]


async def test_an_email_is_unique_per_team_not_across_teams(api: Api):
    assert (await _add(api, "dave2", "dave@example.com")).status_code == 201  # dave is in other


async def test_only_owners_mutate(api: Api):
    for r in (
        await _add(api, "erin", "erin@example.com", by="bob"),
        await _patch(api, "carol", {"role": "owner"}, by="bob"),
        await _patch(api, "bob", {"add_email": "b2@example.com"}, by="bob"),  # not even oneself
        await _delete(api, "carol", by="bob"),
    ):
        assert r.status_code == 403 and r.json()["error"] == "forbidden"
    assert list(await _roster(api)) == ["alice", "bob", "carol"]


async def test_patch_emails_and_roles(api: Api):
    # An owner adds their own second account (M6-SPEC §7.1).
    r = await _patch(api, "alice", {"add_email": "Alice.Work@Example.com"})
    assert r.status_code == 200 and r.json()["emails"] == [
        "alice@example.com",
        "alice.work@example.com",
    ]
    r = await _patch(api, "alice", {"remove_email": "alice@example.com"})
    assert r.status_code == 200 and r.json()["emails"] == ["alice.work@example.com"]
    # Swap the last email in one call.
    r = await _patch(
        api, "alice", {"remove_email": "alice.work@example.com", "add_email": "a@x.io"}
    )
    assert r.status_code == 200 and r.json()["emails"] == ["a@x.io"]
    # Another member's role, and an email taken off another member's entry.
    r = await _patch(api, "bob", {"role": "owner"})
    assert r.status_code == 200 and r.json()["role"] == "owner"
    assert (await _patch(api, "bob", {"add_email": "bob.work@example.com"}, by="bob")).is_success
    r = await _patch(api, "bob", {"remove_email": "bob@example.com", "role": "member"})
    assert r.status_code == 200
    assert r.json()["emails"] == ["bob.work@example.com"] and r.json()["role"] == "member"
    # A no-op changes nothing and writes nothing.
    version = await api.store.roster_version(api.team)
    r = await _patch(api, "bob", {"role": "member"})
    assert r.status_code == 200 and await api.store.roster_version(api.team) == version


@pytest.mark.parametrize(
    "member, body, status, error",
    [
        ("bob", {}, 422, "invalid_body"),
        ("bob", {"role": "boss"}, 422, "invalid_body"),
        ("bob", {"add_email": "x"}, 422, "invalid_body"),
        ("bob", {"remove_email": 5}, 422, "invalid_body"),
        ("bob", {"add_email": "a@x.io", "remove_email": "a@x.io"}, 422, "invalid_body"),
        ("bob", {"nickname": "b"}, 422, "invalid_body"),
        ("nobody", {"role": "owner"}, 404, "not_found"),
        ("bob", {"remove_email": "bob@example.com"}, 409, "last_email"),
        ("bob", {"remove_email": "carol@example.com"}, 409, "no_such_email"),
        ("alice", {"add_email": "carol@example.com"}, 409, "email_taken"),
        ("alice", {"add_email": "alice@example.com"}, 409, "email_taken"),
        # M6-SPEC §7.1: never an email onto someone else's entry, whatever else is asked.
        ("bob", {"add_email": "carol@example.com"}, 403, "forbidden"),
        ("bob", {"add_email": "b2@example.com"}, 403, "forbidden"),
        ("bob", {"add_email": "b2@example.com", "role": "owner"}, 403, "forbidden"),
        ("nobody", {"add_email": "n@example.com"}, 403, "forbidden"),
        ("alice", {"role": "member"}, 409, "last_owner"),
    ],
)
async def test_patch_refusals(api: Api, member: str, body: Any, status: int, error: str):
    r = await _patch(api, member, body)
    assert (r.status_code, r.json()["error"]) == (status, error), r.text


async def test_at_most_five_emails(api: Api):
    for i in range(4):
        assert (await _patch(api, "alice", {"add_email": f"a{i}@example.com"})).status_code == 200
    r = await _patch(api, "alice", {"add_email": "a9@example.com"})
    assert (r.status_code, r.json()["error"]) == (409, "too_many_emails")


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_at_most_fifty_members(kind: str, clock: FakeClock):
    async with open_api(kind, clock, roster_mutations_per_hour=100) as api:
        for i in range(47):
            r = await _add(api, f"m{i:02d}", f"m{i}@example.com")
            assert r.status_code == 201, r.text
        r = await _add(api, "one_more", "one.more@example.com")
        assert (r.status_code, r.json()["error"]) == (409, "team_full")


async def test_remove(api: Api):
    assert (await _add(api, "erin", "erin@example.com")).status_code == 201
    r = await _delete(api, "erin")
    assert r.status_code == 200 and r.json() == {"removed": "erin"}
    assert "erin" not in await _roster(api)
    assert "erin" not in await api.directory("alice")
    r = await api.post(
        "alice",
        "/requests",
        {"idempotency_key": "key-" + uuid.uuid4().hex, "kind": "question", "to": ["erin"],
         "question": "Still there?"},
    )  # fmt: skip
    assert r.status_code == 400 and r.json()["error"] == "bad_recipients"
    assert (await _delete(api, "erin")).status_code == 404


async def test_the_last_owner_cannot_be_removed_and_seed_members_stay(api: Api):
    r = await _delete(api, "alice")
    assert (r.status_code, r.json()["error"]) == (409, "last_owner")
    r = await _delete(api, "bob")
    assert (r.status_code, r.json()["error"]) == (409, "seed_member")
    assert (await _add(api, "erin", "erin@example.com", role="owner")).status_code == 201
    erin = bearer((await login(api, "erin", email="erin@example.com"))["credential"])
    r = await api.client.delete(api.url("/roster/alice"), headers=erin)
    assert (r.status_code, r.json()["error"]) == (409, "seed_member")
    # An owner may leave while another stays; their own credential goes with them.
    r = await api.client.delete(api.url("/roster/erin"), headers=erin)
    assert r.status_code == 200
    assert (await api.client.get(api.url("/me"), headers=erin)).status_code == 401


# Retired ids --------------------------------------------------------------------------------


async def _own_email(api: Api, member: str, email: str, new: str) -> None:
    """``member`` (an owner) signs in with ``email`` and adds ``new`` to their own entry."""
    cred = bearer((await login(api, member, email=email))["credential"])
    r = await api.client.patch(api.url(f"/roster/{member}"), headers=cred, json={"add_email": new})
    assert r.status_code == 200, r.text


async def test_a_removed_id_goes_back_only_to_the_same_person_while_retired(api: Api):
    assert (await _add(api, "erin", "erin@example.com", role="owner")).status_code == 201
    await _own_email(api, "erin", "erin@example.com", "erin.work@example.com")
    assert (await _delete(api, "erin")).status_code == 200
    # Someone else under the old id would read its inbox and requests: refused.
    r = await _add(api, "erin", "someone.else@example.com")
    assert (r.status_code, r.json()["error"]) == (409, "member_id_retired")
    # The same person (any email the id had) may come back.
    assert (await _add(api, "erin", "erin.work@example.com")).status_code == 201
    assert (await _delete(api, "erin")).status_code == 200
    # Once every request of the old id has expired, the id is free again.
    api.clock.advance(RETIRED_ID_LIFETIME.total_seconds())
    assert (await _add(api, "erin", "someone.else@example.com")).status_code == 201


async def test_a_retired_id_keeps_every_email_it_had(api: Api):
    assert (await _add(api, "erin", "e1@example.com")).status_code == 201
    assert (await _delete(api, "erin")).status_code == 200
    assert (await _add(api, "erin", "e1@example.com", role="owner")).status_code == 201
    await _own_email(api, "erin", "e1@example.com", "e2@example.com")
    assert (await _patch(api, "erin", {"remove_email": "e1@example.com"})).status_code == 200
    assert (await _delete(api, "erin")).status_code == 200
    assert (await _add(api, "erin", "e1@example.com")).status_code == 201


def test_the_retired_lifetime_outlasts_any_request():
    assert RETIRED_ID_LIFETIME > timedelta(seconds=MAX_TTL)


def test_the_seed_skips_a_retired_id_it_does_not_match(clock: FakeClock):
    config = parse_team_config(team_config_data())
    now = clock.current
    owner = RosterEntry("alice", ["alice@example.com"], "owner", "relay", now, now)
    later = now + RETIRED_ID_LIFETIME
    retired = {
        "bob": RetiredId("bob", [_sha("someone@example.com")], now, later),
        "carol": RetiredId("carol", [_sha("carol@example.com")], now, later),
    }
    change = plan_seed(config, "demo", now)(RosterState(5, {"alice": owner}, retired))
    assert change.result == (["carol"], ["bob"])
    assert [e.member for e in change.put] == ["carol"]


# Masking ---------------------------------------------------------------------------------------


async def test_members_see_names_and_roles_and_only_their_own_emails(api: Api):
    owner_view = await _roster(api, "alice")
    assert all(entry["emails"] for entry in owner_view.values())
    member_view = await _roster(api, "bob")
    assert member_view["bob"]["emails"] == ["bob@example.com"]
    assert member_view["alice"]["emails"] is None and member_view["carol"]["emails"] is None
    assert [(e["member"], e["role"]) for e in member_view.values()] == [
        ("alice", "owner"),
        ("bob", "member"),
        ("carol", "member"),
    ]
    r = await api.client.get(api.url("/roster"), headers=auth("bob"))
    assert "alice@example.com" not in r.text and "carol@example.com" not in r.text


# Cache and roster_version ---------------------------------------------------------------------


async def test_another_instance_sees_an_addition_and_a_removal_within_30_seconds(api: Api):
    async with api.instance() as (other, _):
        assert (await other.get(api.url("/me"), headers=auth("alice"))).status_code == 200
        assert (await _add(api, "erin", "erin@example.com")).status_code == 201
        seen = (await other.get(api.url("/me"), headers=auth("alice"))).json()["teammates"]
        assert "erin" not in seen  # cached
        api.clock.advance(ROSTER_CACHE_TTL.total_seconds())
        seen = (await other.get(api.url("/me"), headers=auth("alice"))).json()["teammates"]
        assert "erin" in seen
        # The roster read itself is always validated against the version.
        assert (await _delete(api, "erin")).status_code == 200
        r = await other.get(api.url("/roster"), headers=auth("alice"))
        assert "erin" not in {m["member"] for m in r.json()["members"]}


async def test_a_cache_hit_reads_nothing_and_a_stale_one_reads_only_the_version(api: Api):
    calls: list[str] = []
    store = api.store
    original_version, original_read = store.roster_version, store.read_roster

    async def version(team: str) -> int:
        calls.append("version")
        return await original_version(team)

    async def read(team: str) -> RosterState:
        calls.append("read")
        return await original_read(team)

    store.roster_version = version  # type: ignore[method-assign]
    store.read_roster = read  # type: ignore[method-assign]
    try:
        await api.get("alice", "/me")
        calls.clear()
        await api.get("alice", "/me")
        assert calls == []
        api.clock.advance(ROSTER_CACHE_TTL.total_seconds())
        await api.get("alice", "/me")
        assert calls == ["version"]
    finally:
        store.roster_version, store.read_roster = original_version, original_read  # type: ignore[method-assign]


# Rate limit -------------------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_thirty_roster_mutations_per_owner_per_hour(kind: str, clock: FakeClock):
    clock.current = clock.current.replace(minute=0, second=0)
    async with open_api(kind, clock, roster_mutations_per_hour=3) as api:
        assert (await _add(api, "e1", "e1@example.com")).status_code == 201
        assert (await _patch(api, "e1", {"role": "owner"})).status_code == 200
        assert (await _delete(api, "e1")).status_code == 200
        r = await _add(api, "e2", "e2@example.com")
        assert (r.status_code, r.json()["error"]) == (429, "rate_limited")
        # Refusals (409) do not count; a new hour starts from zero.
        clock.advance(3600)
        assert (await _add(api, "e2", "e2@example.com")).status_code == 201


def test_the_default_is_thirty():
    assert parse_team_config(team_config_data()).limits.roster_mutations_per_hour == 30


# Audit ------------------------------------------------------------------------------------------


async def test_changes_are_audited_with_email_hashes_only(api: Api):
    # One second apart: the audit is ordered by time, and entries of one instant are not.
    await _add(api, "erin", "erin@example.com", accept=False)
    api.clock.advance(1)
    await accept_invitation(api.client, api.team, "erin@example.com")
    api.clock.advance(1)
    await _patch(api, "erin", {"role": "owner"})
    api.clock.advance(1)
    erin = bearer((await login(api, "erin", email="erin@example.com"))["credential"])
    api.clock.advance(1)
    r = await api.client.patch(
        api.url("/roster/erin"), headers=erin, json={"add_email": "erin.two@example.com"}
    )
    assert r.status_code == 200
    api.clock.advance(1)
    await _patch(api, "erin", {"remove_email": "erin@example.com"})
    api.clock.advance(1)
    await _delete(api, "erin")
    entries = [e for e in await api.store.list_audit(api.team) if e.action.startswith("roster.")]
    assert [(e.action, e.actor, e.member, e.outcome) for e in entries] == [
        ("roster.add", "alice", "erin", "invited"),
        # M9-SPEC §7.2: she accepts with her Google account, which binds it (M6-SPEC §7.2),
        # so her first sign-in has nothing left to bind.
        ("roster.accept", "erin", "erin", "accepted"),
        ("roster.role", "alice", "erin", "changed"),
        ("roster.email_add", "erin", "erin", "changed"),
        ("roster.email_remove", "alice", "erin", "changed"),
        ("roster.remove", "alice", "erin", "removed"),
    ]
    by_action = {e.action: e for e in entries}
    assert by_action["roster.add"].email_sha256 == [_sha("erin@example.com")]
    assert by_action["roster.accept"].email_sha256 == [_sha("erin@example.com")]
    assert by_action["roster.email_add"].email_sha256 == [_sha("erin.two@example.com")]
    assert by_action["roster.email_remove"].email_sha256 == [_sha("erin@example.com")]
    assert by_action["roster.role"].email_sha256 == []
    assert by_action["roster.remove"].email_sha256 == [_sha("erin.two@example.com")]
    assert all("@" not in repr(e) for e in entries)


# Delegates with manage-roster (M6-SPEC §3) ---------------------------------------------------


def _manage(data: dict[str, Any]) -> None:
    data["delegates"][0]["scope"] = ["read", "manage-roster"]


@asynccontextmanager
async def _managing(kind: str, clock: FakeClock) -> AsyncIterator[Api]:
    async with open_api(kind, clock, configure=_manage) as api:
        yield api


@pytest.fixture(params=["memory", "firestore"])
async def managed(request: pytest.FixtureRequest, clock: FakeClock) -> AsyncIterator[Api]:
    async with _managing(request.param, clock) as api:
        yield api


async def test_a_managing_delegate_acts_for_an_owner(managed: Api):
    api = managed
    r = await api.delegated(
        "POST", "/roster", EMAILS["alice"], json={"member": "erin", "email": "erin@example.com"}
    )
    assert r.status_code == 201, r.text
    r = await api.delegated("PATCH", "/roster/erin", EMAILS["alice"], json={"role": "owner"})
    assert r.status_code == 200
    r = await api.delegated("DELETE", "/roster/erin", EMAILS["alice"])
    assert r.status_code == 200
    entries = [e for e in await api.store.list_audit(api.team) if e.action.startswith("roster.")]
    assert all(e.actor == "alice" and "via delegate" in (e.detail or "") for e in entries)
    r = await api.delegated("GET", "/roster", EMAILS["alice"])
    assert r.status_code == 200 and r.json()["members"][0]["emails"] == ["alice@example.com"]


async def test_a_managing_delegate_for_a_member_is_forbidden(managed: Api):
    api = managed
    r = await api.delegated(
        "POST", "/roster", EMAILS["bob"], json={"member": "erin", "email": "erin@example.com"}
    )
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    r = await api.delegated("DELETE", "/roster/carol", EMAILS["bob"])
    assert r.status_code == 403
    r = await api.delegated("GET", "/roster", EMAILS["bob"])
    assert r.status_code == 200 and r.json()["members"][0]["emails"] is None


async def test_manage_roster_opens_nothing_else(managed: Api):
    api = managed
    for method, path, body in (
        ("POST", "/requests", {}),
        ("PUT", "/members/alice/manifest", {"version": 1, "capabilities": []}),
        ("GET", "/streams/inbox", None),
        ("GET", "/credentials", None),
        ("DELETE", "/credentials/self", None),
    ):
        r = await api.delegated(method, path, EMAILS["alice"], json=body)
        assert r.status_code == 403, (method, path)


async def test_a_read_only_delegate_cannot_manage(api: Api):
    r = await api.delegated(
        "POST", "/roster", EMAILS["alice"], json={"member": "erin", "email": "erin@example.com"}
    )
    assert r.status_code == 403 and r.json()["detail"] == "A delegate may only read."
    r = await api.delegated("DELETE", "/roster/bob", EMAILS["alice"])
    assert r.status_code == 403
    r = await api.delegated("GET", "/roster", EMAILS["bob"])
    assert r.status_code == 200
    assert [e for e in await api.store.list_audit(api.team) if e.outcome == "refused"] == []


async def test_a_delegate_names_a_member_added_through_the_roster(api: Api):
    assert (await _add(api, "erin", "erin@example.com")).status_code == 201
    r = await api.delegated("GET", "/me", "erin@example.com")
    assert r.status_code == 200 and r.json()["member"] == "erin"


# Multi-team principals (M5-SPEC §4) ------------------------------------------------------------


def _two_teams(data: dict[str, Any]) -> None:
    data["teams"][1]["id"] = "o" + uuid.uuid4().hex[:20]
    data["teams"][1]["members"].append(
        {"id": "ally", "principals": [principal(TOKENS["alice"]), f"google:{EMAILS['alice']}"]}
    )
    data["delegates"] = []


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_one_principal_two_teams(kind: str, clock: FakeClock):
    async with open_api(kind, clock, configure=_two_teams) as api:
        other = api.settings.team_config.team_ids()[1]
        r = await api.client.get(api.url("/me"), headers=auth("alice"))
        assert r.json()["member"] == "alice"
        r = await api.client.get(f"/v1/teams/{other}/me", headers=auth("alice"))
        assert r.status_code == 200 and r.json()["member"] == "ally"
        assert r.json()["teammates"] == ["dave"]
        # bob is in one team: 404 in the other; a stranger in none: 401.
        r = await api.client.get(f"/v1/teams/{other}/me", headers=auth("bob"))
        assert r.status_code == 404
        r = await api.client.get(api.url("/me"), headers={"Authorization": "Bearer stranger-1"})
        assert r.status_code == 401
        # Adding bob to the second team's roster invites him there (same email); once he
        # accepts (M9-SPEC §7.2) he is a member there.
        r = await api.client.post(
            f"/v1/teams/{other}/roster",
            headers=auth("dave"),
            json={"member": "bobby", "email": EMAILS["bob"]},
        )
        assert r.status_code == 201
        # (bob is every test's bob on the shared emulator: this test's teams only.)
        ours = {api.team, other}
        chooser = await to_chooser(api.client, api.fake, EMAILS["bob"])
        assert [t for t in chooser.teams if t in ours] == [api.team]
        await accept_invitation(api.client, other, EMAILS["bob"])
        # bob's static token is bob in the first team only; his Google identity signs in to
        # either (the chooser offers both).
        chooser = await to_chooser(api.client, api.fake, EMAILS["bob"])
        assert [t for t in chooser.teams if t in ours] == [api.team, other]
        body = await login(api, "bob", team=other)
        assert (body["team"], body["member"]) == (other, "bobby")


def test_emails_are_one_plain_address():
    assert normalise_email("Alice@Example.COM") == "alice@example.com"
    for bad in ("", "a", "a@b", "a b@c.io", "a@b.io ", "<a@b.io>", "a@b.io,c@d.io", "é@x.io"):
        assert normalise_email(bad) is None, bad
    assert normalise_email("a" * 250 + "@x.io") is None


async def test_static_tokens_resolve_only_while_on_the_roster(api: Api, clock: FakeClock):
    """A token principal in the team file is its member only while the roster holds them:
    the seed put them there, and nothing else can."""
    r = await api.client.get(api.url("/me"), headers=auth("carol"))
    assert r.status_code == 200
    # Simulate an out-of-band removal (an operator, or a future file change): the token stops.
    await api.store.mutate_roster(
        api.team, lambda s: RosterChange(result=None, remove=["carol"]), clock.current
    )
    api.clock.advance(ROSTER_CACHE_TTL.total_seconds())
    r = await api.client.get(api.url("/me"), headers=auth("carol"))
    assert r.status_code == 401


async def test_the_roster_route_is_per_team(api: Api):
    r = await api.client.get("/v1/teams/other/roster", headers=auth("alice"))
    assert r.status_code == 404
    r = await api.client.post(
        "/v1/teams/other/roster", headers=auth("alice"), json={"member": "x1", "email": "x@x.io"}
    )
    assert r.status_code == 404
    refused = [e for e in await api.store.list_audit(api.team) if e.outcome == "refused"]
    assert [(e.action, e.detail) for e in refused] == [("roster.add", "404 not_found")]
