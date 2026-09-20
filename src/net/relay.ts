/**
 * WebSocket room relay — phones talk to the game server (same Cloudflare URL),
 * not phone-to-phone. Avoids Wi‑Fi client-isolation / flaky TURN.
 */
import type { GameState, NetMessage, Role } from '../game/types';

export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export function randomRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return s;
}

export type NetHandlers = {
  onOpen?: (id: string) => void;
  onError?: (err: Error) => void;
  onPeerJoined?: (role: 'playerB' | 'display') => void;
  onPeerLeft?: (role: string) => void;
  onMessage?: (msg: NetMessage) => void;
  onStatus?: (text: string, kind?: 'ok' | 'err' | '') => void;
};

/** Soft, accurate join errors — no VPN-blaming. */
export function humanJoinError(err: unknown): string {
  const m =
    err instanceof Error
      ? err.message
      : err && typeof err === 'object' && 'message' in err
        ? String((err as { message: string }).message)
        : String(err ?? '');
  const lower = m.toLowerCase();
  if (/room not found|not found|keep the lobby/i.test(lower)) {
    return 'Room not found — host must keep the lobby open, double-check the code.';
  }
  if (/invalid room/i.test(lower)) {
    return 'Invalid room code — need 6 letters/numbers.';
  }
  if (/host left/i.test(lower)) {
    return 'Host left the room.';
  }
  if (/websocket|failed to fetch|network|reach game server|connection refused|timeout/i.test(lower)) {
    return 'Could not reach game server — check the link, hard-refresh both devices, try again.';
  }
  if (/negotiation|ice|webrtc|peerjs|turn/i.test(lower)) {
    return 'Direct phone link failed — use the latest build (server relay). Hard-refresh both devices.';
  }
  return m || 'Could not join room';
}

function relayUrl(): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/pr-net`;
}

/**
 * Drop-in replacement for the old PeerJS PlateRaceNet.
 * Host/guest sync via server WebSocket rooms.
 */
export class RelayNet {
  role: Role;
  roomCode: string;
  handlers: NetHandlers;
  private ws: WebSocket | null = null;
  private destroyed = false;
  private opened = false;

  constructor(role: Role, roomCode: string, handlers: NetHandlers = {}) {
    this.role = role;
    this.roomCode = normalizeRoomCode(roomCode);
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    this.destroyed = false;
    if (this.role === 'solo') {
      this.handlers.onStatus?.('Solo ready', 'ok');
      this.handlers.onOpen?.('solo');
      return;
    }
    await this.connectAndSeat();
  }

  private connectAndSeat(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = relayUrl();
      this.handlers.onStatus?.('Connecting to game server…');
      console.log('[RelayNet/WS]', 'open', url, this.role, this.roomCode);

      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.handlers.onError?.(err);
        reject(err);
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      };

      const timer = window.setTimeout(() => {
        fail(new Error('Could not reach game server (timeout)'));
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
      }, 20000);

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        fail(new Error('Could not reach game server'));
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this.opened = true;
        if (this.role === 'host') {
          ws.send(JSON.stringify({ type: 'host', room: this.roomCode }));
        } else {
          const role = this.role === 'display' ? 'display' : 'playerB';
          ws.send(JSON.stringify({ type: 'join', room: this.roomCode, role }));
        }
      };

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const type = String(msg.type || '');

        if (type === 'hosted') {
          this.handlers.onOpen?.(this.roomCode);
          this.handlers.onStatus?.(
            `Room live · ${this.roomCode} · waiting for Player B`,
            'ok'
          );
          ok();
          return;
        }
        if (type === 'joined') {
          this.handlers.onOpen?.(this.roomCode);
          this.handlers.onStatus?.('Connected — waiting for host to start', 'ok');
          // Tell host we're here with a hello (game-level)
          const role = this.role === 'display' ? 'display' : 'playerB';
          this.sendRaw({ type: 'msg', payload: { type: 'hello', role } satisfies NetMessage });
          ok();
          return;
        }
        if (type === 'peer-joined') {
          const role = msg.role === 'display' ? 'display' : 'playerB';
          this.handlers.onPeerJoined?.(role);
          return;
        }
        if (type === 'peer-left') {
          this.handlers.onPeerLeft?.(String(msg.role || 'peer'));
          return;
        }
        if (type === 'start') {
          this.handlers.onMessage?.({ type: 'start' });
          return;
        }
        if (type === 'msg' && msg.payload) {
          this.handlers.onMessage?.(msg.payload as NetMessage);
          return;
        }
        if (type === 'error') {
          const err = new Error(String(msg.message || 'Server error'));
          this.handlers.onStatus?.(humanJoinError(err), 'err');
          if (!settled) fail(err);
          return;
        }
      };

      ws.onerror = () => {
        console.warn('[RelayNet/WS] error');
        if (!settled) fail(new Error('Could not reach game server'));
      };

      ws.onclose = () => {
        this.opened = false;
        if (this.destroyed) return;
        if (!settled) {
          fail(new Error('Could not reach game server'));
          return;
        }
        this.handlers.onStatus?.('Disconnected from game server', 'err');
        this.handlers.onPeerLeft?.('host');
      };
    });
  }

  private sendRaw(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  sendStart(): void {
    if (this.role !== 'host') return;
    this.sendRaw({ type: 'start', room: this.roomCode });
  }

  sendToHost(msg: NetMessage): void {
    this.sendRaw({ type: 'msg', payload: msg });
  }

  broadcastState(state: GameState): void {
    const msg: NetMessage = { type: 'state', state };
    this.sendRaw({ type: 'msg', payload: msg });
  }

  sendHit(side: 'A' | 'B', offset: number): void {
    const msg: NetMessage = { type: 'hit', side, offset, t: Date.now() };
    if (this.role === 'host' || this.role === 'solo') {
      this.handlers.onMessage?.(msg);
    } else {
      this.sendToHost(msg);
    }
  }

  destroy(): void {
    this.destroyed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.opened = false;
  }
}
