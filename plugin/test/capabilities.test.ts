import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeRelay, TOKEN_OF, rqId } from './helpers/fake-relay.js';
import { FIXTURES, PLUGIN_ROOT, spawnServer, textOf, waitFor, type Spawned } from './helpers/mcp.js';
import { findCapability, loadManifest, validateParams } from '../src/manifest.js';
import { canonicalJson } from '../src/tool-util.js';

let relay: FakeRelay;
const open: Spawned[] = [];
const MANIFEST = join(PLUGIN_ROOT, 'manifest.yaml');
const RUNNER = join(FIXTURES, 'fake-runner.mjs');

beforeEach(async () => {
  relay = await new FakeRelay().start();
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  await relay.stop();
});

async function capServer(env: Record<string, string>) {
  const s = await spawnServer('capabilities.js', {
    RELAY_URL: relay.url,
    RELAY_TEAM: 'demo',
    RELAY_TOKEN: TOKEN_OF.bob!,
    MANIFEST_PATH: MANIFEST,
    ...env,
  });
  open.push(s);
  return s;
}

function tmp(prefix = 'team-relay-cap-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A one-capability manifest whose runner behaviour is the test's to choose. */
function oneCapManifest(timeout = 5): string {
  const dir = tmp();
  const path = join(dir, 'manifest.yaml');
  writeFileSync(
    path,
    [
      'version: 1',
      'capabilities:',
      '  - name: probe',
      '    title: Probe',
      '    description: Synthetic test capability.',
      '    environment: staging',
      `    timeout_seconds: ${timeout}`,
      '    params:',
      '      mode:',
      '        type: enum',
      '        values: [a, b]',
      '        description: Mode.',
      '    required: [mode]',
      '',
    ].join('\n'),
  );
  return path;
}

const call = (s: Spawned, name: string, args: Record<string, unknown>) => s.client.callTool({ name, arguments: args });

/**
 * A directed capability request from alice to bob, stored at the fake relay the way the relay
 * stores it (params with the shipped manifest's defaults filled). Returns its request_id.
 */
function bound(name: string, params: Record<string, unknown>, extra: Parameters<FakeRelay['addRequest']>[0] = {}): string {
  const cap = findCapability(loadManifest(MANIFEST), name);
  let filled = params;
  if (cap) {
    const r = validateParams(cap, params);
    if (!r.ok) throw new Error(`test setup: ${r.detail}`);
    filled = r.params;
  }
  return relay.addRequest({ capability: { name, params: filled }, ...extra });
}

describe('capability server: which capabilities are offered', () => {
  it('declares tools only, not a channel', async () => {
    const s = await capServer({});
    const caps = s.client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.experimental).toBeUndefined();
    expect(s.client.getServerVersion()?.name).toBe('capabilities');
  });

  it('offers nothing when nothing is enabled', async () => {
    const s = await capServer({ CAP_STAGING_DB_QUERY_RUNNER: RUNNER });
    expect((await s.client.listTools()).tools).toEqual([]);
  });

  it('offers only enabled + runner + environment-allowed capabilities', async () => {
    const notExec = join(tmp(), 'runner.mjs');
    copyFileSync(RUNNER, notExec);
    chmodSync(notExec, 0o644);
    const s = await capServer({
      CAP_STAGING_DB_QUERY_ENABLED: 'true',
      CAP_STAGING_DB_QUERY_RUNNER: RUNNER,
      CAP_SERVICE_HEALTH_ENABLED: 'true',
      CAP_SERVICE_HEALTH_RUNNER: notExec, // not executable
      CAP_PRODUCTION_DB_COUNT_ENABLED: 'true',
      CAP_PRODUCTION_DB_COUNT_RUNNER: RUNNER, // production, not allowed
    });
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['staging_db_query']);
    expect(s.stderr()).toMatch(/service_health not offered: runner is not executable/);
    expect(s.stderr()).toMatch(/production_db_count not offered: production data not allowed/);
  });

  it('requires a runner, an absolute path, a regular file, and "true" exactly', async () => {
    const dir = tmp();
    const s = await capServer({
      CAP_STAGING_DB_QUERY_ENABLED: '1',
      CAP_STAGING_DB_QUERY_RUNNER: RUNNER,
      CAP_SERVICE_HEALTH_ENABLED: 'true',
      CAP_SERVICE_HEALTH_RUNNER: dir, // a directory
      CAP_PRODUCTION_DB_COUNT_ENABLED: 'true',
      ALLOW_PRODUCTION: 'true',
      CAP_PRODUCTION_DB_COUNT_RUNNER: 'test/fixtures/fake-runner.mjs', // relative
    });
    expect((await s.client.listTools()).tools).toEqual([]);
    const s2 = await capServer({ CAP_SERVICE_HEALTH_ENABLED: 'true' });
    expect((await s2.client.listTools()).tools).toEqual([]);
    expect(s2.stderr()).toMatch(/service_health not offered: no runner set/);
  });

  it('offers a production capability only with ALLOW_PRODUCTION=true exactly', async () => {
    const base = { CAP_PRODUCTION_DB_COUNT_ENABLED: 'true', CAP_PRODUCTION_DB_COUNT_RUNNER: RUNNER };
    const yes = await capServer({ ...base, ALLOW_PRODUCTION: 'true' });
    expect((await yes.client.listTools()).tools.map((t) => t.name)).toEqual(['production_db_count']);
    const one = await capServer({ ...base, ALLOW_PRODUCTION: '1' });
    expect((await one.client.listTools()).tools).toEqual([]);
    const upper = await capServer({ ...base, ALLOW_PRODUCTION: 'TRUE' });
    expect((await upper.client.listTools()).tools).toEqual([]);
  });

  it('generates the input schema from the params plus a required request_id', async () => {
    const s = await capServer({ CAP_STAGING_DB_QUERY_ENABLED: 'true', CAP_STAGING_DB_QUERY_RUNNER: RUNNER });
    const [tool] = (await s.client.listTools()).tools;
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['dataset', 'request_id'],
      properties: {
        dataset: { type: 'string', enum: ['users', 'orders', 'events'] },
        field: { type: 'string', enum: ['id', 'status', 'created_on', 'country'] },
        op: { type: 'string', enum: ['eq', 'ne', 'lt', 'gt'], default: 'eq' },
        value: { type: 'string', maxLength: 100, description: expect.stringContaining('RE2 pattern ^[A-Za-z0-9_.@-]{0,100}$') },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        request_id: { type: 'string', pattern: '^rq_[0-9a-f]{32}$' },
      },
    });
    // A manifest pattern is never handed to the client's regex engine.
    expect((tool!.inputSchema.properties as Record<string, Record<string, unknown>>).value).not.toHaveProperty('pattern');
  });
});

