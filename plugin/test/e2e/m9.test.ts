// The M9 plugin-side e2e scenario (M9-SPEC §6, with §7 items 2, 6 and 7), against the real
// relay started through relay/tests/fake_oauth_app.py (a fake Google on the same port), whose
// team file (scripts/e2e.sh) names admin@example.com a relay admin and a synthetic service
// account the console's any-team delegate:
//
//   A. a new account (erin, on no team) signs in with the real login tool; the stub browser
//      creates a team on the relay's "You're not on a team yet" page and continues with it;
//   B. erin invites frank through the console server (hosted mode, in this process: IAP is
//      stood in for, the delegate's ID token comes from the fake Google); frank's Google
//      identity sees the invitation and nothing of the team;
//   C. frank signs in, accepting the invitation on the chooser first;
//   D. erin and frank exchange a question with their stored credentials;
//   E. erin creates a second team through the console (the relay needs the console's
//      X-Relay-Client-IP-Hash for that) and deletes it as its owner;
//   F. an admin deletes the first team through the console; both credentials are refused at
//      once, erin's session says to sign in again, and the console shows the team to nobody.
//
// Run through ../scripts/e2e.sh, which sets E2E_M9=1 only when the relay serves GET
// /v1/me/teams and the fake OAuth launcher. Every identity is synthetic (example.com).

import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsoleServer, relayBackend, type ConsoleServer } from '../../src/console-app.js';
import { RelayClient } from '../../src/relay-client.js';
import { FIXTURES } from '../helpers/mcp.js';
import { ENABLED, Party, api, googleIdToken, relayUrl, until } from './harness.js';

const M9 = ENABLED && process.env.E2E_M9 === '1';
const DELIVERY_MS = 15_000;
const CREDENTIAL_RE = /^trc_[A-Za-z0-9_-]{43}$/;
const CONSOLE_SA = 'team-relay-console@e2e-project.iam.gserviceaccount.com';
const PUBLIC_HOST = 'team-relay-console.e2e.example';

const SUFFIX = randomBytes(3).toString('hex');
const TEAM = `e2e-${SUFFIX}`;
const TEAM_NAME = `E2E crew ${SUFFIX}`;
const SECOND = `e2e-${SUFFIX}-two`;
const ERIN = `erin.${SUFFIX}@example.com`;
const FRANK = `frank.${SUFFIX}@example.com`;
const ADMIN = 'admin@example.com';

const open: Party[] = [];
let consoleApp: ConsoleServer | null = null;

afterAll(async () => {
  while (open.length) await open.pop()!.close();
  await consoleApp?.close();
});

type Signed = { party: Party; xdg: string; file: string; log: string };

/** A working session with no stored sign-in, whose browser is the headless stub. */
async function freshAsker(label: string, email: string, browser: Record<string, string>): Promise<Signed> {
  const xdg = mkdtempSync(join(tmpdir(), `team-relay-e2e-${label}-`));
  const log = join(xdg, 'browser.log');
  const party = await Party.start(`${label}-asker`, 'channel.js', {
    RELAY_ROLE: 'asker',
    RELAY_AUTH: '',
    RELAY_URL: relayUrl(),
    XDG_CONFIG_HOME: xdg,
    TEAM_RELAY_OPEN_COMMAND: join(FIXTURES, 'fake-browser.mjs'),
    FAKE_BROWSER_LOG: log,
    FAKE_BROWSER_EMAIL: email,
    TEAM_RELAY_CHANNEL: '1',
    TEAM_RELAY_AUTO_ANSWER: '0',
    ...browser,
  });
  open.push(party);
  return { party, xdg, file: join(xdg, 'team-relay', 'credentials.json'), log };
}

function browserLog(s: Signed): { steps: Array<{ url: string; status: number; pressed?: string }>; done: boolean } {
  try {
    return JSON.parse(readFileSync(s.log, 'utf8').trim().split('\n').at(-1)!) as ReturnType<typeof browserLog>;
  } catch {
    return { steps: [], done: false };
  }
}

