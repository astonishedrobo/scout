import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/web",
  },
  server: {
    proxy: {
      "/health": "http://127.0.0.1:7801",
      "/warnings": "http://127.0.0.1:7801",
      "/chat": "http://127.0.0.1:7801",
      "/reset": "http://127.0.0.1:7801",
      "/restore": "http://127.0.0.1:7801",
      "/approval": "http://127.0.0.1:7801",
      "/edit-done": "http://127.0.0.1:7801",
      "/sessions": "http://127.0.0.1:7801",
      "/files": "http://127.0.0.1:7801",
      "/workspace": "http://127.0.0.1:7801",
      "/artifacts": "http://127.0.0.1:7801",
      "/upload": "http://127.0.0.1:7801",
      "/shared": "http://127.0.0.1:7801",
      "/admin": "http://127.0.0.1:7801",
      "/config": "http://127.0.0.1:7801",
      "/memories": "http://127.0.0.1:7801",
      "/init-skill": "http://127.0.0.1:7801",
      "/init-save": "http://127.0.0.1:7801",
      "/init-status": "http://127.0.0.1:7801",
      "/api": "http://127.0.0.1:7801",
    },
  },
});
