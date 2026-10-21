import type { RuleDTO } from "@plusone/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { HostProposal } from "../ai/hostSpeech.js";
import type { Db, Tx } from "../db/client.js";
import {
  liveSessions,
  orderLines,
  orders,
  products,
  rules,
  sellers,
  variants,
} from "../db/schema.js";
import { setShowcase } from "./catalog.js";
import { recalcOrder } from "./orders.js";
import { moveStock } from "./stock.js";

// Cards made from what the host said. A card does nothing until the host taps
// Apply; then it changes the catalog (new item, new price), adds a deal or a
// limit, or puts a product on screen.

export type RuleParams = Omit<HostProposal, "kind">;
type RuleRow = typeof rules.$inferSelect;

export function toRuleDTO(row: RuleRow): RuleDTO {
  const p = row.params as RuleParams;
  return {
    id: row.id,
    kind: row.kind as RuleDTO["kind"],
    status: row.status,
    summary: p.summary,
    quote: row.sourceText ?? p.quote,
    productCodes: p.productCodes ?? [],
    discountCents: p.discountCents ?? null,
    maxPerBuyer: p.maxPerBuyer ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listRules(
  tx: Tx,
  sessionId: string,
  statuses: RuleRow["status"][] = ["proposed", "active"],
) {
  const rows = await tx
    .select()
    .from(rules)
    .where(and(eq(rules.sessionId, sessionId), inArray(rules.status, statuses)))
    .orderBy(desc(rules.createdAt));
  return rows.map(toRuleDTO);
}

export async function proposeRules(tx: Tx, sessionId: string, proposals: HostProposal[]) {
  if (proposals.length === 0) return [];
  const rows = await tx
    .insert(rules)
    .values(
      proposals.map(({ kind, ...params }) => ({
        sessionId,
        kind,
        params,
        sourceText: params.quote,
        status: "proposed" as const,
      })),
    )
    .returning();
  return rows.map(toRuleDTO);
}

export async function dismissRule(tx: Tx, ruleId: string) {
  const [row] = await tx
    .update(rules)
    .set({ status: "rejected" })
    .where(and(eq(rules.id, ruleId), eq(rules.status, "proposed")))
    .returning();
  return row ?? null;
}

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency })
    .format(cents / 100)
    .replace(".00", "");

/**
 * The host tapped Apply. Returns what changed so the caller can tell the room,
 * or null if the card was already handled.
 */
