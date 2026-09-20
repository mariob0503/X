# Plate Race — BFit24

A real-time multiplayer plate-throwing duel PWA for mobile browsers.

## Gameplay

- Drag your avatar to aim, tap FIRE to launch plates
- Only outer plates chip off; strip opponent to center to win
- Dark gym UI with procedural SFX

## Networking

**P2P-primary architecture:**
- Direct PeerJS/WebRTC connection attempted first (STUN + TURN)
- Automatic fallback to WebSocket relay (`/pr-net`) if P2P fails within ~8s
- Host keeps both paths open; guest auto-switches seamlessly
- VS AI mode works fully offline

Status progression: `Trying direct…` → `TURN…` → `Connected (direct)` or `Connected (backup)`

## Quick Start

```bash
# Install dependencies
npm install

# Development server (hot reload)
npm run dev

# Production build
npm run build

# Preview production build (serves dist + /pr-net WebSocket relay)
npm run preview
```

The `preview` script runs `pr-server.mjs` which serves the built static files and provides the `/pr-net` WebSocket relay endpoint for backup connectivity.

## Deployment

Firebase Hosting deployment is a future step. For now, the app can be served via `npm run preview` or any static host with WebSocket support.

## Tech Stack

- Vite + TypeScript
- PeerJS for WebRTC
- PWA with service worker
- Procedural audio (no external sound files)

## License

Private project.
