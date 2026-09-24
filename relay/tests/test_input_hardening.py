"""Malformed input is a 4xx, never a 500 (M1-SPEC §11.9), and the body rules the 23 Sep
corrections added: blank questions (§11.3), ack <= answer timeouts (§11.4) and the param
rules at the API (§11.2)."""

from __future__ import annotations

import json

import pytest

from relay.jsonutil import MAX_JSON_DEPTH, BodyError, check_json_value, parse_json

from .conftest import auth
from .helpers import T, ask, capability_body, get, post, publish, question_body, reply, stream

pytestmark = pytest.mark.anyio


def nested(depth: int) -> object:
    """A value that nests ``depth`` containers deep."""
    value: object = 1
    for i in range(depth):
        value = [value] if i % 2 else {"k": value}
    return value


async def raw_post(client, member: str, path: str, content: bytes):
    return await client.post(
        T + path, headers={**auth(member), "Content-Type": "application/json"}, content=content
    )


# The parser, unit level --------------------------------------------------------------------


def test_parse_json_accepts_ordinary_json():
    assert parse_json(b'{"a": [1, 2.5, "x", null, true], "b": "\\ud83d\\ude00"}') == {
        "a": [1, 2.5, "x", None, True],
        "b": "😀",  # an escaped surrogate pair is one code point
    }


@pytest.mark.parametrize(
    "raw",
    [
        b'"\\ud800"',  # an escaped lone high surrogate
        b'"\\udfff"',  # an escaped lone low surrogate
        b'"\\ude00\\ud83d"',  # a pair in the wrong order
        b'{"\\ud800": 1}',  # in a key
        b'["\xed\xa0\x80"]',  # the raw UTF-8-style bytes of a surrogate
    ],
)
def test_parse_json_refuses_lone_surrogates(raw):
    with pytest.raises(BodyError, match="lone surrogate"):
        parse_json(raw)


@pytest.mark.parametrize("raw", [b"1e400", b"[-1e999]", b'{"x": 1E+400}'])
def test_parse_json_refuses_numbers_that_overflow_to_infinity(raw):
    with pytest.raises(ValueError):
        parse_json(raw)


def test_parse_json_depth():
    assert parse_json(json.dumps(nested(MAX_JSON_DEPTH)).encode())
    with pytest.raises(BodyError, match="nests deeper"):
        parse_json(json.dumps(nested(MAX_JSON_DEPTH + 1)).encode())
    with pytest.raises(BodyError, match="nests deeper"):
        parse_json(b"[" * 200_000 + b"]" * 200_000)  # deep enough to exhaust the C parser


def test_check_json_value_is_iterative_and_finds_everything():
    check_json_value({"a": [{"b": "ok"}]})
    with pytest.raises(BodyError):
        check_json_value({"a": [{"b": ["x", "\udc00"]}]})
    with pytest.raises(BodyError):
        check_json_value([1, [2, [float("nan")]]])
    with pytest.raises(BodyError):
        check_json_value({"deep": nested(10)}, max_depth=5)


# Bodies through the API ----------------------------------------------------------------------

MALFORMED = [
    ("lone surrogate in a string", b'"\\ud800"'),
    ("lone surrogate in a key", b'{"\\udc00": 1}'),
    ("raw surrogate bytes", b'{"question": "\xed\xa0\x80"}'),
    ("float overflowing to infinity", b'{"n": 1e400}'),
    ("nesting deeper than the cap", json.dumps(nested(MAX_JSON_DEPTH + 1)).encode()),
    ("nesting deep enough to exhaust the parser", b"[" * 100_000 + b"]" * 100_000),
    ("an integer beyond Python's digit limit", b'{"n": ' + b"9" * 5000 + b"}"),
]


