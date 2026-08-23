import { defineConfig } from "vitest/config";

// Several suites do real work rather than pure computation: pipeline.test.ts and
// edgeCases.test.ts bind real sockets and make real HTTP requests to a local
// receiver, and the auth suites run bcrypt. Vitest runs test files in parallel,
// so on a busy machine those compete for CPU and a test that normally finishes in
// 200ms can take several seconds — overshooting the 5s default and failing for
// reasons that have nothing to do with the behaviour under test.
//
// A timeout exists to catch a hang, not to assert performance. Raising it makes
// the suite deterministic under load without weakening a single assertion, and
// costs nothing on a passing run.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
