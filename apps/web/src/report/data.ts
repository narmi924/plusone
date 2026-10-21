import type { OrderDTO, ProductDTO, WaitingDTO } from "@plusone/shared";
import type { AgDataSourcesDefinition, AgFieldDefinition } from "ag-studio";

// What the report (and its AI assistant) can see: every order line and the
// stock of every option. Descriptions matter: the assistant reads them.

export interface LineRow {
  id: string;
  order: string;
  buyer: string;
  product: string;
  variant: string;
  qty: number;
  amount: number;
  status: string;
  placed: string;
  captureId: string | null;
  /** The amount again, split by what happened to it, so totals never come out empty. */
  takenAmount: number;
  heldAmount: number;
  soldQty: number;
}

export interface StockRow {
  sku: string;
  product: string;
  variant: string;
  available: number;
  held: number;
  sold: number;
  waiting: number;
}

const money = { format: "$#,##0.00" };

const lineFields: AgFieldDefinition[] = [
  { id: "id", name: "Line", format: "textFormat", cardinality: "high", hide: true },
  {
    id: "order",
    name: "Order",
    format: "textFormat",
    cardinality: "high",
    description: "Order number like #7. Use the number for payment reminders.",
  },
  { id: "buyer", name: "Buyer", format: "textFormat" },
  { id: "product", name: "Product", format: "textFormat", cardinality: "low" },
  {
    id: "variant",
    name: "Option",
    format: "textFormat",
    description: "Colour and size, e.g. Blue M.",
  },
  { id: "qty", name: "Qty", format: "integerFormat" },
  {
    id: "amount",
    name: "Amount",
    format: "currencyFormat",
    formatOptions: money,
    context: { cell: "money" },
    description: "Line amount in USD (qty times unit price), before shipping and deals.",
  },
  {
    id: "status",
    name: "Status",
    format: "textFormat",
    cardinality: "low",
    context: { cell: "status" },
    description:
      "held = reserved for the buyer, waiting for their PayPal payment; paid = PayPal captured the money; cancelled = the buyer cancelled before paying; released = the hold ran out unpaid; refunded = paid, then refunded with PayPal.",
  },
  { id: "placed", name: "Placed", format: "dateTimeFormat" },
  {
    id: "takenAmount",
    name: "Paid amount",
    format: "currencyFormat",
    formatOptions: money,
    context: { cell: "money" },
    description: "The line amount if PayPal captured it, otherwise 0.",
  },
  {
    id: "heldAmount",
    name: "Owed amount",
    format: "currencyFormat",
    formatOptions: money,
    context: { cell: "money" },
    description: "The line amount if it's held and not paid yet, otherwise 0.",
  },
  {
    id: "soldQty",
    name: "Sold qty",
    format: "integerFormat",
    description: "The quantity if paid, otherwise 0.",
  },
  { id: "captureId", name: "PayPal capture", format: "textFormat", context: { cell: "capture" } },
];

const stockFields: AgFieldDefinition[] = [
  { id: "sku", name: "SKU", format: "textFormat", cardinality: "high" },
  { id: "product", name: "Product", format: "textFormat", cardinality: "low" },
  { id: "variant", name: "Option", format: "textFormat" },
  {
    id: "available",
    name: "Left",
    format: "integerFormat",
    description: "Still for sale right now.",
  },
  {
    id: "held",
    name: "Held",
    format: "integerFormat",
    description:
      "Reserved for buyers who have not paid yet. Comes back if they cancel or the hold runs out.",
  },
  { id: "sold", name: "Sold", format: "integerFormat", description: "Paid for." },
  {
    id: "waiting",
    name: "Waiting",
    format: "integerFormat",
    description: "Buyers on the waitlist for this exact option.",
  },
];

export function toLineRows(orders: OrderDTO[]): LineRow[] {
  return orders.flatMap((o) =>
    o.lines.map((l) => ({
      id: l.id,
      order: `#${o.number}`,
      buyer: o.buyer.name,
      product: l.productName,
      variant: [l.color, l.size].filter(Boolean).join(" ") || "One option",
      qty: l.qty,
      amount: (l.qty * l.unitPriceCents) / 100,
      status: l.status,
      placed: o.createdAt,
      captureId: l.status === "paid" || l.status === "refunded" ? o.captureId : null,
      takenAmount: l.status === "paid" ? (l.qty * l.unitPriceCents) / 100 : 0,
      heldAmount: l.status === "held" ? (l.qty * l.unitPriceCents) / 100 : 0,
      soldQty: l.status === "paid" ? l.qty : 0,
    })),
  );
}

export function toStockRows(products: ProductDTO[], waiting: WaitingDTO[]): StockRow[] {
  return products.flatMap((p) =>
    p.variants.map((v) => {
      const variant = [v.color, v.size].filter(Boolean).join(" ") || "One option";
      const label = variant === "One option" ? p.name : `${p.name}, ${variant}`;
      return {
        sku: v.sku,
        product: p.name,
        variant,
        available: v.available,
        held: v.reserved,
        sold: v.sold,
        waiting: waiting.filter((w) => w.item === label).length,
      };
    }),
  );
}

/** A new object every time: Studio reloads its widgets when the reference changes. */
export function reportData(lines: LineRow[], stock: StockRow[]): AgDataSourcesDefinition {
  return {
    description:
      "Tonight's live sale for a small clothing seller. Buyers order in the live chat, PlusOne holds items for them, and they pay with PayPal. Amounts are USD.",
    sources: [
      {
        id: "lines",
        name: "Order lines",
        description: "One row per item a buyer asked for, with what happened to it.",
        data: lines,
        fields: lineFields,
      },
      {
        id: "stock",
        name: "Stock",
        description:
          "One row per product option: left for sale, held unpaid, sold, and how many buyers wait for it.",
        data: stock,
        fields: stockFields,
      },
    ],
  };
}
