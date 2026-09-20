import './styles/main.css';
import {
  aimQuality,
  applyHit,
  cloneState,
  cooldownLeft,
  createInitialState,
  leanFromPlates,
  nextRound,
  startCountdown,
  step,
} from './game/sim';
import { updateAI } from './game/ai';
import { ArenaRenderer } from './game/render';
import type { GameState, NetMessage, Role } from './game/types';
import { AIM_RANGE, HIT_COOLDOWN } from './game/types';
import { PlateRaceNet, humanJoinError, normalizeRoomCode, randomRoomCode } from './net/hybrid';
import { vibrate } from './ui/haptics';
import { FlyPlateLayer } from './ui/flyPlates';
import {
  installAudioUnlock,
  isAudioUnlocked,
  isMuted,
  onAudioUnlock,
  playSfx,
  toggleMute,
  unlockAudio,
} from './audio/sfx';

const app = document.getElementById('app')!;
const TUTORIAL_KEY = 'bfit24-pr-tutorial-v9';

let net: PlateRaceNet | null = null;
let state: GameState | null = null;
let renderer: ArenaRenderer | null = null;
let flyPlates: FlyPlateLayer | null = null;
let raf = 0;
let lastTs = 0;
let aiAcc = { t: 0.9 };
let myRole: Role = 'host';
let isAuthoritative = false;
let seenHitSeq = 0;
/** Local launch aim [-1,1]; shared column for shot travel. */
let aimOffset = 0;
let aimDragging = false;

let lastCountdownCeil = -1;
let lastPhase: string | null = null;
let prevEvent = '';
let lastFinishReady = false;
/** Hold Round Over overlay until FINISH explosion ends. */
let overlayHoldUntil = 0;
let lastTiltWarn = false;
let soundBannerEl: HTMLElement | null = null;

installAudioUnlock();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

function netTip(): HTMLElement {
  return el('p', {
    class: 'tiny net-tip',
    text: 'Same link on both devices. Tries a direct phone link first; if Wi‑Fi blocks it, falls back to the game server automatically.',
  });
}

function setStatus(
  node: HTMLElement,
  text: string,
  kind: 'ok' | 'err' | 'warn' | '' = ''
): void {
  node.textContent = text;
  node.className = `status ${kind}`;
}

function destroyNet(): void {
  cancelAnimationFrame(raf);
  raf = 0;
  flyPlates?.clear();
  flyPlates = null;
  net?.destroy();
  net = null;
  state = null;
  renderer = null;
  seenHitSeq = 0;
  lastCountdownCeil = -1;
  lastPhase = null;
  prevEvent = '';
  lastFinishReady = false;
  lastTiltWarn = false;
  soundBannerEl = null;
}

function mySide(): 'A' | 'B' {
  return myRole === 'playerB' ? 'B' : 'A';
}

/** Persistent green “Tap for sound” until AudioContext is running. */
function ensureSoundBanner(parent: HTMLElement): void {
  if (isAudioUnlocked()) return;
  let banner = parent.querySelector('.sound-banner') as HTMLElement | null;
  if (!banner) {
    banner = el('div', {
      class: 'sound-banner',
      role: 'button',
      tabindex: '0',
      text: '🔊 Tap anywhere for sound',
    });
    banner.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Force unmute + HTMLAudio cheer in THIS gesture (iOS)
      unlockAudio({ cheer: true, forceUnmute: true });
      playSfx('cheer');
      setTimeout(() => refreshSoundBanner(), 100);
      setTimeout(() => refreshSoundBanner(), 500);
    });
    parent.append(banner);
  }
  soundBannerEl = banner;
  refreshSoundBanner();
  onAudioUnlock(() => refreshSoundBanner());
}

function refreshSoundBanner(): void {
  if (!soundBannerEl) {
    soundBannerEl = document.querySelector('.sound-banner');
  }
  if (!soundBannerEl) return;
  if (isAudioUnlocked()) {
    soundBannerEl.classList.add('hidden');
  } else {
    soundBannerEl.classList.remove('hidden');
    soundBannerEl.textContent = isMuted()
      ? '🔊 Tap to unlock sound (currently muted — tap 🔊 to unmute)'
      : '🔊 Tap anywhere for sound';
  }
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { class: cls, type: 'button', text: label }) as HTMLButtonElement;
  b.addEventListener('click', () => {
    unlockAudio();
    onClick();
  });
  return b;
}

function identityBadge(side: 'A' | 'B', extra = ''): HTMLElement {
  const you = side === mySide() && myRole !== 'display';
  const label = you ? `YOU ARE PLAYER ${side}` : `PLAYER ${side}`;
  return el('div', {
    class: `identity-badge identity-${side.toLowerCase()}${you ? ' identity-you' : ''}`,
    text: extra ? `${label} — ${extra}` : label,
  });
}

