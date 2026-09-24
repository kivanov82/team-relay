// M5-SPEC §2 (steps 1 and 6), §3 and §6: the login tool's flow against a fake relay (the
// browser stubbed), the credential file (modes, ownership, atomic writes), the RELAY_AUTH
// default, and the relay client with a device credential.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CredentialFileError,
  credentialsPath,
  normaliseRelayUrl,
  parseStoredCredential,
  readCredential,
  removeCredential,
  writeCredential,
  type StoredCredential,
} from '../src/credentials.js';
import { LOGIN_TIMEOUT_MS, codeChallenge, deviceLabel, startLogin, DEVICE_RE } from '../src/login.js';
import {
  NotConnected,
  RelayClient,
  RelayError,
  SIGN_IN_AGAIN,
  authModeFromEnv,
  connectionFromEnv,
  relayClientFromEnv,
} from '../src/relay-client.js';
import { defaultRelayUrl } from '../src/relay-default.js';
import { FakeRelay } from './helpers/fake-relay.js';
import { PLUGIN_ROOT } from './helpers/mcp.js';

let relay: FakeRelay;
let dir: string;

beforeEach(async () => {
  relay = await new FakeRelay().start();
  dir = mkdtempSync(join(tmpdir(), 'team-relay-login-'));
});
afterEach(async () => {
  await relay.stop();
});

const CRED = `trc_${'A'.repeat(43)}`;
const credFile = () => join(dir, 'config', 'team-relay', 'credentials.json');
const sample = (over: Partial<StoredCredential> = {}): StoredCredential => ({
  relay_url: relay.url,
  team: 'demo',
  member: 'alice',
  credential: CRED,
  expires_at: '2026-12-24T00:00:00Z',
  ...over,
});
const mode = (p: string) => lstatSync(p).mode & 0o777;

/** Follow the sign-in URL the way the relay's pages would send a browser (the fake approves at once). */
async function browse(url: string): Promise<number> {
  const res = await fetch(url, { redirect: 'follow' });
  await res.text();
  return res.status;
}

describe('credential file (M5-SPEC §6)', () => {
  it('lives in $XDG_CONFIG_HOME/team-relay (absolute only), else ~/.config/team-relay, unless RELAY_CREDENTIALS_FILE names it', () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/home/a' })).toBe('/x/cfg/team-relay/credentials.json');
    expect(credentialsPath({ XDG_CONFIG_HOME: 'relative/cfg', HOME: '/home/a' })).toBe('/home/a/.config/team-relay/credentials.json');
    expect(credentialsPath({ HOME: '/home/a' })).toBe('/home/a/.config/team-relay/credentials.json');
    expect(credentialsPath({ HOME: '/home/a', RELAY_CREDENTIALS_FILE: '/elsewhere/c.json' })).toBe('/elsewhere/c.json');
    expect(() => credentialsPath({ RELAY_CREDENTIALS_FILE: 'c.json' })).toThrow(CredentialFileError);
  });

  it('writes the directory 700 and the file 600, atomically, leaving no temp file', () => {
    writeCredential(credFile(), sample());
    expect(mode(join(dir, 'config', 'team-relay'))).toBe(0o700);
    expect(mode(credFile())).toBe(0o600);
    expect(readdirSync(join(dir, 'config', 'team-relay'))).toEqual(['credentials.json']);
    expect(readCredential(credFile())).toEqual(sample({ relay_url: normaliseRelayUrl(relay.url) }));
    // A second write replaces it whole.
    writeCredential(credFile(), sample({ member: 'bob' }));
    expect(readCredential(credFile())?.member).toBe('bob');
    expect(readdirSync(join(dir, 'config', 'team-relay'))).toEqual(['credentials.json']);
  });

  it('is absent when there is no file, and removed by logout', () => {
    expect(readCredential(credFile())).toBeNull();
    writeCredential(credFile(), sample());
    expect(removeCredential(credFile())).toBe(true);
    expect(readCredential(credFile())).toBeNull();
    expect(removeCredential(credFile())).toBe(false);
  });

  it('refuses a file readable by others, a directory open to others, and a symlink, and says why without the secret', () => {
    writeCredential(credFile(), sample());
    chmodSync(credFile(), 0o644);
    expect(() => readCredential(credFile())).toThrow(/mode 644.*refusing to use it/);
    chmodSync(credFile(), 0o600);
    chmodSync(join(dir, 'config', 'team-relay'), 0o755);
    expect(() => readCredential(credFile())).toThrow(/credential directory has mode 755/);
    chmodSync(join(dir, 'config', 'team-relay'), 0o700);
    expect(readCredential(credFile())).not.toBeNull();

    const other = join(dir, 'other.json');
    writeFileSync(other, readFileSync(credFile()), { mode: 0o600 });
    const link = join(dir, 'config', 'team-relay', 'link.json');
    symlinkSync(other, link);
    expect(() => readCredential(link)).toThrow(/symbolic link/);
    try {
      readCredential(link);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(CRED);
    }
    // Writing refuses an unusable directory instead of loosening or reusing it.
    chmodSync(join(dir, 'config', 'team-relay'), 0o777);
    expect(() => writeCredential(credFile(), sample())).toThrow(/refusing/);
  });

  it('checks every field', () => {
    for (const bad of [
      { credential: 'trc_short' },
      { credential: 'tok-something' },
      { team: 'Demo' },
      { member: '1bob' },
      { relay_url: 'http://relay.example.com' },
      { relay_url: 'https://user:pw@relay.example.com' },
      { expires_at: 'tomorrow' },
    ]) {
      expect(() => parseStoredCredential({ ...sample(), ...bad }), JSON.stringify(bad)).toThrow(CredentialFileError);
    }
    mkdirSync(join(dir, 'config', 'team-relay'), { recursive: true, mode: 0o700 });
    writeFileSync(credFile(), 'not json', { mode: 0o600 });
    expect(() => readCredential(credFile())).toThrow(/not valid JSON/);
  });
});

