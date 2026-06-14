/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a node global available to the config
const host = process.env.TAURI_DEV_HOST;

// Vite config tuned for Tauri (fixed dev port, ignore the Rust crate).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // 1430 to avoid clashing with the-wall, which uses Tauri's default 1420.
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
