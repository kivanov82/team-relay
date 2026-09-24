import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { FIXTURES, PLUGIN_ROOT, textOf } from './helpers/mcp.js';

const ANSWERER = join(PLUGIN_ROOT, 'bin', 'answerer');

/** M2-SPEC §4.2 and §7.5: paths in the home directory, exactly as listed there. */
const HOME_PATHS = [
  '~/.ssh/**', '~/.gnupg/**', '~/.aws/**', '~/.config/gcloud/**', '~/.azure/**', '~/.kube/**', '~/.docker/**',
  '~/.netrc', '~/.npmrc', '~/.pypirc', '~/.git-credentials', '~/.claude/**', '~/.claude-team-relay/**',
  '~/Library/Keychains/**',
  // §7.5
  '~/.config/gh/**', '~/.zsh_history', '~/.bash_history', '~/.*_history',
  '~/Library/Application Support/**/Cookies*', '~/Library/Application Support/Firefox/**',
  '~/Library/Application Support/Google/Chrome/**', '~/.terraform.d/**', '~/.cargo/credentials*',
  '~/.vault-token', '~/.pgpass', '~/.config/solana/**', '~/.foundry/**', '~/.ethereum/**',
];
/** M2-SPEC §4.2 and §7.5: files that can be anywhere. */
const ANY_DEPTH = [
  '**/.env', '**/.env.*', '**/.envrc', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*',
  '**/*.p12', '**/*.pfx', '**/*.keystore', '**/*.jks', '**/credentials.json', '**/*.tfvars', '**/keystore/**',
];

/** The whole deny list the launcher must write, in order. */
function expectedDeny(home: string, tokenFile: string | null, extra: string[] = []): string[] {
  return [
    'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task',
    ...HOME_PATHS.map((p) => `Read(${p})`),
    // As listed (from the empty working directory), home-anchored and root-anchored.
    ...ANY_DEPTH.flatMap((p) => [`Read(${p})`, `Read(~/${p})`, `Read(//${p})`]),
    // The session's own files.
    ...['~/.claude.json', `/${home}/**`].map((p) => `Read(${p})`),
    ...(tokenFile ? [`Read(/${tokenFile})`] : []),
    ...extra.map((p) => `Read(${p})`),
  ];
}
const TOKEN = 'tok-bob-answerer-secret-7';

// Each run gets its own TMPDIR, so the default working directory is a fresh one under it
// and no test touches the real ${TMPDIR}/team-relay-answerer-<uid>.
function runAnswerer(env: Record<string, string>, args: string[] = ['--print-command']) {
  return spawnSync(ANSWERER, args, {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TMPDIR: mkdtempSync(join(tmpdir(), 'team-relay-ans-tmp-')),
      // Static test tokens; the google default has its own tests below.
      RELAY_AUTH: 'token',
      ...env,
    },
    encoding: 'utf8',
  });
}

function setup(extra: Record<string, string> = {}) {
  const home = extra.ANSWERER_HOME ?? join(mkdtempSync(join(tmpdir(), 'team-relay-ans-')), 'home');
  const r = runAnswerer({
    ANSWERER_HOME: home,
    RELAY_URL: 'http://127.0.0.1:8080',
    RELAY_TEAM: 'demo',
    RELAY_TOKEN: TOKEN,
    CAP_STAGING_DB_QUERY_ENABLED: 'true',
    CAP_STAGING_DB_QUERY_RUNNER: '/opt/runners/staging db query',
    ...extra,
  });
  // The script resolves symlinks (macOS tmp is /var -> /private/var).
  return { home: r.status === 0 ? realpathSync(home) : home, r };
}

