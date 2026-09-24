// M5-SPEC §6 in the asker channel: with no stored sign-in it starts, waits quietly and says
// "Not connected"; the login tool (browser stubbed by test/fixtures/fake-browser.mjs through
// TEAM_RELAY_OPEN_COMMAND) stores the credential and the stream loop starts without a
// restart; a credential stored by another session is picked up too; whoami and logout; a
// refused credential is not retried in a loop.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCredential } from '../src/credentials.js';
import { FakeRelay } from './helpers/fake-relay.js';
import { FIXTURES, sleep, spawnServer, textOf, waitFor, type Spawned } from './helpers/mcp.js';

let relay: FakeRelay;
let xdg: string;
let browserLog: string;
const open: Spawned[] = [];

beforeEach(async () => {
  relay = await new FakeRelay().start();
  xdg = mkdtempSync(join(tmpdir(), 'team-relay-chlogin-'));
  browserLog = join(xdg, 'browser.log');
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  await relay.stop();
});

const credFile = () => join(xdg, 'team-relay', 'credentials.json');

async function asker(extra: Record<string, string> = {}) {
  const s = await spawnServer('channel.js', {
    RELAY_ROLE: 'asker',
    // No RELAY_AUTH, RELAY_URL or RELAY_TEAM: the plugin as installed (M5-SPEC §6).
    RELAY_AUTH: '',
    XDG_CONFIG_HOME: xdg,
    TEAM_RELAY_OPEN_COMMAND: join(FIXTURES, 'fake-browser.mjs'),
    FAKE_BROWSER_LOG: browserLog,
    ...extra,
  });
  open.push(s);
  return s;
}

async function call(s: Spawned, name: string, args: Record<string, unknown> = {}) {
  const r = await s.client.callTool({ name, arguments: args });
  return { isError: r.isError === true, text: textOf(r) };
}

const statusNotes = (s: Spawned) => s.notifications.filter((n) => n.meta.type === 'status');

describe('asker channel before sign-in', () => {
  it('starts, and every teammate tool says Not connected: run /team-relay:login', async () => {
    const s = await asker();
    for (const name of ['list_teammates', 'ask_question', 'invoke_capability', 'request_status']) {
      const r = await call(s, name, name === 'ask_question' ? { to: ['bob'], question: 'hi' } : {});
      expect(r.isError, name).toBe(true);
      expect(r.text).toBe('Not connected: run /team-relay:login');
    }
    const who = JSON.parse((await call(s, 'whoami')).text);
    expect(who).toEqual({ connected: false, message: 'Not connected: run /team-relay:login' });
    // Waiting quietly: nothing is asked of any relay.
    await sleep(300);
    expect(relay.requests).toEqual([]);
    expect(s.client.getInstructions()).toMatch(/type="status" events come from this plugin itself/);
  });
});

