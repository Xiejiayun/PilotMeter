import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run after installing the project's Playwright Chromium browser:
// node scripts/generate-icons.mjs
// The SVG is the source of truth; no image service or runtime dependency is used.
const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const assets = join(workspace, 'web', 'assets');
const source = await readFile(join(assets, 'pilotmeter.svg'), 'utf8');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  const renders = await page.evaluate(async ({ source, sizes }) => {
    const icon = new Image();
    icon.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);
    await icon.decode();
    return sizes.map(size => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.drawImage(icon, 0, 0, size, size);
      return { size, png: canvas.toDataURL('image/png').split(',')[1], rgba: Array.from(context.getImageData(0, 0, size, size).data) };
    });
  }, { source, sizes: [...sizes, 512] });

  // Store small frames as 32-bit DIBs for System.Drawing/.NET Framework;
  // the 256px PNG frame keeps Explorer's large icon compact and crisp.
  const frames = renders.filter(render => render.size <= 256).map(({ size, png, rgba }) => {
    if (size === 256) return { size, bytes: Buffer.from(png, 'base64') };
    const maskStride = Math.ceil(size / 32) * 4;
    const pixels = size * size * 4;
    const bytes = Buffer.alloc(40 + pixels + maskStride * size);
    bytes.writeUInt32LE(40, 0);
    bytes.writeInt32LE(size, 4);
    bytes.writeInt32LE(size * 2, 8);
    bytes.writeUInt16LE(1, 12);
    bytes.writeUInt16LE(32, 14);
    bytes.writeUInt32LE(pixels + maskStride * size, 20);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const input = (y * size + x) * 4;
        const output = 40 + ((size - 1 - y) * size + x) * 4;
        bytes[output] = rgba[input + 2];
        bytes[output + 1] = rgba[input + 1];
        bytes[output + 2] = rgba[input];
        bytes[output + 3] = rgba[input + 3];
        if (rgba[input + 3] === 0) bytes[40 + pixels + (size - 1 - y) * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return { size, bytes };
  });
  const directory = Buffer.alloc(6 + 16 * frames.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach(({ size, bytes }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(bytes.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  await writeFile(join(assets, 'pilotmeter.ico'), Buffer.concat([directory, ...frames.map(frame => frame.bytes)]));
  await writeFile(join(assets, 'pilotmeter-512.png'), Buffer.from(renders.find(render => render.size === 512).png, 'base64'));

  const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#F9FAF4;color:#2F432D;font-family:'Segoe UI','Microsoft YaHei',sans-serif}
    main{padding:48px 56px}.top{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #DAE2D1;padding-bottom:24px}
    .brand{font-size:24px;font-weight:650;letter-spacing:-.7px}.eyebrow{font-size:11px;letter-spacing:2.5px;color:#6F8164}
    .hero{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:30px}.tile{height:384px;display:flex;align-items:center;justify-content:center;border-radius:26px;background:#F2F6EA;border:1px solid #DDE5D7}
    .dark{background:#263524;border-color:#263524}.tile img{width:264px;height:264px}.caption{font-size:13px;color:#6F8164;margin:14px 2px}
    .bottom{display:flex;justify-content:space-between;align-items:center;margin-top:30px;padding-top:24px;border-top:1px solid #DAE2D1}.sizes{display:flex;align-items:center;gap:28px}.sample{display:flex;align-items:center;gap:9px;color:#6F8164;font-size:11px}
    .lockup{display:flex;align-items:center;gap:12px;color:#2F432D;font-size:22px;font-weight:650;letter-spacing:-.6px}.lockup img{width:36px;height:36px}
    .note{margin-top:34px;font-size:12px;color:#6F8164;letter-spacing:.4px}
  </style><main><div class="top"><div class="brand">PilotMeter</div><div class="eyebrow">APP ICON / 02</div></div>
    <div class="hero"><div><div class="tile"><img src="${uri}"></div><div class="caption">界面浅绿背景</div></div><div><div class="tile dark"><img src="${uri}"></div><div class="caption">深色背景</div></div></div>
    <div class="bottom"><div class="sizes">${[16,24,32,48].map(size => `<div class="sample"><img src="${uri}" width="${size}" height="${size}"><span>${size}px</span></div>`).join('')}</div><div class="lockup"><img src="${uri}">PilotMeter</div></div>
    <p class="note">导航指针 × 用量仪表 · 森林绿 / 鼠尾草绿 / 暖白 · 与桌面界面同源配色</p>
  </main></html>`);
  await page.evaluate(() => Promise.all(Array.from(document.images, image => image.decode())));
  const preview = join(workspace, 'docs', 'design', 'pilotmeter-icon-preview.png');
  await mkdir(dirname(preview), { recursive: true });
  await page.screenshot({ path: preview });
  console.log('Generated web/assets/pilotmeter.ico, pilotmeter-512.png and docs/design/pilotmeter-icon-preview.png');
} finally {
  await browser.close();
}
