import type { ProductDTO, SessionDTO } from "@plusone/shared";
import { and, asc, desc, eq, inArray, lte, ne } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { liveSessions, products, sellers, showcases, variants } from "../db/schema.js";
import { activeBundles, activeDealsText } from "./rules.js";

export async function getProducts(tx: Tx, sellerId: string): Promise<ProductDTO[]> {
  const productRows = await tx
    .select()
    .from(products)
    .where(eq(products.sellerId, sellerId))
    .orderBy(asc(products.sortOrder));
  if (productRows.length === 0) return [];

  const variantRows = await tx
    .select()
    .from(variants)
    .where(
      inArray(
        variants.productId,
        productRows.map((p) => p.id),
      ),
    )
    .orderBy(asc(variants.sortOrder));

  return productRows.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    imageUrl: p.imageUrl,
    priceCents: p.priceCents,
    variants: variantRows
      .filter((v) => v.productId === p.id)
      .map((v) => ({
        id: v.id,
        sku: v.sku,
        color: v.color,
        size: v.size,
        priceCents: v.priceCents ?? p.priceCents,
        available: v.available,
        reserved: v.reserved,
        sold: v.sold,
      })),
  }));
}

export async function getSessionRow(tx: Tx, sessionId: string) {
  const [row] = await tx
    .select({ session: liveSessions, seller: sellers })
    .from(liveSessions)
    .innerJoin(sellers, eq(sellers.id, liveSessions.sellerId))
    .where(eq(liveSessions.id, sessionId));
  return row ?? null;
}

/** The seller's live session, or their most recent one. */
export async function findSessionForHandle(tx: Tx, handle: string) {
  const [row] = await tx
    .select({ id: liveSessions.id })
    .from(liveSessions)
    .innerJoin(sellers, eq(sellers.id, liveSessions.sellerId))
    .where(eq(sellers.handle, handle))
    .orderBy(desc(eq(liveSessions.status, "live")), desc(liveSessions.createdAt))
    .limit(1);
  return row?.id ?? null;
}

export async function getSessionDTO(tx: Tx, sessionId: string): Promise<SessionDTO | null> {
  const row = await getSessionRow(tx, sessionId);
  if (!row) return null;
  const { session, seller } = row;
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    currentProductId: session.currentProductId,
    hostVideoOn: false,
    deals: await activeDealsText(tx, sessionId),
    bundles: await activeBundles(tx, sessionId),
    seller: {
      id: seller.id,
      handle: seller.handle,
      name: seller.name,
      currency: seller.currency,
      holdMinutes: seller.holdMinutes,
    },
    products: await getProducts(tx, seller.id),
  };
}

/**
 * The product shown before the current one, for messages like "the blue one from
 * before". `at` pins it to when a message arrived, not when it is processed.
 */
export async function previousShowcaseProductId(
  tx: Tx,
  sessionId: string,
  currentProductId: string | null,
  at: Date = new Date(),
) {
  const conditions = [eq(showcases.sessionId, sessionId), lte(showcases.startedAt, at)];
  if (currentProductId) conditions.push(ne(showcases.productId, currentProductId));
  const [row] = await tx
    .select({ productId: showcases.productId })
    .from(showcases)
    .where(and(...conditions))
    .orderBy(desc(showcases.startedAt))
    .limit(1);
  return row?.productId ?? null;
}

/** When the product on screen at `at` was put there. */
export async function showcaseStartedAt(
  tx: Tx,
  sessionId: string,
  productId: string,
  at: Date = new Date(),
) {
  const [row] = await tx
    .select({ startedAt: showcases.startedAt })
    .from(showcases)
    .where(
      and(
        eq(showcases.sessionId, sessionId),
        eq(showcases.productId, productId),
        lte(showcases.startedAt, at),
      ),
    )
    .orderBy(desc(showcases.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

/** Puts a product on screen and records when. */
export async function setShowcase(tx: Tx, sessionId: string, productId: string) {
  const [before] = await tx
    .select({ currentProductId: liveSessions.currentProductId })
    .from(liveSessions)
    .where(eq(liveSessions.id, sessionId))
    .for("update");
  if (before?.currentProductId === productId) {
    return {
      productId,
      previousProductId: await previousShowcaseProductId(tx, sessionId, productId),
    };
  }
  await tx
    .update(liveSessions)
    .set({ currentProductId: productId })
    .where(eq(liveSessions.id, sessionId));
  await tx.insert(showcases).values({ sessionId, productId });
  return { productId, previousProductId: before?.currentProductId ?? null };
}

/** "Linen Wrap Dress, Blue M" for messages. */
export async function describeVariant(tx: Tx, variantId: string) {
  const [row] = await tx
    .select({ name: products.name, color: variants.color, size: variants.size })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(variants.id, variantId));
  if (!row) return "your item";
  const option = [row.color, row.size].filter(Boolean).join(" ");
  return option ? `${row.name}, ${option}` : row.name;
}