/** The login tool, then login_wait: the stored credential. */
async function signIn(s: Signed, member: string, team: string): Promise<string> {
  const r = await s.party.ok('login', {});
  expect(r.status).toBe('waiting_for_browser');
  const waited = await s.party.call('login_wait', {});
  if (waited.isError) {
    throw new Error(`login_wait: ${waited.text}; browser: ${JSON.stringify(browserLog(s)).slice(0, 1500)}; stderr: ${s.party.stderr().slice(-1500)}`);
  }
  expect(String(waited.json.message)).toMatch(new RegExp(`^Connected as ${member}( \\([^)]+\\))? on team ${team}$`));
  const stored = JSON.parse(readFileSync(s.file, 'utf8')) as { credential: string; team: string; member: string };
  expect(stored).toMatchObject({ team, member });
  expect(stored.credential).toMatch(CREDENTIAL_RE);
  return stored.credential;
}

// ---------------------------------------------------------------------------------------
// The hosted console server, in this process: IAP stood in for by `iap:<email>`, the relay
// read as the any-team delegate with its ID token from the fake Google.

async function startConsole(): Promise<number> {
  let cached: { token: string; at: number } | null = null;
  const token = Object.assign(
    async () => {
      if (!cached || Date.now() - cached.at > 10 * 60_000) cached = { token: await googleIdToken(CONSOLE_SA), at: Date.now() };
      return cached.token;
    },
    { invalidate: () => (cached = null) },
  );
  const client = new RelayClient({ url: relayUrl(), team: 'demo', token, attempts: 1 });
  consoleApp = createConsoleServer({
    backend: relayBackend(client),
    staticDir: join(tmpdir(), 'team-relay-e2e-no-ui'),
    hosted: {
      publicHost: PUBLIC_HOST,
      verify: async (a) => (a?.startsWith('iap:') ? { email: a.slice(4) } : null),
      ipHashSalt: randomBytes(24).toString('hex'),
    },
  });
  return consoleApp.listen(0);
}

type Res = { status: number; json: any };

/** A call to the console as the page sends it, signed in as `who`. */
function consoleCall(port: number, who: string, method: string, path: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Host: PUBLIC_HOST,
      'x-goog-iap-jwt-assertion': `iap:${who}`,
      // What Google's front end appends: the viewer's address, right-most.
      'X-Forwarded-For': '203.0.113.50',
    };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers['Sec-Fetch-Site'] = 'same-origin';
    }
    if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload));
    const r = httpRequest({ host: '127.0.0.1', port, path, method, headers, setHost: false, agent: false }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString('utf8')));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = { raw: text.slice(0, 200) };
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

