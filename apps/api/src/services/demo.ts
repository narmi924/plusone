import { desc, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { liveSessions } from "../db/schema.js";
import { seedDemo } from "../db/seed.js";
import type { Realtime } from "../realtime.js";
import { getProducts, setShowcase } from "./catalog.js";

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

/**
 * Public demo without a host: while someone is watching and no seller console
 * or camera is on, put the next product on screen every so often, the way a
 * host moves through a drop. Visitors can then say "the dress just now".
 */
export function startDemoHost(deps: {
  db: Db;
  realtime: Realtime;
  log: FastifyBaseLogger;
  everyMs?: number;
}) {
  const { db, realtime, log } = deps;
  const tick = async () => {
    const [session] = await db
      .select()
      .from(liveSessions)
      .orderBy(desc(liveSessions.createdAt))
      .limit(1);
    if (session?.status !== "live") return;
    if (realtime.watching(session.id) === 0) return;
    if (realtime.hasSeller(session.id) || realtime.isVideoOn(session.id)) return;
    const products = (await getProducts(db, session.sellerId)).filter((p) =>
      p.variants.some((v) => v.available > 0),
    );
    if (products.length < 2) return;
    const at = products.findIndex((p) => p.id === session.currentProductId);
    const next = products[(at + 1) % products.length];
    if (!next) return;
    const result = await db.transaction((tx) => setShowcase(tx, session.id, next.id));
    realtime.showcase(session.id, result.productId, result.previousProductId);
    log.info({ product: next.code }, "demo host put the next product on screen");
  };
  const timer = setInterval(
    () => void tick().catch((err: unknown) => log.error({ err }, "demo host failed")),
    deps.everyMs ?? 90_000,
  );
  return () => clearInterval(timer);
}
