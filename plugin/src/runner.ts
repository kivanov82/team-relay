// Run one capability program (M1-SPEC §8.3): no shell, no caller arguments, a minimal
// environment, one JSON line on stdin, one JSON object (at most 64 KiB) on stdout, progress
// lines on stderr, and a timeout that escalates SIGTERM → SIGKILL.

import { spawn } from 'node:child_process';

export const STDOUT_LIMIT = 64 * 1024;
export const KILL_GRACE_MS = 5000;
const STDERR_LINE_LIMIT = 8 * 1024;
const PROGRESS_TEXT_LIMIT = 1000;

export type Progress = { text: string; pct: number | null };

export type RunInput = {
  runner: string;
  capability: string;
  params: Record<string, unknown>;
  requestId: string;
  timeoutSeconds: number;
  parentEnv: NodeJS.ProcessEnv;
  onProgress: (p: Progress) => void;
  onStderr: (line: string) => void;
};

export type RunResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** The only environment a runner sees: PATH, HOME, LANG (when set) and CAPABILITY_NAME. */
export function minimalEnv(parent: NodeJS.ProcessEnv, capability: string): Record<string, string> {
  const env: Record<string, string> = { CAPABILITY_NAME: capability };
  for (const key of ['PATH', 'HOME', 'LANG'] as const) {
    const v = parent[key];
    if (typeof v === 'string') env[key] = v;
  }
  return env;
}

/** Parse one stderr line as `{"progress": "text", "pct": n}`; null when it is not one. */
export function parseProgress(line: string): Progress | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.progress !== 'string' || rec.progress.trim() === '') return null;
  let pct: number | null = null;
  if (typeof rec.pct === 'number' && Number.isFinite(rec.pct)) {
    pct = Math.min(100, Math.max(0, Math.round(rec.pct)));
  }
  const chars = [...rec.progress];
  const text = chars.length > PROGRESS_TEXT_LIMIT ? chars.slice(0, PROGRESS_TEXT_LIMIT).join('') : rec.progress;
  return { text, pct };
}

export function runCapability(input: RunInput): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let failure: string | null = null;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBuf = '';
    let killTimer: NodeJS.Timeout | undefined;

    let child;
    try {
      child = spawn(input.runner, [], {
        shell: false,
        env: minimalEnv(input.parentEnv, input.capability),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // its own process group, so a timeout kills what it started too
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: `runner could not start (${(err as NodeJS.ErrnoException).code ?? 'error'})` });
      return;
    }

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };
    const terminate = (reason: string) => {
      if (failure === null) failure = reason;
      killGroup('SIGTERM');
      killTimer ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };
    activeRunners.add(killGroup);

    const timer = setTimeout(() => terminate(`runner timed out after ${input.timeoutSeconds} s`), input.timeoutSeconds * 1000);

    const handleStderrLine = (line: string) => {
      if (!line) return;
      const p = parseProgress(line);
      if (p) input.onProgress(p);
      else input.onStderr(line);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (failure !== null) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_LIMIT) {
        stdout.length = 0;
        terminate('runner output is larger than 64 KiB');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) >= 0) {
        handleStderrLine(stderrBuf.slice(0, nl).replace(/\r$/, ''));
        stderrBuf = stderrBuf.slice(nl + 1);
      }
      if (stderrBuf.length > STDERR_LINE_LIMIT) {
        handleStderrLine(stderrBuf.slice(0, STDERR_LINE_LIMIT));
        stderrBuf = '';
      }
    });
    // A runner that exits without reading stdin must not crash this server (EPIPE).
    child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify({ capability: input.capability, params: input.params, request_id: input.requestId })}\n`);

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (failure === null) failure = `runner could not start (${err.code ?? 'error'})`;
      if (child.pid === undefined && !settled) {
        // Spawn itself failed: there is no process whose 'close' will follow.
        settled = true;
        clearTimeout(timer);
        activeRunners.delete(killGroup);
        resolve({ ok: false, error: failure });
      }
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      activeRunners.delete(killGroup);
      if (stderrBuf) handleStderrLine(stderrBuf);
      if (failure !== null) return resolve({ ok: false, error: failure });
      if (code !== 0) {
        return resolve({ ok: false, error: signal ? `runner was killed by ${signal}` : `runner exited with code ${code}` });
      }
      const text = Buffer.concat(stdout).toString('utf8').trim();
      if (!text) return resolve({ ok: false, error: 'runner wrote no output' });
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return resolve({ ok: false, error: 'runner output is not one JSON value' });
      }
      // It becomes the reply's `data` (M1-SPEC §11.11), so it must be an object.
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return resolve({ ok: false, error: 'runner output is not a JSON object' });
      }
      resolve({ ok: true, value: value as Record<string, unknown> });
    });
  });
}

/** Kill functions for runners still going; used to clean up when the server exits. */
export const activeRunners = new Set<(signal: NodeJS.Signals) => void>();