describe('bin/answerer --print-command', () => {
  it('prints the isolated, strict session command and runs nothing', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-ans-tmp-')));
    const { home, r } = setup({ TMPDIR: `${tmp}/` });
    expect(r.status, r.stderr).toBe(0);
    const cmd = r.stdout.trim();
    expect(cmd.split('\n')).toHaveLength(1);
    expect(cmd.startsWith(`cd ${tmp}/team-relay-answerer-${process.getuid!()}/work &&`)).toBe(true);
    expect(cmd).toContain(`CLAUDE_CONFIG_DIR=${home}/config`);
    expect(cmd).toContain('env -u RELAY_TOKEN');
    expect(cmd).toContain(` claude --mcp-config ${home}/mcp.json --strict-mcp-config --settings ${home}/settings.json`);
    expect(cmd).toContain('--disallowedTools Bash Write Edit NotebookEdit WebFetch WebSearch');
    expect(cmd).toContain('--dangerously-load-development-channels server:relay');
    expect(cmd).not.toContain(TOKEN);
  });

  it('writes mcp.json with both servers, explicit env, and the token only by file', () => {
    const { home } = setup();
    const raw = readFileSync(join(home, 'mcp.json'), 'utf8');
    expect(raw).not.toContain(TOKEN);
    const mcp = JSON.parse(raw);
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['capabilities', 'relay']);
    const { relay, capabilities } = mcp.mcpServers;
    expect(relay.args).toEqual([join(PLUGIN_ROOT, 'dist', 'channel.js')]);
    expect(capabilities.args).toEqual([join(PLUGIN_ROOT, 'dist', 'capabilities.js')]);
    expect(relay.env).toMatchObject({
      RELAY_ROLE: 'answerer',
      RELAY_URL: 'http://127.0.0.1:8080',
      RELAY_TEAM: 'demo',
      RELAY_TOKEN_FILE: join(home, 'token'),
      MANIFEST_PATH: join(PLUGIN_ROOT, 'manifest.yaml'),
      ALLOW_PRODUCTION: 'false',
      CAP_STAGING_DB_QUERY_ENABLED: 'true',
      CAP_STAGING_DB_QUERY_RUNNER: '/opt/runners/staging db query',
    });
    expect(relay.env.RELAY_TOKEN).toBeUndefined();
    expect(capabilities.env.RELAY_TOKEN).toBeUndefined();
    expect(capabilities.env.RELAY_ROLE).toBeUndefined();
    expect(capabilities.env.RELAY_TOKEN_FILE).toBe(join(home, 'token'));
    expect(readFileSync(join(home, 'token'), 'utf8')).toBe(`${TOKEN}\n`);
    expect(statSync(join(home, 'token')).mode & 0o777).toBe(0o600);
  });

  it('uses an existing RELAY_TOKEN_FILE instead of writing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-relay-ans-tok-'));
    const tokenFile = join(dir, 'bob.token');
    writeFileSync(tokenFile, `${TOKEN}\n`);
    const { home, r } = setup({ RELAY_TOKEN: '', RELAY_TOKEN_FILE: tokenFile });
    expect(r.status, r.stderr).toBe(0);
    const mcp = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers.relay.env.RELAY_TOKEN_FILE).toMatch(/bob\.token$/);
    expect(() => statSync(join(home, 'token'))).toThrow();
  });

  it('writes settings.json with exactly the M2 allow and deny lists (reads allowed, credential stores denied)', () => {
    const { home } = setup();
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    expect(settings.permissions.allow).toEqual(['mcp__relay__*', 'mcp__capabilities__*', 'Read', 'Glob', 'Grep']);
    expect(settings.permissions.deny).toEqual(expectedDeny(home, join(home, 'token')));
    // Nothing that writes, runs or reaches the web is allowed anywhere.
    for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task']) {
      expect(settings.permissions.allow).not.toContain(tool);
    }
  });

  it('has no Glob(...) or Grep(...) path rule, and a Read rule for every §7.5 path in every form', () => {
    const { home } = setup();
    const deny: string[] = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).permissions.deny;
    // Claude Code never evaluates them (it applies Read rules to Glob and Grep): §7.5.
    expect(deny.filter((d) => /^(Glob|Grep)\(/.test(d))).toEqual([]);
    for (const p of HOME_PATHS) expect(deny).toContain(`Read(${p})`);
    for (const p of ANY_DEPTH) {
      for (const form of [p, `~/${p}`, `//${p}`]) expect(deny).toContain(`Read(${form})`);
    }
    // Spot checks against the text of §7.5, so a typo in both lists above still fails.
    for (const rule of [
      'Read(~/.config/gh/**)', 'Read(~/.*_history)', 'Read(~/Library/Application Support/**/Cookies*)',
      'Read(~/.cargo/credentials*)', 'Read(//**/.envrc)', 'Read(~/**/credentials.json)', 'Read(//**/keystore/**)',
      'Read(//**/*.tfvars)', 'Read(~/.vault-token)', 'Read(~/.pgpass)', 'Read(~/.foundry/**)',
    ]) {
      expect(deny).toContain(rule);
    }
    // Every rule is a bare tool name or a Read path rule.
    for (const d of deny) expect(d).toMatch(/^(Bash|Write|Edit|NotebookEdit|WebFetch|WebSearch|Agent|Task|Read\(.+\))$/);
    expect(new Set(deny).size).toBe(deny.length);
  });

  it('adds the tool-event hooks in exec form for PostToolUse and PostToolUseFailure, async, and nothing else', () => {
    const { home } = setup();
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    const nodeBin = spawnSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim();
    const hook = {
      type: 'command',
      command: nodeBin,
      args: [join(PLUGIN_ROOT, 'dist', 'tool-event.js'), '--config', join(home, 'tool-event.json')],
      async: true,
      timeout: 5,
    };
    expect(settings.hooks).toEqual({
      PostToolUse: [{ matcher: '*', hooks: [hook] }],
      PostToolUseFailure: [{ matcher: '*', hooks: [hook] }],
    });
    expect(Object.keys(settings).sort()).toEqual(['hooks', 'permissions']);
  });

  it('writes tool-event.json (no secret in it) and a mode-700 state directory the answerer channel records into', () => {
    const { home } = setup();
    const cfg = JSON.parse(readFileSync(join(home, 'tool-event.json'), 'utf8'));
    expect(cfg).toEqual({
      relay_url: 'http://127.0.0.1:8080',
      relay_team: 'demo',
      relay_auth: 'token',
      state_dir: join(home, 'state'),
      token_file: join(home, 'token'),
    });
    expect(readFileSync(join(home, 'tool-event.json'), 'utf8')).not.toContain(TOKEN);
    expect(statSync(join(home, 'tool-event.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'state')).mode & 0o777).toBe(0o700);
    const mcp = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers.relay.env.ANSWERER_STATE_DIR).toBe(join(home, 'state'));
    expect(mcp.mcpServers.capabilities.env.ANSWERER_STATE_DIR).toBeUndefined();
  });

  it('also disallows Agent and Task on the command line', () => {
    const { r } = setup();
    expect(r.stdout).toContain(' --disallowedTools Bash Write Edit NotebookEdit WebFetch WebSearch Agent Task --dangerously-load-development-channels');
  });

  it('escapes glob characters in its own paths when it denies reading them', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-ans-')));
    const odd = join(base, 'a[b]*c?');
    const { r } = setup({ ANSWERER_HOME: odd });
    expect(r.status, r.stderr).toBe(0);
    const deny: string[] = JSON.parse(readFileSync(join(odd, 'settings.json'), 'utf8')).permissions.deny;
    const esc = (p: string) => p.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`);
    expect(deny).toContain(`Read(/${esc(odd)}/**)`);
    expect(deny).toContain(`Read(/${esc(join(odd, 'token'))})`);
    expect(deny.some((d) => d.includes('a[b]'))).toBe(false);
  });

  it('creates the home and config directories with mode 700, the files with 600, and no work/ under home', () => {
    const { home } = setup();
    for (const d of ['', 'config']) expect(statSync(join(home, d)).mode & 0o777).toBe(0o700);
    for (const f of ['mcp.json', 'settings.json']) expect(statSync(join(home, f)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, 'work'))).toBe(false);
  });

  it('passes production opt-in only as the exact string true', () => {
    const { home } = setup({ ALLOW_PRODUCTION: 'yes' });
    expect(JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')).mcpServers.relay.env.ALLOW_PRODUCTION).toBe('false');
    const second = setup({ ALLOW_PRODUCTION: 'true' });
    expect(JSON.parse(readFileSync(join(second.home, 'mcp.json'), 'utf8')).mcpServers.capabilities.env.ALLOW_PRODUCTION).toBe('true');
  });

  it('keeps awkward values intact as JSON (no splicing into JSON text)', () => {
    const { home, r } = setup({ CAP_SERVICE_HEALTH_RUNNER: '/opt/x"y\\z/run', CAP_SERVICE_HEALTH_ENABLED: 'true' });
    expect(r.status, r.stderr).toBe(0);
    const env = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')).mcpServers.capabilities.env;
    expect(env.CAP_SERVICE_HEALTH_RUNNER).toBe('/opt/x"y\\z/run');
  });

  it('passes extra arguments through to claude, quoted', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'team-relay-ans-')), 'home');
    const r = runAnswerer(
      { ANSWERER_HOME: home, RELAY_URL: 'https://relay.example.com', RELAY_TEAM: 'demo', RELAY_TOKEN: TOKEN },
      ['--print-command', '--model', 'a b'],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().endsWith('--model a\\ b')).toBe(true);
  });

  it('fails clearly when required settings are missing', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'team-relay-ans-')), 'home');
    const noUrl = runAnswerer({ ANSWERER_HOME: home, RELAY_TEAM: 'demo', RELAY_TOKEN: TOKEN });
    expect(noUrl.status).not.toBe(0);
    expect(noUrl.stderr).toMatch(/RELAY_URL is required/);
    const noToken = runAnswerer({ ANSWERER_HOME: home, RELAY_URL: 'https://relay.example.com', RELAY_TEAM: 'demo' });
    expect(noToken.status).not.toBe(0);
    expect(noToken.stderr).toMatch(/RELAY_TOKEN/);
    expect(noToken.stderr).not.toContain(TOKEN);
  });

  it('is a bash script with strict mode', () => {
    const text = readFileSync(ANSWERER, 'utf8');
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(text).toContain('set -euo pipefail');
    expect(statSync(ANSWERER).mode & 0o111).not.toBe(0);
  });
});

describe('bin/answerer with RELAY_AUTH=google (M2-SPEC §4.1)', () => {
  function googleSetup(extra: Record<string, string> = {}) {
    return setup({ RELAY_AUTH: '', RELAY_TOKEN: '', ...extra });
  }

  it('is the default, needs no token, and stores none', () => {
    const { home, r } = googleSetup({ RELAY_GCLOUD_ACCOUNT: 'bob@example.com', CLOUDSDK_CONFIG: '/opt/gcloud-config', CLOUDSDK_CORE_PROJECT: 'demo-project' });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(home, 'token'))).toBe(false);
    const mcp = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'));
    for (const name of ['relay', 'capabilities']) {
      const env = mcp.mcpServers[name].env;
      expect(env).toMatchObject({
        RELAY_AUTH: 'google',
        RELAY_GCLOUD_ACCOUNT: 'bob@example.com',
        CLOUDSDK_CONFIG: '/opt/gcloud-config',
        CLOUDSDK_CORE_PROJECT: 'demo-project',
      });
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.RELAY_TOKEN_FILE).toBeUndefined();
      expect(env.RELAY_TOKEN).toBeUndefined();
    }
    expect(JSON.parse(readFileSync(join(home, 'tool-event.json'), 'utf8'))).toEqual({
      relay_url: 'http://127.0.0.1:8080',
      relay_team: 'demo',
      relay_auth: 'google',
      state_dir: join(home, 'state'),
      gcloud_account: 'bob@example.com',
    });
    const deny: string[] = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).permissions.deny;
    expect(deny).toEqual(expectedDeny(home, null, ['//opt/gcloud-config/**']));
  });

  it('ignores a RELAY_TOKEN and removes a token file a token-mode run left behind', () => {
    const first = setup();
    expect(existsSync(join(first.home, 'token'))).toBe(true);
    const again = runAnswerer({
      ANSWERER_HOME: first.home,
      RELAY_URL: 'http://127.0.0.1:8080',
      RELAY_TEAM: 'demo',
      RELAY_AUTH: 'google',
      RELAY_TOKEN: TOKEN,
    });
    expect(again.status, again.stderr).toBe(0);
    expect(existsSync(join(first.home, 'token'))).toBe(false);
    for (const f of ['mcp.json', 'settings.json', 'tool-event.json']) {
      expect(readFileSync(join(first.home, f), 'utf8')).not.toContain(TOKEN);
    }
  });

  it('refuses an unknown RELAY_AUTH and an account that is not an email address', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'team-relay-ans-')), 'home');
    const base = { ANSWERER_HOME: home, RELAY_URL: 'https://relay.example.com', RELAY_TEAM: 'demo' };
    const badMode = runAnswerer({ ...base, RELAY_AUTH: 'basic' });
    expect(badMode.status).not.toBe(0);
    expect(badMode.stderr).toMatch(/RELAY_AUTH must be google or token/);
    const badAccount = runAnswerer({ ...base, RELAY_AUTH: 'google', RELAY_GCLOUD_ACCOUNT: '--impersonate-service-account=x@y.z' });
    expect(badAccount.status).not.toBe(0);
    expect(badAccount.stderr).toMatch(/RELAY_GCLOUD_ACCOUNT must be an account email address/);
    expect(existsSync(join(home, 'mcp.json'))).toBe(false);
  });
});

describe('bin/answerer working directory (§11.13)', () => {
  const base = () => realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-wd-')));
  const settings = (extra: Record<string, string>) => ({
    ANSWERER_HOME: join(base(), 'home'),
    RELAY_URL: 'https://relay.example.com',
    RELAY_TEAM: 'demo',
    RELAY_TOKEN: TOKEN,
    ...extra,
  });
  function refused(extra: Record<string, string>, why: RegExp) {
    const env = settings(extra);
    const r = runAnswerer(env);
    expect(r.status, r.stdout).not.toBe(0);
    expect(r.stderr).toMatch(why);
    expect(r.stdout).toBe('');
    // Refused before anything was written.
    expect(existsSync(join(env.ANSWERER_HOME, 'mcp.json'))).toBe(false);
    return r;
  }

  it('defaults to ${TMPDIR}/team-relay-answerer-<uid>/work, both levels mode 700, and runs from it', () => {
    const tmp = base();
    const r = runAnswerer(settings({ TMPDIR: tmp }));
    expect(r.status, r.stderr).toBe(0);
    const parent = join(tmp, `team-relay-answerer-${process.getuid!()}`);
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    expect(statSync(join(parent, 'work')).mode & 0o777).toBe(0o700);
    expect(r.stdout.startsWith(`cd ${join(parent, 'work')} &&`)).toBe(true);
    // Reusable: an empty existing directory is fine, and a loose mode is tightened.
    chmodSync(join(parent, 'work'), 0o755);
    const again = runAnswerer(settings({ TMPDIR: tmp }));
    expect(again.status, again.stderr).toBe(0);
    expect(statSync(join(parent, 'work')).mode & 0o777).toBe(0o700);
  });

  it('uses ANSWERER_WORKDIR, creating it when missing', () => {
    const dir = join(base(), 'a', 'b', 'work');
    const r = runAnswerer(settings({ ANSWERER_WORKDIR: dir }));
    expect(r.status, r.stderr).toBe(0);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(r.stdout.startsWith(`cd ${dir} &&`)).toBe(true);
  });

  it('refuses a working directory inside $HOME, however it is reached', () => {
    const home = base();
    refused({ HOME: home, ANSWERER_WORKDIR: join(home, 'answerer-work') }, /inside \$HOME/);
    refused({ HOME: home, ANSWERER_WORKDIR: home }, /inside \$HOME/);
    // Through a symlink that points into $HOME.
    const outside = base();
    symlinkSync(home, join(outside, 'link-to-home'));
    refused({ HOME: home, ANSWERER_WORKDIR: join(outside, 'link-to-home', 'work') }, /inside \$HOME/);
    // A TMPDIR inside $HOME makes the default refused too.
    refused({ HOME: home, TMPDIR: join(home, 'tmp') }, /inside \$HOME/);
    expect(existsSync(join(home, 'answerer-work'))).toBe(false);
  });

  for (const name of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/rules', '.claude/settings.json', '.claude/settings.local.json']) {
    it(`refuses when an ancestor holds ${name}`, () => {
      const root = base();
      const target = join(root, name);
      mkdirSync(join(target, '..'), { recursive: true });
      if (name.endsWith('rules')) mkdirSync(target);
      else writeFileSync(target, '# memory\n');
      refused({ ANSWERER_WORKDIR: join(root, 'x', 'work') }, new RegExp(`${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} would load`));
      // The same file in the working directory itself.
      const own = join(base(), 'work');
      mkdirSync(join(own, name, '..'), { recursive: true });
      if (name.endsWith('rules')) mkdirSync(join(own, name));
      else writeFileSync(join(own, name), '# memory\n');
      refused({ ANSWERER_WORKDIR: own }, /would load into the answering session/);
    });
  }

  it('refuses a working directory that is not empty', () => {
    const dir = join(base(), 'work');
    mkdirSync(dir);
    writeFileSync(join(dir, '.mcp.json'), '{}');
    refused({ ANSWERER_WORKDIR: dir }, /must be empty/);
  });

  it('refuses a relative path, . or .. components, a symlink, and a file', () => {
    refused({ ANSWERER_WORKDIR: 'relative/work' }, /absolute path/);
    const root = base();
    refused({ ANSWERER_WORKDIR: `${root}/a/../work` }, /\. or \.\. components/);
    refused({ ANSWERER_WORKDIR: `${root}/./work` }, /\. or \.\. components/);
    const real = join(root, 'real');
    mkdirSync(real);
    symlinkSync(real, join(root, 'link'));
    refused({ ANSWERER_WORKDIR: join(root, 'link') }, /is a symlink/);
    writeFileSync(join(root, 'file'), 'x');
    refused({ ANSWERER_WORKDIR: join(root, 'file') }, /not a directory/);
  });

  it('refuses a default parent directory that is a symlink (a pre-planted /tmp entry)', () => {
    const tmp = base();
    const elsewhere = base();
    symlinkSync(elsewhere, join(tmp, `team-relay-answerer-${process.getuid!()}`));
    refused({ TMPDIR: tmp }, /is a symlink/);
    expect(existsSync(join(elsewhere, 'work'))).toBe(false);
  });
});

describe('bin/answerer session files drive working servers', () => {
  it('the relay and capabilities entries in mcp.json start and authenticate via the token file', async () => {
    const relay = await new FakeRelay().start();
    const clients: Client[] = [];
    try {
      const { home, r } = setup({
        RELAY_URL: relay.url,
        RELAY_TOKEN: TOKEN_OF.bob!,
        CAP_STAGING_DB_QUERY_RUNNER: join(FIXTURES, 'fake-runner.mjs'),
      });
      expect(r.status, r.stderr).toBe(0);
      const mcp = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'));
      for (const name of ['relay', 'capabilities']) {
        const def = mcp.mcpServers[name];
        const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
        await client.connect(
          new StdioClientTransport({ command: def.command, args: def.args, env: { PATH: process.env.PATH ?? '', ...def.env }, stderr: 'pipe' }),
        );
        clients.push(client);
      }
      const [relayClient, capClient] = clients;
      expect(relayClient!.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} });
      expect((relay.manifests.get('bob') as { capabilities: Array<{ name: string }> }).capabilities.map((c) => c.name)).toEqual([
        'staging_db_query',
      ]);
      const request_id = relay.addRequest({ capability: { name: 'staging_db_query', params: { dataset: 'users', op: 'eq', limit: 20 } } });
      const res = await capClient!.callTool({ name: 'staging_db_query', arguments: { dataset: 'users', request_id } });
      expect(JSON.parse(textOf(res)).rows.length).toBeGreaterThan(0);
      expect(relay.progress).toHaveLength(2);
      expect(relay.requests.every((q) => q.member === 'bob')).toBe(true);
    } finally {
      for (const c of clients) await c.close().catch(() => {});
      await relay.stop();
    }
  });
});
