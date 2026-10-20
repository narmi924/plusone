import type { TaskContext } from "@renderinc/sdk/workflows";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, runMigrations } from "../db/client.js";
import { buyers, liveSessions, orderLines, variants } from "../db/schema.js";
import { seedDemo } from "../db/seed.js";
import type { Invoicing } from "../paypal/invoicing.js";
import type { Pushes } from "../realtime.js";
import { createNotifier } from "../services/notify.js";
import { getOrderDTO, holdItem, openOrderFor, recalcOrder } from "../services/orders.js";
import { closeOutLive, provideJobDeps, remindToPay } from "./tasks.js";

// The end of the video: the host ends the live, everyone who still owes gets
// an invoice (one PayPal hiccup doesn't stop the others), and the recap lands
// in the seller's book. Plus the nudge a buyer gets before their hold runs out.
const url =
  process.env.TEST_DATABASE_URL ?? "postgres://plusone:plusone@localhost:5432/plusone_test";
const { db, pool } = createDb(url);

beforeAll(async () => {
  await runMigrations(db);
  await seedDemo(db);
});
afterAll(() => pool.end());

describe("closeOutLive", () => {
  it("invoices each buyer who owes, then writes the recap", async () => {
    const [session] = await db.select().from(liveSessions);
    const [blue] = await db.select().from(variants).where(eq(variants.sku, "A1-BLUE-M"));
    const [sage] = await db.select().from(variants).where(eq(variants.sku, "A1-SAGE-L"));
    if (!session || !blue || !sage) throw new Error("seed missing");
    const people = await db
      .insert(buyers)
      .values([
        { name: "Aisha", email: "aisha@example.com", tokenHash: "co-a" },
        { name: "Ben", email: "ben@example.com", tokenHash: "co-b" },
      ])
      .returning();
    const orderIds: string[] = [];
    for (const [i, buyer] of people.entries()) {
      const variant = i === 0 ? blue : sage;
      orderIds.push(
        await db.transaction(async (tx) => {
          const order = await openOrderFor(tx, {
            sessionId: session.id,
            buyerId: buyer.id,
            sellerId: session.sellerId,
          });
          await holdItem(tx, { order, variantId: variant.id, qty: 1, holdMinutes: 15 });
          return order.id;
        }),
      );
    }

    // PayPal takes the first invoice and fails the second.
    const invoiceOrder = vi.fn(async (orderId: string) => {
      if (orderId === orderIds[1]) throw new Error("PayPal 503");
      return { paypalInvoiceId: `INV-${orderId.slice(0, 4)}` };
    });
    const pushes = {
      message: vi.fn(),
      order: vi.fn(),
      stock: vi.fn(),
      sessionChanged: vi.fn(),
      waitlistChanged: vi.fn(),
      attentionChanged: vi.fn(),
      recapChanged: vi.fn(),
    } satisfies Pushes;
    provideJobDeps(async () => ({
      deps: {
        db,
        notify: createNotifier({ db, realtime: pushes }),
        pushes,
        invoicing: { invoiceOrder } as unknown as Invoicing,
        anthropicKey: null,
        log: pino({ level: "silent" }),
      },
      done: async () => undefined,
    }));
    const ctx: TaskContext = {
      metadata: {},
      run: async (t, ...args) => t.func(ctx, ...args),
    };

    const result = await closeOutLive.func(ctx, session.id);

    expect(invoiceOrder).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ owing: 2, invoiced: 1, failed: 1 });
    const [after] = await db
      .select({ recap: liveSessions.recap })
      .from(liveSessions)
      .where(eq(liveSessions.id, session.id));
    expect(after?.recap?.headline).toBe("0 pieces, $0.00 in");
    expect(after?.recap?.notes[0]).toContain("2 still owe");
    expect(pushes.recapChanged).toHaveBeenCalledWith(session.id);
  });

  it("reminds a buyer before the hold runs out, unless the hold moved", async () => {
    const [session] = await db.select().from(liveSessions);
    const [variant] = await db.select().from(variants).where(eq(variants.sku, "A2-WHITE-M"));
    if (!session || !variant) throw new Error("seed missing");
    const [buyer] = await db
      .insert(buyers)
      .values({ name: "Siti", email: "siti@example.com", tokenHash: "rm-s", locale: "ms" })
      .returning();
    if (!buyer) throw new Error("buyer");
    const orderId = await db.transaction(async (tx) => {
      const order = await openOrderFor(tx, {
        sessionId: session.id,
        buyerId: buyer.id,
        sellerId: session.sellerId,
      });
      const held = await holdItem(tx, { order, variantId: variant.id, qty: 1, holdMinutes: 15 });
      // Five minutes left: the reminder is due now.
      await tx
        .update(orderLines)
        .set({ holdExpiresAt: new Date(Date.now() + 5 * 60_000) })
        .where(eq(orderLines.id, held.lineId));
      await recalcOrder(tx, order.id);
      return order.id;
    });
    const endsAt = (await getOrderDTO(db, orderId))?.holdExpiresAt;
    if (!endsAt) throw new Error("no hold end");

    const pushes = {
      message: vi.fn(),
      order: vi.fn(),
      stock: vi.fn(),
      sessionChanged: vi.fn(),
      waitlistChanged: vi.fn(),
      attentionChanged: vi.fn(),
      recapChanged: vi.fn(),
    } satisfies Pushes;
    provideJobDeps(async () => ({
      deps: {
        db,
        notify: createNotifier({ db, realtime: pushes }),
        pushes,
        invoicing: null,
        anthropicKey: null,
        log: pino({ level: "silent" }),
      },
      done: async () => undefined,
    }));
    const ctx: TaskContext = { metadata: {}, run: async (t, ...args) => t.func(ctx, ...args) };

    expect(await remindToPay.func(ctx, orderId, endsAt)).toMatchObject({ sent: true });
    expect(pushes.message).toHaveBeenCalledTimes(1);
    expect(pushes.message.mock.calls[0]?.[0].body).toContain("Peringatan");

    // A reminder set for an older hold end stays quiet.
    const stale = new Date(Date.parse(endsAt) - 60_000).toISOString();
    expect(await remindToPay.func(ctx, orderId, stale)).toMatchObject({
      sent: false,
      reason: "hold changed",
    });
  });
});
