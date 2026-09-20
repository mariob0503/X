/**
 * P2P-primary (PeerJS/WebRTC) with WebSocket /pr-net backup.
 * Host listens on BOTH so guest can fall back without re-entering the code.
 * Guest hard-budgets direct+TURN at 8s, then RelayNet immediately.
 */
import type { GameState, NetMessage, Role } from '../game/types';
import {
  PeerNet,
  humanJoinError as peerHumanError,
  isNegotiationError,
  normalizeRoomCode,
  randomRoomCode,
} from './peer';
import { RelayNet, humanJoinError as relayHumanError } from './relay';

export { normalizeRoomCode, randomRoomCode, isNegotiationError };

/** Guest must leave PeerJS (incl. TURN retry) within this budget. */
const GUEST_DIRECT_BUDGET_MS = 8000;

export type StatusKind = 'ok' | 'err' | 'warn' | '';

export type NetHandlers = {
  onOpen?: (id: string) => void;
  onError?: (err: Error) => void;
  onPeerJoined?: (role: 'playerB' | 'display') => void;
  onPeerLeft?: (role: string) => void;
  onMessage?: (msg: NetMessage) => void;
  onStatus?: (text: string, kind?: StatusKind) => void;
};

export function humanJoinError(err: unknown): string {
  const r = relayHumanError(err);
  if (r && r !== 'Could not join room') return r;
  return peerHumanError(err);
}

export type TransportMode = 'peer' | 'relay' | 'solo' | null;

/**
 * Unified net: try direct WebRTC first; on failure use WS backup (same room).
 */
export class PlateRaceNet {
  role: Role;
  roomCode: string;
  handlers: NetHandlers;
  mode: TransportMode = null;
  private peer: PeerNet | null = null;
  private relay: RelayNet | null = null;
  private destroyed = false;
  private announced = new Set<string>();
  private peerPathOk = false;
  private relayPathOk = false;
  /** Once B (or display) joins via any path, lock lobby status away from peer fatals. */
  private lobbyJoined = false;
  private joinVia: 'peer' | 'relay' | null = null;

  constructor(role: Role, roomCode: string, handlers: NetHandlers = {}) {
    this.role = role;
    this.roomCode = normalizeRoomCode(roomCode);
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    this.destroyed = false;
    this.announced.clear();
    this.mode = null;
    this.peerPathOk = false;
    this.relayPathOk = false;
    this.lobbyJoined = false;
    this.joinVia = null;

    if (this.role === 'solo') {
      this.mode = 'solo';
      this.handlers.onStatus?.('Solo ready (offline)', 'ok');
      this.handlers.onOpen?.('solo');
      return;
    }

    if (this.role === 'host') {
      await this.startHostDual();
      return;
    }

    await this.startGuestPreferPeer();
  }