@pytest.mark.parametrize("label, raw", MALFORMED, ids=[m[0] for m in MALFORMED])
async def test_malformed_bodies_are_400_and_audited_on_every_mutation(
    client, memory_store, label, raw
):
    rid = (await ask(client))["request_id"]
    before = len(await memory_store.list_audit("demo"))
    paths = [
        ("alice", "/requests", "request.create"),
        ("bob", f"/requests/{rid}/reply", "request.reply"),
        ("bob", f"/requests/{rid}/progress", "request.progress"),
    ]
    for member, path, _ in paths:
        r = await raw_post(client, member, path, raw)
        assert r.status_code == 400, (path, r.text)
        assert r.json()["error"] == "invalid_json"
    r = await client.put(
        f"{T}/members/bob/manifest",
        headers={**auth("bob"), "Content-Type": "application/json"},
        content=raw,
    )
    assert r.status_code == 400 and r.json()["error"] == "invalid_json"
    # The cursor is bookkeeping: refused like the rest, but not audited (§3.7).
    r = await raw_post(client, "bob", "/streams/inbox/cursor", raw)
    assert r.status_code == 400 and r.json()["error"] == "invalid_json"

    refused = [(a.action, a.detail) for a in (await memory_store.list_audit("demo"))[before:]]
    assert refused == [(action, "400 invalid_json") for _, _, action in paths] + [
        ("manifest.publish", "400 invalid_json")
    ]
    assert (await stream(client, "bob", "inbox"))["head"] == 1  # nothing was created


async def test_valid_surrogate_pairs_are_ordinary_text(client):
    r = await raw_post(
        client,
        "alice",
        "/requests",
        b'{"idempotency_key": "emoji-key-1", "kind": "question", "to": ["bob"],'
        b' "question": "ship it? \\ud83d\\ude80"}',
    )
    assert r.status_code == 201
    [env] = (await stream(client, "bob", "inbox"))["messages"]
    assert env["data"]["question"] == "ship it? 🚀"


async def test_deep_but_allowed_reply_data_is_accepted(client):
    rid = (await ask(client))["request_id"]
    # body (1) > data (2) > nested: exactly MAX_JSON_DEPTH levels in all, then one more.
    r = await reply(client, "bob", rid, data={"k": nested(MAX_JSON_DEPTH - 2)})
    assert r.status_code == 200, r.text
    r = await reply(client, "bob", rid, data={"k": nested(MAX_JSON_DEPTH - 1)})
    assert r.status_code == 400 and r.json()["error"] == "invalid_json"


async def test_huge_integers_are_4xx_everywhere(client, memory_store):
    huge = 10**400
    rid = (await ask(client))["request_id"]
    r = await post(client, "bob", f"/requests/{rid}/progress", {"text": "x", "pct": huge})
    assert r.status_code == 422 and r.json()["error"] == "invalid_body"
    r = await post(client, "alice", "/requests", question_body(ack_timeout_seconds=huge))
    assert r.status_code == 422
    r = await post(client, "bob", "/streams/inbox/cursor", {"acked_seq": huge})
    assert r.status_code == 400 and r.json()["error"] == "beyond_head"
    await publish(client)
    r = await post(
        client, "alice", "/requests", capability_body(params={"dataset": "users", "limit": huge})
    )
    assert r.status_code == 422 and r.json()["error"] == "invalid_params"
    assert "'limit'" in r.json()["detail"]
    r = await reply(client, "bob", rid, data={"big": huge})  # results may carry big integers
    assert r.status_code == 200


@pytest.mark.parametrize("value", ["²", "٣", "①", "1.0", " 1", "0x1", "+1"])
async def test_query_integers_are_ascii_digits_only(client, value):
    for name in ("after", "wait", "limit"):
        r = await get(client, "bob", "/streams/inbox", **{name: value})
        assert r.status_code == 400 and r.json()["error"] == "invalid_query", (name, value)


@pytest.mark.parametrize("declared", ["²", "-1", "1e3", "abc"])
async def test_a_malformed_content_length_is_413_not_500(client, declared):
    r = await client.post(
        f"{T}/requests",
        headers={
            **auth("alice"),
            "Content-Length": declared.encode("latin-1"),
            "Content-Type": "application/json",
        },
        content=b"{}",
    )
    assert r.status_code == 413 and r.json()["error"] == "too_large", r.text


# §11.3 blank questions ------------------------------------------------------------------------


# Built from code points: NBSP, IDEOGRAPHIC SPACE, LINE SEPARATOR, BOM, EN QUAD, HAIR SPACE,
# MEDIUM MATHEMATICAL SPACE (all in JavaScript's trim() set).
BLANKS = [" ", "\n\t \r", chr(0xA0), chr(0x3000) + chr(0x2028), chr(0xFEFF)]
BLANKS.append(chr(0x2000) + chr(0x200A) + chr(0x205F))


