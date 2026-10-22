import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
import { formatMoney } from "@plusone/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { invoices, orders, products } from "../db/schema.js";
import type { CarrierKey, Payments } from "../paypal/payments.js";
import type { Realtime } from "../realtime.js";
import { getSessionDTO, setShowcase } from "../services/catalog.js";
import type { Notifier } from "../services/notify.js";
import { listOrderDTOs } from "../services/orders.js";
import { sendPayReminder } from "../services/reminders.js";
import { listWaiting } from "../services/waitlist.js";
import { MODEL } from "./interpret.js";

// The seller's copilot: "who still owes?", "remind everyone with an open
// invoice", "refund Farah's skirt", "ship Mei's with Ninja Van NV123". Claude
// reads tonight's orders and asks PayPal directly through PayPal's own Agent
// Toolkit. Anything that moves money or messages a buyer comes back as a card
// the seller taps to approve; only then does it run.

const PAYPAL_READ = [
  "get_order",
  "list_invoices",
  "get_invoice",
  "search_invoicing",
  "generate_invoice_qr_code",
  "get_refund",
  "get_shipment_tracking",
  "list_disputes",
  "get_dispute",
  "list_transactions",
] as const;
const PAYPAL_PROPOSE = ["send_invoice_reminder", "cancel_sent_invoice"] as const;

const INSTRUCTIONS = `You are PlusOne's copilot for a small seller during and after a live-stream sale.
The seller types or says short requests. Be brief: at most three plain sentences, in the language the seller used.

Use tonight_orders for orders, buyers, holds, invoices and PayPal ids. Use the PayPal tools (PayPal's Agent Toolkit) for anything PayPal knows: an order's status, invoices, refunds, shipment tracking, disputes.
Anything that moves money, messages buyers or changes an invoice is only proposed: call the tool, it becomes a card the seller approves. Say in one sentence what you've lined up (don't mention card ids); never claim it's done.
Putting a product on screen happens straight away.
Never invent order numbers, ids or amounts; look them up.
The PayPal account also holds invoices from earlier lives. When the seller means tonight, go by the invoice ids in tonight_orders.`;

type Emit = (event: string, data: unknown) => void;

interface Proposal {
  id: string;
  sessionId: string;
  title: string;
  run: () => Promise<string>;
  createdAt: number;
}

const DOMAIN_TOOLS: Anthropic.Tool[] = [
  {
    name: "tonight_orders",
    description:
      "Every order in tonight's live: number, buyer, status (reserved = held unpaid, paid, shipped, cancelled), each line with its id, product, option, qty, status and price, total, when the hold ends, the PayPal order and capture ids, and the PayPal invoice id and status if one was sent.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "catalog",
    description:
      "Tonight's products: code, name, price, which one is on screen, and per option how many are left, held unpaid, sold, and who is waiting for it.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "put_on_screen",
    description: "Put a product on screen for buyers (happens immediately).",
    input_schema: {
      type: "object",
      properties: {
        product: { type: "string", description: "Catalog code like A2, or the product's name" },
      },
      required: ["product"],
    },
  },
  {
    name: "remind_in_chat",
    description:
      "Propose a private chat reminder to pay, in each buyer's own language, for held unpaid orders.",
    input_schema: {
      type: "object",
      properties: { order_numbers: { type: "array", items: { type: "integer" } } },
      required: ["order_numbers"],
    },
  },
  {
    name: "refund_line",
    description:
      "Propose refunding one paid order line through PayPal (partial refund of that line). Get line_id from tonight_orders.",
    input_schema: {
      type: "object",
      properties: { line_id: { type: "string" } },
      required: ["line_id"],
    },
  },
  {
    name: "ship_order",
    description:
      "Propose marking a paid order shipped and adding its tracking number to the PayPal payment.",
    input_schema: {
      type: "object",
      properties: {
        order_number: { type: "integer" },
        carrier: { type: "string", enum: ["singpost", "ninjavan", "jt", "dhl", "other"] },
        carrier_name: { type: "string", description: "Only when carrier is other" },
        tracking_number: { type: "string" },
      },
      required: ["order_number", "carrier", "tracking_number"],
    },
  },
];

