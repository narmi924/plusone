import type { Server as HttpServer } from "node:http";
import type {
  ChatMessageDTO,
  ClientToServerEvents,
  OrderDTO,
  ServerToClientEvents,
  SocketAuth,
  StockChange,
} from "@plusone/shared";
import type { FastifyBaseLogger } from "fastify";
import { Server } from "socket.io";
import type { Db } from "./db/client.js";
import type { buyers } from "./db/schema.js";
import type { Env } from "./env.js";
import { buyerFromToken, isSellerToken } from "./lib/auth.js";
import { getSessionRow } from "./services/catalog.js";
import type { SpeechRelay } from "./speech.js";

type Buyer = typeof buyers.$inferSelect;

interface SocketData {
  sessionId: string;
  buyer: Buyer | null;
  isSeller: boolean;
}

export type ChatHandler = (input: {
  sessionId: string;
  buyer: Buyer;
  body: string;
}) => Promise<{ id: string }>;

// Rooms: everyone watching a session, one per buyer (their private replies and
// orders), and the seller console for that session.
const sessionRoom = (id: string) => `session:${id}`;
const buyerRoom = (id: string) => `buyer:${id}`;
const sellerRoom = (sessionId: string) => `seller:${sessionId}`;

export function createRealtime(
  httpServer: HttpServer,
  deps: { db: Db; env: Env; log: FastifyBaseLogger },
) {
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    cors: { origin: true },
    // Lets a viewer on a flaky connection come back without losing events.
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000 },
  });

  let chatHandler: ChatHandler | null = null;
  let speech: SpeechRelay | null = null;
  // Whether the host's camera is on, per session. Viewers only join the video
  // room while it is, so idle visitors don't use up video minutes.
  const videoOn = new Map<string, boolean>();
  // A buyer typing faster than anyone could read gets asked to slow down, so a
  // stuck key or a script can't run up the AI bill on the public demo.
  const recentSends = new Map<string, number[]>();
  const tooFast = (buyerId: string) => {
    const now = Date.now();
    const sent = (recentSends.get(buyerId) ?? []).filter((t) => t > now - 30_000);
    sent.push(now);
    recentSends.set(buyerId, sent);
    return sent.length > 8;
  };

  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth as Partial<SocketAuth>;
      if (!auth.sessionId || !(await getSessionRow(deps.db, auth.sessionId))) {
        return next(new Error("unknown session"));
      }
      socket.data.sessionId = auth.sessionId;
      socket.data.buyer = await buyerFromToken(deps.db, auth.buyerToken);
      socket.data.isSeller = isSellerToken(deps.env.SELLER_PASSWORD, auth.sellerToken);
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error(String(err)));
    }
  });

  io.on("connection", (socket) => {
    const { sessionId, buyer, isSeller } = socket.data;
    socket.join(sessionRoom(sessionId));
    if (buyer) socket.join(buyerRoom(buyer.id));
    if (isSeller) socket.join(sellerRoom(sessionId));

    // The host's microphone, relayed to speech-to-text (seller console only).
    socket.on("host:listen", (payload, ack) => {
      if (!isSeller || !speech) return ack({ ok: false, error: "Speech is not available" });
      const language = ["en", "zh", "ms"].includes(payload?.language) ? payload.language : "en";
      if (payload?.on) speech.start(sessionId, language);
      else speech.stop(sessionId);
      ack({ ok: true, data: { on: speech.isOn(sessionId) } });
    });
    socket.on("host:audio", (chunk) => {
      if (isSeller && chunk) speech?.push(sessionId, chunk);
    });
    socket.on("disconnect", () => {
      // Host closed the console: stop paying for a stream nobody is talking into.
      if (isSeller) speech?.stop(sessionId);
    });

    socket.on("chat:send", async (payload, ack) => {
      const body = typeof payload?.body === "string" ? payload.body.trim().slice(0, 500) : "";
      if (!buyer) return ack({ ok: false, error: "Join the live first" });
      if (!body) return ack({ ok: false, error: "Empty message" });
      if (tooFast(buyer.id)) return ack({ ok: false, error: "Slow down a little, then try again" });
      if (!chatHandler) return ack({ ok: false, error: "Not ready" });
      try {
        ack({ ok: true, data: await chatHandler({ sessionId, buyer, body }) });
      } catch (err) {
        deps.log.error({ err }, "chat:send failed");
        ack({ ok: false, error: "Could not send, try again" });
      }
    });
  });

  return {
    io,
    onChat(handler: ChatHandler) {
      chatHandler = handler;
    },
    useSpeech(relay: SpeechRelay) {
      speech = relay;
    },
    hostInterim(sessionId: string, text: string) {
      io.to(sellerRoom(sessionId)).emit("host:interim", { text });
    },
    message(msg: ChatMessageDTO) {
      if (msg.visibility === "public") {
        io.to(sessionRoom(msg.sessionId)).emit("chat:message", msg);
      } else if (msg.buyerId) {
        io.to([buyerRoom(msg.buyerId), sellerRoom(msg.sessionId)]).emit("chat:message", msg);
      }
    },
    thinking(sessionId: string, buyerId: string, messageId: string, done: boolean) {
      io.to([buyerRoom(buyerId), sellerRoom(sessionId)]).emit("chat:thinking", {
        messageId,
        buyerId,
        done,
      });
    },
    order(order: OrderDTO) {
      io.to([buyerRoom(order.buyer.id), sellerRoom(order.sessionId)]).emit("order:updated", order);
    },
    stock(sessionId: string, changes: StockChange[]) {
      if (changes.length > 0) io.to(sessionRoom(sessionId)).emit("stock:changed", changes);
    },
    sessionChanged(sessionId: string) {
      io.to(sessionRoom(sessionId)).emit("session:changed");
    },
    waitlistChanged(sessionId: string) {
      io.to(sellerRoom(sessionId)).emit("waitlist:changed");
    },
    rulesChanged(sessionId: string) {
      io.to(sellerRoom(sessionId)).emit("rules:changed");
    },
    hostHeard(sessionId: string, text: string) {
      io.to(sellerRoom(sessionId)).emit("host:heard", { text });
    },
    attentionChanged(sessionId: string) {
      io.to(sellerRoom(sessionId)).emit("attention:changed");
    },
    recapChanged(sessionId: string) {
      io.to(sellerRoom(sessionId)).emit("recap:changed");
    },
    isVideoOn(sessionId: string) {
      return videoOn.get(sessionId) ?? false;
    },
    /** People with the live page open right now. */
    watching(sessionId: string) {
      return io.sockets.adapter.rooms.get(sessionRoom(sessionId))?.size ?? 0;
    },
    /** A seller console is open for this session. */
    hasSeller(sessionId: string) {
      return (io.sockets.adapter.rooms.get(sellerRoom(sessionId))?.size ?? 0) > 0;
    },
    setVideo(sessionId: string, on: boolean) {
      videoOn.set(sessionId, on);
      io.to(sessionRoom(sessionId)).emit("video:status", { on });
    },
    showcase(sessionId: string, productId: string | null, previousProductId: string | null) {
      io.to(sessionRoom(sessionId)).emit("showcase:changed", { productId, previousProductId });
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;

/** The pushes services make. Background tasks send them through Postgres (jobs/relay.ts). */
export type Pushes = Pick<
  Realtime,
  | "message"
  | "order"
  | "stock"
  | "sessionChanged"
  | "waitlistChanged"
  | "attentionChanged"
  | "recapChanged"
>;
