/**
 * One-off / CI-style asserts for strip hit predicate.
 * Run: npx tsx scripts/assert-aim-hit.mts
 */
import {
  aimQuality,
  outerPlateAimTarget,
  plateAimCenter,
} from '../src/game/sim';
import { PLATE_HALF_AIM, PLATE_HIT_SCALE } from '../src/game/types';

const hitHalf = PLATE_HALF_AIM * PLATE_HIT_SCALE;
const n = 8;
const lean = 0;
const outer = outerPlateAimTarget(n, lean);
const leftRim = outer - hitHalf;
const rightRim = outer + hitHalf;

function must(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok:', msg);
}

// Aim at -1.0 with plates ending ~+0.85 must miss (Mario: left of bar)
must(aimQuality(-1, n, lean) === 0, 'aim -1.0 → miss');
must(aimQuality(-0.7, n, lean) === 0, 'aim -0.7 (left of bar) → miss');
must(aimQuality(0, n, lean) === 0, 'aim center → miss');
must(aimQuality(0.5, n, lean) === 0, 'aim through INNER plates (left of outer) → miss');
must(aimQuality(leftRim - 0.01, n, lean) === 0, 'just left of outer left-rim → miss');
must(aimQuality(outer, n, lean) > 0.32, 'aim through outer center → chip');
must(aimQuality(rightRim + 0.01, n, lean) === 0, 'past outer right-rim → miss');
must(aimQuality(1, n, lean) === 0, 'aim +1 past bar → miss');
// Same for side B arg (POV does not flip hit space)
must(aimQuality(-1, n, lean, 'B') === 0, 'B: aim -1 → miss');
must(aimQuality(outer, n, lean, 'B') > 0.32, 'B: outer → chip');

console.log('All aim-hit asserts passed. outer=', outer, 'rims', leftRim, rightRim);