/** "--boundary ... image\r\n\r\n<base64>\r\n--boundary--" from the QR tool, as a data URL. */
function qrDataUrl(content: string) {
  const text = content.startsWith('"') ? (JSON.parse(content) as string) : content;
  const b64 = text.match(/(iVBORw0KGgo[A-Za-z0-9+/=\r\n]+)/)?.[1]?.replace(/\s+/g, "");
  return b64 ? `data:image/png;base64,${b64}` : null;
}

export function createCopilot(deps: {
  apiKey: string;
  paypal: { clientId: string; clientSecret: string; sandbox: boolean } | null;
  db: Db;
  payments: Payments | null;
  notify: Notifier;
  realtime: Realtime;
  log: FastifyBaseLogger;
}) {
  const { db, log } = deps;
  const client = new Anthropic({ apiKey: deps.apiKey, timeout: 60_000, maxRetries: 2 });
  const toolkit = deps.paypal
    ? new PayPalAgentToolkit({
        clientId: deps.paypal.clientId,
        clientSecret: deps.paypal.clientSecret,
        configuration: {
          actions: {
            invoices: {
              list: true,
              get: true,
              search: true,
              generateQRC: true,
              sendReminder: true,
              cancel: true,
            },
            orders: { get: true },
            payments: { getRefunds: true },
            shipment: { get: true },
            disputes: { list: true, get: true },
            transactions: { list: true },
          },
          context: { sandbox: deps.paypal.sandbox },
        },
      })
    : null;
  const paypalTools: Anthropic.Tool[] = (toolkit?.getTools() ?? [])
    .filter((t) =>
      [...PAYPAL_READ, ...PAYPAL_PROPOSE].includes(t.function.name as (typeof PAYPAL_READ)[number]),
    )
    .map((t) => {
      const { $schema: _drop, ...schema } = (t.function.parameters ?? {}) as Record<
        string,
        unknown
      >;
      return {
        name: t.function.name,
        description: `PayPal: ${(t.function.description ?? "").trim().slice(0, 600)}`,
        input_schema: { type: "object", ...schema } as Anthropic.Tool.InputSchema,
      };
    });
  const tools: Anthropic.Tool[] = [...DOMAIN_TOOLS, ...paypalTools];
  const last = tools.at(-1);
  if (last) last.cache_control = { type: "ephemeral" }; // tools + instructions are cached

  const proposals = new Map<string, Proposal>();
  const propose = (sessionId: string, title: string, run: () => Promise<string>) => {
    for (const [id, p] of proposals)
      if (Date.now() - p.createdAt > 30 * 60_000) proposals.delete(id);
    const id = randomUUID();
    proposals.set(id, { id, sessionId, title, run, createdAt: Date.now() });
    return id;
  };

  async function paypalCall(name: string, input: unknown) {
    if (!toolkit) throw new Error("PayPal is not configured");
    const r = await toolkit.handleToolCall({
      id: randomUUID(),
      type: "function",
      function: { name, arguments: JSON.stringify(input ?? {}) },
    });
    return String(r.content);
  }

  async function tonightOrders(sessionId: string) {
    const list = await listOrderDTOs(db, { sessionId });
    const sent = await db
      .select({
        orderId: invoices.orderId,
        id: invoices.paypalInvoiceId,
        status: invoices.status,
        dueAt: invoices.dueAt,
      })
      .from(invoices)
      .innerJoin(orders, eq(orders.id, invoices.orderId))
      .where(eq(orders.sessionId, sessionId));
    return list
      .sort((a, b) => a.number - b.number)
      .map((o) => {
        const inv = sent.filter((i) => i.orderId === o.id).at(-1);
        return {
          number: o.number,
          buyer: o.buyer.name,
          status: o.status,
          lines: o.lines.map((l) => ({
            line_id: l.id,
            product: l.productName,
            option: [l.color, l.size].filter(Boolean).join(" ") || null,
            qty: l.qty,
            status: l.status,
            price: formatMoney(l.qty * l.unitPriceCents, o.currency),
          })),
          total: formatMoney(o.totalCents, o.currency),
          hold_minutes_left:
            o.status === "reserved" && o.holdExpiresAt
              ? Math.max(0, Math.round((Date.parse(o.holdExpiresAt) - Date.now()) / 60_000))
              : null,
          paypal_order_id: o.paypalOrderId,
          capture_id: o.captureId,
          paid_via: o.paidVia,
          invoice: inv ? { id: inv.id, status: inv.status, due_at: inv.dueAt.toISOString() } : null,
          tracking: o.tracking,
        };
      });
  }

  async function orderByNumber(sessionId: string, number: number) {
    const [o] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.sessionId, sessionId), eq(orders.number, number)));
    return o ?? null;
  }

  /** Runs one tool call; returns what Claude sees. */
  async function runTool(
    sessionId: string,
    name: string,
    input: Record<string, unknown>,
    emit: Emit,
  ): Promise<string> {
    const step = (label: string, source: "paypal" | "plusone") =>
      emit("step", { tool: name, label, source });

    if (name === "tonight_orders") {
      step("Read tonight's orders", "plusone");
      return JSON.stringify(await tonightOrders(sessionId));
    }
    if (name === "catalog") {
      step("Read the catalog", "plusone");
      const session = await getSessionDTO(db, sessionId);
      const waiting = await listWaiting(db, sessionId);
      return JSON.stringify(
        (session?.products ?? []).map((p) => ({
          code: p.code,
          name: p.name,
          price: formatMoney(p.priceCents, session?.seller.currency ?? "USD"),
          on_screen: p.id === session?.currentProductId,
          options: p.variants.map((v) => {
            const option = [v.color, v.size].filter(Boolean).join(" ");
            const label = option ? `${p.name}, ${option}` : p.name;
            return {
              option: option || "one option",
              left: v.available,
              held: v.reserved,
              sold: v.sold,
              waiting: waiting.filter((w) => w.item === label).map((w) => w.buyerName),
            };
          }),
        })),
      );
    }
    if (name === "put_on_screen") {
      const wanted = String(input.product ?? "").trim();
      const all = await db.select().from(products);
      const words = wanted
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      const p =
        all.find((x) => x.code.toUpperCase() === wanted.toUpperCase()) ??
        all.find((x) => x.name.toLowerCase() === wanted.toLowerCase()) ??
        all
          .map((x) => ({ x, hits: words.filter((w) => x.name.toLowerCase().includes(w)).length }))
          .filter((m) => m.hits > 0)
          .sort((a, b) => b.hits - a.hits)[0]?.x;
      if (!p) return `No product matches "${wanted}". Use catalog to see what's there.`;
      const shown = await db.transaction((tx) => setShowcase(tx, sessionId, p.id));
      deps.realtime.showcase(sessionId, shown.productId, shown.previousProductId);
      step(`Put ${p.name} on screen`, "plusone");
      return `${p.name} is on screen now.`;
    }
    if (name === "remind_in_chat") {
      const numbers = (input.order_numbers as number[] | undefined) ?? [];
      const found = await db
        .select({ id: orders.id, number: orders.number })
        .from(orders)
        .where(and(eq(orders.sessionId, sessionId), inArray(orders.number, numbers)));
      if (found.length === 0) return "No such orders.";
      const id = propose(
        sessionId,
        `Remind ${found.length === 1 ? `order #${found[0]?.number}` : `${found.length} buyers`} to pay, in chat`,
        async () => {
          let sent = 0;
          for (const o of found) if ((await sendPayReminder(db, deps.notify, o.id)).sent) sent++;
          return `Sent ${sent} reminder${sent === 1 ? "" : "s"}.`;
        },
      );
      emit("proposal", { id, title: proposals.get(id)?.title, source: "plusone" });
      return "Queued as a card for the seller to approve.";
    }
    if (name === "refund_line") {
      if (!deps.payments) return "PayPal is not configured.";
      const lineId = String(input.line_id ?? "");
      const all = await tonightOrders(sessionId);
      const hit = all
        .flatMap((o) => o.lines.map((l) => ({ o, l })))
        .find((x) => x.l.line_id === lineId);
      if (!hit) return "No such line tonight.";
      if (hit.l.status !== "paid") return `That line is ${hit.l.status}, nothing to refund.`;
      const payments = deps.payments;
      const id = propose(
        sessionId,
        `Refund ${hit.l.price} to ${hit.o.buyer} for ${hit.l.product}${hit.l.option ? `, ${hit.l.option}` : ""} with PayPal`,
        async () => {
          await payments.refundLine(lineId);
          return "Refunded with PayPal.";
        },
      );
      emit("proposal", { id, title: proposals.get(id)?.title, source: "paypal" });
      return "Queued as a card for the seller to approve.";
    }
    if (name === "ship_order") {
      if (!deps.payments) return "PayPal is not configured.";
      const o = await orderByNumber(sessionId, Number(input.order_number));
      if (!o) return "No such order.";
      if (o.status !== "paid") return `Order #${o.number} is ${o.status}.`;
      const carrier = String(input.carrier ?? "other") as CarrierKey;
      const trackingNumber = String(input.tracking_number ?? "");
      const carrierName = input.carrier_name ? String(input.carrier_name) : undefined;
      const payments = deps.payments;
      const id = propose(
        sessionId,
        `Ship order #${o.number} with ${carrierName ?? carrier} ${trackingNumber}, and add the tracking to PayPal`,
        async () => {
          await payments.shipOrder(o.id, {
            carrier,
            trackingNumber,
            ...(carrierName ? { carrierName } : {}),
          });
          return "Marked shipped; PayPal has the tracking number.";
        },
      );
      emit("proposal", { id, title: proposals.get(id)?.title, source: "paypal" });
      return "Queued as a card for the seller to approve.";
    }

    // PayPal Agent Toolkit
    if ((PAYPAL_PROPOSE as readonly string[]).includes(name)) {
      const invoiceId = String(input.invoice_id ?? "");
      const [inv] = await db
        .select({
          number: orders.number,
          amount: invoices.amountCents,
          currency: invoices.currency,
        })
        .from(invoices)
        .innerJoin(orders, eq(orders.id, invoices.orderId))
        .where(eq(invoices.paypalInvoiceId, invoiceId));
      const who = inv
        ? `order #${inv.number} (${formatMoney(inv.amount, inv.currency)})`
        : invoiceId;
      const title =
        name === "send_invoice_reminder"
          ? `Send a PayPal invoice reminder for ${who}`
          : `Cancel the PayPal invoice for ${who}`;
      const id = propose(sessionId, title, async () => {
        const out = await paypalCall(name, input);
        if (/"ok":false|"error"/.test(out)) throw new Error(out.slice(0, 300));
        return name === "send_invoice_reminder"
          ? "PayPal sent the reminder."
          : "Invoice cancelled.";
      });
      emit("proposal", { id, title, source: "paypal" });
      return "Queued as a card for the seller to approve.";
    }
    if ((PAYPAL_READ as readonly string[]).includes(name)) {
      step(`PayPal ${name.replaceAll("_", " ")}`, "paypal");
      const out = await paypalCall(name, input);
      if (name === "generate_invoice_qr_code") {
        const url = qrDataUrl(out);
        if (url) {
          emit("image", { dataUrl: url, caption: "Scan to pay this PayPal invoice" });
          return "QR code generated and shown to the seller.";
        }
      }
      return out.length > 8000 ? `${out.slice(0, 8000)}…` : out;
    }
    return `Unknown tool ${name}.`;
  }

  async function ask(
    sessionId: string,
    message: string,
    history: Array<{ role: "user" | "assistant"; text: string }>,
    emit: Emit,
  ) {
    const messages: Anthropic.MessageParam[] = [
      ...history.slice(-6).map((h) => ({ role: h.role, content: h.text })),
      { role: "user", content: message },
    ];
    for (let turn = 0; turn < 8; turn++) {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: [{ type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
        output_config: { effort: "low" },
      } as Anthropic.MessageCreateParamsNonStreaming);
      messages.push({ role: "assistant", content: res.content });
      const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || calls.length === 0) {
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        emit("text", { text });
        return text;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        try {
          const content = await runTool(
            sessionId,
            call.name,
            (call.input ?? {}) as Record<string, unknown>,
            emit,
          );
          results.push({ type: "tool_result", tool_use_id: call.id, content });
        } catch (err) {
          log.warn({ err, tool: call.name }, "copilot tool failed");
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            is_error: true,
            content: err instanceof Error ? err.message : String(err),
          });
        }
      }
      messages.push({ role: "user", content: results });
    }
    emit("text", { text: "That took too many steps; try asking more simply." });
    return null;
  }

  async function apply(id: string, sessionId: string) {
    const p = proposals.get(id);
    if (!p || p.sessionId !== sessionId) throw new Error("That card has expired; ask again.");
    proposals.delete(id);
    return p.run();
  }

  function dismiss(id: string) {
    proposals.delete(id);
  }

  return { ask, apply, dismiss, usesPayPalToolkit: Boolean(toolkit) };
}

export type Copilot = ReturnType<typeof createCopilot>;
