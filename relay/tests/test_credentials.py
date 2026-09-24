"""Device credentials (M5-SPEC §3, gates in §8) on both stores: authentication, the URL
team, the 60 s cache, logout and revocation, the list of one's own devices, the rolling
expiry, a removed member, and the cap of live credentials per member."""

from __future__ import annotations

import hashlib
import re
from datetime import timedelta

import pytest

from relay.credentials import CREDENTIAL_CACHE_TTL, LAST_USED_INTERVAL
from relay.store import MAX_LIVE_CREDENTIALS

from .conftest import Api, accept_invitation, auth, delegate_auth
from .login_helpers import bearer, login

pytestmark = pytest.mark.anyio


def _key(credential: str) -> str:
    return hashlib.sha256(credential.encode()).hexdigest()


async def _record(api: Api, credential: str):
    return await api.store.find_credential([api.team], _key(credential))


# Authentication -------------------------------------------------------------------------------


async def test_a_credential_is_its_member_for_every_member_route(api: Api):
    cred = bearer((await login(api, "bob"))["credential"])
    r = await api.client.get(api.url("/me"), headers=cred)
    assert r.status_code == 200 and r.json()["member"] == "bob"
    r = await api.client.put(
        api.url("/members/bob/manifest"), headers=cred, json={"version": 1, "capabilities": []}
    )
    assert r.status_code == 200, r.text
    r = await api.client.post(
        api.url("/requests"),
        headers=cred,
        json={
            "idempotency_key": "key-credential-0001",
            "kind": "question",
            "to": ["alice"],
            "question": "Where is the deploy log?",
        },
    )
    assert r.status_code == 201, r.text
    request_id = r.json()["request_id"]
    r = await api.client.get(api.url(f"/requests/{request_id}"), headers=cred)
    assert r.status_code == 200 and r.json()["asker"] == "bob"
    r = await api.client.get(api.url("/streams/replies"), headers=cred)
    assert r.status_code == 200
    # The envelope's sender is the credential's member, whatever the body says.
    inbox = await api.stream("alice", "inbox")
    assert inbox["messages"][-1]["from"] == "bob"


async def test_the_url_team_must_match(api: Api):
    cred = bearer((await login(api, "alice"))["credential"])
    for team in ("other", "nosuchteam"):
        r = await api.client.get(f"/v1/teams/{team}/me", headers=cred)
        assert r.status_code == 404 and r.json() == {"error": "not_found"}
    r = await api.client.post("/v1/teams/other/requests", headers=cred, json={})
    assert r.status_code == 404
    refused = [e for e in await api.store.list_audit(api.team) if e.outcome == "refused"]
    assert [(e.actor, e.action, e.detail) for e in refused] == [
        ("alice", "request.create", "404 not_found")
    ]


@pytest.mark.parametrize(
    "token",
    [
        "trc_",
        "trc_" + "A" * 42,
        "trc_" + "A" * 44,
        "trc_" + "!" * 43,
        "trc_" + "A" * 43,  # well formed, unknown
        "TRC_" + "A" * 43,
    ],
)
async def test_bad_credentials_are_401(api: Api, token: str, capsys):
    r = await api.client.get(api.url("/me"), headers=bearer(token))
    assert r.status_code == 401 and r.json() == {"error": "unauthenticated"}
    assert token not in capsys.readouterr().out


async def test_a_credential_cannot_speak_for_a_delegate(api: Api):
    cred = (await login(api, "alice"))["credential"]
    r = await api.client.get(
        api.url("/me"), headers={**bearer(cred), "X-Relay-On-Behalf-Of": "bob@example.com"}
    )
    assert r.status_code == 400  # the header is only a delegate's


# The 60 s cache -------------------------------------------------------------------------------


async def test_a_revocation_elsewhere_lands_within_a_minute(api: Api):
    cred = (await login(api, "alice"))["credential"]
    assert (await api.client.get(api.url("/me"), headers=bearer(cred))).status_code == 200
    # Another instance revokes it (straight in the store: this instance's cache holds it).
    revoked = await api.store.revoke_credential(
        api.team, _key(cred), "alice", api.clock.current, []
    )
    assert revoked is not None and revoked.revoked
    api.clock.advance(CREDENTIAL_CACHE_TTL.total_seconds() - 1)
    assert (await api.client.get(api.url("/me"), headers=bearer(cred))).status_code == 200
    api.clock.advance(1)
    assert (await api.client.get(api.url("/me"), headers=bearer(cred))).status_code == 401


