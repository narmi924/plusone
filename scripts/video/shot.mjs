// Plays one shot of the demo video in a real browser, the same way every time.
//   node --env-file=.env scripts/video/shot.mjs <shot> [--prod] [--screens <dir>] [--record <dir>]
// Shots: crowd, host-and-aisha, pay-and-save, autopay, seller, try
//
// A full-screen window opens and the shop is made ready for the shot (reset,
// buyers, PayPal saved where the shot needs it). Then it waits: start recording,
// press Enter, and the shot plays. With --screens it runs headless instead and
// saves stills for the README into <dir>. With --record it runs headless and records
// the shot itself: a track per page, the PayPal window included, and the marks the edit cuts on.
//
// Local by default (DEMO_MODE API on :3001, web on :5174). --prod plays against
// the hosted demo, where the close-out runs on Render Workflows.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { pointerScript, recorder } from "./record.mjs";

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { io } = require("socket.io-client");

const args = process.argv.slice(2);
const shot = args.find(
  (a) => !a.startsWith("--") && !["--screens", "--record"].includes(args[args.indexOf(a) - 1]),
);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const PROD = args.includes("--prod");
const WEB = opt("--web") ?? (PROD ? "https://plusone-sjgp.onrender.com" : "http://localhost:5174");
const API = opt("--api") ?? (PROD ? WEB : "http://127.0.0.1:3001");
const SCREENS = opt("--screens");
const RECORD = opt("--record");
const HEADLESS = Boolean(SCREENS || RECORD);
if (SCREENS) mkdirSync(SCREENS, { recursive: true });
const rec = RECORD ? recorder(join(RECORD, shot)) : null;

const { PAYPAL_SANDBOX_BUYER_EMAIL: EMAIL, PAYPAL_SANDBOX_BUYER_PASSWORD: PW } = process.env;
const SELLER_PASSWORD = process.env.SELLER_PASSWORD;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- the shop

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

const sellerToken = (
  await call("/api/seller/login", { method: "POST", body: { password: SELLER_PASSWORD } })
).token;
const session = () => call("/api/live/lumicloset");
async function resetShop() {
  await call("/api/seller/demo/reset", { method: "POST", body: {}, seller: sellerToken });
  await wait(2000);
  return session();
}
async function showProduct(code) {
  const s = await session();
  const p = s.products.find((x) => x.code === code);
  await call(`/api/seller/sessions/${s.id}/showcase`, {
    method: "POST",
    body: { productId: p.id },
    seller: sellerToken,
  });
}

/** Waits until the recorded host is showing `code`, at least `minLeft` seconds before it moves on. */
async function waitForReplay(code, minLeft = 12) {
  const config = await call("/api/config");
  if (!config.replay) return;
  const skew = config.replay.serverNow - Date.now();
  const { clips } = config.replay;
  const total = clips.reduce((n, c) => n + c.seconds, 0);
  for (;;) {
    let t = ((Date.now() + skew) / 1000) % total;
    for (const c of clips) {
      if (t < c.seconds) {
        if (c.product === code && c.seconds - t >= minLeft) return;
        break;
      }
      t -= c.seconds;
    }
    await wait(250);
  }
}

// ---------------------------------------------------------------- browsers

// Recorded shots are a little wider than 16:9: the band under the picture is for the captions.
const viewport = RECORD
  ? { width: 1536, height: 792 }
  : HEADLESS
    ? { width: 1600, height: 1000 }
    : null;