  /** Host: PeerJS + WS in parallel so either guest path can mark B connected. */
  private async startHostDual(): Promise<void> {
    this.handlers.onStatus?.('Opening room (direct + backup)…');

    this.peer = new PeerNet('host', this.roomCode, {
      onOpen: (id) => this.handlers.onOpen?.(id),
      onError: (err) => console.warn('[PlateRaceNet] peer host error', err),
      onPeerJoined: (role) => this.noteJoined(role, 'peer'),
      onPeerLeft: (role) => this.handlers.onPeerLeft?.(role),
      onMessage: (msg) => this.handlers.onMessage?.(msg),
      onStatus: (text, kind) => this.forwardHostPeerStatus(text, kind),
    });
    this.relay = new RelayNet('host', this.roomCode, {
      onOpen: (id) => this.handlers.onOpen?.(id),
      onError: (err) => console.warn('[PlateRaceNet] relay host error', err),
      onPeerJoined: (role) => this.noteJoined(role, 'relay'),
      onPeerLeft: (role) => this.handlers.onPeerLeft?.(role),
      onMessage: (msg) => this.handlers.onMessage?.(msg),
      onStatus: (text, kind) => {
        // After B is connected, never show relay fatals either
        if (this.lobbyJoined) return;
        // Relay errors are real only if peer is also down
        if (kind === 'err' && !this.peerPathOk) {
          this.handlers.onStatus?.(text, kind);
        }
      },
    });

    const results = await Promise.allSettled([this.peer.start(), this.relay.start()]);
    if (this.destroyed) return;

    const peerOk = results[0].status === 'fulfilled';
    const relayOk = results[1].status === 'fulfilled';
    this.peerPathOk = peerOk;
    this.relayPathOk = relayOk;

    if (!peerOk && !relayOk) {
      const err =
        results[0].status === 'rejected'
          ? results[0].reason
          : results[1].status === 'rejected'
            ? results[1].reason
            : new Error('Could not open room');
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.mode = peerOk ? 'peer' : 'relay';
    const paths = [peerOk ? 'direct' : null, relayOk ? 'backup' : null]
      .filter(Boolean)
      .join(' + ');
    this.handlers.onStatus?.(
      `Room live · ${this.roomCode} · waiting for Player B (${paths})`,
      'ok'
    );
    this.handlers.onOpen?.(this.roomCode);
  }

  /**
   * PeerJS negotiation noise must not replace green lobby status when WS backup
   * is listening / already connected. Soft warning only — never fatal red once
   * backup is up or B has joined.
   */
  private forwardHostPeerStatus(text: string, kind?: StatusKind): void {
    if (kind !== 'err') return;
    // Once B joined (any path), lock Connected status — ignore peer fatals.
    if (this.lobbyJoined) return;
    if (this.relayPathOk) {
      // Soft tip only while still waiting for B (backup is listening).
      this.handlers.onStatus?.(
        'Direct path noisy — backup still listening',
        'warn'
      );
      return;
    }
    this.handlers.onStatus?.(text, kind);
  }

  /** Guest: PeerJS (incl. TURN) ≤ 8s; on fail/timeout → WS same room. */
  private async startGuestPreferPeer(): Promise<void> {
    const role = this.role === 'display' ? 'display' : 'playerB';

    this.handlers.onStatus?.('Trying direct…');
    this.peer = new PeerNet(role, this.roomCode, {
      onStatus: (t, k) => {
        // Keep TURN / trying messages; ignore PeerJS fatal red during budget
        if (k === 'err' && /latest build|hard-refresh|Direct phone link failed/i.test(t)) {
          return;
        }
        this.handlers.onStatus?.(t, k === 'err' ? '' : k);
      },
      onError: (e) => console.warn('[PlateRaceNet] peer', e),
      onMessage: (msg) => this.handlers.onMessage?.(msg),
      onPeerLeft: (r) => this.handlers.onPeerLeft?.(r),
      onOpen: (id) => this.handlers.onOpen?.(id),
    });

    let directOk = false;
    let budgetTimer = 0;
    try {
      await Promise.race([
        this.peer.start().then(() => {
          directOk = true;
          if (budgetTimer) window.clearTimeout(budgetTimer);
        }),
        new Promise<never>((_, reject) => {
          budgetTimer = window.setTimeout(() => {
            reject(new Error('Direct link budget exceeded'));
          }, GUEST_DIRECT_BUDGET_MS);
        }),
      ]);
      if (budgetTimer) window.clearTimeout(budgetTimer);
      if (this.destroyed) return;
      if (directOk) {
        this.mode = 'peer';
        this.relay = null;
        this.handlers.onStatus?.('Connected (direct)', 'ok');
        return;
      }
    } catch (e1) {
      if (budgetTimer) window.clearTimeout(budgetTimer);
      console.warn('[PlateRaceNet] direct failed/timed out, trying backup', e1);
    }

    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;

    if (this.destroyed) throw new Error('Cancelled');

    this.handlers.onStatus?.(
      'Direct path failed — connecting via backup server…',
      'err'
    );

    this.relay = new RelayNet(role, this.roomCode, {
      onStatus: (t, k) => {
        if (k === 'err') this.handlers.onStatus?.(t, k);
      },
      onError: (e) => this.handlers.onError?.(e),
      onMessage: (msg) => this.handlers.onMessage?.(msg),
      onPeerLeft: (r) => this.handlers.onPeerLeft?.(r),
      onOpen: (id) => this.handlers.onOpen?.(id),
    });

    try {
      await this.relay.start();
      if (this.destroyed) return;
      this.mode = 'relay';
      this.handlers.onStatus?.('Connected (backup)', 'ok');
    } catch (e2) {
      const err = e2 instanceof Error ? e2 : new Error(String(e2));
      throw new Error(humanJoinError(err));
    }
  }

  private noteJoined(role: 'playerB' | 'display', via: 'peer' | 'relay'): void {
    if (this.announced.has(role)) return;
    this.announced.add(role);
    this.lobbyJoined = true;
    this.joinVia = via;
    // Prefer active mode for status label when both paths are live
    if (via === 'relay') this.mode = 'relay';
    else if (via === 'peer' && this.mode !== 'relay') this.mode = 'peer';
    this.handlers.onPeerJoined?.(role);
    if (role === 'playerB') {
      const label =
        via === 'relay'
          ? 'Player B connected (backup)'
          : 'Player B connected (direct)';
      this.handlers.onStatus?.(label, 'ok');
    } else {
      this.handlers.onStatus?.('Display connected', 'ok');
    }
  }

  sendToHost(msg: NetMessage): void {
    if (this.mode === 'peer') this.peer?.sendToHost(msg);
    else if (this.mode === 'relay') this.relay?.sendToHost(msg);
  }

  broadcastState(state: GameState): void {
    // Dual-send so whichever path the guest used receives state
    this.peer?.broadcastState(state);
    this.relay?.broadcastState(state);
  }

  sendHit(side: 'A' | 'B', offset: number): void {
    const msg: NetMessage = { type: 'hit', side, offset, t: Date.now() };
    if (this.role === 'host' || this.role === 'solo') {
      this.handlers.onMessage?.(msg);
    } else {
      this.sendToHost(msg);
    }
  }

  /** Host signals start over relay (P2P guests already get state broadcast). */
  sendStart(): void {
    if (this.role !== 'host') return;
    this.relay?.sendStart();
  }

  destroy(): void {
    this.destroyed = true;
    try {
      this.peer?.destroy();
      this.relay?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;
    this.relay = null;
    this.mode = null;
    this.announced.clear();
    this.peerPathOk = false;
    this.relayPathOk = false;
    this.lobbyJoined = false;
    this.joinVia = null;
  }
}
