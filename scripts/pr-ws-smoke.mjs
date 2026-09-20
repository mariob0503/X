#!/usr/bin/env node
/**
 * Smoke: host + guest join room TEST01 on local /pr-net within a few seconds.
 */
import WebSocket from 'ws';

const PORT = process.env.PORT || 4173;
const URL = `ws://127.0.0.1:${PORT}/pr-net`;
const ROOM = 'TEST01';
const BUDGET_MS = 8000;

function onceMessage(ws, pred, ms = BUDGET_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${pred.name || 'message'}`)), ms);
    const onMsg = (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (pred(msg)) {
        clearTimeout(t);
        ws.off('message', onMsg);
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
  });
}

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const t = setTimeout(() => reject(new Error('WS open timeout')), 5000);
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

const t0 = Date.now();
console.log('[smoke] connecting host…', URL);
const host = await openWs();
host.send(JSON.stringify({ type: 'host', room: ROOM }));
const hosted = await onceMessage(host, (m) => m.type === 'hosted');
console.log('[smoke] hosted', hosted.room, `+${Date.now() - t0}ms`);

console.log('[smoke] connecting guest…');
const guest = await openWs();
guest.send(JSON.stringify({ type: 'join', room: ROOM, role: 'playerB' }));

const [joined, peerJoined] = await Promise.all([
  onceMessage(guest, (m) => m.type === 'joined'),
  onceMessage(host, (m) => m.type === 'peer-joined' && m.role === 'playerB'),
]);
console.log('[smoke] guest joined', joined, `+${Date.now() - t0}ms`);
console.log('[smoke] host saw peer-joined', peerJoined, `+${Date.now() - t0}ms`);

// Guest hello → host should receive msg
guest.send(JSON.stringify({ type: 'msg', payload: { type: 'hello', role: 'playerB' } }));
const hello = await onceMessage(host, (m) => m.type === 'msg' && m.payload?.type === 'hello');
console.log('[smoke] host got hello', hello.payload, `+${Date.now() - t0}ms`);

// Host start → guest
host.send(JSON.stringify({ type: 'start', room: ROOM }));
const start = await onceMessage(guest, (m) => m.type === 'start');
console.log('[smoke] guest got start', start, `+${Date.now() - t0}ms`);

host.close();
guest.close();
const elapsed = Date.now() - t0;
console.log(`[smoke] PASS room=${ROOM} elapsed=${elapsed}ms`);
if (elapsed > BUDGET_MS) {
  console.warn('[smoke] WARN: slower than 8s budget (WS itself should be fast)');
}
process.exit(0);