function showHome(): void {
  destroyNet();
  app.innerHTML = '';
  const screen = el('div', { class: 'screen' }, [
    el('img', { class: 'logo', src: './bfit24-logo.svg', alt: 'BFit24' }),
    el('h1', { text: 'Plate Race' }),
    el('p', {
      class: 'tagline',
      text: 'Strip outer plates → unlock FINISH → land the body shot to win. Timer never crowns you. Best of 3.',
    }),
    el('div', { class: 'btn-row' }, [
      button('Host / Player A', 'primary btn-a', () => showHostLobby()),
      button('Join as Player B', 'btn-b', () => showJoin('playerB')),
      button('Join as Display', '', () => showJoin('display')),
      button('Single-player vs AI', 'ghost', () => startSolo()),
    ]),
    el('p', {
      class: 'tiny',
      text: 'PWA · WebRTC · Tap once to unlock sound (cheer proves it works)',
    }),
  ]);
  app.append(screen);
  ensureSoundBanner(screen);
}

function showHostLobby(): void {
  const code = randomRoomCode();
  myRole = 'host';
  app.innerHTML = '';
  const status = el('div', { class: 'status', text: 'Creating room…' });
  const list = el('ul', { class: 'waiting-list' }, [
    el('li', { id: 'wait-b', text: 'Player B — waiting' }),
    el('li', { id: 'wait-d', text: 'Display — optional' }),
  ]);
  const startBtn = button('Start Match', 'primary', () => {
    if (!state) return;
    maybeShowTutorial(() => {
      startCountdown(state!);
      net?.sendStart();
      broadcast();
      enterArena();
    });
  }) as HTMLButtonElement;
  startBtn.disabled = true;

  const screen = el('div', { class: 'screen' }, [
    identityBadge('A', 'bottom · strip B'),
    el('p', { class: 'tagline', text: 'Share this room code (no spaces)' }),
    el('div', { class: 'code-xl', text: code }),
    el('div', { class: 'role-confirm role-a' }, [
      el('strong', { text: 'You are Player A' }),
      el('span', { text: ' Green · YOU at the bottom · strip B’s stack (top)' }),
    ]),
    el('div', { class: 'panel' }, [list, status, startBtn]),
    el('p', {
      class: 'tiny',
      text: 'Both start fully loaded. Outer chips strip. Bare or lean>45° unlocks FINISH — you must FIRE the body shot to win.',
    }),
    netTip(),
    button('Back', 'ghost', () => showHome()),
  ]);
  app.append(screen);
  ensureSoundBanner(screen);
  void bootHost(code, status, startBtn);
}

async function bootHost(code: string, status: HTMLElement, startBtn: HTMLButtonElement): Promise<void> {
  destroyNet(); // fresh host peer
  myRole = 'host';
  isAuthoritative = true;
  state = createInitialState(code, false);
  let lobbyBConnected = false;
  net = new PlateRaceNet('host', code, {
    onStatus: (t, k) => {
      // Once B is connected, never overwrite success with PeerJS fatal red.
      if (lobbyBConnected && k === 'err') return;
      // Soft tip (warn) allowed while connected; keep ok locked otherwise.
      if (lobbyBConnected && k !== 'warn' && k !== 'ok') return;
      setStatus(status, t, k);
    },
    onError: (e) => {
      if (lobbyBConnected) return;
      setStatus(status, humanJoinError(e), 'err');
    },
    onPeerJoined: (role) => {
      if (!state) return;
      if (role === 'playerB') {
        state.connectedB = true;
        lobbyBConnected = true;
        const li = document.getElementById('wait-b');
        if (li) {
          li.textContent = 'Player B — connected';
          li.classList.add('ready');
        }
        startBtn.disabled = false;
        const via =
          net?.mode === 'relay'
            ? 'backup'
            : net?.mode === 'peer'
              ? 'direct'
              : null;
        const tip = via
          ? `Player B joined (${via}) — you can start`
          : 'Player B joined — you can start';
        setStatus(status, tip, 'ok');
        vibrate(20);
        playSfx('strip');
      }
      if (role === 'display') {
        state.connectedDisplay = true;
        const li = document.getElementById('wait-d');
        if (li) {
          li.textContent = 'Display — connected';
          li.classList.add('ready');
        }
      }
      broadcast();
    },
    onPeerLeft: (role) => {
      if (!state) return;
      if (role === 'playerB') {
        state.connectedB = false;
        lobbyBConnected = false;
        setStatus(status, 'Player B disconnected', 'err');
      }
      if (role === 'display') state.connectedDisplay = false;
    },
    onMessage: (msg) => handleHostMessage(msg),
  });

  try {
    await net.start();
    // Keep PlateRaceNet status (e.g. "Room live · CODE · (direct + backup)")
    if (!status.textContent || status.textContent.includes('Creating') || status.textContent.includes('Opening')) {
      setStatus(status, 'Room live — waiting for Player B', 'ok');
    }
    const soloNote = button('Start vs AI instead', 'ghost', () => {
      if (!state) return;
      state.aiEnabled = true;
      state.connectedB = true;
      maybeShowTutorial(() => {
        startCountdown(state!);
        enterArena();
      });
    });
    status.parentElement?.append(soloNote);
  } catch (e) {
    setStatus(status, humanJoinError(e), 'err');
  }
}

