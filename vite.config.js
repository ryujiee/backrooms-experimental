import { defineConfig } from "vite";

// Relative base so the static build works on GitHub Pages sub-paths, Netlify, Vercel or any static host.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 900,
  },
});
