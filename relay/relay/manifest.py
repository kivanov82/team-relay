"""Capability manifests: schema validation, the relay-side checks of M1-SPEC §3.3, and the
parameter validation of §3.5 (with defaults filled in), as corrected on 23 Sep 2026 (§11.1,
§11.2).

The same rules run in the plugin (plugin/src/manifest.ts); this module is the relay's copy.
Teammate-published patterns are only ever evaluated by RE2 (``google-re2``), which runs in
linear time, so no manifest can stall the relay's event loop.
"""

from __future__ import annotations

import functools
import math
import re
from collections.abc import Mapping
from typing import Any

import jsonschema
import re2
from jsonschema.validators import validator_for

from .jsonutil import has_lone_surrogate

MAX_PATTERN_LENGTH = 300
# Integers and numbers are exact on both sides (Python and JavaScript) only within ±2^53.
MAX_SAFE_MAGNITUDE = 2**53
RESERVED_PARAMS = frozenset({"request_id"})

_RE2_OPTIONS = re2.Options()
_RE2_OPTIONS.log_errors = False  # a bad teammate pattern is a 422, not a line on stderr


class ManifestError(ValueError):
    """The manifest is not acceptable; the message is the human detail."""


class ParamsError(ValueError):
    """Capability params are not acceptable; the message names the first failing param."""


def _is_anchored(pattern: str) -> bool:
    """``^`` first and an unescaped ``$`` last (``^a\\$`` ends in a literal dollar)."""
    if not pattern.startswith("^") or not pattern.endswith("$"):
        return False
    backslashes = len(pattern[:-1]) - len(pattern[:-1].rstrip("\\"))
    return backslashes % 2 == 0


def _uses_any_byte(pattern: str) -> bool:
    """RE2's ``\\C`` matches one byte, not one character: it can split a UTF-8 sequence and
    has no equivalent in the plugin's engine, so it is refused."""
    i = 0
    while i < len(pattern):
        if pattern[i] == "\\":
            if pattern[i + 1 : i + 2] == "C":
                return True
            i += 2
        else:
            i += 1
    return False


@functools.lru_cache(maxsize=256)
def compile_pattern(pattern: str) -> Any:
    """Compile a manifest pattern with RE2, or raise :class:`ManifestError`."""
    if len(pattern) > MAX_PATTERN_LENGTH:
        raise ManifestError(f"pattern is longer than {MAX_PATTERN_LENGTH} characters")
    if has_lone_surrogate(pattern):
        raise ManifestError("pattern contains a lone surrogate")
    if not _is_anchored(pattern):
        raise ManifestError("pattern must be anchored ^...$")
    if _uses_any_byte(pattern):
        raise ManifestError("pattern uses \\C, which is not allowed")
    try:
        return re2.compile(pattern, _RE2_OPTIONS)
    except Exception:  # re2.error, and anything else the binding raises on odd input
        raise ManifestError("pattern does not compile in RE2") from None


