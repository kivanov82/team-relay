"""The store protocol and the records it holds (M1-SPEC §6).

The protocol is a handful of high-level atomic operations, not CRUD, so the invariants
that need a transaction live in exactly one primitive each:

- :meth:`Store.create_request`: the request, its idempotency record, one envelope per
  recipient (seqs assigned) and the audit entries, or nothing, in one transaction; an
  existing unexpired idempotency record wins and nothing is written.
- :meth:`Store.mutate_request`: re-read one request, run a *pure* function over it, then
  write the new request, append the envelopes it produced to their target streams
  (assigning seqs), add progress entries and audit entries, in one transaction. Ack,
  reply, progress and the deadline sweep are all this primitive with a different function.
  The function may run more than once (Firestore retries on contention), so it must not
  have side effects; raising aborts the transaction and writes nothing.
- :meth:`Store.set_cursor`: read head and cursor, move the cursor forward and stamp the
  delivery times of the messages it passed (M2-SPEC §3.2), atomically.
- :meth:`Store.append_audit_capped`: count one against a per-minute counter and write the
  audit entries only while the counter is under its limit, atomically.
- :meth:`Store.count_quota`: count one against a per-minute counter while it is under its
  limit, atomically (the read budget, M2-SPEC §7.3).
- :meth:`Store.mutate_roster`: read a team's roster version and every roster entry, run a
  *pure* function over them, count the quotas, and write the entries it changed, delete the
  members it removed (revoking every live device credential of theirs) and bump the
  version, in one transaction (M6-SPEC §1). Seeding and the owner endpoints are all this
  primitive with a different function.
- :meth:`Store.mutate_login`: read one login, run a pure function, write its new version and
  the one-time code it minted, in one transaction (M5-SPEC §2).
- :meth:`Store.redeem_code`: read one login code, run a pure function, then write the used
  code, the credential it mints (revoking the member's least recently used live credentials
  beyond MAX_LIVE_CREDENTIALS) or revoke the credential a reused code minted, in one
  transaction (M5-SPEC §2 step 7, §3).

Every write of an existing request keeps its ``updated_at`` monotonic (M2-SPEC §7.1): the
store stamps it, inside the transaction that writes the request, as the later of the value
the writer set and the previous stored value plus 1 ms (:func:`monotonic_updated_at`). A
retried transaction therefore never writes an older value than a change that committed
first, whatever the writer's clock says.

Per-sender counters (:class:`Quota`) live in the store so a limit holds across instances;
:meth:`Store.create_request` checks and increments them in the creating transaction.

Implementations: :mod:`relay.store_memory` (a lock plays the transaction) and
:mod:`relay.store_firestore`. Both must pass ``tests/test_store_contract.py``. Neither
filters by business rules; expiry filtering on reads is done where noted.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal, Protocol

StreamName = Literal["inbox", "replies"]
STREAMS: tuple[str, ...] = ("inbox", "replies")

Status = Literal["pending", "acked", "answered", "no_response", "timed_out"]


@dataclass
class Envelope:
    """One message in one member's stream (§5). ``seq`` is 0 until the store assigns it."""

    id: str
    team: str
    stream: str
    type: str
    sender: str  # "from" on the wire
    to: str
    request_id: str
    broadcast: bool
    time: datetime
    expire_at: datetime
    data: dict[str, Any]
    seq: int = 0


@dataclass
class ToolEvent:
    """One tool the recipient's answering session used (M2-SPEC §3.3): never its input,
    output or path, only the name, the outcome and the duration."""

    tool: str
    status: str  # "ok" | "error" | "waiting" (M4-SPEC §2)
    at: datetime
    duration_ms: int | None = None


