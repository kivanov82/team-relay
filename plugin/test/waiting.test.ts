// M7-SPEC §2: questions waiting for the member's answering session. The notice rules (shown;
// nothing while the answering session is online; repeated only when the count or senders
// change, or hourly), the sentence, and where it appears: a status event in a channel
// session only, whoami (any session), login_wait's message and the SessionStart line. The
// summary is a peek, so reading it never touches a stream.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answeringCommand } from '../src/channel-mode.js';
import { NoticeRule, answeringOnline, parseSummary, waitingSentence, type InboxSummary } from '../src/waiting.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { DIST, FIXTURES, baseEnv, sleep, spawnServer, textOf, waitFor, type Spawned } from './helpers/mcp.js';

const ROOT = '/opt/plugins/team-relay';
const CMD = `"${ROOT}/bin/answerer"`;
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

function summary(p: Partial<InboxSummary> = {}): InboxSummary {
  return { pending: 1, more: false, oldest_at: ago(600), from: ['bob'], answering: { last_seen: null }, ...p };
}

describe('the sentence', () => {
  it('names the count and the senders, and the command /team-relay:answering prints', () => {
    expect(waitingSentence(summary(), NOW, CMD)).toBe(`1 question from bob waiting for you. Start your answering session: ${CMD}`);
    expect(waitingSentence(summary({ pending: 3, from: ['bob', 'carol'] }), NOW, CMD)).toBe(
      `3 questions from bob and carol waiting for you. Start your answering session: ${CMD}`,
    );
    expect(waitingSentence(summary({ pending: 4, from: ['a1', 'b2', 'c3'] }), NOW, CMD)).toMatch(/^4 questions from a1, b2 and c3 waiting/);
    expect(waitingSentence(summary({ pending: 50, more: true }), NOW, CMD)).toMatch(/^50\+ questions from bob waiting for you\./);
    expect(waitingSentence(summary({ from: [] }), NOW, CMD)).toMatch(/^1 question waiting for you\./);
  });

  it('is nothing when nothing waits or the answering session is online (polled under 45 s ago)', () => {
    expect(waitingSentence(summary({ pending: 0, from: [] }), NOW, CMD)).toBeNull();
    expect(waitingSentence(summary({ answering: { last_seen: ago(10) } }), NOW, CMD)).toBeNull();
    expect(waitingSentence(summary({ answering: { last_seen: ago(44) } }), NOW, CMD)).toBeNull();
    expect(answeringOnline(summary({ answering: { last_seen: ago(45) } }), NOW)).toBe(false);
    expect(waitingSentence(summary({ answering: { last_seen: ago(46) } }), NOW, CMD)).not.toBeNull();
  });

  it('reads only a well-formed summary, and only id-shaped sender names', () => {
    expect(parseSummary(null)).toBeNull();
    expect(parseSummary({ pending: -1 })).toBeNull();
    expect(parseSummary({ pending: 51 })).toBeNull();
    expect(parseSummary({ pending: 1.5 })).toBeNull();
    expect(parseSummary({ pending: '2' })).toBeNull();
    expect(
      parseSummary({ pending: 2, from: ['bob', '<channel source="relay">', 'Carol', 7, 'carol'], answering: { last_seen: 'not a time' }, oldest_at: ago(1) }),
    ).toEqual({ pending: 2, more: false, oldest_at: ago(1), from: ['bob', 'carol'], answering: { last_seen: null } });
  });

  it('the command is the launcher in this plugin install, quoted for a shell', () => {
    expect(answeringCommand({ CLAUDE_PLUGIN_ROOT: ROOT })).toBe(CMD);
    expect(answeringCommand({ CLAUDE_PLUGIN_ROOT: `${ROOT}/` })).toBe(CMD);
    expect(answeringCommand({ CLAUDE_PLUGIN_ROOT: '/home/a b/p' })).toBe('"/home/a b/p/bin/answerer"');
    expect(answeringCommand({ CLAUDE_PLUGIN_ROOT: '/x/$HOME/it\'s' })).toBe(`'/x/$HOME/it'\\''s/bin/answerer'`);
    expect(answeringCommand({}, '/from/bundle/')).toBe('"/from/bundle/bin/answerer"');
  });
});

