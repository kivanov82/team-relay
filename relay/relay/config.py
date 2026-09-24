"""Team configuration (who may speak for which member) and process settings from env.

The team file is the only source of identity: a verified credential yields a principal,
and the principal resolves to exactly one (team, member) here (M1-SPEC §2), or to one
read-only delegate of a team, which reads on behalf of that team's members (M3-SPEC §2).
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .errors import ConfigError

TEAM_RE = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
MEMBER_RE = re.compile(r"^[a-z][a-z0-9_]{1,31}$")
GOOGLE_PRINCIPAL_RE = re.compile(r"^google:([^@\s:]+@[^@\s]+\.[^@\s]+)$")
TOKEN_PRINCIPAL_RE = re.compile(r"^token:sha256:[0-9a-f]{64}$")

# A broadcast writes one envelope and one stream head per recipient in one transaction,
# plus the request, the idempotency record and the audit entries; Firestore caps a
# transaction at 500 writes. Well above a team of three, well below the cap.
MAX_MEMBERS_PER_TEAM = 50
# M3-SPEC §2: one console service per deployment; a handful leaves room, not a registry.
MAX_DELEGATES = 10

AuthMode = Literal["google", "static"]
DelegateScope = Literal["read"]

# RFC 5321 caps a mailbox at 254 characters; with "google:" in front, well under this.
MAX_ON_BEHALF_LENGTH = 320


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _MemberFile(_Strict):
    id: str
    principals: list[str] = Field(min_length=1)


class _TeamFile(_Strict):
    id: str
    members: list[_MemberFile] = Field(min_length=1, max_length=MAX_MEMBERS_PER_TEAM)


class _LimitsFile(_Strict):
    min_ack_timeout_seconds: int = Field(default=10, ge=1, le=3600)
    min_answer_timeout_seconds: int = Field(default=60, ge=1, le=86400)
    # Abuse limits (M1-SPEC §11.7). Per sender and per minute, counted in the store.
    requests_per_minute: int = Field(default=30, ge=1, le=10000)
    broadcasts_per_minute: int = Field(default=5, ge=1, le=10000)
    audited_refusals_per_minute: int = Field(default=60, ge=1, le=10000)
    # Per (team, member, stream) and per relay instance: concurrent long-polls (wait > 0).
    concurrent_polls: int = Field(default=2, ge=1, le=100)
    # M2-SPEC §7.3: reads of /activity and /directory, one budget per member and minute,
    # counted in the store.
    reads_per_minute: int = Field(default=120, ge=1, le=10000)


class _DelegateFile(_Strict):
    principal: str
    team: str
    # One value (M3-SPEC §2): a delegate reads, nothing else.
    scope: DelegateScope


class _ConfigFile(_Strict):
    teams: list[_TeamFile] = Field(min_length=1)
    delegates: list[_DelegateFile] = Field(default_factory=list, max_length=MAX_DELEGATES)
    limits: _LimitsFile = Field(default_factory=_LimitsFile)
    audit_retention_days: int = Field(default=90, ge=1, le=3650)


@dataclass(frozen=True)
class Limits:
    min_ack_timeout_seconds: int = 10
    min_answer_timeout_seconds: int = 60
    requests_per_minute: int = 30
    broadcasts_per_minute: int = 5
    audited_refusals_per_minute: int = 60
    concurrent_polls: int = 2
    reads_per_minute: int = 120


@dataclass(frozen=True)
class Team:
    id: str
    members: tuple[str, ...]


@dataclass(frozen=True)
class Identity:
    team: str
    member: str


@dataclass(frozen=True)
class Delegate:
    """A service that reads a team's console views on behalf of one member at a time
    (M3-SPEC §2). It is never a member and never the caller: the member it names is."""

    principal: str
    team: str
    scope: DelegateScope = "read"


@dataclass(frozen=True)
class TeamConfig:
    teams: Mapping[str, Team]
    principals: Mapping[str, Identity]
    limits: Limits = field(default_factory=Limits)
    audit_retention_days: int = 90
    delegates: Mapping[str, Delegate] = field(default_factory=dict)

    def resolve(self, principal: str) -> Identity | None:
        return self.principals.get(principal)

    def delegate(self, principal: str) -> Delegate | None:
        return self.delegates.get(principal)

    def resolve_on_behalf(self, delegate: Delegate, email: str) -> Identity | None:
        """The member of the delegate's team whose principal is ``google:<email
        lowercased>``, or None. A member of another team is None too: a delegate never
        reaches outside its team."""
        if len(email) > MAX_ON_BEHALF_LENGTH:
            return None
        match = GOOGLE_PRINCIPAL_RE.fullmatch("google:" + email)
        if match is None:
            return None
        identity = self.principals.get("google:" + match.group(1).lower())
        if identity is None or identity.team != delegate.team:
            return None
        return identity

    def members_of(self, team: str) -> tuple[str, ...]:
        return self.teams[team].members


def _normalise_principal(raw: str) -> str:
    match = GOOGLE_PRINCIPAL_RE.match(raw)
    if match:
        return "google:" + match.group(1).lower()
    if TOKEN_PRINCIPAL_RE.match(raw):
        return raw
    raise ConfigError("principal must be 'google:<email>' or 'token:sha256:<64 lowercase hex>'")


def parse_team_config(data: Any) -> TeamConfig:
    try:
        parsed = _ConfigFile.model_validate(data)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first["loc"])
        raise ConfigError(f"team config invalid at {where}: {first['msg']}") from None

    teams: dict[str, Team] = {}
    principals: dict[str, Identity] = {}
    member_team: dict[str, str] = {}
    for team in parsed.teams:
        if not TEAM_RE.match(team.id):
            raise ConfigError(f"team id {team.id!r} does not match {TEAM_RE.pattern}")
        if team.id in teams:
            raise ConfigError(f"duplicate team {team.id!r}")
        members: list[str] = []
        for member in team.members:
            if not MEMBER_RE.match(member.id):
                raise ConfigError(f"member id {member.id!r} does not match {MEMBER_RE.pattern}")
            # A member belongs to exactly one team: the same id twice anywhere is refused.
            if member.id in member_team:
                raise ConfigError(f"duplicate member {member.id!r}")
            member_team[member.id] = team.id
            members.append(member.id)
            for raw in member.principals:
                principal = _normalise_principal(raw)
                if principal in principals:
                    # Not echoing the principal: it may be a token hash or an email.
                    raise ConfigError(f"a principal of member {member.id!r} is listed twice")
                principals[principal] = Identity(team=team.id, member=member.id)
        teams[team.id] = Team(id=team.id, members=tuple(members))

    delegates: dict[str, Delegate] = {}
    for index, entry in enumerate(parsed.delegates):
        match = GOOGLE_PRINCIPAL_RE.match(entry.principal)
        if match is None:
            raise ConfigError(f"delegates.{index}: principal must be 'google:<email>'")
        principal = "google:" + match.group(1).lower()
        if entry.team not in teams:
            raise ConfigError(f"delegates.{index}: team {entry.team!r} is not a team")
        # Not echoing the principal, as for members.
        if principal in principals:
            raise ConfigError(f"delegates.{index}: a delegate principal is also a member's")
        if principal in delegates:
            raise ConfigError(f"delegates.{index}: the delegate principal is listed twice")
        delegates[principal] = Delegate(principal=principal, team=entry.team, scope=entry.scope)

    return TeamConfig(
        teams=teams,
        principals=principals,
        limits=Limits(**parsed.limits.model_dump()),
        audit_retention_days=parsed.audit_retention_days,
        delegates=delegates,
    )


def load_team_config(path: str | os.PathLike[str]) -> TeamConfig:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"cannot read team config: {exc.strerror}") from None
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        raise ConfigError("team config is not valid YAML") from None
    return parse_team_config(data)


def default_schema_path() -> Path:
    # The relay project root is the directory holding the `relay` package; the schema sits
    # beside it at ../schema (M1-SPEC §3.3). The image sets RELAY_MANIFEST_SCHEMA instead.
    return Path(__file__).resolve().parent.parent.parent / "schema" / "manifest.schema.json"


def load_schema(path: str | os.PathLike[str]) -> dict[str, Any]:
    try:
        schema = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        raise ConfigError(f"cannot read manifest schema: {exc.strerror}") from None
    except json.JSONDecodeError:
        raise ConfigError("manifest schema is not valid JSON") from None
    if not isinstance(schema, dict):
        raise ConfigError("manifest schema must be a JSON object")
    return schema


def parse_audiences(raw: str | None) -> tuple[str, ...]:
    """``RELAY_AUDIENCE``: one audience or a comma-separated list (M2-SPEC §2). Whitespace
    around an entry is dropped; an empty entry (``"a,,b"``, a trailing comma, a blank value)
    is a startup error rather than silently ignored. Duplicates collapse, order is kept."""
    if raw is None or not raw.strip():
        return ()
    entries = [entry.strip() for entry in raw.split(",")]
    if any(not entry for entry in entries):
        raise ConfigError("RELAY_AUDIENCE has an empty entry")
    return tuple(dict.fromkeys(entries))


def refuse_static_on_cloud_run(mode: str, env: Mapping[str, str]) -> None:
    if mode == "static" and env.get("K_SERVICE"):
        raise ConfigError("RELAY_AUTH_MODE=static is refused on Cloud Run (K_SERVICE is set)")


@dataclass(frozen=True)
class Settings:
    team_config: TeamConfig
    manifest_schema: dict[str, Any]
    auth_mode: AuthMode = "google"
    # Every audience a Google ID token may carry (M2-SPEC §2): gcloud's OAuth client id and
    # the service URL on Cloud Run.
    audiences: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.auth_mode not in ("google", "static"):
            raise ConfigError("RELAY_AUTH_MODE must be 'google' or 'static'")
        if not isinstance(self.audiences, tuple) or not all(
            isinstance(a, str) and a and a == a.strip() for a in self.audiences
        ):
            raise ConfigError("audiences must be a tuple of non-empty strings")
        if self.auth_mode == "google" and not self.audiences:
            raise ConfigError("RELAY_AUDIENCE is required when RELAY_AUTH_MODE=google")

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        mode = env.get("RELAY_AUTH_MODE", "google") or "google"
        if mode not in ("google", "static"):
            raise ConfigError("RELAY_AUTH_MODE must be 'google' or 'static'")
        refuse_static_on_cloud_run(mode, env)
        config_path = env.get("RELAY_TEAM_CONFIG")
        if not config_path:
            raise ConfigError("RELAY_TEAM_CONFIG is required")
        schema_path = env.get("RELAY_MANIFEST_SCHEMA") or default_schema_path()
        return cls(
            team_config=load_team_config(config_path),
            manifest_schema=load_schema(schema_path),
            auth_mode=mode,  # type: ignore[arg-type]
            audiences=parse_audiences(env.get("RELAY_AUDIENCE")),
        )
