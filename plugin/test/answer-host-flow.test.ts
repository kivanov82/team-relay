// M8-SPEC §7 items 4, 5 and 12, with the host in this process (so its limits and its
// notifier can be set), the fake relay, and the stub `claude` standing in for the answerer:
// taking over is announced; the volume limits make questions wait for approval to run;
// notifications and pushes are grouped; the inbox cursor moves only past fully handled
// questions, so one in flight when the host stops is received again (and skipped when the
// relay says it is already answered); the shared folder is withdrawn when the host stops.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnswerHost, type HostOptions } from '../src/answer-host.js';
import type { ElicitParams, ElicitResult } from '../src/approvals-review.js';
import { APPROVAL_TEXT, TAKEOVER_TEXT, type NoticeText } from '../src/notify-desktop.js';
import { RelayClient } from '../src/relay-client.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { DIST, FIXTURES, sleep, waitFor } from './helpers/mcp.js';

const STUB = join(FIXTURES, 'stub-claude.mjs');
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const script = (steps: unknown[]) => `STUB:${JSON.stringify({ steps })}`;

let relay: FakeRelay;
let tmp: string;
let proj: string;
let xdg: string;
const hosts: AnswerHost[] = [];
const savedTmp = process.env.TMPDIR;

beforeEach(async () => {
  relay = await new FakeRelay().start();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tr-flow-')));
  // The stub records into $TMPDIR/stub-claude; the host's socket directory goes there too.
  process.env.TMPDIR = tmp;
  xdg = join(tmp, 'xdg');
  mkdirSync(xdg, { mode: 0o700 });
  proj = join(tmp, 'project');
  mkdirSync(join(proj, '.git'), { recursive: true });
  writeFileSync(join(proj, 'NOTES.md'), 'The staging bucket lives in europe-west3.\n');
});
afterEach(async () => {
  while (hosts.length) await hosts.pop()!.stop();
  await relay.stop();
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
});

type Started = { host: AnswerHost; pushes: string[]; notices: NoticeText[]; logs: string[] };

function startHost(extra: Partial<HostOptions> = {}): Started {
  const pushes: string[] = [];
  const notices: NoticeText[] = [];
  const logs: string[] = [];
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', TMPDIR: tmp, XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv;
  const client = new RelayClient({ url: relay.url, team: 'demo', token: () => TOKEN_OF.bob!, attempts: 1 });
  const host = new AnswerHost({
    client,
    me: { team: 'demo', member: 'bob', teammates: ['alice', 'carol'] },
    env,
    connection: { mode: 'token', url: relay.url, team: 'demo', token: TOKEN_OF.bob! },
    push: (c) => void pushes.push(c),
    log: (l) => void logs.push(l),
    cwd: proj,
    distDir: DIST,
    claudeBin: STUB,
    notify: (t) => void notices.push(t),
    ...extra,
  });
  hosts.push(host);
  void host.start();
  return { host, pushes, notices, logs };
}

function ask(question: string, from = 'alice', answerMs = 600_000): string {
  const id = relay.addRequest({ kind: 'question', asker: from, question, recipients: { bob: { status: 'pending' } }, answer_deadline: iso(answerMs) });
  relay.enqueue('bob', 'inbox', { type: 'question', from, request_id: id, data: { question, ack_deadline: iso(60_000), answer_deadline: iso(answerMs) } });
  return id;
}

const replyTo = (id: string) => relay.replies.find((r) => r.request_id === id);
const record = (id: string) => JSON.parse(readFileSync(join(tmp, 'stub-claude', `${id}.json`), 'utf8')) as Record<string, any>;
const ran = (id: string) => {
  try {
    record(id);
    return true;
  } catch {
    return false;
  }
};
/** The cursor positions bob's host posted for its inbox. */
const cursors = () => relay.requests.filter((r) => r.member === 'bob' && r.method === 'POST' && r.path.endsWith('/streams/inbox/cursor')).map((r) => (r.body as { acked_seq: number }).acked_seq);
const reading = () => waitFor(() => relay.requests.some((r) => r.path.endsWith('/streams/inbox') && r.member === 'bob'), 10_000, 'the host to read the inbox');

/** The member's dialog: decides with the choices given, in order; records what it showed. */
function dialog(choices: string[], shown: string[] = []) {
  return async (p: ElicitParams): Promise<ElicitResult> => {
    shown.push(p.message);
    const c = choices.shift();
    return c ? { action: 'accept', content: { decision: c } } : { action: 'decline' };
  };
}

describe('taking over answering (§7 item 4)', () => {
  it('pushes the announcement and shows the fixed desktop notice', async () => {
    const { pushes, notices } = startHost();
    await reading();
    expect(pushes[0]).toBe(`team-relay: This session now answers teammates automatically from ${proj}; reads inside it are automatic.`);
    expect(notices).toEqual([TAKEOVER_TEXT]);
  });
});

