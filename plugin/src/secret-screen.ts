// The deterministic secret screen (M8-SPEC §3, §7 item 1): a draft answer that looks like it
// carries a secret waits for the member's approval instead of being sent on its own. It flags
// private keys and key bodies, provider tokens and API keys (known prefixes, long high-entropy
// strings, hex strings of 32+ characters, padded base64), `.env`-style KEY=value pairs whose
// key names a secret (pass, pwd and pw included), prose that states one ("the password is
// X"), and URLs with credentials in any form (user:password@, :password@, a token as the
// user, a secret-named query parameter). It errs towards flagging: a false positive costs the
// member one decision, a false negative leaks. The reasons it returns name the kind of secret
// only, never the text.
//
// The text is looked at in several forms, so a secret cannot slip through by its spelling:
// Unicode-normalised with invisible characters removed and look-alike letters folded to
// Latin; with a token split across lines joined up again; with a spaced-out run ("s k - a n
// t") closed up; and, for the prefixed token shapes only, with every space removed.

export type SecretFinding = { kind: string };

/** Known token shapes, by prefix. Each has enough fixed structure not to match prose. */
const PREFIXED: Array<{ kind: string; re: RegExp }> = [
  { kind: 'a private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'a PGP private key', re: /-----BEGIN PGP PRIVATE KEY BLOCK-----/ },
  { kind: 'a key or certificate body', re: /\bMI[IGH][A-Za-z0-9+/]{40,}/ },
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

// -- the forms the text is looked at in -------------------------------------------------------

/** Invisible and direction-control characters: removed before anything is matched. */
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

/** Cyrillic and Greek letters that look like Latin ones (escaped, so the source shows which), folded to them. */
const CONFUSABLES: Record<string, string> = {
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M', '\u041D': 'H',
  '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0423': 'Y',
  '\u0405': 'S', '\u0406': 'I', '\u0408': 'J', '\u0500': 'd', '\u0430': 'a', '\u0432': 'b',
  '\u0435': 'e', '\u043A': 'k', '\u043C': 'm', '\u043D': 'h', '\u043E': 'o', '\u0440': 'p',
  '\u0441': 'c', '\u0442': 't', '\u0445': 'x', '\u0443': 'y', '\u0455': 's', '\u0456': 'i',
  '\u0458': 'j', '\u04BB': 'h', '\u0501': 'd', '\u051B': 'q', '\u051D': 'w', '\u04CF': 'l',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I',
  '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T',
  '\u03A5': 'Y', '\u03A7': 'X', '\u03BF': 'o', '\u03BD': 'v', '\u03B1': 'a', '\u03B9': 'i',
  '\u03BA': 'k', '\u03C1': 'p', '\u03C4': 't', '\u03C5': 'u', '\u03C7': 'x',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'gu');

/** NFKC (full-width letters and the like), invisible characters removed, look-alikes folded. */
export function normalise(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c);
}

/** A token at the end of a line joined to a token at the start of the next one. */
function joinLines(text: string): string {
  // Lookarounds of fixed length only: a long run of token characters costs one pass, not n².
  return text.replace(/(?<=[A-Za-z0-9+/_=.-]{4})[ \t]*\r?\n[ \t>*-]*(?=[A-Za-z0-9+/_=-]{4})/g, '');
}

/** Runs of eight or more single characters separated by single spaces, closed up. */
function closeUp(text: string): string {
  return text.replace(/(?:\S[ \t\u00A0]){7,}\S/g, (run) => run.replace(/[ \t\u00A0]/g, ''));
}

// -- KEY=value -----------------------------------------------------------------------------

/** Key names that are secrets wherever they appear inside a longer name. */
const SECRET_KEY_SUBSTRING =
  /PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|CLIENT[_-]?SECRET|AUTH[_-]?KEY|SIGNING[_-]?KEY|ENCRYPTION[_-]?KEY|SESSION[_-]?KEY|DSN|CONN(?:ECTION)?[_-]?STRING/;
/** Key names that are secrets as a whole word of the name (db_pass, DB_PWD, pw, userPass). */
const SECRET_KEY_WORDS = new Set(['pass', 'pwd', 'pw', 'passwd', 'passcode', 'passphrase', 'creds', 'pat']);

export function isSecretKey(key: string): boolean {
  const k = normalise(key);
  if (SECRET_KEY_SUBSTRING.test(k.toUpperCase())) return true;
  const words = k
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.:-]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  return words.some((w) => SECRET_KEY_WORDS.has(w));
}

