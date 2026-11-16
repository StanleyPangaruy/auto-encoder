import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// While developing, the screens run on Vite's server and the API calls go to the app server on port 3000.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3000" } },
  // One bundle is fine for an app that only ever loads from this PC.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
