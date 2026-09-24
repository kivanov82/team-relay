"""M9-SPEC §3 on both stores: creating a team from the login flow. An account on no team
sees "You're not on a team yet" with the form; the chooser offers "Create a new team". The
form takes the chooser's cookie, Origin, CSRF and step rules; a created team is preselected
and the sign-in goes on to a credential; a refused creation shows the form again, escaped."""

from __future__ import annotations

import hashlib
import re
import uuid
from html import unescape
from urllib.parse import urlencode

import httpx
import pytest

from .conftest import PUBLIC_URL, Api, FakeClock, open_api
from .login_helpers import (
    Chooser,
    bearer,
    choose,
    continue_as,
    google,
    hidden_csrf,
    loopback,
    start,
    team_values,
    to_chooser,
    token,
)

pytestmark = pytest.mark.anyio

FORM = {"Content-Type": "application/x-www-form-urlencoded"}


def new_email() -> str:
    return f"u{uuid.uuid4().hex[:16]}@example.com"


def new_id() -> str:
    return "k" + uuid.uuid4().hex[:20]


def checked_teams(html: str) -> list[str]:
    found = re.findall(r'<input type="radio" name="team" value="([^"]*)" checked', html)
    return [unescape(v) for v in found]


def field_value(html: str, name: str) -> str:
    match = re.search(rf'<input[^>]* name="{name}" value="([^"]*)"', html)
    assert match, html
    return unescape(match.group(1))


