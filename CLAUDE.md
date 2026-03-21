# Gravity Grid Shooter

A 2D kinetic shooter built with React + Canvas. Players push enemies into a black hole using bullets that apply force rather than damage.

## Tech Stack
- React 19 + TypeScript, single-component game in `src/App.tsx`
- Vite dev server on port 3000
- Tailwind CSS v4 for UI overlays
- Web Audio API for procedural sound effects
- No game engine — raw canvas rendering and custom physics

## Dev Environment
- Node.js runs via WSL (Ubuntu), not native Windows
- Dev server runs via WSL: `source ~/.nvm/nvm.sh && npm run dev`
- Vite config uses `watch: { usePolling: true }` for HMR over the `/mnt/c/` mount
- Preview launch config in `.claude/launch.json` wraps through WSL

## Architecture
All game logic lives in `src/App.tsx` (~600 lines). Key sections:
- **Constants** (top): tuning values for physics, fire rates, speeds
- **Sound system**: `playSound()` generates tones via Web Audio oscillators
- **Game state**: React refs for real-time data (players, enemies, bullets, black hole), useState for UI-driving state (scores, lives, gameOver, isPaused, playerCount)
- **Game loop**: Fixed 60fps tick rate decoupled from render via accumulator pattern
- **Tick function**: processes input → physics/gravity → bullet collisions → enemy AI → frame counter
- **Render function**: grid distortion → black hole → ships → bullets → touch controls

## Game Mechanics

### Core Loop
- A black hole drifts around the screen, pulling all entities via inverse-square gravity
- Players shoot bullets that **push** enemies (no hitpoints/damage)
- Enemies sucked into the black hole = points scored
- Players touching the black hole = lose a life and respawn

### Multiplayer (1-2 players, local)
- **P1** (green, id=0): WASD/Arrows + Space. Spawns top-left
- **P2** (blue, id=-1): IJKL + Enter. Spawns bottom-right
- Enemy IDs start at 1 via `nextIdRef` — player IDs are 0 and -1 to avoid collision
- **Competitive scoring**: `lastHitBy` on each enemy tracks which player last shot it. Points awarded to that player when enemy enters black hole
- Game over when all players have lost all lives. Winner announced on game over screen
- Touch controls (virtual joystick) only available in 1-player mode

### Enemy AI
- Enemies spawn from the black hole with a shield that grants gravity/bullet immunity until they're far enough away
- **Targeting**: each enemy targets the nearest alive player
- **Movement priorities**: 1) Flee black hole if too close, 2) Steer away in danger zone, 3) Strategically position on opposite side of target from black hole
- **Turning**: enemies rotate gradually (0.05 rad/frame) and only boost when facing within ~45 degrees of target direction
- **Fuel system**: enemies have 150 fuel, recharges at 0.2/frame. Fleeing costs 3/frame, so sustained pressure near the black hole depletes their fuel and they can be pushed in
- **Smart shooting**: enemies fire more eagerly when their shot would push the target toward the black hole

### Physics
- Gravity: inverse-square law with smoothing constant (`GRAVITY_STRENGTH / (distSq + 1000)`)
- Friction: 0.98 velocity multiplier per tick
- Bullets affected by gravity at 50% strength
- All entities bounce off screen edges
- Bullet hits push entities (0.8x bullet velocity transferred)

## Key Constants for Tuning
| Constant | Value | Purpose |
|---|---|---|
| GRAVITY_STRENGTH | 1000 | Black hole pull force |
| PLAYER_ACCEL | 0.08 | Player thrust per tick |
| PLAYER_ROT_SPEED | 0.06 | Player rotation rad/tick |
| BULLET_SPEED | 6 | Player bullet velocity |
| ENEMY_FIRE_RATE | 280 | Ticks between enemy shots |
| ENEMY_SPAWN_RATE | 180 | Ticks between enemy spawns |
| FUEL_MAX | 150 | Enemy boost fuel capacity |
| FUEL_RECHARGE | 0.2 | Enemy fuel recovery per tick |
