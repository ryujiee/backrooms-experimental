import { defineConfig } from "vite";

// Relative base so the static build works on GitHub Pages sub-paths, Netlify, Vercel or any static host.
// QA_NO_HMR=1 serves a frozen dev build for long automated QA runs (edits do not reload the page).
const frozen = !!process.env.QA_NO_HMR;

export default defineConfig({
  base: "./",
  server: frozen ? { hmr: false, watch: null } : {},
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 900,
  },
});
