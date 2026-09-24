// `node dist/answering-lock-info.js`: who answers for the member on this computer
// (M8-SPEC §1), for bin/answerer to check before it starts a manual answering session.
// Exit 0: nobody (the lock is free or stale). Exit 3: held; prints {"pid", "role"} on stdout.

import { lockPath, readLock } from './answering-lock.js';

function main(): number {
  if (process.argv.length > 2) {
    process.stderr.write('usage: answering-lock-info.js\n');
    return 2;
  }
  const holder = readLock(lockPath(process.env));
  if (!holder) return 0;
  process.stdout.write(`${JSON.stringify({ pid: holder.pid, role: holder.role })}\n`);
  return 3;
}

process.exitCode = main();
