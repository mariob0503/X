import {
  AIM_RANGE,
  COLOR_A,
  COLOR_B,
  FINISH_LEAN_RAD,
  GameState,
  MAX_PLATES,
  PLATE_COLLAR_AIM,
  PLATE_HALF_AIM,
  PLATE_STEP_AIM,
} from './types';
import { leanFromPlates, plateLocalAim } from './sim';

const GREEN = COLOR_A;
const BLUE = COLOR_B;

/** Who is at the bottom of the screen. Spectator = A bottom / B top, labeled. */
export type ViewSide = 'A' | 'B' | 'spectator';

export class ArenaRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  logo: HTMLImageElement;
  logoReady = false;
  displayMode = false;
  /** Local player POV: 'A' or 'B' keeps YOU at bottom. 'spectator' = A bottom, B top. */
  viewSide: ViewSide = 'A';
  /** Opponent ghost hit flash 0..1 */
  opponentFlash = 0;
  opponentOffset = 0;
  /** Local player horizontal aim [-1,1] — moves bottom avatar. */
  localAimOffset = 0;
  /** FINISH kill blast 1→0 on the defeated player. */
  finishBoom = 0;
  /** Which side got finished (defeated). */
  finishBoomSide: 'A' | 'B' | null = null;
  /** POV presentation: win = green FINISHED, lose = red YOU LOSE. */
  finishBoomTone: 'win' | 'lose' = 'win';
  /** performance.now() when boom should end (3s). */
  finishBoomUntil = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2d context');
    this.ctx = ctx;
    this.logo = new Image();
    this.logo.onload = () => {
      this.logoReady = true;
    };
    this.logo.src = './bfit24-logo.svg';
  }

  /** Start a big 3s explosion on the defeated player after a FINISH lands. */
  triggerFinishBoom(defeated: 'A' | 'B', tone: 'win' | 'lose' = 'win'): void {
    this.finishBoom = 1;
    this.finishBoomSide = defeated;
    this.finishBoomTone = tone;
    this.finishBoomUntil = performance.now() + 3000;
  }

  /** True while the FINISH explosion is still playing. */
  get finishBoomActive(): boolean {
    return this.finishBoomUntil > 0 && performance.now() < this.finishBoomUntil;
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  zoneLabels(): { bottom: 'A' | 'B'; top: 'A' | 'B' } {
    if (this.viewSide === 'B') return { bottom: 'B', top: 'A' };
    return { bottom: 'A', top: 'B' };
  }

  /** Screen lean: positive = clockwise on screen. */
  viewLean(state: GameState): number {
    const lean = leanFromPlates(state);
    return this.viewSide === 'B' ? -lean : lean;
  }

  barScreenPos(state: GameState): { x: number; y: number } {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const laneTop = h * 0.3;
    const laneBot = h * 0.62;
    const midY = (laneTop + laneBot) / 2;
    // Soft vertical bias from plate lead
    const bias =
      this.viewSide === 'B'
        ? -(state.platesA - state.platesB) / MAX_PLATES
        : (state.platesA - state.platesB) / MAX_PLATES;
    return { x: w * 0.5, y: midY - bias * 18 };
  }

  /**
   * Screen column for aim offset [-1,1]. Launch and impact share this X
   * so the shot travels in one vertical column.
   */
  aimColumnX(offset: number): number {
    const w = this.canvas.clientWidth;
    const clamped = Math.max(-1, Math.min(1, offset));
    return w * 0.5 + clamped * w * AIM_RANGE;
  }

  /** Stack / body target for flying discs. offset [-1,1] = same column as launch. */
  stackTargetPos(
    which: 'A' | 'B',
    offset = 0,
    finish = false
  ): { x: number; y: number } {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const labels = this.zoneLabels();
    const isBottom = labels.bottom === which;
    const baseY = isBottom ? h * 0.78 : h * 0.2;
    const colX = this.aimColumnX(offset);
    if (finish) {
      // Body zone — same column, clamped toward torso
      const bodyX = w * 0.5 + Math.max(-1, Math.min(1, offset)) * w * 0.14;
      return { x: bodyX, y: baseY };
    }
    // Impact stays in the aim column (stack coverage still decides hit/miss in sim)
    return { x: colX, y: baseY + (isBottom ? 8 : 4) };
  }

  playerZonePos(which: 'local' | 'opponent' | 'A' | 'B'): { x: number; y: number } {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const labels = this.zoneLabels();
    let bottom = false;
    if (which === 'local') bottom = true;
    else if (which === 'opponent') bottom = false;
    else if (which === 'A') bottom = labels.bottom === 'A';
    else bottom = labels.bottom === 'B';
    // Local (bottom) player slides with aimOffset
    const x =
      bottom && (which === 'local' || which === labels.bottom)
        ? this.aimColumnX(this.localAimOffset)
        : w * 0.5;
    return {
      x,
      y: bottom ? h * 0.78 : h * 0.2,
    };
  }

  draw(state: GameState): void {
    if (this.finishBoomUntil > 0) {
      const left = this.finishBoomUntil - performance.now();
      if (left <= 0) {
        this.finishBoom = 0;
        this.finishBoomSide = null;
        this.finishBoomTone = 'win';
        this.finishBoomUntil = 0;
      } else {
        this.finishBoom = Math.min(1, left / 3000);
      }
    }
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0c100c');
    g.addColorStop(1, '#050605');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const labels = this.zoneLabels();
    ctx.fillStyle = labels.top === 'A' ? 'rgba(6,225,19,0.07)' : 'rgba(77,163,255,0.07)';
    ctx.fillRect(0, 0, w, h * 0.28);
    ctx.fillStyle = labels.bottom === 'A' ? 'rgba(6,225,19,0.1)' : 'rgba(77,163,255,0.1)';
    ctx.fillRect(0, h * 0.7, w, h * 0.3);

    if (this.logoReady) {
      const lw = this.displayMode ? Math.min(w * 0.55, 520) : Math.min(w * 0.42, 280);
      const lh = lw * (this.logo.naturalHeight / Math.max(1, this.logo.naturalWidth));
      ctx.save();
      ctx.globalAlpha = this.displayMode ? 0.18 : 0.07;
      ctx.drawImage(this.logo, (w - lw) / 2, h * 0.42 - lh / 2, lw, lh);
      ctx.restore();
    }

    if (state.phase === 'playing' || state.phase === 'countdown') {
      this.drawAdvantageMeter(ctx, w, h, state);
    }

    // Avatars + plate stacks (always both visible)
    this.drawPlayerSide(ctx, w, h, labels.top, true, state);
    this.drawPlayerSide(ctx, w, h, labels.bottom, false, state);

    if (this.finishBoom > 0.01 && this.finishBoomSide) {
      const boomTop = labels.top === this.finishBoomSide;
      this.drawFinishBoom(ctx, w, h, boomTop, this.finishBoomTone);
    }

    if (this.opponentFlash > 0.01) {
      this.drawGhostHitBar(ctx, w, h * 0.045, this.opponentOffset, this.opponentFlash);
    }

    // Dumbbell — lean ALWAYS from plate stacks
    const bar = this.barScreenPos(state);
    const rot = this.viewLean(state);
    const absLean = Math.abs(leanFromPlates(state));
    const finishUnlocked = state.finishReady || absLean > FINISH_LEAN_RAD;

    ctx.save();
    ctx.translate(bar.x, bar.y);
    ctx.rotate(rot);

    const glow = ctx.createRadialGradient(0, 0, 4, 0, 0, finishUnlocked ? 95 : 70);
    glow.addColorStop(0, finishUnlocked ? 'rgba(6,225,19,0.55)' : 'rgba(6,225,19,0.3)');
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, finishUnlocked ? 95 : 70, 0, Math.PI * 2);
    ctx.fill();

    // Plate stacks on bar ends (match plate counts — left=A, right=B in world; flip for B view)
    const leftPlates = this.viewSide === 'B' ? state.platesB : state.platesA;
    const rightPlates = this.viewSide === 'B' ? state.platesA : state.platesB;
    const leftColor = this.viewSide === 'B' ? BLUE : GREEN;
    const rightColor = this.viewSide === 'B' ? GREEN : BLUE;
    this.drawBarPlates(ctx, -1, leftPlates, leftColor);
    ctx.fillStyle = '#cfd3cf';
    {
      const span = this.canvas.clientWidth * AIM_RANGE;
      const half = (PLATE_COLLAR_AIM + PLATE_STEP_AIM * 0.5) * span;
      ctx.fillRect(-half, -7, half * 2, 14);
    }
    ctx.fillStyle = '#2a2e2a';
    ctx.fillRect(-18, -10, 36, 20);
    ctx.fillStyle = GREEN;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(-8, -11, 16, 22);
    ctx.globalAlpha = 1;
    this.drawBarPlates(ctx, 1, rightPlates, rightColor);

    ctx.restore();

    // Lean degrees readout
    const deg = Math.round((absLean * 180) / Math.PI);
    ctx.font = '700 11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = finishUnlocked ? GREEN : 'rgba(255,255,255,0.55)';
    ctx.fillText(`LEAN ${deg}°`, bar.x, bar.y + 48);

    for (const s of state.sparks) {
      ctx.globalAlpha = Math.max(0, s.life);
      ctx.fillStyle = s.color;
      let sx = s.x * w;
      let sy = s.y * h;
      if (this.viewSide === 'B') sy = h - sy;
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Event toast + FINISH banner sit NEAR THE BAR (mid arena) — never over OPPONENT (top)
    if (state.lastEvent) {
      const ey = bar.y + 62;
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.fillRect(w * 0.18, ey - 12, w * 0.64, 22);
      ctx.fillStyle = state.lastFinish
        ? GREEN
        : state.lastMiss
          ? '#ffcc33'
          : state.lastStrip
            ? GREEN
            : 'rgba(242,245,242,0.9)';
      ctx.font = '700 11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(state.lastEvent, w / 2, ey + 3);
    }

    // Coach tips live only on the HTML hit-tip above the HIT bar (no mid-arena duplicate)

    if (state.phase === 'playing' && state.finishReady) {
      const fy = bar.y - 36;
      ctx.fillStyle = 'rgba(6,225,19,0.16)';
      ctx.fillRect(w * 0.16, fy - 12, w * 0.68, 24);
      ctx.strokeStyle = 'rgba(6,225,19,0.65)';
      ctx.strokeRect(w * 0.16, fy - 12, w * 0.68, 24);
      ctx.fillStyle = GREEN;
      ctx.font = '800 12px system-ui';
      ctx.textAlign = 'center';
      const who = state.finishFavors ?? '?';
      ctx.fillText(`FINISH — ${who} aim BODY`, w / 2, fy + 4);
    }

    if (state.phase === 'countdown') {
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(0, 0, w, h);
      const you =
        this.viewSide === 'B' ? 'B' : this.viewSide === 'A' ? 'A' : null;
      if (you) {
        ctx.fillStyle = you === 'A' ? GREEN : BLUE;
        ctx.font = '800 22px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(`YOU ARE PLAYER ${you}`, w / 2, h * 0.28);
        ctx.fillStyle = '#cfd8cf';
        ctx.font = '600 14px system-ui';
        ctx.fillText('YOU bottom · opponent top · both always visible', w / 2, h * 0.34);
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '500 13px system-ui';
        ctx.fillText('Drag yourself · FIRE · outer plates · bare → center FINISH', w / 2, h * 0.4);
      }
      ctx.fillStyle = GREEN;
      ctx.font = '800 96px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const n = Math.max(1, Math.ceil(state.countdown));
      ctx.fillText(String(n), w / 2, h / 2 + 20);
      ctx.textBaseline = 'alphabetic';
    }
  }

  private drawPlayerSide(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    side: 'A' | 'B',
    isTop: boolean,
    state: GameState
  ): void {
    const you =
      (this.viewSide === 'A' && side === 'A' && !isTop) ||
      (this.viewSide === 'B' && side === 'B' && !isTop);
    // Local player X follows drag-aim; opponent stays centered
    const x = you ? this.aimColumnX(this.localAimOffset) : w * 0.5;
    const y = isTop ? h * 0.2 : h * 0.8;
    const plates = side === 'A' ? state.platesA : state.platesB;
    const color = side === 'A' ? GREEN : BLUE;

    // Avatar
    ctx.save();
    ctx.fillStyle = side === 'A' ? 'rgba(6,225,19,0.35)' : 'rgba(77,163,255,0.35)';
    ctx.beginPath();
    roundRect(ctx, x - 32, y - 22, 64, 44, 12);
    ctx.fill();
    ctx.strokeStyle = you ? color : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = you ? 2.5 : 1.5;
    ctx.stroke();

    // Head / body (finish target)
    ctx.fillStyle = '#dfe5df';
    ctx.beginPath();
    ctx.arc(x, y - 28, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = side === 'A' ? 'rgba(6,225,19,0.55)' : 'rgba(77,163,255,0.55)';
    ctx.beginPath();
    roundRect(ctx, x - 14, y - 14, 28, 26, 6);
    ctx.fill();

    // FINISH body highlight when finish favors the OTHER player (they're aiming at you)
    // or when finish favors local and this is opponent
    if (state.finishReady && state.finishFavors && state.finishFavors !== side) {
      const pulse = 0.45 + 0.55 * Math.sin(performance.now() / 120);
      ctx.strokeStyle = `rgba(255, 80, 80, ${0.4 + pulse * 0.5})`;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 60, 60, ${0.15 + pulse * 0.2})`;
      ctx.beginPath();
      roundRect(ctx, x - 18, y - 32, 36, 48, 8);
      ctx.fill();
      ctx.fillStyle = '#ff6b6b';
      ctx.font = '800 9px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('BODY', x, y + 28);
    }

    ctx.fillStyle = you ? color : '#cfd8cf';
    ctx.font = '800 12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(you ? `YOU (${side})` : `PLAYER ${side}`, x, y + 40);
    if (isTop) {
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = '600 9px system-ui';
      ctx.fillText('OPPONENT', x, y + 52);
    }
    ctx.restore();

    // Subtle aim column cue for local player (not the old HIT bar)
    if (you && (state.phase === 'playing' || state.phase === 'countdown')) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.moveTo(x, y - 40);
      ctx.lineTo(x, h * 0.28);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Vertical plate stack beside avatar
    const stackX = isTop ? x + 58 : x - 58;
    this.drawVerticalStack(ctx, stackX, y, plates, color);
  }

  private drawVerticalStack(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    plates: number,
    accent: string
  ): void {
    const mass = Math.max(0, plates);
    const full = Math.floor(mass + 1e-9);
    const topHealth = mass - full; // 0, 0.25, 0.5, 0.75
    const plateCount = topHealth > 0.02 ? full + 1 : full;
    ctx.save();
    ctx.font = '800 10px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = accent;
    // Show living plates + chip quarters, not cryptic decimals
    const label =
      topHealth > 0.02
        ? `${full}+${Math.round(topHealth * 100)}%`
        : `${full}`;
    ctx.fillText(label, x, y - 36);
    for (let i = 0; i < plateCount; i++) {
      const py = y + 18 - i * 7;
      const isTopPartial = i === plateCount - 1 && topHealth > 0.02;
      const health = isTopPartial ? topHealth : 1;
      this.drawPlateChip(ctx, x, py, 22, 5, health, i % 2 === 0 ? '#1a1f1a' : accent, accent);
    }
    ctx.restore();
  }

  /** Draw an oval plate with visible 25/50/75/100% chip (missing wedge). */
  private drawPlateChip(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    rx: number,
    ry: number,
    health: number,
    fill: string,
    accent: string
  ): void {
    const h = Math.max(0, Math.min(1, health));
    ctx.save();
    // Damaged shell (ghost outline of full plate)
    if (h < 0.98) {
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#0a0c0a';
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.stroke();
    }
    // Remaining mass as a pie/wedge of the ellipse
    ctx.fillStyle = fill;
    ctx.beginPath();
    if (h >= 0.98) {
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    } else {
      // Start from top, sweep clockwise for remaining health
      const start = -Math.PI / 2;
      const end = start + Math.PI * 2 * h;
      ctx.moveTo(x, y);
      ctx.ellipse(x, y, rx, ry, 0, start, end, false);
      ctx.closePath();
    }
    ctx.fill();
    ctx.strokeStyle = h < 0.98 ? accent : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = h < 0.98 ? 1.5 : 1;
    ctx.stroke();
    // Chip tick marks at 25% steps on damaged plates
    if (h < 0.98 && h > 0.02) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      for (const q of [0.25, 0.5, 0.75]) {
        if (q > h + 0.01) continue;
        const a = -Math.PI / 2 + Math.PI * 2 * q;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * rx * 0.35, y + Math.sin(a) * ry * 0.35);
        ctx.lineTo(x + Math.cos(a) * rx, y + Math.sin(a) * ry);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawAdvantageMeter(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    state: GameState
  ): void {
    // Sit just ABOVE the barbell — never over OPPONENT at the top
    const bar = this.barScreenPos(state);
    const barW = Math.min(w * 0.55, 220);
    const x0 = (w - barW) / 2;
    const y = bar.y - 58;
    const bh = 8;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(x0 - 4, y - 2, barW + 8, bh + 4);
    let score = state.advantageScore;
    if (this.viewSide === 'B') score = -score;
    const mid = x0 + barW / 2;
    const fill = Math.abs(score) * (barW / 2);
    if (score >= 0) {
      ctx.fillStyle = this.viewSide === 'B' ? BLUE : GREEN;
      ctx.fillRect(mid, y, fill, bh);
    } else {
      ctx.fillStyle = this.viewSide === 'B' ? GREEN : BLUE;
      ctx.fillRect(mid - fill, y, fill, bh);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.strokeRect(x0, y, barW, bh);
    ctx.fillStyle = '#fff';
    ctx.fillRect(mid - 1, y - 2, 2, bh + 4);

    const heavier =
      state.advantage === 'EVEN'
        ? 'EVEN'
        : state.advantage === 'A'
          ? 'A HEAVIER'
          : 'B HEAVIER';
    ctx.font = '800 9px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle =
      state.advantage === 'A' ? GREEN : state.advantage === 'B' ? BLUE : '#cfd8cf';
    ctx.fillText(heavier, w / 2, y - 6);
    ctx.restore();
  }

  private drawGhostHitBar(
    ctx: CanvasRenderingContext2D,
    w: number,
    y: number,
    offset: number,
    flash: number
  ): void {
    const barW = Math.min(w * 0.72, 320);
    const x0 = (w - barW) / 2;
    ctx.save();
    ctx.globalAlpha = 0.35 + flash * 0.55;
    ctx.fillStyle = 'rgba(77,163,255,0.25)';
    ctx.strokeStyle = 'rgba(77,163,255,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    roundRect(ctx, x0, y, barW, 28, 8);
    ctx.fill();
    ctx.stroke();
    const mid = x0 + barW / 2;
    const ax = mid + offset * (barW / 2) * 0.9;
    ctx.fillStyle = '#fff';
    ctx.fillRect(ax - 1.5, y + 4, 3, 20);
    ctx.fillStyle = 'rgba(180,210,255,0.95)';
    ctx.font = '700 10px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('THEY HIT', mid, y + 18);
    ctx.restore();
  }


  /**
   * Arena-scale FINISH explosion (≥25% of screen, 3s).
   * POV tone: win = green FINISHED!; lose = red YOU LOSE.
   * Overlay is held back until finishBoomActive is false.
   */
  private drawFinishBoom(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    isTop: boolean,
    tone: 'win' | 'lose' = 'win'
  ): void {
    const t = this.finishBoom; // 1 → 0 over 3s
    const x = w * 0.5;
    const y = isTop ? h * 0.22 : h * 0.78;
    const p = 1 - t; // 0 → 1 progress
    const R = Math.min(w, h) * (0.35 + p * 0.28); // ≥25% screen, grows to ~arena fill
    const primary = tone === 'lose' ? '#ff3b4a' : '#06E113';
    const soft = tone === 'lose' ? '#ff8a94' : '#b8ffb8';
    const coreMid = tone === 'lose' ? '#ffcc33' : '#d4ff00';
    const title = tone === 'lose' ? 'YOU LOSE' : 'FINISHED!';
    ctx.save();

    // Full-arena flash (strong at start)
    ctx.globalAlpha = 0.65 * Math.min(1, t * 1.5);
    ctx.fillStyle = primary;
    ctx.fillRect(0, 0, w, h);
    // White punch flash
    ctx.globalAlpha = 0.35 * Math.max(0, t - 0.7) / 0.3;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);

    // Massive shockwave rings
    for (let i = 0; i < 5; i++) {
      const r = R * (0.35 + i * 0.22) * (0.5 + p * 0.5);
      ctx.globalAlpha = (0.7 - i * 0.12) * t;
      ctx.strokeStyle = i % 2 === 0 ? '#fff' : primary;
      ctx.lineWidth = 10 - i;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Dense particle blast
    const n = 40; // keep light for iPhone
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + p * 1.2;
      const dist = R * (0.15 + p * (0.55 + (i % 7) * 0.05));
      const px = x + Math.cos(ang) * dist;
      const py = y + Math.sin(ang) * dist * 0.9;
      ctx.globalAlpha = t * (0.45 + (i % 4) * 0.15);
      ctx.fillStyle = i % 3 === 0 ? '#fff' : i % 3 === 1 ? primary : soft;
      const sz = 4 + (1 - p) * 8 + (i % 5);
      ctx.beginPath();
      ctx.arc(px, py, sz, 0, Math.PI * 2);
      ctx.fill();
    }

    // Secondary sparks
    for (let i = 0; i < 24; i++) {
      const ang = (i / 24) * Math.PI * 2 - p * 0.8;
      const dist = R * (0.4 + p * 0.7);
      ctx.globalAlpha = t * 0.5;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang) * dist * 0.6, y + Math.sin(ang) * dist * 0.6);
      ctx.lineTo(x + Math.cos(ang) * dist, y + Math.sin(ang) * dist);
      ctx.stroke();
    }

    // Core fireball
    ctx.globalAlpha = 0.95 * t;
    const grd = ctx.createRadialGradient(x, y, 4, x, y, R * 0.55);
    grd.addColorStop(0, '#fff');
    grd.addColorStop(0.25, coreMid);
    grd.addColorStop(0.55, primary);
    grd.addColorStop(1, 'transparent');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, R * 0.55, 0, Math.PI * 2);
    ctx.fill();

    // Title
    if (t > 0.15) {
      ctx.globalAlpha = Math.min(1, t * 1.2);
      ctx.fillStyle = '#fff';
      ctx.font = `900 ${Math.floor(Math.min(w, h) * 0.08)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = primary;
      ctx.shadowBlur = 24;
      ctx.fillText(title, x, y);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  private drawBarPlates(
    ctx: CanvasRenderingContext2D,
    dir: number,
    count: number,
    accent: string
  ): void {
    const mass = Math.max(0, count);
    const full = Math.floor(mass + 1e-9);
    const topHealth = mass - full;
    const n = topHealth > 0.02 ? full + 1 : full;
    const colors = ['#1a1f1a', accent, '#222922', accent, '#333'];
    // Positions in aim-offset space (same as aimColumnX / aimQuality).
    // Visual size uses PLATE_HALF_AIM — chunky plates, independent of step spacing.
    const span = this.canvas.clientWidth * AIM_RANGE;
    const rx = PLATE_HALF_AIM * span; // along-bar radius (matches hit half-width)
    const ry = rx * 2.45; // vertical plate silhouette (readable on iPhone)
    // Local X (pre-rotate). Hit test projects with plateAimCenter (= local * cos).
    for (let i = 0; i < n; i++) {
      const aim = plateLocalAim(i);
      const x = dir * aim * span;
      const isTopPartial = i === n - 1 && topHealth > 0.02;
      const health = isTopPartial ? topHealth : 1;
      this.drawPlateChip(ctx, x, 0, rx, ry, health, colors[i % colors.length], accent);
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
