"""Device credentials (M5-SPEC §3): ``trc_`` + 43 base64url characters (32 random bytes).

Only the SHA-256 of a credential is stored (``teams/{team}/credentials/{sha256 hex}``) and
nothing but its first 16 hex characters (its public id) is ever logged or returned. A
verified credential is cached in the process for at most CREDENTIAL_CACHE_TTL, so a
revocation made on another instance lands within a minute; one made here lands at once.
Use rolls the expiry forward (90 days after the last use), written at most every
LAST_USED_INTERVAL.
"""

from __future__ import annotations

import base64
import hashlib
import re
import secrets
from collections import OrderedDict
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from .store import CredentialRecord, Store

PREFIX = "trc_"
CREDENTIAL_RE = re.compile(r"^trc_[A-Za-z0-9_-]{43}$")
CREDENTIAL_LIFETIME = timedelta(days=90)
CREDENTIAL_CACHE_TTL = timedelta(seconds=60)
LAST_USED_INTERVAL = timedelta(minutes=10)
CACHE_SIZE = 4096
PUBLIC_ID_LENGTH = 16
PUBLIC_ID_RE = re.compile(r"^[0-9a-f]{16}$")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def new_credential() -> str:
    return PREFIX + b64url(secrets.token_bytes(32))


def credential_key(credential: str) -> str:
    return hashlib.sha256(credential.encode("ascii")).hexdigest()


def public_id(key: str) -> str:
    return key[:PUBLIC_ID_LENGTH]


def looks_like_credential(token: str) -> bool:
    return token.startswith(PREFIX)


@dataclass
class _Cached:
    record: CredentialRecord
    cached_at: datetime


class Credentials:
    def __init__(self, store: Store, teams: Sequence[str], now: Callable[[], datetime]) -> None:
        self._store = store
        self._teams = tuple(teams)
        self._now = now
        self._cache: OrderedDict[str, _Cached] = OrderedDict()

    async def authenticate(self, credential: str) -> CredentialRecord | None:
        """The live credential, or None (malformed, unknown, revoked, expired)."""
        if CREDENTIAL_RE.fullmatch(credential) is None:
            return None
        key = credential_key(credential)
        now = self._now()
        hit = self._cache.get(key)
        record: CredentialRecord | None
        if hit is not None and timedelta(0) <= now - hit.cached_at < CREDENTIAL_CACHE_TTL:
            self._cache.move_to_end(key)
            record = hit.record
        else:
            self._cache.pop(key, None)
            record = await self._store.find_credential(self._teams, key)
            if record is None:
                return None
            self._remember(record, now)
        if not record.live(now):
            return None
        if now - record.last_used_at >= LAST_USED_INTERVAL:
            expire_at = now + CREDENTIAL_LIFETIME
            await self._store.touch_credential(record.team, key, now, expire_at)
            record.last_used_at, record.expire_at = now, expire_at
        return record

    def _remember(self, record: CredentialRecord, now: datetime) -> None:
        self._cache[record.key] = _Cached(record=record, cached_at=now)
        self._cache.move_to_end(record.key)
        while len(self._cache) > CACHE_SIZE:
            self._cache.popitem(last=False)

    def forget(self, keys: Sequence[str]) -> None:
        for key in keys:
            self._cache.pop(key, None)

    def forget_member(self, team: str, member: str) -> None:
        stale = [
            key
            for key, cached in self._cache.items()
            if (cached.record.team, cached.record.member) == (team, member)
        ]
        for key in stale:
            del self._cache[key]
