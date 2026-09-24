// The M5 and M6 plugin-side e2e scenarios (M5-SPEC §8, M6-SPEC §6), against the real relay
// started through relay/tests/fake_oauth_app.py (a fake Google on the same port):
//
//   A. the whole sign-in through the real login tool, the browser a headless stub
//      (test/fixtures/fake-browser.mjs, via TEAM_RELAY_OPEN_COMMAND) that follows the relay's
//      redirects, the fake consent and the team chooser; the credential stored with the right
//      modes; both streams working with it; logout revoking it;
//   B. the owner (alice) adding a member through the console server's roster proxy; the new
//      member signing in with the M5 flow and appearing in the directory;
//   C. the owner removing that member, and the relay refusing them within 30 s.
//
// Run through ../scripts/e2e.sh, which sets E2E_M5=1 only when the relay serves the login flow.
// Every request here is answered and every stream drained, and the member added in B is
// removed in C, so the M1 and M2 suites are unaffected whichever file runs first.

import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIST, FIXTURES } from '../helpers/mcp.js';
import { ENABLED, Party, api, channelEnv, relayUrl, teamPath, tokenOf, until } from './harness.js';

const M5 = ENABLED && process.env.E2E_M5 === '1';
const DELIVERY_MS = 15_000;
const CREDENTIAL_RE = /^trc_[A-Za-z0-9_-]{43}$/;

const open: Party[] = [];
const children: ChildProcess[] = [];

afterAll(async () => {
  while (open.length) await open.pop()!.close();
  for (const c of children) c.kill('SIGTERM');
});

type Signed = { party: Party; xdg: string; file: string; log: string };

/** A working session with no stored sign-in, whose browser is the headless stub. */
async function freshAsker(label: string, email: string): Promise<Signed> {
  const xdg = mkdtempSync(join(tmpdir(), `team-relay-e2e-${label}-`));
  const log = join(xdg, 'browser.log');
  const party = await Party.start(`${label}-asker`, 'channel.js', {
    RELAY_ROLE: 'asker',
    RELAY_AUTH: '',
    XDG_CONFIG_HOME: xdg,
    TEAM_RELAY_OPEN_COMMAND: join(FIXTURES, 'fake-browser.mjs'),
    FAKE_BROWSER_LOG: log,
    FAKE_BROWSER_EMAIL: email,
  });
  open.push(party);
  return { party, xdg, file: join(xdg, 'team-relay', 'credentials.json'), log };
}

async function signIn(s: Signed, member: string): Promise<string> {
  const r = await s.party.ok('login', { relay_url: relayUrl() });
  expect(r.status).toBe('waiting_for_browser');
  expect(String(r.sign_in_url).startsWith(`${relayUrl()}/v1/login/start?`)).toBe(true);
  const note = await s.party
    .waitNote((n) => n.meta.type === 'status' && /signed in|did not complete/.test(n.content), 30_000, 'the sign-in status')
    .catch((err: unknown) => {
      const browser = (() => {
        try {
          return readFileSync(s.log, 'utf8');
        } catch {
          return '(no browser log)';
        }
      })();
      throw new Error(`${String(err)}; browser: ${browser.slice(0, 1500)}; stderr: ${s.party.stderr().slice(-1500)}`);
    });
  expect(note.content).toBe(`team-relay: signed in as ${member} in team demo. Teammate tools are ready.`);
  const stored = JSON.parse(readFileSync(s.file, 'utf8')) as { credential: string; team: string; member: string; relay_url: string };
  expect(stored).toMatchObject({ team: 'demo', member, relay_url: relayUrl() });
  expect(stored.credential).toMatch(CREDENTIAL_RE);
  return stored.credential;
}

async function whoami(p: Party): Promise<Record<string, unknown>> {
  return p.ok('whoami', {});
}

async function connected(p: Party): Promise<Record<string, unknown>> {
  return until(async () => {
    const w = await whoami(p);
    return w.connected === true ? w : null;
  }, 15_000, `${p.label} connected`);
}

