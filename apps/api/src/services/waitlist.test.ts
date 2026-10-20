import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "../db/client.js";
import { buyers, liveSessions, orderLines, orders, variants, waitlist } from "../db/schema.js";
import { seedDemo } from "../db/seed.js";
import { releaseExpiredHolds } from "./holds.js";
import { holdItem, openOrderFor } from "./orders.js";
import { joinWaitlist } from "./waitlist.js";

// Video scene 3: the last Blue M is held by A, B is waiting for it, A's hold
// runs out, and B ends up holding it without anyone touching anything.
const url =
  process.env.TEST_DATABASE_URL ?? "postgres://plusone:plusone@localhost:5432/plusone_test";
const { db, pool } = createDb(url);

beforeAll(async () => {
  await runMigrations(db);
  await seedDemo(db);
});
afterAll(() => pool.end());

describe("waitlist", () => {
  it("hands a run-out hold to the next person waiting", async () => {
    const [session] = await db.select().from(liveSessions);
    const [variant] = await db.select().from(variants).where(eq(variants.sku, "A1-BLUE-M"));
    if (!session || !variant) throw new Error("seed missing");
    const [a, b] = await db
      .insert(buyers)
      .values([
        { name: "A", email: "a@example.com", tokenHash: "wl-a" },
        { name: "B", email: "b@example.com", tokenHash: "wl-b" },
      ])
      .returning();
    if (!a || !b) throw new Error("buyers");

    const held = await db.transaction(async (tx) => {
      const order = await openOrderFor(tx, {
        sessionId: session.id,
        buyerId: a.id,
        sellerId: session.sellerId,
      });
      return holdItem(tx, { order, variantId: variant.id, qty: 1, holdMinutes: 15 });
    });
    const place = await db.transaction((tx) =>
      joinWaitlist(tx, { sessionId: session.id, variantId: variant.id, buyerId: b.id, qty: 1 }),
    );
    expect(place).toBe(1);

    // A's hold runs out.
    await db
      .update(orderLines)
      .set({ holdExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(orderLines.id, held.lineId));
    const released = await releaseExpiredHolds(db);

    expect(released).toHaveLength(1);
    expect(released[0]?.offers.map((o) => o.buyerId)).toEqual([b.id]);
    const [aLine] = await db.select().from(orderLines).where(eq(orderLines.id, held.lineId));
    expect(aLine?.status).toBe("released");

    const bLines = await db
      .select({ status: orderLines.status })
      .from(orderLines)
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .where(and(eq(orders.buyerId, b.id), eq(orderLines.variantId, variant.id)));
    expect(bLines).toEqual([{ status: "held" }]);

    const [entry] = await db.select().from(waitlist).where(eq(waitlist.buyerId, b.id));
    expect(entry?.status).toBe("filled");
    const [after] = await db.select().from(variants).where(eq(variants.id, variant.id));
    expect(after).toMatchObject({ available: 0, reserved: 1 });
  });
});
