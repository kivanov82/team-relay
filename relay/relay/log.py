"""Structured stdout logging: one JSON object per line, Cloud Logging compatible.

Nothing here ever receives a bearer token, a question, an answer or a manifest body; the
callers pass identifiers and reason codes only.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from .clock import format_time, utc_now


def log_event(event: str, severity: str = "INFO", **fields: Any) -> None:
    record = {"severity": severity, "event": event, "time": format_time(utc_now()), **fields}
    sys.stdout.write(json.dumps(record, sort_keys=True, default=str) + "\n")
    sys.stdout.flush()
