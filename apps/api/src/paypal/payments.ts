import { randomUUID } from "node:crypto";
import type { ItemRequest, Order } from "@paypal/paypal-server-sdk";
import {
  CaptureStatus,
  CheckoutPaymentIntent,
  ItemCategory,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  RefundStatus,
  ShipmentCarrier,
} from "@paypal/paypal-server-sdk";
import type { StockChange } from "@plusone/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db, Tx } from "../db/client.js";
import {
  attention,
  buyers,
  orderLines,
  orders,
  payments,
  products,
  sellers,
  shipments,
  variants,
} from "../db/schema.js";
import { describeVariant } from "../services/catalog.js";
import { type Notifier, phrase } from "../services/notify.js";
import { getOrderDTO, recalcOrder } from "../services/orders.js";
import { moveStock, OutOfStockError } from "../services/stock.js";
import { offerFreedStock } from "../services/waitlist.js";
import { describePayPalError, type PayPal } from "./client.js";

type PaymentRow = typeof payments.$inferSelect;

/** Carriers sellers here actually use, mapped to PayPal's carrier codes. */
export const CARRIERS = {
  singpost: { label: "SingPost", code: ShipmentCarrier.SgSgPost },
  ninjavan: { label: "Ninja Van", code: ShipmentCarrier.NinjavanSg },
  jt: { label: "J&T Express", code: ShipmentCarrier.JtexpressSgApi },
  dhl: { label: "DHL", code: ShipmentCarrier.Dhl },
} as const;
export type CarrierKey = keyof typeof CARRIERS | "other";

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly issue: string | null = null,
  ) {
    super(message);
  }
}

const AWAITING_CAPTURE = new Set<PaymentRow["status"]>(["created", "approved"]);

const money = (cents: number, currencyCode: string) => ({
  currencyCode,
  value: (cents / 100).toFixed(2),
});

/**
 * PayPal Orders v2 with intent CAPTURE. Our order is "reserved" until PayPal
 * confirms the capture; only then are the held items sold. The same transition
 * runs from the buyer's capture call and from the PAYMENT.CAPTURE.COMPLETED
 * webhook, whichever arrives first; the second is a no-op.
 */
