import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import { createPayPal } from "../paypal/client.js";
import { createInvoicing } from "../paypal/invoicing.js";
import { createPayments } from "../paypal/payments.js";
import { createNotifier } from "../services/notify.js";
import { createRelay } from "./relay.js";
import type { JobDeps } from "./tasks.js";

/** Everything a task needs, wired to push through Postgres rather than sockets. */
export function buildJobDeps(input: { db: Db; env: Env; log: FastifyBaseLogger }) {
  const { db, env, log } = input;
  const relay = createRelay(db, log);
  const notify = createNotifier({ db, realtime: relay });
  const paypal = createPayPal(env);
  const payments = paypal ? createPayments({ db, paypal, notify, log }) : null;
  const deps: JobDeps = {
    db,
    notify,
    pushes: relay,
    invoicing: paypal && payments ? createInvoicing({ db, paypal, payments, notify, log }) : null,
    anthropicKey: env.ANTHROPIC_API_KEY || null,
    log,
  };
  return { deps, flush: relay.flush };
}
