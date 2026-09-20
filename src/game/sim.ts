import {
  AIM_RANGE,
  FINISH_BODY_ZONE,
  FINISH_HOLD_SEC,
  FINISH_LEAN_RAD,
  GameState,
  HIT_COOLDOWN,
  MAX_LEAN_RAD,
  MAX_PLATES,
  MISS_QUALITY,
  OVERTIME_SECONDS,
  OUTER_PLATE_AIM,
  PLATE_CHIP,
  PLATE_COLLAR_AIM,
  PLATE_HALF_AIM,
  PLATE_HIT_HALF,
  PLATE_HIT_SCALE,
  PLATE_STEP_AIM,
  ROUND_SECONDS,
  Spark,
  START_PLATES,
  STUN_SEC,
  WIN_SCORE,
} from './types';

export {
  AIM_RANGE,
  OUTER_PLATE_AIM,
  OVERTIME_SECONDS,
  PLATE_CHIP,
  PLATE_COLLAR_AIM,
  PLATE_HALF_AIM,
  PLATE_HIT_HALF,
  PLATE_HIT_SCALE,
  PLATE_STEP_AIM,
};

const COACH_TIPS = [
  'Drag yourself · tap FIRE · only OUTER plates chip.',
  'Each clean outer hit chips 25% of one plate. Four = gone.',
  'Center shots miss while they have plates — slide to the sides.',
  'Strip them bare ⇒ slide to CENTER and FINISH.',
  'Lean past 45° opens FINISH — you still must FIRE the body shot to win.',
  'Only a FINISH shot wins — OT then draw if time runs out. Best of 3.',
];

export function createInitialState(roomCode: string, aiEnabled = false): GameState {
  return {
    phase: 'lobby',
    position: 0,
    spin: 0,
    velocity: 0,
    platesA: START_PLATES,
    platesB: START_PLATES,
    scoreA: 0,
    scoreB: 0,
    round: 1,
    timeLeft: ROUND_SECONDS,
    countdown: 3,
    lastHitQuality: 0,
    lastHitSide: null,
    lastHitOffset: 0,
    hitSeq: 0,
    lastMiss: false,
    lastStrip: false,
    lastStripAmt: 0,
    lastFinish: false,
    lastEvent: 'Waiting…',
    winner: null,
    roundWinner: null,
    sparks: [],
    roomCode,
    connectedB: aiEnabled,
    connectedDisplay: false,
    aiEnabled,
    aiPressure: 0.12,
    tick: 0,
    finishReady: false,
    finishFavors: null,
    finishHold: 0,
    coolA: 0,
    coolB: 0,
    stunA: 0,
    stunB: 0,
    advantage: 'EVEN',
    advantageScore: 0,
    coachTip: 'Drag · FIRE · outer plates · bare → center FINISH.',
    overtimeActive: false,
    overtimeUsed: false,
  };
}

/** Visual lean (radians). A heavier → negative (A/left end down). */
export function leanFromPlates(state: GameState): number {
  const diff = (state.platesA - state.platesB) / MAX_PLATES;
  return Math.max(-MAX_LEAN_RAD, Math.min(MAX_LEAN_RAD, -diff * MAX_LEAN_RAD));
}

/** Alias used by AI. */
export function leanAngle(state: GameState): number {
  return leanFromPlates(state);
}

export function leanDegrees(state: GameState): number {
  return (leanFromPlates(state) * 180) / Math.PI;
}

export function syncLeanProxy(state: GameState): void {
  state.spin = leanFromPlates(state) / 0.28;
}

function foeOf(side: 'A' | 'B'): 'A' | 'B' {
  return side === 'A' ? 'B' : 'A';
}

function getPlates(state: GameState, side: 'A' | 'B'): number {
  return side === 'A' ? state.platesA : state.platesB;
}

function setPlates(state: GameState, side: 'A' | 'B', v: number): void {
  const q = quantizePlates(v);
  if (side === 'A') state.platesA = q;
  else state.platesB = q;
}

export function canHit(state: GameState, side: 'A' | 'B'): boolean {
  if (state.phase !== 'playing') return false;
  if (side === 'A') return state.coolA <= 0 && state.stunA <= 0;
  return state.coolB <= 0 && state.stunB <= 0;
}

