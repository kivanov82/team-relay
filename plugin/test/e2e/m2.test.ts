// The M2 plugin-side e2e scenarios (M2-SPEC §6): presence per session, delivered_at and
// answer_delivered_at, tool events from the hook script (driven with a synthetic hook
// payload), and the activity feed's participant masking (carol sees metadata, no text or
// params); plus the console server proxying the real relay.
//
// Run through ../scripts/e2e.sh, which probes the relay first and sets E2E_M2=1 only when it
// serves GET /v1/health and GET /v1/teams/{team}/activity; otherwise this file is skipped and
// the script says so. Every request here is answered and every stream drained before the end,
// so the M1 suite's exact-delivery ledger is unaffected whichever file runs first.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mostRecentOpen, readActive } from '../../src/active.js';
import { DIST } from '../helpers/mcp.js';
import {
  BOB_CAPABILITIES,
  ENABLED,
  Party,
  api,
  channelEnv,
  idempotencyKey,
  relayUrl,
  streamPosition,
  teamPath,
  tokenOf,
  until,
  type Member,
} from './harness.js';

const M2 = ENABLED && process.env.E2E_M2 === '1';
const DELIVERY_MS = 10_000;
const SECRET = 'M2-E2E-SECRET-tool-input-and-output';

type Recipient = {
  status: string;
  delivered_at: string | null;
  acked_at: string | null;
  answered_at: string | null;
  answer_delivered_at: string | null;
  tools: Array<{ tool: string; status: string; at: string; duration_ms: number | null }>;
  progress_count: number;
  last_progress_pct: number | null;
  answer_preview: string | null;
};
type FeedEntry = {
  request_id: string;
  kind: string;
  asker: string;
  question: string | null;
  capability: { name: string; environment: string; params: Record<string, unknown> | null } | null;
  recipients: Record<string, Recipient>;
  participant: boolean;
  updated_at: string;
  answer_deadline: string;
};

let alice: Party;
let bob: Party;
let carol: Party;
let stateDir: string;
let hookConfig: string;

/** The feed as `member` sees it, for one request (the whole feed of the last 24 h). */
async function feedEntry(member: Member, requestId: string): Promise<FeedEntry | undefined> {
  const r = await api(tokenOf(member), 'GET', teamPath('activity') + '?limit=200');
  expect(r.status).toBe(200);
  const body = r.body as { requests: FeedEntry[]; next_since: string; server_time: string };
  expect(typeof body.next_since).toBe('string');
  expect(typeof body.server_time).toBe('string');
  // Pages are by updated_at; this suite's requests are the most recent, so follow the pages.
  let entries = body.requests;
  let since = body.next_since;
  for (let i = 0; i < 20 && entries.length > 0 && !entries.some((e) => e.request_id === requestId); i++) {
    const next = await api(tokenOf(member), 'GET', teamPath('activity') + `?limit=200&since=${encodeURIComponent(since)}`);
    const nb = next.body as { requests: FeedEntry[]; next_since: string };
    if (nb.requests.length === 0) break;
    entries = nb.requests;
    since = nb.next_since;
  }
  return entries.find((e) => e.request_id === requestId);
}

async function waitFeed(member: Member, requestId: string, pred: (e: FeedEntry) => boolean, what: string): Promise<FeedEntry> {
  return until(
    async () => {
      const e = await feedEntry(member, requestId);
      return e && pred(e) ? e : null;
    },
    DELIVERY_MS,
    what,
  );
}

/** Run dist/tool-event.js as Claude Code runs a hook: exec form, the input on stdin. */
function runHook(payload: unknown): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(DIST, 'tool-event.js'), '--config', hookConfig], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(payload));
  });
}

const t = (s: string | null) => (s === null ? Number.NaN : Date.parse(s));

