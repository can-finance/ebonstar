# Gravity Grid Shooter

A 2D kinetic shooter built with React + Canvas. Players push enemies into a black hole using bullets that apply force rather than damage. Supports 1-4 players with local and LAN multiplayer.

## Tech Stack
- React 19 + TypeScript
- Vite dev server on port 3000
- Tailwind CSS v4 for UI overlays
- Web Audio API for procedural sound effects
- WebSocket relay server for LAN multiplayer
- No game engine — raw canvas rendering and custom physics

## Project Structure
```
src/
  App.tsx          — All game logic (~1450 lines): constants, state, game loop, rendering, UI
  net/
    protocol.ts    — Shared message types and player ID constants
    host.ts        — HostConnection: WebSocket host that relays state to clients
    client.ts      — ClientConnection: WebSocket client that sends input to host
server/
  relay.ts         — WebSocket relay server for multiplayer room management
```

## Dev Environment
- Node.js runs via WSL (Ubuntu), not native Windows
- Dev server: `cd <project-root> && npm run dev`
- Relay server: `node server/relay.js` (runs on port 3001, proxied through Vite at `/relay`)
- Vite config uses `watch: { usePolling: true }` for HMR over the `/mnt/c/` mount
- WSL uses mirrored networking (`~/.wslconfig`) so LAN devices can connect
- Windows Firewall rules added for ports 3000 and 3001 inbound
- Preview launch config in `.claude/launch.json` wraps through WSL

## Architecture

### Fixed World Size
- Game logic runs in a fixed 1920×1080 coordinate space (`WORLD_W`, `WORLD_H`)
- Canvas scales and letterboxes to fit any screen size
- All physics, spawns, and positions use world coordinates
- Touch input is translated from screen space to world space

### Game Loop
- Fixed 60fps tick rate decoupled from render via accumulator pattern
- Tick function: processes input → physics/gravity → bullet collisions → enemy AI → spawning
- Render function: scaling transform → grid distortion → black hole → ships → bullets → touch controls → HUD

### Networking (Host-Client Model)
- Host runs the full game loop and broadcasts state at 20Hz (`NET_SEND_INTERVAL = 3`)
- Clients send input only (left/right/thrust/fire) and render interpolated state
- Relay server (`server/relay.ts`) manages rooms — hosts create, clients browse and join
- Room codes are 4 random uppercase letters
- Player IDs: P1=0, P2=-1, P3=-2, P4=-3 (negative to avoid collision with enemy IDs starting at 1)
- Vite proxies `/relay` WebSocket to port 3001 so everything goes through one port

## Game Mechanics

### Core Loop
- A black hole drifts around the screen, pulling all entities via inverse-square gravity
- Players shoot bullets that **push** enemies and other players (no hitpoints/damage)
- Enemies sucked into the black hole = points scored
- Players touching the black hole = lose a life, 5-second respawn delay
- Max 10 enemies on screen at once

### Multiplayer (1-4 players)
- **1P / 2P local**: played on one device with two keyboard control sets
- **3P / 4P**: requires separate devices connected via LAN WebSocket
- **P1** (green, id=0): WASD + Space. Spawns top-left
- **P2** (blue, id=-1): IJKL + Enter. Spawns bottom-right
- **P3** (orange, id=-2): remote only
- **P4** (purple, id=-3): remote only
- **Competitive scoring**: `lastHitBy` on each enemy tracks which player last shot it. Points awarded to that player when enemy enters black hole
- Game over when all players have lost all lives. Winner announced on game over screen
- Touch controls (virtual joystick + fire button) available in 1-player local mode only
- Escape key pauses the game

### Enemy AI
- Enemies spawn from the black hole with a shield that grants gravity/bullet immunity until far enough away
- **Targeting**: each enemy targets the nearest alive player
- **Movement priorities**: 1) Flee black hole if too close, 2) Steer away in danger zone, 3) Strategically position on opposite side of target from black hole to push them toward it
- **Turning**: enemies rotate gradually (0.05 rad/frame) and only boost when facing within ~45° of target direction
- **Fuel system**: 150 fuel, recharges at 0.2/frame. Fleeing costs 3/frame, so sustained pressure near the black hole depletes their fuel and they can be pushed in
- **Smart shooting**: enemies fire more eagerly when their shot would push the target toward the black hole

### Physics
- Gravity: inverse-square law with smoothing (`GRAVITY_STRENGTH / (distSq + 1000)`)
- Friction: 0.96 velocity multiplier per tick
- Explicit max speed cap (`PLAYER_MAX_SPEED = 2.2`) — top speed is independent of acceleration
- Bullets affected by gravity at 50% strength
- All entities bounce off world edges
- Bullet hits push entities proportional to bullet velocity
- Player spawn positions are adjusted away from the black hole if too close

## Key Constants for Tuning
| Constant | Value | Purpose |
|---|---|---|
| WORLD_W / WORLD_H | 1920 / 1080 | Fixed game world dimensions |
| GRAVITY_STRENGTH | 800 | Black hole pull force |
| PLAYER_ACCEL | 0.07 | Player thrust per tick |
| PLAYER_MAX_SPEED | 2.2 | Max velocity magnitude |
| PLAYER_ROT_SPEED | 0.05 | Player rotation rad/tick |
| BULLET_SPEED | 5 | Player bullet velocity |
| FRICTION | 0.96 | Velocity decay per tick |
| ENEMY_FIRE_RATE | 280 | Ticks between enemy shots |
| ENEMY_SPAWN_RATE | 180 | Ticks between enemy spawns |
| FUEL_MAX | 150 | Enemy boost fuel capacity |
| FUEL_RECHARGE | 0.2 | Enemy fuel recovery per tick |
| RESPAWN_DELAY | 300 | Ticks before respawn (5 seconds) |
| NET_SEND_INTERVAL | 3 | Ticks between network state broadcasts |

## Deployment
- **Static game client**: GitHub Pages (built with `npm run build`)
- **Relay server**: Can be deployed to Render (free tier) or any Node.js host
- **Local dev**: Vite proxies `/relay` to the local relay server on port 3001
- **Production**: `getRelayUrl()` detects localhost vs production and routes accordingly
