import type { ProductDTO } from "@plusone/shared";
import { sql } from "drizzle-orm";
import { moveStock } from "../services/stock.js";
import type { Db } from "./client.js";
import { liveSessions, products, sellers, showcases, variants } from "./schema.js";

// Demo data: one boutique seller in Singapore doing a Friday night live sale.
// Stock numbers are chosen for the demo: A1 Blue M is the last one (scene 3),
// A2 Pink S is already gone (stock questions), A8 has a single variant so a bare
// "+1" can be understood without asking.

type SeedProduct = {
  code: string;
  name: string;
  description: string;
  priceCents: number;
  colors: string[] | null;
  sizes: string[] | null;
  /** Stock per variant, keyed "Color/Size"; missing keys get `defaultStock`. */
  stock?: Record<string, number>;
  defaultStock: number;
};

const CATALOG: SeedProduct[] = [
  {
    code: "A1",
    name: "Linen Wrap Dress",
    description: "Breathable linen, tie waist, midi length.",
    priceCents: 3900,
    colors: ["Blue", "Sage"],
    sizes: ["S", "M", "L"],
    stock: { "Blue/M": 1, "Blue/S": 2, "Sage/L": 1 },
    defaultStock: 3,
  },
  {
    code: "A2",
    name: "Puff-Sleeve Blouse",
    description: "Cotton poplin with soft puff sleeves.",
    priceCents: 2500,
    colors: ["White", "Pink"],
    sizes: ["S", "M", "L"],
    stock: { "Pink/S": 0, "White/M": 5 },
    defaultStock: 3,
  },
  {
    code: "A3",
    name: "Pleated Midi Skirt",
    description: "Satin-finish pleats, elastic waist.",
    priceCents: 2900,
    colors: ["Black", "Beige"],
    sizes: ["S", "M", "L"],
    defaultStock: 2,
  },
  {
    code: "A4",
    name: "Batik Print Shirt",
    description: "Hand-stamped batik, relaxed fit.",
    priceCents: 3200,
    colors: ["Navy", "Maroon"],
    sizes: ["M", "L", "XL"],
    stock: { "Maroon/XL": 0 },
    defaultStock: 2,
  },
  {
    code: "A5",
    name: "Wide-Leg Trousers",
    description: "High waist, drapey crepe.",
    priceCents: 3500,
    colors: ["Black", "Cream"],
    sizes: ["S", "M", "L"],
    defaultStock: 3,
  },
  {
    code: "A6",
    name: "Chunky Knit Cardigan",
    description: "Oversized, one size fits most.",
    priceCents: 4200,
    colors: ["Oat", "Grey"],
    sizes: null,
    defaultStock: 4,
  },
  {
    code: "A7",
    name: "Silk Square Scarf",
    description: "70 x 70 cm, hand-rolled edges.",
    priceCents: 1500,
    colors: ["Floral", "Paisley"],
    sizes: null,
    defaultStock: 6,
  },
  {
    code: "A8",
    name: "Woven Rattan Bag",
    description: "Handwoven in Bali, leather straps.",
    priceCents: 2800,
    colors: null,
    sizes: null,
    defaultStock: 5,
  },
];

// What the seller would tell a buyer who asks. PlusOne answers from this and
// nothing else; anything not covered goes to the seller.
export const DEMO_POLICIES = `Shipping: we post from Singapore within 2 working days, tracked. Singapore 2-3 days, Malaysia 5-7 days, elsewhere 7-14 days.
Shipping is $5 per parcel. Everything you buy in one live goes in one parcel, so items added after you pay ship free with it.
Payment: PayPal (cards work through PayPal too). Unpaid items are held for 15 minutes, then go back on sale.
Sizes: S = UK 8 (bust 84 cm), M = UK 10 (bust 88 cm), L = UK 12 (bust 94 cm), XL = UK 14 (bust 100 cm). The wrap dress is relaxed; between sizes, take the smaller one.
Returns: size exchanges within 7 days if unworn with tags. Message us after the live.
Materials: A1 100% linen. A2 cotton poplin. A3 polyester satin. A4 cotton batik, hand-stamped in Penang. A5 viscose crepe. A6 acrylic-wool blend. A7 100% silk. A8 rattan with leather straps.
Care: hand wash cold, hang dry. A7 dry clean only.`;

