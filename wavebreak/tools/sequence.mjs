#!/usr/bin/env node
/**
 * Temporal verification.
 *
 * Every visual review in this project so far has been done on still frames, and
 * a still frame cannot show crawl, strobe, boiling, swimming or LOD popping -
 * which are exactly the artefacts that separate a good-looking screenshot from
 * a game that reads as finished in motion.
 *
 * Because the simulation is seeded and fixed-step, consecutive frames are
 * exactly reproducible, so these artefacts are measurable rather than a matter
 * of opinion. Three modes:
 *
 *   frozen  - sim does NOT advance (dt = 0) and the camera is fixed. Consecutive
 *             frames MUST be pixel-identical. Any difference at all is a real
 *             nondeterminism bug: an uninitialised buffer, a per-frame random,
 *             a feedback loop. This is an assertion, not a judgement call.
 *   static  - camera fixed, sim advancing. Intended to isolate surface crawl:
 *             water that shimmers, foam that boils, sparkles that strobe.
 *             CAVEAT, measured: with the camera pinned the boats keep driving
 *             through the frame, and a hull crossing a pixel registers as a
 *             luminance reversal exactly like a shimmer does. On the `lowwater`
 *             shot that put 12.8% of pixels in the strobe bucket, ~all of it the
 *             boat's own motion. To read this mode as a water number, point it
 *             at empty sea (`--shot horizon`) or stop the boats first; otherwise
 *             treat the figure as an upper bound, not a defect count.
 *   motion  - normal gameplay. Isolates popping, swimming and LOD transitions.
 *
 * The headline metric is STROBE, not mean difference. A pixel that brightens
 * then darkens then brightens again is flickering; a pixel that moves steadily
 * in one direction is just animation. Counting sign reversals separates the two,
 * which mean-absolute-difference completely fails to do.
 *
 * Usage:
 *   node tools/sequence.mjs --shot chase --mode static --frames 24
 *   node tools/sequence.mjs --mode frozen            # the assertion
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {
    shot: 'chase', mode: 'static', frames: 24, time: 42,
    width: 1280, height: 720, dpr: 1, port: 5240, seed: 1337,
    out: null, strobeThreshold: 10, failOnFrozen: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i];
    if (a === '--shot') out.shot = next();
    else if (a === '--mode') out.mode = next();
    else if (a === '--frames') out.frames = Number(next());
    else if (a === '--time') out.time = Number(next());
    else if (a === '--width') out.width = Number(next());
    else if (a === '--height') out.height = Number(next());
    else if (a === '--dpr') out.dpr = Number(next());
    else if (a === '--port') out.port = Number(next());
    else if (a === '--out') out.out = next();
    else if (a === '--threshold') out.strobeThreshold = Number(next());
    else if (a === '--no-fail') out.failOnFrozen = false;
  }
  out.out ??= `shots/seq-${out.mode}-${out.shot}`;
  return out;
}
const ARGS = parseArgs(process.argv);

const CHROME = process.env.WAVEBREAK_CHROME ??
  (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
    ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function startServer(port) {
  const url = `http://127.0.0.1:${port}/`;
  if (await waitForServer(url, 800)) return { url, stop: async () => {} };
  const proc = spawn(process.execPath,
    [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!(await waitForServer(url, 60_000))) { proc.kill('SIGKILL'); throw new Error('vite failed'); }
  return { url, stop: async () => proc.kill('SIGTERM') };
}

/**
 * Runs inside the page: decode the captured frames and measure churn.
 * Done in-browser so we get canvas 2D without an image library, matching the
 * zero-dependency constraint the game itself works under.
 */
