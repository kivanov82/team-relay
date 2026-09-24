"""M9-SPEC §1, §2, §4, §5 over HTTP, on both stores: creating a team (the Google identity it
needs, validation, reserved ids, uniqueness under concurrency, the limits), ``/v1/me/teams``,
the admin endpoints and their audit, deletion (everyone refused at once, on every instance;
the id reserved for 31 days; the removal resumed) and the any-team delegate.

Every creator is a fresh email: on the shared Firestore emulator an account's teams count
across tests."""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest

import relay.teams as teams_module
from relay.config import parse_team_config
from relay.errors import ConfigError
from relay.roster import email_hash
from relay.service import Caller
from relay.store import TEAM_DELETED
from relay.teams import RESERVED_TEAM_IDS, suggest_member_id, suggest_team_id

from .conftest import (
    DELEGATE_TOKENS,
    DELEGATES,
    EMAILS,
    Api,
    FakeClock,
    accept_invitation,
    auth,
    id_token,
    open_api,
    team_config_data,
    with_delegates,
)
from .login_helpers import bearer, login

pytestmark = pytest.mark.anyio

# The admin's email is new for every test: account routes are rate limited per account, and
# the Firestore tests share one emulator and one fake minute.
ADMIN = "relay-admin@example.com"
ANY_SCOPES = ["read", "manage-roster", "manage-teams"]


@pytest.fixture(autouse=True)
def _fresh_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(globals(), "ADMIN", f"admin-{uuid.uuid4().hex[:12]}@example.com")


def new_email() -> str:
    return f"u{uuid.uuid4().hex[:16]}@example.com"


def new_id(prefix: str = "k") -> str:
    return prefix + uuid.uuid4().hex[:20]


def with_m9(scopes: list[str] | None = None, **extra: Any):
    """The admin and the any-team delegate (M9-SPEC §4, §5); ``extra`` edits the file."""

    def configure(data: dict[str, Any]) -> None:
        data["admins"] = [f"google:{ADMIN}"]
        data["delegates"].append(
            {"principal": DELEGATES["any"], "team": "*", "scope": scopes or ANY_SCOPES}
        )
        for key, value in extra.items():
            value(data) if key == "edit" else data.__setitem__(key, value)

    return configure


@pytest.fixture(params=["memory", "firestore"])
async def api(request: pytest.FixtureRequest, clock: FakeClock) -> AsyncIterator[Api]:
    async with open_api(request.param, clock, configure=with_m9()) as opened:
        yield opened


def google_sub(email: str) -> str:
    """The ``sub`` the fake Google gives ``email`` in the login flow, so an ID token and a
    sign-in are the same Google account."""
    return hashlib.sha256(email.encode()).hexdigest()[:21]


def google(email: str, sub: str | None = None) -> dict[str, str]:
    """A Google ID token for ``email`` (the account the login flow signs in as, unless
    ``sub`` says otherwise)."""
    return {"Authorization": f"Bearer {id_token(email, sub or google_sub(email))}"}


# M9-SPEC §7.6: the console reports its viewer's address, salted and hashed.
CONSOLE_IP_HASH = hashlib.sha256(b"salt|203.0.113.7").hexdigest()


def any_delegate(email: str, ip_hash: str | None = CONSOLE_IP_HASH) -> dict[str, str]:
    """The any-team console's headers for the viewer ``email`` (and the address it saw)."""
    headers = {"Authorization": f"Bearer {DELEGATE_TOKENS['any']}", "X-Relay-On-Behalf-Of": email}
    if ip_hash is not None:
        headers["X-Relay-Client-IP-Hash"] = ip_hash
    return headers


async def invite(api: Api, team: str, owner: str, member: str, email: str) -> None:
    """``owner`` invites ``email`` as ``member`` and they accept (M9-SPEC §7.2)."""
    r = await api.client.post(
        f"/v1/teams/{team}/roster", json={"member": member, "email": email}, headers=google(owner)
    )
    assert r.status_code == 201, r.text
    await accept_invitation(api.client, team, email)


async def create(
    api: Api,
    email: str | None = None,
    team: str | None = None,
    *,
    name: str = "Platform team",
    member: str = "owner1",
    headers: dict[str, str] | None = None,
):
    body: dict[str, Any] = {"name": name, "owner_member_id": member}
    if team is not None:
        body["id"] = team
    return await api.client.post(
        "/v1/teams", json=body, headers=headers if headers is not None else google(email or "")
    )


async def made(api: Api, email: str, team: str | None = None, member: str = "owner1") -> str:
    team = team or new_id()
    r = await create(api, email, team, member=member)
    assert r.status_code == 201, r.text
    return team


