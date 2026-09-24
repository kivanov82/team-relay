// The M1 gate (M1-SPEC §9): seven scenarios against a real relay on the Firestore emulator,
// driving the bundled servers over stdio the way Claude Code would. Run through
// scripts/e2e.sh (it sets E2E=1, RELAY_URL and the E2E_TOKEN_* values); `pnpm test` never
// includes this directory.
//
// Scenarios run in order and share the member processes. They stay out of each other's
// way by correlating on request_id, and a ledger records every notification each scenario
// expects; the last test checks that every member received exactly the ledger, once.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOB_CAPABILITIES,
  ENABLED,
  MESSAGE_ID_RE,
  META_KEY_RE,
  Party,
  REQUEST_ID_RE,
  api,
  channelEnv,
  idempotencyKey,
  relayUrl,
  sleep,
  streamPosition,
  teamPath,
  tokenOf,
  until,
  type Member,
  type Note,
} from './harness.js';

/** Long enough for a stray second delivery to show up: a long poll re-reads the store every second. */
const SETTLE_MS = 2500;
/** A delivery normally takes about a second (the relay's store poll); allow for a slow machine. */
const DELIVERY_MS = 10_000;

let alice: Party; // the working session (asker); replaced in scenario 5
let bob: Party; // bob's answering session (answerer)
let carol: Party; // carol's answering session (answerer)
let bobCaps: Party; // bob's capability server
const aliceProcesses: Party[] = [];
let broadcastRequestId = ''; // scenario 2's broadcast question, reused by scenario 3's binding checks

// member -> the notifications that member's session is expected to receive, as
// "request_id type sender-or-member"; compared against what actually arrived at the end.
const ledger: Record<Member, string[]> = { alice: [], bob: [], carol: [] };
const expectNote = (member: Member, requestId: string, type: string, who: string) =>
  ledger[member].push(`${requestId} ${type} ${who}`);
const noteKey = (n: Note) => `${n.meta.request_id} ${n.meta.type} ${n.meta.from ?? n.meta.member}`;

function checkMeta(n: Note, keys: string[]) {
  expect(Object.keys(n.meta).sort()).toEqual([...keys].sort());
  for (const [k, v] of Object.entries(n.meta)) {
    expect(k).toMatch(META_KEY_RE);
    expect(typeof v).toBe('string');
  }
  expect(n.meta.message_id).toMatch(MESSAGE_ID_RE);
  expect(n.meta.request_id).toMatch(REQUEST_ID_RE);
}

const QUESTION_META = ['type', 'request_id', 'from', 'message_id', 'ack_deadline', 'broadcast'];
const CAPABILITY_META = [...QUESTION_META, 'capability'];
const ANSWER_META = ['type', 'request_id', 'from', 'message_id'];
const NOTICE_META = ['type', 'request_id', 'member', 'message_id'];

async function startAlice(): Promise<Party> {
  const p = await Party.start(`alice#${aliceProcesses.length + 1}`, 'channel.js', channelEnv('alice', 'asker'));
  aliceProcesses.push(p);
  return p;
}

const aliceNotes = () => aliceProcesses.flatMap((p) => p.notes);

/** Wait until the relay says `member` has acked everything in `stream` (cursor at head). */
async function drained(member: Member, stream: 'inbox' | 'replies') {
  return until(
    async () => {
      const pos = await streamPosition(member, stream);
      return pos.cursor === pos.head ? pos : null;
    },
    DELIVERY_MS,
    `${member}'s ${stream} cursor to reach its head`,
  );
}

/** The answering side's part in a question: ack, then reply once. */
async function answer(party: Party, requestId: string, text: string, data?: Record<string, unknown>) {
  expect(await party.ok('ack_question', { request_id: requestId })).toEqual({ status: 'acked' });
  const res = await party.ok('reply', { request_id: requestId, text, ...(data ? { data } : {}) });
  expect(res.status).toBe('answered');
  expect(res.message_id).toMatch(MESSAGE_ID_RE);
  return res.message_id as string;
}

