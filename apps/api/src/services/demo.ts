import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { seedDemo } from "../db/seed.js";

// Public demo: once a visitor has been and gone, put the shop back the way the
// next one should find it: a live in progress, full stock, an empty book.

const IDLE_MS = 30 * 60_000;
const ENDED_IDLE_MS = 10 * 60_000;

export function startDemoKeeper(deps: {
  db: Db;
  log: FastifyBaseLogger;
  onReset: () => void;
  everyMs?: number;
}) {
  const { db, log } = deps;
  const tick = async () => {
    const { rows } = await db.execute<{ last: Date | string | null; ended: boolean }>(sql`
      select greatest(
        (select max(created_at) from chat_messages),
        (select max(updated_at) from orders),
        (select max(ended_at) from live_sessions)
      ) as last,
      exists(select 1 from live_sessions where status = 'ended') as ended
    `);
    const row = rows[0];
    if (!row?.last) return; // untouched since the last reset
    const idle = Date.now() - new Date(row.last).getTime();
    if (idle < (row.ended ? ENDED_IDLE_MS : IDLE_MS)) return;
    await seedDemo(db);
    log.info({ idleMinutes: Math.round(idle / 60_000) }, "demo reset after a quiet spell");
    deps.onReset();
  };
  const timer = setInterval(
    () => void tick().catch((err: unknown) => log.error({ err }, "demo reset failed")),
    deps.everyMs ?? 60_000,
  );
  return () => clearInterval(timer);
}
