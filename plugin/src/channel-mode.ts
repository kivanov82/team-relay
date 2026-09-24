// Is this Claude Code session a channel session? Claude Code shows notifications/claude/channel
// events only in a session started with the channel flag (`--dangerously-load-development-channels
// plugin:team-relay@<marketplace>` during the research preview, `--channels …` later). It sends
// the same MCP initialize with and without the flag, so the plugin cannot learn it from the
// protocol. The plugin is installed user-wide, so every session on the machine starts this
// server; a session that cannot show teammates' answers must never read (and so acknowledge)
// the member's stream, or the answers are lost.
//
// The answer, in order:
// 1. TEAM_RELAY_CHANNEL=1 or 0 in the server's environment wins (bin/answerer sets 1 for the
//    answering session, whose mcp.json it writes itself).
// 2. Otherwise the nearest `claude` process among up to 4 ancestors decides: it is a channel
//    session only when its argv carries one of the channel flags with a value list that names
//    this plugin (`plugin:<plugin>@…`; `server:relay` for the answering role).
// 3. Anything that cannot be inspected is not a channel session: never consume what cannot be shown.
//
// The process table is read with execFile (no shell): /proc/<pid>/cmdline and /proc/<pid>/stat
// where they exist (exact argv), else `ps -ww -o ppid=,args= -p <pid>` and `ps -ww -o comm= -p
// <pid>` (argv joined by spaces; argv[0] comes from `comm`, so an executable path with spaces
// in it still parses).

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ChannelRole = 'asker' | 'answerer';

/** The flags that load channels (the research-preview one, and the one it becomes). */
export const CHANNEL_FLAGS = ['--dangerously-load-development-channels', '--channels'] as const;

/** How far up the process tree the detection looks. */
export const MAX_ANCESTORS = 4;

const DEFAULT_PLUGIN = 'team-relay';
const DEFAULT_MARKETPLACE = 'team-relay-dev';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ProcInfo = { ppid: number; argv: string[] };
export type Inspect = (pid: number) => Promise<ProcInfo>;
export type ChannelDecision = { channel: boolean; reason: string };

// ---------------------------------------------------------------------------------------
// argv

/**
 * Every value given to a channel flag in `argv` (argv[0] is the program). Forms: `--flag a`,
 * `--flag a b c` (a list runs until the next token that starts with "-"), `--flag=a` (that
 * value only), `--flag a,b`, and any number of flags. `--` ends the options.
 */
export function channelEntries(argv: readonly string[]): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    for (const part of value.split(/[,\s]+/)) if (part) out.push(part);
  };
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') break;
    const eq = CHANNEL_FLAGS.find((f) => tok.startsWith(`${f}=`));
    if (eq) {
      add(tok.slice(eq.length + 1));
      continue;
    }
    if (!(CHANNEL_FLAGS as readonly string[]).includes(tok)) continue;
    while (i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) add(argv[++i]!);
  }
  return out;
}

/** Whether a channel entry loads this server for `role`. */
export function entryLoads(entry: string, role: ChannelRole, plugin: string = DEFAULT_PLUGIN): boolean {
  if (role === 'answerer') return entry === 'server:relay';
  const prefix = `plugin:${plugin}@`;
  return entry.startsWith(prefix) && entry.length > prefix.length;
}

