// Types shared between the API and the web app.
// Keep this file free of runtime dependencies other than zod.

export const ORDER_STATUSES = ["draft", "reserved", "paid", "cancelled", "shipped"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const LINE_STATUSES = ["held", "paid", "released", "cancelled", "refunded"] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

export const SESSION_STATUSES = ["scheduled", "live", "ended"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const AUTHOR_KINDS = ["buyer", "host", "assistant", "system"] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

export const INTENTS = [
  "buy",
  "change",
  "cancel",
  "ask_stock",
  "conditional_buy",
  "combine_shipping",
  "question",
  "chit_chat",
] as const;
export type Intent = (typeof INTENTS)[number];

/** Public, non-secret config the web app fetches from the API at startup. */
/** One recorded clip of the host for replay, and the product it shows. */
export interface ReplayClip {
  src: string;
  /** Product code on screen while it plays, e.g. "A8". */
  product: string;
  seconds: number;
}

export interface PublicConfig {
  paypalClientId: string;
  paypalEnv: "sandbox" | "live";
  livekitUrl: string | null;
  /** Public demo: recorded host clips that play when nobody is hosting, and the server's clock. */
  replay: { clips: ReplayClip[]; serverNow: number } | null;
  /** Public demo: what a judge or visitor needs to try everything. */
  demo: {
    sellerPassword: string;
    sandboxBuyer: { email: string; password: string } | null;
  } | null;
}

export interface VariantDTO {
  id: string;
  sku: string;
  color: string | null;
  size: string | null;
  priceCents: number;
  available: number;
  reserved: number;
  sold: number;
}

export interface ProductDTO {
  id: string;
  code: string;
  name: string;
  description: string;
  imageUrl: string | null;
  priceCents: number;
  variants: VariantDTO[];
}

export interface SellerDTO {
  id: string;
  handle: string;
  name: string;
  currency: string;
  holdMinutes: number;
}

export interface SessionDTO {
  id: string;
  title: string;
  status: SessionStatus;
  currentProductId: string | null;
  /** What was on screen before it, for "the one just now". */
  previousProductId: string | null;
  /** The host's camera is on right now. */
  hostVideoOn: boolean;
  /** Nobody is hosting and the recorded host is playing instead (public demo). */
  replayOn?: boolean;
  /** Deals and limits the host has announced and confirmed, one line each. */
  deals: string[];
  /** Active "buy these together" deals, so a buyer can be offered the missing piece. */
  bundles: Array<{ summary: string; productCodes: string[] }>;
  seller: SellerDTO;
  products: ProductDTO[];
}

/** The seller's note after the live: what happened tonight and what to do next. */
export interface RecapDTO {
  headline: string;
  notes: string[];
  writtenAt: string;
  /** False when written from the numbers alone (no AI available). */
  byAi: boolean;
}

export interface BuyerDTO {
  id: string;
  name: string;
  email: string;
}

/** What PlusOne saw in a frame from the host's camera. */
export type LookDTO =
  | { busy: true }
  | {
      busy: false;
      saw: string | null;
      product: { code: string; name: string } | null;
      /** That product is what buyers see now (it was already, or it just went on). */
      onScreen: boolean;
      switched: boolean;
    };

export type PaidVia = "checkout" | "saved" | "auto" | "invoice";

/** The buyer's saved PayPal and auto-pay for one live. */
export interface WalletDTO {
  /** The PayPal account saved at an earlier checkout, e.g. "sb-nh…@personal.example.com". */
  savedPayPal: string | null;
  /** Auto-pay for this live: PlusOne pays for what the buyer says, up to the limit. */
  autopay: { limitCents: number; spentCents: number } | null;
}

export interface ChatOption {
  label: string;
  /** Text sent on the buyer's behalf when they tap the option. */
  say: string;
}

export interface ChatMessageDTO {
  id: string;
  seq: number;
  sessionId: string;
  authorKind: AuthorKind;
  authorName: string;
  buyerId: string | null;
  /** Private messages are only delivered to this buyer (and the seller). */
  visibility: "public" | "private";
  body: string;
  options: ChatOption[] | null;
  replyToId: string | null;
  createdAt: string;
}

export interface OrderLineDTO {
  id: string;
  variantId: string;
  productName: string;
  productCode: string;
  color: string | null;
  size: string | null;
  qty: number;
  unitPriceCents: number;
  status: LineStatus;
  holdExpiresAt: string | null;
}

export interface OrderDTO {
  id: string;
  number: number;
  sessionId: string;
  buyer: BuyerDTO;
  status: OrderStatus;
  currency: string;
  subtotalCents: number;
  /** Money off from the host's bundle deals. */
  discountCents: number;
  shippingCents: number;
  /** This order goes in the same parcel as that (already paid) order, so no second shipping fee. */
  shipsWithOrderNumber: number | null;
  totalCents: number;
  holdExpiresAt: string | null;
  paidAt: string | null;
  paypalOrderId: string | null;
  captureId: string | null;
  paidVia: PaidVia | null;
  /** Auto-pay will charge the saved PayPal at this time unless the order changes. */
  autopayAt: string | null;
  /** The same, as time left when the server sent this (browser clocks drift). */
  autopayInMs: number | null;
  /** PlusOne asked the buyer something; auto-pay waits for the answer. */
  autopayWaiting: boolean;
  /** Where PayPal says to send it (from the buyer's PayPal checkout), one line. */
  shipTo: string | null;
  tracking: { carrier: string; number: string } | null;
  /** A PayPal invoice sent when the live ended with this still unpaid. */
  invoice: { payUrl: string | null; dueAt: string; status: "sent" | "paid" | "cancelled" } | null;
  lines: OrderLineDTO[];
  createdAt: string;
  updatedAt: string;
}

export const RULE_KINDS = ["show_product", "new_product", "price", "bundle", "limit"] as const;

/** A card made from what the host said; does nothing until the host applies it. */
export interface RuleDTO {
  id: string;
  kind: (typeof RULE_KINDS)[number];
  status: "proposed" | "active" | "rejected" | "ended";
  summary: string;
  quote: string;
  productCodes: string[];
  discountCents: number | null;
  maxPerBuyer: number | null;
  createdAt: string;
}

/** Someone waiting in line for a sold-out item. */
export interface WaitingDTO {
  id: string;
  buyerName: string;
  item: string;
  /** 1 = next to get it. */
  position: number;
  condition: string | null;
}

/** Something only the seller can decide. */
export interface AttentionDTO {
  /** A buyer to answer (questions, change requests): the seller can reply in place. */
  canReply?: boolean;
  id: string;
  kind: string;
  summary: string;
  buyerName: string | null;
  orderNumber: number | null;
  /** Set when the item can be refunded with one click. */
  refund: { lineId: string; amountCents: number; currency: string } | null;
  createdAt: string;
}

export interface StockChange {
  variantId: string;
  available: number;
  reserved: number;
  sold: number;
}

/** Events the server pushes to browsers. */
export interface ServerToClientEvents {
  "chat:message": (message: ChatMessageDTO) => void;
  "chat:thinking": (payload: { messageId: string; buyerId: string; done: boolean }) => void;
  "showcase:changed": (payload: {
    productId: string | null;
    previousProductId: string | null;
  }) => void;
  "order:updated": (order: OrderDTO) => void;
  "stock:changed": (changes: StockChange[]) => void;
  "video:status": (payload: { on: boolean }) => void;
  /** The recorded host started or stopped playing (public demo). */
  "replay:status": (payload: { on: boolean }) => void;
  /** The seller's "needs you" list changed; refetch it. */
  "attention:changed": () => void;
  /** Products, prices or deals changed; refetch the session. */
  "session:changed": () => void;
  /** Someone joined or left a waitlist, or got their item from it (seller only). */
  "waitlist:changed": () => void;
  /** Cards from the host's speech were added or applied (seller only). */
  "rules:changed": () => void;
  /** A finished sentence from the host, as PlusOne heard it (seller only). */
  "host:heard": (payload: { text: string }) => void;
  /** The sentence the host is in the middle of (seller only). */
  "host:interim": (payload: { text: string }) => void;
  /** The host said "PlusOne, …" out loud: a request for the copilot (seller only). */
  "copilot:ask": (payload: { text: string }) => void;
  /** The after-live recap is ready (seller only); refetch it. */
  "recap:changed": () => void;
}

export type Ack<T> = (result: { ok: true; data: T } | { ok: false; error: string }) => void;

/** Events browsers send to the server. */
export interface ClientToServerEvents {
  "chat:send": (payload: { body: string }, ack: Ack<{ id: string }>) => void;
  /** Seller only: start or stop listening to the host's microphone. */
  "host:listen": (payload: { language: string; on: boolean }, ack: Ack<{ on: boolean }>) => void;
  /** Seller only: a chunk of microphone audio (webm/opus). */
  "host:audio": (chunk: ArrayBuffer) => void;
}

/** Sent in the Socket.IO handshake. Viewers without a buyer token can watch but not chat. */
export interface SocketAuth {
  sessionId: string;
  buyerToken?: string;
  sellerToken?: string;
}

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
