import Peer, { type DataConnection } from 'peerjs';
import type { GameState, NetMessage, Role } from '../game/types';
import { PEER_PREFIX } from '../game/types';

/** Strip spaces/punctuation, uppercase, keep 6 alphanumerics. */
export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export function randomRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return s;
}

export function peerIdForRoom(code: string): string {
  return `${PEER_PREFIX}${normalizeRoomCode(code)}`;
}

export type NetHandlers = {
  onOpen?: (id: string) => void;
  onError?: (err: Error) => void;
  onPeerJoined?: (role: 'playerB' | 'display', conn: DataConnection) => void;
  onPeerLeft?: (role: string) => void;
  onMessage?: (msg: NetMessage, from: DataConnection) => void;
  onStatus?: (text: string, kind?: 'ok' | 'err' | '') => void;
};

/**
 * Multi-provider ICE. PeerJS cloud TURN (peerjs/peerjsp) + Metered openrelay
 * (UDP/TCP/TLS) + Google/Cloudflare STUN. Dead entries are skipped by the
 * browser; more options = better chance through VPN/CGNAT/firewall.
 */
const ICE_SERVERS: RTCIceServer[] = [
  // STUN
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'stun:global.stun.twilio.com:3478' },

  // Official PeerJS TURN (ships with peerjs util.defaultConfig)
  {
    urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
    username: 'peerjs',
    credential: 'peerjsp',
  },

  // Metered Open Relay — free public credentials (UDP + TCP + TLS)
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:80?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turns:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turns:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  // Alias host used in Metered docs
  {
    urls: 'turn:standard.relay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:standard.relay.metered.ca:80?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turns:standard.relay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turns:standard.relay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

/** Host can wait longer on broker; guest must fail fast for WS backup. */
const HOST_BROKER_TIMEOUT_MS = 22000;
const GUEST_BROKER_TIMEOUT_MS = 4000;
/** Per dial attempt (guest). Two attempts + broker must fit ≤ ~8s hybrid budget. */
const GUEST_DIAL_TIMEOUT_MS = 3200;
const HOST_DIAL_TIMEOUT_MS = 28000;

function peerOpts(iceTransportPolicy: RTCIceTransportPolicy = 'all') {
  return {
    debug: 2 as const,
    host: '0.peerjs.com',
    port: 443,
    path: '/',
    secure: true,
    key: 'peerjs',
    config: {
      iceServers: ICE_SERVERS,
      iceTransportPolicy,
      sdpSemantics: 'unified-plan' as const,
    },
  };
}

function errType(err: unknown): string {
  if (err && typeof err === 'object' && 'type' in err) {
    return String((err as { type: string }).type);
  }
  return '';
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: string }).message);
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

/** True when WebRTC ICE / PeerJS negotiation failed (not “room missing”). */
export function isNegotiationError(err: unknown): boolean {
  const t = errType(err);
  const m = errMessage(err).toLowerCase();
  if (t === 'peer-unavailable' || t === 'unavailable-id') return false;
  return (
    /negotiation|ice|webrtc|could not connect|connection.*fail|failed to establish|dtls|candidate/i.test(
      m
    ) || t === 'network'
  );
}

/** Lobby-facing copy for join failures. */
export function humanJoinError(err: unknown): string {
  const t = errType(err);
  const m = errMessage(err);

  if (t === 'peer-unavailable' || /not found|does not exist|could not find/i.test(m)) {
    return 'Room not found — host must keep the lobby open, double-check the code.';
  }
  if (t === 'unavailable-id') {
    return 'Room code still reserved — host: go Back and create a new room.';
  }
  if (isNegotiationError(err) || /negotiation of connection/i.test(m)) {
    return 'Direct phone link failed (Wi‑Fi often blocks device-to-device). Use the latest build with server relay — hard-refresh both devices.';
  }
  if (/timeout/i.test(m)) {
    return 'Direct link timed out — backup server will try, or keep host on lobby and retry.';
  }
  if (t === 'websocket-error' || t === 'server-error') {
    return 'PeerJS broker hiccup — wait a few seconds and try again.';
  }
  return m || 'Could not join room';
}

/**
 * Host registers a deterministic PeerJS id from the room code.
 * Guests dial that id via 0.peerjs.com; game data is WebRTC.
 *
 * Handshake (metadata + hello/welcome) kept from prior fix.
 * ICE: multi STUN/TURN + automatic relay-only retry on negotiation failure.
 */
export class PeerNet {
  peer: Peer | null = null;
  role: Role;
  roomCode: string;
  handlers: NetHandlers;
  connToHost: DataConnection | null = null;
  playerB: DataConnection | null = null;
  display: DataConnection | null = null;
  private destroyed = false;
  private welcomed = false;
  private announced = new Set<string>();
  private icePolicy: RTCIceTransportPolicy = 'all';
  /** Reject in-flight guest dial when destroy() / budget abort runs. */
  private dialAbort: ((err: Error) => void) | null = null;

