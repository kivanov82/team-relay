// Which capabilities this member actually runs for teammates (M1-SPEC §8.3, §8.4).
// Shared by the capability server (which tools it lists) and the answerer channel (the
// discovery payload it publishes), so teammates discover exactly what will run.

import { statSync, accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SHARES, SHARE_NAME_RE, type Capability, type Manifest, type Share } from './manifest.js';

export type ExposedCapability = { capability: Capability; runner: string };
export type SkippedCapability = { name: string; reason: string };

export function envKey(name: string): string {
  return name.toUpperCase();
}

/** The manifest shipped with the plugin, next to dist/ (bundles live in dist/). */
export function defaultManifestPath(): string {
  return fileURLToPath(new URL('../manifest.yaml', import.meta.url));
}

function runnerProblem(path: string): string | null {
  if (!isAbsolute(path)) return 'runner path must be absolute';
  let st;
  try {
    st = statSync(path);
  } catch {
    return 'runner does not exist';
  }
  if (!st.isFile()) return 'runner is not a regular file';
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return 'runner is not executable';
  }
  return null;
}

/**
 * A capability is exposed iff CAP_<NAME>_ENABLED is "true", CAP_<NAME>_RUNNER names an
 * executable regular file (absolute path), and it is staging or ALLOW_PRODUCTION is "true".
 */
export function exposedCapabilities(
  manifest: Manifest,
  env: NodeJS.ProcessEnv,
): { exposed: ExposedCapability[]; skipped: SkippedCapability[] } {
  const allowProduction = env.ALLOW_PRODUCTION === 'true';
  const exposed: ExposedCapability[] = [];
  const skipped: SkippedCapability[] = [];
  for (const cap of manifest.capabilities) {
    const key = envKey(cap.name);
    if (env[`CAP_${key}_ENABLED`] !== 'true') {
      skipped.push({ name: cap.name, reason: 'not enabled' });
      continue;
    }
    if (cap.environment !== 'staging' && !allowProduction) {
      skipped.push({ name: cap.name, reason: 'production data not allowed' });
      continue;
    }
    const runner = env[`CAP_${key}_RUNNER`];
    if (!runner) {
      skipped.push({ name: cap.name, reason: 'no runner set' });
      continue;
    }
    const problem = runnerProblem(runner);
    if (problem) {
      skipped.push({ name: cap.name, reason: problem });
      continue;
    }
    exposed.push({ capability: cap, runner });
  }
  return { exposed, skipped };
}

/**
 * The folders this member shares (M4-SPEC §3), from ANSWERER_SHARES: the JSON list of
 * basenames bin/answerer derives from ANSWERER_READ_DIRS (never a path). Unset or empty is
 * no share. Throws on anything else, so a malformed value never reaches the team.
 */
export function sharesFromEnv(value: string | undefined): Share[] {
  if (value === undefined || value === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('ANSWERER_SHARES is not JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('ANSWERER_SHARES must be a list of folder names');
  if (parsed.length > MAX_SHARES) throw new Error(`ANSWERER_SHARES names more than ${MAX_SHARES} folders`);
  const names: string[] = [];
  for (const n of parsed) {
    if (typeof n !== 'string' || !SHARE_NAME_RE.test(n)) throw new Error('ANSWERER_SHARES holds a name that is not a folder name');
    if (names.includes(n)) throw new Error('ANSWERER_SHARES repeats a name');
    names.push(n);
  }
  return names.map((name) => ({ name }));
}

/**
 * The discovery payload: the manifest restricted to the exposed capabilities, and the
 * folders shared for reading (M4-SPEC §3; an empty list says "shares nothing").
 */
export function discoveryPayload(exposed: ExposedCapability[], shares: Share[] = []): Manifest {
  return { version: 1, capabilities: exposed.map((e) => e.capability), shares };
}
