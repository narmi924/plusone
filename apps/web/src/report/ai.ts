import {
  type AgAiHarnessSetup,
  type AgAiPromptStarter,
  createAiHarness,
  directLlmRunner,
} from "ag-studio";
import { backendAdapter } from "./backendAdapter";

// AG Studio's own agents (lead, planning, data, page, widget) run on Claude
// through our server, plus one tool of ours on the lead: nudge a buyer who
// still owes. Studio's `ai` setup is read once, so the seller's session and
// token are read from here at call time.

export const reportAuth = { sessionId: "", token: "" };

const adapter = backendAdapter("/api/studio-ai/turn", () => ({
  "x-seller-token": reportAuth.token,
}));

const PROMPT_STARTERS: AgAiPromptStarter[] = [
  {
    label: "Who still owes?",
    prompt: "Who still has items held but unpaid? Biggest amounts first.",
  },
  {
    label: "Why is it sold out?",
    prompt: "The Linen Wrap Dress in Blue M shows sold out but only a few were paid for. Why?",
  },
  { label: "Nudge them", prompt: "Send a payment reminder to everyone who still owes." },
  {
    label: "Best seller",
    prompt: "What sold best tonight? Add a chart of paid revenue by product.",
  },
];

export const reportAi: AgAiHarnessSetup = ({ api }) => {
  const remind = api.defineAiTool({
    name: "send_payment_reminder",
    description:
      "Send one buyer a friendly reminder to pay for the items held for them. It arrives privately in their live chat, in their own language. Only for orders whose lines are held (unpaid).",
    params: (s) =>
      s.object({
        order: s.string({ description: "The order number from lines.order, e.g. #7 or 7" }),
      }),
    execute: async (args, ctx) => {
      const number = args.order.replace(/\D/g, "");
      const res = await fetch(
        `/api/seller/sessions/${reportAuth.sessionId}/orders/${number}/remind`,
        {
          method: "POST",
          headers: { "x-seller-token": reportAuth.token },
          signal: ctx.signal ?? null,
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        buyer?: string;
        minutesLeft?: number;
        error?: string;
      };
      return res.ok
        ? ctx.success(
            `Reminder sent to ${body.buyer ?? "the buyer"} for order #${number} (${body.minutesLeft} min left on the hold).`,
          )
        : ctx.error(body.error ?? `Could not remind order #${number}.`);
    },
  });

  return createAiHarness(api, ({ builtIn }) => ({
    agents: Object.values(builtIn).map((def) =>
      def.id === "lead"
        ? directLlmRunner({
            ...def,
            adapter,
            tools: (ctx, p) => [...(def.tools?.(ctx, p) ?? []), remind],
          })
        : directLlmRunner({ ...def, adapter }),
    ),
    primary: "lead",
    promptStarters: PROMPT_STARTERS,
    models: [
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        efforts: [
          { id: "low", label: "Fast" },
          { id: "medium", label: "Balanced" },
          { id: "high", label: "Thorough" },
        ],
      },
    ],
  }));
};
