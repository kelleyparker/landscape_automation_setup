#!/usr/bin/env node
/**
 * WAVEBREAK audio harness.
 *
 * The screenshot harness (`tools/shoot.mjs`) exists because a visual claim you
 * cannot see is worthless. This is the same argument for the half of the game
 * that has no pixels: until this file existed, every statement about WAVEBREAK's
 * audio was a statement about *source code*, not about sound.
 *
 * How it works, and why this way:
 *
 * The game's own `Audio` instance is handed an **`OfflineAudioContext`** through
 * `Audio.unlock(ctx)`, and then driven with `OfflineAudioContext.suspend()` -
 * one suspend per simulated frame. At each suspend point the probe writes a
 * scripted `BoatState` / `RaceStatus` into the *real* `Audio.update()` and
 * resumes. The result is bit-exact, reproducible PCM of exactly the code the
 * game ships, rendered far faster than realtime.
 *
 * A realtime capture (MediaRecorder, AudioWorklet) was the obvious approach and
 * is the wrong one here: this container has no sound card, a headless realtime
 * `AudioContext` free-runs against a null sink, and any main-thread hitch shows
 * up in the recording as a dropout that a "not silent" assertion would report as
 * a failure of the audio rather than of the harness. Offline rendering has no
 * clock to miss.
 *
 * Outputs:
 *   press/audio-sample.wav   scripted sequence, for a human to listen to
 *   press/audio-live.wav     the real race, audio taken off Game -> Audio
 *   press/audio-report.json  every number this file measured
 *
 * Exit codes:  0 pass   1 crash   2 console/page error   3 assertion failure
 *
 * Usage:
 *   node tools/audio-probe.mjs
 *   node tools/audio-probe.mjs --port 5315 --no-assert
 *   node tools/audio-probe.mjs --no-live
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- args ------
function parseArgs(argv) {
  const out = {
    port: 5191,
    out: 'press',
    seed: 1337,
    sampleRate: 48000,
    live: true,
    liveSeconds: 18,
    liveStart: 38,
    assert: true,
    keep: false,
    quiet: false,
    /**
     * Settings VOLUME to render at. 1 is the strict setting for the clipping
     * assertion; `--volume 0` is the standing negative test that the silence
     * gate can actually fire, which is the only way to know a green run means
     * anything.
     */
    volume: 1,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') out.port = Number(next());
    else if (a === '--out') out.out = next();
    else if (a === '--seed') out.seed = Number(next());
    else if (a === '--rate') out.sampleRate = Number(next());
    else if (a === '--live-seconds') out.liveSeconds = Number(next());
    else if (a === '--live-start') out.liveStart = Number(next());
    else if (a === '--volume') out.volume = Number(next());
    else if (a === '--no-live') out.live = false;
    else if (a === '--no-assert') out.assert = false;
    else if (a === '--keep') out.keep = true;
    else if (a === '--quiet') out.quiet = true;
  }
  return out;
}
const ARGS = parseArgs(process.argv);
const log = (...a) => { if (!ARGS.quiet) console.log(...a); };

/**
 * Frame length in samples. `OfflineAudioContext.suspend()` can only stop on a
 * render-quantum boundary, so this must be a multiple of 128. 768 @ 48 kHz is
 * 16 ms - 62.5 Hz, near enough to the game's 60 Hz that every rate-dependent
 * smoother in `Audio.update` behaves as it does in play.
 */
const BLOCK = 768;

// --------------------------------------------------------- scripted take ----

const IDLE_RPM = 0.087; // the floor BoatPhysics actually publishes

