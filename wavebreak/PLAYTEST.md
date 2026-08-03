# WAVEBREAK playtest checklist

Three things about this game cannot be verified from a headless container, and they are
exactly the three that decide whether it is fun:

1. **Frame rate on real hardware.** Every performance number in this repo came from either
   a CPU-side timer or SwiftShader, a software rasteriser. Neither says anything about a GPU.
2. **Whether the audio sounds good.** 21 numeric assertions pass — no clipping, engine pitch
   rises monotonically with RPM, water rush scales with speed. None of that is the same as
   it sounding like a boat.
3. **Whether the handling feels right.** No measurement tells you whether a powerslide is
   satisfying.

This should take about five minutes. Please note anything that feels wrong even if you
can't say why — "the boat feels floaty in the hairpin" is a usable defect report; I can turn
it into numbers from there.

```bash
npm install && npm run dev
```

---

## 1. Frame rate — 60 seconds

Press **F3** (or load with `?debug`) for the perf overlay, top right.

- **GPU ms** is the number that matters. Under 16.7 means you have headroom at 60fps. The
  dashed green line on the graph *is* 16.7ms — the only question is whether the traces stay
  under it.
- Coral trace = GPU, cyan = CPU. If GPU is high and CPU is low, the shaders are the cost;
  the reverse means the simulation is.
- `res scale` below 1.00 means the adaptive scaler has already backed off to protect the
  frame rate — worth knowing, because it trades sharpness silently.

Drive a full lap watching it. **Please report: GPU ms cruising, GPU ms in the pack at the
start, and whether `res scale` ever drops.** Resize the window large and check again — this
renderer is fill-rate bound, so a full-screen retina window is the worst case.

> If GPU timing shows "unavailable", your browser lacks
> `EXT_disjoint_timer_query_webgl2`. Chrome has it; Safari does not.

## 2. Audio — 60 seconds

Click once first (browsers block audio until a gesture). **M** mutes.

- **Engine.** Does it read as a motor, or as a synth tone? It should get harder-edged under
  load and thinner when you lift.
- **Airtime.** Launch off a crest. The engine should audibly free-rev and thin out — that
  contrast is the whole point.
- **Landing.** Does the thud have weight, or is it a click?
- **Drift and boost.** Hold drift: a resonant band should swell. Boost: a whoosh, then hiss.
- **Start horn.** Three beeps and a brighter GO.
- **Mix.** Is anything drowning anything else? Is the water rush too loud at speed?

## 3. Handling — 3 minutes

This is the important one. Drive two or three laps.

- **Does the boat fight the water?** It should pitch and roll with the wave it's on, bog
  down slamming into a trough, then climb out. If it feels like it's sliding on glass, that
  is the single biggest thing to tell me.
- **Steering.** Most agile at mid speed, heavier at the top end, near-useless in the air.
  Does that read, or does it just feel vague?
- **The powerslide.** Hold `Space` into the hairpin. Is there a clean *breakaway* — a moment
  where grip lets go and the boat rotates — or does it mush? Releasing should bank charge.
- **Boost.** Does spending it feel earned and worth the drift that paid for it?
- **Airtime.** Land flat or nose-high and you should be punished. Land nose-down and you
  should carry speed. Is that legible while playing, or invisible?
- **The AI.** Vex brakes late and leans on you; Nori runs a tight, clean line; Gus is wide
  and erratic. Measured over a lap they do differ (avg lateral offset 2.72 / 2.31 / 2.77 m
  against your 1.70). **Can you actually tell them apart while racing?** If not, the
  difference is real but not legible, which is its own defect.
- **Difficulty.** Do you win by miles, lose by a lap, or is it close?

## 4. Anything else

- Press **Esc** — pause, settings, resume. Change resolution and glow; both should visibly
  change the picture.
- Alt-tab away mid-race. It should pause itself.
- Finish a race and look at the results screen.
- Resize the window mid-race; nothing should break.

---

## Known-short list — no need to report these

Already measured and on the list, so don't spend attention on them:

- The fresh near-wake immediately behind the transom is still one merged mass; the
  mid-distance ribbon has better shape language than the near field.
- One or two spray droplets over white foam read as pale rings rather than commas.
- The sun and its stylised flare sit outside every gameplay camera angle.
- Rider limbs are smooth tapered tubes; the hands are geometric.
- Only one circuit exists.
