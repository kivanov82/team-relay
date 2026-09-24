// The scope folder (M8-SPEC §1): the working session's folder, which its automatic answerer
// may read without asking. It is the channel server's working directory, resolved. It must
// not be /, $HOME or an ancestor of $HOME, nor inside the credential deny list or the team
// relay's or Claude Code's config directories; if it is, the host still answers but with no
// automatic folder access (every read needs the member's approval) and shares no folder.

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { configDir } from './answering-lock.js';
import { credentialsPath } from './credentials.js';
import { credentialHit, realOr, within } from './deny-list.js';

export type Scope = {
  /** The resolved folder. */
  path: string;
  /** Whether reads inside it are automatic. */
  qualifies: boolean;
  /** Why it does not qualify (null when it does). */
  reason: string | null;
  /** The name published as a share (M4-SPEC §3), only when it qualifies. */
  share: string | null;
};

/** The team relay's own credential directories: its config dir and wherever the credential file is. */
export function relayCredentialDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs = [configDir(env)];
  try {
    dirs.push(dirname(credentialsPath(env)));
  } catch {
    // a relative RELAY_CREDENTIALS_FILE is refused where it is used
  }
  return [...new Set(dirs)];
}

/** The share name for a folder: its basename in the manifest's share-name alphabet. */
export function shareName(path: string): string {
  return basename(path).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'folder';
}

export function scopeFolder(cwd: string, env: NodeJS.ProcessEnv): Scope {
  const path = realOr(cwd);
  const refuse = (reason: string): Scope => ({ path, qualifies: false, reason, share: null });
  if (!isAbsolute(path)) return refuse('it is not an absolute path');
  try {
    if (!statSync(path).isDirectory()) return refuse('it is not a directory');
  } catch {
    return refuse('it does not exist');
  }
  const home = env.HOME?.trim() || homedir();
  const homeReal = realOr(home);
  if (path === '/') return refuse('it is the root directory');
  if (path === homeReal || normalize(cwd) === normalize(home)) return refuse('it is your home directory');
  if (within(homeReal, path) || within(normalize(home), path)) return refuse('it contains your home directory');
  const configDirs = [join(homeReal, '.claude'), join(homeReal, '.claude-team-relay'), ...relayCredentialDirs(env).map(realOr)];
  const claudeConfig = env.CLAUDE_CONFIG_DIR?.trim();
  if (claudeConfig && isAbsolute(claudeConfig)) configDirs.push(realOr(claudeConfig));
  for (const d of configDirs) {
    if (within(path, d)) return refuse(`it is inside a configuration directory (${d})`);
  }
  const cloudsdk = env.CLOUDSDK_CONFIG?.trim();
  const hit = credentialHit(path, {
    home,
    cloudsdkConfig: cloudsdk && isAbsolute(cloudsdk) ? cloudsdk : undefined,
    credentialDirs: relayCredentialDirs(env),
  });
  if (hit) return refuse(`it is inside a credential location on the deny list (${hit})`);
  return { path, qualifies: true, reason: null, share: shareName(path) };
}
