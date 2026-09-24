"""Request bodies (M1-SPEC §3). Strict, and ``extra="forbid"``: a body that carries ``from``,
``sender`` or any other field the contract does not name is refused, so the envelope's
``from`` can only ever be the relay-resolved member (§2)."""

from __future__ import annotations

import math
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from .jsonutil import canonical_json

IdempotencyKey = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.:-]{8,128}$")]
Identifier = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{1,62}$")]

MAX_REPLY_DATA_BYTES = 64 * 1024

# JavaScript's String.prototype.trim() set (WhiteSpace and LineTerminator), so "has a
# non-whitespace character" reads the same here and in the plugin (M1-SPEC §11.3).
JS_WHITESPACE = frozenset(
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007"
    "\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def is_blank(text: str) -> bool:
    return all(ch in JS_WHITESPACE for ch in text)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CapabilityCall(StrictModel):
    name: Identifier
    params: dict[str, Any] = Field(default_factory=dict)


DEFAULT_ACK_TIMEOUT = 120


class CreateRequestBody(StrictModel):
    idempotency_key: IdempotencyKey
    kind: Literal["question", "capability"]
    to: Literal["*"] | Annotated[list[str], Field(max_length=64)]
    question: Annotated[str, StringConstraints(min_length=1, max_length=8000)] | None = None
    capability: CapabilityCall | None = None
    # Lower bounds come from the team config and upper bounds are checked beside them in
    # the service, so the whole range check reads in one place.
    # Omitted, the ack timeout is 120 s or the answer timeout if that is shorter, so a
    # request that only shortens the answer window stays valid (§11.4).
    ack_timeout_seconds: int | None = None
    answer_timeout_seconds: int = 1800
    ttl_seconds: int = 604800

    @model_validator(mode="after")
    def _default_ack_timeout(self) -> Self:
        if self.ack_timeout_seconds is None:
            self.ack_timeout_seconds = min(DEFAULT_ACK_TIMEOUT, self.answer_timeout_seconds)
        return self

    @model_validator(mode="after")
    def _kind_matches_payload(self) -> Self:
        if self.kind == "question":
            if self.question is None or self.capability is not None:
                raise ValueError("kind=question needs 'question' and no 'capability'")
            if is_blank(self.question):
                raise ValueError("'question' must contain a non-whitespace character")
        else:
            if self.capability is None or self.question is not None:
                raise ValueError("kind=capability needs 'capability' and no 'question'")
        return self


class CursorBody(StrictModel):
    acked_seq: Annotated[int, Field(ge=0)]


class ReplyBody(StrictModel):
    idempotency_key: IdempotencyKey
    text: Annotated[str, StringConstraints(min_length=1, max_length=32000)]
    data: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _data_is_bounded_json(self) -> Self:
        if self.data is not None:
            try:
                size = len(canonical_json(self.data).encode("utf-8"))
            except (TypeError, ValueError):
                raise ValueError("data is not JSON") from None
            if size > MAX_REPLY_DATA_BYTES:
                raise ValueError("data exceeds 64 KiB serialized")
        return self


class ProgressBody(StrictModel):
    text: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
    pct: int | float | None = None

    @model_validator(mode="after")
    def _pct_in_range(self) -> Self:
        if self.pct is not None:
            # isfinite only on floats: a huge int would overflow converting to float.
            if isinstance(self.pct, bool) or (
                isinstance(self.pct, float) and not math.isfinite(self.pct)
            ):
                raise ValueError("pct must be a number")
            if not 0 <= self.pct <= 100:
                raise ValueError("pct must be within 0..100")
        return self


MAX_TOOL_DURATION_MS = 3_600_000


class ToolEventBody(StrictModel):
    """M2-SPEC §3.3: the name, the outcome and the duration of one tool use. Never its input,
    output or path; ``extra="forbid"`` refuses any attempt to send more."""

    tool: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.:-]{1,64}$")]
    status: Literal["ok", "error"]
    duration_ms: Annotated[int, Field(ge=0, le=MAX_TOOL_DURATION_MS)] | None = None
