import { build } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A review artifact only: all data is explicitly synthetic and all account
// mutations stay disabled. The production desktop entry never sets this flag.
const workspace = fileURLToPath(new URL('..', import.meta.url));
const output = join(workspace, '.tmp', 'desktop-design-export');
await build({
  configFile: false,
  root: join(workspace, 'web'),
  base: './',
  plugins: [tailwindcss()],
  build: {
    outDir: output,
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      input: join(workspace, 'web', 'desktop.html'),
      output: { inlineDynamicImports: true },
    },
  },
});
let html = await readFile(join(output, 'desktop.html'), 'utf8');
async function asset(path, encoding = 'utf8') {
  const absolute = resolve(output, path);
  if (!absolute.startsWith(output + '\\') && !absolute.startsWith(output + '/')) throw new Error('Unexpected design asset path.');
  return readFile(absolute, encoding);
}
for (const match of [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^\"]+)"[^>]*>/g)]) {
  const css = await asset(match[1]);
  html = html.replace(match[0], () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`);
}
for (const match of [...html.matchAll(/<script\b[^>]*src="([^\"]+)"[^>]*><\/script>/g)]) {
  const js = await asset(match[1]);
  html = html.replace(match[0], () => `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`);
}
html = html.replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, '');
for (const match of [...html.matchAll(/(?:src|href)="(\.\/assets\/[^\"]+)"/g)]) {
  const mime = match[1].endsWith('.svg') ? 'image/svg+xml' : match[1].endsWith('.png') ? 'image/png' : null;
  if (!mime) throw new Error('Unexpected external design asset: ' + match[1]);
  const data = await asset(match[1], null);
  html = html.replace(match[0], () => match[0].replace(match[1], `data:${mime};base64,${data.toString('base64')}`));
}
html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-design-preview="true">');
if (/(?:src|href)="\.\/assets\//.test(html)) throw new Error('Design export still has an external asset.');
const destination = join(workspace, 'docs', 'design', 'desktop-v3.html');
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, html, 'utf8');
console.log('Standalone design preview: ' + destination);
