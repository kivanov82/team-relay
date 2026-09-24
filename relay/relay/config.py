"""Team configuration and process settings from env.

The team file (M1-SPEC §2, M6-SPEC §1) holds the list of teams, each team's **seed**
members (their ids, roles and principals), ``limits``, ``audit_retention_days``, the
``delegates`` (M3-SPEC §2, M6-SPEC §3, M9-SPEC §5) and the relay-wide ``admins`` (M9-SPEC §4).
Teams created through the API (M9-SPEC §1) live in the store only; the file's teams are the
**seed teams**, which the API never deletes. Membership itself lives in the roster in
the store (:mod:`relay.roster`): the relay upserts the seed into it and from then on a
principal is a member of a team only while the team's roster says so.

Seed reading (M6-SPEC §1, decided for this relay): every file member is created in the
roster when the roster has no entry with its id, with its role (``owner`` when marked,
``member`` otherwise) and the emails of its ``google:`` principals. An existing entry is
never changed by the seed (never demoted, never re-promoted, emails never merged), and
nobody is ever removed by it. Every team needs at least one ``role: owner`` in the file.
``token:sha256:`` principals (static development tokens) never enter the roster; they stay
in the process and resolve to a member only while that member is on the roster.
"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .errors import ConfigError

TEAM_RE = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
# M9-SPEC §1: a team created through the API. Every such id also matches TEAM_RE.
CREATED_TEAM_RE = re.compile(r"^[a-z][a-z0-9-]{2,31}$")
MEMBER_RE = re.compile(r"^[a-z][a-z0-9_]{1,31}$")
EMAIL_RE = re.compile(r"^[^@\s:,;<>\"'`\\]+@[^@\s:,;<>\"'`\\]+\.[^@\s:,;<>\"'`\\]+$")
GOOGLE_PRINCIPAL_RE = re.compile(r"^google:([^@\s:]+@[^@\s]+\.[^@\s]+)$")
TOKEN_PRINCIPAL_RE = re.compile(r"^token:sha256:[0-9a-f]{64}$")

# A broadcast writes one envelope and one stream head per recipient in one transaction,
# plus the request, the idempotency record and the audit entries; Firestore caps a
# transaction at 500 writes. M6-SPEC §1 keeps a team at 50 members.
MAX_MEMBERS_PER_TEAM = 50
# M6-SPEC §1: a roster entry holds 1..5 Google emails.
MAX_EMAILS_PER_MEMBER = 5
# RFC 5321 caps a mailbox at 254 characters.
MAX_EMAIL_LENGTH = 254
# M3-SPEC §2: one console service per deployment; a handful leaves room, not a registry.
MAX_DELEGATES = 10
# M9-SPEC §4: relay admins, a handful.
MAX_ADMINS = 20
# M9-SPEC §1: a team's display name.
MAX_TEAM_NAME_LENGTH = 60
# Unicode categories a display name may not hold: controls, format characters (the bidi
# overrides among them), surrogates, private use, unassigned, and line/paragraph separators.
_NAME_FORBIDDEN = frozenset({"Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"})

AuthMode = Literal["google", "static"]
Role = Literal["owner", "member"]
DelegateScope = Literal["read", "manage-roster", "manage-teams"]
SCOPE_READ = "read"
SCOPE_MANAGE_ROSTER = "manage-roster"
# M9-SPEC §2, §4: create a team on behalf of an email, and the admin endpoints on behalf of
# an admin. Only for a delegate of every team (``team: "*"``).
SCOPE_MANAGE_TEAMS = "manage-teams"
# M9-SPEC §5: a delegate for any team the on-behalf-of email belongs to.
ANY_TEAM = "*"

# RFC 5321 caps a mailbox at 254 characters; with "google:" in front, well under this.
MAX_ON_BEHALF_LENGTH = 320

LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost"})


def normalise_email(raw: Any) -> str | None:
    """``raw`` lower-cased when it is one plain email address of at most 254 characters,
    else None. Nothing is stripped: surrounding whitespace makes it not an email."""
    if not isinstance(raw, str) or not raw or len(raw) > MAX_EMAIL_LENGTH:
        return None
    if not raw.isascii() or EMAIL_RE.fullmatch(raw) is None:
        return None
    return raw.lower()


def fold_team_name(name: str) -> str:
    """What two team names are compared by (M9-SPEC §7.2): case folded, whitespace runs
    folded to one space, surrounding whitespace dropped."""
    return " ".join(name.split()).casefold()


def normalise_team_name(raw: Any) -> str | None:
    """A team's display name (M9-SPEC §1): surrounding whitespace dropped, then 1 to 60
    characters, none of them a control, format, private-use, unassigned or separator
    character; else None. Shown escaped everywhere."""
    if not isinstance(raw, str):
        return None
    name = raw.strip()
    if not 1 <= len(name) <= MAX_TEAM_NAME_LENGTH:
        return None
    if any(unicodedata.category(ch) in _NAME_FORBIDDEN for ch in name):
        return None
    return name


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _MemberFile(_Strict):
    id: str
    role: Role = "member"
    principals: list[str] = Field(min_length=1)


class _TeamFile(_Strict):
    id: str
    # M9-SPEC §1: the display name; the id when absent.
    name: str | None = None
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
    # M5-SPEC §2: per client IP and minute, counted in the store. `start` is 20 in the spec;
    # the token exchange and the two browser pages (callback, choose) get their own budgets.
    login_starts_per_minute: int = Field(default=20, ge=1, le=10000)
    login_pages_per_minute: int = Field(default=30, ge=1, le=10000)
    login_tokens_per_minute: int = Field(default=20, ge=1, le=10000)
    # M6-SPEC §2: roster mutations per owner and hour.
    roster_mutations_per_hour: int = Field(default=30, ge=1, le=10000)
    # M9-SPEC §2: teams one Google account has created and not deleted; members per team (at
    # most 50: a broadcast writes one envelope per member in one transaction); team
    # creations per account and calendar day (UTC), and per client IP and calendar hour.
    teams_per_account: int = Field(default=3, ge=1, le=100)
    members_per_team: int = Field(default=MAX_MEMBERS_PER_TEAM, ge=1, le=MAX_MEMBERS_PER_TEAM)
    team_creations_per_account_per_day: int = Field(default=10, ge=1, le=1000)
    team_creations_per_ip_per_hour: int = Field(default=30, ge=1, le=10000)
    # M9-SPEC §7.4: every attempt to create a team (refused ones included) per account (its
    # email and its Google sub) and hour.
    team_create_attempts_per_account_per_hour: int = Field(default=30, ge=1, le=10000)
    # M9-SPEC §7.6: team creations per delegate (the console) and hour.
    team_creations_per_delegate_per_hour: int = Field(default=60, ge=1, le=10000)
    # M9-SPEC §7.8: admin deletions through a delegate, per delegate and hour.
    admin_deletes_per_delegate_per_hour: int = Field(default=5, ge=1, le=1000)
    # M9-SPEC §7.9: requests per principal and minute that are not (yet) known to come from
    # a member of the team they name, counted before the membership check.
    non_member_requests_per_minute: int = Field(default=60, ge=1, le=10000)


class _DelegateFile(_Strict):
    principal: str
    # A team of the file, or "*" (M9-SPEC §5): any team the on-behalf-of email belongs to.
    team: str
    # M3-SPEC §2: `read`; M6-SPEC §3: `[read, manage-roster]`; M9-SPEC: `manage-teams` for a
    # `team: "*"` delegate. A bare `read` is kept for the M3 files; a list must hold `read`.
    scope: Literal["read"] | list[DelegateScope]


class _ConfigFile(_Strict):
    teams: list[_TeamFile] = Field(min_length=1)
    delegates: list[_DelegateFile] = Field(default_factory=list, max_length=MAX_DELEGATES)
    # M9-SPEC §4: relay-wide admins, `google:<email>`.
    admins: list[str] = Field(default_factory=list, max_length=MAX_ADMINS)
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
    login_starts_per_minute: int = 20
    login_pages_per_minute: int = 30
    login_tokens_per_minute: int = 20
    roster_mutations_per_hour: int = 30
    teams_per_account: int = 3
    members_per_team: int = MAX_MEMBERS_PER_TEAM
    team_creations_per_account_per_day: int = 10
    team_creations_per_ip_per_hour: int = 30
    team_create_attempts_per_account_per_hour: int = 30
    team_creations_per_delegate_per_hour: int = 60
    admin_deletes_per_delegate_per_hour: int = 5
    non_member_requests_per_minute: int = 60


@dataclass(frozen=True)
class SeedMember:
    """One member as the team file lists it: upserted into the roster when absent."""

    id: str
    role: str
    emails: tuple[str, ...]
    # Static development tokens (``token:sha256:<hex>``), never in the roster.
    tokens: tuple[str, ...] = ()


@dataclass(frozen=True)
class Team:
    id: str
    seeds: tuple[SeedMember, ...]
    name: str = ""

    @property
    def display_name(self) -> str:
        return self.name or self.id

    @property
    def seed_ids(self) -> frozenset[str]:
        return frozenset(seed.id for seed in self.seeds)


@dataclass(frozen=True)
class Identity:
    team: str
    member: str


@dataclass(frozen=True)
class Delegate:
    """A service that reads a team's console views on behalf of one member at a time
    (M3-SPEC §2), and with ``manage-roster`` changes the roster for an owner (M6-SPEC §3).
    It is never a member and never the caller: the member it names is. With ``team: "*"``
    it acts in whichever team the request names, for a member of that team (M9-SPEC §5), and
    with ``manage-teams`` it creates teams and calls the admin endpoints for the email it
    names (M9-SPEC §2, §4)."""

    principal: str
    team: str
    scopes: frozenset[str] = frozenset({SCOPE_READ})

    @property
    def manages_roster(self) -> bool:
        return SCOPE_MANAGE_ROSTER in self.scopes

    @property
    def manages_teams(self) -> bool:
        return SCOPE_MANAGE_TEAMS in self.scopes

    @property
    def any_team(self) -> bool:
        return self.team == ANY_TEAM


@dataclass(frozen=True)
class TeamConfig:
    teams: Mapping[str, Team]
    # token:sha256 principal -> {team: member}. A principal may be in several teams, once
    # per team (M5-SPEC §4).
    token_principals: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    limits: Limits = field(default_factory=Limits)
    audit_retention_days: int = 90
    delegates: Mapping[str, Delegate] = field(default_factory=dict)
    # M9-SPEC §4: the admins' lower-cased emails.
    admins: frozenset[str] = frozenset()

    def team_ids(self) -> tuple[str, ...]:
        return tuple(self.teams)

    def is_file_team_name(self, name: str) -> bool:
        """Whether ``name`` equals a file team's display name (its id when it has none),
        compared by :func:`fold_team_name` (M9-SPEC §7.2)."""
        folded = fold_team_name(name)
        return any(fold_team_name(t.display_name) == folded for t in self.teams.values())

    def is_admin(self, email: str) -> bool:
        return email in self.admins

    def token_member(self, principal: str, team: str) -> str | None:
        return (self.token_principals.get(principal) or {}).get(team)

    def delegate(self, principal: str) -> Delegate | None:
        return self.delegates.get(principal)

    def is_delegate_email(self, email: str) -> bool:
        return ("google:" + email) in self.delegates


def _normalise_principal(raw: str) -> str:
    match = GOOGLE_PRINCIPAL_RE.match(raw)
    if match:
        email = normalise_email(match.group(1))
        if email is None:
            raise ConfigError("principal must be 'google:<email>' with a plain email address")
        return "google:" + email
    if TOKEN_PRINCIPAL_RE.match(raw):
        return raw
    raise ConfigError("principal must be 'google:<email>' or 'token:sha256:<64 lowercase hex>'")


def _delegate_scopes(index: int, raw: str | list[str], team: str) -> frozenset[str]:
    values = [raw] if isinstance(raw, str) else list(raw)
    if len(set(values)) != len(values):
        raise ConfigError(f"delegates.{index}.scope: a scope is listed twice")
    if SCOPE_READ not in values:
        raise ConfigError(f"delegates.{index}.scope: must include 'read'")
    if SCOPE_MANAGE_TEAMS in values and team != ANY_TEAM:
        raise ConfigError(f"delegates.{index}.scope: 'manage-teams' needs team: \"*\"")
    return frozenset(values)


def parse_team_config(data: Any) -> TeamConfig:
    try:
        parsed = _ConfigFile.model_validate(data)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first["loc"])
        raise ConfigError(f"team config invalid at {where}: {first['msg']}") from None

    teams: dict[str, Team] = {}
    tokens: dict[str, dict[str, str]] = {}
    member_emails: set[str] = set()
    for team in parsed.teams:
        if not TEAM_RE.match(team.id):
            raise ConfigError(f"team id {team.id!r} does not match {TEAM_RE.pattern}")
        if team.id in teams:
            raise ConfigError(f"duplicate team {team.id!r}")
        seeds: list[SeedMember] = []
        seen_members: set[str] = set()
        seen_principals: set[str] = set()
        for member in team.members:
            if not MEMBER_RE.match(member.id):
                raise ConfigError(f"member id {member.id!r} does not match {MEMBER_RE.pattern}")
            # Member ids are unique within a team (M5-SPEC §4), no longer across teams.
            if member.id in seen_members:
                raise ConfigError(f"duplicate member {member.id!r} in team {team.id!r}")
            seen_members.add(member.id)
            emails: list[str] = []
            member_tokens: list[str] = []
            for raw in member.principals:
                principal = _normalise_principal(raw)
                if principal in seen_principals:
                    # Not echoing the principal: it may be a token hash or an email.
                    raise ConfigError(f"a principal of member {member.id!r} is listed twice")
                seen_principals.add(principal)
                if principal.startswith("google:"):
                    emails.append(principal.removeprefix("google:"))
                else:
                    member_tokens.append(principal)
                    tokens.setdefault(principal, {})[team.id] = member.id
            if len(emails) > MAX_EMAILS_PER_MEMBER:
                raise ConfigError(
                    f"member {member.id!r} has more than {MAX_EMAILS_PER_MEMBER} google principals"
                )
            member_emails.update(emails)
            seeds.append(
                SeedMember(
                    id=member.id,
                    role=member.role,
                    emails=tuple(emails),
                    tokens=tuple(member_tokens),
                )
            )
        if not any(seed.role == "owner" for seed in seeds):
            raise ConfigError(f"team {team.id!r} has no member with role: owner")
        name = ""
        if team.name is not None:
            name = normalise_team_name(team.name) or ""
            if not name:
                raise ConfigError(
                    f"team {team.id!r}: name must be 1 to {MAX_TEAM_NAME_LENGTH} characters, "
                    "no control characters"
                )
        teams[team.id] = Team(id=team.id, seeds=tuple(seeds), name=name)

    delegates: dict[str, Delegate] = {}
    for index, entry in enumerate(parsed.delegates):
        match = GOOGLE_PRINCIPAL_RE.match(entry.principal)
        email = normalise_email(match.group(1)) if match else None
        if email is None:
            raise ConfigError(f"delegates.{index}: principal must be 'google:<email>'")
        principal = "google:" + email
        if entry.team != ANY_TEAM and entry.team not in teams:
            raise ConfigError(f"delegates.{index}: team {entry.team!r} is not a team")
        # Not echoing the principal, as for members.
        if email in member_emails:
            raise ConfigError(f"delegates.{index}: a delegate principal is also a member's")
        if principal in delegates:
            raise ConfigError(f"delegates.{index}: the delegate principal is listed twice")
        delegates[principal] = Delegate(
            principal=principal,
            team=entry.team,
            scopes=_delegate_scopes(index, entry.scope, entry.team),
        )

    admins: set[str] = set()
    for index, raw in enumerate(parsed.admins):
        match = GOOGLE_PRINCIPAL_RE.match(raw)
        email = normalise_email(match.group(1)) if match else None
        if email is None:
            raise ConfigError(f"admins.{index}: must be 'google:<email>'")
        # Not echoing the email.
        if email in admins:
            raise ConfigError(f"admins.{index}: an admin is listed twice")
        if ("google:" + email) in delegates:
            raise ConfigError(f"admins.{index}: a delegate principal cannot be an admin")
        admins.add(email)

    return TeamConfig(
        teams=teams,
        token_principals={p: dict(m) for p, m in tokens.items()},
        limits=Limits(**parsed.limits.model_dump()),
        audit_retention_days=parsed.audit_retention_days,
        delegates=delegates,
        admins=frozenset(admins),
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


def parse_public_url(raw: str, env: Mapping[str, str]) -> str:
    """``RELAY_PUBLIC_URL`` (M5-SPEC §2): the relay's own origin, from which the login pages
    and Google's redirect URI are built. ``https`` always, except ``http`` on 127.0.0.1 or
    localhost when not on Cloud Run. No path, query, fragment or user info. Returned
    without a trailing slash."""
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        raise ConfigError("RELAY_PUBLIC_URL is not a URL") from None
    host = parts.hostname or ""
    if parts.scheme == "http":
        if host not in LOCAL_HOSTS or env.get("K_SERVICE"):
            raise ConfigError("RELAY_PUBLIC_URL must be https (http only on 127.0.0.1 locally)")
    elif parts.scheme != "https":
        raise ConfigError("RELAY_PUBLIC_URL must be https")
    if not host or parts.username is not None or parts.password is not None:
        raise ConfigError("RELAY_PUBLIC_URL must name a host and no user info")
    if parts.path not in ("", "/") or parts.query or parts.fragment or "#" in raw or "?" in raw:
        raise ConfigError("RELAY_PUBLIC_URL must be an origin: no path, query or fragment")
    netloc = host if port is None else f"{host}:{port}"
    if ":" in host:
        raise ConfigError("RELAY_PUBLIC_URL must use a host name or an IPv4 address")
    return f"{parts.scheme}://{netloc}"


@dataclass(frozen=True)
class OAuthClient:
    """The relay's own Google OAuth client (M5-SPEC §5). The secret is never logged."""

    client_id: str
    client_secret: str = field(repr=False)


