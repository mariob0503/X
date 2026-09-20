export type Role = 'host' | 'playerB' | 'display' | 'solo';

export type Phase =
  | 'lobby'
  | 'countdown'
  | 'playing'
  | 'roundOver'
  | 'matchOver';

export interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

export type Advantage = 'A' | 'B' | 'EVEN';

export interface GameState {
  phase: Phase;
  /** Kept for wire compat / soft lane bias; win is finish shot, not end-line. */
  position: number;
  /** Derived lean proxy (synced from plates); visual lean uses leanFromPlates(). */
  spin: number;
  velocity: number;
  /** Plate mass on A's stack (sum of per-plate health 0..1, chips of 0.25). */
  platesA: number;
  /** Plate mass on B's stack. */
  platesB: number;
  scoreA: number;
  scoreB: number;
  round: number;
  timeLeft: number;
  countdown: number;
  lastHitQuality: number;
  lastHitSide: 'A' | 'B' | null;
  /** Aim offset of last hit [-1,1] — maps to target on foe stack / body. */
  lastHitOffset: number;
  hitSeq: number;
  /** Last hit missed (edge / weak). */
  lastMiss: boolean;
  /** Last hit was a successful strip. */
  lastStrip: boolean;
  /** Plates stripped on last hit. */
  lastStripAmt: number;
  /** Last hit was a successful finish shot. */
  lastFinish: boolean;
  lastEvent: string;
  winner: 'A' | 'B' | null;
  /** Set only on a landed FINISH; null on time-up draw. */
  roundWinner: 'A' | 'B' | null;
  sparks: Spark[];
  roomCode: string;
  connectedB: boolean;
  connectedDisplay: boolean;
  aiEnabled: boolean;
  aiPressure: number;
  tick: number;
  /** FINISH unlocked when foe plates ≈ 0, or lean > 45° in someone's favor. */
  finishReady: boolean;
  /** Who the lean favors (heavier / tipping toward). */
  finishFavors: 'A' | 'B' | null;
  /** Seconds lean has been past finish threshold. */
  finishHold: number;
  coolA: number;
  coolB: number;
  stunA: number;
  stunB: number;
  advantage: Advantage;
  /** -1..+1 continuous (A positive = A heavier / tipping toward A). */
  advantageScore: number;
  coachTip: string;
  /** True while the +15s overtime period is running. */
  overtimeActive: boolean;
  /** True after overtime has already been granted this round (one OT max). */
  overtimeUsed: boolean;
}

export type NetMessage =
  | { type: 'hello'; role: 'playerB' | 'display'; name?: string }
  | { type: 'welcome'; role: 'playerB' | 'display' }
  | { type: 'hit'; side: 'A' | 'B'; offset: number; t: number }
  | { type: 'aim'; side: 'A' | 'B'; offset: number }
  | { type: 'ready' }
  | { type: 'start' }
  | { type: 'rematch' }
  | { type: 'state'; state: GameState }
  | { type: 'ping'; t: number }
  | { type: 'pong'; t: number };

/** Target ~30–45s contested strip rounds. */
export const ROUND_SECONDS = 45;
export const BEST_OF = 3;
export const WIN_SCORE = 2;
/** Both sides start fully loaded. */
export const START_PLATES = 8;
export const MAX_PLATES = 8;
/** Absolute visual lean at full one-sided stack (radians). */
export const MAX_LEAN_RAD = Math.PI * 0.42; // ~75°
/** FINISH unlock: absolute lean beyond 45°. */
export const FINISH_LEAN_RAD = Math.PI / 4;
/** Brief hold before FINISH unlocks (stops flicker). */
export const FINISH_HOLD_SEC = 0.35;
/** |offset| within this in FINISH mode = body hit / win. */
export const FINISH_BODY_ZONE = 0.38;
/** Quality below this → miss (no strip). */
export const MISS_QUALITY = 0.32;
/**
 * Aim column span: screenX = w/2 + aim * w * AIM_RANGE.
 * Must match ArenaRenderer.aimColumnX.
 */
export const AIM_RANGE = 0.42;
/**
 * Barbell plate geometry in aim-offset units (screenX = w/2 + aim * w * AIM_RANGE).
 * Visual radius and hit half-width share PLATE_HALF_AIM so WYSIWYG holds.
 * Collar→outermost must stay within |aim| ≤ ~0.95 so every plate is reachable.
 */
export const PLATE_COLLAR_AIM = 0.36;
export const PLATE_STEP_AIM = 0.07;
/** Half-width of a plate disc in aim units — BOTH draw radius and hit tolerance. */
export const PLATE_HALF_AIM = 0.068; // visual plate half-width in aim units // draw rx + hit half; outer+half must stay < 1
/** @deprecated alias */
/** Hit half-width as fraction of visual (slightly tighter than draw). */
export const PLATE_HIT_SCALE = 0.8;
export const PLATE_HIT_HALF = PLATE_HALF_AIM * PLATE_HIT_SCALE;
/** @deprecated Use plate-geometry hit test; kept as approximate collar. */
export const OUTER_PLATE_AIM = PLATE_COLLAR_AIM - PLATE_HALF_AIM;
/** Each successful strip chips exactly 25% of one plate (50% in overtime). */
export const PLATE_CHIP = 0.25;
/** One overtime period after regulation: +15s, double chip power. */
export const OVERTIME_SECONDS = 15;
/** Hit spam prevention — accuracy required. */
export const HIT_COOLDOWN = 0.62;
/** Short stun on extreme miss (minor, not round-end). */
export const STUN_SEC = 0.55;
export const PEER_PREFIX = 'bfit24-pr-';

export const COLOR_A = '#06E113';
export const COLOR_B = '#4DA3FF';

/** Legacy aliases so older wire clients don't explode on missing consts. */
export const LEAN_SCALE = 0.28;
export const TIP_LEAN_RAD = FINISH_LEAN_RAD;
