import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy so the browser sees one origin (localhost:5173) while /auth and /api are forwarded
// to the Express server on :3200 - keeps session cookies same-site without extra CORS config.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/auth": "http://localhost:3200",
      "/api": "http://localhost:3200",
    },
  },
  build: {
    outDir: "dist",
  },
});