function setCool(state: GameState, side: 'A' | 'B'): void {
  if (side === 'A') state.coolA = HIT_COOLDOWN;
  else state.coolB = HIT_COOLDOWN;
}

export function cooldownLeft(state: GameState, side: 'A' | 'B'): number {
  return side === 'A'
    ? Math.max(state.coolA, state.stunA)
    : Math.max(state.coolB, state.stunB);
}

export function refreshFinishFlags(state: GameState): void {
  if (state.platesB <= 0.01 && state.platesA > 0.01) {
    state.finishReady = true;
    state.finishFavors = 'A';
    return;
  }
  if (state.platesA <= 0.01 && state.platesB > 0.01) {
    state.finishReady = true;
    state.finishFavors = 'B';
    return;
  }
  const lean = leanFromPlates(state);
  if (Math.abs(lean) > FINISH_LEAN_RAD && state.finishHold >= FINISH_HOLD_SEC) {
    state.finishReady = true;
    state.finishFavors = lean < 0 ? 'A' : 'B';
  } else {
    state.finishReady = false;
    state.finishFavors = null;
  }
}

/** @deprecated tip alias */
export function refreshTipFlags(state: GameState): void {
  refreshFinishFlags(state);
}

export function computeAdvantage(state: GameState): void {
  const plateDiff = (state.platesA - state.platesB) / MAX_PLATES;
  const lean = leanFromPlates(state);
  const leanNorm = Math.min(1, Math.abs(lean) / FINISH_LEAN_RAD);
  let score = plateDiff * 0.85;
  if (Math.abs(lean) > 0.08) score += (lean < 0 ? 1 : -1) * leanNorm * 0.2;
  if (state.finishReady && state.finishFavors === 'A') score += 0.12;
  if (state.finishReady && state.finishFavors === 'B') score -= 0.12;
  state.advantageScore = Math.max(-1, Math.min(1, score));
  if (state.advantageScore > 0.1) state.advantage = 'A';
  else if (state.advantageScore < -0.1) state.advantage = 'B';
  else state.advantage = 'EVEN';
}

export function spawnSparks(
  state: GameState,
  x: number,
  y: number,
  n: number,
  color: string
): void {
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = 0.4 + Math.random() * 1.2;
    state.sparks.push({
      x,
      y,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd - 0.5,
      life: 0.35 + Math.random() * 0.45,
      color,
    });
  }
}

function maybeCoach(state: GameState, force?: string): void {
  if (force) {
    state.coachTip = force;
    return;
  }
  if (state.finishReady && state.finishFavors) {
    state.coachTip =
      state.finishFavors === 'A'
        ? 'FINISH — A aims at B’s body!'
        : 'FINISH — B aims at A’s body!';
    return;
  }
  if (state.overtimeActive) {
    state.coachTip = 'OVERTIME — double chips! Still need a FINISH to win.';
    return;
  }
  const lean = leanFromPlates(state);
  if (Math.abs(lean) > FINISH_LEAN_RAD * 0.75) {
    state.coachTip = 'Bar tipping — FINISH unlocking… FIRE at body when ready.';
    return;
  }
  if (state.tick % 200 === 0) {
    state.coachTip = COACH_TIPS[(Math.random() * COACH_TIPS.length) | 0];
  }
}

/**
 * Shared plate geometry (sim hit test + render draw must stay identical).
 *
 * Aim space: -1 = screen left, +1 = screen right.
 * screenX = canvasW/2 + aim * canvasW * AIM_RANGE
 *
 * IMPORTANT — both POVs draw the FOE on the RIGHT and YOU on the LEFT
 * (viewSide B swaps which color/count sits on each end). Therefore strip
 * hits always test the RIGHT-hand OUTERMOST plate in aim space.
 *
 * Only the OUTER plate chips. Aim through inner plates / left of outer
 * left-rim / right of outer right-rim / left of bar → MISS.
 * No nearest-plate snap, no half-plane, no clamping aim into the stack.
 *
 * // Assert: aimQuality(-1, 8, 0) === 0           (left of bar → miss)
 * // Assert: aimQuality(0.5, 8, 0) === 0          (inner stack, left of outer → miss)
 * // Assert: aimQuality(outerCenter, 8, 0) > 0    (through outer → chip)
 * // Assert: aimQuality(outerRim+0.02, 8, 0) === 0 (past outer rim → miss)
 */