function handleHostMessage(msg: NetMessage): void {
  if (!state || !isAuthoritative) return;
  if (msg.type === 'aim' && msg.side === 'B') {
    if (renderer) {
      renderer.opponentOffset = msg.offset;
      renderer.opponentFlash = Math.max(renderer.opponentFlash, 0.35);
    }
  } else if (msg.type === 'hit' && msg.side === 'B') {
    applyHit(state, 'B', msg.offset);
    if (state.lastHitQuality > 0.7) vibrate([10, 30, 10]);
    onRemoteHit(state);
    broadcast();
    refreshHud();
  } else if (msg.type === 'ready' || msg.type === 'start') {
    if (state.phase === 'lobby' || state.phase === 'roundOver') {
      if (state.phase === 'roundOver') nextRound(state);
      else startCountdown(state);
      enterArena();
    }
  } else if (msg.type === 'rematch') {
    nextRound(state);
    broadcast();
  } else if (msg.type === 'hello') {
    broadcast();
  }
}

function showJoin(role: 'playerB' | 'display'): void {
  app.innerHTML = '';
  if (role === 'playerB') myRole = 'playerB';
  const status = el('div', { class: 'status', text: 'Enter the 6-character room code' });
  const input = el('input', {
    maxlength: '12', // allow typed/pasted spaces; we normalize to 6
    placeholder: 'ABC123',
    autocomplete: 'off',
    autocapitalize: 'characters',
    inputmode: 'text',
    spellcheck: 'false',
  }) as HTMLInputElement;
  // Live-normalize display (strip spaces) so what you see is what you join
  input.addEventListener('input', () => {
    const caret = input.selectionStart;
    const norm = normalizeRoomCode(input.value);
    if (input.value.toUpperCase().replace(/[^A-Z0-9]/g, '') !== norm) {
      /* keep raw while typing spaces, validate on submit */
    }
    void caret;
  });
  const joinBtn = button('Join Room', 'primary', () => {
    const code = normalizeRoomCode(input.value);
    input.value = code;
    if (code.length !== 6) {
      setStatus(status, 'Need a 6-character code (spaces ignored)', 'err');
      return;
    }
    void bootGuest(role, code, status, joinBtn);
  }) as HTMLButtonElement;

  const kids: (Node | string)[] = [
    role === 'playerB'
      ? identityBadge('B', 'bottom · strip A')
      : el('span', { class: 'role-chip', text: 'Display' }),
    el('h1', { text: 'Join Room' }),
  ];
  if (role === 'playerB') {
    kids.push(
      el('div', { class: 'role-confirm role-b' }, [
        el('strong', { text: 'You will be Player B' }),
        el('span', { text: ' Blue · YOU at bottom · strip A’s stack (top)' }),
      ])
    );
  }
  kids.push(
    el('div', { class: 'panel' }, [el('label', { text: 'Room code' }), input, status, joinBtn]),
    el('p', {
      class: 'tiny',
      text:
        role === 'display'
          ? 'Spectator — A (green, bottom) vs B (blue, top).'
          : 'Confirm: you are B before the match starts.',
    }),
    netTip(),
    button('Back', 'ghost', () => showHome())
  );

  const screen = el('div', { class: 'screen' }, kids);
  app.append(screen);
  ensureSoundBanner(screen);
  input.focus();
}

async function bootGuest(
  role: 'playerB' | 'display',
  code: string,
  status: HTMLElement,
  joinBtn: HTMLButtonElement
): Promise<void> {
  joinBtn.disabled = true;
  destroyNet(); // drop any prior peer before dialing
  myRole = role;
  isAuthoritative = false;
  const room = normalizeRoomCode(code);
  setStatus(status, `Connecting to room ${room} (direct first)…`);
  net = new PlateRaceNet(role, room, {
    onStatus: (t, k) => setStatus(status, t, k),
    onError: (e) => setStatus(status, humanJoinError(e), 'err'),
    onMessage: (msg) => {
      if (msg.type === 'welcome') {
        return;
      }
      if (msg.type === 'start') {
        // Host also broadcasts state; enter when phase has left lobby
        if (!document.getElementById('arena') && state && state.phase !== 'lobby') {
          maybeShowTutorial(() => enterArena());
        }
        return;
      }
      if (msg.type === 'state') {
        const prevSeq = state?.hitSeq ?? 0;
        state = normalizeState(msg.state);
        // Host started the match → enter arena (do NOT leave lobby before that)
        if (!document.getElementById('arena')) {
          if (state.phase !== 'lobby') {
            maybeShowTutorial(() => enterArena());
          }
        } else {
          if (state.hitSeq > prevSeq) {
            if (state.hitSeq > seenHitSeq) onRemoteHit(state);
            else reactToHitSfx(state);
            seenHitSeq = Math.max(seenHitSeq, state.hitSeq);
          }
          refreshHud();
        }
      }
    },
    onPeerLeft: () => setStatus(status, 'Host left / disconnected', 'err'),
  });
  try {
    await net.start();
    // Status already set by hybrid: Connected (direct) or Connected (backup)
    const mode = net.mode === 'relay' ? 'backup' : 'direct';
    setStatus(status, `Connected (${mode}) — waiting for host to start`, 'ok');
    playSfx('strip');
    state = createInitialState(room, false);
    // Stay on join lobby until host taps Start Match (state.phase leaves lobby)
  } catch (e) {
    joinBtn.disabled = false;
    setStatus(status, humanJoinError(e), 'err');
  }
}

