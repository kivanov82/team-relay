// M8-SPEC §1: the scope folder rules, and the one credential deny list (the host's copy in
// src/deny-list.ts is the launcher's, entry for entry).

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANY_DEPTH, HOME_PATHS, credentialHit, readDenyRules } from '../src/deny-list.js';
import { scopeFolder, shareName } from '../src/scope.js';
import { PLUGIN_ROOT } from './helpers/mcp.js';

function fakeHome() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-scope-')));
  const home = join(root, 'home', 'u');
  mkdirSync(home, { recursive: true });
  return { root, home, env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config') } as NodeJS.ProcessEnv };
}

describe('scope folder (M8-SPEC §1)', () => {
  it('an ordinary project folder qualifies and is shared by its name', () => {
    const { home, env } = fakeHome();
    const proj = join(home, 'src', 'my app');
    mkdirSync(join(proj, '.git'), { recursive: true });
    const s = scopeFolder(proj, env);
    expect(s).toEqual({ path: proj, qualifies: true, reason: null, share: 'my_app' });
  });

  describe('M8-SPEC §7 item 3: only a folder inside a git work tree, away from home\'s own folders', () => {
    it('a sub-folder of a repository qualifies; a linked work tree\'s .git file counts', () => {
      const { home, env } = fakeHome();
      const repo = join(home, 'code', 'api');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, 'src', 'handlers'), { recursive: true });
      expect(scopeFolder(join(repo, 'src', 'handlers'), env)).toMatchObject({ qualifies: true, share: 'handlers' });
      const wt = join(home, 'code', 'api-wt');
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'api-wt')}\n`);
      expect(scopeFolder(wt, env).qualifies).toBe(true);
    });

    it('a folder in no repository does not qualify', () => {
      const { home, env } = fakeHome();
      const d = join(home, 'Downloads', 'stuff');
      mkdirSync(d, { recursive: true });
      expect(scopeFolder(d, env)).toMatchObject({ qualifies: false, share: null });
      expect(scopeFolder(d, env).reason).toMatch(/^it is not inside a git work tree/);
    });

    it("$HOME's own repository (dotfiles) does not make every folder in it qualify", () => {
      const { home, env } = fakeHome();
      mkdirSync(join(home, '.git'));
      const d = join(home, 'notes', 'misc');
      mkdirSync(d, { recursive: true });
      expect(scopeFolder(d, env).reason).toMatch(/^it is not inside a git work tree/);
    });

    it('a repository above $HOME does not count either', () => {
      const { root, home, env } = fakeHome();
      mkdirSync(join(root, '.git'));
      const d = join(home, 'code', 'x');
      mkdirSync(d, { recursive: true });
      expect(scopeFolder(d, env).qualifies).toBe(false);
    });

    it('a repository outside $HOME qualifies (a .git in it or above it, never at /)', () => {
      const { root, env } = fakeHome();
      const repo = join(root, 'srv', 'repo');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, 'pkg'));
      expect(scopeFolder(join(repo, 'pkg'), env).qualifies).toBe(true);
      const bare = join(root, 'srv', 'loose');
      mkdirSync(bare);
      expect(scopeFolder(bare, env).qualifies).toBe(false);
    });

    it('refuses a direct child of $HOME, even a repository', () => {
      const { home, env } = fakeHome();
      const d = join(home, 'project');
      mkdirSync(join(d, '.git'), { recursive: true });
      expect(scopeFolder(d, env)).toMatchObject({ qualifies: false, reason: 'it is a folder directly in your home directory' });
    });

    it('refuses anything under ~/Library or a ~/.* folder, even a repository', () => {
      const { home, env } = fakeHome();
      for (const sub of ['Library/Mobile Documents/proj', '.local/share/proj', '.cache/x/proj', '.dotfiles/nvim']) {
        const d = join(home, sub);
        mkdirSync(join(d, '.git'), { recursive: true });
        const s = scopeFolder(d, env);
        expect(s.qualifies, sub).toBe(false);
        expect(s.reason, sub).toMatch(/^it is inside ~\/(Library|\.\w+)$/);
      }
    });

    it('resolves symlinks both ways: a link into ~/.x, and a folder that holds where ~/.x points', () => {
      const { root, home, env } = fakeHome();
      // A project reached by a link but living under ~/.local.
      const hidden = join(home, '.local', 'code', 'proj');
      mkdirSync(join(hidden, '.git'), { recursive: true });
      mkdirSync(join(home, 'code'));
      symlinkSync(hidden, join(home, 'code', 'proj-link'));
      expect(scopeFolder(join(home, 'code', 'proj-link'), env).reason).toBe('it is inside ~/.local');
      // ~/.aws is a link to a folder inside a repository elsewhere: that repository contains it.
      const repo = join(root, 'work', 'infra');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, 'aws-config'));
      symlinkSync(join(repo, 'aws-config'), join(home, '.aws'));
      expect(scopeFolder(repo, env)).toMatchObject({ qualifies: false, reason: 'it contains ~/.aws' });
      // ~/Library the same way.
      const repo2 = join(root, 'work', 'lib');
      mkdirSync(join(repo2, '.git'), { recursive: true });
      mkdirSync(join(repo2, 'Library'));
      symlinkSync(join(repo2, 'Library'), join(home, 'Library'));
      expect(scopeFolder(repo2, env).reason).toBe('it contains ~/Library');
    });
  });

  it('resolves symlinks: the folder is where the link points', () => {
    const { root, home, env } = fakeHome();
    const real = join(root, 'work', 'api');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(home, 'api-link'));
    expect(scopeFolder(join(home, 'api-link'), env).path).toBe(real);
  });

  it('refuses /, $HOME and any ancestor of $HOME', () => {
    const { root, home, env } = fakeHome();
    expect(scopeFolder('/', env)).toMatchObject({ qualifies: false, reason: 'it is the root directory', share: null });
    expect(scopeFolder(home, env)).toMatchObject({ qualifies: false, reason: 'it is your home directory' });
    expect(scopeFolder(join(root, 'home'), env)).toMatchObject({ qualifies: false, reason: 'it contains your home directory' });
    expect(scopeFolder(root, env)).toMatchObject({ qualifies: false, reason: 'it contains your home directory' });
  });

  it('refuses folders inside the credential deny list', () => {
    const { home, env } = fakeHome();
    for (const sub of ['.ssh', '.aws/sso', '.config/gcloud', '.kube', 'Library/Keychains']) {
      const d = join(home, sub);
      mkdirSync(d, { recursive: true });
      expect(scopeFolder(d, env).qualifies, sub).toBe(false);
      expect(scopeFolder(d, env).reason, sub).toMatch(/credential location on the deny list|configuration directory/);
    }
    const ks = join(home, 'proj', 'keystore', 'x');
    mkdirSync(ks, { recursive: true });
    expect(scopeFolder(ks, env).reason).toContain('**/keystore/**');
  });

  it('refuses the team relay and Claude Code config directories', () => {
    const { root, home, env } = fakeHome();
    for (const sub of ['.claude/projects', '.claude-team-relay/answerer', '.config/team-relay']) {
      const d = join(home, sub);
      mkdirSync(d, { recursive: true });
      expect(scopeFolder(d, env), sub).toMatchObject({ qualifies: false });
    }
    const cfg = join(root, 'claude-cfg', 'x');
    mkdirSync(cfg, { recursive: true });
    expect(scopeFolder(cfg, { ...env, CLAUDE_CONFIG_DIR: join(root, 'claude-cfg') }).reason).toMatch(/configuration directory/);
    const cred = join(root, 'creds', 'x');
    mkdirSync(cred, { recursive: true });
    expect(scopeFolder(cred, { ...env, RELAY_CREDENTIALS_FILE: join(root, 'creds', 'credentials.json') }).qualifies).toBe(false);
  });

  it('a folder that does not exist does not qualify', () => {
    const { home, env } = fakeHome();
    expect(scopeFolder(join(home, 'gone'), env)).toMatchObject({ qualifies: false, reason: 'it does not exist' });
  });

  it('share names use the manifest alphabet', () => {
    expect(shareName('/a/b/Hello World!')).toBe('Hello_World_');
    expect(shareName('/a/' + 'x'.repeat(80))).toHaveLength(64);
  });
});

describe('the deny list', () => {
  it('is the launcher\'s list, entry for entry', () => {
    const script = readFileSync(join(PLUGIN_ROOT, 'bin', 'answerer'), 'utf8');
    const block = (name: string) => {
      const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(script);
      return [...(m?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    };
    expect([...HOME_PATHS]).toEqual(block('HOME_PATHS'));
    expect([...ANY_DEPTH]).toEqual(block('ANY_DEPTH'));
  });

  it('builds Read rules: home paths, any-depth three ways, ~/.claude.json, then extras', () => {
    const rules = readDenyRules(['//x/y/**']);
    expect(rules[0]).toBe('Read(~/.ssh/**)');
    expect(rules).toContain('Read(**/.env)');
    expect(rules).toContain('Read(~/**/.env)');
    expect(rules).toContain('Read(//**/.env)');
    expect(rules.at(-2)).toBe('Read(~/.claude.json)');
    expect(rules.at(-1)).toBe('Read(//x/y/**)');
  });

  it('credentialHit matches like the launcher', () => {
    const ctx = { home: '/home/u' };
    expect(credentialHit('/home/u/.ssh/id_ed25519', ctx)).toBe('~/.ssh/**');
    expect(credentialHit('/work/app/.env', ctx)).toBe('**/.env');
    expect(credentialHit('/work/app/.env.production', ctx)).toBe('**/.env.*');
    expect(credentialHit('/work/app/server.pem', ctx)).toBe('**/*.pem');
    expect(credentialHit('/work/app/src/index.ts', ctx)).toBeNull();
    expect(credentialHit('/home/u/.zsh_history', ctx)).toBe('~/.zsh_history');
    expect(credentialHit('/x/creds/credentials.json', ctx)).toBe('**/credentials.json');
    expect(credentialHit('/x/relay/f', { ...ctx, credentialDirs: ['/x/relay'] })).toBe('/x/relay/**');
  });

  it('M8-SPEC §7 item 2: credential files and folders are denied at any depth, not only in home', () => {
    const ctx = { home: '/home/u' };
    const cases: Array<[string, string]> = [
      ['/work/app/.npmrc', '**/.npmrc'],
      ['/work/app/.netrc', '**/.netrc'],
      ['/work/app/sub/.pypirc', '**/.pypirc'],
      ['/work/app/.git-credentials', '**/.git-credentials'],
      ['/work/app/keys/id_ecdsa', '**/id_ecdsa*'],
      ['/work/app/keys/id_ecdsa.pub', '**/id_ecdsa*'],
      ['/work/app/keys/id_dsa', '**/id_dsa*'],
      ['/work/app/putty.ppk', '**/*.ppk'],
      ['/work/infra/terraform.tfstate', '**/*.tfstate'],
      ['/work/infra/terraform.tfstate.backup', '**/*.tfstate.*'],
      ['/work/app/.aws/credentials', '**/.aws/**'],
      ['/work/app/.aws', '**/.aws/**'],
      ['/work/app/deploy/.kube/config', '**/.kube/**'],
    ];
    for (const [path, rule] of cases) expect(credentialHit(path, ctx), path).toBe(rule);
    // Rules for Claude Code: each any-depth entry three ways.
    const rules = readDenyRules();
    for (const r of ['**/.npmrc', '**/*.tfstate', '**/.aws/**', '**/.kube/**', '**/id_dsa*', '**/*.ppk']) {
      expect(rules).toContain(`Read(${r})`);
      expect(rules).toContain(`Read(~/${r})`);
      expect(rules).toContain(`Read(//${r})`);
    }
    // Look-alikes that are not credential files stay readable.
    for (const path of ['/work/app/npmrc.md', '/work/app/tfstate.md', '/work/app/aws/config.ts', '/work/app/kube.yaml']) {
      expect(credentialHit(path, ctx), path).toBeNull();
    }
  });
});
