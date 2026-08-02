import * as THREE from 'three';
import type { BoatState } from '../core/types';
import type { Rng } from '../core/Rng';
import { PALETTE } from '../core/Palette';
import { addOutlineRecursive } from '../render/OutlineHull';
import { buildRiderRig, type RiderRig } from './RiderRig';
import { RiderAnimator } from './RiderAnimator';

/**
 * A rider: skinned body, ink outline, and a procedural animator.
 *
 * USAGE
 *   const rider = new Rider({ index, color, rng });
 *   boat.riderMount.add(rider.root);
 *   // every frame, after the boat's physics has published its state:
 *   rider.update(dt, elapsed, boat.state, raceStatus.phase);
 *
 * The root's origin is the point *between the rider's feet*, +Z forward, so the
 * mount should sit where the rider stands on the deck. Nothing in here reads or
 * writes the boat - the hands find the steering yoke on their own (by name or
 * via `setYoke`) and everything else comes from `BoatState`.
 *
 * Four riders share one set of geometries; only the skeleton, the materials and
 * the animator state are per-rider.
 */

export interface RiderOptions {
  index: number;
  /** The racer's colour - the suit's field colour, and usually the helmet. */
  color: THREE.Color;
  /** Seeded per racer by the composition root; nothing here uses Math.random. */
  rng: Rng;
}

/** Ink is a touch thinner than the boats' - a small figure with a boat-weight
 *  line reads as a toy. 2.1px at any distance. */
const RIDER_INK_PX = 2.1;

/**
 * THERE IS NO STANCE OFFSET, AND THERE MUST NOT BE ONE AGAIN.
 *
 * This used to be 0.38 m of forward shove applied to the whole figure, because
 * the boat's mount and its yoke grips disagreed by 0.72 m and something had to
 * absorb it. It absorbed it visibly: the rider stood on the coaming rather than
 * in the footwell, and the arm chain had to be stretched to 0.546 m on top.
 *
 * `boat.riderMount` is now placed where a rider actually stands - soles on the
 * well floor, directly behind the steering column - and the grips are set from
 * that same measurement (see the SEAT_LOCAL block in BoatMesh). The rig's origin
 * goes on the mount, unmodified. If the hands ever miss the bars again, the
 * answer is in those two constants, not here.
 */
const STANCE_FORWARD = 0;

export class Rider {
  readonly index: number;
  readonly root: THREE.Object3D;
  /** Body triangles (the ink shell reuses the same geometry, so double it on screen). */
  readonly triangles: number;

  private readonly rig: RiderRig;
  private readonly anim: RiderAnimator;

  constructor(opts: RiderOptions) {
    this.index = opts.index;
    const rng = opts.rng;

    // Cast varies per racer so four riders never look like one model in four
    // colours. All draws come off the seeded RNG, so a given seed always
    // produces the same four people.
    // Keyed off the index rather than the RNG so four racers are guaranteed to
    // differ - a random draw can hand the whole grid the same face.
    const tones = [PALETTE.skinA, PALETTE.skinB, PALETTE.skinC];
    const skinTone = tones[opts.index % tones.length]!;
    // Half the grid wears a white lid; the rest match their hull.
    const helmetColor = opts.index % 2 === 0 ? opts.color : PALETTE.hullLight;
    // The trim yellow disappears against a tangerine suit, so a warm racer gets
    // the cool scarf instead. Checked against the colour, not against an index.
    const warmSuit = opts.color.r > 0.5 && opts.color.g > 0.15 && opts.color.b < 0.08;
    const scarfColor = warmSuit ? PALETTE.foam : PALETTE.hullTrim;

    this.rig = buildRiderRig({
      suitColor: opts.color,
      helmetColor,
      skinTone,
      scarfColor,
    });
    this.root = this.rig.root;
    this.root.name = `rider${opts.index}`;
    this.root.position.z = STANCE_FORWARD;
    this.triangles = this.rig.triangles;

    // Outline after the meshes are parented: the inverted hull is added as a
    // sibling of each mesh so it inherits the same skeleton and transform.
    addOutlineRecursive(this.root, {
      thickness: RIDER_INK_PX,
      color: PALETTE.ink,
      // Less world padding than a hull - on a 1.6m figure the boats' 4mm would
      // detach the line from the silhouette at close range.
      worldPad: 0.0022,
    });

    this.anim = new RiderAnimator(this.rig, rng, opts.index);
  }

  /**
   * Drive the pose. `state` is the boat's published physics state and `phase`
   * is the race phase ('countdown' coils the rider, 'finished'/'results' starts
   * the celebration loop).
   */
  update(dt: number, elapsed: number, state: BoatState, phase: string): void {
    this.anim.update(dt, elapsed, state, phase);
  }

  /**
   * Explicitly hand the animator the boat's yoke grips. Optional - the rider
   * finds objects named `*handleL/R` or `*gripL/R` (or tagged with
   * `userData.riderGrip = 'left' | 'right'`) under the boat by itself.
   */
  setYoke(left: THREE.Object3D | null, right: THREE.Object3D | null): void {
    this.anim.setYoke(left, right);
  }

  /** Materials are per-rider; the geometry is shared and must outlive them. */
  dispose(): void {
    for (const m of this.rig.materials) m.dispose();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && o.name.endsWith('_ink')) (mesh.material as THREE.Material).dispose();
    });
  }
}
