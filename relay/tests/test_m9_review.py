"""M9-SPEC §7, the corrections after the M9 security review, on both stores, one section per
item. The review's probes are here as regression tests (a file team adopting a squatted
created team, unsolicited membership, concurrent creations by one account, a delegate telling
teams apart and ids probed by creation for free).

Every account is a fresh email: on the shared Firestore emulator an account's counters and
teams count across tests."""

from __future__ import annotations

import asyncio
import hashlib
import re
import uuid
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlencode

import httpx
import pytest

from relay.app import create_app
from relay.config import Settings, load_schema, parse_team_config
from relay.roster import SeedConflict, email_hash
from relay.store import MEMBER_ACTIVE, MEMBER_INVITED, AuditEntry, Quota, sub_account_key
from relay.teams import ALL_TEAMS

from .conftest import (
    DELEGATE_TOKENS,
    EMAILS,
    LOGIN_LIMITS,
    PUBLIC_URL,
    SCHEMA_PATH,
    Api,
    DelegateVerifier,
    FakeClock,
    accept_invitation,
    auth,
    google_sub,
    open_api,
    team_config_data,
    with_delegates,
)
from .fake_google import FakeGoogleProvider
from .login_helpers import (
    bearer,
    choose,
    continue_as,
    login,
    team_values,
    to_chooser,
    token,
)
from .test_teams_api import (
    CONSOLE_IP_HASH,
    admin_delete,
    any_delegate,
    create,
    google,
    made,
    new_email,
    new_id,
    with_m9,
)

pytestmark = pytest.mark.anyio

ADMIN = "relay-admin@example.com"
FORM = {"Content-Type": "application/x-www-form-urlencoded"}


@pytest.fixture(autouse=True)
def _fresh_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    import tests.test_teams_api as teams_api

    email = f"admin-{uuid.uuid4().hex[:12]}@example.com"
    monkeypatch.setitem(globals(), "ADMIN", email)
    monkeypatch.setattr(teams_api, "ADMIN", email)


@pytest.fixture(params=["memory", "firestore"])
async def api(request: pytest.FixtureRequest, clock: FakeClock) -> AsyncIterator[Api]:
    async with open_api(request.param, clock, configure=with_m9()) as opened:
        yield opened


async def invite(api: Api, team: str, by: dict[str, str], member: str, email: str, **extra: Any):
    r = await api.client.post(
        f"/v1/teams/{team}/roster", json={"member": member, "email": email, **extra}, headers=by
    )
    assert r.status_code == 201, r.text
    return r.json()


async def answer(api: Api, team: str, headers: dict[str, str], accept: Any = True):
    return await api.client.post(
        f"/v1/me/invitations/{team}", json={"accept": accept}, headers=headers
    )


# §7.1 A file team never adopts a created team ---------------------------------------------------


def settings_with(api: Api, *extra_teams: dict[str, Any]) -> Settings:
    """The test's team file (its two teams, their delegates, the admin) plus ``extra_teams``."""
    data = team_config_data(min_ack_timeout_seconds=2, **LOGIN_LIMITS)
    data["teams"][0]["id"] = api.team
    data["teams"][1]["id"] = api.teams["other"]
    with_delegates(data)
    with_m9()(data)
    data["teams"].extend(extra_teams)
    return Settings(
        team_config=parse_team_config(data),
        manifest_schema=load_schema(SCHEMA_PATH),
        auth_mode="static",
        public_url=PUBLIC_URL,
    )


def file_team(team: str, email: str) -> dict[str, Any]:
    return {
        "id": team,
        "members": [{"id": "boss", "role": "owner", "principals": [f"google:{email}"]}],
    }


async def start_with(api: Api, settings: Settings) -> None:
    assert api.fake is not None
    app = create_app(
        settings,
        api.store,
        clock=api.clock,
        verifier=DelegateVerifier(),
        oauth=FakeGoogleProvider(api.fake),
    )
    async with app.router.lifespan_context(app):
        pass


async def test_a_file_team_never_adopts_a_squatted_created_team(api: Api, capsys):
    """The review's probe: mallory creates the id an operator later lists in the file, and
    pre-invites the future seed owner's email under an id of her choosing. The relay refuses
    to start, naming the id, and writes nothing of the seed."""
    mallory, boss = new_email(), new_email()
    team = await made(api, mallory, member="mallory")
    await invite(api, team, google(mallory), "victim", boss)
    before = await api.store.read_roster(team)
    with pytest.raises(SeedConflict) as caught:
        await start_with(api, settings_with(api, file_team(team, boss)))
    assert team in str(caught.value)
    assert '"seed_team_conflict"' in capsys.readouterr().out
    after = await api.store.read_roster(team)
    assert after.version == before.version and set(after.entries) == {"mallory", "victim"}
    record = (await api.store.get_teams([team]))[team]
    assert record.seed is False and record.status == "active"
    # The admin can still delete it: it is not a seed team.
    assert (await admin_delete(api, team)).status_code == 200


async def test_a_deleted_created_team_is_not_adopted_either(api: Api):
    team = await made(api, new_email())
    assert (await admin_delete(api, team)).status_code == 200
    with pytest.raises(SeedConflict):
        await start_with(api, settings_with(api, file_team(team, new_email())))
    record = (await api.store.get_teams([team]))[team]
    assert (record.seed, record.status) == (False, "deleted")


async def test_the_store_never_marks_a_created_team_as_seed(api: Api):
    team = await made(api, new_email())
    record = await api.store.ensure_seed_team(team, "Taken", api.clock.current)
    assert record.seed is False and record.name == "Platform team"
    assert (await api.store.get_teams([team]))[team].seed is False


async def test_a_team_is_created_only_over_an_empty_id(api: Api):
    team = new_id()
    assert await api.store.team_has_documents(team) is False
    # Something left under the id without a record (a stray audit entry, here).
    now = api.clock.current
    entry = AuditEntry(time=now, team=team, actor="x", action="a", outcome="o", expire_at=now)
    await api.store.append_audit([entry])
    assert await api.store.team_has_documents(team) is True
    r = await create(api, new_email(), team)
    assert r.status_code == 409 and r.json()["error"] == "team_id_unavailable"
    assert await api.store.get_teams([team]) == {}
    # A counter alone counts too.
    other = new_id()
    await api.store.count_quota(other, Quota(key="k", limit=5, expire_at=now))
    assert (await create(api, new_email(), other)).status_code == 409


