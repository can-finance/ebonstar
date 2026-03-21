/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

// --- Constants ---
const GRID_SIZE = 40;
const GRAVITY_STRENGTH = 800;
const BLACK_HOLE_RADIUS = 30;
const SHIP_SIZE = 20;
const BULLET_SPEED = 5;
const BULLET_LIFETIME = 55;
const PLAYER_ACCEL = 0.07;
const PLAYER_MAX_SPEED = 2.2; // Explicit speed cap (current equilibrium ~1.75)
const PLAYER_ROT_SPEED = 0.05;
const PLAYER_FIRE_RATE = 9;
const FRICTION = 0.96; // More drag = less momentum / sliding
const ENEMY_SPAWN_RATE = 180; // Slowed down
const ENEMY_FIRE_RATE = 280; // Slowed down, compensates for smarter AI
const BLACK_HOLE_SPEED = 0.5; // Slowed down
const MAX_LIVES = 3;

// Player IDs: P1 = 0, P2 = -1 (negative to avoid collision with enemy IDs which start at 1)
const P1_ID = 0;
const P2_ID = -1;
const PLAYER_IDS = new Set([P1_ID, P2_ID]);

// Control schemes
const CONTROLS = [
  { left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], thrust: ['ArrowUp', 'KeyW'], fire: ['Space'] },
  { left: ['KeyJ'], right: ['KeyL'], thrust: ['KeyI'], fire: ['Enter'] },
];

type Point = { x: number; y: number; vx?: number; vy?: number };

interface Entity {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  color: string;
  isMoving?: boolean;
  lastShot?: number;
  isShielded?: boolean;
  fuel?: number;
  lastHitBy?: number; // tracks which player last hit this enemy
}

interface Bullet extends Entity {
  life: number;
  ownerId: number;
}

