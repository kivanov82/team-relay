// Put a fake `gcloud` (test/fixtures/fake-gcloud.mjs) first on a PATH, and read back what it
// was asked and what it minted.

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES } from './mcp.js';

export type FakeGcloud = {
  /** A PATH with the fake first, then the real PATH (for node). */
  PATH: string;
  /** The fake's env: FAKE_GCLOUD_STATE plus PATH. */
  env: Record<string, string>;
  calls(): string[][];
  tokens(): string[];
  /** The member an ID token from this fake identifies, per the email in its payload. */
  memberOf(token: string): string | null;
};

export function fakeGcloud(): FakeGcloud {
  const root = mkdtempSync(join(tmpdir(), 'team-relay-gcloud-'));
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  mkdirSync(bin);
  mkdirSync(state);
  copyFileSync(join(FIXTURES, 'fake-gcloud.mjs'), join(bin, 'gcloud'));
  chmodSync(join(bin, 'gcloud'), 0o755);
  const PATH = `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  const lines = (f: string) => (existsSync(join(state, f)) ? readFileSync(join(state, f), 'utf8').split('\n').filter(Boolean) : []);
  return {
    PATH,
    env: { PATH, FAKE_GCLOUD_STATE: state },
    calls: () => lines('calls.jsonl').map((l) => JSON.parse(l) as string[]),
    tokens: () => lines('tokens.txt'),
    memberOf: (token: string) => {
      if (!lines('tokens.txt').includes(token)) return null;
      const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { email: string };
      const local = payload.email.split('@')[0]!;
      return ['alice', 'bob', 'carol'].includes(local) ? local : null;
    },
  };
}