# §7.2 Invitations, not silent membership --------------------------------------------------------


async def test_an_unsolicited_addition_is_only_an_invitation(api: Api):
    """The review's probe: mallory adds alice to her team; alice's teams do not list it, her
    invitations do, and it grants her nothing until she accepts."""
    mallory = new_email()
    team = await made(api, mallory, member="mallory")
    body = await invite(api, team, google(mallory), "alice", EMAILS["alice"])
    assert body["status"] == "invited"
    r = await api.client.get("/v1/me/teams", headers=google(EMAILS["alice"]))
    assert [t["team"] for t in r.json()["teams"]] == [api.team]
    # (alice is everyone's alice on the shared emulator: this team's invitation only.)
    assert [i for i in r.json()["invitations"] if i["team"] == team] == [
        {
            "team": team,
            "name": "Platform team",
            "member": "alice",
            "role": "member",
            "invited_by_member": "mallory",
        }
    ]
    # Nothing in the team: 404 (she is on another team), for her and for the console.
    r = await api.client.get(f"/v1/teams/{team}/me", headers=google(EMAILS["alice"]))
    assert r.status_code == 404
    r = await api.client.get(f"/v1/teams/{team}/directory", headers=any_delegate(EMAILS["alice"]))
    assert r.status_code == 404
    # Not a teammate, not a recipient, not in the directory.
    r = await api.client.get(f"/v1/teams/{team}/me", headers=google(mallory))
    assert r.json()["teammates"] == []
    r = await api.client.post(
        f"/v1/teams/{team}/requests",
        headers=google(mallory),
        json={"idempotency_key": "k-" + uuid.uuid4().hex, "kind": "question", "to": ["alice"],
              "question": "Hi"},
    )  # fmt: skip
    assert r.status_code == 400 and r.json()["error"] == "bad_recipients"
    r = await api.client.post(
        f"/v1/teams/{team}/requests",
        headers=google(mallory),
        json={"idempotency_key": "k-" + uuid.uuid4().hex, "kind": "question", "to": "*",
              "question": "Hi"},
    )  # fmt: skip
    assert r.status_code == 400 and r.json()["error"] == "bad_recipients"
    # Not a team to sign in to.
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    assert chooser.teams == [api.team]
    r = await choose(
        api.client,
        chooser.started.cookie,
        {"csrf": chooser.csrf, "team": team, "action": "continue"},
    )
    assert r.status_code == 400 and "location" not in r.headers


async def test_an_invited_account_on_no_team_is_refused_everywhere(api: Api):
    owner, guest = new_email(), new_email()
    team = await made(api, owner)
    await invite(api, team, google(owner), "guest", guest)
    r = await api.client.get(f"/v1/teams/{team}/me", headers=google(guest))
    assert r.status_code == 401  # on no team at all
    r = await api.client.get(f"/v1/teams/{team}/roster", headers=any_delegate(guest))
    assert r.status_code == 404
    r = await api.client.get("/v1/me/teams", headers=google(guest))
    assert r.json()["teams"] == [] and [i["team"] for i in r.json()["invitations"]] == [team]


async def test_the_owner_sees_the_invitation_and_members_do_not(api: Api):
    owner, member, guest = new_email(), new_email(), new_email()
    team = await made(api, owner, member="olga")
    await invite(api, team, google(owner), "max", member)
    await accept_invitation(api.client, team, member)
    await invite(api, team, google(owner), "gus", guest, role="owner")
    r = await api.client.get(f"/v1/teams/{team}/roster", headers=google(owner))
    rows = {m["member"]: m for m in r.json()["members"]}
    assert {m: (row["status"], row["role"]) for m, row in rows.items()} == {
        "gus": ("invited", "owner"),
        "max": ("active", "member"),
        "olga": ("active", "owner"),
    }
    assert rows["gus"]["emails"] == [guest]
    r = await api.client.get(f"/v1/teams/{team}/roster", headers=google(member))
    assert [m["member"] for m in r.json()["members"]] == ["max", "olga"]
    # The counts are the members': an invitation is not one yet.
    record = (await api.store.get_teams([team]))[team]
    assert (record.members, record.owners) == (2, 1)


async def test_accepting_makes_a_member_and_binds_the_account(api: Api):
    owner, guest = new_email(), new_email()
    team = await made(api, owner, member="olga")
    await invite(api, team, google(owner), "gus", guest)
    api.clock.advance(1)  # the audit is ordered by time
    r = await answer(api, team, google(guest))
    assert r.status_code == 200, r.text
    assert r.json() == {
        "team": team,
        "name": "Platform team",
        "member": "gus",
        "role": "member",
        "status": "active",
    }
    r = await api.client.get(f"/v1/teams/{team}/me", headers=google(guest))
    assert r.status_code == 200 and r.json()["member"] == "gus"
    # Accepting was this Google account's first use: another account with the email is not him.
    r = await api.client.get(f"/v1/teams/{team}/me", headers=google(guest, "another-sub"))
    assert r.status_code == 401
    r = await api.client.get(f"/v1/teams/{team}/me", headers=google(owner))
    assert r.json()["teammates"] == ["gus"]
    # Answered: nothing left to answer.
    assert (await answer(api, team, google(guest))).status_code == 404
    audit = [e for e in await api.store.list_audit(team) if e.action.startswith("roster.")]
    assert [(e.action, e.actor, e.member, e.outcome) for e in audit] == [
        ("roster.add", "olga", "gus", "invited"),
        ("roster.accept", "gus", "gus", "accepted"),
    ]
    assert audit[1].email_sha256 == [email_hash(guest)] and "@" not in repr(audit)


