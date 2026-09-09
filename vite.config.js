import { defineConfig } from 'vite';

// Minimal, explicit Vite config.
// - Project root is the repo root; index.html lives here (Vite's default entry).
// - Root-relative base ('/') because the app is deployed at a domain root
//   (optionally behind Nginx Proxy Manager mapping a subdomain -> :8090).
// - three.js produces one large chunk; raise the warning limit to avoid noise.
export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
  },
  server: {
    host: true,
    port: 5173,
  },
});