async def admin_delete(api: Api, team: str, confirm: Any = None, headers=None):
    return await api.client.request(
        "DELETE",
        f"/v1/admin/teams/{team}",
        json={"confirm": team if confirm is None else confirm},
        headers=headers or google(ADMIN),
    )


async def admin_rows(api: Api, prefix: str, **params: Any) -> dict[str, dict[str, Any]]:
    """The admin listing from ``prefix`` on (created teams sort by id; a unique prefix keeps
    other tests' teams on the shared emulator out of the page)."""
    r = await api.client.get(
        "/v1/admin/teams", params={"after": prefix, "limit": 50, **params}, headers=google(ADMIN)
    )
    assert r.status_code == 200, r.text
    return {row["id"]: row for row in r.json()["teams"] if row["id"].startswith(prefix)}


# Creating ----------------------------------------------------------------------------------------


async def test_a_google_account_creates_a_team_and_owns_it(api: Api, capsys):
    email, team = new_email(), new_id()
    r = await create(api, email, team, name="  Platform <team> ", member="erin")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body == {
        "team": team,
        "name": "Platform <team>",
        "status": "active",
        "created_at": "2026-09-23T12:00:00.000Z",
        "member": "erin",
        "role": "owner",
    }
    r = await api.client.get(f"/v1/teams/{team}/me", headers=google(email))
    assert r.status_code == 200
    assert r.json() == {
        "team": team,
        "name": "Platform <team>",
        "member": "erin",
        "teammates": [],
        "role": "owner",
    }
    r = await api.client.get(f"/v1/teams/{team}/roster", headers=google(email))
    assert [(m["member"], m["emails"], m["role"]) for m in r.json()["members"]] == [
        ("erin", [email], "owner")
    ]
    audit = await api.store.list_audit(team)
    assert [(e.actor, e.action, e.email_sha256) for e in audit] == [
        ("erin", "team.create", [email_hash(email)])
    ]
    admin = [e for e in await api.store.list_admin_audit(100000) if e.team == team]
    assert [(e.action, e.outcome, e.actor_email_sha256) for e in admin] == [
        ("team.create", "created", email_hash(email))
    ]
    assert email not in capsys.readouterr().out  # never logged


async def test_the_id_is_made_from_the_name_when_omitted(api: Api):
    name = "Zeta " + uuid.uuid4().hex[:10] + "!"
    r = await create(api, new_email(), name=name)
    assert r.status_code == 201, r.text
    assert r.json()["team"] == suggest_team_id(name) == name[:-1].lower().replace(" ", "-")


def test_suggestions():
    assert suggest_team_id("Platform Team!") == "platform-team"
    assert suggest_team_id("42") == "team-42"
    assert suggest_team_id("ß") == "team"
    assert suggest_team_id("x" * 50) == "x" * 32
    assert suggest_member_id("Mary.Jane+x@example.com") == "mary_jane_x"
    assert suggest_member_id("9lives@example.com") == "m_9lives"
    assert suggest_member_id("a@example.com") == "a_member"
    assert suggest_member_id("__@example.com") == "member"


@pytest.mark.parametrize(
    "body",
    [
        {"owner_member_id": "o1"},
        {"name": "", "owner_member_id": "o1"},
        {"name": "   ", "owner_member_id": "o1"},
        {"name": "x" * 61, "owner_member_id": "o1"},
        {"name": "bell\x07", "owner_member_id": "o1"},
        {"name": "new\nline", "owner_member_id": "o1"},
        {"name": "a\u202eb", "owner_member_id": "o1"},  # a bidi override
        {"name": "zero\u200bwidth", "owner_member_id": "o1"},
        {"name": 5, "owner_member_id": "o1"},
        {"name": "Ok", "id": "Ab1", "owner_member_id": "o1"},
        {"name": "Ok", "id": "ab", "owner_member_id": "o1"},
        {"name": "Ok", "id": "a" * 33, "owner_member_id": "o1"},
        {"name": "Ok", "id": "1abc", "owner_member_id": "o1"},
        {"name": "Ok", "id": "a_bc", "owner_member_id": "o1"},
        {"name": "Ok", "id": "abc/..", "owner_member_id": "o1"},
        {"name": "Ok", "id": 7, "owner_member_id": "o1"},
        {"name": "Ok", "owner_member_id": "O1"},
        {"name": "Ok", "owner_member_id": "o"},
        {"name": "Ok"},
        {"name": "Ok", "owner_member_id": "o1", "owner": "x"},
        ["name"],
    ],
)
async def test_a_bad_body_is_422(api: Api, body: Any):
    r = await api.client.post("/v1/teams", json=body, headers=google(new_email()))
    assert r.status_code == 422, r.text
    assert r.json()["error"] == "invalid_body"


async def test_a_name_may_hold_any_printable_text(api: Api):
    r = await create(api, new_email(), new_id(), name="Équipe 東京 🚀 <b>&amp;</b>")
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "Équipe 東京 🚀 <b>&amp;</b>"