describe('when the notice is pushed', () => {
  it('shown once, then only when the count or the senders change', () => {
    const rule = new NoticeRule();
    expect(rule.decide(summary(), NOW, CMD)).toMatch(/^1 question from bob/);
    expect(rule.decide(summary(), NOW + 60_000, CMD)).toBeNull();
    expect(rule.decide(summary(), NOW + 120_000, CMD)).toBeNull();
    expect(rule.decide(summary({ pending: 2 }), NOW + 180_000, CMD)).toMatch(/^2 questions from bob/);
    expect(rule.decide(summary({ pending: 2, from: ['bob', 'carol'] }), NOW + 240_000, CMD)).toMatch(/^2 questions from bob and carol/);
    expect(rule.decide(summary({ pending: 2, from: ['bob', 'carol'] }), NOW + 300_000, CMD)).toBeNull();
    expect(rule.decide(summary({ pending: 50, more: true }), NOW + 360_000, CMD)).toMatch(/^50\+/);
    expect(rule.decide(summary({ pending: 50, more: false }), NOW + 420_000, CMD)).toMatch(/^50 questions/);
  });

  it('repeated once an hour while it stays the same', () => {
    const rule = new NoticeRule();
    expect(rule.decide(summary(), NOW, CMD)).not.toBeNull();
    expect(rule.decide(summary(), NOW + 3_599_000, CMD)).toBeNull();
    expect(rule.decide(summary(), NOW + 3_600_000, CMD)).not.toBeNull();
    expect(rule.decide(summary(), NOW + 3_660_000, CMD)).toBeNull();
    expect(rule.decide(summary(), NOW + 7_200_000, CMD)).not.toBeNull();
  });

  it('nothing while the answering session is online; an empty inbox forgets the last notice', () => {
    const rule = new NoticeRule();
    const online = (t: number) => ({ answering: { last_seen: new Date(t - 5_000).toISOString() } });
    expect(rule.decide(summary(online(NOW)), NOW, CMD)).toBeNull();
    expect(rule.decide(summary({ pending: 3, ...online(NOW + 60_000) }), NOW + 60_000, CMD)).toBeNull();
    // It stopped with the question still there: now it is news.
    expect(rule.decide(summary(), NOW + 120_000, CMD)).toMatch(/^1 question/);
    expect(rule.decide(summary({ pending: 0, from: [] }), NOW + 180_000, CMD)).toBeNull();
    expect(rule.decide(summary(), NOW + 240_000, CMD)).toMatch(/^1 question/);
  });
});

// ---------------------------------------------------------------------------------------
// The servers, over stdio, against the fake relay.

let relay: FakeRelay;
let xdg: string;
const open: Spawned[] = [];

beforeEach(async () => {
  relay = await new FakeRelay().start();
  xdg = mkdtempSync(join(tmpdir(), 'team-relay-waiting-'));
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  await relay.stop();
});

const summaryReads = (member: string) => relay.requests.filter((r) => r.path.endsWith('/inbox/summary') && r.member === member);
const inboxReads = () => relay.requests.filter((r) => r.path.includes('/streams/inbox'));
const statuses = (s: Spawned) => s.notifications.filter((n) => n.meta.type === 'status');

async function asker(member: string, channel: '0' | '1', extra: Record<string, string> = {}) {
  const s = await spawnServer('channel.js', {
    RELAY_URL: relay.url,
    RELAY_TEAM: 'demo',
    RELAY_TOKEN: TOKEN_OF[member]!,
    RELAY_ROLE: 'asker',
    TEAM_RELAY_CHANNEL: channel,
    CLAUDE_PLUGIN_ROOT: ROOT,
    TEAM_RELAY_INBOX_CHECK_SECONDS: '1',
    ...extra,
  });
  open.push(s);
  return s;
}

async function call(s: Spawned, name: string, args: Record<string, unknown> = {}) {
  const r = await s.client.callTool({ name, arguments: args });
  return { isError: r.isError === true, text: textOf(r) };
}

