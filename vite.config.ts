import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";

const nodeOnlyIngestPackages = [
  "@mozilla/readability",
  "crawlee",
  "got-scraping",
  "jsdom",
  "pdf-parse",
  "playwright",
  "playwright-core",
  "rss-parser",
  "chromium-bidi",
];

export default defineConfig({
  plugins: [
    vinext({
      images: { optimizer: imagesOptimizer() },
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
  build: {
    rolldownOptions: {
      external: nodeOnlyIngestPackages,
    },
  },
});
