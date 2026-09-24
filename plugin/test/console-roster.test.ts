// M6-SPEC §3: the console server's roster proxy. GET /api/roster, POST /api/roster, PATCH and
// DELETE /api/roster/{member}, locally (the per-launch key) and hosted (IAP, the viewer sent
// on behalf of); a change needs Content-Type: application/json and Sec-Fetch-Site:
// same-origin, and its body is checked before the relay sees it. Everything else stays
// read-only. M6-SPEC §4: a signed-in account the relay does not know gets not_on_team, and
// no data. And the --demo roster, under the relay's invariants.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ROSTER_BODY_LIMIT,
  checkAddMember,
  checkUpdateMember,
  createConsoleServer,
  demoBackend,
  relayBackend,
  type ConsoleServer,
} from '../src/console-app.js';
import { DemoTeam, NotFound, RosterRefusal } from '../src/console-demo.js';
import { IAP_HEADER } from '../src/iap.js';
import { RelayClient } from '../src/relay-client.js';
import { FakeRelay, TOKEN_OF, type Recorded } from './helpers/fake-relay.js';

const KEY = 'k'.repeat(43);
const NO_UI = join(tmpdir(), 'team-relay-no-ui-here');
const PUBLIC_HOST = 'team-relay-console-abc123-ey.a.run.app';

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any };

function req(
  port: number,
  path: string,
  opts: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    // As a browser sends it (Node's client would send a DELETE body without a length).
    if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    const r = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, setHost: false, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}

/** What the console's own page sends for a change. */
const SAME_ORIGIN = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };

const relayCalls = (relay: FakeRelay): Recorded[] => relay.requests.filter((r) => r.path.includes('/roster'));