export async function applyRule(db: Db, ruleId: string) {
  return db.transaction(async (tx) => {
    const [rule] = await tx.select().from(rules).where(eq(rules.id, ruleId)).for("update");
    if (rule?.status !== "proposed") return null;
    const [session] = await tx
      .select({ session: liveSessions, seller: sellers })
      .from(liveSessions)
      .innerJoin(sellers, eq(sellers.id, liveSessions.sellerId))
      .where(eq(liveSessions.id, rule.sessionId));
    if (!session) return null;
    const p = rule.params as RuleParams;
    const currency = session.seller.currency;
    const sellerProducts = await tx
      .select()
      .from(products)
      .where(eq(products.sellerId, session.seller.id));
    const byCode = (code: string | undefined) => sellerProducts.find((x) => x.code === code);

    let announcement: string | null = null;
    let showcase: { productId: string; previousProductId: string | null } | null = null;
    const touchedOrders: string[] = [];
    // A card that no longer makes sense (product gone, numbers missing) is dropped.
    const reject = async () => {
      await tx.update(rules).set({ status: "rejected" }).where(eq(rules.id, rule.id));
      return {
        rule: toRuleDTO({ ...rule, status: "rejected" }),
        announcement: null,
        showcase: null,
        touchedOrders,
      };
    };

    switch (rule.kind) {
      case "show_product": {
        const product = byCode(p.productCodes[0]);
        if (!product) return reject();
        showcase = await setShowcase(tx, rule.sessionId, product.id);
        break;
      }
      case "new_product": {
        if (!p.priceCents || p.priceCents <= 0) return reject();
        const used = sellerProducts.map((x) => Number(x.code.replace(/\D/g, "")) || 0);
        const code = `A${Math.max(0, ...used) + 1}`;
        const [product] = await tx
          .insert(products)
          .values({
            sellerId: session.seller.id,
            code,
            name: p.name?.trim() || `Item ${code}`,
            description: "Fresh off the rail, announced live.",
            priceCents: p.priceCents,
            sortOrder: sellerProducts.length,
          })
          .returning();
        if (!product) return reject();
        const [variant] = await tx
          .insert(variants)
          .values({ productId: product.id, sku: code })
          .returning();
        if (!variant) return reject();
        await moveStock(tx, variant.id, "restock", Math.max(1, p.quantity ?? 1), {
          note: "announced by host",
        });
        showcase = await setShowcase(tx, rule.sessionId, product.id);
        announcement = `New: ${product.name}, ${money(p.priceCents, currency)}${p.quantity ? `, only ${p.quantity}` : ""}. Say +1 to grab one`;
        break;
      }
      case "price": {
        const product = byCode(p.productCodes[0]);
        if (!product || !p.priceCents || p.priceCents <= 0) return reject();
        const lower = p.priceCents < product.priceCents;
        await tx
          .update(products)
          .set({ priceCents: p.priceCents })
          .where(eq(products.id, product.id));
        await tx
          .update(variants)
          .set({ priceCents: null })
          .where(eq(variants.productId, product.id));
        if (lower) {
          // Buyers holding it unpaid get the lower price too.
          const held = await tx
            .select({ lineId: orderLines.id, orderId: orderLines.orderId })
            .from(orderLines)
            .innerJoin(variants, eq(variants.id, orderLines.variantId))
            .where(and(eq(variants.productId, product.id), eq(orderLines.status, "held")));
          if (held.length > 0) {
            await tx
              .update(orderLines)
              .set({ unitPriceCents: p.priceCents })
              .where(
                inArray(
                  orderLines.id,
                  held.map((h) => h.lineId),
                ),
              );
            touchedOrders.push(...new Set(held.map((h) => h.orderId)));
          }
        }
        announcement = `${lower ? "Price drop" : "New price"}: ${product.name} now ${money(p.priceCents, currency)}`;
        break;
      }
      case "bundle": {
        const pair = p.productCodes.map(byCode);
        if (pair.length !== 2 || pair.some((x) => !x) || !p.discountCents || p.discountCents <= 0)
          return reject();
        announcement = `Deal: ${pair.map((x) => x?.name).join(" + ")} together, ${money(p.discountCents, currency)} off`;
        break;
      }
      case "limit": {
        const product = byCode(p.productCodes[0]);
        if (!product || !p.maxPerBuyer || p.maxPerBuyer <= 0) return reject();
        announcement = `Limit: ${p.maxPerBuyer} per person for ${product.name}`;
        break;
      }
      default:
        return reject();
    }

    await tx
      .update(rules)
      .set({ status: "active", confirmedAt: new Date() })
      .where(eq(rules.id, rule.id));

    // Open orders are repriced under the new deals and prices.
    if (rule.kind === "bundle" || touchedOrders.length > 0) {
      const open = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(eq(orders.sessionId, rule.sessionId), inArray(orders.status, ["draft", "reserved"])),
        );
      for (const o of open) {
        await recalcOrder(tx, o.id);
        if (!touchedOrders.includes(o.id)) touchedOrders.push(o.id);
      }
    }
    return {
      rule: toRuleDTO({ ...rule, status: "active" }),
      announcement,
      showcase,
      touchedOrders,
    };
  });
}

/** Per-buyer limits currently in force, by product code. */
export async function activeLimits(tx: Tx, sessionId: string) {
  const active = await tx
    .select()
    .from(rules)
    .where(
      and(eq(rules.sessionId, sessionId), eq(rules.kind, "limit"), eq(rules.status, "active")),
    );
  const limits = new Map<string, number>();
  for (const rule of active) {
    const p = rule.params as RuleParams;
    const code = p.productCodes[0];
    if (code && p.maxPerBuyer)
      limits.set(code, Math.min(limits.get(code) ?? Number.POSITIVE_INFINITY, p.maxPerBuyer));
  }
  return limits;
}

/** Active bundle deals and the products in each. */
export async function activeBundles(tx: Tx, sessionId: string) {
  const active = await listRules(tx, sessionId, ["active"]);
  return active
    .filter((r) => r.kind === "bundle")
    .map((r) => ({ summary: r.summary, productCodes: r.productCodes }));
}

/** One line per active deal or limit, for buyers and for PlusOne's context. */
export async function activeDealsText(tx: Tx, sessionId: string) {
  const active = await listRules(tx, sessionId, ["active"]);
  return active.filter((r) => r.kind === "bundle" || r.kind === "limit").map((r) => r.summary);
}
