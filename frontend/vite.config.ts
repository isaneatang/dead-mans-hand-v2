import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "../dist"),
    emptyOutDir: true,
  },
  server: {
    fs: { allow: [resolve(__dirname, "..")] },
    // Must stay in sync with frontend/public/_headers and the fallback meta
    // policy in index.html. Every policy a browser receives is enforced
    // independently, so relaxing only one of the three changes nothing.
    headers: {
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' chrome-extension: moz-extension: safari-web-extension:; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://rpc.bohr.life https://scan.bohr.life; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  },
});