async def test_reserved_ids_and_the_files_ids_are_refused(api: Api):
    email = new_email()
    for team in sorted(RESERVED_TEAM_IDS) + ["other", api.team]:
        if len(team) < 3:
            continue  # "v1", "api"-like short ids never match the id shape anyway
        r = await create(api, email, team)
        assert r.status_code == 409, (team, r.text)
        assert r.json()["error"] == "team_id_unavailable"
    r = await create(api, email, "v1")
    assert r.status_code == 422
    account = await api.store.get_account(email_hash(email))
    assert account is None


async def test_a_taken_id_is_409(api: Api):
    team = await made(api, new_email())
    r = await create(api, new_email(), team)
    assert r.status_code == 409 and r.json()["error"] == "team_id_unavailable"


async def test_concurrent_creations_of_one_id_create_one_team(api: Api):
    team = new_id()
    emails = [new_email() for _ in range(5)]
    responses = await asyncio.gather(*(create(api, e, team) for e in emails))
    codes = sorted(r.status_code for r in responses)
    assert codes == [201, 409, 409, 409, 409], [r.text for r in responses]
    assert {r.json()["error"] for r in responses if r.status_code == 409} == {"team_id_unavailable"}
    assert len((await api.store.read_roster(team)).entries) == 1


async def test_creating_needs_a_google_identity(api: Api):
    assert (await create(api, headers={})).status_code == 401
    r = await create(api, headers={"Authorization": "Bearer trc_" + "A" * 43})
    assert r.status_code == 401  # not a credential at all
    r = await create(api, headers=auth("alice"))  # a static token: no email
    assert r.status_code == 403 and r.json()["error"] == "google_identity_required"
    credential = (await login(api, "alice"))["credential"]
    r = await create(api, headers=bearer(credential))  # bound to its team
    assert r.status_code == 403 and r.json()["error"] == "google_identity_required"
    email = new_email()
    headers = {**google(email), "X-Relay-On-Behalf-Of": email}
    assert (await create(api, headers=headers)).status_code == 400
    # A per-team delegate may not; the any-team delegate with manage-teams may.
    r = await create(
        api,
        headers={
            "Authorization": f"Bearer {DELEGATE_TOKENS['demo']}",
            "X-Relay-On-Behalf-Of": email,
        },
    )
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    r = await create(api, headers=any_delegate(email), team=new_id())
    assert r.status_code == 201, r.text
    team = r.json()["team"]
    # The delegate named the owner by email; their first own sign-in binds their account.
    r = await api.client.get(f"/v1/teams/{team}/me", headers=google(email, "their-sub"))
    assert r.status_code == 200 and r.json()["role"] == "owner"
    r = await api.client.get(f"/v1/teams/{team}/me", headers=google(email, "another-sub"))
    assert r.status_code == 401
    created = [e for e in await api.store.list_audit(team) if e.action == "team.create"]
    assert [e.detail for e in created] == ["via delegate"]


async def test_a_delegate_email_owns_no_team(api: Api):
    r = await create(api, headers=any_delegate(DELEGATES["demo"].removeprefix("google:")))
    assert r.status_code == 422


async def test_three_teams_per_account_and_a_deletion_frees_a_slot(api: Api):
    email = new_email()
    teams = [await made(api, email) for _ in range(3)]
    r = await create(api, email, new_id())
    assert r.status_code == 409 and r.json()["error"] == "team_limit"
    assert "at most 3 teams" in r.json()["detail"]
    # Being added to other teams does not count; only creating does.
    assert (await admin_delete(api, teams[0])).status_code == 200
    assert (await create(api, email, new_id())).status_code == 201


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_creations_per_account_per_day(kind: str, clock: FakeClock):
    clock.current = clock.current.replace(hour=0, minute=0, second=0)
    configure = with_m9()
    async with open_api(
        kind, clock, configure=configure, team_creations_per_account_per_day=2
    ) as api:
        email = new_email()
        await made(api, email)
        await made(api, email)
        r = await create(api, email, new_id())
        assert r.status_code == 429 and r.json()["error"] == "rate_limited"
        assert "a day" in r.json()["detail"]
        # A refusal for another reason does not count, and the next day starts afresh.
        clock.advance(86400)
        await made(api, email)


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_creations_per_ip_per_hour(kind: str, clock: FakeClock):
    clock.current = clock.current.replace(minute=0, second=0)
    async with open_api(kind, clock, configure=with_m9(), team_creations_per_ip_per_hour=2) as api:
        ip = f"10.9.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}"
        async with api.instance(client_ip=ip) as (client, _):
            for _ in range(2):
                r = await client.post(
                    "/v1/teams",
                    json={"name": "N", "id": new_id(), "owner_member_id": "o1"},
                    headers=google(new_email()),
                )
                assert r.status_code == 201, r.text
            r = await client.post(
                "/v1/teams",
                json={"name": "N", "id": new_id(), "owner_member_id": "o1"},
                headers=google(new_email()),
            )
            assert r.status_code == 429 and "this address" in r.json()["detail"]
            # The console's delegate calls from the console's address: the address it reports
            # (M9-SPEC §7.6) counts instead, not this one.
            reported = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
            r = await client.post(
                "/v1/teams",
                json={"name": "N", "id": new_id(), "owner_member_id": "o1"},
                headers=any_delegate(new_email(), reported),
            )
            assert r.status_code == 201, r.text


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_a_created_team_holds_at_most_members_per_team(kind: str, clock: FakeClock):
    async with open_api(kind, clock, configure=with_m9(), members_per_team=2) as api:
        email = new_email()
        team = await made(api, email)
        url = f"/v1/teams/{team}/roster"
        r = await api.client.post(
            url, json={"member": "m2", "email": new_email()}, headers=google(email)
        )
        assert r.status_code == 201
        r = await api.client.post(
            url, json={"member": "m3", "email": new_email()}, headers=google(email)
        )
        assert r.status_code == 409 and r.json()["error"] == "team_full"


