// A session started without the team-relay channel (TEAM_RELAY_CHANNEL=0 here; the process-tree
// check is channel-mode.test.ts): it never polls or acknowledges a stream, whatever it signs in
// with, while every tool still works and says plainly where answers appear. A channel session
// (TEAM_RELAY_CHANNEL=1) beside it is the one that consumes. login_wait reports a sign-in
// without any channel event.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCredential } from '../src/credentials.js';
import { notChannelNote } from '../src/channel-mode.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { FIXTURES, sleep, spawnServer, textOf, waitFor, type Spawned } from './helpers/mcp.js';

let relay: FakeRelay;
let xdg: string;
const open: Spawned[] = [];

beforeEach(async () => {
  relay = await new FakeRelay().start();
  xdg = mkdtempSync(join(tmpdir(), 'team-relay-chsession-'));
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  await relay.stop();
});

const NOTE = notChannelNote({});
const LAUNCH = 'claude --dangerously-load-development-channels plugin:team-relay@team-relay-dev';
const streamRequests = (member?: string) => relay.requests.filter((r) => r.path.includes('/streams/') && (!member || r.member === member));

async function tokenSession(member: string, role: 'asker' | 'answerer', channel: '0' | '1', extra: Record<string, string> = {}) {
  const s = await spawnServer('channel.js', {
    RELAY_URL: relay.url,
    RELAY_TEAM: 'demo',
    RELAY_TOKEN: TOKEN_OF[member]!,
    RELAY_ROLE: role,
    TEAM_RELAY_CHANNEL: channel,
    ...extra,
  });
  open.push(s);
  return s;
}

/** The plugin as installed: no RELAY_AUTH, signs in with the stored credential or login. */
async function installedAsker(channel: '0' | '1', extra: Record<string, string> = {}) {
  const s = await spawnServer('channel.js', {
    RELAY_ROLE: 'asker',
    RELAY_AUTH: '',
    RELAY_URL: relay.url,
    XDG_CONFIG_HOME: xdg,
    TEAM_RELAY_OPEN_COMMAND: join(FIXTURES, 'fake-browser.mjs'),
    TEAM_RELAY_CHANNEL: channel,
    ...extra,
  });
  open.push(s);
  return s;
}

async function call(s: Spawned, name: string, args: Record<string, unknown> = {}) {
  const r = await s.client.callTool({ name, arguments: args });
  return { isError: r.isError === true, text: textOf(r) };
}

async function whoamiConnected(s: Spawned) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const who = JSON.parse((await call(s, 'whoami')).text);
    if (who.connected) return who;
    if (Date.now() > deadline) throw new Error(`not connected: ${JSON.stringify(who)}`);
    await sleep(100);
  }
}

const credFile = () => join(xdg, 'team-relay', 'credentials.json');