/** One entry per step. `win` is the fraction of the step that gets analysed. */
function buildScript() {
  const steps = [];
  const push = (s) => steps.push({
    countdown: 0, ramp: null, once: null, win: [0.0, 1.0], note: '', ...s,
  });

  push({ name: 'intro', dur: 0.9, phase: 'intro', s: { rpm: IDLE_RPM }, win: [0.4, 1.0],
    note: 'ducked world bed at idle' });
  push({ name: 'horn-3', dur: 1.0, phase: 'countdown', countdown: 2.6, s: { rpm: IDLE_RPM }, win: [0.0, 0.45] });
  push({ name: 'horn-2', dur: 1.0, phase: 'countdown', countdown: 1.6, s: { rpm: IDLE_RPM }, win: [0.0, 0.45] });
  push({ name: 'horn-1', dur: 1.0, phase: 'countdown', countdown: 0.6, s: { rpm: IDLE_RPM }, win: [0.0, 0.45] });
  push({ name: 'go', dur: 1.4, phase: 'racing', s: { rpm: IDLE_RPM }, win: [0.0, 0.7],
    note: 'green light horn' });

  // Engine isolated: speed01 = 0 so the water bed contributes almost nothing and
  // the spectrum being measured really is the motor.
  //
  // The sweep starts at IDLE_RPM, not at 0. `BoatPhysics` floors rpm at ~0.087
  // and never publishes anything below it, so rpm = 0 is a state the game
  // cannot be in; at that value the engine is quiet enough that the residual
  // water bed owns the spectrum and the measurement stops being about the
  // motor at all. Testing an unreachable configuration is not a stricter test,
  // it is a different one.
  for (let i = 0; i <= 10; i++) {
    const rpm = IDLE_RPM + (1 - IDLE_RPM) * (i / 10);
    push({
      name: `rpm-${String(i).padStart(2, '0')}`, dur: 1.0, phase: 'racing',
      s: { rpm, speed01: 0 }, win: [0.65, 1.0], rpm,
      note: `engine only, rpm ${rpm.toFixed(3)}`,
    });
  }
  // Engine held constant: anything that moves here is the water.
  for (let i = 0; i <= 4; i++) {
    push({
      name: `spd-${i}`, dur: 0.8, phase: 'racing',
      s: { rpm: 0.5, speed01: i / 4 }, win: [0.6, 1.0],
      note: `water only, speed01 ${(i / 4).toFixed(2)}`,
    });
  }

  push({ name: 'ground-ref', dur: 1.0, phase: 'racing', s: { rpm: 0.5, speed01: 0.6 }, win: [0.55, 1.0],
    note: 'baseline for the airborne comparison' });
  push({ name: 'air', dur: 1.2, phase: 'racing', s: { rpm: 0.5, speed01: 0.6, airborne: true }, win: [0.55, 1.0],
    note: 'same rpm and speed, out of the water' });
  push({ name: 'land', dur: 1.2, phase: 'racing', s: { rpm: 0.5, speed01: 0.6 },
    once: { landingImpact: 0.9 }, win: [0.0, 0.45] });
  push({ name: 'drift', dur: 1.9, phase: 'racing',
    s: { rpm: 0.62, speed01: 0.7, drifting: true, slip: 7 },
    ramp: { driftCharge: [0, 1] }, win: [0.4, 1.0],
    note: 'charge ramps through all three tiers; measured after the 6/s smoother arrives' });
  push({ name: 'boost', dur: 1.6, phase: 'racing', s: { rpm: 0.92, speed01: 0.95, boosting: true }, win: [0.0, 1.0] });
  push({ name: 'hit', dur: 1.0, phase: 'racing', s: { rpm: 0.7, speed01: 0.7 },
    once: { hitImpact: 0.7 }, win: [0.0, 0.45] });
  push({ name: 'tail', dur: 1.8, phase: 'racing', s: { rpm: IDLE_RPM, speed01: 0.02 }, win: [0.5, 1.0],
    note: 'back to idle; voice count must return to zero' });

  return steps;
}

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
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let serverLog = '';
  proc.stdout.on('data', (d) => { serverLog += d; });
  proc.stderr.on('data', (d) => { serverLog += d; });
  const ok = await waitForServer(url, 60_000);
  if (!ok) {
    proc.kill('SIGKILL');
    throw new Error(`vite failed to start on ${port}\n${serverLog}`);
  }
  return { url, stop: async () => { proc.kill('SIGTERM'); } };
}

// ------------------------------------------------------------- in-page ------

/**
 * Runs inside the page. Renders the scripted take offline and returns the raw
 * PCM base64-encoded plus the sample index of every step boundary.
 *
 * Kept as one self-contained function because Playwright serialises it across
 * the CDP boundary - it cannot close over anything in this module.
 */
