import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { orderLines, orders, payments } from "../db/schema.js";

// How much goes back when one paid item is cancelled: its share of what the
// buyer actually paid (bundle deals included), and the postage with the last
// item. Refunds never add up to more than the payment. The seller's refund
// button, the copilot's card and the PayPal call all use this one number.

export function refundShare(input: {
  /** This line's price times quantity. */
  lineCents: number;
  /** All items this payment covered, at their prices. */
  itemsCents: number;
  /** What PayPal captured. */
  paidCents: number;
  shippingCents: number;
  refundedCents: number;
  /** The last paid item of the payment: everything left goes back. */
  last: boolean;
}) {
  const left = Math.max(0, input.paidCents - input.refundedCents);
  if (input.last) return left;
  const itemsPaid = Math.max(0, input.paidCents - input.shippingCents);
  const share =
    input.itemsCents > 0 ? Math.round((input.lineCents * itemsPaid) / input.itemsCents) : 0;
  return Math.min(share, left);
}

/** The refund for one paid line, with the payment it comes out of. Null if it isn't refundable. */
export async function refundQuote(tx: Tx, lineId: string) {
  const [line] = await tx.select().from(orderLines).where(eq(orderLines.id, lineId));
  if (line?.status !== "paid") return null;
  const [order] = await tx.select().from(orders).where(eq(orders.id, line.orderId));
  if (!order) return null;
  const [payment] = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.orderId, order.id),
        inArray(payments.status, ["captured", "partially_refunded"]),
        sql`${payments.lineIds} @> ${JSON.stringify([line.id])}::jsonb`,
      ),
    );
  if (!payment?.captureId) return null;

  const covered = await tx
    .select({
      id: orderLines.id,
      qty: orderLines.qty,
      unit: orderLines.unitPriceCents,
      status: orderLines.status,
    })
    .from(orderLines)
    .where(inArray(orderLines.id, payment.lineIds));
  const counted = covered.filter((l) => l.status === "paid" || l.status === "refunded");
  const last = !counted.some((l) => l.id !== line.id && l.status === "paid");
  const amountCents = refundShare({
    lineCents: line.qty * line.unitPriceCents,
    itemsCents: counted.reduce((n, l) => n + l.qty * l.unit, 0),
    paidCents: payment.amountCents,
    shippingCents: order.shippingCents,
    refundedCents: payment.refundedCents,
    last,
  });
  return { line, order, payment, last, amountCents, currency: order.currency };
}