@dataclass
class RecipientState:
    status: str = "pending"
    acked_at: datetime | None = None
    answered_at: datetime | None = None
    reply_key: str | None = None
    reply_message_id: str | None = None
    progress_count: int = 0  # progress events of kind "progress" only
    # M2-SPEC §3.2: first write wins, never overwritten.
    delivered_at: datetime | None = None
    answer_delivered_at: datetime | None = None
    tools: list[ToolEvent] = field(default_factory=list)  # §3.3, at most 50
    last_progress_pct: int | float | None = None  # the most recent pct reported
    answer_preview: str | None = None  # §3.4, the first 2000 characters of the reply


@dataclass
class RequestDoc:
    request_id: str
    team: str
    kind: str
    asker: str
    broadcast: bool
    question: str | None
    capability: dict[str, Any] | None  # {"name", "params", "environment"}
    created_at: datetime
    ack_deadline: datetime
    answer_deadline: datetime
    expire_at: datetime
    next_deadline: datetime | None
    recipients: dict[str, RecipientState]  # insertion order is the recipient order
    progress_head: int = 0
    # M2-SPEC §3.5: set on every change. None only on documents written before M2, which
    # the activity feed never returns (Firestore leaves a document without the field out
    # of a query on it, and MemoryStore does the same).
    updated_at: datetime | None = None


@dataclass
class ProgressEntry:
    """One entry of a request's progress list: a progress event (``kind="progress"``, with
    ``text`` and ``pct``) or a tool event (``kind="tool"``, with ``tool``, ``status`` and
    ``duration_ms``; M2-SPEC §3.3). One sequence covers both."""

    seq: int
    member: str
    text: str | None
    pct: int | float | None
    time: datetime
    expire_at: datetime
    kind: str = "progress"
    tool: str | None = None
    status: str | None = None
    duration_ms: int | None = None


@dataclass
class IdempotencyRecord:
    request_id: str
    body_hash: str
    recipients: list[str]
    ack_deadline: datetime
    answer_deadline: datetime
    expire_at: datetime


@dataclass
class MemberDoc:
    manifest: dict[str, Any] | None = None
    published_at: datetime | None = None
    last_seen: datetime | None = None
    # M2-SPEC §3.1: per stream ("inbox" is the answering session, "replies" the working
    # session), the last time a poll of that stream was recorded.
    presence: dict[str, datetime] = field(default_factory=dict)


@dataclass
class AuditEntry:
    time: datetime
    team: str
    actor: str
    action: str
    outcome: str
    expire_at: datetime
    request_id: str | None = None
    message_id: str | None = None
    envelope_type: str | None = None
    to: list[str] = field(default_factory=list)
    content_sha256: str | None = None
    content_length: int | None = None
    detail: str | None = None
    # M6-SPEC §2: the member a roster change or a credential is about, and the SHA-256 of
    # every email it touched (never the email itself).
    member: str | None = None
    email_sha256: list[str] = field(default_factory=list)


# Roster (M6-SPEC §1) ---------------------------------------------------------------------


@dataclass
class RosterEntry:
    """``teams/{team}/roster/{member}``: who the member is (their lower-cased Google emails)
    and their role. Never expires."""

    member: str
    emails: list[str]
    role: str  # "owner" | "member"
    added_by: str
    added_at: datetime
    updated_at: datetime


@dataclass
class RetiredId:
    """``teams/{team}/retired/{member}``: a removed member's id, kept until ``expire_at``
    (past the longest a request and its messages can live) with the SHA-256 of the emails it
    had, so the id cannot be handed to someone else while its history is still readable."""

    member: str
    email_sha256: list[str]
    retired_at: datetime
    expire_at: datetime


@dataclass
class RosterState:
    """A team's roster as one transaction read it: ``roster_version`` (0 before the first
    change), every entry by member id, and the retired ids (expired ones included; the
    caller compares ``expire_at``)."""

    version: int
    entries: dict[str, RosterEntry]
    retired: dict[str, RetiredId] = field(default_factory=dict)


