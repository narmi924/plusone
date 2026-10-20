import type { StockChange } from "@plusone/shared";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { orderLines, orders, payments } from "../db/schema.js";
import type { Notifier } from "./notify.js";
import { recalcOrder } from "./orders.js";
import { moveStock } from "./stock.js";
import { offerFreedStock, type WaitlistOffer } from "./waitlist.js";

// Unpaid holds run out: the item goes back on sale, or straight to the next
// person waiting for it. A buyer who is in the PayPal window right now gets a
// few extra minutes so the hold doesn't vanish mid-payment.

const CHECKOUT_GRACE_MS = 5 * 60_000;

type Released = {
  sessionId: string;
  buyerId: string;
  orderId: string;
  variantId: string;
  stock: StockChange;
  offers: WaitlistOffer[];
};

export async function releaseExpiredHolds(db: Db, now = new Date()): Promise<Released[]> {
  const inCheckout = db
    .select({ orderId: payments.orderId })
    .from(payments)
    .where(
      and(
        eq(payments.status, "created"),
        gt(payments.createdAt, new Date(now.getTime() - CHECKOUT_GRACE_MS)),
      ),
    );

  const due = await db
    .select({ id: orderLines.id })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(
      and(
        eq(orderLines.status, "held"),
        lt(orderLines.holdExpiresAt, now),
        sql`${orders.id} NOT IN ${inCheckout}`,
      ),
    );

  const released: Released[] = [];
  for (const { id } of due) {
    const result = await db.transaction(async (tx) => {
      const [line] = await tx.select().from(orderLines).where(eq(orderLines.id, id)).for("update");
      if (line?.status !== "held") return null; // paid or cancelled meanwhile
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, line.orderId))
        .for("update");
      if (!order) return null;

      const stock = await moveStock(tx, line.variantId, "release", line.qty, {
        orderLineId: line.id,
        note: "hold ran out",
      });
      await tx
        .update(orderLines)
        .set({ status: "released", holdExpiresAt: null })
        .where(eq(orderLines.id, line.id));

      const remaining = await tx
        .select({ id: orderLines.id })
        .from(orderLines)
        .where(and(eq(orderLines.orderId, order.id), inArray(orderLines.status, ["held", "paid"])));
      if (remaining.length === 0 && (order.status === "reserved" || order.status === "draft")) {
        await tx
          .update(orders)
          .set({ status: "cancelled", cancelledAt: now })
          .where(eq(orders.id, order.id));
      }
      await recalcOrder(tx, order.id);

      const offers = await offerFreedStock(tx, order.sessionId, line.variantId);
      return {
        sessionId: order.sessionId,
        buyerId: order.buyerId,
        orderId: order.id,
        variantId: line.variantId,
        stock,
        offers,
      };
    });
    if (result) released.push(result);
  }
  return released;
}

/** Checks for run-out holds every few seconds. Returns a stop function. */
export function startHoldSweeper(deps: {
  db: Db;
  notify: Notifier;
  log: FastifyBaseLogger;
  /** Called after an order's hold ran out (e.g. cancel its open invoice). */
  onReleased?: (orderId: string) => Promise<void>;
  everyMs?: number;
}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const r of await releaseExpiredHolds(deps.db)) {
        deps.notify.stock(r.sessionId, [r.stock]);
        await deps.notify.orders([r.orderId]);
        await deps.notify.holdEnded(r.sessionId, r.buyerId, r.variantId);
        await deps.notify.waitlistOffers(r.sessionId, r.offers);
        await deps.onReleased?.(r.orderId);
      }
    } catch (err) {
      deps.log.error({ err }, "releasing expired holds failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.everyMs ?? 5_000);
  return () => clearInterval(timer);
}
