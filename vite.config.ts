import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5178,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8091", ws: true },
      "/api": { target: "http://127.0.0.1:8091", changeOrigin: true },
    },
  },
  build: {
    target: "es2022",
    rollupOptions: { input: { main: "index.html", animation: "animation.html" } },
  },
});