async def test_another_instance_sees_a_revocation_at_once_when_it_had_not_cached_it(api: Api):
    cred = (await login(api, "alice"))["credential"]
    r = await api.client.delete(api.url("/credentials/self"), headers=bearer(cred))
    assert r.status_code == 200
    async with api.instance() as (other, _):
        r = await other.get(api.url("/me"), headers=bearer(cred))
        assert r.status_code == 401


# Logout, list, revoke ---------------------------------------------------------------------------


async def test_logout_revokes_the_calling_credential_at_once(api: Api):
    first = (await login(api, "alice"))["credential"]
    second = (await login(api, "alice", device="Claude Code on laptop-2"))["credential"]
    r = await api.client.delete(api.url("/credentials/self"), headers=bearer(first))
    assert r.status_code == 200 and r.json() == {"revoked": _key(first)[:16]}
    assert (await api.client.get(api.url("/me"), headers=bearer(first))).status_code == 401
    assert (await api.client.get(api.url("/me"), headers=bearer(second))).status_code == 200
    audit = [e for e in await api.store.list_audit(api.team) if e.action == "credential.revoke"]
    assert [(e.actor, e.member, e.detail) for e in audit] == [
        ("alice", "alice", f"credential {_key(first)[:16]}; logout")
    ]
    assert all(first not in repr(e) and _key(first) not in repr(e) for e in audit)


async def test_logout_needs_a_credential(api: Api):
    r = await api.client.delete(api.url("/credentials/self"), headers=auth("alice"))
    assert r.status_code == 400 and r.json()["error"] == "not_a_credential"


async def test_the_list_is_the_callers_own_devices(api: Api):
    first = (await login(api, "alice", device="Claude Code on alpha"))["credential"]
    api.clock.advance(5)
    second = (await login(api, "alice", device="Claude Code on beta"))["credential"]
    await login(api, "bob", device="Claude Code on bobs-box")
    api.clock.advance(LAST_USED_INTERVAL.total_seconds())
    await api.client.get(api.url("/me"), headers=bearer(first))  # first is now the latest used

    # Listed with a static token (which touches no credential): most recently used first.
    r = await api.client.get(api.url("/credentials"), headers=auth("alice"))
    assert r.status_code == 200
    items = r.json()["credentials"]
    assert [i["device"] for i in items] == ["Claude Code on alpha", "Claude Code on beta"]
    assert [i["id"] for i in items] == [_key(first)[:16], _key(second)[:16]]
    assert [i["current"] for i in items] == [False, False]
    assert set(items[0]) == {"id", "device", "created_at", "last_used_at", "expires_at", "current"}
    assert all(re.fullmatch(r"[0-9a-f]{16}", i["id"]) for i in items)
    # With a credential: the same devices, that one marked current.
    r = await api.client.get(api.url("/credentials"), headers=bearer(second))
    current = {i["id"]: i["current"] for i in r.json()["credentials"]}
    assert current == {_key(first)[:16]: False, _key(second)[:16]: True}
    # carol has none.
    r = await api.client.get(api.url("/credentials"), headers=auth("carol"))
    assert r.json() == {"credentials": []}


async def test_revoking_one_of_ones_own_by_id(api: Api):
    first = (await login(api, "alice"))["credential"]
    second = (await login(api, "alice"))["credential"]
    bobs = (await login(api, "bob"))["credential"]
    r = await api.client.delete(api.url(f"/credentials/{_key(first)[:16]}"), headers=bearer(second))
    assert r.status_code == 200 and r.json() == {"revoked": _key(first)[:16]}
    assert (await api.client.get(api.url("/me"), headers=bearer(first))).status_code == 401
    # Someone else's, an unknown id, a malformed one, an already revoked one: 404.
    for which in (_key(bobs)[:16], "0" * 16, "xyz", _key(bobs), _key(first)[:16]):
        r = await api.client.delete(api.url(f"/credentials/{which}"), headers=bearer(second))
        assert r.status_code == 404, which
    assert (await api.client.get(api.url("/me"), headers=bearer(bobs))).status_code == 200


async def test_a_delegate_cannot_touch_credentials(api: Api):
    r = await api.client.get(api.url("/credentials"), headers=delegate_auth("alice@example.com"))
    assert r.status_code == 403
    r = await api.client.delete(
        api.url("/credentials/self"), headers=delegate_auth("alice@example.com")
    )
    assert r.status_code == 403


# Rolling expiry -------------------------------------------------------------------------------