@pytest.mark.parametrize("question", BLANKS)
async def test_a_question_of_whitespace_only_is_422(client, memory_store, question):
    r = await post(client, "alice", "/requests", question_body(question=question))
    assert r.status_code == 422 and r.json()["error"] == "invalid_body"
    assert "non-whitespace" in r.json()["detail"]
    assert (await memory_store.list_audit("demo"))[-1].detail == "422 invalid_body"


# ZERO WIDTH SPACE and SOFT HYPHEN are not whitespace to JavaScript's trim() either.
@pytest.mark.parametrize("question", [" x ", chr(0x200B), chr(0xAD), "."])
async def test_a_question_with_any_other_character_is_accepted(client, question):
    r = await post(client, "alice", "/requests", question_body(question=question))
    assert r.status_code == 201, r.text


# §11.4 timeouts -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "timeouts",
    [
        {"ack_timeout_seconds": 600, "answer_timeout_seconds": 300},
        {"ack_timeout_seconds": 3600, "answer_timeout_seconds": 3599},
    ],
)
async def test_ack_timeout_above_answer_timeout_is_422_invalid_timeouts(
    client, memory_store, timeouts
):
    r = await post(client, "alice", "/requests", question_body(**timeouts))
    assert r.status_code == 422 and r.json()["error"] == "invalid_timeouts"
    assert (await memory_store.list_audit("demo"))[-1].detail == "422 invalid_timeouts"
    assert (await stream(client, "bob", "inbox"))["head"] == 0


async def test_an_omitted_ack_timeout_is_capped_by_the_answer_timeout(client):
    created = await ask(client, answer_timeout_seconds=60)
    assert created["ack_deadline"] == created["answer_deadline"]


async def test_an_omitted_ack_timeout_defaults_to_120_seconds(client):
    from datetime import datetime

    created = await ask(client, answer_timeout_seconds=1800)
    ack = datetime.fromisoformat(created["ack_deadline"].replace("Z", "+00:00"))
    answer = datetime.fromisoformat(created["answer_deadline"].replace("Z", "+00:00"))
    assert (answer - ack).total_seconds() == 1800 - 120


async def test_equal_timeouts_are_accepted(client):
    created = await ask(client, ack_timeout_seconds=300, answer_timeout_seconds=300)
    assert created["ack_deadline"] == created["answer_deadline"]


async def test_range_checks_come_before_the_timeout_order(client):
    r = await post(
        client,
        "alice",
        "/requests",
        question_body(ack_timeout_seconds=3601, answer_timeout_seconds=60),
    )
    assert r.status_code == 422 and r.json()["error"] == "invalid_body"


# §11.2 params at the API -----------------------------------------------------------------------


async def test_integral_floats_are_accepted_and_stored_as_integers(client):
    await publish(client)
    r = await post(
        client, "alice", "/requests", capability_body(params={"dataset": "users", "limit": 5.0})
    )
    assert r.status_code == 201, r.text
    [env] = (await stream(client, "bob", "inbox"))["messages"]
    assert env["data"]["params"] == {"dataset": "users", "limit": 5}
    assert type(env["data"]["params"]["limit"]) is int
    rid = r.json()["request_id"]
    body = (await get(client, "alice", f"/requests/{rid}")).json()
    assert body["capability"]["params"] == {"dataset": "users", "limit": 5}


@pytest.mark.parametrize(
    "limit, message",
    [(5.5, "expected an integer"), (2**53 + 1, "2^53"), (1e300, "2^53"), (-(10**30), "2^53")],
)
async def test_non_integral_and_huge_integers_are_422(client, limit, message):
    await publish(client)
    r = await post(
        client, "alice", "/requests", capability_body(params={"dataset": "users", "limit": limit})
    )
    assert r.status_code == 422 and r.json()["error"] == "invalid_params"
    assert "'limit'" in r.json()["detail"] and message in r.json()["detail"]


async def test_request_id_may_not_be_a_param(client):
    manifest = {
        "version": 1,
        "capabilities": [
            {
                "name": "probe",
                "title": "t",
                "description": "d",
                "environment": "staging",
                "params": {
                    "request_id": {
                        "type": "string",
                        "max_length": 40,
                        "pattern": "^rq_[0-9a-f]{32}$",
                        "description": "d",
                    }
                },
            }
        ],
    }
    r = await client.put(f"{T}/members/bob/manifest", headers=auth("bob"), json=manifest)
    assert r.status_code == 422 and "reserved" in r.json()["detail"]
