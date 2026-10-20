import type { ChatOption, StockChange } from "@plusone/shared";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Interpretation, Interpreter } from "./ai/interpret.js";
import type { Db } from "./db/client.js";
import {
  attention,
  buyers,
  chatMessages,
  orderLines,
  orders,
  products,
  variants,
  waitlist,
} from "./db/schema.js";
import {
  describeVariant,
  getSessionDTO,
  getSessionRow,
  previousShowcaseProductId,
  showcaseStartedAt,
} from "./services/catalog.js";
import { insertMessage } from "./services/chat.js";
import { type Notifier, phrase } from "./services/notify.js";
import {
  cancelLine,
  holdItem,
  LineNotHeldError,
  openOrderFor,
  replaceLine,
} from "./services/orders.js";
import { activeDealsText, activeLimits } from "./services/rules.js";
import { OutOfStockError } from "./services/stock.js";
import {
  joinWaitlist,
  leaveWaitlist,
  offerFreedStock,
  type WaitlistOffer,
} from "./services/waitlist.js";

type Buyer = typeof buyers.$inferSelect;
type Message = typeof chatMessages.$inferSelect;
type SessionRow = NonNullable<Awaited<ReturnType<typeof getSessionRow>>>;

type Understood =
  | {
      ok: true;
      interpretation: Interpretation;
      /** L1, L2... -> order line ids; W1, W2... -> waitlist entry ids. */
      refs: Map<string, string>;
      meta: Record<string, unknown>;
    }
  | { ok: false; error: unknown };

/**
 * Buyer message -> understanding -> orders and stock.
 *
 * Understanding runs in parallel across buyers (each model call takes a few
 * seconds), but a buyer's next message waits until their previous one has been
 * applied, so "change to L" sees the order "+1" just made. Applying always
 * happens in the order the server received messages, whatever order the model
 * calls finish in: first come, first served.
 */
