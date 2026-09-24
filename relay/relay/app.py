"""FastAPI app (M1-SPEC §3).

``create_app(settings, store)`` builds the app; ``relay.app:app`` builds one from the
environment on first access (so importing this module has no side effects). Bodies are read
and validated by hand, after authentication, so the order of refusals is always
401 → 400 (on-behalf header) → 404 (other team) → 403/422/… and every refusal body is
``{"error", "detail"}``.

Who the caller is (M5-SPEC §3, §4; M6-SPEC §1):
- ``Bearer trc_…``: a device credential; its team and member, while the member is on that
  team's roster (and was added no later than the credential was minted).
  A credential that records the email it was minted through stops working as soon as the
  entry no longer holds that email (M6-SPEC §7.1; the removal also revokes it).
- any other bearer token: the verifier's principal. A delegate's principal (M3-SPEC §2)
  names the member it acts for in ``X-Relay-On-Behalf-Of``; a ``google:`` principal is the
  member of the URL's team whose roster entry holds the email, and when that email is bound
  to a Google ``sub`` (M6-SPEC §7.2) the ID token's ``sub`` must be it (an unbound email is
  bound to it on the first call to its own team); a ``token:sha256:`` principal
  (development) the member the team file names for the URL's team, while on the roster. A
  principal that is a member of another team but not this one gets ``404``; one that is a
  member of no team ``401`` (M6-SPEC §7.4). A delegate's token names the console's service
  account, not the member, so the delegate path has no ``sub`` to check.

A delegate may reach only the GET routes in DELEGATE_ROUTES, and with ``manage-roster`` the
roster mutations in ROSTER_MUTATIONS (the service then requires the member it names to be an
owner, as for anyone).

The login pages (M5-SPEC §2) are unauthenticated and live under ``/v1/login``.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth import Unauthenticated, Verified, Verifier, bearer_token, build_verifier
from .clock import Clock, utc_now
from .config import Delegate, Identity, Settings, normalise_email
from .credentials import looks_like_credential
from .errors import ApiError, ConfigError, not_found
from .jsonutil import BodyError, parse_json
from .log import log_event
from .login import LoginService
from .manifest import ManifestValidator
from .oauth import GoogleOAuthProvider, OAuthProvider
from .pages import stylesheet_response
from .roster import email_hash
from .service import Caller, RelayService
from .store import Store

MAX_BODY_BYTES = 256 * 1024

ON_BEHALF_HEADER = "x-relay-on-behalf-of"
MAX_ON_BEHALF_LENGTH = 320
# M3-SPEC §2: the console's reads, by route template. Nothing that moves presence or
# cursors (stream reads) and nothing that writes.
DELEGATE_ROUTES = frozenset(
    {
        "/v1/teams/{team}/me",
        "/v1/teams/{team}/directory",
        "/v1/teams/{team}/activity",
        "/v1/teams/{team}/requests/{request_id}",
        # M6-SPEC §3: the console's Members panel reads the roster (masked as for the member).
        "/v1/teams/{team}/roster",
        # M7-SPEC §1: what waits for the member's answering session. A peek, not a stream
        # read: it moves no cursor and writes no presence.
        "/v1/teams/{team}/inbox/summary",
    }
)
# M6-SPEC §3: with scope manage-roster, a delegate may also make these, by (method, route).
ROSTER_MUTATIONS = frozenset(
    {
        ("POST", "/v1/teams/{team}/roster"),
        ("PATCH", "/v1/teams/{team}/roster/{member}"),
        ("DELETE", "/v1/teams/{team}/roster/{member}"),
    }
)

_STATUS_CODES = {
    400: "bad_request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    413: "too_large",
    415: "unsupported_media_type",
}


def _error(err: ApiError) -> JSONResponse:
    return JSONResponse(err.body(), status_code=err.status)


async def read_json_body(request: Request) -> Any:
    declared = request.headers.get("content-length")
    # ASCII digits only: str.isdigit() also admits "²", which int() refuses.
    if declared is not None and (
        not (declared.isascii() and declared.isdigit()) or int(declared) > MAX_BODY_BYTES
    ):
        raise ApiError(413, "too_large", f"The body is larger than {MAX_BODY_BYTES} bytes.")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise ApiError(413, "too_large", f"The body is larger than {MAX_BODY_BYTES} bytes.")
        chunks.append(chunk)
    try:
        return parse_json(b"".join(chunks))
    except BodyError as exc:  # lone surrogates, non-finite numbers, too deep (§11.9)
        raise ApiError(400, "invalid_json", str(exc)) from None
    except ValueError:  # UnicodeDecodeError included
        raise ApiError(400, "invalid_json", "The body is not valid JSON.") from None


# Mutations whose refusals are audited (§7). Cursor moves are transport bookkeeping.
def _audited_action(request: Request) -> str | None:
    if request.method == "GET":
        return None
    path = request.url.path
    if path.endswith("/cursor"):
        return None
    if path.endswith("/manifest"):
        return "manifest.publish"
    for suffix in ("ack", "reply", "progress"):
        if path.endswith("/" + suffix):
            return f"request.{suffix}"
    if path.endswith("/events"):
        return "request.event"
    if path.endswith("/requests"):
        return "request.create"
    if "/roster" in path:
        return {"POST": "roster.add", "PATCH": "roster.update"}.get(request.method, "roster.remove")
    if "/credentials/" in path:
        return "credential.revoke"
    return "unknown"


def create_app(
    settings: Settings,
    store: Store,
    *,
    clock: Clock = utc_now,
    poll_interval: float = 1.0,
    verifier: Verifier | None = None,
    oauth: OAuthProvider | None = None,
) -> FastAPI:
    """``oauth`` is the Google sign-in the login pages use; without it one is built from
    ``settings.oauth_client`` with Google's fixed endpoints. Tests pass a fake here, never
    through the environment. Without ``settings.public_url`` the login pages are 404."""
    manifests = ManifestValidator(settings.manifest_schema)
    service = RelayService(settings.team_config, store, manifests, clock, poll_interval)
    verifier = verifier if verifier is not None else build_verifier(settings)
    config = settings.team_config
    roster = service.roster
    login: LoginService | None = None
    if settings.public_url is not None:
        if oauth is None:
            if settings.oauth_client is None:
                raise ConfigError("the login needs an OAuth client (RELAY_OAUTH_CLIENT_FILE)")
            oauth = GoogleOAuthProvider(settings.oauth_client)
        login = LoginService(
            settings,
            store,
            roster,
            service.credentials,
            oauth,
            service.now,
            on_cloud_run=bool(os.environ.get("K_SERVICE")),
        )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        # M6-SPEC §1: upsert the seed at startup. Not fatal here: each team is seeded again,
        # lazily, before its roster is first read.
        try:
            await roster.seed_all()
        except Exception as exc:
            log_event("roster_seed_failed", severity="ERROR", error=type(exc).__name__)
        yield
        await store.aclose()

    app = FastAPI(
        title="team relay",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.service = service
    app.state.store = store

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return _error(exc)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "error")
        if exc.status_code == 404:
            return _error(not_found())
        return JSONResponse({"error": code, "detail": code.replace("_", " ")}, exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse({"error": "invalid_body", "detail": "Invalid request."}, 422)

    @app.exception_handler(Exception)
    async def _internal(request: Request, exc: Exception) -> JSONResponse:
        log_event(
            "internal_error",
            severity="ERROR",
            error=type(exc).__name__,
            method=request.method,
            path=request.url.path,
        )
        return JSONResponse({"error": "internal", "detail": "Internal error."}, 500)

    class NotAMember(Unauthenticated):
        """A delegate named a well-formed email that is on no roster of its team."""

    async def on_behalf_of(request: Request, delegate: Delegate) -> Identity:
        """The member a delegate acts for (M3-SPEC §2): exactly one header naming, by email,
        a member of the delegate's team on its roster, else 401. The value is never logged."""
        values = request.headers.getlist(ON_BEHALF_HEADER)
        if not values:
            raise Unauthenticated("missing_on_behalf")
        if len(values) != 1:
            raise Unauthenticated("repeated_on_behalf")
        if len(values[0]) > MAX_ON_BEHALF_LENGTH:
            raise Unauthenticated("unknown_on_behalf")
        email = normalise_email(values[0])
        if not email:
            raise Unauthenticated("unknown_on_behalf")
        member = await roster.member_for_email(delegate.team, email)
        if member is None:
            # A well-formed email that is simply not on this team's roster (M6-SPEC §4): the
            # console shows "not on this team" instead of treating it as a broken setup.
            raise NotAMember("not_a_member")
        return Identity(team=delegate.team, member=member)

    retention = timedelta(days=config.audit_retention_days)

    async def member_in(verified: Verified, team: str) -> tuple[str | None, bool]:
        """The principal's member in ``team`` and whether its email still needs binding;
        ``(None, True)`` when the email is bound to another Google account."""
        principal = verified.principal
        if principal.startswith("google:"):
            email = principal.removeprefix("google:")
            snapshot = await roster.snapshot(team)
            member = snapshot.member_for_email(email)
            if member is None or verified.sub is None:
                return member, False
            bound = snapshot.sub_for(member, email)
            if bound is None:
                return member, True
            return (member, False) if bound == verified.sub else (None, True)
        member = config.token_member(principal, team)
        if member is None or member not in (await roster.snapshot(team)).entries:
            return None, False
        return member, False

    async def resolve(verified: Verified, team: str) -> Identity:
        """The principal's membership in ``team``, else in the first other team that has
        one (for the 404), else 401 (M5-SPEC §4, M6-SPEC §7.4). A Google account whose
        email is bound to another ``sub`` is not that member (M6-SPEC §7.2)."""
        order = [team] if team in config.teams else []
        order += [t for t in config.team_ids() if t != team]
        rebound = False
        for candidate in order:
            member, flag = await member_in(verified, candidate)
            if member is None:
                rebound = rebound or flag
                continue
            if flag and candidate == team:
                # The email's first use by a Google ID token on its own team binds it.
                assert verified.sub is not None
                email = verified.principal.removeprefix("google:")
                outcome = await roster.bind(team, member, email, verified.sub, retention)
                if outcome == "other":
                    raise Unauthenticated("sub_mismatch")
                if outcome == "gone":
                    raise Unauthenticated("not_on_roster")
            return Identity(team=candidate, member=member)
        raise Unauthenticated("sub_mismatch" if rebound else "unknown_principal")

    async def from_credential(token: str) -> tuple[Identity, str]:
        record = await service.credentials.authenticate(token)
        if record is None:
            raise Unauthenticated("bad_credential")
        entry = (await roster.snapshot(record.team)).entries.get(record.member)
        # Removed (M5-SPEC §3), or removed and added again since this credential was minted.
        if entry is None or record.created_at < entry.added_at:
            raise Unauthenticated("not_on_roster")
        # Minted through an email the entry no longer holds (M6-SPEC §7.1): the removal
        # revoked it; this holds on an instance whose credential cache has not seen that yet.
        if record.email_sha256 is not None and record.email_sha256 not in {
            email_hash(e) for e in entry.emails
        }:
            raise Unauthenticated("email_removed")
        return Identity(team=record.team, member=record.member), record.key

    async def authenticate(request: Request, team: str) -> Caller:
        token = bearer_token(request.headers.get("authorization"))
        delegate: Delegate | None = None
        credential: str | None = None
        try:
            if token is None:
                raise Unauthenticated("missing_bearer")
            if looks_like_credential(token):
                identity, credential = await from_credential(token)
            else:
                verified = await verifier.verify(token)
                # A delegate is never a member (M3-SPEC §2): checked first.
                delegate = config.delegate(verified.principal)
                if delegate is not None:
                    identity = await on_behalf_of(request, delegate)
                else:
                    identity = await resolve(verified, team)
        except Unauthenticated as exc:
            # Structured, and never the token (§2) or the on-behalf value.
            log_event(
                "auth_rejected",
                severity="WARNING",
                reason=exc.reason,
                method=request.method,
                path=request.url.path,
                **({"delegate": delegate.principal} if delegate is not None else {}),
            )
            if isinstance(exc, NotAMember):
                raise ApiError(
                    403, "not_a_member", "This Google account is not a member of this team."
                ) from None
            raise ApiError(401, "unauthenticated") from None

        if delegate is None:
            if ON_BEHALF_HEADER in request.headers:
                # Only meaningful for a delegate (M3-SPEC §2). Refused, never ignored: a
                # member's client that sends it is confused about who it is.
                log_event(
                    "on_behalf_refused",
                    severity="WARNING",
                    team=identity.team,
                    member=identity.member,
                    method=request.method,
                    path=request.url.path,
                )
                raise ApiError(
                    400, "bad_request", "X-Relay-On-Behalf-Of is only accepted from a delegate."
                )
            caller = Caller(team=identity.team, member=identity.member, credential=credential)
            if team != identity.team:
                err = not_found()
                action = _audited_action(request)
                if action is not None:
                    await service.audit_refusal(caller, action, err)
                raise err
            return caller

        caller = Caller(team=identity.team, member=identity.member, delegate=delegate.principal)
        route_path = getattr(request.scope.get("route"), "path", None)
        reads = request.method == "GET" and route_path in DELEGATE_ROUTES
        manages = delegate.manages_roster and (request.method, route_path) in ROSTER_MUTATIONS
        if team != identity.team or not (reads or manages):
            # A delegate's refusals go to stdout, never to the audit log: the member it names
            # did not attempt them (M3-SPEC §2).
            err = (
                not_found()
                if team != identity.team
                else ApiError(403, "forbidden", "A delegate may only read.")
            )
            log_event(
                "delegate_refused",
                severity="WARNING",
                delegate=delegate.principal,
                team=identity.team,
                member=identity.member,
                method=request.method,
                path=request.url.path,
                status=err.status,
            )
            raise err
        log_event(
            "delegated_read" if reads else "delegated_change",
            delegate=delegate.principal,
            team=identity.team,
            member=identity.member,
            method=request.method,
            path=request.url.path,
        )
        return caller

    CallerDep = Depends(authenticate)

    @app.get("/healthz")
    async def healthz() -> dict[str, bool]:
        return {"ok": True}

    # M2-SPEC §1: Cloud Run's front end reserves some paths ending in "z", so the same
    # health check is also served here. No credentials at the app (Cloud Run IAM still
    # applies in front of it).
    @app.get("/v1/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/v1/teams/{team}/me")
    async def me(caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.me(caller)

    # M6-SPEC §2: the roster ---------------------------------------------------------------
    @app.get("/v1/teams/{team}/roster")
    async def roster_list(caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.roster_list(caller)

    @app.post("/v1/teams/{team}/roster")
    async def roster_add(request: Request, caller: Caller = CallerDep) -> JSONResponse:
        raw = await _read_guarded(service, caller, "roster.add", lambda: read_json_body(request))
        return JSONResponse(await service.roster_add(caller, raw), status_code=201)

    @app.patch("/v1/teams/{team}/roster/{member}")
    async def roster_update(member: str, request: Request, caller: Caller = CallerDep) -> Any:
        raw = await _read_guarded(service, caller, "roster.update", lambda: read_json_body(request))
        return await service.roster_update(caller, member, raw)

    @app.delete("/v1/teams/{team}/roster/{member}")
    async def roster_remove(member: str, caller: Caller = CallerDep) -> Any:
        return await service.roster_remove(caller, member)

    # M5-SPEC §3: device credentials -------------------------------------------------------
    @app.get("/v1/teams/{team}/credentials")
    async def credentials_list(caller: Caller = CallerDep) -> Any:
        return await service.credentials_list(caller)

    @app.delete("/v1/teams/{team}/credentials/{credential_id}")
    async def credential_revoke(credential_id: str, caller: Caller = CallerDep) -> Any:
        return await service.credential_revoke(caller, credential_id)

    # M5-SPEC §2: the login pages (no authentication) ------------------------------------
    def login_service() -> LoginService:
        if login is None:
            raise not_found()
        return login

    @app.get("/v1/login/style.css")
    async def login_stylesheet() -> Response:
        login_service()
        return stylesheet_response()

    @app.get("/v1/login/start")
    async def login_start(request: Request) -> Response:
        return await login_service().start(request)

    @app.get("/v1/login/callback")
    async def login_callback(request: Request) -> Response:
        return await login_service().callback(request)

    @app.post("/v1/login/choose")
    async def login_choose(request: Request) -> Response:
        return await login_service().choose(request)

    @app.post("/v1/login/token")
    async def login_token(request: Request) -> Response:
        service_ = login_service()
        try:
            raw = await read_json_body(request)
        except ApiError:
            raw = None  # the service answers 400 invalid_request for anything unreadable
        return await service_.token(request, raw)

    @app.put("/v1/teams/{team}/members/{member}/manifest")
    async def put_manifest(member: str, request: Request, caller: Caller = CallerDep) -> Any:
        if member != caller.member:
            # Before reading the body: the 403 does not depend on it.
            return await service.publish_manifest(caller, member, None)
        raw = await _read_guarded(
            service, caller, "manifest.publish", lambda: read_json_body(request)
        )
        return await service.publish_manifest(caller, member, raw)

    @app.get("/v1/teams/{team}/directory")
    async def directory(caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.directory(caller)

    @app.get("/v1/teams/{team}/activity")
    async def activity(request: Request, caller: Caller = CallerDep) -> dict[str, Any]:
        q = request.query_params
        return await service.activity(caller, q.get("since"), q.get("limit"))

    @app.get("/v1/teams/{team}/inbox/summary")
    async def inbox_summary(caller: Caller = CallerDep) -> dict[str, Any]:
        return await service.inbox_summary(caller)

    @app.post("/v1/teams/{team}/requests")
    async def create_request(request: Request, caller: Caller = CallerDep) -> JSONResponse:
        raw = await _read_guarded(
            service, caller, "request.create", lambda: read_json_body(request)
        )
        status, payload = await service.create_request(caller, raw)
        return JSONResponse(payload, status_code=status)

    @app.get("/v1/teams/{team}/streams/{stream}")
    async def read_stream(stream: str, request: Request, caller: Caller = CallerDep) -> Any:
        q = request.query_params
        return await service.read_stream(
            caller,
            stream,
            q.get("after"),
            q.get("wait"),
            q.get("limit"),
            request.is_disconnected,
        )

    @app.post("/v1/teams/{team}/streams/{stream}/cursor")
    async def set_cursor(stream: str, request: Request, caller: Caller = CallerDep) -> Any:
        raw = await read_json_body(request)
        return await service.set_cursor(caller, stream, raw)

    @app.post("/v1/teams/{team}/requests/{request_id}/ack")
    async def ack(request_id: str, caller: Caller = CallerDep) -> Any:
        return await service.ack(caller, request_id)

    @app.post("/v1/teams/{team}/requests/{request_id}/reply")
    async def reply(request_id: str, request: Request, caller: Caller = CallerDep) -> Any:
        raw = await _read_guarded(
            service, caller, "request.reply", lambda: read_json_body(request), request_id
        )
        return await service.reply(caller, request_id, raw)

    @app.post("/v1/teams/{team}/requests/{request_id}/progress")
    async def progress(request_id: str, request: Request, caller: Caller = CallerDep) -> Any:
        raw = await _read_guarded(
            service, caller, "request.progress", lambda: read_json_body(request), request_id
        )
        payload = await service.progress(caller, request_id, raw)
        return JSONResponse(payload, status_code=201)

    @app.post("/v1/teams/{team}/requests/{request_id}/events")
    async def tool_event(request_id: str, request: Request, caller: Caller = CallerDep) -> Any:
        raw = await _read_guarded(
            service, caller, "request.event", lambda: read_json_body(request), request_id
        )
        payload = await service.tool_event(caller, request_id, raw)
        return JSONResponse(payload, status_code=201)

    @app.get("/v1/teams/{team}/requests/{request_id}")
    async def get_request(request_id: str, caller: Caller = CallerDep) -> Any:
        return await service.get_request(caller, request_id)

    return app


async def _read_guarded(
    service: RelayService,
    caller: Caller,
    action: str,
    read: Callable[[], Awaitable[Any]],
    request_id: str | None = None,
) -> Any:
    """Read a mutation's body; a refused body (413, bad JSON) is audited like any refusal."""
    try:
        return await read()
    except ApiError as err:
        await service.audit_refusal(caller, action, err, request_id)
        raise


def create_app_from_env() -> FastAPI:
    settings = Settings.from_env()
    from .store_firestore import FirestoreStore

    store = FirestoreStore(
        project=os.environ.get("GOOGLE_CLOUD_PROJECT") or None,
        database=os.environ.get("RELAY_FIRESTORE_DATABASE") or None,
    )
    log_event(
        "relay_start",
        auth_mode=settings.auth_mode,
        teams=sorted(settings.team_config.teams),
        login=settings.login_enabled,
    )
    return create_app(settings, store)


_app: FastAPI | None = None


def __getattr__(name: str) -> Any:
    # `uvicorn relay.app:app` resolves `app` with getattr; build it then, from env, once.
    global _app
    if name == "app":
        if _app is None:
            _app = create_app_from_env()
        return _app
    raise AttributeError(name)
