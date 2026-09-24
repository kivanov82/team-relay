#!/usr/bin/env node
// Test runner: prints a JSON value larger than 64 KiB.
process.stdout.write(JSON.stringify({ blob: 'x'.repeat(70 * 1024) }));
