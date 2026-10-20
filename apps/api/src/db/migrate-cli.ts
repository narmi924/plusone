import { loadEnv } from "../env.js";
import { createDb, runMigrations } from "./client.js";

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db);
await pool.end();
console.log("Migrations applied.");