/** Whether `argv` (a claude process's) loads this server as a channel for `role`. */
export function argvLoadsChannel(argv: readonly string[], role: ChannelRole, plugin: string = DEFAULT_PLUGIN): boolean {
  return channelEntries(argv).some((e) => entryLoads(e, role, plugin));
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? '';

/**
 * Whether `argv` is Claude Code's: the native binary (argv[0] named `claude`, however it was
 * reached), or a JavaScript runtime running the npm package or its `claude` shim.
 */
export function isClaudeArgv(argv: readonly string[]): boolean {
  const a0 = base(argv[0] ?? '');
  if (/^claude(\.exe)?$/i.test(a0)) return true;
  if (/^(node|nodejs|bun)(\.exe)?$/i.test(a0) && argv[1]) {
    return /^claude(\.m?js)?$/i.test(base(argv[1])) || /[\\/]@anthropic-ai[\\/]claude-code[\\/]/.test(argv[1]);
  }
  return false;
}

/**
 * argv from `ps -o args=` (argv joined by spaces) and `ps -o comm=` (argv[0] as it was
 * given, which may itself contain spaces). The rest is split on whitespace: a value with a
 * space in it cannot be told apart here, and no channel entry has one.
 */
export function splitPsArgs(args: string, comm: string): string[] {
  const a = args.trim();
  const c = comm.trim();
  if (c && (a === c || a.startsWith(`${c} `))) {
    const rest = a.slice(c.length).trim();
    return [c, ...(rest ? rest.split(/\s+/) : [])];
  }
  return a ? a.split(/\s+/) : [];
}

// ---------------------------------------------------------------------------------------
// The process table

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, env: { PATH: '/bin:/usr/bin:/usr/sbin:/sbin', LC_ALL: 'C' } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

async function inspectProc(pid: number): Promise<ProcInfo> {
  const [cmdline, stat] = await Promise.all([readFile(`/proc/${pid}/cmdline`), readFile(`/proc/${pid}/stat`, 'utf8')]);
  const argv = cmdline.toString('utf8').split('\0');
  if (argv.at(-1) === '') argv.pop();
  // "pid (comm) state ppid …": comm may hold spaces and parentheses, so read after the last ")".
  const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  return { ppid: Number(after[1]), argv };
}

async function inspectPs(pid: number): Promise<ProcInfo> {
  const [line, comm] = await Promise.all([
    run('ps', ['-ww', '-o', 'ppid=,args=', '-p', String(pid)]),
    run('ps', ['-ww', '-o', 'comm=', '-p', String(pid)]),
  ]);
  const m = /^\s*(\d+)\s+([\s\S]*?)\s*$/.exec(line);
  if (!m) throw new Error(`ps gave no entry for ${pid}`);
  return { ppid: Number(m[1]), argv: splitPsArgs(m[2]!, comm.replace(/\n[\s\S]*$/, '')) };
}

/** One process's parent and argv: /proc where it exists, else ps. Throws when neither works. */
export async function inspectProcess(pid: number): Promise<ProcInfo> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a pid: ${pid}`);
  try {
    return await inspectProc(pid);
  } catch {
    return inspectPs(pid);
  }
}

// ---------------------------------------------------------------------------------------
// The decision

/** TEAM_RELAY_CHANNEL: "1" or "0" wins; anything else leaves it to the process tree. */
export function channelOverride(env: NodeJS.ProcessEnv): boolean | null {
  const v = (env.TEAM_RELAY_CHANNEL ?? '').trim();
  if (v === '1') return true;
  if (v === '0') return false;
  return null;
}

export async function detectChannelSession(opts: {
  env: NodeJS.ProcessEnv;
  role: ChannelRole;
  /** The first ancestor to look at (default: this process's parent). */
  startPid?: number;
  inspect?: Inspect;
  plugin?: string;
}): Promise<ChannelDecision> {
  const override = channelOverride(opts.env);
  if (override !== null) return { channel: override, reason: `TEAM_RELAY_CHANNEL=${override ? 1 : 0}` };
  const inspect = opts.inspect ?? inspectProcess;
  const plugin = opts.plugin ?? pluginRef(opts.env).plugin;
  let pid = opts.startPid ?? process.ppid;
  for (let depth = 1; depth <= MAX_ANCESTORS && pid > 1; depth++) {
    let info: ProcInfo;
    try {
      info = await inspect(pid);
    } catch (err) {
      return { channel: false, reason: `could not inspect ancestor ${depth} (${err instanceof Error ? err.message : 'error'})` };
    }
    if (isClaudeArgv(info.argv)) {
      const on = argvLoadsChannel(info.argv, opts.role, plugin);
      return { channel: on, reason: on ? `claude (ancestor ${depth}) loads this channel` : `claude (ancestor ${depth}) was started without this channel` };
    }
    if (!Number.isInteger(info.ppid) || info.ppid === pid) break;
    pid = info.ppid;
  }
  return { channel: false, reason: `no claude process among the ${MAX_ANCESTORS} nearest ancestors` };
}

// ---------------------------------------------------------------------------------------
// What a session without the channel is told

/**
 * The plugin and marketplace names, from the plugin's install path
 * (…/plugins/cache/<marketplace>/<plugin>/<version>): CLAUDE_PLUGIN_ROOT, else where this
 * bundle lives. Anything else (a development checkout) gives team-relay@team-relay-dev.
 */
export function pluginRef(env: NodeJS.ProcessEnv, bundleRoot: string | null = ownRoot()): { plugin: string; marketplace: string } {
  for (const root of [env.CLAUDE_PLUGIN_ROOT, bundleRoot]) {
    if (!root) continue;
    const parts = root.split(/[\\/]+/).filter(Boolean);
    const [cache, marketplace, plugin] = parts.slice(-4);
    if (parts.length >= 4 && cache === 'cache' && marketplace && plugin && NAME_RE.test(marketplace) && NAME_RE.test(plugin)) {
      return { plugin, marketplace };
    }
  }
  return { plugin: DEFAULT_PLUGIN, marketplace: DEFAULT_MARKETPLACE };
}

function ownRoot(): string | null {
  try {
    // dist/<bundle>.js (or src/<file>.ts under test): the plugin root is one level up.
    return dirname(dirname(fileURLToPath(import.meta.url))) + sep;
  } catch {
    return null;
  }
}

/** The command that starts a working session with this plugin's channel. */
export function channelCommand(env: NodeJS.ProcessEnv): string {
  const { plugin, marketplace } = pluginRef(env);
  return `claude --dangerously-load-development-channels plugin:${plugin}@${marketplace}`;
}

/** Said plainly, in tool results and the SessionStart line, by a session without the channel. */
export function notChannelNote(env: NodeJS.ProcessEnv): string {
  return (
    "This session was not started with the team-relay channel, so teammates' answers are not shown here. " +
    `Start one with: ${channelCommand(env)}`
  );
}

/** Where the answer to a request sent from a session without the channel will appear. */
export function answersAppearNote(env: NodeJS.ProcessEnv): string {
  return (
    'The answer is not shown in this session. It is delivered to a session started with the team-relay channel: one running now, ' +
    `or the next one you start with: ${channelCommand(env)}. Here, request_status with this request_id shows who has acknowledged and answered.`
  );
}
