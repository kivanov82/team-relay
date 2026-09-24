// M2-SPEC §2, §4.1: the client's Google identity, from `gcloud auth print-identity-token`
// (a fake gcloud first on PATH here): argv only, --account passthrough, cached until 5 minutes
// before exp, one refresh on a 401, and the token never in a log line or an error.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RelayClient,
  RelayError,
  TOKEN_REFRESH_MARGIN_MS,
  checkGcloudAccount,
  configValue,
  credentialsFromEnv,
  gcloudTokenProvider,
  jwtExpiryMs,
  relayClientFromEnv,
} from '../src/relay-client.js';
import { FakeRelay } from './helpers/fake-relay.js';
import { fakeGcloud, type FakeGcloud } from './helpers/fake-gcloud.js';
import { spawnServer, waitFor } from './helpers/mcp.js';

let gcloud: FakeGcloud;
let relay: FakeRelay;

beforeEach(async () => {
  gcloud = fakeGcloud();
  relay = await new FakeRelay().start();
  relay.authorize = (t) => gcloud.memberOf(t);
});
afterEach(async () => {
  await relay.stop();
});

const gEnv = (extra: Record<string, string> = {}) => ({ ...process.env, ...gcloud.env, ...extra });

describe('gcloud ID token provider', () => {
  it('runs gcloud auth print-identity-token with an argv (no --account by default) and returns its token', async () => {
    const provider = gcloudTokenProvider({ env: gEnv() });
    const token = await provider();
    expect(gcloud.calls()).toEqual([['auth', 'print-identity-token']]);
    expect(gcloud.tokens()).toEqual([token]);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('passes --account=<account> when one is set', async () => {
    await gcloudTokenProvider({ env: gEnv(), account: 'bob@example.com' })();
    expect(gcloud.calls()).toEqual([['auth', 'print-identity-token', '--account=bob@example.com']]);
  });

  it('refuses an account that is not an email address before running anything', () => {
    for (const bad of ['--impersonate-service-account=x@y.z', 'bob', 'a b@example.com', 'bob@example.com;rm', '']) {
      expect(() => gcloudTokenProvider({ env: gEnv(), account: bad })).toThrow(/email address/);
      expect(() => checkGcloudAccount(bad)).toThrow();
    }
    expect(gcloud.calls()).toEqual([]);
  });

  it('caches the token until 5 minutes before its exp, then mints a new one', async () => {
    let now = Date.now();
    const provider = gcloudTokenProvider({ env: gEnv(), now: () => now });
    const first = await provider();
    const exp = jwtExpiryMs(first)!;
    expect(exp).toBeGreaterThan(now + 3_500_000);
    expect(await provider()).toBe(first);
    now = exp - TOKEN_REFRESH_MARGIN_MS - 1000;
    expect(await provider()).toBe(first);
    expect(gcloud.calls()).toHaveLength(1);
    now = exp - TOKEN_REFRESH_MARGIN_MS;
    const second = await provider();
    expect(second).not.toBe(first);
    expect(gcloud.calls()).toHaveLength(2);
  });

  it('does not cache a token that expires within the margin', async () => {
    const provider = gcloudTokenProvider({ env: gEnv({ FAKE_GCLOUD_TTL: '120' }) });
    await provider();
    await provider();
    expect(gcloud.calls()).toHaveLength(2);
  });

  it('shares one gcloud run between concurrent requests', async () => {
    const provider = gcloudTokenProvider({ env: gEnv({ FAKE_GCLOUD_SLEEP: '200' }) });
    const tokens = await Promise.all([provider(), provider(), provider()]);
    expect(new Set(tokens).size).toBe(1);
    expect(gcloud.calls()).toHaveLength(1);
  });

  it('invalidate() drops the cache', async () => {
    const provider = gcloudTokenProvider({ env: gEnv() });
    const first = await provider();
    provider.invalidate();
    expect(await provider()).not.toBe(first);
    expect(gcloud.calls()).toHaveLength(2);
  });

  it('reports a gcloud failure without anything token-shaped from its output', async () => {
    const err = (await gcloudTokenProvider({ env: gEnv({ FAKE_GCLOUD_FAIL: '1' }) })().catch((e) => e)) as Error;
    expect(err.message).toMatch(/gcloud auth print-identity-token failed: ERROR: \(gcloud\.auth\.print-identity-token\) Reauthentication failed/);
    expect(err.message).toContain('[redacted]');
    expect(err.message).not.toMatch(/eyJ/);
  });

  it('says clearly when gcloud is not installed', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'team-relay-nogcloud-'));
    const err = (await gcloudTokenProvider({ env: { PATH: empty } })().catch((e) => e)) as Error;
    expect(err.message).toMatch(/gcloud was not found on PATH/);
  });

  it('times out a gcloud that hangs', async () => {
    const err = (await gcloudTokenProvider({ env: gEnv({ FAKE_GCLOUD_SLEEP: '5000' }), timeoutMs: 300 })().catch((e) => e)) as Error;
    expect(err.message).toMatch(/timed out/);
  });
});