describe.skipIf(!M9)('M9: anyone can create a team', () => {
  let port = 0;
  let erin: Signed;
  let frank: Signed;
  let erinCredential = '';
  let frankCredential = '';

  it('A. a new account creates a team on the sign-in page and is signed in to it as its owner', async () => {
    port = await startConsole();
    // erin is on no team yet: the console offers nothing but creating one.
    const before = await consoleCall(port, ERIN, 'GET', '/api/teams');
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({ teams: [], invitations: [], admin: false, email: ERIN, can_manage_teams: true });

    erin = await freshAsker('erin', ERIN, { FAKE_BROWSER_CREATE: `${TEAM_NAME}|${TEAM}|erin` });
    erinCredential = await signIn(erin, 'erin', TEAM);
    const log = browserLog(erin);
    expect(log.done).toBe(true);
    expect(log.steps.map((x) => new URL(x.url).pathname)).toEqual(expect.arrayContaining(['/v1/login/callback', '/v1/login/create', '/v1/login/choose']));

    const me = await api(erinCredential, 'GET', `/v1/teams/${TEAM}/me`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ team: TEAM, member: 'erin', role: 'owner', name: TEAM_NAME });
    const now = await consoleCall(port, ERIN, 'GET', '/api/teams');
    expect(now.json.teams).toEqual([{ team: TEAM, name: TEAM_NAME, member: 'erin', role: 'owner' }]);
    expect(now.json.teams_created).toBe(1);
  }, 120_000);

  it('B. erin invites frank through the console; the invitation grants frank nothing yet', async () => {
    const invited = await consoleCall(port, ERIN, 'POST', `/api/roster?team=${TEAM}`, { member: 'frank', email: FRANK });
    expect(invited.status, JSON.stringify(invited.json)).toBe(201);
    expect(invited.json).toMatchObject({ member: 'frank', status: 'invited' });
    const roster = await consoleCall(port, ERIN, 'GET', `/api/roster?team=${TEAM}`);
    expect(roster.json.members.find((m: { member: string }) => m.member === 'frank')).toMatchObject({ status: 'invited', emails: [FRANK] });

    const franks = await consoleCall(port, FRANK, 'GET', '/api/teams');
    expect(franks.json.teams).toEqual([]);
    expect(franks.json.invitations).toEqual([{ team: TEAM, name: TEAM_NAME, member: 'frank', role: 'member', invited_by_member: 'erin' }]);
    // Not a member: no data of the team, from the console or the relay.
    const nosy = await consoleCall(port, FRANK, 'GET', `/api/directory?team=${TEAM}`);
    expect(nosy.status).toBe(403);
    expect(nosy.json).toEqual({ error: 'not_on_team', email: FRANK, team: TEAM });
    expect((await api(await googleIdToken(FRANK), 'GET', `/v1/teams/${TEAM}/me`)).status).toBe(401);
  }, 60_000);

  it('C. frank accepts the invitation on the chooser and signs in', async () => {
    frank = await freshAsker('frank', FRANK, { FAKE_BROWSER_ACCEPT: TEAM });
    frankCredential = await signIn(frank, 'frank', TEAM);
    expect(browserLog(frank).steps.map((x) => new URL(x.url).pathname)).toEqual(
      expect.arrayContaining(['/v1/login/invitation', '/v1/login/choose']),
    );
    const roster = await consoleCall(port, ERIN, 'GET', `/api/roster?team=${TEAM}`);
    expect(roster.json.members.find((m: { member: string }) => m.member === 'frank')).toMatchObject({ status: 'active' });
    expect((await consoleCall(port, FRANK, 'GET', '/api/teams')).json.teams).toEqual([
      { team: TEAM, name: TEAM_NAME, member: 'frank', role: 'member' },
    ]);
  }, 120_000);

  it('D. erin and frank exchange a question with their stored credentials', async () => {
    const answerer = await Party.start('frank-answerer-m9', 'channel.js', {
      RELAY_ROLE: 'answerer',
      RELAY_AUTH: 'credential',
      RELAY_CREDENTIALS_FILE: frank.file,
      RELAY_URL: relayUrl(),
      RELAY_TEAM: TEAM,
      TEAM_RELAY_CHANNEL: '1',
      XDG_CONFIG_HOME: frank.xdg,
      TEAM_RELAY_AUTO_ANSWER: '0',
    });
    open.push(answerer);
    await until(async () => {
      const t = await erin.party.call('list_teammates', {});
      return !t.isError && t.text.includes('frank') ? true : null;
    }, 20_000, 'frank among erin\'s teammates');
    const asked = await erin.party.ok('ask_question', { to: ['frank'], question: 'M9: does the new team work?' });
    const rid = asked.request_id as string;
    await answerer.waitNote((n) => n.meta.request_id === rid, DELIVERY_MS, 'the question at frank');
    await answerer.ok('ack_question', { request_id: rid });
    await answerer.ok('reply', { request_id: rid, text: 'It does, from a team nobody configured.' });
    const answer = await erin.party.waitNote((n) => n.meta.request_id === rid && n.meta.type === 'answer', DELIVERY_MS, 'the answer at erin');
    expect(answer.content).toContain('from a team nobody configured');
    await answerer.close();
    // The console shows the exchange to both, on their behalf.
    const feed = await consoleCall(port, FRANK, 'GET', `/api/activity?team=${TEAM}`);
    expect(feed.status).toBe(200);
    expect(feed.json.requests.map((r: { request_id: string }) => r.request_id)).toContain(rid);
  }, 90_000);

  it('E. erin creates a second team through the console and deletes it as its owner', async () => {
    const created = await consoleCall(port, ERIN, 'POST', '/api/teams', { name: `Second ${SUFFIX}`, id: SECOND, owner_member_id: 'erin' });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json).toMatchObject({ team: SECOND, member: 'erin', role: 'owner' });
    const teams = await consoleCall(port, ERIN, 'GET', '/api/teams');
    expect(teams.json.teams.map((t: { team: string }) => t.team).sort()).toEqual([TEAM, SECOND].sort());
    expect(teams.json.teams_created).toBe(2);
    // The same id again: the relay's one answer for a taken id, passed on.
    const taken = await consoleCall(port, ERIN, 'POST', '/api/teams', { name: 'Again', id: SECOND, owner_member_id: 'erin' });
    expect(taken.json).toMatchObject({ error: 'relay_refused', relay_status: 409, relay_error: 'team_id_unavailable' });
    // A member who is not an owner cannot delete a team; the id must be typed again.
    expect((await consoleCall(port, FRANK, 'DELETE', `/api/teams/${TEAM}`, { confirm: TEAM })).json).toMatchObject({ relay_status: 403 });
    expect((await consoleCall(port, ERIN, 'DELETE', `/api/teams/${SECOND}`, { confirm: 'nope' })).status).toBe(400);
    const deleted = await consoleCall(port, ERIN, 'DELETE', `/api/teams/${SECOND}`, { confirm: SECOND });
    expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
    expect(deleted.json).toMatchObject({ team: SECOND, status: 'deleted' });
    const after = await consoleCall(port, ERIN, 'GET', '/api/teams');
    expect(after.json.teams.map((t: { team: string }) => t.team)).toEqual([TEAM]);
    expect(after.json.teams_created).toBe(1);
  }, 60_000);

  it('F. an admin deletes the team through the console; both members are refused', async () => {
    // Only an admin sees every team.
    expect((await consoleCall(port, ERIN, 'GET', '/api/admin/teams')).json).toMatchObject({ error: 'relay_refused', relay_status: 403 });
    const all = await consoleCall(port, ADMIN, 'GET', '/api/admin/teams?limit=1000');
    expect(all.status).toBe(200);
    const row = all.json.teams.find((t: { id: string }) => t.id === TEAM);
    expect(row).toMatchObject({ id: TEAM, name: TEAM_NAME, status: 'active', seed: false, created_by_member: 'erin', members: 2, owners: 1 });
    expect(JSON.stringify(all.json)).not.toContain('@');
    expect(all.json.teams.find((t: { id: string }) => t.id === 'demo')).toMatchObject({ seed: true });
    // A team of the file cannot be deleted, and the id must be typed again.
    expect((await consoleCall(port, ADMIN, 'DELETE', '/api/admin/teams/demo', { confirm: 'demo' })).json).toMatchObject({ relay_error: 'seed_team' });
    expect((await consoleCall(port, ADMIN, 'DELETE', `/api/admin/teams/${TEAM}`, { confirm: 'x' })).status).toBe(400);

    const gone = await consoleCall(port, ADMIN, 'DELETE', `/api/admin/teams/${TEAM}`, { confirm: TEAM });
    expect(gone.status, JSON.stringify(gone.json)).toBe(200);
    expect(gone.json).toMatchObject({ team: TEAM, status: 'deleted' });

    // Refused at once, both of them.
    expect((await api(erinCredential, 'GET', `/v1/teams/${TEAM}/me`)).status).toBe(401);
    expect((await api(frankCredential, 'GET', `/v1/teams/${TEAM}/me`)).status).toBe(401);
    // erin's working session hears it on its next read, and says to sign in again.
    const refused = await erin.party.waitNote(
      (n) => n.meta.type === 'status' && /refused your sign-in/.test(n.content),
      45_000,
      "erin's refused status",
    );
    expect(refused.content).toMatch(/run \/team-relay:login again/);
    // The console shows the team to nobody.
    for (const who of [ERIN, FRANK]) {
      expect((await consoleCall(port, who, 'GET', '/api/teams')).json.teams).toEqual([]);
      expect((await consoleCall(port, who, 'GET', `/api/me?team=${TEAM}`)).json).toEqual({ error: 'not_on_team', email: who, team: TEAM });
    }
    const listed = (await consoleCall(port, ADMIN, 'GET', '/api/admin/teams?limit=1000')).json.teams.find((t: { id: string }) => t.id === TEAM);
    expect(listed).toMatchObject({ status: 'deleted' });
  }, 90_000);
});
