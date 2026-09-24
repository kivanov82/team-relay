// GET /api/join: what the console's join panel shows a new member. Answered by the console
// server itself (never proxied), behind the same gate as the other /api routes (the key
// locally; IAP hosted, in console-hosted.test.ts), with demo values under --demo and
// JOIN_REPO_URL checked at startup.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEMO_JOIN,
  checkJoinRepoUrl,
  createConsoleServer,
  demoBackend,
  joinInfo,
  relayBackend,
  type ConsoleServer,
} from '../src/console-app.js';
import { DemoTeam } from '../src/console-demo.js';
import { RelayClient } from '../src/relay-client.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { DIST } from './helpers/mcp.js';

const KEY = 'j'.repeat(43);
const NO_UI = join(tmpdir(), 'team-relay-no-such-console');

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any };

function req(port: number, path: string, opts: { method?: string; key?: string | null; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    if (opts.key) headers['X-Console-Key'] = opts.key;
    const r = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, setHost: false, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    r.on('error', reject);
    r.end();
  });
}

const EXPECTED_KEYS = ['marketplace', 'plugin', 'relay_url', 'repo_url', 'team'];

describe('/api/join on the local console server', () => {
  let app: ConsoleServer;
  let port: number;
  let relay: FakeRelay;

  beforeEach(async () => {
    relay = await new FakeRelay().start();
    const client = new RelayClient({ url: relay.url, team: 'demo', token: () => TOKEN_OF.alice!, attempts: 1 });
    app = createConsoleServer({
      backend: relayBackend(client),
      key: KEY,
      staticDir: NO_UI,
      join: joinInfo('https://relay.team.example', 'demo', 'https://github.com/example/multiagent.git'),
    });
    port = await app.listen(0);
  });
  afterEach(async () => {
    await app.close();
    await relay.stop();
  });

  it('needs the key: missing is 401, wrong is 403, and neither says anything else', async () => {
    const missing = await req(port, '/api/join');
    expect(missing.status).toBe(401);
    expect(missing.json()).toEqual({ error: 'unauthenticated', detail: 'X-Console-Key is required' });
    const wrong = await req(port, '/api/join', { key: 'x'.repeat(43) });
    expect(wrong.status).toBe(403);
    expect(wrong.body).not.toContain('relay.team.example');
    expect(missing.body).not.toContain('relay.team.example');
    expect((await req(port, '/api/join', { key: KEY, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  });

  it('answers the configured values with the key, and never asks the relay', async () => {
    const r = await req(port, '/api/join', { key: KEY });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-security-policy']).toMatch(/^default-src 'self'; /);
    for (const h of Object.keys(r.headers)) expect(h).not.toMatch(/^access-control-/);
    expect(r.json()).toEqual({
      relay_url: 'https://relay.team.example',
      team: 'demo',
      repo_url: 'https://github.com/example/multiagent.git',
      marketplace: 'team-relay-dev',
      plugin: 'team-relay',
    });
    expect(Object.keys(r.json()).sort()).toEqual(EXPECTED_KEYS);
    expect(relay.requests).toHaveLength(0);
  });

  it('is GET only, takes no query, and is not a prefix for anything else', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
      const r = await req(port, '/api/join', { key: KEY, method });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe('GET');
    }
    expect((await req(port, '/api/join?repo_url=https://evil.example', { key: KEY })).status).toBe(400);
    for (const path of ['/api/join/', '/api/join/x', '/api/joins']) {
      expect((await req(port, path, { key: KEY })).status, path).toBe(404);
    }
    expect(relay.requests).toHaveLength(0);
  });

  it('is 404 on a server that was given no join details', async () => {
    const bare = createConsoleServer({ backend: demoBackend(new DemoTeam()), key: KEY, staticDir: NO_UI });
    const p = await bare.listen(0);
    try {
      expect((await req(p, '/api/join', { key: KEY })).status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

describe('JOIN_REPO_URL', () => {
  it('accepts a plain https URL, and unset or empty as null', () => {
    expect(checkJoinRepoUrl(undefined)).toBeNull();
    expect(checkJoinRepoUrl('')).toBeNull();
    expect(checkJoinRepoUrl('   ')).toBeNull();
    for (const ok of [
      'https://github.com/example/multiagent.git',
      'https://github.com/example/multiagent',
      'https://gitlab.example.com:8443/team/relay_repo-2.git',
      'https://git.example.com/',
      'https://source.developers.google.com/p/proj/r/team~relay',
    ]) {
      expect(checkJoinRepoUrl(ok), ok).toBe(ok);
    }
    expect(checkJoinRepoUrl('  https://github.com/example/multiagent.git\n')).toBe('https://github.com/example/multiagent.git');
  });

  it('refuses anything else', () => {
    for (const bad of [
      'http://github.com/example/multiagent.git',
      'git@github.com:example/multiagent.git',
      'ssh://git@github.com/example/multiagent.git',
      'file:///srv/multiagent',
      'github.com/example/multiagent',
      'https://user:secret@github.com/example/multiagent.git',
      'https://token@github.com/example/multiagent.git',
      'https://github.com/example/multiagent.git?ref=main',
      'https://github.com/example/multiagent.git#main',
      'https://github.com/example/multi agent.git',
      'https://github.com/example/$(touch x).git',
      'https://github.com/example/a;b',
      'https://github.com/example/`id`',
      "https://github.com/example/it's",
      'https://github.com/example/../other',
      'https://github.com//double',
      'https://',
      'https://' + 'a'.repeat(600) + '.example/x',
    ]) {
      expect(() => checkJoinRepoUrl(bad), bad).toThrow(/JOIN_REPO_URL/);
    }
  });

  it('never echoes a credential in its error', () => {
    try {
      checkJoinRepoUrl('https://user:hunter2@github.com/example/multiagent.git');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
    }
  });
});

describe('dist/console-server.js: /api/join', () => {
  function start(args: string[], env: Record<string, string> = {}) {
    const child = spawn(process.execPath, [join(DIST, 'console-server.js'), ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', CONSOLE_PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const exited = new Promise<number | null>((r) => child.on('close', r));
    return { child, out: () => stdout, err: () => stderr, exited };
  }

  async function launched(p: ReturnType<typeof start>): Promise<{ port: number; key: string }> {
    const deadline = Date.now() + 10_000;
    while (!p.out().includes('\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/#k=([A-Za-z0-9_-]{43})$/.exec(p.out().trim());
    expect(m, p.out() + p.err()).not.toBeNull();
    return { port: Number(m![1]), key: m![2]! };
  }

  it('--demo answers the demo values, even with JOIN_REPO_URL set', async () => {
    const p = start(['--demo'], { JOIN_REPO_URL: 'https://github.com/example/multiagent.git', RELAY_URL: 'https://real-relay.example', RELAY_TEAM: 'demo' });
    try {
      const { port, key } = await launched(p);
      expect((await req(port, '/api/join')).status).toBe(401);
      const r = await req(port, '/api/join', { key });
      expect(r.status).toBe(200);
      expect(r.json()).toEqual({ relay_url: 'https://relay.example.com', team: 'demo', repo_url: null, marketplace: 'team-relay-dev', plugin: 'team-relay' });
      expect(r.json()).toEqual(DEMO_JOIN);
    } finally {
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
    }
  });

  it('answers RELAY_URL, RELAY_TEAM and JOIN_REPO_URL from the environment', async () => {
    const env = {
      RELAY_URL: 'http://127.0.0.1:9',
      RELAY_TEAM: 'acme',
      RELAY_AUTH: 'token',
      RELAY_TOKEN: 'tok-for-a-relay-that-is-not-there',
      JOIN_REPO_URL: 'https://github.com/example/multiagent.git',
    };
    const p = start([], env);
    try {
      const { port, key } = await launched(p);
      const r = await req(port, '/api/join', { key });
      expect(r.status).toBe(200);
      expect(r.json()).toEqual({
        relay_url: 'http://127.0.0.1:9',
        team: 'acme',
        repo_url: 'https://github.com/example/multiagent.git',
        marketplace: 'team-relay-dev',
        plugin: 'team-relay',
      });
      expect(r.body).not.toContain(env.RELAY_TOKEN);
    } finally {
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
    }
  });

  it('answers repo_url null when JOIN_REPO_URL is unset', async () => {
    const p = start([], { RELAY_URL: 'http://127.0.0.1:9', RELAY_TEAM: 'demo', RELAY_AUTH: 'token', RELAY_TOKEN: 't' });
    try {
      const { port, key } = await launched(p);
      expect((await req(port, '/api/join', { key })).json().repo_url).toBeNull();
    } finally {
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
    }
  });

  it('refuses to start with a JOIN_REPO_URL that is not a plain https URL, --demo included', async () => {
    for (const [args, env] of [
      [['--demo'], { JOIN_REPO_URL: 'http://github.com/example/multiagent.git' }],
      [['--demo'], { JOIN_REPO_URL: 'https://user:hunter2@github.com/example/multiagent.git' }],
      [[], { RELAY_URL: 'http://127.0.0.1:9', RELAY_TEAM: 'demo', RELAY_AUTH: 'token', RELAY_TOKEN: 't', JOIN_REPO_URL: 'git@github.com:example/multiagent.git' }],
    ] as Array<[string[], Record<string, string>]>) {
      const p = start(args, env);
      expect(await p.exited, JSON.stringify(env)).toBe(1);
      expect(p.err()).toMatch(/configuration error: JOIN_REPO_URL/);
      expect(p.err()).not.toContain('hunter2');
      expect(p.out()).toBe('');
    }
  });
});
