"""In-process store for tests. One asyncio lock plays the transaction; every value going in
or out is deep-copied so no caller can mutate stored state by aliasing."""

from __future__ import annotations

import asyncio
import copy
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .store import (
    DELIVERY_SCAN_LIMIT,
    MAX_LIVE_CREDENTIALS,
    STREAM_SCAN_LIMIT,
    AuditEntry,
    BeyondHead,
    CreateOutcome,
    CredentialRecord,
    Envelope,
    IdempotencyRecord,
    LoginCode,
    LoginDoc,
    LoginFn,
    MemberDoc,
    MutateFn,
    ProgressEntry,
    Quota,
    QuotaExceeded,
    RedeemFn,
    RedeemOutcome,
    RequestDoc,
    RetiredId,
    RosterEntry,
    RosterFn,
    RosterOutcome,
    RosterState,
    StreamPage,
    credentials_over_cap,
    monotonic_updated_at,
    stamp_deliveries,
)


@dataclass
class _Stream:
    head: int = 0
    cursor: int = 0
    messages: dict[int, Envelope] = field(default_factory=dict)


class MemoryStore:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._members: dict[tuple[str, str], MemberDoc] = {}
        self._streams: dict[tuple[str, str, str], _Stream] = {}
        self._requests: dict[tuple[str, str], RequestDoc] = {}
        self._progress: dict[tuple[str, str], list[ProgressEntry]] = {}
        self._idempotency: dict[tuple[str, str], IdempotencyRecord] = {}
        self._audit: list[AuditEntry] = []
        self._counters: dict[tuple[str, str], int] = {}
        self._roster: dict[str, dict[str, RosterEntry]] = {}
        self._roster_version: dict[str, int] = {}
        self._retired: dict[str, dict[str, RetiredId]] = {}
        self._credentials: dict[tuple[str, str], CredentialRecord] = {}
        self._logins: dict[str, LoginDoc] = {}
        self._codes: dict[str, LoginCode] = {}
        self._login_counters: dict[str, int] = {}

    async def aclose(self) -> None:
        return None

    # Helpers (call with the lock held) --------------------------------------------------
    def _append(self, envelopes: Sequence[Envelope]) -> list[Envelope]:
        written = []
        for env in envelopes:
            stream = self._streams.setdefault((env.team, env.to, env.stream), _Stream())
            stored = copy.deepcopy(env)
            stream.head += 1
            stored.seq = stream.head
            stream.messages[stored.seq] = stored
            written.append(copy.deepcopy(stored))
        return written

    def _advance(self, team: str, state: _Stream, to: int, now: datetime) -> None:
        """Move the cursor to ``to`` (> cursor) and stamp the deliveries it passed (§3.2)."""
        passed: list[Envelope] = []
        for seq in range(state.cursor + 1, to + 1):
            if len(passed) >= DELIVERY_SCAN_LIMIT:
                break
            if seq in state.messages:
                passed.append(state.messages[seq])
        requests = {
            env.request_id: self._requests[(team, env.request_id)]
            for env in passed
            if (team, env.request_id) in self._requests
        }
        # stamp_deliveries edits the stored documents in place; the lock is held.
        stamp_deliveries(passed, requests, now)
        state.cursor = to

    def _take(self, team: str, quotas: Sequence[Quota]) -> None:
        """Check every quota, then count one against each; all or nothing."""
        for quota in quotas:
            if self._counters.get((team, quota.key), 0) >= quota.limit:
                raise QuotaExceeded(quota)
        for quota in quotas:
            self._counters[(team, quota.key)] = self._counters.get((team, quota.key), 0) + 1

    # Members --------------------------------------------------------------------------
    async def get_members(self, team: str, members: Sequence[str]) -> dict[str, MemberDoc]:
        async with self._lock:
            return {
                m: copy.deepcopy(self._members[(team, m)])
                for m in members
                if (team, m) in self._members
            }

    async def put_manifest(
        self,
        team: str,
        member: str,
        manifest: dict[str, Any],
        published_at: datetime,
        audit: Sequence[AuditEntry],
    ) -> None:
        async with self._lock:
            doc = self._members.setdefault((team, member), MemberDoc())
            doc.manifest = copy.deepcopy(manifest)
            doc.published_at = published_at
            self._audit.extend(copy.deepcopy(list(audit)))

    async def touch_presence(
        self, team: str, member: str, stream: str, now: datetime, min_interval: timedelta
    ) -> None:
        async with self._lock:
            doc = self._members.setdefault((team, member), MemberDoc())
            last = doc.presence.get(stream)
            if last is None or now - last >= min_interval:
                doc.presence[stream] = now
                if doc.last_seen is None or now > doc.last_seen:
                    doc.last_seen = now

    # Requests -------------------------------------------------------------------------
    async def get_idempotency(
        self, team: str, key_id: str, now: datetime
    ) -> IdempotencyRecord | None:
        async with self._lock:
            record = self._idempotency.get((team, key_id))
            if record is None or record.expire_at <= now:
                return None
            return copy.deepcopy(record)

    async def create_request(
        self,
        team: str,
        key_id: str,
        record: IdempotencyRecord,
        request: RequestDoc,
        envelopes: Sequence[Envelope],
        audit: Sequence[AuditEntry],
        now: datetime,
        quotas: Sequence[Quota] = (),
    ) -> CreateOutcome:
        async with self._lock:
            existing = self._idempotency.get((team, key_id))
            if existing is not None and existing.expire_at > now:
                return CreateOutcome(created=False, record=copy.deepcopy(existing))
            if (team, request.request_id) in self._requests:
                raise RuntimeError("request id collision")
            self._take(team, quotas)
            self._idempotency[(team, key_id)] = copy.deepcopy(record)
            self._requests[(team, request.request_id)] = copy.deepcopy(request)
            self._append(envelopes)
            self._audit.extend(copy.deepcopy(list(audit)))
            return CreateOutcome(created=True, record=copy.deepcopy(record))

    async def get_request(self, team: str, request_id: str) -> RequestDoc | None:
        async with self._lock:
            return copy.deepcopy(self._requests.get((team, request_id)))

    async def list_progress(self, team: str, request_id: str) -> list[ProgressEntry]:
        async with self._lock:
            entries = self._progress.get((team, request_id), [])
            return copy.deepcopy(sorted(entries, key=lambda e: e.seq))

    async def mutate_request[T](self, team: str, request_id: str, fn: MutateFn[T]) -> T:
        async with self._lock:
            current = copy.deepcopy(self._requests.get((team, request_id)))
            previous = current.updated_at if current is not None else None
            mutation = fn(current)  # raising here leaves everything untouched
            if mutation.request is not None:
                if mutation.request.request_id != request_id:
                    raise RuntimeError("a mutation may only write its own request")
                # M2-SPEC §7.1, on the value read under the lock.
                mutation.request.updated_at = monotonic_updated_at(
                    mutation.request.updated_at, previous
                )
                self._requests[(team, request_id)] = copy.deepcopy(mutation.request)
            self._append(mutation.envelopes)
            if mutation.progress:
                bucket = self._progress.setdefault((team, request_id), [])
                bucket.extend(copy.deepcopy(mutation.progress))
            self._audit.extend(copy.deepcopy(mutation.audit))
            return mutation.result

    async def due_requests(self, team: str, asker: str, now: datetime, limit: int) -> list[str]:
        async with self._lock:
            due = [
                doc
                for (t, _), doc in self._requests.items()
                if t == team
                and doc.asker == asker
                and doc.next_deadline is not None
                and doc.next_deadline <= now
            ]
            due.sort(key=lambda d: d.next_deadline)  # type: ignore[arg-type,return-value]
            return [d.request_id for d in due[:limit]]

    async def requests_updated_after(
        self, team: str, since: datetime, limit: int, *, descending: bool = False
    ) -> list[RequestDoc]:
        async with self._lock:
            found = [
                doc
                for (t, _), doc in self._requests.items()
                if t == team and doc.updated_at is not None and doc.updated_at > since
            ]
            found.sort(key=lambda d: (d.updated_at, d.request_id), reverse=descending)
            return copy.deepcopy(found[:limit])

    async def requests_updated_at(self, team: str, at: datetime, limit: int) -> list[RequestDoc]:
        async with self._lock:
            found = [
                doc for (t, _), doc in self._requests.items() if t == team and doc.updated_at == at
            ]
            found.sort(key=lambda d: d.request_id)
            return copy.deepcopy(found[:limit])

    # Streams --------------------------------------------------------------------------
    async def read_stream(
        self, team: str, member: str, stream: str, after: int | None, limit: int, now: datetime
    ) -> StreamPage:
        async with self._lock:
            state = self._streams.get((team, member, stream), _Stream())
            out: list[Envelope] = []
            start = state.cursor if after is None else after
            seq = start
            expired_through = start  # the end of the expired run right after ``start``
            scanned = 0
            while len(out) < limit and seq < state.head and scanned < STREAM_SCAN_LIMIT:
                seq += 1
                env = state.messages.get(seq)
                if env is None:
                    continue
                scanned += 1
                if env.expire_at > now:
                    out.append(copy.deepcopy(env))
                elif not out:
                    expired_through = seq
            if start == state.cursor and expired_through > state.cursor:
                self._advance(team, state, expired_through, now)  # (§11.5) under the lock
            return StreamPage(messages=out, cursor=state.cursor, head=state.head)

    async def set_cursor(
        self, team: str, member: str, stream: str, acked_seq: int, now: datetime
    ) -> int:
        async with self._lock:
            state = self._streams.get((team, member, stream))
            head = state.head if state else 0
            if acked_seq > head:
                raise BeyondHead()
            if state is None:
                return 0
            if acked_seq > state.cursor:
                self._advance(team, state, acked_seq, now)
            return state.cursor

    # Audit ----------------------------------------------------------------------------
    async def append_audit(self, entries: Sequence[AuditEntry]) -> None:
        async with self._lock:
            self._audit.extend(copy.deepcopy(list(entries)))

    async def append_audit_capped(
        self, team: str, entries: Sequence[AuditEntry], quota: Quota
    ) -> bool:
        async with self._lock:
            try:
                self._take(team, [quota])
            except QuotaExceeded:
                return False
            self._audit.extend(copy.deepcopy(list(entries)))
            return True

    async def list_audit(self, team: str, limit: int = 1000) -> list[AuditEntry]:
        async with self._lock:
            return copy.deepcopy([e for e in self._audit if e.team == team][:limit])

    async def count_quota(self, team: str, quota: Quota) -> bool:
        async with self._lock:
            try:
                self._take(team, [quota])
            except QuotaExceeded:
                return False
            return True

    # Roster ---------------------------------------------------------------------------
    async def roster_version(self, team: str) -> int:
        async with self._lock:
            return self._roster_version.get(team, 0)

    async def read_roster(self, team: str) -> RosterState:
        async with self._lock:
            return self._roster_state(team)

    def _roster_state(self, team: str) -> RosterState:
        return RosterState(
            version=self._roster_version.get(team, 0),
            entries=copy.deepcopy(self._roster.get(team, {})),
            retired=copy.deepcopy(self._retired.get(team, {})),
        )

    async def mutate_roster[T](
        self, team: str, fn: RosterFn[T], now: datetime, quotas: Sequence[Quota] = ()
    ) -> RosterOutcome[T]:
        async with self._lock:
            state = self._roster_state(team)
            version = state.version
            change = fn(state)  # raising here leaves everything untouched
            if not change.changed:
                return RosterOutcome(result=change.result, version=version, revoked=[])
            self._take(team, quotas)
            entries = self._roster.setdefault(team, {})
            revoked: list[str] = []
            for member in change.remove:
                entries.pop(member, None)
                for (t, key), record in sorted(self._credentials.items()):
                    if t == team and record.member == member and record.live(now):
                        record.revoked = True
                        record.revoked_at = now
                        revoked.append(key)
            for entry in change.put:
                entries[entry.member] = copy.deepcopy(entry)
            retired = self._retired.setdefault(team, {})
            for tomb in change.retire:
                retired[tomb.member] = copy.deepcopy(tomb)
            self._roster_version[team] = version + 1
            self._audit.extend(copy.deepcopy(change.audit))
            return RosterOutcome(result=change.result, version=version + 1, revoked=revoked)

    # Device credentials ---------------------------------------------------------------
    async def find_credential(self, teams: Sequence[str], key: str) -> CredentialRecord | None:
        async with self._lock:
            for team in teams:
                record = self._credentials.get((team, key))
                if record is not None:
                    return copy.deepcopy(record)
            return None

    async def touch_credential(
        self, team: str, key: str, last_used_at: datetime, expire_at: datetime
    ) -> None:
        async with self._lock:
            record = self._credentials.get((team, key))
            if record is not None and not record.revoked:
                record.last_used_at = last_used_at
                record.expire_at = expire_at

    async def list_credentials(self, team: str, member: str) -> list[CredentialRecord]:
        async with self._lock:
            return copy.deepcopy(
                [r for (t, _), r in self._credentials.items() if t == team and r.member == member]
            )

    async def revoke_credential(
        self, team: str, key: str, member: str, now: datetime, audit: Sequence[AuditEntry]
    ) -> CredentialRecord | None:
        async with self._lock:
            record = self._credentials.get((team, key))
            if record is None or record.member != member or not record.live(now):
                return None
            record.revoked = True
            record.revoked_at = now
            self._audit.extend(copy.deepcopy(list(audit)))
            return copy.deepcopy(record)

    # Login ----------------------------------------------------------------------------
    async def create_login(self, login: LoginDoc) -> None:
        async with self._lock:
            if login.key in self._logins:
                raise RuntimeError("login id collision")
            self._logins[login.key] = copy.deepcopy(login)

    async def mutate_login[T](self, key: str, fn: LoginFn[T]) -> T:
        async with self._lock:
            change = fn(copy.deepcopy(self._logins.get(key)))
            if change.code is not None and change.code.key in self._codes:
                raise RuntimeError("login code collision")
            if change.login is not None:
                if change.login.key != key:
                    raise RuntimeError("a login change may only write its own login")
                self._logins[key] = copy.deepcopy(change.login)
            if change.code is not None:
                self._codes[change.code.key] = copy.deepcopy(change.code)
            return change.result

    async def redeem_code[T](self, key: str, fn: RedeemFn[T], now: datetime) -> RedeemOutcome[T]:
        async with self._lock:
            plan = fn(copy.deepcopy(self._codes.get(key)))
            revoked: list[CredentialRecord] = []
            if plan.code is not None:
                if plan.code.key != key:
                    raise RuntimeError("a redemption may only write its own code")
                self._codes[key] = copy.deepcopy(plan.code)
            if plan.credential is not None:
                cred = plan.credential
                existing = [
                    r
                    for (t, _), r in self._credentials.items()
                    if t == cred.team and r.member == cred.member
                ]
                for record in credentials_over_cap(existing, now, MAX_LIVE_CREDENTIALS - 1):
                    record.revoked = True
                    record.revoked_at = now
                    revoked.append(copy.deepcopy(record))
                if (cred.team, cred.key) in self._credentials:
                    raise RuntimeError("credential collision")
                self._credentials[(cred.team, cred.key)] = copy.deepcopy(cred)
            if plan.revoke is not None:
                record = self._credentials.get(plan.revoke)
                if record is not None and record.live(now):
                    record.revoked = True
                    record.revoked_at = now
                    revoked.append(copy.deepcopy(record))
            self._audit.extend(copy.deepcopy(plan.audit))
            return RedeemOutcome(result=plan.result, revoked=revoked)

    async def count_login_quota(self, quota: Quota) -> bool:
        async with self._lock:
            count = self._login_counters.get(quota.key, 0)
            if count >= quota.limit:
                return False
            self._login_counters[quota.key] = count + 1
            return True
