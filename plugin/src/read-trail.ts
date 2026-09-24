// The automatic answerer's read-trail hook (M8-SPEC §7 item 1; read-trail-core.ts):
//
//   node dist/read-trail.js --config <run dir>/read-trail.json   (exec form, the answerer's settings)
//
// Reads the hook input from stdin and reports the file read or searched (PreToolUse, Read and
// Grep) or a search's matches (PostToolUse / PostToolUseFailure, Grep) to the host over its
// private socket, authenticated with the run's token from the config file (mode 600, in the
// host's private directory, which the answerer itself may not read).
//
// PreToolUse fails closed: if the report cannot be made (no config, no host, a refusal, a
// timeout), it exits 2 and Claude Code does not run the tool. The Post events exit 0 whatever
// happens: the host then still counts the search as open, and the draft waits.

import { readFileSync } from 'node:fs';
import { HostSocketClient } from './host-socket.js';
import { trailReport } from './read-trail-core.js';
import { describeError, isPlainObject } from './tool-util.js';

const CAP_MS = 8000;
const STDIN_LIMIT = 16 * 1024 * 1024;
let blocking = true;

function finish(ok: boolean, why?: string): never {
  if (!ok && blocking) {
    process.stderr.write(`team relay: this read could not be recorded (${why ?? 'unknown'}), so it is not allowed\n`);
    process.exit(2);
  }
  process.exit(0);
}

// Not unref'd: this is what ends the process if the host hangs.
setTimeout(() => finish(false, 'the host did not answer in time'), CAP_MS);

function readStdin(): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on('data', (c: Buffer) => {
      size += c.length;
      if (size > STDIN_LIMIT) {
        process.stdin.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(null));
  });
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const raw = await readStdin();
  let payload: unknown = null;
  try {
    payload = raw === null ? null : JSON.parse(raw);
  } catch {
    payload = null;
  }
  // Only a PreToolUse input can be blocked; an input that is not JSON is treated as one.
  blocking = !isPlainObject(payload) || payload.hook_event_name === 'PreToolUse';
  if (argv.length !== 2 || argv[0] !== '--config' || !argv[1]) finish(false, 'usage: read-trail.js --config <file>');
  if (raw === null || payload === null) finish(false, 'the hook input was not JSON');
  const report = trailReport(payload);
  if (!report) finish(true);
  let cfg: { socket?: unknown; token?: unknown };
  try {
    cfg = JSON.parse(readFileSync(argv[1]!, 'utf8')) as typeof cfg;
  } catch (err) {
    finish(false, `its config could not be read: ${describeError(err)}`);
  }
  if (typeof cfg.socket !== 'string' || typeof cfg.token !== 'string') finish(false, 'its config is incomplete');
  const host = await HostSocketClient.connect(cfg.socket, cfg.token);
  try {
    const res = await host.call('trail', report);
    if (!isPlainObject(res) || res.ok !== true) finish(false, 'the host refused it');
  } finally {
    host.close();
  }
  finish(true);
}

run().catch((err: unknown) => finish(false, describeError(err)));
