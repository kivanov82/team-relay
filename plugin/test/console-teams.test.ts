// M9-SPEC §5 (with §7 items 2, 6, 7): the console server serves several teams. Every
// team-scoped /api/* route takes `team` (query) or X-Relay-Team, checked against the viewer's
// active teams (GET /v1/me/teams, cached briefly); the account routes (GET/POST /api/teams,
// POST /api/invitations/{team}, DELETE /api/teams/{team}, GET /api/admin/teams, DELETE
// /api/admin/teams/{team}) follow the roster changes' rules; hosted, a creation carries
// X-Relay-Client-IP-Hash. The relay here is a fake that records what it was sent.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEAMS_TTL_MS,
  addressKey,
  checkConfirm,
  checkCreateTeam,
  checkInvitationAnswer,
  checkIpHashSalt,
  clientAddress,
  createConsoleServer,
  demoBackend,
  joinInfo,
  parseTeams,
  relayBackend,
  type ConsoleServer,
} from '../src/console-app.js';
import { DEMO_MAX_TEAMS_CREATED, DemoAccount, RosterRefusal, teamIdFromName } from '../src/console-demo.js';
import { RelayClient, staticTokenProvider } from '../src/relay-client.js';

const KEY = 'k'.repeat(43);
const NO_UI = join(tmpdir(), 'team-relay-no-ui-here');
const PUBLIC_HOST = 'team-relay-console-abc123-ey.a.run.app';
const SALT = 'a-salt-of-at-least-32-characters-0123';
const SAME_ORIGIN = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };

type Seen = { method: string; path: string; query: string; headers: IncomingMessage['headers']; body: unknown };

/** The relay's account routes and two teams' reads, for whoever the delegate names. */
class FakeTeamsRelay {
  seen: Seen[] = [];
  url = '';
  /** Per viewer email: their active teams and invitations. */
  teams = new Map<string, { teams: Array<Record<string, unknown>>; invitations: Array<Record<string, unknown>>; admin?: boolean }>();
  /** The next answers, by "METHOD path", when set. */
  answers = new Map<string, { status: number; body: unknown }>();
  private server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? (JSON.parse(text) as unknown) : undefined;
      this.seen.push({ method: req.method ?? '', path: url.pathname, query: url.search, headers: req.headers, body });
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      const canned = this.answers.get(`${req.method} ${url.pathname}`);
      if (canned) {
        this.answers.delete(`${req.method} ${url.pathname}`);
        return json(canned.status, canned.body);
      }
      const viewer = String(req.headers['x-relay-on-behalf-of'] ?? '');
      const mine = this.teams.get(viewer) ?? { teams: [], invitations: [] };
      if (url.pathname === '/v1/me/teams') {
        return json(200, { ...mine, admin: mine.admin === true, teams_created: 1, max_teams_created: 3, suggested_member: 'alice' });
      }
      const m = /^\/v1\/teams\/([^/]+)\/(me|directory|roster|inbox\/summary|activity)$/.exec(url.pathname);
      if (m) {
        if (!mine.teams.some((t) => t.team === m[1])) return json(404, { error: 'not_found' });
        if (m[2] === 'me') return json(200, { team: m[1], member: 'alice', teammates: [] });
        return json(200, { ok: m[2], team: m[1] });
      }
      if (req.method === 'POST' && url.pathname === '/v1/teams') return json(201, { team: 'fresh-team', name: 'Fresh', member: 'alice', role: 'owner', status: 'active' });
      if (req.method === 'POST' && url.pathname.startsWith('/v1/me/invitations/')) return json(200, { status: 'active' });
      if (req.method === 'DELETE' && url.pathname.startsWith('/v1/teams/')) return json(200, { status: 'deleted', removal: 'complete' });
      if (url.pathname === '/v1/admin/teams') return json(200, { teams: [], next: null });
      if (req.method === 'DELETE' && url.pathname.startsWith('/v1/admin/teams/')) return json(200, { status: 'deleted', removal: 'complete' });
      return json(404, { error: 'not_found' });
    });
  });
  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  close() {
    return new Promise<void>((r) => {
      this.server.closeAllConnections();
      this.server.close(() => r());
    });
  }
  paths(): string[] {
    return this.seen.map((s) => `${s.method} ${s.path}${s.query}`);
  }
}