async def test_declining_removes_the_entry_and_retires_nothing(api: Api):
    owner, guest = new_email(), new_email()
    team = await made(api, owner, member="olga")
    await invite(api, team, google(owner), "gus", guest)
    api.clock.advance(1)  # the audit is ordered by time
    r = await answer(api, team, google(guest), accept=False)
    assert r.status_code == 200 and r.json() == {
        "team": team,
        "member": "gus",
        "status": "declined",
    }
    assert "gus" not in (await api.store.read_roster(team)).entries
    r = await api.client.get("/v1/me/teams", headers=google(guest))
    assert r.json()["invitations"] == []
    # The id never had a member: someone else may be invited under it at once.
    api.clock.advance(1)
    await invite(api, team, google(owner), "gus", new_email())
    audit = [e.action for e in await api.store.list_audit(team) if e.action.startswith("roster.")]
    assert audit == ["roster.add", "roster.decline", "roster.add"]


async def test_an_owner_withdraws_an_invitation_without_retiring_the_id(api: Api):
    owner = new_email()
    team = await made(api, owner, member="olga")
    await invite(api, team, google(owner), "gus", new_email())
    r = await api.client.delete(f"/v1/teams/{team}/roster/gus", headers=google(owner))
    assert r.status_code == 200
    assert (await api.store.read_roster(team)).retired == {}
    await invite(api, team, google(owner), "gus", new_email())


async def test_an_invited_owner_is_not_an_owner_yet(api: Api):
    owner, guest = new_email(), new_email()
    team = await made(api, owner, member="olga")
    await invite(api, team, google(owner), "gus", guest, role="owner")
    # The only active owner cannot step down or leave on the strength of an invitation.
    r = await api.client.patch(
        f"/v1/teams/{team}/roster/olga", json={"role": "member"}, headers=google(owner)
    )
    assert r.status_code == 409 and r.json()["error"] == "last_owner"
    r = await api.client.delete(f"/v1/teams/{team}/roster/olga", headers=google(owner))
    assert r.status_code == 409 and r.json()["error"] == "last_owner"
    # An invited owner changes nothing.
    r = await api.client.post(
        f"/v1/teams/{team}/roster",
        json={"member": "x9", "email": new_email()},
        headers=google(guest),
    )
    assert r.status_code == 401
    # Demoting an invitation is allowed; so is changing it back.
    r = await api.client.patch(
        f"/v1/teams/{team}/roster/gus", json={"role": "member"}, headers=google(owner)
    )
    assert r.status_code == 200 and r.json()["status"] == "invited"


async def test_a_file_teams_owner_invites_too(api: Api):
    guest = new_email()
    await invite(api, api.team, auth("alice"), "gus", guest)
    # A per-team delegate names the invitee: not a member.
    r = await api.delegated("GET", "/me", guest)
    assert r.status_code == 403 and r.json()["error"] == "not_a_member"
    r = await api.client.get("/v1/me/teams", headers=google(guest))
    assert r.json()["invitations"][0]["team"] == api.team
    assert r.json()["invitations"][0]["invited_by_member"] == "alice"
    await accept_invitation(api.client, api.team, guest)
    r = await api.delegated("GET", "/me", guest)
    assert r.status_code == 200 and r.json()["member"] == "gus"


@pytest.mark.parametrize(
    "body", [{}, {"accept": "yes"}, {"accept": 1}, {"accept": True, "x": 1}, [True], "true"]
)
async def test_an_answer_is_exactly_accept_true_or_false(api: Api, body: Any):
    owner, guest = new_email(), new_email()
    team = await made(api, owner)
    await invite(api, team, google(owner), "gus", guest)
    r = await api.client.post(f"/v1/me/invitations/{team}", json=body, headers=google(guest))
    assert r.status_code == 422 and r.json()["error"] == "invalid_body"


async def test_answering_needs_the_invitees_google_identity(api: Api):
    owner, guest = new_email(), new_email()
    team = await made(api, owner)
    await invite(api, team, google(owner), "gus", guest)
    assert (await answer(api, team, {})).status_code == 401
    r = await answer(api, team, auth("alice"))
    assert r.status_code == 403 and r.json()["error"] == "google_identity_required"
    # Someone else has no invitation there; nor does anyone at a team that is not one.
    assert (await answer(api, team, google(new_email()))).status_code == 404
    assert (await answer(api, new_id(), google(guest))).status_code == 404
    assert (await answer(api, "__x__", google(guest))).status_code == 404
    # A per-team delegate answers only for its own team; a read-only one not at all.
    per_team = {"Authorization": f"Bearer {DELEGATE_TOKENS['demo']}", "X-Relay-On-Behalf-Of": guest}
    assert (await answer(api, team, per_team)).status_code == 403  # scope read
    # The any-team delegate (manage-roster) answers for the email it names.
    r = await answer(api, team, any_delegate(guest))
    assert r.status_code == 200 and r.json()["status"] == "active"
    audit = [e for e in await api.store.list_audit(team) if e.action == "roster.accept"]
    assert audit[0].detail is not None and "via delegate" in audit[0].detail


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_a_per_team_managing_delegate_answers_only_for_its_team(kind: str, clock: FakeClock):
    def manage(data: dict[str, Any]) -> None:
        data["delegates"][0]["scope"] = ["read", "manage-roster"]

    async with open_api(kind, clock, configure=manage) as api:
        guest = new_email()
        await invite(api, api.team, auth("alice"), "gus", guest)
        headers = {
            "Authorization": f"Bearer {DELEGATE_TOKENS['demo']}",
            "X-Relay-On-Behalf-Of": guest,
        }
        r = await answer(api, api.teams["other"], headers)
        assert r.status_code == 404
        r = await answer(api, api.team, headers)
        assert r.status_code == 200 and r.json()["member"] == "gus"


async def test_an_invitation_bound_to_another_account_is_not_its_to_answer(api: Api):
    """An email bound to one Google account (it was a member, left an email binding behind)
    cannot be answered by another account holding the email."""
    owner, guest = new_email(), new_email()
    team = await made(api, owner, member="olga")
    await invite(api, team, google(owner), "gus", guest)
    r = await answer(api, team, google(guest, "sub-one"))
    assert r.status_code == 200
    # Removed and invited again under the same id: its binding went with the removal.
    assert (
        await api.client.delete(f"/v1/teams/{team}/roster/gus", headers=google(owner))
    ).status_code == 200
    await invite(api, team, google(owner), "gus", guest)
    r = await answer(api, team, google(guest, "sub-two"))
    assert r.status_code == 200