async function renderScripted({ steps, sampleRate, block, volume }) {
  const audio = window.__wavebreak.game.audio;

  const frames = [];
  const marks = [];
  for (const st of steps) {
    const n = Math.max(1, Math.round((st.dur * sampleRate) / block));
    marks.push({ name: st.name, note: st.note, win: st.win, from: frames.length, count: n });
    for (let i = 0; i < n; i++) {
      const u = n > 1 ? i / (n - 1) : 0;
      const s = {
        rpm: 0, speed01: 0, slip: 0, drifting: false, driftCharge: 0,
        boostMeter: 1, boosting: false, airborne: false, airTime: 0,
        landingImpact: 0, hitImpact: 0,
        ...st.s,
      };
      if (st.ramp) for (const k of Object.keys(st.ramp)) s[k] = st.ramp[k][0] + (st.ramp[k][1] - st.ramp[k][0]) * u;
      if (st.once && i === 0) Object.assign(s, st.once);
      frames.push({ s, status: { phase: st.phase, countdown: st.countdown, raceTime: 0, totalLaps: 3 } });
    }
  }

  const total = frames.length * block;
  const ctx = new OfflineAudioContext(1, total, sampleRate);
  audio.setMasterVolume(volume);
  audio.setMuted(false);
  audio.unlock(ctx);
  if (!audio.probeTap()) throw new Error('audio.unlock(offline) did not build a graph');

  const dt = block / sampleRate;
  const voiceLog = [];
  const apply = (i) => {
    const f = frames[i];
    audio.update(dt, f.s, f.status);
  };

  for (let i = 1; i < frames.length; i++) {
    const t = (i * block) / sampleRate;
    ctx.suspend(t).then(() => {
      apply(i);
      if (i % 32 === 0) voiceLog.push([i, audio.probeTap().voices]);
      ctx.resume();
    });
  }
  apply(0);

  const buf = await ctx.startRendering();
  return {
    pcm: encodePcm(buf.getChannelData(0)),
    sampleRate: buf.sampleRate,
    block,
    marks,
    voiceLog,
    voicesAtEnd: audio.probeTap().voices,
  };

  function encodePcm(f32) {
    const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    }
    return btoa(s);
  }
}

/**
 * Renders the audio of an actual race. Same offline trick, but instead of a
 * scripted state the probe steps the real simulation once per audio frame -
 * `engine.simulateOnly()` runs the same updater list the live game runs, and
 * that list ends with `this.audio.update(...)`. So this proves the whole
 * Game -> BoatPhysics -> Audio path, not just the audio module in isolation.
 */
async function renderLive({ sampleRate, block, seconds, startAt, volume }) {
  const hooks = window.__wavebreak;
  const audio = hooks.game.audio;
  hooks.autopilot(true);
  hooks.advanceTo(startAt); // warm up the race *before* any audio context exists

  const nFrames = Math.round((seconds * sampleRate) / block);
  const ctx = new OfflineAudioContext(1, nFrames * block, sampleRate);
  audio.setMasterVolume(volume);
  audio.setMuted(false);
  audio.unlock(ctx);

  const dt = block / sampleRate;
  const events = { landings: 0, hits: 0, boosts: 0, chimes: 0 };
  let prevBoost = false;
  let prevCharge = 0;
  let maxRpm = 0;
  let maxSpeed01 = 0;
  const tick = () => {
    hooks.game.engine.simulateOnly(dt);
    const s = hooks.game.player.state;
    if (s.landingImpact > 0.02) events.landings++;
    if (s.hitImpact > 0.02) events.hits++;
    if (s.boosting && !prevBoost) events.boosts++;
    for (const th of [0.33, 0.66, 1.0]) if (prevCharge < th && s.driftCharge >= th) events.chimes++;
    prevBoost = s.boosting;
    prevCharge = s.driftCharge;
    if (s.rpm > maxRpm) maxRpm = s.rpm;
    if (s.speed01 > maxSpeed01) maxSpeed01 = s.speed01;
  };

  for (let i = 1; i < nFrames; i++) {
    ctx.suspend((i * block) / sampleRate).then(() => { tick(); ctx.resume(); });
  }
  tick();

  const buf = await ctx.startRendering();
  return {
    pcm: (() => {
      const f32 = buf.getChannelData(0);
      const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
      let s = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
      }
      return btoa(s);
    })(),
    sampleRate: buf.sampleRate,
    events, maxRpm, maxSpeed01,
    phase: hooks.game.status.phase,
  };
}

// ------------------------------------------------------------- analysis -----

