import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: process.env.VITE_BASE_URL || '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:3001", "/i": "http://127.0.0.1:3001" },
  },
  build: {
    chunkSizeWarningLimit: 3000,
  },
});