export function plateLocalAim(indexFromCollar: number): number {
  return PLATE_COLLAR_AIM + indexFromCollar * PLATE_STEP_AIM;
}

/** Plate center in aim space after lean (matches canvas rotate projection). */
export function plateScreenAim(localAim: number, leanRad: number): number {
  const cos = Math.max(0.35, Math.abs(Math.cos(leanRad)));
  return localAim * cos;
}

/**
 * Aim-space center of plate i on a given bar end.
 * endDir: -1 = left stack (YOU), +1 = right stack (FOE) in screen/aim space.
 */
export function plateAimCenter(
  indexFromCollar: number,
  endDir: -1 | 1,
  leanRad: number
): number {
  return endDir * plateScreenAim(plateLocalAim(indexFromCollar), leanRad);
}

/**
 * Pixel X of plate center relative to bar center — same space as aimColumnX delta.
 * Draw (inside rotate) uses local aim * span; hit uses this after lean projection.
 */
export function plateScreenX(
  indexFromCollar: number,
  endDir: -1 | 1,
  leanRad: number,
  canvasW: number
): number {
  return plateAimCenter(indexFromCollar, endDir, leanRad) * canvasW * AIM_RANGE;
}

/** Preferred aim to hit foe's outermost plate (always on the RIGHT / +). */
export function outerPlateAimTarget(foePlates: number, leanRad = 0): number {
  const n = Math.max(1, Math.ceil(Math.max(0, foePlates) - 1e-9));
  return plateAimCenter(n - 1, 1, leanRad);
}

/**
 * Strip quality — chip IFF vertical aim column intersects the FOE OUTERMOST
 * plate disc (same centers as draw). Hit half = 80% of visual half.
 */
export function aimQuality(
  offset: number,
  foePlates = MAX_PLATES,
  leanRad = 0,
  _side?: 'A' | 'B'
): number {
  const a = Math.max(-1, Math.min(1, offset));
  const n = Math.max(0, Math.ceil(Math.max(0, foePlates) - 1e-9));
  if (n <= 0) return 0;

  const FOE_END: -1 | 1 = 1;
  const hitHalf = PLATE_HALF_AIM * PLATE_HIT_SCALE;
  const c = plateAimCenter(n - 1, FOE_END, leanRad);
  const leftRim = c - hitHalf;
  const rightRim = c + hitHalf;

  // Left of outer plate, right of outer plate, or own half → miss
  if (a < leftRim || a > rightRim) return 0;
  if (a < 0) return 0;

  const dist = Math.abs(a - c);
  if (dist > hitHalf) return 0;
  // Full-quality on center; still above MISS_QUALITY at the rim
  return 0.55 + 0.45 * (1 - dist / hitHalf);
}

/** 25% normally, 50% in overtime. */
export function stripAmount(quality: number, overtime = false): number {
  if (quality < MISS_QUALITY) return 0;
  return overtime ? PLATE_CHIP * 2 : PLATE_CHIP;
}

export function quantizePlates(n: number): number {
  return Math.max(0, Math.min(MAX_PLATES, Math.round(n / PLATE_CHIP) * PLATE_CHIP));
}