export function createChatPipeline(deps: {
  db: Db;
  notify: Notifier;
  interpret: Interpreter | null;
  log: FastifyBaseLogger;
  onMessage: (msg: Message) => void;
  onThinking: (sessionId: string, buyerId: string, messageId: string, done: boolean) => void;
  /** What the host said lately, if PlusOne is listening to them. */
  hostSaid: (sessionId: string) => string[];
}) {
  const { db, notify, log } = deps;
  const sessionTail = new Map<string, Promise<void>>();
  const buyerTail = new Map<string, Promise<void>>();

  function enqueue(map: Map<string, Promise<void>>, key: string, p: Promise<void>) {
    map.set(key, p);
    void p.finally(() => {
      if (map.get(key) === p) map.delete(key);
    });
  }

  async function receive(input: { sessionId: string; buyer: Buyer; body: string }) {
    const row = await getSessionRow(db, input.sessionId);
    if (!row) throw new Error("Unknown session");
    if (row.session.status === "ended") throw new Error("The live has ended");

    const msg = await insertMessage(db, {
      sessionId: input.sessionId,
      authorKind: "buyer",
      authorName: input.buyer.name,
      buyerId: input.buyer.id,
      visibility: "public",
      body: input.body,
      showcaseProductId: row.session.currentProductId,
    });
    deps.onMessage(msg);

    const understood: Promise<Understood> = (buyerTail.get(input.buyer.id) ?? Promise.resolve())
      .then(() => understand(msg, input.buyer, row))
      .then(
        (r) => r,
        (error: unknown) => ({ ok: false as const, error }),
      );

    const applied = Promise.all([sessionTail.get(input.sessionId), understood])
      .then(([, u]) => apply(msg, input.buyer, row, u))
      .catch((err: unknown) => log.error({ err, messageId: msg.id }, "applying message failed"));

    enqueue(sessionTail, input.sessionId, applied);
    enqueue(buyerTail, input.buyer.id, applied);
    return { id: msg.id };
  }

  async function understand(msg: Message, buyer: Buyer, row: SessionRow): Promise<Understood> {
    if (!deps.interpret) return { ok: false, error: new Error("ANTHROPIC_API_KEY is not set") };
    deps.onThinking(msg.sessionId, buyer.id, msg.id, false);

    const session = await getSessionDTO(db, msg.sessionId);
    if (!session) throw new Error("Unknown session");

    const onScreen = session.products.find((p) => p.id === msg.showcaseProductId) ?? null;
    const [shownSince, beforeId] = await Promise.all([
      onScreen ? showcaseStartedAt(db, msg.sessionId, onScreen.id, msg.createdAt) : null,
      previousShowcaseProductId(db, msg.sessionId, msg.showcaseProductId, msg.createdAt),
    ]);
    const shownBefore = session.products.find((p) => p.id === beforeId) ?? null;

    const earlier = await db
      .select({ body: chatMessages.body, createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.sessionId, msg.sessionId),
          eq(chatMessages.buyerId, buyer.id),
          eq(chatMessages.authorKind, "buyer"),
          lt(chatMessages.seq, msg.seq),
        ),
      )
      .orderBy(desc(chatMessages.seq))
      .limit(10);

    const lines = await db
      .select({
        id: orderLines.id,
        sku: variants.sku,
        name: products.name,
        qty: orderLines.qty,
        status: orderLines.status,
      })
      .from(orderLines)
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .innerJoin(variants, eq(variants.id, orderLines.variantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .where(
        and(
          eq(orders.sessionId, msg.sessionId),
          eq(orders.buyerId, buyer.id),
          inArray(orderLines.status, ["held", "paid"]),
        ),
      )
      .orderBy(orderLines.createdAt);

    const waits = await db
      .select({ id: waitlist.id, sku: variants.sku, name: products.name, qty: waitlist.qty })
      .from(waitlist)
      .innerJoin(variants, eq(variants.id, waitlist.variantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .where(
        and(
          eq(waitlist.sessionId, msg.sessionId),
          eq(waitlist.buyerId, buyer.id),
          eq(waitlist.status, "waiting"),
        ),
      )
      .orderBy(waitlist.createdAt);

    const refs = new Map<string, string>([
      ...lines.map((l, i) => [`L${i + 1}`, l.id] as const),
      ...waits.map((w, i) => [`W${i + 1}`, w.id] as const),
    ]);

    const at = msg.createdAt.getTime();
    const result = await deps.interpret({
      sellerName: row.seller.name,
      holdMinutes: row.seller.holdMinutes,
      policies: row.seller.policies,
      products: session.products,
      onScreen: onScreen && {
        code: onScreen.code,
        name: onScreen.name,
        sinceSeconds: shownSince ? (at - shownSince.getTime()) / 1000 : 0,
      },
      shownBefore: shownBefore && { code: shownBefore.code, name: shownBefore.name },
      buyerName: buyer.name,
      recentMessages: earlier
        .reverse()
        .map((m) => ({ secondsAgo: (at - m.createdAt.getTime()) / 1000, body: m.body })),
      openLines: lines.map((l, i) => ({
        ref: `L${i + 1}`,
        sku: l.sku,
        name: l.name,
        qty: l.qty,
        status: l.status,
      })),
      waitlist: waits.map((w, i) => ({ ref: `W${i + 1}`, sku: w.sku, name: w.name, qty: w.qty })),
      deals: await activeDealsText(db, msg.sessionId),
      hostSaid: deps.hostSaid(msg.sessionId),
      message: msg.body,
    });

    return {
      ok: true,
      interpretation: result.interpretation,
      refs,
      meta: { ms: result.ms, usage: result.usage },
    };
  }

  async function reply(
    msg: Message,
    buyer: Buyer,
    body: string,
    options: ChatOption[] | null = null,
  ) {
    if (!body.trim()) return;
    const row = await insertMessage(db, {
      sessionId: msg.sessionId,
      authorKind: "assistant",
      authorName: "PlusOne",
      buyerId: buyer.id,
      visibility: "private",
      body,
      options,
      replyToId: msg.id,
    });
    deps.onMessage(row);
  }

  async function flagForSeller(
    msg: Message,
    buyer: Buyer,
    kind: string,
    summary: string,
    link: { orderId?: string; lineId?: string } = {},
  ) {
    await db.insert(attention).values({
      sessionId: msg.sessionId,
      kind,
      summary,
      buyerId: buyer.id,
      messageId: msg.id,
      orderId: link.orderId ?? null,
      lineId: link.lineId ?? null,
    });
    notify.attentionChanged(msg.sessionId);
  }

  async function setStatus(msg: Message, status: Message["status"], interpretation?: unknown) {
    await db
      .update(chatMessages)
      .set(interpretation === undefined ? { status } : { status, interpretation })
      .where(eq(chatMessages.id, msg.id));
  }

  /** Stock, orders and anyone on a waitlist hear about it after the transaction commits. */
  async function publish(
    sessionId: string,
    orderIds: Iterable<string>,
    stock: StockChange[],
    offers: WaitlistOffer[] = [],
  ) {
    notify.stock(sessionId, stock);
    await notify.orders(orderIds);
    await notify.waitlistOffers(sessionId, offers);
  }

  async function apply(msg: Message, buyer: Buyer, row: SessionRow, u: Understood) {
    deps.onThinking(msg.sessionId, buyer.id, msg.id, true);

    if (!u.ok) {
      log.error({ err: u.error, messageId: msg.id }, "could not understand message");
      await setStatus(msg, "failed");
      await flagForSeller(msg, buyer, "not_understood", `${buyer.name}: "${msg.body}"`);
      await reply(msg, buyer, `Sorry, I didn't catch that. ${row.seller.name} will take a look.`);
      return;
    }

    const it = u.interpretation;
    await setStatus(msg, "understood", { ...it, meta: u.meta });
    // Messages PlusOne sends on its own later (waitlist, hold ran out) use this language.
    if (it.language && it.language !== buyer.locale) {
      await db.update(buyers).set({ locale: it.language }).where(eq(buyers.id, buyer.id));
    }

    switch (it.intent) {
      case "buy":
      case "conditional_buy":
        await applyBuy(msg, buyer, row, it);
        break;
      case "change":
        await applyChange(msg, buyer, it, u.refs);
        break;
      case "cancel":
        await applyCancel(msg, buyer, it, u.refs);
        break;
      default:
        // Questions, stock questions, combined shipping (automatic) and chit-chat
        // change nothing; anything the policies don't cover goes to the seller.
        if (it.needsSeller)
          await flagForSeller(msg, buyer, "question", `${buyer.name}: "${msg.body}"`);
        await reply(msg, buyer, it.reply);
    }
    await setStatus(msg, "applied");
  }

  async function askInstead(msg: Message, buyer: Buyer, it: Interpretation, fallback: string) {
    if (it.clarify) await reply(msg, buyer, it.clarify.question, it.clarify.options.slice(0, 2));
    else await reply(msg, buyer, it.reply || fallback);
  }

  async function applyBuy(msg: Message, buyer: Buyer, row: SessionRow, it: Interpretation) {
    const session = await getSessionDTO(db, msg.sessionId);
    if (!session) return;
    const bySku = new Map(
      session.products.flatMap((p) => p.variants.map((v) => [v.sku, v] as const)),
    );

    const items = it.items.filter((i) => i.quantity > 0);
    const resolved = items.map((i) => (i.sku ? bySku.get(i.sku) : undefined));
    if (!it.confident || it.clarify || items.length === 0 || resolved.some((v) => !v)) {
      await askInstead(msg, buyer, it, "Which one would you like? Tell me the colour and size.");
      return;
    }

    const stock: StockChange[] = [];
    const orderIds = new Set<string>();
    let held = 0;
    let waiting = 0;
    const limits = await activeLimits(db, msg.sessionId);
    let limited: { max: number; variantId: string } | null = null;
    for (const [i, item] of items.entries()) {
      const variant = resolved[i];
      if (!variant) continue;
      // The host's per-person limit, counting what they already hold or bought.
      let quantity = item.quantity;
      const product = session.products.find((p) => p.variants.some((v) => v.id === variant.id));
      const max = product ? limits.get(product.code) : undefined;
      if (product && max !== undefined) {
        const mine = await db
          .select({ qty: orderLines.qty })
          .from(orderLines)
          .innerJoin(orders, eq(orders.id, orderLines.orderId))
          .innerJoin(variants, eq(variants.id, orderLines.variantId))
          .where(
            and(
              eq(orders.sessionId, msg.sessionId),
              eq(orders.buyerId, buyer.id),
              eq(variants.productId, product.id),
              inArray(orderLines.status, ["held", "paid"]),
            ),
          );
        const allowed = max - mine.reduce((n, l) => n + l.qty, 0);
        if (allowed <= 0) {
          limited = { max, variantId: variant.id };
          continue;
        }
        quantity = Math.min(quantity, allowed);
      }
      try {
        const result = await db.transaction(async (tx) => {
          // Check (and lock) stock before opening an order, so a sold-out
          // request doesn't burn an order number.
          const [locked] = await tx
            .select({ available: variants.available })
            .from(variants)
            .where(eq(variants.id, variant.id))
            .for("update");
          if (!locked || locked.available < quantity) {
            throw new OutOfStockError(variant.id, quantity, locked?.available ?? 0);
          }
          const order = await openOrderFor(tx, {
            sessionId: msg.sessionId,
            buyerId: buyer.id,
            sellerId: row.seller.id,
          });
          const hold = await holdItem(tx, {
            order,
            variantId: variant.id,
            qty: quantity,
            holdMinutes: row.seller.holdMinutes,
            sourceMessageId: msg.id,
          });
          return { orderId: order.id, stock: hold.stock };
        });
        orderIds.add(result.orderId);
        stock.push(result.stock);
        held++;
        const what = await describeVariant(db, variant.id);
        await notify.announce(
          msg.sessionId,
          result.stock.available === 0
            ? `${buyer.name} got the last one: ${what}`
            : `${buyer.name} got ${what}${quantity > 1 ? ` x${quantity}` : ""}`,
        );
      } catch (err) {
        if (!(err instanceof OutOfStockError)) throw err;
        // Gone: wait in line for this exact item. If it frees up it's held for them.
        await db.transaction((tx) =>
          joinWaitlist(tx, {
            sessionId: msg.sessionId,
            variantId: variant.id,
            buyerId: buyer.id,
            qty: quantity,
            condition: it.condition,
            sourceMessageId: msg.id,
          }),
        );
        waiting++;
        notify.waitlistChanged(msg.sessionId);
      }
    }

    await publish(msg.sessionId, orderIds, stock);
    if (held === 0 && waiting === 0 && limited) {
      const item = await describeVariant(db, limited.variantId);
      await reply(
        msg,
        buyer,
        phrase(buyer.locale, "limitReached", { item, max: String(limited.max) }),
      );
      return;
    }
    if (held === 0) {
      await reply(
        msg,
        buyer,
        it.replyIfUnavailable ?? "That one is sold out. You're on the waitlist for it.",
      );
    } else {
      await reply(msg, buyer, it.reply);
      if (waiting > 0)
        await flagForSeller(msg, buyer, "partly_sold_out", `${buyer.name}: "${msg.body}"`);
    }
  }

  /** Which of the buyer's lines or waitlist places a change/cancel is about. Falls back to their only held line. */
  async function resolveTargets(
    msg: Message,
    buyer: Buyer,
    it: Interpretation,
    refs: Map<string, string>,
  ) {
    const lineIds: string[] = [];
    const waitIds: string[] = [];
    for (const ref of it.targetLines) {
      const id = refs.get(ref);
      if (!id) continue;
      (ref.startsWith("W") ? waitIds : lineIds).push(id);
    }
    if (lineIds.length === 0 && waitIds.length === 0) {
      const held = await db
        .select({ id: orderLines.id })
        .from(orderLines)
        .innerJoin(orders, eq(orders.id, orderLines.orderId))
        .where(
          and(
            eq(orders.sessionId, msg.sessionId),
            eq(orders.buyerId, buyer.id),
            eq(orderLines.status, "held"),
          ),
        );
      if (held.length === 1 && held[0]) lineIds.push(held[0].id);
    }
    return { lineIds, waitIds };
  }

  /** "Change to L": swap one held item for another option, all or nothing. */
  async function applyChange(
    msg: Message,
    buyer: Buyer,
    it: Interpretation,
    refs: Map<string, string>,
  ) {
    const {
      lineIds: [targetId],
    } = await resolveTargets(msg, buyer, it, refs);
    const item = it.items.find((i) => i.quantity > 0);
    const session = await getSessionDTO(db, msg.sessionId);
    const variant = item?.sku
      ? session?.products.flatMap((p) => p.variants).find((v) => v.sku === item.sku)
      : undefined;

    if (it.needsSeller) {
      await flagForSeller(
        msg,
        buyer,
        "change_paid",
        `${buyer.name}: "${msg.body}"`,
        targetId ? { lineId: targetId } : {},
      );
      await reply(msg, buyer, it.reply);
      return;
    }
    if (!targetId || !item || !variant || !it.confident || it.clarify) {
      await askInstead(msg, buyer, it, "Which item should I change, and to what?");
      return;
    }

    try {
      const result = await db.transaction(async (tx) => {
        const swap = await replaceLine(tx, {
          lineId: targetId,
          variantId: variant.id,
          qty: item.quantity,
          sourceMessageId: msg.id,
        });
        // The old option is back on sale; someone may be waiting for it.
        const offers =
          swap.previousVariantId === variant.id
            ? []
            : await offerFreedStock(tx, msg.sessionId, swap.previousVariantId);
        return { ...swap, offers };
      });
      await publish(msg.sessionId, [result.orderId], result.stock, result.offers);
      await reply(msg, buyer, it.reply);
    } catch (err) {
      if (err instanceof OutOfStockError) {
        await reply(
          msg,
          buyer,
          it.replyIfUnavailable ?? "That option just sold out. You still have your original item.",
        );
      } else if (err instanceof LineNotHeldError) {
        // Paid already, or the hold ran out: the seller decides.
        await flagForSeller(
          msg,
          buyer,
          "change_not_held",
          `${buyer.name}: "${msg.body}" (item ${err.status})`,
          {
            lineId: targetId,
          },
        );
        await reply(msg, buyer, "I've asked the seller to sort that out for you.");
      } else {
        throw err;
      }
    }
  }

  /** "Cancel": give held items back (to the waitlist first). Paid ones need a refund the seller approves. */
  async function applyCancel(
    msg: Message,
    buyer: Buyer,
    it: Interpretation,
    refs: Map<string, string>,
  ) {
    const { lineIds, waitIds } = await resolveTargets(msg, buyer, it, refs);
    if ((lineIds.length === 0 && waitIds.length === 0) || (!it.confident && !it.needsSeller)) {
      await askInstead(msg, buyer, it, "Which item should I cancel?");
      return;
    }

    for (const id of waitIds) await db.transaction((tx) => leaveWaitlist(tx, id));
    if (waitIds.length > 0) notify.waitlistChanged(msg.sessionId);

    const orderIds: string[] = [];
    const stock: StockChange[] = [];
    const offers: WaitlistOffer[] = [];
    for (const lineId of lineIds) {
      try {
        const result = await db.transaction(async (tx) => {
          const cancelled = await cancelLine(tx, lineId);
          return {
            ...cancelled,
            offers: await offerFreedStock(tx, msg.sessionId, cancelled.stock.variantId),
          };
        });
        orderIds.push(result.orderId);
        stock.push(result.stock);
        offers.push(...result.offers);
      } catch (err) {
        if (!(err instanceof LineNotHeldError)) throw err;
        if (err.status === "paid") {
          const [line] = await db.select().from(orderLines).where(eq(orderLines.id, lineId));
          const what = line ? await describeVariant(db, line.variantId) : "an item";
          await flagForSeller(msg, buyer, "cancel_paid", what, {
            lineId,
            ...(line ? { orderId: line.orderId } : {}),
          });
        }
      }
    }
    await publish(msg.sessionId, orderIds, stock, offers);
    await reply(msg, buyer, it.reply);
  }

  return { receive };
}
