import type { StockChange } from "@plusone/shared";
import { eq } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { stockMoves, variants } from "../db/schema.js";

export type StockMoveKind = (typeof stockMoves.$inferInsert)["kind"];

/** How each kind of move shifts the three counters. */
const EFFECT: Record<StockMoveKind, { available: number; reserved: number; sold: number }> = {
  restock: { available: 1, reserved: 0, sold: 0 },
  reserve: { available: -1, reserved: 1, sold: 0 },
  release: { available: 1, reserved: -1, sold: 0 },
  sell: { available: 0, reserved: -1, sold: 1 },
  refund: { available: 1, reserved: 0, sold: -1 },
  // Seller takes items off sale (damaged, sold elsewhere). Increases are `restock`.
  adjust: { available: -1, reserved: 0, sold: 0 },
};

export class OutOfStockError extends Error {
  constructor(
    readonly variantId: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(`Only ${available} left, ${requested} requested`);
  }
}

/**
 * The only way stock changes. Must run inside a transaction: the variant row is
 * locked first, so two buyers racing for the last item are applied one after the
 * other and only one of them gets it.
 */
export async function moveStock(
  tx: Tx,
  variantId: string,
  kind: StockMoveKind,
  qty: number,
  opts: { orderLineId?: string; note?: string } = {},
): Promise<StockChange> {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Invalid stock quantity ${qty}`);

  const [row] = await tx.select().from(variants).where(eq(variants.id, variantId)).for("update");
  if (!row) throw new Error(`Variant ${variantId} not found`);

  const effect = EFFECT[kind];
  const next = {
    available: row.available + effect.available * qty,
    reserved: row.reserved + effect.reserved * qty,
    sold: row.sold + effect.sold * qty,
  };
  if (next.available < 0) throw new OutOfStockError(variantId, qty, row.available);
  if (next.reserved < 0 || next.sold < 0) {
    throw new Error(`Stock move ${kind} x${qty} would make counters negative for ${row.sku}`);
  }

  await tx.update(variants).set(next).where(eq(variants.id, variantId));
  await tx.insert(stockMoves).values({
    variantId,
    kind,
    qty,
    orderLineId: opts.orderLineId ?? null,
    note: opts.note ?? null,
  });

  return { variantId, ...next };
}
