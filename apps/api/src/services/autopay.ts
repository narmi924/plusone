import { formatMoney, type WalletDTO } from "@plusone/shared";
import { and, eq, gt, inArray, isNotNull, like, lte, or, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import {
  buyers,
  chatMessages,
  liveSessions,
  orders,
  payments as paymentRows,
} from "../db/schema.js";
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
 * The buyer said something: push any auto-pay countdown out so it lands before
 * the money moves. If PlusOne was waiting for their answer, this is it: the
 * countdown starts again from the top.
 */
export async function holdOff(
  db: Db,
  notify: Notifier,
  input: { buyerId: string; sessionId: string; ms: number },
) {
  const pushed = await db
    .update(orders)
    .set({
      autopayWaiting: false,
      autopayAt: sql`case when ${orders.autopayWaiting} then now() + make_interval(secs => ${input.ms / 1000})
        else greatest(${orders.autopayAt}, now() + make_interval(secs => ${input.ms / 1000})) end`,
    })
    .where(
      and(
        eq(orders.buyerId, input.buyerId),
        eq(orders.sessionId, input.sessionId),
        eq(orders.status, "reserved"),
        or(isNotNull(orders.autopayAt), eq(orders.autopayWaiting, true)),
      ),
    )
    .returning({ id: orders.id });
  if (pushed.length > 0) await notify.orders(pushed.map((o) => o.id));
}

/** PlusOne asked the buyer a question: no auto-pay until they answer, however long that takes. */
export async function waitForAnswer(
  db: Db,
  notify: Notifier,
  input: { buyerId: string; sessionId: string },
) {
  const [buyer] = await db
    .select({ vault: buyers.paypalVaultId, autopayIn: buyers.autopaySessionId })
    .from(buyers)
    .where(eq(buyers.id, input.buyerId));
  if (!buyer?.vault || buyer.autopayIn !== input.sessionId) return;
  const held = await db
    .update(orders)
    .set({ autopayWaiting: true, autopayAt: null })
    .where(
      and(
        eq(orders.buyerId, input.buyerId),
        eq(orders.sessionId, input.sessionId),
        eq(orders.status, "reserved"),
      ),
    )
    .returning({ id: orders.id });
  if (held.length > 0) await notify.orders(held.map((o) => o.id));
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
          // A recent checkout, or a saved-PayPal charge we never heard back about.
          or(
            gt(paymentRows.createdAt, new Date(Date.now() - 5 * 60_000)),
            like(paymentRows.paypalOrderId, "pending-%"),
          ),
        ),
      );
    const [live] = await db
      .select({ status: liveSessions.status })
      .from(liveSessions)
      .where(eq(liveSessions.id, o.sessionId));
    if (inCheckout || live?.status !== "live") return;

    // Something they said is still being read (it could be "cancel that"):
    // look again in a few seconds instead of paying over it.
    const [unread] = await db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.buyerId, o.buyerId),
          eq(chatMessages.sessionId, o.sessionId),
          eq(chatMessages.authorKind, "buyer"),
          inArray(chatMessages.status, ["received", "understood"]),
          gt(chatMessages.createdAt, new Date(Date.now() - 2 * 60_000)),
        ),
      )
      .limit(1);
    if (unread) {
      await db
        .update(orders)
        .set({ autopayAt: new Date(Date.now() + 5_000) })
        .where(and(eq(orders.id, o.id), eq(orders.autopayWaiting, false)));
      return;
    }

    const [buyer] = await db
      .select({
        locale: buyers.locale,
        vault: buyers.paypalVaultId,
        autopayIn: buyers.autopaySessionId,
      })
      .from(buyers)
      .where(eq(buyers.id, o.buyerId));
    // Turned off (or PayPal forgotten) since the countdown started: nothing to do.
    if (!buyer?.vault || buyer.autopayIn !== o.sessionId) return;
    const locale = buyer.locale ?? null;
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
            eq(orders.autopayWaiting, false),
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
