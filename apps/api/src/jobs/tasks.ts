import { task } from "@renderinc/sdk/workflows";
import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { orders } from "../db/schema.js";
import type { Invoicing } from "../paypal/invoicing.js";
import type { Pushes } from "../realtime.js";
import type { Notifier } from "../services/notify.js";
import { REMIND_BEFORE_MS, sendPayReminder } from "../services/reminders.js";
import { composeRecap } from "./recap.js";

// The work that happens around a live rather than in the middle of it. On
// Render every task is a Render Workflows run on its own compute, with its own
// retries; the close-out fans out one run per unpaid buyer. Locally the same
// functions run in-process (runner.ts). Either way a task only touches the
// database and PayPal, and its pushes reach buyers through relay.ts.

export interface JobDeps {
  db: Db;
  notify: Notifier;
  pushes: Pushes;
  invoicing: Invoicing | null;
  anthropicKey: string | null;
  log: FastifyBaseLogger;
}

type Provider = () => Promise<{ deps: JobDeps; done: () => Promise<void> }>;
let provider: Provider | null = null;

/** Where tasks get their database and clients: the web server's, or fresh per run on Render. */
export function provideJobDeps(p: Provider) {
  provider = p;
}

async function withDeps<T>(fn: (deps: JobDeps) => Promise<T>): Promise<T> {
  if (!provider) throw new Error("Job dependencies were not provided");
  const { deps, done } = await provider();
  try {
    return await fn(deps);
  } finally {
    await done();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One buyer who still owes: a PayPal invoice by email, items held until it's due. */
export const invoiceBuyer = task(
  {
    name: "invoiceBuyer",
    timeoutSeconds: 120,
    retry: { maxRetries: 3, waitDurationMs: 2000, backoffScaling: 2 },
  },
  async function invoiceBuyer(_ctx, orderId: string) {
    return withDeps(async ({ invoicing }) => {
      if (!invoicing) throw new Error("PayPal is not configured");
      const row = await invoicing.invoiceOrder(orderId);
      return { orderId, invoiceId: row?.paypalInvoiceId ?? null };
    });
  },
);

/** Claude reads the night and leaves the seller a short note in the order book. */
export const writeRecap = task(
  { name: "writeRecap", timeoutSeconds: 180, retry: { maxRetries: 2, waitDurationMs: 3000 } },
  async function writeRecap(_ctx, sessionId: string) {
    return withDeps(async (deps) => {
      const recap = await composeRecap(deps, sessionId);
      deps.pushes.recapChanged(sessionId);
      return { notes: recap.notes.length, byAi: recap.byAi };
    });
  },
);

/** The host ended the live: invoice everyone who still owes, all at once, then the recap. */
export const closeOutLive = task(
  { name: "closeOutLive", timeoutSeconds: 900, retry: { maxRetries: 1, waitDurationMs: 5000 } },
  async function closeOutLive(ctx, sessionId: string) {
    const owing = await withDeps(({ db }) =>
      db
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.sessionId, sessionId), eq(orders.status, "reserved"))),
    );
    // Each invoice is its own run: one buyer's PayPal hiccup retries alone.
    const results = await Promise.allSettled(owing.map((o) => ctx.run(invoiceBuyer, o.id)));
    // The recap comes after, so it can say who got an invoice.
    const recap = await ctx.run(writeRecap, sessionId);
    return {
      owing: owing.length,
      invoiced: results.filter((r) => r.status === "fulfilled" && r.value.invoiceId).length,
      failed: results.filter((r) => r.status === "rejected").length,
      recap,
    };
  },
);

/** A few minutes before a hold runs out, nudge the buyer, unless they paid or it moved. */
export const remindToPay = task(
  { name: "remindToPay", timeoutSeconds: 3600, retry: { maxRetries: 2, waitDurationMs: 5000 } },
  async function remindToPay(_ctx, orderId: string, holdEndsAt: string) {
    // An absolute time, so a retry doesn't wait the whole way again.
    const wait = Date.parse(holdEndsAt) - REMIND_BEFORE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    return withDeps(({ db, notify }) => sendPayReminder(db, notify, orderId, holdEndsAt));
  },
);
