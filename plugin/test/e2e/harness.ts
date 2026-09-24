// The e2e harness (M1-SPEC §9): drives the real bundled servers (node dist/*.js) over stdio
// with the MCP client SDK, playing Claude Code, against a real relay on the Firestore
// emulator. scripts/e2e.sh starts both and exports RELAY_URL and the E2E_TOKEN_* values.
//
// Tokens are read from the environment and never appear in an assertion message, a thrown
// error or a log line.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomBytes } from 'node:crypto';
import { DIST, FIXTURES, baseEnv, textOf } from '../helpers/mcp.js';

export const TEAM = 'demo';
export const MEMBERS = ['alice', 'bob', 'carol'] as const;
export type Member = (typeof MEMBERS)[number];

export const ENABLED = process.env.E2E === '1';
export const RUNNER = FIXTURES + 'fake-runner.mjs';

export function relayUrl(): string {
  const url = process.env.RELAY_URL ?? '';
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(url)) {
    throw new Error('RELAY_URL must be http://127.0.0.1:<port> (run the suite through scripts/e2e.sh)');
  }
  return url;
}

export function tokenOf(member: Member): string {
  const t = process.env[`E2E_TOKEN_${member.toUpperCase()}`];
  if (!t || !/^[0-9a-f]{48}$/.test(t)) {
    throw new Error(`E2E_TOKEN_${member.toUpperCase()} is missing or malformed (run the suite through scripts/e2e.sh)`);
  }
  return t;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `fn` every 50 ms until it returns something truthy or `timeoutMs` passes. */
export async function until<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------
// Raw HTTP against the relay (the relay-level checks of scenarios 4, 6 and 7).

export type ApiResult = { status: number; body: Record<string, unknown> };

export async function api(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(new URL(path, relayUrl()), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path}: ${res.status} with a body that is not JSON`);
    }
  }
  return { status: res.status, body: parsed as Record<string, unknown> };
}

export const teamPath = (...parts: string[]) => `/v1/teams/${TEAM}/${parts.join('/')}`;

/** A member's stream position at the relay, read without moving the cursor. */
export async function streamPosition(member: Member, stream: 'inbox' | 'replies'): Promise<{ cursor: number; head: number }> {
  const path = teamPath('streams', stream) + '?wait=0&limit=1';
  // A 429 means the relay's per-stream poll cap counted a crashed process's poll that it
  // has not noticed yet (scenario 5); that is the harness's read, not the system under test.
  let r = await api(tokenOf(member), 'GET', path);
  for (let tries = 0; r.status === 429 && tries < 20; tries++) {
    await sleep(250);
    r = await api(tokenOf(member), 'GET', path);
  }
  if (r.status !== 200) throw new Error(`reading ${member}'s ${stream} position: ${r.status}`);
  return { cursor: r.body.cursor as number, head: r.body.head as number };
}

export const idempotencyKey = () => `e2e-${randomBytes(12).toString('hex')}`;

// ---------------------------------------------------------------------------------------
// A bundled server over stdio, with the notifications it pushed.

export type Note = { content: string; meta: Record<string, string>; at: number };

export class Party {
  readonly notes: Note[] = [];
  readonly other: Array<{ method: string; params?: unknown }> = [];
  private err = '';

  private constructor(
    readonly label: string,
    readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {}

  static async start(label: string, bundle: 'channel.js' | 'capabilities.js', env: Record<string, string>): Promise<Party> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST + bundle],
      env: baseEnv(env),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e-claude-code', version: '0.0.0' }, { capabilities: {} });
    const party = new Party(label, client, transport);
    transport.stderr?.on('data', (c: Buffer) => (party.err += c.toString('utf8')));
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/claude/channel') {
        const p = n.params as { content: string; meta: Record<string, string> };
        party.notes.push({ content: p.content, meta: p.meta, at: Date.now() });
      } else {
        party.other.push(n);
      }
    };
    try {
      await client.connect(transport);
    } catch (err) {
      // The server's own reason (it never logs a token) makes a failed start readable.
      await sleep(100);
      throw new Error(`${label} did not start: ${String(err)}; stderr: ${party.err.slice(-800)}`);
    }
    return party;
  }

  get pid(): number {
    const pid = this.transport.pid;
    if (pid === null) throw new Error(`${this.label}: no process`);
    return pid;
  }

  stderr(): string {
    return this.err;
  }

  forRequest(requestId: string): Note[] {
    return this.notes.filter((n) => n.meta.request_id === requestId);
  }

  async waitNote(pred: (n: Note) => boolean, timeoutMs: number, what: string): Promise<Note> {
    return until(() => this.notes.find(pred), timeoutMs, `${this.label}: ${what}`);
  }

  /** Call a tool; `json` is the parsed text for a successful call. */
  async call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: Record<string, unknown> }> {
    const res = await this.client.callTool({ name, arguments: args });
    const text = textOf(res);
    const isError = res.isError === true;
    let json: Record<string, unknown> = {};
    if (!isError) json = JSON.parse(text) as Record<string, unknown>;
    return { isError, text, json };
  }

  /** Call a tool that must succeed. */
  async ok(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.call(name, args);
    if (r.isError) throw new Error(`${this.label}: ${name} failed: ${r.text}`);
    return r.json;
  }

  /** Kill the process outright (a crash: no shutdown path runs) and wait for it to go. */
  async crash(): Promise<void> {
    const pid = this.pid;
    process.kill(pid, 'SIGKILL');
    await until(() => !alive(pid), 5000, `${this.label} (pid ${pid}) to exit`);
    await this.client.close().catch(() => {});
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A channel server's environment. TEAM_RELAY_CHANNEL=1: this harness plays a Claude Code session
 * started with the channel, so the server reads its stream (there is no claude process here for
 * it to find). Scenario 8 of m1.test.ts overrides it with 0: a session without the channel.
 */
export function channelEnv(member: Member, role: 'asker' | 'answerer', extra: Record<string, string> = {}): Record<string, string> {
  return { RELAY_URL: relayUrl(), RELAY_TEAM: TEAM, RELAY_TOKEN: tokenOf(member), RELAY_ROLE: role, TEAM_RELAY_CHANNEL: '1', ...extra };
}

/** bob offers staging_db_query with the synthetic runner; nobody else offers anything. */
export const BOB_CAPABILITIES = { CAP_STAGING_DB_QUERY_ENABLED: 'true', CAP_STAGING_DB_QUERY_RUNNER: RUNNER };

export const MESSAGE_ID_RE = /^msg_[0-9a-f]{32}$/;
export const REQUEST_ID_RE = /^rq_[0-9a-f]{32}$/;
export const META_KEY_RE = /^[A-Za-z0-9_]+$/;
