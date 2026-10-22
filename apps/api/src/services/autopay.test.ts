import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, runMigrations } from "../db/client.js";
import { buyers, liveSessions, orders, variants } from "../db/schema.js";
import { seedDemo } from "../db/seed.js";
import type { Payments } from "../paypal/payments.js";
import type { Pushes } from "../realtime.js";
import { holdOff, startAutopay } from "./autopay.js";
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
    await new Promise((r) => setTimeout(r, 400));
    for (const stop of stops) stop();
    const forThisOrder = payWithSaved.mock.calls.filter((c) => c[0] === order.id);
    expect(forThisOrder).toHaveLength(1);
  });
});
