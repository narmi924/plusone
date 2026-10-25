import type { ReplayClip } from "@plusone/shared";
import { desc, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { liveSessions } from "../db/schema.js";
import { seedDemo } from "../db/seed.js";
import type { Realtime } from "../realtime.js";
import { getProducts, setShowcase } from "./catalog.js";
import { clipAt } from "./replay.js";

// Public demo: once a visitor has been and gone, put the shop back the way the
// next one should find it: a live in progress, full stock, an empty book.

const IDLE_MS = 30 * 60_000;
const ENDED_IDLE_MS = 10 * 60_000;

export function startDemoKeeper(deps: {
  db: Db;
  log: FastifyBaseLogger;
  onReset: () => void;
  /** Someone is hosting right now (console open or camera on): don't reset under them. */
  hosting: () => Promise<boolean>;
  /** Runs before the shop is wiped (e.g. cancel open PayPal invoices). */
  beforeReset?: () => Promise<void>;
  everyMs?: number;
}) {
  const { db, log } = deps;
  const tick = async () => {
    if (await deps.hosting()) return;
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
    await deps.beforeReset?.();
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
  /** Recorded host clips: when present the replay drives what's on screen. */
  replay?: ReplayClip[] | null;
  everyMs?: number;
}) {
  const { db, realtime, log } = deps;
  if (deps.replay) return startReplay({ db, realtime, log, clips: deps.replay });
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

/** How long a product put on screen by hand keeps the replay paused. */
const MANUAL_PAUSE_MS = 2 * 60_000;

/**
 * The recorded host plays whenever nobody is hosting: no camera on and no
 * product put on screen by hand in the last two minutes. Every second, the
 * product the current clip shows goes on screen if it isn't already.
 */
function startReplay(deps: {
  db: Db;
  realtime: Realtime;
  log: FastifyBaseLogger;
  clips: ReplayClip[];
}) {
  const { db, realtime, log, clips } = deps;
  let codes = new Map<string, string>();
  let codesAt = 0;
  const tick = async () => {
    const [session] = await db
      .select()
      .from(liveSessions)
      .orderBy(desc(liveSessions.createdAt))
      .limit(1);
    if (!session) return;
    const on =
      session.status === "live" &&
      !realtime.isVideoOn(session.id) &&
      Date.now() - realtime.manualShowcaseAt(session.id) > MANUAL_PAUSE_MS;
    realtime.setReplay(session.id, on);
    if (!on || realtime.watching(session.id) === 0) return;

    if (Date.now() - codesAt > 60_000) {
      codes = new Map((await getProducts(db, session.sellerId)).map((p) => [p.code, p.id]));
      codesAt = Date.now();
    }
    const productId = codes.get(clipAt(clips, Date.now()).clip.product);
    if (!productId || productId === session.currentProductId) return;
    const result = await db.transaction((tx) => setShowcase(tx, session.id, productId));
    realtime.showcase(session.id, result.productId, result.previousProductId, { byReplay: true });
  };
  log.info({ clips: clips.length }, "replay: the recorded host plays when nobody is hosting");
  const timer = setInterval(
    () => void tick().catch((err: unknown) => log.error({ err }, "replay failed")),
    1_000,
  );
  return () => clearInterval(timer);
}