_CLIENT_FIELD = re.compile(r"^[\x21-\x7e]{1,512}$")


def load_oauth_client(path: str | os.PathLike[str]) -> OAuthClient:
    """The mounted secret ``RELAY_OAUTH_CLIENT_FILE``: a JSON object with string fields
    ``client_id`` and ``client_secret`` (other keys are ignored). Error messages never
    quote the file."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"cannot read the OAuth client file: {exc.strerror}") from None
    except UnicodeDecodeError:
        raise ConfigError("the OAuth client file is not UTF-8") from None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        raise ConfigError("the OAuth client file is not valid JSON") from None
    if not isinstance(data, dict):
        raise ConfigError("the OAuth client file must be a JSON object")
    client_id, secret = data.get("client_id"), data.get("client_secret")
    for name, value in (("client_id", client_id), ("client_secret", secret)):
        if not isinstance(value, str) or _CLIENT_FIELD.fullmatch(value) is None:
            raise ConfigError(f"the OAuth client file needs a string {name} (printable, no spaces)")
    return OAuthClient(client_id=client_id, client_secret=secret)  # type: ignore[arg-type]


@dataclass(frozen=True)
class Settings:
    team_config: TeamConfig
    manifest_schema: dict[str, Any]
    auth_mode: AuthMode = "google"
    # Every audience a Google ID token may carry (M2-SPEC §2): gcloud's OAuth client id and
    # the service URL on Cloud Run.
    audiences: tuple[str, ...] = ()
    # M5-SPEC §2, §5: the relay's public origin and its own OAuth client. Both or neither;
    # without them the login pages answer 404 (required on Cloud Run).
    public_url: str | None = None
    oauth_client: OAuthClient | None = None

    def __post_init__(self) -> None:
        if self.auth_mode not in ("google", "static"):
            raise ConfigError("RELAY_AUTH_MODE must be 'google' or 'static'")
        if not isinstance(self.audiences, tuple) or not all(
            isinstance(a, str) and a and a == a.strip() for a in self.audiences
        ):
            raise ConfigError("audiences must be a tuple of non-empty strings")
        if self.auth_mode == "google" and not self.audiences:
            raise ConfigError("RELAY_AUDIENCE is required when RELAY_AUTH_MODE=google")

    @property
    def login_enabled(self) -> bool:
        return self.public_url is not None

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
        public_raw = env.get("RELAY_PUBLIC_URL") or None
        client_path = env.get("RELAY_OAUTH_CLIENT_FILE") or None
        if (public_raw is None) != (client_path is None):
            raise ConfigError("RELAY_PUBLIC_URL and RELAY_OAUTH_CLIENT_FILE go together")
        if public_raw is None and env.get("K_SERVICE"):
            raise ConfigError(
                "RELAY_PUBLIC_URL and RELAY_OAUTH_CLIENT_FILE are required on Cloud Run"
            )
        return cls(
            team_config=load_team_config(config_path),
            manifest_schema=load_schema(schema_path),
            auth_mode=mode,  # type: ignore[arg-type]
            audiences=parse_audiences(env.get("RELAY_AUDIENCE")),
            public_url=parse_public_url(public_raw, env) if public_raw else None,
            oauth_client=load_oauth_client(client_path) if client_path else None,
        )
