import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type { OrderDTO } from "@plusone/shared";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { createHostListener } from "./ai/hostSpeech.js";
import { createInterpreter } from "./ai/interpret.js";
import { createDb, runMigrations } from "./db/client.js";
import { liveSessions, orders, sellers } from "./db/schema.js";
import { seedDemo } from "./db/seed.js";
import { loadEnv } from "./env.js";
import { createHostEars } from "./hostEars.js";
import { buildJobDeps } from "./jobs/deps.js";
import { listenForPushes } from "./jobs/relay.js";
import { createJobs } from "./jobs/runner.js";
import { provideJobDeps, remindToPay, writeRecap } from "./jobs/tasks.js";
import { isSellerToken } from "./lib/auth.js";
import { createLiveKit } from "./livekit.js";
import { createPayPal } from "./paypal/client.js";
import { createInvoicing } from "./paypal/invoicing.js";
import { createPayments } from "./paypal/payments.js";
import { ensureWebhook } from "./paypal/webhooks.js";
import { createChatPipeline } from "./pipeline.js";
import { createRealtime } from "./realtime.js";
import { registerRoutes } from "./routes.js";
import { toMessageDTO } from "./services/chat.js";
import { createSampleCrowd } from "./services/crowd.js";
import { startDemoHost, startDemoKeeper } from "./services/demo.js";
import { startHoldSweeper } from "./services/holds.js";
import { createNotifier } from "./services/notify.js";
import { REMIND_BEFORE_MS } from "./services/reminders.js";
import { createSpeechRelay } from "./speech.js";
import { studioAiRoute } from "./studioAi.js";

const env = loadEnv();

const app = Fastify({
  logger:
    process.env.NODE_ENV === "production"
      ? true
      : {
          transport: { target: "pino-pretty", options: { colorize: true, ignore: "pid,hostname" } },
        },
});

await app.register(cors, { origin: true });

const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db);
// A brand-new database (first deploy) opens with the demo shop already live.
if ((await db.select({ id: sellers.id }).from(sellers).limit(1)).length === 0) {
  await seedDemo(db);
  app.log.info("empty database: seeded the demo shop");
}

const realtime = createRealtime(app.server, { db, env, log: app.log });

// Background tasks: Render Workflows runs in production, in-process locally.
// Either way their pushes come back through Postgres.
const jobs = createJobs({
  apiKey: env.RENDER_API_KEY,
  workflowSlug: env.WORKFLOW_SLUG,
  log: app.log,
});
if (!jobs.onRender) {
  const local = buildJobDeps({ db, env, log: app.log });
  provideJobDeps(async () => ({ deps: local.deps, done: local.flush }));
}
const stopPushes = await listenForPushes({
  databaseUrl: env.DATABASE_URL,
  db,
  realtime,
  log: app.log,
});

// A held order gets a nudge a few minutes before the hold runs out.
const remindersStarted = new Set<string>();
function remindLater(order: OrderDTO) {
  if (order.status !== "reserved" || !order.holdExpiresAt) return;
  if (order.invoice?.status === "sent") return;
  if (Date.parse(order.holdExpiresAt) - Date.now() < REMIND_BEFORE_MS + 60_000) return;
  const key = `remind-${order.id}-${Date.parse(order.holdExpiresAt)}`;
  if (remindersStarted.has(key)) return;
  remindersStarted.add(key);
  jobs
    .start(remindToPay, [order.id, order.holdExpiresAt], key)
    .catch((err: unknown) => app.log.error({ err }, "couldn't schedule a payment reminder"));
}

