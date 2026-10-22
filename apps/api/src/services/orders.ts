import type { OrderDTO, StockChange } from "@plusone/shared";
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import {
  buyers,
  invoices,
  orderLines,
  orders,
  payments,
  products,
  rules,
  sellers,
  shipments,
  variants,
} from "../db/schema.js";
import { moveStock } from "./stock.js";

type OrderRow = typeof orders.$inferSelect;

const OPEN_STATUSES = ["draft", "reserved"] as const;
/** Lines that count towards what the buyer owes. */
const BILLABLE = ["held", "paid"] as const;

/**
 * With auto-pay on, PlusOne pays for what the buyer said this long after the
 * order last changed, so "actually make it L" lands before the money moves.
 */
export const AUTOPAY_AFTER_MS = 15_000;

/** How much auto-pay may still spend for this buyer in this live. */
export async function autopayRoom(
  tx: Tx,
  buyer: Pick<typeof buyers.$inferSelect, "id" | "autopaySessionId" | "autopayLimitCents">,
  sessionId: string,
): Promise<number> {
  if (buyer.autopaySessionId !== sessionId || !buyer.autopayLimitCents) return 0;
  const [spent] = await tx
    .select({ cents: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(
      and(
        eq(orders.sessionId, sessionId),
        eq(orders.buyerId, buyer.id),
        eq(payments.via, "auto"),
        inArray(payments.status, ["created", "approved", "captured", "partially_refunded"]),
      ),
    );
  return buyer.autopayLimitCents - (spent?.cents ?? 0);
}

/** The buyer's open order in this session, created on first use. Locked for the rest of the transaction. */
export async function openOrderFor(
  tx: Tx,
  input: { sessionId: string; buyerId: string; sellerId: string },
): Promise<OrderRow> {
  const find = () =>
    tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.sessionId, input.sessionId),
          eq(orders.buyerId, input.buyerId),
          inArray(orders.status, [...OPEN_STATUSES]),
        ),
      )
      .for("update");

  const [existing] = await find();
  if (existing) return existing;

  const [seller] = await tx.select().from(sellers).where(eq(sellers.id, input.sellerId));
  await tx
    .insert(orders)
    .values({ ...input, status: "draft", currency: seller?.currency ?? "USD" })
    .onConflictDoNothing();
  const [created] = await find();
  if (!created) throw new Error("Could not open an order");
  return created;
}

/** Holds `qty` of a variant for the buyer. Throws OutOfStockError when there isn't enough. */
export async function holdItem(
  tx: Tx,
  input: {
    order: OrderRow;
    variantId: string;
    qty: number;
    holdMinutes: number;
    /** Keep an existing deadline instead of starting a new one (used when swapping an item). */
    holdExpiresAt?: Date | null;
    sourceMessageId?: string;
    /** Handed over from the waitlist: the buyer pays for it themselves. */
    fromWaitlist?: boolean;
  },
): Promise<{ lineId: string; stock: StockChange }> {
  const [variant] = await tx
    .select({ variantPrice: variants.priceCents, productPrice: products.priceCents })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(variants.id, input.variantId));
  if (!variant) throw new Error(`Variant ${input.variantId} not found`);

  const holdExpiresAt = input.holdExpiresAt ?? new Date(Date.now() + input.holdMinutes * 60_000);
  const [line] = await tx
    .insert(orderLines)
    .values({
      orderId: input.order.id,
      variantId: input.variantId,
      qty: input.qty,
      unitPriceCents: variant.variantPrice ?? variant.productPrice,
      status: "held",
      holdExpiresAt,
      sourceMessageId: input.sourceMessageId ?? null,
      fromWaitlist: input.fromWaitlist ?? false,
    })
    .returning({ id: orderLines.id });
  if (!line) throw new Error("Could not add order line");

  // Reserve after inserting the line so the stock move can point at it; an
  // OutOfStockError rolls both back together.
  const stock = await moveStock(tx, input.variantId, "reserve", input.qty, {
    orderLineId: line.id,
  });

  await tx.update(orders).set({ status: "reserved" }).where(eq(orders.id, input.order.id));
  await recalcOrder(tx, input.order.id);
  return { lineId: line.id, stock };
}

