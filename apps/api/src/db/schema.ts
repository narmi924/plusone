import type { ShippingDetails } from "@paypal/paypal-server-sdk";
import type {
  AuthorKind,
  ChatOption,
  LineStatus,
  OrderStatus,
  PaidVia,
  RecapDTO,
  SessionStatus,
} from "@plusone/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Column names are camelCase here and snake_case in Postgres (`casing: "snake_case"`).
// Money is always integer cents. Stock counters on `variants` only change through
// `services/stock.ts`, which writes a `stock_moves` row for every change.

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const sellers = pgTable("sellers", {
  id: uuid().primaryKey().defaultRandom(),
  handle: text().notNull().unique(),
  name: text().notNull(),
  currency: text().notNull().default("USD"),
  holdMinutes: integer().notNull().default(15),
  shippingCents: integer().notNull().default(500),
  /** Shipping, sizing, returns and materials, in the seller's words. PlusOne answers questions from this. */
  policies: text().notNull().default(""),
  createdAt: createdAt(),
});

export const products = pgTable(
  "products",
  {
    id: uuid().primaryKey().defaultRandom(),
    sellerId: uuid()
      .notNull()
      .references(() => sellers.id),
    code: text().notNull(),
    name: text().notNull(),
    description: text().notNull().default(""),
    imageUrl: text(),
    priceCents: integer().notNull(),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.sellerId, t.code)],
);

export const variants = pgTable(
  "variants",
  {
    id: uuid().primaryKey().defaultRandom(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    sku: text().notNull().unique(),
    color: text(),
    size: text(),
    /** Overrides the product price when set. */
    priceCents: integer(),
    available: integer().notNull().default(0),
    reserved: integer().notNull().default(0),
    sold: integer().notNull().default(0),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [
    index().on(t.productId),
    check(
      "variants_counts_non_negative",
      sql`${t.available} >= 0 AND ${t.reserved} >= 0 AND ${t.sold} >= 0`,
    ),
  ],
);

export const liveSessions = pgTable("live_sessions", {
  id: uuid().primaryKey().defaultRandom(),
  sellerId: uuid()
    .notNull()
    .references(() => sellers.id),
  title: text().notNull(),
  status: text().$type<SessionStatus>().notNull().default("scheduled"),
  currentProductId: uuid().references(() => products.id),
  /** Recorded host clip + timeline of what was on screen, for replay mode. */
  replay: jsonb(),
  /** Written after the live ends: what happened and what to do next. */
  recap: jsonb().$type<RecapDTO>(),
  startedAt: timestamp({ withTimezone: true }),
  endedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

/** Every time the host puts a product on screen. Lets "the one before" resolve. */
export const showcases = pgTable(
  "showcases",
  {
    id: uuid().primaryKey().defaultRandom(),
    sessionId: uuid()
      .notNull()
      .references(() => liveSessions.id),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.sessionId, t.startedAt)],
);

export const buyers = pgTable("buyers", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  email: text().notNull(),
  tokenHash: text().notNull().unique(),
  locale: text(),
  /** PayPal saved with the buyer's consent at checkout (Vault), for one-tap payment next time. */
  paypalVaultId: text(),
  paypalCustomerId: text(),
  paypalEmail: text(),
  /** Where that PayPal checkout said to ship, reused for one-tap payments. */
  paypalShipping: jsonb().$type<ShippingDetails>(),
  /** Auto-pay is on for this one live, up to this much. */
  autopaySessionId: uuid(),
  autopayLimitCents: integer(),
  createdAt: createdAt(),
  lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Server receive order. Orders and stock are applied in this order, never in AI-reply order. */
    seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    sessionId: uuid()
      .notNull()
      .references(() => liveSessions.id),
    authorKind: text().$type<AuthorKind>().notNull(),
    authorName: text().notNull(),
    /** Author for buyer messages; recipient for private assistant replies. */
    buyerId: uuid().references(() => buyers.id),
    visibility: text().$type<"public" | "private">().notNull().default("public"),
    body: text().notNull(),
    options: jsonb().$type<ChatOption[]>(),
    replyToId: uuid(),
    /** Product on screen when the message arrived. */
    showcaseProductId: uuid().references(() => products.id),
    interpretation: jsonb(),
    status: text()
      .$type<"received" | "understood" | "applied" | "failed">()
      .notNull()
      .default("received"),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.sessionId, t.seq), index().on(t.buyerId)],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid().primaryKey().defaultRandom(),
    number: serial().notNull().unique(),
    sellerId: uuid()
      .notNull()
      .references(() => sellers.id),
    sessionId: uuid()
      .notNull()
      .references(() => liveSessions.id),
    buyerId: uuid()
      .notNull()
      .references(() => buyers.id),
    status: text().$type<OrderStatus>().notNull().default("draft"),
    currency: text().notNull().default("USD"),
    subtotalCents: integer().notNull().default(0),
    discountCents: integer().notNull().default(0),
    shippingCents: integer().notNull().default(0),
    totalCents: integer().notNull().default(0),
    holdExpiresAt: timestamp({ withTimezone: true }),
    paidAt: timestamp({ withTimezone: true }),
    cancelledAt: timestamp({ withTimezone: true }),
    shippedAt: timestamp({ withTimezone: true }),
    /** Set when this order goes in the same parcel as an earlier paid one (no second shipping fee). */
    shipsWithOrderId: uuid(),
    /** Auto-pay charges the saved PayPal at this time, unless the order changes first. */
    autopayAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.sessionId, t.status),
    // A buyer has at most one open order per live session; new items join it.
    uniqueIndex("orders_one_open_per_buyer")
      .on(t.sessionId, t.buyerId)
      .where(sql`${t.status} IN ('draft', 'reserved')`),
  ],
);