async def test_roster_entries_without_a_status_are_active():
    """The migration: an entry stored before invitations (no ``status``) is active; any
    status but "active" grants nothing."""
    from relay.store_firestore import _roster_from_doc, _roster_to_doc

    from .conftest import START

    doc = {
        "member": "bob",
        "emails": ["bob@example.com"],
        "role": "member",
        "added_by": "relay",
        "added_at": START,
        "updated_at": START,
    }
    assert _roster_from_doc(doc).status == MEMBER_ACTIVE
    assert _roster_from_doc({**doc, "status": "active"}).status == MEMBER_ACTIVE
    assert _roster_from_doc({**doc, "status": "invited"}).status == MEMBER_INVITED
    assert _roster_from_doc({**doc, "status": "Active"}).status == MEMBER_INVITED
    entry = _roster_from_doc({**doc, "status": "invited"})
    assert _roster_to_doc(entry)["status"] == "invited"


@pytest.mark.parametrize("kind", ["firestore"])
async def test_an_entry_stored_before_invitations_resolves_as_a_member(kind: str, clock: FakeClock):
    """On the live store: a roster document written without ``status`` (as every one before
    this change) is a member, with no step to run."""
    from google.cloud import firestore

    async with open_api(kind, clock, configure=with_m9()) as api:
        owner, old = new_email(), new_email()
        team = await made(api, owner, member="olga")
        await invite(api, team, google(owner), "max", old)
        ref = api.store._roster_col(team).document("max")  # type: ignore[attr-defined]
        await ref.update({"status": firestore.DELETE_FIELD})
        state = await api.store.read_roster(team)
        assert state.entries["max"].status == MEMBER_ACTIVE
        api.clock.advance(31)  # past every roster cache
        r = await api.client.get(f"/v1/teams/{team}/me", headers=google(old))
        assert r.status_code == 200 and r.json()["member"] == "max"


async def test_a_seed_member_is_active_from_the_start(api: Api):
    assert (await api.client.get(api.url("/me"), headers=auth("carol"))).status_code == 200
    state = await api.store.read_roster(api.team)
    assert {m: e.status for m, e in state.entries.items()} == {
        "alice": "active",
        "bob": "active",
        "carol": "active",
    }


@pytest.mark.parametrize("name", ["DEMO TEAM", "  demo   team ", "Demo Team", "OTHER"])
@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_a_name_equal_to_a_file_teams_is_refused(kind: str, clock: FakeClock, name: str):
    def named(data: dict[str, Any]) -> None:
        with_m9()(data)
        data["teams"][0]["name"] = "Demo Team"

    async with open_api(kind, clock, configure=named) as api:
        r = await create(api, new_email(), new_id(), name=name)
        assert r.status_code == 409 and r.json()["error"] == "team_name_unavailable", r.text
        assert (await create(api, new_email(), new_id(), name="Demo Teams")).status_code == 201


# §7.2 in the login chooser ----------------------------------------------------------------------


async def post_invitation(
    client: httpx.AsyncClient, cookie: str | None, fields: dict[str, str], **headers: str
) -> httpx.Response:
    all_headers = {**FORM, **headers}
    if cookie is not None:
        all_headers["Cookie"] = f"trl={cookie}"
    return await client.post("/v1/login/invitation", content=urlencode(fields), headers=all_headers)


def page_inputs(html: str) -> set[str]:
    return set(re.findall(r'<input\b[^>]*name="([^"]*)"', html))


async def test_the_chooser_lists_invitations_and_keeps_its_contract(api: Api):
    mallory = new_email()
    team = await made(api, mallory, member="mallory")
    await invite(api, team, google(mallory), "ali", EMAILS["alice"])
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    html = chooser.response.text
    assert chooser.teams == [api.team]
    assert "Platform team" in html and "invited by" in html and "mallory" in html
    # One form, the same inputs; the answers are buttons after Continue.
    assert html.count("<form") == 1 and page_inputs(html) == {"csrf", "team"}
    assert re.findall(r'<button[^>]*name="action" value="([^"]*)"', html) == [
        "continue",
        "cancel",
        "new",
    ]
    buttons = re.findall(r"<button[^>]*>", html)
    assert 'value="continue"' in buttons[0]
    assert f'formaction="/v1/login/invitation" formnovalidate name="accept" value="{team}"' in html
    assert f'name="decline" value="{team}"' in html


async def test_accepting_in_the_chooser_signs_in_to_the_team(api: Api):
    owner, guest = new_email(), new_email()
    team = await made(api, owner, member="olga")
    await invite(api, team, google(owner), "gus", guest)
    chooser = await to_chooser(api.client, api.fake, guest)
    # On no team: no radios and no Continue, the invitation and the way to create a team.
    html = chooser.response.text
    assert chooser.teams == [] and 'value="continue"' not in html
    assert "You're not on a team yet" in html and 'value="new"' in html
    r = await post_invitation(
        api.client, chooser.started.cookie, {"csrf": chooser.csrf, "accept": team}
    )
    assert r.status_code == 200, r.text
    assert team_values(r.text) == [team] and f'value="{team}" checked' in r.text
    assert "invited by" not in r.text
    query = await continue_as(api.client, chooser, team)
    r = await token(api.client, query["code"], chooser.started.verifier)
    assert r.status_code == 200 and (r.json()["team"], r.json()["member"]) == (team, "gus")
    credential = bearer(r.json()["credential"])
    assert (await api.client.get(f"/v1/teams/{team}/me", headers=credential)).status_code == 200


async def test_declining_in_the_chooser(api: Api):
    owner = new_email()
    team = await made(api, owner)
    await invite(api, team, google(owner), "ali", EMAILS["alice"])
    chooser = await to_chooser(api.client, api.fake, EMAILS["alice"])
    assert f'name="decline" value="{team}"' in chooser.response.text
    r = await post_invitation(
        api.client, chooser.started.cookie, {"csrf": chooser.csrf, "decline": team}
    )
    assert r.status_code == 200 and f'value="{team}"' not in r.text
    assert team_values(r.text) == [api.team]
    assert "ali" not in (await api.store.read_roster(team)).entries
    # Declined by a guest on no other team: back to "not on a team yet" with the create form.
    guest = new_email()
    await invite(api, team, google(owner), "gus", guest)
    chooser = await to_chooser(api.client, api.fake, guest)
    r = await post_invitation(
        api.client, chooser.started.cookie, {"csrf": chooser.csrf, "decline": team}
    )
    assert r.status_code == 200 and 'action="/v1/login/create"' in r.text


