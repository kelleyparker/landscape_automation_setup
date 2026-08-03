import { Rng } from '../core/Rng';
import type { BoatState, RaceStatus } from '../core/types';

/**
 * WAVEBREAK audio - every sample in this game is made of oscillators.
 *
 * There is no audio file anywhere in the project and there is no loader. The
 * water is a procedurally filled `AudioBuffer` of pink-ish noise, looped forever
 * through three parallel band filters; the engine is three oscillators through a
 * lowpass and a soft-clipper; every impact is a swept oscillator plus a noise
 * transient. That constraint is not a hardship - it is why the engine can track
 * `rpm` continuously over two and a half octaves instead of crossfading between
 * recorded loops, and why airtime can genuinely change the *timbre* of the motor
 * rather than just its volume.
 *
 * Three structural decisions drive the rest of the file:
 *
 * **1. Nothing exists until the first gesture.** Every browser blocks an
 * `AudioContext` created outside a user gesture, and a suspended context that is
 * never resumed leaks a whole audio thread. So the constructor allocates
 * nothing but two event listeners; the graph is built on the first pointerdown
 * or keydown and never rebuilt. `update()` before that is a plain early return,
 * which is also what happens on a browser with no Web Audio at all - the whole
 * subsystem degrades to silence rather than to an exception in the frame loop.
 *
 * **2. The graph is static; only parameters move.** Building nodes per frame is
 * how Web Audio projects end up with a thousand-node graph and a stuttering
 * audio thread. Everything continuous - engine pitch, filter cutoff, band gains
 * - is a persistent node whose `AudioParam` is nudged with `setTargetAtTime`, an
 * exponential approach that is click-free by construction and costs one number
 * per call. Only one-shots (impacts, horn, chimes) create nodes, and those are
 * counted, capped and disconnected from their own `onended`.
 *
 * **3. Loudness is bounded twice.** A compressor doing limiter duty catches the
 * musical peaks, and a `tanh` waveshaper sits after the master gain to saturate
 * whatever gets past it. Four boats' worth of impacts landing on the same frame
 * must not be able to clip.
 *
 * The waveshaper is a saturator, not a brickwall: it runs at `oversample: '2x'`,
 * and the resampling filters ring, so a signal driven far past unity comes out
 * a little *over* it. Measured with the master deliberately set to 6.0, the
 * output peaks at 1.14 rather than 1.00. That is a fine trade - 2x oversampling
 * is what stops the saturation from aliasing at audio rates - and it is not
 * load-bearing, because in normal operation the peak sits at -2.3 dBFS with the
 * settings volume at maximum. `tools/audio-probe.mjs` measures both numbers.
 *
 * Which is the point of this file's relationship to that tool: every claim in
 * this comment block is a number in `press/audio-report.json`.
 */

// ------------------------------------------------------------- master --------

/** Post-limiter master level. Leaves headroom for the browser's own mixer. */
const MASTER_LEVEL = 0.85;
/** Ceiling on simultaneous one-shot voices. Past this, new one-shots are dropped. */
const MAX_ONESHOTS = 16;

// ------------------------------------------------------------- engine --------

/**
 * Engine fundamental at zero RPM, Hz, and the range it climbs through.
 *
 * 46 Hz is deliberately below the useful idle: `BoatPhysics` never publishes an
 * rpm under about 0.09, so the audible floor sits near 53 Hz and the bottom of
 * the range is held in reserve for the moment the throttle is dropped in a
 * trough. 2.5 octaves puts full revs at ~260 Hz, which is where a two-stroke
 * ski actually lives - high enough to scream, low enough that the sawtooth's
 * harmonics still land inside the lowpass rather than above it.
 */
const ENGINE_F0 = 46;
const ENGINE_OCTAVES = 2.5;
/** Detune of the second oscillator, cents. ~14 cents beats about once a second at idle. */
const ENGINE_DETUNE = 14;

/**
 * Motor wobble. A steady oscillator reads as a synth pad; the thing that makes
 * it read as a *motor* is a periodic amplitude ripple that speeds up with revs,
 * standing in for cylinder firing. The depth shrinks as the revs rise because a
 * screaming engine is smoother than a lugging one.
 *
 * The modulator is a *pulse* train, not a sine (see `makeFiringWave`): a sine
 * ripple is a tremolo and sounds like an effect pedal, whereas a narrow spike
 * once per cycle is what a cylinder actually does to the exhaust.
 */
const WOBBLE_HZ_IDLE = 6.5;
const WOBBLE_HZ_TOP = 34.0;
const WOBBLE_DEPTH_IDLE = 0.22;
const WOBBLE_DEPTH_TOP = 0.09;

/**
 * Relative levels of the three engine oscillators.
 *
 * These are load-bearing, not taste. `tools/audio-probe.mjs` measures the
 * strongest partial across an rpm sweep and asserts it is the fundamental:
 * with the original 0.42 / 0.50 split the sub sine at f0/2 came out 3-9 dB
 * *above* the fundamental at every rev, so the motor's perceived pitch sat an
 * octave below the note it was supposed to be playing, and the measured peak
 * frequency jumped between f0 and f0/2 from step to step instead of climbing.
 *
 * The sub also has a floor of zero rather than 0.35 now. At idle f0/2 is about
 * 26 Hz - below anything a laptop or a phone can reproduce - so a floor there
 * spent headroom on a tone nobody could hear.
 */
const SAW_LEVEL = 0.62;
const SUB_LEVEL = 0.16;

