// M8-SPEC §3: the deterministic secret screen, over a corpus of positives and negatives. The
// secrets below are synthetic: made-up values of the right shape, never real credentials.

import { describe, expect, it } from 'vitest';
import { screenDraft, screenSecrets } from '../src/secret-screen.js';

// Built at run time so no token-shaped literal sits in the source.
const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const mixed = (n: number) => rep('aZ3kQ9xW7mPq2Lr8Tn5Vb1Yc6Hd4Jf0G', n);

const POSITIVES: Array<[string, string]> = [
  ['PEM private key', `here:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow${mixed(40)}\n-----END RSA PRIVATE KEY-----`],
  ['OpenSSH key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE\n-----END OPENSSH PRIVATE KEY-----'],
  ['EC key', '-----BEGIN EC PRIVATE KEY-----'],
  ['PGP key', '-----BEGIN PGP PRIVATE KEY BLOCK-----'],
  ['AWS key id', `the key is AKIA${rep('QWERTYUIOP234567', 16)} ok`],
  ['GitHub classic', `ghp_${mixed(36)}`],
  ['GitHub fine-grained', `github_pat_${mixed(40)}`],
  ['GitLab', `glpat-${mixed(20)}`],
  ['Slack bot', `xoxb-${rep('1234567890-', 30)}`],
  ['Slack webhook', `https://hooks.slack.com/services/T0000/B0000/${mixed(24)}`],
  ['Anthropic', `sk-ant-api03-${mixed(40)}`],
  ['OpenAI', `sk-proj-${mixed(40)}`],
  ['Stripe live', `sk_live_${mixed(24)}`],
  ['Stripe webhook', `whsec_${mixed(32)}`],
  ['Google API key', `AIza${mixed(35)}`],
  ['Google OAuth access token', `ya29.${mixed(40)}`],
  ['Google client secret', `GOCSPX-${mixed(28)}`],
  ['service account JSON', '{"type": "service_account", "private_key_id": "0123456789abcdef0123456789abcdef01234567"}'],
  ['npm', `npm_${mixed(36)}`],
  ['SendGrid', `SG.${mixed(22)}.${mixed(43)}`],
  ['Hugging Face', `hf_${mixed(34)}`],
  ['team relay credential', `trc_${mixed(43)}`],
  ['JWT', `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${mixed(43)}`],
  ['Bearer header', `Authorization: Bearer ${mixed(30)}`],
  ['.env password', 'DB_PASSWORD=hunter2hunter2'],
  ['.env API key', 'STRIPE_API_KEY="abcdef123456"'],
  ['yaml secret', 'client_secret: q8W2e4R6t8Y0'],
  ['json token', '{"access_token": "abc123def456ghi"}'],
  ['connection string', 'postgres://app:S3cretPass@db.internal:5432/app'],
  ['mongodb+srv', 'mongodb+srv://admin:pa55word@cluster0.example.net/test'],
  ['Azure storage', `DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${rep('Ab3+', 88)}==`],
  ['high-entropy token', `use this: ${mixed(48)}`],
];

const NEGATIVES: Array<[string, string]> = [
  ['plain answer', 'The staging bucket lives in europe-west3; the worker retries three times.'],
  ['git sha', 'Fixed in commit 3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c0e2b4d6f8 on main.'],
  ['sha256 checksum', 'sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
  ['uuid', 'request 123e4567-e89b-12d3-a456-426614174000 failed'],
  ['placeholder password', 'Set DB_PASSWORD=<your-password> in .env'],
  ['env reference', 'API_KEY=${API_KEY} is read from the environment'],
  ['masked', 'password: ********'],
  ['short value', 'token: abc'],
  ['secret manager path', 'DB_PASSWORD=projects/demo/secrets/db-password'],
  ['process.env', 'const token = process.env.GITHUB_TOKEN'],
  ['connection without password', 'postgres://app@db.internal:5432/app'],
  ['url', 'See https://example.com/docs/getting-started/installation-and-configuration for details.'],
  ['file path', '/Users/someone/projects/team-relay/plugin/src/answer-host.ts'],
  ['identifier', 'The function answerQuestionAutomaticallyWithinScopeFolder is in answer-host.ts.'],
  ['words about tokens', 'Tokens are refreshed every hour; the max_tokens setting is 1000.'],
  ['sk- prose', 'Ask the sk-team channel about it.'],
];

describe('secret screen (M8-SPEC §3)', () => {
  for (const [name, text] of POSITIVES) {
    it(`flags: ${name}`, () => {
      expect(screenSecrets(text).length, name).toBeGreaterThan(0);
    });
  }
  for (const [name, text] of NEGATIVES) {
    it(`passes: ${name}`, () => {
      expect(screenSecrets(text), name).toEqual([]);
    });
  }

  it('says what kind of secret, never the secret', () => {
    const secret = `sk_live_${mixed(24)}`;
    const found = screenSecrets(`key ${secret}`);
    expect(found.map((f) => f.kind)).toContain('a Stripe key');
    expect(JSON.stringify(found)).not.toContain(secret);
  });

  it('screens the structured data too', () => {
    expect(screenDraft('Here is the result.', { rows: [{ note: `ghp_${mixed(36)}` }] }).length).toBeGreaterThan(0);
    expect(screenDraft('Here is the result.', { rows: [{ count: 42 }] })).toEqual([]);
  });
});
