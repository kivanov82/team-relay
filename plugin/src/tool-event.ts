// The answering session's PostToolUse / PostToolUseFailure hook (M2-SPEC §4.3) and its
// PermissionRequest hook (M4-SPEC §2: a `waiting` event while the member is asked):
//
//   node dist/tool-event.js --config $ANSWERER_HOME/tool-event.json   (exec form, bin/answerer)
//
// Reads the hook input from stdin, and when a request is open (active.json), posts the
// tool's name, outcome and duration to that request (§3.3). Never sends tool input or output.
// Always exits 0, and gives up after 3 s whatever is still pending: a tool event is a side
// surface and must never hold up or fail the answering session.

import { readFileSync } from 'node:fs';
import { mostRecentOpen } from './active.js';
import { makeLogger } from './log.js';
import { RelayClient, credentialTokenProvider, gcloudTokenProvider, tokenProviderFromEnv, type TokenProvider } from './relay-client.js';
import { parseToolEventConfig, toolEventFromPayload } from './tool-event-core.js';
import { describeError } from './tool-util.js';

const CAP_MS = 3000;
const STDIN_LIMIT = 16 * 1024 * 1024;
const started = Date.now();
const log = makeLogger('tool-event');

// Not unref'd: this is what ends the process if a read, gcloud or the relay hangs.
setTimeout(() => process.exit(0), CAP_MS);

/** Time left before the cap, keeping a margin to exit cleanly. */
const remaining = () => Math.max(50, CAP_MS - 250 - (Date.now() - started));

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

function configPath(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--config' || !argv[1]) throw new Error('usage: tool-event.js --config <file>');
  return argv[1];
}

async function run(): Promise<void> {
  const path = configPath(process.argv.slice(2));
  const raw = await readStdin();
  if (raw === null) return;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const event = toolEventFromPayload(payload);
  if (!event) return;
  const config = parseToolEventConfig(JSON.parse(readFileSync(path, 'utf8')));
  const requestId = mostRecentOpen(config.state_dir);
  if (!requestId) return; // Nothing open: a tool call outside any request is not reported.

  let token: TokenProvider;
  if (config.relay_auth === 'token') {
    token = tokenProviderFromEnv({ RELAY_TOKEN_FILE: config.token_file });
  } else if (config.relay_auth === 'credential') {
    // Bound to the relay and team the answering session was started for (M5-SPEC §6).
    token = credentialTokenProvider(config.credentials_file!, { relay_url: config.relay_url, team: config.relay_team });
  } else {
    token = gcloudTokenProvider({
      env: process.env,
      timeoutMs: remaining(),
      ...(config.gcloud_account !== undefined ? { account: config.gcloud_account } : {}),
    });
  }
  const client = new RelayClient({ url: config.relay_url, team: config.relay_team, token, attempts: 1, timeoutMs: remaining() });
  await client.toolEvent(requestId, event, { timeoutMs: remaining() });
}

run()
  .catch((err: unknown) => log(`tool event not recorded: ${describeError(err)}`))
  .finally(() => process.exit(0));
