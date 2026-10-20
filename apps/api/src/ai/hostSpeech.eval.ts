import { describe, expect, it } from "vitest";
import { demoCatalog } from "../db/seed.js";
import { createHostListener, type HostProposal, type HostSpeechContext } from "./hostSpeech.js";

// What the host says on camera (video scene 4) and what card it should become.
// Most host talk must produce nothing.

const products = demoCatalog();
const name = (code: string) => products.find((p) => p.code === code)?.name ?? code;
const listen = createHostListener(process.env.ANTHROPIC_API_KEY ?? "");

function ctx(newest: string, over: Partial<HostSpeechContext> = {}): HostSpeechContext {
  return {
    sellerName: "Lumi Closet",
    currency: "USD",
    products,
    onScreen: { code: "A2", name: name("A2") },
    shownBefore: { code: "A1", name: name("A1") },
    existing: [],
    earlier: [],
    newest,
    ...over,
  };
}

type Want = Partial<Omit<HostProposal, "summary" | "quote">> | null;

const cases: Array<[string, HostSpeechContext, Want]> = [
  [
    "a new item with price and stock",
    ctx("okay new one ah, this cotton tote, 39 dollars, only 3 left, type plus one if you want"),
    { kind: "new_product", priceCents: 3900, quantity: 3 },
  ],
  [
    "a bundle of the two last shown",
    ctx("dress and blouse together, five dollars off"),
    { kind: "bundle", productCodes: ["A1", "A2"], discountCents: 500 },
  ],
  [
    "the same bundle in Chinese",
    ctx("这两件一起买减五块"),
    { kind: "bundle", productCodes: ["A1", "A2"], discountCents: 500 },
  ],
  [
    "a price change",
    ctx("the pleated skirt special price tonight, 25 dollars only"),
    { kind: "price", productCodes: ["A3"], priceCents: 2500 },
  ],
  [
    "a per-buyer limit",
    ctx("silk scarf one per person ah, don't greedy"),
    { kind: "limit", productCodes: ["A7"], maxPerBuyer: 1 },
  ],
  [
    "moving on to a product",
    ctx("next we look at the batik shirt"),
    { kind: "show_product", productCodes: ["A4"] },
  ],
  ["small talk", ctx("wah this colour so nice right, hi Aisha welcome back"), null],
  [
    "not proposing twice",
    ctx("remember ah, dress and blouse together five dollars off", {
      existing: ["active: A1 + A2 together, $5 off"],
    }),
    null,
  ],
];

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("listening to the host", () => {
  it.concurrent.each(cases)("%s", async (_label, context, want) => {
    const { proposals } = await listen(context);
    const summary = JSON.stringify(proposals);
    if (want === null) {
      expect(proposals, summary).toHaveLength(0);
      return;
    }
    expect(proposals.length, summary).toBeGreaterThanOrEqual(1);
    const got = proposals.find((p) => p.kind === want.kind);
    expect(got, summary).toBeDefined();
    if (!got) return;
    if (want.productCodes) expect([...got.productCodes].sort(), summary).toEqual(want.productCodes);
    for (const key of ["priceCents", "quantity", "discountCents", "maxPerBuyer"] as const) {
      if (want[key] !== undefined) expect(got[key], summary).toBe(want[key]);
    }
  });
});