async def test_an_invitation_no_longer_open_shows_a_notice(api: Api):
    owner, guest = new_email(), new_email()
    team = await made(api, owner)
    await invite(api, team, google(owner), "gus", guest)
    chooser = await to_chooser(api.client, api.fake, guest)
    r = await api.client.delete(f"/v1/teams/{team}/roster/gus", headers=google(owner))
    assert r.status_code == 200
    r = await post_invitation(
        api.client, chooser.started.cookie, {"csrf": chooser.csrf, "accept": team}
    )
    # On no team any more: the create page, with the notice.
    assert r.status_code == 409 and "no longer open" in r.text
    assert 'action="/v1/login/create"' in r.text
    r = await post_invitation(
        api.client, chooser.started.cookie, {"csrf": chooser.csrf, "accept": "__x__"}
    )
    assert r.status_code == 409
    # With teams: the chooser, with the notice.
    alice = await to_chooser(api.client, api.fake, EMAILS["alice"])
    r = await post_invitation(
        api.client, alice.started.cookie, {"csrf": alice.csrf, "accept": team}
    )
    assert r.status_code == 409 and "no longer open" in r.text
    assert team_values(r.text) == [api.team]


@pytest.mark.parametrize(
    "fields, status",
    [
        ({"csrf": "A" * 43, "accept": "TEAM"}, 403),
        ({"csrf": "", "accept": "TEAM"}, 403),
        ({"accept": "TEAM", "decline": "TEAM"}, 400),
        ({}, 400),
        ({"accept": "TEAM", "action": "continue"}, 400),
        ({"accept": "TEAM", "name": "x"}, 400),
    ],
)
async def test_the_invitation_form_is_checked_like_the_chooser(
    api: Api, fields: dict[str, str], status: int
):
    owner, guest = new_email(), new_email()
    team = await made(api, owner)
    await invite(api, team, google(owner), "gus", guest)
    chooser = await to_chooser(api.client, api.fake, guest)
    body = {"csrf": chooser.csrf, **{k: v.replace("TEAM", team) for k, v in fields.items()}}
    r = await post_invitation(api.client, chooser.started.cookie, body)
    assert r.status_code == status, r.text
    # No cookie, another origin: nothing either.
    ok = {"csrf": chooser.csrf, "accept": team}
    assert (await post_invitation(api.client, None, ok)).status_code == 400
    r = await post_invitation(api.client, chooser.started.cookie, ok, Origin="https://evil.test")
    assert r.status_code == 403
    r = await api.client.post(
        "/v1/login/invitation",
        json=ok,
        headers={"Cookie": f"trl={chooser.started.cookie}"},
    )
    assert r.status_code == 400
    assert (await api.store.read_roster(team)).entries["gus"].status == "invited"


async def test_the_invitation_form_only_at_the_choose_step(api: Api):
    owner, guest = new_email(), new_email()
    team = await made(api, owner)
    await invite(api, team, google(owner), "gus", guest)
    await invite(api, api.team, auth("alice"), "gus", new_email())  # unrelated
    chooser = await to_chooser(api.client, api.fake, guest)
    await post_invitation(
        api.client, chooser.started.cookie, {"csrf": chooser.csrf, "accept": team}
    )
    await continue_as(api.client, chooser, team)  # the login is done
    r = await post_invitation(
        api.client, chooser.started.cookie, {"csrf": chooser.csrf, "decline": team}
    )
    assert r.status_code == 400 and "expired or was already used" in r.text


# §7.3 The any-team delegate: one 404 ------------------------------------------------------------


async def test_the_any_team_delegate_does_not_tell_teams_apart(api: Api):
    """The review's probe: a team the email is not on and a team that does not exist are the
    same answer, as is a team where the email is only invited."""
    owner, outsider = new_email(), new_email()
    secret = await made(api, owner)
    headers = any_delegate(outsider)
    a = await api.client.get(f"/v1/teams/{secret}/me", headers=headers)
    b = await api.client.get(f"/v1/teams/{new_id()}/me", headers=headers)
    assert (a.status_code, a.json()) == (b.status_code, b.json()) == (404, {"error": "not_found"})
    await invite(api, secret, google(owner), "out", outsider)
    c = await api.client.get(f"/v1/teams/{secret}/me", headers=headers)
    assert (c.status_code, c.json()) == (404, {"error": "not_found"})
    # The file's team, too.
    d = await api.client.get(api.url("/me"), headers=headers)
    assert (d.status_code, d.json()) == (404, {"error": "not_found"})


# §7.4 One answer for an unavailable id, and a quota on attempts ----------------------------------


async def test_probing_ids_by_creation_is_counted(api: Api):
    """The review's probe: attempts refused as taken were free. Now every one counts: 30 an
    hour per account, then 429, whatever the reason."""
    team = await made(api, new_email())
    prober = new_email()
    for _ in range(30):
        r = await create(api, prober, team)
        assert (r.status_code, r.json()["error"]) == (409, "team_id_unavailable")
    r = await create(api, prober, team)
    assert r.status_code == 429 and r.json()["error"] == "rate_limited"
    assert "attempts" in r.json()["detail"]
    r = await create(api, prober, new_id())  # even a good one, this hour
    assert r.status_code == 429
    api.clock.advance(3600)
    assert (await create(api, prober, new_id())).status_code == 201


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_every_refusal_counts_and_the_sub_counts_too(kind: str, clock: FakeClock):
    clock.current = clock.current.replace(minute=0, second=0)
    async with open_api(
        kind, clock, configure=with_m9(), team_create_attempts_per_account_per_hour=3
    ) as api:
        sub = "sub-" + uuid.uuid4().hex
        first = new_email()
        r = await api.client.post("/v1/teams", json={"name": ""}, headers=google(first, sub))
        assert r.status_code == 422
        assert (await create(api, headers=google(first, sub), team="v1")).status_code == 422
        assert (await create(api, headers=google(first, sub), team="admin")).status_code == 409
        r = await create(api, headers=google(first, sub), team=new_id())
        assert r.status_code == 429
        # Another email of the same Google account: the sub's count is spent too.
        r = await create(api, headers=google(new_email(), sub), team=new_id())
        assert r.status_code == 429
        # Another account: its own count.
        assert (await create(api, new_email(), new_id())).status_code == 201


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_the_login_form_counts_attempts_too(kind: str, clock: FakeClock):
    clock.current = clock.current.replace(minute=0, second=0)
    async with open_api(
        kind, clock, configure=with_m9(), team_create_attempts_per_account_per_hour=1
    ) as api:
        email = new_email()
        chooser = await to_chooser(api.client, api.fake, email)
        fields = {
            "csrf": chooser.csrf,
            "name": "N",
            "team": "admin",
            "member": "me1",
            "action": "create",
        }
        r = await api.client.post(
            "/v1/login/create",
            content=urlencode(fields),
            headers={**FORM, "Cookie": f"trl={chooser.started.cookie}"},
        )
        assert r.status_code == 409 and "not available" in r.text
        fields["team"] = new_id()
        r = await api.client.post(
            "/v1/login/create",
            content=urlencode(fields),
            headers={**FORM, "Cookie": f"trl={chooser.started.cookie}"},
        )
        assert r.status_code == 429 and "attempts" in r.text


