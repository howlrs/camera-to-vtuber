import { defineConfig } from 'vite';

// The Node server (server/index.ts) embeds Vite in middleware mode during development,
// so the app, /api/* and /ws/live share a single origin and port.
export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },
});
