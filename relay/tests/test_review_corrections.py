"""The corrections after the M5/M6 security review (M6-SPEC §7, M5-SPEC §9.3), on both
stores: no identity handover by email (§7.1, with the review's reproduction as a regression
test), accounts bound by Google ``sub`` (§7.2), the limits built with M5/M6 (§7.3), 401
versus 404 (§7.4), the chooser's preselection (§7.5), the forwarded-hops log (§7.7), and the
email in the token response (M5 §9.3). Synthetic identities only."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import timedelta
from typing import Any

import pytest

from relay.credentials import CREDENTIAL_LIFETIME, credential_key, new_credential
from relay.login import REBOUND_LINE, REBOUND_TITLE, forwarded_hops
from relay.pages import chooser_page
from relay.roster import RETIRED_ID_LIFETIME
from relay.store import (
    MAX_LIVE_CREDENTIALS,
    CredentialRecord,
    LoginChoice,
    Redemption,
    RosterChange,
    RosterState,
)

from .conftest import (
    EMAILS,
    Api,
    FakeClock,
    accept_invitation,
    auth,
    delegate_auth,
    id_token,
    open_api,
)
from .login_helpers import (
    bearer,
    choose,
    continue_as,
    google,
    hidden_csrf,
    login,
    start,
    start_query,
    to_chooser,
    token,
)

pytestmark = pytest.mark.anyio

ALT = "alice.alt@example.com"  # alice's own second Google account


def _sha(email: str) -> str:
    return hashlib.sha256(email.encode()).hexdigest()


def _fake_sub(email: str) -> str:
    """The ``sub`` the fake Google gives an email's account (tests.fake_google)."""
    return hashlib.sha256(email.encode()).hexdigest()[:21]


def _logs(out: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in out.splitlines() if line.strip().startswith("{")]


async def _patch(api: Api, member: str, body: dict[str, Any], headers: dict[str, str]):
    return await api.client.patch(api.url(f"/roster/{member}"), headers=headers, json=body)


async def _entry(api: Api, member: str):
    await api.app.state.service.roster.ensure_seeded(api.team)
    return (await api.store.read_roster(api.team)).entries[member]


async def _record(api: Api, credential: str) -> CredentialRecord:
    record = await api.store.find_credential([api.team], credential_key(credential))
    assert record is not None
    return record


# §7.1 No identity handover by email ------------------------------------------------------------


async def test_regression_an_owner_cannot_attach_their_account_to_another_member(api: Api):
    """The review's reproduction, first half: alice (owner) added her own second Google
    account to bob's entry and signed in as bob. The PATCH is now refused."""
    rid = await api.ask("carol", to=["bob"], question="secret for bob only")
    version = await api.store.roster_version(api.team)
    r = await _patch(api, "bob", {"add_email": ALT}, auth("alice"))
    assert r.status_code == 403
    assert r.json()["error"] == "forbidden"
    assert "remove and re-add the member" in r.json()["detail"]
    assert await api.store.roster_version(api.team) == version
    assert (await _entry(api, "bob")).emails == [EMAILS["bob"]]
    # So the second account is on no team, and cannot become bob.
    started = await start(api.client)
    r = await google(api.client, api.fake, started, ALT)
    assert r.status_code == 200 and "not on a team yet" in r.text
    assert 'type="radio"' not in r.text
    r = await api.client.get(api.url(f"/requests/{rid}"), headers=auth("alice"))
    assert r.status_code == 404
    refused = [e for e in await api.store.list_audit(api.team) if e.outcome == "refused"]
    assert [(e.actor, e.action, e.detail) for e in refused] == [
        ("alice", "roster.update", "403 forbidden")
    ]


