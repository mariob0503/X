/**
 * Procedural gym-comedy SFX via Web Audio.
 * iOS Safari/PWA: AudioContext must be created + resumed inside a user gesture.
 * On successful unlock / unmute → short cheerful cheer/fanfare (proof sound works).
 */

import { CHEER_WAV_DATA_URL } from './cheer-wav';

const MUTE_KEY = 'bfit24-pr-mute';

export type SfxName =
  | 'hit'
  | 'whoosh'
  | 'strip'
  | 'miss'
  | 'plateFall'
  | 'tiltWarn'
  | 'finishMode'
  | 'finishWin'
  | 'countdown'
  | 'win'
  | 'lose'
  | 'go'
  | 'cheer'
  | 'unlock'
  // legacy aliases
  | 'rack'
  | 'dump'
  | 'boom'
  | 'tip'
  | 'bonk'
  | 'lucky';

let ctx: AudioContext | null = null;
let unlocked = false;
let muted = false;
let master: GainNode | null = null;
let cheerPlayedForUnlock = false;
const unlockListeners = new Set<(ok: boolean) => void>();

try {
  // Default unmuted — only mute if user explicitly chose mute
  muted = localStorage.getItem(MUTE_KEY) === '1';
} catch {
  /* private mode */
}

function getAC(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
    null
  );
}

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  const AC = getAC();
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain();
    // Phone-speaker-friendly master level (audible on iPhone)
    master.gain.value = muted ? 0.0001 : 0.9;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
    master = null;
  }
  return ctx;
}

function dest(): AudioNode {
  return master ?? (ctx as AudioContext).destination;
}

function notifyUnlock(ok: boolean): void {
  for (const fn of unlockListeners) {
    try {
      fn(ok);
    } catch {
      /* ignore */
    }
  }
}

export function onAudioUnlock(fn: (ok: boolean) => void): () => void {
  unlockListeners.add(fn);
  return () => unlockListeners.delete(fn);
}

export function isAudioUnlocked(): boolean {
  return unlocked && !!ctx && ctx.state === 'running';
}

/** Short cheerful cheer / fanfare via Web Audio (needs running ctx). */
function playCheerInternal(force = false): void {
  const c = ensureCtx();
  if (!c) return;
  if (c.state !== 'running') return;
  if (muted && !force) return;

  const t0 = c.currentTime;
  const notes = [
    { f: 523.25, t: 0, d: 0.12 },
    { f: 659.25, t: 0.1, d: 0.12 },
    { f: 783.99, t: 0.2, d: 0.14 },
    { f: 1046.5, t: 0.34, d: 0.28 },
  ];
  for (const n of notes) {
    try {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(n.f, t0 + n.t);
      const peak = 0.45;
      g.gain.setValueAtTime(0.0001, t0 + n.t);
      g.gain.exponentialRampToValueAtTime(peak, t0 + n.t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.t + n.d);
      o.connect(g);
      g.connect(dest());
      o.start(t0 + n.t);
      o.stop(t0 + n.t + n.d + 0.04);
    } catch {
      /* ignore */
    }
  }
}

/** HTMLAudio cheer — plays inside the same iOS user gesture (most reliable). */
export function playHtmlCheer(): void {
  try {
    const a = new Audio(CHEER_WAV_DATA_URL);
    a.volume = 1;
    const p = a.play();
    if (p && typeof p.then === 'function') {
      void p.catch(() => {
        /* ignore */
      });
    }
  } catch {
    /* ignore */
  }
}

/**
 * Must run inside a user gesture. Creates ctx, silent buffer unlock, resume(), cheer.
 * Pass { cheer: true, forceUnmute: true } from the sound banner.
 */
export function unlockAudio(opts?: { cheer?: boolean; forceUnmute?: boolean }): boolean {
  if (opts?.forceUnmute) {
    muted = false;
    try {
      localStorage.setItem(MUTE_KEY, '0');
    } catch {
      /* ignore */
    }
  }

  const wantCheer = opts?.cheer === true;
  if (wantCheer) {
    // Always fire HTMLAudio in the gesture first — this is what iOS will actually play
    playHtmlCheer();
  }

  const c = ensureCtx();
  if (!c) {
    unlocked = false;
    notifyUnlock(false);
    return false;
  }

  // Synchronous silent buffer + resume kick (iOS unlock ritual)
  try {
    if (master) master.gain.value = muted ? 0.0001 : 0.9;
    const buf = c.createBuffer(1, 1, c.sampleRate);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(dest());
    src.start(0);
    void c.resume();
  } catch {
    /* ignore */
  }

  const afterRunning = () => {
    unlocked = true;
    notifyUnlock(true);
    if (wantCheer && !muted) {
      cheerPlayedForUnlock = true;
      playCheerInternal(true);
    }
  };

  if (c.state === 'running') {
    afterRunning();
    return true;
  }

  void c
    .resume()
    .then(() => {
      if ((c.state as AudioContextState) === 'running') afterRunning();
      else {
        unlocked = false;
        notifyUnlock(false);
      }
    })
    .catch(() => {
      unlocked = false;
      notifyUnlock(false);
    });

  // HTMLAudio cheer already fired in the gesture; WebAudio follows after resume
  return false;
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(m: boolean): void {
  const wasMuted = muted;
  muted = m;
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (master && ctx) {
    master.gain.value = muted ? 0.0001 : 0.9;
  }
  // Unmute → unlock + unmistakable cheer (HTMLAudio + WebAudio)
  if (wasMuted && !muted) {
    cheerPlayedForUnlock = false;
    unlockAudio({ cheer: true, forceUnmute: true });
  }
}

export function toggleMute(): boolean {
  setMuted(!muted);
  return muted;
}

function canPlay(): boolean {
  if (muted) return false;
  const c = ensureCtx();
  if (!c) return false;
  if (c.state === 'suspended') {
    void c.resume().then(() => {
      if (c.state === 'running') {
        unlocked = true;
        notifyUnlock(true);
      }
    });
    return false;
  }
  return c.state === 'running';
}

function tone(
  freq: number,
  dur: number,
  type: OscillatorType,
  gain = 0.28,
  sweepTo?: number
): void {
  if (!canPlay()) return;
  const c = ctx!;
  const t0 = c.currentTime;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (sweepTo != null) {
    o.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t0 + dur);
  }
  const peak = Math.max(0.05, Math.min(0.55, gain));
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g);
  g.connect(dest());
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