/** In-place iterative radix-2 FFT. No dependencies; the project ships none. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + half], bi = im[i + k + half];
        const vr = br * cr - bi * ci;
        const vi = br * ci + bi * cr;
        re[i + k] = ar + vr; im[i + k] = ai + vi;
        re[i + k + half] = ar - vr; im[i + k + half] = ai - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const db = (x) => (x > 1e-12 ? 20 * Math.log10(x) : -Infinity);
const r3 = (x) => (Number.isFinite(x) ? Number(x.toFixed(3)) : (x === -Infinity ? -999 : null));

/** Averaged Hann-windowed magnitude spectrum over a slice. */
function spectrum(pcm, from, to, sampleRate) {
  let N = 8192;
  while (N > 512 && to - from < N) N >>= 1;
  const hop = N >> 1;
  const mag = new Float64Array(N / 2);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  let frames = 0;
  for (let start = from; start + N <= to; start += hop) {
    for (let i = 0; i < N; i++) { re[i] = pcm[start + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) mag[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  if (!frames) return null;
  for (let k = 0; k < N / 2; k++) mag[k] /= frames;
  return { mag, binHz: sampleRate / N, N, frames };
}

function centroid(sp, loHz = 25, hiHz = 16000) {
  let num = 0, den = 0;
  const lo = Math.max(1, Math.floor(loHz / sp.binHz));
  const hi = Math.min(sp.mag.length - 1, Math.ceil(hiHz / sp.binHz));
  for (let k = lo; k <= hi; k++) { num += k * sp.binHz * sp.mag[k]; den += sp.mag[k]; }
  return den > 0 ? num / den : 0;
}

function peakFreq(sp, loHz = 25, hiHz = 6000) {
  const lo = Math.max(1, Math.floor(loHz / sp.binHz));
  const hi = Math.min(sp.mag.length - 2, Math.ceil(hiHz / sp.binHz));
  let best = lo;
  for (let k = lo; k <= hi; k++) if (sp.mag[k] > sp.mag[best]) best = k;
  // Parabolic interpolation on log magnitude - the true peak of a windowed
  // sinusoid almost never lands exactly on a bin centre.
  const l = Math.log(sp.mag[best - 1] + 1e-20);
  const c = Math.log(sp.mag[best] + 1e-20);
  const r = Math.log(sp.mag[best + 1] + 1e-20);
  const d = (0.5 * (l - r)) / (l - 2 * c + r || 1e-20);
  return (best + Math.max(-1, Math.min(1, d))) * sp.binHz;
}

function bandRms(sp, loHz, hiHz) {
  let e = 0;
  const lo = Math.max(1, Math.floor(loHz / sp.binHz));
  const hi = Math.min(sp.mag.length - 1, Math.ceil(hiHz / sp.binHz));
  for (let k = lo; k <= hi; k++) e += sp.mag[k] * sp.mag[k];
  return Math.sqrt(e / Math.max(1, hi - lo + 1));
}

/** Magnitude at a specific frequency, taking the max over a +/- tolerance. */
function magAt(sp, hz, tol = 0.04) {
  const lo = Math.max(1, Math.floor((hz * (1 - tol)) / sp.binHz));
  const hi = Math.min(sp.mag.length - 1, Math.ceil((hz * (1 + tol)) / sp.binHz));
  let m = 0;
  for (let k = lo; k <= hi; k++) if (sp.mag[k] > m) m = sp.mag[k];
  return m;
}

/**
 * Loudest short window in a slice, optionally band-limited first.
 *
 * The averaged-spectrum band measures above are the right tool for a *steady*
 * sound and the wrong one for an impact: a 300 ms thud sweeping 130 Hz down to
 * 54 Hz spreads its energy over dozens of bins and across half the analysis
 * window, so it can be plainly the loudest thing in the file and still show a
 * *lower* per-bin band average than the continuous engine tone it sits on top
 * of. That is exactly what happened on the first run. What an impact actually
 * is, is a brief moment much louder than its neighbours - so that is what gets
 * measured: peak 20 ms RMS, after one-pole filtering to the band of interest.
 */
function transientPeak(pcm, from, to, sampleRate, band) {
  const win = Math.round(0.02 * sampleRate);
  if (to - from < win) return 0;
  const n = to - from;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm[from + i];
  if (band) {
    const [lo, hi] = band;
    if (hi && hi < sampleRate / 2) {
      const a = Math.exp((-2 * Math.PI * hi) / sampleRate);
      let y = 0;
      for (let i = 0; i < n; i++) { y = (1 - a) * x[i] + a * y; x[i] = y; }
    }
    if (lo && lo > 0) {
      const a = Math.exp((-2 * Math.PI * lo) / sampleRate);
      let y = 0;
      for (let i = 0; i < n; i++) { y = (1 - a) * x[i] + a * y; x[i] -= y; }
    }
  }
  // Running sum of squares over a sliding 20 ms window.
  let acc = 0;
  for (let i = 0; i < win; i++) acc += x[i] * x[i];
  let best = acc;
  for (let i = win; i < n; i++) {
    acc += x[i] * x[i] - x[i - win] * x[i - win];
    if (acc > best) best = acc;
  }
  return Math.sqrt(best / win);
}

function levels(pcm, from, to) {
  let sum = 0, peak = 0, clipped = 0;
  for (let i = from; i < to; i++) {
    const v = pcm[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.995) clipped++;
  }
  const n = Math.max(1, to - from);
  return { rms: Math.sqrt(sum / n), peak, clipped, samples: n };
}

const BANDS = {
  sub: [25, 120],
  low: [30, 250],
  body: [250, 800],
  mid: [800, 2500],
  rush: [800, 8000],
  drift: [900, 2200],
  hiss: [2800, 12000],
  bright: [1500, 6000],
};

function analyseStep(pcm, sampleRate, from, to) {
  const lv = levels(pcm, from, to);
  const sp = spectrum(pcm, from, to, sampleRate);
  const out = {
    rmsDb: r3(db(lv.rms)), peakDb: r3(db(lv.peak)), peak: r3(lv.peak),
    clipped: lv.clipped, seconds: r3(lv.samples / sampleRate),
  };
  if (sp) {
    out.centroidHz = r3(centroid(sp));
    out.peakHz = r3(peakFreq(sp));
    out.bands = {};
    for (const [k, [a, b]] of Object.entries(BANDS)) out.bands[k] = r3(db(bandRms(sp, a, b)));
  }
  out.transientDb = {
    full: r3(db(transientPeak(pcm, from, to, sampleRate, null))),
    low: r3(db(transientPeak(pcm, from, to, sampleRate, [0, 250]))),
    bright: r3(db(transientPeak(pcm, from, to, sampleRate, [1500, 6000]))),
  };
  return { metrics: out, sp };
}

// ---------------------------------------------------------------- wav -------

/** 16-bit mono PCM WAV. Everything here is written by hand; no encoder dep. */
function wav16(pcm, sampleRate) {
  const n = pcm.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

function decodePcm(b64) {
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  return new Float32Array(bytes.buffer, 0, bytes.byteLength >> 2);
}

// ------------------------------------------------------------ assertions ----

class Checks {
  constructor() { this.list = []; }
  add(group, name, pass, detail) {
    this.list.push({ group, name, pass: !!pass, detail });
    return !!pass;
  }
  get failed() { return this.list.filter((c) => !c.pass); }
}

function strictlyRising(vals) {
  for (let i = 1; i < vals.length; i++) if (!(vals[i] > vals[i - 1])) return i;
  return -1;
}

// ----------------------------------------------------------------- main -----
async function main() {
  const outDir = path.resolve(ROOT, ARGS.out);
  await mkdir(outDir, { recursive: true });

  const server = await startServer(ARGS.port);

  const explicitChrome =
    process.env.WAVEBREAK_CHROME ??
    (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
      ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
      : undefined);

  const browser = await chromium.launch({
    ...(explicitChrome ? { executablePath: explicitChrome } : {}),
    args: [
      '--headless=new',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--hide-scrollbars',
      // No --mute-audio: it is irrelevant to an offline render, and leaving it
      // off keeps this harness honest if it ever grows a realtime path.
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  // Small viewport: nothing here is screenshotted, and SwiftShader rasterising
  // a 1440p frame every tick would triple the live pass for no measurement.
  const context = await browser.newContext({ viewport: { width: 480, height: 270 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);

  const consoleErrors = [];
  const pageErrors = [];
  const watch = (p) => {
    p.on('console', (msg) => {
      const t = msg.type();
      if (t === 'error' || t === 'warning') consoleErrors.push(`[${t}] ${msg.text()}`);
    });
    p.on('pageerror', (err) => pageErrors.push(String(err && err.stack ? err.stack : err)));
  };
  watch(page);

  const url = `${server.url}?harness=1&seed=${ARGS.seed}`;
  log(`> loading ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__wavebreak && window.__wavebreak.ready, null, { timeout: 90_000 });

  const steps = buildScript();
  const scriptSeconds = steps.reduce((a, s) => a + s.dur, 0);
  log(`> rendering scripted take (${scriptSeconds.toFixed(1)}s, ${steps.length} steps) offline`);

  const t0 = Date.now();
  const take = await page.evaluate(renderScripted, {
    steps, sampleRate: ARGS.sampleRate, block: BLOCK, volume: ARGS.volume,
  });
  const pcm = decodePcm(take.pcm);
  log(`  rendered ${(pcm.length / take.sampleRate).toFixed(2)}s of audio in ${((Date.now() - t0) / 1000).toFixed(1)}s wall`);

  // ---- per-step measurement ------------------------------------------------
  const byName = new Map();
  const stepReport = [];
  for (const m of take.marks) {
    const a = m.from * take.block;
    const b = (m.from + m.count) * take.block;
    const wa = a + Math.floor((b - a) * m.win[0]);
    const wb = a + Math.ceil((b - a) * m.win[1]);
    const { metrics, sp } = analyseStep(pcm, take.sampleRate, wa, wb);
    const whole = levels(pcm, a, b);
    const row = {
      step: m.name, note: m.note,
      tStart: r3(a / take.sampleRate), tEnd: r3(b / take.sampleRate),
      window: m.win, ...metrics,
      stepPeakDb: r3(db(whole.peak)), stepClipped: whole.clipped,
    };
    stepReport.push(row);
    byName.set(m.name, { row, sp });
  }

  const overall = levels(pcm, 0, pcm.length);

  // ---- assertions ----------------------------------------------------------
  const C = new Checks();

  // 1. SILENCE ---------------------------------------------------------------
  C.add('silence', 'file is not silent', db(overall.rms) > -60,
    `overall rms ${r3(db(overall.rms))} dBFS, peak ${r3(db(overall.peak))} dBFS`);
  const dead = stepReport.filter((r) => !(r.rmsDb > -60));
  C.add('silence', 'no dead step', dead.length === 0,
    dead.length ? `silent steps: ${dead.map((d) => `${d.step}=${d.rmsDb}dB`).join(', ')}` : 'every step above -60 dBFS');

  // 2. SPECTRAL CENTROID MONOTONIC VS RPM -----------------------------------
  const sweep = stepReport.filter((r) => r.step.startsWith('rpm-'));
  const cents = sweep.map((r) => r.centroidHz);
  const badC = strictlyRising(cents);
  C.add('rpm', 'spectral centroid strictly rises with rpm', badC < 0,
    badC < 0 ? `centroid ${cents[0]} -> ${cents[cents.length - 1]} Hz over rpm 0..1`
      : `not rising at ${sweep[badC].step}: ${cents[badC - 1]} -> ${cents[badC]} Hz`);

  const pks = sweep.map((r) => r.peakHz);
  const badP = strictlyRising(pks);
  C.add('rpm', 'dominant partial strictly rises with rpm', badP < 0,
    badP < 0 ? `peak ${pks[0]} -> ${pks[pks.length - 1]} Hz`
      : `not rising at ${sweep[badP].step}: ${pks[badP - 1]} -> ${pks[badP]} Hz`);

  // Does the loudest partial sit on the fundamental, or an octave below it on
  // the sub? An engine whose strongest partial is the sub reads an octave flat.
  const sweepSteps = steps.filter((s) => s.name.startsWith('rpm-'));
  const tracking = sweep.map((r, i) => {
    const rpm = sweepSteps[i].rpm;
    const f0 = 46 * Math.pow(2, 2.5 * rpm);
    const ent = byName.get(r.step);
    return {
      step: r.step, rpm: r3(rpm), f0: r3(f0), peakHz: r.peakHz,
      ratio: r3(r.peakHz / f0),
      subDb: r3(db(magAt(ent.sp, f0 * 0.5))),
      fundDb: r3(db(magAt(ent.sp, f0))),
      h2Db: r3(db(magAt(ent.sp, f0 * 2))),
    };
  });
  const onFund = tracking.filter((t) => Math.abs(t.ratio - 1) < 0.08).length;
  C.add('rpm', 'loudest partial is the fundamental, not the sub octave', onFund === tracking.length,
    `${onFund}/${tracking.length} steps peak within 8% of f0 = 46*2^(2.5*rpm); ` +
    `ratios ${tracking.map((t) => t.ratio).join(', ')}`);

  // 3. CLIPPING --------------------------------------------------------------
  C.add('clip', 'no sample reaches full scale', overall.peak < 0.999,
    `true peak ${r3(overall.peak)} (${r3(db(overall.peak))} dBFS)`);
  C.add('clip', 'zero clipped samples', overall.clipped === 0,
    `${overall.clipped} samples at |x| >= 0.995 of ${overall.samples}`);

  // 4. WATER TRACKS SPEED ----------------------------------------------------
  const spd = stepReport.filter((r) => r.step.startsWith('spd-'));
  const rushes = spd.map((r) => r.bands.rush);
  const badS = strictlyRising(rushes);
  C.add('water', '800Hz-8kHz energy strictly rises with speed', badS < 0,
    `rush band ${rushes.join(' -> ')} dB`);

  // 5. AIRTIME IS AUDIBLE ----------------------------------------------------
  const gref = byName.get('ground-ref').row;
  const airr = byName.get('air').row;
  C.add('air', 'airborne is brighter than grounded at the same rpm', airr.centroidHz > gref.centroidHz * 1.05,
    `centroid ${gref.centroidHz} -> ${airr.centroidHz} Hz (${r3(100 * (airr.centroidHz / gref.centroidHz - 1))}%)`);
  C.add('air', 'engine free-revs out of the water', airr.peakHz > gref.peakHz * 1.04,
    `dominant partial ${gref.peakHz} -> ${airr.peakHz} Hz (${r3(100 * (airr.peakHz / gref.peakHz - 1))}%)`);

  // 6. IMPACTS ---------------------------------------------------------------
  const land = byName.get('land').row;
  const hit = byName.get('hit').row;
  C.add('impact', 'landing has low-end weight above the bed',
    land.transientDb.low > gref.transientDb.low + 6,
    `peak 20ms RMS below 250Hz: ${gref.transientDb.low} -> ${land.transientDb.low} dBFS`);
  C.add('impact', 'landing peaks above the running mix',
    land.transientDb.full > gref.transientDb.full + 4,
    `peak 20ms RMS: ${gref.transientDb.full} -> ${land.transientDb.full} dBFS`);
  C.add('impact', 'collision is bright and above the bed',
    hit.transientDb.bright > gref.transientDb.bright + 6,
    `peak 20ms RMS 1.5-6kHz: ${gref.transientDb.bright} -> ${hit.transientDb.bright} dBFS`);
  C.add('impact', 'a collision is shorter and brighter than a landing',
    hit.transientDb.bright - hit.transientDb.low > land.transientDb.bright - land.transientDb.low,
    `bright-minus-low: landing ${r3(land.transientDb.bright - land.transientDb.low)} dB, ` +
    `collision ${r3(hit.transientDb.bright - hit.transientDb.low)} dB`);

  // 7. DRIFT / BOOST ---------------------------------------------------------
  const drift = byName.get('drift').row;
  const boost = byName.get('boost').row;
  C.add('drift', 'drift band swells while sliding', drift.bands.drift > gref.bands.drift + 3,
    `900-2200Hz ${gref.bands.drift} -> ${drift.bands.drift} dB`);
  C.add('boost', 'boost adds high hiss', boost.bands.hiss > gref.bands.hiss + 6,
    `2.8-12kHz ${gref.bands.hiss} -> ${boost.bands.hiss} dB`);

  // 8. START LIGHTS ----------------------------------------------------------
  const intro = byName.get('intro').row;
  const h3 = byName.get('horn-3').row;
  const h1 = byName.get('horn-1').row;
  const go = byName.get('go').row;
  C.add('horn', 'countdown beeps are audible events', h3.peakDb > intro.peakDb + 6,
    `intro peak ${intro.peakDb} -> beep peak ${h3.peakDb} dBFS`);
  C.add('horn', 'GO tone is brighter than the beeps', go.centroidHz > h1.centroidHz * 1.1,
    `beep centroid ${h1.centroidHz} Hz -> go ${go.centroidHz} Hz`);

  // 9. NO VOICE LEAK ---------------------------------------------------------
  const maxVoices = take.voiceLog.reduce((a, [, v]) => Math.max(a, v), 0);
  C.add('voices', 'one-shot voices return to zero', take.voicesAtEnd === 0,
    `peak concurrent ${maxVoices}, at end ${take.voicesAtEnd}`);

  // ---- live pass -----------------------------------------------------------
  let live = null;
  if (ARGS.live) {
    log(`> rendering live race audio (${ARGS.liveSeconds}s from t=${ARGS.liveStart}s)`);
    // A brand new page, not a reload. `Audio.unlock()` is deliberately
    // idempotent - the shipping code must not rebuild its graph on every
    // gesture - so a second offline context handed to the same Audio instance
    // is ignored and this pass would render pure silence. (It did, on the first
    // run: 18 s at exactly 0.0 amplitude while the simulation underneath was
    // happily reporting 14 landings.) A second tab gets a fresh Game.
    const lt = Date.now();
    const livePage = await context.newPage();
    watch(livePage);
    livePage.setDefaultTimeout(300_000);
    await livePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await livePage.waitForFunction(() => window.__wavebreak && window.__wavebreak.ready, null, { timeout: 90_000 });
    const lr = await livePage.evaluate(renderLive, {
      sampleRate: ARGS.sampleRate, block: BLOCK,
      seconds: ARGS.liveSeconds, startAt: ARGS.liveStart, volume: ARGS.volume,
    });
    const lpcm = decodePcm(lr.pcm);
    const ll = levels(lpcm, 0, lpcm.length);
    const lsp = spectrum(lpcm, 0, lpcm.length, lr.sampleRate);
    live = {
      seconds: r3(lpcm.length / lr.sampleRate),
      wallSeconds: r3((Date.now() - lt) / 1000),
      phase: lr.phase, events: lr.events,
      maxRpm: r3(lr.maxRpm), maxSpeed01: r3(lr.maxSpeed01),
      rmsDb: r3(db(ll.rms)), peakDb: r3(db(ll.peak)), clipped: ll.clipped,
      centroidHz: lsp ? r3(centroid(lsp)) : null,
    };
    C.add('live', 'real Game->Audio path makes sound', db(ll.rms) > -60,
      `rms ${live.rmsDb} dBFS, peak ${live.peakDb} dBFS over ${live.seconds}s of race`);
    C.add('live', 'real race does not clip', ll.peak < 0.999 && ll.clipped === 0,
      `peak ${r3(ll.peak)}, ${ll.clipped} clipped samples`);
    await writeFile(path.join(outDir, 'audio-live.wav'), wav16(lpcm, lr.sampleRate));
    log(`  wrote ${path.relative(ROOT, path.join(outDir, 'audio-live.wav'))} (${live.seconds}s)`);
    await livePage.close();
  }

  // ---- artifacts -----------------------------------------------------------
  const wavPath = path.join(outDir, 'audio-sample.wav');
  await writeFile(wavPath, wav16(pcm, take.sampleRate));
  log(`  wrote ${path.relative(ROOT, wavPath)} (${(pcm.length / take.sampleRate).toFixed(2)}s, 16-bit mono ${take.sampleRate} Hz)`);

  const report = {
    generatedBy: 'tools/audio-probe.mjs',
    generatedAt: new Date().toISOString(),
    method:
      'The game\'s own Audio instance is driven with an OfflineAudioContext, one ' +
      'suspend() per 16 ms frame, so the PCM below is the shipping code path ' +
      'rendered deterministically rather than a realtime capture.',
    args: ARGS,
    sampleRate: take.sampleRate,
    frameMs: r3((BLOCK / take.sampleRate) * 1000),
    scripted: {
      file: path.relative(ROOT, wavPath),
      seconds: r3(pcm.length / take.sampleRate),
      rmsDb: r3(db(overall.rms)),
      truePeakDb: r3(db(overall.peak)),
      truePeak: r3(overall.peak),
      clippedSamples: overall.clipped,
      peakConcurrentVoices: maxVoices,
      voicesAtEnd: take.voicesAtEnd,
      steps: stepReport,
      rpmTracking: tracking,
    },
    live,
    checks: C.list,
    passed: C.failed.length === 0,
    consoleErrors,
    pageErrors,
  };
  const reportPath = path.join(outDir, 'audio-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  log(`  wrote ${path.relative(ROOT, reportPath)}`);

  await browser.close();
  if (!ARGS.keep) await server.stop();

  // ---- verdict -------------------------------------------------------------
  console.log('');
  for (const c of C.list) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  [${c.group}] ${c.name}\n          ${c.detail}`);
  console.log('');
  console.log(`  scripted : ${r3(pcm.length / take.sampleRate)}s  rms ${r3(db(overall.rms))} dBFS  peak ${r3(db(overall.peak))} dBFS  clipped ${overall.clipped}`);
  if (live) console.log(`  live     : ${live.seconds}s  rms ${live.rmsDb} dBFS  peak ${live.peakDb} dBFS  events ${JSON.stringify(live.events)}`);

  if (pageErrors.length) {
    console.error('\n!! PAGE ERRORS');
    for (const e of pageErrors) console.error(e);
  }
  const hardConsole = consoleErrors.filter((e) => e.startsWith('[error]'));
  if (hardConsole.length) {
    console.error('\n!! CONSOLE');
    for (const e of hardConsole.slice(0, 40)) console.error(e);
  }
  if (pageErrors.length || hardConsole.length) process.exit(2);
  if (ARGS.assert && C.failed.length) {
    console.error(`\n!! ${C.failed.length} audio assertion(s) failed`);
    process.exit(3);
  }
}

main().catch(async (err) => { console.error(err); process.exit(1); });