describe.skipIf(!ENABLED)('M1 end to end (relay + Firestore emulator + bundled servers)', () => {
  beforeAll(async () => {
    const health = await fetch(new URL('/healthz', relayUrl()));
    expect(health.status).toBe(200);
    // Answerers first: their startup publishes the discovery payload (bob: staging_db_query).
    [bob, carol] = await Promise.all([
      Party.start('bob', 'channel.js', channelEnv('bob', 'answerer', BOB_CAPABILITIES)),
      Party.start('carol', 'channel.js', channelEnv('carol', 'answerer')),
    ]);
    bobCaps = await Party.start('bob-capabilities', 'capabilities.js', {
      RELAY_URL: relayUrl(),
      RELAY_TEAM: 'demo',
      RELAY_TOKEN: tokenOf('bob'),
      ...BOB_CAPABILITIES,
    });
    alice = await startAlice();
  });

  afterAll(async () => {
    await Promise.all([...aliceProcesses, bob, carol, bobCaps].filter(Boolean).map((p) => p.close()));
  });

  it('0. the servers are what Claude Code expects: channel capability only, the right tools, discovery published', async () => {
    for (const p of [alice, bob, carol]) {
      const caps = p.client.getServerCapabilities();
      expect(caps?.experimental).toEqual({ 'claude/channel': {} });
      expect(JSON.stringify(caps)).not.toContain('permission');
    }
    const askerTools = (await alice.client.listTools()).tools.map((t) => t.name).sort();
    expect(askerTools).toEqual(['ask_question', 'invoke_capability', 'list_teammates', 'request_status']);
    const answererTools = (await bob.client.listTools()).tools.map((t) => t.name).sort();
    expect(answererTools).toEqual(['ack_question', 'reply']);
    expect((await bobCaps.client.listTools()).tools.map((t) => t.name)).toEqual(['staging_db_query']);
    expect(bobCaps.client.getServerCapabilities()?.experimental).toBeUndefined();

    const dir = await alice.ok('list_teammates', {});
    const teammates = dir.teammates as Array<{ member: string; capabilities: Array<{ name: string }> }>;
    expect(teammates.map((t) => t.member).sort()).toEqual(['bob', 'carol']);
    expect(teammates.find((t) => t.member === 'bob')!.capabilities.map((c) => c.name)).toEqual(['staging_db_query']);
    expect(teammates.find((t) => t.member === 'carol')!.capabilities).toEqual([]);
  });

  it('1. directed question: alice asks bob, bob acks and replies, alice gets the answer with the same request_id', async () => {
    const asked = await alice.ok('ask_question', { to: ['bob'], question: 'Which staging region are we on?' });
    const requestId = asked.request_id as string;
    expect(requestId).toMatch(REQUEST_ID_RE);
    expect(asked.recipients).toEqual(['bob']);
    expectNote('bob', requestId, 'question', 'alice');
    expectNote('alice', requestId, 'answer', 'bob');

    const q = await bob.waitNote((n) => n.meta.request_id === requestId, DELIVERY_MS, 'the question');
    checkMeta(q, QUESTION_META);
    expect(q.meta).toMatchObject({ type: 'question', request_id: requestId, from: 'alice', broadcast: 'false' });
    expect(Date.parse(q.meta.ack_deadline!)).toBeGreaterThan(Date.now());
    expect(q.content).toBe('Which staging region are we on?');

    const messageId = await answer(bob, requestId, 'Staging runs in europe-west3.');

    const a = await alice.waitNote((n) => n.meta.request_id === requestId, DELIVERY_MS, 'the answer');
    checkMeta(a, ANSWER_META);
    expect(a.meta).toEqual({ type: 'answer', request_id: requestId, from: 'bob', message_id: messageId });
    expect(a.content).toBe('Staging runs in europe-west3.');

    const status = await alice.ok('request_status', { request_id: requestId });
    expect(status).toMatchObject({ request_id: requestId, kind: 'question', asker: 'alice', broadcast: false });
    expect((status.recipients as Record<string, { status: string }>).bob!.status).toBe('answered');
    expect(carol.forRequest(requestId)).toEqual([]);
  });

  it('2. broadcast: bob answers, carol never acks, alice gets the answer and a no_response, then carol\'s late reply', async () => {
    const ackTimeout = 5; // the team config allows down to 2; 5 leaves bob time to ack on a slow machine
    const asked = await alice.ok('ask_question', {
      to: '*',
      question: 'Has anyone changed the staging schema this week?',
      ack_timeout_seconds: ackTimeout,
    });
    const requestId = asked.request_id as string;
    broadcastRequestId = requestId;
    expect([...(asked.recipients as string[])].sort()).toEqual(['bob', 'carol']);
    const status0 = await alice.ok('request_status', { request_id: requestId });
    const ackDeadline = Date.parse(status0.ack_deadline as string);
    expectNote('bob', requestId, 'question', 'alice');
    expectNote('carol', requestId, 'question', 'alice');
    expectNote('alice', requestId, 'answer', 'bob');
    expectNote('alice', requestId, 'no_response', 'carol');
    expectNote('alice', requestId, 'answer', 'carol');

    const [qb, qc] = await Promise.all([
      bob.waitNote((n) => n.meta.request_id === requestId, DELIVERY_MS, 'the broadcast'),
      carol.waitNote((n) => n.meta.request_id === requestId, DELIVERY_MS, 'the broadcast'),
    ]);
    for (const q of [qb, qc]) {
      checkMeta(q, QUESTION_META);
      expect(q.meta).toMatchObject({ type: 'question', request_id: requestId, from: 'alice', broadcast: 'true' });
    }
    expect(qb.meta.message_id).not.toBe(qc.meta.message_id);

    // bob acks before the ack deadline and answers; carol does nothing.
    expect(Date.now()).toBeLessThan(ackDeadline);
    const bobMessage = await answer(bob, requestId, 'No schema changes from me.');

    const bobAnswer = await alice.waitNote(
      (n) => n.meta.request_id === requestId && n.meta.type === 'answer' && n.meta.from === 'bob',
      DELIVERY_MS,
      "bob's answer",
    );
    expect(bobAnswer.meta.message_id).toBe(bobMessage);

    const notice = await alice.waitNote(
      (n) => n.meta.request_id === requestId && n.meta.type === 'no_response',
      ackTimeout * 1000 + DELIVERY_MS,
      "the no_response notice for carol",
    );
    checkMeta(notice, NOTICE_META);
    expect(notice.meta).toMatchObject({ type: 'no_response', request_id: requestId, member: 'carol' });
    expect(notice.content).toBe('No response yet from carol.');
    expect(notice.at).toBeGreaterThanOrEqual(ackDeadline);
    const recipients1 = (await alice.ok('request_status', { request_id: requestId })).recipients as Record<string, { status: string }>;
    expect(recipients1.bob!.status).toBe('answered');
    expect(recipients1.carol!.status).toBe('no_response');

    // carol's late reply (no ack first) is still delivered.
    const late = await carol.ok('reply', { request_id: requestId, text: 'Sorry, late: I added an index on orders.' });
    expect(late.status).toBe('answered');
    const carolAnswer = await alice.waitNote(
      (n) => n.meta.request_id === requestId && n.meta.type === 'answer' && n.meta.from === 'carol',
      DELIVERY_MS,
      "carol's late answer",
    );
    checkMeta(carolAnswer, ANSWER_META);
    expect(carolAnswer.meta.message_id).toBe(late.message_id);
    expect(carolAnswer.content).toBe('Sorry, late: I added an index on orders.');
    const recipients2 = (await alice.ok('request_status', { request_id: requestId })).recipients as Record<string, { status: string }>;
    expect(recipients2.carol!.status).toBe('answered');

    // bob answered before his deadlines: never a notice about bob.
    expect(alice.forRequest(requestId).filter((n) => n.meta.member === 'bob')).toEqual([]);
  });

  it('3. capability: bob runs staging_db_query bound to its request, progress stays on the side surface, alice gets exactly one answer', async () => {
    const aliceBefore = alice.notes.length;
    const replies0 = await drained('alice', 'replies');

    const invoked = await alice.ok('invoke_capability', {
      member: 'bob',
      capability: 'staging_db_query',
      params: { dataset: 'orders', limit: 5 },
    });
    const requestId = invoked.request_id as string;
    expect(requestId).toMatch(REQUEST_ID_RE);
    expectNote('bob', requestId, 'capability_call', 'alice');
    expectNote('alice', requestId, 'answer', 'bob');

    const call = await bob.waitNote((n) => n.meta.request_id === requestId, DELIVERY_MS, 'the capability call');
    checkMeta(call, CAPABILITY_META);
    expect(call.meta).toMatchObject({
      type: 'capability_call',
      request_id: requestId,
      from: 'alice',
      capability: 'staging_db_query',
      broadcast: 'false',
    });
    const prefix = 'alice asks you to run staging_db_query with ';
    expect(call.content.startsWith(prefix)).toBe(true);
    const params = JSON.parse(call.content.slice(prefix.length)) as Record<string, unknown>;
    // The relay stored the params with the manifest's defaults filled (op defaults to eq).
    expect(params).toEqual({ dataset: 'orders', op: 'eq', limit: 5 });

    // Playing the answering Claude: ack, run the capability tool with exactly the params, reply.
    expect(await bob.ok('ack_question', { request_id: requestId })).toEqual({ status: 'acked' });

    // The capability server binds a run to its request at the relay (§11.10): other params, or
    // a broadcast question's request_id, are refused and no runner starts (no progress below).
    const otherParams = await bobCaps.call('staging_db_query', { ...params, limit: 6, request_id: requestId });
    expect(otherParams.isError).toBe(true);
    expect(otherParams.text).toMatch(/params differ/);
    expect(broadcastRequestId).toMatch(REQUEST_ID_RE);
    const forBroadcast = await bobCaps.call('staging_db_query', { ...params, request_id: broadcastRequestId });
    expect(forBroadcast.isError).toBe(true);
    expect(forBroadcast.text).toMatch(/not a capability request/);

    const run = await bobCaps.call('staging_db_query', { ...params, request_id: requestId });
    expect(run.isError, run.text).toBe(false);
    const result = run.json;
    expect(result).toMatchObject({ capability: 'staging_db_query', request_id: requestId, dataset: 'orders', row_count: 3 });

    // The runner's progress is on the side surface...
    const status = await alice.ok('request_status', { request_id: requestId });
    expect((status.recipients as Record<string, { status: string }>).bob!.status).toBe('acked');
    const progress = status.progress as Array<{ seq: number; member: string; text: string; pct: number }>;
    expect(progress.map(({ seq, member, text, pct }) => ({ seq, member, text, pct }))).toEqual([
      { seq: 1, member: 'bob', text: 'connecting to the fake staging database', pct: 10 },
      { seq: 2, member: 'bob', text: 'reading rows', pct: 60 },
    ]);
    // ...and never in alice's session: nothing pushed, nothing written to her replies stream.
    await sleep(SETTLE_MS);
    expect(alice.notes.length).toBe(aliceBefore);
    expect(await streamPosition('alice', 'replies')).toEqual(replies0);

    const messageId = await answer(bob, requestId, 'Three orders rows from staging.', result);
    const a = await alice.waitNote((n) => n.meta.request_id === requestId, DELIVERY_MS, 'the capability answer');
    checkMeta(a, ANSWER_META);
    expect(a.meta).toEqual({ type: 'answer', request_id: requestId, from: 'bob', message_id: messageId });
    const [text, json] = a.content.split('\n\n');
    expect(text).toBe('Three orders rows from staging.');
    expect(JSON.parse(json!)).toEqual(result);

    // Answered: the capability server will not run it again.
    const again = await bobCaps.call('staging_db_query', { ...params, request_id: requestId });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already been answered/);
    expect(((await alice.ok('request_status', { request_id: requestId })).progress as unknown[]).length).toBe(2);

    await sleep(SETTLE_MS);
    expect(alice.forRequest(requestId)).toHaveLength(1);
    expect(alice.notes.length).toBe(aliceBefore + 1);
    expect(bobCaps.notes).toEqual([]);
  });

  it('4. params outside the manifest are refused by the asker tool before sending, and by the relay (422)', async () => {
    const bobInbox0 = await drained('bob', 'inbox');
    const bobNotes0 = bob.notes.length;
    const bad: Array<[string, Record<string, unknown>]> = [
      ['limit', { dataset: 'users', limit: 500 }],
      ['dataset', { dataset: 'payroll' }],
      ['where', { dataset: 'users', where: '1=1' }],
    ];

    for (const [param, params] of bad) {
      const r = await alice.call('invoke_capability', { member: 'bob', capability: 'staging_db_query', params });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^invalid params: /);
      expect(r.text).toContain(param);
    }

    for (const [param, params] of bad) {
      const r = await api(tokenOf('alice'), 'POST', teamPath('requests'), {
        idempotency_key: idempotencyKey(),
        kind: 'capability',
        to: ['bob'],
        capability: { name: 'staging_db_query', params },
      });
      expect(r.status).toBe(422);
      expect(r.body.error).toBe('invalid_params');
      expect(String(r.body.detail)).toContain(param);
    }

    // Nothing reached bob: no envelope in his inbox, nothing pushed into his session.
    await sleep(SETTLE_MS);
    expect(await streamPosition('bob', 'inbox')).toEqual(bobInbox0);
    expect(bob.notes.length).toBe(bobNotes0);
  });

  it('5. resume: alice\'s channel dies before the answer lands; a new process delivers it once, from the stored cursor', async () => {
    const asked = await alice.ok('ask_question', { to: ['bob'], question: 'Is the nightly staging refresh done?' });
    const requestId = asked.request_id as string;
    expectNote('bob', requestId, 'question', 'alice');
    expectNote('alice', requestId, 'answer', 'bob');
    await bob.waitNote((n) => n.meta.request_id === requestId, DELIVERY_MS, 'the question');

    // Everything alice was sent so far is acked, then her working session's channel crashes.
    const before = await drained('alice', 'replies');
    const dead = alice;
    await dead.crash();

    const messageId = await answer(bob, requestId, 'Yes, it finished at 04:10.');
    // The answer is stored in alice's replies stream, past her cursor, and nobody has it yet.
    const stored = await streamPosition('alice', 'replies');
    expect(stored).toEqual({ cursor: before.cursor, head: before.head + 1 });

    alice = await startAlice();
    const a = await alice.waitNote((n) => n.meta.request_id === requestId, DELIVERY_MS, 'the resumed answer');
    checkMeta(a, ANSWER_META);
    expect(a.meta).toEqual({ type: 'answer', request_id: requestId, from: 'bob', message_id: messageId });
    expect(a.content).toBe('Yes, it finished at 04:10.');

    // Exactly once: the new process replays nothing older, and nothing twice.
    await sleep(SETTLE_MS);
    expect(alice.notes.map(noteKey)).toEqual([`${requestId} answer bob`]);
    expect(dead.forRequest(requestId)).toEqual([]);
    expect(await drained('alice', 'replies')).toEqual({ cursor: before.head + 1, head: before.head + 1 });
  });

  it('6. idempotency: the same key and body twice is one request and one delivery; another body is 409', async () => {
    const key = idempotencyKey();
    const body = { idempotency_key: key, kind: 'question', to: ['bob'], question: 'Who owns the staging certificates?' };
    const bobInbox0 = await drained('bob', 'inbox');

    const first = await api(tokenOf('alice'), 'POST', teamPath('requests'), body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ recipients: ['bob'], created: true });
    const requestId = first.body.request_id as string;
    expect(requestId).toMatch(REQUEST_ID_RE);
    expectNote('bob', requestId, 'question', 'alice');
    expectNote('alice', requestId, 'answer', 'bob');

    const again = await api(tokenOf('alice'), 'POST', teamPath('requests'), body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ request_id: requestId, recipients: ['bob'], created: false });
    expect(again.body.ack_deadline).toBe(first.body.ack_deadline);

    const conflict = await api(tokenOf('alice'), 'POST', teamPath('requests'), { ...body, question: 'Something else entirely?' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('idempotency_conflict');

    await bob.waitNote((n) => n.meta.request_id === requestId, DELIVERY_MS, 'the question');
    await sleep(SETTLE_MS);
    expect(bob.forRequest(requestId)).toHaveLength(1);
    expect(await drained('bob', 'inbox')).toEqual({ cursor: bobInbox0.head + 1, head: bobInbox0.head + 1 });

    const messageId = await answer(bob, requestId, 'The platform team owns them.');
    const a = await alice.waitNote((n) => n.meta.request_id === requestId, DELIVERY_MS, 'the answer');
    expect(a.meta.message_id).toBe(messageId);
    await sleep(SETTLE_MS);
    expect(alice.forRequest(requestId)).toHaveLength(1);
  });

  it('7. identity: unknown token 401; bob cannot reach alice\'s streams or ack what he was not sent (404); a body with "from" is 422', async () => {
    // An unknown or missing credential: 401 with no detail, on every authenticated route.
    const stranger = 'f'.repeat(48);
    for (const [token, method, path] of [
      [stranger, 'GET', teamPath('me')],
      [stranger, 'GET', teamPath('streams', 'replies')],
      [null, 'GET', teamPath('me')],
      [`${tokenOf('bob')}x`, 'GET', teamPath('me')],
    ] as const) {
      const r = await api(token, method, path);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'unauthenticated' });
    }
    expect((await api(stranger, 'POST', teamPath('requests'), { kind: 'question' })).status).toBe(401);
    // Another team's URL is not found, not forbidden.
    expect(await api(tokenOf('bob'), 'GET', '/v1/teams/other/me')).toEqual({ status: 404, body: { error: 'not_found' } });

    // Streams are always the caller's own: there is no URL naming another member's stream.
    const aliceReplies = await streamPosition('alice', 'replies');
    expect(aliceReplies.head).toBeGreaterThan(0);
    for (const path of [
      teamPath('members', 'alice', 'streams', 'replies'),
      teamPath('streams', 'alice', 'replies'),
      teamPath('streams', 'replies', 'alice'),
    ]) {
      expect((await api(tokenOf('bob'), 'GET', path)).status).toBe(404);
    }
    const bobView = await api(tokenOf('bob'), 'GET', teamPath('streams', 'replies') + '?member=alice&after=0&wait=0');
    expect(bobView.status).toBe(200);
    expect(bobView.body).toMatchObject({ messages: [], head: 0 }); // bob's own replies: he never asked anything

    // A request alice sends to carol only: bob cannot ack, reply to or read it.
    const asked = await alice.ok('ask_question', { to: ['carol'], question: 'Can you review the staging runbook?' });
    const requestId = asked.request_id as string;
    expectNote('carol', requestId, 'question', 'alice');
    expectNote('alice', requestId, 'answer', 'carol');
    const notFound = { status: 404, body: { error: 'not_found' } };
    expect(await api(tokenOf('bob'), 'POST', teamPath('requests', requestId, 'ack'), {})).toEqual(notFound);
    expect(
      await api(tokenOf('bob'), 'POST', teamPath('requests', requestId, 'reply'), { idempotency_key: idempotencyKey(), text: 'me!' }),
    ).toEqual(notFound);
    expect(await api(tokenOf('bob'), 'GET', teamPath('requests', requestId))).toEqual(notFound);
    // Indistinguishable from a request id that does not exist.
    const missing = `rq_${'0'.repeat(32)}`;
    expect(await api(tokenOf('bob'), 'POST', teamPath('requests', missing, 'ack'), {})).toEqual(notFound);
    // bob's ack attempt changed nothing for carol.
    const s = await alice.ok('request_status', { request_id: requestId });
    expect(s.recipients).toEqual({ carol: { status: 'pending', acked_at: null, answered_at: null } });

    // A body that names its own sender is refused by the model, whatever it claims.
    const aliceInbox0 = await streamPosition('alice', 'inbox');
    for (const field of ['from', 'sender']) {
      const r = await api(tokenOf('bob'), 'POST', teamPath('requests'), {
        idempotency_key: idempotencyKey(),
        kind: 'question',
        to: ['alice'],
        question: 'Posing as carol.',
        [field]: 'carol',
      });
      expect(r.status).toBe(422);
      expect(r.body.error).toBe('invalid_body');
    }
    expect(await streamPosition('alice', 'inbox')).toEqual(aliceInbox0);
    const replyFrom = await api(tokenOf('carol'), 'POST', teamPath('requests', requestId, 'reply'), {
      idempotency_key: idempotencyKey(),
      text: 'Posing as bob.',
      from: 'bob',
    });
    expect(replyFrom.status).toBe(422);
    expect(replyFrom.body.error).toBe('invalid_body');

    // carol, the actual recipient, answers; alice sees it from carol.
    await carol.waitNote((n) => n.meta.request_id === requestId, DELIVERY_MS, 'the question');
    const messageId = await answer(carol, requestId, 'Reviewed, two typos fixed.');
    const a = await alice.waitNote((n) => n.meta.request_id === requestId, DELIVERY_MS, "carol's answer");
    expect(a.meta).toEqual({ type: 'answer', request_id: requestId, from: 'carol', message_id: messageId });
  });

  it('every session received exactly the notifications the scenarios expected, each once, and no progress ever', async () => {
    await sleep(SETTLE_MS);
    const actual: Record<Member, Note[]> = { alice: aliceNotes(), bob: bob.notes, carol: carol.notes };
    for (const member of ['alice', 'bob', 'carol'] as const) {
      expect(actual[member].map(noteKey).sort(), member).toEqual([...ledger[member]].sort());
      const ids = actual[member].map((n) => n.meta.message_id);
      expect(new Set(ids).size, `${member}: duplicate message ids`).toBe(ids.length);
    }
    // alice's session only ever sees final answers and deadline notices.
    for (const n of aliceNotes()) expect(['answer', 'no_response', 'timed_out']).toContain(n.meta.type);
    for (const p of [...aliceProcesses, bob, carol, bobCaps]) expect(p.other, p.label).toEqual([]);
    expect(bobCaps.notes).toEqual([]);
    // Every stream is fully acked: nothing left behind for a later session.
    for (const [member, stream] of [
      ['alice', 'replies'],
      ['bob', 'inbox'],
      ['carol', 'inbox'],
    ] as const) {
      const pos = await streamPosition(member, stream);
      expect(pos.cursor, `${member}/${stream}`).toBe(pos.head);
    }
    // The token never reaches a server's log.
    for (const p of [...aliceProcesses, bob, carol, bobCaps]) {
      for (const m of ['alice', 'bob', 'carol'] as const) {
        if (p.stderr().includes(tokenOf(m))) throw new Error(`${p.label}'s stderr contains a token`);
      }
    }
  });
});