@dataclass
class RosterChange[T]:
    """What a :meth:`Store.mutate_roster` function asks the store to write. ``put`` entries
    are written whole; ``remove`` members are deleted and their live credentials revoked.
    The version is bumped when either is non-empty; nothing is written otherwise, and the
    quotas are counted only then."""

    result: T
    put: list[RosterEntry] = field(default_factory=list)
    remove: list[str] = field(default_factory=list)
    audit: list[AuditEntry] = field(default_factory=list)
    # Written with a removal; kept (not deleted) when the id is given back, so the next
    # removal merges every email the id had. The TTL policy deletes them.
    retire: list[RetiredId] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.put or self.remove or self.retire)


@dataclass
class RosterOutcome[T]:
    result: T
    version: int
    revoked: list[str]  # credential keys revoked with a removal


# Device credentials (M5-SPEC §3) ---------------------------------------------------------

# At most this many live (unrevoked, unexpired) credentials per member: minting one more
# revokes the least recently used beyond it, so a removal revokes a bounded number in its
# transaction.
MAX_LIVE_CREDENTIALS = 20


@dataclass
class CredentialRecord:
    """``teams/{team}/credentials/{key}``, ``key`` the SHA-256 hex of the whole credential.
    ``expire_at`` rolls forward with use (the TTL field)."""

    key: str
    team: str
    member: str
    device: str
    created_at: datetime
    last_used_at: datetime
    expire_at: datetime
    revoked: bool = False
    revoked_at: datetime | None = None

    def live(self, now: datetime) -> bool:
        return not self.revoked and now < self.expire_at


def credentials_over_cap(
    records: Sequence[CredentialRecord], now: datetime, keep: int
) -> list[CredentialRecord]:
    """The live credentials to revoke so that at most ``keep`` stay live: the least recently
    used first (ties: the oldest, then the key). Pure, for both stores."""
    live = [r for r in records if r.live(now)]
    if len(live) <= keep:
        return []
    live.sort(key=lambda r: (r.last_used_at, r.created_at, r.key))
    return live[: len(live) - keep]


# Login (M5-SPEC §2) ----------------------------------------------------------------------


@dataclass
class LoginChoice:
    team: str
    member: str


@dataclass
class LoginDoc:
    """``logins/{key}``, ``key`` the SHA-256 hex of the login id (the ``trl`` cookie and
    Google's ``state``). Steps: ``google`` → ``exchanging`` → ``choose`` → ``done``, or
    ``closed`` from any of them."""

    key: str
    port: int
    state: str  # the plugin's, returned to its listener
    challenge: str  # the plugin's PKCE challenge
    device: str
    step: str
    nonce: str
    google_verifier: str  # the relay's own PKCE verifier towards Google
    created_at: datetime
    expire_at: datetime
    csrf_sha256: str | None = None
    email: str | None = None
    choices: list[LoginChoice] = field(default_factory=list)


@dataclass
class LoginCode:
    """``login_codes/{key}``, ``key`` the SHA-256 hex of the one-time code."""

    key: str
    login_key: str
    team: str
    member: str
    device: str
    challenge: str
    created_at: datetime
    expire_at: datetime
    used: bool = False
    credential_key: str | None = None


@dataclass
class LoginChange[T]:
    """What a :meth:`Store.mutate_login` function asks the store to write."""

    result: T
    login: LoginDoc | None = None  # the new version, or None to leave it
    code: LoginCode | None = None  # a code to create


@dataclass
class Redemption[T]:
    """What a :meth:`Store.redeem_code` function asks the store to write: the code's new
    version, a credential to create, the ``(team, key)`` of a credential to revoke (the one a
    reused code minted), and audit entries."""

    result: T
    code: LoginCode | None = None
    credential: CredentialRecord | None = None
    revoke: tuple[str, str] | None = None
    audit: list[AuditEntry] = field(default_factory=list)


@dataclass
class RedeemOutcome[T]:
    result: T
    revoked: list[CredentialRecord]  # revoked in the transaction (reuse, or over the cap)


