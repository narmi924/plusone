import type { StockChange } from "@plusone/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import type { Db } from "../db/client.js";
import { chatMessages } from "../db/schema.js";
import type { Pushes, Realtime } from "../realtime.js";
import { toMessageDTO } from "../services/chat.js";
import { getOrderDTO } from "../services/orders.js";

// Background tasks run in their own process (on Render, one Workflows run per
// task), so they can't reach anyone's socket. They write to the database as
// usual and leave a note on a Postgres channel; the web server listens and
// does the push. Notes carry ids, not payloads, to stay under NOTIFY's 8 kB.

const CHANNEL = "plusone_pushes";

type Note =
  | { t: "message"; id: string }
  | { t: "order"; id: string }
  | { t: "stock"; sessionId: string; changes: StockChange[] }
  | { t: "session" | "waitlist" | "attention" | "recap"; sessionId: string };

/** Pushes for code running away from the web server. `flush` before the process ends. */
export function createRelay(
  db: Db,
  log: FastifyBaseLogger,
): Pushes & { flush: () => Promise<void> } {
  const pending = new Set<Promise<unknown>>();
  const send = (note: Note) => {
    const p: Promise<unknown> = db
      .execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify(note)})`)
      .catch((err: unknown) => log.warn({ err, note }, "couldn't pass a push to the web server"))
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  return {
    message: (msg) => send({ t: "message", id: msg.id }),
    order: (order) => send({ t: "order", id: order.id }),
    stock: (sessionId, changes) => {
      if (changes.length > 0) send({ t: "stock", sessionId, changes });
    },
    sessionChanged: (sessionId) => send({ t: "session", sessionId }),
    waitlistChanged: (sessionId) => send({ t: "waitlist", sessionId }),
    attentionChanged: (sessionId) => send({ t: "attention", sessionId }),
    recapChanged: (sessionId) => send({ t: "recap", sessionId }),
    flush: async () => {
      await Promise.allSettled([...pending]);
    },
  };
}

/** The web server's side: hear the notes and push them to the right sockets. */
export async function listenForPushes(deps: {
  databaseUrl: string;
  db: Db;
  realtime: Realtime;
  log: FastifyBaseLogger;
}) {
  const { db, realtime, log } = deps;
  let client: pg.Client | null = null;
  let stopped = false;

  async function deliver(note: Note) {
    switch (note.t) {
      case "message": {
        const [row] = await db.select().from(chatMessages).where(eq(chatMessages.id, note.id));
        if (row) realtime.message(toMessageDTO(row));
        break;
      }
      case "order": {
        const dto = await getOrderDTO(db, note.id);
        if (dto) realtime.order(dto);
        break;
      }
      case "stock":
        realtime.stock(note.sessionId, note.changes);
        break;
      case "session":
        realtime.sessionChanged(note.sessionId);
        break;
      case "waitlist":
        realtime.waitlistChanged(note.sessionId);
        break;
      case "attention":
        realtime.attentionChanged(note.sessionId);
        break;
      case "recap":
        realtime.recapChanged(note.sessionId);
        break;
    }
  }

  async function connect() {
    const c = new pg.Client({ connectionString: deps.databaseUrl });
    c.on("notification", (m) => {
      if (m.channel !== CHANNEL || !m.payload) return;
      let note: Note;
      try {
        note = JSON.parse(m.payload) as Note;
      } catch {
        return;
      }
      deliver(note).catch((err: unknown) => log.error({ err, note }, "push from a task failed"));
    });
    c.on("error", (err) => {
      log.error({ err }, "lost the task push channel, reconnecting");
      client = null;
      void c.end().catch(() => undefined);
      if (!stopped) setTimeout(() => void connect().catch(retryLater), 1000);
    });
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
    client = c;
  }
  const retryLater = (err: unknown) => {
    log.error({ err }, "task push channel unavailable, retrying");
    if (!stopped) setTimeout(() => void connect().catch(retryLater), 5000);
  };

  await connect();
  return async () => {
    stopped = true;
    await client?.end();
  };
}