# The whole life of a created team ----------------------------------------------------------------


async def test_a_created_team_works_like_any_other(api: Api):
    """The owner invites a member by email, the member signs in from Claude Code (the login
    flow), and they exchange a question."""
    owner, member = new_email(), new_email()
    team = await made(api, owner, member="olga")
    await invite(api, team, owner, "max", member)
    signed_in = await login(api, email=member, team=team)
    assert (signed_in["team"], signed_in["member"]) == (team, "max")
    credential = bearer(signed_in["credential"])
    r = await api.client.post(
        f"/v1/teams/{team}/requests",
        headers=google(owner),
        json={
            "idempotency_key": "k-" + uuid.uuid4().hex,
            "kind": "question",
            "to": ["max"],
            "question": "Ready?",
        },
    )
    assert r.status_code == 201, r.text
    rid = r.json()["request_id"]
    r = await api.client.get(f"/v1/teams/{team}/streams/inbox", headers=credential)
    assert [m["request_id"] for m in r.json()["messages"]] == [rid]
    r = await api.client.post(
        f"/v1/teams/{team}/requests/{rid}/reply",
        headers=credential,
        json={"idempotency_key": "r-" + uuid.uuid4().hex, "text": "Yes."},
    )
    assert r.status_code == 200, r.text
    r = await api.client.get(f"/v1/teams/{team}/streams/replies", headers=google(owner))
    assert [m["data"]["text"] for m in r.json()["messages"]] == ["Yes."]
    # Someone else's team is 404 for both, and the file's team too.
    for headers in (credential, google(owner)):
        r = await api.client.get(api.url("/me"), headers=headers)
        assert r.status_code == 404


# /v1/me/teams -----------------------------------------------------------------------------------


def _alice_also(email: str):
    """``email`` as a second Google account of alice, the file team's owner."""

    def edit(data: dict[str, Any]) -> None:
        data["teams"][0]["members"][0]["principals"].append(f"google:{email}")

    return edit


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_my_teams_lists_the_files_and_the_created_ones(kind: str, clock: FakeClock):
    email = new_email()
    async with open_api(kind, clock, configure=with_m9(edit=_alice_also(email))) as api:
        team = await made(api, email, new_id("z"), member="al")
        other_owner = new_email()
        joined = await made(api, other_owner, new_id("y"))
        await invite(api, joined, other_owner, "ally", email)
        r = await api.client.get("/v1/me/teams", headers=google(email))
        assert r.status_code == 200, r.text
        assert r.json() == {
            "teams": [
                {"team": api.team, "name": api.team, "member": "alice", "role": "owner"},
                {"team": joined, "name": "Platform team", "member": "ally", "role": "member"},
                {"team": team, "name": "Platform team", "member": "al", "role": "owner"},
            ],
            "invitations": [],
            "admin": False,
            "teams_created": 1,
            "max_teams_created": 3,
            "suggested_member": email.split("@")[0],
        }
        # The any-team delegate sees the same; a per-team delegate its own team only.
        r = await api.client.get("/v1/me/teams", headers=any_delegate(email))
        assert [t["team"] for t in r.json()["teams"]] == [api.team, joined, team]
        r = await api.client.get(
            "/v1/me/teams",
            headers={
                "Authorization": f"Bearer {DELEGATE_TOKENS['demo']}",
                "X-Relay-On-Behalf-Of": email,
            },
        )
        assert [t["team"] for t in r.json()["teams"]] == [api.team]
        # A team the admin created is listed to them as to anyone; admin is a flag.
        r = await api.client.get("/v1/me/teams", headers=google(ADMIN))
        assert r.json()["admin"] is True and r.json()["teams"] == []


