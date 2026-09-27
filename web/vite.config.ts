import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the API runs separately on :8080; both prefixes are proxied so the
// session cookie is same-origin exactly as it is in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/auth': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
