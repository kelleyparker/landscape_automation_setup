#!/usr/bin/env node
/**
 * WAVEBREAK screenshot harness.
 *
 * Boots the Vite dev server (or reuses one), loads the game headlessly in
 * Chromium with real GPU-ish rasterisation (SwiftShader in CI), drives the game
 * to a requested moment via the deterministic test hooks on `window.__wavebreak`,
 * and captures retina-resolution frames from named camera rigs.
 *
 * Every visual claim in this project is verified against a frame produced here.
 *
 * Usage:
 *   node tools/shoot.mjs                                  # default shot list
 *   node tools/shoot.mjs --shots chase,bow,orbit          # pick shots
 *   node tools/shoot.mjs --time 12 --out shots/pass3      # sim seconds + outdir
 *   node tools/shoot.mjs --list                           # print available shots
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- args ------
function parseArgs(argv) {
  const out = {
    shots: null,
    time: 8,
    out: 'shots/latest',
    width: 1280,
    height: 720,
    dpr: 2,
    port: 5178,
    keep: false,
    list: false,
    seed: 1337,
    quiet: false,
    settle: 0,
    noDrive: false,
    noHud: false,
    phase: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--shots') out.shots = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--time') out.time = Number(next());
    else if (a === '--out') out.out = next();
    else if (a === '--width') out.width = Number(next());
    else if (a === '--height') out.height = Number(next());
    else if (a === '--dpr') out.dpr = Number(next());
    else if (a === '--port') out.port = Number(next());
    else if (a === '--seed') out.seed = Number(next());
    else if (a === '--settle') out.settle = Number(next());
    else if (a === '--no-drive') out.noDrive = true;
    else if (a === '--no-hud') out.noHud = true;
    else if (a === '--phase') out.phase = next();
    else if (a === '--keep') out.keep = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--list') out.list = true;
  }
  return out;
}
const ARGS = parseArgs(process.argv);
const log = (...a) => { if (!ARGS.quiet) console.log(...a); };

// ------------------------------------------------------------ dev server ----
async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function startServer(port) {
  const url = `http://127.0.0.1:${port}/`;
  if (await waitForServer(url, 800)) {
    log(`> reusing dev server on ${port}`);
    return { url, stop: async () => {} };
  }
  log(`> starting vite on ${port}`);
  const proc = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let serverLog = '';
  proc.stdout.on('data', (d) => { serverLog += d; });
  proc.stderr.on('data', (d) => { serverLog += d; });
  const ok = await waitForServer(url, 60_000);
  if (!ok) {
    proc.kill('SIGKILL');
    throw new Error(`vite failed to start on ${port}\n${serverLog}`);
  }
  return {
    url,
    stop: async () => { proc.kill('SIGTERM'); },
  };
}

// ----------------------------------------------------------------- main -----
async function main() {
  const outDir = path.resolve(ROOT, ARGS.out);
  if (existsSync(outDir)) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const server = await startServer(ARGS.port);

  // Prefer an explicitly provided Chromium (containers ship one that may not
  // match Playwright's pinned revision); otherwise fall back to Playwright's own.
  const explicitChrome =
    process.env.WAVEBREAK_CHROME ??
    (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
      ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
      : undefined);

  const browser = await chromium.launch({
    ...(explicitChrome ? { executablePath: explicitChrome } : {}),
    args: [
      '--headless=new',
      // Headless Chromium needs an explicit software GL stack in a container.
      // These flags are harness-only; the shipped game uses whatever the user's browser has.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: ARGS.width, height: ARGS.height },
    deviceScaleFactor: ARGS.dpr,
  });
  const page = await context.newPage();
  // SwiftShader composites slowly, and a screenshot has to wait for a real
  // frame. 30s is not enough on the heavier screens; this is harness-only.
  page.setDefaultTimeout(180_000);

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    const t = msg.type();
    const text = msg.text();
    if (t === 'error' || t === 'warning') {
      // Shader compile failures surface here - they must fail the harness loudly.
      consoleErrors.push(`[${t}] ${text}`);
    }
    if (!ARGS.quiet && t === 'log' && text.startsWith('[wb]')) log('  ' + text);
  });
  page.on('pageerror', (err) => pageErrors.push(String(err && err.stack ? err.stack : err)));

  const url = `${server.url}?harness=1&seed=${ARGS.seed}`;
  log(`> loading ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Wait for either the real game hook or the smoke hook.
  await page.waitForFunction(
    () => (window.__wavebreak && window.__wavebreak.ready) || (window.__smoke && window.__smoke.ready),
    null,
    { timeout: 90_000 }
  ).catch(() => {});

  const info = await page.evaluate(() => ({
    smoke: window.__smoke ?? null,
    game: window.__wavebreak
      ? { ready: !!window.__wavebreak.ready, shots: window.__wavebreak.listShots?.() ?? [] }
      : null,
  }));

  if (info.smoke) log(`> smoke ok  gl=${info.smoke.renderer}  three=r${info.smoke.version}`);

  if (ARGS.list) {
    console.log(JSON.stringify(info.game?.shots ?? [], null, 2));
    await browser.close(); await server.stop(); return;
  }

  const report = { url, args: ARGS, frames: [], consoleErrors, pageErrors, stats: null, info };

  if (info.game) {
    // Deterministic mode: the game exposes a fixed-step advance so a given
    // (seed, time) always produces the identical frame.
    const shots = ARGS.shots ?? (info.game.shots.length ? info.game.shots : ['chase']);
    // Frames of a parked boat prove nothing about wake, spray, drift or landings,
    // so the harness races the player unless explicitly told not to.
    if (!ARGS.noDrive) await page.evaluate(() => window.__wavebreak.autopilot(true));
    // Clean frames for press art: no cropped HUD panels at the capsule edges.
    if (ARGS.noHud) await page.evaluate(() => window.__wavebreak.setHud(false));
    log(`> advancing sim to t=${ARGS.time}s`);
    await page.evaluate((t) => window.__wavebreak.advanceTo(t), ARGS.time);

    // Force a race phase after advancing, so the countdown and results screens
    // - which a normal capture at t=42 would never show - can be reviewed too.
    if (ARGS.phase) {
      await page.evaluate((p) => window.__wavebreak.phase(p), ARGS.phase);
      await page.evaluate(() => window.__wavebreak.renderFrames(10));
    }

    for (const shot of shots) {
      const ok = await page.evaluate((s) => window.__wavebreak.setShot(s), shot);
      if (!ok) { log(`  ! unknown shot "${shot}" - skipped`); continue; }
      // Render a few frames so temporal effects (foam, spray, TAA-ish) settle.
      await page.evaluate((n) => window.__wavebreak.renderFrames(n), 3 + ARGS.settle);
      const file = path.join(outDir, `${shot}.png`);
      await page.locator('#app canvas').screenshot({ path: file, scale: 'device' }).catch(async () => {
        await page.screenshot({ path: file, scale: 'device' });
      });
      log(`  captured ${path.relative(ROOT, file)}`);
      report.frames.push({ shot, file: path.relative(ROOT, file) });
    }

    report.stats = await page.evaluate(() => window.__wavebreak.stats());
    // A real 60fps measurement needs the live loop, not the deterministic stepper.
    if (!ARGS.quiet) log(`> stats ${JSON.stringify(report.stats)}`);
  } else {
    const file = path.join(outDir, 'smoke.png');
    await page.screenshot({ path: file, scale: 'device' });
    report.frames.push({ shot: 'smoke', file: path.relative(ROOT, file) });
    log(`  captured ${path.relative(ROOT, file)}`);
  }

  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  if (pageErrors.length) {
    console.error('\n!! PAGE ERRORS');
    for (const e of pageErrors) console.error(e);
  }
  if (consoleErrors.length) {
    console.error('\n!! CONSOLE');
    for (const e of consoleErrors.slice(0, 40)) console.error(e);
  }

  await browser.close();
  if (!ARGS.keep) await server.stop();

  if (pageErrors.length || consoleErrors.some((e) => e.startsWith('[error]'))) process.exit(2);
}

main().catch(async (err) => { console.error(err); process.exit(1); });
