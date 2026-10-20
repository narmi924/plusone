import { pino } from "pino";
import { createDb } from "./db/client.js";
import { loadEnv } from "./env.js";
import { buildJobDeps } from "./jobs/deps.js";
import { provideJobDeps } from "./jobs/tasks.js";

// Entry point of the Render Workflows service. Importing the tasks registers
// them; the Render SDK then runs whichever one this process was started for.
// Each run is its own process, so the database pool is opened per run and
// closed at the end, and nothing here may wait at the top level.

const env = loadEnv();
const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

provideJobDeps(async () => {
  const { db, pool } = createDb(env.DATABASE_URL);
  const { deps, flush } = buildJobDeps({ db, env, log });
  return {
    deps,
    done: async () => {
      await flush();
      await pool.end();
    },
  };
});
