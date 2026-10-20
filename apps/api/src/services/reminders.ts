import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { buyers, invoices, payments } from "../db/schema.js";
import { type Notifier, phrase } from "./notify.js";
import { getOrderDTO } from "./orders.js";

// "Friendly reminder: your dress is still held for 5 more min." Sent by hand
// (the seller, or the report's AI) or on a timer a few minutes before a hold
// runs out. The timed one stays quiet if anything moved in the meantime.

export const REMIND_BEFORE_MS = 5 * 60_000;
const CHECKOUT_GRACE_MS = 5 * 60_000;

export type ReminderResult =
  | { sent: true; buyer: string | null; minutesLeft: number }
  | { sent: false; reason: string };

export async function sendPayReminder(
  db: Db,
  notify: Notifier,
  orderId: string,
  /** Timed reminders: the hold end they were set for, so a changed hold skips this one. */
  scheduledFor?: string,
): Promise<ReminderResult> {
  const order = await getOrderDTO(db, orderId);
  if (!order) return { sent: false, reason: "no such order" };
  if (order.status !== "reserved") {
    return { sent: false, reason: `Order #${order.number} is ${order.status}, nothing to pay` };
  }

  if (scheduledFor) {
    if (order.holdExpiresAt !== scheduledFor) return { sent: false, reason: "hold changed" };
    const [invoiced] = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.orderId, orderId), eq(invoices.status, "sent")));
    if (invoiced) return { sent: false, reason: "invoiced" };
    const [paying] = await db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.orderId, orderId),
          eq(payments.status, "created"),
          gt(payments.createdAt, new Date(Date.now() - CHECKOUT_GRACE_MS)),
        ),
      );
    if (paying) return { sent: false, reason: "paying right now" };
  }

  const [buyer] = await db
    .select({ name: buyers.name, locale: buyers.locale })
    .from(buyers)
    .where(eq(buyers.id, order.buyer.id));
  const item = order.lines
    .filter((l) => l.status === "held")
    .map((l) =>
      [l.productName, [l.color, l.size].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    )
    .join(" + ");
  const minutesLeft = order.holdExpiresAt
    ? Math.max(1, Math.round((Date.parse(order.holdExpiresAt) - Date.now()) / 60_000))
    : 15;
  await notify.privateTo(
    order.sessionId,
    order.buyer.id,
    phrase(buyer?.locale ?? null, "payReminder", { item, min: String(minutesLeft) }),
  );
  return { sent: true, buyer: buyer?.name ?? null, minutesLeft };
}
