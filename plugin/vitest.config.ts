import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The end-to-end gate needs a relay and an emulator: `pnpm test:e2e` via scripts/e2e.sh.
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
    globalSetup: ['test/helpers/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