export class LineNotHeldError extends Error {
  constructor(readonly status: string) {
    super(`Line is ${status}, not held`);
  }
}

/** Gives a held item back to stock. Paid items go through a refund instead. */
export async function cancelLine(
  tx: Tx,
  lineId: string,
): Promise<{ orderId: string; stock: StockChange }> {
  const [line] = await tx.select().from(orderLines).where(eq(orderLines.id, lineId)).for("update");
  if (!line) throw new Error(`Line ${lineId} not found`);
  if (line.status !== "held") throw new LineNotHeldError(line.status);

  const stock = await moveStock(tx, line.variantId, "release", line.qty, {
    orderLineId: line.id,
    note: "buyer cancelled",
  });
  await tx
    .update(orderLines)
    .set({ status: "cancelled", holdExpiresAt: null })
    .where(eq(orderLines.id, line.id));

  const remaining = await tx
    .select({ id: orderLines.id })
    .from(orderLines)
    .where(and(eq(orderLines.orderId, line.orderId), inArray(orderLines.status, [...BILLABLE])));
  if (remaining.length === 0) {
    await tx
      .update(orders)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(and(eq(orders.id, line.orderId), inArray(orders.status, [...OPEN_STATUSES])));
  }
  await recalcOrder(tx, line.orderId);
  return { orderId: line.orderId, stock };
}

/**
 * Swaps a held item for another option ("change to L"): the old one goes back
 * on sale and the new one is held with the same deadline, so changing your mind
 * doesn't buy extra time. Throws OutOfStockError, and the transaction rolls the
 * whole swap back, when the new option isn't there.
 */
export async function replaceLine(
  tx: Tx,
  input: { lineId: string; variantId: string; qty: number; sourceMessageId?: string },
): Promise<{ orderId: string; lineId: string; previousVariantId: string; stock: StockChange[] }> {
  const [line] = await tx
    .select()
    .from(orderLines)
    .where(eq(orderLines.id, input.lineId))
    .for("update");
  if (!line) throw new Error(`Line ${input.lineId} not found`);
  if (line.status !== "held") throw new LineNotHeldError(line.status);
  const [order] = await tx.select().from(orders).where(eq(orders.id, line.orderId));
  if (!order) throw new Error(`Order ${line.orderId} not found`);

  const released = await moveStock(tx, line.variantId, "release", line.qty, {
    orderLineId: line.id,
    note: "swapped by buyer",
  });
  await tx
    .update(orderLines)
    .set({ status: "cancelled", holdExpiresAt: null })
    .where(eq(orderLines.id, line.id));

  const [seller] = await tx.select().from(sellers).where(eq(sellers.id, order.sellerId));
  const held = await holdItem(tx, {
    order,
    variantId: input.variantId,
    qty: input.qty,
    holdMinutes: seller?.holdMinutes ?? 15,
    holdExpiresAt: line.holdExpiresAt,
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
  });
  // Same variant (a quantity change) reports its final counters last.
  return {
    orderId: order.id,
    lineId: held.lineId,
    previousVariantId: line.variantId,
    stock: [released, held.stock],
  };
}

/**
 * Recomputes totals and the order-level hold expiry from its lines. Everything a
 * buyer gets in one live ships in one parcel: an order placed after an earlier
 * one was paid rides along with it and pays no second shipping fee.
 */