/**
 * Intake / jet noise. Oscillators alone give a *tone* that rises with revs;
 * what separates a motor from a synth patch in the top half of the range is the
 * broadband air being dragged through it. This rides the same firing ripple as
 * the oscillators, so it pulses with them rather than sitting underneath as a
 * separate hiss.
 */
const INTAKE_LEVEL = 0.115;

/**
 * How hard rising RPM counts as "under load". `rpm` chases its target at 6/s in
 * physics, so a hard launch peaks near 5 rpm-units/second; 0.45 saturates the
 * bite well before that, which means an ordinary roll-on still gets some.
 */
const BITE_FROM_DRPM = 0.45;

// -------------------------------------------------------------- water --------

/** Noise loop length, seconds. Long and non-round so the loop never beats against the engine. */
const NOISE_SECONDS = 3.17;
/** Equal-power crossfade at the loop seam, samples. */
const NOISE_XFADE = 2048;
/** Slip speed that counts as fully sideways for the drift band, m/s. Mirrors BoatPhysics' feel. */
const SLIP_REF = 8.0;

// -------------------------------------------------------------- drift --------

/**
 * Drift charge tiers. These mirror `DRIFT_TIERS` in `boat/BoatPhysics.ts`, which
 * does not export them - the chime has to ring on the same frame the payout
 * changes or the reward stops reading as caused by the player. If those move,
 * these move with them.
 */
const DRIFT_TIERS: readonly number[] = [0.33, 0.66, 1.0];
/** Chime fundamentals per tier. A rising pentatonic figure: the third one is the prize. */
const TIER_PITCH: readonly number[] = [784, 988, 1319];

// ------------------------------------------------------------- helpers -------

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Odd-symmetric soft clip. Built once at startup, shared by the master limiter
 * and (with more drive) by the engine's saturation stage. An odd sample count
 * guarantees the centre tap maps exactly 0 -> 0, so a muted master really is
 * silent rather than a DC offset.
 *
 * The return type is left to inference on purpose: `WaveShaperNode.curve` wants
 * a `Float32Array` backed by a plain `ArrayBuffer`, and writing the bare alias
 * here would widen it to `ArrayBufferLike` and stop assigning.
 */
