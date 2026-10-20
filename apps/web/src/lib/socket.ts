import type { ClientToServerEvents, ServerToClientEvents, SocketAuth } from "@plusone/shared";
import { io, type Socket } from "socket.io-client";

export type LiveSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function connectLive(auth: SocketAuth): LiveSocket {
  // Same origin: Vite proxies /socket.io in dev; the API serves the app in production.
  return io({ auth, transports: ["websocket", "polling"] });
}
