import type { FastifyBaseLogger } from "fastify";
import type { HostListener } from "./ai/hostSpeech.js";
import type { Db } from "./db/client.js";
import type { Realtime } from "./realtime.js";
import { getSessionDTO, previousShowcaseProductId } from "./services/catalog.js";
import { listRules, proposeRules } from "./services/rules.js";

// The host's finished sentences arrive here from the console (speech-to-text
// runs in the host's browser). We keep the last minute or so, ask PlusOne what
// it announces, and put any cards in front of the host. One request per
// session at a time, so cards don't arrive twice.

const KEEP_MS = 90_000;

export function createHostEars(deps: {
  db: Db;
  realtime: Realtime;
  listen: HostListener | null;
  log: FastifyBaseLogger;
}) {
  const heard = new Map<string, Array<{ at: number; text: string }>>();
  const tail = new Map<string, Promise<void>>();

  async function think(sessionId: string, newest: string) {
    if (!deps.listen) return;
    const session = await getSessionDTO(deps.db, sessionId);
    if (!session) return;
    const before = await previousShowcaseProductId(deps.db, sessionId, session.currentProductId);
    const onScreen = session.products.find((p) => p.id === session.currentProductId) ?? null;
    const shownBefore = session.products.find((p) => p.id === before) ?? null;
    const existing = (await listRules(deps.db, sessionId)).map((r) => `${r.status}: ${r.summary}`);
    const recent = (heard.get(sessionId) ?? []).map((h) => h.text);

    const { proposals, ms } = await deps.listen({
      sellerName: session.seller.name,
      currency: session.seller.currency,
      products: session.products,
      onScreen: onScreen && { code: onScreen.code, name: onScreen.name },
      shownBefore: shownBefore && { code: shownBefore.code, name: shownBefore.name },
      existing,
      earlier: recent.slice(0, -1),
      newest,
    });
    deps.log.info({ sessionId, newest, proposals: proposals.length, ms }, "host speech understood");
    if (proposals.length > 0) {
      await proposeRules(deps.db, sessionId, proposals);
      deps.realtime.rulesChanged(sessionId);
    }
  }

  return {
    /** What the host said in the last minute, oldest first, for reading buyers' messages. */
    recent(sessionId: string, withinMs = 60_000) {
      const now = Date.now();
      return (heard.get(sessionId) ?? []).filter((h) => now - h.at < withinMs).map((h) => h.text);
    },
    hear(sessionId: string, text: string) {
      const clean = text.trim().slice(0, 500);
      if (!clean) return;
      const now = Date.now();
      const list = (heard.get(sessionId) ?? []).filter((h) => now - h.at < KEEP_MS);
      list.push({ at: now, text: clean });
      heard.set(sessionId, list);
      deps.realtime.hostHeard(sessionId, clean);

      const next = (tail.get(sessionId) ?? Promise.resolve())
        .then(() => think(sessionId, clean))
        .catch((err: unknown) => deps.log.error({ err }, "listening to the host failed"));
      tail.set(sessionId, next);
    },
  };
}

export type HostEars = ReturnType<typeof createHostEars>;
