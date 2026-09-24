"""Time: one injectable clock and one RFC 3339 format.

Times are truncated to whole milliseconds when read from the clock, so a value survives a
round trip through either store unchanged and prints the same way everywhere.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

Clock = Callable[[], datetime]


def truncate_ms(value: datetime) -> datetime:
    """Return ``value`` as an aware UTC datetime with whole milliseconds."""
    if value.tzinfo is None:
        raise ValueError("naive datetime")
    value = value.astimezone(UTC)
    return datetime(
        value.year,
        value.month,
        value.day,
        value.hour,
        value.minute,
        value.second,
        (value.microsecond // 1000) * 1000,
        tzinfo=UTC,
    )


def utc_now() -> datetime:
    return truncate_ms(datetime.now(UTC))


def format_time(value: datetime | None) -> str | None:
    """RFC 3339 UTC with a ``Z`` suffix and millisecond precision."""
    if value is None:
        return None
    value = value.astimezone(UTC)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"
