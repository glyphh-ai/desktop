import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every integration file signs a user in, which creates an org, which provisions
    // that org a schema in the stator. This drops exactly what the run created, once,
    // after every file has finished — see test/helpers/global-teardown.ts for why the
    // sweep cannot live in a per-file hook.
    globalSetup: ["test/helpers/global-teardown.ts"],
    // This suite drives a REAL server over HTTP — and some paths (app release upload)
    // reach further still, to object storage. In isolation those take ~1s, but 42 files
    // run in parallel against one server and the slowest legitimately spike past
    // vitest's 5s default. Budget for real I/O rather than let load flake the build.
    testTimeout: 30_000,
    // The sweep drops ~80 org schemas (~40 tables each) and vacuums the catalogs.
    teardownTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/contract/**"],
      // Enterprise baseline: fail the build if coverage regresses.
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