async def test_my_teams_leaves_out_a_team_bound_to_another_google_account(api: Api):
    email = new_email()
    team = await made(api, email)  # bound to sub-<email>
    r = await api.client.get("/v1/me/teams", headers=google(email, "someone-else"))
    assert r.status_code == 200 and r.json()["teams"] == []
    r = await api.client.get("/v1/me/teams", headers=google(email))
    assert [t["team"] for t in r.json()["teams"]] == [team]


async def test_my_teams_needs_a_google_identity(api: Api):
    assert (await api.client.get("/v1/me/teams")).status_code == 401
    r = await api.client.get("/v1/me/teams", headers=auth("alice"))
    assert r.status_code == 403
    credential = (await login(api, "alice"))["credential"]
    r = await api.client.get("/v1/me/teams", headers=bearer(credential))
    assert r.status_code == 403 and r.json()["error"] == "google_identity_required"
    r = await api.client.get("/v1/me/teams", headers=any_delegate("not an email"))
    assert r.status_code == 401


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_account_routes_are_rate_limited_per_account(kind: str, clock: FakeClock):
    clock.current = clock.current.replace(second=0)
    async with open_api(kind, clock, configure=with_m9(), reads_per_minute=3) as api:
        email = new_email()
        for _ in range(3):
            assert (await api.client.get("/v1/me/teams", headers=google(email))).status_code == 200
        r = await api.client.get("/v1/me/teams", headers=google(email))
        assert r.status_code == 429
        assert (
            await api.client.get("/v1/me/teams", headers=google(new_email()))
        ).status_code == 200
        clock.advance(60)
        assert (await api.client.get("/v1/me/teams", headers=google(email))).status_code == 200


# Admin ------------------------------------------------------------------------------------------


async def test_the_admin_lists_every_team_without_emails_or_content(api: Api):
    prefix = new_id("a")[:12]
    owner = new_email()
    team = await made(api, owner, prefix + "-one", member="olga")
    await invite(api, team, owner, "max", new_email())
    r = await api.client.get("/v1/admin/teams", params={"limit": 1}, headers=google(ADMIN))
    assert r.status_code == 200, r.text
    listing = r.json()
    seeds = [row for row in listing["teams"] if row["seed"]]
    assert [row["id"] for row in seeds] == [api.team, api.teams["other"]]
    assert (seeds[0]["members"], seeds[0]["owners"], seeds[0]["status"]) == (3, 1, "active")
    # Paged by id after the file's teams: `next` is where the following page starts.
    second = await made(api, new_email(), prefix + "-two")
    r = await api.client.get(
        "/v1/admin/teams", params={"after": prefix, "limit": 1}, headers=google(ADMIN)
    )
    assert [row["id"] for row in r.json()["teams"]] == [team] and r.json()["next"] == team
    r = await api.client.get(
        "/v1/admin/teams", params={"after": team, "limit": 1}, headers=google(ADMIN)
    )
    assert [row["id"] for row in r.json()["teams"]] == [second]
    rows = await admin_rows(api, prefix)
    assert rows[team] == {
        "id": team,
        "name": "Platform team",
        "status": "active",
        "seed": False,
        "created_at": "2026-09-23T12:00:00.000Z",
        "created_by_member": "olga",
        "members": 2,
        "owners": 1,
        "last_activity_at": None,
    }
    assert owner not in r.text and "@" not in str(rows)
    r = await api.client.post(
        f"/v1/teams/{team}/requests",
        headers=google(owner),
        json={"idempotency_key": "key-0001", "kind": "question", "to": ["max"], "question": "Hi"},
    )
    assert r.status_code == 201, r.text
    rows = await admin_rows(api, prefix)
    assert rows[team]["last_activity_at"] == "2026-09-23T12:00:00.000Z"
    r = await api.client.get("/v1/admin/teams", params={"after": "Bad!"}, headers=google(ADMIN))
    assert r.status_code == 400
    r = await api.client.get("/v1/admin/teams", params={"limit": "0"}, headers=google(ADMIN))
    assert r.status_code == 400


