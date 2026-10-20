import type { FastifyBaseLogger } from "fastify";
import type { PayPal } from "./client.js";

// PayPal webhooks go through the Notifications REST API, which the server SDK
// doesn't cover. The webhook is registered by code: on boot we point the app's
// webhook at PUBLIC_URL (creating it if needed), so a new tunnel or deploy URL
// needs no trip to the developer dashboard.

export const WEBHOOK_PATH = "/api/paypal/webhook";

const WANTED_EVENTS = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.CANCELLED",
];

interface Webhook {
  id: string;
  url: string;
  event_types: Array<{ name: string }>;
}

/** Makes sure exactly one of this app's webhooks points at `${publicUrl}${WEBHOOK_PATH}`. Returns its id. */
export async function ensureWebhook(
  paypal: PayPal,
  publicUrl: string,
  log: FastifyBaseLogger,
  knownId?: string,
) {
  const url = `${publicUrl.replace(/\/$/, "")}${WEBHOOK_PATH}`;

  // Only subscribe to names PayPal recognises; the docs disagree on DENIED vs DECLINED.
  const available = await paypal.rest<{ event_types: Array<{ name: string }> }>(
    "GET",
    "/v1/notifications/webhooks-event-types",
  );
  const known = new Set(available.event_types.map((e) => e.name));
  const eventTypes = WANTED_EVENTS.filter((name) => known.has(name)).map((name) => ({ name }));

  const { webhooks } = await paypal.rest<{ webhooks: Webhook[] }>(
    "GET",
    "/v1/notifications/webhooks",
  );
  // A dev tunnel gets a new address on every start: re-point the old tunnel's
  // webhook rather than piling up new ones, but never touch the deployed one.
  const tunnel = (u: string) => new URL(u).hostname.endsWith(".trycloudflare.com");
  const existing =
    webhooks.find((w) => w.id === knownId) ??
    webhooks.find((w) => w.url === url) ??
    (tunnel(url) ? webhooks.find((w) => w.url.endsWith(WEBHOOK_PATH) && tunnel(w.url)) : undefined);

  if (!existing) {
    const created = await paypal.rest<Webhook>("POST", "/v1/notifications/webhooks", {
      url,
      event_types: eventTypes,
    });
    log.info({ url, id: created.id }, "PayPal webhook created");
    return created.id;
  }

  const sameEvents =
    existing.event_types
      .map((e) => e.name)
      .sort()
      .join() ===
    eventTypes
      .map((e) => e.name)
      .sort()
      .join();
  if (existing.url !== url || !sameEvents) {
    await paypal.rest("PATCH", `/v1/notifications/webhooks/${existing.id}`, [
      { op: "replace", path: "/url", value: url },
      { op: "replace", path: "/event_types", value: eventTypes },
    ]);
    log.info({ url, id: existing.id }, "PayPal webhook updated");
  } else {
    log.info({ url, id: existing.id }, "PayPal webhook ready");
  }
  return existing.id;
}

/**
 * Asks PayPal whether a delivery is genuine. The event is spliced in as the raw
 * body: re-serialising parsed JSON can change it and fail verification.
 */
export async function verifyWebhook(
  paypal: PayPal,
  webhookId: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
) {
  const h = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const fields = {
    auth_algo: h("paypal-auth-algo"),
    cert_url: h("paypal-cert-url"),
    transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"),
    transmission_time: h("paypal-transmission-time"),
    webhook_id: webhookId,
  };
  if (Object.values(fields).some((v) => !v)) return false;

  const body = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}`;
  const res = await paypal.rest<{ verification_status: string }>(
    "POST",
    "/v1/notifications/verify-webhook-signature",
    body,
  );
  return res.verification_status === "SUCCESS";
}
