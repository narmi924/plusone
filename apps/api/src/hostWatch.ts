import type { FastifyBaseLogger } from "fastify";
import type { HostEyes } from "./ai/hostEyes.js";
import type { Db } from "./db/client.js";
import type { Realtime } from "./realtime.js";
import { getSessionDTO, setShowcase } from "./services/catalog.js";

// Frames from the host's camera arrive here from the console. When two frames
// in a row show the same product, and it isn't already on screen, it goes on
// screen for buyers. One frame per session at a time; extras are dropped.

export function createHostWatch(deps: {
  db: Db;
  realtime: Realtime;
  look: HostEyes | null;
  log: FastifyBaseLogger;
}) {
  const sessions = new Map<string, { busy: boolean; last: string | null }>();

  return {
    available: Boolean(deps.look),
    async frame(sessionId: string, jpegBase64: string) {
      if (!deps.look) throw new Error("ANTHROPIC_API_KEY is not set");
      const state = sessions.get(sessionId) ?? { busy: false, last: null };
      sessions.set(sessionId, state);
      if (state.busy) return { busy: true as const };
      state.busy = true;
      try {
        const session = await getSessionDTO(deps.db, sessionId);
        if (!session) throw new Error("Unknown session");
        const onScreen = session.products.find((p) => p.id === session.currentProductId);
        const { seen, ms } = await deps.look({
          jpegBase64,
          products: session.products,
          onScreen: onScreen ? `${onScreen.code} ${onScreen.name}` : null,
        });
        const product =
          seen?.sure && seen.code ? session.products.find((p) => p.code === seen.code) : undefined;
        const again = Boolean(product) && state.last === product?.code;
        state.last = product?.code ?? null;

        let switched = false;
        if (product && again && product.id !== session.currentProductId) {
          const result = await deps.db.transaction((tx) => setShowcase(tx, sessionId, product.id));
          deps.realtime.showcase(sessionId, result.productId, result.previousProductId);
          switched = true;
        }
        deps.log.info({ sessionId, seen, switched, ms }, "host camera looked at");
        return {
          busy: false as const,
          saw: seen?.saw ?? null,
          product: product ? { code: product.code, name: product.name } : null,
          onScreen: product?.id === session.currentProductId || switched,
          switched,
        };
      } finally {
        state.busy = false;
      }
    },
  };
}

export type HostWatch = ReturnType<typeof createHostWatch>;
