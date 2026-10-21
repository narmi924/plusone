import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { buyers, liveSessions, products } from "../db/schema.js";
import { newBuyerToken } from "../lib/auth.js";
import type { ChatHandler } from "../realtime.js";
import { setShowcase } from "./catalog.js";

// Public demo: a judge alone in the shop can play a busy minute of a real
// live. A handful of buyers talk the way they do (mixed languages, changes,
// a question for the seller, a race for the last one) through the same chat
// pipeline real buyers use. Nothing here is scripted on the answering side.

const LINES: Array<[string, string]> = [
  ["Aisha", "+1 blue M"],
  ["Ben", "+1 blue S"],
  ["Siti", "nak saiz L warna sage satu"],
  ["Farah", "pleated skirt black S one"],
  ["Mei", "要一件 blue 的 S"],
  ["Ben", "change to L, don't add another"],
  ["Dewi", "can you shorten the dress for me if I buy?"],
  ["Chloe", "blue M, if no M forget it, don't want other colour"],
  ["Farah", "sorry cancel the skirt, wrong size"],
  ["Wei Ming", "+1 the rattan bag"],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createSampleCrowd(deps: {
  db: Db;
  receive: ChatHandler;
  onShowcase: (sessionId: string, productId: string, previousProductId: string | null) => void;
  log: FastifyBaseLogger;
}) {
  const { db, log } = deps;
  let playing = false;

  async function play(sessionId: string) {
    const [session] = await db.select().from(liveSessions).where(eq(liveSessions.id, sessionId));
    if (session?.status !== "live") return;
    // Start on the dress, like the host would.
    const [dress] = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.code, "A1"))
      .limit(1);
    if (dress) {
      const shown = await db.transaction((tx) => setShowcase(tx, sessionId, dress.id));
      deps.onShowcase(sessionId, shown.productId, shown.previousProductId);
    }
    const people = new Map<string, typeof buyers.$inferSelect>();
    for (const [name, body] of LINES) {
      let buyer = people.get(name);
      if (!buyer) {
        const [row] = await db
          .insert(buyers)
          .values({
            name,
            email: `${name.toLowerCase().replace(/\s+/g, "")}@example.com`,
            tokenHash: newBuyerToken().tokenHash,
          })
          .returning();
        if (!row) continue;
        buyer = row;
        people.set(name, row);
      }
      void deps
        .receive({ sessionId, buyer, body })
        .catch((err: unknown) => log.error({ err }, "sample crowd line failed"));
      await sleep(3500);
    }
  }

  return {
    /** Starts the crowd in the background; false if one is already playing. */
    start(sessionId: string) {
      if (playing) return false;
      playing = true;
      play(sessionId)
        .catch((err: unknown) => log.error({ err }, "sample crowd failed"))
        .finally(() => {
          playing = false;
        });
      return true;
    },
  };
}

export type SampleCrowd = ReturnType<typeof createSampleCrowd>;
