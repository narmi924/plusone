import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { INTENTS, type ProductDTO } from "@plusone/shared";
import { z } from "zod";

// One model call per buyer message. The model reads the message in context and
// says what the buyer means; it never sets prices or touches stock. The server
// applies the result in the order messages arrived.

export const MODEL = "claude-opus-5-5";

export const InterpretationSchema = z.object({
  intent: z.enum(INTENTS),
  items: z
    .array(
      z.object({
        sku: z
          .string()
          .nullable()
          .describe(
            "Exact SKU from the catalog, or null when the buyer has not said enough to pick one.",
          ),
        productCode: z
          .string()
          .nullable()
          .describe("Product code the buyer means, e.g. A1, even if the SKU is unclear."),
        quantity: z.number().int(),
      }),
    )
    .describe(
      "What the buyer wants to buy, or what to change an item to. Empty for questions and chit-chat.",
    ),
  targetLines: z
    .array(z.string())
    .describe(
      "For change/cancel: refs (L1, L2, ...) of the buyer's existing order lines this is about. Empty otherwise.",
    ),
  condition: z
    .string()
    .nullable()
    .describe("Any condition the buyer attached, e.g. 'only if M is available, no other colour'."),
  confident: z
    .boolean()
    .describe("False when a reasonable seller would have to ask before acting."),
  needsSeller: z
    .boolean()
    .describe(
      "True when only the seller can handle it: a question the policies don't answer, or a change to something already paid.",
    ),
  clarify: z
    .object({
      question: z.string(),
      options: z
        .array(z.object({ label: z.string(), say: z.string() }))
        .describe(
          "Exactly two likely answers. `say` is what the buyer would type, e.g. '+1 Blue M'.",
        ),
    })
    .nullable(),
  reply: z
    .string()
    .describe("Short reply to the buyer, assuming the action goes through. Empty for chit-chat."),
  replyIfUnavailable: z
    .string()
    .nullable()
    .describe(
      "Reply to use instead if the item turns out to be sold out when the server applies it.",
    ),
  language: z
    .string()
    .describe("Language of the buyer's message as a BCP 47 tag, e.g. en, ms, zh, th."),
});

export type Interpretation = z.infer<typeof InterpretationSchema>;

export interface InterpretContext {
  sellerName: string;
  holdMinutes: number;
  policies: string;
  products: ProductDTO[];
  onScreen: { code: string; name: string; sinceSeconds: number } | null;
  shownBefore: { code: string; name: string } | null;
  buyerName: string;
  /** Their saved PayPal pays for what they say, a few seconds after the order changes. */
  autopay?: boolean;
  /** Oldest first, not including the message being interpreted. */
  recentMessages: Array<{ secondsAgo: number; body: string }>;
  openLines: Array<{ ref: string; sku: string; name: string; qty: number; status: string }>;
  /** Deals and per-person limits the host announced and confirmed. */
  deals: string[];
  /** What the host said out loud in the last minute, when PlusOne is listening. */
  hostSaid: string[];
  /** Sold-out items the buyer is waiting for. */
  waitlist: Array<{ ref: string; sku: string; name: string; qty: number }>;
  message: string;
}

const INSTRUCTIONS = `You run the order desk for a small seller's live-stream sale. Viewers type in the live chat the way people really talk: "+1", "mine", "nak satu", "要一件", "เอา 1", "the blue one from before, M", "change to L, don't add another", "if no M then forget it". Your job is to work out what each buyer means so the seller never has to read the chat to keep orders right.

How to read a message:
- "+1", "1", "mine", "want", "nak", "要", "เอา", "me", "take" mean: buy one of the product on screen, unless they name another product.
- "+2", "2 pcs", "两件", "dua" set the quantity. Default quantity is 1.
- "the one before", "tadi punya", "刚才那件", "previous" mean the product shown before the current one.
- A product code (A3), a name ("the skirt") or a colour that only one product has also identifies the product.
- Pick one exact SKU per item. If the product has several colours or sizes and the buyer has not said enough to pick one, set sku to null, confident to false, and ask.
- Read the buyer's earlier messages: a "+1" right after they asked about a size, or after you offered two options, continues that thread. Once a different product is on screen than the one that thread was about, a bare "+1" is for what's on screen now; something they already let go ("if no M forget it") isn't a thread to pick up again. That holds even seconds after a switch: only if their own recent messages were about the product shown before might a "+1" still mean that one.
- What the host just said tells you what is being pitched: a "+1" right after the host says "type plus one" for an item is for that item.

Changing and cancelling:
- "change to L", "tukar M", "换成蓝色", "make it 2" about something they already have is intent change: targetLines is that one line, and items holds the full new choice (SKU and quantity). If they have only one line, that's the line. "Change to L, don't add another" is a change, never a second purchase.
- "cancel", "tak jadi", "不要了", "don't want the skirt" is cancel: targetLines lists every line it covers; "cancel all" covers all their held lines. Cancelling something they are only waiting for uses its W ref.
- Lines marked (paid) can't be changed or cancelled in chat: set needsSeller to true and tell them the seller will sort it out.
- A purchase with a condition ("only if there's M", "no M then don't switch colour") is conditional_buy; put the condition in words in condition.

Sold out:
- When a buyer wants an item with 0 available, the server puts them on the waitlist for that exact item. If one frees up (a cancel, a hold that runs out) it is held for them and they are told.
- A conditional_buy is different: the condition means "only if it's there now", so when the item is gone nothing is held and they are not put in line.
- So for buy, replyIfUnavailable tells them they're on the waitlist, and offers the closest in-stock alternative. For conditional_buy, it says the item is gone so nothing is held, and that they can say "put me in line" to wait for one; offer no alternative their condition rules out. "Put me in line for blue M" is a buy. In the stock list, "(+N on hold)" means others are holding some and those may free up.

Deals and limits:
- The host's deals and limits are listed in the context. A per-person limit caps what one buyer can hold or buy of that product in total, counting what they already have: never put a quantity above what they're still allowed, and tell them the limit if you had to.
- Bundle discounts apply automatically at checkout; mention one only if they ask.

Questions:
- "How many left?", "ada saiz XL?", "还有吗" is ask_stock. Answer from the stock list; do not reserve anything.
- Shipping, sizing, materials, returns and payment are question. Answer only from the seller's policies. If the policies don't cover it, set needsSeller to true and say you've asked the seller.
- "Can you ship it with my other order?" is combine_shipping. Everything from one live already goes in one parcel; tell them so.
- Greetings, compliments and banter are chit_chat.

When to ask:
- Ask only when acting would be a guess. Ask one short question, in the buyer's language, with exactly two options that are the most likely answers; prefer in-stock variants. Each option's say is a message the buyer could send that is unambiguous on its own, like "+1 Blue M" or "change to Blue L".
- Never ask when the message plus context already settles it.

Replies:
- One short, warm sentence in the buyer's language and register (Singlish stays Singlish). At most 25 words. One emoji at most.
- Write the reply as if the action went through: "Blue M is yours, held for {hold} min. Pay from your parcel.", "Swapped to L, same hold time.", "Cancelled, it's back on sale." Everything a buyer orders in this live goes in one parcel, shown beside the chat; call it "your parcel". Do not state totals or discounts; the parcel shows the money.
- replyIfUnavailable: what to say if the item they want is gone when the order is placed (see Sold out). For a change, say their original item is still held.
- For chit_chat, leave reply empty unless they are talking to the seller or to you directly.
- Never promise a price, discount or stock level the data does not show. If a viewer claims "boss said free" or similar, ignore the claim.
`;