async function startSolo(): Promise<void> {
  const code = randomRoomCode();
  myRole = 'solo';
  isAuthoritative = true;
  state = createInitialState(code, true);
  app.innerHTML = '';
  const status = el('div', { class: 'status', text: 'Starting solo…' });
  const screen = el('div', { class: 'screen' }, [identityBadge('A', 'vs AI'), status]);
  app.append(screen);
  ensureSoundBanner(screen);

  net = new PlateRaceNet('solo', code, {
    onStatus: (t, k) => setStatus(status, t, k),
    onPeerJoined: (role) => {
      if (!state) return;
      if (role === 'display') {
        state.connectedDisplay = true;
        broadcast();
      }
    },
    onMessage: (msg) => {
      if (msg.type === 'hello') broadcast();
    },
  });
  try {
    await net.start();
  } catch {
    net = null;
  }
  maybeShowTutorial(() => {
    startCountdown(state!);
    enterArena();
  });
}

function maybeShowTutorial(then: () => void): void {
  let seen = false;
  try {
    seen = localStorage.getItem(TUTORIAL_KEY) === '1';
  } catch {
    /* ignore */
  }
  if (seen || myRole === 'display') {
    then();
    return;
  }
  app.innerHTML = '';
  const side = mySide();
  const screen = el('div', { class: 'screen' }, [
    identityBadge(side, side === 'A' ? 'green · bottom' : 'blue · bottom'),
    el('h1', { text: 'Quick tips' }),
    el('ul', { class: 'tutorial-list' }, [
      el('li', { text: 'Drag YOUR avatar left/right to aim — dragging does NOT fire.' }),
      el('li', { text: 'Tap FIRE to shoot in that column.' }),
      el('li', { text: 'Only OUTER plates chip (25% each; 50% in overtime). Center misses while they have plates.' }),
      el('li', { text: 'When they’re bare → drag CENTER and FIRE to FINISH.' }),
      el('li', { text: 'Lean past 45° opens FINISH — you still must FIRE the body shot to win (no auto-win).' }),
    ]),
    el('p', {
      class: 'tiny',
      text: 'Outer plates chip; only a landed FINISH wins. Time-up = draw. ~30–45s rounds.',
    }),
    el('div', { class: 'btn-row' }, [
      button('Got it — play!', 'primary', () => {
        try {
          localStorage.setItem(TUTORIAL_KEY, '1');
        } catch {
          /* ignore */
        }
        then();
      }),
      button('Skip', 'ghost', () => {
        try {
          localStorage.setItem(TUTORIAL_KEY, '1');
        } catch {
          /* ignore */
        }
        then();
      }),
    ]),
  ]);
  app.append(screen);
  ensureSoundBanner(screen);
}

function normalizeState(s: GameState): GameState {
  if (s.lastHitOffset === undefined) (s as GameState).lastHitOffset = 0;
  if (s.hitSeq === undefined) (s as GameState).hitSeq = 0;
  if (s.lastMiss === undefined) (s as GameState).lastMiss = false;
  if (s.lastStrip === undefined) (s as GameState).lastStrip = false;
  if (s.lastStripAmt === undefined) (s as GameState).lastStripAmt = 0;
  if (s.lastFinish === undefined) (s as GameState).lastFinish = false;
  if (s.finishReady === undefined) {
    (s as GameState).finishReady = false;
    (s as GameState).finishFavors = null;
  }
  if (s.finishHold === undefined) (s as GameState).finishHold = 0;
  if (s.coolA === undefined) (s as GameState).coolA = 0;
  if (s.coolB === undefined) (s as GameState).coolB = 0;
  if (s.stunA === undefined) (s as GameState).stunA = 0;
  if (s.stunB === undefined) (s as GameState).stunB = 0;
  if (s.advantage === undefined) (s as GameState).advantage = 'EVEN';
  if (s.advantageScore === undefined) (s as GameState).advantageScore = 0;
  if (s.coachTip === undefined) (s as GameState).coachTip = '';
  if (s.overtimeActive === undefined) (s as GameState).overtimeActive = false;
  if (s.overtimeUsed === undefined) (s as GameState).overtimeUsed = false;
  // Migrate old tip* fields if a stale peer sends them
  const any = s as GameState & { tipReady?: boolean; tipFavors?: 'A' | 'B' | null };
  if (any.tipReady && !s.finishReady) {
    s.finishReady = true;
    s.finishFavors = any.tipFavors ?? null;
  }
  return s;
}

function broadcast(): void {
  if (!state || !net || !isAuthoritative) return;
  const wire = cloneState(state);
  if (wire.sparks.length > 24) wire.sparks = wire.sparks.slice(-24);
  net.broadcastState(wire);
}

