// Manifest-driven install (M1-SPEC §8.4): from plugin/manifest.yaml generate
// .claude-plugin/plugin.json `userConfig` (every other key is left as it is) and .mcp.json.
//
//   pnpm generate           write the files
//   pnpm generate --check   exit 1 when the committed files differ from what would be written

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, type Manifest } from '../src/manifest.js';

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export type UserConfigEntry = {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file';
  title: string;
  description: string;
  sensitive?: boolean;
  required?: boolean;
  default?: string | number | boolean;
  /** For a string: the fixed values to choose from. */
  options?: string[];
};

export function buildUserConfig(manifest: Manifest): Record<string, UserConfigEntry> {
  const cfg: Record<string, UserConfigEntry> = {
    relay_url: {
      type: 'string',
      title: 'Relay URL',
      description: 'Base URL of your team relay (https; plain http only to localhost).',
      required: true,
    },
    relay_team: {
      type: 'string',
      title: 'Team',
      description: 'Your team id on the relay, for example demo.',
      required: true,
    },
    relay_auth: {
      type: 'string',
      title: 'Relay sign-in',
      description:
        'google (the default): your own gcloud identity, from `gcloud auth print-identity-token`. token: a static development token, for a local relay only.',
      options: ['google', 'token'],
      default: 'google',
    },
    gcloud_account: {
      type: 'string',
      title: 'gcloud account',
      description: 'Optional: the gcloud account (email) whose identity to use when signing in with google. Empty means gcloud\'s active account.',
    },
    relay_token: {
      type: 'string',
      title: 'Relay token',
      description: 'Only when relay sign-in is token: your bearer token for a local relay. Stored in your system keychain, never in a file.',
      sensitive: true,
    },
    allow_production: {
      type: 'boolean',
      title: 'Allow production-data capabilities',
      description:
        'Off unless you opt in. When off, capabilities that touch production data are never offered to teammates, whatever else is set. The answering session reads this as ALLOW_PRODUCTION.',
      default: false,
    },
  };
  for (const cap of manifest.capabilities) {
    const key = cap.name.toUpperCase();
    const production = cap.environment === 'production';
    cfg[`cap_${cap.name}`] = {
      type: 'boolean',
      title: `Run ${cap.title} for teammates`,
      description: production
        ? `Production data: offered only if you also allow production-data capabilities. Always off by default. The answering session reads this as CAP_${key}_ENABLED.`
        : `Staging data. Off by default unless the team manifest turns it on. The answering session reads this as CAP_${key}_ENABLED.`,
      // Production is forced off by default, whatever default_enabled says.
      default: production ? false : cap.default_enabled === true,
    };
    cfg[`cap_${cap.name}_runner`] = {
      type: 'file',
      title: `Program that runs ${cap.title}`,
      description: `Absolute path to the executable that runs ${cap.name}; it gets one JSON line on stdin and prints one JSON value. The answering session reads this as CAP_${key}_RUNNER.`,
    };
  }
  return cfg;
}

export function buildMcpJson(): Record<string, unknown> {
  return {
    mcpServers: {
      relay: {
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
      },
    },
  };
}

export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export type Rendered = { path: string; content: string };

/** What the generator would write, for a plugin rooted at `root`. */
export function render(root: string = PLUGIN_ROOT): Rendered[] {
  const manifest = loadManifest(join(root, 'manifest.yaml'));
  const pluginPath = join(root, '.claude-plugin', 'plugin.json');
  const plugin = JSON.parse(readFileSync(pluginPath, 'utf8')) as Record<string, unknown>;
  // Replace userConfig in place (key order kept); every other key is untouched.
  const next: Record<string, unknown> = {};
  let placed = false;
  for (const [k, v] of Object.entries(plugin)) {
    if (k === 'userConfig') {
      next.userConfig = buildUserConfig(manifest);
      placed = true;
    } else next[k] = v;
  }
  if (!placed) next.userConfig = buildUserConfig(manifest);
  return [
    { path: pluginPath, content: renderJson(next) },
    { path: join(root, '.mcp.json'), content: renderJson(buildMcpJson()) },
  ];
}

export function run(opts: { root?: string; check: boolean }): { drifted: string[] } {
  const root = opts.root ?? PLUGIN_ROOT;
  const drifted: string[] = [];
  for (const file of render(root)) {
    const current = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null;
    if (current === file.content) continue;
    drifted.push(file.path);
    if (!opts.check) writeFileSync(file.path, file.content);
  }
  return { drifted };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--check');
  if (unknown.length > 0) {
    console.error(`unknown argument: ${unknown.join(' ')}`);
    process.exit(2);
  }
  const check = args.includes('--check');
  try {
    const { drifted } = run({ check });
    if (check && drifted.length > 0) {
      console.error(`out of date (run pnpm generate): ${drifted.map((p) => p.slice(PLUGIN_ROOT.length + 1)).join(', ')}`);
      process.exit(1);
    }
    console.error(check ? 'generated files are up to date' : drifted.length ? `wrote ${drifted.length} file(s)` : 'nothing to change');
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