describe('capability server: running', () => {
  const enabled = { CAP_STAGING_DB_QUERY_ENABLED: 'true', CAP_STAGING_DB_QUERY_RUNNER: RUNNER };

  it('runs the runner with one stdin line, returns its JSON, forwards progress to the relay only', async () => {
    const s = await capServer(enabled);
    const request_id = bound('staging_db_query', { dataset: 'users', limit: 2 });
    const r = await call(s, 'staging_db_query', { dataset: 'users', limit: 2, request_id });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(textOf(r));
    expect(out).toMatchObject({ capability: 'staging_db_query', request_id, dataset: 'users', row_count: 2 });
    expect(out.rows).toHaveLength(2);
    expect(relay.progress).toEqual([
      { request_id, member: 'bob', text: 'connecting to the fake staging database', pct: 10 },
      { request_id, member: 'bob', text: 'reading rows', pct: 60 },
    ]);
    // Non-progress stderr goes to this server's stderr; nothing goes to any stream.
    expect(s.stderr()).toContain('[staging_db_query] fake runner: done');
    expect(relay.requests.some((q) => q.path.includes('/streams/'))).toBe(false);
    expect(s.otherNotifications).toEqual([]);
  });

  it('passes the structured field/op/value filter through to the runner', async () => {
    const s = await capServer(enabled);
    const request_id = bound('staging_db_query', { dataset: 'users', field: 'status', op: 'eq', value: 'active' });
    const r = await call(s, 'staging_db_query', { dataset: 'users', field: 'status', op: 'eq', value: 'active', request_id });
    expect(r.isError, textOf(r)).toBeFalsy();
    const out = JSON.parse(textOf(r));
    expect(out.rows.map((x: { id: number }) => x.id)).toEqual([1, 3]);
    const gt = await call(s, 'staging_db_query', { dataset: 'users', field: 'id', op: 'gt', value: '1', request_id: bound('staging_db_query', { dataset: 'users', field: 'id', op: 'gt', value: '1' }) });
    expect(JSON.parse(textOf(gt)).rows.map((x: { id: number }) => x.id)).toEqual([2, 3]);
  });

  it('passes the params with defaults filled and the request_id on stdin, and no arguments', async () => {
    const s = await capServer({ CAP_STAGING_DB_QUERY_ENABLED: 'true', CAP_STAGING_DB_QUERY_RUNNER: join(FIXTURES, 'env-runner.mjs') });
    const request_id = bound('staging_db_query', { dataset: 'orders' });
    const r = await call(s, 'staging_db_query', { dataset: 'orders', request_id });
    const out = JSON.parse(textOf(r));
    expect(out.argv).toEqual([]);
    expect(out.stdin.endsWith('\n')).toBe(true);
    expect(out.stdin.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out.stdin)).toEqual({ capability: 'staging_db_query', params: { dataset: 'orders', op: 'eq', limit: 20 }, request_id });
  });

  it('gives the runner a minimal environment (no parent secrets)', async () => {
    const s = await capServer({
      CAP_STAGING_DB_QUERY_ENABLED: 'true',
      CAP_STAGING_DB_QUERY_RUNNER: join(FIXTURES, 'env-runner.mjs'),
      SUPER_SECRET_API_KEY: 'sk-this-must-not-leak',
      LANG: 'en_GB.UTF-8',
    });
    const r = await call(s, 'staging_db_query', { dataset: 'users', request_id: bound('staging_db_query', { dataset: 'users' }) });
    const { env } = JSON.parse(textOf(r)) as { env: Record<string, string> };
    expect(JSON.stringify(env)).not.toContain('sk-this-must-not-leak');
    expect(env.RELAY_TOKEN).toBeUndefined();
    expect(env.CAPABILITY_NAME).toBe('staging_db_query');
    expect(env.LANG).toBe('en_GB.UTF-8');
    expect(env.PATH).toBe(process.env.PATH);
    // Anything beyond the four allowed names can only be injected by the OS itself.
    const extra = Object.keys(env).filter((k) => !['PATH', 'HOME', 'LANG', 'CAPABILITY_NAME'].includes(k));
    expect(extra.filter((k) => !k.startsWith('__CF_'))).toEqual([]);
  });

  it('never starts the runner for bad arguments', async () => {
    const dir = tmp();
    const marker = join(dir, 'marker-runner.mjs');
    copyFileSync(join(FIXTURES, 'marker-runner.mjs'), marker);
    chmodSync(marker, 0o755);
    const s = await capServer({ CAP_STAGING_DB_QUERY_ENABLED: 'true', CAP_STAGING_DB_QUERY_RUNNER: marker });
    // A real, bound request: only the arguments are wrong, and they are refused before the relay is asked.
    const id = bound('staging_db_query', { dataset: 'users' });
    for (const args of [
      { dataset: 'users', limit: 500, request_id: id },
      { dataset: 'secrets', request_id: id },
      { dataset: 'users', extra: 1, request_id: id },
      { dataset: 'users', field: 'status', value: "x'; drop table users; --\n", request_id: id },
      { dataset: 'users', op: 'like', request_id: id },
      { limit: 5, request_id: id },
      { dataset: 'users' },
      { dataset: 'users', request_id: 'rq_123' },
    ]) {
      const r = await call(s, 'staging_db_query', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(existsSync(join(dir, 'started'))).toBe(false);
    expect(relay.requests.some((q) => q.path.includes('/requests/'))).toBe(false);
    const unknown = await call(s, 'service_health', { service: 'api', request_id: bound('service_health', { service: 'api' }) });
    expect(unknown.isError).toBe(true);
    expect(existsSync(join(dir, 'started'))).toBe(false);
    // A good call does start it (the marker works).
    const ok = await call(s, 'staging_db_query', { dataset: 'users', request_id: bound('staging_db_query', { dataset: 'users' }) });
    expect(ok.isError).toBeFalsy();
    expect(existsSync(join(dir, 'started'))).toBe(true);
  });

  it('executes a runner path containing shell metacharacters as a file, not a command', async () => {
    const root = tmp();
    const canary = join(root, 'INJECTED');
    const weird = join(root, `dir with space; touch ${canary} $(touch ${canary}) |x`);
    mkdirSync(weird, { recursive: true });
    const runner = join(weird, "run'me`&.mjs");
    copyFileSync(RUNNER, runner);
    chmodSync(runner, 0o755);
    const s = await capServer({ CAP_STAGING_DB_QUERY_ENABLED: 'true', CAP_STAGING_DB_QUERY_RUNNER: runner });
    const r = await call(s, 'staging_db_query', { dataset: 'events', request_id: bound('staging_db_query', { dataset: 'events' }) });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(JSON.parse(textOf(r)).dataset).toBe('events');
    expect(existsSync(canary)).toBe(false);
  });

  it('kills a runner whose output exceeds 64 KiB and returns a tool error', async () => {
    const s = await capServer({ CAP_STAGING_DB_QUERY_ENABLED: 'true', CAP_STAGING_DB_QUERY_RUNNER: join(FIXTURES, 'big-runner.mjs') });
    const r = await call(s, 'staging_db_query', { dataset: 'users', request_id: bound('staging_db_query', { dataset: 'users' }) });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/larger than 64 KiB/);
  });

  it('returns a tool error for output that is not JSON and for a failing exit code', async () => {
    const s = await capServer({ CAP_STAGING_DB_QUERY_ENABLED: 'true', CAP_STAGING_DB_QUERY_RUNNER: join(FIXTURES, 'bad-output-runner.mjs') });
    const r = await call(s, 'staging_db_query', { dataset: 'users', request_id: bound('staging_db_query', { dataset: 'users' }) });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not one JSON value/);

    const dir = tmp();
    const failing = join(dir, 'fail.mjs');
    writeFileSync(failing, '#!/usr/bin/env node\nprocess.stderr.write("boom\\n"); process.exit(3);\n');
    chmodSync(failing, 0o755);
    const s2 = await capServer({ CAP_STAGING_DB_QUERY_ENABLED: 'true', CAP_STAGING_DB_QUERY_RUNNER: failing });
    const r2 = await call(s2, 'staging_db_query', { dataset: 'users', request_id: bound('staging_db_query', { dataset: 'users' }) });
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toBe('runner exited with code 3');
  });

  it('times out: SIGTERM, then SIGKILL after 5 s, and a tool error', { timeout: 20_000 }, async () => {
    const manifest = oneCapManifest(1);
    const s = await capServer({
      MANIFEST_PATH: manifest,
      CAP_PROBE_ENABLED: 'true',
      CAP_PROBE_RUNNER: join(FIXTURES, 'hang-runner.mjs'),
    });
    const started = Date.now();
    const r = await call(s, 'probe', { mode: 'a', request_id: bound('probe', { mode: 'a' }) });
    const elapsed = Date.now() - started;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('runner timed out after 1 s');
    // It ignores SIGTERM, so only the SIGKILL 5 s later ends it.
    expect(elapsed).toBeGreaterThanOrEqual(5500);
    expect(elapsed).toBeLessThan(12_000);
  });

  it('stops forwarding progress after 200 events per call', async () => {
    const dir = tmp();
    const chatty = join(dir, 'chatty.mjs');
    writeFileSync(
      chatty,
      '#!/usr/bin/env node\nfor (let i = 0; i < 250; i++) process.stderr.write(JSON.stringify({progress: "step " + i, pct: i / 2.5}) + "\\n");\nprocess.stdout.write("{}");\n',
    );
    chmodSync(chatty, 0o755);
    const s = await capServer({ MANIFEST_PATH: oneCapManifest(), CAP_PROBE_ENABLED: 'true', CAP_PROBE_RUNNER: chatty });
    const request_id = bound('probe', { mode: 'b' });
    const r = await call(s, 'probe', { mode: 'b', request_id });
    expect(r.isError).toBeFalsy();
    await waitFor(() => relay.progress.length >= 200, 10_000, '200 progress events');
    expect(relay.progress).toHaveLength(200);
    expect(relay.progress.every((p) => p.pct === null || (p.pct >= 0 && p.pct <= 100))).toBe(true);
  });
});