@dataclass
class Mutation[T]:
    """What a :meth:`Store.mutate_request` function asks the store to write."""

    result: T
    request: RequestDoc | None = None  # the new version, or None to leave it as it was
    envelopes: list[Envelope] = field(default_factory=list)
    progress: list[ProgressEntry] = field(default_factory=list)
    audit: list[AuditEntry] = field(default_factory=list)


@dataclass
class CreateOutcome:
    created: bool
    record: IdempotencyRecord  # the stored one when created is False


@dataclass
class StreamPage:
    messages: list[Envelope]
    cursor: int
    head: int


# read_stream scans at most this many envelopes past ``after`` looking for unexpired ones,
# so one read has a bounded cost; a read from the stored cursor also moves the cursor past
# the expired run it scanned, so the next read starts beyond it (M1-SPEC §11.5).
STREAM_SCAN_LIMIT = 1000


# A cursor advance reads at most this many of the messages it passes, ascending, to stamp
# their delivery times (M2-SPEC §3.2); messages beyond it in one advance stay unstamped.
DELIVERY_SCAN_LIMIT = 100

DELIVERED_TYPES = frozenset({"question", "capability_call"})

# M2-SPEC §7.1: a rewritten request's updated_at is at least this much after the previous one.
UPDATED_AT_STEP = timedelta(milliseconds=1)


def monotonic_updated_at(new: datetime | None, previous: datetime | None) -> datetime | None:
    """The ``updated_at`` to store when a request whose stored value is ``previous`` is
    rewritten with ``new`` (M2-SPEC §7.1): ``max(new, previous + 1 ms)``. With no previous
    value (a document written before M2) ``new`` stands; with no new value the previous one
    still moves forward, so no write can make a request disappear from the feed or move it
    backwards. Both stores call this inside the writing transaction, on the value read
    there."""
    if previous is None:
        return new
    floor = previous + UPDATED_AT_STEP
    return floor if new is None or new < floor else new


def stamp_deliveries(
    envelopes: Sequence[Envelope], requests: dict[str, RequestDoc], now: datetime
) -> list[RequestDoc]:
    """Record delivery times for the messages a cursor advance passed (M2-SPEC §3.2), on the
    given request documents, in place; return the documents that changed.

    - an ``inbox`` question or capability call sets the recipient's ``delivered_at``;
    - a ``replies`` answer sets the answering recipient's ``answer_delivered_at``;
    - notices (``no_response``, ``timed_out``) set nothing;
    - first write wins: a time already set is never overwritten;
    - a request that is missing or expired at ``now`` is left alone (reads treat it as
      gone, and nothing about it can be delivered any more);
    - a changed request's ``updated_at`` becomes ``max(now, previous + 1 ms)`` (§7.1).

    Pure, so both stores run exactly the same rule inside their own transaction.
    """
    changed: dict[str, RequestDoc] = {}
    for env in envelopes:
        doc = requests.get(env.request_id)
        if doc is None or now >= doc.expire_at:
            continue
        if env.stream == "inbox" and env.type in DELIVERED_TYPES:
            state = doc.recipients.get(env.to)
            if state is not None and state.delivered_at is None:
                state.delivered_at = now
                changed[doc.request_id] = doc
        elif env.stream == "replies" and env.type == "answer":
            state = doc.recipients.get(env.sender)
            if state is not None and state.answer_delivered_at is None:
                state.answer_delivered_at = now
                changed[doc.request_id] = doc
    for doc in changed.values():
        doc.updated_at = monotonic_updated_at(now, doc.updated_at)  # §7.1
    return list(changed.values())


class BeyondHead(Exception):
    """``acked_seq`` is greater than the stream head."""


@dataclass(frozen=True)
class Quota:
    """A fixed-window counter: at most ``limit`` counts under ``key`` (the window is part of
    the key, so a new window starts from zero). ``expire_at`` is its TTL field."""

    key: str
    limit: int
    expire_at: datetime


class QuotaExceeded(Exception):
    """A :class:`Quota` is already at its limit; nothing was written."""

    def __init__(self, quota: Quota) -> None:
        super().__init__(quota.key)
        self.quota = quota


