import { createRequire as __teamRelayCreateRequire } from 'node:module'; const require = __teamRelayCreateRequire(import.meta.url);

// src/notify-desktop.ts
import { execFile } from "node:child_process";
var NOTICE_TITLE = "Team relay";
var NOTICE_TEXT = "Team relay: your answering session is waiting for your permission";
var CAP_MS = 3e3;
var STDIN_LIMIT = 1024 * 1024;
var APPROVAL_TEXT = "Team relay: an answer is waiting for your approval";
var TAKEOVER_TEXT = "Team relay: this session now answers teammates automatically";
var TEXTS = [NOTICE_TEXT, APPROVAL_TEXT, TAKEOVER_TEXT];
function notifyCommand(platform, text = NOTICE_TEXT) {
  if (!TEXTS.includes(text)) return null;
  if (platform === "darwin") {
    return { file: "osascript", args: ["-e", `display notification "${text}" with title "${NOTICE_TITLE}"`] };
  }
  if (platform === "linux") return { file: "notify-send", args: [NOTICE_TITLE, text] };
  return null;
}
function isPermissionPrompt(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const p = payload;
  return p.hook_event_name === "Notification" && p.notification_type === "permission_prompt";
}
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (c) => {
      size += c.length;
      if (size > STDIN_LIMIT) {
        process.stdin.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(null));
  });
}
async function run() {
  const raw = await readStdin();
  if (raw === null) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isPermissionPrompt(payload)) return;
  const cmd = notifyCommand(process.platform);
  if (!cmd) return;
  await new Promise((resolve) => {
    execFile(cmd.file, cmd.args, { timeout: CAP_MS - 500, windowsHide: true }, () => resolve());
  });
}
if (process.argv[1] && /notify-desktop\.(js|ts)$/.test(process.argv[1])) {
  setTimeout(() => process.exit(0), CAP_MS);
  run().catch(() => {
  }).finally(() => process.exit(0));
}
export {
  APPROVAL_TEXT,
  NOTICE_TEXT,
  NOTICE_TITLE,
  TAKEOVER_TEXT,
  isPermissionPrompt,
  notifyCommand
};
