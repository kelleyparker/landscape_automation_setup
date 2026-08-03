#!/usr/bin/env node
/**
 * Store and press assets, generated from real gameplay frames.
 *
 * Nothing here is hand-painted or mocked up: it drives the same deterministic
 * screenshot harness the project uses for visual review, captures at 4K, and
 * composes the exact pixel sizes itch.io and Steam ask for. Because the sim is
 * seeded and fixed-step, re-running this produces byte-identical art, so a
 * store page can be regenerated after a visual change instead of drifting out
 * of date with the build.
 *
 * The wordmark is drawn in code with the same canvas-2D treatment as the HUD
 * (ink stroke under a cream fill, hard offset shadow), so the marketing and the
 * game share one visual language rather than merely resembling each other.
 *
 * Usage:
 *   node tools/marketing.mjs                    # capture + compose everything
 *   node tools/marketing.mjs --skip-capture     # recompose from existing frames
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Two passes: gallery screenshots keep the HUD, because a store gallery should
// show what playing actually looks like. Capsules and cover art use clean
// frames - a capsule cropped through a speedometer reads as an unfinished page.
const RAW_HUD = path.join(ROOT, 'shots', 'marketing-hud');
const RAW_CLEAN = path.join(ROOT, 'shots', 'marketing-clean');
const OUT = path.join(ROOT, 'press');

const ARGS = process.argv.slice(2);
const SKIP_CAPTURE = ARGS.includes('--skip-capture');

const CHROME =
  process.env.WAVEBREAK_CHROME ??
  (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
    ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
    : undefined);

/**
 * Capture plan. Times are chosen for what the sim is actually doing at that
 * moment - mid-race with the pack close, not an empty stretch of water.
 */
const CAPTURE = { shots: ['chase', 'bow', 'aerial', 'lowwater', 'wake', 'pack'], time: 42 };

/**
 * Target sizes. Steam's capsule dimensions do change - re-check against the
 * Steamworks docs at upload time rather than trusting this list forever.
 * `focus` is the point of the source frame to keep centred when cropping,
 * in 0..1 of width/height.
 */
const TARGETS = [
  { file: 'itch-cover-630x500.png',        w: 630,  h: 500,  src: 'chase',    logo: 0.78, focus: [0.5, 0.55] },
  { file: 'steam-header-460x215.png',      w: 460,  h: 215,  src: 'chase',    logo: 0.86, focus: [0.5, 0.55] },
  { file: 'steam-small-462x174.png',       w: 462,  h: 174,  src: 'bow',      logo: 0.88, focus: [0.5, 0.5]  },
  { file: 'steam-main-616x353.png',        w: 616,  h: 353,  src: 'chase',    logo: 0.80, focus: [0.5, 0.55] },
  { file: 'steam-vertical-374x448.png',    w: 374,  h: 448,  src: 'bow',      logo: 0.84, focus: [0.5, 0.5]  },
  { file: 'steam-library-600x900.png',     w: 600,  h: 900,  src: 'bow',      logo: 0.84, focus: [0.5, 0.5]  },
  { file: 'steam-hero-3840x1240.png',      w: 3840, h: 1240, src: 'aerial',   logo: 0,    focus: [0.5, 0.55] },
  { file: 'steam-page-bg-1438x810.png',    w: 1438, h: 810,  src: 'aerial',   logo: 0,    focus: [0.5, 0.5]  },
  { file: 'steam-logo-1280x720.png',       w: 1280, h: 720,  src: null,       logo: 0.82, focus: [0.5, 0.5]  },
];

// ---------------------------------------------------------------- capture ---
function capture(outDir, port, extraArgs) {
  console.log(`> capturing ${CAPTURE.shots.length} frames at 3840x2160 -> ${path.relative(ROOT, outDir)}`);
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'tools', 'shoot.mjs'),
      '--shots', CAPTURE.shots.join(','),
      '--time', String(CAPTURE.time),
      '--width', '1920', '--height', '1080', '--dpr', '2',
      '--out', path.relative(ROOT, outDir),
      '--port', String(port),
      ...extraArgs,
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (res.status !== 0) {
    console.error('capture failed - the harness reported a console or page error');
    process.exit(res.status ?? 1);
  }
}

async function loadFrames(dir) {
  const out = {};
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.png') || f.startsWith('_')) continue;
    const buf = await readFile(path.join(dir, f));
    out[path.basename(f, '.png')] = 'data:image/png;base64,' + buf.toString('base64');
  }
  return out;
}

// ---------------------------------------------------------------- compose ---
/**
 * The wordmark and every composite are drawn inside a headless browser page so
 * we get canvas 2D without pulling in an image library - the same constraint
 * the game itself works under.
 */
