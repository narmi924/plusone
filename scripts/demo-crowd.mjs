// A small crowd of buyers for filming or trying the demo alone. Each scene is
// one moment from the video, paced like real chat. Open the live page and the
// seller console in a browser first, then run a scene against the same server.
//   node --env-file=.env scripts/demo-crowd.mjs <scene> [--reset] [--api http://localhost:3000]
// Scenes: switch, last-one, deal, languages, close-out
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { io } = require("socket.io-client");

const args = process.argv.slice(2);
const scene = args.find((a) => !a.startsWith("--"));
const API = args.includes("--api") ? args[args.indexOf("--api") + 1] : "http://localhost:3000";
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
if (args.includes("--reset")) {
  await call("/api/seller/demo/reset", { method: "POST", body: {}, seller });
  await wait(1500);
}
const session = await call("/api/live/lumicloset");
const product = (code) => session.products.find((p) => p.code === code);
const show = (code) =>
  call(`/api/seller/sessions/${session.id}/showcase`, {
    method: "POST",
    body: { productId: product(code).id },
    seller,
  });

const sockets = [];
async function buyer(name) {
  const { token } = await call("/api/buyers", {
    method: "POST",
    body: { name, email: `${name.toLowerCase()}@example.com` },
  });
  const socket = io(API, {
    auth: { sessionId: session.id, buyerToken: token },
    transports: ["websocket"],
  });
  sockets.push(socket);
  socket.on("chat:message", (m) => {
    if (m.authorKind === "assistant" && m.buyerId) console.log(`   PlusOne → ${name}: ${m.body}`);
  });
  await new Promise((r) => socket.on("connect", r));
  return {
    say: (body) =>
      new Promise((r) => {
        console.log(`${name}: ${body}`);
        socket.emit("chat:send", { body }, () => r());
      }),
  };
}

/** The host says something out loud (as if PlusOne heard it), then taps Apply on the card. */
async function hostSays(text, { apply = true } = {}) {
  console.log(`HOST: "${text}"`);
  await call(`/api/seller/sessions/${session.id}/host-speech`, {
    method: "POST",
    body: { text },
    seller,
  });
  for (let i = 0; i < 30 && apply; i++) {
    await wait(1000);
    const cards = (await call(`/api/seller/sessions/${session.id}/rules`, { seller })).filter(
      (r) => r.status === "proposed",
    );
    if (cards.length === 0) continue;
    await wait(2500); // let the camera see the card
    for (const c of cards) {
      console.log(`   card: ${c.summary} → Apply`);
      await call(`/api/seller/rules/${c.id}/apply`, { method: "POST", body: {}, seller });
    }
    return;
  }
}

const scenes = {
  // The host moves from the dress to the blouse; three buyers talk at once.
  async switch() {
    await show("A1");
    const [aisha, ben, chloe] = await Promise.all(["Aisha", "Ben", "Chloe"].map(buyer));
    await ben.say("+1 white M");
    await wait(6000);
    await show("A2");
    await wait(2500);
    await Promise.all([
      aisha.say("the dress just now, blue S"),
      ben.say("change to L, don't add another"),
      chloe.say("still got pink S?"),
    ]);
    await wait(10000);
  },
  // The last Blue M: Aisha has it, Bea waits, Aisha lets it go, Bea gets it.
  async "last-one"() {
    await show("A1");
    const [aisha, bea, chloe] = await Promise.all(["Aisha", "Bea", "Chloe"].map(buyer));
    await aisha.say("+1 blue M");
    await wait(7000);
    await bea.say("nak blue M satu");
    await wait(7000);
    await chloe.say("blue M, if no M forget it, don't want other colour");
    await wait(7000);
    await aisha.say("cancel la, I think too long for me");
    await wait(10000);
  },
  // The host just talks; deals become cards; the buyer's total changes.
  async deal() {
    await show("A1");
    const [aisha] = await Promise.all(["Aisha"].map(buyer));
    await aisha.say("+1 blue S and also the white puff blouse in M");
    await wait(9000);
    await hostSays("okay dress and puff blouse together, five dollars off ah");
    await wait(6000);
  },
  // Southeast Asian chat: each buyer gets an answer in their own language.
  async languages() {
    await show("A1");
    const [siti, mei, ploy, dewi] = await Promise.all(["Siti", "Mei", "Ploy", "Dewi"].map(buyer));
    await siti.say("nak saiz L warna sage satu");
    await wait(5000);
    await mei.say("要一件 blue 的 S");
    await wait(5000);
    await ploy.say("เอาสีฟ้า ไซส์ M 1 ตัวค่ะ");
    await wait(5000);
    await dewi.say("kak ongkir ke Jakarta berapa?");
    await wait(10000);
  },
  // A few people still owe when the host ends the live.
  async "close-out"() {
    await show("A1");
    const [aisha, ben, chloe, dan] = await Promise.all(["Aisha", "Ben", "Chloe", "Dan"].map(buyer));
    await aisha.say("+1 blue M");
    await ben.say("+1 sage S");
    await wait(5000);
    await dan.say("+1 blue M please");
    await chloe.say("got XL for the batik shirt?");
    await wait(10000);
    console.log("Now press End live in the seller console.");
  },
};

if (!scenes[scene]) {
  console.log(`Scenes: ${Object.keys(scenes).join(", ")}`);
  process.exit(1);
}
await scenes[scene]();
for (const s of sockets) s.disconnect();
