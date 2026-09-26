import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev server proxies `/api` to the control app (default http://localhost:3000).
 * Production output goes to `dist/`, which the control app serves statically.
 * SSE (`/api/tasks/:id/events`) streams through the proxy unchanged.
 */
const controlUrl = process.env.AIRLOCK_CONTROL_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": { target: controlUrl, changeOrigin: false, ws: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