describe('volume limits (§7 item 5)', () => {
  it('beyond the queued-per-asker limit a question waits for approval to run; allowed, it is answered', async () => {
    const { host, pushes } = startHost({ limits: { perAsker: 1 } });
    await reading();
    const a = ask(script([{ sleep: 800 }, { reply: { text: 'one' } }]));
    const b = ask(script([{ reply: { text: 'two' } }]));
    const c = ask(script([{ reply: { text: 'three' } }]));
    await waitFor(() => host.queue.size === 1, 10_000, 'the third to wait');
    const pending = host.queue.list()[0]!;
    expect(pending.ctx.request_id).toBe(c);
    expect(pending.ask).toEqual({ type: 'run', reason: 'alice already has 1 questions waiting to be answered automatically (at most 1)' });
    expect(pushes.some((p) => p.includes('answering it is waiting for your approval'))).toBe(true);
    await waitFor(() => replyTo(a) && replyTo(b), 15_000, 'the first two answers');
    expect(ran(c)).toBe(false);
    const shown: string[] = [];
    expect(await host.review(dialog(['allow'], shown))).toBe('Reviewed 1: 1 allowed. Nothing else is waiting.');
    expect(shown[0]).toContain('This question waits for your approval before your automatic answerer works on it');
    await waitFor(() => replyTo(c), 15_000, 'the third answer');
    expect(replyTo(c)!.body.text).toBe('three');
  });

  it('another asker is not held back by one who asks a lot', async () => {
    const { host } = startHost({ limits: { perAsker: 1 } });
    await reading();
    ask(script([{ sleep: 800 }, { reply: { text: 'a1' } }]));
    ask(script([{ reply: { text: 'a2' } }]));
    const fromCarol = ask(script([{ reply: { text: 'c1' } }]), 'carol');
    await waitFor(() => replyTo(fromCarol), 15_000, "carol's answer");
    expect(host.queue.size).toBe(0);
  });

  it('beyond the hourly limit a question waits; denied, nothing is sent and the cursor moves on', async () => {
    const { host } = startHost({ limits: { perHour: 1 } });
    await reading();
    const a = ask(script([{ reply: { text: 'first' } }]));
    await waitFor(() => replyTo(a), 15_000, 'the first answer');
    const b = ask(script([{ reply: { text: 'second' } }]));
    await waitFor(() => host.queue.size === 1, 10_000, 'the second to wait');
    expect(host.queue.list()[0]!.ask).toEqual({ type: 'run', reason: '1 questions were answered automatically in the last hour (at most 1)' });
    expect(await host.review(dialog(['deny']))).toBe('Reviewed 1: 1 denied. Nothing else is waiting.');
    await waitFor(() => cursors().includes(2), 10_000, 'the cursor past the denied question');
    expect(replyTo(b)).toBeUndefined();
    expect(ran(b)).toBe(false);
  });

  it('"Decline politely" on a question waiting to run sends the fixed sentence', async () => {
    const { host } = startHost({ limits: { perHour: 0 } });
    await reading();
    const a = ask('anything?');
    await waitFor(() => host.queue.size === 1, 10_000, 'the question to wait');
    await host.review(dialog(['decline']));
    await waitFor(() => replyTo(a), 10_000, 'the decline');
    expect(replyTo(a)!.body.text).toBe("I couldn't answer this automatically; bob hasn't approved it.");
  });
});

