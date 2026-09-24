#!/usr/bin/env node
// A stand-in for `gcloud auth print-identity-token`, copied into a temp directory as `gcloud`
// and put first on PATH by the tests. It mints a synthetic, unsigned JWT-shaped token.
//
//   FAKE_GCLOUD_STATE   directory: calls.jsonl (argv per call), tokens.txt (every token minted)
//   FAKE_GCLOUD_TTL     seconds until the token's exp (default 3600)
//   FAKE_GCLOUD_FAIL    "1": print an error (with a token-shaped string in it) and exit 1
//   FAKE_GCLOUD_SLEEP   ms to wait before answering

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const state = process.env.FAKE_GCLOUD_STATE;
const argv = process.argv.slice(2);
if (state) appendFileSync(join(state, 'calls.jsonl'), `${JSON.stringify(argv)}\n`);

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');

setTimeout(() => {
  if (argv[0] !== 'auth' || argv[1] !== 'print-identity-token') {
    process.stderr.write('fake gcloud: unexpected arguments\n');
    process.exit(2);
  }
  if (process.env.FAKE_GCLOUD_FAIL === '1') {
    process.stderr.write(
      'ERROR: (gcloud.auth.print-identity-token) Reauthentication failed. cached eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4eHh4eHgifQ.c2lnbmF0dXJlLXZhbHVl\n',
    );
    process.exit(1);
  }
  let n = 1;
  try {
    n = readFileSync(join(state, 'tokens.txt'), 'utf8').split('\n').filter(Boolean).length + 1;
  } catch {
    n = 1;
  }
  const ttl = Number(process.env.FAKE_GCLOUD_TTL ?? '3600');
  const account = argv.find((a) => a.startsWith('--account='))?.slice('--account='.length) ?? 'active@example.com';
  const now = Math.floor(Date.now() / 1000);
  const token = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: 'https://accounts.google.com',
    aud: '32555940559.apps.googleusercontent.com',
    email: account,
    email_verified: true,
    iat: now,
    exp: now + ttl,
    n,
  })}.${Buffer.from(`fake-signature-${n}-${Math.random()}`).toString('base64url')}`;
  if (state) appendFileSync(join(state, 'tokens.txt'), `${token}\n`);
  process.stdout.write(`${token}\n`);
}, Number(process.env.FAKE_GCLOUD_SLEEP ?? '0'));