describe('RELAY_AUTH default (M5-SPEC §6)', () => {
  const env = (extra: Record<string, string> = {}) => ({ HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), ...extra });

  it('is the credential file when present, else google; an explicit RELAY_AUTH wins', () => {
    expect(authModeFromEnv(env())).toBe('google');
    writeCredential(credFile(), sample());
    expect(authModeFromEnv(env())).toBe('credential');
    expect(authModeFromEnv(env({ RELAY_AUTH: 'google' }))).toBe('google');
    expect(authModeFromEnv(env({ RELAY_AUTH: 'token' }))).toBe('token');
    expect(() => authModeFromEnv(env({ RELAY_AUTH: 'basic' }))).toThrow(/RELAY_AUTH must be/);
  });

  it('takes relay and team from the credential; RELAY_URL and RELAY_TEAM must agree with it', () => {
    writeCredential(credFile(), sample());
    const c = connectionFromEnv(env());
    expect(c).toMatchObject({ mode: 'credential', url: normaliseRelayUrl(relay.url), team: 'demo', member: 'alice' });
    expect(connectionFromEnv(env({ RELAY_URL: `${relay.url}/`, RELAY_TEAM: 'demo' })).mode).toBe('credential');
    expect(() => connectionFromEnv(env({ RELAY_URL: 'https://other.example.com' }))).toThrow(/not the relay you signed in to/);
    expect(() => connectionFromEnv(env({ RELAY_TEAM: 'other' }))).toThrow(/not the team you signed in to/);
  });

  it('is not connected with neither a credential nor a team; google defaults the relay URL', () => {
    expect(() => connectionFromEnv(env())).toThrow(NotConnected);
    expect(() => connectionFromEnv(env({ RELAY_AUTH: 'google' }))).toThrow(/RELAY_TEAM must be set/);
    const c = connectionFromEnv(env({ RELAY_TEAM: 'demo' }));
    expect(c.mode).toBe('google');
    expect(c.url).toBe(defaultRelayUrl());
  });

  it('the default relay URL lives in exactly one file, plugin/relay.default.json', () => {
    const raw = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'relay.default.json'), 'utf8'));
    expect(Object.keys(raw)).toEqual(['relay_url']);
    expect(raw.relay_url).toMatch(/^https:\/\/[a-z0-9.-]+\.run\.app$/);
    expect(defaultRelayUrl()).toBe(raw.relay_url);
    // Read at run time: no bundle carries a copy.
    for (const f of readdirSync(join(PLUGIN_ROOT, 'dist')).filter((n) => n.endsWith('.js'))) {
      expect(readFileSync(join(PLUGIN_ROOT, 'dist', f), 'utf8'), f).not.toContain(raw.relay_url);
    }
  });

  it('the client sends Bearer trc_…; a 401 tells the member to log in again, with no retry loop', async () => {
    const token = relay.mintCredential('alice');
    writeCredential(credFile(), sample({ credential: token }));
    const client = relayClientFromEnv(env());
    expect((await client.me()).member).toBe('alice');
    expect(relay.requests.at(-1)!.headers.authorization).toBe(`Bearer ${token}`);

    relay.credentials.delete(token);
    const before = relay.requests.length;
    const err = await client.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).status).toBe(401);
    expect((err as RelayError).detail).toBe(SIGN_IN_AGAIN);
    expect((err as Error).message).toMatch(/run \/team-relay:login again/);
    expect((err as Error).message).not.toContain(token);
    expect(relay.requests.length - before).toBe(1);
  });

  it('never sends the credential to another relay: a login elsewhere since start is refused', async () => {
    const token = relay.mintCredential('alice');
    writeCredential(credFile(), sample({ credential: token }));
    const client = relayClientFromEnv(env());
    writeCredential(credFile(), sample({ credential: token, relay_url: 'https://elsewhere.example.com' }));
    const before = relay.requests.length;
    await expect(client.me()).rejects.toThrow(/signed in to another relay or team/);
    expect(relay.requests.length).toBe(before);
  });
});

