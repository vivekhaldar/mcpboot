// ABOUTME: Vitest test runner configuration.
// ABOUTME: Includes all test files under the test/ directory.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
