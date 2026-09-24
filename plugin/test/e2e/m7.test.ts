// The M7 end-to-end scenario (docs/M7-SPEC.md §4): a question to a member whose answering
// session is not running waits in their inbox, and their channel working session says so with
// a status event (and whoami with the count); nothing reads the inbox meanwhile. When the
// answering session starts, the question is delivered to it exactly once, and it is answered.
//
// Run through ../scripts/e2e.sh, which sets E2E_M7=1 only when the relay serves GET
// /v1/teams/{team}/inbox/summary. Every request here is answered and every stream drained
// before the end, so the other files' ledgers are unaffected whichever runs first.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENABLED, MEMBERS, Party, api, channelEnv, sleep, teamPath, tokenOf, until, type Member } from './harness.js';

const M7 = ENABLED && process.env.E2E_M7 === '1';
const ROOT = '/opt/e2e/team-relay';
const COMMAND = `"${ROOT}/bin/answerer"`;
/** The relay's answering session is online while it polled within this long (M7-SPEC §2). */
const ONLINE_MS = 45_000;

type Summary = { pending: number; more: boolean; oldest_at: string | null; from: string[]; answering: { last_seen: string | null } };

async function summaryOf(member: Member): Promise<Summary> {
  const r = await api(tokenOf(member), 'GET', teamPath('inbox', 'summary'));
  expect(r.status).toBe(200);
  return r.body as unknown as Summary;
}

const seenAgo = (s: Summary) => (s.answering.last_seen === null ? Infinity : Date.now() - Date.parse(s.answering.last_seen));

let target: Member;
let asker: Member;
const parties: Party[] = [];

describe.skipIf(!M7)('M7 end to end: say when questions are waiting', () => {
  beforeAll(async () => {
    // Earlier files ran answering sessions: take the member whose answering session has been
    // quiet longest, and wait until it counts as not running.
    const quiet = await Promise.all(MEMBERS.map(async (m) => ({ m, ago: seenAgo(await summaryOf(m)) })));
    quiet.sort((a, b) => b.ago - a.ago);
    target = quiet[0]!.m;
    asker = MEMBERS.find((m) => m !== target)!;
    if (quiet[0]!.ago < ONLINE_MS + 1000) await sleep(ONLINE_MS + 1000 - quiet[0]!.ago);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(parties.map((p) => p.close()));
  });

  it('the working session is told, the inbox is left alone, and the answering session gets the question once', async () => {
    const before = await summaryOf(target);
    expect(seenAgo(before)).toBeGreaterThanOrEqual(ONLINE_MS);

    // The target's working session, started with the channel; it checks every second here.
    const working = await Party.start(
      `m7-${target}-working`,
      'channel.js',
      channelEnv(target, 'asker', { CLAUDE_PLUGIN_ROOT: ROOT, TEAM_RELAY_INBOX_CHECK_SECONDS: '1' }),
    );
    parties.push(working);
    const askerSession = await Party.start(`m7-${asker}-working`, 'channel.js', channelEnv(asker, 'asker'));
    parties.push(askerSession);

    const asked = await askerSession.ok('ask_question', {
      to: [target],
      question: 'M7 e2e: which region does the staging bucket live in?',
    });
    const requestId = asked.request_id as string;

    // The notice, in the working session, as a status event from the plugin itself.
    const count = before.pending + 1;
    const noun = count === 1 ? 'question' : 'questions';
    const notice = await working.waitNote(
      (n) => n.meta.type === 'status' && n.content.includes('waiting for you'),
      15_000,
      'the waiting notice',
    );
    expect(notice.content).toMatch(new RegExp(`^team-relay: ${count} ${noun} from [a-z0-9_, ]*\\b${asker}\\b`));
    expect(notice.content.endsWith(`waiting for you. Start your answering session: ${COMMAND}`)).toBe(true);
    expect(notice.meta).toEqual({ type: 'status' });

    // whoami says the same; the summary counts it; nothing read the inbox or moved presence.
    const who = await working.ok('whoami', {});
    expect(who.inbox_waiting).toBe(count);
    expect(who.inbox_notice).toBe(notice.content.replace(/^team-relay: /, ''));
    const waiting = await summaryOf(target);
    expect(waiting.pending).toBe(count);
    expect(waiting.from).toContain(asker);
    expect(waiting.answering.last_seen).toBe(before.answering.last_seen);

    // Unchanged, it is not repeated.
    await sleep(3000);
    expect(working.notes.filter((n) => n.content.includes('waiting for you'))).toHaveLength(1);

    // The answering session starts: the question is delivered to it, once.
    const answering = await Party.start(`m7-${target}-answering`, 'channel.js', channelEnv(target, 'answerer'));
    parties.push(answering);
    const delivered = await answering.waitNote((n) => n.meta.request_id === requestId, 15_000, 'the question');
    expect(delivered.meta.type).toBe('question');
    expect(delivered.meta.from).toBe(asker);
    await until(async () => (await summaryOf(target)).pending === 0, 15_000, 'the inbox to drain');
    await sleep(2500);
    expect(answering.forRequest(requestId)).toHaveLength(1);
    // Nothing is waiting any more, so the working session says nothing more.
    expect(working.notes.filter((n) => n.content.includes('waiting for you'))).toHaveLength(1);

    // Answered, and the answer reaches the asker's working session.
    expect(await answering.ok('ack_question', { request_id: requestId })).toEqual({ status: 'acked' });
    await answering.ok('reply', { request_id: requestId, text: 'M7 e2e: europe-west3.' });
    const answer = await askerSession.waitNote((n) => n.meta.request_id === requestId && n.meta.type === 'answer', 15_000, 'the answer');
    expect(answer.content).toContain('europe-west3');
  }, 90_000);
});