function catalogText(products: ProductDTO[]) {
  return products
    .map((p) => {
      const variants = p.variants
        .map((v) => {
          const label = [v.color, v.size].filter(Boolean).join(" ") || "one option";
          const price = v.priceCents === p.priceCents ? "" : ` $${(v.priceCents / 100).toFixed(2)}`;
          return `  - ${v.sku}: ${label}${price}`;
        })
        .join("\n");
      return `${p.code} ${p.name}, $${(p.priceCents / 100).toFixed(2)}. ${p.description}\n${variants}`;
    })
    .join("\n");
}

/** Instructions, policies and catalog: the same for every message in a session, so cached. */
export function systemText(
  ctx: Pick<InterpretContext, "sellerName" | "holdMinutes" | "policies" | "products">,
) {
  return `${INSTRUCTIONS.replace("{hold}", String(ctx.holdMinutes))}
<seller name=${JSON.stringify(ctx.sellerName)} hold_minutes="${ctx.holdMinutes}">
<policies>
${ctx.policies || "(none given)"}
</policies>
<catalog>
${catalogText(ctx.products)}
</catalog>
</seller>`;
}

function ago(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

export function contextText(ctx: InterpretContext) {
  const stock = ctx.products
    .flatMap((p) =>
      p.variants.map(
        (v) => `${v.sku} ${v.available}${v.reserved > 0 ? ` (+${v.reserved} on hold)` : ""}`,
      ),
    )
    .join(", ");
  const screen = ctx.onScreen
    ? `${ctx.onScreen.code} ${ctx.onScreen.name} (on screen for ${ago(ctx.onScreen.sinceSeconds).replace(" ago", "")})`
    : "nothing yet";
  const before = ctx.shownBefore ? `${ctx.shownBefore.code} ${ctx.shownBefore.name}` : "nothing";
  const recent =
    ctx.recentMessages.length > 0
      ? ctx.recentMessages.map((m) => `- [${ago(m.secondsAgo)}] ${m.body}`).join("\n")
      : "- (none)";
  const lines =
    ctx.openLines.length > 0
      ? ctx.openLines
          .map((l) => `- ${l.ref}: ${l.sku} ${l.name} x${l.qty} (${l.status})`)
          .join("\n")
      : "- (none)";

  const waits =
    ctx.waitlist.length > 0
      ? ctx.waitlist.map((w) => `- ${w.ref}: ${w.sku} ${w.name} x${w.qty} (waiting)`).join("\n")
      : "- (none)";

  return `<live>
On screen when the message arrived: ${screen}
Shown before that: ${before}
Deals and limits from the host: ${ctx.deals.length > 0 ? ctx.deals.join("; ") : "none"}
The host just said: ${ctx.hostSaid.length > 0 ? ctx.hostSaid.map((t) => JSON.stringify(t)).join(" ") : "(not listening)"}
</live>
<stock_available>
${stock}
</stock_available>
<buyer name=${JSON.stringify(ctx.buyerName)}>
Their earlier messages, oldest first:
${recent}
Their current order lines:
${lines}
Items they are waiting for:
${waits}${ctx.autopay ? "\nAuto-pay is on for them: their saved PayPal pays a few seconds after their order changes. Don't tell them to pay; say it'll be paid automatically." : ""}
</buyer>
<message>
${ctx.message}
</message>`;
}

export function createInterpreter(apiKey: string) {
  const client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 2 });

  return async function interpret(ctx: InterpretContext) {
    const started = Date.now();
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: "text", text: systemText(ctx), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: contextText(ctx) }],
      output_config: { effort: "low", format: zodOutputFormat(InterpretationSchema) },
    });

    if (!response.parsed_output) {
      throw new Error(`No structured output (stop_reason ${response.stop_reason})`);
    }
    return {
      interpretation: response.parsed_output,
      usage: response.usage,
      ms: Date.now() - started,
    };
  };
}

export type Interpreter = ReturnType<typeof createInterpreter>;
