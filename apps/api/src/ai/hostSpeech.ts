import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ProductDTO } from "@plusone/shared";
import { z } from "zod";
import { MODEL } from "./interpret.js";

// The host talks the way hosts talk: "this one 39 dollars, only 3 left, type
// plus one", "buy the dress and the blouse together, five dollars off". This
// turns that into cards the host confirms with one tap. Nothing changes until
// they do, and buyers' chat can never trigger it.

export const HOST_PROPOSAL_KINDS = [
  "show_product",
  "new_product",
  "price",
  "bundle",
  "limit",
] as const;

export const HostSpeechSchema = z.object({
  proposals: z
    .array(
      z.object({
        kind: z.enum(HOST_PROPOSAL_KINDS),
        productCodes: z
          .array(z.string())
          .describe(
            "Existing catalog products this is about. Two for a bundle. Empty for new_product.",
          ),
        name: z.string().nullable().describe("new_product only: what the host calls it, or null."),
        priceCents: z
          .number()
          .int()
          .nullable()
          .describe("price / new_product: the price in cents."),
        quantity: z
          .number()
          .int()
          .nullable()
          .describe("new_product: how many the host says there are."),
        discountCents: z
          .number()
          .int()
          .nullable()
          .describe("bundle: money off when bought together, in cents."),
        maxPerBuyer: z.number().int().nullable().describe("limit: most one buyer may take."),
        summary: z
          .string()
          .describe("Card text for the host, under 10 words, e.g. 'Rattan bag now $25'."),
        quote: z.string().describe("The host's own words this comes from."),
      }),
    )
    .describe("Only what the newest speech announces. Usually empty."),
});

export type HostProposal = z.infer<typeof HostSpeechSchema>["proposals"][number];

export interface HostSpeechContext {
  sellerName: string;
  currency: string;
  products: ProductDTO[];
  onScreen: { code: string; name: string } | null;
  shownBefore: { code: string; name: string } | null;
  /** Rules already active or waiting for the host, so nothing is proposed twice. */
  existing: string[];
  /** What the host said in the last minute or so, oldest first. */
  earlier: string[];
  newest: string;
}

const INSTRUCTIONS = `You listen to the host of a live-stream sale and turn sale announcements into cards the host confirms with one tap. Most of what a host says is chat ("this colour is so pretty", "hi Aisha, welcome back") and produces nothing.

Propose only what the newest speech clearly announces:
- show_product: the host moves on to a catalog product by name or code ("next, the batik shirt", "A4 now"). Not when they only mention it.
- new_product: the host is selling something not in the catalog, with a price ("this one 39 dollars, only 3 left, type plus one"). quantity is how many they say there are (null if not said); name is what they call it, or null. If what they describe matches the product on screen, it's not new: use price instead if the price differs.
- price: a new price for an existing product ("the skirt now 25", "dress special price 35 tonight").
- bundle: money off two products bought together ("dress and blouse together, minus five dollars", "这两件一起买减五块"). "These two" means the product on screen and the one shown before.
- limit: a per-buyer limit ("one per person only", "每人限一件").

Rules:
- Use only numbers the host said. Prices are in the seller's currency (USD): "39", "39 dollars", "39 块", "thirty-nine", "RM39" all mean 3900 cents.
- Never re-propose something in the existing list.
- If the speech is unclear or half a sentence, propose nothing; the next segment will carry it.
- summary is for the host, in English, plain: "New item: $39, 3 in stock", "Dress + blouse together: $5 off".`;

function catalogLine(p: ProductDTO, currency: string) {
  const left = p.variants.reduce((n, v) => n + v.available, 0);
  const price = new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    p.priceCents / 100,
  );
  return `${p.code} ${p.name}, ${price}, ${left} left`;
}

export function hostSpeechText(ctx: HostSpeechContext) {
  return `<live seller=${JSON.stringify(ctx.sellerName)}>
On screen: ${ctx.onScreen ? `${ctx.onScreen.code} ${ctx.onScreen.name}` : "nothing"}
Shown before: ${ctx.shownBefore ? `${ctx.shownBefore.code} ${ctx.shownBefore.name}` : "nothing"}
</live>
<catalog>
${ctx.products.map((p) => catalogLine(p, ctx.currency)).join("\n")}
</catalog>
<existing>
${ctx.existing.length > 0 ? ctx.existing.join("\n") : "(none)"}
</existing>
<host_said_earlier>
${ctx.earlier.length > 0 ? ctx.earlier.join("\n") : "(nothing)"}
</host_said_earlier>
<newest>
${ctx.newest}
</newest>`;
}

export function createHostListener(apiKey: string) {
  const client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 2 });
  return async function listen(ctx: HostSpeechContext) {
    const started = Date.now();
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: hostSpeechText(ctx) }],
      output_config: { effort: "medium", format: zodOutputFormat(HostSpeechSchema) },
    });
    if (!response.parsed_output)
      throw new Error(`No structured output (stop_reason ${response.stop_reason})`);
    return {
      proposals: response.parsed_output.proposals,
      ms: Date.now() - started,
      usage: response.usage,
    };
  };
}

export type HostListener = ReturnType<typeof createHostListener>;
