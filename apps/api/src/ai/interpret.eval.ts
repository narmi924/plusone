import { describe, expect, it } from "vitest";
import { DEMO_POLICIES, demoCatalog } from "../db/seed.js";
import { createInterpreter, type Interpretation, type InterpretContext } from "./interpret.js";

// What the video and the judges will try. Each case is one buyer message in a
// fixed situation, checked for what the server would act on (intent, SKU,
// which line, whether to ask), not for the exact wording of the reply.

const products = demoCatalog();
const name = (code: string) => products.find((p) => p.code === code)?.name ?? code;
const interpret = createInterpreter(process.env.ANTHROPIC_API_KEY ?? "");

function ctx(message: string, over: Partial<InterpretContext> = {}): InterpretContext {
  return {
    sellerName: "Lumi Closet",
    holdMinutes: 15,
    policies: DEMO_POLICIES,
    products,
    onScreen: { code: "A1", name: name("A1"), sinceSeconds: 90 },
    shownBefore: { code: "A8", name: name("A8") },
    buyerName: "Aisha",
    recentMessages: [],
    openLines: [],
    waitlist: [],
    deals: [],
    hostSaid: [],
    message,
    ...over,
  };
}

const line = (ref: string, sku: string, status = "held") => ({
  ref,
  sku,
  name: name(sku.split("-")[0] ?? ""),
  qty: 1,
  status,
});
// Scene 2: the host has just moved from the dress (A1) to the blouse (A2).
const afterSwitch = {
  onScreen: { code: "A2", name: name("A2"), sinceSeconds: 20 },
  shownBefore: { code: "A1", name: name("A1") },
};

/** The catalog with one option gone: held by someone else. */
function soldOut(sku: string) {
  return products.map((p) => ({
    ...p,
    variants: p.variants.map((v) => (v.sku === sku ? { ...v, available: 0, reserved: 1 } : v)),
  }));
}

type Expect = {
  intent: Interpretation["intent"] | Interpretation["intent"][];
  sku?: string | null;
  qty?: number;
  targetLines?: string[];
  confident?: boolean;
  needsSeller?: boolean;
  asks?: boolean;
  language?: string;
  unavailableReply?: boolean;
  /** The reply mustn't send the buyer off to pay (auto-pay pays for them). */
  noPayPrompt?: boolean;
};

