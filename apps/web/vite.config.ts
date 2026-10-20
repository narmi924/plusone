import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    // In dev the browser talks to the API through Vite, so there is one origin
    // for cookies and no CORS surprises.
    proxy: {
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/socket.io": { target: "http://localhost:3000", ws: true },
    },
  },
});
