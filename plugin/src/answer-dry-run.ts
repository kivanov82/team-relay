// `node dist/answer-dry-run.js`: show, and optionally smoke-check, exactly what the automatic
// answerer (M8-SPEC §2) runs for a question asked in the current folder. Nothing is ever sent
// to the relay and nothing is read from the inbox.
//
//   node dist/answer-dry-run.js [--question TEXT]           print the scope decision, the child
//                                                          command line, settings.json and mcp.json
//   node dist/answer-dry-run.js --run [--offline] [...]     also run it: the real `claude` (or
//                                                          TEAM_RELAY_CLAUDE_BIN) with those exact
//                                                          flags, against a local host that prints
//                                                          each tool call, denies every permission
//                                                          request and sends nothing
//
// --offline points the run's Anthropic API at a closed local port (ANTHROPIC_BASE_URL), so it
// makes no model call: Claude Code still parses every flag, loads the settings, starts both MCP
// servers and binds the permission prompt tool, then fails at its first API request. A flag,
// settings or MCP problem shows up as a different error. (A Claude Code signed in to a cloud
// provider does not use ANTHROPIC_BASE_URL; there --offline makes a real call.)

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { planRun, draftReasons, type HostConnection } from './answer-host.js';
import { runChild, type WorkItem } from './headless.js';
import { HostSocket } from './host-socket.js';
import { MEMBER_RE, connectionFromEnv } from './relay-client.js';
import { scopeFolder } from './scope.js';
import { isPlainObject } from './tool-util.js';

const USAGE = 'usage: answer-dry-run.js [--question TEXT] [--run [--offline]]';

function shellQuote(a: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

function parse(argv: string[]): { question: string; run: boolean; offline: boolean } {
  const o = { question: 'Dry run: what does this folder contain? Answer in one sentence.', run: false, offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--run') o.run = true;
    else if (a === '--offline') o.offline = true;
    else if (a === '--question' && argv[i + 1] !== undefined) o.question = argv[++i]!;
    else {
      process.stderr.write(`${USAGE}\n`);
      process.exit(2);
    }
  }
  if (o.offline && !o.run) o.run = true;
  return o;
}

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function main(): Promise<void> {
  const opts = parse(process.argv.slice(2));
  const env = { ...process.env };
  let connection: HostConnection = { mode: 'token', url: 'http://127.0.0.1:9', team: 'demo', token: 'dry-run-token' };
  let member = 'member';
  try {
    const c = connectionFromEnv(env);
    connection = { mode: c.mode, url: c.url, team: c.team };
    if (c.member && MEMBER_RE.test(c.member)) member = c.member;
  } catch {
    // not signed in: a placeholder relay (nothing is sent anyway)
  }
  const scope = scopeFolder(process.cwd(), env);
  const socket = new HostSocket();
  const runDir = mkdtempSync(join(socket.dir, 'run-'));
  const item: WorkItem = {
    request_id: `rq_${'0'.repeat(32)}`,
    from: 'teammate',
    kind: 'question',
    question: opts.question,
    answer_deadline: Date.now() + 15 * 60_000,
  };
  const claudeBin = env.TEAM_RELAY_CLAUDE_BIN?.trim() || 'claude';
  const plan = planRun({ item, runDir, socket: { path: socket.path, dir: socket.dir }, scope, env, connection, member, dist: import.meta.dirname, node: process.execPath, claudeBin });
  const redact = (text: string) => text.split(plan.token).join('<per-run token>');
  const out = (line = '') => process.stdout.write(`${line}\n`);
  out(`scope folder: ${scope.path}`);
  out(scope.qualifies ? `reads inside it are automatic; shared as "${scope.share}"` : `no automatic reads: ${scope.reason}`);
  out(`working directory: ${plan.cwd}`);
  out();
  out('command (the prompt goes on stdin):');
  out(`cd ${shellQuote(plan.cwd)} && ${[plan.bin, ...plan.args].map(shellQuote).join(' ')}`);
  out();
  out(`settings.json:\n${readFileSync(plan.files.settings, 'utf8')}`);
  out(`mcp.json:\n${redact(readFileSync(plan.files.mcpConfig, 'utf8'))}`);
  out(`environment kept: ${Object.keys(plan.env).sort().join(' ')}`);
  if (!opts.run) {
    await socket.close();
    return;
  }

  await socket.listen();
  const calls: string[] = [];
  socket.setRun(plan.token, async (method, params) => {
    const p = isPlainObject(params) ? params : {};
    if (method === 'permission') {
      calls.push(`permission ${String(p.tool_name)} ${JSON.stringify(p.input).slice(0, 300)} -> denied (dry run)`);
      return { allow: false, message: 'Dry run: every permission request is denied.' };
    }
    if (method === 'request_approval') {
      calls.push(`request_approval ${JSON.stringify(p.reason)}`);
      return { ok: true, message: 'Noted (dry run).' };
    }
    if (method === 'reply') {
      const text = typeof p.text === 'string' ? p.text : '';
      const data = isPlainObject(p.data) ? p.data : null;
      const reasons = draftReasons({
        needsApproval: p.needs_approval === true,
        reason: typeof p.reason === 'string' ? p.reason : null,
        requested: null,
        approvalDuringRun: calls.some((c) => c.startsWith('permission')),
        text,
        data,
      });
      calls.push(`reply ${JSON.stringify(text.slice(0, 500))} -> ${reasons.length ? `would wait for approval: ${reasons.join('; ')}` : 'would be sent automatically'} (nothing sent: dry run)`);
      return { ok: true, message: 'Dry run: nothing was sent.' };
    }
    throw new Error(`unknown method ${method}`);
  });
  const runEnv = { ...plan.env };
  if (opts.offline) runEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${await closedPort()}`;
  out(opts.offline ? 'running offline (no model call)…' : 'running (this makes a model call)…');
  const result = await runChild({ bin: plan.bin, args: plan.args, cwd: plan.cwd, env: runEnv, stdin: plan.stdin, limitMs: 5 * 60_000 });
  await socket.close();
  rmSync(runDir, { recursive: true, force: true });
  out(`exit: ${result.code ?? result.signal}${result.timedOut ? ' (timed out)' : ''}`);
  for (const c of calls) out(`tool call: ${c}`);
  if (result.result) {
    const r = result.result;
    out(`result: type=${String(r.type)} subtype=${String(r.subtype)} is_error=${String(r.is_error)}`);
    if (typeof r.result === 'string') out(`result text: ${r.result.slice(0, 600)}`);
  } else {
    out('no JSON result on stdout');
    if (result.stderrTail) out(`stderr: ${redact(result.stderrTail).slice(-1500)}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`answer-dry-run: ${err instanceof Error ? err.message : 'failed'}\n`);
  process.exit(1);
});