const ANALYSE = ({ frames, threshold, cols }) => (async () => {
  const imgs = [];
  for (const d of frames) {
    const el = new Image(); el.src = d; await el.decode(); imgs.push(el);
  }
  const w = imgs[0].naturalWidth, h = imgs[0].naturalHeight;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  const lum = [];
  for (const el of imgs) {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(el, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    const L = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      L[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    }
    lum.push(L);
  }

  const n = lum.length, px = w * h;
  // Per-pair mean absolute difference: how much the image is changing at all.
  const mad = [];
  for (let f = 1; f < n; f++) {
    let s = 0;
    for (let p = 0; p < px; p++) s += Math.abs(lum[f][p] - lum[f - 1][p]);
    mad.push(s / px);
  }

  // STROBE: a pixel that goes up then down then up (or the reverse) by more
  // than `threshold` is flickering. Steady motion produces same-sign deltas and
  // is correctly ignored. This is the metric that actually finds shimmer.
  const strobeMap = new Uint16Array(px);
  let strobePixels = 0, maxRun = 0;
  for (let p = 0; p < px; p++) {
    let reversals = 0;
    for (let f = 2; f < n; f++) {
      const d1 = lum[f - 1][p] - lum[f - 2][p];
      const d2 = lum[f][p] - lum[f - 1][p];
      if (Math.abs(d1) > threshold && Math.abs(d2) > threshold && Math.sign(d1) !== Math.sign(d2)) reversals++;
    }
    strobeMap[p] = reversals;
    if (reversals > 0) strobePixels++;
    if (reversals > maxRun) maxRun = reversals;
  }

  // Region breakdown: thirds vertically, so "sky / mid-distance / near water"
  // can be reported separately - a strobe number for the whole frame hides
  // which part of the picture is misbehaving.
  const regions = { top: 0, middle: 0, bottom: 0 };
  for (let y = 0; y < h; y++) {
    const band = y < h / 3 ? 'top' : y < (2 * h) / 3 ? 'middle' : 'bottom';
    for (let x = 0; x < w; x++) if (strobeMap[y * w + x] > 0) regions[band]++;
  }
  const third = px / 3;

  // Heatmap: where the flicker lives.
  const hm = document.createElement('canvas'); hm.width = w; hm.height = h;
  const hctx = hm.getContext('2d');
  const out = hctx.createImageData(w, h);
  const denom = Math.max(1, maxRun);
  for (let p = 0; p < px; p++) {
    const v = strobeMap[p] / denom;
    const i = p * 4;
    // Base frame at low brightness so the heatmap is readable in context.
    const base = lum[0][p] * 0.25;
    out.data[i] = base + v * 255;
    out.data[i + 1] = base + v * 60;
    out.data[i + 2] = base;
    out.data[i + 3] = 255;
  }
  hctx.putImageData(out, 0, 0);

  // Contact strip so a human/critic can see the motion rather than a pose.
  const rows = Math.ceil(imgs.length / cols);
  const tw = Math.round(w / 2), th = Math.round(h / 2);
  const strip = document.createElement('canvas');
  strip.width = tw * cols; strip.height = th * rows;
  const sctx = strip.getContext('2d');
  sctx.fillStyle = '#101a35'; sctx.fillRect(0, 0, strip.width, strip.height);
  imgs.forEach((el, i) => {
    sctx.drawImage(el, (i % cols) * tw, Math.floor(i / cols) * th, tw, th);
  });

  return {
    width: w, height: h, frames: n,
    meanAbsDiff: mad,
    strobePixels, strobeFraction: strobePixels / px, maxReversals: maxRun,
    regionStrobeFraction: {
      top: regions.top / third, middle: regions.middle / third, bottom: regions.bottom / third,
    },
    heatmap: hm.toDataURL('image/png').split(',')[1],
    strip: strip.toDataURL('image/png').split(',')[1],
  };
})();

async function main() {
  const outDir = path.resolve(ROOT, ARGS.out);
  if (existsSync(outDir)) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const server = await startServer(ARGS.port);
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--mute-audio'],
  });
  const context = await browser.newContext({
    viewport: { width: ARGS.width, height: ARGS.height }, deviceScaleFactor: ARGS.dpr,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(`${server.url}?harness=1&seed=${ARGS.seed}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__wavebreak?.ready, null, { timeout: 90_000 });

  await page.evaluate(() => window.__wavebreak.autopilot(true));
  await page.evaluate((t) => window.__wavebreak.advanceTo(t), ARGS.time);
  await page.evaluate((s) => window.__wavebreak.setShot(s), ARGS.shot);
  await page.evaluate(() => window.__wavebreak.renderFrames(3));
  // Pin the camera for both assertion modes. The chase rig advances a spring
  // every time it is applied, so re-applying a shot per frame would make the
  // camera itself the thing that changed - measuring the harness, not the game.
  if (ARGS.mode !== 'motion') await page.evaluate(() => window.__wavebreak.freezeCamera(true));

  console.log(`> ${ARGS.mode}: capturing ${ARGS.frames} frames from "${ARGS.shot}"`);
  const canvas = page.locator('#app canvas');
  const frames = [];
  for (let i = 0; i < ARGS.frames; i++) {
    if (ARGS.mode === 'frozen') {
      await page.evaluate(() => window.__wavebreak.redraw(1));
    } else {
      await page.evaluate(() => window.__wavebreak.renderFrames(1));
    }
    const buf = await canvas.screenshot({ scale: 'device' });
    frames.push('data:image/png;base64,' + buf.toString('base64'));
    process.stdout.write(`\r  frame ${i + 1}/${ARGS.frames}`);
  }
  process.stdout.write('\n');

  const r = await page.evaluate(ANALYSE, { frames, threshold: ARGS.strobeThreshold, cols: 6 });
  await writeFile(path.join(outDir, 'heatmap.png'), Buffer.from(r.heatmap, 'base64'));
  await writeFile(path.join(outDir, 'strip.png'), Buffer.from(r.strip, 'base64'));
  delete r.heatmap; delete r.strip;
  r.mode = ARGS.mode; r.shot = ARGS.shot; r.pageErrors = pageErrors;
  await writeFile(path.join(outDir, 'churn.json'), JSON.stringify(r, null, 2));

  const pct = (v) => (v * 100).toFixed(3) + '%';
  console.log(`  strobe pixels      ${r.strobePixels} (${pct(r.strobeFraction)})`);
  console.log(`  max reversals/px   ${r.maxReversals} of ${ARGS.frames - 2} possible`);
  console.log(`  by region          top ${pct(r.regionStrobeFraction.top)}  ` +
              `middle ${pct(r.regionStrobeFraction.middle)}  bottom ${pct(r.regionStrobeFraction.bottom)}`);
  const madAvg = r.meanAbsDiff.reduce((a, b) => a + b, 0) / Math.max(1, r.meanAbsDiff.length);
  console.log(`  mean abs diff      ${madAvg.toFixed(3)} / 255`);
  console.log(`  -> ${path.relative(ROOT, outDir)}`);

  await browser.close();
  await server.stop();

  if (pageErrors.length) { console.error('!! page errors:', pageErrors.slice(0, 5)); process.exit(2); }

  if (ARGS.mode === 'frozen' && ARGS.failOnFrozen) {
    // Nothing advanced, so nothing may differ. A handful of pixels can flip
    // from float rounding in the composite; anything beyond that is a bug.
    if (r.strobeFraction > 0.0005 || madAvg > 0.05) {
      console.error(`\n!! FROZEN-SCENE ASSERTION FAILED`);
      console.error(`   With dt = 0 and a fixed camera the image must not change.`);
      console.error(`   strobe ${pct(r.strobeFraction)}, meanAbsDiff ${madAvg.toFixed(4)}`);
      console.error(`   Look at ${path.relative(ROOT, outDir)}/heatmap.png for where.`);
      process.exit(3);
    }
    console.log('  frozen-scene assertion PASSED');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
