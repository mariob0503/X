#!/usr/bin/env node
/**
 * Plate Race public server: serves dist/ over HTTP and /pr-net WebSocket rooms.
 * One port → one Cloudflare tunnel. Phones never need peer-to-peer ICE.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': status === 200 && type.includes('html') ? 'no-cache' : 'public, max-age=60',
  });
  res.end(body);
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent((reqPath || '/').split('?')[0]);
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(root, cleaned);
  if (!full.startsWith(root)) return null;
  return full;
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed');
    return;
  }
  let filePath = safeJoin(DIST, req.url === '/' ? '/index.html' : req.url);
  if (!filePath) {
    send(res, 403, 'Forbidden');
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA fallback
    const index = path.join(DIST, 'index.html');
    if (fs.existsSync(index)) {
      send(res, 200, fs.readFileSync(index), MIME['.html']);
      return;
    }
    send(res, 404, 'Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': type });
    res.end();
    return;
  }
  send(res, 200, fs.readFileSync(filePath), type);
}

/** @typedef {{ host: import('ws').WebSocket | null, playerB: import('ws').WebSocket | null, display: import('ws').WebSocket | null }} Room */

/** @type {Map<string, Room>} */
const rooms = new Map();

function normRoom(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function getRoom(code) {
  const r = normRoom(code);
  if (!r || r.length !== 6) return null;
  let room = rooms.get(r);
  if (!room) {
    room = { host: null, playerB: null, display: null };
    rooms.set(r, room);
  }
  return { code: r, room };
}

function sendJson(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function roleOf(room, ws) {
  if (room.host === ws) return 'host';
  if (room.playerB === ws) return 'playerB';
  if (room.display === ws) return 'display';
  return null;
}

function clearSlot(room, ws) {
  if (room.host === ws) room.host = null;
  if (room.playerB === ws) room.playerB = null;
  if (room.display === ws) room.display = null;
}

function roomEmpty(room) {
  return !room.host && !room.playerB && !room.display;
}

function broadcastRoom(room, except, obj) {
  for (const ws of [room.host, room.playerB, room.display]) {
    if (ws && ws !== except) sendJson(ws, obj);
  }
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/pr-net')) {
    send(res, 426, 'WebSocket endpoint — use WS upgrade');
    return;
  }
  if (req.url === '/health') {
    send(res, 200, JSON.stringify({ ok: true, rooms: rooms.size }), 'application/json');
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: '/pr-net' });

wss.on('connection', (ws) => {
  /** @type {{ code: string, role: string } | null} */
  let seat = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      sendJson(ws, { type: 'error', message: 'Bad JSON' });
      return;
    }
    const type = msg?.type;

    if (type === 'host') {
      const got = getRoom(msg.room);
      if (!got) {
        sendJson(ws, { type: 'error', message: 'Invalid room code' });
        return;
      }
      const { code, room } = got;
      if (room.host && room.host !== ws && room.host.readyState === 1) {
        // Replace stale host (refresh)
        try {
          room.host.close();
        } catch {
          /* ignore */
        }
      }
      room.host = ws;
      seat = { code, role: 'host' };
      sendJson(ws, { type: 'hosted', room: code });
      if (room.playerB) sendJson(ws, { type: 'peer-joined', role: 'playerB' });
      if (room.display) sendJson(ws, { type: 'peer-joined', role: 'display' });
      console.log(`[pr-net] host room ${code}`);
      return;
    }

    if (type === 'join') {
      const got = getRoom(msg.room);
      if (!got) {
        sendJson(ws, { type: 'error', message: 'Invalid room code' });
        return;
      }
      const { code, room } = got;
      const role = msg.role === 'display' ? 'display' : 'playerB';
      if (!room.host || room.host.readyState !== 1) {
        sendJson(ws, {
          type: 'error',
          message: 'Room not found — host must keep the lobby open',
        });
        return;
      }
      if (role === 'playerB') {
        if (room.playerB && room.playerB !== ws && room.playerB.readyState === 1) {
          try {
            room.playerB.close();
          } catch {
            /* ignore */
          }
        }
        room.playerB = ws;
      } else {
        if (room.display && room.display !== ws && room.display.readyState === 1) {
          try {
            room.display.close();
          } catch {
            /* ignore */
          }
        }
        room.display = ws;
      }
      seat = { code, role };
      sendJson(ws, { type: 'joined', room: code, role });
      sendJson(room.host, { type: 'peer-joined', role });
      // Notify the other spectator/player if present
      const other = role === 'playerB' ? room.display : room.playerB;
      if (other) sendJson(other, { type: 'peer-joined', role });
      console.log(`[pr-net] ${role} joined ${code}`);
      return;
    }

    if (type === 'start') {
      if (!seat || seat.role !== 'host') {
        sendJson(ws, { type: 'error', message: 'Only host can start' });
        return;
      }
      const room = rooms.get(seat.code);
      if (!room) return;
      broadcastRoom(room, ws, { type: 'start' });
      console.log(`[pr-net] start ${seat.code}`);
      return;
    }

    if (type === 'msg' || type === 'relay') {
      if (!seat) {
        sendJson(ws, { type: 'error', message: 'Not in a room' });
        return;
      }
      const room = rooms.get(seat.code);
      if (!room) return;
      const payload = msg.payload ?? msg.msg;
      if (!payload || typeof payload !== 'object') return;

      // Host broadcasts to everyone else; guests/display only to host
      if (seat.role === 'host') {
        broadcastRoom(room, ws, { type: 'msg', payload });
      } else if (room.host) {
        sendJson(room.host, { type: 'msg', payload, from: seat.role });
        // Also mirror state/start to display if guest somehow… no, only host broadcasts state
      }
      return;
    }

    if (type === 'ping') {
      sendJson(ws, { type: 'pong', t: msg.t ?? Date.now() });
      return;
    }
  });

  ws.on('close', () => {
    if (!seat) return;
    const room = rooms.get(seat.code);
    if (!room) return;
    const leftRole = seat.role;
    clearSlot(room, ws);
    if (leftRole === 'host') {
      broadcastRoom(room, null, {
        type: 'error',
        message: 'Host left the room',
      });
      for (const peer of [room.playerB, room.display]) {
        try {
          peer?.close();
        } catch {
          /* ignore */
        }
      }
      rooms.delete(seat.code);
      console.log(`[pr-net] host left, room ${seat.code} closed`);
    } else {
      if (room.host) sendJson(room.host, { type: 'peer-left', role: leftRole });
      console.log(`[pr-net] ${leftRole} left ${seat.code}`);
      if (roomEmpty(room)) rooms.delete(seat.code);
    }
    seat = null;
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[pr-server] http://0.0.0.0:${PORT}  ws://0.0.0.0:${PORT}/pr-net  dist=${DIST}`);
});