export async function recalcOrder(tx: Tx, orderId: string): Promise<void> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return;
  const [seller] = await tx.select().from(sellers).where(eq(sellers.id, order.sellerId));

  const lines = await tx
    .select()
    .from(orderLines)
    .where(and(eq(orderLines.orderId, orderId), inArray(orderLines.status, [...BILLABLE])));
  const subtotalCents = lines.reduce((sum, l) => sum + l.qty * l.unitPriceCents, 0);
  const holds = lines
    .filter((l) => l.status === "held" && l.holdExpiresAt)
    .map((l) => l.holdExpiresAt as Date);
  const holdExpiresAt =
    holds.length > 0 ? new Date(Math.min(...holds.map((d) => d.getTime()))) : null;

  // What the buyer agreed to pay (shipping, deals) doesn't change after payment.
  let { shippingCents, shipsWithOrderId, discountCents } = order;
  if (order.status === "draft" || order.status === "reserved" || order.status === "cancelled") {
    const [parcel] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.sessionId, order.sessionId),
          eq(orders.buyerId, order.buyerId),
          ne(orders.id, order.id),
          eq(orders.status, "paid"),
          lt(orders.createdAt, order.createdAt),
        ),
      )
      .orderBy(asc(orders.createdAt))
      .limit(1);
    shipsWithOrderId = parcel?.id ?? null;
    shippingCents = lines.length > 0 && !parcel ? (seller?.shippingCents ?? 0) : 0;
    discountCents = await bundleDiscountCents(tx, order.sessionId, lines);
  }

  const totalCents = subtotalCents - discountCents + shippingCents;

  // Every change to an open order restarts the auto-pay countdown. Not while
  // PlusOne waits for the buyer's answer, and never for something handed over
  // from the waitlist: they didn't just ask for it.
  let autopayAt: Date | null = null;
  const fromWaitlist = lines.some((l) => l.status === "held" && l.fromWaitlist);
  if (order.status === "reserved" && holds.length > 0 && !order.autopayWaiting && !fromWaitlist) {
    const [buyer] = await tx.select().from(buyers).where(eq(buyers.id, order.buyerId));
    if (
      buyer?.paypalVaultId &&
      buyer.autopaySessionId === order.sessionId &&
      totalCents <= (await autopayRoom(tx, buyer, order.sessionId))
    ) {
      autopayAt = new Date(Date.now() + AUTOPAY_AFTER_MS);
    }
  }

  await tx
    .update(orders)
    .set({
      subtotalCents,
      shippingCents,
      shipsWithOrderId,
      discountCents,
      totalCents,
      holdExpiresAt,
      autopayAt,
    })
    .where(eq(orders.id, orderId));
}

/** Money off for the host's bundle deals an order's lines complete: one discount per matching pair. */
async function bundleDiscountCents(
  tx: Tx,
  sessionId: string,
  lines: Array<{ variantId: string; qty: number }>,
) {
  const active = await tx
    .select({ params: rules.params })
    .from(rules)
    .where(
      and(eq(rules.sessionId, sessionId), eq(rules.kind, "bundle"), eq(rules.status, "active")),
    );
  if (active.length === 0 || lines.length === 0) return 0;

  const codes = await tx
    .select({ variantId: variants.id, code: products.code })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(
      inArray(
        variants.id,
        lines.map((l) => l.variantId),
      ),
    );
  const qtyOf = (code: string) =>
    lines
      .filter((l) => codes.find((c) => c.variantId === l.variantId)?.code === code)
      .reduce((n, l) => n + l.qty, 0);

  let discount = 0;
  for (const { params } of active) {
    const p = params as { productCodes?: string[]; discountCents?: number | null };
    const [a, b] = p.productCodes ?? [];
    if (!a || !b || !p.discountCents) continue;
    discount += Math.min(qtyOf(a), qtyOf(b)) * p.discountCents;
  }
  return discount;
}

/** One-line ship-to address from a captured PayPal order, if PayPal gave one. */
function shipToFrom(raw: unknown): string | null {
  const unit = (raw as { purchaseUnits?: Array<{ shipping?: ShippingRaw }> } | null)
    ?.purchaseUnits?.[0];
  const s = unit?.shipping;
  if (!s?.address) return null;
  const a = s.address;
  return [
    s.name?.fullName,
    a.addressLine1,
    a.addressLine2,
    a.adminArea2,
    a.adminArea1,
    a.postalCode,
    a.countryCode,
  ]
    .filter(Boolean)
    .join(", ");
}

type ShippingRaw = {
  name?: { fullName?: string };
  address?: {
    addressLine1?: string;
    addressLine2?: string;
    adminArea1?: string;
    adminArea2?: string;
    postalCode?: string;
    countryCode?: string;
  };
};

export async function getOrderDTO(tx: Tx, orderId: string): Promise<OrderDTO | null> {
  const [list] = await getOrderDTOs(tx, [orderId]);
  return list ?? null;
}

export async function listOrderDTOs(
  tx: Tx,
  filter: { sessionId: string; buyerId?: string },
): Promise<OrderDTO[]> {
  const rows = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      filter.buyerId
        ? and(eq(orders.sessionId, filter.sessionId), eq(orders.buyerId, filter.buyerId))
        : eq(orders.sessionId, filter.sessionId),
    )
    .orderBy(desc(orders.createdAt));
  return getOrderDTOs(
    tx,
    rows.map((r) => r.id),
  );
}