describe('roster proxy, local (M6-SPEC §3)', () => {
  let relay: FakeRelay;
  let app: ConsoleServer;
  let port: number;

  const change = (method: string, path: string, body: unknown, headers: Record<string, string> = SAME_ORIGIN) =>
    req(port, path, { method, headers: { 'X-Console-Key': KEY, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = (path: string, headers: Record<string, string> = {}) => req(port, path, { headers: { 'X-Console-Key': KEY, ...headers } });

  beforeEach(async () => {
    relay = await new FakeRelay().start();
    const client = new RelayClient({ url: relay.url, team: 'demo', token: () => TOKEN_OF.alice!, attempts: 1 });
    app = createConsoleServer({ backend: relayBackend(client), key: KEY, staticDir: NO_UI });
    port = await app.listen(0);
  });
  afterEach(async () => {
    await app.close();
    await relay.stop();
  });

  it('GET /api/roster reads the relay with the key; without it nothing is asked', async () => {
    const r = await get('/api/roster');
    expect(r.status).toBe(200);
    expect(r.json().members.map((m: { member: string; role: string }) => [m.member, m.role])).toEqual([
      ['alice', 'owner'],
      ['bob', 'member'],
      ['carol', 'member'],
    ]);
    expect(relayCalls(relay).map((c) => [c.method, c.path])).toEqual([['GET', '/v1/teams/demo/roster']]);
    expect((await req(port, '/api/roster')).status).toBe(401);
    expect((await req(port, '/api/roster', { headers: { 'X-Console-Key': 'x'.repeat(43) } })).status).toBe(403);
    expect((await get('/api/roster?x=1')).status).toBe(400);
    expect(relayCalls(relay)).toHaveLength(1);
  });

  it('adds, changes and removes a member, sending exactly the checked body', async () => {
    const added = await change('POST', '/api/roster', { member: 'dave', email: ' Dave@Example.COM ' });
    expect(added.status).toBe(201);
    expect(added.json()).toMatchObject({ member: 'dave', emails: ['dave@example.com'], role: 'member' });
    const patched = await change('PATCH', '/api/roster/dave', { role: 'owner' });
    expect(patched.status).toBe(200);
    expect(patched.json().role).toBe('owner');
    const removed = await change('DELETE', '/api/roster/dave', undefined);
    expect(removed.status).toBe(200);
    const calls = relayCalls(relay);
    expect(calls.map((c) => [c.method, c.path, c.raw])).toEqual([
      ['POST', '/v1/teams/demo/roster', '{"member":"dave","email":"dave@example.com"}'],
      ['PATCH', '/v1/teams/demo/roster/dave', '{"role":"owner"}'],
      ['DELETE', '/v1/teams/demo/roster/dave', ''],
    ]);
    for (const c of calls.slice(0, 2)) expect(c.headers['content-type']).toBe('application/json');
    // DELETE with an empty JSON object is accepted too.
    await change('POST', '/api/roster', { member: 'erin', email: 'erin@example.com', role: 'member' });
    expect((await change('DELETE', '/api/roster/erin', {})).status).toBe(200);
  });

  it('refuses a change without Sec-Fetch-Site: same-origin, before the relay is asked', async () => {
    for (const site of [undefined, 'none', 'same-site', 'cross-site']) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (site !== undefined) headers['Sec-Fetch-Site'] = site;
      const r = await change('POST', '/api/roster', { member: 'dave', email: 'dave@example.com' }, headers);
      expect(r.status, String(site)).toBe(403);
      expect(r.json().error).toBe('forbidden');
      expect((await change('DELETE', '/api/roster/bob', undefined, headers)).status).toBe(403);
    }
    expect(relayCalls(relay)).toHaveLength(0);
  });

  it('refuses a change that is not application/json (415), a missing key (401), a wrong key (403)', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', '']) {
      const r = await change('POST', '/api/roster', { member: 'dave', email: 'dave@example.com' }, { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': type });
      expect(r.status, type).toBe(415);
    }
    expect((await change('PATCH', '/api/roster/bob', { role: 'owner' }, { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json; charset=utf-8' })).status).toBe(200);
    const noKey = await req(port, '/api/roster', { method: 'POST', headers: SAME_ORIGIN, body: '{"member":"dave","email":"dave@example.com"}' });
    expect(noKey.status).toBe(401);
    const wrong = await req(port, '/api/roster', { method: 'POST', headers: { ...SAME_ORIGIN, 'X-Console-Key': 'y'.repeat(43) }, body: '{}' });
    expect(wrong.status).toBe(403);
    expect(relayCalls(relay).map((c) => c.method)).toEqual(['PATCH']);
  });

  it('allows exactly these methods and paths; everything else stays read-only', async () => {
    const cases: Array<[string, string, number]> = [
      ['PUT', '/api/roster', 405],
      ['PATCH', '/api/roster', 405],
      ['DELETE', '/api/roster', 405],
      ['POST', '/api/roster/bob', 405],
      ['PUT', '/api/roster/bob', 405],
      ['GET', '/api/roster/bob', 404],
      ['POST', '/api/me', 405],
      ['POST', '/api/directory', 405],
      ['DELETE', `/api/requests/rq_${'0'.repeat(32)}`, 405],
      ['POST', '/api/join', 405],
      ['PATCH', '/api/roster/Bob', 404],
      ['DELETE', '/api/roster/bob/x', 405],
      ['DELETE', '/api/roster/%2e%2e', 400],
    ];
    for (const [method, path, status] of cases) {
      const r = method === 'GET' ? await get(path) : await change(method, path, {});
      expect(r.status, `${method} ${path}`).toBe(status);
    }
    expect((await change('POST', '/api/roster', {})).headers.allow).toBeUndefined();
    expect((await change('PUT', '/api/roster', {})).headers.allow).toBe('GET, POST');
    expect((await change('POST', '/api/roster/bob', {})).headers.allow).toBe('PATCH, DELETE');
    expect(relayCalls(relay)).toHaveLength(0);
  });

  it('checks every body before sending it on', async () => {
    const bad: Array<[string, string, string]> = [
      ['POST', '/api/roster', '{"member":"dave"}'],
      ['POST', '/api/roster', '{"member":"Dave","email":"d@example.com"}'],
      ['POST', '/api/roster', '{"member":"dave","email":"not-an-email"}'],
      ['POST', '/api/roster', '{"member":"dave","email":"d@example.com","role":"admin"}'],
      ['POST', '/api/roster', '{"member":"dave","email":"d@example.com","extra":1}'],
      ['POST', '/api/roster', '[]'],
      ['POST', '/api/roster', 'not json'],
      ['POST', '/api/roster', ''],
      ['PATCH', '/api/roster/bob', '{}'],
      ['PATCH', '/api/roster/bob', '{"add_email":"x"}'],
      ['PATCH', '/api/roster/bob', '{"role":"owner","member":"eve"}'],
      ['DELETE', '/api/roster/bob', '{"member":"bob"}'],
      ['DELETE', '/api/roster/bob', '"bob"'],
    ];
    for (const [method, path, body] of bad) {
      const r = await req(port, path, { method, headers: { ...SAME_ORIGIN, 'X-Console-Key': KEY }, body });
      expect(r.status, `${method} ${body}`).toBe(400);
      expect(r.json().error).toBe('bad_request');
    }
    const big = await req(port, '/api/roster', {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'X-Console-Key': KEY },
      body: JSON.stringify({ member: 'dave', email: 'd@example.com', pad: 'x'.repeat(ROSTER_BODY_LIMIT) }),
    });
    expect(big.status).toBe(413);
    expect((await change('POST', '/api/roster?member=x', { member: 'dave', email: 'd@example.com' })).status).toBe(400);
    expect(relayCalls(relay)).toHaveLength(0);
  });

  it("passes the relay's refusal on, with its status, code and detail", async () => {
    const taken = await change('POST', '/api/roster', { member: 'bob', email: 'new@example.com' });
    expect(taken.status).toBe(502);
    expect(taken.json()).toEqual({ error: 'relay_refused', relay_status: 409, relay_error: 'conflict', detail: 'member id or email taken' });
    const lastOwner = await change('DELETE', '/api/roster/alice', undefined);
    expect(lastOwner.json()).toMatchObject({ relay_status: 409, relay_error: 'last_owner' });
  });

  it('a member (not an owner) is refused by the relay; the console adds nothing of its own', async () => {
    await app.close();
    const client = new RelayClient({ url: relay.url, team: 'demo', token: () => TOKEN_OF.bob!, attempts: 1 });
    app = createConsoleServer({ backend: relayBackend(client), key: KEY, staticDir: NO_UI });
    port = await app.listen(0);
    const roster = (await get('/api/roster')).json();
    expect(roster.members.find((m: { member: string }) => m.member === 'alice').emails).toEqual([null]);
    const r = await change('POST', '/api/roster', { member: 'dave', email: 'dave@example.com' });
    expect(r.json()).toMatchObject({ error: 'relay_refused', relay_status: 403, relay_error: 'forbidden' });
  });
});

describe('roster proxy, hosted (M6-SPEC §3, §4)', () => {
  let relay: FakeRelay;
  let app: ConsoleServer;
  let port: number;
  const VIEWER = 'alice@example.com';

  beforeEach(async () => {
    relay = await new FakeRelay().start();
    // The service account's token (a delegate at the real relay) and the viewer on behalf of.
    const client = new RelayClient({ url: relay.url, team: 'demo', token: () => TOKEN_OF.alice!, attempts: 1 });
    app = createConsoleServer({
      backend: relayBackend(client),
      staticDir: NO_UI,
      hosted: { publicHost: PUBLIC_HOST, verify: async (a) => (a === 'good-assertion' ? { email: VIEWER } : null) },
    });
    port = await app.listen(0);
  });
  afterEach(async () => {
    await app.close();
    await relay.stop();
  });

  const hosted = (method: string, path: string, opts: { assertion?: string | null; headers?: Record<string, string>; body?: string } = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.assertion !== null) headers[IAP_HEADER] = opts.assertion ?? 'good-assertion';
    return req(port, path, { method, host: PUBLIC_HOST, headers, body: opts.body });
  };

  it('forwards a change on behalf of the IAP viewer, and refuses one without IAP', async () => {
    const body = JSON.stringify({ member: 'dave', email: 'dave@example.com' });
    const r = await hosted('POST', '/api/roster', { headers: SAME_ORIGIN, body });
    expect(r.status).toBe(201);
    const call = relayCalls(relay)[0]!;
    expect(call.headers['x-relay-on-behalf-of']).toBe(VIEWER);
    expect(call.raw).toBe(body);

    expect((await hosted('POST', '/api/roster', { assertion: null, headers: SAME_ORIGIN, body })).status).toBe(401);
    expect((await hosted('POST', '/api/roster', { assertion: 'forged', headers: SAME_ORIGIN, body })).status).toBe(401);
    expect((await hosted('DELETE', '/api/roster/bob', { headers: { 'Content-Type': 'application/json' } })).status).toBe(403);
    expect((await hosted('DELETE', '/api/roster/bob', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(415);
    expect(relayCalls(relay)).toHaveLength(1);
  });

  const NOT_A_MEMBER = { error: 'not_a_member', detail: 'not on this team' };

  it('a signed-in account on no roster (the relay\'s 403 not_a_member) gets not_on_team and no data', async () => {
    for (const path of ['/api/me', '/api/directory', '/api/activity', '/api/roster']) {
      relay.fail((r) => r.path.startsWith('/v1/teams/demo/'), 403, 1, NOT_A_MEMBER);
      const r = await hosted('GET', path);
      expect(r.status, path).toBe(403);
      expect(r.json(), path).toEqual({ error: 'not_on_team', email: VIEWER });
    }
    relay.fail((r) => r.path === '/v1/teams/demo/roster', 403, 1, NOT_A_MEMBER);
    const change = await hosted('POST', '/api/roster', { headers: SAME_ORIGIN, body: JSON.stringify({ member: 'dave', email: 'dave@example.com' }) });
    expect(change.json()).toEqual({ error: 'not_on_team', email: VIEWER });
  });

  it('a plain 401 from the relay is the console\'s own sign-in failing: passed on, never not_on_team', async () => {
    relay.fail((r) => r.path === '/v1/teams/demo/me', 401, 1);
    const r = await hosted('GET', '/api/me');
    expect(r.status).toBe(502);
    expect(r.json()).toMatchObject({ error: 'relay_refused', relay_status: 401 });
    // Another 403 (an owner-only route for a member) is not not_on_team either.
    relay.fail((r) => r.path === '/v1/teams/demo/roster', 403, 1, { error: 'forbidden' });
    const f = await hosted('POST', '/api/roster', { headers: SAME_ORIGIN, body: JSON.stringify({ member: 'dave', email: 'dave@example.com' }) });
    expect(f.json()).toMatchObject({ error: 'relay_refused', relay_status: 403, relay_error: 'forbidden' });
  });
});

describe('the roster bodies', () => {
  it('lower-cases emails and keeps only the known fields', () => {
    expect(checkAddMember({ member: 'dave', email: 'DAVE@Example.com' })).toEqual({ member: 'dave', email: 'dave@example.com' });
    expect(checkAddMember({ member: 'dave', email: 'd@example.com', role: 'owner' })).toEqual({ member: 'dave', email: 'd@example.com', role: 'owner' });
    expect(checkUpdateMember({ add_email: 'X@Example.com', remove_email: 'y@example.com', role: 'member' })).toEqual({
      add_email: 'x@example.com',
      remove_email: 'y@example.com',
      role: 'member',
    });
    for (const bad of ['a@b', 'a b@example.com', '<a>@example.com', `${'a'.repeat(65)}@example.com`, 'a@example..com']) {
      expect(() => checkAddMember({ member: 'dave', email: bad }), bad).toThrow();
    }
  });
});

describe('--demo roster (M6-SPEC §1 invariants)', () => {
  it('alice owns the demo team; changes follow the relay rules', async () => {
    const team = new DemoTeam();
    const backend = demoBackend(team);
    const roster = (await backend.roster()) as { members: Array<{ member: string; role: string; emails: string[] }> };
    expect(roster.members.map((m) => [m.member, m.role])).toEqual([
      ['alice', 'owner'],
      ['bob', 'member'],
      ['carol', 'member'],
    ]);
    expect(roster.members.flatMap((m) => m.emails).every((e) => e.endsWith('@example.com') || e.endsWith('@example.org'))).toBe(true);
    await backend.addMember({ member: 'dave', email: 'dave@example.com' });
    await expect(backend.addMember({ member: 'dave', email: 'other@example.com' })).rejects.toBeInstanceOf(RosterRefusal);
    await expect(backend.addMember({ member: 'erin', email: 'bob@example.com' })).rejects.toThrow(/already belongs/);
    await expect(backend.removeMember('alice')).rejects.toThrow(/at least one owner/);
    await expect(backend.updateMember('alice', { role: 'member' })).rejects.toThrow(/at least one owner/);
    await backend.updateMember('bob', { role: 'owner' });
    await backend.updateMember('alice', { role: 'member' });
    await expect(backend.updateMember('dave', { remove_email: 'dave@example.com' })).rejects.toThrow(/at least one email/);
    await backend.removeMember('dave');
    await expect(backend.removeMember('dave')).rejects.toBeInstanceOf(NotFound);
  });
});
