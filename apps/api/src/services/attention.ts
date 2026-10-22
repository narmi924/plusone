import type { AttentionDTO } from "@plusone/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { attention, buyers, orderLines, orders } from "../db/schema.js";
import { refundQuote } from "./refunds.js";

/** The seller's "needs you" list: open items, oldest first, with a refund amount where one click settles it. */
export async function listAttention(tx: Tx, sessionId: string): Promise<AttentionDTO[]> {
  const rows = await tx
    .select({ item: attention, buyerName: buyers.name, line: orderLines, order: orders })
    .from(attention)
    .leftJoin(buyers, eq(buyers.id, attention.buyerId))
    .leftJoin(orderLines, eq(orderLines.id, attention.lineId))
    .leftJoin(orders, eq(orders.id, orderLines.orderId))
    .where(and(eq(attention.sessionId, sessionId), eq(attention.status, "open")))
    .orderBy(asc(attention.createdAt));

  const out: AttentionDTO[] = [];
  for (const { item, buyerName, line, order } of rows) {
    let refund: AttentionDTO["refund"] = null;
    if (item.kind === "cancel_paid" && line?.status === "paid" && order) {
      const quote = await refundQuote(tx, line.id);
      if (quote)
        refund = { lineId: line.id, amountCents: quote.amountCents, currency: quote.currency };
    }
    out.push({
      id: item.id,
      kind: item.kind,
      summary: item.summary,
      buyerName,
      orderNumber: order?.number ?? null,
      refund,
      createdAt: item.createdAt.toISOString(),
    });
  }
  return out;
}

export async function resolveAttention(tx: Tx, id: string) {
  const [row] = await tx
    .update(attention)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(eq(attention.id, id))
    .returning({ sessionId: attention.sessionId });
  return row?.sessionId ?? null;
}
