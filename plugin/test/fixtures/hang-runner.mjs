#!/usr/bin/env node
// Test runner: ignores SIGTERM and never finishes, so only SIGKILL stops it.
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
