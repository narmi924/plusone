import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, runMigrations } from "../db/client.js";
import { buyers, chatMessages, liveSessions, orders, variants } from "../db/schema.js";
import { seedDemo } from "../db/seed.js";
import type { Payments } from "../paypal/payments.js";
import type { Pushes } from "../realtime.js";
import { holdOff, startAutopay, waitForAnswer } from "./autopay.js";
import { createNotifier } from "./notify.js";
import { holdItem, openOrderFor } from "./orders.js";

// Auto-pay moves real money without a tap, so: it only arms for a buyer who
// turned it on and is under their limit, talking pushes it back, and an order
// is charged once even with two sweepers racing.
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

beforeAll(async () => {
  await runMigrations(db);
  await seedDemo(db);
});
afterAll(() => pool.end());

async function buyerHolding(sku: string, wallet: { limitCents: number | null }) {
  const [session] = await db.select().from(liveSessions);
  const [variant] = await db.select().from(variants).where(eq(variants.sku, sku));
  if (!session || !variant) throw new Error("seed missing");
  const [buyer] = await db
    .insert(buyers)
    .values({
      name: sku,
      email: `${sku}@example.com`,
      tokenHash: `ap-${sku}`,
      paypalVaultId: "vault-1",
      autopaySessionId: wallet.limitCents ? session.id : null,
      autopayLimitCents: wallet.limitCents,
    })
    .returning();
  if (!buyer) throw new Error("no buyer");
  const orderId = await db.transaction(async (tx) => {
    const order = await openOrderFor(tx, {
      sessionId: session.id,
      buyerId: buyer.id,
      sellerId: session.sellerId,
    });
    await holdItem(tx, { order, variantId: variant.id, qty: 1, holdMinutes: 15 });
    return order.id;
  });
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new Error("no order");
  return { order, buyer, sessionId: session.id };
}

describe("auto-pay", () => {
  it("arms only for a buyer who turned it on and is under their limit", async () => {
    const on = await buyerHolding("A2-WHITE-M", { limitCents: 10_000 });
    const off = await buyerHolding("A7-FLORAL", { limitCents: null });
    const over = await buyerHolding("A6-OAT", { limitCents: 1_000 });
    expect(on.order.autopayAt?.getTime()).toBeGreaterThan(Date.now());
    expect(off.order.autopayAt).toBeNull();
    expect(over.order.autopayAt).toBeNull();
  });

  it("pushes the countdown back while the buyer is talking", async () => {
    const { order, buyer, sessionId } = await buyerHolding("A8", { limitCents: 10_000 });
    await holdOff(db, notify, { buyerId: buyer.id, sessionId, ms: 60_000 });
    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(after?.autopayAt?.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it("charges a due order once, even with two sweepers", async () => {
    const { order } = await buyerHolding("A3-BLACK-M", { limitCents: 10_000 });
    await db
      .update(orders)
      .set({ autopayAt: new Date(Date.now() - 1000) })
      .where(eq(orders.id, order.id));
    const payWithSaved = vi.fn(async (_orderId: string) => null);
    const payments = { payWithSaved } as unknown as Payments;
    const log = pino({ level: "silent" });
    const stops = [
      startAutopay({ db, payments, notify, log, everyMs: 10 }),
      startAutopay({ db, payments, notify, log, everyMs: 10 }),
    ];
    const forThisOrder = () => payWithSaved.mock.calls.filter((c) => c[0] === order.id);
    await vi.waitFor(() => expect(forThisOrder().length).toBeGreaterThan(0), { timeout: 5000 });
    // Let both sweepers keep going for a while: still only the one charge.
    await new Promise((r) => setTimeout(r, 300));
    for (const stop of stops) stop();
    expect(forThisOrder()).toHaveLength(1);
  });

  it("waits for an answer however long it takes, then counts down again", async () => {
    const { order, buyer, sessionId } = await buyerHolding("A5-BLACK-M", { limitCents: 10_000 });
    await waitForAnswer(db, notify, { buyerId: buyer.id, sessionId });
    // Even with a countdown that ran out long ago, nothing is paid while the question is open.
    await db
      .update(orders)
      .set({ autopayAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(orders.id, order.id));
    const payWithSaved = vi.fn(async (_orderId: string) => null);
    const stop = startAutopay({
      db,
      payments: { payWithSaved } as unknown as Payments,
      notify,
      log: pino({ level: "silent" }),
      everyMs: 10,
    });
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(payWithSaved.mock.calls.filter((c) => c[0] === order.id)).toHaveLength(0);

    // The answer comes in: a fresh countdown.
    await holdOff(db, notify, { buyerId: buyer.id, sessionId, ms: 15_000 });
    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(after?.autopayWaiting).toBe(false);
    expect(after?.autopayAt?.getTime()).toBeGreaterThan(Date.now() + 10_000);
  });

  it("doesn't pay over something the buyer said that's still being read", async () => {
    const { order, buyer, sessionId } = await buyerHolding("A5-BLACK-L", { limitCents: 10_000 });
    const due = () =>
      db
        .update(orders)
        .set({ autopayAt: new Date(Date.now() - 1000) })
        .where(eq(orders.id, order.id));
    const run = async () => {
      const payWithSaved = vi.fn(async (_orderId: string) => null);
      const stop = startAutopay({
        db,
        payments: { payWithSaved } as unknown as Payments,
        notify,
        log: pino({ level: "silent" }),
        everyMs: 10,
      });
      await new Promise((r) => setTimeout(r, 300));
      stop();
      return payWithSaved.mock.calls.filter((c) => c[0] === order.id).length;
    };
    // PlusOne's own reply to them doesn't hold anything up...
    await db.insert(chatMessages).values({
      sessionId,
      authorKind: "assistant",
      authorName: "PlusOne",
      buyerId: buyer.id,
      visibility: "private",
      body: "Held for you.",
    });
    await due();
    expect(await run()).toBe(1);
    // ...but "actually cancel that", not yet read, does.
    await db.insert(chatMessages).values({
      sessionId,
      authorKind: "buyer",
      authorName: buyer.name,
      buyerId: buyer.id,
      visibility: "public",
      body: "actually cancel that",
    });
    await due();
    expect(await run()).toBe(0);
  });

  it("never pays by itself for something handed over from the waitlist", async () => {
    const [session] = await db.select().from(liveSessions);
    const [variant] = await db.select().from(variants).where(eq(variants.sku, "A5-CREAM-S"));
    if (!session || !variant) throw new Error("seed missing");
    const [buyer] = await db
      .insert(buyers)
      .values({
        name: "Wren",
        email: "",
        tokenHash: "ap-wren",
        paypalVaultId: "vault-1",
        autopaySessionId: session.id,
        autopayLimitCents: 10_000,
      })
      .returning();
    if (!buyer) throw new Error("no buyer");
    const orderId = await db.transaction(async (tx) => {
      const order = await openOrderFor(tx, {
        sessionId: session.id,
        buyerId: buyer.id,
        sellerId: session.sellerId,
      });
      await holdItem(tx, {
        order,
        variantId: variant.id,
        qty: 1,
        holdMinutes: 15,
        fromWaitlist: true,
      });
      return order.id;
    });
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(order?.autopayAt).toBeNull();
  });
});
