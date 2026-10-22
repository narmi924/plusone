import type { PublicConfig } from "@plusone/shared";
import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Copilot } from "./ai/copilot.js";
import type { Db } from "./db/client.js";
import { buyers, liveSessions, orders, rules, webhookEvents } from "./db/schema.js";
import { seedDemo } from "./db/seed.js";
import { type Env, integrationStatus } from "./env.js";
import type { HostEars } from "./hostEars.js";
import type { HostWatch } from "./hostWatch.js";
import type { Jobs } from "./jobs/runner.js";
import { closeOutLive } from "./jobs/tasks.js";
import {
  bearer,
  buyerFromToken,
  isSellerToken,
  newBuyerToken,
  sellerTokenFor,
} from "./lib/auth.js";
import type { LiveKit } from "./livekit.js";
import type { PayPal } from "./paypal/client.js";
import type { Invoicing } from "./paypal/invoicing.js";
import { CARRIERS, type CarrierKey, PaymentError, type Payments } from "./paypal/payments.js";
import { verifyWebhook, WEBHOOK_PATH } from "./paypal/webhooks.js";
import type { Realtime } from "./realtime.js";
import { listAttention, resolveAttention } from "./services/attention.js";
import { AUTOPAY_LIMITS, getWallet, reArm, setAutopay } from "./services/autopay.js";
import {
  findSessionForHandle,
  getSessionDTO,
  getSessionRow,
  setShowcase,
} from "./services/catalog.js";
import { recentMessages } from "./services/chat.js";
import type { SampleCrowd } from "./services/crowd.js";
import type { Notifier } from "./services/notify.js";
import { listOrderDTOs } from "./services/orders.js";
import { sendPayReminder } from "./services/reminders.js";
import { applyRule, dismissRule, listRules } from "./services/rules.js";
import { listWaiting } from "./services/waitlist.js";

interface Deps {
  db: Db;
  env: Env;
  realtime: Realtime;
  paypal: PayPal | null;
  payments: Payments | null;
  invoicing: Invoicing | null;
  livekit: LiveKit | null;
  hostEars: HostEars;
  /** Reads frames from the host's camera and puts the product they hold up on screen. */
  hostWatch: HostWatch;
  notify: Notifier;
  jobs: Jobs;
  /** The seller's copilot (Claude + PayPal Agent Toolkit); null without an Anthropic key. */
  copilot: Copilot | null;
  /** Public demo only: a busy minute of buyers, played on request. */
  crowd: SampleCrowd | null;
  webhookId: () => string | null;
}

// A name is enough to order. The email comes from PayPal at the first payment;
// a buyer who never pays and gave none gets their invoice as a link instead.
const JoinBody = z.object({
  name: z.string().trim().min(1).max(40),
  email: z.union([z.string().trim().email().max(120), z.literal("")]).default(""),
});