# Mutation functions receive the current request (None when it does not exist).
type MutateFn[T] = Callable[[RequestDoc | None], Mutation[T]]
type RosterFn[T] = Callable[[RosterState], RosterChange[T]]
type LoginFn[T] = Callable[[LoginDoc | None], LoginChange[T]]
type RedeemFn[T] = Callable[[LoginCode | None], Redemption[T]]


class Store(Protocol):
    async def aclose(self) -> None: ...

    # Members -------------------------------------------------------------------------
    async def get_members(self, team: str, members: Sequence[str]) -> dict[str, MemberDoc]:
        """The docs that exist, keyed by member."""
        ...

    async def put_manifest(
        self,
        team: str,
        member: str,
        manifest: dict[str, Any],
        published_at: datetime,
        audit: Sequence[AuditEntry],
    ) -> None:
        """Store the discovery payload and its audit entries atomically; keep last_seen."""
        ...

    async def touch_presence(
        self, team: str, member: str, stream: str, now: datetime, min_interval: timedelta
    ) -> None:
        """Set ``presence[stream]`` to ``now`` unless it is already within ``min_interval``;
        when it is written, ``last_seen`` becomes the later of itself and ``now``."""
        ...

    # Requests ------------------------------------------------------------------------
    async def get_idempotency(
        self, team: str, key_id: str, now: datetime
    ) -> IdempotencyRecord | None:
        """The record, or None when absent or expired."""
        ...

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
        """An unexpired idempotency record wins (``created=False``, nothing written, no
        quota counted). Otherwise every quota must be under its limit (else
        :class:`QuotaExceeded` and nothing is written) and is incremented with the rest."""
        ...

    async def get_request(self, team: str, request_id: str) -> RequestDoc | None: ...

    async def list_progress(self, team: str, request_id: str) -> list[ProgressEntry]:
        """Ascending by seq."""
        ...

    async def mutate_request[T](self, team: str, request_id: str, fn: MutateFn[T]) -> T:
        """Run ``fn`` on the request read inside the transaction and write what it returns.
        A written request's ``updated_at`` is replaced by :func:`monotonic_updated_at` of the
        value ``fn`` set and the one read (M2-SPEC §7.1)."""
        ...

    async def due_requests(self, team: str, asker: str, now: datetime, limit: int) -> list[str]:
        """Ids of the asker's requests with ``next_deadline <= now``, earliest first."""
        ...

    async def requests_updated_after(
        self, team: str, since: datetime, limit: int, *, descending: bool = False
    ) -> list[RequestDoc]:
        """Up to ``limit`` of the team's requests with ``updated_at > since``, ordered by
        ``(updated_at, request_id)`` ascending (or both descending), expired ones included
        (the caller filters). One query on the single field ``updated_at``."""
        ...

    async def requests_updated_at(self, team: str, at: datetime, limit: int) -> list[RequestDoc]:
        """Up to ``limit`` of the team's requests with ``updated_at == at``, by request id."""
        ...

    # Streams -------------------------------------------------------------------------
    async def read_stream(
        self, team: str, member: str, stream: str, after: int | None, limit: int, now: datetime
    ) -> StreamPage:
        """Up to ``limit`` unexpired envelopes with seq > ``after`` (None: the stored
        cursor) and seq <= head, ascending, skipping expired ones (TTL deletion is lazy),
        scanning at most STREAM_SCAN_LIMIT envelopes; plus the stored cursor and head.

        When the read starts at the stored cursor (``after`` is None or equal to it), the
        cursor is moved, atomically and never backwards, past the contiguous run of expired
        envelopes the scan found right after it: they can never be delivered. It never moves
        past an unexpired envelope. The returned cursor is the stored one after that move.
        That move is a cursor advance like :meth:`set_cursor`'s and stamps deliveries the
        same way, in the same transaction (M2-SPEC §3.2)."""
        ...

    async def set_cursor(
        self, team: str, member: str, stream: str, acked_seq: int, now: datetime
    ) -> int:
        """Cursor becomes max(cursor, acked_seq); raises :class:`BeyondHead`. When it moves,
        the first DELIVERY_SCAN_LIMIT messages it passed are read and
        :func:`stamp_deliveries` is applied to their requests, in the same transaction."""
        ...

    # Audit ---------------------------------------------------------------------------
    async def append_audit(self, entries: Sequence[AuditEntry]) -> None: ...

    async def append_audit_capped(
        self, team: str, entries: Sequence[AuditEntry], quota: Quota
    ) -> bool:
        """Count one against ``quota`` and write ``entries``, atomically, if the quota is
        under its limit; otherwise write nothing and return False."""
        ...

    async def list_audit(self, team: str, limit: int = 1000) -> list[AuditEntry]:
        """Oldest first. For operators and tests; the HTTP API never exposes it."""
        ...

    async def count_quota(self, team: str, quota: Quota) -> bool:
        """Count one against ``quota`` and return True, atomically, if it is under its
        limit; otherwise write nothing and return False."""
        ...

    # Roster (M6-SPEC §1) -------------------------------------------------------------
    async def roster_version(self, team: str) -> int:
        """``teams/{team}.roster_version`` (0 when unset): one small read."""
        ...

    async def read_roster(self, team: str) -> RosterState:
        """The version and every entry, read consistently (one transaction)."""
        ...

    async def mutate_roster[T](
        self, team: str, fn: RosterFn[T], now: datetime, quotas: Sequence[Quota] = ()
    ) -> RosterOutcome[T]:
        """Read the roster and the retired ids, run ``fn`` (pure; raising writes nothing).
        When it changed something: every quota must be under its limit (else
        :class:`QuotaExceeded`, nothing written) and is counted; ``put`` entries are
        written, ``remove`` members deleted with every live credential of theirs revoked
        (``revoked_at = now``), ``retire`` ids written, ``roster_version`` incremented,
        the audit written; all in one transaction."""
        ...

    # Device credentials (M5-SPEC §3) -------------------------------------------------
    async def find_credential(self, teams: Sequence[str], key: str) -> CredentialRecord | None:
        """The credential ``key`` in whichever of ``teams`` holds it (revoked or expired
        ones included; the caller decides), in one batched read."""
        ...

    async def touch_credential(
        self, team: str, key: str, last_used_at: datetime, expire_at: datetime
    ) -> None:
        """Record a use (the rolling expiry) unless the credential is gone or revoked."""
        ...

    async def list_credentials(self, team: str, member: str) -> list[CredentialRecord]:
        """Every credential of the member, revoked and expired ones included, any order."""
        ...

    async def revoke_credential(
        self, team: str, key: str, member: str, now: datetime, audit: Sequence[AuditEntry]
    ) -> CredentialRecord | None:
        """Revoke the member's live credential ``key`` and write ``audit``, atomically;
        None (nothing written) when there is no such live credential of that member."""
        ...

    # Login (M5-SPEC §2) --------------------------------------------------------------
    async def create_login(self, login: LoginDoc) -> None: ...

    async def mutate_login[T](self, key: str, fn: LoginFn[T]) -> T:
        """Read login ``key`` (None when absent), run ``fn`` (pure; raising writes
        nothing), write the new login and create the code it minted, atomically."""
        ...

    async def redeem_code[T](self, key: str, fn: RedeemFn[T], now: datetime) -> RedeemOutcome[T]:
        """Read code ``key`` (None when absent), run ``fn`` (pure; raising writes nothing),
        then atomically: write the code's new version; create the credential (revoking the
        member's live credentials beyond MAX_LIVE_CREDENTIALS - 1 by
        :func:`credentials_over_cap`); revoke ``revoke`` when it is live; write the audit."""
        ...

    async def count_login_quota(self, quota: Quota) -> bool:
        """:meth:`count_quota` for the login pages, outside any team (M5-SPEC §2)."""
        ...