describe('a session without the channel never polls or acknowledges a stream', () => {
  it('asker with RELAY_* from the environment: tools work, every result says so, the replies stream is untouched', async () => {
    relay.enqueue('alice', 'replies', { type: 'answer', from: 'bob', data: { text: 'an answer nobody here could see' } });
    relay.manifests.set('bob', {
      version: 1,
      capabilities: [
        {
          name: 'service_health',
          title: 'Check a service',
          description: 'd',
          environment: 'staging',
          params: { service: { type: 'enum', values: ['api'], description: 'x' } },
          required: ['service'],
        },
      ],
    });
    const s = await tokenSession('alice', 'asker', '0');
    expect(s.client.getInstructions()).toContain(NOTE);
    expect(s.client.getInstructions()).toMatch(/call login and then login_wait/);

    const mates = await call(s, 'list_teammates');
    expect(mates.isError, mates.text).toBe(false);
    const matesBody = JSON.parse(mates.text);
    expect(matesBody.teammates.map((m: { member: string }) => m.member)).toEqual(['bob', 'carol']);
    expect(matesBody).toMatchObject({ channel_session: false, channel_note: NOTE });
    expect(NOTE).toContain(`Start one with: ${LAUNCH}`);

    const asked = await call(s, 'ask_question', { to: ['bob'], question: 'Where is the runbook?' });
    expect(asked.isError, asked.text).toBe(false);
    const askedBody = JSON.parse(asked.text);
    expect(askedBody.request_id).toMatch(/^rq_/);
    expect(askedBody.channel_note).toBe(NOTE);
    expect(askedBody.where_answers_appear).toMatch(/The answer is not shown in this session/);
    expect(askedBody.where_answers_appear).toContain(LAUNCH);
    expect(askedBody.where_answers_appear).toMatch(/request_status with this request_id shows who has acknowledged and answered/);
    expect(relay.created).toHaveLength(1);

    const invoked = await call(s, 'invoke_capability', { member: 'bob', capability: 'service_health', params: { service: 'api' } });
    expect(invoked.isError, invoked.text).toBe(false);
    expect(JSON.parse(invoked.text).where_answers_appear).toMatch(/not shown in this session/);

    const status = await call(s, 'request_status', { request_id: askedBody.request_id });
    expect(status.isError, status.text).toBe(false);
    expect(JSON.parse(status.text)).toMatchObject({ channel_session: false, teammate_authored_data: expect.any(String) });

    const who = JSON.parse((await call(s, 'whoami')).text);
    expect(who).toMatchObject({ connected: true, member: 'alice', channel_session: false, channel_note: NOTE });

    // Errors carry the note too, as a sentence.
    const bad = await call(s, 'ask_question', { to: [], question: 'x' });
    expect(bad.isError).toBe(true);
    expect(bad.text.endsWith(`\n\n${NOTE}`)).toBe(true);

    await sleep(1500);
    expect(streamRequests()).toEqual([]);
    expect(relay.stream('alice', 'replies').cursor).toBe(0);
    expect(s.notifications).toEqual([]);
  });

  it('asker signed in with a stored credential: connects for its tools, never reads the stream', async () => {
    const token = relay.mintCredential('alice');
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'alice', credential: token, expires_at: null, email: 'alice@example.com' });
    relay.enqueue('alice', 'replies', { type: 'answer', from: 'bob', data: { text: 'kept for a channel session' } });
    const s = await installedAsker('0');
    const who = await whoamiConnected(s);
    expect(who).toMatchObject({ member: 'alice', channel_session: false });
    expect((await call(s, 'list_teammates')).isError).toBe(false);
    await sleep(1500);
    expect(streamRequests()).toEqual([]);
    expect(relay.stream('alice', 'replies').cursor).toBe(0);
  });

  it('a credential refused on a tool call (no stream to notice it) takes the session back to "sign in again"', async () => {
    const token = relay.mintCredential('alice');
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'alice', credential: token, expires_at: null });
    const s = await installedAsker('0');
    await whoamiConnected(s);
    relay.credentials.delete(token);
    const r = await call(s, 'list_teammates');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/401/);
    const who = JSON.parse((await call(s, 'whoami')).text);
    expect(who.connected).toBe(false);
    expect(who.message).toMatch(/run \/team-relay:login again/);
    expect(s.notifications).toEqual([]);
  });

  it('answerer without the channel: never reads the inbox', async () => {
    relay.enqueue('bob', 'inbox', { type: 'question', from: 'alice', data: { question: 'q?', ack_deadline: '2026-09-23T12:00:00Z', answer_deadline: '2026-09-23T12:00:00Z' } });
    const s = await tokenSession('bob', 'answerer', '0');
    await sleep(1500);
    expect(streamRequests()).toEqual([]);
    expect(relay.stream('bob', 'inbox').cursor).toBe(0);
    expect(s.notifications).toEqual([]);
    expect(s.stderr()).toMatch(/not a channel session: no stream is read \(TEAM_RELAY_CHANNEL=0\)/);
  });

  it('beside a channel session of the same member, only the channel session consumes and shows the answer', async () => {
    const quiet = await tokenSession('alice', 'asker', '0');
    await sleep(1000);
    expect(streamRequests()).toEqual([]);
    const shown = await tokenSession('alice', 'asker', '1');
    const env = relay.enqueue('alice', 'replies', { type: 'answer', from: 'bob', data: { text: 'for the channel session' } });
    const n = await waitFor(() => shown.notifications.find((x) => x.meta.message_id === env.id), 10_000, 'the answer in the channel session');
    expect(n.content).toBe('for the channel session');
    await waitFor(() => relay.stream('alice', 'replies').cursor === 1, 5000, 'cursor 1');
    await sleep(500);
    expect(quiet.notifications).toEqual([]);
    expect(shown.stderr()).toMatch(/channel session \(TEAM_RELAY_CHANNEL=1\)/);
    expect(quiet.stderr()).toMatch(/not a channel session: no stream is read \(TEAM_RELAY_CHANNEL=0\)/);
  });

  it('a channel session answerer reads the inbox (the control)', async () => {
    const e = relay.enqueue('bob', 'inbox', { type: 'question', from: 'alice', data: { question: 'q?', ack_deadline: '2026-09-23T12:00:00Z', answer_deadline: '2026-09-23T12:00:00Z' } });
    const s = await tokenSession('bob', 'answerer', '1');
    await waitFor(() => s.notifications.find((x) => x.meta.request_id === e.request_id), 10_000, 'the question');
    await waitFor(() => relay.stream('bob', 'inbox').cursor === 1, 5000, 'cursor 1');
  });
});

