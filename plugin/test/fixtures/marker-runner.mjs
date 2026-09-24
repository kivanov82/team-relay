#!/usr/bin/env node
// Test runner: records that it started by creating a file next to itself.
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./started', import.meta.url), 'started\n');
process.stdout.write('{"ok":true}');
