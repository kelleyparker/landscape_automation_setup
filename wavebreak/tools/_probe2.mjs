#!/usr/bin/env node
/** THROWAWAY probe 2: is the corner-handedness cross product stable? Delete after use. */
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
  const a = new V(), b = new V(), p0 = new V(), p1 = new V(), tg = new V();

  // signed turn of the tangent across +/- e metres, via cross product
  const crossAt = (t, e) => {
    course.tangentAt(wrap(t - e / L), a);
    course.tangentAt(wrap(t + e / L), b);
    return a.x * b.z - a.z * b.x;
  };
  // robust truth: lateral offset of a point D metres ahead, in the peak's frame.
  // starboard of forward (tx,tz) is (tz,-tx); positive => course bends to starboard.
  const truthAt = (t, D) => {
    course.curve.getPoint(wrap(t), p0);
    course.tangentAt(wrap(t), tg);
    course.curve.getPoint(wrap(t + D / L), p1);
    return (p1.x - p0.x) * tg.z - (p1.z - p0.z) * tg.x;
  };

  const rows = [];
  const N = 240;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const k = course.curvatureAt(t);
    if (k < 1 / 240) continue; // only where the HUD would call a corner
    rows.push({
      t: +t.toFixed(4), k: +k.toFixed(5),
      c6: Math.sign(crossAt(t, 6)),
      c15: Math.sign(crossAt(t, 15)),
      c30: Math.sign(crossAt(t, 30)),
      c60: Math.sign(crossAt(t, 60)),
      d40: Math.sign(truthAt(t, 40)),
      d80: Math.sign(truthAt(t, 80)),
      d120: Math.sign(truthAt(t, 120)),
      raw6: +crossAt(t, 6).toFixed(6),
      raw30: +crossAt(t, 30).toFixed(6),
    });
  }
  const agree = (f, gf) => {
    let n = 0; for (const r of rows) if (r[f] === r[gf]) n++;
    return +((n / rows.length) * 100).toFixed(1);
  };
  return {
    samples: rows.length,
    'c6 vs d80': agree('c6', 'd80'),
    'c15 vs d80': agree('c15', 'd80'),
    'c30 vs d80': agree('c30', 'd80'),
    'c60 vs d80': agree('c60', 'd80'),
    'd40 vs d80': agree('d40', 'd80'),
    'd120 vs d80': agree('d120', 'd80'),
    'NEGATED c6 vs d80': +((rows.filter(r => -r.c6 === r.d80).length / rows.length) * 100).toFixed(1),
    'NEGATED c30 vs d80': +((rows.filter(r => -r.c30 === r.d80).length / rows.length) * 100).toFixed(1),
    rows: rows.slice(0, 24),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