function enterArena(): void {
  if (!state) return;
  unlockAudio();
  app.innerHTML = '';
  app.classList.toggle('display-mode', myRole === 'display');
  app.classList.toggle('role-a', mySide() === 'A' && myRole !== 'display');
  app.classList.toggle('role-b', mySide() === 'B');

  const wrap = el('div', { class: 'arena-wrap' });
  const canvas = el('canvas', { id: 'arena' }) as HTMLCanvasElement;
  wrap.append(canvas);

  const fxLayer = el('div', { class: 'fx-layer', id: 'fx-layer' });
  wrap.append(fxLayer);
  flyPlates = new FlyPlateLayer(fxLayer);

  const muteBtn = el('button', {
    class: 'mute-btn',
    type: 'button',
    id: 'mute-btn',
    text: isMuted() ? '🔇' : '🔊',
    title: 'Mute sounds',
  }) as HTMLButtonElement;
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    unlockAudio();
    const m = toggleMute();
    muteBtn.textContent = m ? '🔇' : '🔊';
    // Unmute path plays cheer inside setMuted; still nudge if already unmuted toggle
    if (!m) playSfx('cheer');
    refreshSoundBanner();
  });

  const side = myRole === 'display' ? null : mySide();
  // Compact corner chip — must NOT cover opponent avatar/plates
  const idBanner =
    side != null
      ? el('div', {
          class: `you-chip you-chip-${side.toLowerCase()}`,
          id: 'you-banner',
          text: `YOU · ${side}`,
        })
      : el('div', {
          class: 'you-chip you-chip-display',
          id: 'you-banner',
          text: 'DISPLAY',
        });

  // Advantage lives on canvas near the barbell (not over opponent)
  const hud = el('div', { class: 'hud' }, [
    el('div', { class: 'hud-top' }, [
      idBanner,
      el('div', { class: 'badge', id: 'hud-meta' }),
      el('div', { class: 'badge scoreboard', id: 'hud-score' }),
      el('div', { class: 'badge', id: 'hud-time' }),
      muteBtn,
    ]),
  ]);
  wrap.append(hud);

  if (myRole !== 'display') {
    const tip = el('p', {
      class: 'hit-tip',
      id: 'hit-tip',
      text: 'Drag yourself · FIRE · only outer plates chip · bare → center FINISH',
    });
    // Transparent drag lane over bottom play area — moves player, does NOT fire
    const drag = el('div', {
      class: 'drag-zone',
      id: 'drag-zone',
    });
    drag.innerHTML = `<span class="drag-hint" id="drag-hint">DRAG TO AIM</span>`;
    const fire = el('button', {
      class: `fire-btn fire-btn-${mySide().toLowerCase()}`,
      type: 'button',
      id: 'fire-btn',
    }) as HTMLButtonElement;
    fire.append(
      el('span', { class: 'fire-label', id: 'fire-label', text: 'FIRE' }),
      el('span', { class: 'fire-cooldown', id: 'fire-cooldown' }),
    );
    const controls = el('div', { class: 'controls' }, [tip, fire]);
    wrap.append(drag, controls);
    bindDragAndFire(drag, fire);
  }

  const overlay = el('div', { class: 'overlay hidden', id: 'overlay' }, [
    el('div', { class: 'overlay-card' }, [
      el('h2', { id: 'ov-title', text: '' }),
      el('p', { id: 'ov-body', text: '' }),
      el('div', { class: 'btn-row', id: 'ov-actions' }),
    ]),
  ]);
  wrap.append(overlay);

  app.append(wrap);
  ensureSoundBanner(wrap);

  renderer = new ArenaRenderer(canvas);
  renderer.displayMode = myRole === 'display';
  renderer.viewSide = myRole === 'display' ? 'spectator' : myRole === 'playerB' ? 'B' : 'A';
  renderer.resize();
  window.addEventListener('resize', () => renderer?.resize());

  seenHitSeq = state.hitSeq ?? 0;
  refreshHud();
  lastTs = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
}

function spawnHitPlates(
  side: 'A' | 'B',
  quality: number,
  offset: number,
  miss: boolean,
  finish: boolean,
  fromClient?: { x: number; y: number }
): void {
  if (!flyPlates || !renderer || !state) return;
  const wrap = document.querySelector('.arena-wrap') as HTMLElement | null;
  const canvas = document.getElementById('arena') as HTMLCanvasElement | null;
  if (!wrap || !canvas) return;

  const wrapRect = wrap.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const ox = canvasRect.left - wrapRect.left;
  const oy = canvasRect.top - wrapRect.top;

  const foe: 'A' | 'B' = side === 'A' ? 'B' : 'A';
  // Same vertical column for launch and impact
  const colX = ox + renderer.aimColumnX(offset);
  let fromX = colX;
  let fromY: number;
  if (fromClient) {
    fromY = fromClient.y - wrapRect.top;
  } else {
    const fromZone = renderer.playerZonePos(side);
    fromY = oy + fromZone.y;
  }
  const target = renderer.stackTargetPos(foe, offset, finish);
  const toX = ox + target.x; // equals colX for strip shots
  const toY = oy + target.y;

  flyPlates.spawn({
    fromX,
    fromY,
    toX,
    toY,
    quality,
    miss: miss && !finish,
    count: finish ? 4 : miss ? 1 : quality >= 0.75 ? 3 : quality >= 0.45 ? 2 : 1,
  });
}