describe('login flow (M5-SPEC §2 steps 1 and 6)', () => {
  it('PKCE: a 64-character verifier, its S256 challenge; a device label in the allowed alphabet', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(deviceLabel('mbp.local')).toBe('Claude Code on mbp');
    expect(deviceLabel('we!rd host*name')).toMatch(DEVICE_RE);
    expect(deviceLabel('x'.repeat(200)).length).toBeLessThanOrEqual(64);
    expect(LOGIN_TIMEOUT_MS).toBe(300_000);
  });

  it('opens the browser at /v1/login/start with the listener on 127.0.0.1, exchanges the code and stores the credential', async () => {
    const opened: string[] = [];
    const flow = await startLogin({ relayUrl: relay.url, credentialsFile: credFile(), open: (u) => opened.push(u) });
    expect(opened).toEqual([flow.url]);
    const u = new URL(flow.url);
    expect(`${u.origin}${u.pathname}`).toBe(`${relay.url}/v1/login/start`);
    expect(u.searchParams.get('port')).toBe(String(flow.port));
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('device')).toMatch(DEVICE_RE);

    // Not reachable on any address but 127.0.0.1.
    await expect(
      new Promise((resolve, reject) => {
        const s = connect({ host: '::1', port: flow.port }, () => {
          s.destroy();
          resolve('connected');
        });
        s.on('error', reject);
      }),
    ).rejects.toThrow();

    expect(await browse(flow.url)).toBe(200);
    const stored = await flow.done;
    expect(stored).toMatchObject({ team: 'demo', member: 'alice', relay_url: normaliseRelayUrl(relay.url) });
    expect(stored.credential).toMatch(/^trc_[A-Za-z0-9_-]{43}$/);
    expect(readCredential(credFile())).toEqual(stored);
    expect(mode(credFile())).toBe(0o600);
    // The token exchange carried the verifier whose S256 is the challenge.
    const tokenCall = relay.requests.find((r) => r.path === '/v1/login/token')!;
    const body = tokenCall.body as { code: string; code_verifier: string };
    expect(Object.keys(body).sort()).toEqual(['code', 'code_verifier']);
    expect(codeChallenge(body.code_verifier)).toBe(u.searchParams.get('code_challenge'));
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // The listener is gone.
    await expect(fetch(`http://127.0.0.1:${flow.port}/callback`)).rejects.toThrow();
  });

  it('refuses a callback whose state does not match, and stores nothing', async () => {
    const flow = await startLogin({ relayUrl: relay.url, credentialsFile: credFile(), open: () => {} });
    const res = await fetch(`http://127.0.0.1:${flow.port}/callback?code=${'c'.repeat(43)}&state=${'x'.repeat(43)}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/does not belong to the sign-in/);
    await expect(flow.done).rejects.toThrow(/state mismatch/);
    expect(existsSync(credFile())).toBe(false);
    expect(relay.requests.some((r) => r.path === '/v1/login/token')).toBe(false);
  });

  it('answers exactly one request: after it, even the right callback gets nowhere', async () => {
    const flow = await startLogin({ relayUrl: relay.url, credentialsFile: credFile(), open: () => {} });
    const state = new URL(flow.url).searchParams.get('state')!;
    const first = await fetch(`http://127.0.0.1:${flow.port}/favicon.ico`);
    expect(first.status).toBe(400);
    await expect(flow.done).rejects.toThrow();
    const second = await fetch(`http://127.0.0.1:${flow.port}/callback?code=${'c'.repeat(43)}&state=${state}`).then(
      (r) => r.status,
      () => 'refused',
    );
    expect(second).not.toBe(200);
    expect(existsSync(credFile())).toBe(false);
  });

  it('refuses a callback under another Host name', async () => {
    const flow = await startLogin({ relayUrl: relay.url, credentialsFile: credFile(), open: () => {} });
    const state = new URL(flow.url).searchParams.get('state')!;
    const status = await new Promise<number>((resolve, reject) => {
      const s = connect({ host: '127.0.0.1', port: flow.port }, () => {
        s.write(`GET /callback?code=${'c'.repeat(43)}&state=${state} HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      s.on('data', (c) => (data += c.toString()));
      s.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1])));
      s.on('error', reject);
    });
    expect(status).toBe(400);
    await expect(flow.done).rejects.toThrow(/unexpected Host/);
  });

  it('times out, and the listener closes', async () => {
    const flow = await startLogin({ relayUrl: relay.url, credentialsFile: credFile(), open: () => {}, timeoutMs: 150 });
    await expect(flow.done).rejects.toThrow(/timed out/);
    await expect(fetch(`http://127.0.0.1:${flow.port}/callback`)).rejects.toThrow();
  });

  it('a refused exchange (wrong or reused code) stores nothing and says to log in again', async () => {
    relay.loginRefusal = { status: 400, error: 'invalid_grant' };
    const flow = await startLogin({ relayUrl: relay.url, credentialsFile: credFile(), open: () => {} });
    await browse(flow.url);
    await expect(flow.done).rejects.toThrow(/refused the sign-in \(400 invalid_grant\).*\/team-relay:login again/);
    expect(existsSync(credFile())).toBe(false);
  });

  it('stops waiting when the member cancels on the chooser (error=access_denied), and stores nothing', async () => {
    relay.loginCancel = true;
    const flow = await startLogin({ relayUrl: relay.url, credentialsFile: credFile(), open: () => {} });
    expect(await browse(flow.url)).toBe(200);
    await expect(flow.done).rejects.toThrow(/sign-in cancelled/);
    expect(existsSync(credFile())).toBe(false);
    expect(relay.requests.some((r) => r.path === '/v1/login/token')).toBe(false);
  });

  it('a cancel with the wrong state is a state mismatch, not a cancel', async () => {
    const flow = await startLogin({ relayUrl: relay.url, credentialsFile: credFile(), open: () => {} });
    const res = await fetch(`http://127.0.0.1:${flow.port}/callback?error=access_denied&state=${'x'.repeat(43)}`);
    expect(res.status).toBe(400);
    await expect(flow.done).rejects.toThrow(/state mismatch/);
  });

  it('refuses an answer that names another relay', async () => {
    relay.loginRelayUrl = 'https://evil.example.com';
    const flow = await startLogin({ relayUrl: relay.url, credentialsFile: credFile(), open: () => {} });
    await browse(flow.url);
    await expect(flow.done).rejects.toThrow(/different relay URL/);
    expect(existsSync(credFile())).toBe(false);
  });

  it('refuses a relay URL that is not https (plain http only to localhost)', async () => {
    await expect(startLogin({ relayUrl: 'http://relay.example.com', credentialsFile: credFile(), open: () => {} })).rejects.toThrow(/https/);
  });
});

describe('the default opener: the URL is never in a process argument (M2-SPEC §7.7)', () => {
  it('hands the opener a private redirect file, and the browser gets the URL from it', async () => {
    const logFile = join(dir, 'browser.log');
    const opener = join(PLUGIN_ROOT, 'test', 'fixtures', 'fake-browser.mjs');
    process.env.TEAM_RELAY_OPEN_COMMAND = opener;
    process.env.FAKE_BROWSER_LOG = logFile;
    try {
      const flow = await startLogin({ relayUrl: relay.url, credentialsFile: credFile() });
      await flow.done;
      const entry = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n')[0]!) as { argv: string[]; url: string; done: boolean };
      expect(entry.url).toBe(flow.url);
      expect(entry.done).toBe(true);
      expect(entry.argv).toHaveLength(1);
      expect(entry.argv[0]).toMatch(/team-relay-console-.+\/console\.html$/);
      expect(entry.argv.join(' ')).not.toContain(new URL(flow.url).searchParams.get('state')!);
    } finally {
      delete process.env.TEAM_RELAY_OPEN_COMMAND;
      delete process.env.FAKE_BROWSER_LOG;
    }
  });
});
