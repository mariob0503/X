#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build

# Kill anything already on 4173
if command -v fuser >/dev/null 2>&1; then
  fuser -k 4173/tcp 2>/dev/null || true
fi
pkill -f 'pr-server.mjs' 2>/dev/null || true
pkill -f 'vite preview' 2>/dev/null || true
sleep 0.5

PORT=4173 node scripts/pr-server.mjs &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
sleep 0.8

# Health check
curl -sf "http://127.0.0.1:4173/health" >/dev/null || {
  echo "pr-server failed to start" >&2
  exit 1
}
echo "pr-server healthy on :4173"

CF=$(command -v cloudflared || echo /tmp/cloudflared)
exec "$CF" tunnel --url "http://127.0.0.1:4173" --no-autoupdate