async def test_regression_a_credential_dies_with_the_email_it_was_minted_through(api: Api):
    """The review's reproduction, second half: a credential minted through an email outlived
    the email's removal. Plant the state the old PATCH allowed (alice's second account on
    bob's entry) straight in the store, sign in through it, remove the email: the
    credential is revoked in the same transaction and cannot read bob's requests."""
    rid = await api.ask("carol", to=["bob"], question="secret for bob only")

    def plant(state: RosterState) -> RosterChange[None]:
        bob = state.entries["bob"]
        bob.emails.append(ALT)
        return RosterChange(result=None, put=[bob])

    await api.store.mutate_roster(api.team, plant, api.clock.current)
    api.clock.advance(31)  # past the roster cache, as another instance would be
    own = (await login(api, "bob"))["credential"]  # bob's own, through his own email
    got = await login(api, email=ALT)
    assert (got["member"], got["email"]) == ("bob", ALT)
    handed = got["credential"]
    assert (await _record(api, handed)).email_sha256 == _sha(ALT)
    r = await api.client.get(api.url(f"/requests/{rid}"), headers=bearer(handed))
    assert r.status_code == 200  # what the review saw, while the email is on the entry

    r = await _patch(api, "bob", {"remove_email": ALT}, auth("alice"))
    assert r.status_code == 200 and r.json()["emails"] == [EMAILS["bob"]]
    record = await _record(api, handed)
    assert record.revoked and record.revoked_at == api.clock.current
    api.clock.advance(120)
    r = await api.client.get(api.url("/me"), headers=bearer(handed))
    assert r.status_code == 401
    r = await api.client.get(api.url(f"/requests/{rid}"), headers=bearer(handed))
    assert r.status_code == 401
    # Bob's own credential, minted through his own email, is untouched.
    assert not (await _record(api, own)).revoked
    r = await api.client.get(api.url("/me"), headers=bearer(own))
    assert r.status_code == 200 and r.json()["member"] == "bob"


async def test_an_owner_adds_and_removes_their_own_second_account(api: Api):
    r = await _patch(api, "alice", {"add_email": ALT}, auth("alice"))
    assert r.status_code == 200 and r.json()["emails"] == [EMAILS["alice"], ALT]
    via_alt = (await login(api, email=ALT))["credential"]
    via_own = (await login(api, "alice"))["credential"]
    assert (await _record(api, via_alt)).email_sha256 == _sha(ALT)
    assert (await _record(api, via_own)).email_sha256 == _sha(EMAILS["alice"])
    # Taking the second account off revokes exactly the credentials minted through it.
    r = await _patch(api, "alice", {"remove_email": ALT}, bearer(via_own))
    assert r.status_code == 200
    assert (await _record(api, via_alt)).revoked
    assert not (await _record(api, via_own)).revoked
    assert (await api.client.get(api.url("/me"), headers=bearer(via_alt))).status_code == 401
    assert (await api.client.get(api.url("/me"), headers=bearer(via_own))).status_code == 200


async def test_removing_an_email_also_revokes_credentials_that_record_none(api: Api):
    """A credential minted before the email was recorded may have come through any email of
    the member, so taking any email off revokes it (the member signs in again)."""
    assert (await _patch(api, "alice", {"add_email": ALT}, auth("alice"))).status_code == 200
    legacy = new_credential()
    now = api.clock.current
    record = CredentialRecord(
        key=credential_key(legacy),
        team=api.team,
        member="alice",
        device="old plugin",
        created_at=now,
        last_used_at=now,
        expire_at=now + CREDENTIAL_LIFETIME,
    )
    await api.store.redeem_code(
        "no-such-code", lambda _: Redemption(result=None, credential=record), now
    )
    assert (await _record(api, legacy)).email_sha256 is None
    assert (await api.client.get(api.url("/me"), headers=bearer(legacy))).status_code == 200
    via_own = (await login(api, "alice"))["credential"]
    outcome_before = await api.store.roster_version(api.team)
    assert (await _patch(api, "alice", {"remove_email": ALT}, auth("alice"))).status_code == 200
    assert await api.store.roster_version(api.team) == outcome_before + 1
    assert (await _record(api, legacy)).revoked
    assert not (await _record(api, via_own)).revoked
    assert (await api.client.get(api.url("/me"), headers=bearer(legacy))).status_code == 401


async def test_another_instance_refuses_a_credential_once_its_email_is_gone(api: Api):
    """Belt and braces for the 60 s credential cache of other instances: once their roster
    (30 s) sees the email gone, a credential minted through it is refused."""
    assert (await _patch(api, "alice", {"add_email": ALT}, auth("alice"))).status_code == 200
    via_alt = bearer((await login(api, email=ALT))["credential"])
    async with api.instance() as (other, _):
        assert (await other.get(api.url("/me"), headers=via_alt)).status_code == 200  # cached
        assert (await _patch(api, "alice", {"remove_email": ALT}, auth("alice"))).is_success
        api.clock.advance(31)  # the roster cache is stale; the credential cache (60 s) is not
        assert (await other.get(api.url("/me"), headers=via_alt)).status_code == 401


