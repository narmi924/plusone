import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Where the API runs in dev; API_URL moves it off port 3000 when that's taken.
const api = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    // In dev the browser talks to the API through Vite, so there is one origin
    // for cookies and no CORS surprises.
    proxy: {
      "/api": api,
      "/health": api,
      "/socket.io": { target: api, ws: true },
    },
  },
});