function makePlayer(id: number, x: number, y: number): Entity {
  return {
    id,
    x, y,
    vx: 0, vy: 0,
    angle: -Math.PI / 2,
    color: id === P1_ID ? '#00ff00' : '#00aaff',
    isMoving: false,
    lastShot: 0,
  };
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [scores, setScores] = useState<number[]>([0]);
  const [livesArray, setLivesArray] = useState<number[]>([MAX_LIVES]);
  const [gameOver, setGameOver] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [playerCount, setPlayerCount] = useState<1 | 2>(1);

  // Sound System
  const initAudio = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
  };

  const playSound = (type: 'shoot' | 'hit' | 'death' | 'spawn' | 'score') => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;

    if (type === 'shoot') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.1);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.1);
    } else if (type === 'hit') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.linearRampToValueAtTime(55, now + 0.2);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.2);
      osc.start(now);
      osc.stop(now + 0.2);
    } else if (type === 'death') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(110, now);
      osc.frequency.linearRampToValueAtTime(20, now + 0.6);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.6);
      osc.start(now);
      osc.stop(now + 0.6);
    } else if (type === 'spawn') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(110, now);
      osc.frequency.exponentialRampToValueAtTime(660, now + 0.4);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.4);
    } else if (type === 'score') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.1);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.1);
    }
  };

  // Game state refs (to avoid re-renders)
  const playersRef = useRef<Entity[]>([makePlayer(P1_ID, 100, 100)]);
  const deadPlayersRef = useRef<Set<number>>(new Set());
  const playerCountRef = useRef(1);
  const enemiesRef = useRef<Entity[]>([]);
  const bulletsRef = useRef<Bullet[]>([]);
  const keysRef = useRef<Record<string, boolean>>({});
  const blackHoleRef = useRef<Point & { vx: number; vy: number }>({
    x: 0, y: 0, vx: BLACK_HOLE_SPEED, vy: BLACK_HOLE_SPEED
  });
  const frameCountRef = useRef(0);
  const nextIdRef = useRef(1);

  // Mobile touch controls
  const isMobile = useRef(false);
  const joystickRef = useRef<{ active: boolean; startX: number; startY: number; dx: number; dy: number; touchId: number | null }>({
    active: false, startX: 0, startY: 0, dx: 0, dy: 0, touchId: null,
  });
  const fireRef = useRef<{ active: boolean; touchId: number | null }>({ active: false, touchId: null });

  const resetGame = (numPlayers: 1 | 2 = 1) => {
    const initScores = numPlayers === 2 ? [0, 0] : [0];
    const initLives = numPlayers === 2 ? [MAX_LIVES, MAX_LIVES] : [MAX_LIVES];
    setScores(initScores);
    setLivesArray(initLives);
    setGameOver(false);
    setIsPaused(false);
    enemiesRef.current = [];
    bulletsRef.current = [];
    deadPlayersRef.current = new Set();
    playerCountRef.current = numPlayers;

    const canvas = canvasRef.current;
    const w = canvas?.width ?? window.innerWidth;
    const h = canvas?.height ?? window.innerHeight;

    if (numPlayers === 2) {
      playersRef.current = [
        makePlayer(P1_ID, 100, 100),
        makePlayer(P2_ID, w - 100, h - 100),
      ];
    } else {
      playersRef.current = [makePlayer(P1_ID, 100, 100)];
    }
    frameCountRef.current = 0;
  };

  const respawnPlayer = (playerIndex: number) => {
    playSound('death');
    const p = playersRef.current[playerIndex];
    if (!p) return;

    const canvas = canvasRef.current;
    const w = canvas?.width ?? window.innerWidth;
    const h = canvas?.height ?? window.innerHeight;

    // Respawn at starting position
    if (p.id === P1_ID) {
      p.x = 100; p.y = 100;
    } else {
      p.x = w - 100; p.y = h - 100;
    }
    p.vx = 0; p.vy = 0;
    p.angle = -Math.PI / 2;

    setLivesArray((prev) => {
      const next = [...prev];
      next[playerIndex] = Math.max(0, next[playerIndex] - 1);
      if (next[playerIndex] <= 0) {
        deadPlayersRef.current.add(p.id);
        // Check if ALL players are dead
        if (deadPlayersRef.current.size >= playerCountRef.current) {
          setGameOver(true);
        }
      }
      return next;
    });
  };

  // Initialize game
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = window.innerWidth;
        canvasRef.current.height = window.innerHeight;
        if (!gameStarted) {
          blackHoleRef.current.x = window.innerWidth * 0.75;
          blackHoleRef.current.y = window.innerHeight * 0.4;
        }
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    // Detect mobile — only activate on first touch, not on touch-capable desktops
    const activateMobile = () => {
      isMobile.current = true;
      window.removeEventListener('touchstart', activateMobile);
    };
    // Only treat as mobile if screen is narrow (rules out touch laptops)
    if (window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 1024) {
      isMobile.current = true;
    } else {
      window.addEventListener('touchstart', activateMobile, { once: true });
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      keysRef.current[e.code] = true;
      if (e.code === 'Escape' && gameStarted && !gameOver) {
        setIsPaused((p) => !p);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => (keysRef.current[e.code] = false);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // Touch handlers (1-player only)
    const JOYSTICK_ZONE_WIDTH = 0.5; // left half of screen

    const handleTouchStart = (e: TouchEvent) => {
      if (!gameStarted || gameOver || isPaused) return;
      if (playerCountRef.current > 1) return; // no touch in 2P mode
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        const isLeftSide = t.clientX < window.innerWidth * JOYSTICK_ZONE_WIDTH;
        if (isLeftSide && joystickRef.current.touchId === null) {
          joystickRef.current = { active: true, startX: t.clientX, startY: t.clientY, dx: 0, dy: 0, touchId: t.identifier };
        } else if (!isLeftSide && fireRef.current.touchId === null) {
          fireRef.current = { active: true, touchId: t.identifier };
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!joystickRef.current.active) return;
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === joystickRef.current.touchId) {
          joystickRef.current.dx = t.clientX - joystickRef.current.startX;
          joystickRef.current.dy = t.clientY - joystickRef.current.startY;
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === joystickRef.current.touchId) {
          joystickRef.current = { active: false, startX: 0, startY: 0, dx: 0, dy: 0, touchId: null };
        }
        if (t.identifier === fireRef.current.touchId) {
          fireRef.current = { active: false, touchId: null };
        }
      }
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: false });
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd);
    window.addEventListener('touchcancel', handleTouchEnd);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('touchstart', activateMobile);
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [gameStarted, gameOver, isPaused]);

  // Game Loop
  useEffect(() => {
    if (!gameStarted || gameOver || isPaused) return;

    let animationFrameId: number;
    let lastTime = performance.now();
    let accumulator = 0;
    const TICK_RATE = 1000 / 60; // Fixed 60 ticks per second

    const update = (now: number = performance.now()) => {
      const canvas = canvasRef.current;
      if (!canvas || isPaused) return;

      const elapsed = Math.min(now - lastTime, 100); // Cap to avoid spiral of death
      lastTime = now;
      accumulator += elapsed;

      // Run physics at fixed tick rate, render once per frame
      while (accumulator >= TICK_RATE) {
        accumulator -= TICK_RATE;
        tick(canvas);
      }

      render();
      animationFrameId = requestAnimationFrame(update);
    };

    const tick = (canvas: HTMLCanvasElement) => {

      const players = playersRef.current;
      const keys = keysRef.current;
      const bh = blackHoleRef.current;
      const dead = deadPlayersRef.current;

      // 0. Update Black Hole
      bh.x += bh.vx;
      bh.y += bh.vy;
      if (bh.x < BLACK_HOLE_RADIUS || bh.x > canvas.width - BLACK_HOLE_RADIUS) bh.vx *= -1;
      if (bh.y < BLACK_HOLE_RADIUS || bh.y > canvas.height - BLACK_HOLE_RADIUS) bh.vy *= -1;

      // 1. Player Input — process each alive player with their control scheme
      players.forEach((player, idx) => {
        if (dead.has(player.id)) return;

        const ctrl = CONTROLS[idx];
        if (!ctrl) return;

        // Keyboard rotation
        if (ctrl.left.some(k => keys[k])) player.angle -= PLAYER_ROT_SPEED;
        if (ctrl.right.some(k => keys[k])) player.angle += PLAYER_ROT_SPEED;

        // Keyboard thrust
        player.isMoving = ctrl.thrust.some(k => keys[k]);
        if (player.isMoving) {
          player.vx += Math.cos(player.angle) * PLAYER_ACCEL;
          player.vy += Math.sin(player.angle) * PLAYER_ACCEL;
        }

        // Touch joystick (P1 only, 1-player mode only)
        if (idx === 0 && playerCountRef.current === 1) {
          const js = joystickRef.current;
          if (js.active) {
            const mag = Math.sqrt(js.dx * js.dx + js.dy * js.dy);
            const DEAD_ZONE = 15;
            if (mag > DEAD_ZONE) {
              const targetAngle = Math.atan2(js.dy, js.dx);
              let angleDiff = targetAngle - player.angle;
              while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
              while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
              player.angle += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), PLAYER_ROT_SPEED * 2);

              const thrust = Math.min(mag / 80, 1) * PLAYER_ACCEL;
              player.vx += Math.cos(player.angle) * thrust;
              player.vy += Math.sin(player.angle) * thrust;
              player.isMoving = true;
            }
          }
        }

        // Fire (keyboard or touch for P1)
        const touchFire = idx === 0 && playerCountRef.current === 1 && fireRef.current.active;
        const wantsFire = ctrl.fire.some(k => keys[k]) || touchFire;
        if (wantsFire && frameCountRef.current - (player.lastShot || 0) >= PLAYER_FIRE_RATE) {
          player.lastShot = frameCountRef.current;
          playSound('shoot');
          bulletsRef.current.push({
            id: nextIdRef.current++,
            x: player.x + Math.cos(player.angle) * SHIP_SIZE,
            y: player.y + Math.sin(player.angle) * SHIP_SIZE,
            vx: Math.cos(player.angle) * BULLET_SPEED + player.vx,
            vy: Math.sin(player.angle) * BULLET_SPEED + player.vy,
            angle: player.angle,
            color: player.color,
            life: BULLET_LIFETIME,
            ownerId: player.id,
          });
        }
      });

      // 2. Physics & Gravity
      const alivePlayers = players.filter(p => !dead.has(p.id));
      const entities = [...alivePlayers, ...enemiesRef.current];

      entities.forEach((e) => {
        const dx = bh.x - e.x;
        const dy = bh.y - e.y;
        const distSq = dx * dx + dy * dy;
        const dist = Math.sqrt(distSq);

        // Shielded enemies are immune to gravity pull to allow escape from spawn
        if (dist > 5 && !e.isShielded) {
          const force = GRAVITY_STRENGTH / (distSq + 1000);
          e.vx += (dx / dist) * force;
          e.vy += (dy / dist) * force;
        }

        e.x += e.vx;
        e.y += e.vy;
        e.vx *= FRICTION;
        e.vy *= FRICTION;

        // Clamp player speed
        if (PLAYER_IDS.has(e.id)) {
          const speed = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
          if (speed > PLAYER_MAX_SPEED) {
            e.vx = (e.vx / speed) * PLAYER_MAX_SPEED;
            e.vy = (e.vy / speed) * PLAYER_MAX_SPEED;
          }
        }

        // Bounce off edges (instead of screen wrap)
        if (e.x < SHIP_SIZE / 2) {
          e.x = SHIP_SIZE / 2;
          e.vx *= -1;
        }
        if (e.x > canvas.width - SHIP_SIZE / 2) {
          e.x = canvas.width - SHIP_SIZE / 2;
          e.vx *= -1;
        }
        if (e.y < SHIP_SIZE / 2) {
          e.y = SHIP_SIZE / 2;
          e.vy *= -1;
        }
        if (e.y > canvas.height - SHIP_SIZE / 2) {
          e.y = canvas.height - SHIP_SIZE / 2;
          e.vy *= -1;
        }

        // Black hole collision
        if (dist < BLACK_HOLE_RADIUS) {
          // Check if this entity is a player
          const playerIdx = players.findIndex(p => p.id === e.id);
          if (playerIdx >= 0) {
            respawnPlayer(playerIdx);
          } else if (!e.isShielded) {
            // Enemy sucked in — award points to last player who hit it
            const lastHitter = (e as Entity).lastHitBy;
            if (lastHitter !== undefined) {
              const hitterIdx = players.findIndex(p => p.id === lastHitter);
              if (hitterIdx >= 0) {
                setScores((prev) => {
                  const next = [...prev];
                  next[hitterIdx] = (next[hitterIdx] || 0) + 100;
                  return next;
                });
              }
            }
            enemiesRef.current = enemiesRef.current.filter((en) => en.id !== e.id);
            playSound('score');
          }
        }

        // Shield logic: remove shield once away from black hole
        if (e.isShielded && dist > BLACK_HOLE_RADIUS * 4.5) {
          e.isShielded = false;
        }
      });

      // 3. Bullets
      bulletsRef.current.forEach((b) => {
        b.x += b.vx;
        b.y += b.vy;
        b.life--;

        // Bounce off edges
        if (b.x < 0 || b.x > canvas.width) {
          b.vx *= -1;
          b.angle = Math.atan2(b.vy, b.vx);
        }
        if (b.y < 0 || b.y > canvas.height) {
          b.vy *= -1;
          b.angle = Math.atan2(b.vy, b.vx);
        }

        // Gravity on bullets
        const dx = bh.x - b.x;
        const dy = bh.y - b.y;
        const distSq = dx * dx + dy * dy;
        const dist = Math.sqrt(distSq);
        const force = (GRAVITY_STRENGTH * 0.5) / (distSq + 1000);
        b.vx += (dx / dist) * force;
        b.vy += (dy / dist) * force;

        // Bullet-Entity collision (Push)
        const isPlayerBullet = PLAYER_IDS.has(b.ownerId);

        if (isPlayerBullet) {
          // Player bullet hitting enemy — track lastHitBy for scoring
          enemiesRef.current.forEach((en) => {
            if (en.isShielded) return;
            const edx = en.x - b.x;
            const edy = en.y - b.y;
            const edist = Math.sqrt(edx * edx + edy * edy);
            if (edist < SHIP_SIZE) {
              en.vx += b.vx * 0.8;
              en.vy += b.vy * 0.8;
              en.lastHitBy = b.ownerId; // track who last hit this enemy
              playSound('hit');
              b.life = 0;
            }
          });
        } else {
          // Enemy bullet hitting any alive player
          for (const player of alivePlayers) {
            const pdx = player.x - b.x;
            const pdy = player.y - b.y;
            const pdist = Math.sqrt(pdx * pdx + pdy * pdy);
            if (pdist < SHIP_SIZE) {
              player.vx += b.vx * 0.8;
              player.vy += b.vy * 0.8;
              playSound('hit');
              b.life = 0;
              break;
            }
          }
        }
      });
      bulletsRef.current = bulletsRef.current.filter((b) => b.life > 0);

      // 4. Enemy Spawning & AI
      if (frameCountRef.current % ENEMY_SPAWN_RATE === 0 && enemiesRef.current.length < 10) {
        const colors = ['#ff00ff', '#ffff00', '#ff4400'];
        const spawnAngle = Math.random() * Math.PI * 2;
        playSound('spawn');
        enemiesRef.current.push({
          id: nextIdRef.current++,
          x: bh.x,
          y: bh.y,
          vx: Math.cos(spawnAngle) * 4.5,
          vy: Math.sin(spawnAngle) * 4.5,
          angle: spawnAngle,
          color: colors[Math.floor(Math.random() * colors.length)],
          lastShot: frameCountRef.current,
          isShielded: true,
          fuel: 150,
        });
      }

      enemiesRef.current.forEach((en) => {
        if (en.isShielded) {
          // While shielded, boost away from the black hole with extra power
          en.isMoving = true;
          en.vx += Math.cos(en.angle) * 0.25;
          en.vy += Math.sin(en.angle) * 0.25;
          return;
        }

        // Find nearest alive player as target
        let target = alivePlayers[0];
        if (!target) return; // no alive players
        let minDist = Infinity;
        alivePlayers.forEach(p => {
          const d = Math.hypot(p.x - en.x, p.y - en.y);
          if (d < minDist) { minDist = d; target = p; }
        });

        // Vector from enemy to target player
        const pdx = target.x - en.x;
        const pdy = target.y - en.y;
        const pdist = Math.sqrt(pdx * pdx + pdy * pdy);

        // Vector from enemy to black hole
        const bhdx = bh.x - en.x;
        const bhdy = bh.y - en.y;
        const bhdist = Math.sqrt(bhdx * bhdx + bhdy * bhdy);

        // Vector from target player to black hole
        const pbhdx = bh.x - target.x;
        const pbhdy = bh.y - target.y;
        const pbhdist = Math.sqrt(pbhdx * pbhdx + pbhdy * pbhdy);

        // --- Smart AI: prioritize survival, then strategic positioning ---
        // Fuel system: enemies have limited boost, recharges slowly
        const fuel = en.fuel ?? 0;
        const FUEL_MAX = 150;
        const FUEL_RECHARGE = 0.2; // per frame
        const BH_DANGER_ZONE = BLACK_HOLE_RADIUS * 6; // ~180px
        const BH_FLEE_ZONE = BLACK_HOLE_RADIUS * 4;   // ~120px

        let fuelUsed = 0;
        let desiredAngle = en.angle;
        let wantsBoost = false;
        let boostStrength = 0;

        // Determine desired angle and boost intent
        if (bhdist < BH_FLEE_ZONE && fuel > 5) {
          desiredAngle = Math.atan2(-bhdy, -bhdx);
          wantsBoost = true;
          boostStrength = 0.2;
          fuelUsed = 3;
        } else if (bhdist < BH_DANGER_ZONE && fuel > 2) {
          desiredAngle = Math.atan2(-bhdy, -bhdx);
          wantsBoost = true;
          boostStrength = 0.08;
          fuelUsed = 1;
        } else if (bhdist < BH_FLEE_ZONE) {
          desiredAngle = Math.atan2(-bhdy, -bhdx);
        } else {
          const idealX = target.x - (pbhdx / (pbhdist || 1)) * 200;
          const idealY = target.y - (pbhdy / (pbhdist || 1)) * 200;
          const toIdealX = idealX - en.x;
          const toIdealY = idealY - en.y;
          const toIdealDist = Math.sqrt(toIdealX * toIdealX + toIdealY * toIdealY);

          if (toIdealDist > 60 && Math.random() < 0.03 && fuel > 2) {
            desiredAngle = Math.atan2(toIdealY, toIdealX);
            wantsBoost = true;
            boostStrength = 0.18;
            fuelUsed = 1.5;
          } else if (Math.random() < 0.01 && fuel > 1) {
            desiredAngle = Math.atan2(pdy, pdx);
            wantsBoost = true;
            boostStrength = 0.15;
            fuelUsed = 1;
          } else {
            desiredAngle = Math.atan2(pdy, pdx);
          }
        }

        // Gradually rotate toward desired angle (similar speed to player)
        const ENEMY_ROT_SPEED = 0.05;
        let angleDiff = desiredAngle - en.angle;
        // Normalize to [-PI, PI]
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
        en.angle += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), ENEMY_ROT_SPEED);

        // Only boost forward if facing roughly the right way (within ~45 degrees)
        if (wantsBoost && Math.abs(angleDiff) < Math.PI / 4) {
          en.vx += Math.cos(en.angle) * boostStrength;
          en.vy += Math.sin(en.angle) * boostStrength;
          en.isMoving = true;
        } else if (wantsBoost) {
          // Still turning, don't boost yet but don't spend fuel either
          fuelUsed = 0;
          en.isMoving = false;
        } else {
          en.isMoving = false;
        }

        // Update fuel: consume and recharge
        en.fuel = Math.min(FUEL_MAX, fuel - fuelUsed + FUEL_RECHARGE);

        // Enemy shooting - smarter: prefer shooting when target is roughly between enemy and black hole
        if (!en.isShielded && frameCountRef.current - (en.lastShot || 0) >= ENEMY_FIRE_RATE) {
          // Check if shooting would push target toward black hole
          const angleToPlayer = Math.atan2(pdy, pdx);
          const anglePlayerToBH = Math.atan2(pbhdy, pbhdx);
          let angleDiff = Math.abs(angleToPlayer - anglePlayerToBH);
          if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;

          const fireThreshold = angleDiff < Math.PI / 2 ? ENEMY_FIRE_RATE : ENEMY_FIRE_RATE * 1.5;

          if (frameCountRef.current - (en.lastShot || 0) >= fireThreshold) {
            en.lastShot = frameCountRef.current;
            playSound('shoot');
            bulletsRef.current.push({
              id: nextIdRef.current++,
              x: en.x + Math.cos(en.angle) * SHIP_SIZE,
              y: en.y + Math.sin(en.angle) * SHIP_SIZE,
              vx: Math.cos(en.angle) * (BULLET_SPEED * 0.7),
              vy: Math.sin(en.angle) * (BULLET_SPEED * 0.7),
              angle: en.angle,
              color: en.color,
              life: BULLET_LIFETIME * 1.5,
              ownerId: en.id,
            });
          }
        }
      });

      frameCountRef.current++;
    };

    const render = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;

      // Clear
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 1. Draw Grid with Distortion
      ctx.strokeStyle = '#0000aa';
      ctx.lineWidth = 1;
      const bh = blackHoleRef.current;

      const drawGridLine = (p1: Point, p2: Point) => {
        const distort = (p: Point) => {
          const dx = bh.x - p.x;
          const dy = bh.y - p.y;
          const distSq = dx * dx + dy * dy;
          const dist = Math.sqrt(distSq);
          const pull = 15000 / (dist + 100);
          return {
            x: p.x + (dx / (dist + 1)) * Math.min(pull, dist),
            y: p.y + (dy / (dist + 1)) * Math.min(pull, dist),
          };
        };

        const d1 = distort(p1);
        const d2 = distort(p2);
        ctx.beginPath();
        ctx.moveTo(d1.x, d1.y);
        ctx.lineTo(d2.x, d2.y);
        ctx.stroke();
      };

      // Horizontal lines
      for (let y = 0; y <= canvas.height; y += GRID_SIZE) {
        for (let x = 0; x < canvas.width; x += GRID_SIZE) {
          drawGridLine({ x, y }, { x: x + GRID_SIZE, y });
        }
      }
      // Vertical lines
      for (let x = 0; x <= canvas.width; x += GRID_SIZE) {
        for (let y = 0; y < canvas.height; y += GRID_SIZE) {
          drawGridLine({ x, y }, { x, y: y + GRID_SIZE });
        }
      }

      // 2. Draw Black Hole
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(bh.x, bh.y, BLACK_HOLE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ff00ff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 3. Draw Entities
      const drawShip = (e: Entity) => {
        ctx.save();
        ctx.translate(e.x, e.y);
        ctx.rotate(e.angle);

        // Engine flame
        if (e.isMoving) {
          ctx.fillStyle = '#ff8800';
          ctx.beginPath();
          ctx.moveTo(-SHIP_SIZE / 2, -SHIP_SIZE / 4);
          ctx.lineTo(-SHIP_SIZE - Math.random() * 10, 0);
          ctx.lineTo(-SHIP_SIZE / 2, SHIP_SIZE / 4);
          ctx.fill();
        }

        // Body (Triangle)
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.moveTo(SHIP_SIZE / 2, 0);
        ctx.lineTo(-SHIP_SIZE / 2, -SHIP_SIZE / 2);
        ctx.lineTo(-SHIP_SIZE / 2, SHIP_SIZE / 2);
        ctx.closePath();
        ctx.fill();

        // Shield (Visual)
        if (e.isShielded) {
          ctx.strokeStyle = '#00ffff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(0, 0, SHIP_SIZE * 0.8, 0, Math.PI * 2);
          ctx.stroke();
          // Shield glow
          ctx.fillStyle = 'rgba(0, 255, 255, 0.2)';
          ctx.fill();
        }

        // Nose (Grey)
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.moveTo(SHIP_SIZE / 2, 0);
        ctx.lineTo(0, -SHIP_SIZE / 4);
        ctx.lineTo(0, SHIP_SIZE / 4);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
      };

      // Draw alive players
      const dead = deadPlayersRef.current;
      playersRef.current.forEach(p => {
        if (!dead.has(p.id)) drawShip(p);
      });
      enemiesRef.current.forEach(drawShip);

      // 4. Draw Bullets
      bulletsRef.current.forEach((b) => {
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.angle);

        ctx.fillStyle = b.color;
        // Rectangular bar: 10px long, 3px wide
        ctx.fillRect(-5, -1.5, 10, 3);

        // Glow
        ctx.shadowBlur = 10;
        ctx.shadowColor = b.color;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(-5, -1.5, 10, 3);

        ctx.restore();
      });

      // 5. Draw Touch Controls (only on touch devices, 1-player only)
      if (isMobile.current && playerCountRef.current === 1) {
        ctx.save();
        ctx.globalAlpha = 0.25;

        // Joystick base
        const jsBaseX = 120;
        const jsBaseY = canvas.height - 140;
        const jsRadius = 60;
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(jsBaseX, jsBaseY, jsRadius, 0, Math.PI * 2);
        ctx.stroke();

        // Joystick thumb
        const js = joystickRef.current;
        let thumbX = jsBaseX;
        let thumbY = jsBaseY;
        if (js.active) {
          const mag = Math.sqrt(js.dx * js.dx + js.dy * js.dy);
          const clamped = Math.min(mag, jsRadius);
          if (mag > 0) {
            thumbX = jsBaseX + (js.dx / mag) * clamped;
            thumbY = jsBaseY + (js.dy / mag) * clamped;
          }
        }
        ctx.fillStyle = '#00ff00';
        ctx.beginPath();
        ctx.arc(thumbX, thumbY, 20, 0, Math.PI * 2);
        ctx.fill();

        // Fire button
        const fbX = canvas.width - 120;
        const fbY = canvas.height - 140;
        const fbRadius = 50;
        ctx.strokeStyle = fireRef.current.active ? '#ff4400' : '#ff8800';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(fbX, fbY, fbRadius, 0, Math.PI * 2);
        ctx.stroke();
        if (fireRef.current.active) {
          ctx.fillStyle = 'rgba(255, 68, 0, 0.3)';
          ctx.fill();
        }
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#ff8800';
        ctx.font = 'bold 18px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('FIRE', fbX, fbY);

        ctx.restore();
      }
    };

    animationFrameId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animationFrameId);
  }, [gameStarted, gameOver, isPaused]);

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden font-mono text-white select-none">
      <canvas
        ref={canvasRef}
        className="block w-full h-full"
      />

      {/* UI Overlay */}
      <div className="absolute top-4 left-4 flex flex-col gap-1">
        <div className="text-2xl tracking-widest text-[#00ff00]">GRAVITY GRID</div>
        {playerCount === 1 ? (
          <div className="flex gap-8">
            <div className="text-xl">SCORE: {(scores[0] || 0).toString().padStart(6, '0')}</div>
            <div className="text-xl text-red-500">LIVES: {'❤'.repeat(livesArray[0] || 0)}</div>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex gap-6">
              <div className="text-lg text-[#00ff00]">P1: {(scores[0] || 0).toString().padStart(6, '0')}</div>
              <div className="text-lg text-red-500">{'❤'.repeat(livesArray[0] || 0)}</div>
            </div>
            <div className="flex gap-6">
              <div className="text-lg text-[#00aaff]">P2: {(scores[1] || 0).toString().padStart(6, '0')}</div>
              <div className="text-lg text-red-500">{'❤'.repeat(livesArray[1] || 0)}</div>
            </div>
          </div>
        )}
      </div>

      {!gameStarted && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10">
          <h1 className="text-6xl mb-8 text-[#00ff00] animate-pulse">GRAVITY GRID</h1>
          <div className="text-center mb-8 space-y-2 text-gray-400">
            <p className="text-[#00ff00]">P1: W/A/S/D or ARROWS to Move, SPACE to Shoot</p>
            <p className="text-[#00aaff]">P2: I/J/K/L to Move, ENTER to Shoot</p>
            <p className="text-gray-500 text-sm mt-2">Mobile: Left side = joystick, Right side = fire (1P only)</p>
            <p className="mt-4">Push enemies into the Black Hole</p>
            <p>Bullets don't kill, they PUSH</p>
            <p className="text-yellow-400 text-sm mt-2">Last player to hit an enemy before it's sucked in scores the points!</p>
          </div>
          <div className="flex gap-6">
            <button
              onClick={() => {
                initAudio();
                setPlayerCount(1);
                resetGame(1);
                setGameStarted(true);
              }}
              className="px-8 py-4 border-4 border-[#00ff00] text-[#00ff00] text-2xl hover:bg-[#00ff00] hover:text-black transition-colors"
            >
              1 PLAYER
            </button>
            <button
              onClick={() => {
                initAudio();
                setPlayerCount(2);
                resetGame(2);
                setGameStarted(true);
              }}
              className="px-8 py-4 border-4 border-[#00aaff] text-[#00aaff] text-2xl hover:bg-[#00aaff] hover:text-black transition-colors"
            >
              2 PLAYERS
            </button>
          </div>
        </div>
      )}

      {isPaused && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm z-30">
          <h2 className="text-6xl mb-8 text-[#00ff00]">PAUSED</h2>
          <div className="flex flex-col gap-4">
            <button
              onClick={() => setIsPaused(false)}
              className="px-8 py-4 border-4 border-[#00ff00] text-[#00ff00] text-2xl hover:bg-[#00ff00] hover:text-black transition-colors"
            >
              RESUME
            </button>
            <button
              onClick={() => {
                resetGame(playerCount);
                setGameStarted(false);
              }}
              className="px-8 py-4 border-4 border-red-500 text-red-500 text-2xl hover:bg-red-500 hover:text-black transition-colors"
            >
              QUIT TO MENU
            </button>
          </div>
          <div className="mt-8 text-gray-400">Press ESC to Resume</div>
        </div>
      )}

      {gameOver && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-900/40 backdrop-blur-sm z-20">
          <h2 className="text-8xl mb-4 text-white font-bold">GAME OVER</h2>
          {playerCount === 1 ? (
            <div className="text-4xl mb-8">FINAL SCORE: {scores[0] || 0}</div>
          ) : (
            <div className="text-center mb-8 space-y-2">
              <div className="text-3xl text-[#00ff00]">P1: {scores[0] || 0}</div>
              <div className="text-3xl text-[#00aaff]">P2: {scores[1] || 0}</div>
              <div className="text-4xl mt-4 text-yellow-400">
                {(scores[0] || 0) > (scores[1] || 0) ? 'PLAYER 1 WINS!' :
                 (scores[1] || 0) > (scores[0] || 0) ? 'PLAYER 2 WINS!' : 'TIE GAME!'}
              </div>
            </div>
          )}
          <button
            onClick={() => window.location.reload()}
            className="px-8 py-4 border-4 border-white text-white text-2xl hover:bg-white hover:text-red-900 transition-colors"
          >
            TRY AGAIN
          </button>
        </div>
      )}

      <div className="absolute bottom-4 right-4 text-xs text-gray-500">
        8-BIT KINETIC SHOOTER V1.2
      </div>
    </div>
  );
}