export function applyHit(state: GameState, side: 'A' | 'B', offset: number): void {
  if (state.phase !== 'playing') return;
  if (!canHit(state, side)) return;

  const clamped = Math.max(-1, Math.min(1, offset));
  const foe = foeOf(side);
  const foePlates = getPlates(state, foe);
  const lean = leanFromPlates(state);
  const quality = aimQuality(clamped, foePlates, lean, side);

  setCool(state, side);
  state.lastHitSide = side;
  state.lastHitQuality = quality;
  state.lastHitOffset = clamped;
  state.hitSeq += 1;
  state.lastMiss = false;
  state.lastStrip = false;
  state.lastStripAmt = 0;
  state.lastFinish = false;

  refreshFinishFlags(state);

  if (state.finishReady && state.finishFavors === side) {
    if (Math.abs(clamped) <= FINISH_BODY_ZONE) {
      state.lastFinish = true;
      state.lastEvent = `${side === 'A' ? 'Player A' : 'Player B'} FINISHES IT!`;
      spawnSparks(state, 0.5 + clamped * 0.12, foe === 'A' ? 0.82 : 0.18, 28, '#06E113');
      endRound(state, side);
      syncLeanProxy(state);
      computeAdvantage(state);
      return;
    }
    state.lastMiss = true;
    if (side === 'A') state.stunA = STUN_SEC * 0.6;
    else state.stunB = STUN_SEC * 0.6;
    state.lastEvent = `${side} misses the FINISH — aim at their body!`;
    spawnSparks(state, 0.5 + clamped * 0.2, foe === 'A' ? 0.82 : 0.18, 10, '#ffcc33');
    maybeCoach(state, 'FINISH — drag to CENTER, then FIRE at their body!');
    syncLeanProxy(state);
    computeAdvantage(state);
    return;
  }

  const amt = stripAmount(quality, state.overtimeActive);
  if (amt <= 0) {
    state.lastMiss = true;
    if (Math.abs(clamped) <= 0.28) {
      if (side === 'A') state.stunA = STUN_SEC;
      else state.stunB = STUN_SEC;
    }
    state.lastEvent = `${side} MISSES — hit an OUTER plate!`;
    spawnSparks(state, 0.5 + clamped * 0.18, foe === 'A' ? 0.78 : 0.22, 8, '#ffcc33');
    maybeCoach(state, 'Only OUTER plates chip — drag onto a plate, then FIRE.');
    syncLeanProxy(state);
    computeAdvantage(state);
    return;
  }

  const before = getPlates(state, foe);
  const after = quantizePlates(before - amt);
  const stripped = Math.max(0, before - after);
  setPlates(state, foe, after);
  state.lastStrip = stripped > 0.01;
  state.lastStripAmt = stripped;

  if (stripped > 0.01) {
    const gone =
      after < before &&
      Math.abs(after - Math.floor(after + 1e-9)) < 1e-9 &&
      stripped >= PLATE_CHIP - 1e-9;
    const pct = Math.round(stripped * 100);
    const ot = state.overtimeActive ? ' (OT×2)' : '';
    state.lastEvent = gone
      ? `${side} knocks a plate off ${foe} (−${pct}%${ot})`
      : `${side} chips ${foe}'s plate (−${pct}%${ot})`;
    spawnSparks(
      state,
      0.5 + clamped * 0.38,
      foe === 'A' ? 0.78 : 0.22,
      10,
      side === 'A' ? '#06E113' : '#4DA3FF'
    );
    if (after <= 0.01) {
      maybeCoach(state, 'They’re BARE — drag to CENTER and FIRE to FINISH!');
    } else {
      maybeCoach(
        state,
        quality >= 0.75
          ? 'Clean outer-plate chip! Stay on the plates.'
          : 'Aim the dashed line through an outer plate, then FIRE.'
      );
    }
  } else {
    state.lastMiss = true;
    state.lastEvent = `${side} glances — no chip.`;
  }

  syncLeanProxy(state);
  refreshFinishFlags(state);
  computeAdvantage(state);
}

export function startCountdown(state: GameState): void {
  state.phase = 'countdown';
  state.countdown = 3;
  state.position = 0;
  state.velocity = 0;
  state.platesA = START_PLATES;
  state.platesB = START_PLATES;
  state.timeLeft = ROUND_SECONDS;
  state.roundWinner = null;
  state.lastEvent = 'Get ready…';
  state.sparks = [];
  state.lastMiss = false;
  state.lastStrip = false;
  state.lastStripAmt = 0;
  state.lastFinish = false;
  state.lastHitSide = null;
  state.finishHold = 0;
  state.coolA = 0;
  state.coolB = 0;
  state.stunA = 0;
  state.stunB = 0;
  state.coachTip = 'Drag · FIRE · outer plates · bare → center FINISH.';
  state.advantage = 'EVEN';
  state.advantageScore = 0;
  state.overtimeActive = false;
  state.overtimeUsed = false;
  syncLeanProxy(state);
  refreshFinishFlags(state);
  computeAdvantage(state);
}