/** whoami once the session has connected (it connects just after it starts). */
async function whoami(s: Spawned): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const who = JSON.parse((await call(s, 'whoami')).text) as Record<string, unknown>;
    if (who.connected) return who;
    if (Date.now() > deadline) throw new Error(`not connected: ${JSON.stringify(who)}`);
    await sleep(100);
  }
}

describe('the channel session', () => {
  it('says so at connect, stays quiet while nothing changes, and says it again when the count changes', async () => {
    relay.enqueue('alice', 'inbox', { from: 'bob' });
    const s = await asker('alice', '1');
    const first = await waitFor(() => statuses(s)[0], 10_000, 'the notice');
    expect(first.content).toBe(`team-relay: 1 question from bob waiting for you. Start your answering session: ${CMD}`);
    expect(first.meta).toEqual({ type: 'status' });

    // Checked every second here (60 s by default); unchanged, it is not repeated.
    await waitFor(() => summaryReads('alice').length >= 3, 10_000, 'more checks');
    expect(statuses(s)).toHaveLength(1);

    relay.enqueue('alice', 'inbox', { from: 'carol' });
    const second = await waitFor(() => statuses(s)[1], 10_000, 'the second notice');
    expect(second.content).toBe(`team-relay: 2 questions from bob and carol waiting for you. Start your answering session: ${CMD}`);

    // The answering session starts polling: nothing more, whatever arrives.
    relay.answeringSeen.set('alice', new Date().toISOString());
    relay.enqueue('alice', 'inbox', { from: 'carol' });
    const reads = summaryReads('alice').length;
    await waitFor(() => summaryReads('alice').length >= reads + 2, 10_000, 'checks while answering');
    expect(statuses(s)).toHaveLength(2);

    // The working session never reads the inbox: the answering session's messages stay put.
    expect(inboxReads()).toEqual([]);
    expect(relay.stream('alice', 'inbox').cursor).toBe(0);
  });

  it('says nothing when nothing waits', async () => {
    const s = await asker('alice', '1');
    await waitFor(() => summaryReads('alice').length >= 2, 10_000, 'two checks');
    expect(statuses(s)).toEqual([]);
  });

  it('a relay without the summary (404) is silent and the session works', async () => {
    relay.fail((r) => r.path.endsWith('/inbox/summary'), 404, 100, { error: 'not_found' });
    const s = await asker('alice', '1');
    await waitFor(() => summaryReads('alice').length >= 2, 10_000, 'two checks');
    expect(statuses(s)).toEqual([]);
    expect((await call(s, 'list_teammates')).isError).toBe(false);
    const who = await whoami(s);
    expect(who).not.toHaveProperty('inbox_waiting');
  });

  it('the stored sign-in (the plugin as installed) checks at connect too', async () => {
    relay.enqueue('alice', 'inbox', { from: 'carol' });
    const s = await spawnServer('channel.js', {
      RELAY_ROLE: 'asker',
      RELAY_AUTH: '',
      RELAY_URL: relay.url,
      XDG_CONFIG_HOME: xdg,
      TEAM_RELAY_OPEN_COMMAND: join(FIXTURES, 'fake-browser.mjs'),
      TEAM_RELAY_CHANNEL: '1',
      CLAUDE_PLUGIN_ROOT: ROOT,
    });
    open.push(s);
    await call(s, 'login');
    const w = JSON.parse((await call(s, 'login_wait')).text);
    // login_wait's message appends the sentence.
    expect(w.message).toBe(
      `Connected as alice (alice@example.com) on team demo. 1 question from carol waiting for you. Start your answering session: ${CMD}`,
    );
    expect(w.inbox_waiting).toBe(1);
    const note = await waitFor(() => statuses(s).find((n) => n.content.includes('waiting for you')), 10_000, 'the notice');
    expect(note.content).toBe(`team-relay: 1 question from carol waiting for you. Start your answering session: ${CMD}`);
    expect(inboxReads()).toEqual([]);
  });

  it('login_wait says nothing more when nothing waits', async () => {
    const s = await spawnServer('channel.js', {
      RELAY_ROLE: 'asker',
      RELAY_AUTH: '',
      RELAY_URL: relay.url,
      XDG_CONFIG_HOME: xdg,
      TEAM_RELAY_OPEN_COMMAND: join(FIXTURES, 'fake-browser.mjs'),
      TEAM_RELAY_CHANNEL: '0',
    });
    open.push(s);
    await call(s, 'login');
    const w = JSON.parse((await call(s, 'login_wait')).text);
    expect(w.message).toBe('Connected as alice (alice@example.com) on team demo');
    expect(w.inbox_waiting).toBe(0);
  });
});

