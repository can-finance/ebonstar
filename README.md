# Gravity Grid Shooter

A retro 8-bit kinetic shooter built with React + Canvas. Bullets don't kill — they **push**. Shove enemies into the black hole to score, and don't get pulled in yourself. Supports 1–4 players with local and LAN multiplayer.

## Run locally

**Prerequisites:** Docker Desktop

```sh
docker compose up
```

Then open http://localhost:3000. This starts two containers:

- `web` — Vite dev server on port 3000
- `relay` — WebSocket relay for multiplayer on port 3001 (proxied through Vite at `/relay`)

`node_modules` lives inside Docker volumes, so nothing is installed on the host. After changing `package.json`, just restart the containers — each one runs `npm install` on start.

## Controls

| Player | Move | Shoot |
|---|---|---|
| P1 | WASD or arrows | Space |
| P2 (local) | IJKL | Enter |

Touch controls (virtual joystick + fire) are available in 1-player mode. Escape pauses.

## Multiplayer

- **1P / 2P local** — one device, shared keyboard
- **3P / 4P LAN** — host a game, other devices on the same network open `http://<host-ip>:3000` and join with the 4-letter room code

## Deployment

- **Game client** — static build (`npm run build`) deployed to GitHub Pages via `.github/workflows/static.yml`
- **Relay server** — `server/` is self-contained (own `package.json`, just `ws`) and runs on Render; the production client connects to it via `VITE_RELAY_URL` (see `.env.example`)
