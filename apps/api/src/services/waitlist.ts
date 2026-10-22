import type { StockChange, WaitingDTO } from "@plusone/shared";
import { and, asc, count, eq, lte, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { buyers, liveSessions, products, sellers, variants, waitlist } from "../db/schema.js";
import { holdItem, openOrderFor } from "./orders.js";

// Sold out isn't the end: buyers who asked for an item that's gone wait in line
// for that exact item, and when one comes back (a cancel, a hold that ran out, a
// refund) it goes straight to whoever has waited longest. Nobody has to watch
// the chat for it.

/** Puts the buyer in line for a variant (once). Returns their place in line. */
export async function joinWaitlist(
  tx: Tx,
  input: {
    sessionId: string;
    variantId: string;
    buyerId: string;
    qty: number;
    condition?: string | null;
    sourceMessageId?: string;
  },
): Promise<number> {
  const mine = and(
    eq(waitlist.sessionId, input.sessionId),
    eq(waitlist.variantId, input.variantId),
    eq(waitlist.status, "waiting"),
  );
  let [entry] = await tx
    .select()
    .from(waitlist)
    .where(and(mine, eq(waitlist.buyerId, input.buyerId)));
  if (!entry) {
    [entry] = await tx
      .insert(waitlist)
      .values({
        sessionId: input.sessionId,
        variantId: input.variantId,
        buyerId: input.buyerId,
        qty: input.qty,
        condition: input.condition ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
      })
      .returning();
  }
  if (!entry) throw new Error("Could not join the waitlist");
  const [ahead] = await tx
    .select({ n: count() })
    .from(waitlist)
    // Compare in SQL: Postgres keeps microseconds, a JS Date only milliseconds.
    .where(
      and(
        mine,
        lte(waitlist.createdAt, sql`(SELECT created_at FROM waitlist WHERE id = ${entry.id})`),
      ),
    );
  return ahead?.n ?? 1;
}

export interface WaitlistOffer {
  buyerId: string;
  orderId: string;
  variantId: string;
  qty: number;
  stock: StockChange;
}

/**
 * Stock came back for a variant: hold it for whoever has waited longest (as many
 * as fit). Runs inside the caller's transaction, so the freed item can't be
 * grabbed by a chat message in between.
 */
export async function offerFreedStock(
  tx: Tx,
  sessionId: string,
  variantId: string,
): Promise<WaitlistOffer[]> {
  const [session] = await tx
    .select({ sellerId: liveSessions.sellerId, holdMinutes: sellers.holdMinutes })
    .from(liveSessions)
    .innerJoin(sellers, eq(sellers.id, liveSessions.sellerId))
    .where(eq(liveSessions.id, sessionId));
  if (!session) return [];

  const offers: WaitlistOffer[] = [];
  for (;;) {
    const [variant] = await tx
      .select()
      .from(variants)
      .where(eq(variants.id, variantId))
      .for("update");
    if (!variant || variant.available <= 0) break;

    const [next] = await tx
      .select()
      .from(waitlist)
      .where(
        and(
          eq(waitlist.sessionId, sessionId),
          eq(waitlist.variantId, variantId),
          eq(waitlist.status, "waiting"),
          lte(waitlist.qty, variant.available),
        ),
      )
      .orderBy(asc(waitlist.createdAt))
      .limit(1)
      .for("update");
    if (!next) break;

    const order = await openOrderFor(tx, {
      sessionId,
      buyerId: next.buyerId,
      sellerId: session.sellerId,
    });
    const hold = await holdItem(tx, {
      order,
      variantId,
      qty: next.qty,
      holdMinutes: session.holdMinutes,
      fromWaitlist: true,
      ...(next.sourceMessageId ? { sourceMessageId: next.sourceMessageId } : {}),
    });
    await tx.update(waitlist).set({ status: "filled" }).where(eq(waitlist.id, next.id));
    offers.push({
      buyerId: next.buyerId,
      orderId: order.id,
      variantId,
      qty: next.qty,
      stock: hold.stock,
    });
  }
  return offers;
}

/** The buyer's own place in line, for "cancel" and for PlusOne's context. */
export async function leaveWaitlist(tx: Tx, entryId: string) {
  await tx.update(waitlist).set({ status: "cancelled" }).where(eq(waitlist.id, entryId));
}

/** Everyone waiting in this session, in line order per item, for the seller's book. */
export async function listWaiting(tx: Tx, sessionId: string): Promise<WaitingDTO[]> {
  const rows = await tx
    .select({
      id: waitlist.id,
      variantId: waitlist.variantId,
      buyerName: buyers.name,
      condition: waitlist.condition,
      product: products.name,
      color: variants.color,
      size: variants.size,
    })
    .from(waitlist)
    .innerJoin(buyers, eq(buyers.id, waitlist.buyerId))
    .innerJoin(variants, eq(variants.id, waitlist.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(waitlist.sessionId, sessionId), eq(waitlist.status, "waiting")))
    .orderBy(asc(waitlist.createdAt));
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const position = (seen.get(r.variantId) ?? 0) + 1;
    seen.set(r.variantId, position);
    const option = [r.color, r.size].filter(Boolean).join(" ");
    return {
      id: r.id,
      buyerName: r.buyerName,
      item: option ? `${r.product}, ${option}` : r.product,
      position,
      condition: r.condition,
    };
  });
}
