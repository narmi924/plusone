import { formatMoney, type WalletDTO } from "@plusone/shared";
import { and, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { buyers, liveSessions, orders, payments as paymentRows } from "../db/schema.js";
import { PaymentError, type Payments } from "../paypal/payments.js";
import { type Notifier, phrase } from "./notify.js";
import { autopayRoom, recalcOrder } from "./orders.js";

// Auto-pay: a buyer who saved their PayPal can let PlusOne pay for what they
// say during one live, up to a limit they pick. Saying "+1 blue M" is then the
// whole purchase. Each change to the order restarts a short countdown so a
// correction lands first; when it runs out, the saved PayPal is charged.

export const AUTOPAY_LIMITS = [5_000, 10_000, 20_000] as const;

/** "sb-nh…@personal.example.com": enough to recognise, not enough to copy. */
const masked = (email: string | null) => {
  if (!email) return "your PayPal";
  const [name = "", domain = ""] = email.split("@");
  return `${name.slice(0, 5)}…@${domain}`;
};

export async function getWallet(db: Db, buyerId: string, sessionId: string): Promise<WalletDTO> {
  const [buyer] = await db.select().from(buyers).where(eq(buyers.id, buyerId));
  if (!buyer?.paypalVaultId) return { savedPayPal: null, autopay: null };
  const on = buyer.autopaySessionId === sessionId && buyer.autopayLimitCents;
  return {
    savedPayPal: masked(buyer.paypalEmail),
    autopay: on
      ? {
          limitCents: buyer.autopayLimitCents ?? 0,
          spentCents: (buyer.autopayLimitCents ?? 0) - (await autopayRoom(db, buyer, sessionId)),
        }
      : null,
  };
}

/** Turns auto-pay on (with a limit) or off for this live, and restarts the countdown on any open order. */
export async function setAutopay(
  db: Db,
  notify: Notifier,
  input: { buyerId: string; sessionId: string; limitCents: number | null },
) {
  const [buyer] = await db.select().from(buyers).where(eq(buyers.id, input.buyerId));
  if (!buyer?.paypalVaultId)
    throw new PaymentError("Save your PayPal at checkout first, then turn on auto-pay.", 409);
  await db
    .update(buyers)
    .set(
      input.limitCents
        ? { autopaySessionId: input.sessionId, autopayLimitCents: input.limitCents }
        : { autopaySessionId: null, autopayLimitCents: null },
    )
    .where(eq(buyers.id, input.buyerId));
  await reArm(db, notify, input.buyerId, input.sessionId);
}

/** Recomputes the buyer's open orders in this live so their countdown matches the new setting. */
export async function reArm(db: Db, notify: Notifier, buyerId: string, sessionId?: string) {
  const open = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.buyerId, buyerId),
        eq(orders.status, "reserved"),
        ...(sessionId ? [eq(orders.sessionId, sessionId)] : []),
      ),
    );
  for (const o of open) await db.transaction((tx) => recalcOrder(tx, o.id));
  await notify.orders(open.map((o) => o.id));
}

/**
 * The buyer is talking (or PlusOne asked them something): push any auto-pay
 * countdown out so what they're about to say lands before the money moves.
 */
export async function holdOff(
  db: Db,
  notify: Notifier,
  input: { buyerId: string; sessionId: string; ms: number },
) {
  const pushed = await db
    .update(orders)
    .set({
      autopayAt: sql`greatest(${orders.autopayAt}, now() + make_interval(secs => ${input.ms / 1000}))`,
    })
    .where(
      and(
        eq(orders.buyerId, input.buyerId),
        eq(orders.sessionId, input.sessionId),
        eq(orders.status, "reserved"),
        isNotNull(orders.autopayAt),
      ),
    )
    .returning({ id: orders.id });
  if (pushed.length > 0) await notify.orders(pushed.map((o) => o.id));
}

/** Pays orders whose auto-pay countdown ran out. Returns a stop function. */
export function startAutopay(deps: {
  db: Db;
  payments: Payments;
  notify: Notifier;
  log: FastifyBaseLogger;
  everyMs?: number;
}) {
  const { db, payments, notify, log } = deps;
  let running = false;

  async function payOne(o: { id: string; buyerId: string; sessionId: string }) {
    // Not while the buyer is in a PayPal window for it, and not after the live
    // ended (those orders get a PayPal invoice instead).
    const [inCheckout] = await db
      .select({ id: paymentRows.id })
      .from(paymentRows)
      .where(
        and(
          eq(paymentRows.orderId, o.id),
          eq(paymentRows.status, "created"),
          gt(paymentRows.createdAt, new Date(Date.now() - 5 * 60_000)),
        ),
      );
    const [live] = await db
      .select({ status: liveSessions.status })
      .from(liveSessions)
      .where(eq(liveSessions.id, o.sessionId));
    if (inCheckout || live?.status !== "live") return;

    const [buyer] = await db
      .select({ locale: buyers.locale })
      .from(buyers)
      .where(eq(buyers.id, o.buyerId));
    const locale = buyer?.locale ?? null;
    try {
      const paid = await payments.payWithSaved(o.id, o.buyerId, "auto");
      const wallet = await getWallet(db, o.buyerId, o.sessionId);
      const currency = paid?.currency ?? "USD";
      await notify.privateTo(
        o.sessionId,
        o.buyerId,
        phrase(locale, "autopaid", {
          amount: formatMoney(paid?.totalCents ?? 0, currency),
          left: formatMoney(
            Math.max(0, (wallet.autopay?.limitCents ?? 0) - (wallet.autopay?.spentCents ?? 0)),
            currency,
          ),
        }),
      );
    } catch (err) {
      const reason =
        err instanceof PaymentError && err.issue === "AUTOPAY_LIMIT"
          ? "it's over tonight's limit"
          : err instanceof PaymentError
            ? err.message
            : "PayPal didn't answer";
      log.warn({ err, orderId: o.id }, "auto-pay failed");
      // A decline turns auto-pay off so it doesn't try again behind the buyer's back.
      if (!(err instanceof PaymentError && err.issue === "AUTOPAY_LIMIT")) {
        await db
          .update(buyers)
          .set({ autopaySessionId: null, autopayLimitCents: null })
          .where(eq(buyers.id, o.buyerId));
      }
      await notify.orders([o.id]);
      await notify.privateTo(o.sessionId, o.buyerId, phrase(locale, "autopayStopped", { reason }));
    }
  }

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Claim due orders by clearing their countdown, so each is paid once.
      const due = await db
        .update(orders)
        .set({ autopayAt: null })
        .where(
          and(
            lte(orders.autopayAt, new Date()),
            inArray(orders.status, ["reserved"]),
            sql`${orders.id} IN (SELECT id FROM orders WHERE autopay_at <= now() LIMIT 10 FOR UPDATE SKIP LOCKED)`,
          ),
        )
        .returning({ id: orders.id, buyerId: orders.buyerId, sessionId: orders.sessionId });
      for (const o of due) await payOne(o);
    } catch (err) {
      log.error({ err }, "auto-pay sweep failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.everyMs ?? 1_000);
  return () => clearInterval(timer);
}