async def test_only_an_admin_reaches_the_admin_endpoints(api: Api):
    team = await made(api, new_email())
    denied = [
        google(new_email()),
        any_delegate(new_email()),
        {"Authorization": f"Bearer {DELEGATE_TOKENS['demo']}", "X-Relay-On-Behalf-Of": ADMIN},
        auth("alice"),
    ]
    for headers in denied:
        r = await api.client.get("/v1/admin/teams", headers=headers)
        assert r.status_code == 403, r.text
        r = await admin_delete(api, team, headers=headers)
        assert r.status_code == 403, r.text
    assert (await api.client.get("/v1/admin/teams")).status_code == 401
    # The any-team delegate with manage-teams acts for an admin.
    r = await api.client.get("/v1/admin/teams", headers=any_delegate(ADMIN))
    assert r.status_code == 200
    assert (await api.store.get_teams([team]))[team].status == "active"


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_an_any_team_delegate_without_manage_teams_does_not_act_for_an_admin(
    kind: str, clock: FakeClock
):
    async with open_api(kind, clock, configure=with_m9(["read", "manage-roster"])) as api:
        r = await api.client.get("/v1/admin/teams", headers=any_delegate(ADMIN))
        assert r.status_code == 403
        r = await create(api, headers=any_delegate(new_email()))
        assert r.status_code == 403


async def test_delete_asks_for_the_id_typed_and_spares_the_files_teams(api: Api):
    team = await made(api, new_email())
    for body in ({}, {"confirm": "other"}, {"confirm": team.upper()}, {"confirm": team, "x": 1}):
        r = await api.client.request(
            "DELETE", f"/v1/admin/teams/{team}", json=body, headers=google(ADMIN)
        )
        assert r.status_code == 422 and r.json()["error"] == "confirm_mismatch", body
    r = await api.client.request(
        "DELETE", f"/v1/admin/teams/{team}", content=b"[]", headers=google(ADMIN)
    )
    assert r.status_code == 422
    assert (await admin_delete(api, api.team)).status_code == 409
    assert (await admin_delete(api, api.team)).json()["error"] == "seed_team"
    assert (await admin_delete(api, new_id())).status_code == 404
    assert (await admin_delete(api, "__x__")).status_code == 404
    assert (await api.store.get_teams([team]))[team].status == "active"


async def test_deleting_a_team_refuses_everyone_at_once_on_every_instance(api: Api):
    owner, member = new_email(), new_email()
    team = await made(api, owner, member="olga")
    await invite(api, team, owner, "max", member)
    credential = bearer((await login(api, email=member, team=team))["credential"])
    async with api.instance() as (other, _):
        # Both instances have the team, the roster and the credential cached.
        for client in (api.client, other):
            assert (await client.get(f"/v1/teams/{team}/me", headers=credential)).status_code == 200
            r = await client.get(f"/v1/teams/{team}/me", headers=google(owner))
            assert r.status_code == 200
            r = await client.get(f"/v1/teams/{team}/directory", headers=any_delegate(owner))
            assert r.status_code == 200
        r = await admin_delete(api, team)
        assert r.status_code == 200, r.text
        assert r.json() == {
            "team": team,
            "status": "deleted",
            "removal": "complete",
            "deleted_at": "2026-09-23T12:00:00.000Z",
            "reserved_until": "2026-10-24T12:00:00.000Z",
        }
        for client in (api.client, other):
            r = await client.get(f"/v1/teams/{team}/me", headers=credential)
            assert r.status_code == 401  # the credential stopped working
            r = await client.get(f"/v1/teams/{team}/me", headers=google(owner))
            assert r.status_code == 401  # on no team at all now
            r = await client.get(f"/v1/teams/{team}/directory", headers=any_delegate(owner))
            assert r.status_code == 404
            r = await client.post(
                f"/v1/teams/{team}/roster",
                json={"member": "z9", "email": new_email()},
                headers=google(owner),
            )
            assert r.status_code == 401
        r = await api.client.get("/v1/me/teams", headers=google(owner))
        assert r.json()["teams"] == [] and r.json()["teams_created"] == 0
    admin = [e for e in await api.store.list_admin_audit(100000) if e.team == team]
    assert sorted((e.action, e.outcome, e.actor_email_sha256) for e in admin) == [
        ("team.create", "created", email_hash(owner)),
        ("team.delete", "deleted", email_hash(ADMIN)),
    ]
    state = await api.store.read_roster(team)
    assert state.entries == {} and await api.store.list_audit(team) == []
    # Deleting again is harmless: the removal is simply confirmed.
    r = await admin_delete(api, team)
    assert r.status_code == 200 and r.json()["removal"] == "complete"