async def post_create(
    client: httpx.AsyncClient,
    cookie: str | None,
    fields: dict[str, str],
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    all_headers = {**FORM, **(headers or {})}
    if cookie is not None:
        all_headers["Cookie"] = f"trl={cookie}"
    return await client.post("/v1/login/create", content=urlencode(fields), headers=all_headers)


async def no_team_page(api: Api, email: str):
    started = await start(api.client)
    r = await google(api.client, api.fake, started, email)
    assert r.status_code == 200, r.text
    return started, r


def fields(csrf: str, **values: str) -> dict[str, str]:
    return {"csrf": csrf, "name": "Night shift", "team": "", "member": "", **values}


async def test_an_account_on_no_team_creates_one_and_signs_in(api: Api):
    email, team = new_email(), new_id()
    started, page = await no_team_page(api, email)
    assert "You're not on a team yet" in page.text
    csrf = hidden_csrf(page.text)
    # The member id is suggested from the email.
    assert field_value(page.text, "member") == email.split("@")[0]
    r = await post_create(
        api.client,
        started.cookie,
        fields(csrf, name="Night <shift>", team=team, member="nia", action="create"),
    )
    assert r.status_code == 200, r.text
    assert team_values(r.text) == [team] and checked_teams(r.text) == [team]
    assert "Night &lt;shift&gt;" in r.text and "<shift>" not in r.text
    assert "Create a new team</button>" in r.text  # still offered
    # Continue as the new team's owner, then the token.
    chooser_csrf = hidden_csrf(r.text)
    r = await choose(
        api.client, started.cookie, {"csrf": chooser_csrf, "team": team, "action": "continue"}
    )
    _, query = loopback(r)
    r = await token(api.client, query["code"], started.verifier)
    assert r.status_code == 200, r.text
    assert (r.json()["team"], r.json()["member"], r.json()["email"]) == (team, "nia", email)
    me = await api.client.get(f"/v1/teams/{team}/me", headers=bearer(r.json()["credential"]))
    assert (me.json()["role"], me.json()["name"]) == ("owner", "Night <shift>")
    # The owner is bound to the Google account that signed in (M6-SPEC §7.2).
    entry = (await api.store.read_roster(team)).entries["nia"]
    assert entry.subs == {email: hashlib.sha256(email.encode()).hexdigest()[:21]}


async def test_a_blank_id_is_made_from_the_name(api: Api):
    email = new_email()
    name = "Zulu " + uuid.uuid4().hex[:8]
    started, page = await no_team_page(api, email)
    r = await post_create(
        api.client,
        started.cookie,
        fields(hidden_csrf(page.text), name=name, member="zed", action="create"),
    )
    assert r.status_code == 200, r.text
    assert team_values(r.text) == [name.lower().replace(" ", "-")]


def page_inputs(html: str) -> list[tuple[str, str]]:
    """Every ``<input>`` on the page as ``(type, name)``, as a naive headless client reads
    them (the plugin's e2e browser stub collects them all, whatever form they are in)."""
    tags = re.findall(r"<input\b[^>]*>", html)
    return [
        (re.search(r'type="([^"]*)"', t).group(1), re.search(r'name="([^"]*)"', t).group(1))
        for t in tags
    ]


async def test_the_chooser_keeps_one_form_and_its_fields(api: Api):
    """The chooser POST contract of M5 is unchanged: one form, a hidden csrf, the team radios,
    and buttons named action (continue first). "Create a new team" is a button of that same
    form (action=new), so a client that submits every input and the first button still
    chooses a team."""
    chooser = await to_chooser(api.client, api.fake, "alice@example.com")
    html = chooser.response.text
    assert html.count("<form") == 1 and 'action="/v1/login/choose"' in html
    assert {name for _, name in page_inputs(html)} == {"csrf", "team"}
    assert [t for t, n in page_inputs(html) if n == "csrf"] == ["hidden"]
    buttons = re.findall(r'<button[^>]*name="action" value="([^"]*)"', html)
    assert buttons == ["continue", "cancel", "new"]
    assert "Create a new team</button>" in html
    # What the stub sends: every input, the checked radio, the first button.
    r = await choose(
        api.client,
        chooser.started.cookie,
        {"csrf": chooser.csrf, "team": chooser.teams[0], "action": "continue"},
    )
    assert r.status_code == 303


async def test_an_account_on_teams_creates_another_from_the_chooser(api: Api):
    email, team = new_email(), new_id()
    started, page = await no_team_page(api, email)
    assert page.text.count("<form") == 1 and 'action="/v1/login/create"' in page.text
    assert "Back</button>" not in page.text  # no teams to go back to
    csrf = hidden_csrf(page.text)
    r = await post_create(
        api.client, started.cookie, fields(csrf, team=team, member="mo", action="create")
    )
    assert r.status_code == 200 and checked_teams(r.text) == [team]
    assert r.text.count("<form") == 1
    # The chooser's "Create a new team": the create page, with Back.
    r = await choose(api.client, started.cookie, {"csrf": csrf, "team": team, "action": "new"})
    assert r.status_code == 200 and "<h1>Create a new team</h1>" in r.text
    assert 'action="/v1/login/create"' in r.text and "Back</button>" in r.text
    assert field_value(r.text, "member") == email.split("@")[0]
    # Back: the chooser again, nothing created.
    r = await post_create(api.client, started.cookie, {"csrf": csrf, "action": "back"})
    assert r.status_code == 200 and team_values(r.text) == [team]
    second = new_id()
    r = await post_create(
        api.client, started.cookie, fields(csrf, team=second, member="mo", action="create")
    )
    assert r.status_code == 200, r.text
    assert sorted(team_values(r.text)) == sorted([team, second])
    assert checked_teams(r.text) == [second]  # only the new one, though there are two
    # A refusal here keeps the "Create a new team" page (with Back).
    r = await post_create(
        api.client, started.cookie, fields(csrf, team=second, member="mo", action="create")
    )
    assert r.status_code == 409 and "<h1>Create a new team</h1>" in r.text


async def test_a_refused_creation_shows_the_form_again_escaped(api: Api):
    email = new_email()
    started, page = await no_team_page(api, email)
    csrf = hidden_csrf(page.text)
    bad = '"><script>alert(1)</script>'
    r = await post_create(
        api.client, started.cookie, fields(csrf, name=bad + "x" * 60, member=bad, action="create")
    )
    assert r.status_code == 422
    assert "<script>" not in r.text and "&lt;script&gt;" in r.text
    assert "1 to 60 characters" in r.text
    assert "You're not on a team yet" in r.text
    assert hidden_csrf(r.text) == csrf  # the same login, the same token
    # A taken id: 409, with the id to edit.
    taken = new_id()
    r = await post_create(
        api.client, started.cookie, fields(csrf, team=taken, member="ok1", action="create")
    )
    assert r.status_code == 200
    started2, page2 = await no_team_page(api, new_email())
    r = await post_create(
        api.client,
        started2.cookie,
        fields(hidden_csrf(page2.text), team=taken, member="ok2", action="create"),
    )
    assert r.status_code == 409 and "That team id is taken" in r.text
    assert field_value(r.text, "team") == taken
    # A reserved id made from the name is shown, to edit.
    r = await post_create(
        api.client,
        started2.cookie,
        fields(hidden_csrf(page2.text), name="Demo", member="ok2", action="create"),
    )
    assert r.status_code == 409 and field_value(r.text, "team") == "demo"


@pytest.mark.parametrize(
    "tamper, status",
    [
        ({"csrf": "A" * 43}, 403),
        ({"csrf": ""}, 403),
        ({"action": "continue"}, 400),
        ({"extra": "1"}, 400),
    ],
)
async def test_the_form_is_checked_like_the_chooser(api: Api, tamper: dict[str, str], status: int):
    started, page = await no_team_page(api, new_email())
    values = {**fields(hidden_csrf(page.text), team=new_id(), member="ab", action="create")}
    values.update(tamper)
    r = await post_create(api.client, started.cookie, values)
    assert r.status_code == status, r.text
    assert "Your team" not in r.text


async def test_no_cookie_a_foreign_origin_or_another_body_type_create_nothing(api: Api):
    started, page = await no_team_page(api, new_email())
    team = new_id()
    good = fields(hidden_csrf(page.text), team=team, member="ab", action="create")
    assert (await post_create(api.client, None, good)).status_code == 400
    r = await post_create(api.client, started.cookie, good, {"Origin": "https://evil.example"})
    assert r.status_code == 403
    r = await api.client.post(
        "/v1/login/create",
        json=good,
        headers={"Cookie": f"trl={started.cookie}"},
    )
    assert r.status_code == 400
    assert await api.store.get_teams([team]) == {}
    # Same origin is fine.
    r = await post_create(api.client, started.cookie, good, {"Origin": PUBLIC_URL})
    assert r.status_code == 200 and team_values(r.text) == [team]


async def test_only_at_the_choose_step(api: Api):
    # Before Google: the login is at step google.
    started = await start(api.client)
    r = await post_create(
        api.client, started.cookie, fields("A" * 43, team=new_id(), member="ab", action="create")
    )
    assert r.status_code == 400
    # After the choice: done.
    email = new_email()
    started, page = await no_team_page(api, email)
    csrf = hidden_csrf(page.text)
    team = new_id()
    r = await post_create(
        api.client, started.cookie, fields(csrf, team=team, member="ab", action="create")
    )
    chooser = Chooser(started=started, response=r, csrf=hidden_csrf(r.text), teams=[team])
    await continue_as(api.client, chooser, team)
    later = new_id()
    r = await post_create(
        api.client, started.cookie, fields(csrf, team=later, member="ab", action="create")
    )
    assert r.status_code == 400 and await api.store.get_teams([later]) == {}
    # Expired.
    started, page = await no_team_page(api, new_email())
    api.clock.advance(601)
    expired = new_id()
    r = await post_create(
        api.client,
        started.cookie,
        fields(hidden_csrf(page.text), team=expired, member="ab", action="create"),
    )
    assert r.status_code == 400 and await api.store.get_teams([expired]) == {}


async def test_cancel_from_the_form_ends_the_login(api: Api):
    started, page = await no_team_page(api, new_email())
    r = await post_create(
        api.client, started.cookie, {"csrf": hidden_csrf(page.text), "action": "cancel"}
    )
    target, query = loopback(r)
    assert target == f"http://127.0.0.1:{started.port}/callback"
    assert query == {"error": "access_denied", "state": started.state}


@pytest.mark.parametrize("kind", ["memory", "firestore"])
async def test_the_creation_limits_hold_in_the_login_flow(kind: str, clock: FakeClock):
    clock.current = clock.current.replace(minute=0, second=0)
    async with open_api(kind, clock, team_creations_per_ip_per_hour=1) as api:
        ip = f"10.8.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}"
        async with api.instance(client_ip=ip) as (client, _):
            for n, expected in enumerate((200, 429)):
                started = await start(client)
                page = await google(client, api.fake, started, new_email())
                r = await post_create(
                    client,
                    started.cookie,
                    fields(hidden_csrf(page.text), team=new_id(), member=f"m{n}x", action="create"),
                )
                assert r.status_code == expected, r.text
            assert "an hour from this address" in r.text