describe('login tool (M5-SPEC §2, §6)', () => {
  it('returns the sign-in URL at once, stores the credential, and starts the stream without a restart', async () => {
    const s = await asker();
    const r = await call(s, 'login', { relay_url: relay.url });
    expect(r.isError, r.text).toBe(false);
    const res = JSON.parse(r.text);
    expect(res.status).toBe('waiting_for_browser');
    expect(res.sign_in_url.startsWith(`${relay.url}/v1/login/start?port=`)).toBe(true);

    const note = await waitFor(() => statusNotes(s).find((n) => /signed in/.test(n.content)), 10_000, 'the signed-in status');
    expect(note.content).toBe('team-relay: signed in as alice in team demo. Teammate tools are ready.');
    expect(note.meta).toEqual({ type: 'status' });

    // Stored with the right modes, never shown.
    expect(lstatSync(credFile()).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(xdg, 'team-relay')).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(readFileSync(credFile(), 'utf8'));
    expect(r.text).not.toContain(stored.credential);

    // The browser got the URL from a file, never from its arguments.
    const entry = JSON.parse(readFileSync(browserLog, 'utf8').trim());
    expect(entry.argv).toHaveLength(1);
    expect(entry.argv[0]).not.toContain('login');
    expect(entry.url).toBe(res.sign_in_url);

    // Connected: whoami, the tools, and the replies stream.
    await waitForConnected(s);
    const teammates = await call(s, 'list_teammates');
    expect(teammates.isError, teammates.text).toBe(false);
    const env = relay.enqueue('alice', 'replies', { type: 'answer', from: 'bob', data: { text: 'hello from bob' } });
    await waitFor(() => s.notifications.find((n) => n.meta.message_id === env.id), 10_000, 'the pushed answer');
    expect(relay.requests.filter((r) => r.path.startsWith('/v1/teams/')).every((r) => r.headers.authorization === `Bearer ${stored.credential}`)).toBe(true);
  });

  it('a sign-in that fails says so on the channel and stores nothing', async () => {
    const s = await asker({ FAKE_BROWSER_MODE: 'wrong-state' });
    await call(s, 'login', { relay_url: relay.url });
    const note = await waitFor(() => statusNotes(s).find((n) => /did not complete/.test(n.content)), 10_000, 'the failure status');
    expect(note.content).toMatch(/state mismatch/);
    expect(existsSync(credFile())).toBe(false);
    expect(JSON.parse((await call(s, 'whoami')).text).connected).toBe(false);
  });

  it('a cancel on the chooser says so on the channel, and a later login works', async () => {
    relay.loginCancel = true;
    const s = await asker();
    await call(s, 'login', { relay_url: relay.url });
    const note = await waitFor(() => statusNotes(s).find((n) => /did not complete/.test(n.content)), 10_000, 'the cancel status');
    expect(note.content).toMatch(/sign-in cancelled in the browser/);
    relay.loginCancel = false;
    await call(s, 'login', { relay_url: relay.url });
    await waitFor(() => statusNotes(s).find((n) => /signed in as alice/.test(n.content)), 10_000, 'the signed-in status');
  });

  it('refuses a relay URL that is not https', async () => {
    const s = await asker();
    const r = await call(s, 'login', { relay_url: 'http://relay.example.com' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/https/);
    const bad = await call(s, 'login', { relay_url: relay.url, extra: 1 });
    expect(bad.isError).toBe(true);
  });
});

async function waitForConnected(s: Spawned) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const who = JSON.parse((await call(s, 'whoami')).text);
    if (who.connected) return who;
    if (Date.now() > deadline) throw new Error(`not connected: ${JSON.stringify(who)}`);
    await sleep(100);
  }
}

describe('a credential stored by another session, whoami and logout', () => {
  it('connects as soon as the file appears; whoami names relay, team and member; logout revokes and deletes', async () => {
    const s = await asker();
    await sleep(200);
    const token = relay.mintCredential('bob');
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'bob', credential: token, expires_at: '2026-12-23T00:00:00Z' });
    const who = await waitForConnected(s);
    expect(who).toMatchObject({
      connected: true,
      relay_url: relay.url,
      team: 'demo',
      member: 'bob',
      signed_in_with: 'device credential (/team-relay:login)',
      credential_expires_at: '2026-12-23T00:00:00Z',
    });
    expect(JSON.stringify(who)).not.toContain(token);

    const out = JSON.parse((await call(s, 'logout')).text);
    expect(out).toMatchObject({ signed_out: true, revoked: true, team: 'demo', member: 'bob' });
    expect(relay.revoked).toEqual([token]);
    expect(existsSync(credFile())).toBe(false);
    const after = await call(s, 'list_teammates');
    expect(after.text).toBe('Not connected: run /team-relay:login');
    expect(JSON.parse((await call(s, 'logout')).text)).toEqual({ signed_out: false, note: 'not signed in on this computer' });
  });

  it('a credential the relay refuses is not retried in a loop, and a new login connects', async () => {
    const s = await asker();
    const stale = relay.mintCredential('alice');
    relay.credentials.delete(stale);
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'alice', credential: stale, expires_at: null });
    await waitFor(() => relay.requests.some((r) => r.path === '/v1/teams/demo/me'), 10_000, 'the first /me');
    await sleep(4500);
    const tries = relay.requests.filter((r) => r.path === '/v1/teams/demo/me').length;
    expect(tries).toBe(1);
    const who = JSON.parse((await call(s, 'whoami')).text);
    expect(who.connected).toBe(false);
    expect(who.message).toMatch(/run \/team-relay:login again/);
    const r = await call(s, 'list_teammates');
    expect(r.text).toMatch(/run \/team-relay:login again/);

    // A new login replaces the file: connected, no restart.
    await call(s, 'login', { relay_url: relay.url });
    await waitForConnected(s);
  });

  it('a credential revoked while connected: one status line, no retry loop', async () => {
    const s = await asker();
    const token = relay.mintCredential('alice');
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'alice', credential: token, expires_at: null });
    await waitForConnected(s);
    relay.credentials.delete(token);
    const note = await waitFor(() => statusNotes(s).find((n) => /refused your sign-in/.test(n.content)), 40_000, 'the refused status');
    expect(note.content).toMatch(/run \/team-relay:login again/);
    const count = relay.requests.length;
    await sleep(3000);
    expect(relay.requests.length).toBe(count);
  }, 60_000);
});