export function createPayments(deps: {
  db: Db;
  paypal: PayPal;
  notify: Notifier;
  log: FastifyBaseLogger;
}) {
  const { db, paypal, notify, log } = deps;

  /** Creates (or reuses) the PayPal order for what the buyer currently has on hold. */
  async function createForOrder(
    orderId: string,
    buyerId: string,
  ): Promise<{ paypalOrderId: string }> {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order || order.buyerId !== buyerId) throw new PaymentError("Order not found", 404);
    if (order.status !== "reserved") throw new PaymentError("Nothing to pay for on this order");

    const [seller] = await db.select().from(sellers).where(eq(sellers.id, order.sellerId));
    const lines = await db
      .select({ line: orderLines, variant: variants, product: products })
      .from(orderLines)
      .innerJoin(variants, eq(variants.id, orderLines.variantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(orderLines.orderId, orderId), eq(orderLines.status, "held")));
    if (lines.length === 0) throw new PaymentError("Nothing to pay for on this order");

    const itemTotal = lines.reduce((sum, l) => sum + l.line.qty * l.line.unitPriceCents, 0);
    // Already zero when this order rides along with an earlier paid parcel.
    const shipping = order.shippingCents;
    // The host's bundle deals, as recalculated on the order.
    const discount = Math.min(order.discountCents, itemTotal);
    const amountCents = itemTotal - discount + shipping;
    const lineIds = lines.map((l) => l.line.id).sort();

    // Tapping "Pay" twice for the same items reuses the PayPal order.
    const existing = await db
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, "created")));
    const reusable = existing.find(
      (p) =>
        p.amountCents === amountCents &&
        JSON.stringify([...p.lineIds].sort()) === JSON.stringify(lineIds),
    );
    if (reusable) return { paypalOrderId: reusable.paypalOrderId };

    const currencyCode = order.currency;
    const items: ItemRequest[] = lines.map(({ line, variant, product }) => ({
      name: [product.name, [variant.color, variant.size].filter(Boolean).join(" / ")]
        .filter(Boolean)
        .join(" - "),
      sku: variant.sku,
      quantity: String(line.qty),
      unitAmount: money(line.unitPriceCents, currencyCode),
      category: ItemCategory.PhysicalGoods,
    }));

    const paymentId = randomUUID();
    try {
      const { result } = await paypal.orders.createOrder({
        paypalRequestId: paymentId,
        prefer: "return=minimal",
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [
            {
              referenceId: order.id,
              customId: order.id,
              // Unique per merchant forever, so it can't collide after a demo reset.
              invoiceId: `PO${order.number}-${paymentId.slice(0, 8)}`,
              description: `${seller?.name ?? "PlusOne"} live order #${order.number}`,
              softDescriptor: "PLUSONE LIVE",
              amount: {
                ...money(amountCents, currencyCode),
                breakdown: {
                  itemTotal: money(itemTotal, currencyCode),
                  shipping: money(shipping, currencyCode),
                  ...(discount > 0 ? { discount: money(discount, currencyCode) } : {}),
                },
              },
              items,
            },
          ],
          paymentSource: {
            paypal: {
              experienceContext: {
                brandName: seller?.name ?? "PlusOne",
                shippingPreference: PaypalWalletContextShippingPreference.GetFromFile,
                userAction: PaypalExperienceUserAction.PayNow,
              },
            },
          },
        },
      });
      if (!result.id) throw new PaymentError("PayPal did not return an order id", 502);

      await db.insert(payments).values({
        id: paymentId,
        orderId,
        paypalOrderId: result.id,
        status: "created",
        amountCents,
        currency: currencyCode,
        lineIds,
      });
      return { paypalOrderId: result.id };
    } catch (err) {
      if (err instanceof PaymentError) throw err;
      const info = describePayPalError(err);
      log.error({ err, info }, "PayPal create order failed");
      throw new PaymentError(info.message, 502, info.issue);
    }
  }

  /** Captures an approved PayPal order. Safe to call more than once. */
  async function capture(paypalOrderId: string, buyerId?: string) {
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.paypalOrderId, paypalOrderId));
    if (!payment) throw new PaymentError("Payment not found", 404);
    if (buyerId) {
      const [order] = await db.select().from(orders).where(eq(orders.id, payment.orderId));
      if (order?.buyerId !== buyerId) throw new PaymentError("Payment not found", 404);
    }
    // Already captured, refunded or declined: nothing to do, whoever asks.
    if (!AWAITING_CAPTURE.has(payment.status)) return getOrderDTO(db, payment.orderId);

    let result: Order;
    try {
      ({ result } = await paypal.orders.captureOrder({
        id: paypalOrderId,
        // Same id from the buyer's call and the webhook path, so PayPal captures once.
        paypalRequestId: `capture-${payment.id}`,
        prefer: "return=representation",
      }));
    } catch (err) {
      const info = describePayPalError(err);
      if (info.issue === "ORDER_ALREADY_CAPTURED") {
        ({ result } = await paypal.orders.getOrder({ id: paypalOrderId }));
      } else {
        log.warn({ info, paypalOrderId }, "PayPal capture failed");
        // INSTRUMENT_DECLINED: the buyer can pick another funding source and try again.
        throw new PaymentError(info.message, info.status === 422 ? 422 : 502, info.issue);
      }
    }

    const cap = result.purchaseUnits?.[0]?.payments?.captures?.[0];
    if (cap?.status === CaptureStatus.Completed && cap.id) {
      await settle(payment.id, cap.id, {
        payerEmail: result.payer?.emailAddress ?? null,
        raw: result,
      });
    } else if (cap?.status === CaptureStatus.Pending) {
      await db
        .update(payments)
        .set({ status: "approved", captureId: cap.id ?? null, raw: result })
        .where(eq(payments.id, payment.id));
    } else {
      await db
        .update(payments)
        .set({ status: "denied", raw: result })
        .where(eq(payments.id, payment.id));
      throw new PaymentError(
        "The payment was declined. Try another way to pay.",
        422,
        "CAPTURE_DECLINED",
      );
    }
    return getOrderDTO(db, payment.orderId);
  }

  /**
   * Money is in: sell the held items, mark the order paid. Items the buyer added
   * after starting checkout weren't in this payment, so they move to a new open order.
   */
  async function settle(
    paymentId: string,
    captureId: string,
    extra: { payerEmail: string | null; raw: unknown },
  ) {
    const outcome = await db.transaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, paymentId))
        .for("update");
      // Only a payment still in checkout can settle. A late "capture completed"
      // webhook must not turn an already refunded order back into a paid one.
      if (!payment || !AWAITING_CAPTURE.has(payment.status)) return null;

      await tx
        .update(payments)
        .set({ status: "captured", captureId, payerEmail: extra.payerEmail, raw: extra.raw })
        .where(eq(payments.id, payment.id));

      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, payment.orderId))
        .for("update");
      if (!order) throw new Error(`Order ${payment.orderId} missing`);

      const stock = await sellPaidLines(tx, payment, order);
      await tx
        .update(orders)
        .set({ status: "paid", paidAt: new Date() })
        .where(eq(orders.id, order.id));

      const leftover = await tx
        .select({ id: orderLines.id })
        .from(orderLines)
        .where(and(eq(orderLines.orderId, order.id), eq(orderLines.status, "held")));
      let carriedTo: string | null = null;
      if (leftover.length > 0) {
        const [next] = await tx
          .insert(orders)
          .values({
            sellerId: order.sellerId,
            sessionId: order.sessionId,
            buyerId: order.buyerId,
            status: "reserved",
            currency: order.currency,
          })
          .returning({ id: orders.id });
        if (!next) throw new Error("Could not open follow-up order");
        await tx
          .update(orderLines)
          .set({ orderId: next.id })
          .where(
            inArray(
              orderLines.id,
              leftover.map((l) => l.id),
            ),
          );
        await recalcOrder(tx, next.id);
        carriedTo = next.id;
      }
      await recalcOrder(tx, order.id);
      return { orderId: order.id, sessionId: order.sessionId, carriedTo, stock };
    });

    if (!outcome) return;
    await notify.orders(
      [outcome.orderId, outcome.carriedTo].filter((id): id is string => Boolean(id)),
    );
    notify.stock(outcome.sessionId, outcome.stock);
    notify.attentionChanged(outcome.sessionId);
  }

  /**
   * Refunds one paid item, after the seller approves it: a partial refund on the
   * capture for that item, plus shipping when it was the last paid item in the
   * parcel. The item goes back on sale, to the waitlist first.
   */
  async function refundLine(lineId: string) {
    const [line] = await db.select().from(orderLines).where(eq(orderLines.id, lineId));
    if (line?.status !== "paid") throw new PaymentError("Only paid items can be refunded");
    const [order] = await db.select().from(orders).where(eq(orders.id, line.orderId));
    if (!order) throw new PaymentError("Order not found", 404);
    const [payment] = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.orderId, order.id),
          inArray(payments.status, ["captured", "partially_refunded"]),
          sql`${payments.lineIds} @> ${JSON.stringify([line.id])}::jsonb`,
        ),
      );
    if (!payment?.captureId) throw new PaymentError("No PayPal payment found for this item");

    const stillPaid = await db
      .select({ id: orderLines.id })
      .from(orderLines)
      .where(and(eq(orderLines.orderId, order.id), eq(orderLines.status, "paid")));
    const last = stillPaid.length === 1;
    const amountCents = line.qty * line.unitPriceCents + (last ? order.shippingCents : 0);
    const what = await describeVariant(db, line.variantId);

    try {
      const { result } = await paypal.payments.refundCapturedPayment({
        captureId: payment.captureId,
        // One refund per item, however many times the button is pressed.
        paypalRequestId: `refund-${line.id}`,
        prefer: "return=representation",
        body: { amount: money(amountCents, order.currency), noteToPayer: `Refund: ${what}` },
      });
      if (result.status !== RefundStatus.Completed && result.status !== RefundStatus.Pending) {
        throw new PaymentError(`PayPal refund ${result.status ?? "failed"}`, 502);
      }
    } catch (err) {
      if (err instanceof PaymentError) throw err;
      const info = describePayPalError(err);
      log.error({ err, info }, "PayPal refund failed");
      throw new PaymentError(info.message, 502, info.issue);
    }

    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(orderLines)
        .where(eq(orderLines.id, line.id))
        .for("update");
      if (locked?.status !== "paid") return null;
      const stock = await moveStock(tx, line.variantId, "refund", line.qty, {
        orderLineId: line.id,
        note: "refunded",
      });
      await tx.update(orderLines).set({ status: "refunded" }).where(eq(orderLines.id, line.id));
      await tx
        .update(payments)
        .set({ status: last ? "refunded" : "partially_refunded" })
        .where(eq(payments.id, payment.id));
      if (last) {
        await tx
          .update(orders)
          .set({ status: "cancelled", cancelledAt: new Date() })
          .where(eq(orders.id, order.id));
      }
      await recalcOrder(tx, order.id);
      await tx
        .update(attention)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(and(eq(attention.lineId, line.id), eq(attention.status, "open")));
      const offers = await offerFreedStock(tx, order.sessionId, line.variantId);
      return { stock, offers };
    });
    if (!outcome) return;

    notify.stock(order.sessionId, [outcome.stock]);
    await notify.orders([order.id]);
    notify.attentionChanged(order.sessionId);
    const [buyer] = await db
      .select({ locale: buyers.locale })
      .from(buyers)
      .where(eq(buyers.id, order.buyerId));
    await notify.privateTo(
      order.sessionId,
      order.buyerId,
      phrase(buyer?.locale ?? null, "refunded", {
        item: what,
        amount: new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: order.currency,
        }).format(amountCents / 100),
      }),
    );
    await notify.waitlistOffers(order.sessionId, outcome.offers);
  }

  async function sellPaidLines(
    tx: Tx,
    payment: PaymentRow,
    order: typeof orders.$inferSelect,
  ): Promise<StockChange[]> {
    const lines = await tx.select().from(orderLines).where(inArray(orderLines.id, payment.lineIds));
    const stock: StockChange[] = [];
    for (const line of lines) {
      if (line.status === "held") {
        stock.push(await moveStock(tx, line.variantId, "sell", line.qty, { orderLineId: line.id }));
      } else if (line.status === "released") {
        // The hold ran out while the buyer was paying. Take it back if it's still there.
        try {
          await moveStock(tx, line.variantId, "reserve", line.qty, {
            orderLineId: line.id,
            note: "paid after hold expired",
          });
          stock.push(
            await moveStock(tx, line.variantId, "sell", line.qty, { orderLineId: line.id }),
          );
        } catch (err) {
          if (!(err instanceof OutOfStockError)) throw err;
          await tx.insert(attention).values({
            sessionId: order.sessionId,
            kind: "paid_but_gone",
            summary:
              "Paid after the hold expired and the item was taken by someone else. Refund or substitute.",
            orderId: order.id,
            buyerId: order.buyerId,
          });
          continue;
        }
      } else {
        continue;
      }
      await tx
        .update(orderLines)
        .set({ status: "paid", holdExpiresAt: null })
        .where(eq(orderLines.id, line.id));
    }
    return stock;
  }

  /** Called from the webhook route once the signature is verified. */
  async function onWebhookEvent(event: { event_type: string; resource?: Record<string, unknown> }) {
    const resource = event.resource ?? {};
    switch (event.event_type) {
      case "CHECKOUT.ORDER.APPROVED": {
        // The buyer approved but may have closed the window before our capture
        // call ran. Capturing here is idempotent.
        const id = typeof resource.id === "string" ? resource.id : null;
        if (id)
          await capture(id).catch((err) => log.warn({ err, id }, "capture from webhook failed"));
        break;
      }
      case "PAYMENT.CAPTURE.COMPLETED": {
        const captureId = typeof resource.id === "string" ? resource.id : null;
        const related = (
          resource.supplementary_data as { related_ids?: { order_id?: string } } | undefined
        )?.related_ids;
        const paypalOrderId = related?.order_id;
        if (!captureId || !paypalOrderId) break;
        const [payment] = await db
          .select()
          .from(payments)
          .where(eq(payments.paypalOrderId, paypalOrderId));
        if (payment) await settle(payment.id, captureId, { payerEmail: null, raw: resource });
        break;
      }
      case "PAYMENT.CAPTURE.DENIED":
      case "PAYMENT.CAPTURE.DECLINED": {
        const related = (
          resource.supplementary_data as { related_ids?: { order_id?: string } } | undefined
        )?.related_ids;
        if (related?.order_id) {
          await db
            .update(payments)
            .set({ status: "denied" })
            .where(eq(payments.paypalOrderId, related.order_id));
        }
        break;
      }
      default:
        log.info({ type: event.event_type }, "PayPal webhook ignored");
    }
  }

  /**
   * The seller posted the parcel: add the tracking number to the PayPal
   * transaction (Shipment Tracking, so the buyer sees it in PayPal too and the
   * seller is covered for disputes), mark it shipped, tell the buyer. Orders
   * that go in the same parcel get the same tracking number on their own
   * PayPal transactions.
   */
  async function shipOrder(
    orderId: string,
    input: { carrier: CarrierKey; carrierName?: string; trackingNumber: string },
  ) {
    const trackingNumber = input.trackingNumber.trim();
    if (!trackingNumber) throw new PaymentError("Enter the tracking number");
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) throw new PaymentError("Order not found", 404);
    if (order.status !== "paid")
      throw new PaymentError(`Order #${order.number} is ${order.status}, not ready to ship`);

    const parcel = await db
      .select()
      .from(orders)
      .where(and(eq(orders.shipsWithOrderId, order.id), eq(orders.status, "paid")));
    const known = input.carrier === "other" ? null : CARRIERS[input.carrier];
    const carrierLabel = known?.label ?? (input.carrierName?.trim() || "Other");

    for (const o of [order, ...parcel]) {
      const [payment] = await db
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.orderId, o.id),
            inArray(payments.status, ["captured", "partially_refunded"]),
          ),
        );
      if (!payment?.captureId)
        throw new PaymentError(`Order #${o.number} has no PayPal payment to attach tracking to`);
      const items = await db
        .select({ name: products.name, sku: variants.sku, qty: orderLines.qty })
        .from(orderLines)
        .innerJoin(variants, eq(variants.id, orderLines.variantId))
        .innerJoin(products, eq(products.id, variants.productId))
        .where(and(eq(orderLines.orderId, o.id), eq(orderLines.status, "paid")));

      let trackerId: string | null = null;
      try {
        const { result } = await paypal.orders.createOrderTracking({
          id: payment.paypalOrderId,
          body: {
            captureId: payment.captureId,
            trackingNumber,
            carrier: known?.code ?? ShipmentCarrier.Other,
            ...(known ? {} : { carrierNameOther: carrierLabel }),
            notifyPayer: true,
            items: items.map((i) => ({ name: i.name, sku: i.sku, quantity: String(i.qty) })),
          },
        });
        trackerId = result.purchaseUnits?.[0]?.shipping?.trackers?.at(-1)?.id ?? null;
      } catch (err) {
        const info = describePayPalError(err);
        log.error({ err, info, order: o.number }, "PayPal tracking failed");
        throw new PaymentError(
          `PayPal didn't take the tracking number: ${info.message}`,
          502,
          info.issue,
        );
      }

      await db.transaction(async (tx) => {
        await tx.insert(shipments).values({
          orderId: o.id,
          carrier: carrierLabel,
          trackingNumber,
          paypalTrackerId: trackerId,
        });
        await tx
          .update(orders)
          .set({ status: "shipped", shippedAt: new Date() })
          .where(eq(orders.id, o.id));
      });
    }

    await notify.orders([order.id, ...parcel.map((o) => o.id)]);
    const [buyer] = await db
      .select({ locale: buyers.locale })
      .from(buyers)
      .where(eq(buyers.id, order.buyerId));
    await notify.privateTo(
      order.sessionId,
      order.buyerId,
      phrase(buyer?.locale ?? null, "shipped", { carrier: carrierLabel, tracking: trackingNumber }),
    );
  }

  /**
   * Money arrived some other way than our checkout button (a PayPal invoice):
   * record it as a payment for those lines and settle the order the usual way.
   */
  async function settleExternal(input: {
    orderId: string;
    lineIds: string[];
    amountCents: number;
    currency: string;
    reference: string;
    captureId: string;
    raw: unknown;
  }) {
    const [existing] = await db
      .select()
      .from(payments)
      .where(eq(payments.paypalOrderId, input.reference));
    const paymentId = existing?.id ?? randomUUID();
    if (!existing) {
      await db.insert(payments).values({
        id: paymentId,
        orderId: input.orderId,
        paypalOrderId: input.reference,
        status: "created",
        amountCents: input.amountCents,
        currency: input.currency,
        lineIds: input.lineIds,
      });
    }
    await settle(paymentId, input.captureId, { payerEmail: null, raw: input.raw });
  }

  return { createForOrder, capture, refundLine, shipOrder, settleExternal, onWebhookEvent };
}

export type Payments = ReturnType<typeof createPayments>;