type Res = { status: number; body: string; json: () => any };

function call(port: number, path: string, opts: { method?: string; host?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    const headers: Record<string, string> = { Host: opts.host ?? PUBLIC_HOST, ...(opts.headers ?? {}) };
    if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload));
    const r = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, setHost: false, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

const ALICE = 'alice@example.com';
const DANA = 'dana@example.com';

describe('hosted console, several teams (M9-SPEC §5)', () => {
  let relay: FakeTeamsRelay;
  let app: ConsoleServer;
  let port: number;
  let clock = 1_000_000;

  /** A request as the page sends it, signed in (IAP) as `who`. */
  const as = (who: string, path: string, opts: Parameters<typeof call>[2] = {}) =>
    call(port, path, { ...opts, headers: { 'x-goog-iap-jwt-assertion': `iap:${who}`, ...(opts.headers ?? {}) } });

  beforeEach(async () => {
    relay = await new FakeTeamsRelay().start();
    relay.teams.set(ALICE, {
      teams: [
        { team: 'demo', name: 'Demo', member: 'alice', role: 'owner' },
        { team: 'research', name: 'Research', member: 'alice', role: 'owner' },
      ],
      invitations: [{ team: 'ops', name: 'Operations', member: 'alice', role: 'member', invited_by_member: 'olga' }],
      admin: true,
    });
    // dana is on research only, and invited to demo.
    relay.teams.set(DANA, {
      teams: [{ team: 'research', name: 'Research', member: 'dana', role: 'member' }],
      invitations: [{ team: 'demo', name: 'Demo', member: 'dana', role: 'member', invited_by_member: 'alice' }],
    });
    // A Google identity that can call the account routes (not a device credential).
    const client = new RelayClient({ url: relay.url, team: 'demo', token: () => 'service-account-id-token', attempts: 1 });
    app = createConsoleServer({
      backend: relayBackend(client),
      staticDir: NO_UI,
      join: joinInfo('https://relay.example', 'demo', null),
      now: () => clock,
      hosted: {
        publicHost: PUBLIC_HOST,
        verify: async (a) => (a?.startsWith('iap:') ? { email: a.slice(4) } : null),
        ipHashSalt: SALT,
      },
    });
    port = await app.listen(0);
  });
  afterEach(async () => {
    await app.close();
    await relay.close();
  });

  it('GET /api/teams: the viewer\'s teams and invitations, the default team and their own email', async () => {
    const r = await as(ALICE, '/api/teams');
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({
      teams: [
        { team: 'demo', name: 'Demo', member: 'alice', role: 'owner' },
        { team: 'research', name: 'Research', member: 'alice', role: 'owner' },
      ],
      invitations: [{ team: 'ops', name: 'Operations', member: 'alice', role: 'member', invited_by_member: 'olga' }],
      admin: true,
      teams_created: 1,
      max_teams_created: 3,
      suggested_member: 'alice',
      can_manage_teams: true,
      default_team: 'demo',
      email: ALICE,
    });
    expect(relay.seen[0]!.headers['x-relay-on-behalf-of']).toBe(ALICE);
    expect((await as(ALICE, '/api/teams?x=1')).status).toBe(400);
    // Without IAP, nothing.
    expect((await call(port, '/api/teams')).status).toBe(401);
  });

  it('reads the team named by ?team= or X-Relay-Team, only one the viewer is an active member of', async () => {
    expect((await as(ALICE, '/api/me?team=research')).json()).toMatchObject({ team: 'research', email: ALICE });
    expect((await as(ALICE, '/api/directory', { headers: { 'X-Relay-Team': 'research' } })).json()).toEqual({ ok: 'directory', team: 'research' });
    expect((await as(ALICE, '/api/activity?limit=5&team=research')).json()).toEqual({ ok: 'activity', team: 'research' });
    expect((await as(ALICE, '/api/inbox/summary?team=demo')).json()).toEqual({ ok: 'inbox/summary', team: 'demo' });
    // Both, the same: fine; different, twice, or not a team id: 400, and the relay is not asked.
    expect((await as(ALICE, '/api/roster?team=research', { headers: { 'X-Relay-Team': 'research' } })).status).toBe(200);
    const before = relay.seen.length;
    expect((await as(ALICE, '/api/roster?team=research', { headers: { 'X-Relay-Team': 'demo' } })).status).toBe(400);
    expect((await as(ALICE, '/api/roster?team=demo&team=research')).status).toBe(400);
    expect((await as(ALICE, '/api/roster?team=Bad!')).status).toBe(400);
    expect((await as(ALICE, '/api/me?team=research&x=1')).status).toBe(400);
    expect(relay.seen.length).toBe(before);
    // The relay was read on the viewer's behalf, at the team's own path.
    expect(relay.paths()).toContain('GET /v1/teams/research/directory');
    expect(relay.seen.filter((s) => s.path.startsWith('/v1/teams/')).every((s) => s.headers['x-relay-on-behalf-of'] === ALICE)).toBe(true);
  });

  it('refuses a team the viewer is not on (an invitation is not membership) before asking the relay', async () => {
    for (const path of ['/api/me?team=ops', '/api/roster?team=ops', '/api/activity?team=elsewhere', '/api/join?team=ops']) {
      const r = await as(ALICE, path);
      expect(r.status, path).toBe(403);
      expect(r.json(), path).toEqual({ error: 'not_on_team', email: ALICE, team: path.includes('ops') ? 'ops' : 'elsewhere' });
    }
    expect(relay.paths().filter((p) => p.includes('/v1/teams/'))).toEqual([]);
    // No team named: RELAY_TEAM, only if the viewer is on it. dana is invited there, not on it.
    expect((await as(DANA, '/api/me')).json()).toEqual({ error: 'not_on_team', email: DANA, team: 'demo' });
    expect((await as(DANA, '/api/me?team=research')).status).toBe(200);
    expect((await as(ALICE, '/api/me')).json()).toMatchObject({ team: 'demo' });
    // /api/join names the team asked about.
    expect((await as(DANA, '/api/join?team=research')).json()).toMatchObject({ team: 'research', relay_url: 'https://relay.example' });
  });

  it('keeps the viewer\'s teams for a while, per viewer, and reads them again after', async () => {
    await as(ALICE, '/api/me?team=research');
    await as(ALICE, '/api/directory?team=research');
    await as(DANA, '/api/directory?team=research');
    expect(relay.paths().filter((p) => p === 'GET /v1/me/teams')).toHaveLength(2);
    clock += TEAMS_TTL_MS + 1;
    await as(ALICE, '/api/directory?team=research');
    expect(relay.paths().filter((p) => p === 'GET /v1/me/teams')).toHaveLength(3);
  });

  it('a relay 404 on a team read (removed, or the team deleted) is not_on_team and drops the cached teams', async () => {
    await as(ALICE, '/api/me?team=research');
    relay.answers.set('GET /v1/teams/research/roster', { status: 404, body: { error: 'not_found' } });
    const r = await as(ALICE, '/api/roster?team=research');
    expect(r.status).toBe(403);
    expect(r.json()).toEqual({ error: 'not_on_team', email: ALICE, team: 'research' });
    await as(ALICE, '/api/me?team=research');
    expect(relay.paths().filter((p) => p === 'GET /v1/me/teams')).toHaveLength(2);
    // A request's 404 is about the request, not the team.
    const rid = `rq_${'0'.repeat(32)}`;
    const q = await as(ALICE, `/api/requests/${rid}?team=research`);
    expect(q.status).toBe(404);
    expect(q.json()).toEqual({ error: 'not_found' });
  });

  it('roster changes name their team too, and only one the viewer is on', async () => {
    const add = await as(ALICE, '/api/roster?team=research', { method: 'POST', headers: SAME_ORIGIN, body: { member: 'dave', email: 'dave@example.com' } });
    expect(add.status).toBe(201);
    expect(relay.seen.find((s) => s.path === '/v1/teams/research/roster' && s.method === 'POST')).toMatchObject({ body: { member: 'dave', email: 'dave@example.com' } });
    // The relay's 404 for the team itself (the viewer removed, the team deleted): not_on_team.
    relay.answers.set('POST /v1/teams/research/roster', { status: 404, body: { error: 'not_found' } });
    const gone = await as(ALICE, '/api/roster?team=research', { method: 'POST', headers: SAME_ORIGIN, body: { member: 'erin', email: 'erin@example.com' } });
    expect(gone.json()).toEqual({ error: 'not_on_team', email: ALICE, team: 'research' });
    const other = await as(ALICE, '/api/roster/dave?team=ops', { method: 'DELETE', headers: SAME_ORIGIN });
    expect(other.json()).toEqual({ error: 'not_on_team', email: ALICE, team: 'ops' });
    expect(relay.paths()).not.toContain('DELETE /v1/teams/ops/roster/dave');
  });

  it('POST /api/teams: checks the body, sends it on behalf of the viewer with the hashed address', async () => {
    const r = await as(ALICE, '/api/teams', {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'X-Forwarded-For': '198.51.100.9, 203.0.113.7' },
      body: { name: '  Platform  ', id: 'platform', owner_member_id: 'alice' },
    });
    expect(r.status).toBe(201);
    expect(r.json()).toMatchObject({ team: 'fresh-team', role: 'owner' });
    const sent = relay.seen.find((s) => s.method === 'POST' && s.path === '/v1/teams')!;
    expect(sent.body).toEqual({ name: 'Platform', id: 'platform', owner_member_id: 'alice' });
    expect(sent.headers['x-relay-on-behalf-of']).toBe(ALICE);
    // The right-most X-Forwarded-For entry (the front end's), salted: never the address itself.
    const expected = createHash('sha256').update(`${SALT}203.0.113.7`).digest('hex');
    expect(sent.headers['x-relay-client-ip-hash']).toBe(expected);
    expect(JSON.stringify(sent.headers)).not.toContain('203.0.113.7" ');
    // A client that writes its own X-Forwarded-For entries cannot pick its bucket.
    await as(ALICE, '/api/teams', {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'X-Forwarded-For': '10.0.0.1, 10.0.0.2, 203.0.113.7' },
      body: { name: 'Other', owner_member_id: 'alice' },
    });
    const second = relay.seen.filter((s) => s.method === 'POST' && s.path === '/v1/teams')[1]!;
    expect(second.headers['x-relay-client-ip-hash']).toBe(expected);
    expect(second.body).toEqual({ name: 'Other', owner_member_id: 'alice' });
  });

  it('POST /api/teams: refuses bad bodies, cross-site calls and other media types before the relay', async () => {
    const post = (body: unknown, headers: Record<string, string> = SAME_ORIGIN) => as(ALICE, '/api/teams', { method: 'POST', headers, body });
    for (const bad of [
      {},
      { name: '', owner_member_id: 'alice' },
      { name: 'x'.repeat(61), owner_member_id: 'alice' },
      { name: 'Bad‮name', owner_member_id: 'alice' },
      { name: 'Tab\tname', owner_member_id: 'alice' },
      { name: 'Ok', owner_member_id: 'A' },
      { name: 'Ok', owner_member_id: 'alice', id: 'ab' },
      { name: 'Ok', owner_member_id: 'alice', id: 'Has_Upper' },
      { name: 'Ok', owner_member_id: 'alice', extra: 1 },
      [],
      'text',
    ]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post({ name: 'Ok', owner_member_id: 'alice' }, { 'Content-Type': 'application/json' })).status).toBe(403);
    expect((await post({ name: 'Ok', owner_member_id: 'alice' }, { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(415);
    expect((await post('x'.repeat(5000))).status).toBe(413);
    expect((await as(ALICE, '/api/teams?name=x', { method: 'POST', headers: SAME_ORIGIN, body: { name: 'Ok', owner_member_id: 'alice' } })).status).toBe(400);
    expect((await as(ALICE, '/api/teams', { method: 'PUT', headers: SAME_ORIGIN, body: {} })).status).toBe(405);
    expect(relay.paths().filter((p) => p.startsWith('POST /v1/teams'))).toEqual([]);
  });

  it("POST /api/teams: the relay's refusal is passed on with its code (team_limit, team_id_unavailable, rate_limited)", async () => {
    for (const [status, code] of [
      [409, 'team_limit'],
      [409, 'team_id_unavailable'],
      [409, 'team_name_unavailable'],
      [429, 'rate_limited'],
    ] as const) {
      relay.answers.set('POST /v1/teams', { status, body: { error: code, detail: `detail for ${code}` } });
      const r = await as(ALICE, '/api/teams', { method: 'POST', headers: SAME_ORIGIN, body: { name: 'Ok', owner_member_id: 'alice' } });
      expect(r.status).toBe(502);
      expect(r.json()).toEqual({ error: 'relay_refused', relay_status: status, relay_error: code, detail: `detail for ${code}` });
    }
  });

  it('a creation or an answered invitation drops the cached teams, so the new team is usable at once', async () => {
    await as(ALICE, '/api/me?team=research');
    expect(relay.paths().filter((p) => p === 'GET /v1/me/teams')).toHaveLength(1);
    const accepted = await as(ALICE, '/api/invitations/ops', { method: 'POST', headers: SAME_ORIGIN, body: { accept: true } });
    expect(accepted.status).toBe(200);
    expect(relay.seen.find((s) => s.path === '/v1/me/invitations/ops')).toMatchObject({ method: 'POST', body: { accept: true } });
    relay.teams.get(ALICE)!.teams.push({ team: 'ops', name: 'Operations', member: 'alice', role: 'member' });
    expect((await as(ALICE, '/api/me?team=ops')).status).toBe(200);
    expect(relay.paths().filter((p) => p === 'GET /v1/me/teams')).toHaveLength(2);
  });

  it('POST /api/invitations/{team}: exactly {"accept": boolean}, a team id in the path', async () => {
    const post = (path: string, body: unknown) => as(DANA, path, { method: 'POST', headers: SAME_ORIGIN, body });
    expect((await post('/api/invitations/demo', { accept: false })).status).toBe(200);
    expect(relay.seen.find((s) => s.path === '/v1/me/invitations/demo')).toMatchObject({ body: { accept: false } });
    expect(relay.seen.find((s) => s.path === '/v1/me/invitations/demo')!.headers['x-relay-on-behalf-of']).toBe(DANA);
    for (const bad of [{}, { accept: 'yes' }, { accept: true, team: 'demo' }, null]) expect((await post('/api/invitations/demo', bad)).status).toBe(400);
    expect((await post('/api/invitations/Not-A-Team!', { accept: true })).status).toBe(404);
    expect((await post('/api/invitations/demo/x', { accept: true })).status).toBe(405);
    expect((await as(DANA, '/api/invitations/demo', { method: 'DELETE', headers: SAME_ORIGIN })).status).toBe(405);
  });

  it('DELETE /api/teams/{team}: the id typed again, a team the viewer is on, sent to the relay', async () => {
    const del = (who: string, team: string, body: unknown) => as(who, `/api/teams/${team}`, { method: 'DELETE', headers: SAME_ORIGIN, body });
    expect((await del(ALICE, 'research', { confirm: 'researc' })).status).toBe(400);
    expect((await del(ALICE, 'research', {})).status).toBe(400);
    expect((await del(ALICE, 'research', { confirm: 'research', also: 1 })).status).toBe(400);
    expect(relay.paths().filter((p) => p.startsWith('DELETE'))).toEqual([]);
    // Not on it: not_on_team, nothing asked.
    expect((await del(DANA, 'demo', { confirm: 'demo' })).json()).toEqual({ error: 'not_on_team', email: DANA, team: 'demo' });
    const ok = await del(ALICE, 'research', { confirm: 'research' });
    expect(ok.status).toBe(200);
    const sent = relay.seen.find((s) => s.method === 'DELETE')!;
    expect(sent.path).toBe('/v1/teams/research');
    expect(sent.body).toEqual({ confirm: 'research' });
    expect(sent.headers['x-relay-on-behalf-of']).toBe(ALICE);
    // An owner-only refusal from the relay is passed on.
    relay.answers.set('DELETE /v1/teams/research', { status: 409, body: { error: 'seed_team', detail: 'from the file' } });
    expect((await del(ALICE, 'research', { confirm: 'research' })).json()).toMatchObject({ relay_status: 409, relay_error: 'seed_team' });
  });

  it('GET and DELETE /api/admin/teams: checked queries and bodies; the relay decides who is an admin', async () => {
    expect((await as(ALICE, '/api/admin/teams?after=research&limit=50')).status).toBe(200);
    expect(relay.paths()).toContain('GET /v1/admin/teams?after=research&limit=50');
    for (const q of ['?limit=0', '?limit=1001', '?limit=x', '?after=Bad!', '?after=a&after=b', '?other=1']) {
      expect((await as(ALICE, `/api/admin/teams${q}`)).status, q).toBe(400);
    }
    const del = await as(ALICE, '/api/admin/teams/field-notes', { method: 'DELETE', headers: SAME_ORIGIN, body: { confirm: 'field-notes' } });
    expect(del.status).toBe(200);
    expect(relay.seen.find((s) => s.method === 'DELETE')).toMatchObject({ path: '/v1/admin/teams/field-notes', body: { confirm: 'field-notes' } });
    expect((await as(ALICE, '/api/admin/teams/field-notes', { method: 'DELETE', headers: SAME_ORIGIN, body: { confirm: 'other' } })).status).toBe(400);
    expect((await as(ALICE, '/api/admin/teams/field-notes', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: { confirm: 'field-notes' } })).status).toBe(403);
    // A viewer who is not an admin: the relay's 403, passed on.
    relay.answers.set('GET /v1/admin/teams', { status: 403, body: { error: 'forbidden', detail: 'Only a relay admin can do this.' } });
    expect((await as(DANA, '/api/admin/teams')).json()).toMatchObject({ error: 'relay_refused', relay_status: 403 });
  });
});

