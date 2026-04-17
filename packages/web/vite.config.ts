import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const DAEMON_URL = process.env.YT2PT_DAEMON_URL ?? "http://127.0.0.1:8090";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: DAEMON_URL,
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
