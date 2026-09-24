// The M1 end-to-end gate (docs/M1-SPEC.md §9). Run it through ../scripts/e2e.sh, which
// starts the Firestore emulator and the relay, builds dist/, and sets E2E=1, RELAY_URL
// and the E2E_TOKEN_* values. Without E2E=1 the suite is skipped.
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { defineConfig } from 'vitest/config';

/**
 * The files run in name order (m1, m2, m5, ...), every time: the scenarios share one relay
 * and team, and the M1 checks read streams as a fresh team has them (bob has asked nothing
 * yet), which the later milestones' scenarios change.
 */
class ByName extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    // One set of member processes per stream: never two files at once.
    fileParallelism: false,
    sequence: { sequencer: ByName },
    setupFiles: ['test/helpers/isolate.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