function skuPart(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/** Every colour/size combination of a product, with its SKU and opening stock. */
function variantsOf(p: SeedProduct) {
  const combos: Array<{ color: string | null; size: string | null }> = [];
  for (const color of p.colors ?? [null]) {
    for (const size of p.sizes ?? [null]) combos.push({ color, size });
  }
  return combos.map((combo, sortOrder) => {
    const key = [combo.color, combo.size].filter(Boolean).join("/");
    const sku = [p.code, combo.color && skuPart(combo.color), combo.size && skuPart(combo.size)]
      .filter(Boolean)
      .join("-");
    return { ...combo, sku, sortOrder, stock: p.stock?.[key] ?? p.defaultStock };
  });
}

/** The demo catalog as the app sees it, without a database (for AI tests). Ids are SKUs/codes. */
export function demoCatalog(): ProductDTO[] {
  return CATALOG.map((p) => ({
    id: p.code,
    code: p.code,
    name: p.name,
    description: p.description,
    imageUrl: null,
    priceCents: p.priceCents,
    variants: variantsOf(p).map((v) => ({
      id: v.sku,
      sku: v.sku,
      color: v.color,
      size: v.size,
      priceCents: p.priceCents,
      available: v.stock,
      reserved: 0,
      sold: 0,
    })),
  }));
}

/** Wipes everything and loads the demo. Returns the live session id. */
export async function seedDemo(db: Db): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      TRUNCATE webhook_events, invoices, shipments, payments, attention, rules, waitlist, stock_moves,
        order_lines, orders, chat_messages, buyers, showcases, live_sessions, variants, products, sellers
      RESTART IDENTITY CASCADE
    `);

    const [seller] = await tx
      .insert(sellers)
      .values({
        handle: "lumicloset",
        name: "Lumi Closet",
        currency: "USD",
        holdMinutes: 15,
        shippingCents: 500,
        policies: DEMO_POLICIES,
      })
      .returning();
    if (!seller) throw new Error("seed: seller");

    const productIds = new Map<string, string>();
    for (const [i, p] of CATALOG.entries()) {
      const [product] = await tx
        .insert(products)
        .values({
          sellerId: seller.id,
          code: p.code,
          name: p.name,
          description: p.description,
          priceCents: p.priceCents,
          sortOrder: i,
        })
        .returning();
      if (!product) throw new Error(`seed: product ${p.code}`);
      productIds.set(p.code, product.id);

      for (const v of variantsOf(p)) {
        const [variant] = await tx
          .insert(variants)
          .values({
            productId: product.id,
            sku: v.sku,
            color: v.color,
            size: v.size,
            sortOrder: v.sortOrder,
          })
          .returning();
        if (!variant) throw new Error(`seed: variant ${v.sku}`);
        if (v.stock > 0)
          await moveStock(tx, variant.id, "restock", v.stock, { note: "opening stock" });
      }
    }

    const first = productIds.get("A8");
    const current = productIds.get("A1");
    const [session] = await tx
      .insert(liveSessions)
      .values({
        sellerId: seller.id,
        title: "Tonight's drop: new linen & batik",
        status: "live",
        currentProductId: current ?? null,
        startedAt: new Date(Date.now() - 12 * 60_000),
      })
      .returning();
    if (!session || !first || !current) throw new Error("seed: session");

    // The bag was on screen first, then the dress.
    await tx.insert(showcases).values([
      { sessionId: session.id, productId: first, startedAt: new Date(Date.now() - 10 * 60_000) },
      { sessionId: session.id, productId: current, startedAt: new Date(Date.now() - 3 * 60_000) },
    ]);

    return session.id;
  });
}
