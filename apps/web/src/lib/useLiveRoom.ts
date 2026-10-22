import type { ChatMessageDTO, OrderDTO, SessionDTO, StockChange } from "@plusone/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { api } from "./api";
import { connectLive, type LiveSocket } from "./socket";

interface LiveState {
  session: SessionDTO | null;
  messages: ChatMessageDTO[];
  orders: OrderDTO[];
  /** Buyer message ids the assistant is still working on. */
  thinking: Set<string>;
  connected: boolean;
  /** Bumped whenever the seller's "needs you" list changes. */
  attentionVersion: number;
  /** Bumped whenever cards from the host's voice change. */
  rulesVersion: number;
  /** Bumped whenever someone joins, leaves or gets served from a waitlist. */
  waitlistVersion: number;
  recapVersion: number;
  /** The latest "PlusOne, …" the host said out loud, for the copilot. */
  copilotAsk: { text: string; n: number } | null;
  /** The host's latest finished sentence, as PlusOne heard it. */
  heard: string | null;
  /** The sentence the host is in the middle of. */
  hearing: string;
  setSession: (s: SessionDTO) => void;
  setMessages: (m: ChatMessageDTO[]) => void;
  addMessage: (m: ChatMessageDTO) => void;
  setOrders: (o: OrderDTO[]) => void;
  upsertOrder: (o: OrderDTO) => void;
  applyStock: (changes: StockChange[]) => void;
  setShowcase: (productId: string | null, previousProductId: string | null) => void;
  setHostVideo: (on: boolean) => void;
  setThinking: (messageId: string, done: boolean) => void;
  setConnected: (c: boolean) => void;
  bumpAttention: () => void;
  bumpRules: () => void;
  bumpWaitlist: () => void;
  bumpRecap: () => void;
  setCopilotAsk: (text: string) => void;
  setHeard: (text: string) => void;
  setHearing: (text: string) => void;
}

