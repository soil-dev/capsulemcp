import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Runs before every test file's beforeEach. Currently only used
    // to clear the per-process reference-data cache between tests so
    // a cached response from one test doesn't make the next "skip"
    // its expected fetch. See tests/setup.ts for the full reason.
    setupFiles: ["./tests/setup.ts"],
  },
});