# §7.2 Accounts are bound by Google sub ---------------------------------------------------------


async def test_the_first_sign_in_binds_the_email_to_the_account(api: Api):
    assert (await _entry(api, "bob")).subs == {}
    await login(api, "bob")
    assert (await _entry(api, "bob")).subs == {EMAILS["bob"]: _fake_sub(EMAILS["bob"])}
    bound = [e for e in await api.store.list_audit(api.team) if e.action == "roster.bind"]
    assert [(e.actor, e.member, e.email_sha256) for e in bound] == [
        ("bob", "bob", [_sha(EMAILS["bob"])])
    ]
    # The same account signs in again: nothing changes.
    version = await api.store.roster_version(api.team)
    await login(api, "bob")
    assert await api.store.roster_version(api.team) == version


async def test_another_account_with_a_bound_email_is_refused_at_the_callback(api: Api, capsys):
    await login(api, "bob")
    capsys.readouterr()
    started = await start(api.client)
    r = await google(api.client, api.fake, started, EMAILS["bob"], claims={"sub": "9" * 21})
    assert r.status_code == 403
    assert REBOUND_TITLE in r.text and REBOUND_LINE in r.text
    assert 'name="csrf"' not in r.text  # no chooser
    out = capsys.readouterr().out
    assert "9" * 21 not in out and _fake_sub(EMAILS["bob"]) not in out  # subs never logged
    assert any(e.get("reason") == "sub_mismatch" for e in _logs(out))
    # The login is closed.
    r = await google(api.client, api.fake, started, EMAILS["bob"])
    assert r.status_code == 400
    assert (await _entry(api, "bob")).subs == {EMAILS["bob"]: _fake_sub(EMAILS["bob"])}


async def test_a_binding_made_while_the_chooser_was_open_is_checked_at_choose(api: Api):
    """Two accounts sign in with one unbound email at once: the first to choose binds it;
    the other is refused at choose, before a code is minted."""
    first = await to_chooser(api.client, api.fake, EMAILS["carol"])
    started = await start(api.client)
    r = await google(api.client, api.fake, started, EMAILS["carol"], claims={"sub": "8" * 21})
    assert r.status_code == 200  # carol's email is not bound yet
    query = await continue_as(api.client, first, api.team)
    assert (await token(api.client, query["code"], first.started.verifier)).status_code == 200
    r = await choose(
        api.client,
        started.cookie,
        {"csrf": hidden_csrf(r.text), "team": api.team, "action": "continue"},
    )
    assert r.status_code == 403 and "location" not in r.headers
    assert REBOUND_TITLE in r.text
    assert (await _entry(api, "carol")).subs == {EMAILS["carol"]: _fake_sub(EMAILS["carol"])}


async def test_removing_an_email_clears_its_binding(api: Api):
    assert (await _patch(api, "alice", {"add_email": ALT}, auth("alice"))).status_code == 200
    await login(api, email=ALT)
    assert (await _entry(api, "alice")).subs[ALT] == _fake_sub(ALT)
    assert (await _patch(api, "alice", {"remove_email": ALT}, auth("alice"))).status_code == 200
    assert ALT not in (await _entry(api, "alice")).subs
    # Added again, it binds to the next account that signs in with it, even another one.
    assert (await _patch(api, "alice", {"add_email": ALT}, auth("alice"))).status_code == 200
    started = await start(api.client)
    r = await google(api.client, api.fake, started, ALT, claims={"sub": "7" * 21})
    assert r.status_code == 200
    r = await choose(
        api.client,
        started.cookie,
        {"csrf": hidden_csrf(r.text), "team": api.team, "action": "continue"},
    )
    assert r.status_code == 303
    assert (await _entry(api, "alice")).subs[ALT] == "7" * 21


async def test_other_updates_and_the_seed_keep_the_binding(api: Api):
    await login(api, "bob")
    headers = auth("alice")
    assert (await _patch(api, "bob", {"role": "owner"}, headers)).status_code == 200
    assert (await _entry(api, "bob")).subs == {EMAILS["bob"]: _fake_sub(EMAILS["bob"])}
    async with api.instance() as (other, _):  # a new instance upserts the seed again
        assert (await other.get(api.url("/me"), headers=auth("bob"))).status_code == 200
    assert (await _entry(api, "bob")).subs == {EMAILS["bob"]: _fake_sub(EMAILS["bob"])}


