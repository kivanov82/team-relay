// The member's own device credential (M5-SPEC §3, §6): what /team-relay:login stores and
// every part of the plugin (the channel, the capability server, the tool-event hook, the
// answering session and the local console) reads by default.
//
//   $XDG_CONFIG_HOME/team-relay/credentials.json   (XDG_CONFIG_HOME absolute, else ~/.config)
//   {relay_url, team, member, credential, expires_at}
//
// The directory is mode 700 and the file mode 600, both owned by the current user; a file
// or directory with wider permissions, owned by someone else, or reached through a symlink
// is refused, never used and never "fixed". Writes are atomic (a private temp file in the
// same directory, fsync, rename). RELAY_CREDENTIALS_FILE (an absolute path) names the file
// directly; bin/answerer sets it for the servers it starts. The credential itself never
// appears in an error, a log line or a tool result.

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { MEMBER_RE, TEAM_RE, parseRelayUrl } from './relay-client-core.js';

export const CREDENTIAL_RE = /^trc_[A-Za-z0-9_-]{43}$/;
export const CREDENTIALS_DIR = 'team-relay';
export const CREDENTIALS_FILE = 'credentials.json';
const MAX_FILE_BYTES = 16 * 1024;

export type StoredCredential = {
  relay_url: string;
  team: string;
  member: string;
  credential: string;
  expires_at: string | null;
};

/** Something is wrong with the credential file: it is not used. The message names no secret. */
export class CredentialFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialFileError';
  }
}

/** Where the credential file lives for this environment. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.RELAY_CREDENTIALS_FILE?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new CredentialFileError('RELAY_CREDENTIALS_FILE must be an absolute path');
    return explicit;
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  // The XDG base directory spec: a relative XDG_CONFIG_HOME is invalid and ignored.
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), '.config');
  return join(base, CREDENTIALS_DIR, CREDENTIALS_FILE);
}

/** The directory the credential file lives in (for deny lists). */
export function credentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(credentialsPath(env));
}

function uid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function checkOwnedPrivate(st: Stats, what: string, kind: 'file' | 'directory'): void {
  if (st.isSymbolicLink()) throw new CredentialFileError(`${what} is a symbolic link; refusing to use it`);
  if (kind === 'file' ? !st.isFile() : !st.isDirectory()) throw new CredentialFileError(`${what} is not a ${kind}; refusing to use it`);
  const me = uid();
  if (me !== null && st.uid !== me) throw new CredentialFileError(`${what} is owned by another user; refusing to use it`);
  if ((st.mode & 0o077) !== 0) {
    const mode = (st.mode & 0o777).toString(8).padStart(3, '0');
    throw new CredentialFileError(
      `${what} has mode ${mode}, readable or writable by others; refusing to use it (run /team-relay:logout and /team-relay:login again, or chmod ${kind === 'file' ? '600' : '700'} it)`,
    );
  }
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** A relay URL in one canonical form, for comparing: origin plus path without a trailing slash. */
export function normaliseRelayUrl(raw: string): string {
  const url = parseRelayUrl(raw);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** The file's content, checked field by field. */
export function parseStoredCredential(raw: unknown): StoredCredential {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new CredentialFileError('the credential file is not a JSON object');
  const c = raw as Record<string, unknown>;
  const { relay_url, team, member, credential, expires_at } = c;
  if (typeof relay_url !== 'string') throw new CredentialFileError('the credential file has no relay_url');
  let url: string;
  try {
    url = normaliseRelayUrl(relay_url);
  } catch {
    throw new CredentialFileError('the credential file has an invalid relay_url');
  }
  if (typeof team !== 'string' || !TEAM_RE.test(team)) throw new CredentialFileError('the credential file has an invalid team');
  if (typeof member !== 'string' || !MEMBER_RE.test(member)) throw new CredentialFileError('the credential file has an invalid member');
  if (typeof credential !== 'string' || !CREDENTIAL_RE.test(credential)) throw new CredentialFileError('the credential file has an invalid credential');
  if (expires_at !== undefined && expires_at !== null && (typeof expires_at !== 'string' || !RFC3339.test(expires_at))) {
    throw new CredentialFileError('the credential file has an invalid expires_at');
  }
  return { relay_url: url, team, member, credential, expires_at: typeof expires_at === 'string' ? expires_at : null };
}

/**
 * The stored credential, or null when there is none. Throws CredentialFileError when a file
 * is there but must not be used (permissions, owner, symlink, content).
 */
export function readCredential(path: string): StoredCredential | null {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw new CredentialFileError(`cannot read the credential file (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  checkOwnedPrivate(lstatSync(dirname(path)), 'the credential directory', 'directory');
  checkOwnedPrivate(st, 'the credential file', 'file');
  if (st.size > MAX_FILE_BYTES) throw new CredentialFileError('the credential file is too large');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CredentialFileError(`cannot read the credential file (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CredentialFileError('the credential file is not valid JSON');
  }
  return parseStoredCredential(json);
}

/** Whether a credential file exists at `path` (whatever its state). */
export function credentialFileExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A cheap fingerprint of the file, to notice a new login or a logout without reading it. */
export function credentialFingerprint(path: string): string | null {
  try {
    const st = lstatSync(path);
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Create (mode 700) or check the credential directory. Refuses one it must not use. */
function ensureDir(dir: string): void {
  let st: Stats | null = null;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new CredentialFileError(`cannot use the credential directory (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (st === null) {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    st = lstatSync(dir);
  }
  checkOwnedPrivate(st, 'the credential directory', 'directory');
}

/** Store `value` atomically, mode 600, in a mode-700 directory. */
export function writeCredential(path: string, value: StoredCredential): void {
  const checked = parseStoredCredential(value);
  const dir = dirname(path);
  ensureDir(dir);
  try {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new CredentialFileError('the credential file is not a regular file; refusing to replace it');
  } catch (err) {
    if (err instanceof CredentialFileError) throw err;
  }
  const tmp = join(dir, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  const body = `${JSON.stringify(checked, null, 2)}\n`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw new CredentialFileError(`cannot write the credential file (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  try {
    const dfd = openSync(dir, 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Not every platform can fsync a directory; the rename is still atomic.
  }
}

/** Remove the stored credential (logout). True when a file was removed. */
export function removeCredential(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new CredentialFileError(`cannot remove the credential file (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}
