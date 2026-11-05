import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import pkg from "./package.json";
import { modelParts, partRange } from "./src/core/ocr/model-parts";

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

// Content-Security-Policy of the built site. GitHub Pages can't send headers,
// so the policy ships as the first <meta> in <head>: no inline script
// (untrusted book HTML can't run code even if the sanitizer ever misses
// something) and a pinned list of network destinations — the app itself,
// the two sync clouds, and the dictionary catalog. Dev runs without it:
// Vite's HMR client and React refresh inject inline scripts there.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  [
    "connect-src 'self' blob: data:",
    "https://oauth.yandex.ru https://cloud-api.yandex.net https://*.disk.yandex.net https://*.disk.yandex.ru",
    "https://api.dropboxapi.com https://content.dropboxapi.com https://notify.dropboxapi.com",
    "https://huggingface.co https://*.huggingface.co https://*.hf.co",
  ].join(" "),
  "img-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "manifest-src 'self'",
].join("; ");

const cspMeta: Plugin = {
  name: "csp-meta",
  apply: "build",
  transformIndexHtml() {
    return [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
        injectTo: "head-prepend",
      },
    ];
  },
};

// OCR models above the host's per-file cap ship as parts (see
// src/core/ocr/model-parts.ts). The build cuts them in dist/; the dev server
// answers `<file>.partN` by slicing the whole file in public/, so the
// downloader takes the same path everywhere.
const modelPartsPlugin: Plugin = {
  name: "model-parts",
  configureServer(server) {
    server.middlewares.use("/ocr-models", (req, res, next) => {
      const match = /^\/([\w.-]+)\.part(\d+)$/.exec((req.url ?? "").split("?")[0] ?? "");
      if (!match) return next();
      const file = join(process.cwd(), "public", "ocr-models", match[1]!);
      if (!existsSync(file)) return next();
      const { start, end } = partRange(statSync(file).size, Number(match[2]));
      if (end <= start) return next();
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(end - start));
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      createReadStream(file, { start, end: end - 1 }).pipe(res);
    });
  },
  closeBundle() {
    const dir = join(process.cwd(), "dist", "ocr-models");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const size = statSync(file).size;
      const count = modelParts(size);
      if (count === 1) continue;
      const bytes = readFileSync(file);
      for (let i = 0; i < count; i += 1) {
        const { start, end } = partRange(size, i);
        writeFileSync(`${file}.part${i}`, bytes.subarray(start, end));
      }
      unlinkSync(file);
    }
  },
};

// yuki is a static site at a domain root; VITE_BASE can still move it under
// a subpath.
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
    modelPartsPlugin,
    cspMeta,
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
        clientsClaim: true,
        // Precache every built asset including public/pdfjs (cmaps + fonts):
        // after the first visit the reader works fully offline. User books
        // live in IndexedDB and never touch the SW cache. The OCR wasm
        // runtime (~13.5MB) is precached too — hence the raised file limit.
        globPatterns: ["**/*"],
        // Not precached on purpose:
        // - ocr-models/: the merged decoder is fetched once into IndexedDB
        //   (the model cache), a second copy in the SW cache buys nothing.
        // - the WebGPU-only runtime (asyncify, ~24MB): needed solely
        //   when WebGPU is present, and that first run is online anyway —
        //   the models themselves download over the network then.
        // - dist duplicates of the threaded wasm that rolldown emits next to
        //   the ort bundles (the runtime loads them from /ort via wasmPaths).
        globIgnores: [
          "ocr-models/**",
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
    // in the OCR workers. Everything served is same-origin, so require-corp
    // breaks nothing here. A production host
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
