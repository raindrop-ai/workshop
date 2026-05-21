import react from "@vitejs/plugin-react-swc";
import { readFileSync } from "node:fs";
import path from "path";
import { defineConfig } from "vite";

const uiPort = Number(process.env.RAINDROP_WORKSHOP_UI_PORT ?? "5900");
const backendPort = Number(
  process.env.RAINDROP_WORKSHOP_BACKEND_PORT ??
    process.env.RAINDROP_WORKSHOP_PORT ??
    "5899",
);
const backendUrl = `http://localhost:${backendPort}`;
const researchApiUrl = `http://localhost:${process.env.RESEARCH_SIDECAR_PORT ?? "5902"}`;
const rootPackage = JSON.parse(
  readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
) as { version?: string };
const raindropVersion = process.env.RAINDROP_VERSION || rootPackage.version || "dev";
const raindropAssetsBaseUrl = (process.env.RAINDROP_ASSETS_BASE_URL || "https://raindrop.sh").replace(/\/+$/, "");

export default defineConfig({
  plugins: [react()],
  define: {
    __RAINDROP_VERSION__: JSON.stringify(raindropVersion),
    __RAINDROP_ASSETS_BASE_URL__: JSON.stringify(raindropAssetsBaseUrl),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: uiPort,
    proxy: {
      "/api": backendUrl,
      "/v1": backendUrl,
      "/ws": { target: backendUrl.replace(/^http/, "ws"), ws: true },
      "/research-api": researchApiUrl,
    },
  },
});
