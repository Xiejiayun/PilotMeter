import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'web',
  plugins: [tailwindcss()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        dashboard: fileURLToPath(new URL('./web/index.html', import.meta.url)),
        desktop: fileURLToPath(new URL('./web/desktop.html', import.meta.url)),
      },
    },
  },
  server: { host: '127.0.0.1' },
});
