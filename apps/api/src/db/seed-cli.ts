import { loadEnv } from "../env.js";
import { createDb, runMigrations } from "./client.js";
import { seedDemo } from "./seed.js";

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db);
const sessionId = await seedDemo(db);
await pool.end();
console.log(`Seeded demo. Live session ${sessionId}`);
