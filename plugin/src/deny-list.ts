// The credential deny list (M2-SPEC §4.2, §7.5; M5-SPEC §6), for the automatic answerer
// (M8-SPEC §1, §2). bin/answerer carries the same two lists in its launcher script;
// test/deny-list.test.ts checks the two copies are identical, so there is one list.
//
// Claude Code consults path rules for Read only (it applies them to Glob and Grep), so every
// rule is a Read rule. Deny rules beat any allow rule and any approval.

import { realpathSync } from 'node:fs';
import { normalize } from 'node:path';

/** Paths in the home directory, home-anchored. */
export const HOME_PATHS = [
  '~/.ssh/**', '~/.gnupg/**', '~/.aws/**', '~/.config/gcloud/**', '~/.azure/**', '~/.kube/**',
  '~/.docker/**', '~/.netrc', '~/.npmrc', '~/.pypirc', '~/.git-credentials', '~/.claude/**',
  '~/.claude-team-relay/**', '~/.config/team-relay/**', '~/Library/Keychains/**',
  '~/.config/gh/**', '~/.zsh_history', '~/.bash_history', '~/.*_history',
  '~/Library/Application Support/**/Cookies*', '~/Library/Application Support/Firefox/**',
  '~/Library/Application Support/Google/Chrome/**', '~/.terraform.d/**', '~/.cargo/credentials*',
  '~/.vault-token', '~/.pgpass', '~/.config/solana/**', '~/.foundry/**', '~/.ethereum/**',
] as const;

/**
 * Files that can be anywhere. A "**\/x" rule resolves from the session's working directory, so
 * each also goes in home-anchored ("~/**\/x") and root-anchored ("//**\/x").
 */
export const ANY_DEPTH = [
  '**/.env', '**/.env.*', '**/.envrc', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*',
  '**/*.p12', '**/*.pfx', '**/*.keystore', '**/*.jks', '**/credentials.json', '**/*.tfvars',
  '**/keystore/**', '**/.npmrc', '**/.netrc', '**/.pypirc', '**/.git-credentials', '**/id_ecdsa*',
  '**/id_dsa*', '**/*.ppk', '**/*.tfstate', '**/*.tfstate.*', '**/.aws/**', '**/.kube/**',
] as const;

/** A literal path escaped, so a glob character in it matches only itself. */
export function escapeGlob(p: string): string {
  return p.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`);
}

/** An absolute path as a root-anchored rule path ("//abs"). */
export function anchored(p: string): string {
  return `/${escapeGlob(p)}`;
}

/** The deny rules for a session: the lists, then `extraPaths` (absolute: each file or `dir/**`). */
export function readDenyRules(extraRulePaths: readonly string[] = []): string[] {
  const out: string[] = [...HOME_PATHS];
  for (const p of ANY_DEPTH) out.push(p, `~/${p}`, `//${p}`);
  out.push('~/.claude.json', ...extraRulePaths);
  return out.map((p) => `Read(${p})`);
}

/** A deny-list glob (gitignore style) as a full-match RegExp over a relative path. */
export function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function within(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

export function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return normalize(p);
  }
}

export type DenyContext = {
  home: string;
  /** CLOUDSDK_CONFIG when it is absolute. */
  cloudsdkConfig?: string | undefined;
  /** The team relay's own credential directories (absolute). */
  credentialDirs?: readonly string[];
};

/** The deny-list entry an absolute path is inside (or is), if any: the launcher's rule, ported. */
export function credentialHit(p: string, ctx: DenyContext): string | null {
  const homes = [...new Set([normalize(ctx.home), realOr(ctx.home)])];
  for (const rule of HOME_PATHS) {
    const re = globRe(rule.slice(2).replace(/\/\*\*$/, ''));
    for (const h of homes) {
      if (p === h || !within(p, h)) continue;
      const parts = p.slice(h.length).split('/').filter(Boolean);
      for (let k = 1; k <= parts.length; k++) if (re.test(parts.slice(0, k).join('/'))) return rule;
    }
  }
  for (const rule of ANY_DEPTH) {
    const re = globRe(rule.replace(/^\*\*\//, '').replace(/\/\*\*$/, ''));
    if (p.split('/').some((part) => part !== '' && re.test(part))) return rule;
  }
  if (ctx.cloudsdkConfig && ctx.cloudsdkConfig.startsWith('/') && within(p, realOr(ctx.cloudsdkConfig))) return 'CLOUDSDK_CONFIG';
  for (const d of ctx.credentialDirs ?? []) {
    if (within(p, d) || within(p, realOr(d))) return `${d}/**`;
  }
  return null;
}
