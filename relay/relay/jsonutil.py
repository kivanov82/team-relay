"""Canonical JSON and hashing, shared by idempotency, audit and size limits; and the strict
body parser every request body goes through (M1-SPEC §11.9: malformed input is a 4xx)."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

# Deeper than any body the contract describes (a capability result is the deepest, and
# 64 levels is generous for it), shallow enough that nothing downstream (validation, deep
# copies, encoders) can run out of stack.
MAX_JSON_DEPTH = 64


class BodyError(ValueError):
    """The body is not acceptable JSON; the message is the human detail."""


def canonical_json(value: Any) -> str:
    """Sorted keys, no whitespace, UTF-8 text, and no NaN or Infinity (they are not JSON)."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def content_digest(value: Any) -> tuple[str, int]:
    """``(sha256 hex, length in UTF-8 bytes)`` of a string, or of a value's canonical JSON."""
    text = value if isinstance(value, str) else canonical_json(value)
    data = text.encode("utf-8")
    return hashlib.sha256(data).hexdigest(), len(data)


def has_lone_surrogate(text: str) -> bool:
    """True when ``text`` holds a UTF-16 surrogate code point, which no UTF-8 text can carry
    (JSON's ``\\ud800`` escapes and Python's ``surrogatepass`` decoding both produce them)."""
    if text.isascii():
        return False
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return True
    return False


def check_json_value(value: Any, max_depth: int = MAX_JSON_DEPTH) -> None:
    """Raise :class:`BodyError` unless every string (keys included) is well-formed Unicode,
    every float is finite and nothing nests deeper than ``max_depth``. Iterative, so the
    check itself cannot exhaust the stack."""
    stack: list[tuple[Any, int]] = [(value, 1)]
    while stack:
        node, depth = stack.pop()
        if isinstance(node, str):
            if has_lone_surrogate(node):
                raise BodyError("The body contains a lone surrogate, which is not valid text.")
        elif isinstance(node, float):
            if not math.isfinite(node):
                raise BodyError("The body contains a number that is not finite.")
        elif isinstance(node, dict | list):
            if depth > max_depth:
                raise BodyError(f"The body nests deeper than {max_depth} levels.")
            if isinstance(node, dict):
                for key, item in node.items():
                    stack.append((key, depth))
                    stack.append((item, depth + 1))
            else:
                stack.extend((item, depth + 1) for item in node)


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


def _parse_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):  # 1e400 parses to inf; it is not a JSON number we accept
        raise ValueError("number out of range")
    return value


def parse_json(raw: bytes) -> Any:
    """Parse strict JSON: NaN, Infinity and out-of-range numbers are refused (``ValueError``);
    so are lone surrogates and nesting deeper than :data:`MAX_JSON_DEPTH` (:class:`BodyError`).
    Integers are capped by Python's own digit limit (a ``ValueError`` beyond it)."""
    try:
        value = json.loads(raw, parse_constant=_reject_constant, parse_float=_parse_float)
    except RecursionError:
        raise BodyError(f"The body nests deeper than {MAX_JSON_DEPTH} levels.") from None
    check_json_value(value)
    return value
