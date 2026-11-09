import { defineConfig } from "vite";

const signalingPort = Number.parseInt(process.env.SIGNALING_PORT || "8787", 10);

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    host: "localhost",
    strictPort: true,
    // WebSocket relay (dev) proxied so wss/ws paths work without CORS pain.
    proxy: {
      "/ws": {
        target: `ws://localhost:${signalingPort}`,
        ws: true,
      },
    },
  },
});