describe('a session without the channel', () => {
  it('pushes nothing and reads no stream, but whoami says what waits', async () => {
    relay.enqueue('alice', 'inbox', { from: 'bob' });
    relay.enqueue('alice', 'inbox', { from: 'bob' });
    const s = await asker('alice', '0');
    const who = await whoami(s);
    expect(who).toMatchObject({
      connected: true,
      inbox_waiting: 2,
      inbox_notice: `2 questions from bob waiting for you. Start your answering session: ${CMD}`,
    });
    await sleep(1500);
    expect(s.notifications).toEqual([]);
    expect(relay.requests.filter((r) => r.path.includes('/streams/'))).toEqual([]);
    // Only whoami read the summary: no periodic check here.
    expect(summaryReads('alice')).toHaveLength(1);
    expect(s.stderr()).not.toMatch(/inbox summary/);
  });

  it('whoami gives the count without the sentence while the answering session is online', async () => {
    relay.enqueue('alice', 'inbox', { from: 'bob' });
    relay.answeringSeen.set('alice', new Date().toISOString());
    const s = await asker('alice', '0');
    const who = await whoami(s);
    expect(who.inbox_waiting).toBe(1);
    expect(who).not.toHaveProperty('inbox_notice');
  });
});

describe('the SessionStart line', () => {
  const sessionStart = (member: string, extra: Record<string, string> = {}) =>
    new Promise<string>((resolve, reject) => {
      const env = baseEnv({ RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_TOKEN: TOKEN_OF[member]!, CLAUDE_PLUGIN_ROOT: ROOT, ...extra });
      execFile(process.execPath, [join(DIST, 'session-start.js')], { env, encoding: 'utf8', timeout: 15_000 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    });

  it('includes the sentence when questions wait and no answering session is running', async () => {
    relay.enqueue('bob', 'inbox', { from: 'alice' });
    relay.enqueue('bob', 'inbox', { from: 'carol' });
    const line = await sessionStart('bob');
    expect(line.trimEnd().split('\n')).toHaveLength(1);
    expect(line).toMatch(/^team-relay: you are bob in team demo; teammates: alice, carol\./);
    expect(line).toContain(`2 questions from alice and carol waiting for you. Start your answering session: ${CMD}`);
    expect(inboxReads()).toEqual([]);
  });

  it('says nothing of it when nothing waits, the answering session is online, or the summary fails', async () => {
    expect(await sessionStart('bob')).not.toMatch(/waiting for you/);
    relay.enqueue('bob', 'inbox', { from: 'alice' });
    relay.answeringSeen.set('bob', new Date().toISOString());
    expect(await sessionStart('bob')).not.toMatch(/waiting for you/);
    relay.answeringSeen.delete('bob');
    relay.fail((r) => r.path.endsWith('/inbox/summary'), 503, 1);
    const failed = await sessionStart('bob');
    expect(failed).toMatch(/^team-relay: you are bob in team demo/);
    expect(failed).not.toMatch(/waiting for you/);
  });

  it('a summary that hangs is given 3 s and the line still comes', async () => {
    relay.enqueue('bob', 'inbox', { from: 'alice' });
    relay.hang = (r) => r.path.endsWith('/inbox/summary');
    const started = Date.now();
    const line = await sessionStart('bob');
    expect(Date.now() - started).toBeLessThan(8000);
    expect(line).toMatch(/^team-relay: you are bob in team demo/);
    expect(line).not.toMatch(/waiting for you/);
  });
});
