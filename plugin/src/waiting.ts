// Questions waiting for the member's answering session (M7-SPEC §2). The relay keeps a
// question in the member's inbox until an answering session acknowledges it; this says so when
// no answering session is running. The summary (GET /inbox/summary) is a peek: it moves no
// cursor and writes no presence, so any session may read it (whoami, SessionStart); only a
// channel session pushes the notice as a status event.

import { MEMBER_RE, RelayError, type RelayClient } from './relay-client.js';
import { isPlainObject } from './tool-util.js';

/** An answering session that polled within this long is online (M2-SPEC §5, M7-SPEC §2). */
export const ANSWERING_ONLINE_MS = 45_000;
/** How often a channel session checks the summary. */
export const CHECK_INTERVAL_MS = 60_000;
/** An unchanged notice is repeated at most this often. */
export const REPEAT_MS = 3_600_000;
/** The relay reads at most this many waiting messages (M7-SPEC §1). */
export const SUMMARY_CAP = 50;

export type InboxSummary = {
  pending: number;
  /** The count stopped at the cap and the inbox holds later messages. */
  more: boolean;
  oldest_at: string | null;
  /** Distinct senders, id-shaped only, at most five. */
  from: string[];
  answering: { last_seen: string | null };
};

/** The relay's answer, checked: anything malformed is null (and says nothing). */
export function parseSummary(raw: unknown): InboxSummary | null {
  if (!isPlainObject(raw)) return null;
  const { pending, more, oldest_at, from, answering } = raw;
  if (typeof pending !== 'number' || !Number.isInteger(pending) || pending < 0 || pending > SUMMARY_CAP) return null;
  const seen = isPlainObject(answering) ? answering.last_seen : null;
  const time = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
  return {
    pending,
    more: more === true,
    oldest_at: time(oldest_at),
    from: Array.isArray(from) ? from.filter((m): m is string => typeof m === 'string' && MEMBER_RE.test(m)).slice(0, 5) : [],
    answering: { last_seen: time(seen) },
  };
}

export function answeringOnline(s: InboxSummary, now: number): boolean {
  if (s.answering.last_seen === null) return false;
  return now - Date.parse(s.answering.last_seen) < ANSWERING_ONLINE_MS;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * "<n> question(s) from <names> waiting for you. Start your answering session: <command>",
 * or null when nothing is waiting or the answering session is online.
 */
export function waitingSentence(s: InboxSummary, now: number, command: string): string | null {
  if (s.pending === 0 || answeringOnline(s, now)) return null;
  const count = s.more ? `${s.pending}+` : String(s.pending);
  const noun = s.pending === 1 && !s.more ? 'question' : 'questions';
  const from = s.from.length > 0 ? ` from ${joinNames(s.from)}` : '';
  return `${count} ${noun}${from} waiting for you. Start your answering session: ${command}`;
}

/**
 * When to push the notice: when something is waiting and the answering session is not
 * online, and then again only when the count or the senders change, or once an hour while
 * they stay the same. Nothing waiting forgets the last notice, so the next question is news.
 */
export class NoticeRule {
  private lastKey: string | null = null;
  private lastAt = 0;

  constructor(private readonly repeatMs: number = REPEAT_MS) {}

  decide(s: InboxSummary, now: number, command: string): string | null {
    if (s.pending === 0) {
      this.lastKey = null;
      return null;
    }
    const sentence = waitingSentence(s, now, command);
    if (sentence === null) return null;
    const key = `${s.pending}|${s.more}|${s.from.join(',')}`;
    if (key === this.lastKey && now - this.lastAt < this.repeatMs) return null;
    this.lastKey = key;
    this.lastAt = now;
    return sentence;
  }
}

/** One bounded summary read, or null (older relay, refused, unreachable, malformed). */
export async function readSummary(client: RelayClient, timeoutMs = 3000, signal?: AbortSignal): Promise<InboxSummary | null> {
  try {
    return parseSummary(await client.inboxSummary({ attempts: 1, timeoutMs, ...(signal ? { signal } : {}) }));
  } catch {
    return null;
  }
}

/** The whoami fields: the count and, when it applies, the sentence. Empty when unknown. */
export async function whoamiFields(client: RelayClient, command: string): Promise<Record<string, unknown>> {
  const s = await readSummary(client);
  if (!s) return {};
  const sentence = waitingSentence(s, Date.now(), command);
  return { inbox_waiting: s.pending, ...(s.more ? { inbox_waiting_more: true } : {}), ...(sentence ? { inbox_notice: sentence } : {}) };
}

/** TEAM_RELAY_INBOX_CHECK_SECONDS (1..60) shortens the check interval, for tests. */
export function checkIntervalMs(env: NodeJS.ProcessEnv): number {
  const v = Number(env.TEAM_RELAY_INBOX_CHECK_SECONDS);
  return Number.isInteger(v) && v >= 1 && v * 1000 <= CHECK_INTERVAL_MS ? v * 1000 : CHECK_INTERVAL_MS;
}

/**
 * The channel session's check: at once (connect, which follows every sign-in), then every
 * `intervalMs` until `signal` aborts. A failed read is silent; a refused sign-in is the
 * stream loop's to report.
 */
export async function watchInbox(opts: {
  client: RelayClient;
  push: (content: string) => Promise<void> | void;
  command: string;
  signal: AbortSignal;
  intervalMs?: number;
  rule?: NoticeRule;
  log?: (line: string) => void;
}): Promise<void> {
  const rule = opts.rule ?? new NoticeRule();
  const interval = opts.intervalMs ?? CHECK_INTERVAL_MS;
  let failing = false;
  while (!opts.signal.aborted) {
    try {
      const raw = await opts.client.inboxSummary({ attempts: 1, timeoutMs: 15_000, signal: opts.signal });
      failing = false;
      const s = parseSummary(raw);
      const sentence = s ? rule.decide(s, Date.now(), opts.command) : null;
      if (sentence && !opts.signal.aborted) await opts.push(`team-relay: ${sentence}`);
    } catch (err) {
      if (opts.signal.aborted) return;
      if (!failing) {
        const why = err instanceof RelayError ? `${err.status} ${err.code}` : 'unreachable';
        opts.log?.(`inbox summary not read (${why}); checking again later`);
      }
      failing = true;
    }
    await sleep(interval, opts.signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}