function makeSoftClipCurve(drive: number, n = 1025) {
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

/**
 * The firing ripple's shape: a periodic *pulse*, built as a cosine series with
 * a Gaussian envelope over the harmonics.
 *
 * All-real coefficients put the spike at phase zero and make the waveform even,
 * so the modulator is a narrow positive spike sitting on a shallow negative
 * plateau - one bang per cycle, exactly the asymmetry a two-stroke has and a
 * sine does not. Seven partials keeps the spike about a seventh of a period
 * wide, which at the top of the rev range is ~4 ms: audible as a pulse, far too
 * slow to alias.
 *
 * Normalisation is left on, so peak deviation is 1.0 and `WOBBLE_DEPTH_*` means
 * exactly what it says regardless of how many partials this uses.
 */
function makeFiringWave(ctx: BaseAudioContext, partials = 7): PeriodicWave {
  const real = new Float32Array(partials + 1);
  const imag = new Float32Array(partials + 1);
  // real[0] is DC and is ignored by the spec; leaving it zero keeps the mean at
  // zero, which is what stops the ripple from biasing the engine's level.
  for (let k = 1; k <= partials; k++) real[k] = Math.exp(-((k - 1) * (k - 1)) / (2 * 2.2 * 2.2));
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/**
 * Percussive envelope on a gain param.
 *
 * Exponential ramps from a floor rather than from zero: Web Audio's exponential
 * ramp is undefined through zero, and the 1e-4 floor is 80 dB down - inaudible,
 * but a legal starting value.
 */
function envelope(p: AudioParam, t0: number, peak: number, attack: number, decay: number): void {
  const top = Math.max(peak, 2e-4);
  p.cancelScheduledValues(t0);
  p.setValueAtTime(1e-4, t0);
  p.exponentialRampToValueAtTime(top, t0 + attack);
  p.exponentialRampToValueAtTime(1e-4, t0 + attack + decay);
}

// --------------------------------------------------------------- graph -------

interface EngineVoice {
  saw: OscillatorNode;
  pulse: OscillatorNode;
  sub: OscillatorNode;
  pulseGain: GainNode;
  subGain: GainNode;
  filter: BiquadFilterNode;
  dry: GainNode;
  drive: GainNode;
  wet: GainNode;
  shaper: WaveShaperNode;
  wobble: GainNode;
  lfo: OscillatorNode;
  lfoDepth: GainNode;
  intakeSrc: AudioBufferSourceNode;
  intakeBand: BiquadFilterNode;
  intakeGain: GainNode;
  level: GainNode;
}

interface WaterVoice {
  src: AudioBufferSourceNode;
  rushBand: BiquadFilterNode;
  rushGain: GainNode;
  driftBand: BiquadFilterNode;
  driftGain: GainNode;
  rumble: BiquadFilterNode;
  rumbleGain: GainNode;
  hiss: BiquadFilterNode;
  hissGain: GainNode;
  wind: BiquadFilterNode;
  windGain: GainNode;
}

interface Graph {
  /** Everything that belongs to the simulation. Ducked by race phase. */
  world: GainNode;
  /** One-shots. Never ducked - the horn has to cut through the intro flyover. */
  sfx: GainNode;
  limiter: DynamicsCompressorNode;
  master: GainNode;
  clip: WaveShaperNode;
  noise: AudioBuffer;
  engine: EngineVoice;
  water: WaterVoice;
}

/**
 * What `tools/audio-probe.mjs` needs to see. Harness-only.
 *
 * `out` is the node *after* the soft-clipper, i.e. exactly what reaches the
 * speakers, so the probe can tap the true output without inserting anything
 * into the signal path. `voices` is the live one-shot count, which is how the
 * probe proves that impacts and horns actually release their nodes instead of
 * leaking them.
 */
export interface AudioProbeTap {
  ctx: BaseAudioContext;
  out: AudioNode;
  world: GainNode;
  sfx: GainNode;
  voices: number;
}

// ------------------------------------------------------------------ Audio ----

export class Audio {
  private ctx: AudioContext | null = null;
  private g: Graph | null = null;
  /** Set if Web Audio is missing or the graph threw. The subsystem then stays silent forever. */
  private failed = false;
  private isMuted = false;
  /**
   * The settings menu's VOLUME slider, 0..1.
   *
   * This used to have no home: `Game.applySettings` calls
   * `audio.setMasterVolume?.(...)` through an optional-call cast, so before the
   * method existed the slider silently did nothing at every position except
   * zero (where the separate mute path caught it). Storing it here rather than
   * writing straight to the gain node matters because settings are applied once
   * at construction, long before the first gesture builds the graph - so the
   * value has to survive until `build()` can pick it up.
   */
  private volume = 1;
  /**
   * Harness escape hatch for `update()`'s `state === 'running'` guard.
   *
   * An `OfflineAudioContext` reports `'suspended'` at every `suspend()` point -
   * which is precisely the instant the probe needs to write this frame's
   * parameters. Without this flag an offline render would produce silence, and
   * the probe would be measuring its own harness bug instead of the audio.
   */
  private tickWhileSuspended = false;

  /**
   * Seeded independently of the world RNG. Audio must never perturb the stream
   * that generates the course, and the noise bed should be identical between
   * runs so a recorded capture sounds the same twice.
   */
  private readonly rng = new Rng(0xa0d10);

  // --- smoothed signals. Plain numbers; `update()` allocates nothing. -------
  private prevRpm = 0;
  private bite = 0;
  private air = 0;
  private driftAmt = 0;
  private boostAmt = 0;

  // --- edge detectors -------------------------------------------------------
  private wasBoosting = false;
  private prevCharge = 0;
  /** Countdown integer last announced; -1 = nothing announced yet. */
  private lastBeep = -1;
  private wentGreen = false;
  private oneShots = 0;

  constructor() {
    if (typeof window === 'undefined') {
      this.failed = true;
      return;
    }
    // The listeners stay attached rather than being `{ once: true }`. Building
    // the graph is idempotent, and a context can be suspended again later (tab
    // switch, OS audio focus change) - keeping them means the *next* gesture
    // resumes it instead of leaving the game mute until a reload.
    window.addEventListener('pointerdown', this.onGesture);
    window.addEventListener('keydown', this.onKeyDown);
  }

  // ---------------------------------------------------------------- unlock ---

  private onGesture = (): void => {
    if (this.failed) return;
    if (!this.ctx) this.init();
    const ctx = this.ctx;
    // `resume()` only counts while we are still inside the gesture's call stack,
    // which is exactly where this handler runs.
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    this.onGesture();
    if (e.code === 'KeyM') this.setMuted(!this.isMuted);
  };

  /**
   * Build the graph without a user gesture. **Harness only.**
   *
   * The shipped game never calls this - a page that starts an `AudioContext`
   * before the user has touched it is a page browsers rightly mute. It exists
   * because the audio probe has to be able to render the subsystem's output to
   * a file, and there is no gesture in a headless render.
   *
   * Passing a context lets the probe hand in an `OfflineAudioContext`, which is
   * the only way to get bit-exact, reproducible PCM out of this file: a
   * realtime capture in a container with no sound card measures the container's
   * scheduling jitter as much as it measures the game. The parameter is typed
   * `BaseAudioContext` because that is genuinely all this class uses; the cast
   * below is the one place the difference is papered over, and `dispose()` is
   * written to tolerate a context with no `close()`.
   */
  unlock(injected?: BaseAudioContext): void {
    if (this.failed && !injected) return;
    if (injected) {
      if (this.g) return;
      this.failed = false;
      this.tickWhileSuspended = true;
      this.ctx = injected as AudioContext;
      this.g = this.build(this.ctx);
      return;
    }
    if (!this.ctx) this.init();
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  }

  /** Harness only: the tap points and live voice count. Null before `unlock()`. */
  probeTap(): AudioProbeTap | null {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return null;
    return { ctx, out: g.clip, world: g.world, sfx: g.sfx, voices: this.oneShots };
  }

  private init(): void {
    try {
      // Read off `window` rather than referencing the global binding directly:
      // Safari only exposes the prefixed constructor, and the DOM lib does not
      // declare either of them as a property of `Window`.
      const w = window as unknown as {
        AudioContext?: AudioContextCtor;
        webkitAudioContext?: AudioContextCtor;
      };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) { this.failed = true; return; }
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.g = this.build(ctx);
    } catch {
      // A blocked or unavailable context is not a game-stopping condition.
      this.failed = true;
      this.ctx = null;
      this.g = null;
    }
  }

  // ----------------------------------------------------------------- build ---

  private build(ctx: AudioContext): Graph {
    // --- master chain: limiter -> gain -> hard soft-clip -> speakers --------
    const clip = ctx.createWaveShaper();
    clip.curve = makeSoftClipCurve(1.35);
    clip.oversample = '2x';
    clip.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = this.masterTarget();
    master.connect(clip);

    // Fast attack, musical release: this is a limiter, not a glue compressor.
    // The threshold sits just above where the engine and the water bed together
    // peak (around -6 dBFS by design of the gains below), so the steady mix
    // passes through untouched and only stacked transients - four hulls landing
    // on the same frame, an impact under the start horn - get pulled down. A
    // lower threshold would compress the engine permanently and leave the
    // impacts with no headroom to be impacts in.
    //
    // The release used to be 0.18 s, which was long enough that a landing left
    // a measurable hole in the engine bed behind it - the probe caught the
    // low-band energy *dropping* during a landing step. 0.09 s lets the mix
    // recover inside the impact's own decay, so a slam reads as an addition
    // rather than as a duck.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3.5;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.09;
    limiter.connect(master);

    const world = ctx.createGain();
    world.gain.value = 0;
    world.connect(limiter);

    const sfx = ctx.createGain();
    sfx.gain.value = 0.9;
    sfx.connect(limiter);

    const noise = this.makeNoiseBuffer(ctx);

    return {
      world, sfx, limiter, master, clip, noise,
      engine: this.buildEngine(ctx, world, noise),
      water: this.buildWater(ctx, world, noise),
    };
  }

  /**
   * The looping water bed.
   *
   * Mostly pink (1/f) because water is a low-slope spectrum, with a slice of
   * white left in so the bandpasses have something to find above 5 kHz. Pinking
   * uses Paul Kellet's economical filter bank - seven one-poles, exact enough
   * for a noise bed and about as cheap as arithmetic gets.
   *
   * The tail is crossfaded into the head with an equal-power curve so the loop
   * seam has no step in it. A step in *white* noise is inaudible, but the pink
   * component carries real low-frequency energy and a discontinuity there is a
   * click once every three seconds - which the ear locks onto immediately.
   */
  private makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * NOISE_SECONDS);
    const xf = Math.min(NOISE_XFADE, len >> 3);
    const raw = new Float32Array(len + xf);

    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < raw.length; i++) {
      const white = this.rng.signed();
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
      raw[i] = pink * 0.72 + white * 0.28;
    }

    const buf = ctx.createBuffer(1, len, rate);
    const out = buf.getChannelData(0);
    out.set(raw.subarray(0, len));
    for (let i = 0; i < xf; i++) {
      // sqrt weights keep RMS constant across the seam; the two sides are
      // uncorrelated, so linear weights would dip in the middle.
      const t = i / xf;
      out[i] = raw[i]! * Math.sqrt(t) + raw[len + i]! * Math.sqrt(1 - t);
    }
    return buf;
  }

  /**
   * Engine voice.
   *
   * saw + detuned pulse + sub sine -> lowpass -> parallel saturation -> wobble.
   *
   * The saturation is parallel rather than in series so "bite" can be dialled in
   * without the dry fundamental losing weight - drive a lowpassed saw straight
   * into a tanh and the low end is the first thing to go, which is the opposite
   * of what an engine under load does.
   */
  private buildEngine(ctx: AudioContext, dest: GainNode, noise: AudioBuffer): EngineVoice {
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = ENGINE_F0;

    const pulse = ctx.createOscillator();
    pulse.type = 'square';
    pulse.frequency.value = ENGINE_F0;
    pulse.detune.value = ENGINE_DETUNE;

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = ENGINE_F0 * 0.5;

    // The saw is the reference level and never moves; the other two are voiced
    // against it every frame. The three together sum to about unity at full
    // revs, which is the budget the limiter's threshold was chosen around.
    const sawGain = ctx.createGain();
    sawGain.gain.value = SAW_LEVEL;
    const pulseGain = ctx.createGain();
    pulseGain.gain.value = 0.09;
    const subGain = ctx.createGain();
    subGain.gain.value = SUB_LEVEL * 0.15;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    filter.Q.value = 0.9;

    const shaper = ctx.createWaveShaper();
    shaper.curve = makeSoftClipCurve(2.6);
    shaper.oversample = '2x';

    const drive = ctx.createGain();
    drive.gain.value = 1;
    const wet = ctx.createGain();
    wet.gain.value = 0;
    const dry = ctx.createGain();
    dry.gain.value = 1;

    const wobble = ctx.createGain();
    wobble.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.setPeriodicWave(makeFiringWave(ctx));
    lfo.frequency.value = WOBBLE_HZ_IDLE;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = WOBBLE_DEPTH_IDLE;

    // Intake air. Its own read of the shared noise buffer rather than a tap off
    // the water source: a second reader costs one buffer fetch per sample and
    // keeps the two uncorrelated, where sharing one would comb-filter the
    // engine against the hull noise every time their bands overlapped.
    const intakeSrc = ctx.createBufferSource();
    intakeSrc.buffer = noise;
    intakeSrc.loop = true;
    const intakeBand = ctx.createBiquadFilter();
    intakeBand.type = 'bandpass';
    intakeBand.frequency.value = 400;
    intakeBand.Q.value = 1.1;
    const intakeGain = ctx.createGain();
    intakeGain.gain.value = 0;

    const level = ctx.createGain();
    level.gain.value = 0;

    saw.connect(sawGain).connect(filter);
    pulse.connect(pulseGain).connect(filter);
    sub.connect(subGain).connect(filter);
    filter.connect(dry).connect(wobble);
    filter.connect(drive).connect(shaper).connect(wet).connect(wobble);
    // Intake joins *before* the wobble so it gets the firing ripple too. Air
    // being pulled through a running motor pulses with the motor; a smooth hiss
    // laid over a pulsing tone reads as two unrelated sounds.
    intakeSrc.connect(intakeBand).connect(intakeGain).connect(wobble);
    // The LFO writes into the wobble gain's *offset*, so the node rides
    // 1 +/- depth. Depth stays well under 1 and the gain never goes negative.
    lfo.connect(lfoDepth).connect(wobble.gain);
    wobble.connect(level).connect(dest);

    saw.start();
    pulse.start();
    sub.start();
    lfo.start();
    // Offset the intake's read so it is not phase-locked to the water bed's
    // copy of the same three seconds of noise.
    intakeSrc.start(0, this.rng.next() * (noise.duration * 0.8));

    return {
      saw, pulse, sub, pulseGain, subGain, filter, dry, drive, wet, shaper,
      wobble, lfo, lfoDepth, intakeSrc, intakeBand, intakeGain, level,
    };
  }

  /**
   * Water voice: one looping noise source fanned into four bands.
   *
   *  - rush:   wide bandpass that opens upward with speed. The main hull noise.
   *  - drift:  narrow, high-Q band that swells while sliding. The resonance is
   *            what makes a powerslide *hiss* rather than just get louder.
   *  - rumble: lowpassed body so speed has weight and not just air.
   *  - hiss:   highpassed jet noise, on only while boosting.
   *
   * One source feeding four filters costs one buffer read per sample instead of
   * four, and guarantees the bands stay phase-coherent with each other - four
   * independent noise sources sound like four separate noises.
   */
  private buildWater(ctx: AudioContext, dest: GainNode, noise: AudioBuffer): WaterVoice {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;

    const rushBand = ctx.createBiquadFilter();
    rushBand.type = 'bandpass';
    rushBand.frequency.value = 500;
    rushBand.Q.value = 0.75;
    const rushGain = ctx.createGain();
    rushGain.gain.value = 0;

    const driftBand = ctx.createBiquadFilter();
    driftBand.type = 'bandpass';
    driftBand.frequency.value = 1000;
    driftBand.Q.value = 8;
    const driftGain = ctx.createGain();
    driftGain.gain.value = 0;

    const rumble = ctx.createBiquadFilter();
    rumble.type = 'lowpass';
    rumble.frequency.value = 160;
    rumble.Q.value = 0.7;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;

    const hiss = ctx.createBiquadFilter();
    hiss.type = 'highpass';
    hiss.frequency.value = 2800;
    hiss.Q.value = 0.8;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0;

    // Wind. Only ever on while airborne, and the reason airtime is not a hole
    // in the mix: every other water band is multiplied by `wet01`, so leaving
    // the water took *all* the broadband energy with it and the measured
    // spectral centroid fell by 46% at the exact moment the game wants to feel
    // faster and thinner. Wide Q because wind is not resonant.
    const wind = ctx.createBiquadFilter();
    wind.type = 'bandpass';
    wind.frequency.value = 2400;
    wind.Q.value = 0.55;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;

    src.connect(rushBand).connect(rushGain).connect(dest);
    src.connect(driftBand).connect(driftGain).connect(dest);
    src.connect(rumble).connect(rumbleGain).connect(dest);
    src.connect(hiss).connect(hissGain).connect(dest);
    src.connect(wind).connect(windGain).connect(dest);
    src.start();

    return { src, rushBand, rushGain, driftBand, driftGain, rumble, rumbleGain, hiss, hissGain, wind, windGain };
  }

  // ------------------------------------------------------------------ tick ---

  /**
   * Per-frame parameter update. Allocation-free: every call below passes numbers
   * to an `AudioParam`, and the one-shot triggers only fire on edges.
   *
   * A no-op until the graph exists, which is the whole pre-gesture lifetime of
   * the page and the entire lifetime of a browser without Web Audio.
   */
  update(dt: number, state: BoatState, status: RaceStatus): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    if (ctx.state !== 'running' && !this.tickWhileSuspended) return;

    const now = ctx.currentTime;
    // Guard the derivative below against a zero or pathological frame time; the
    // physics substep is 1/240 s, so nothing finer than that is meaningful.
    const h = Math.max(dt, 1 / 240);

    // --- load / air / drift / boost, smoothed ------------------------------
    const rpm = clamp(state.rpm, 0, 1);
    const dRpm = (rpm - this.prevRpm) / h;
    this.prevRpm = rpm;
    // Bite is *rising* revs weighted by where in the range they are: a launch
    // off idle bites, a top-end trim does not. Attack is fast and release slow,
    // so the extra harmonics arrive with the throttle and bleed away on lift.
    const biteTarget = clamp(dRpm * BITE_FROM_DRPM, 0, 1) * (0.35 + 0.65 * rpm);
    this.bite += (biteTarget - this.bite) * Math.min(1, h * (biteTarget > this.bite ? 12 : 3.2));

    // Airborne rises fast (the moment of leaving the water is the event) and
    // falls a little slower so a hull skipping across chop does not chatter.
    const airTarget = state.airborne ? 1 : 0;
    this.air += (airTarget - this.air) * Math.min(1, h * (state.airborne ? 14 : 7));

    const slip01 = clamp(Math.abs(state.slip) / SLIP_REF, 0, 1);
    const driftTarget = state.drifting ? slip01 : 0;
    this.driftAmt += (driftTarget - this.driftAmt) * Math.min(1, h * 6);

    const boostTarget = state.boosting ? 1 : 0;
    this.boostAmt += (boostTarget - this.boostAmt) * Math.min(1, h * (state.boosting ? 14 : 5));

    const sp = clamp(state.speed01, 0, 1);
    const wet01 = 1 - this.air;

    // --- engine ------------------------------------------------------------
    const e = g.engine;
    // Free-revving in the air: the jet has nothing to push against, so the note
    // lifts a few percent as the load comes off. Small on purpose - a big jump
    // reads as a gear change rather than as cavitation.
    const f0 = ENGINE_F0 * Math.pow(2, ENGINE_OCTAVES * rpm) * (1 + 0.07 * this.air);
    e.saw.frequency.setTargetAtTime(f0, now, 0.04);
    e.pulse.frequency.setTargetAtTime(f0, now, 0.04);
    e.sub.frequency.setTargetAtTime(f0 * 0.5, now, 0.055);

    // Cutoff opens with revs, opens further under load, and opens furthest in
    // the air - that last term is the "thins out" half of the cavitation cue.
    const cutoff = clamp(
      250 + 3200 * Math.pow(rpm, 1.1) + 1500 * this.bite + 2800 * this.air,
      120, 11000,
    );
    e.filter.frequency.setTargetAtTime(cutoff, now, 0.05);
    // Resonance only under load. A permanently resonant lowpass on a sawtooth
    // whistles at the cutoff and immediately stops sounding mechanical.
    e.filter.Q.setTargetAtTime(0.9 + 3.0 * this.bite, now, 0.12);

    // The sub is the hull in the water. Airborne it is the first thing to go.
    // It fades in with revs from nothing rather than from a floor: at idle it
    // sits at 26 Hz, which is headroom spent on a tone no consumer speaker
    // reproduces, and which the probe measured drowning the fundamental.
    e.subGain.gain.setTargetAtTime(SUB_LEVEL * (0.15 + 0.85 * rpm) * (1 - 0.8 * this.air), now, 0.07);
    e.pulseGain.gain.setTargetAtTime(0.09 + 0.26 * this.bite, now, 0.08);

    // Intake: brighter and louder with revs, and it opens further under load
    // because that is when the motor is actually swallowing air. Superlinear in
    // rpm so idle stays a mechanical burble rather than a hiss.
    e.intakeBand.frequency.setTargetAtTime(360 + 3000 * rpm + 900 * this.bite, now, 0.06);
    e.intakeGain.gain.setTargetAtTime(INTAKE_LEVEL * Math.pow(rpm, 1.3) * (1 + 0.7 * this.bite), now, 0.06);
    e.drive.gain.setTargetAtTime(1 + 5 * this.bite, now, 0.08);
    e.wet.gain.setTargetAtTime(0.55 * this.bite, now, 0.08);
    e.dry.gain.setTargetAtTime(1 - 0.28 * this.bite, now, 0.08);

    e.lfo.frequency.setTargetAtTime(WOBBLE_HZ_IDLE + (WOBBLE_HZ_TOP - WOBBLE_HZ_IDLE) * rpm, now, 0.1);
    const depth = (WOBBLE_DEPTH_IDLE + (WOBBLE_DEPTH_TOP - WOBBLE_DEPTH_IDLE) * rpm) * (1 - 0.55 * this.air);
    e.lfoDepth.gain.setTargetAtTime(depth, now, 0.12);

    // Sub-linear in rpm: loudness perception is, and a linear ramp makes the
    // bottom of the range inaudible and the top of it the only thing you hear.
    e.level.gain.setTargetAtTime(0.13 + 0.32 * Math.pow(rpm, 0.85) + 0.04 * this.air, now, 0.05);

    // --- water -------------------------------------------------------------
    const w = g.water;
    w.rushBand.frequency.setTargetAtTime(430 + 2500 * Math.pow(sp, 0.85), now, 0.09);
    // The band also *narrows* at rest. A Q of 0.75 rolls off at only 6 dB per
    // octave, so the resting bed had audible hiss two decades above its centre
    // - enough that at idle the water, not the motor, owned the measured
    // spectral centroid, and the engine's brightness curve went backwards over
    // its first step. Water at rest is low and slow; only planing is hissy.
    w.rushBand.Q.setTargetAtTime(1.7 - 0.95 * sp, now, 0.09);
    // Superlinear so the bottom of the speed range stays quiet - a boat idling
    // on the swell should be nearly silent - but not *squared*, which made the
    // whole bottom half of the speed range indistinguishable from a dead stop.
    w.rushGain.gain.setTargetAtTime((0.03 + 0.42 * Math.pow(sp, 1.5)) * wet01, now, 0.09);

    w.driftBand.frequency.setTargetAtTime(900 + 1200 * slip01, now, 0.08);
    w.driftGain.gain.setTargetAtTime(0.40 * this.driftAmt * (0.3 + 0.7 * sp) * wet01, now, 0.07);

    w.rumble.frequency.setTargetAtTime(140 + 170 * sp, now, 0.12);
    w.rumbleGain.gain.setTargetAtTime(0.11 * sp * wet01, now, 0.1);

    w.hiss.frequency.setTargetAtTime(2600 + 1600 * sp, now, 0.1);
    w.hissGain.gain.setTargetAtTime(0.17 * this.boostAmt, now, 0.06);

    // Wind is the mirror image of the other four: `air`, not `wet01`. It rises
    // with speed as well as airtime because a slow hop should not roar.
    w.wind.frequency.setTargetAtTime(2200 + 2400 * sp, now, 0.08);
    w.windGain.gain.setTargetAtTime(0.30 * this.air * (0.25 + 0.75 * sp), now, 0.06);

    // --- phase duck --------------------------------------------------------
    // The intro is a camera flyover and the results screen is a menu; both want
    // the world present but out of the way. One-shots bypass this entirely.
    const phase = status.phase;
    const worldTarget = phase === 'intro' ? 0.5 : phase === 'results' ? 0.42 : 1.0;
    g.world.gain.setTargetAtTime(worldTarget, now, 0.3);

    // --- discrete events ---------------------------------------------------
    this.tickStartHorn(status, now);

    if (state.landingImpact > 0.02) this.playThud(now, state.landingImpact);
    if (state.hitImpact > 0.02) this.playHit(now, state.hitImpact);

    if (state.boosting && !this.wasBoosting) this.playWhoosh(now);
    this.wasBoosting = state.boosting;

    // Charge only ever rises within a slide and is zeroed on release, so an
    // upward threshold crossing is exactly one tier being reached.
    const charge = state.driftCharge;
    for (let i = 0; i < DRIFT_TIERS.length; i++) {
      const th = DRIFT_TIERS[i]!;
      if (this.prevCharge < th && charge >= th) this.playChime(now, i);
    }
    this.prevCharge = charge;
  }

  /**
   * Start lights. Three short tones on 3-2-1, one longer and brighter on GO.
   *
   * The count is taken from `Math.ceil` of the remaining time, so each integer
   * band fires exactly once regardless of frame rate, and the GO tone is hung
   * off the phase transition rather than off `countdown <= 0` so a harness jump
   * straight into 'racing' still gets its horn.
   */
  private tickStartHorn(status: RaceStatus, now: number): void {
    const phase = status.phase;
    if (phase === 'intro') {
      this.lastBeep = -1;
      this.wentGreen = false;
      return;
    }
    if (phase === 'countdown') {
      const n = clamp(Math.ceil(status.countdown), 0, 3);
      if (n >= 1 && n !== this.lastBeep) {
        this.lastBeep = n;
        this.playHorn(now, 560, 0.17, 0.34, 2400);
      }
      return;
    }
    if ((phase === 'racing' || phase === 'finished') && !this.wentGreen) {
      this.wentGreen = true;
      this.lastBeep = -1;
      // Up an octave, twice as long, filter wide open: the release.
      this.playHorn(now, 1120, 0.85, 0.42, 7000);
    }
  }

  // ------------------------------------------------------------- one-shots ---

  /**
   * Voice budget. One-shots are cheap individually but four boats' worth of
   * collisions in a pile-up can spike the node count, and an audio thread that
   * misses its deadline drops out audibly for far longer than the sounds it was
   * trying to play. Dropping the sixteenth simultaneous impact is free.
   */
  private takeVoice(): boolean {
    if (this.oneShots >= MAX_ONESHOTS) return false;
    this.oneShots++;
    return true;
  }

  /** A short pitched body: swept oscillator through its own envelope. */
  private playBody(
    now: number, type: OscillatorType, fStart: number, fEnd: number,
    peak: number, attack: number, decay: number,
  ): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || !this.takeVoice()) return;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(fStart, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(fEnd, 8), now + attack + decay);

    const amp = ctx.createGain();
    envelope(amp.gain, now, peak, attack, decay);

    osc.connect(amp).connect(g.sfx);
    osc.start(now);
    osc.stop(now + attack + decay + 0.02);
    osc.onended = () => {
      osc.disconnect();
      amp.disconnect();
      this.oneShots--;
    };
  }

  /**
   * A noise transient: a slice of the shared loop through a resonant band.
   *
   * The read offset is jittered from the seeded RNG so two impacts in a row are
   * not literally the same waveform - the ear picks up an exact repeat instantly,
   * and that is what makes a synthesised hit sound like a sample.
   */
  private playNoise(
    now: number, filterType: BiquadFilterType, freq: number, q: number,
    peak: number, attack: number, decay: number,
  ): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || !this.takeVoice()) return;

    const dur = attack + decay + 0.02;
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    const span = Math.max(0, g.noise.duration - dur - 0.05);

    const band = ctx.createBiquadFilter();
    band.type = filterType;
    band.frequency.value = freq;
    band.Q.value = q;

    const amp = ctx.createGain();
    envelope(amp.gain, now, peak, attack, decay);

    src.connect(band).connect(amp).connect(g.sfx);
    src.start(now, this.rng.next() * span);
    src.stop(now + dur);
    src.onended = () => {
      src.disconnect();
      band.disconnect();
      amp.disconnect();
      this.oneShots--;
    };
  }

  /**
   * Water re-entry. A pitched-down sine body carries the mass and a mid noise
   * burst carries the splash; the body's start pitch rises with the magnitude so
   * a big slam is not merely a louder small one.
   */
  private playThud(now: number, mag01: number): void {
    const m = clamp(mag01, 0, 1);
    // The body used to sweep down to 34 Hz, which spent most of the tail below
    // what a laptop or a phone can move air with - the slam had a big number in
    // the analyser and not much weight in the room. 54 Hz keeps the drop
    // audible on small speakers and still reads as an octave-and-a-bit fall.
    this.playBody(now, 'sine', 130 + 130 * m, 54, 0.62 * (0.35 + 0.65 * m), 0.005, 0.26 + 0.18 * m);
    this.playNoise(now, 'bandpass', 900 + 500 * m, 1.1, 0.34 * m, 0.004, 0.13 + 0.12 * m);
    // A second, lower noise tail: the water closing back over the hull.
    if (m > 0.35) this.playNoise(now + 0.05, 'lowpass', 480, 0.9, 0.20 * m, 0.02, 0.3);
  }

  /** Hull-to-hull contact. Higher, harder, much shorter than a landing. */
  private playHit(now: number, mag01: number): void {
    const m = clamp(mag01, 0, 1);
    this.playBody(now, 'triangle', 400 + 220 * m, 95, 0.42 * (0.4 + 0.6 * m), 0.002, 0.12);
    this.playNoise(now, 'bandpass', 2600 + 900 * m, 2.4, 0.30 * m, 0.001, 0.06);
  }

  /**
   * Boost ignition: a noise band swept upward through two and a half decades.
   * The sweep is exponential because pitch perception is - a linear ramp over
   * the same range spends most of its time sounding like it has already arrived.
   */
  private playWhoosh(now: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || !this.takeVoice()) return;

    const dur = 0.5;
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    const span = Math.max(0, g.noise.duration - dur - 0.05);

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.7;
    band.frequency.setValueAtTime(280, now);
    band.frequency.exponentialRampToValueAtTime(5200, now + 0.42);

    const amp = ctx.createGain();
    envelope(amp.gain, now, 0.42, 0.07, 0.41);

    src.connect(band).connect(amp).connect(g.sfx);
    src.start(now, this.rng.next() * span);
    src.stop(now + dur);
    src.onended = () => {
      src.disconnect();
      band.disconnect();
      amp.disconnect();
      this.oneShots--;
    };

    // A short pitched swell underneath so the boost has a body, not just air.
    this.playBody(now, 'triangle', 180, 620, 0.16, 0.05, 0.3);
  }

  /**
   * Drift tier reached. Two partials a fifth apart with different decays, so the
   * chime has an attack that rings and a tail that sings - the tier index moves
   * it up the pentatonic figure, which is what makes tier three feel like a
   * reward rather than a repeat.
   */
  private playChime(now: number, tier: number): void {
    const f = TIER_PITCH[Math.min(tier, TIER_PITCH.length - 1)]!;
    const loud = 0.16 + 0.06 * tier;
    this.playBody(now, 'sine', f, f, loud, 0.004, 0.26 + 0.08 * tier);
    this.playBody(now + 0.012, 'sine', f * 1.5, f * 1.5, loud * 0.45, 0.004, 0.18);
  }

  /**
   * Start-light tone. A triangle for the body plus a square an octave up for the
   * edge, both through a lowpass whose corner is the "brightness" control - the
   * GO tone is the same voice with the filter simply opened.
   */
  private playHorn(now: number, freq: number, dur: number, peak: number, bright: number): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || !this.takeVoice()) return;

    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.value = freq;

    const edge = ctx.createOscillator();
    edge.type = 'square';
    edge.frequency.value = freq * 2;

    const edgeGain = ctx.createGain();
    edgeGain.gain.value = 0.22;

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = bright;
    tone.Q.value = 0.7;

    const amp = ctx.createGain();
    // Near-instant attack, flat hold, quick release: a lamp, not a bell.
    const rel = Math.min(0.18, dur * 0.5);
    amp.gain.setValueAtTime(1e-4, now);
    amp.gain.exponentialRampToValueAtTime(peak, now + 0.008);
    amp.gain.setValueAtTime(peak, now + dur - rel);
    amp.gain.exponentialRampToValueAtTime(1e-4, now + dur);

    body.connect(tone);
    edge.connect(edgeGain).connect(tone);
    tone.connect(amp).connect(g.sfx);

    body.start(now);
    edge.start(now);
    body.stop(now + dur + 0.02);
    edge.stop(now + dur + 0.02);
    body.onended = () => {
      body.disconnect();
      edge.disconnect();
      edgeGain.disconnect();
      tone.disconnect();
      amp.disconnect();
      this.oneShots--;
    };
  }

  // ---------------------------------------------------------------- control --

  get muted(): boolean { return this.isMuted; }

  /** Post-limiter gain the master node should sit at right now. */
  private masterTarget(): number {
    return this.isMuted ? 0 : MASTER_LEVEL * this.volume;
  }

  /** Ramped rather than switched - an instant gain step is an audible click. */
  setMuted(on: boolean): void {
    this.isMuted = on;
    this.applyMaster();
  }

  /**
   * Settings VOLUME, 0..1. Squared on the way in because a linear fader on a
   * gain reads as "everything happens in the top quarter of the slider" - equal
   * *loudness* steps need roughly equal steps in amplitude-squared.
   */
  setMasterVolume(v: number): void {
    this.volume = clamp(v, 0, 1) ** 2;
    this.applyMaster();
  }

  private applyMaster(): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    g.master.gain.setTargetAtTime(this.masterTarget(), ctx.currentTime, 0.02);
  }

  /** Tears the whole graph down. Not used by the game loop; here for the harness. */
  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.onGesture);
      window.removeEventListener('keydown', this.onKeyDown);
    }
    const ctx = this.ctx;
    const g = this.g;
    if (g) {
      g.engine.saw.stop();
      g.engine.pulse.stop();
      g.engine.sub.stop();
      g.engine.lfo.stop();
      g.water.src.stop();
      g.master.disconnect();
      g.clip.disconnect();
    }
    this.g = null;
    this.ctx = null;
    // An OfflineAudioContext (harness) has no `close()`; a real one does.
    const closable = ctx as unknown as { close?: () => Promise<void> } | null;
    if (closable?.close) void closable.close().catch(() => undefined);
  }
}