describe.skipIf(!M2)('M2 end to end (plugin side)', () => {
  beforeAll(async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-e2e-m2-')));
    stateDir = join(dir, 'state');
    const tokenFile = join(dir, 'bob.token');
    writeFileSync(tokenFile, `${tokenOf('bob')}\n`, { mode: 0o600 });
    hookConfig = join(dir, 'tool-event.json');
    writeFileSync(
      hookConfig,
      JSON.stringify({ relay_url: relayUrl(), relay_team: 'demo', relay_auth: 'token', token_file: tokenFile, state_dir: stateDir }),
      { mode: 0o600 },
    );
    [bob, carol] = await Promise.all([
      Party.start(
        'm2-bob',
        'channel.js',
        // M4-SPEC §3: bin/answerer hands the channel the shared folders' names to publish.
        channelEnv('bob', 'answerer', { ...BOB_CAPABILITIES, ANSWERER_STATE_DIR: stateDir, ANSWERER_SHARES: JSON.stringify(['orders-service', 'runbooks']) }),
      ),
      Party.start('m2-carol', 'channel.js', channelEnv('carol', 'answerer')),
    ]);
    alice = await Party.start('m2-alice', 'channel.js', channelEnv('alice', 'asker'));
  });

  afterAll(async () => {
    await Promise.all([alice, bob, carol].filter(Boolean).map((p) => p.close()));
  });

  it('A. presence per session: the directory shows each running session, and last_seen is the later of the two', async () => {
    const dir = await until(
      async () => {
        const r = await api(tokenOf('carol'), 'GET', teamPath('directory'));
        const members = (r.body.members ?? []) as Array<Record<string, any>>;
        const a = members.find((m) => m.member === 'alice');
        const b = members.find((m) => m.member === 'bob');
        return a?.sessions?.working?.last_seen && b?.sessions?.answering?.last_seen ? members : null;
      },
      20_000,
      'working and answering presence',
    );
    const now = Date.now();
    for (const m of dir) {
      expect(Object.keys(m.sessions).sort()).toEqual(['answering', 'working']);
      expect(m.stats).toEqual({
        asked: expect.any(Number),
        answered: expect.any(Number),
        open: expect.any(Number),
        median_answer_seconds: m.stats.median_answer_seconds === null ? null : expect.any(Number),
      });
      const seen = [m.sessions.working.last_seen, m.sessions.answering.last_seen].filter(Boolean).map((s: string) => Date.parse(s));
      if (seen.length) expect(Date.parse(m.last_seen)).toBe(Math.max(...seen));
    }
    const a = dir.find((m) => m.member === 'alice')!;
    const b = dir.find((m) => m.member === 'bob')!;
    expect(now - Date.parse(a.sessions.working.last_seen)).toBeLessThan(60_000);
    expect(now - Date.parse(b.sessions.answering.last_seen)).toBeLessThan(60_000);
    expect(dir.map((m) => m.member).sort()).toEqual(['alice', 'bob']);
  });

  let questionId = '';

  it('B. delivery times, and C. tool events from the hook script with a synthetic payload', async () => {
    const asked = await alice.ok('ask_question', { to: ['bob'], question: 'M2: which tools did you use to answer this?' });
    questionId = asked.request_id as string;
    await bob.waitNote((n) => n.meta.request_id === questionId, DELIVERY_MS, 'the question');
    const delivered = await waitFeed('alice', questionId, (e) => e.recipients.bob?.delivered_at != null, 'delivered_at');
    expect(delivered.recipients.bob!.status).toBe('pending');

    // Before the ack nothing is open: the hook sends nothing.
    expect(mostRecentOpen(stateDir)).toBeNull();
    expect(await runHook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: SECRET }, tool_response: SECRET, duration_ms: 5 })).toBe(0);

    expect(await bob.ok('ack_question', { request_id: questionId })).toEqual({ status: 'acked' });
    expect(mostRecentOpen(stateDir)).toBe(questionId);
    // §7.6: the entry carries the request's answer deadline, as the relay has it.
    expect(t(readActive(stateDir)[0]!.answer_deadline)).toBe(t(delivered.answer_deadline));

    expect(
      await runHook({
        session_id: 'e2e',
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: `/tmp/${SECRET}` },
        tool_response: SECRET,
        tool_use_id: 'toolu_e2e_1',
        duration_ms: 42,
      }),
    ).toBe(0);
    expect(
      await runHook({
        session_id: 'e2e',
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'mcp__capabilities__staging_db_query',
        tool_input: { dataset: SECRET },
        error: SECRET,
        is_interrupt: false,
        tool_use_id: 'toolu_e2e_2',
        duration_ms: 1500,
      }),
    ).toBe(0);
    // The relay's own tools are never reported.
    expect(await runHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__relay__ack_question', duration_ms: 3 })).toBe(0);

    const withTools = await waitFeed('alice', questionId, (e) => (e.recipients.bob?.tools.length ?? 0) >= 2, 'the tool events');
    expect(withTools.recipients.bob!.tools.map(({ tool, status, duration_ms }) => ({ tool, status, duration_ms }))).toEqual([
      { tool: 'Read', status: 'ok', duration_ms: 42 },
      { tool: 'staging_db_query', status: 'error', duration_ms: 1500 },
    ]);
    // The side surface (§3.11) lists them as kind "tool", and nothing of the input or output.
    const detail = await api(tokenOf('alice'), 'GET', teamPath('requests', questionId));
    expect(detail.status).toBe(200);
    const kinds = (detail.body.progress as Array<{ kind: string; tool?: string }>).map((p) => [p.kind, p.tool]);
    expect(kinds).toEqual([
      ['tool', 'Read'],
      ['tool', 'staging_db_query'],
    ]);
    expect(JSON.stringify(detail.body) + JSON.stringify(withTools)).not.toContain(SECRET);

    await bob.ok('reply', { request_id: questionId, text: 'I read one file; the query failed.' });
    expect(readActive(stateDir)).toEqual([]);
    // Nothing open any more: a later tool call is not attributed to it.
    expect(await runHook({ hook_event_name: 'PostToolUse', tool_name: 'Glob', duration_ms: 1 })).toBe(0);

    await alice.waitNote((n) => n.meta.request_id === questionId && n.meta.type === 'answer', DELIVERY_MS, 'the answer');
    const done = await waitFeed('alice', questionId, (e) => e.recipients.bob?.answer_delivered_at != null, 'answer_delivered_at');
    const r = done.recipients.bob!;
    expect(r.status).toBe('answered');
    expect(r.tools).toHaveLength(2);
    expect(r.answer_preview).toBe('I read one file; the query failed.');
    // Every hop in order: delivered, acked, answered, returned.
    expect(t(r.delivered_at)).toBeLessThanOrEqual(t(r.acked_at));
    expect(t(r.acked_at)).toBeLessThanOrEqual(t(r.answered_at));
    expect(t(r.answered_at)).toBeLessThanOrEqual(t(r.answer_delivered_at));
  });

  it('D. the feed masks text and params from a non-participant (carol) and shows them to participants', async () => {
    // A capability call alice -> bob, sent raw so no runner is needed; bob answers it.
    const created = await api(tokenOf('alice'), 'POST', teamPath('requests'), {
      idempotency_key: idempotencyKey(),
      kind: 'capability',
      to: ['bob'],
      capability: { name: 'staging_db_query', params: { dataset: 'orders', limit: 3 } },
    });
    expect(created.status).toBe(201);
    const capId = created.body.request_id as string;
    await bob.waitNote((n) => n.meta.request_id === capId, DELIVERY_MS, 'the capability call');
    await bob.ok('ack_question', { request_id: capId });
    await bob.ok('reply', { request_id: capId, text: 'Three orders.', data: { rows: 3 } });
    await alice.waitNote((n) => n.meta.request_id === capId && n.meta.type === 'answer', DELIVERY_MS, 'the capability answer');

    for (const id of [questionId, capId]) {
      const seen = await waitFeed('carol', id, (e) => e.recipients.bob?.status === 'answered', `carol's view of ${id}`);
      expect(seen.participant).toBe(false);
      expect(seen.question).toBeNull();
      expect(seen.recipients.bob!.answer_preview).toBeNull();
      // Metadata stays visible.
      expect(seen.asker).toBe('alice');
      expect(seen.recipients.bob!.delivered_at).not.toBeNull();
      if (id === capId) expect(seen.capability).toEqual({ name: 'staging_db_query', environment: 'staging', params: null });
      else expect(seen.recipients.bob!.tools.map((x) => x.tool)).toEqual(['Read', 'staging_db_query']);
      // And carol cannot read the request itself.
      expect((await api(tokenOf('carol'), 'GET', teamPath('requests', id))).status).toBe(404);
    }
    const aliceCap = await waitFeed('alice', capId, (e) => e.recipients.bob?.status === 'answered', "alice's view");
    expect(aliceCap.participant).toBe(true);
    expect(aliceCap.capability).toEqual({ name: 'staging_db_query', environment: 'staging', params: { dataset: 'orders', op: 'eq', limit: 3 } });
    expect(aliceCap.recipients.bob!.answer_preview).toBe('Three orders.');
    const bobQ = await waitFeed('bob', questionId, () => true, "bob's view");
    expect(bobQ.participant).toBe(true);
    expect(bobQ.question).toBe('M2: which tools did you use to answer this?');
  });

  it('E. the console server proxies the real relay read-only, with the key', async () => {
    const child = spawn(process.execPath, [join(DIST, 'console-server.js')], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '', CONSOLE_PORT: '0', RELAY_URL: relayUrl(), RELAY_TEAM: 'demo', RELAY_AUTH: 'token', RELAY_TOKEN: tokenOf('carol') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    try {
      const url = await until(() => (out.includes('\n') ? out.trim() : null), 10_000, 'the console URL');
      const m = /^http:\/\/127\.0\.0\.1:(\d+)\/#k=([A-Za-z0-9_-]{43})$/.exec(url)!;
      const base = `http://127.0.0.1:${m[1]}`;
      const get = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { 'X-Console-Key': m[2]!, ...(init.headers ?? {}) } });
      const me = await (await get('/api/me')).json();
      expect(me).toEqual({ team: 'demo', member: 'carol', teammates: ['alice', 'bob'] });
      const feed = (await (await get('/api/activity?limit=200')).json()) as { requests: FeedEntry[] };
      expect(Array.isArray(feed.requests)).toBe(true);
      const dir = (await (await get('/api/directory')).json()) as { members: Array<{ member: string }> };
      expect(dir.members.map((x) => x.member).sort()).toEqual(['alice', 'bob']);
      expect((await get(`/api/requests/${questionId}`)).status).toBe(404);
      expect((await get(`/api/requests/${questionId}/reply`, { method: 'POST', body: '{}' })).status).toBe(405);
      expect((await fetch(base + '/api/me')).status).toBe(401);
      expect(err).not.toContain(tokenOf('carol'));
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('F. a request acknowledged and not answered stops collecting tool events at its answer deadline (§7.6)', async () => {
    const asked = await alice.ok('ask_question', { to: ['bob'], question: 'M2: a question nobody answers in time', ack_timeout_seconds: 2, answer_timeout_seconds: 3 });
    const staleId = asked.request_id as string;
    await bob.waitNote((n) => n.meta.request_id === staleId, DELIVERY_MS, 'the short question');
    await bob.ok('ack_question', { request_id: staleId });
    const entry = readActive(stateDir).find((e) => e.request_id === staleId);
    expect(entry).toBeDefined();
    const deadline = t(entry!.answer_deadline);
    expect(deadline - Date.now()).toBeLessThanOrEqual(3000);
    await until(() => (Date.now() > deadline + 200 ? true : null), 10_000, 'the answer deadline');
    expect(readActive(stateDir).map((e) => e.request_id)).not.toContain(staleId);
    expect(mostRecentOpen(stateDir)).toBeNull();
    expect(await runHook({ hook_event_name: 'PostToolUse', tool_name: 'Read', duration_ms: 2 })).toBe(0);
    const seen = await waitFeed('alice', staleId, () => true, 'the stale request');
    expect(seen.recipients.bob!.tools).toEqual([]);
  });

  it('G. M4: a permission request shows on the feed as waiting and the next event clears it; shares are published by name', async () => {
    // §3: the directory returns bob's shares inside his manifest, names only.
    const dir = await api(tokenOf('carol'), 'GET', teamPath('directory'));
    const bobEntry = (dir.body.members as Array<{ member: string; manifest: { shares?: unknown } | null }>).find((m) => m.member === 'bob')!;
    expect(bobEntry.manifest?.shares).toEqual([{ name: 'orders-service' }, { name: 'runbooks' }]);

    // §2: a permission request while answering posts `waiting`, never the path.
    const asked = await alice.ok('ask_question', { to: ['bob'], question: 'M4: what does the handover note say?' });
    const id = asked.request_id as string;
    await bob.waitNote((n) => n.meta.request_id === id, DELIVERY_MS, 'the M4 question');
    await bob.ok('ack_question', { request_id: id });
    expect(
      await runHook({
        session_id: 'e2e',
        hook_event_name: 'PermissionRequest',
        permission_mode: 'default',
        tool_name: 'Read',
        tool_input: { file_path: `/tmp/${SECRET}/handover.md` },
        permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: `//tmp/${SECRET}/**` }], behavior: 'allow', destination: 'session' }],
      }),
    ).toBe(0);
    const waiting = await waitFeed('alice', id, (e) => e.recipients.bob?.tools.at(-1)?.status === 'waiting', 'the waiting event');
    expect(waiting.recipients.bob!.status).toBe('acked');
    expect(waiting.recipients.bob!.tools.map(({ tool, status, duration_ms }) => ({ tool, status, duration_ms }))).toEqual([
      { tool: 'Read', status: 'waiting', duration_ms: null },
    ]);
    // Everyone on the team sees the metadata: carol, who is not a participant, too.
    const carolView = await waitFeed('carol', id, (e) => e.recipients.bob?.tools.at(-1)?.status === 'waiting', "carol's view of the waiting event");
    expect(carolView.question).toBeNull();

    // Allowed: the Read runs, and its ok is the next event for that tool.
    expect(await runHook({ session_id: 'e2e', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: `/tmp/${SECRET}` }, tool_response: SECRET, duration_ms: 9 })).toBe(0);
    const cleared = await waitFeed('alice', id, (e) => (e.recipients.bob?.tools.length ?? 0) >= 2, 'the event after the grant');
    expect(cleared.recipients.bob!.tools.map(({ tool, status }) => [tool, status])).toEqual([
      ['Read', 'waiting'],
      ['Read', 'ok'],
    ]);
    const detail = await api(tokenOf('alice'), 'GET', teamPath('requests', id));
    expect((detail.body.progress as Array<{ kind: string; tool?: string; status?: string }>).map((p) => [p.kind, p.tool, p.status])).toEqual([
      ['tool', 'Read', 'waiting'],
      ['tool', 'Read', 'ok'],
    ]);
    expect(JSON.stringify(detail.body) + JSON.stringify(cleared) + JSON.stringify(dir.body)).not.toContain(SECRET);

    await bob.ok('reply', { request_id: id, text: 'It says to page on-call above 5,000.' });
    await alice.waitNote((n) => n.meta.request_id === id && n.meta.type === 'answer', DELIVERY_MS, 'the M4 answer');
  });

  it('leaves every stream drained and no token in any log', async () => {
    for (const [member, stream] of [
      ['alice', 'replies'],
      ['bob', 'inbox'],
      ['carol', 'inbox'],
    ] as const) {
      await until(
        async () => {
          const pos = await streamPosition(member, stream);
          return pos.cursor === pos.head;
        },
        DELIVERY_MS,
        `${member}/${stream} drained`,
      );
    }
    for (const p of [alice, bob, carol]) {
      for (const m of ['alice', 'bob', 'carol'] as const) {
        if (p.stderr().includes(tokenOf(m))) throw new Error(`${p.label}'s stderr contains a token`);
      }
    }
    expect(readFileSync(join(stateDir, 'active.json'), 'utf8')).not.toContain('M2:');
  });
});