/** The local console server as alice (the seed owner), with its URL and key. */
async function aliceConsole(): Promise<{ base: string; key: string }> {
  const child = spawn(process.execPath, [join(DIST, 'console-server.js')], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '',
      CONSOLE_PORT: '0',
      RELAY_URL: relayUrl(),
      RELAY_TEAM: 'demo',
      RELAY_AUTH: 'token',
      RELAY_TOKEN: tokenOf('alice'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (c: Buffer) => (out += c.toString('utf8')));
  const url = await until(() => (out.includes('\n') ? out.trim() : null), 10_000, 'the console URL');
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\/#k=([A-Za-z0-9_-]{43})$/.exec(url)!;
  return { base: `http://127.0.0.1:${m[1]}`, key: m[2]! };
}

/** A roster change as the console's own page sends it. */
function change(c: { base: string; key: string }, method: string, path: string, body?: unknown) {
  return fetch(c.base + path, {
    method,
    headers: { 'X-Console-Key': c.key, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe.skipIf(!M5)('M5: sign in with the login tool', () => {
  it('A. signs bob in end to end, both streams work with the stored credential, and logout revokes it', async () => {
    const bob = await freshAsker('bob', 'bob@example.com');
    // Before the sign-in: waiting quietly.
    expect((await bob.party.call('list_teammates', {})).text).toBe('Not connected: run /team-relay:login');

    const credential = await signIn(bob, 'bob');
    // Modes: the directory 700, the file 600.
    expect(lstatSync(join(bob.xdg, 'team-relay')).mode & 0o777).toBe(0o700);
    expect(lstatSync(bob.file).mode & 0o777).toBe(0o600);
    // The stub browser got the URL from a private file, never from its arguments, and walked
    // the relay's pages: start, the fake consent, the callback, the chooser, the loopback.
    const entry = JSON.parse(readFileSync(bob.log, 'utf8').trim().split('\n').at(-1)!) as { argv: string[]; done: boolean; steps: Array<{ url: string; status: number }> };
    expect(entry.done).toBe(true);
    expect(entry.argv).toHaveLength(1);
    expect(entry.argv[0]).not.toContain('state=');
    expect(entry.steps.map((x) => new URL(x.url).pathname)).toEqual(
      expect.arrayContaining(['/v1/login/start', '/v1/login/callback', '/v1/login/choose', '/callback']),
    );
    expect(entry.steps.at(-1)!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const who = await connected(bob.party);
    expect(who).toMatchObject({ connected: true, team: 'demo', member: 'bob', relay_url: relayUrl() });
    expect(JSON.stringify(who)).not.toContain(credential);
    // The relay knows the credential as bob.
    const me = await api(credential, 'GET', teamPath('me'));
    expect(me.status).toBe(200);
    expect(me.body.member).toBe('bob');

    // bob's replies stream, with the credential: he asks alice, her answering session replies.
    const alice = await Party.start('alice-answerer-m5', 'channel.js', channelEnv('alice', 'answerer'));
    open.push(alice);
    const asked = await bob.party.ok('ask_question', { to: ['alice'], question: 'M5: can you hear me with my new sign-in?' });
    const rid = asked.request_id as string;
    await alice.waitNote((n) => n.meta.request_id === rid, DELIVERY_MS, 'the question at alice');
    await alice.ok('ack_question', { request_id: rid });
    await alice.ok('reply', { request_id: rid, text: 'Loud and clear.' });
    const answer = await bob.party.waitNote((n) => n.meta.request_id === rid && n.meta.type === 'answer', DELIVERY_MS, 'the answer at bob');
    expect(answer.content).toContain('Loud and clear.');

    // bob's inbox stream, with the credential: an answering channel as bin/answerer starts it.
    const bobAnswerer = await Party.start('bob-answerer-m5', 'channel.js', {
      RELAY_ROLE: 'answerer',
      RELAY_AUTH: 'credential',
      RELAY_CREDENTIALS_FILE: bob.file,
      RELAY_URL: relayUrl(),
      RELAY_TEAM: 'demo',
    });
    open.push(bobAnswerer);
    const aliceAsker = await Party.start('alice-asker-m5', 'channel.js', channelEnv('alice', 'asker'));
    open.push(aliceAsker);
    const q = await aliceAsker.ok('ask_question', { to: ['bob'], question: 'M5: and your answering session?' });
    const qid = q.request_id as string;
    await bobAnswerer.waitNote((n) => n.meta.request_id === qid, DELIVERY_MS, 'the question at bob');
    await bobAnswerer.ok('ack_question', { request_id: qid });
    await bobAnswerer.ok('reply', { request_id: qid, text: 'Answering with the stored sign-in.' });
    await aliceAsker.waitNote((n) => n.meta.request_id === qid && n.meta.type === 'answer', DELIVERY_MS, 'the answer at alice');
    await bobAnswerer.close();

    // Logout: revoked at the relay, deleted here, and the session is back to waiting.
    const out = await bob.party.ok('logout', {});
    expect(out).toMatchObject({ signed_out: true, revoked: true, team: 'demo', member: 'bob' });
    expect(() => lstatSync(bob.file)).toThrow();
    expect((await api(credential, 'GET', teamPath('me'))).status).toBe(401);
    expect((await bob.party.call('list_teammates', {})).text).toBe('Not connected: run /team-relay:login');
  }, 120_000);
});

describe.skipIf(!M5)('M6: the owner manages members in the console', () => {
  let dave: Signed;
  let daveCredential = '';
  let console_: { base: string; key: string };

  it('B. alice adds dave through the console server; dave signs in and appears in the directory', async () => {
    console_ = await aliceConsole();
    const before = (await (await fetch(console_.base + '/api/roster', { headers: { 'X-Console-Key': console_.key } })).json()) as {
      members: Array<{ member: string; role: string; emails: string[] }>;
    };
    expect(before.members.find((m) => m.member === 'alice')).toMatchObject({ role: 'owner' });
    expect(before.members.some((m) => m.member === 'dave')).toBe(false);

    // Refused without the page's own headers, before the relay is asked.
    const crossSite = await fetch(console_.base + '/api/roster', {
      method: 'POST',
      headers: { 'X-Console-Key': console_.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'dave', email: 'dave@example.com' }),
    });
    expect(crossSite.status).toBe(403);

    const added = await change(console_, 'POST', '/api/roster', { member: 'dave', email: 'Dave@Example.com' });
    expect(added.status, await added.clone().text()).toBe(201);
    const roster = (await (await fetch(console_.base + '/api/roster', { headers: { 'X-Console-Key': console_.key } })).json()) as {
      members: Array<{ member: string; role: string; emails: string[] }>;
    };
    expect(roster.members.find((m) => m.member === 'dave')).toMatchObject({ role: 'member', emails: ['dave@example.com'] });
    // The same email again is a conflict, passed on with the relay's status.
    const again = await change(console_, 'POST', '/api/roster', { member: 'dave_two', email: 'dave@example.com' });
    expect(again.status).toBe(502);
    expect(((await again.json()) as { relay_status: number }).relay_status).toBe(409);

    // dave signs in with the M5 flow (within the roster cache's 30 s of being added).
    dave = await freshAsker('dave', 'dave@example.com');
    daveCredential = await until(
      async () => {
        try {
          return await signIn(dave, 'dave');
        } catch {
          return null;
        }
      },
      40_000,
      'dave signing in',
    );
    await connected(dave.party);
    // He is in alice's directory and her teammates.
    await until(
      async () => {
        const dir = await api(tokenOf('alice'), 'GET', teamPath('directory'));
        return (dir.body.members as Array<{ member: string }>).some((m) => m.member === 'dave') ? true : null;
      },
      30_000,
      'dave in the directory',
    );
    const me = await api(tokenOf('alice'), 'GET', teamPath('me'));
    expect(me.body.teammates).toContain('dave');
  }, 120_000);

  it('C. alice removes dave; the relay refuses him within 30 s, and his session says to sign in again', async () => {
    expect(daveCredential).toMatch(CREDENTIAL_RE);
    const started = Date.now();
    const removed = await change(console_, 'DELETE', `/api/roster/dave`);
    expect(removed.status, await removed.clone().text()).toBe(200);
    await until(
      async () => ((await api(daveCredential, 'GET', teamPath('me'))).status === 401 ? true : null),
      31_000,
      'dave refused',
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThanOrEqual(31_000);
    // His working session hears it on its next read, and does not retry in a loop.
    const refused = await dave.party.waitNote(
      (n) => n.meta.type === 'status' && /refused your sign-in/.test(n.content),
      45_000,
      "dave's refused status",
    );
    expect(refused.content).toMatch(/run \/team-relay:login again/);
    expect((await dave.party.call('list_teammates', {})).text).toMatch(/run \/team-relay:login again/);
    // And alice's view no longer lists him.
    await until(
      async () => {
        const meNow = await api(tokenOf('alice'), 'GET', teamPath('me'));
        return (meNow.body.teammates as string[]).includes('dave') ? null : true;
      },
      31_000,
      'dave gone from the teammates',
    );
  }, 120_000);
});