const COMPOSE = ({ images, gallery, targets }) => {
  const decode = async (dataUrl) => {
    const el = new Image();
    el.src = dataUrl;
    await el.decode();
    return el;
  };

  /** WAVEBREAK lockup, matching the HUD's sticker treatment. */
  const drawWordmark = (ctx, cx, cy, width) => {
    const size = width / 6.1;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    const text = 'WAVEBREAK';
    ctx.letterSpacing = `${size * 0.04}px`;

    // Hard offset shadow, no blur - the HUD panels do the same.
    ctx.fillStyle = '#ff3d6e';
    ctx.fillText(text, cx + size * 0.055, cy + size * 0.055);
    // Ink stroke under a cream fill.
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#101a35';
    ctx.lineWidth = size * 0.17;
    ctx.strokeText(text, cx, cy);
    ctx.fillStyle = '#fff4d6';
    ctx.fillText(text, cx, cy);
    ctx.restore();
    return size;
  };

  return (async () => {
    const decoded = {};
    for (const [name, data] of Object.entries(images)) decoded[name] = await decode(data);
    const decodedGallery = {};
    for (const [name, data] of Object.entries(gallery)) decodedGallery[name] = await decode(data);
    const out = {};

    for (const t of targets) {
      const cv = document.createElement('canvas');
      cv.width = t.w;
      cv.height = t.h;
      const ctx = cv.getContext('2d');

      if (t.src && decoded[t.src]) {
        const img = decoded[t.src];
        // Cover-fit: scale so the frame fills the target, crop the overflow
        // around the requested focus point.
        const scale = Math.max(t.w / img.naturalWidth, t.h / img.naturalHeight);
        const dw = img.naturalWidth * scale;
        const dh = img.naturalHeight * scale;
        const dx = (t.w - dw) * t.focus[0];
        const dy = (t.h - dh) * t.focus[1];
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, dx, dy, dw, dh);
      } else {
        // Logo plate: transparent background so Steam can composite it.
        ctx.clearRect(0, 0, t.w, t.h);
      }

      if (t.logo > 0) {
        // Darken behind the wordmark just enough to keep it legible over
        // bright water, without turning the capsule into a grey box.
        if (t.src) {
          const bandH = t.h * 0.42;
          ctx.save();
          ctx.globalAlpha = 0.34;
          ctx.fillStyle = '#101a35';
          ctx.fillRect(0, t.h / 2 - bandH / 2, t.w, bandH);
          ctx.restore();
        }
        const size = drawWordmark(ctx, t.w / 2, t.h * 0.5, t.w * t.logo);
        if (t.h > 300) {
          ctx.save();
          ctx.textAlign = 'center';
          ctx.font = `700 ${size * 0.19}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
          ctx.letterSpacing = `${size * 0.06}px`;
          ctx.strokeStyle = '#101a35';
          ctx.lineWidth = size * 0.06;
          ctx.lineJoin = 'round';
          ctx.strokeText('CEL-SHADED ARCADE BOAT RACING', t.w / 2, t.h * 0.5 + size * 0.72);
          ctx.fillStyle = '#ffd23f';
          ctx.fillText('CEL-SHADED ARCADE BOAT RACING', t.w / 2, t.h * 0.5 + size * 0.72);
          ctx.restore();
        }
      }
      out[t.file] = cv.toDataURL('image/png').split(',')[1];
    }

    // Downscaled 1080p screenshots for store galleries.
    for (const [name, img] of Object.entries(decodedGallery)) {
      const cv = document.createElement('canvas');
      cv.width = 1920;
      cv.height = 1080;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, 1920, 1080);
      out[`screenshot-${name}-1920x1080.png`] = cv.toDataURL('image/png').split(',')[1];
    }
    return out;
  })();
};

async function main() {
  if (!SKIP_CAPTURE) {
    capture(RAW_CLEAN, 5211, ['--no-hud']);
    capture(RAW_HUD, 5212, []);
  }
  for (const d of [RAW_CLEAN, RAW_HUD]) {
    if (!existsSync(d)) { console.error(`no frames in ${d}`); process.exit(1); }
  }

  await mkdir(OUT, { recursive: true });

  const images = await loadFrames(RAW_CLEAN);
  const gallery = await loadFrames(RAW_HUD);
  console.log(`> composing from ${Object.keys(images).length} clean + ${Object.keys(gallery).length} HUD frames`);

  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');
  const results = await page.evaluate(COMPOSE, { images, gallery, targets: TARGETS });
  await browser.close();

  for (const [file, b64] of Object.entries(results)) {
    await writeFile(path.join(OUT, file), Buffer.from(b64, 'base64'));
    console.log('  ' + path.relative(ROOT, path.join(OUT, file)));
  }
  console.log(`\n> ${Object.keys(results).length} assets in ${path.relative(ROOT, OUT)}`);
  console.log('> Re-check Steam capsule sizes against current Steamworks docs before upload.');
}

main().catch((e) => { console.error(e); process.exit(1); });
