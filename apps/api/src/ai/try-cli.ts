// Try the interpreter against the seeded catalog without the rest of the app:
//   pnpm ai:try "+1 blue M"

import { createDb } from "../db/client.js";
import { loadEnv } from "../env.js";
import { findSessionForHandle, getSessionDTO } from "../services/catalog.js";
import { createInterpreter } from "./interpret.js";

const env = loadEnv();
if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
const { db, pool } = createDb(env.DATABASE_URL);
const sessionId = await findSessionForHandle(db, "lumicloset");
const session = sessionId ? await getSessionDTO(db, sessionId) : null;
if (!session) throw new Error("Seed the demo first: pnpm db:seed");

const interpret = createInterpreter(env.ANTHROPIC_API_KEY);
const onScreen = session.products.find((p) => p.id === session.currentProductId) ?? null;
for (const message of process.argv.slice(2)) {
  const { interpretation, usage, ms } = await interpret({
    sellerName: session.seller.name,
    holdMinutes: session.seller.holdMinutes,
    policies: "",
    products: session.products,
    onScreen: onScreen && { code: onScreen.code, name: onScreen.name, sinceSeconds: 90 },
    shownBefore: { code: "A8", name: "Woven Rattan Bag" },
    buyerName: "Aisha",
    recentMessages: [],
    openLines: [],
    waitlist: [],
    deals: [],
    hostSaid: [],
    message,
  });
  console.log(
    `\n> ${message}  (${ms} ms, in ${usage.input_tokens} + cache read ${usage.cache_read_input_tokens ?? 0} / write ${usage.cache_creation_input_tokens ?? 0}, out ${usage.output_tokens})`,
  );
  console.log(JSON.stringify(interpretation, null, 2));
}
await pool.end();