const scale = RECORD ? 2 : HEADLESS ? 1.25 : 1;
async function openBrowser({ camera } = {}) {
  const extra = camera
    ? [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-video-capture=${camera}`,
      ]
    : [];
  return chromium.launch({
    channel: process.env.BROWSER_CHANNEL ?? "msedge",
    headless: HEADLESS || Boolean(camera),
    args: [
      ...(HEADLESS || camera ? [] : ["--start-fullscreen"]),
      // Headless screencasts come at CSS size unless the device scale is forced.
      ...(RECORD && !camera ? [`--force-device-scale-factor=${scale}`] : []),
      ...extra,
    ],
  });
}
async function newPage(browser, { front = true } = {}) {
  const ctx = await browser.newContext({
    viewport: front ? viewport : { width: 1440, height: 900 },
    deviceScaleFactor: front ? scale : 1,
    locale: "en-US",
    permissions: ["camera", "microphone"],
  });
  if (RECORD && front) await ctx.addInitScript(pointerScript);
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());
  return page;
}

async function still(page, name) {
  if (!SCREENS) return;
  await page.screenshot({ path: join(SCREENS, `${name}.jpg`), type: "jpeg", quality: 88 });
  log("still", name);
}

/** Recording starts here: in the window, nothing has moved yet. */
async function ready() {
  if (RECORD) return rec.start();
  if (HEADLESS) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("\nReady. Start recording, then press Enter to play the shot… ");
  rl.close();
}

function mark(name) {
  rec?.mark(name);
  log(name);
}

async function done() {
  log("done");
  if (rec) log("recorded", JSON.stringify((await rec.finish()).tracks));
}

const pointer = new WeakMap();
/** Moves the pointer to `target` the way a hand does, then acts on it (click by default). */
async function tap(page, target, act = (t) => t.click()) {
  if (RECORD) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (box) {
      const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const from = pointer.get(page) ?? { x: to.x - 240, y: to.y + 140 };
      for (let i = 1; i <= 20; i++) {
        const k = i / 20;
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
        await wait(16);
      }
      pointer.set(page, to);
      await wait(180);
    }
  }
  await act(target);
}

// ---------------------------------------------------------------- people

async function buyerPage(browser, name, { front = true } = {}) {
  const page = await newPage(browser, { front });
  await page.goto(`${WEB}/live/lumicloset`);
  if (name) {
    await page.getByLabel("Your name").fill(name);
    await page.getByRole("button", { name: "Join" }).click();
    await page.getByLabel("Chat message").waitFor();
  }
  return page;
}

/** Types the way a person does, then sends. */
async function say(page, text) {
  const box = page.getByLabel("Chat message");
  if (!(await box.evaluate((el) => el === document.activeElement))) await tap(page, box);
  await page.keyboard.type(text, { delay: HEADLESS && !RECORD ? 0 : 70 });
  await wait(HEADLESS && !RECORD ? 0 : 350);
  await box.press("Enter");
}

const parcel = (page) => page.getByRole("region", { name: "Your parcel" });

async function payWithPayPal(page, { save }) {
  await page.getByRole("region", { name: "Held for you" }).waitFor({ timeout: 60_000 });
  const box = page.getByLabel("Save my PayPal for one tap next time");
  if (save && !(await box.isChecked())) {
    await wait(HEADLESS && !RECORD ? 0 : 700);
    await tap(page, box, (t) => t.check());
    mark("saved");
  }
  await wait(HEADLESS && !RECORD ? 800 : 1200);
  const [popup] = await Promise.all([
    page.waitForEvent("popup", { timeout: 30_000 }),
    tap(page, page.locator("paypal-button").first()),
  ]);
  // The window PayPal opens is phone-sized; recorded, it's its own track for the edit to lay on top.
  const shown = Boolean(rec?.live);
  if (shown) {
    await popup.setViewportSize({ width: 450, height: 640 });
    await rec.track("paypal", popup);
    mark("paypal");
  }
  await popup.waitForLoadState("domcontentloaded");
  await popup.locator("#email").waitFor({ timeout: 45_000 });
  await popup.locator("#email").fill(EMAIL);
  if (
    await popup
      .locator("#btnNext")
      .isVisible()
      .catch(() => false)
  ) {
    await popup.locator("#btnNext").click();
  }
  await popup.locator("#password").waitFor({ timeout: 45_000 });
  await popup.locator("#password").fill(PW);
  await (shown ? tap(popup, popup.locator("#btnLogin")) : popup.locator("#btnLogin").click());
  const pay = popup
    .locator(
      "#payment-submit-btn, button:has-text('Agree'), button:has-text('Complete Purchase'), button:has-text('Pay Now'), [data-testid='submit-button-initial']",
    )
    .first();
  await pay.waitFor({ timeout: 90_000 });
  await popup.waitForTimeout(HEADLESS && !shown ? 600 : 1500);
  if (shown) mark("paypal-pay");
  await (shown ? tap(popup, pay) : pay.click());
  await parcel(page).getByText("PAID", { exact: true }).first().waitFor({ timeout: 90_000 });
  if (shown) mark("paid");
  log("paid with PayPal", save ? "(saved)" : "");
}

/** Buyers who aren't on screen, talking through the same chat pipeline (a socket each). */
async function crowd(lines, gapMs) {
  const s = await session();
  const sockets = new Map();
  for (const [name, body] of lines) {
    let socket = sockets.get(name);
    if (!socket) {
      // With an email, as most real buyers leave one: PayPal emails their invoice
      // and can send its reminders.
      const email = `${name.toLowerCase().replace(/\s+/g, "")}@example.com`;
      const { token } = await call("/api/buyers", { method: "POST", body: { name, email } });
      socket = io(API, { auth: { sessionId: s.id, buyerToken: token }, transports: ["websocket"] });
      await new Promise((r) => socket.on("connect", r));
      sockets.set(name, socket);
    }
    await new Promise((r) => socket.emit("chat:send", { body }, () => r()));
    await wait(gapMs);
  }
  return () => {
    for (const sk of sockets.values()) sk.close();
  };
}

async function sellerConsole(browser, { front = true } = {}) {
  const page = await newPage(browser, { front });
  await page.goto(`${WEB}/seller`);
  await page.getByLabel("Password").fill(SELLER_PASSWORD);
  await page.getByRole("button", { name: "Open console" }).click();
  await page.getByRole("main", { name: "Tonight's order book" }).waitFor();
  return page;
}

/** The recorded host as a camera: the dress, then the bag, then the bag held up for a while. */
function hostCamera() {
  const out = join(tmpdir(), "plusone-host-camera.mjpeg");
  if (existsSync(out) && statSync(out).size > 1_000_000) return out;
  const dir = fileURLToPath(new URL("../../apps/web/public/replay/", import.meta.url));
  log("making the host camera file (once)…");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    join(dir, "dress.mp4"),
    "-i",
    join(dir, "bag.mp4"),
    "-filter_complex",
    "[1:v]split[b1][b2];[b2]trim=12:19.6,setpts=PTS-STARTPTS,loop=6:size=228:start=0[hold];" +
      "[0:v][b1][hold]concat=n=3:v=1:a=0,fps=25,scale=960:540[v]",
    "-map",
    "[v]",
    "-q:v",
    "4",
    "-f",
    "mjpeg",
    out,
  ]);
  return out;
}

// ---------------------------------------------------------------- shots

const shots = {
  // S1–S2: a busy minute on the buyer page, then the seller's manifests filling up.
  async crowd() {
    await resetShop();
    const browser = await openBrowser();
    const buyer = await buyerPage(browser, null);
    const seller = await sellerConsole(browser);
    await rec?.track("buyer", buyer);
    await rec?.track("seller", seller);
    await buyer.bringToFront();
    await waitForReplay("A1", 26);
    await ready();
    const s = await session();
    await call(`/api/seller/sessions/${s.id}/crowd`, {
      method: "POST",
      body: {},
      seller: sellerToken,
    });
    mark("crowd");
    await wait(16_000);
    await still(buyer, "crowd-buyer");
    await seller.bringToFront();
    mark("seller");
    await wait(26_000);
    await still(seller, "crowd-seller");
    await done();
    await wait(2000);
    await browser.close();
  },

  // S3: the host puts the dress down and holds up the bag; the price label follows by itself.
  // Aisha points back at the dress, then changes the size in Malay.
  async "host-and-aisha"() {
    await resetShop();
    await showProduct("A1");
    const camera = hostCamera();
    const backstage = await openBrowser({ camera });
    const host = await sellerConsole(backstage, { front: false });
    const browser = await openBrowser();
    const aisha = await buyerPage(browser, "Aisha");
    await rec?.track("buyer", aisha);
    await ready();
    await host.getByRole("button", { name: "Go live with camera" }).click();
    await host.getByRole("button", { name: "Turn camera off" }).waitFor({ timeout: 60_000 });
    await host.getByLabel("Watch", { exact: true }).click();
    mark("watching");
    const tag = aisha.locator("[role=img][aria-label]").first();
    await aisha.waitForFunction(
      (el) => el?.getAttribute("aria-label")?.startsWith("Woven Rattan Bag"),
      await tag.elementHandle(),
      { timeout: 90_000 },
    );
    mark("bag");
    await wait(2500);
    mark("say-before");
    await say(aisha, "the blue one from before, M");
    await parcel(aisha).getByText("Blue M").waitFor({ timeout: 45_000 });
    mark("blue-m");
    await wait(RECORD ? 3600 : 2500);
    mark("say-l");
    await say(aisha, "tukar L, jangan tambah");
    await parcel(aisha).getByText("Blue L").waitFor({ timeout: 45_000 });
    mark("blue-l");
    await wait(RECORD ? 5000 : 3000);
    await still(aisha, "host-and-aisha");
    await done();
    await wait(2000);
    await host
      .getByRole("button", { name: "Turn camera off" })
      .click()
      .catch(() => {});
    await browser.close();
    await backstage.close();
  },

  // S4: she pays for the dress and chooses to save PayPal with the shop.
  async "pay-and-save"() {
    await resetShop();
    const browser = await openBrowser();
    const aisha = await buyerPage(browser, "Aisha");
    await say(aisha, "+1 A1 blue L");
    await aisha.getByRole("region", { name: "Held for you" }).waitFor({ timeout: 60_000 });
    await rec?.track("buyer", aisha);
    await ready();
    await wait(1500);
    await payWithPayPal(aisha, { save: true });
    await aisha.getByRole("region", { name: "Auto-pay" }).waitFor({ timeout: 30_000 });
    mark("saved-shown");
    await wait(3000);
    await still(aisha, "pay-and-save");
    await done();
    await wait(2000);
    await browser.close();
  },

  // S5: auto-pay on; "+1 the rattan bag"; a question pauses it; one payment for both.
  async autopay() {
    await resetShop();
    const browser = await openBrowser();
    const aisha = await buyerPage(browser, "Aisha");
    await say(aisha, "+1 A1 blue L");
    await payWithPayPal(aisha, { save: true });
    await aisha.getByRole("region", { name: "Auto-pay" }).waitFor({ timeout: 30_000 });
    await rec?.track("buyer", aisha);
    await waitForReplay("A8", 14);
    await ready();
    await wait(1500);
    await tap(aisha, aisha.getByRole("switch", { name: "Auto-pay my +1s tonight" }));
    mark("autopay-on");
    await wait(2000);
    mark("say-bag");
    await say(aisha, "+1 the rattan bag");
    await aisha.getByRole("region", { name: "Auto-pay countdown" }).waitFor({ timeout: 45_000 });
    mark("countdown");
    await wait(4000);
    await still(aisha, "autopay-countdown");
    mark("say-scarf");
    await say(aisha, "and the scarf too");
    await aisha.getByRole("region", { name: "Auto-pay waiting" }).waitFor({ timeout: 45_000 });
    mark("waiting");
    await wait(RECORD ? 9000 : 4000);
    await still(aisha, "autopay-waiting");
    await tap(aisha, aisha.getByRole("button", { name: /Floral/ }).first());
    mark("floral");
    await aisha.getByRole("region", { name: "Auto-pay countdown" }).waitFor({ timeout: 45_000 });
    mark("countdown-again");
    await parcel(aisha).getByText("Silk Square Scarf").waitFor({ timeout: 45_000 });
    await aisha
      .getByRole("region", { name: "Auto-pay countdown" })
      .waitFor({ state: "detached", timeout: 60_000 });
    mark("paid");
    await wait(RECORD ? 4500 : 3000);
    await still(aisha, "autopay-paid");
    await done();
    await wait(2000);
    await browser.close();
  },

  // S7: how to try it: the live page, a name, "+1", the Sandbox login under the PayPal button,
  // the seller's password on the login page, the Demo menu.
  async try() {
    await resetShop();
    const browser = await openBrowser();
    const buyer = await buyerPage(browser, null);
    await rec?.track("buyer", buyer);
    await waitForReplay("A8", 16);
    await ready();
    await wait(1500);
    await tap(buyer, buyer.getByLabel("Your name"));
    await buyer.keyboard.type("Sam", { delay: HEADLESS && !RECORD ? 0 : 110 });
    await wait(300);
    await tap(buyer, buyer.getByRole("button", { name: "Join" }));
    await buyer.getByLabel("Chat message").waitFor();
    mark("joined");
    await wait(500);
    await say(buyer, "+1");
    await buyer.getByRole("region", { name: "Held for you" }).waitFor({ timeout: 60_000 });
    mark("held");
    await wait(4000);
    await still(buyer, "try-buyer");
    const seller = await newPage(browser);
    await seller.goto(`${WEB}/seller`);
    await rec?.track("seller", seller);
    mark("login");
    await wait(1500);
    await tap(seller, seller.getByRole("button", { name: SELLER_PASSWORD }));
    await wait(500);
    await tap(seller, seller.getByRole("button", { name: "Open console" }));
    await seller.getByRole("main", { name: "Tonight's order book" }).waitFor();
    mark("console");
    await wait(1200);
    await tap(seller, seller.locator("summary", { hasText: "Demo" }));
    mark("demo-menu");
    await wait(3000);
    await still(seller, "try-seller");
    await done();
    await wait(1000);
    await browser.close();
  },

  // S6–S7: the seller's table, End live, PayPal invoices, reminders approved in one tap, the recap.
  async seller() {
    await resetShop();
    const behind = await chromium.launch({
      channel: process.env.BROWSER_CHANNEL ?? "msedge",
      headless: true,
    });
    const aisha = await buyerPage(behind, "Aisha", { front: false });
    await say(aisha, "+1 A1 blue L");
    await payWithPayPal(aisha, { save: false });
    const close = await crowd(
      [
        ["Ben", "+1 blue S"],
        ["Siti", "nak saiz M warna sage satu"],
        ["Mei", "要一件 white 的 M blouse"],
        ["Wei Ming", "+1 the rattan bag"],
      ],
      3500,
    );
    await wait(8000);
    const browser = await openBrowser();
    const seller = await sellerConsole(browser);
    await seller.getByText("Wei Ming").first().waitFor({ timeout: 60_000 });
    await rec?.track("seller", seller);
    await ready();
    await wait(RECORD ? 5500 : 3500);
    await still(seller, "seller-table");
    await tap(seller, seller.getByRole("button", { name: "End live" }));
    mark("end-live");
    await seller
      .getByText(/invoice due/i)
      .first()
      .waitFor({ timeout: 120_000 });
    mark("invoiced");
    await wait(RECORD ? 6000 : 3000);
    await still(seller, "seller-invoiced");
    const ask = seller.getByRole("textbox", { name: "Ask PlusOne" });
    await tap(seller, ask);
    mark("ask");
    await seller.keyboard.type("Send a PayPal reminder to everyone with an open invoice", {
      delay: HEADLESS && !RECORD ? 0 : 45,
    });
    await ask.press("Enter");
    const all = seller.getByRole("button", { name: /Approve all/ });
    await all.waitFor({ timeout: 120_000 });
    mark("cards");
    await wait(RECORD ? 5500 : 2500);
    await still(seller, "seller-approve");
    await tap(seller, all);
    mark("approved");
    await wait(6000);
    await seller.getByRole("region", { name: "After the live" }).waitFor({ timeout: 120_000 });
    await seller.getByRole("region", { name: "After the live" }).scrollIntoViewIfNeeded();
    mark("recap");
    await wait(RECORD ? 7000 : 5000);
    await still(seller, "seller-recap");
    await done();
    await wait(2000);
    close();
    await browser.close();
    await behind.close();
  },
};

if (!shots[shot]) {
  console.log(`Shots: ${Object.keys(shots).join(", ")}`);
  process.exit(1);
}
await shots[shot]();
process.exit(0);
