// The M1 end-to-end gate (docs/M1-SPEC.md §9). Run it through ../scripts/e2e.sh, which
// starts the Firestore emulator and the relay, builds dist/, and sets E2E=1, RELAY_URL
// and the E2E_TOKEN_* values. Without E2E=1 the suite is skipped.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    // One set of member processes per stream: never two files at once.
    fileParallelism: false,
    setupFiles: ['test/helpers/isolate.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
