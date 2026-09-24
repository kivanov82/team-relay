// The answering session's open requests (M2-SPEC §4.3): `$ANSWERER_STATE_DIR/active.json`.
// The answerer channel adds a request id when ack_question succeeds and removes it when
// reply does; the tool-event hook reads it to attribute a tool call to the most recently
// acknowledged open request. Only ids and times are stored, never teammate text.
//
// Each entry carries the request's answer deadline (M2-SPEC §7.6); an entry past it is
// dropped whenever the file is read, so a request that was acknowledged and never answered
// stops collecting tool events once it can no longer be answered in time. The answerer
// channel clears the file when it starts.
//
// Written atomically (a temp file in the same directory, then rename), so a reader never
// sees a half-written file.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { REQUEST_ID_RE } from './relay-client.js';

export const ACTIVE_FILE = 'active.json';
/** Oldest entries are dropped beyond this; an answering session never has this many open. */
export const MAX_OPEN = 50;
const READ_LIMIT = 64 * 1024;

export type ActiveEntry = { request_id: string; acked_at: string; answer_deadline: string };
export type ActiveFile = { version: 1; open: ActiveEntry[] };

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** An RFC 3339 time with a zone, as the relay writes them, or null. */
export function deadlineOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40 || !RFC3339.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The open requests, oldest acknowledgement first: those whose answer deadline is still
 * ahead of `now`. A missing or malformed file is empty.
 */
export function readActive(stateDir: string, now: number = Date.now()): ActiveEntry[] {
  let raw: string;
  try {
    raw = readFileSync(join(stateDir, ACTIVE_FILE), 'utf8');
  } catch {
    return [];
  }
  if (raw.length > READ_LIMIT) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const open = (parsed as { open?: unknown })?.open;
  if (!Array.isArray(open)) return [];
  return open.filter(
    (e): e is ActiveEntry =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as ActiveEntry).request_id === 'string' &&
      REQUEST_ID_RE.test((e as ActiveEntry).request_id) &&
      typeof (e as ActiveEntry).acked_at === 'string' &&
      deadlineOf((e as ActiveEntry).answer_deadline) !== null &&
      Date.parse((e as ActiveEntry).answer_deadline) > now,
  );
}

/** The most recently acknowledged open request still within its answer deadline, if any. */
export function mostRecentOpen(stateDir: string, now: number = Date.now()): string | null {
  return readActive(stateDir, now).at(-1)?.request_id ?? null;
}

export function writeActiveAtomic(stateDir: string, open: ActiveEntry[]): void {
  const body: ActiveFile = { version: 1, open: open.slice(-MAX_OPEN) };
  const tmp = join(stateDir, `.${ACTIVE_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, join(stateDir, ACTIVE_FILE));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The channel's writer: one read-modify-write at a time, in call order. */
export class ActiveRequests {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly stateDir: string,
    private readonly onError: (err: unknown) => void = () => {},
  ) {
    if (!isAbsolute(stateDir)) throw new Error('ANSWERER_STATE_DIR must be an absolute path');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }

  private update(fn: (open: ActiveEntry[]) => ActiveEntry[]): Promise<void> {
    this.chain = this.chain.then(() => {
      try {
        writeActiveAtomic(this.stateDir, fn(readActive(this.stateDir)));
      } catch (err) {
        this.onError(err);
      }
    });
    return this.chain;
  }

  /**
   * Acknowledged: now the most recent (a repeated ack moves it to the end). `answerDeadline`
   * is the request's answer deadline (RFC 3339); past it the entry is dropped on read.
   */
  add(requestId: string, answerDeadline: string, now = new Date()): Promise<void> {
    if (deadlineOf(answerDeadline) === null) return Promise.reject(new Error('answer deadline must be an RFC 3339 time'));
    return this.update((open) => [
      ...open.filter((e) => e.request_id !== requestId),
      { request_id: requestId, acked_at: now.toISOString(), answer_deadline: answerDeadline },
    ]);
  }

  /** Nothing open: what the answerer channel does when it starts (M2-SPEC §7.6). */
  clear(): Promise<void> {
    return this.update(() => []);
  }

  /** Answered (or no longer answerable): no longer open. */
  remove(requestId: string): Promise<void> {
    return this.update((open) => open.filter((e) => e.request_id !== requestId));
  }
}

/**
 * The answer deadlines of the questions and capability calls the answerer channel pushed
 * (their envelopes carry `answer_deadline`, M1-SPEC §5), so an acknowledgement can record
 * one without another relay call. Bounded: the oldest are forgotten first.
 */
export class AnswerDeadlines {
  private readonly map = new Map<string, string>();
  constructor(private readonly capacity = 500) {}

  remember(requestId: string, answerDeadline: unknown): void {
    const deadline = deadlineOf(answerDeadline);
    if (!REQUEST_ID_RE.test(requestId) || deadline === null) return;
    this.map.delete(requestId);
    this.map.set(requestId, deadline);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  get(requestId: string): string | null {
    return this.map.get(requestId) ?? null;
  }
}