async def test_concurrent_creations_by_one_account_stop_at_three(api: Api):
    """The review's probe: twelve at once, three teams."""
    email = new_email()
    responses = await asyncio.gather(*(create(api, email, new_id()) for _ in range(12)))
    codes = sorted(r.status_code for r in responses)
    assert codes.count(201) == 3 and codes.count(409) == 9, codes
    account = await api.store.get_account(email_hash(email))
    assert account is not None and len(account.created) == 3


# §7.5 The admin audit says via, and records refusals ---------------------------------------------


async def admin_audit(api: Api, team: str) -> list[tuple[str, str, str | None, str]]:
    return [
        (e.action, e.outcome, e.detail, e.via)
        for e in await api.store.list_admin_audit(100000)
        if e.team == team
    ]


async def test_every_admin_audit_entry_says_via(api: Api):
    direct = await made(api, new_email())
    console = (await create(api, headers=any_delegate(new_email()), team=new_id())).json()["team"]
    api.clock.advance(1)  # the audit is ordered by time
    assert (await admin_delete(api, direct)).status_code == 200
    r = await admin_delete(api, console, headers=any_delegate(ADMIN))
    assert r.status_code == 200
    api.clock.advance(1)
    assert (await admin_delete(api, console, headers=any_delegate(ADMIN))).status_code == 200
    assert await admin_audit(api, direct) == [
        ("team.create", "created", None, "direct"),
        ("team.delete", "deleted", "members 1; admin", "direct"),
    ]
    assert await admin_audit(api, console) == [
        ("team.create", "created", "via delegate", "delegate"),
        ("team.delete", "deleted", "members 1; admin", "delegate"),
        ("team.delete", "resumed", "admin", "delegate"),
    ]


async def test_refused_admin_actions_are_recorded(api: Api):
    team = await made(api, new_email())
    stranger = new_email()
    tick = api.clock.advance  # the audit is ordered by time
    assert (await api.client.get("/v1/admin/teams", headers=google(stranger))).status_code == 403
    tick(1)
    assert (await admin_delete(api, team, headers=google(stranger))).status_code == 403
    tick(1)
    assert (await admin_delete(api, team, headers=any_delegate(stranger))).status_code == 403
    tick(1)
    assert (await admin_delete(api, team, confirm="nope")).status_code == 422
    tick(1)
    assert (await admin_delete(api, api.team)).status_code == 409
    entries = [
        (e.action, e.team, e.outcome, e.detail, e.via, e.actor_email_sha256)
        for e in await api.store.list_admin_audit(100000)
        if e.outcome == "refused"
        and e.team in (team, api.team, ALL_TEAMS)
        and e.actor_email_sha256 in (email_hash(stranger), email_hash(ADMIN))
    ]
    assert entries == [
        ("admin.list", ALL_TEAMS, "refused", "403 forbidden", "direct", email_hash(stranger)),
        ("team.delete", team, "refused", "403 forbidden", "direct", email_hash(stranger)),
        ("team.delete", team, "refused", "403 forbidden", "delegate", email_hash(stranger)),
        ("team.delete", team, "refused", "422 confirm_mismatch", "direct", email_hash(ADMIN)),
        ("team.delete", api.team, "refused", "409 seed_team", "direct", email_hash(ADMIN)),
    ]
    # A delegate that may not act for an admin is recorded as the delegate's.
    assert (await api.store.get_teams([team]))[team].status == "active"


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_refusals_cannot_flood_the_admin_audit(kind: str, clock: FakeClock):
    clock.current = clock.current.replace(second=0)
    async with open_api(kind, clock, configure=with_m9(), audited_refusals_per_minute=2) as api:
        stranger = new_email()
        for _ in range(5):
            r = await api.client.get("/v1/admin/teams", headers=google(stranger))
            assert r.status_code == 403
        refused = [
            e
            for e in await api.store.list_admin_audit(100000)
            if e.actor_email_sha256 == email_hash(stranger)
        ]
        assert len(refused) == 2


# §7.6 Limits through the console ------------------------------------------------------------------


