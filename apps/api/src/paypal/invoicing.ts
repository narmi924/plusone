import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { buyers, invoices, orderLines, orders, products, sellers, variants } from "../db/schema.js";
import { type Notifier, phrase } from "../services/notify.js";
import { recalcOrder } from "../services/orders.js";
import type { PayPal } from "./client.js";
import type { Payments } from "./payments.js";

// When the live ends, buyers who still hold unpaid items get a PayPal invoice
// (Invoicing v2, not covered by the server SDK, so plain REST). Their items stay
// held until it's due. Paying it settles the order exactly like a checkout
// payment; if it runs out, the items go back on sale and the invoice is
// cancelled. Invoicing one order is safe to retry: PayPal sees the same request
// id, and an invoice that already went out isn't sent twice.

const DUE_IN_MS = 24 * 60 * 60_000;
const SELLER_TIME_ZONE = "Asia/Singapore";

const money = (cents: number, currency_code: string) => ({
  currency_code,
  value: (cents / 100).toFixed(2),
});

interface PayPalInvoice {
  id: string;
  status?: string;
  detail?: { metadata?: { recipient_view_url?: string } };
  payments?: { transactions?: Array<{ payment_id?: string }> };
  links?: Array<{ href: string; rel: string }>;
}

export function createInvoicing(deps: {
  db: Db;
  paypal: PayPal;
  payments: Payments;
  notify: Notifier;
  log: FastifyBaseLogger;
  /** An invoice was paid (e.g. bring the after-live recap up to date). */
  onPaid?: (orderId: string) => Promise<void>;
}) {
  const { db, paypal, notify, log } = deps;

  async function invoiceOrder(orderId: string) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (order?.status !== "reserved") return null;
    const [open] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.orderId, order.id), eq(invoices.status, "sent")));
    if (open) return open;

    const [seller] = await db.select().from(sellers).where(eq(sellers.id, order.sellerId));
    const [buyer] = await db.select().from(buyers).where(eq(buyers.id, order.buyerId));
    const lines = await db
      .select({
        id: orderLines.id,
        qty: orderLines.qty,
        unit: orderLines.unitPriceCents,
        name: products.name,
        color: variants.color,
        size: variants.size,
      })
      .from(orderLines)
      .innerJoin(variants, eq(variants.id, orderLines.variantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(orderLines.orderId, order.id), eq(orderLines.status, "held")));
    if (!seller || !buyer || lines.length === 0) return null;

    const label = (l: (typeof lines)[number]) =>
      [l.name, [l.color, l.size].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const dueAt = new Date(Date.now() + DUE_IN_MS);
    const c = order.currency;

    const requestId = `plusone-invoice-${order.id}-${createHash("sha256")
      .update(lines.map((l) => l.id).join(","))
      .digest("hex")
      .slice(0, 16)}`;
    const created = await paypal.rest<PayPalInvoice>(
      "POST",
      "/v2/invoicing/invoices",
      {
        detail: {
          currency_code: c,
          // Unique per merchant forever, so it can't collide after a demo reset.
          invoice_number: `PO${order.number}-${order.id.slice(0, 6)}`,
          note: `Your order from ${seller.name}'s live. The items stay held for you until this invoice is due.`,
          payment_term: {
            term_type: "DUE_ON_DATE_SPECIFIED",
            due_date: dueAt.toISOString().slice(0, 10),
          },
        },
        invoicer: { business_name: seller.name },
        primary_recipients: [
          { billing_info: { name: { given_name: buyer.name }, email_address: buyer.email } },
        ],
        items: lines.map((l) => ({
          name: label(l),
          quantity: String(l.qty),
          unit_amount: money(l.unit, c),
        })),
        amount: {
          breakdown: {
            ...(order.shippingCents > 0
              ? { shipping: { amount: money(order.shippingCents, c) } }
              : {}),
            ...(order.discountCents > 0
              ? { discount: { invoice_discount: { amount: money(order.discountCents, c) } } }
              : {}),
          },
        },
        configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } },
      },
      { Prefer: "return=representation", "PayPal-Request-Id": requestId },
    );
    const id =
      created.id ??
      created.links
        ?.find((l) => l.rel === "self")
        ?.href.split("/")
        .pop();
    if (!id) throw new Error("PayPal did not return an invoice id");

    await paypal
      .rest("POST", `/v2/invoicing/invoices/${id}/send`, {
        send_to_recipient: true,
        send_to_invoicer: false,
        subject: `Your order from ${seller.name}`,
      })
      .catch(async (err: unknown) => {
        // A retry after the send went through: fine, as long as it's out.
        const now = await paypal.rest<PayPalInvoice>("GET", `/v2/invoicing/invoices/${id}`);
        if (now.status === "DRAFT") throw err;
      });
    const sent = await paypal.rest<PayPalInvoice>("GET", `/v2/invoicing/invoices/${id}`);
    const payUrl = sent.detail?.metadata?.recipient_view_url ?? null;

    const row = await db.transaction(async (tx) => {
      // Keep the items for the buyer until the invoice is due.
      await tx
        .update(orderLines)
        .set({ holdExpiresAt: dueAt })
        .where(
          inArray(
            orderLines.id,
            lines.map((l) => l.id),
          ),
        );
      await recalcOrder(tx, order.id);
      const [inserted] = await tx
        .insert(invoices)
        .values({
          orderId: order.id,
          paypalInvoiceId: id,
          amountCents: order.totalCents,
          currency: c,
          payUrl,
          dueAt,
          lineIds: lines.map((l) => l.id),
        })
        .returning();
      return inserted;
    });

    const due = dueAt.toLocaleString("en-GB", {
      timeZone: SELLER_TIME_ZONE,
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    await notify.privateTo(
      order.sessionId,
      order.buyerId,
      phrase(buyer.locale, "invoiced", { item: lines.map(label).join(" + "), due }),
    );
    await notify.orders([order.id]);
    return row ?? null;
  }

  /** A hold ran out: the items are back on sale, so the invoice can't be paid any more. */
  /** Cancels this order's open invoice, or every open invoice (before a demo reset). */
  async function cancelForOrder(orderId: string | null) {
    const open = await db
      .select()
      .from(invoices)
      .where(
        orderId
          ? and(eq(invoices.orderId, orderId), eq(invoices.status, "sent"))
          : eq(invoices.status, "sent"),
      );
    for (const inv of open) {
      await paypal
        .rest("POST", `/v2/invoicing/invoices/${inv.paypalInvoiceId}/cancel`, {
          send_to_recipient: false,
          send_to_invoicer: false,
        })
        .catch((err: unknown) =>
          log.warn({ err, invoice: inv.paypalInvoiceId }, "cancelling invoice failed"),
        );
      await db.update(invoices).set({ status: "cancelled" }).where(eq(invoices.id, inv.id));
    }
  }

  async function onWebhookEvent(event: { event_type: string; resource?: Record<string, unknown> }) {
    if (!event.event_type.startsWith("INVOICING.INVOICE.")) return false;
    const resource = event.resource ?? {};
    const invoice =
      ((resource.invoice as PayPalInvoice | undefined) ?? (resource as unknown as PayPalInvoice)) ||
      null;
    if (!invoice?.id) return true;
    const [row] = await db.select().from(invoices).where(eq(invoices.paypalInvoiceId, invoice.id));
    if (!row) return true;

    if (event.event_type === "INVOICING.INVOICE.PAID" && row.status !== "paid") {
      await deps.payments.settleExternal({
        orderId: row.orderId,
        lineIds: row.lineIds,
        amountCents: row.amountCents,
        currency: row.currency,
        reference: `invoice:${invoice.id}`,
        captureId: invoice.payments?.transactions?.[0]?.payment_id ?? `invoice:${invoice.id}`,
        raw: invoice,
      });
      await db.update(invoices).set({ status: "paid" }).where(eq(invoices.id, row.id));
      await notify.orders([row.orderId]);
      await deps.onPaid?.(row.orderId);
    } else if (event.event_type === "INVOICING.INVOICE.CANCELLED" && row.status === "sent") {
      await db.update(invoices).set({ status: "cancelled" }).where(eq(invoices.id, row.id));
    }
    return true;
  }

  return { invoiceOrder, cancelForOrder, onWebhookEvent };
}

export type Invoicing = ReturnType<typeof createInvoicing>;
