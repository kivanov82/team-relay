// `bin/console --open` (M2-SPEC §4.4, §7.7) without putting the key in any process argument.
//
// Every local user can read another process's arguments (ps), so the URL with its #k=<key>
// fragment is never passed to the opener. Instead a small HTML file that redirects to the
// URL is written, mode 600, into a fresh private directory (mkdtemp, mode 700), the opener is
// given that file's path, and the directory is removed after 10 s (or when this process exits,
// whichever comes first).

import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REDIRECT_TTL_MS = 10_000;
export const REDIRECT_FILE = 'console.html';

export type Run = (command: string, args: string[], done: (err: Error | null) => void) => void;

export type OpenOptions = {
  log: (message: string) => void;
  platform?: NodeJS.Platform;
  /** Where the private directory is made (default: the OS temp directory). */
  tmpRoot?: string;
  deleteAfterMs?: number;
  /** Runs the opener (default: execFile, argv only, never a shell). */
  run?: Run;
};

const defaultRun: Run = (command, args, done) => {
  execFile(command, args, { shell: false, timeout: 10_000 }, (err) => done(err));
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The redirect page: no script, no external request, no referrer. */
export function redirectHtml(url: string): string {
  const u = escapeHtml(url);
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="refresh" content="0;url=${u}">`,
    '<title>Team console</title></head>',
    `<body><p><a href="${u}">Open the team console</a></p></body></html>`,
    '',
  ].join('\n');
}

/** The platform's opener, or null where --open is not supported. */
export function openerFor(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return 'open';
  if (platform === 'linux') return 'xdg-open';
  return null;
}

/**
 * Open `url` in the default browser by way of a private redirect file. Returns the file's
 * path (for tests), or null when nothing was opened.
 */
export function openInBrowser(url: string, opts: OpenOptions): string | null {
  const opener = openerFor(opts.platform ?? process.platform);
  if (!opener) {
    opts.log('--open is not supported on this platform; open the URL above yourself');
    return null;
  }
  let dir: string;
  try {
    dir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), 'team-relay-console-'));
    chmodSync(dir, 0o700);
  } catch {
    opts.log('could not prepare the browser hand-off; open the URL above yourself');
    return null;
  }
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const file = join(dir, REDIRECT_FILE);
  try {
    writeFileSync(file, redirectHtml(url), { mode: 0o600, flag: 'wx' });
  } catch {
    cleanup();
    opts.log('could not prepare the browser hand-off; open the URL above yourself');
    return null;
  }
  process.once('exit', cleanup);
  setTimeout(() => {
    process.removeListener('exit', cleanup);
    cleanup();
  }, opts.deleteAfterMs ?? REDIRECT_TTL_MS).unref();
  (opts.run ?? defaultRun)(opener, [file], (err) => {
    if (err) opts.log(`could not open a browser (${opener}); open the URL above yourself`);
  });
  return file;
}