export const orderLines = pgTable(
  "order_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    variantId: uuid()
      .notNull()
      .references(() => variants.id),
    qty: integer().notNull(),
    unitPriceCents: integer().notNull(),
    status: text().$type<LineStatus>().notNull().default("held"),
    holdExpiresAt: timestamp({ withTimezone: true }),
    sourceMessageId: uuid().references(() => chatMessages.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.orderId),
    index().on(t.variantId, t.status),
    check("order_lines_qty_positive", sql`${t.qty} > 0`),
  ],
);

export const stockMoves = pgTable(
  "stock_moves",
  {
    id: uuid().primaryKey().defaultRandom(),
    variantId: uuid()
      .notNull()
      .references(() => variants.id),
    kind: text()
      .$type<"restock" | "reserve" | "release" | "sell" | "refund" | "adjust">()
      .notNull(),
    qty: integer().notNull(),
    orderLineId: uuid().references(() => orderLines.id),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.variantId, t.createdAt)],
);

export const waitlist = pgTable(
  "waitlist",
  {
    id: uuid().primaryKey().defaultRandom(),
    sessionId: uuid()
      .notNull()
      .references(() => liveSessions.id),
    variantId: uuid()
      .notNull()
      .references(() => variants.id),
    buyerId: uuid()
      .notNull()
      .references(() => buyers.id),
    qty: integer().notNull().default(1),
    /** e.g. "only M, don't switch colour". */
    condition: text(),
    status: text()
      .$type<"waiting" | "offered" | "filled" | "cancelled">()
      .notNull()
      .default("waiting"),
    sourceMessageId: uuid().references(() => chatMessages.id),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.variantId, t.status, t.createdAt)],
);

/** Promotions the host announced; only take effect after the host confirms. */
export const rules = pgTable("rules", {
  id: uuid().primaryKey().defaultRandom(),
  sessionId: uuid()
    .notNull()
    .references(() => liveSessions.id),
  kind: text().notNull(),
  params: jsonb().notNull(),
  sourceText: text(),
  status: text()
    .$type<"proposed" | "active" | "rejected" | "ended">()
    .notNull()
    .default("proposed"),
  createdAt: createdAt(),
  confirmedAt: timestamp({ withTimezone: true }),
});

/** Things the seller has to look at themselves. The goal is to keep this list short. */
export const attention = pgTable(
  "attention",
  {
    id: uuid().primaryKey().defaultRandom(),
    sessionId: uuid()
      .notNull()
      .references(() => liveSessions.id),
    kind: text().notNull(),
    summary: text().notNull(),
    buyerId: uuid().references(() => buyers.id),
    orderId: uuid().references(() => orders.id),
    /** The order line it's about, e.g. a paid item the buyer wants to cancel (refund). */
    lineId: uuid().references(() => orderLines.id),
    messageId: uuid().references(() => chatMessages.id),
    status: text().$type<"open" | "resolved">().notNull().default("open"),
    createdAt: createdAt(),
    resolvedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.sessionId, t.status)],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    paypalOrderId: text().notNull().unique(),
    captureId: text().unique(),
    status: text()
      .$type<
        | "created"
        | "approved"
        | "captured"
        | "denied"
        | "refunded"
        | "partially_refunded"
        | "voided"
      >()
      .notNull()
      .default("created"),
    amountCents: integer().notNull(),
    currency: text().notNull(),
    /** Order lines this PayPal order pays for, fixed when it was created. */
    lineIds: jsonb().$type<string[]>().notNull(),
    /** How the buyer paid: PayPal checkout, saved PayPal in one tap, auto-pay, or an invoice. */
    via: text().$type<PaidVia>().notNull().default("checkout"),
    payerEmail: text(),
    raw: jsonb(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.orderId)],
);

export const shipments = pgTable("shipments", {
  id: uuid().primaryKey().defaultRandom(),
  orderId: uuid()
    .notNull()
    .references(() => orders.id),
  carrier: text().notNull(),
  trackingNumber: text().notNull(),
  paypalTrackerId: text(),
  status: text().notNull().default("shipped"),
  createdAt: createdAt(),
});

/** PayPal webhook deliveries, keyed by PayPal's event id so redeliveries are ignored. */
export const webhookEvents = pgTable("webhook_events", {
  id: text().primaryKey(),
  eventType: text().notNull(),
  resourceId: text(),
  verified: boolean().notNull(),
  payload: jsonb().notNull(),
  receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp({ withTimezone: true }),
  error: text(),
});

/** PayPal invoices for buyers who left the live without paying. */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    paypalInvoiceId: text().notNull().unique(),
    status: text().$type<"sent" | "paid" | "cancelled">().notNull().default("sent"),
    amountCents: integer().notNull(),
    currency: text().notNull(),
    /** Where the buyer opens and pays it on paypal.com. */
    payUrl: text(),
    dueAt: timestamp({ withTimezone: true }).notNull(),
    lineIds: jsonb().$type<string[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.orderId)],
);