async function getOrderDTOs(tx: Tx, orderIds: string[]): Promise<OrderDTO[]> {
  if (orderIds.length === 0) return [];

  const orderRows = await tx
    .select({ order: orders, buyer: buyers })
    .from(orders)
    .innerJoin(buyers, eq(buyers.id, orders.buyerId))
    .where(inArray(orders.id, orderIds));

  const lineRows = await tx
    .select({ line: orderLines, variant: variants, product: products })
    .from(orderLines)
    .innerJoin(variants, eq(variants.id, orderLines.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(inArray(orderLines.orderId, orderIds))
    .orderBy(asc(orderLines.createdAt));

  const parcelIds = orderRows.flatMap(({ order }) =>
    order.shipsWithOrderId ? [order.shipsWithOrderId] : [],
  );
  const parcels =
    parcelIds.length > 0
      ? await tx
          .select({ id: orders.id, number: orders.number })
          .from(orders)
          .where(inArray(orders.id, parcelIds))
      : [];

  const shipmentRows = await tx
    .select()
    .from(shipments)
    .where(inArray(shipments.orderId, orderIds));
  const invoiceRows = await tx
    .select()
    .from(invoices)
    .where(inArray(invoices.orderId, orderIds))
    .orderBy(desc(invoices.createdAt));

  const paymentRows = await tx
    .select()
    .from(payments)
    .where(inArray(payments.orderId, orderIds))
    .orderBy(desc(payments.createdAt));

  const byId = new Map(
    orderRows.map(({ order, buyer }) => {
      const payment =
        paymentRows.find((p) => p.orderId === order.id && p.status === "captured") ??
        paymentRows.find((p) => p.orderId === order.id);
      const dto: OrderDTO = {
        id: order.id,
        number: order.number,
        sessionId: order.sessionId,
        buyer: { id: buyer.id, name: buyer.name, email: buyer.email },
        status: order.status,
        currency: order.currency,
        subtotalCents: order.subtotalCents,
        shippingCents: order.shippingCents,
        discountCents: order.discountCents,
        shipsWithOrderNumber: parcels.find((p) => p.id === order.shipsWithOrderId)?.number ?? null,
        totalCents: order.totalCents,
        holdExpiresAt: order.holdExpiresAt?.toISOString() ?? null,
        paidAt: order.paidAt?.toISOString() ?? null,
        paypalOrderId: payment?.paypalOrderId ?? null,
        captureId: payment?.captureId ?? null,
        paidVia:
          paymentRows.find((p) => p.orderId === order.id && p.status === "captured")?.via ?? null,
        autopayAt: order.autopayAt?.toISOString() ?? null,
        autopayInMs: order.autopayAt ? Math.max(0, order.autopayAt.getTime() - Date.now()) : null,
        autopayWaiting: order.autopayWaiting,
        shipTo: shipToFrom(
          paymentRows.find((p) => p.orderId === order.id && p.status === "captured")?.raw,
        ),
        invoice: (() => {
          const inv = invoiceRows.find((r) => r.orderId === order.id);
          return inv
            ? { payUrl: inv.payUrl, dueAt: inv.dueAt.toISOString(), status: inv.status }
            : null;
        })(),
        tracking: (() => {
          const s = shipmentRows.find((r) => r.orderId === order.id);
          return s ? { carrier: s.carrier, number: s.trackingNumber } : null;
        })(),
        lines: lineRows
          .filter((r) => r.line.orderId === order.id)
          .map(({ line, variant, product }) => ({
            id: line.id,
            variantId: variant.id,
            productName: product.name,
            productCode: product.code,
            color: variant.color,
            size: variant.size,
            qty: line.qty,
            unitPriceCents: line.unitPriceCents,
            status: line.status,
            holdExpiresAt: line.holdExpiresAt?.toISOString() ?? null,
          })),
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
      };
      return [order.id, dto] as const;
    }),
  );

  // Keep the caller's order.
  return orderIds.flatMap((id) => byId.get(id) ?? []);
}