describe('RelayClient with the Google identity', () => {
  it('sends the ID token as the bearer and reuses it', async () => {
    const client = new RelayClient({ url: relay.url, team: 'demo', token: credentialsFromEnv(gEnv({ RELAY_GCLOUD_ACCOUNT: 'alice@example.com' })) });
    expect((await client.me()).member).toBe('alice');
    await client.directory();
    expect(gcloud.calls()).toEqual([['auth', 'print-identity-token', '--account=alice@example.com']]);
    const [token] = gcloud.tokens();
    expect(relay.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
  });

  it('refreshes once on a 401 and succeeds with the new token', async () => {
    // The relay rejects the first token it sees (say, revoked), accepts later ones.
    let first: string | null = null;
    relay.authorize = (t) => {
      first ??= t;
      return t === first ? null : gcloud.memberOf(t);
    };
    const sleeps: number[] = [];
    const client = new RelayClient({
      url: relay.url,
      team: 'demo',
      token: credentialsFromEnv(gEnv({ RELAY_GCLOUD_ACCOUNT: 'bob@example.com' })),
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect((await client.me()).member).toBe('bob');
    expect(gcloud.calls()).toHaveLength(2);
    expect(relay.requests).toHaveLength(2);
    expect(sleeps).toEqual([]);
  });

  it('refreshes only once: a second 401 is surfaced without backoff or more gcloud runs', async () => {
    relay.authorize = () => null;
    const sleeps: number[] = [];
    const client = new RelayClient({
      url: relay.url,
      team: 'demo',
      token: credentialsFromEnv(gEnv()),
      sleep: async (ms) => void sleeps.push(ms),
    });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err.status).toBe(401);
    expect(gcloud.calls()).toHaveLength(2);
    expect(relay.requests).toHaveLength(2);
    expect(sleeps).toEqual([]);
    for (const t of gcloud.tokens()) {
      expect(String(err.message)).not.toContain(t);
      expect(JSON.stringify(err)).not.toContain(t);
    }
  });

  it('a static token (RELAY_AUTH=token) is not refreshed on a 401', async () => {
    const client = new RelayClient({ url: relay.url, team: 'demo', token: credentialsFromEnv({ RELAY_AUTH: 'token', RELAY_TOKEN: 'tok-unknown-99' }) });
    await expect(client.me()).rejects.toMatchObject({ status: 401 });
    expect(relay.requests).toHaveLength(1);
  });
});

describe('RELAY_AUTH and the plugin options', () => {
  it('defaults to google, and ignores a token then', async () => {
    const client = relayClientFromEnv(gEnv({ RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_TOKEN: 'tok-alice-0123456789', RELAY_GCLOUD_ACCOUNT: 'carol@example.com' }));
    expect((await client.me()).member).toBe('carol');
    expect(gcloud.calls()).toHaveLength(1);
  });

  it('token mode needs a token; an unknown mode is refused', () => {
    expect(() => credentialsFromEnv({ RELAY_AUTH: 'token' })).toThrow(/RELAY_TOKEN/);
    expect(() => credentialsFromEnv({ RELAY_AUTH: 'basic' })).toThrow(/google" or "token/);
    expect(credentialsFromEnv({ RELAY_AUTH: 'token', RELAY_TOKEN: 't' })()).toBe('t');
  });

  it('treats an unfilled ${user_config.*} placeholder as not set', () => {
    expect(configValue('${user_config.gcloud_account}')).toBeUndefined();
    expect(configValue('  ')).toBeUndefined();
    expect(configValue('x@example.com')).toBe('x@example.com');
    // relay_auth unset in the plugin: google, and no --account from an unfilled gcloud_account.
    expect(() =>
      credentialsFromEnv({ RELAY_AUTH: '${user_config.relay_auth}', RELAY_GCLOUD_ACCOUNT: '${user_config.gcloud_account}' }),
    ).not.toThrow();
    expect(() => credentialsFromEnv({ RELAY_AUTH: 'token', RELAY_TOKEN: '${user_config.relay_token}' })).toThrow(/RELAY_TOKEN/);
  });
});

describe('servers with RELAY_AUTH=google', () => {
  it('the channel server authenticates with the gcloud token and never logs it, also when refused', async () => {
    const env = { ...gcloud.env, RELAY_AUTH: 'google', RELAY_GCLOUD_ACCOUNT: 'alice@example.com', RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_ROLE: 'asker' };
    const s = await spawnServer('channel.js', env);
    try {
      await waitFor(() => relay.requests.some((r) => r.path.endsWith('/streams/replies')), 10_000, 'a stream poll');
      const res = await s.client.callTool({ name: 'list_teammates', arguments: {} });
      expect(res.isError).toBeFalsy();
      // Now the relay turns the token down: the server logs the 401, never the token.
      relay.authorize = () => null;
      const refused = await s.client.callTool({ name: 'list_teammates', arguments: {} });
      expect(refused.isError).toBe(true);
      await waitFor(() => /401/.test(s.stderr()), 10_000, 'the 401 in the log').catch(() => undefined);
    } finally {
      await s.close();
    }
    const tokens = gcloud.tokens();
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    for (const t of tokens) {
      expect(s.stderr()).not.toContain(t);
      expect(s.stderr()).not.toContain(t.split('.')[1]!);
    }
    for (const call of gcloud.calls()) expect(call).toEqual(['auth', 'print-identity-token', '--account=alice@example.com']);
  });

  it('the capability server uses the same client (and the same identity)', async () => {
    const env = { ...gcloud.env, RELAY_AUTH: 'google', RELAY_GCLOUD_ACCOUNT: 'bob@example.com', RELAY_URL: relay.url, RELAY_TEAM: 'demo' };
    const s = await spawnServer('capabilities.js', { ...env, CAP_SERVICE_HEALTH_ENABLED: 'true', CAP_SERVICE_HEALTH_RUNNER: join(process.cwd(), 'test', 'fixtures', 'fake-runner.mjs') });
    try {
      const request_id = relay.addRequest({ capability: { name: 'service_health', params: { service: 'api' } } });
      const res = await s.client.callTool({ name: 'service_health', arguments: { service: 'api', request_id } });
      expect(res.isError).toBeFalsy();
    } finally {
      await s.close();
    }
    expect(relay.requests.every((r) => r.member === 'bob')).toBe(true);
    for (const t of gcloud.tokens()) expect(s.stderr()).not.toContain(t);
  });
});
