"""M2-SPEC §1 and §2: the relay's Cloud Run environment, /v1/health, and RELAY_AUDIENCE as a
list of audiences. Throwaway keys and synthetic identities only; nothing reaches the network
or GCP."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from relay import __main__ as relay_main
from relay import app as app_module
from relay.app import create_app
from relay.auth import (
    GoogleVerifier,
    Unauthenticated,
    audience_set_digest,
    build_verifier,
    verified_cache_key,
)
from relay.config import Settings, load_schema, parse_audiences, parse_team_config
from relay.errors import ConfigError
from relay.store_memory import MemoryStore

from .conftest import SCHEMA_PATH, TOKENS, team_config_data
from .test_google_verifier import Clock, FakeCertsEndpoint, make_token

pytestmark = pytest.mark.anyio

GCLOUD_CLIENT = "32555940559.apps.googleusercontent.com"
SERVICE_URL = "https://team-relay-test.a.run.app"


def _write_config(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "team.yaml"
    path.write_text(json.dumps(team_config_data()))  # JSON is YAML
    return path


def _login_env(directory: Path) -> dict[str, str]:
    """M5-SPEC §5: on Cloud Run the relay also needs its public URL and its OAuth client."""
    directory.mkdir(parents=True, exist_ok=True)
    client = directory / "oauth-client.json"
    client.write_text(json.dumps({"client_id": "id.example", "client_secret": "s3cret"}))
    return {"RELAY_PUBLIC_URL": SERVICE_URL, "RELAY_OAUTH_CLIENT_FILE": str(client)}


# /v1/health ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [{}, {"Authorization": "Bearer not-a-known-token"}, {"Authorization": "Basic x"}],
)
async def test_v1_health_needs_no_credentials_and_matches_healthz(client, headers):
    r = await client.get("/v1/health", headers=headers)
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert r.json() == (await client.get("/healthz")).json()


async def test_v1_health_is_get_only(client):
    assert (await client.post("/v1/health")).status_code == 405


async def test_v1_health_under_google_mode_needs_no_token():
    settings = Settings(
        team_config=parse_team_config(team_config_data()),
        manifest_schema=load_schema(SCHEMA_PATH),
        auth_mode="google",
        audiences=(GCLOUD_CLIENT,),
    )
    endpoint = FakeCertsEndpoint()
    app = create_app(
        settings, MemoryStore(), verifier=GoogleVerifier(GCLOUD_CLIENT, transport=endpoint)
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://relay"
    ) as c:
        assert (await c.get("/v1/health")).json() == {"ok": True}
        assert (await c.get("/v1/teams/demo/me")).status_code == 401
    assert endpoint.fetches == 0


# RELAY_AUDIENCE ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("https://relay.example", ("https://relay.example",)),
        (f"{GCLOUD_CLIENT},{SERVICE_URL}", (GCLOUD_CLIENT, SERVICE_URL)),
        (f" {GCLOUD_CLIENT} , {SERVICE_URL} ", (GCLOUD_CLIENT, SERVICE_URL)),
        (f"{GCLOUD_CLIENT},{SERVICE_URL},{GCLOUD_CLIENT}", (GCLOUD_CLIENT, SERVICE_URL)),
        (None, ()),
        ("", ()),
        ("   ", ()),
    ],
)
def test_parse_audiences(raw, expected):
    assert parse_audiences(raw) == expected


@pytest.mark.parametrize("raw", ["a,,b", "a,", ",a", " , ", "a, ", ",", "a,\t,b"])
def test_an_empty_audience_entry_is_a_startup_error(raw, tmp_path: Path):
    with pytest.raises(ConfigError, match="RELAY_AUDIENCE has an empty entry"):
        parse_audiences(raw)
    env = {"RELAY_TEAM_CONFIG": str(_write_config(tmp_path)), "RELAY_AUDIENCE": raw}
    with pytest.raises(ConfigError, match="RELAY_AUDIENCE has an empty entry"):
        Settings.from_env(env)


def test_settings_carry_every_audience(tmp_path: Path):
    env = {
        "RELAY_TEAM_CONFIG": str(_write_config(tmp_path)),
        "RELAY_AUDIENCE": f"{GCLOUD_CLIENT},{SERVICE_URL}",
        "K_SERVICE": "team-relay",
        **_login_env(tmp_path / "oauth"),
    }
    settings = Settings.from_env(env)
    assert settings.auth_mode == "google"
    assert settings.audiences == (GCLOUD_CLIENT, SERVICE_URL)
    verifier = build_verifier(settings)
    assert isinstance(verifier, GoogleVerifier)
    assert verifier._audiences == [GCLOUD_CLIENT, SERVICE_URL]


@pytest.mark.parametrize("audiences", [("",), ("a", ""), (" a",), ["a"], ("a", 1)])
def test_settings_refuse_malformed_audiences(audiences):
    with pytest.raises(ConfigError):
        Settings(
            team_config=parse_team_config(team_config_data()),
            manifest_schema=load_schema(SCHEMA_PATH),
            auth_mode="google",
            audiences=audiences,  # type: ignore[arg-type]
        )


def test_google_mode_needs_at_least_one_audience():
    with pytest.raises(ConfigError, match="RELAY_AUDIENCE is required"):
        Settings(
            team_config=parse_team_config(team_config_data()),
            manifest_schema=load_schema(SCHEMA_PATH),
            auth_mode="google",
        )


@pytest.mark.parametrize("audiences", ["", [], ["a", ""], ("",)])
def test_the_verifier_refuses_an_empty_audience(audiences):
    with pytest.raises(ValueError):
        GoogleVerifier(audiences)


@pytest.fixture
def two_audiences() -> GoogleVerifier:
    return GoogleVerifier(
        [GCLOUD_CLIENT, SERVICE_URL], transport=FakeCertsEndpoint(), clock=Clock()
    )


@pytest.mark.parametrize("aud", [GCLOUD_CLIENT, SERVICE_URL])
async def test_a_token_for_any_listed_audience_is_accepted(two_audiences, aud):
    assert await two_audiences.principal(make_token(aud=aud)) == "google:alice@example.com"


@pytest.mark.parametrize(
    "aud",
    [
        "https://some-other-service.a.run.app",
        GCLOUD_CLIENT + " ",
        GCLOUD_CLIENT.upper(),
        f"{GCLOUD_CLIENT},{SERVICE_URL}",
        [GCLOUD_CLIENT],  # an array-valued aud is never one of the accepted strings
        [GCLOUD_CLIENT, SERVICE_URL],
    ],
)
async def test_a_token_for_any_other_audience_is_refused(two_audiences, aud):
    with pytest.raises(Unauthenticated):
        await two_audiences.principal(make_token(aud=aud))


async def test_the_other_checks_still_apply_with_a_list(two_audiences):
    for claims in ({"email_verified": False}, {"iss": "https://evil.example"}):
        with pytest.raises(Unauthenticated):
            await two_audiences.principal(make_token(aud=SERVICE_URL, **claims))


def test_the_audience_digest_ignores_order_and_duplicates():
    assert audience_set_digest(["a", "b"]) == audience_set_digest(["b", "a", "a"])
    assert audience_set_digest(["a"]) != audience_set_digest(["a", "b"])
    assert audience_set_digest(["a,b"]) != audience_set_digest(["a", "b"])
    assert audience_set_digest(["a\nb"]) != audience_set_digest(["a", "b"])


async def test_the_verified_cache_is_keyed_on_the_audience_set_and_the_token(two_audiences):
    token = make_token(aud=SERVICE_URL)
    await two_audiences.principal(token)
    [key] = list(two_audiences._verified)
    assert key == verified_cache_key(audience_set_digest([GCLOUD_CLIENT, SERVICE_URL]), token)
    assert key != hashlib.sha256(token.encode()).hexdigest()  # not the token alone
    assert key != verified_cache_key(audience_set_digest([SERVICE_URL]), token)
    assert key != verified_cache_key(audience_set_digest([GCLOUD_CLIENT]), token)


async def test_a_principal_cached_under_one_audience_set_is_not_served_under_another():
    """Two verifiers sharing one cache (the cache is per verifier today; this pins that the
    key would keep them apart if it ever were shared)."""
    endpoint, clock = FakeCertsEndpoint(), Clock()
    wide = GoogleVerifier([GCLOUD_CLIENT, SERVICE_URL], transport=endpoint, clock=clock)
    narrow = GoogleVerifier([SERVICE_URL], transport=endpoint, clock=clock)
    narrow._verified = wide._verified  # shared on purpose
    token = make_token(aud=GCLOUD_CLIENT)
    assert await wide.principal(token) == "google:alice@example.com"
    with pytest.raises(Unauthenticated):
        await narrow.principal(token)  # re-verified under its own set, and refused


# The Cloud Run environment (M2-SPEC §1) -------------------------------------------------------


def test_the_team_config_is_read_from_a_mounted_secret_file(tmp_path: Path):
    # Secret Manager volumes present the file through symlinks (…/team.yaml -> ..data/…).
    real = _write_config(tmp_path / "secrets" / "team" / "..2026_09_23")
    data_link = tmp_path / "secrets" / "team" / "..data"
    data_link.symlink_to(real.parent.name)
    mounted = tmp_path / "secrets" / "team" / "team.yaml"
    mounted.symlink_to(Path("..data") / "team.yaml")
    env = {
        "RELAY_TEAM_CONFIG": str(mounted),
        "RELAY_AUDIENCE": f"{GCLOUD_CLIENT},{SERVICE_URL}",
        "K_SERVICE": "team-relay",
        **_login_env(tmp_path / "oauth"),
    }
    settings = Settings.from_env(env)
    assert [s.id for s in settings.team_config.teams["demo"].seeds] == ["alice", "bob", "carol"]


def test_a_missing_mounted_file_is_a_startup_error(tmp_path: Path):
    env = {
        "RELAY_TEAM_CONFIG": str(tmp_path / "secrets" / "team" / "team.yaml"),
        "RELAY_AUDIENCE": SERVICE_URL,
    }
    with pytest.raises(ConfigError, match="cannot read team config"):
        Settings.from_env(env)


def test_the_app_from_env_uses_the_named_firestore_database(tmp_path: Path, monkeypatch):
    seen: dict[str, Any] = {}

    class FakeFirestoreStore(MemoryStore):
        def __init__(self, project: str | None = None, database: str | None = None) -> None:
            super().__init__()
            seen.update(project=project, database=database)

    import relay.store_firestore as store_firestore

    monkeypatch.setattr(store_firestore, "FirestoreStore", FakeFirestoreStore)
    monkeypatch.setenv("RELAY_TEAM_CONFIG", str(_write_config(tmp_path)))
    monkeypatch.setenv("RELAY_AUTH_MODE", "google")
    monkeypatch.setenv("RELAY_AUDIENCE", f"{GCLOUD_CLIENT},{SERVICE_URL}")
    monkeypatch.setenv("RELAY_FIRESTORE_DATABASE", "team-relay")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "demo-project")
    app = app_module.create_app_from_env()
    assert seen == {"project": "demo-project", "database": "team-relay"}
    assert isinstance(app.state.store, FakeFirestoreStore)


@pytest.mark.parametrize(
    "env, host, port",
    [({}, "127.0.0.1", 8080), ({"RELAY_HOST": "0.0.0.0", "PORT": "9090"}, "0.0.0.0", 9090)],
)
def test_the_listen_address_comes_from_relay_host(monkeypatch, env, host, port):
    calls: list[dict[str, Any]] = []
    monkeypatch.delenv("RELAY_HOST", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(relay_main.uvicorn, "run", lambda app, **kw: calls.append(kw))
    relay_main.main()
    assert calls[0]["host"] == host and calls[0]["port"] == port


def test_static_tokens_still_resolve_under_the_new_settings(tmp_path: Path):
    env = {"RELAY_TEAM_CONFIG": str(_write_config(tmp_path)), "RELAY_AUTH_MODE": "static"}
    settings = Settings.from_env(env)
    assert settings.audiences == ()
    principal = "token:sha256:" + hashlib.sha256(TOKENS["alice"].encode()).hexdigest()
    assert settings.team_config.token_member(principal, "demo") == "alice"
