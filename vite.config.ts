import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import pkg from "./package.json";

// Dev-only: the ONNX runtime builds its glue/wasm URLs dynamically and Vite's
// worker transform appends `?import` to them — which the public/ middleware
// 500s on ("files in /public skip plugin transforms"). Serve /ort/* straight
// from disk; both files are plain ESM/wasm and need no transform. Production
// hosts them as ordinary statics, so nothing here applies.
const ortStatic: Plugin = {
  name: "ort-static",
  configureServer(server) {
    server.middlewares.use("/ort", (req, res, next) => {
      const name = (req.url ?? "").split("?")[0] ?? "";
      if (!/^\/[\w.-]+$/.test(name)) return next();
      const file = join(process.cwd(), "public", "ort", name);
      if (!existsSync(file) || statSync(file).isDirectory()) return next();
      res.setHeader(
        "Content-Type",
        name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
      );
      // The threaded wasm runtime spawns its pthread workers FROM this glue
      // URL — a worker script loaded under cross-origin isolation is a
      // "frame resource" and must carry COEP itself, or Chrome blocks it
      // (coep-frame-resource-needs-coep-header) and session init hangs.
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      createReadStream(file).pipe(res);
    });
  },
};

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
    ortStatic,
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
        // live in IndexedDB and never touch the SW cache. The OCR wasm
        // runtime (~13.5MB) is precached too — hence the raised file limit.
        globPatterns: ["**/*"],
        // Not precached on purpose:
        // - ocr-models/: the merged decoder is fetched once into IndexedDB
        //   (the model cache), a second copy in the SW cache buys nothing.
        // - the WebGPU-only runtime (jsep/asyncify, ~50MB): needed solely
        //   when WebGPU is present, and that first run is online anyway —
        //   the models themselves download over the network then.
        // - dist duplicates of the threaded wasm that rolldown emits next to
        //   the ort bundles (the runtime loads them from /ort via wasmPaths).
        globIgnores: [
          "ocr-models/**",
          "ort/ort-wasm-simd-threaded.jsep.*",
          "ort/ort-wasm-simd-threaded.asyncify.*",
          "assets/ort-wasm-simd-threaded.*",
        ],
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        navigateFallback: "index.html",
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  optimizeDeps: {
    // Discovered via the OCR worker — pre-bundle at server start so the
    // late discovery never triggers a mid-session reload.
    include: ["onnxruntime-web/wasm", "onnxruntime-web/webgpu"],
  },
  worker: {
    // ES workers: the OCR runtime picks its onnxruntime-web build (wasm vs
    // webgpu) via a dynamic import, which needs code splitting in the worker.
    format: "es",
  },
  server: {
    port: 1420,
    strictPort: true,
    // Cross-origin isolation unlocks SharedArrayBuffer → multi-threaded wasm
    // in the OCR workers. Everything served is same-origin or CORS-enabled
    // (HF model CDN), so require-corp breaks nothing here. A production host
    // MUST send the same headers for threaded OCR; without them the runtime
    // just falls back to one thread per worker.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  },
  clearScreen: false,
});
