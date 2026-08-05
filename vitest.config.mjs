import { defineConfig } from 'vitest/config';

// Scoped to the web target's tests for now. glyphh-core is pure (globals are
// injected), so a plain node environment is enough — no jsdom needed. As the
// web bridge grows we can add a happy-dom project for DOM-touching units.
export default defineConfig({
  test: {
    // Web-target JS units + the pure main-process panel units (transport
    // decision, signaling validation, ffmpeg argv — no Electron, no browser).
    include: ['web/test/**/*.test.js', 'test/main/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['web/src/**/*.js'],
      // Match the SDK's bar.
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 75 },
    },
  },
});