describe('capability server: a run is bound to its request (§11.10)', () => {
  let dir: string;
  let started: string;
  let s: Spawned;
  const params = { dataset: 'users', limit: 5 };
  const filled = { dataset: 'users', op: 'eq', limit: 5 };

  beforeEach(async () => {
    dir = tmp();
    const marker = join(dir, 'marker-runner.mjs');
    copyFileSync(join(FIXTURES, 'marker-runner.mjs'), marker);
    chmodSync(marker, 0o755);
    started = join(dir, 'started');
    s = await capServer({ CAP_STAGING_DB_QUERY_ENABLED: 'true', CAP_STAGING_DB_QUERY_RUNNER: marker });
  });

  /** Call with valid args for `requestId`; the call must be refused and the runner never start. */
  async function refused(requestId: string, why: RegExp, args: Record<string, unknown> = params) {
    const r = await call(s, 'staging_db_query', { ...args, request_id: requestId });
    expect(r.isError, textOf(r)).toBe(true);
    expect(textOf(r)).toMatch(why);
    expect(textOf(r)).toMatch(/the runner was not started/);
    expect(existsSync(started)).toBe(false);
    // The check read the request from the relay as bob.
    const reads = relay.requests.filter((q) => q.method === 'GET' && q.path === `/v1/teams/demo/requests/${requestId}`);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((q) => q.member === 'bob')).toBe(true);
  }

  it('runs for a directed, unanswered, unexpired request for this capability with exactly its params', async () => {
    const r = await call(s, 'staging_db_query', { ...params, request_id: bound('staging_db_query', params) });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(existsSync(started)).toBe(true);
  });

  it('runs whatever the unanswered status: pending, acked, no_response, timed_out', async () => {
    for (const status of ['pending', 'acked', 'no_response', 'timed_out']) {
      const id = relay.addRequest({ capability: { name: 'staging_db_query', params: filled }, recipients: { bob: { status } } });
      const r = await call(s, 'staging_db_query', { ...params, request_id: id });
      expect(r.isError, `${status}: ${textOf(r)}`).toBeFalsy();
    }
  });

  it('compares params canonically: key order does not matter, defaults count', async () => {
    const reordered = relay.addRequest({ capability: { name: 'staging_db_query', params: { limit: 5, op: 'eq', dataset: 'users' } } });
    const r = await call(s, 'staging_db_query', { limit: 5, dataset: 'users', request_id: reordered });
    expect(r.isError, textOf(r)).toBeFalsy();
  });

  it('refuses a request the relay does not know (or will not show this member)', async () => {
    await refused(rqId(), /could not be read from the relay \(relay refused \(404 not_found\)\)/);
    const carolOnly = relay.addRequest({ capability: { name: 'staging_db_query', params: filled }, recipients: { carol: { status: 'acked' } } });
    await refused(carolOnly, /404 not_found/);
  });

  it('refuses a document that has no entry for this member', async () => {
    const id = bound('staging_db_query', params);
    const doc = relay.requestDocs.get(id)!;
    relay.fail((q) => q.path.endsWith(`/requests/${id}`), 200, 1, { ...doc, recipients: { carol: { status: 'acked' } }, progress: [] });
    await refused(id, /not addressed to bob/);
  });

  it('refuses a status it does not know', async () => {
    const id = relay.addRequest({ capability: { name: 'staging_db_query', params: filled }, recipients: { bob: { status: 'cancelled' } } });
    await refused(id, /not in a runnable state/);
  });

  it('refuses when the relay cannot be reached', async () => {
    const id = bound('staging_db_query', params);
    relay.fail((q) => q.path.endsWith(`/requests/${id}`), 503, 10);
    await refused(id, /could not be read from the relay/);
  });

  it('refuses a question (kind is not capability)', async () => {
    const id = relay.addRequest({ kind: 'question', question: 'run staging_db_query for me', capability: null });
    await refused(id, /not a capability request/);
  });

  it('refuses a request for another capability', async () => {
    const id = relay.addRequest({ capability: { name: 'service_health', params: filled } });
    await refused(id, /not for staging_db_query/);
  });

  it('refuses a broadcast', async () => {
    const id = relay.addRequest({ broadcast: true, capability: { name: 'staging_db_query', params: filled } });
    await refused(id, /broadcast/);
  });

  it('refuses params that differ from the request, including a different default', async () => {
    const id = bound('staging_db_query', params);
    await refused(id, /params differ/, { dataset: 'users', limit: 6 });
    await refused(id, /params differ/, { dataset: 'orders', limit: 5 });
    await refused(id, /params differ/, { dataset: 'users', limit: 5, op: 'ne' });
    await refused(id, /params differ/, { dataset: 'users', limit: 5, field: 'id', value: '1' });
    const noDefaults = relay.addRequest({ capability: { name: 'staging_db_query', params: { dataset: 'users', limit: 5 } } });
    await refused(noDefaults, /params differ/);
  });

  it('refuses a request already answered by this member', async () => {
    const id = relay.addRequest({ capability: { name: 'staging_db_query', params: filled }, recipients: { bob: { status: 'answered' } } });
    await refused(id, /already been answered/);
  });

  it('refuses an expired request', async () => {
    const id = relay.addRequest({ capability: { name: 'staging_db_query', params: filled }, expire_at: '2020-01-01T00:00:00Z' });
    await refused(id, /expired/);
  });

  it('refuses a request whose asker is this member', async () => {
    const id = relay.addRequest({ asker: 'bob', capability: { name: 'staging_db_query', params: filled } });
    await refused(id, /asker/);
  });

  it('refuses a request whose document does not match the id asked for', async () => {
    const id = bound('staging_db_query', params);
    const other = rqId();
    relay.fail((q) => q.path.endsWith(`/requests/${id}`), 200, 1, { ...relay.requestDocs.get(id), request_id: other, progress: [] });
    await refused(id, /different request/);
  });
});

