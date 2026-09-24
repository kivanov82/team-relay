#!/usr/bin/env node
// Test runner: reports the environment and the stdin line it was given.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ env: process.env, argv: process.argv.slice(2), stdin: input }));
});