async def test_the_id_stays_reserved_for_31_days_then_starts_clean(api: Api):
    owner, member = new_email(), new_email()
    team = await made(api, owner, member="olga")
    await invite(api, team, owner, "max", member)
    credential = bearer((await login(api, email=member, team=team))["credential"])
    assert (await admin_delete(api, team)).status_code == 200
    r = await create(api, new_email(), team)
    assert r.status_code == 409 and r.json()["error"] == "team_id_unavailable"
    prefix = team
    rows = await admin_rows(api, prefix[:-1])
    assert rows[team]["status"] == "deleted" and rows[team]["removal"] == "complete"
    api.clock.advance(31 * 86400 - 1)
    assert (await create(api, new_email(), team)).status_code == 409
    api.clock.advance(1)
    newcomer = new_email()
    assert (await create(api, newcomer, team, member="nina")).status_code == 201
    r = await api.client.get(f"/v1/teams/{team}/roster", headers=google(newcomer))
    assert [m["member"] for m in r.json()["members"]] == ["nina"]
    assert (await api.client.get(f"/v1/teams/{team}/me", headers=credential)).status_code == 401
    r = await api.client.get(f"/v1/teams/{team}/me", headers=google(owner))
    assert r.status_code == 401
    record = (await api.store.get_teams([team]))[team]
    # The old one's 3 (created, invited, accepted), then one: no stale cache matches.
    assert record.roster_version == 4


async def test_a_removal_that_runs_out_of_budget_resumes(api: Api, monkeypatch):
    owner = new_email()
    team = await made(api, owner)
    for n in range(3):
        await api.client.post(
            f"/v1/teams/{team}/roster",
            json={"member": f"m{n}", "email": new_email()},
            headers=google(owner),
        )
    monkeypatch.setattr(teams_module, "PURGE_BUDGET", 2)
    r = await admin_delete(api, team)
    assert r.status_code == 200 and r.json()["removal"] == "pending"
    # Refused at once all the same.
    assert (await api.client.get(f"/v1/teams/{team}/me", headers=google(owner))).status_code == 401
    rows = await admin_rows(api, team[:-1])
    assert rows[team]["removal"] == "pending"
    calls = 0
    while (await admin_delete(api, team)).json()["removal"] == "pending":
        calls += 1
        assert calls < 50
    assert (await api.store.get_teams([team]))[team].purge_complete
    assert await api.store.list_audit(team) == []
    outcomes = sorted(e.outcome for e in await api.store.list_admin_audit(100000) if e.team == team)
    assert outcomes == ["created", "deleted"] + ["resumed"] * (calls + 1)


async def test_a_listing_hides_a_deleted_team_once_its_id_is_free(api: Api):
    team = await made(api, new_email())
    await admin_delete(api, team)
    assert team in await admin_rows(api, team[:-1])
    api.clock.advance(31 * 86400)
    assert team not in await admin_rows(api, team[:-1])


async def test_a_sign_in_to_a_team_deleted_meanwhile_mints_nothing(api: Api):
    from .login_helpers import choose, continue_as, to_chooser, token

    owner = new_email()
    team = await made(api, owner)
    chooser = await to_chooser(api.client, api.fake, owner)
    assert team in chooser.teams
    await admin_delete(api, team)
    r = await choose(
        api.client,
        chooser.started.cookie,
        {"csrf": chooser.csrf, "team": team, "action": "continue"},
    )
    assert r.status_code == 403 and "no longer on this team" in r.text
    # Chosen before the deletion, redeemed after: invalid_grant, no credential.
    other_owner = new_email()
    second = await made(api, other_owner)
    chooser = await to_chooser(api.client, api.fake, other_owner)
    query = await continue_as(api.client, chooser, second)
    await admin_delete(api, second)
    r = await token(api.client, query["code"], chooser.started.verifier)
    assert r.status_code == 400 and r.json() == {"error": "invalid_grant"}


async def test_a_roster_change_racing_a_deletion_writes_nothing(api: Api):
    owner = new_email()
    team = await made(api, owner, member="olga")
    service = api.app.state.service
    await service.teams.delete(team, actor_sha256=email_hash(ADMIN), confirm=team)
    with pytest.raises(Exception) as caught:
        await service.roster_add(
            Caller(team=team, member="olga"), {"member": "x1", "email": new_email()}
        )
    assert getattr(caught.value, "status", None) == 404
    assert (await api.store.get_teams([team]))[team].status == TEAM_DELETED


# The any-team delegate (M9-SPEC §5) ----------------------------------------------------------