export const useLive = create<LiveState>((set) => ({
  session: null,
  messages: [],
  orders: [],
  thinking: new Set(),
  connected: false,
  attentionVersion: 0,
  rulesVersion: 0,
  waitlistVersion: 0,
  recapVersion: 0,
  copilotAsk: null,
  heard: null,
  hearing: "",
  setSession: (session) => set({ session }),
  setMessages: (messages) => set({ messages }),
  addMessage: (m) =>
    set((s) => {
      if (s.messages.some((x) => x.id === m.id)) return s;
      const messages = [...s.messages, m].sort((a, b) => a.seq - b.seq);
      return { messages: messages.slice(-300) };
    }),
  setOrders: (orders) => set({ orders }),
  upsertOrder: (o) =>
    set((s) => {
      const rest = s.orders.filter((x) => x.id !== o.id);
      return { orders: [o, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
    }),
  applyStock: (changes) =>
    set((s) => {
      if (!s.session) return s;
      const byId = new Map(changes.map((c) => [c.variantId, c]));
      return {
        session: {
          ...s.session,
          products: s.session.products.map((p) => ({
            ...p,
            variants: p.variants.map((v) => {
              const c = byId.get(v.id);
              return c ? { ...v, available: c.available, reserved: c.reserved, sold: c.sold } : v;
            }),
          })),
        },
      };
    }),
  setShowcase: (productId, previousProductId) =>
    set((s) =>
      s.session ? { session: { ...s.session, currentProductId: productId, previousProductId } } : s,
    ),
  setHostVideo: (on) =>
    set((s) => (s.session ? { session: { ...s.session, hostVideoOn: on } } : s)),
  setThinking: (messageId, done) =>
    set((s) => {
      const thinking = new Set(s.thinking);
      if (done) thinking.delete(messageId);
      else thinking.add(messageId);
      return { thinking };
    }),
  setConnected: (connected) => set({ connected }),
  bumpAttention: () => set((s) => ({ attentionVersion: s.attentionVersion + 1 })),
  bumpRules: () => set((s) => ({ rulesVersion: s.rulesVersion + 1 })),
  bumpWaitlist: () => set((s) => ({ waitlistVersion: s.waitlistVersion + 1 })),
  bumpRecap: () => set((s) => ({ recapVersion: s.recapVersion + 1 })),
  setCopilotAsk: (text) => set((s) => ({ copilotAsk: { text, n: (s.copilotAsk?.n ?? 0) + 1 } })),
  setHeard: (heard) => set({ heard }),
  setHearing: (hearing) => set({ hearing }),
}));

/**
 * Loads a live session and keeps it current over Socket.IO. A buyer token gets
 * that buyer's private replies and orders; a seller token gets everything.
 */
export function useLiveRoom(opts: {
  handle: string;
  buyerToken?: string | null;
  sellerToken?: string | null;
}) {
  const { handle, buyerToken = null, sellerToken = null } = opts;
  const socketRef = useRef<LiveSocket | null>(null);
  // Resolves once this load has a socket. Sending right after joining (while the
  // page reconnects as the buyer) waits for it instead of failing.
  const readyRef = useRef<{
    promise: Promise<LiveSocket>;
    resolve: (s: LiveSocket) => void;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-runs the load on purpose
  useEffect(() => {
    let cancelled = false;
    const store = useLive.getState();
    setError(null);
    let resolve!: (s: LiveSocket) => void;
    readyRef.current = { promise: new Promise<LiveSocket>((r) => (resolve = r)), resolve };

    async function load() {
      const session = await api.live(handle);
      if (cancelled) return;
      store.setSession(session);

      const [messages, orders] = await Promise.all([
        api.messages(session.id, { buyerToken, sellerToken }),
        sellerToken
          ? api.sellerOrders(session.id, sellerToken)
          : buyerToken
            ? api.myOrders(session.id, buyerToken)
            : Promise.resolve([] as OrderDTO[]),
      ]);
      if (cancelled) return;
      store.setMessages(messages);
      store.setOrders(orders);

      const socket = connectLive({
        sessionId: session.id,
        ...(buyerToken ? { buyerToken } : {}),
        ...(sellerToken ? { sellerToken } : {}),
      });
      socketRef.current = socket;
      resolve(socket);
      socket.on("connect", () => useLive.getState().setConnected(true));
      socket.on("disconnect", (reason) => {
        useLive.getState().setConnected(false);
        // Only a demo reset closes sockets from the server: start over on the fresh shop.
        if (reason === "io server disconnect") window.location.reload();
      });
      socket.on("chat:message", (m) => useLive.getState().addMessage(m));
      socket.on("chat:thinking", ({ messageId, done }) =>
        useLive.getState().setThinking(messageId, done),
      );
      socket.on("order:updated", (o) => useLive.getState().upsertOrder(o));
      socket.on("stock:changed", (c) => useLive.getState().applyStock(c));
      socket.on("showcase:changed", ({ productId, previousProductId }) =>
        useLive.getState().setShowcase(productId, previousProductId),
      );
      socket.on("video:status", ({ on }) => useLive.getState().setHostVideo(on));
      socket.on("attention:changed", () => useLive.getState().bumpAttention());
      socket.on("rules:changed", () => useLive.getState().bumpRules());
      socket.on("waitlist:changed", () => useLive.getState().bumpWaitlist());
      socket.on("recap:changed", () => useLive.getState().bumpRecap());
      socket.on("copilot:ask", ({ text }) => useLive.getState().setCopilotAsk(text));
      socket.on("host:heard", ({ text }) => useLive.getState().setHeard(text));
      socket.on("host:interim", ({ text }) => useLive.getState().setHearing(text));
      // New products, prices or deals: reload the catalog, keep live state.
      socket.on("session:changed", () => {
        api.live(handle).then(
          (fresh) => {
            const current = useLive.getState().session;
            useLive
              .getState()
              .setSession({ ...fresh, hostVideoOn: current?.hostVideoOn ?? fresh.hostVideoOn });
          },
          () => undefined,
        );
      });
    }

    load().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [handle, buyerToken, sellerToken, reloadKey]);

  /** The current socket, waiting a few seconds for one if the page is (re)connecting. */
  const socketReady = useCallback(async () => {
    if (socketRef.current) return socketRef.current;
    const ready = readyRef.current?.promise;
    if (!ready) throw new Error("Not connected");
    return Promise.race([
      ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Still connecting, try again")), 8_000),
      ),
    ]);
  }, []);

  const send = useCallback(
    async (body: string) => {
      const socket = await socketReady();
      return new Promise<{ id: string }>((resolve, reject) => {
        socket.timeout(10_000).emit("chat:send", { body }, (err, result) => {
          if (err) return reject(new Error("No answer from the server, try again"));
          if (result.ok) resolve(result.data);
          else reject(new Error(result.error));
        });
      });
    },
    [socketReady],
  );

  /** Seller console: start/stop PlusOne listening, and stream microphone audio to it. */
  const hostListen = useCallback(
    async (language: string, on: boolean) => {
      const socket = await socketReady();
      return new Promise<boolean>((resolve, reject) => {
        socket.timeout(10_000).emit("host:listen", { language, on }, (err, result) => {
          if (err) return reject(new Error("No answer from the server"));
          if (result.ok) resolve(result.data.on);
          else reject(new Error(result.error));
        });
      });
    },
    [socketReady],
  );
  const hostAudio = useCallback((chunk: ArrayBuffer) => {
    socketRef.current?.emit("host:audio", chunk);
  }, []);

  return { error, send, reload, hostListen, hostAudio };
}