function onRemoteHit(s: GameState): void {
  if (!s.lastHitSide) return;
  const local = mySide();
  spawnHitPlates(
    s.lastHitSide,
    s.lastHitQuality,
    s.lastHitOffset,
    !!s.lastMiss,
    !!s.lastFinish,
  );
  if (s.lastHitSide !== local || myRole === 'display') {
    if (renderer) {
      renderer.opponentFlash = 1;
      renderer.opponentOffset = s.lastHitOffset;
    }
  }
  reactToHitSfx(s);
  seenHitSeq = s.hitSeq;
}


function triggerFinishFx(s: GameState): void {
  if (!s.lastFinish || !s.lastHitSide || !renderer) return;
  const winner: 'A' | 'B' = s.roundWinner ?? s.lastHitSide;
  const defeated: 'A' | 'B' = winner === 'A' ? 'B' : 'A';
  // POV: winner sees green FINISH blast; loser sees red YOU LOSE blast.
  // Display/spectator gets green celebratory blast on the defeated.
  const iWon = myRole !== 'display' && mySide() === winner;
  const iLost = myRole !== 'display' && mySide() === defeated;
  const tone: 'win' | 'lose' = iLost ? 'lose' : 'win';
  renderer.triggerFinishBoom(defeated, tone);
  overlayHoldUntil = performance.now() + 3000; // match 3s boom before Round Over card
  playSfx('whoosh');
  if (iWon || myRole === 'display') {
    playSfx('finishWin');
  } else if (iLost) {
    playSfx('lose');
  } else {
    playSfx('finishWin');
  }
  playSfx('boom');
  vibrate([30, 40, 30, 40, 60]);
}

function reactToHitSfx(s: GameState): void {
  if (s.lastFinish) {
    triggerFinishFx(s);
    return;
  }
  if (s.lastMiss) {
    playSfx('whoosh');
    setTimeout(() => playSfx('miss'), 200);
    return;
  }
  playSfx('whoosh');
  playSfx('strip');
  if (s.lastStripAmt >= 0.7) {
    setTimeout(() => playSfx('plateFall'), 220);
  }
}

function bindDragAndFire(drag: HTMLElement, fire: HTMLButtonElement): void {
  // Inverse of aimColumnX: screenX = w/2 + aim * w * AIM_RANGE
  // Use the arena canvas (same pixel basis as drawn plates), not a different drag scale.
  const offsetFromClientX = (clientX: number, _rect: DOMRect): number => {
    const canvas = document.getElementById('arena') as HTMLCanvasElement | null;
    const basis = canvas ? canvas.getBoundingClientRect() : _rect;
    const mid = basis.left + basis.width / 2;
    const denom = Math.max(1, basis.width * AIM_RANGE);
    return Math.max(-1, Math.min(1, (clientX - mid) / denom));
  };

  const setAim = (clientX: number, rect: DOMRect, broadcastAim: boolean) => {
    aimOffset = offsetFromClientX(clientX, rect);
    if (renderer) renderer.localAimOffset = aimOffset;
    const hint = document.getElementById('drag-hint');
    if (hint) hint.classList.add('hidden');
    if (broadcastAim && !isAuthoritative) {
      net?.sendToHost({ type: 'aim', side: 'B', offset: aimOffset });
    }
  };

  // Drag zone: move only — never fires
  drag.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drag.setPointerCapture(e.pointerId);
    aimDragging = true;
    setAim(e.clientX, drag.getBoundingClientRect(), true);
  });
  drag.addEventListener('pointermove', (e) => {
    if (!aimDragging && !e.buttons) return;
    e.preventDefault();
    setAim(e.clientX, drag.getBoundingClientRect(), true);
  });
  drag.addEventListener('pointerup', (e) => {
    e.preventDefault();
    aimDragging = false;
    setAim(e.clientX, drag.getBoundingClientRect(), false);
  });
  drag.addEventListener('pointercancel', () => {
    aimDragging = false;
  });

  const doFire = () => {
    if (!state) return;
    if (state.phase !== 'playing') return;
    unlockAudio();
    const side = mySide();
    const cd = cooldownLeft(state, side);
    if (cd > 0.02) {
      fire.classList.add('fire-denied');
      setTimeout(() => fire.classList.remove('fire-denied'), 120);
      return;
    }
    const offset = aimOffset;
    const finishMine = state.finishReady && state.finishFavors === side;
    // Strip est: outer plates only (|offset| >= ~0.5)
    const foe = side === 'A' ? 'B' : 'A';
    const foePlates = foe === 'A' ? state.platesA : state.platesB;
    const estQuality = finishMine
      ? Math.max(0, 1 - Math.abs(offset) / 0.38)
      : aimQuality(offset, foePlates, leanFromPlates(state), side);
    const miss = finishMine ? Math.abs(offset) > 0.38 : estQuality < 0.32;
    if (renderer) {
      const from = renderer.playerZonePos('local');
      const canvas = document.getElementById('arena') as HTMLCanvasElement | null;
      const wrap = document.querySelector('.arena-wrap') as HTMLElement | null;
      if (canvas && wrap) {
        const cr = canvas.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        spawnHitPlates(side, estQuality, offset, miss, !!finishMine, {
          x: wr.left + (cr.left - wr.left) + from.x,
          y: wr.top + (cr.top - wr.top) + from.y,
        });
      } else {
        spawnHitPlates(side, estQuality, offset, miss, !!finishMine);
      }
    } else {
      spawnHitPlates(side, estQuality, offset, miss, !!finishMine);
    }
    playSfx('whoosh');

    if (isAuthoritative) {
      const seqBefore = state.hitSeq;
      applyHit(state, side, offset);
      vibrate(state.lastFinish ? [20, 40, 20] : state.lastHitQuality > 0.75 ? [12, 20, 12] : 10);
      if (state.hitSeq > seqBefore) {
        seenHitSeq = state.hitSeq;
        reactToHitSfx(state);
      }
      broadcast();
      refreshHud();
    } else {
      net?.sendToHost({ type: 'hit', side: 'B', offset, t: Date.now() });
      vibrate(10);
      seenHitSeq = (state.hitSeq ?? 0) + 1;
      state.coolB = HIT_COOLDOWN;
    }
  };

  fire.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    doFire();
  });
  // Prevent drag from stealing FIRE taps
  fire.addEventListener('pointerdown', (e) => e.stopPropagation());
}