export function beginPlaying(state: GameState): void {
  state.phase = 'playing';
  state.lastEvent = 'GO! Strip their stack!';
  maybeCoach(state, 'Drag yourself · FIRE at outer plates!');
}

function endRound(state: GameState, winner: 'A' | 'B'): void {
  if (!state.lastFinish) {
    state.lastEvent = 'No FINISH landed — round continues.';
    return;
  }
  state.phase = 'roundOver';
  state.roundWinner = winner;
  state.overtimeActive = false;
  if (winner === 'A') state.scoreA += 1;
  else state.scoreB += 1;
  state.lastEvent = `${winner === 'A' ? 'Player A' : 'Player B'} wins — FINISH hit!`;
  state.velocity = 0;
  syncLeanProxy(state);
  refreshFinishFlags(state);
  computeAdvantage(state);

  if (state.scoreA >= WIN_SCORE || state.scoreB >= WIN_SCORE) {
    state.phase = 'matchOver';
    state.winner = state.scoreA > state.scoreB ? 'A' : 'B';
    state.lastEvent =
      state.winner === 'A'
        ? 'Match over — Player A wins (FINISH)!'
        : 'Match over — Player B wins (FINISH)!';
  }
}

function endRoundTimeUp(state: GameState): void {
  state.phase = 'roundOver';
  state.roundWinner = null;
  state.winner = null;
  state.lastFinish = false;
  state.overtimeActive = false;
  state.lastEvent = 'TIME UP — no FINISH landed. No winner this round.';
  state.velocity = 0;
  syncLeanProxy(state);
  refreshFinishFlags(state);
  computeAdvantage(state);
}

export function nextRound(state: GameState): void {
  if (state.phase === 'matchOver') {
    state.scoreA = 0;
    state.scoreB = 0;
    state.round = 1;
    state.winner = null;
  } else {
    state.round += 1;
  }
  startCountdown(state);
}

export function step(state: GameState, dt: number): void {
  state.tick += 1;
  const sparks: Spark[] = [];
  for (const s of state.sparks) {
    s.life -= dt;
    s.x += s.vx * dt * 0.15;
    s.y += s.vy * dt * 0.15;
    s.vy += dt * 1.2;
    if (s.life > 0) sparks.push(s);
  }
  state.sparks = sparks;

  if (state.coolA > 0) state.coolA = Math.max(0, state.coolA - dt);
  if (state.coolB > 0) state.coolB = Math.max(0, state.coolB - dt);
  if (state.stunA > 0) state.stunA = Math.max(0, state.stunA - dt);
  if (state.stunB > 0) state.stunB = Math.max(0, state.stunB - dt);

  if (state.phase === 'countdown') {
    state.countdown -= dt;
    if (state.countdown <= 0) beginPlaying(state);
    return;
  }

  if (state.phase !== 'playing') return;

  state.timeLeft -= dt;
  if (state.aiEnabled) {
    const progress = 1 - state.timeLeft / Math.max(1, ROUND_SECONDS);
    state.aiPressure = 0.12 + Math.min(1, Math.max(0, progress)) * 0.55;
  }

  const lean = leanFromPlates(state);
  if (Math.abs(lean) > FINISH_LEAN_RAD) state.finishHold += dt;
  else state.finishHold = Math.max(0, state.finishHold - dt * 2.2);

  state.position = Math.max(
    -0.35,
    Math.min(0.35, ((state.platesA - state.platesB) / MAX_PLATES) * 0.25)
  );

  syncLeanProxy(state);
  refreshFinishFlags(state);
  computeAdvantage(state);
  maybeCoach(state);

  if (state.timeLeft <= 0) {
    state.timeLeft = 0;
    if (!state.overtimeUsed) {
      state.overtimeUsed = true;
      state.overtimeActive = true;
      state.timeLeft = OVERTIME_SECONDS;
      state.lastEvent = 'OVERTIME +15s — double chip power!';
      maybeCoach(state, 'OVERTIME! Chips hit 2× hard — still need a FINISH to win.');
    } else {
      state.overtimeActive = false;
      endRoundTimeUp(state);
    }
  }
}

export function cloneState(state: GameState): GameState {
  return { ...state, sparks: state.sparks.map((s) => ({ ...s })) };
}