const notify = createNotifier({ db, realtime, onOrder: remindLater });
const paypal = createPayPal(env);
const payments = paypal ? createPayments({ db, paypal, notify, log: app.log }) : null;
const invoicing =
  paypal && payments
    ? createInvoicing({
        db,
        paypal,
        payments,
        notify,
        log: app.log,
        // A buyer paid their invoice after the live: rewrite the recap so it doesn't say they owe.
        onPaid: async (orderId) => {
          const [row] = await db
            .select({ sessionId: orders.sessionId, status: liveSessions.status })
            .from(orders)
            .innerJoin(liveSessions, eq(liveSessions.id, orders.sessionId))
            .where(eq(orders.id, orderId));
          if (row?.status !== "ended") return;
          await jobs.start(writeRecap, [row.sessionId], `recap-${row.sessionId}-${orderId}`);
        },
      })
    : null;
const hostEars = createHostEars({
  db,
  realtime,
  listen: env.ANTHROPIC_API_KEY ? createHostListener(env.ANTHROPIC_API_KEY) : null,
  log: app.log,
});
if (env.DEEPGRAM_API_KEY) {
  realtime.useSpeech(
    createSpeechRelay({
      apiKey: env.DEEPGRAM_API_KEY,
      log: app.log,
      onInterim: (sessionId, text) => realtime.hostInterim(sessionId, text),
      onSentence: (sessionId, text) => hostEars.hear(sessionId, text),
    }),
  );
}
const pipeline = createChatPipeline({
  db,
  notify,
  interpret: env.ANTHROPIC_API_KEY ? createInterpreter(env.ANTHROPIC_API_KEY) : null,
  log: app.log,
  onMessage: (msg) => realtime.message(toMessageDTO(msg)),
  onThinking: realtime.thinking,
  hostSaid: (sessionId) => hostEars.recent(sessionId),
});
realtime.onChat(pipeline.receive);
const crowd = env.DEMO_MODE
  ? createSampleCrowd({
      db,
      receive: pipeline.receive,
      onShowcase: realtime.showcase,
      log: app.log,
    })
  : null;
const stopSweeper = startHoldSweeper({
  db,
  notify,
  log: app.log,
  onReleased: async (orderId) => {
    await invoicing?.cancelForOrder(orderId);
  },
});

const stopDemoKeeper = env.DEMO_MODE
  ? startDemoKeeper({ db, log: app.log, onReset: () => realtime.io.disconnectSockets() })
  : () => undefined;
const stopDemoHost = env.DEMO_MODE
  ? startDemoHost({ db, realtime, log: app.log })
  : () => undefined;

let webhookId: string | null = env.PAYPAL_WEBHOOK_ID || null;
await registerRoutes(app, {
  db,
  env,
  realtime,
  paypal,
  payments,
  invoicing,
  livekit: createLiveKit(env),
  hostEars,
  notify,
  jobs,
  crowd,
  webhookId: () => webhookId,
});

if (env.ANTHROPIC_API_KEY) {
  await app.register(
    studioAiRoute({
      apiKey: env.ANTHROPIC_API_KEY,
      isSeller: (token) => isSellerToken(env.SELLER_PASSWORD, token),
    }),
  );
}

// In production the API also serves the built web app: one origin, one service.
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  // Page routes (/live/..., /seller) get the app; missing files and API paths get a 404.
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    const page =
      req.method === "GET" &&
      !path.startsWith("/api/") &&
      !path.startsWith("/socket.io") &&
      !/\.[a-z0-9]+$/i.test(path);
    return page ? reply.sendFile("index.html") : reply.code(404).send({ error: "Not found" });
  });
}

app.addHook("onClose", async () => {
  stopSweeper();
  stopDemoKeeper();
  stopDemoHost();
  await stopPushes();
  realtime.io.close();
  await pool.end();
});

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Point PayPal's webhook at this server. Not fatal: payments still complete
// through the buyer's capture call, the webhook is the second confirmation.
if (paypal && env.PUBLIC_URL) {
  ensureWebhook(paypal, env.PUBLIC_URL, app.log, webhookId ?? undefined)
    .then((id) => {
      webhookId = id;
    })
    .catch((err) => app.log.error({ err }, "PayPal webhook setup failed"));
} else if (paypal) {
  app.log.warn("PUBLIC_URL not set: PayPal webhooks are off (payments still work through capture)");
}
