import { defineConfig } from "vitest/config";

// `pnpm eval`: runs the AI test set against the real model (costs a few cents).
// Kept apart from `pnpm test` so ordinary test runs never call the API.
process.loadEnvFile?.("../../.env");

export default defineConfig({
  test: {
    include: ["src/**/*.eval.ts"],
    testTimeout: 90_000,
  },
});
