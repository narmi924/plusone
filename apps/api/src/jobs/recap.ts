import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { formatMoney, type OrderDTO, type RecapDTO } from "@plusone/shared";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { MODEL } from "../ai/interpret.js";
import type { Db } from "../db/client.js";
import { chatMessages, liveSessions } from "../db/schema.js";
import { listAttention } from "../services/attention.js";
import { getSessionDTO } from "../services/catalog.js";
import { listOrderDTOs } from "../services/orders.js";
import { listWaiting } from "../services/waitlist.js";

// After the live the seller gets one short note in their order book: what came
// in, who still owes, and what the chat says to do next ("four people waited
// for the blue M, restock it"). Claude writes it from the night's numbers and
// what buyers said; without a key it's the numbers alone.

const RecapSchema = z.object({
  headline: z
    .string()
    .describe(
      "The night in under 50 characters, like a seller would jot it: '23 pieces, $1,042 in'.",
    ),
  notes: z
    .array(z.string())
    .describe(
      "3 to 5 notes, most useful first. Each under 90 characters, concrete, names products and people.",
    ),
});

const INSTRUCTIONS = `You write the note a live-stream seller reads right after their live ends.
It sits at the bottom of their order book, in their own handwriting style: short, plain, no fluff.

You get tonight's facts as JSON: orders, products with stock, waitlists, open issues, and what buyers typed in chat.

Write a headline (the night in numbers, short: "23 pieces, $1,042 in, 3 still owe") and 3 to 5 notes. Good notes are things the seller can act on tomorrow:
- who still owes money and how it's being chased (PayPal invoices, due date)
- what sold out and how many people were left waiting: restock or bring it back
- what buyers kept asking for that wasn't there (a size, a colour, a product)
- anything still waiting on the seller (refund requests, questions)
Use the buyers' names and the product names; refer to buyers by name, never guess "he" or "she". Use the money exactly as given. Don't invent facts, don't praise, no emojis.
PlusOne already releases unpaid items when an invoice comes due, cancels that invoice and reminds buyers, so don't tell the seller to do those things. Options that never had stock tonight aren't news.`;

const label = (l: OrderDTO["lines"][number]) =>
  [l.productName, [l.color, l.size].filter(Boolean).join(" ")].filter(Boolean).join(", ");

async function gatherFacts(db: Db, sessionId: string) {
  const session = await getSessionDTO(db, sessionId);
  if (!session) throw new Error(`No session ${sessionId}`);
  const [orders, waiting, issues, chat] = await Promise.all([
    listOrderDTOs(db, { sessionId }),
    listWaiting(db, sessionId),
    listAttention(db, sessionId),
    db
      .select({ name: chatMessages.authorName, body: chatMessages.body })
      .from(chatMessages)
      .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.authorKind, "buyer")))
      .orderBy(desc(chatMessages.seq))
      .limit(150),
  ]);
  const money = (cents: number) => formatMoney(cents, session.seller.currency);
  const paid = orders.filter((o) => o.status === "paid" || o.status === "shipped");
  const owing = orders.filter((o) => o.status === "reserved");
  const piecesSold = paid.reduce(
    (n, o) => n + o.lines.filter((l) => l.status === "paid").reduce((m, l) => m + l.qty, 0),
    0,
  );
  return {
    session,
    takenCents: paid.reduce((n, o) => n + o.totalCents, 0),
    piecesSold,
    paid,
    owing,
    json: {
      shop: session.seller.name,
      live: session.title,
      taken: money(paid.reduce((n, o) => n + o.totalCents, 0)),
      piecesSold,
      paidOrders: paid.length,
      stillOwing: owing.map((o) => ({
        buyer: o.buyer.name,
        amount: money(o.totalCents),
        items: o.lines.filter((l) => l.status === "held").map(label),
        payPalInvoice: o.invoice?.status === "sent" ? { dueAt: o.invoice.dueAt } : "not sent",
      })),
      products: session.products.map((p) => ({
        code: p.code,
        name: p.name,
        sold: p.variants.reduce((n, v) => n + v.sold, 0),
        heldUnpaid: p.variants.reduce((n, v) => n + v.reserved, 0),
        soldOutOptions: p.variants
          .filter((v) => v.available === 0)
          .map((v) => [v.color, v.size].filter(Boolean).join(" ")),
      })),
      waitlists: waiting.map((w) => ({ buyer: w.buyerName, item: w.item })),
      openIssues: issues.map((i) => ({ buyer: i.buyerName, about: i.summary })),
      buyerChat: chat.reverse().map((m) => `${m.name}: ${m.body}`),
    },
  };
}

type Facts = Awaited<ReturnType<typeof gatherFacts>>;

/** Numbers only, for when there's no AI to read the chat. */
function plainRecap(f: Facts): RecapDTO {
  const money = (cents: number) => formatMoney(cents, f.session.seller.currency);
  const notes: string[] = [];
  if (f.owing.length > 0) {
    const invoiced = f.owing.filter((o) => o.invoice?.status === "sent").length;
    notes.push(
      `${f.owing.length} still owe ${money(f.owing.reduce((n, o) => n + o.totalCents, 0))}` +
        (invoiced ? `, ${invoiced} sent a PayPal invoice` : ""),
    );
  }
  for (const p of f.json.products.filter((p) => p.soldOutOptions.length > 0).slice(0, 2)) {
    notes.push(`${p.name}: ${p.soldOutOptions.join(", ")} sold out`);
  }
  if (f.json.waitlists.length > 0) notes.push(`${f.json.waitlists.length} people left waiting`);
  if (f.json.openIssues.length > 0) notes.push(`${f.json.openIssues.length} things still need you`);
  return {
    headline: `${f.piecesSold} pieces, ${money(f.takenCents)} in`,
    notes,
    writtenAt: new Date().toISOString(),
    byAi: false,
  };
}

async function askClaude(apiKey: string, f: Facts): Promise<RecapDTO> {
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: [{ type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: JSON.stringify(f.json) }],
    output_config: { effort: "low", format: zodOutputFormat(RecapSchema) },
  });
  if (!response.parsed_output)
    throw new Error(`No structured output (stop_reason ${response.stop_reason})`);
  return {
    headline: response.parsed_output.headline,
    notes: response.parsed_output.notes.slice(0, 5),
    writtenAt: new Date().toISOString(),
    byAi: true,
  };
}

export async function composeRecap(
  deps: { db: Db; anthropicKey: string | null; log: { warn: (o: object, m: string) => void } },
  sessionId: string,
): Promise<RecapDTO> {
  const facts = await gatherFacts(deps.db, sessionId);
  let recap = plainRecap(facts);
  if (deps.anthropicKey) {
    try {
      recap = await askClaude(deps.anthropicKey, facts);
    } catch (err) {
      deps.log.warn({ err }, "AI recap failed, keeping the numbers-only one");
    }
  }
  await deps.db.update(liveSessions).set({ recap }).where(eq(liveSessions.id, sessionId));
  return recap;
}
