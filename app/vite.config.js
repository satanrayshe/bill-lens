import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/bill-lens/",
  build: { outDir: "../dist", target: "es2020", assetsInlineLimit: 0 },
  worker: { format: "es" },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["icons/*.png", "samples/*.jpg"],
      manifest: {
        name: "Bill Lens",
        short_name: "Bill Lens",
        description: "Check a medicine bill against NPPA ceiling prices and Jan Aushadhi generics, on your phone.",
        theme_color: "#f4f1ea",
        background_color: "#f4f1ea",
        display: "standalone",
        lang: "en",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,jpg,json,svg}"],
        globIgnores: ["**/tesseract/**"],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes("/tesseract/"),
            handler: "CacheFirst",
            options: { cacheName: "ocr-engine", expiration: { maxEntries: 10 } },
          },
        ],
      },
    }),
  ],
});
