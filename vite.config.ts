import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";
import pkg from "./package.json";

// yuki is a static site: `base` comes from VITE_BASE at build time, so the
// same code deploys to a domain root or a GitHub Pages project subpath.
// __APP_VERSION__ surfaces the release version in Settings.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt",
      manifest: {
        name: "yuki",
        short_name: "yuki",
        description:
          "A quiet reader for Japanese novels and English books.",
        theme_color: "#f6f6f8",
        background_color: "#f6f6f8",
        display: "standalone",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        // Precache every built asset including public/pdfjs (cmaps + fonts):
        // after the first visit the reader works fully offline. User books
        // live in IndexedDB and never touch the SW cache.
        globPatterns: ["**/*"],
        navigateFallback: "index.html",
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
});
