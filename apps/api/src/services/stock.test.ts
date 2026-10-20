import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "../db/client.js";
import { buyers, liveSessions, variants } from "../db/schema.js";
import { seedDemo } from "../db/seed.js";
import { holdItem, openOrderFor } from "./orders.js";
import { OutOfStockError } from "./stock.js";

// Runs against a throwaway database next to the dev one (docker compose).
const url =
  process.env.TEST_DATABASE_URL ?? "postgres://plusone:plusone@localhost:5432/plusone_test";
const { db, pool } = createDb(url);

beforeAll(async () => {
  await runMigrations(db);
  await seedDemo(db);
});
afterAll(() => pool.end());

describe("last item", () => {
  it("goes to exactly one of two buyers who ask at the same moment", async () => {
    const [session] = await db.select().from(liveSessions);
    const [variant] = await db.select().from(variants).where(eq(variants.sku, "A1-BLUE-M"));
    if (!session || !variant) throw new Error("seed missing");
    expect(variant.available).toBe(1);

    const people = await db
      .insert(buyers)
      .values([
        { name: "A", email: "a@example.com", tokenHash: "test-a" },
        { name: "B", email: "b@example.com", tokenHash: "test-b" },
      ])
      .returning();

    const attempts = people.map((buyer) =>
      db.transaction(async (tx) => {
        const order = await openOrderFor(tx, {
          sessionId: session.id,
          buyerId: buyer.id,
          sellerId: session.sellerId,
        });
        return holdItem(tx, { order, variantId: variant.id, qty: 1, holdMinutes: 15 });
      }),
    );
    const results = await Promise.allSettled(attempts);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(OutOfStockError);

    const [after] = await db.select().from(variants).where(eq(variants.id, variant.id));
    expect(after).toMatchObject({ available: 0, reserved: 1, sold: 0 });
  });
});