  constructor(role: Role, roomCode: string, handlers: NetHandlers = {}) {
    this.role = role;
    this.roomCode = normalizeRoomCode(roomCode);
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    this.destroyed = false;
    this.announced.clear();
    this.welcomed = false;
    this.icePolicy = 'all';
    this.log('start', this.role, this.roomCode, peerIdForRoom(this.roomCode));

    if (this.role === 'host' || this.role === 'solo') {
      await this.openAsHost();
      // Host peer stays alive for the whole lobby — do not recycle id mid-wait.
      this.peer!.on('connection', (conn) => this.handleIncoming(conn));
      this.handlers.onStatus?.(
        `Room live · ${this.roomCode} · waiting for Player B (direct link)`,
        'ok'
      );
    } else {
      await this.openGuestPeer('all');
      await this.dialHostWithIceRetry();
    }
  }

  private log(...args: unknown[]): void {
    console.log('[PlateRaceNet]', ...args);
  }

  private async openAsHost(): Promise<void> {
    const id = peerIdForRoom(this.roomCode);
    try {
      await this.createAndWaitOpen(id, 'all');
    } catch (e) {
      if (errType(e) === 'unavailable-id') {
        this.log('host id busy, retrying once…');
        this.handlers.onStatus?.('Room id busy on broker — retrying…', 'err');
        this.teardownPeerOnly();
        await sleep(1500);
        await this.createAndWaitOpen(id, 'all');
      } else {
        throw this.wrapErr(e, 'Host could not open PeerJS room');
      }
    }
  }

  private async openGuestPeer(policy: RTCIceTransportPolicy): Promise<void> {
    this.icePolicy = policy;
    try {
      await this.createAndWaitOpen(undefined, policy);
    } catch (e) {
      throw this.wrapErr(e, 'Could not reach PeerJS broker');
    }
  }

  private teardownPeerOnly(): void {
    try {
      this.connToHost?.close();
    } catch {
      /* ignore */
    }
    this.connToHost = null;
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;
    this.welcomed = false;
  }