function noiseBurst(dur: number, gain = 0.18): void {
  if (!canPlay()) return;
  const c = ctx!;
  const n = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 1400;
  g.gain.value = gain;
  src.connect(f);
  f.connect(g);
  g.connect(dest());
  src.start();
}

/** Play named SFX. Always tries unlock first so gesture-driven calls work. */
export function playSfx(name: SfxName): void {
  if (name === 'cheer' || name === 'unlock') {
    unlockAudio({ cheer: true });
    return;
  }
  unlockAudio();
  if (muted) return;

  switch (name) {
    case 'hit':
    case 'strip':
      tone(160, 0.08, 'square', 0.3);
      tone(420, 0.1, 'triangle', 0.22);
      noiseBurst(0.06, 0.14);
      break;
    case 'whoosh':
      tone(520, 0.2, 'sawtooth', 0.22, 160);
      break;
    case 'miss':
    case 'bonk':
      tone(180, 0.12, 'sine', 0.3, 90);
      setTimeout(() => tone(110, 0.16, 'triangle', 0.24), 70);
      break;
    case 'plateFall':
    case 'boom':
    case 'dump':
      tone(95, 0.28, 'sawtooth', 0.38, 45);
      noiseBurst(0.22, 0.22);
      break;
    case 'tiltWarn':
      tone(380, 0.1, 'square', 0.26);
      setTimeout(() => tone(380, 0.1, 'square', 0.22), 120);
      break;
    case 'finishMode':
    case 'tip':
      tone(330, 0.1, 'square', 0.28);
      setTimeout(() => tone(440, 0.1, 'square', 0.3), 80);
      setTimeout(() => tone(660, 0.2, 'square', 0.34), 160);
      break;
    case 'finishWin':
    case 'win':
      tone(523, 0.1, 'triangle', 0.3);
      setTimeout(() => tone(659, 0.1, 'triangle', 0.3), 90);
      setTimeout(() => tone(784, 0.26, 'triangle', 0.36), 180);
      setTimeout(() => playCheerInternal(), 320);
      break;
    case 'lose':
      tone(300, 0.18, 'sawtooth', 0.28, 120);
      setTimeout(() => tone(160, 0.28, 'sawtooth', 0.28, 80), 130);
      break;
    case 'countdown':
      tone(700, 0.12, 'square', 0.28);
      break;
    case 'go':
      tone(520, 0.09, 'square', 0.3);
      setTimeout(() => tone(820, 0.16, 'square', 0.34), 70);
      break;
    case 'rack':
    case 'lucky':
      tone(880, 0.08, 'triangle', 0.28);
      setTimeout(() => tone(1320, 0.1, 'triangle', 0.24), 55);
      break;
  }
}

/** Wire unlock on first gesture anywhere — keep listening until success. */
export function installAudioUnlock(): void {
  let cheered = false;
  const tryUnlock = (ev?: Event) => {
    const fromBanner = (ev?.target as HTMLElement | null)?.closest?.('.sound-banner');
    const ok = unlockAudio({
      cheer: !cheered || !!fromBanner,
      forceUnmute: !!fromBanner,
    });
    if (!cheered && (ok || isAudioUnlocked() || fromBanner)) cheered = true;
    if (ok || isAudioUnlocked()) {
      window.removeEventListener('pointerdown', tryUnlock);
      window.removeEventListener('touchstart', tryUnlock);
      window.removeEventListener('keydown', tryUnlock);
      window.removeEventListener('click', tryUnlock);
    }
  };
  window.addEventListener('pointerdown', tryUnlock, { passive: true });
  window.addEventListener('touchstart', tryUnlock, { passive: true });
  window.addEventListener('keydown', tryUnlock);
  window.addEventListener('click', tryUnlock, { passive: true });
}
