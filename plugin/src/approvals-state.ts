// How many answers wait for the member's approval (M8-SPEC §5), for the processes that are not
// the host: the SessionStart line of any session and the local console's header. The host
// writes `~/.config/team-relay/approvals.json` (mode 600, atomically) with its pid and the
// count only: no teammate text, no request id. A reader trusts it only while that pid lives.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, pidAlive } from './answering-lock.js';

export const STATE_FILE = 'approvals.json';

export type ApprovalsState = { pending: number; pid: number; updated_at: string };

export function statePath(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), STATE_FILE);
}

export function writeApprovalsState(path: string, pending: number, pid: number = process.pid): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ pending, pid, updated_at: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Removed when the host stops, and only while it is still the host's own. */
export function clearApprovalsState(path: string, pid: number = process.pid): void {
  const s = readApprovalsState(path, () => true);
  if (s && s.pid === pid) rmSync(path, { force: true });
}

/** The count while its host lives; null otherwise (no host, a stale file, or a malformed one). */
export function readApprovalsState(path: string, alive: (pid: number) => boolean = pidAlive): ApprovalsState | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  if (raw.length > 4096) return null;
  try {
    const v = JSON.parse(raw) as Partial<ApprovalsState>;
    if (typeof v.pending !== 'number' || !Number.isInteger(v.pending) || v.pending < 0 || v.pending > 10_000) return null;
    if (typeof v.pid !== 'number' || !alive(v.pid)) return null;
    return { pending: v.pending, pid: v.pid, updated_at: typeof v.updated_at === 'string' ? v.updated_at : '' };
  } catch {
    return null;
  }
}

/** "N answers waiting for your approval", or null for none. */
export function approvalsSentence(pending: number): string | null {
  if (pending <= 0) return null;
  return `${pending} ${pending === 1 ? 'answer' : 'answers'} waiting for your approval`;
}