describe('local console, a sign-in bound to one team (a stored credential or a static token)', () => {
  let relay: FakeTeamsRelay;
  let app: ConsoleServer;
  let port: number;
  const local = (path: string, opts: Parameters<typeof call>[2] = {}) =>
    call(port, path, { ...opts, host: `127.0.0.1:${port}`, headers: { 'X-Console-Key': KEY, ...(opts.headers ?? {}) } });

  beforeEach(async () => {
    relay = await new FakeTeamsRelay().start();
    relay.teams.set('', { teams: [{ team: 'demo', name: 'Demo', member: 'alice', role: 'owner' }], invitations: [] });
    const client = new RelayClient({ url: relay.url, team: 'demo', token: staticTokenProvider('static-token'), attempts: 1 });
    app = createConsoleServer({ backend: relayBackend(client), key: KEY, staticDir: NO_UI });
    port = await app.listen(0);
  });
  afterEach(async () => {
    await app.close();
    await relay.close();
  });

  it('GET /api/teams is its one team, from /me; no invitations, no creating; the account route is never asked', async () => {
    const r = await local('/api/teams');
    expect(r.json()).toEqual({
      teams: [{ team: 'demo', name: 'demo', member: 'alice', role: 'member' }],
      invitations: [],
      admin: false,
      teams_created: null,
      max_teams_created: null,
      suggested_member: null,
      can_manage_teams: false,
      default_team: 'demo',
    });
    expect(relay.paths()).toEqual(['GET /v1/teams/demo/me']);
  });

  it('reads its team with no /v1/me/teams, refuses any other, and sends no address hash on a creation', async () => {
    expect((await local('/api/directory?team=demo')).status).toBe(200);
    expect((await local('/api/directory')).status).toBe(200);
    expect((await local('/api/directory?team=research')).json()).toEqual({ error: 'not_on_team', team: 'research' });
    expect(relay.paths()).toEqual(['GET /v1/teams/demo/directory', 'GET /v1/teams/demo/directory']);
    await local('/api/teams', { method: 'POST', headers: SAME_ORIGIN, body: { name: 'Ok', owner_member_id: 'alice' } });
    const sent = relay.seen.find((s) => s.method === 'POST')!;
    expect(sent.headers['x-relay-client-ip-hash']).toBeUndefined();
    expect(sent.headers['x-relay-on-behalf-of']).toBeUndefined();
  });

  it('/api/join names the team asked about without asking the relay (nothing secret, the key holder is the member)', async () => {
    const withJoin = createConsoleServer({ backend: relayBackend(new RelayClient({ url: relay.url, team: 'demo', token: () => 'google-id-token', attempts: 1 })), key: KEY, staticDir: NO_UI, join: joinInfo('https://relay.example', 'demo', null) });
    const p = await withJoin.listen(0);
    try {
      const r = await call(p, '/api/join?team=research', { host: `127.0.0.1:${p}`, headers: { 'X-Console-Key': KEY } });
      expect(r.json()).toMatchObject({ team: 'research' });
      expect(relay.seen).toHaveLength(0);
    } finally {
      await withJoin.close();
    }
  });
});

