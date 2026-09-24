// What the tool-event hook sends (M2-SPEC §3.3, §4.3), as pure functions.
//
// Claude Code's PostToolUse / PostToolUseFailure hook input (code.claude.com/docs/en/hooks,
// checked 23 Sep 2026) carries session_id, transcript_path, cwd, hook_event_name,
// tool_name, tool_input, tool_use_id, duration_ms (the tool's execution time in ms), and
// tool_response (PostToolUse) or error and is_interrupt (PostToolUseFailure). Only
// hook_event_name, tool_name and duration_ms are ever read here; the event built below is
// made of those three alone, so tool input, output, errors and paths cannot leave.

import type { ToolEventBody } from './relay-client.js';

export const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MAX_DURATION_MS = 3_600_000;

/** The relay channel's own tools: bookkeeping of the exchange, not tools used to answer. */
const RELAY_OWN_TOOLS = new Set(['ack_question', 'reply']);

/**
 * `mcp__<server>__<tool>` → `{server, tool}`; a built-in tool has no server. Plugin servers
 * are named `plugin_<plugin>_<server>`, which this keeps whole as the server.
 */
export function splitToolName(name: string): { server: string | null; tool: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : { server: null, tool: name };
}

function isRelayServer(server: string | null): boolean {
  return server === null || server === 'relay' || server.endsWith('_relay');
}

/** The §3.3 body for a hook payload, or null when nothing is to be sent. */
export function toolEventFromPayload(payload: unknown): ToolEventBody | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const p = payload as { hook_event_name?: unknown; tool_name?: unknown; duration_ms?: unknown };
  let status: ToolEventBody['status'];
  if (p.hook_event_name === 'PostToolUse') status = 'ok';
  else if (p.hook_event_name === 'PostToolUseFailure') status = 'error';
  else return null;
  if (typeof p.tool_name !== 'string') return null;
  const { server, tool } = splitToolName(p.tool_name);
  if (RELAY_OWN_TOOLS.has(tool) && isRelayServer(server)) return null;
  if (!TOOL_NAME_RE.test(tool)) return null;
  let duration: number | null = null;
  if (typeof p.duration_ms === 'number' && Number.isFinite(p.duration_ms) && p.duration_ms >= 0) {
    const ms = Math.round(p.duration_ms);
    duration = ms <= MAX_DURATION_MS ? ms : null;
  }
  return { tool, status, duration_ms: duration };
}

export type ToolEventConfig = {
  relay_url: string;
  relay_team: string;
  relay_auth: 'google' | 'token';
  gcloud_account?: string;
  token_file?: string;
  state_dir: string;
};

/** The launcher-written config file (bin/answerer: $ANSWERER_HOME/tool-event.json). */
export function parseToolEventConfig(raw: unknown): ToolEventConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('config is not an object');
  const c = raw as Record<string, unknown>;
  const str = (k: string) => {
    const v = c[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new Error(`config ${k} is not a string`);
    return v;
  };
  const relay_url = str('relay_url');
  const relay_team = str('relay_team');
  const state_dir = str('state_dir');
  const relay_auth = str('relay_auth') ?? 'google';
  if (!relay_url || !relay_team || !state_dir) throw new Error('config needs relay_url, relay_team and state_dir');
  if (relay_auth !== 'google' && relay_auth !== 'token') throw new Error('config relay_auth must be google or token');
  const gcloud_account = str('gcloud_account');
  const token_file = str('token_file');
  if (relay_auth === 'token' && !token_file) throw new Error('config needs token_file when relay_auth is token');
  return {
    relay_url,
    relay_team,
    relay_auth,
    state_dir,
    ...(gcloud_account !== undefined ? { gcloud_account } : {}),
    ...(token_file !== undefined ? { token_file } : {}),
  };
}