const cases: Array<[string, InterpretContext, Expect]> = [
  // Scene 2, three buyers at once
  [
    "points back at the previous product",
    ctx("the dress just now, blue S", afterSwitch),
    { intent: "buy", sku: "A1-BLUE-S", confident: true },
  ],
  [
    "changes size without adding another",
    ctx("change to L, don't add another", {
      ...afterSwitch,
      openLines: [line("L1", "A2-WHITE-M")],
    }),
    { intent: "change", sku: "A2-WHITE-L", qty: 1, targetLines: ["L1"] },
  ],
  [
    "asks about stock without reserving",
    ctx("still got pink S?", afterSwitch),
    { intent: "ask_stock", asks: false },
  ],
  // Scene 3, conditions
  [
    "keeps a no-substitute condition",
    ctx("blue M please, if no M then forget it, don't want other colour"),
    { intent: ["conditional_buy", "buy"], sku: "A1-BLUE-M" },
  ],
  // Asking only when it has to
  ["asks which option for a bare +1", ctx("+1"), { intent: "buy", confident: false, asks: true }],
  [
    "doesn't ask when there is only one option",
    ctx("+1", { onScreen: { code: "A8", name: name("A8"), sinceSeconds: 40 }, shownBefore: null }),
    { intent: "buy", sku: "A8", confident: true, asks: false },
  ],
  [
    "continues its own question",
    ctx("+1", { recentMessages: [{ secondsAgo: 30, body: "got sage in L?" }] }),
    { intent: "buy", sku: "A1-SAGE-L" },
  ],
  // Cancelling
  [
    "cancels just the item named",
    ctx("don't want the bag already", { openLines: [line("L1", "A1-SAGE-M"), line("L2", "A8")] }),
    { intent: "cancel", targetLines: ["L2"] },
  ],
  [
    "hands a change to something paid to the seller",
    ctx("eh can change mine to M or not", { openLines: [line("L1", "A1-BLUE-S", "paid")] }),
    { intent: "change", needsSeller: true },
  ],
  [
    "follows what the host just pitched",
    ctx("+1", {
      products: [
        ...products,
        {
          id: "A9",
          code: "A9",
          name: "Cotton tote",
          description: "",
          imageUrl: null,
          priceCents: 3900,
          variants: [
            {
              id: "A9",
              sku: "A9",
              color: null,
              size: null,
              priceCents: 3900,
              available: 3,
              reserved: 0,
              sold: 0,
            },
          ],
        },
      ],
      onScreen: { code: "A9", name: "Cotton tote", sinceSeconds: 2 },
      shownBefore: { code: "A1", name: name("A1") },
      hostSaid: [
        "okay new one ah, this cotton tote, 39 dollars, only 3 left, type plus one if you want",
      ],
    }),
    { intent: "buy", sku: "A9", confident: true, asks: false },
  ],
  // Sold out and the waitlist
  [
    "keeps a no-substitute condition when it's gone",
    ctx("blue M, if no M forget it, don't want other colour", { products: soldOut("A1-BLUE-M") }),
    { intent: ["conditional_buy", "buy"], sku: "A1-BLUE-M", unavailableReply: true },
  ],
  [
    "cancels a waitlist place",
    ctx("no need to wait for the blue M already", {
      waitlist: [{ ref: "W1", sku: "A1-BLUE-M", name: name("A1"), qty: 1 }],
    }),
    { intent: "cancel", targetLines: ["W1"] },
  ],
  // Questions
  [
    "answers shipping from the policies",
    ctx("how long to ship to KL?"),
    { intent: "question", needsSeller: false, asks: false },
  ],
  [
    "passes unknown questions to the seller",
    ctx("can you shorten the dress for me?"),
    { intent: "question", needsSeller: true },
  ],
  [
    "knows parcels are combined",
    ctx("can ship together with my earlier order?", { openLines: [line("L1", "A8", "paid")] }),
    { intent: "combine_shipping" },
  ],
  // Languages
  [
    "Chinese and English mixed",
    ctx("要一件 blue 的 M size"),
    { intent: "buy", sku: "A1-BLUE-M", language: "zh" },
  ],
  ["Malay", ctx("nak saiz L warna sage satu"), { intent: "buy", sku: "A1-SAGE-L", language: "ms" }],
  ["Thai", ctx("เอาสีฟ้า ไซส์ S 1 ตัว"), { intent: "buy", sku: "A1-BLUE-S", language: "th" }],
  [
    "Thai, changes size",
    ctx("เปลี่ยนเป็นไซส์ L ค่ะ ไม่เอาเพิ่มนะ", { openLines: [line("L1", "A1-BLUE-M")] }),
    { intent: "change", sku: "A1-BLUE-L", targetLines: ["L1"], language: "th" },
  ],
  [
    "Indonesian",
    ctx("kak mau yang biru ukuran M satu ya"),
    { intent: "buy", sku: "A1-BLUE-M", language: "id" },
  ],
  [
    "Indonesian, cancels",
    ctx("kak yang tadi batal aja ya, maaf", { openLines: [line("L1", "A1-SAGE-L")] }),
    { intent: "cancel", targetLines: ["L1"], language: "id" },
  ],
  [
    "Singlish",
    ctx("boss sage one M can? take 1 lah"),
    { intent: "buy", sku: "A1-SAGE-M", language: "en" },
  ],
  [
    "Chinese, changes size",
    ctx("换成 L 码，不要多一件", { openLines: [line("L1", "A1-BLUE-M")] }),
    { intent: "change", sku: "A1-BLUE-L", targetLines: ["L1"], language: "zh" },
  ],
  // Auto-pay on: the reply says it'll be paid, not "pay in your order panel"
  [
    "doesn't tell an auto-pay buyer to go and pay",
    ctx("+1 blue S", { autopay: true }),
    { intent: "buy", sku: "A1-BLUE-S", confident: true, noPayPrompt: true },
  ],
];

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("understanding live chat", () => {
  it.concurrent.each(cases)("%s", async (_label, context, want) => {
    const { interpretation: got } = await interpret(context);
    const summary = JSON.stringify(got);

    const intents = Array.isArray(want.intent) ? want.intent : [want.intent];
    expect(intents, summary).toContain(got.intent);
    if (want.sku !== undefined) expect(got.items[0]?.sku ?? null, summary).toBe(want.sku);
    if (want.qty !== undefined) expect(got.items[0]?.quantity, summary).toBe(want.qty);
    if (want.targetLines) expect([...got.targetLines].sort(), summary).toEqual(want.targetLines);
    if (want.confident !== undefined) expect(got.confident, summary).toBe(want.confident);
    if (want.needsSeller !== undefined) expect(got.needsSeller, summary).toBe(want.needsSeller);
    if (want.asks === true) expect(got.clarify?.options.length, summary).toBe(2);
    if (want.asks === false) expect(got.clarify, summary).toBeNull();
    if (want.noPayPrompt)
      expect(got.reply, summary).not.toMatch(/pay in your order panel|tap pay|please pay/i);
    if (want.unavailableReply)
      expect(got.replyIfUnavailable?.length ?? 0, summary).toBeGreaterThan(0);
    if (want.language)
      expect(got.language.toLowerCase(), summary).toMatch(new RegExp(`^${want.language}`));
    if (got.intent !== "chit_chat")
      expect(got.reply.trim().length > 0 || got.clarify !== null, summary).toBe(true);
  });
});
