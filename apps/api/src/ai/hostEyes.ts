import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { ProductDTO } from "@plusone/shared";
import { z } from "zod";
import { MODEL } from "./interpret.js";

// Hands-free hosting: a few times a minute the host's camera sends a frame and
// Claude says which product, if any, the host is showing. The caller puts it on
// screen once two frames in a row agree, so "+1" goes to what buyers can see
// without the host touching the console.

const SeenSchema = z.object({
  code: z
    .string()
    .nullable()
    .describe("Code of the catalog product being shown to the camera right now, or null"),
  color: z.string().nullable().describe("Which of that product's colours it is, if you can tell"),
  sure: z.boolean().describe("True only when the item clearly matches exactly one catalog product"),
  saw: z.string().describe("What you see being shown, in at most eight words"),
});
export type Seen = z.infer<typeof SeenSchema>;

const INSTRUCTIONS = `You watch the camera of a small shop's live-stream sale. The host shows products one at a time: holding them up, wearing them, or laying them out in front of the camera. Say which product from the catalog is being shown right now.
- Match on what the item is (dress, blouse, skirt, shirt, bag, scarf...), its colour and its pattern, against the catalog's names, colours and descriptions.
- If nothing from the catalog is being shown, or it could be either of two products, set code to null and sure to false.
- Ignore the background and things lying around. Ignore the host's own clothes unless they are clearly modelling a product for the camera.`;

function catalogText(products: ProductDTO[]) {
  return products
    .map((p) => {
      const colors = [...new Set(p.variants.map((v) => v.color).filter(Boolean))];
      return `${p.code}: ${p.name}. ${p.description}${colors.length > 0 ? ` Colours: ${colors.join(", ")}.` : ""}`;
    })
    .join("\n");
}

export function createHostEyes(apiKey: string) {
  const client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 });

  return async function look(input: {
    jpegBase64: string;
    products: ProductDTO[];
    onScreen: string | null;
  }): Promise<{ seen: Seen | null; ms: number }> {
    const started = Date.now();
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: `${INSTRUCTIONS}\n\nCatalog:\n${catalogText(input.products)}`,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: input.jpegBase64 },
            },
            {
              type: "text",
              text: `On screen for buyers right now: ${input.onScreen ?? "nothing"}. What is the host showing in this frame?`,
            },
          ],
        },
      ],
      output_config: { effort: "low", format: betaZodOutputFormat(SeenSchema) },
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    });
    return { seen: response.parsed_output ?? null, ms: Date.now() - started };
  };
}

export type HostEyes = ReturnType<typeof createHostEyes>;
