import { defineConfig } from 'vite';

// The Express backend (`npm start`) serves /api and /models; in development
// the Vite server proxies those to it.
const backend = process.env.BACKEND_URL || 'http://localhost:8090';
const proxy = { '/api': backend, '/models': backend };

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
  // The dev server listens on localhost only; set VITE_HOST=0.0.0.0 to expose
  // it on the LAN deliberately (it serves unbundled sources).
  server: {
    host: process.env.VITE_HOST || 'localhost',
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: {
    host: process.env.VITE_HOST || 'localhost',
    proxy,
  },
});
