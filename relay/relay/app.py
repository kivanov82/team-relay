"""FastAPI app (M1-SPEC §3).

``create_app(settings, store)`` builds the app; ``relay.app:app`` builds one from the
environment on first access (so importing this module has no side effects). Bodies are read
and validated by hand, after authentication, so the order of refusals is always
401 → 400 (on-behalf header) → 404 (other team) → 403/422/… and every refusal body is
``{"error", "detail"}``.

A read-only delegate (M3-SPEC §2) authenticates as itself and names the member it reads
for in ``X-Relay-On-Behalf-Of``; from then on that member is the caller. It may reach only
the routes in DELEGATE_ROUTES, with GET.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth import Unauthenticated, Verifier, bearer_token, build_verifier
from .clock import Clock, utc_now
from .config import Delegate, Identity, Settings
from .errors import ApiError, not_found
from .jsonutil import BodyError, parse_json
from .log import log_event
from .manifest import ManifestValidator
from .service import Caller, RelayService
from .store import Store

MAX_BODY_BYTES = 256 * 1024

ON_BEHALF_HEADER = "x-relay-on-behalf-of"
# M3-SPEC §2: the console's four reads, by route template. Nothing that moves presence or
# cursors (stream reads) and nothing that writes.
DELEGATE_ROUTES = frozenset(
    {
        "/v1/teams/{team}/me",
        "/v1/teams/{team}/directory",
        "/v1/teams/{team}/activity",
        "/v1/teams/{team}/requests/{request_id}",
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
    return "unknown"


def create_app(
    settings: Settings,
    store: Store,
    *,
    clock: Clock = utc_now,
    poll_interval: float = 1.0,
    verifier: Verifier | None = None,
) -> FastAPI:
    manifests = ManifestValidator(settings.manifest_schema)
    service = RelayService(settings.team_config, store, manifests, clock, poll_interval)
    verifier = verifier if verifier is not None else build_verifier(settings)
    config = settings.team_config

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
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

    def on_behalf_of(request: Request, delegate: Delegate) -> Identity:
        """The member a delegate reads for (M3-SPEC §2): exactly one header naming a member
        of the delegate's team by email, else 401. The value is never logged."""
        values = request.headers.getlist(ON_BEHALF_HEADER)
        if not values:
            raise Unauthenticated("missing_on_behalf")
        if len(values) != 1:
            raise Unauthenticated("repeated_on_behalf")
        identity = config.resolve_on_behalf(delegate, values[0])
        if identity is None:
            raise Unauthenticated("unknown_on_behalf")
        return identity

    async def authenticate(request: Request, team: str) -> Caller:
        token = bearer_token(request.headers.get("authorization"))
        delegate: Delegate | None = None
        try:
            if token is None:
                raise Unauthenticated("missing_bearer")
            principal = await verifier.principal(token)
            identity = config.resolve(principal)
            if identity is None:
                delegate = config.delegate(principal)
                if delegate is None:
                    raise Unauthenticated("unknown_principal")
                identity = on_behalf_of(request, delegate)
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
            caller = Caller(team=identity.team, member=identity.member)
            if team != identity.team:
                err = not_found()
                action = _audited_action(request)
                if action is not None:
                    await service.audit_refusal(caller, action, err)
                raise err
            return caller

        caller = Caller(team=identity.team, member=identity.member, delegate=delegate.principal)
        route = request.scope.get("route")
        allowed = request.method == "GET" and getattr(route, "path", None) in DELEGATE_ROUTES
        if team != identity.team or not allowed:
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
            "delegated_read",
            delegate=delegate.principal,
            team=identity.team,
            member=identity.member,
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
        return service.me(caller)

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
    log_event("relay_start", auth_mode=settings.auth_mode, teams=sorted(settings.team_config.teams))
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
