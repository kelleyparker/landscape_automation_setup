#!/usr/bin/env node
/**
 * Builds a contact sheet from a shot directory so a reviewer can judge several
 * angles side by side, and optionally crops a region at 1:1 pixels so fine
 * detail (band edges, line width, foam shapes) can be inspected without the
 * downscale that a full-frame view forces.
 *
 * Uses headless Chromium's 2D canvas as the image compositor - no image
 * libraries, same zero-dependency spirit as the game itself.
 *
 * Usage:
 *   node tools/montage.mjs --in shots/review --out shots/review/_sheet.png
 *   node tools/montage.mjs --in shots/review --crop chase:0.5,0.6,0.25
 *        (shot:centerX,centerY,widthFraction - emits shots/review/_crop-chase.png)
 */
import { chromium } from 'playwright';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { in: 'shots/latest', out: null, cols: 2, crop: null, maxWidth: 2400 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--in') out.in = next();
    else if (a === '--out') out.out = next();
    else if (a === '--cols') out.cols = Number(next());
    else if (a === '--crop') out.crop = next();
    else if (a === '--max-width') out.maxWidth = Number(next());
  }
  return out;
}
const ARGS = parseArgs(process.argv);

const CHROME = process.env.WAVEBREAK_CHROME ??
  (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
    ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
    : undefined);

async function main() {
  const dir = path.resolve(ROOT, ARGS.in);
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.png') && !f.startsWith('_'))
    .sort();
  if (!files.length) { console.error(`no PNGs in ${dir}`); process.exit(1); }

  const images = [];
  for (const f of files) {
    const buf = await readFile(path.join(dir, f));
    images.push({ name: path.basename(f, '.png'), data: 'data:image/png;base64,' + buf.toString('base64') });
  }

  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');

  if (ARGS.crop) {
    const [name, spec] = ARGS.crop.split(':');
    const [cx, cy, w] = spec.split(',').map(Number);
    const img = images.find((i) => i.name === name);
    if (!img) { console.error(`no shot named ${name}`); process.exit(1); }
    const b64 = await page.evaluate(async ({ img, cx, cy, w }) => {
      const el = new Image();
      el.src = img.data;
      await el.decode();
      const cw = Math.round(el.naturalWidth * w);
      const ch = Math.round(cw * 9 / 16);
      const sx = Math.max(0, Math.min(el.naturalWidth - cw, Math.round(el.naturalWidth * cx - cw / 2)));
      const sy = Math.max(0, Math.min(el.naturalHeight - ch, Math.round(el.naturalHeight * cy - ch / 2)));
      const cv = document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(el, sx, sy, cw, ch, 0, 0, cw, ch);
      return cv.toDataURL('image/png').split(',')[1];
    }, { img, cx, cy, w });
    const outFile = path.join(dir, `_crop-${name}.png`);
    await writeFile(outFile, Buffer.from(b64, 'base64'));
    console.log(path.relative(ROOT, outFile));
    await browser.close();
    return;
  }

  const b64 = await page.evaluate(async ({ images, cols, maxWidth }) => {
    const els = [];
    for (const im of images) {
      const el = new Image();
      el.src = im.data;
      await el.decode();
      els.push({ el, name: im.name });
    }
    const rows = Math.ceil(els.length / cols);
    const cellW = Math.floor(maxWidth / cols);
    const cellH = Math.round(cellW * (els[0].el.naturalHeight / els[0].el.naturalWidth));
    const label = 34;
    const cv = document.createElement('canvas');
    cv.width = cellW * cols;
    cv.height = (cellH + label) * rows;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#101a35';
    ctx.fillRect(0, 0, cv.width, cv.height);
    els.forEach((e, i) => {
      const cx = (i % cols) * cellW;
      const cy = Math.floor(i / cols) * (cellH + label);
      ctx.drawImage(e.el, cx, cy + label, cellW, cellH);
      ctx.fillStyle = '#fff4d6';
      ctx.font = '600 20px system-ui, sans-serif';
      ctx.fillText(e.name, cx + 10, cy + 24);
    });
    return cv.toDataURL('image/png').split(',')[1];
  }, { images, cols: ARGS.cols, maxWidth: ARGS.maxWidth });

  const outFile = ARGS.out ? path.resolve(ROOT, ARGS.out) : path.join(dir, '_sheet.png');
  await writeFile(outFile, Buffer.from(b64, 'base64'));
  console.log(path.relative(ROOT, outFile));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