def _number(name: str, value: Any, kind: str) -> int | float:
    """A JSON number within ±2^53; for ``integer`` it must be integral and comes back an int."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        expected = "an integer" if kind == "integer" else "a number"
        raise ParamsError(f"param '{name}': expected {expected}")
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ParamsError(f"param '{name}': expected a finite number")
        if kind == "integer" and not value.is_integer():
            raise ParamsError(f"param '{name}': expected an integer")
    if abs(value) > MAX_SAFE_MAGNITUDE:  # int or finite float: no overflow either way
        raise ParamsError(f"param '{name}': magnitude beyond 2^53")
    if kind == "integer":
        return int(value)
    return value


def _check_value(name: str, spec: Mapping[str, Any], value: Any) -> Any:
    """Return ``value`` (normalised) if it satisfies the param ``spec``, else raise
    :class:`ParamsError`."""
    kind = spec["type"]
    if kind == "enum":
        if not isinstance(value, str):
            raise ParamsError(f"param '{name}': expected one of the enum values")
        if value not in spec["values"]:
            raise ParamsError(f"param '{name}': not one of the allowed values")
        return value
    if kind == "string":
        if not isinstance(value, str):
            raise ParamsError(f"param '{name}': expected a string")
        if has_lone_surrogate(value):
            raise ParamsError(f"param '{name}': contains a lone surrogate")
        if len(value) > spec["max_length"]:  # code points: a str with no surrogates
            raise ParamsError(f"param '{name}': longer than max_length {spec['max_length']}")
        try:
            compiled = compile_pattern(spec["pattern"])
        except ManifestError:
            raise ParamsError(f"param '{name}': its pattern is not usable") from None
        if compiled.fullmatch(value) is None:
            raise ParamsError(f"param '{name}': does not match the allowed pattern")
        return value
    if kind in ("integer", "number"):
        number = _number(name, value, kind)
        _check_range(name, spec, number)
        return number
    if kind == "boolean":
        if not isinstance(value, bool):
            raise ParamsError(f"param '{name}': expected a boolean")
        return value
    raise ParamsError(f"param '{name}': unknown type")  # pragma: no cover - schema admits none


def _check_range(name: str, spec: Mapping[str, Any], value: int | float) -> None:
    if value < spec["min"]:
        raise ParamsError(f"param '{name}': below min {spec['min']}")
    if value > spec["max"]:
        raise ParamsError(f"param '{name}': above max {spec['max']}")


def validate_params(capability: Mapping[str, Any], params: Mapping[str, Any]) -> dict[str, Any]:
    """Validate ``params`` against one manifest capability; return them normalised (integral
    numbers for ``integer`` params become ints) with defaults filled.

    Order of checks, so "the first failing param" is well defined: unknown keys in the
    order given, then each declared param in manifest order (missing-and-required, then
    its value).
    """
    declared: Mapping[str, Any] = capability.get("params", {})
    for key in params:
        if key not in declared:
            shown = key if not has_lone_surrogate(key) else "(invalid text)"
            raise ParamsError(f"param '{shown}': not a parameter of {capability['name']}")
    required = set(capability.get("required", []))
    out: dict[str, Any] = {}
    for name, spec in declared.items():
        if name in params:
            out[name] = _check_value(name, spec, params[name])
        elif "default" in spec:
            out[name] = _check_value(name, spec, spec["default"])
        elif name in required:
            raise ParamsError(f"param '{name}': required")
    return out


def _contains_lone_surrogate(value: Any) -> bool:
    stack = [value]
    while stack:
        node = stack.pop()
        if isinstance(node, str):
            if has_lone_surrogate(node):
                return True
        elif isinstance(node, dict):
            stack.extend(node.keys())
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return False


@functools.lru_cache(maxsize=64)
def _schema_regex(pattern: str) -> re.Pattern[str]:
    """A schema ``pattern`` with JSON Schema's (ECMA-262) meaning of a final ``$``: the end of
    the string. Python's ``$`` also matches before a trailing newline, so ``"name\\n"`` would
    pass ``^[a-z]+$``; the plugin's validator (ajv) refuses it. These patterns are the relay's
    own schema, never a teammate's."""
    if _is_anchored(pattern):
        pattern = pattern[:-1] + r"\Z"
    return re.compile(pattern)


def _pattern_keyword(validator: Any, pattern: str, instance: Any, schema: Any) -> Any:
    if validator.is_type(instance, "string") and not _schema_regex(pattern).search(instance):
        yield jsonschema.ValidationError(f"{instance!r} does not match {pattern!r}")


class ManifestValidator:
    def __init__(self, schema: Mapping[str, Any]) -> None:
        cls = validator_for(schema)
        cls.check_schema(schema)
        cls = jsonschema.validators.extend(cls, {"pattern": _pattern_keyword})
        self._validator = cls(schema)

    def validate(self, manifest: Any) -> list[str]:
        """Return the capability names, or raise :class:`ManifestError`."""
        if _contains_lone_surrogate(manifest):
            raise ManifestError("the manifest contains a lone surrogate")
        errors = sorted(self._validator.iter_errors(manifest), key=jsonschema.exceptions.relevance)
        if errors:
            err = errors[0]
            where = "/".join(str(p) for p in err.absolute_path) or "(root)"
            raise ManifestError(f"schema: at {where}: {err.message}"[:500])

        names: list[str] = []
        for cap in manifest["capabilities"]:
            name = cap["name"]
            if name in names:
                raise ManifestError(f"capability '{name}': name used twice")
            names.append(name)
            params: Mapping[str, Any] = cap["params"]
            for pname, spec in params.items():
                where = f"capability '{name}' param '{pname}'"
                if pname in RESERVED_PARAMS:
                    raise ManifestError(f"{where}: '{pname}' is a reserved name")
                if spec["type"] == "string":
                    try:
                        compile_pattern(spec["pattern"])
                    except ManifestError as exc:
                        raise ManifestError(f"{where}: {exc}") from None
                if spec["type"] in ("integer", "number") and spec["min"] > spec["max"]:
                    raise ManifestError(f"{where}: min is greater than max")
                if "default" in spec:
                    try:
                        _check_value(pname, spec, spec["default"])
                    except ParamsError:
                        msg = f"{where}: default does not satisfy the param"
                        raise ManifestError(msg) from None
            for req in cap.get("required", []):
                if req not in params:
                    raise ManifestError(f"capability '{name}': required '{req}' is not a param")
                if "default" in params[req]:
                    raise ManifestError(
                        f"capability '{name}': required '{req}' may not declare a default"
                    )
        # M4-SPEC §3: share names are unique, compared exactly (case-sensitive). The schema's
        # uniqueItems already refuses equal entries; this names the share that repeats.
        shares: list[str] = []
        for share in manifest.get("shares", []):
            if share["name"] in shares:
                raise ManifestError(f"share '{share['name']}': name used twice")
            shares.append(share["name"])
        return names


def find_capability(manifest: Mapping[str, Any] | None, name: str) -> Mapping[str, Any] | None:
    if not manifest:
        return None
    for cap in manifest.get("capabilities", []):
        if cap.get("name") == name:
            return cap
    return None
