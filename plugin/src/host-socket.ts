// The private channel between the host (a channel working session's server) and the small
// `host` MCP server each headless answerer runs (answer-tools.ts; M8-SPEC §2).
//
// A Unix socket, mode 600, inside a directory of its own made with mkdtemp (mode 700). Each
// connection must first send {"auth": <token>}: the per-launch token of the answerer run that
// is current, 32 random bytes the host gives only that run (in its mcp.json, mode 600, in a
// mode-700 directory the run cannot read: deny rule). A wrong token, any other first line, or
// a token from an earlier run closes the connection. Then newline-delimited JSON requests
// {"id", "method", "params"} get {"id", "result"} or {"id", "error"}. Lines are capped at 1 MiB.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MAX_LINE = 1024 * 1024;
export const SOCKET_FILE = 'host.sock';

export type Handler = (method: string, params: unknown) => Promise<unknown>;

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Split a stream into lines, refusing any longer than MAX_LINE. */
function lineReader(sock: Socket, onLine: (line: string) => void, onTooLong: () => void) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      onLine(line);
    }
    if (buf.length > MAX_LINE) {
      buf = '';
      onTooLong();
    }
  });
}

export class HostSocket {
  readonly dir: string;
  readonly path: string;
  private server: Server | null = null;
  private current: { token: Buffer; handler: Handler } | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(opts: { tmpRoot?: string } = {}) {
    // A short root keeps the socket path within the platform's limit (104 bytes on macOS).
    this.dir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), 'trh-'));
    chmodSync(this.dir, 0o700);
    this.path = join(this.dir, SOCKET_FILE);
  }

  async listen(): Promise<void> {
    const server = createServer((sock) => this.accept(sock));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(this.path, 0o600);
    this.server = server;
  }

  /** The run that may talk to the host now; any earlier run's token stops working. */
  setRun(token: string, handler: Handler): void {
    this.current = { token: digest(token), handler };
  }

  /** No run is current: every connection is refused, and the open ones are closed. */
  clearRun(): void {
    this.current = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  private accept(sock: Socket) {
    let authed: { token: Buffer; handler: Handler } | null = null;
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => sock.destroy());
    const send = (value: unknown) => {
      if (!sock.destroyed) sock.write(`${JSON.stringify(value)}\n`);
    };
    lineReader(
      sock,
      (line) => {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          sock.destroy();
          return;
        }
        if (!authed) {
          const token = (msg as { auth?: unknown })?.auth;
          const run = this.current;
          if (typeof token !== 'string' || !run || !timingSafeEqual(digest(token), run.token)) {
            sock.destroy();
            return;
          }
          authed = run;
          send({ auth: 'ok' });
          return;
        }
        // A run that is no longer current has no say, even on a connection it opened in time.
        if (this.current !== authed) {
          sock.destroy();
          return;
        }
        const { id, method, params } = (msg ?? {}) as { id?: unknown; method?: unknown; params?: unknown };
        if (typeof id !== 'number' || typeof method !== 'string') {
          sock.destroy();
          return;
        }
        authed.handler(method, params).then(
          (result) => send({ id, result: result ?? null }),
          (err: unknown) => send({ id, error: err instanceof Error ? err.message : 'failed' }),
        );
      },
      () => sock.destroy(),
    );
  }

  async close(): Promise<void> {
    this.clearRun();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The answerer side: connect, authenticate, then call methods. */
export class HostSocketClient {
  private sock: Socket | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closedError: Error | null = null;

  static async connect(path: string, token: string): Promise<HostSocketClient> {
    const c = new HostSocketClient();
    await c.open(path, token);
    return c;
  }

  private open(path: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(path);
      let authed = false;
      sock.once('error', (err) => {
        if (!authed) reject(err);
      });
      sock.on('close', () => {
        this.closedError = new Error('the team relay host is gone');
        if (!authed) reject(new Error('the team relay host refused this answerer'));
        for (const w of this.waiting.values()) w.reject(this.closedError);
        this.waiting.clear();
      });
      lineReader(
        sock,
        (line) => {
          let msg: { auth?: unknown; id?: unknown; result?: unknown; error?: unknown };
          try {
            msg = JSON.parse(line) as typeof msg;
          } catch {
            sock.destroy();
            return;
          }
          if (!authed) {
            if (msg.auth === 'ok') {
              authed = true;
              resolve();
            } else sock.destroy();
            return;
          }
          const w = typeof msg.id === 'number' ? this.waiting.get(msg.id) : undefined;
          if (!w) return;
          this.waiting.delete(msg.id as number);
          if (typeof msg.error === 'string') w.reject(new Error(msg.error));
          else w.resolve(msg.result);
        },
        () => sock.destroy(),
      );
      sock.on('connect', () => sock.write(`${JSON.stringify({ auth: token })}\n`));
      this.sock = sock;
    });
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (this.closedError || !this.sock) return Promise.reject(this.closedError ?? new Error('not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.sock!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close(): void {
    this.sock?.destroy();
  }
}