@pytest.mark.parametrize(
    "grant",
    [{"drop": ("sub",)}, {"claims": {"sub": ""}}, {"claims": {"sub": 12345}},
     {"claims": {"sub": "x" * 256}}, {"claims": {"sub": "a b"}}],
)  # fmt: skip
async def test_a_google_answer_without_a_usable_sub_is_refused(api: Api, grant: dict[str, Any]):
    started = await start(api.client)
    r = await google(api.client, api.fake, started, EMAILS["alice"], **grant)
    assert r.status_code == 400 and 'name="csrf"' not in r.text
    assert (await _entry(api, "alice")).subs == {}


async def test_a_google_id_token_binds_on_first_use_and_is_checked_after(api: Api):
    """The gcloud path: an ID token carries the account's ``sub``, checked like a sign-in."""
    right = id_token(EMAILS["bob"], "sub-bob-1")
    wrong = id_token(EMAILS["bob"], "sub-bob-2")
    r = await api.client.get(api.url("/me"), headers={"Authorization": f"Bearer {right}"})
    assert r.status_code == 200 and r.json()["member"] == "bob"
    assert (await _entry(api, "bob")).subs == {EMAILS["bob"]: "sub-bob-1"}
    r = await api.client.get(api.url("/me"), headers={"Authorization": f"Bearer {wrong}"})
    assert r.status_code == 401
    # A relay sign-in by another account with that email is refused as well.
    started = await start(api.client)
    r = await google(api.client, api.fake, started, EMAILS["bob"])
    assert r.status_code == 403 and REBOUND_TITLE in r.text
    r = await api.client.get(api.url("/me"), headers={"Authorization": f"Bearer {right}"})
    assert r.status_code == 200


async def test_a_google_id_token_is_checked_against_a_binding_from_a_sign_in(api: Api):
    await login(api, "carol")
    same = id_token(EMAILS["carol"], _fake_sub(EMAILS["carol"]))
    other = id_token(EMAILS["carol"], "someone-else")
    assert (await api.client.get(api.url("/me"), headers=bearer(same))).status_code == 200
    assert (await api.client.get(api.url("/me"), headers=bearer(other))).status_code == 401


async def test_a_google_id_token_binds_only_on_its_own_team(api: Api):
    token_ = id_token(EMAILS["alice"], "sub-alice")
    other = api.teams["other"]
    r = await api.client.get(f"/v1/teams/{other}/me", headers=bearer(token_))
    assert r.status_code == 404
    assert (await _entry(api, "alice")).subs == {}


async def test_a_delegate_is_not_bound(api: Api):
    """The console's delegate token names its service account, not the member: there is no
    member ``sub`` to check on that path, and it binds nothing."""
    await login(api, "alice")
    r = await api.client.get(api.url("/me"), headers=delegate_auth(EMAILS["alice"]))
    assert r.status_code == 200 and r.json()["member"] == "alice"
    assert (await _entry(api, "alice")).subs == {EMAILS["alice"]: _fake_sub(EMAILS["alice"])}


# §7.3 The limits built with M5/M6 (seed_member and member_id_retired: test_roster.py; the
# login limits' defaults: test_limits.py::test_limit_defaults) --------------------------------


def test_the_recorded_limits():
    assert MAX_LIVE_CREDENTIALS == 20
    assert RETIRED_ID_LIFETIME == timedelta(days=31)


# §7.4 401 versus 404 ---------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_no_team_is_401_and_another_team_is_404(kind: str, clock: FakeClock):
    async with open_api(kind, clock) as api:
        other = api.teams["other"]
        cases = [
            # (bearer, team URL, status)
            (id_token("nobody@example.com", "sub-nobody"), api.team, 401),
            (id_token("nobody@example.com", "sub-nobody"), "nosuchteam", 401),
            (id_token(EMAILS["dave"], "sub-dave"), api.team, 404),
            (id_token(EMAILS["dave"], "sub-dave"), "nosuchteam", 404),
            ("dev-token-nobody", api.team, 401),
            ("dev-token-dave-0004", api.team, 404),
            ((await login(api, "alice"))["credential"], other, 404),
            ("trc_" + "A" * 43, api.team, 401),
        ]
        for token_, team, status in cases:
            r = await api.client.get(f"/v1/teams/{team}/me", headers=bearer(token_))
            assert r.status_code == status, (token_[:12], team)
            body = {401: {"error": "unauthenticated"}, 404: {"error": "not_found"}}[status]
            assert r.json() == body
        # A removed member is on no team: 401.
        erin = uuid.uuid4().hex[:6]
        r = await api.client.post(
            api.url("/roster"),
            headers=auth("alice"),
            json={"member": f"e{erin}", "email": f"{erin}@example.com"},
        )
        assert r.status_code == 201
        await accept_invitation(api.client, api.team, f"{erin}@example.com")
        cred = (await login(api, email=f"{erin}@example.com"))["credential"]
        r = await api.client.delete(api.url(f"/roster/e{erin}"), headers=auth("alice"))
        assert r.status_code == 200
        assert (await api.client.get(api.url("/me"), headers=bearer(cred))).status_code == 401


