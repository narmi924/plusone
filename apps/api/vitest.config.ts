import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The database tests share one test database and reset it, so one file at a time.
    fileParallelism: false,
  },
});
