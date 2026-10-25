// Runs scripts/messy-chat.json through the real chat pipeline and compares each
// buyer's parcel with what a careful seller would write down. Also counts how
// many messages a fixed-format comment tool could act on (a product code with
// a quantity, or a bare "+1" for a one-option item on screen).
//   node --env-file=.env scripts/messy-chat.mjs [--api http://localhost:3000]
// Resets the demo shop first. Uses real Claude calls (about 25).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { io } = require("socket.io-client");

const args = process.argv.slice(2);
const API = args.includes("--api") ? args[args.indexOf("--api") + 1] : "http://localhost:3000";
const script = JSON.parse(readFileSync(new URL("./messy-chat.json", import.meta.url), "utf8"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = "GET", body, seller } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(seller ? { "x-seller-token": seller } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const seller = (
  await call("/api/seller/login", {
    method: "POST",
    body: { password: process.env.SELLER_PASSWORD ?? "change-me" },
  })
).token;
await call("/api/seller/demo/reset", { method: "POST", body: {}, seller });
await wait(1500);
const session = await call("/api/live/lumicloset");
const product = (code) => session.products.find((p) => p.code === code);

// One socket per buyer; count PlusOne's questions and how long replies take.
const buyers = new Map();
let questions = 0;
const askedBuyer = new Set();
const replyMs = [];
async function buyerNamed(name) {
  if (buyers.has(name)) return buyers.get(name);
  const { token, buyer } = await call("/api/buyers", { method: "POST", body: { name } });
  const socket = io(API, {
    auth: { sessionId: session.id, buyerToken: token },
    transports: ["websocket"],
  });
  const pending = [];
  socket.on("chat:message", (m) => {
    if (m.authorKind !== "assistant" || m.buyerId !== buyer.id) return;
    if (m.options?.length) {
      questions++;
      askedBuyer.add(name);
    }
    const sentAt = pending.shift();
    if (sentAt) replyMs.push(Date.now() - sentAt);
    console.log(`   PlusOne → ${name}: ${m.body}${m.options?.length ? "  [asks]" : ""}`);
  });
  await new Promise((r) => socket.on("connect", r));
  const entry = { id: buyer.id, socket, pending };
  buyers.set(name, entry);
  return entry;
}

let onScreen = null;
let formatOnly = 0;
let messages = 0;
let orderMessages = 0;
const codeAndQty = /^\s*[A-Z]\d+\s*\+\s*\d+\s*$/i;
for (const step of script.steps) {
  if (step.show) {
    onScreen = product(step.show);
    await call(`/api/seller/sessions/${session.id}/showcase`, {
      method: "POST",
      body: { productId: onScreen.id },
      seller,
    });
    console.log(`\n[on screen: ${onScreen.name}]`);
    await wait(800);
    continue;
  }
  const b = await buyerNamed(step.buyer);
  messages++;
  if (step.order !== false) orderMessages++;
  if (
    codeAndQty.test(step.say) ||
    (/^\s*\+1\s*$/.test(step.say) && onScreen?.variants.length === 1)
  )
    formatOnly++;
  console.log(`${step.buyer}: ${step.say}`);
  b.pending.push(Date.now());
  await new Promise((r) => b.socket.emit("chat:send", { body: step.say }, () => r()));
  // Paced like a busy chat (and under the demo's per-visitor limit).
  await wait(3200);
}
console.log("\n…letting the last messages finish");
await wait(15000);

// What each buyer ended up with.
const orders = await call(`/api/seller/sessions/${session.id}/orders`, { seller });
const waiting = await call(`/api/seller/sessions/${session.id}/waitlist`, { seller });
const attention = await call(`/api/seller/sessions/${session.id}/attention`, { seller });
const skuOf = new Map(session.products.flatMap((p) => p.variants.map((v) => [v.id, v.sku])));
let right = 0;
let asked = 0;
let wrong = 0;
const rows = [];
for (const [name, want] of Object.entries(script.expected)) {
  const id = buyers.get(name)?.id;
  const got = orders
    .filter((o) => o.buyer.id === id && o.status !== "cancelled")
    .flatMap((o) => o.lines.filter((l) => l.status === "held" || l.status === "paid"))
    .map((l) => `${skuOf.get(l.variantId)}${l.qty > 1 ? ` x${l.qty}` : ""}`)
    .sort();
  const ok = JSON.stringify(got) === JSON.stringify([...want].sort());
  // Something they didn't ask for is a mistake; something still missing after
  // PlusOne asked them is a question instead of a guess.
  const extra = got.filter((g) => !want.includes(g));
  const mark = ok ? "✓" : extra.length === 0 && askedBuyer.has(name) ? "?" : "✗";
  if (ok) right++;
  else if (mark === "?") asked++;
  else wrong++;
  rows.push(
    `${mark} ${name.padEnd(9)} got ${got.join(", ") || "nothing"}${ok ? "" : `   (expected ${want.join(", ") || "nothing"})`}`,
  );
}
const avg = replyMs.length
  ? Math.round(replyMs.reduce((a, b) => a + b, 0) / replyMs.length / 100) / 10
  : 0;
console.log(`\n${rows.join("\n")}`);
console.log(`\nParcels right: ${right} of ${Object.keys(script.expected).length}`);
console.log(`Waiting on a question from PlusOne instead of a guess: ${asked}; wrong: ${wrong}`);
console.log(
  `Messages: ${messages}, ${orderMessages} of them place, change or cancel an order; a fixed-format tool could act on ${formatOnly}`,
);
console.log(
  `PlusOne asked ${questions} short question(s); ${attention.length} item(s) went to the seller`,
);
console.log(`Waiting in line: ${waiting.length} (expected ${script.expectedWaiting.length})`);
console.log(`Average time to PlusOne's reply: ${avg}s`);
for (const b of buyers.values()) b.socket.close();