async def test_a_delegates_creation_needs_the_client_address(api: Api):
    email = new_email()
    for ip_hash in (None, "A" * 64, "a" * 63, "not-hex"):
        r = await create(api, headers=any_delegate(email, ip_hash), team=new_id())
        assert r.status_code == 400 and r.json()["error"] == "bad_request", ip_hash
    headers = {**any_delegate(email), "X-Relay-Client-IP-Hash": CONSOLE_IP_HASH}
    r = await api.client.post(
        "/v1/teams",
        json={"name": "N", "id": new_id(), "owner_member_id": "o1"},
        headers=[*headers.items(), ("X-Relay-Client-IP-Hash", CONSOLE_IP_HASH)],
    )
    assert r.status_code == 400  # given twice
    assert (await create(api, headers=any_delegate(email), team=new_id())).status_code == 201


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_the_console_address_counts_per_hour(kind: str, clock: FakeClock):
    clock.current = clock.current.replace(minute=0, second=0)
    async with open_api(kind, clock, configure=with_m9(), team_creations_per_ip_per_hour=2) as api:
        address = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
        for _ in range(2):
            r = await create(api, headers=any_delegate(new_email(), address), team=new_id())
            assert r.status_code == 201, r.text
        r = await create(api, headers=any_delegate(new_email(), address), team=new_id())
        assert r.status_code == 429 and "this address" in r.json()["detail"]
        other = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
        r = await create(api, headers=any_delegate(new_email(), other), team=new_id())
        assert r.status_code == 201


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_a_delegate_creates_at_most_so_many_teams_an_hour(kind: str, clock: FakeClock):
    clock.current = clock.current.replace(minute=0, second=0)
    # One delegate principal on a shared emulator: a limit high enough for the other tests'
    # creations this fake hour, then spent here.
    async with open_api(
        kind, clock, configure=with_m9(), team_creations_per_delegate_per_hour=1
    ) as api:
        clock.advance(3600 * (500 + uuid.uuid4().int % 100000))  # an hour of its own
        address = lambda: hashlib.sha256(uuid.uuid4().bytes).hexdigest()  # noqa: E731
        r = await create(api, headers=any_delegate(new_email(), address()), team=new_id())
        assert r.status_code == 201, r.text
        r = await create(api, headers=any_delegate(new_email(), address()), team=new_id())
        assert r.status_code == 429 and "through the console" in r.json()["detail"]
        # A direct creation is not the console's.
        assert (await create(api, new_email(), new_id())).status_code == 201


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_the_per_account_limits_key_on_the_sub(kind: str, clock: FakeClock):
    clock.current = clock.current.replace(hour=0, minute=0, second=0)
    async with open_api(
        kind, clock, configure=with_m9(), teams_per_account=1, team_creations_per_account_per_day=5
    ) as api:
        sub = "sub-" + uuid.uuid4().hex
        r = await create(api, headers=google(new_email(), sub), team=new_id())
        assert r.status_code == 201
        team = r.json()["team"]
        record = (await api.store.get_teams([team]))[team]
        assert record.created_by_sub_sha256 == sub_account_key(sub)
        # The same Google account under another email: it has created its one team.
        r = await create(api, headers=google(new_email(), sub), team=new_id())
        assert r.status_code == 409 and r.json()["error"] == "team_limit"
        # Deleting it frees the slot for the account by either key.
        assert (await admin_delete(api, team)).status_code == 200
        assert (await api.store.get_account(sub_account_key(sub))) is None
        r = await create(api, headers=google(new_email(), sub), team=new_id())
        assert r.status_code == 201


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_the_daily_creations_key_on_the_sub(kind: str, clock: FakeClock):
    clock.current = clock.current.replace(hour=0, minute=0, second=0)
    async with open_api(
        kind, clock, configure=with_m9(), team_creations_per_account_per_day=1
    ) as api:
        sub = "sub-" + uuid.uuid4().hex
        assert (
            await create(api, headers=google(new_email(), sub), team=new_id())
        ).status_code == 201
        r = await create(api, headers=google(new_email(), sub), team=new_id())
        assert r.status_code == 429 and "a day" in r.json()["detail"]


# §7.7 An owner deletes a team they own ---------------------------------------------------------


async def owner_delete(api: Api, team: str, headers: dict[str, str], confirm: Any = None):
    return await api.client.request(
        "DELETE",
        f"/v1/teams/{team}",
        json={"confirm": team if confirm is None else confirm},
        headers=headers,
    )


async def test_an_owner_deletes_their_team(api: Api):
    owner, member = new_email(), new_email()
    team = await made(api, owner, member="olga")
    await invite(api, team, google(owner), "max", member)
    await accept_invitation(api.client, team, member)
    credential = bearer((await login(api, email=member, team=team))["credential"])
    api.clock.advance(1)  # the audit is ordered by time
    r = await owner_delete(api, team, google(owner))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "deleted" and r.json()["removal"] == "complete"
    assert (await api.client.get(f"/v1/teams/{team}/me", headers=credential)).status_code == 401
    assert (await api.client.get(f"/v1/teams/{team}/me", headers=google(owner))).status_code == 401
    r = await api.client.get("/v1/me/teams", headers=google(owner))
    assert r.json()["teams_created"] == 0  # the slot is free
    assert await admin_audit(api, team) == [
        ("team.create", "created", None, "direct"),
        ("team.delete", "deleted", "members 2; owner olga", "direct"),
    ]
    admin = [e for e in await api.store.list_admin_audit(100000) if e.team == team]
    assert admin[-1].actor_email_sha256 == email_hash(owner)


async def test_any_owner_may_delete_and_nobody_else(api: Api):
    owner, second, member = new_email(), new_email(), new_email()
    team = await made(api, owner, member="olga")
    await invite(api, team, google(owner), "sam", second, role="owner")
    # Invited as an owner: not one yet.
    assert (await owner_delete(api, team, google(second))).status_code == 401
    await accept_invitation(api.client, team, second)
    await invite(api, team, google(owner), "max", member)
    await accept_invitation(api.client, team, member)
    r = await owner_delete(api, team, google(member))
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    # Only with a Google identity: a device credential is refused, even an owner's.
    credential = bearer((await login(api, email=owner, team=team))["credential"])
    r = await owner_delete(api, team, credential)
    assert r.status_code == 403 and r.json()["error"] == "google_identity_required"
    assert (await owner_delete(api, team, google(second), confirm="nope")).status_code == 422
    r = await api.client.request(
        "DELETE", f"/v1/teams/{team}", content=b"[]", headers=google(second)
    )
    assert r.status_code == 422
    # Someone else's team: 404, as for any team route.
    assert (await owner_delete(api, team, google(new_email()))).status_code == 401
    assert (await owner_delete(api, api.team, google(owner))).status_code == 404
    assert (await api.store.get_teams([team]))[team].status == "active"
    assert (await owner_delete(api, team, google(second))).status_code == 200
    refused = [e for e in await api.store.list_audit(team) if e.outcome == "refused"]
    assert refused == []  # the removal took the team's audit with it


