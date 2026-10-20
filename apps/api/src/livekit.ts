import { randomUUID } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import type { Env } from "./env.js";

// The host's camera goes out through LiveKit (hosted WebRTC). The server only
// mints short-lived tokens: the seller may publish, everyone else may watch.

export function createLiveKit(env: Env) {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return null;
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = env;

  return {
    url,
    async token(input: { sessionId: string; host: boolean; name?: string }) {
      const identity = input.host ? `host-${input.sessionId}` : `viewer-${randomUUID()}`;
      const at = new AccessToken(key, secret, {
        identity,
        name: input.name ?? identity,
        ttl: "6h",
      });
      at.addGrant({
        room: `plusone-${input.sessionId}`,
        roomJoin: true,
        canSubscribe: true,
        canPublish: input.host,
        canPublishData: false,
      });
      return { url, token: await at.toJwt(), identity };
    },
  };
}

export type LiveKit = NonNullable<ReturnType<typeof createLiveKit>>;
