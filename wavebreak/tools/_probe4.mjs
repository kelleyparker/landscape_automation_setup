#!/usr/bin/env node
/** THROWAWAY probe 4: live hud.cornerSide vs ground truth, on RENDERED frames. Delete after use. */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const PORT = Number(process.argv[2] || 5323);
const explicitChrome = process.env.WAVEBREAK_CHROME ??
  (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
    ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({
  ...(explicitChrome ? { executablePath: explicitChrome } : {}),
  args: ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&seed=1337`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__wavebreak?.ready === true, { timeout: 60000 });

const out = await page.evaluate(() => {
  const h = window.__wavebreak;
  const g = h.game;
  g.setAutopilot(true);
  g.engine.setDeterministic(true);
  const course = g.course, L = course.totalLength, hud = g.hud;
  const V = Object.getPrototypeOf(g.player.state.position).constructor;
  const a = new V();
  const wrap = (t) => { const f = t - Math.floor(t); return f < 0 ? f + 1 : f; };
  const headAt = (t) => { course.tangentAt(wrap(t), a); return Math.atan2(a.x, a.z); };

  h.phase('racing');
  let agree = 0, total = 0, blendedOut = 0;
  const bad = [];
  // Rendered frames, so Hud.render -> advance -> scanCorner actually runs.
  for (let i = 0; i < 4200; i++) {
    g.engine.step(1 / 60);
    if (i % 15 !== 0) continue;
    if (hud.cornerBlend < 0.9) { blendedOut++; continue; }
    // The HUD's own reported entry distance locates the corner it is describing;
    // ground truth is the heading derivative at that corner's peak.
    const tEntry = wrap(g.player.progress.splineT + hud.cornerDist / L);
    // walk to the peak the same way the HUD does
    let peakK = 0, tPeak = tEntry;
    for (let s = 0; s <= 18; s++) {
      const t = wrap(tEntry + (s * 5) / L);
      const k = course.curvatureAt(t);
      if (k < (1 / 240) * 0.75 && s > 0) break;
      if (k > peakK) { peakK = k; tPeak = t; }
    }
    let d = headAt(tPeak + 6 / L) - headAt(tPeak - 6 / L);
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const truth = Math.sign(d); // +1 = heading rising = turns starboard = RIGHT
    total++;
    if (hud.cornerSide === truth) agree++;
    else if (bad.length < 6) bad.push({ t: +g.player.progress.splineT.toFixed(3), hud: hud.cornerSide, truth, dist: Math.round(hud.cornerDist) });
  }
  return { samples: total, agree, pct: total ? +((agree / total) * 100).toFixed(1) : null, blendedOut, bad };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