async def test_a_file_team_is_not_deleted_by_its_owner(api: Api):
    r = await owner_delete(api, api.team, google(EMAILS["alice"]))
    assert r.status_code == 409 and r.json()["error"] == "seed_team"
    api.clock.advance(1)  # the audit is ordered by time
    r = await owner_delete(api, api.team, auth("alice"))
    assert r.status_code == 403 and r.json()["error"] == "google_identity_required"
    refused = [e for e in await api.store.list_audit(api.team) if e.action == "team.delete"]
    assert [(e.actor, e.detail) for e in refused] == [
        ("alice", "409 seed_team"),
        ("alice", "403 google_identity_required"),
    ]


async def test_the_console_deletes_for_an_owner_only_with_manage_teams(api: Api):
    owner = new_email()
    team = await made(api, owner, member="olga")
    per_team = {
        "Authorization": f"Bearer {DELEGATE_TOKENS['demo']}",
        "X-Relay-On-Behalf-Of": EMAILS["alice"],
    }
    assert (await owner_delete(api, api.team, per_team)).status_code == 403
    api.clock.advance(1)  # the audit is ordered by time
    r = await owner_delete(api, team, any_delegate(owner))
    assert r.status_code == 200, r.text
    assert (await admin_audit(api, team))[-1] == (
        "team.delete",
        "deleted",
        "members 1; owner olga",
        "delegate",
    )


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_a_delegate_without_manage_teams_deletes_nothing(kind: str, clock: FakeClock):
    async with open_api(kind, clock, configure=with_m9(["read", "manage-roster"])) as api:
        owner = new_email()
        team = await made(api, owner)
        r = await owner_delete(api, team, any_delegate(owner))
        assert r.status_code == 403
        assert (await api.store.get_teams([team]))[team].status == "active"


# §7.8 Admin deletions through the delegate are capped ---------------------------------------------


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_admin_deletions_through_the_delegate_are_capped(kind: str, clock: FakeClock):
    async with open_api(
        kind, clock, configure=with_m9(), admin_deletes_per_delegate_per_hour=2
    ) as api:
        clock.advance(3600 * (500 + uuid.uuid4().int % 100000))  # an hour of its own
        teams = [await made(api, new_email()) for _ in range(4)]
        for team in teams[:2]:
            r = await admin_delete(api, team, headers=any_delegate(ADMIN))
            assert r.status_code == 200, r.text
        r = await admin_delete(api, teams[2], headers=any_delegate(ADMIN))
        assert r.status_code == 429 and r.json()["error"] == "rate_limited"
        assert (await api.store.get_teams([teams[2]]))[teams[2]].status == "active"
        # Resuming a removal deletes nothing: not counted.
        r = await admin_delete(api, teams[0], headers=any_delegate(ADMIN))
        assert r.status_code == 200
        # The admin's own Google identity is not capped.
        assert (await admin_delete(api, teams[2])).status_code == 200
        assert ("team.delete", "refused", "429 rate_limited", "delegate") in await admin_audit(
            api, teams[2]
        )
        clock.advance(3600)
        assert (await admin_delete(api, teams[3], headers=any_delegate(ADMIN))).status_code == 200


# §7.9 Non-members are rate limited before the membership check ----------------------------------


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_non_members_are_rate_limited_before_the_membership_check(
    kind: str, clock: FakeClock
):
    async with open_api(kind, clock, configure=with_m9(), non_member_requests_per_minute=3) as api:
        clock.current = clock.current.replace(second=0)
        clock.advance(60 * (1000 + uuid.uuid4().int % 100000))  # a minute of its own
        team = await made(api, new_email())
        teams = api.app.state.service.teams
        looked: list[str] = []
        original = teams.active

        async def counting(name: str):
            looked.append(name)
            return await original(name)

        teams.active = counting  # type: ignore[method-assign]
        stranger = google(new_email())
        for _ in range(3):
            r = await api.client.get(f"/v1/teams/{team}/me", headers=stranger)
            assert r.status_code == 401
        checked = len(looked)
        r = await api.client.get(f"/v1/teams/{team}/me", headers=stranger)
        assert r.status_code == 429 and r.json()["error"] == "rate_limited"
        assert len(looked) == checked  # refused before any membership read
        # Per principal: another account has its own budget; the console's viewer too.
        assert (
            await api.client.get(f"/v1/teams/{team}/me", headers=google(new_email()))
        ).status_code == 401
        viewer = new_email()
        for _ in range(3):
            r = await api.client.get(f"/v1/teams/{team}/me", headers=any_delegate(viewer))
            assert r.status_code == 404
        r = await api.client.get(f"/v1/teams/{team}/me", headers=any_delegate(viewer))
        assert r.status_code == 429
        clock.advance(60)
        r = await api.client.get(f"/v1/teams/{team}/me", headers=stranger)
        assert r.status_code == 401


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_a_member_is_counted_once_then_goes_free(kind: str, clock: FakeClock):
    async with open_api(kind, clock, configure=with_m9(), non_member_requests_per_minute=2) as api:
        clock.current = clock.current.replace(second=0)
        clock.advance(60 * (1000 + uuid.uuid4().int % 100000))
        owner = new_email()
        team = await made(api, owner)
        for _ in range(10):
            r = await api.client.get(f"/v1/teams/{team}/me", headers=google(owner))
            assert r.status_code == 200
        # A member of one team is a non-member of another: counted there.
        other = await made(api, new_email())
        for _ in range(1):
            assert (
                await api.client.get(f"/v1/teams/{other}/me", headers=google(owner))
            ).status_code == 404
        r = await api.client.get(f"/v1/teams/{other}/me", headers=google(owner))
        assert r.status_code == 429
        assert (
            await api.client.get(f"/v1/teams/{team}/me", headers=google(owner))
        ).status_code == 200


# Logs ------------------------------------------------------------------------------------------


async def test_no_email_reaches_the_logs(api: Api, capsys):
    owner, guest = new_email(), new_email()
    team = await made(api, owner)
    await invite(api, team, google(owner), "gus", guest)
    await answer(api, team, google(guest))
    await owner_delete(api, team, google(owner))
    await api.client.get("/v1/admin/teams", headers=google(guest))
    out = capsys.readouterr().out
    assert owner not in out and guest not in out and ADMIN not in out
    assert google_sub(guest) not in out and "id-token-" not in out
