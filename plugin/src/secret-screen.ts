// The deterministic secret screen (M8-SPEC §3): a draft answer that looks like it carries a
// secret waits for the member's approval instead of being sent on its own. It flags private
// keys, provider tokens and API keys (known prefixes, and long high-entropy strings),
// `.env`-style KEY=value pairs whose key names a secret, and connection strings with a
// password. It errs towards flagging: a false positive costs the member one decision, a false
// negative leaks. The reasons it returns name the kind of secret only, never the text.

export type SecretFinding = { kind: string };

/** Known token shapes, by prefix. Each has enough fixed structure not to match prose. */
const PREFIXED: Array<{ kind: string; re: RegExp }> = [
  { kind: 'a private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'a PGP private key', re: /-----BEGIN PGP PRIVATE KEY BLOCK-----/ },
  { kind: 'an AWS access key id', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/ },
  { kind: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/ },
  { kind: 'a GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'a Slack token', re: /\bxox[abprsoe]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'a Slack webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/ },
  { kind: 'an Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'an OpenAI-style API key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'a Stripe key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { kind: 'a Stripe webhook secret', re: /\bwhsec_[A-Za-z0-9]{24,}\b/ },
  { kind: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'a Google OAuth token', re: /\bya29\.[0-9A-Za-z_-]{20,}/ },
  { kind: 'a Google OAuth client secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { kind: 'a Google service account key', re: /"private_key_id"\s*:\s*"[0-9a-f]{20,}"/ },
  { kind: 'an npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: 'a PyPI token', re: /\bpypi-[A-Za-z0-9_-]{50,}/ },
  { kind: 'a SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { kind: 'a Twilio key', re: /\bSK[0-9a-fA-F]{32}\b/ },
  { kind: 'a Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { kind: 'a DigitalOcean token', re: /\bdo[oprs]_v1_[a-f0-9]{64}\b/ },
  { kind: 'a Shopify token', re: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/ },
  { kind: 'an Azure storage key', re: /AccountKey=[A-Za-z0-9+/=]{40,}/ },
  { kind: 'a team relay credential', re: /\btrc_[A-Za-z0-9_-]{43}\b/ },
  { kind: 'a JSON web token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: 'a basic-auth header', re: /\bAuthorization:\s*(?:Basic|Bearer)\s+[A-Za-z0-9+/=._-]{12,}/i },
];

/**
 * KEY=value, key: value and "key": "value" where the key names a secret (PASSWORD, SECRET,
 * TOKEN, API_KEY, ACCESS_KEY, PRIVATE_KEY, CREDENTIAL, CLIENT_SECRET, AUTH_KEY, SIGNING_KEY,
 * ENCRYPTION_KEY, SESSION_KEY, DSN, CONNECTION_STRING, in any case, inside a longer name too).
 * Group 1 is the key, group 2 the value.
 */
const ASSIGNMENT =
  /(?:^|[\s"'{,;])["']?([A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|CLIENT[_-]?SECRET|AUTH[_-]?KEY|SIGNING[_-]?KEY|ENCRYPTION[_-]?KEY|SESSION[_-]?KEY|DSN|CONN(?:ECTION)?[_-]?STRING)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([^\s"',;}]+)/gim;

/** Values that are not secrets: placeholders and references. */
function placeholder(value: string): boolean {
  const v = value.trim().replace(/^["']|["']$/g, '');
  if (v.length < 6) return true;
  if (/^(?:x+|\*+|\.+|-+|_+|<[^>]*>|\{\{.*\}\}|\$\{[^}]*\}?|\$[A-Z_][A-Z0-9_]*|%[A-Z_]+%|null|none|nil|true|false|undefined|changeme|change_me|your[_-]?\w*|example\w*|placeholder|redacted|\[redacted\]|todo|tbd|secret|password|token)$/i.test(v)) {
    return true;
  }
  // A reference to where the secret comes from, not the secret itself.
  if (/^(?:process\.env|os\.environ|env\.|secrets\.|vault:|projects\/[^/]+\/secrets\/)/i.test(v)) return true;
  return false;
}

/** Connection strings with a password: scheme://user:password@host. */
const CONNECTION = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,128}:([^\s@/]{1,256})@[^\s/]{1,255}/gi;

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Long runs of token characters that look random: at least 32 characters, mixing letters and
 * digits (and both cases), with high entropy. Pure hex (commit ids, checksums) and ordinary
 * identifiers are left alone; a hex value next to a secret-like key is caught above.
 */
const CANDIDATE = /[A-Za-z0-9+/_=-]{32,}/g;
function highEntropy(text: string): boolean {
  for (const m of text.matchAll(CANDIDATE)) {
    const s = m[0].replace(/=+$/, '');
    if (s.length < 32) continue;
    if (/^[0-9a-f]+$/i.test(s)) continue;
    if (!/[0-9]/.test(s) || !/[a-z]/.test(s) || !/[A-Z]/.test(s)) continue;
    // Paths and dotted identifiers are prose, not tokens.
    if ((s.match(/\//g) ?? []).length > 2) continue;
    if (entropy(s) >= 4.3) return true;
  }
  return false;
}

/** What in `text` looks like a secret (empty: nothing). */
export function screenSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  const add = (kind: string) => {
    if (!found.some((f) => f.kind === kind)) found.push({ kind });
  };
  for (const { kind, re } of PREFIXED) if (re.test(text)) add(kind);
  for (const m of text.matchAll(ASSIGNMENT)) {
    if (!placeholder(m[2] ?? '')) add('a secret-looking KEY=value pair');
  }
  for (const m of text.matchAll(CONNECTION)) {
    if (!placeholder(m[1] ?? '')) add('a connection string with a password');
  }
  if (highEntropy(text)) add('a long random-looking token');
  return found;
}

/** The screen over a draft: its text and its structured data. */
export function screenDraft(text: string, data: unknown): SecretFinding[] {
  const parts = [text];
  if (data !== undefined && data !== null) parts.push(JSON.stringify(data));
  return screenSecrets(parts.join('\n'));
}
