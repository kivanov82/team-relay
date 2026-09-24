// The answering session's Notification hook (M4-SPEC §2):
//
//   node dist/notify-desktop.js   (exec form, "async": true, matcher permission_prompt; bin/answerer)
//
// When Claude Code is waiting for the member to allow something in the answering session
// (a Read, Glob or Grep outside the shared folders), this shows a local desktop notification
// with a FIXED text, so the member knows to look at that terminal. Nothing from the hook
// payload, and nothing a teammate wrote, ever reaches the notification: the payload is read
// only to check that it is a permission prompt (`notification_type`, checked against
// code.claude.com/docs/en/hooks on 24 Sep 2026), and the command's arguments are constants.
// macOS: `osascript -e 'display notification …'`; Linux: `notify-send`, when present; any
// other platform: nothing. Always exits 0, and gives up after 3 s.

import { execFile } from 'node:child_process';

export const NOTICE_TITLE = 'Team relay';
export const NOTICE_TEXT = 'Team relay: your answering session is waiting for your permission';

const CAP_MS = 3000;
const STDIN_LIMIT = 1024 * 1024;

/** M8-SPEC §4: the host's notice when an answer waits for the member's approval. */
export const APPROVAL_TEXT = 'Team relay: an answer is waiting for your approval';
/** M8-SPEC §7 item 4: the host's notice when a session takes over answering. */
export const TAKEOVER_TEXT = 'Team relay: this session now answers teammates automatically';
const TEXTS = [NOTICE_TEXT, APPROVAL_TEXT, TAKEOVER_TEXT] as const;
export type NoticeText = (typeof TEXTS)[number];

/**
 * The command that shows `text` (one of the fixed notices, nothing else) on `platform`, or null
 * where there is none.
 */
export function notifyCommand(platform: NodeJS.Platform, text: NoticeText = NOTICE_TEXT): { file: string; args: string[] } | null {
  if (!(TEXTS as readonly string[]).includes(text)) return null;
  if (platform === 'darwin') {
    return { file: 'osascript', args: ['-e', `display notification "${text}" with title "${NOTICE_TITLE}"`] };
  }
  if (platform === 'linux') return { file: 'notify-send', args: [NOTICE_TITLE, text] };
  return null;
}

/** A Notification hook input for a permission prompt; anything else is not. */
export function isPermissionPrompt(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const p = payload as { hook_event_name?: unknown; notification_type?: unknown };
  return p.hook_event_name === 'Notification' && p.notification_type === 'permission_prompt';
}

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
  const raw = await readStdin();
  if (raw === null) return;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isPermissionPrompt(payload)) return;
  const cmd = notifyCommand(process.platform);
  if (!cmd) return;
  // No shell: the arguments are passed as they are. A missing notify-send is not an error.
  await new Promise<void>((resolve) => {
    execFile(cmd.file, cmd.args, { timeout: CAP_MS - 500, windowsHide: true }, () => resolve());
  });
}

if (process.argv[1] && /notify-desktop\.(js|ts)$/.test(process.argv[1])) {
  // Not unref'd: this is what ends the process if the notifier hangs.
  setTimeout(() => process.exit(0), CAP_MS);
  run()
    .catch(() => {})
    .finally(() => process.exit(0));
}
