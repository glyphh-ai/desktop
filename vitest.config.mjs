import { defineConfig } from 'vitest/config';

// Scoped to the web target's tests for now. glyphh-core is pure (globals are
// injected), so a plain node environment is enough — no jsdom needed. As the
// web bridge grows we can add a happy-dom project for DOM-touching units.
export default defineConfig({
  test: {
    include: ['web/test/**/*.test.js'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['web/src/**/*.js'],
      // Match the SDK's bar.
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 75 },
    },
  },
});