export async function registerRoutes(app: FastifyInstance, deps: Deps) {
  const { db, env, realtime } = deps;

  const requireBuyer = async (req: FastifyRequest, reply: FastifyReply) => {
    const buyer = await buyerFromToken(db, bearer(req.headers.authorization));
    if (!buyer) {
      reply.code(401).send({ error: "Join the live first" });
      return null;
    }
    return buyer;
  };
  const requireSeller = (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.headers["x-seller-token"];
    if (!isSellerToken(env.SELLER_PASSWORD, typeof token === "string" ? token : null)) {
      reply.code(401).send({ error: "Seller sign-in required" });
      return false;
    }
    return true;
  };

  app.get("/health", async () => ({
    ok: true,
    integrations: integrationStatus(env),
    webhook: Boolean(deps.webhookId()),
  }));

  // Non-secret settings the browser needs. Secrets never leave the server.
  app.get(
    "/api/config",
    async (): Promise<PublicConfig> => ({
      paypalClientId: env.PAYPAL_CLIENT_ID ?? "",
      paypalEnv: env.PAYPAL_ENV,
      livekitUrl: env.LIVEKIT_URL || null,
      demo: env.DEMO_MODE
        ? {
            sellerPassword: env.SELLER_PASSWORD,
            sandboxBuyer:
              env.DEMO_SANDBOX_BUYER_EMAIL && env.DEMO_SANDBOX_BUYER_PASSWORD
                ? {
                    email: env.DEMO_SANDBOX_BUYER_EMAIL,
                    password: env.DEMO_SANDBOX_BUYER_PASSWORD,
                  }
                : null,
          }
        : null,
    }),
  );

  app.get<{ Params: { handle: string } }>("/api/live/:handle", async (req, reply) => {
    const sessionId = await findSessionForHandle(db, req.params.handle);
    const session = sessionId ? await getSessionDTO(db, sessionId) : null;
    if (!session) return reply.code(404).send({ error: "No live here" });
    return { ...session, hostVideoOn: realtime.isVideoOn(session.id) };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/messages", async (req) => {
    const buyer = await buyerFromToken(db, bearer(req.headers.authorization));
    const token = req.headers["x-seller-token"];
    const isSeller = isSellerToken(env.SELLER_PASSWORD, typeof token === "string" ? token : null);
    return recentMessages(db, req.params.id, { ...(buyer ? { buyerId: buyer.id } : {}), isSeller });
  });

  // Video: the seller gets a publish token, everyone else a watch-only one.
  app.get<{ Params: { id: string } }>("/api/sessions/:id/video-token", async (req, reply) => {
    if (!deps.livekit) return reply.code(503).send({ error: "Live video is not configured" });
    const row = await getSessionRow(db, req.params.id);
    if (!row) return reply.code(404).send({ error: "Unknown session" });
    const token = req.headers["x-seller-token"];
    const host = isSellerToken(env.SELLER_PASSWORD, typeof token === "string" ? token : null);
    return deps.livekit.token({
      sessionId: row.session.id,
      host,
      name: host ? row.seller.name : "viewer",
    });
  });

  // --- Buyers ---

  app.post("/api/buyers", async (req, reply) => {
    const parsed = JoinBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter your name" });
    const { token, tokenHash } = newBuyerToken();
    const [buyer] = await db
      .insert(buyers)
      .values({ ...parsed.data, tokenHash })
      .returning();
    if (!buyer) return reply.code(500).send({ error: "Could not join" });
    return { token, buyer: { id: buyer.id, name: buyer.name, email: buyer.email } };
  });

  app.get("/api/me", async (req, reply) => {
    const buyer = await requireBuyer(req, reply);
    if (!buyer) return;
    return { id: buyer.id, name: buyer.name, email: buyer.email };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/my-orders", async (req, reply) => {
    const buyer = await requireBuyer(req, reply);
    if (!buyer) return;
    return listOrderDTOs(db, { sessionId: req.params.id, buyerId: buyer.id });
  });

  // --- Payments (buyer) ---

  const sendPaymentError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof PaymentError)
      return reply.code(err.status).send({ error: err.message, issue: err.issue });
    throw err;
  };

  app.post<{ Params: { id: string }; Body: { save?: unknown } | null }>(
    "/api/orders/:id/paypal",
    async (req, reply) => {
      const buyer = await requireBuyer(req, reply);
      if (!buyer) return;
      if (!deps.payments) return reply.code(503).send({ error: "PayPal is not configured" });
      try {
        const site = req.headers.origin || env.PUBLIC_URL || "http://localhost:5174";
        return await deps.payments.createForOrder(req.params.id, buyer.id, {
          save: req.body?.save === true,
          returnUrl: `${site}/live`,
        });
      } catch (err) {
        return sendPaymentError(reply, err);
      }
    },
  );

  // One tap with the PayPal the buyer saved at an earlier checkout.
  app.post<{ Params: { id: string } }>("/api/orders/:id/pay-saved", async (req, reply) => {
    const buyer = await requireBuyer(req, reply);
    if (!buyer) return;
    if (!deps.payments) return reply.code(503).send({ error: "PayPal is not configured" });
    try {
      return await deps.payments.payWithSaved(req.params.id, buyer.id, "saved");
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/wallet", async (req, reply) => {
    const buyer = await requireBuyer(req, reply);
    if (!buyer) return;
    return getWallet(db, buyer.id, req.params.id);
  });

  app.put<{ Params: { id: string }; Body: { limitCents?: unknown } | null }>(
    "/api/sessions/:id/autopay",
    async (req, reply) => {
      const buyer = await requireBuyer(req, reply);
      if (!buyer) return;
      const limit = req.body?.limitCents ?? null;
      if (limit !== null && !AUTOPAY_LIMITS.includes(limit as (typeof AUTOPAY_LIMITS)[number]))
        return reply.code(400).send({ error: "Pick one of the limits" });
      try {
        await setAutopay(db, deps.notify, {
          buyerId: buyer.id,
          sessionId: req.params.id,
          limitCents: limit as number | null,
        });
        return getWallet(db, buyer.id, req.params.id);
      } catch (err) {
        return sendPaymentError(reply, err);
      }
    },
  );

  app.delete("/api/me/paypal", async (req, reply) => {
    const buyer = await requireBuyer(req, reply);
    if (!buyer) return;
    if (!deps.payments) return reply.code(503).send({ error: "PayPal is not configured" });
    await deps.payments.forgetSaved(buyer.id);
    await reArm(db, deps.notify, buyer.id);
    return { savedPayPal: null, autopay: null };
  });

  app.post<{ Params: { paypalOrderId: string } }>(
    "/api/paypal/orders/:paypalOrderId/capture",
    async (req, reply) => {
      const buyer = await requireBuyer(req, reply);
      if (!buyer) return;
      if (!deps.payments) return reply.code(503).send({ error: "PayPal is not configured" });
      try {
        return await deps.payments.capture(req.params.paypalOrderId, buyer.id);
      } catch (err) {
        return sendPaymentError(reply, err);
      }
    },
  );

  // --- Seller console ---

  app.post("/api/seller/login", async (req, reply) => {
    const password = (req.body as { password?: unknown } | null)?.password;
    if (typeof password !== "string" || password !== env.SELLER_PASSWORD) {
      return reply.code(401).send({ error: "Wrong password" });
    }
    return { token: sellerTokenFor(env.SELLER_PASSWORD) };
  });

  app.get<{ Params: { id: string } }>("/api/seller/sessions/:id/orders", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    return listOrderDTOs(db, { sessionId: req.params.id });
  });

  app.post<{ Params: { id: string }; Body: { productId?: string } }>(
    "/api/seller/sessions/:id/showcase",
    async (req, reply) => {
      if (!requireSeller(req, reply)) return;
      const productId = req.body?.productId;
      if (!productId) return reply.code(400).send({ error: "productId required" });
      const row = await getSessionRow(db, req.params.id);
      if (!row) return reply.code(404).send({ error: "Unknown session" });
      const result = await db.transaction((tx) => setShowcase(tx, req.params.id, productId));
      realtime.showcase(req.params.id, result.productId, result.previousProductId);
      return result;
    },
  );

  app.post<{ Params: { id: string }; Body: { on?: boolean } }>(
    "/api/seller/sessions/:id/video",
    async (req, reply) => {
      if (!requireSeller(req, reply)) return;
      realtime.setVideo(req.params.id, req.body?.on === true);
      return { on: realtime.isVideoOn(req.params.id) };
    },
  );

  // --- The host's camera -> what's on screen ---

  app.post<{ Params: { id: string }; Body: { frame?: unknown } | null }>(
    "/api/seller/sessions/:id/look",
    async (req, reply) => {
      if (!requireSeller(req, reply)) return;
      if (!deps.hostWatch.available)
        return reply.code(503).send({ error: "PlusOne can't see without an Anthropic key" });
      const frame = req.body?.frame;
      if (typeof frame !== "string" || frame.length < 100 || frame.length > 900_000)
        return reply.code(400).send({ error: "Send one JPEG frame, base64" });
      return deps.hostWatch.frame(req.params.id, frame);
    },
  );

  // --- The host's voice -> cards ---

  // Finished sentences also arrive here (typed by hand, or from another speech engine).
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/api/seller/sessions/:id/host-speech",
    async (req, reply) => {
      if (!requireSeller(req, reply)) return;
      if (typeof req.body?.text === "string") deps.hostEars.hear(req.params.id, req.body.text);
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>("/api/seller/sessions/:id/waitlist", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    return listWaiting(db, req.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/seller/sessions/:id/rules", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    return listRules(db, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/seller/rules/:id/apply", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    const result = await applyRule(db, req.params.id);
    if (!result) return reply.code(409).send({ error: "This card was already handled" });
    const [rule] = await db
      .select({ sessionId: rules.sessionId })
      .from(rules)
      .where(eq(rules.id, req.params.id));
    const sessionId = rule?.sessionId;
    if (sessionId) {
      if (result.showcase)
        realtime.showcase(sessionId, result.showcase.productId, result.showcase.previousProductId);
      if (result.announcement) await deps.notify.announce(sessionId, result.announcement);
      await deps.notify.orders(result.touchedOrders);
      realtime.sessionChanged(sessionId);
      realtime.rulesChanged(sessionId);
    }
    return result.rule;
  });

  app.post<{ Params: { id: string } }>("/api/seller/rules/:id/dismiss", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    const row = await dismissRule(db, req.params.id);
    if (row) realtime.rulesChanged(row.sessionId);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/seller/sessions/:id/attention", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    return listAttention(db, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/seller/attention/:id/resolve", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    const sessionId = await resolveAttention(db, req.params.id);
    if (sessionId) realtime.attentionChanged(sessionId);
    return { ok: true };
  });

  // A friendly nudge to a buyer who hasn't paid yet, in their language. Used by
  // the report's AI ("remind everyone who still owes") and by hand.
  app.post<{ Params: { id: string; number: string } }>(
    "/api/seller/sessions/:id/orders/:number/remind",
    async (req, reply) => {
      if (!requireSeller(req, reply)) return;
      const [order] = await db
        .select()
        .from(orders)
        .where(
          and(eq(orders.sessionId, req.params.id), eq(orders.number, Number(req.params.number))),
        );
      if (!order) return reply.code(404).send({ error: `No order #${req.params.number}` });
      const result = await sendPayReminder(db, deps.notify, order.id);
      if (!result.sent) return reply.code(409).send({ error: result.reason });
      return { ok: true, buyer: result.buyer, minutesLeft: result.minutesLeft };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { carrier?: string; carrierName?: string; trackingNumber?: string };
  }>("/api/seller/orders/:id/ship", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    if (!deps.payments) return reply.code(503).send({ error: "PayPal is not configured" });
    const carrier = req.body?.carrier ?? "other";
    if (!(carrier in CARRIERS) && carrier !== "other")
      return reply.code(400).send({ error: "Unknown carrier" });
    try {
      await deps.payments.shipOrder(req.params.id, {
        carrier: carrier as CarrierKey,
        trackingNumber: req.body?.trackingNumber ?? "",
        ...(req.body?.carrierName ? { carrierName: req.body.carrierName } : {}),
      });
      return { ok: true };
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  // The host ends the live. The close-out (an invoice for everyone who still
  // owes, then the recap) runs as a background task.
  app.post<{ Params: { id: string } }>("/api/seller/sessions/:id/end", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    const sessionId = req.params.id;
    const [ended] = await db
      .update(liveSessions)
      .set({ status: "ended", endedAt: new Date() })
      .where(and(eq(liveSessions.id, sessionId), ne(liveSessions.status, "ended")))
      .returning({ id: liveSessions.id });
    if (!ended) return reply.code(409).send({ error: "This live has already ended" });
    realtime.sessionChanged(sessionId);
    const owing = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.sessionId, sessionId), eq(orders.status, "reserved")));
    await deps.jobs.start(closeOutLive, [sessionId], `close-out-${sessionId}`);
    return { owing: owing.length };
  });

  app.get<{ Params: { id: string } }>("/api/seller/sessions/:id/recap", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    const [row] = await db
      .select({ recap: liveSessions.recap })
      .from(liveSessions)
      .where(eq(liveSessions.id, req.params.id));
    return { recap: row?.recap ?? null };
  });

  // Money only goes back when the seller says so.
  app.post<{ Params: { id: string } }>("/api/seller/lines/:id/refund", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    if (!deps.payments) return reply.code(503).send({ error: "PayPal is not configured" });
    try {
      await deps.payments.refundLine(req.params.id);
      return { ok: true };
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  // The copilot streams what it's doing (steps, cards to approve, its answer) as server-sent events.
  app.post<{
    Params: { id: string };
    Body: { message?: string; history?: Array<{ role: "user" | "assistant"; text: string }> };
  }>("/api/seller/sessions/:id/copilot", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    if (!deps.copilot) return reply.code(503).send({ error: "The copilot needs an Anthropic key" });
    const message = String(req.body?.message ?? "")
      .trim()
      .slice(0, 600);
    if (!message) return reply.code(400).send({ error: "Ask something" });
    const history = (req.body?.history ?? [])
      .filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.text === "string")
      .map((h) => ({ role: h.role, text: h.text.slice(0, 2000) }));
    reply.hijack();
    const out = reply.raw;
    out.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: string, data: unknown) =>
      out.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
    try {
      await deps.copilot.ask(req.params.id, message, history, send);
    } catch (err) {
      req.log.error({ err }, "copilot failed");
      send("error", { message: "The copilot couldn't answer that; try again." });
    } finally {
      send("done", {});
      out.end();
    }
  });

  app.post<{ Params: { id: string; proposal: string } }>(
    "/api/seller/sessions/:id/copilot/:proposal/apply",
    async (req, reply) => {
      if (!requireSeller(req, reply)) return;
      if (!deps.copilot) return reply.code(503).send({ error: "No copilot" });
      try {
        return { ok: true, result: await deps.copilot.apply(req.params.proposal, req.params.id) };
      } catch (err) {
        return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post<{ Params: { id: string; proposal: string } }>(
    "/api/seller/sessions/:id/copilot/:proposal/dismiss",
    async (req, reply) => {
      if (!requireSeller(req, reply)) return;
      deps.copilot?.dismiss(req.params.proposal);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>("/api/seller/sessions/:id/crowd", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    if (!deps.crowd) return reply.code(404).send({ error: "Only on the public demo" });
    if (!deps.crowd.start(req.params.id)) {
      return reply.code(429).send({ error: "The crowd is busy; try again in a few minutes" });
    }
    return { started: true };
  });

  app.post("/api/seller/demo/reset", async (req, reply) => {
    if (!requireSeller(req, reply)) return;
    // Don't leave the old shop's invoices open in the PayPal account.
    await deps.invoicing?.cancelForOrder(null);
    const sessionId = await seedDemo(db);
    realtime.io.disconnectSockets();
    return { sessionId };
  });

  // --- PayPal webhooks: raw body needed for signature verification ---

  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) =>
      done(null, body),
    );

    scope.post(WEBHOOK_PATH, async (req, reply) => {
      const raw = typeof req.body === "string" ? req.body : "";
      const webhookId = deps.webhookId();
      if (!deps.paypal || !deps.payments || !webhookId) return reply.code(503).send();

      let event: { id?: string; event_type?: string; resource?: Record<string, unknown> };
      try {
        event = JSON.parse(raw);
      } catch {
        return reply.code(400).send();
      }
      if (!event.id || !event.event_type) return reply.code(400).send();

      const verified = await verifyWebhook(deps.paypal, webhookId, req.headers, raw).catch(
        (err) => {
          req.log.error({ err }, "webhook verification call failed");
          return null;
        },
      );
      // PayPal retries non-2xx deliveries, so a failed verification call asks for a retry.
      if (verified === null) return reply.code(503).send();
      if (!verified) {
        req.log.warn(
          { id: event.id, type: event.event_type },
          "PayPal webhook failed verification",
        );
        return reply.code(400).send();
      }

      const resourceId = typeof event.resource?.id === "string" ? event.resource.id : null;
      await db
        .insert(webhookEvents)
        .values({ id: event.id, eventType: event.event_type, resourceId, verified, payload: event })
        .onConflictDoNothing();
      const [stored] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, event.id));
      if (stored?.processedAt) return reply.code(200).send(); // redelivery of something already handled

      try {
        const ev = {
          event_type: event.event_type,
          ...(event.resource ? { resource: event.resource } : {}),
        };
        if (await deps.invoicing?.onWebhookEvent(ev)) {
          await db
            .update(webhookEvents)
            .set({ processedAt: new Date(), error: null })
            .where(eq(webhookEvents.id, event.id));
          return reply.code(200).send();
        }
        await deps.payments.onWebhookEvent({
          event_type: event.event_type,
          ...(event.resource ? { resource: event.resource } : {}),
        });
        await db
          .update(webhookEvents)
          .set({ processedAt: new Date(), error: null })
          .where(eq(webhookEvents.id, event.id));
      } catch (err) {
        req.log.error({ err, id: event.id }, "webhook handling failed");
        await db
          .update(webhookEvents)
          .set({ error: err instanceof Error ? err.message : String(err) })
          .where(eq(webhookEvents.id, event.id));
        // Non-2xx makes PayPal deliver it again later.
        return reply.code(500).send();
      }
      return reply.code(200).send();
    });
  });
}