def _bob_also(email: str):
    """``email`` as a second Google account of bob, a plain member of the file's team."""

    def edit(data: dict[str, Any]) -> None:
        data["teams"][0]["members"][1]["principals"].append(f"google:{email}")

    return edit


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_the_any_team_delegate_acts_per_team_as_the_member_is(kind: str, clock: FakeClock):
    email = new_email()
    async with open_api(kind, clock, configure=with_m9(edit=_bob_also(email))) as api:
        mine = await made(api, email, member="bo")
        stranger = await made(api, new_email())
        headers = any_delegate(email)
        # Reads in both of their teams, as the member they are there.
        r = await api.client.get(f"/v1/teams/{mine}/me", headers=headers)
        assert (r.json()["member"], r.json()["role"]) == ("bo", "owner")
        r = await api.client.get(api.url("/me"), headers=headers)
        assert (r.json()["member"], r.json()["role"]) == ("bob", "member")
        # Not theirs and not a team (or not any more) are one answer (M9-SPEC §7.3): 404.
        r = await api.client.get(f"/v1/teams/{stranger}/me", headers=headers)
        assert r.status_code == 404 and r.json() == {"error": "not_found"}
        assert (
            await api.client.get(f"/v1/teams/{new_id()}/me", headers=headers)
        ).status_code == 404
        assert (await api.client.get("/v1/teams/__x__/me", headers=headers)).status_code == 404
        # Roster changes only where the member is an owner.
        r = await api.client.post(
            f"/v1/teams/{mine}/roster", json={"member": "m2", "email": new_email()}, headers=headers
        )
        assert r.status_code == 201
        r = await api.client.post(
            api.url("/roster"), json={"member": "m2", "email": new_email()}, headers=headers
        )
        assert r.status_code == 403
        # Still only the delegate routes: never a stream read or a request.
        r = await api.client.get(f"/v1/teams/{mine}/streams/inbox", headers=headers)
        assert r.status_code == 403
        await admin_delete(api, mine)
        assert (await api.client.get(f"/v1/teams/{mine}/me", headers=headers)).status_code == 404


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_an_any_team_delegate_that_only_reads_changes_no_roster(kind: str, clock: FakeClock):
    email = new_email()
    async with open_api(kind, clock, configure=with_m9(["read"])) as api:
        r = await api.client.post(
            "/v1/teams",
            json={"name": "N", "id": new_id(), "owner_member_id": "o1"},
            headers=google(email),
        )
        team = r.json()["team"]
        r = await api.client.post(
            f"/v1/teams/{team}/roster",
            json={"member": "m2", "email": new_email()},
            headers=any_delegate(email),
        )
        assert r.status_code == 403
        r = await api.client.get(f"/v1/teams/{team}/roster", headers=any_delegate(email))
        assert r.status_code == 200


# Configuration -----------------------------------------------------------------------------------


def _config(**changes: Any) -> dict[str, Any]:
    data = with_delegates(team_config_data())
    data.update(changes)
    return data


def test_config_accepts_admins_the_any_team_delegate_and_team_names():
    data = _config(admins=["google:Root@Example.com"])
    data["delegates"].append({"principal": DELEGATES["any"], "team": "*", "scope": ANY_SCOPES})
    data["teams"][0]["name"] = "  Demo team "
    config = parse_team_config(data)
    assert config.admins == frozenset({"root@example.com"})
    assert config.is_admin("root@example.com")
    delegate = config.delegate(DELEGATES["any"])
    assert delegate is not None and delegate.any_team and delegate.manages_teams
    assert config.teams["demo"].display_name == "Demo team"
    assert config.teams["other"].display_name == "other"
    assert config.limits.teams_per_account == 3 and config.limits.members_per_team == 50
    assert config.limits.team_creations_per_account_per_day == 10
    assert config.limits.team_creations_per_ip_per_hour == 30


@pytest.mark.parametrize(
    "change, message",
    [
        ({"admins": ["root@example.com"]}, "admins.0"),
        ({"admins": ["google:a@example.com", "google:A@example.com"]}, "listed twice"),
        ({"admins": [DELEGATES["demo"]]}, "delegate"),
        ({"limits": {"members_per_team": 51}}, "members_per_team"),
        ({"limits": {"teams_per_account": 0}}, "teams_per_account"),
    ],
)
def test_config_refuses(change: dict[str, Any], message: str):
    with pytest.raises(ConfigError) as caught:
        parse_team_config(_config(**change))
    assert message in str(caught.value)


def test_manage_teams_is_only_for_an_any_team_delegate():
    data = _config()
    data["delegates"][0]["scope"] = ["read", "manage-teams"]
    with pytest.raises(ConfigError) as caught:
        parse_team_config(data)
    assert "manage-teams" in str(caught.value)
    data = _config()
    data["teams"][0]["name"] = "bad\x00name"
    with pytest.raises(ConfigError):
        parse_team_config(data)
    data = _config()
    data["delegates"].append({"principal": DELEGATES["any"], "team": "nope", "scope": "read"})
    with pytest.raises(ConfigError):
        parse_team_config(data)


async def test_emails_of_members_stay_out_of_the_logs(api: Api, capsys):
    owner, member = new_email(), new_email()
    team = await made(api, owner)
    await api.client.post(
        f"/v1/teams/{team}/roster", json={"member": "max", "email": member}, headers=google(owner)
    )
    await api.client.get("/v1/me/teams", headers=google(member))
    await admin_delete(api, team)
    out = capsys.readouterr().out
    assert owner not in out and member not in out and ADMIN not in out
    assert EMAILS["alice"] not in out