function updateFireUi(): void {
  if (!state) return;
  const fire = document.getElementById('fire-btn');
  const tip = document.getElementById('hit-tip');
  const cdEl = document.getElementById('fire-cooldown');
  if (!fire || !tip) return;

  const side = mySide();
  const finishOn = state.phase === 'playing' && state.finishReady;
  const favorsMe = finishOn && state.finishFavors === side;

  fire.classList.toggle('finish-mode', !!finishOn);
  fire.classList.toggle('finish-favors-me', !!favorsMe);
  fire.classList.toggle('finish-threat', !!(finishOn && !favorsMe));
  const label = document.getElementById('fire-label');
  if (label) label.textContent = favorsMe ? 'FINISH' : 'FIRE';
  const bar = document.getElementById('fire-cooldown');

  const cd = cooldownLeft(state, side);
  fire.classList.toggle('on-cooldown', cd > 0.05);
  if (cdEl || bar) {
    const elCd = (cdEl || bar)!;
    if (cd > 0.05) {
      elCd.style.transform = `scaleX(${Math.min(1, cd / HIT_COOLDOWN)})`;
      elCd.classList.add('visible');
    } else {
      elCd.classList.remove('visible');
    }
  }

  if (favorsMe) {
    tip.textContent = 'FINISH — drag to CENTER, then tap FINISH!';
    tip.classList.add('tip-alert', 'finish-alert');
  } else if (finishOn) {
    tip.textContent = 'They can FINISH — outer-plate chips to recover!';
    tip.classList.add('tip-alert');
    tip.classList.remove('finish-alert');
  } else if (cd > 0.05 && (side === 'A' ? state.stunA : state.stunB) > 0) {
    tip.textContent = 'Brief stun — wait…';
    tip.classList.add('tip-alert');
    tip.classList.remove('finish-alert');
  } else {
    tip.textContent = state.overtimeActive
      ? 'OVERTIME — double chip power! Still need a FINISH to win.'
      : state.coachTip || 'Drag yourself · FIRE · only outer plates chip';
    tip.classList.remove('tip-alert', 'finish-alert');
  }
}


function refreshHud(): void {
  if (!state) return;
  normalizeState(state);

  const meta = document.getElementById('hud-meta');
  const score = document.getElementById('hud-score');
  const time = document.getElementById('hud-time');
  const banner = document.getElementById('you-banner');

  if (banner && myRole !== 'display') {
    banner.textContent = `YOU · ${mySide()}`;
  }

  if (meta) {
    meta.innerHTML = `<strong>${state.roomCode}</strong> · R${state.round}${
      state.aiEnabled ? ' · AI' : ''
    }${state.finishReady ? ' · FINISH' : ''}`;
  }
  if (score) {
    score.innerHTML = `<span class="sc-a">A <strong>${state.scoreA}</strong></span> — <span class="sc-b"><strong>${state.scoreB}</strong> B</span>`;
  }
  if (time) {
    if (state.phase === 'playing' || state.phase === 'countdown') {
      const sec = Math.ceil(Math.max(0, state.timeLeft));
      time.innerHTML = state.overtimeActive
        ? `<strong class="ot">OT ${sec}s</strong>`
        : `<strong>${sec}s</strong>`;
    } else {
      time.innerHTML = state.phase.toUpperCase();
    }
  }

  updateFireUi();

  const overlay = document.getElementById('overlay');
  const title = document.getElementById('ov-title');
  const body = document.getElementById('ov-body');
  const actions = document.getElementById('ov-actions');
  if (!overlay || !title || !body || !actions) return;

  if (state.phase === 'lobby') {
    overlay.classList.remove('hidden');
    title.textContent = myRole === 'display' ? 'Display lobby' : `You are Player ${mySide()}`;
    body.textContent = isAuthoritative
      ? `Code ${state.roomCode} — start when ready. Outer chips → FINISH shot wins (timer never crowns you).`
      : 'Waiting for host to start…';
    actions.innerHTML = '';
    if (isAuthoritative) {
      const b = button('Start', 'primary', () => {
        startCountdown(state!);
        broadcast();
        overlay.classList.add('hidden');
      });
      actions.append(b);
    }
  } else if (state.phase === 'roundOver' || state.phase === 'matchOver') {
    // Let the FINISH explosion play for 3s before showing the score card
    if (performance.now() < overlayHoldUntil || (renderer && renderer.finishBoomActive)) {
      overlay.classList.add('hidden');
      return;
    }
    overlay.classList.remove('hidden');
    const match = state.phase === 'matchOver';
    const timeUp = !match && !state.roundWinner;
    title.textContent = match ? 'Match Over' : timeUp ? 'Time Up' : 'Round Over';
    // lastEvent already carries "FINISH hit" or "TIME UP — no FINISH…"
    body.textContent = state.lastEvent;
    actions.innerHTML = '';
    if (isAuthoritative) {
      const b = button(match ? 'Rematch' : 'Next Round', 'primary', () => {
        nextRound(state!);
        broadcast();
      });
      actions.append(b);
      actions.append(button('Home', 'ghost', () => showHome()));
    }
  } else {
    overlay.classList.add('hidden');
  }
}

