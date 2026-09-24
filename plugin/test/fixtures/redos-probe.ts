// ReDoS regression probe, run in a child process by test/manifest.test.ts so that a
// regression to a backtracking engine fails on a kill timeout instead of hanging vitest.
// Prints one JSON line: what the manifest check and the param check decided.
import { validateManifest, validateParams } from '../../src/manifest.js';

const manifest = validateManifest({
  version: 1,
  capabilities: [
    {
      name: 'evil',
      title: 'Catastrophic pattern',
      description: 'A pattern that backtracks exponentially in a backtracking engine.',
      environment: 'staging',
      params: {
        pa: { type: 'string', max_length: 500, pattern: '^(a+)+$', description: 'x' },
        pb: { type: 'string', max_length: 500, pattern: '^(x+x+)+y$', description: 'x' },
        pc: { type: 'string', max_length: 500, pattern: '^((((a*)*)*)*)*$', description: 'x' },
      },
    },
  ],
});
const cap = manifest.capabilities[0]!;
const started = Date.now();
const results = [
  validateParams(cap, { pa: `${'a'.repeat(499)}!` }).ok,
  validateParams(cap, { pb: 'x'.repeat(500) }).ok,
  validateParams(cap, { pc: `${'a'.repeat(499)}b` }).ok,
  validateParams(cap, { pa: 'a'.repeat(500) }).ok,
];
process.stdout.write(`${JSON.stringify({ results, ms: Date.now() - started })}\n`);