describe('login_wait: the sign-in confirmed without channel events', () => {
  it('login returns the raw sign-in URL at once; login_wait returns "Connected as …" in a session without the channel', async () => {
    const s = await installedAsker('0', { FAKE_BROWSER_LOG: join(xdg, 'browser.log') });
    const r = await call(s, 'login');
    expect(r.isError, r.text).toBe(false);
    const res = JSON.parse(r.text);
    expect(typeof res.sign_in_url).toBe('string');
    expect(res.sign_in_url.startsWith(`${relay.url}/v1/login/start?`)).toBe(true);
    expect(res.sign_in_url).not.toMatch(/[\s\[\]()<>]/);
    expect(res.sign_in_url_rule).toMatch(/exactly as it is, as plain text on a line of its own \(not as a markdown link\)/);
    expect(res.sign_in_url_rule).toMatch(/Never repeat it to anyone else/);
    expect(res.next).toMatch(/then call login_wait \(no arguments\)/);
    expect(res.channel_note).toBe(NOTE);

    const w = await call(s, 'login_wait');
    expect(w.isError, w.text).toBe(false);
    const body = JSON.parse(w.text);
    expect(body).toMatchObject({ connected: true, message: 'Connected as alice (alice@example.com) on team demo', member: 'alice', team: 'demo', email: 'alice@example.com' });
    // It waited for the connection too: the tools work at once.
    expect((await call(s, 'list_teammates')).isError).toBe(false);
    // No channel event at all in a session that could not show one.
    expect(s.notifications).toEqual([]);
    expect(streamRequests()).toEqual([]);
  });

  it('in a channel session the status event still comes, as an extra', async () => {
    const s = await installedAsker('1');
    await call(s, 'login');
    const w = JSON.parse((await call(s, 'login_wait')).text);
    expect(w.message).toBe('Connected as alice (alice@example.com) on team demo');
    const note = await waitFor(() => s.notifications.find((n) => n.meta.type === 'status'), 10_000, 'the status event');
    expect(note.content).toBe('team-relay: Connected as alice (alice@example.com) on team demo. Teammate tools are ready.');
  });

  it('called after the sign-in already finished, it reports that sign-in', async () => {
    const s = await installedAsker('0');
    await call(s, 'login');
    await whoamiConnected(s);
    const w = await call(s, 'login_wait');
    expect(w.isError).toBe(false);
    expect(JSON.parse(w.text).message).toBe('Connected as alice (alice@example.com) on team demo');
  });

  it('says a different member plainly', async () => {
    const token = relay.mintCredential('bob');
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'bob', credential: token, expires_at: null, email: 'bob@example.com' });
    const s = await installedAsker('0');
    await whoamiConnected(s);
    await call(s, 'login');
    const w = JSON.parse((await call(s, 'login_wait')).text);
    expect(w.message).toBe('Connected as alice (alice@example.com) on team demo');
    expect(w.changed).toMatch(/different member than before: this computer was signed in as bob on team demo/);
  });

  it('a sign-in the relay refuses: the failure, as an error', async () => {
    relay.loginRefusal = { status: 400, error: 'invalid_grant' };
    const s = await installedAsker('0');
    await call(s, 'login');
    const w = await call(s, 'login_wait');
    expect(w.isError).toBe(true);
    expect(w.text).toMatch(/^The sign-in did not complete: .*400 invalid_grant.*\. Run \/team-relay:login to try again\./);
  });

  it('a cancel in the browser: the failure', async () => {
    relay.loginCancel = true;
    const s = await installedAsker('0');
    await call(s, 'login');
    const w = await call(s, 'login_wait');
    expect(w.isError).toBe(true);
    expect(w.text).toMatch(/sign-in cancelled in the browser/);
  });

  it('a sign-in that does not finish in time: says so, and a later login_wait still works', async () => {
    const s = await installedAsker('0', { FAKE_BROWSER_MODE: 'ignore', TEAM_RELAY_LOGIN_WAIT_SECONDS: '1' });
    await call(s, 'login');
    const started = Date.now();
    const w = await call(s, 'login_wait');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(w.isError).toBe(true);
    expect(w.text).toMatch(/^The sign-in has not completed after 1 s\. If the user is still in the browser, they can finish there and you can call login_wait again/);
    const who = JSON.parse((await call(s, 'whoami')).text);
    expect(who).toMatchObject({ connected: false, sign_in_pending: true });
    const again = await call(s, 'login_wait');
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/has not completed/);
  });

  it('a newer login replaces the one being waited for: login_wait follows the newer one', async () => {
    // The stub browser opens nothing; the test walks each sign-in link itself.
    const s = await installedAsker('0', { FAKE_BROWSER_MODE: 'ignore' });
    await call(s, 'login');
    const waiting = call(s, 'login_wait');
    await sleep(300);
    const second = JSON.parse((await call(s, 'login')).text);
    await sleep(300);
    // The fake relay approves at once and sends the browser to the listener's callback.
    const res = await fetch(second.sign_in_url);
    expect(res.status).toBe(200);
    const w = await waiting;
    expect(w.isError, w.text).toBe(false);
    expect(JSON.parse(w.text).message).toBe('Connected as alice (alice@example.com) on team demo');
  });

  it('with no sign-in started, it says to run /team-relay:login; it takes no arguments', async () => {
    const s = await installedAsker('0');
    const none = await call(s, 'login_wait');
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/^No sign-in is waiting in this session: run \/team-relay:login to start one\./);
    const args = await call(s, 'login_wait', { relay_url: 'https://evil.example.com' });
    expect(args.isError).toBe(true);
    expect(args.text).toMatch(/^login_wait takes no arguments/);
    expect(relay.requests).toEqual([]);
  });
});