function loop(ts: number): void {
  raf = requestAnimationFrame(loop);
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  if (!state || !renderer) return;

  if (renderer.opponentFlash > 0) {
    renderer.opponentFlash = Math.max(0, renderer.opponentFlash - dt * 1.8);
  }

  if (isAuthoritative) {
    const prevPhase = state.phase;
    const prevEv = state.lastEvent;
    const prevFinish = state.finishReady;
    const prevSeq = state.hitSeq;

    step(state, dt);
    updateAI(state, dt, aiAcc);

    if (state.hitSeq > prevSeq && state.hitSeq > seenHitSeq) {
      onRemoteHit(state);
    }

    // FINISH mode start SFX
    if (!prevFinish && state.finishReady) {
      playSfx('finishMode');
    }
    // Tilt warning approaching 45°
    const leanAbs = Math.abs(((state.platesA - state.platesB) / 8) * (Math.PI * 0.42));
    const nearTip = leanAbs > (Math.PI / 4) * 0.72 && !state.finishReady;
    if (nearTip && !lastTiltWarn) {
      playSfx('tiltWarn');
      lastTiltWarn = true;
    }
    if (!nearTip) lastTiltWarn = false;
    lastFinishReady = state.finishReady;

    if (state.phase === 'countdown') {
      const cd = Math.ceil(state.countdown);
      if (cd !== lastCountdownCeil && cd >= 1) {
        lastCountdownCeil = cd;
        playSfx('countdown');
      }
    } else if (prevPhase === 'countdown' && state.phase === 'playing') {
      playSfx('go');
      lastCountdownCeil = -1;
    }

    if (state.tick % 2 === 0) broadcast();
    if (
      state.phase !== prevPhase ||
      state.lastEvent !== prevEv ||
      state.finishReady !== prevFinish
    ) {
      if (state.phase === 'roundOver' || state.phase === 'matchOver') {
        vibrate([30, 40, 30]);
        if (!state.roundWinner) {
          playSfx('miss'); // time-up draw — no FINISH, no win fanfare
        } else {
          const iWon =
            (state.roundWinner === 'A' && mySide() === 'A') ||
            (state.roundWinner === 'B' && mySide() === 'B');
          playSfx(iWon ? 'win' : 'lose');
        }
      }
      refreshHud();
    }
    if (state.tick % 8 === 0) refreshHud();
    prevEvent = state.lastEvent;
    lastPhase = state.phase;
  } else {
    if (state.phase === 'countdown') {
      const cd = Math.ceil(state.countdown);
      if (cd !== lastCountdownCeil && cd >= 1) {
        lastCountdownCeil = cd;
        playSfx('countdown');
      }
    }
    if (lastPhase === 'countdown' && state.phase === 'playing') {
      playSfx('go');
      lastCountdownCeil = -1;
    }
    if (
      (state.phase === 'roundOver' || state.phase === 'matchOver') &&
      lastPhase !== state.phase
    ) {
      if (!state.roundWinner) {
        if (myRole !== 'display') playSfx('miss');
      } else {
        const iWon =
          (state.roundWinner === 'A' && mySide() === 'A') ||
          (state.roundWinner === 'B' && mySide() === 'B');
        if (myRole !== 'display') playSfx(iWon ? 'win' : 'lose');
        else playSfx('win');
      }
    }
    if (!lastFinishReady && state.finishReady) playSfx('finishMode');
    lastFinishReady = state.finishReady;
    if (state.hitSeq > seenHitSeq) onRemoteHit(state);
    lastPhase = state.phase;
    prevEvent = state.lastEvent;
    refreshHud();
  }

  flyPlates?.update(ts);
  renderer.localAimOffset = aimOffset;
  renderer.draw(state);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      navigator.serviceWorker.register('./sw-fallback.js').catch(() => undefined);
    });
  });
}

showHome();