/** KEY=value, key: value, key := value, key => value and "key": "value". Group 1 the key, 2 the value. */
const ASSIGNMENT = /(?:^|[\s"'`{,;(])["'`]?([A-Za-z_][A-Za-z0-9_.-]{0,79})["'`]?\s*(?::=|=>|=|:)\s*["'`]?([^\s"'`,;}]+)/gm;

/** Values that are not secrets: placeholders and references. */
function placeholder(value: string, minLength = 6): boolean {
  const v = value.trim().replace(/^["'`]|["'`]$/g, '');
  if (v.length < minLength) return true;
  if (/^(?:x+|\*+|•+|\.+|-+|_+|<[^>]*>|\{\{.*\}\}|\$\{[^}]*\}?|\$[A-Z_][A-Z0-9_]*|%[A-Z_]+%|null|none|nil|true|false|undefined|changeme|change_me|your[_-]?\w*|example\w*|placeholder|redacted|\[redacted\]|todo|tbd|secret|password|token)$/i.test(v)) {
    return true;
  }
  // A reference to where the secret comes from, not the secret itself.
  if (/^(?:process\.env|os\.environ|env\.|secrets\.|vault:|projects\/[^/]+\/secrets\/)/i.test(v)) return true;
  return false;
}

// -- prose ---------------------------------------------------------------------------------

/**
 * "the password is X", "the db secret was X", "the token for staging is X". Group 1 the
 * word, group 2 whether the value is quoted, group 3 the value.
 */
const PROSE =
  /\b(passwords?|passphrase|passcode|passwd|pwd|pass|pin|secret|token|(?:api|access|secret|private|signing)[ _-]?key|key)\b(?:\s+(?:for|of|to|on|in|at)(?:\s+[^\s.,;:!?]{1,40}){1,3}?)?\s+(?:is|was|=|would be|will be|should be|reads|equals|is set to|was set to)\s*:?\s*(["'`“”‘’]?)([^\s"'`“”‘’]{1,256})/gi;

/** Words that follow "the password is" in prose about a password, rather than the password. */
const PROSE_WORDS = new Set(
  (
    'a an the not no now also still only just then this that these those it its your our my his her their what whatever which ' +
    'stored kept saved held set reset changed rotated managed required needed used missing wrong invalid expired correct same ' +
    'different located encrypted hashed salted sent provided generated defined configured found empty blank shown visible hidden ' +
    'secure private public available unavailable being from at on in under via inside outside there here too very rotated ' +
    'important optional mandatory case-sensitive sensitive unknown unset known given shared read loaded fetched pulled injected ' +
    'passed checked verified validated refreshed renewed revoked issued signed short long weak strong random different'
  ).split(' '),
);

function proseSecret(word: string, quoted: boolean, rawValue: string): boolean {
  const value = rawValue.replace(/[.,;:!?)\]]+$/, '');
  if (value === '' || PROSE_WORDS.has(value.toLowerCase())) return false;
  if (placeholder(value, 4)) return false;
  const w = word.toLowerCase();
  const passwordLike = /^(?:passwords?|passphrase|passcode|passwd|pwd|pass|pin|secret)$/.test(w);
  if (quoted || passwordLike) return true;
  // "the key is ..." and "the token is ..." are common in prose: only a value that looks like one.
  return value.length >= 8 && (/[0-9]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)) || /[_+/=!@#$%^&*-]/.test(value));
}

// -- URLs ------------------------------------------------------------------------------------

/** A URL's userinfo (whatever sits between "//" and "@" in the authority). Group 1. */
const URL_USERINFO = /(?:\b[a-z][a-z0-9+.-]{0,20}:)?\/\/([^\s/?#@"'<>]{1,256})@[^\s/?#@"'<>]{1,255}/gi;
/** A query or fragment parameter. Group 1 the name, 2 the value. */
const URL_PARAM = /[?&;#]([A-Za-z0-9_.-]{1,64})=([^&#\s"'<>]{1,512})/g;
const SECRET_PARAMS = new Set([
  'key', 'sig', 'signature', 'auth', 'access_token', 'id_token', 'refresh_token', 'client_secret', 'apikey', 'api_key',
  'x-amz-signature', 'x-amz-credential', 'x-amz-security-token', 'x-goog-signature', 'x-goog-credential', 'sas', 'sv', 'code',
]);

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function urlCredentials(text: string): boolean {
  for (const m of text.matchAll(URL_USERINFO)) {
    const info = m[1] ?? '';
    const colon = info.indexOf(':');
    if (colon >= 0) {
      // user:password or :password (an empty user), percent-encoded or not.
      const password = decode(info.slice(colon + 1));
      if (password !== '' && !placeholder(password, 1)) return true;
    } else {
      // A token as the user (https://<token>@host); a plain user name (git@, deploy@) is not one.
      const user = decode(info);
      if (!placeholder(user, 12) && (user.length >= 20 || (/[0-9]/.test(user) && /[A-Za-z]/.test(user)))) return true;
    }
  }
  for (const m of text.matchAll(URL_PARAM)) {
    const name = (m[1] ?? '').toLowerCase();
    if ((SECRET_PARAMS.has(name) || isSecretKey(name)) && !placeholder(decode(m[2] ?? ''))) return true;
  }
  return false;
}

// -- random-looking strings ----------------------------------------------------------------

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
 * digits (and both cases), with high entropy. Pure hex is the hex rule's; ordinary
 * identifiers are left alone.
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

/** Hex strings of 32 or more characters (keys, signing secrets, and hashes too: it errs towards flagging). */
const HEX = /(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g;
/** Hex written in groups (aa:bb:cc…, 9f86 d081 …) that add up to 32 or more hex characters. */
const HEX_GROUPS = /(?<![0-9A-Za-z])(?:[0-9a-fA-F]{2,8}[ :-]){3,}[0-9a-fA-F]{2,8}(?![0-9A-Za-z])/g;
function hexSecret(text: string): boolean {
  const mixed = (s: string) => /[0-9]/.test(s) && /[a-f]/i.test(s);
  for (const m of text.matchAll(HEX)) if (mixed(m[0])) return true;
  for (const m of text.matchAll(HEX_GROUPS)) {
    const digits = m[0].replace(/[ :-]/g, '');
    if (digits.length >= 32 && mixed(digits)) return true;
  }
  return false;
}

/** Padded base64 (ends in = or ==) of 16 or more characters, mixing letters and digits or cases. */
const BASE64_PADDED = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{14,}={1,2}(?![A-Za-z0-9+/=])/g;
function paddedBase64(text: string): boolean {
  for (const m of text.matchAll(BASE64_PADDED)) {
    const s = m[0];
    if (s.length % 4 !== 0) continue;
    const body = s.replace(/=+$/, '');
    if ((/[0-9]/.test(body) && /[A-Za-z]/.test(body)) || (/[a-z]/.test(body) && /[A-Z]/.test(body))) return true;
  }
  return false;
}

// -- the screen ----------------------------------------------------------------------------

function screenForm(text: string, add: (kind: string) => void): void {
  for (const { kind, re } of PREFIXED) if (re.test(text)) add(kind);
  for (const m of text.matchAll(ASSIGNMENT)) {
    if (isSecretKey(m[1] ?? '') && !placeholder(m[2] ?? '')) add('a secret-looking KEY=value pair');
  }
  for (const m of text.matchAll(PROSE)) {
    if (proseSecret(m[1] ?? '', (m[2] ?? '') !== '', m[3] ?? '')) add('a secret stated in words');
  }
  if (urlCredentials(text)) add('a URL with credentials');
  if (hexSecret(text)) add('a long hex string');
  if (paddedBase64(text)) add('a base64-encoded value');
  if (highEntropy(text)) add('a long random-looking token');
}

/** What in `text` looks like a secret (empty: nothing). */
export function screenSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  const add = (kind: string) => {
    if (!found.some((f) => f.kind === kind)) found.push({ kind });
  };
  const norm = normalise(text);
  const forms = new Set([norm, joinLines(norm), closeUp(norm), closeUp(joinLines(norm))]);
  for (const form of forms) screenForm(form, add);
  // Spaces and line breaks anywhere inside a prefixed token: only the prefixed shapes, whose
  // fixed structure keeps them from matching run-together prose.
  const stripped = norm.replace(/\s+/g, '');
  for (const { kind, re } of PREFIXED) if (re.test(stripped)) add(kind);
  return found;
}

/** The screen over a draft: its text and its structured data. */
export function screenDraft(text: string, data: unknown): SecretFinding[] {
  const parts = [text];
  if (data !== undefined && data !== null) parts.push(JSON.stringify(data));
  return screenSecrets(parts.join('\n'));
}
