import { defineConfig } from 'vite';
export default defineConfig({ root: 'web', build: { outDir: '../public', emptyOutDir: true }, server: { host: '127.0.0.1' } });