# §7.5 The chooser preselects only a single team ------------------------------------------------


def test_the_chooser_preselects_only_when_there_is_one_team():
    one = [LoginChoice(team="demo", member="alice")]
    two = [*one, LoginChoice(team="other", member="alicia")]
    page = chooser_page(email="a@example.com", device="d", choices=one, csrf="c", action="/x")
    assert page.count(" checked required>") == 1
    page = chooser_page(email="a@example.com", device="d", choices=two, csrf="c", action="/x")
    assert " checked" not in page and page.count(" required>") == 2


# §7.7 The forwarded hops, once per login start -------------------------------------------------


class _Headers:
    def __init__(self, values: list[str]) -> None:
        self._values = values

    def getlist(self, name: str) -> list[str]:
        return self._values if name == "x-forwarded-for" else []


@pytest.mark.parametrize(
    "values, hops",
    [([], 0), (["203.0.113.9"], 1), (["6.6.6.6, 203.0.113.9"], 2),
     (["6.6.6.6", "7.7.7.7, 203.0.113.9"], 3), ([" , "], 0), (["a,,b"], 2)],
)  # fmt: skip
def test_forwarded_hops(values: list[str], hops: int):
    request = type("R", (), {"headers": _Headers(values)})()
    assert forwarded_hops(request) == hops  # type: ignore[arg-type]


async def test_each_login_start_logs_its_hops_and_never_the_addresses(api: Api, capsys):
    capsys.readouterr()
    query, _, _ = start_query()
    forwarded = [("x-forwarded-for", "198.51.100.23, 203.0.113.9"), ("x-forwarded-for", "10.1.2.3")]
    r = await api.client.get("/v1/login/start", params=query, headers=forwarded)
    assert r.status_code == 302
    r = await api.client.get("/v1/login/start", headers=forwarded)  # a bad start
    assert r.status_code == 400
    out = capsys.readouterr().out
    for address in ("198.51.100.23", "203.0.113.9", "10.1.2.3"):
        assert address not in out
    events = [e for e in _logs(out) if "x_forwarded_for_hops" in e]
    assert [(e["event"], e.get("reason"), e["x_forwarded_for_hops"]) for e in events] == [
        ("login_started", None, 3),
        ("login_refused", "bad_start", 3),
    ]


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_a_rate_limited_start_logs_its_hops(kind: str, clock: FakeClock, capsys):
    async with open_api(kind, clock, login_starts_per_minute=1) as api:
        ip = f"10.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}"
        async with api.instance(client_ip=ip) as (c, _):
            query, _, _ = start_query()
            assert (await c.get("/v1/login/start", params=query)).status_code == 302
            capsys.readouterr()
            headers = {"x-forwarded-for": "192.0.2.1"}
            r = await c.get("/v1/login/start", params=query, headers=headers)
            assert r.status_code == 429
        out = capsys.readouterr().out
        assert "192.0.2.1" not in out
        events = [e for e in _logs(out) if "x_forwarded_for_hops" in e]
        assert [(e["event"], e["x_forwarded_for_hops"]) for e in events] == [
            ("login_rate_limited", 1)
        ]


# M5-SPEC §9.3 The token response names the Google account --------------------------------------


async def test_the_token_response_names_the_email_signed_in_with(api: Api):
    assert (await _patch(api, "alice", {"add_email": ALT}, auth("alice"))).status_code == 200
    body = await login(api, email=ALT.upper())
    assert (body["member"], body["email"]) == ("alice", ALT)  # lower-cased, as on the roster
    audit = [e for e in await api.store.list_audit(api.team) if e.action == "credential.create"]
    assert audit[-1].email_sha256 == [_sha(ALT)]