describe('capability server: runner output must be a JSON object (§11.11)', () => {
  for (const [label, output] of [
    ['an array', '[1, 2, 3]'],
    ['a string', '"done"'],
    ['a number', '42'],
    ['null', 'null'],
    ['true', 'true'],
  ] as const) {
    it(`refuses ${label}`, async () => {
      const runner = join(tmp(), 'runner.mjs');
      writeFileSync(runner, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\n`);
      chmodSync(runner, 0o755);
      const s = await capServer({ CAP_STAGING_DB_QUERY_ENABLED: 'true', CAP_STAGING_DB_QUERY_RUNNER: runner });
      const r = await call(s, 'staging_db_query', { dataset: 'users', request_id: bound('staging_db_query', { dataset: 'users' }) });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe('runner output is not a JSON object');
    });
  }

  it('accepts an object, even an empty one', async () => {
    const runner = join(tmp(), 'runner.mjs');
    writeFileSync(runner, '#!/usr/bin/env node\nprocess.stdout.write("{}\\n");\n');
    chmodSync(runner, 0o755);
    const s = await capServer({ CAP_STAGING_DB_QUERY_ENABLED: 'true', CAP_STAGING_DB_QUERY_RUNNER: runner });
    const r = await call(s, 'staging_db_query', { dataset: 'users', request_id: bound('staging_db_query', { dataset: 'users' }) });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(JSON.parse(textOf(r))).toEqual({});
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level and keeps arrays in order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: 5.0 })).toBe(canonicalJson({ a: 5 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
  });
});

describe('fixture runner (shared with the e2e suite)', () => {
  it('is executable and has a shebang', () => {
    const text = readFileSync(RUNNER, 'utf8');
    expect(text.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});
