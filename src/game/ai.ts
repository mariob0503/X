import { applyHit, leanAngle, outerPlateAimTarget } from './sim';
import type { GameState } from './types';
import { FINISH_BODY_ZONE, FINISH_LEAN_RAD, PLATE_HALF_AIM } from './types';

/** Human-paced AI: prefers OUTER strip columns; FINISH still aims center/body. */
export function updateAI(state: GameState, dt: number, acc: { t: number }): void {
  if (!state.aiEnabled || state.phase !== 'playing') return;
  if (state.stunB > 0 || state.coolB > 0) return;

  acc.t -= dt;
  if (acc.t > 0) return;

  const p = state.aiPressure;
  // Slower cadence — not machine-gun (~0.75–1.4s)
  acc.t = 0.9 - p * 0.22 + Math.random() * (0.55 - p * 0.12);

  // FINISH when lean favors B — still aim near body (center)
  if (state.finishReady && state.finishFavors === 'B') {
    const aim = (Math.random() - 0.5) * FINISH_BODY_ZONE * (1.6 - p * 0.5);
    applyHit(state, 'B', aim);
    return;
  }

  // Foe plates are drawn on the RIGHT for both POVs — aim +.
  const lean = leanAngle(state);
  const target = outerPlateAimTarget(state.platesA, lean); // positive
  let aim = target + (Math.random() - 0.5) * PLATE_HALF_AIM * 0.5;

  if (state.platesB < state.platesA - 0.8) {
    aim = Math.max(aim, target);
  }
  if (lean < -FINISH_LEAN_RAD * 0.7) {
    aim = Math.max(aim, target);
  }

  // Occasional human error drifts toward center (weaker / miss)
  if (Math.random() > 0.78 + p * 0.15) {
    aim *= 0.35 + Math.random() * 0.25;
  }

  applyHit(state, 'B', Math.max(-1, Math.min(1, aim)));
}
