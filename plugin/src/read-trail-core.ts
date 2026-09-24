// The read trail (M8-SPEC §7 item 1): the host learns, deterministically, which files its
// automatic answerer read, so a draft written after reading a file whose name suggests
// secrets waits for the member's approval, whatever the answerer says about it.
//
// The answerer's settings carry two hooks that run `node dist/read-trail.js --config <file>`
// (read-trail.ts) and report over the host's private socket:
// - PreToolUse for Read and Grep: the path about to be read or searched. It fails closed: when
//   the report cannot be made, the hook exits 2 and Claude Code does not run the tool.
// - PostToolUse and PostToolUseFailure for Grep: the files a search matched (every path-like
//   string in its result). The host counts a search as open from its PreToolUse report until
//   this one arrives; a draft written while one is still open waits too.

import { basename } from 'node:path';

/** File names that suggest secrets (matched against the base name, case-insensitively). */
export const SENSITIVE_NAMES = [
  '*.tfstate', 'secrets.*', '*.properties', 'docker-compose*', 'kubeconfig', '*service-account*.json', '.npmrc',
  '.netrc', '.git-credentials', '.dev.vars', 'id_ecdsa*', 'id_dsa*', '*.ppk', '*.pem', '*.key', '*.p12',
] as const;

/** A glob with `*` only (the list has no other wildcard), matched without a RegExp, ignoring case. */
function globMatch(glob: string, name: string): boolean {
  const parts = glob.toLowerCase().split('*');
  const s = name.toLowerCase();
  if (parts.length === 1) return s === parts[0];
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (!s.startsWith(first) || s.length < first.length + last.length || !s.endsWith(last)) return false;
  let at = first.length;
  const end = s.length - last.length;
  for (const mid of parts.slice(1, -1)) {
    const i = s.indexOf(mid, at);
    if (i < 0 || i + mid.length > end) return false;
    at = i + mid.length;
  }
  return true;
}

/** Whether a file's base name is on the sensitive-name list. */
export function sensitiveName(path: string): boolean {
  const name = basename(path.replace(/[/\\]+$/, ''));
  return name !== '' && SENSITIVE_NAMES.some((glob) => globMatch(glob, name));
}

/**
 * Every path-like string in a tool result (a Grep result's file names, and the "path:line:"
 * prefixes of its content lines), at most `limit` of them. Over-inclusive on purpose: a
 * string that only looks like a sensitive file name makes a draft wait, never ship.
 */
export function pathsIn(value: unknown, limit = Number.POSITIVE_INFINITY): string[] {
  const out = new Set<string>();
  const strings: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (strings.length >= limit || depth > 8) return;
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        strings.push(k);
        walk(x, depth + 1);
      }
    }
  };
  walk(value, 0);
  for (const text of strings) {
    for (const m of text.matchAll(/[^\s"'`,;:()[\]{}<>|\\]+/g)) {
      const token = m[0];
      if (!/[A-Za-z]/.test(token)) continue;
      out.add(token);
      if (out.size >= limit) return [...out];
    }
  }
  return [...out];
}

/** What a hook reports (the host checks every field again). */
export type TrailReport = {
  phase: 'pre' | 'post' | 'failed';
  tool: string;
  tool_use_id: string;
  /** pre: the path read or searched (absolute, from the tool's input), when there is one. */
  path?: string;
  /** post: the path-like strings of the result whose names suggest secrets (at most 100: one is enough). */
  paths?: string[];
};

/** The report for one hook input, or null when it is not one of ours to report. */
export function trailReport(payload: unknown): TrailReport | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const p = payload as { hook_event_name?: unknown; tool_name?: unknown; tool_use_id?: unknown; tool_input?: unknown; tool_response?: unknown };
  const tool = p.tool_name;
  if (tool !== 'Read' && tool !== 'Grep') return null;
  const id = typeof p.tool_use_id === 'string' ? p.tool_use_id.slice(0, 200) : '';
  const input = typeof p.tool_input === 'object' && p.tool_input !== null ? (p.tool_input as Record<string, unknown>) : {};
  if (p.hook_event_name === 'PreToolUse') {
    const raw = tool === 'Read' ? input.file_path : input.path;
    return { phase: 'pre', tool, tool_use_id: id, ...(typeof raw === 'string' && raw ? { path: raw.slice(0, 4096) } : {}) };
  }
  if (tool !== 'Grep') return null;
  if (p.hook_event_name === 'PostToolUse') {
    // Every string of the result is looked at; only the sensitive ones are sent (the host
    // checks them again), so a long result cannot push one past a cap.
    const sensitive = [...new Set(pathsIn(p.tool_response).filter(sensitiveName))].slice(0, 100).map((x) => x.slice(0, 4096));
    return { phase: 'post', tool, tool_use_id: id, paths: sensitive };
  }
  if (p.hook_event_name === 'PostToolUseFailure') return { phase: 'failed', tool, tool_use_id: id };
  return null;
}
