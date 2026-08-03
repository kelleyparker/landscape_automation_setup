#!/usr/bin/env node
/** THROWAWAY probe 3: settle corner handedness via the tangent heading derivative. Delete after use. */
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
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&seed=1337`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__wavebreak?.ready === true, { timeout: 60000 });

const out = await page.evaluate(() => {
  const g = window.__wavebreak.game;
  const course = g.course;
  const L = course.totalLength;
  const V = Object.getPrototypeOf(g.player.state.position).constructor;
  const wrap = (t) => { const f = t - Math.floor(t); return f < 0 ? f + 1 : f; };
  const a = new V(), b = new V();

  // World convention (BoatPhysics): forward(h) = (sin h, cos h); heading 0 = +Z;
  // increasing h rotates forward toward +X = starboard. So dh > 0 == turning right.
  const headAt = (t) => { course.tangentAt(wrap(t), a); return Math.atan2(a.x, a.z); };
  const dh = (t, e) => {
    let d = headAt(t + e / L) - headAt(t - e / L);
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  };
  const crossAt = (t, e) => {
    course.tangentAt(wrap(t - e / L), a);
    course.tangentAt(wrap(t + e / L), b);
    return a.x * b.z - a.z * b.x;
  };

  const rows = [];
  const N = 400;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const k = course.curvatureAt(t);
    if (k < 1 / 240) continue;
    const turn = dh(t, 6);
    rows.push({ t: +t.toFixed(4), k: +k.toFixed(5), dh6: +turn.toFixed(5),
      turnSign: Math.sign(turn), crossSign: Math.sign(crossAt(t, 6)),
      hudSide: crossAt(t, 6) > 0 ? 1 : -1, fixedSide: crossAt(t, 6) < 0 ? 1 : -1 });
  }
  const pct = (f) => +((rows.filter(f).length / rows.length) * 100).toFixed(1);
  // Which corners exist, as contiguous runs, with their net turn in degrees.
  const runs = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || r.t - cur.tEnd > 0.01) { cur = { tStart: r.t, tEnd: r.t, net: 0, maxK: 0 }; runs.push(cur); }
    cur.tEnd = r.t; cur.net += r.dh6; cur.maxK = Math.max(cur.maxK, r.k);
  }
  return {
    samples: rows.length,
    'CURRENT hudSide == turnSign (%)': pct((r) => r.hudSide === r.turnSign),
    'FIXED  fixedSide == turnSign (%)': pct((r) => r.fixedSide === r.turnSign),
    corners: runs.map((r) => ({
      tStart: +r.tStart.toFixed(3), tEnd: +r.tEnd.toFixed(3),
      netTurnDeg: +(r.net * 180 / Math.PI).toFixed(1),
      radius_m: +(1 / r.maxK).toFixed(0),
      handedness: r.net > 0 ? 'RIGHT' : 'LEFT',
    })),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