async def test_the_expiry_rolls_with_use(api: Api):
    cred = (await login(api, "alice"))["credential"]
    start = api.clock.current
    for _ in range(3):
        api.clock.advance(80 * 86400)  # under 90 days since the last use, each time
        r = await api.client.get(api.url("/me"), headers=bearer(cred))
        assert r.status_code == 200
    record = await _record(api, cred)
    assert record.last_used_at == api.clock.current
    assert record.expire_at == api.clock.current + timedelta(days=90)
    assert record.expire_at > start + timedelta(days=90)
    api.clock.advance(90 * 86400)
    assert (await api.client.get(api.url("/me"), headers=bearer(cred))).status_code == 401


async def test_last_used_is_written_at_most_every_ten_minutes(api: Api):
    cred = (await login(api, "alice"))["credential"]
    created = (await _record(api, cred)).last_used_at
    api.clock.advance(LAST_USED_INTERVAL.total_seconds() - 1)
    await api.client.get(api.url("/me"), headers=bearer(cred))
    api.clock.advance(1)  # still inside the 60 s cache, but now due: the write happens
    await api.client.get(api.url("/me"), headers=bearer(cred))
    record = await _record(api, cred)
    assert record.last_used_at == created + LAST_USED_INTERVAL
    api.clock.advance(60)
    await api.client.get(api.url("/me"), headers=bearer(cred))
    assert (await _record(api, cred)).last_used_at == created + LAST_USED_INTERVAL


# Removed members ---------------------------------------------------------------------------


async def _add(api: Api, member: str, email: str) -> None:
    r = await api.client.post(
        api.url("/roster"), headers=auth("alice"), json={"member": member, "email": email}
    )
    assert r.status_code == 201, r.text
    await accept_invitation(api.client, api.team, email)  # M9-SPEC §7.2


async def test_a_removed_member_is_refused_and_their_credentials_revoked(api: Api):
    await _add(api, "erin", "erin@example.com")
    cred = (await login(api, "erin", email="erin@example.com"))["credential"]
    assert (await api.client.get(api.url("/me"), headers=bearer(cred))).status_code == 200
    r = await api.client.delete(api.url("/roster/erin"), headers=auth("alice"))
    assert r.status_code == 200
    assert (await api.client.get(api.url("/me"), headers=bearer(cred))).status_code == 401
    record = await _record(api, cred)
    assert record.revoked and record.revoked_at == api.clock.current


async def test_a_removed_member_is_refused_on_another_instance_within_30_seconds(api: Api):
    await _add(api, "erin", "erin@example.com")
    cred = (await login(api, "erin", email="erin@example.com"))["credential"]
    async with api.instance() as (other, _):
        assert (await other.get(api.url("/me"), headers=bearer(cred))).status_code == 200
        r = await api.client.delete(api.url("/roster/erin"), headers=auth("alice"))
        assert r.status_code == 200
        api.clock.advance(30)  # the other instance's roster and credential caches both lapse
        assert (await other.get(api.url("/me"), headers=bearer(cred))).status_code == 401


async def test_a_member_added_again_does_not_revive_old_credentials(api: Api):
    await _add(api, "erin", "erin@example.com")
    old = (await login(api, "erin", email="erin@example.com"))["credential"]
    assert (await api.client.delete(api.url("/roster/erin"), headers=auth("alice"))).status_code
    api.clock.advance(1)
    await _add(api, "erin", "erin@example.com")
    assert (await api.client.get(api.url("/me"), headers=bearer(old))).status_code == 401
    new = (await login(api, "erin", email="erin@example.com"))["credential"]
    assert (await api.client.get(api.url("/me"), headers=bearer(new))).status_code == 200


# The cap ------------------------------------------------------------------------------------


async def test_at_most_twenty_live_credentials_per_member(api: Api):
    creds = []
    for i in range(MAX_LIVE_CREDENTIALS + 1):
        creds.append((await login(api, "carol", device=f"Claude Code on box-{i}"))["credential"])
        api.clock.advance(1)
    # The least recently used (the first) went when the 21st was minted.
    assert (await api.client.get(api.url("/me"), headers=bearer(creds[0]))).status_code == 401
    assert (await api.client.get(api.url("/me"), headers=bearer(creds[-1]))).status_code == 200
    r = await api.client.get(api.url("/credentials"), headers=auth("carol"))
    assert len(r.json()["credentials"]) == MAX_LIVE_CREDENTIALS
    audit = [
        e
        for e in await api.store.list_audit(api.team)
        if e.action == "credential.revoke" and "device limit" in (e.detail or "")
    ]
    assert [(e.actor, e.member) for e in audit] == [("relay", "carol")]
