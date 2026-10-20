// The whole money path in real browsers against the local app:
// "+1" -> held -> PayPal Sandbox checkout -> paid -> buyer cancels in chat ->
// seller refunds with one click. Uses the installed Edge (or Chrome).
//   node --env-file=.env scripts/e2e-pay.mjs [screenshot-dir]
// Needs PAYPAL_SANDBOX_BUYER_EMAIL / PAYPAL_SANDBOX_BUYER_PASSWORD in .env and
// `pnpm dev` (or dev:public + dev:web) running.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const OUT = process.argv[2] ?? "e2e-shots";
mkdirSync(OUT, { recursive: true });
const WEB = process.env.WEB_URL ?? "http://localhost:5174";
const {
  PAYPAL_SANDBOX_BUYER_EMAIL: EMAIL,
  PAYPAL_SANDBOX_BUYER_PASSWORD: PASSWORD,
  SELLER_PASSWORD,
} = process.env;
if (!EMAIL || !PASSWORD) {
  console.log("no sandbox buyer login in .env");
  process.exit(2);
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
const ctxFor = (viewport) =>
  browser.newContext({ viewport, deviceScaleFactor: 2, locale: "en-US" });

const seller = await (await ctxFor({ width: 1440, height: 900 })).newPage();
await seller.goto(`${WEB}/seller`);
await seller.getByLabel("Password").fill(SELLER_PASSWORD);
await seller.getByRole("button", { name: "Open console" }).click();
await seller.getByRole("main", { name: "Tonight's order book" }).waitFor();

const page = await (await ctxFor({ width: 1440, height: 900 })).newPage();
await page.goto(`${WEB}/live/lumicloset`);
await page.getByLabel("Your name").fill("Mei");
await page.getByLabel("Email").fill("mei@example.com");
await page.getByRole("button", { name: "Join" }).click();
const say = async (t) => {
  await page.getByLabel("Chat message").fill(t);
  await page.getByRole("button", { name: "Send" }).click();
};
await say("+1 sage L");
await page.getByRole("region", { name: "Held for you" }).first().waitFor({ timeout: 30000 });
await page.waitForTimeout(3000);
log("held, opening PayPal");

const [popup] = await Promise.all([
  page.waitForEvent("popup", { timeout: 20000 }),
  page.locator("paypal-button").first().click(),
]);
await popup.waitForLoadState("domcontentloaded");
const email = popup.locator("#email");
await email.waitFor({ timeout: 30000 });
await email.fill(EMAIL);
const next = popup.locator("#btnNext");
if (await next.isVisible().catch(() => false)) await next.click();
const pw = popup.locator("#password");
await pw.waitFor({ timeout: 30000 });
await pw.fill(PASSWORD);
await popup.locator("#btnLogin").click();
log("logged in to sandbox");
const payBtn = popup
  .locator(
    "#payment-submit-btn, button:has-text('Complete Purchase'), button:has-text('Pay Now'), [data-testid='submit-button-initial']",
  )
  .first();
await payBtn.waitFor({ timeout: 60000 });
await popup.waitForTimeout(1500);
await popup.screenshot({ path: `${OUT}/12-paypal-review.png` }).catch(() => undefined);
await payBtn.click();
log("approved in PayPal");

await page.getByText("PAID", { exact: true }).first().waitFor({ timeout: 60000 });
log("buyer sees Paid");
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/13-buyer-paid.png` });
await seller.waitForTimeout(1000);
await seller.screenshot({ path: `${OUT}/14-seller-paid.png` });
if (process.env.E2E_STOP_AFTER_PAY) {
  log("stopping after payment");
  await browser.close();
  process.exit(0);
}

await say("sorry can cancel the dress? changed my mind");
const refund = seller.getByRole("button", { name: /Refund .* with PayPal/ });
await refund.waitFor({ timeout: 30000 });
log("seller sees refund request");
await seller.screenshot({ path: `${OUT}/15-seller-refund-request.png` });
await refund.click();
await refund.waitFor({ state: "detached", timeout: 60000 });
await page
  .getByText(/back to your PayPal|PayPal-mu|PayPal anda|PayPal ของคุณ|你的 PayPal/)
  .first()
  .waitFor({ timeout: 30000 });
log("refunded");
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/16-buyer-refunded.png` });
await browser.close();
