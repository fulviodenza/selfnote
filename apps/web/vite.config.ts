import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Mirror the production nginx layout (apps/web/nginx.conf): /api/* → the
    // API with the prefix stripped, /ws → the sync websocket. Lets a dev
    // browser use http://localhost:5173 as the "server" during onboarding.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4445",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      // The /ws/<doc> path is preserved, matching nginx.
      "/ws": {
        target: "ws://127.0.0.1:4444",
        ws: true,
      },
    },
  },
});