describe('the viewer\'s address (M9-SPEC §7.6)', () => {
  const reqWith = (xff: string | undefined, remote = '127.0.0.1') =>
    ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;

  it('is the right-most X-Forwarded-For entry, else the socket peer', () => {
    expect(clientAddress(reqWith('1.2.3.4'))).toBe('1.2.3.4');
    expect(clientAddress(reqWith('9.9.9.9, 1.2.3.4'))).toBe('1.2.3.4');
    expect(clientAddress(reqWith('9.9.9.9,1.2.3.4 ,'))).toBe('1.2.3.4');
    expect(clientAddress(reqWith(undefined, '10.1.2.3'))).toBe('10.1.2.3');
    expect(clientAddress(reqWith('', '10.1.2.3'))).toBe('10.1.2.3');
  });

  it('counts IPv4 as itself, IPv6 per /64, a mapped IPv4 as IPv4, and anything else as one bucket', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0DB8:0001:0002:ffff::1')).toBe('2001:db8:1:2::/64');
    expect(addressKey('[2001:db8:1:2::9]:443')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(addressKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(addressKey('not an address')).toBe('unknown');
    expect(addressKey('')).toBe('unknown');
  });

  it('needs a salt of at least 32 characters', () => {
    expect(() => checkIpHashSalt(undefined)).toThrow(/CONSOLE_IP_HASH_SALT/);
    expect(() => checkIpHashSalt('x'.repeat(31))).toThrow(/CONSOLE_IP_HASH_SALT/);
    expect(checkIpHashSalt(` ${'x'.repeat(32)}\n`)).toBe('x'.repeat(32));
    expect(() =>
      createConsoleServer({
        backend: demoBackend(new DemoAccount()),
        staticDir: NO_UI,
        hosted: { publicHost: PUBLIC_HOST, verify: async () => null, ipHashSalt: 'short' },
      }),
    ).toThrow(/CONSOLE_IP_HASH_SALT/);
  });
});

describe('the account bodies and the teams answer', () => {
  it('checks a creation, an invitation answer and a confirmation', () => {
    expect(checkCreateTeam({ name: ' A team ', owner_member_id: 'al' })).toEqual({ name: 'A team', owner_member_id: 'al' });
    expect(checkCreateTeam({ name: 'Ünïcode ✓', owner_member_id: 'al', id: 'abc' })).toEqual({ name: 'Ünïcode ✓', owner_member_id: 'al', id: 'abc' });
    expect(() => checkCreateTeam({ name: 'zero​width', owner_member_id: 'al' })).toThrow();
    expect(checkInvitationAnswer({ accept: true })).toBe(true);
    expect(() => checkInvitationAnswer({ accept: 1 })).toThrow();
    expect(checkConfirm({ confirm: 'demo' }, 'demo')).toBe('demo');
    expect(() => checkConfirm({ confirm: 'Demo' }, 'demo')).toThrow(/type the team id/);
  });

  it('keeps only well-formed teams and invitations, and never lists a team twice', () => {
    const view = parseTeams({
      teams: [
        { team: 'demo', name: 'Demo', member: 'alice', role: 'owner' },
        { team: 'BAD', member: 'alice', role: 'owner' },
        { team: 'x2', member: 'Nope', role: 'owner' },
        { team: 'ok-team', name: 'Evil‮name', member: 'alice', role: 'admin' },
        { team: 'demo', member: 'alice', role: 'member' },
        'junk',
      ],
      invitations: [{ team: 'demo', member: 'alice' }, { team: 'ops', member: 'alice', invited_by_member: '<b>' }],
      admin: 'yes',
      teams_created: -1,
    });
    expect(view.teams).toEqual([
      { team: 'demo', name: 'Demo', member: 'alice', role: 'owner' },
      { team: 'ok-team', name: 'ok-team', member: 'alice', role: 'member' },
    ]);
    expect(view.invitations).toEqual([{ team: 'ops', name: 'ops', member: 'alice', role: 'member', invited_by_member: null }]);
    expect(view.admin).toBe(false);
    expect(view.teams_created).toBeNull();
    expect(parseTeams(null)).toMatchObject({ teams: [], invitations: [], can_manage_teams: true });
  });
});

describe('--demo account (M9-SPEC)', () => {
  it('lists alice\'s teams and invitation, creates (at most 3), refuses by the relay\'s rules, accepts and deletes', async () => {
    const account = new DemoAccount();
    const backend = demoBackend(account);
    const mine = account.myTeams();
    expect(mine.teams.map((t) => [t.team, t.role])).toEqual([
      ['demo', 'owner'],
      ['research', 'owner'],
    ]);
    expect(mine.invitations.map((i) => i.team)).toEqual(['ops']);
    expect(mine).toMatchObject({ admin: true, teams_created: 1, max_teams_created: DEMO_MAX_TEAMS_CREATED });
    await expect(backend.createTeam({ name: 'x', id: 'demo', owner_member_id: 'alice' })).rejects.toMatchObject({ code: 'team_id_unavailable' });
    await expect(backend.createTeam({ name: 'x', id: 'research', owner_member_id: 'alice' })).rejects.toMatchObject({ code: 'team_id_unavailable' });
    await expect(backend.createTeam({ name: ' DEMO ', id: 'my-demo', owner_member_id: 'alice' })).rejects.toMatchObject({ code: 'team_name_unavailable' });
    expect(await backend.createTeam({ name: 'Platform Team', owner_member_id: 'al' })).toMatchObject({ team: 'platform-team', member: 'al', role: 'owner' });
    expect(await backend.me({ team: 'platform-team' })).toMatchObject({ team: 'platform-team', member: 'al', role: 'owner', teammates: [] });
    await backend.createTeam({ name: 'Third', owner_member_id: 'alice' });
    await expect(backend.createTeam({ name: 'Fourth', owner_member_id: 'alice' })).rejects.toMatchObject({ code: 'team_limit' });
    // Accepting makes the team one of alice's; she is a member there, not an owner.
    expect(await backend.answerInvitation('ops', true)).toMatchObject({ team: 'ops', status: 'active' });
    expect(account.myTeams().invitations).toEqual([]);
    await expect(backend.answerInvitation('ops', true)).rejects.toBeInstanceOf(RosterRefusal);
    await expect(backend.deleteTeam('ops', { team: 'ops' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(backend.deleteTeam('demo', { team: 'demo' })).rejects.toMatchObject({ code: 'seed_team' });
    await expect(backend.deleteTeam('wrong', { team: 'third' })).rejects.toMatchObject({ code: 'confirm_mismatch' });
    expect(await backend.deleteTeam('third', { team: 'third' })).toMatchObject({ team: 'third', status: 'deleted', removal: 'complete' });
    // Deleting frees a slot; the id stays reserved.
    expect(account.myTeams().teams_created).toBe(2);
    await expect(backend.createTeam({ name: 'Again', id: 'third', owner_member_id: 'alice' })).rejects.toMatchObject({ code: 'team_id_unavailable' });
  });

  it('pages the admin listing, the file\'s team first, and an admin deletes', async () => {
    const account = new DemoAccount();
    const first = account.adminTeams({ limit: 2 });
    expect(first.teams.map((t) => t.id)).toEqual(['demo', 'design-guild', 'field-notes']);
    expect(first.next).toBe('field-notes');
    const second = account.adminTeams({ after: first.next!, limit: 2 });
    expect(second.teams.map((t) => t.id)).toEqual(['old-pilot', 'ops']);
    expect(second.teams[0]).toMatchObject({ status: 'deleted', removal: 'complete' });
    const research = account.adminTeams({ after: 'ops' }).teams.find((t) => t.id === 'research')!;
    expect(research).toMatchObject({ members: 2, owners: 1, seed: false, created_by_member: 'alice' });
    expect(() => account.adminDeleteTeam('demo', 'demo')).toThrow(/team file/);
    expect(account.adminDeleteTeam('research', 'research')).toMatchObject({ status: 'deleted' });
    expect(account.myTeams().teams.map((t) => t.team)).toEqual(['demo']);
  });

  it('makes a team id from a name as the relay does', () => {
    expect(teamIdFromName('Platform Team')).toBe('platform-team');
    expect(teamIdFromName('  2025 plans!  ')).toBe('team-2025-plans');
    expect(teamIdFromName('Ω')).toBe('team');
    expect(teamIdFromName('x'.repeat(40))).toHaveLength(32);
  });
});
