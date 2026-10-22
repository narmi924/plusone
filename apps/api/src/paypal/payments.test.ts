import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Interpretation } from "../ai/interpret.js";
import { createDb, runMigrations } from "../db/client.js";
import { buyers, liveSessions, orderLines, payments, variants, waitlist } from "../db/schema.js";
import { seedDemo } from "../db/seed.js";
import { createChatPipeline } from "../pipeline.js";
import type { Pushes } from "../realtime.js";
import { createNotifier } from "../services/notify.js";
import { holdItem, openOrderFor } from "../services/orders.js";
import { refundShare } from "../services/refunds.js";
import type { PayPal } from "./client.js";
import { createPayments, PaymentError } from "./payments.js";

// Money moves only for what the buyer is buying right now: a checkout opened
// before they changed their order doesn't charge, a "no M then forget it"
// doesn't sign them up for later, and refunds never add up to more than was paid.
const url =
  process.env.TEST_DATABASE_URL ?? "postgres://plusone:plusone@localhost:5432/plusone_test";
const { db, pool } = createDb(url);
const pushes = {
  message: vi.fn(),
  order: vi.fn(),
  stock: vi.fn(),
  sessionChanged: vi.fn(),
  waitlistChanged: vi.fn(),
  attentionChanged: vi.fn(),
  recapChanged: vi.fn(),
} satisfies Pushes;
const notify = createNotifier({ db, realtime: pushes });
const log = pino({ level: "silent" });

beforeAll(async () => {
  await runMigrations(db);
  await seedDemo(db);
});
afterAll(() => pool.end());

async function newBuyer(name: string) {
  const [buyer] = await db
    .insert(buyers)
    .values({ name, email: "", tokenHash: `pay-${name}` })
    .returning();
  if (!buyer) throw new Error("no buyer");
  return buyer;
}

describe("refunds", () => {
  it("shares a bundle discount and never refunds more than was paid", () => {
    // 30 + 20, five off together, five postage: 50 paid.
    const first = refundShare({
      lineCents: 3000,
      itemsCents: 5000,
      paidCents: 5000,
      shippingCents: 500,
      refundedCents: 0,
      last: false,
    });
    const second = refundShare({
      lineCents: 2000,
      itemsCents: 5000,
      paidCents: 5000,
      shippingCents: 500,
      refundedCents: first,
      last: true,
    });
    expect(first).toBe(2700);
    expect(first + second).toBe(5000);
  });
});

describe("capture", () => {
  it("doesn't charge a PayPal window opened before the buyer changed the order", async () => {
    const [session] = await db.select().from(liveSessions);
    const [variant] = await db.select().from(variants).where(eq(variants.sku, "A2-WHITE-M"));
    if (!session || !variant) throw new Error("seed missing");
    const buyer = await newBuyer("Ivy");
    const { orderId, lineId } = await db.transaction(async (tx) => {
      const order = await openOrderFor(tx, {
        sessionId: session.id,
        buyerId: buyer.id,
        sellerId: session.sellerId,
      });
      const hold = await holdItem(tx, { order, variantId: variant.id, qty: 1, holdMinutes: 15 });
      return { orderId: order.id, lineId: hold.lineId };
    });
    await db.insert(payments).values({
      orderId,
      paypalOrderId: "PAYPAL-OLD-WINDOW",
      status: "created",
      amountCents: 3000,
      currency: "USD",
      lineIds: [lineId],
    });
    // She changed the size in chat while the PayPal window was open.
    await db.update(orderLines).set({ status: "cancelled" }).where(eq(orderLines.id, lineId));

    const captureOrder = vi.fn();
    const paypal = { orders: { captureOrder } } as unknown as PayPal;
    const pay = createPayments({ db, paypal, notify, log });
    const err = await pay.capture("PAYPAL-OLD-WINDOW", buyer.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect((err as PaymentError).issue).toBe("ORDER_CHANGED");
    expect(captureOrder).not.toHaveBeenCalled();
    const [row] = await db
      .select()
      .from(payments)
      .where(eq(payments.paypalOrderId, "PAYPAL-OLD-WINDOW"));
    expect(row?.status).toBe("voided");
  });
});

describe("a condition that fails", () => {
  it("puts a plain +1 in line for a sold-out item, but not 'if no M forget it'", async () => {
    const [session] = await db.select().from(liveSessions);
    const [blueM] = await db.select().from(variants).where(eq(variants.sku, "A1-BLUE-M"));
    if (!session || !blueM) throw new Error("seed missing");
    await db.update(variants).set({ available: 0 }).where(eq(variants.id, blueM.id));

    const read = (intent: Interpretation["intent"]): Interpretation => ({
      intent,
      items: [{ sku: "A1-BLUE-M", productCode: "A1", quantity: 1 }],
      targetLines: [],
      condition: intent === "conditional_buy" ? "only Blue M, no other colour" : null,
      confident: true,
      needsSeller: false,
      clarify: null,
      reply: "Blue M is yours.",
      replyIfUnavailable: null,
      language: "en",
    });
    let next: Interpretation = read("conditional_buy");
    const pipeline = createChatPipeline({
      db,
      notify,
      interpret: async () => ({
        interpretation: next,
        usage: {} as never,
        ms: 1,
      }),
      log,
      onMessage: () => undefined,
      onThinking: () => undefined,
      hostSaid: () => [],
    });
    const settled = async (messageId: string) => {
      await vi.waitFor(
        async () => {
          const rows = await db.execute<{ status: string }>(
            `select status from chat_messages where id = '${messageId}'`,
          );
          expect(rows.rows[0]?.status).toBe("applied");
        },
        { timeout: 5000 },
      );
    };

    const chloe = await newBuyer("Chloe");
    const c = await pipeline.receive({
      sessionId: session.id,
      buyer: chloe,
      body: "blue M, if no M forget it",
    });
    await settled(c.id);
    next = read("buy");
    const ben = await newBuyer("Ben2");
    const b = await pipeline.receive({ sessionId: session.id, buyer: ben, body: "+1 blue M" });
    await settled(b.id);

    const inLine = await db.select().from(waitlist).where(eq(waitlist.variantId, blueM.id));
    expect(inLine.map((w) => w.buyerId)).toEqual([ben.id]);
  });
});
