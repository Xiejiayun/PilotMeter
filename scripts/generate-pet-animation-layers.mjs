import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Build-time only. The installed EXE reads these cropped transparent PNG layers;
// it does not need a browser, SVG library, network connection, or this script.
// Node indices are checked against the authored SVGs so edits cannot silently
// attach a motion to the wrong body part. Re-run after changing pet artwork.
const directory = fileURLToPath(new URL('../docs/design/pets/', import.meta.url));
const output = join(directory, 'animation');
const plans = [
  { id: '01', name: 'pilot', count: 31, parts: [ ['scarf', [0, 1], 80, 80], ['pilot-hand', [8, 9], 85, 84] ] },
  { id: '02', name: 'cat', count: 30, parts: [ ['cat-tail', [0, 1], 89, 100], ['cat-paw', [21, 22, 23, 24, 25, 26], 36, 89] ] },
  { id: '03', name: 'shiba', count: 27, parts: [ ['shiba-tail', [0, 1], 35, 99], ['scarf', [24], 80, 84] ] },
  { id: '04', name: 'penguin', count: 14, parts: [ ['penguin-left', [0], 36, 70], ['penguin-right', [1, 2], 95, 67] ] },
  { id: '05', name: 'slime', count: 13, parts: [ ['slime-left', [0], 29, 83], ['slime-right', [1], 103, 83] ] },
  { id: '06', name: 'robot', count: 26, parts: [ ['antenna', [0, 1, 2], 65, 29] ] },
  { id: '07', name: 'cloud', count: 14, parts: [ ['star', [6, 7, 8], 62, 87], ['sparkle', [13], 103, 27] ] },
  { id: '08', name: 'sprout', count: 17, parts: [] },
  { id: '09', name: 'jellyfish', count: 13, parts: [] },
  { id: '10', name: 'dragon', count: 22, parts: [ ['wing', [11, 12, 13], 50, 65], ['dragon-hand', [14, 15], 82, 77] ] },
];

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  for (const plan of plans) {
    const source = await readFile(join(directory, `pet-${plan.id}-${plan.name}.svg`), 'utf8');
    const layers = await page.evaluate(({ source, plan }) => {
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      const svg = doc.documentElement;
      const body = svg.querySelector('.pet-body');
      const children = [...body.children];
      if (children.length !== plan.count) throw new Error(`PET ${plan.id}: the SVG structure changed; review layer assignments.`);
      const fragment = nodes => nodes.map(node => node.outerHTML).join('');
      const nodes = children.map((node, index) => ({ markup: node.outerHTML, key: 'still', x: 64, y: 64, index }));
      for (const [key, indices, x, y] of plan.parts) for (const index of indices) Object.assign(nodes[index], { key, x, y });
      const subpath = (index, part) => {
        const node = children[index].cloneNode(true);
        const pieces = node.getAttribute('d').match(/M[^M]*/g);
        if (pieces?.length !== 2) throw new Error('Expected two independent authored subpaths.');
        node.setAttribute('d', pieces[part]);
        return node.outerHTML;
      };
      const replace = (index, count, replacements) => nodes.splice(index, count, ...replacements);
      if (plan.id === '06') {
        replace(7, 4, [
          { markup: subpath(7, 0) + subpath(8, 0) + children[9].outerHTML, key: 'robot-left', x: 42, y: 81 },
          { markup: subpath(7, 1) + subpath(8, 1) + children[10].outerHTML, key: 'robot-right', x: 87, y: 81 },
        ]);
      }
      if (plan.id === '08') {
        replace(6, 4, [
          { markup: children[6].outerHTML + subpath(8, 0) + subpath(9, 0), key: 'leaf-left', x: 63, y: 33 },
          { markup: children[7].outerHTML + subpath(8, 1) + subpath(9, 1), key: 'leaf-right', x: 65, y: 33 },
        ]);
      }
      if (plan.id === '09') {
        const tentacles = [35, 49, 64, 79, 93].map((x, index) => {
          const groups = [0, 1].map(groupIndex => {
            const group = children[groupIndex].cloneNode(false);
            group.append(children[groupIndex].children[index].cloneNode(true));
            return group;
          });
          return { markup: fragment(groups), key: `tentacle-${index}`, x, y: 69 };
        });
        replace(0, 2, tentacles);
      }
      // Preserve painter's order; only adjacent equal motions can share a PNG.
      const runs = [];
      for (const node of nodes) {
        const last = runs.at(-1);
        if (last?.key === node.key) last.markup += node.markup;
        else runs.push({ ...node });
      }
      const beforeBody = [...svg.children].filter(node => node !== body && node.localName !== 'defs' && node.localName !== 'title');
      if (beforeBody.length) runs.unshift({ key: 'shadow', x: 64, y: 112, markup: '', outside: fragment(beforeBody) });
      return runs.map(run => {
        const root = svg.cloneNode(false);
        root.setAttribute('width', '512'); root.setAttribute('height', '512');
        const defs = svg.querySelector('defs'); if (defs) root.append(defs.cloneNode(true));
        if (run.outside) root.insertAdjacentHTML('beforeend', run.outside);
        else { const group = body.cloneNode(false); group.innerHTML = run.markup; root.append(group); }
        return { key: run.key, pivotX: run.x, pivotY: run.y, source: new XMLSerializer().serializeToString(root) };
      });
    }, { source, plan });
    const manifest = [];
    for (let index = 0; index < layers.length; index++) {
      const layer = layers[index];
      const raster = await page.evaluate(async source => {
        const image = new Image();
        image.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(source)));
        await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, 512, 512).data;
        let left = 512, top = 512, right = -1, bottom = -1;
        for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) if (pixels[(y * 512 + x) * 4 + 3]) {
          left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
        if (right < left) throw new Error('Empty animation layer.');
        left = Math.max(0, left - 2); top = Math.max(0, top - 2); right = Math.min(511, right + 2); bottom = Math.min(511, bottom + 2);
        const crop = document.createElement('canvas'); crop.width = right - left + 1; crop.height = bottom - top + 1;
        crop.getContext('2d').drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
        return { x: left / 4, y: top / 4, width: crop.width / 4, height: crop.height / 4, png: crop.toDataURL('image/png').split(',')[1] };
      }, layer.source);
      const filename = `pet-${plan.id}-layer-${String(index).padStart(2, '0')}.png`;
      await writeFile(join(output, filename), Buffer.from(raster.png, 'base64'));
      const { png, ...bounds } = raster;
      manifest.push({ key: layer.key, pivotX: layer.pivotX, pivotY: layer.pivotY, ...bounds });
    }
    assert.ok(manifest.length >= 3 && manifest.length <= 10, 'Keep selected-pet allocations bounded.');
    await writeFile(join(output, `pet-${plan.id}.json`), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`PET ${plan.id}: ${manifest.length} cropped layers`);
  }
} finally { await browser.close(); }
