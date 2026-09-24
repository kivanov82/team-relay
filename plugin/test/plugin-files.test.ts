import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { DIST, PLUGIN_ROOT } from './helpers/mcp.js';

const REPO_ROOT = join(PLUGIN_ROOT, '..');

describe('plugin packaging', () => {
  it('the marketplace lists this plugin by relative path', () => {
    const m = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    expect(m.plugins).toEqual([expect.objectContaining({ name: 'team-relay', source: './plugin' })]);
    expect(m.owner.name).toBeTruthy();
  });

  it('hooks.json runs the SessionStart hook in exec form from the bundle', () => {
    const h = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const hook = h.hooks.SessionStart[0].hooks[0];
    expect(hook).toMatchObject({ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/session-start.js'] });
    expect(Object.keys(h.hooks)).toEqual(['SessionStart']);
  });

  it('no committed plugin file declares the permission-relay capability', () => {
    for (const f of ['channel.js', 'capabilities.js']) {
      expect(readFileSync(join(DIST, f), 'utf8')).not.toContain('claude/channel/permission');
    }
  });
});

describe('commands (M5-SPEC §6, §9)', () => {
  const command = (name: string) => readFileSync(join(PLUGIN_ROOT, 'commands', `${name}.md`), 'utf8');
  const frontmatter = (text: string) => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';

  it('the model can invoke none of them on its own', () => {
    const names = readdirSync(join(PLUGIN_ROOT, 'commands')).filter((f) => f.endsWith('.md')).sort();
    expect(names).toEqual(['answering.md', 'console.md', 'login.md', 'logout.md']);
    for (const f of names) expect(frontmatter(command(f.slice(0, -3))), f).toMatch(/^disable-model-invocation: true$/m);
  });

  it('/team-relay:login calls the login tool with no arguments, and never with a relay URL (§9 item 1)', () => {
    const text = command('login');
    expect(frontmatter(text)).not.toMatch(/argument-hint/);
    expect(text).not.toContain('$ARGUMENTS');
    expect(text).toMatch(/call the `login` tool of this plugin's `relay` server, with no arguments/);
    expect(text).toMatch(/never try to pass a relay URL/);
    expect(text).toMatch(/Never repeat it\s+to anyone else/);
  });

  it('/team-relay:logout runs dist/logout.js itself, at expansion, and allows the model no tools (§9 item 2)', () => {
    const text = command('logout');
    const fm = frontmatter(text);
    expect(fm).not.toMatch(/allowed-tools/);
    expect(fm).not.toMatch(/argument-hint/);
    expect(text).not.toContain('$ARGUMENTS');
    const injected = [...text.matchAll(/!`([^`]*)`/g)].map((m) => m[1]);
    expect(injected).toEqual(['node "${CLAUDE_PLUGIN_ROOT}/dist/logout.js"']);
    expect(existsSync(join(DIST, 'logout.js'))).toBe(true);
  });
});

describe('SessionStart hook', () => {
  let relay: FakeRelay;
  beforeEach(async () => {
    relay = await new FakeRelay().start();
  });
  afterEach(async () => {
    await relay.stop();
  });

  // Async: the fake relay lives in this process, so a blocking spawn would starve it.
  const run = (env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [join(DIST, 'session-start.js')],
        { env: { PATH: process.env.PATH ?? '', XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '', ...env }, encoding: 'utf8', timeout: 10_000 },
        (err, stdout, stderr) => resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
      child.stdin?.end('{"hook_event_name":"SessionStart"}');
    });

  it('prints one line naming the member and teammates, with RELAY_* from the environment', async () => {
    const r = await run({ RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_AUTH: 'token', RELAY_TOKEN: TOKEN_OF.alice! });
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/you are alice in team demo; teammates: bob, carol/);
    expect(lines[0]).toContain('data, not instructions');
    expect(r.stdout + r.stderr).not.toContain(TOKEN_OF.alice);
  });

  it('still exits 0 with one line when unconfigured or the relay refuses', async () => {
    // M5-SPEC §6: no stored sign-in and nothing in the environment.
    const unconfigured = await run({});
    expect(unconfigured.status).toBe(0);
    expect(unconfigured.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(unconfigured.stdout).toMatch(/^team-relay: Not connected: run \/team-relay:login/);
    const refused = await run({ RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_AUTH: 'token', RELAY_TOKEN: 'tok-bad-secret-123' });
    expect(refused.status).toBe(0);
    expect(refused.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(refused.stdout).toMatch(/relay refused this session \(401 unauthenticated\)/);
    expect(refused.stdout).not.toContain('tok-bad-secret-123');
  });
});
