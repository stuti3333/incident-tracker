import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies the API to the Express server on :3000.
// `npm run build` writes ./dist, which server.js serves in production.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: 'dist', emptyOutDir: true }
});