  private createAndWaitOpen(
    id: string | undefined,
    iceTransportPolicy: RTCIceTransportPolicy
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const opts = peerOpts(iceTransportPolicy);
      this.log('creating peer', id ?? '(ephemeral)', 'icePolicy=', iceTransportPolicy);
      this.peer = id ? new Peer(id, opts) : new Peer(opts);

      let settled = false;
      const brokerMs =
        this.role === 'host' || this.role === 'solo'
          ? HOST_BROKER_TIMEOUT_MS
          : GUEST_BROKER_TIMEOUT_MS;
      const t = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error('PeerJS broker timeout — check network, then retry')
        );
      }, brokerMs);

      const finishOk = (pid: string) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(t);
        this.log('peer open', pid, 'icePolicy=', iceTransportPolicy);
        this.handlers.onOpen?.(pid);
        this.peer?.on('error', (err) => {
          this.log('peer error (post-open)', errType(err), errMessage(err));
          // Don't kill lobby on transient post-open errors — surface only.
          this.handlers.onStatus?.(humanJoinError(err), 'err');
        });
        resolve();
      };

      this.peer.on('open', finishOk);
      this.peer.on('error', (err) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(t);
        this.log('peer open error', errType(err), errMessage(err));
        this.handlers.onError?.(this.wrapErr(err, 'Peer open failed'));
        reject(err);
      });
    });
  }

  private wrapErr(err: unknown, prefix: string): Error {
    return new Error(`${prefix}: ${humanJoinError(err)}`);
  }

  /** Watch ICE state for logging + optional UI hint. */
  private attachIceWatch(conn: DataConnection, label: string): void {
    const pc = conn.peerConnection;
    if (!pc) return;
    const dump = () => {
      this.log(
        `ICE[${label}]`,
        'connection=',
        pc.iceConnectionState,
        'gathering=',
        pc.iceGatheringState,
        'signaling=',
        pc.signalingState
      );
    };
    pc.addEventListener('iceconnectionstatechange', () => {
      dump();
      if (pc.iceConnectionState === 'failed') {
        this.handlers.onStatus?.(
          'Direct ICE failed — retrying via TURN, then backup server if needed…',
          'err'
        );
      } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.log(`ICE[${label}] connected OK`);
      } else if (pc.iceConnectionState === 'disconnected') {
        this.handlers.onStatus?.('Peer briefly disconnected…', 'err');
      }
    });
    pc.addEventListener('icegatheringstatechange', dump);
    dump();
  }

  private handleIncoming(conn: DataConnection): void {
    this.log('incoming connection from', conn.peer, 'meta', conn.metadata);
    this.attachIceWatch(conn, 'host-in');

    // Attach data listener IMMEDIATELY (before open) so hello can't be lost.
    conn.on('data', (raw) => this.onHostData(conn, raw));

    const accept = (role: 'playerB' | 'display') => {
      if (role === 'playerB') {
        if (this.playerB && this.playerB !== conn) {
          try {
            this.playerB.close();
          } catch {
            /* ignore */
          }
        }
        this.playerB = conn;
      } else {
        this.display = conn;
      }
      try {
        conn.send({ type: 'welcome', role } satisfies NetMessage);
      } catch (e) {
        this.log('welcome send failed', e);
      }
      const key = `${role}:${conn.connectionId || conn.peer}`;
      if (!this.announced.has(key)) {
        this.announced.add(key);
        this.handlers.onPeerJoined?.(role, conn);
        this.handlers.onStatus?.(
          role === 'playerB' ? 'Player B connected' : 'Display connected',
          'ok'
        );
        this.log('accepted', role);
      } else {
        this.log('re-ack', role);
      }
    };

    const tryMeta = () => {
      const meta = conn.metadata as { role?: string } | undefined;
      const r = meta?.role;
      if (r === 'playerB' || r === 'display') {
        if ((r === 'playerB' && this.playerB === conn) || (r === 'display' && this.display === conn)) {
          return;
        }
        if (r === 'playerB' && this.playerB && this.playerB !== conn) return;
        if (r === 'display' && this.display && this.display !== conn) return;
        if (r === 'playerB' && !this.playerB) accept('playerB');
        else if (r === 'display' && !this.display) accept('display');
      }
    };

    conn.on('open', () => {
      this.log('incoming channel open');
      this.handlers.onStatus?.('Peer channel open — waiting for hello…');
      tryMeta();
    });

    conn.on('close', () => {
      this.log('incoming closed', conn.peer);
      if (conn === this.playerB) {
        this.playerB = null;
        this.handlers.onPeerLeft?.('playerB');
      }
      if (conn === this.display) {
        this.display = null;
        this.handlers.onPeerLeft?.('display');
      }
    });

    conn.on('error', (err) => {
      this.log('incoming conn error', err);
      this.handlers.onStatus?.(humanJoinError(err), 'err');
    });

    if (conn.open) tryMeta();
  }

  private onHostData(conn: DataConnection, raw: unknown): void {
    const msg = raw as NetMessage;
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return;

    if (msg.type === 'hello') {
      const role = msg.role === 'display' ? 'display' : 'playerB';
      if (role === 'playerB') {
        if (this.playerB && this.playerB !== conn) {
          try {
            this.playerB.close();
          } catch {
            /* ignore */
          }
        }
        this.playerB = conn;
        try {
          conn.send({ type: 'welcome', role } satisfies NetMessage);
        } catch {
          /* ignore */
        }
        const key = `playerB:${conn.connectionId || conn.peer}`;
        if (!this.announced.has(key)) {
          this.announced.add(key);
          this.handlers.onPeerJoined?.('playerB', conn);
          this.handlers.onStatus?.('Player B connected', 'ok');
        }
      } else {
        this.display = conn;
        try {
          conn.send({ type: 'welcome', role } satisfies NetMessage);
        } catch {
          /* ignore */
        }
        const key = `display:${conn.connectionId || conn.peer}`;
        if (!this.announced.has(key)) {
          this.announced.add(key);
          this.handlers.onPeerJoined?.('display', conn);
          this.handlers.onStatus?.('Display connected', 'ok');
        }
      }
    }

    this.handlers.onMessage?.(msg, conn);
  }

  /**
   * Attempt 1: iceTransportPolicy 'all' (host + srflx + relay).
   * Attempt 2: recreate guest peer with 'relay' (force TURN) — fixes VPN/CGNAT.
   */
  private async dialHostWithIceRetry(): Promise<void> {
    const hostId = peerIdForRoom(this.roomCode);

    try {
      this.handlers.onStatus?.('Trying direct…');
      await this.connectToHost(hostId);
      return;
    } catch (e1) {
      this.log('dial attempt 1 failed', errType(e1), errMessage(e1));
      if (this.destroyed) throw new Error('Cancelled');
      if (errType(e1) === 'peer-unavailable') {
        throw this.wrapErr(e1, 'Could not join room');
      }
      this.handlers.onStatus?.('TURN…');
    }

    // Clean failed connection, recreate peer forced onto TURN.
    try {
      this.connToHost?.close();
    } catch {
      /* ignore */
    }
    this.connToHost = null;
    this.teardownPeerOnly();
    await sleep(200);
    if (this.destroyed) throw new Error('Cancelled');

    await this.openGuestPeer('relay');
    if (this.destroyed) throw new Error('Cancelled');
    this.handlers.onStatus?.('TURN…');
    try {
      await this.connectToHost(hostId);
    } catch (e2) {
      this.log('dial attempt 2 (relay) failed', errType(e2), errMessage(e2));
      if (this.destroyed) throw new Error('Cancelled');
      throw new Error(`Could not join room: ${humanJoinError(e2)}`);
    }
  }

  private connectToHost(hostId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.peer) {
        reject(new Error('Peer not ready'));
        return;
      }
      const role = this.role === 'display' ? 'display' : 'playerB';
      this.log('connect →', hostId, 'as', role, 'icePolicy=', this.icePolicy);

      const conn = this.peer.connect(hostId, {
        reliable: true,
        serialization: 'json',
        metadata: { role },
      });
      this.connToHost = conn;
      this.welcomed = false;
      this.attachIceWatch(conn, 'guest-out');

      let settled = false;
      let helloTimer = 0;
      const dialMs =
        this.role === 'host' || this.role === 'solo'
          ? HOST_DIAL_TIMEOUT_MS
          : GUEST_DIAL_TIMEOUT_MS;
      const t = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.dialAbort = null;
        window.clearInterval(helloTimer);
        try {
          conn.close();
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            'Host connect timeout — confirm code, keep host on lobby'
          )
        );
      }, dialMs);

      this.dialAbort = (err: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(t);
        window.clearInterval(helloTimer);
        this.dialAbort = null;
        try {
          conn.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };

      const sendHello = () => {
        try {
          conn.send({ type: 'hello', role } satisfies NetMessage);
          this.log('sent hello');
        } catch (e) {
          this.log('hello send err', e);
        }
      };
      const startHelloPulse = () => {
        sendHello();
        let n = 0;
        helloTimer = window.setInterval(() => {
          if (this.welcomed || settled || this.destroyed) {
            window.clearInterval(helloTimer);
            return;
          }
          n += 1;
          if (n > 10) {
            window.clearInterval(helloTimer);
            return;
          }
          sendHello();
        }, 500);
      };

      const doneOk = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(t);
        window.clearInterval(helloTimer);
        this.dialAbort = null;
        this.handlers.onStatus?.('Connected (direct)', 'ok');
        resolve();
      };

      const doneErr = (err: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(t);
        window.clearInterval(helloTimer);
        this.dialAbort = null;
        reject(err);
      };

      const onPeerErr = (err: unknown) => {
        const typ = errType(err);
        const msg = errMessage(err);
        this.log('peer err during dial', typ, msg);
        if (typ === 'peer-unavailable') {
          doneErr(
            new Error(
              `Room ${this.roomCode} not found — host must have lobby open with this code`
            )
          );
          return;
        }
        // PeerJS surfaces ICE failure as "Negotiation of connection to X failed."
        if (/negotiation of connection/i.test(msg) || isNegotiationError(err)) {
          doneErr(err);
        }
      };
      this.peer.on('error', onPeerErr);

      conn.on('open', () => {
        this.log('data channel open to host');
        startHelloPulse();
        window.setTimeout(() => {
          if (!settled) doneOk();
        }, 700);
      });

      conn.on('data', (raw) => {
        const msg = raw as NetMessage;
        if (msg?.type === 'welcome') {
          this.welcomed = true;
          this.log('got welcome');
          doneOk();
        }
        this.handlers.onMessage?.(msg, conn);
      });

      conn.on('close', () => {
        this.handlers.onStatus?.('Disconnected from host', 'err');
        this.handlers.onPeerLeft?.('host');
        if (!settled) doneErr(new Error('Connection closed before join completed'));
      });

      conn.on('error', (err) => {
        this.log('conn error', err);
        doneErr(err);
      });
    });
  }

  sendToHost(msg: NetMessage): void {
    if (this.connToHost?.open) this.connToHost.send(msg);
  }

  broadcastState(state: GameState): void {
    const msg: NetMessage = { type: 'state', state };
    if (this.playerB?.open) this.playerB.send(msg);
    if (this.display?.open) this.display.send(msg);
  }

  sendHit(side: 'A' | 'B', offset: number): void {
    const msg: NetMessage = { type: 'hit', side, offset, t: Date.now() };
    if (this.role === 'host' || this.role === 'solo') {
      this.handlers.onMessage?.(msg, null as unknown as DataConnection);
    } else {
      this.sendToHost(msg);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.announced.clear();
    const abort = this.dialAbort;
    this.dialAbort = null;
    try {
      abort?.(new Error('Cancelled'));
    } catch {
      /* ignore */
    }
    try {
      this.playerB?.close();
      this.display?.close();
      this.connToHost?.close();
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;
    this.playerB = null;
    this.display = null;
    this.connToHost = null;
  }
}
