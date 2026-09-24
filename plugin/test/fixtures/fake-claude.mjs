// Plays a `claude` process for the channel-mode tests. The tests start it through a symlink
// named `claude` that points at node, so its argv[0] is `claude` and the rest of its argv is
// whatever flags the test is about. It runs `node <FAKE_CLAUDE_CHILD>` (a plugin bundle) with
// stdio inherited, as Claude Code runs a plugin's MCP server or hook, and exits with it.
// FAKE_CLAUDE_NODE is the real node binary.

import { spawn } from 'node:child_process';

const env = { ...process.env };
delete env.FAKE_CLAUDE_CHILD;
delete env.FAKE_CLAUDE_NODE;
const child = spawn(process.env.FAKE_CLAUDE_NODE, [process.env.FAKE_CLAUDE_CHILD], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
