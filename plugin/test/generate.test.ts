import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildUserConfig, render, run } from '../scripts/generate.js';
import { validateManifest } from '../src/manifest.js';
import { PLUGIN_ROOT } from './helpers/mcp.js';

function copyPlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-relay-gen-'));
  cpSync(join(PLUGIN_ROOT, 'manifest.yaml'), join(dir, 'manifest.yaml'));
  cpSync(join(PLUGIN_ROOT, '.claude-plugin'), join(dir, '.claude-plugin'), { recursive: true });
  cpSync(join(PLUGIN_ROOT, '.mcp.json'), join(dir, '.mcp.json'));
  return dir;
}

describe('generator', () => {
  it('matches the committed plugin.json and .mcp.json', () => {
    for (const file of render(PLUGIN_ROOT)) {
      expect(readFileSync(file.path, 'utf8'), file.path).toBe(file.content);
    }
    expect(run({ check: true }).drifted).toEqual([]);
  });

  it('asks the relay settings and one pair of questions per capability', () => {
    const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    const cfg = plugin.userConfig;
    expect(Object.keys(cfg)).toEqual([
      'relay_url',
      'relay_team',
      'relay_auth',
      'gcloud_account',
      'relay_token',
      'allow_production',
      'cap_staging_db_query',
      'cap_staging_db_query_runner',
      'cap_service_health',
      'cap_service_health_runner',
      'cap_production_db_count',
      'cap_production_db_count_runner',
    ]);
    // M2-SPEC §4.1: Google identity by default; the token is needed only for relay_auth=token.
    expect(cfg.relay_auth).toMatchObject({ type: 'string', options: ['google', 'token'], default: 'google' });
    expect(cfg.relay_auth.required).toBeUndefined();
    expect(cfg.gcloud_account).toMatchObject({ type: 'string' });
    expect(cfg.gcloud_account.required).toBeUndefined();
    expect(cfg.gcloud_account.sensitive).toBeUndefined();
    expect(cfg.relay_token).toMatchObject({ type: 'string', sensitive: true });
    expect(cfg.relay_token.required).toBeUndefined();
    expect(cfg.relay_url).toMatchObject({ type: 'string', required: true });
    expect(cfg.relay_team).toMatchObject({ type: 'string', required: true });
    expect(cfg.allow_production).toMatchObject({ type: 'boolean', default: false, title: 'Allow production-data capabilities' });
    expect(cfg.cap_staging_db_query).toMatchObject({ type: 'boolean', title: 'Run Query the staging database for teammates' });
    expect(cfg.cap_staging_db_query_runner).toMatchObject({ type: 'file', title: 'Program that runs Query the staging database' });
    for (const entry of Object.values(cfg) as Array<Record<string, unknown>>) {
      expect(typeof entry.title).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(['string', 'number', 'boolean', 'directory', 'file']).toContain(entry.type);
    }
    // Only the token is sensitive; no other key carries a secret.
    expect(Object.entries(cfg).filter(([, v]) => (v as { sensitive?: boolean }).sensitive).map(([k]) => k)).toEqual(['relay_token']);
    expect(plugin.channels).toEqual([{ server: 'relay' }]);
    expect(plugin.name).toBe('team-relay');
  });

  it('forces a production capability to default off, whatever default_enabled says', () => {
    const manifest = validateManifest({
      version: 1,
      capabilities: [
        { name: 'prod_thing', title: 'Prod thing', description: 'd', environment: 'production', default_enabled: true, params: {} },
        { name: 'stage_thing', title: 'Stage thing', description: 'd', environment: 'staging', default_enabled: true, params: {} },
        { name: 'stage_off', title: 'Stage off', description: 'd', environment: 'staging', params: {} },
      ],
    });
    const cfg = buildUserConfig(manifest);
    expect(cfg.cap_prod_thing!.default).toBe(false);
    expect(cfg.cap_prod_thing!.description).toMatch(/Production data/);
    expect(cfg.cap_stage_thing!.default).toBe(true);
    expect(cfg.cap_stage_off!.default).toBe(false);
  });

  it('writes the relay server in asker role with settings from user_config', () => {
    const mcp = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['relay']);
    expect(mcp.mcpServers.relay).toEqual({
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/dist/channel.js'],
      env: {
        RELAY_ROLE: 'asker',
        RELAY_URL: '${user_config.relay_url}',
        RELAY_TEAM: '${user_config.relay_team}',
        RELAY_AUTH: '${user_config.relay_auth}',
        RELAY_GCLOUD_ACCOUNT: '${user_config.gcloud_account}',
        RELAY_TOKEN: '${user_config.relay_token}',
      },
    });
  });

  it('leaves every other plugin.json key untouched', () => {
    const dir = copyPlugin();
    const path = join(dir, '.claude-plugin', 'plugin.json');
    const plugin = JSON.parse(readFileSync(path, 'utf8'));
    plugin.homepage = 'https://example.com/team-relay';
    plugin.userConfig = { stale: { type: 'string', title: 'x', description: 'x' } };
    writeFileSync(path, JSON.stringify(plugin, null, 2) + '\n');
    run({ root: dir, check: false });
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.homepage).toBe('https://example.com/team-relay');
    expect(after.userConfig.stale).toBeUndefined();
    expect(after.userConfig.relay_token.sensitive).toBe(true);
  });

  it('--check detects drift in either file and does not write', () => {
    const dir = copyPlugin();
    expect(run({ root: dir, check: true }).drifted).toEqual([]);

    const manifestPath = join(dir, 'manifest.yaml');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('title: Check a service\'s health', 'title: Check health'));
    const pluginBefore = readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8');
    expect(run({ root: dir, check: true }).drifted).toEqual([join(dir, '.claude-plugin', 'plugin.json')]);
    expect(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(pluginBefore);

    writeFileSync(join(dir, '.mcp.json'), '{}\n');
    expect(run({ root: dir, check: true }).drifted).toHaveLength(2);
    run({ root: dir, check: false });
    expect(run({ root: dir, check: true }).drifted).toEqual([]);
  });

  it('the CLI --check exits 0 on the committed files', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(PLUGIN_ROOT, 'scripts', 'generate.ts'), '--check'], {
      cwd: PLUGIN_ROOT,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
  });
});