describe('grouped notifications (§7 item 5)', () => {
  it('one desktop notice per gap; after the first push, later ones carry counts only', async () => {
    const { host, pushes, notices } = startHost();
    await reading();
    ask(script([{ reply: { text: 'x', needs_approval: true } }]));
    ask(script([{ reply: { text: 'y', needs_approval: true } }]), 'carol');
    await waitFor(() => host.queue.size === 2, 15_000, 'two drafts');
    const approvals = pushes.filter((p) => p.includes('waiting for your approval'));
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toMatch(/^team-relay: alice asked: "STUB:.*" — an answer is waiting for your approval \(1 pending\)\. Run \/team-relay:approvals\.$/);
    expect(approvals[1]).toBe('team-relay: another item is waiting for your approval (2 pending). Run /team-relay:approvals.');
    expect(approvals[1]).not.toContain('carol');
    // The takeover notice took the one desktop notification of these five minutes.
    expect(notices).toEqual([TAKEOVER_TEXT]);
  });

  it('after the gap, the next push quotes again and the next notice shows', async () => {
    let now = Date.now();
    const { host, pushes, notices } = startHost({ now: () => now, limits: { noticeGapMs: 60_000 } });
    await reading();
    ask(script([{ reply: { text: 'x', needs_approval: true } }]));
    await waitFor(() => host.queue.size === 1, 15_000, 'the first draft');
    now += 61_000;
    ask(script([{ reply: { text: 'y', needs_approval: true } }]), 'carol');
    await waitFor(() => host.queue.size === 2, 15_000, 'the second draft');
    const approvals = pushes.filter((p) => p.includes('waiting for your approval'));
    expect(approvals[1]).toMatch(/^team-relay: carol asked: "STUB:/);
    expect(notices).toEqual([TAKEOVER_TEXT, APPROVAL_TEXT]);
  });
});

describe('nothing lost on stop (§7 item 12)', () => {
  it('the cursor moves only once a question is fully handled; one in flight is received again by the next host', async () => {
    const first = startHost();
    await reading();
    const a = ask(script([{ reply: { text: 'auto' } }]));
    await waitFor(() => replyTo(a), 15_000, 'the automatic answer');
    await waitFor(() => cursors().includes(1), 10_000, 'the cursor past the answered question');
    const b = ask(script([{ reply: { text: 'held', needs_approval: true } }]));
    await waitFor(() => first.host.queue.size === 1, 15_000, 'the draft to wait');
    await sleep(300);
    // Waiting for the member: not handled, so the cursor stays before it.
    expect(Math.max(...cursors())).toBe(1);
    await hosts.splice(hosts.indexOf(first.host), 1)[0]!.stop();
    expect(replyTo(b)).toBeUndefined();

    // The next host receives it again, and answers it this time.
    const second = startHost();
    await waitFor(() => second.host.queue.size === 1, 15_000, 'the question again, waiting');
    // Answered again by a new run: its draft is what waits.
    expect(second.host.queue.list()[0]!).toMatchObject({ ctx: { request_id: b }, ask: { type: 'draft', text: 'held' } });
    await second.host.review(dialog(['send']));
    await waitFor(() => replyTo(b), 10_000, 'the approved answer');
    await waitFor(() => cursors().includes(2), 10_000, 'the cursor past it');
    // The first question was not received again.
    expect(relay.replies.filter((r) => r.request_id === a)).toHaveLength(1);
  });

  it('a question received again after it was answered is skipped', async () => {
    const first = startHost();
    await reading();
    const b = ask(script([{ reply: { text: 'held', needs_approval: true } }]));
    await waitFor(() => first.host.queue.size === 1, 15_000, 'the draft to wait');
    await hosts.splice(hosts.indexOf(first.host), 1)[0]!.stop();
    // Answered meanwhile (another way): the relay says so at the acknowledgement.
    relay.requestDocs.get(b)!.recipients.bob!.status = 'answered';
    const before = record(b).calls.length;
    const second = startHost();
    await waitFor(() => cursors().includes(1), 10_000, 'the cursor past it');
    expect(second.logs.some((l) => l === `${b} is already answered; skipped`)).toBe(true);
    await sleep(500);
    expect(record(b).calls.length).toBe(before);
    expect(second.host.queue.size).toBe(0);
  });

  it('the cursor never passes an open question, even when a later one is handled first', async () => {
    const { host } = startHost();
    await reading();
    const a = ask(script([{ reply: { text: 'held', needs_approval: true } }]));
    const b = ask(script([{ reply: { text: 'auto' } }]));
    await waitFor(() => replyTo(b) && host.queue.size === 1, 15_000, 'the second answered, the first waiting');
    await sleep(300);
    expect(cursors().every((c) => c < 1)).toBe(true);
    await host.review(dialog(['dont_send']));
    await waitFor(() => cursors().includes(2), 10_000, 'the cursor past both');
    expect(replyTo(a)).toBeUndefined();
  });

  it('a lapsed approval counts as handled', async () => {
    const { host } = startHost();
    await reading();
    ask(script([{ reply: { text: 'held', needs_approval: true } }]), 'alice', 2500);
    await waitFor(() => host.queue.size === 1, 15_000, 'the draft to wait');
    await waitFor(() => cursors().includes(1), 10_000, 'the cursor past the lapsed question');
  });

  it('the shared folder is withdrawn when the host stops', async () => {
    const { host } = startHost();
    await reading();
    await waitFor(() => (relay.manifests.get('bob') as { shares?: unknown[] } | undefined)?.shares?.length === 1, 5000, 'the share');
    expect(relay.manifests.get('bob')).toMatchObject({ shares: [{ name: 'project' }] });
    await hosts.splice(hosts.indexOf(host), 1)[0]!.stop();
    expect(relay.manifests.get('bob')).toMatchObject({ shares: [] });
  });
});
