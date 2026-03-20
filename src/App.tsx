/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

// --- Constants ---
const GRID_SIZE = 40;
const GRAVITY_STRENGTH = 1000; // Slowed down
const BLACK_HOLE_RADIUS = 30;
const SHIP_SIZE = 20;
const BULLET_SPEED = 6; // Slowed down
const BULLET_LIFETIME = 50; // Adjusted for slower speed
const PLAYER_ACCEL = 0.08; // Slowed down
const PLAYER_ROT_SPEED = 0.06; // Slowed down
const PLAYER_FIRE_RATE = 8; // Slowed down
const FRICTION = 0.98;
const ENEMY_SPAWN_RATE = 180; // Slowed down
const ENEMY_FIRE_RATE = 240; // Slowed down
const BLACK_HOLE_SPEED = 0.5; // Slowed down
const MAX_LIVES = 3;

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
}

interface Bullet extends Entity {
  life: number;
  ownerId: number;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(MAX_LIVES);
  const [gameOver, setGameOver] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

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
  const playerRef = useRef<Entity>({
    id: 0,
    x: 100,
    y: 100,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2,
    color: '#00ff00',
    isMoving: false,
    lastShot: 0,
  });
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

  const resetGame = () => {
    setScore(0);
    setLives(MAX_LIVES);
    setGameOver(false);
    setIsPaused(false);
    enemiesRef.current = [];
    bulletsRef.current = [];
    playerRef.current = {
      id: 0,
      x: 100,
      y: 100,
      vx: 0,
      vy: 0,
      angle: -Math.PI / 2,
      color: '#00ff00',
      isMoving: false,
      lastShot: 0,
    };
    frameCountRef.current = 0;
  };

  const respawnPlayer = () => {
    playSound('death');
    const player = playerRef.current;
    player.x = 100;
    player.y = 100;
    player.vx = 0;
    player.vy = 0;
    player.angle = -Math.PI / 2;
    setLives((l) => {
      if (l <= 1) {
        setGameOver(true);
        return 0;
      }
      return l - 1;
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

    // Detect mobile
    isMobile.current = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    const handleKeyDown = (e: KeyboardEvent) => {
      keysRef.current[e.code] = true;
      if (e.code === 'Escape' && gameStarted && !gameOver) {
        setIsPaused((p) => !p);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => (keysRef.current[e.code] = false);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // Touch handlers
    const JOYSTICK_ZONE_WIDTH = 0.5; // left half of screen

    const handleTouchStart = (e: TouchEvent) => {
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
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [gameStarted, gameOver]);

  // Game Loop
  useEffect(() => {
    if (!gameStarted || gameOver || isPaused) return;

    let animationFrameId: number;

    const update = () => {
      const canvas = canvasRef.current;
      if (!canvas || isPaused) return;

      const player = playerRef.current;
      const keys = keysRef.current;
      const bh = blackHoleRef.current;

      // 0. Update Black Hole
      bh.x += bh.vx;
      bh.y += bh.vy;
      if (bh.x < BLACK_HOLE_RADIUS || bh.x > canvas.width - BLACK_HOLE_RADIUS) bh.vx *= -1;
      if (bh.y < BLACK_HOLE_RADIUS || bh.y > canvas.height - BLACK_HOLE_RADIUS) bh.vy *= -1;

      // 1. Player Input (keyboard)
      if (keys['ArrowLeft'] || keys['KeyA']) player.angle -= PLAYER_ROT_SPEED;
      if (keys['ArrowRight'] || keys['KeyD']) player.angle += PLAYER_ROT_SPEED;

      player.isMoving = keys['ArrowUp'] || keys['KeyW'];
      if (player.isMoving) {
        player.vx += Math.cos(player.angle) * PLAYER_ACCEL;
        player.vy += Math.sin(player.angle) * PLAYER_ACCEL;
      }

      // 1b. Player Input (touch joystick)
      const js = joystickRef.current;
      if (js.active) {
        const mag = Math.sqrt(js.dx * js.dx + js.dy * js.dy);
        const DEAD_ZONE = 15;
        if (mag > DEAD_ZONE) {
          const targetAngle = Math.atan2(js.dy, js.dx);
          // Smoothly rotate toward joystick direction
          let angleDiff = targetAngle - player.angle;
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          player.angle += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), PLAYER_ROT_SPEED * 2);

          // Thrust proportional to joystick distance (capped)
          const thrust = Math.min(mag / 80, 1) * PLAYER_ACCEL;
          player.vx += Math.cos(player.angle) * thrust;
          player.vy += Math.sin(player.angle) * thrust;
          player.isMoving = true;
        }
      }

      // Fire (keyboard or touch)
      const wantsFire = keys['Space'] || fireRef.current.active;
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

      // 2. Physics & Gravity
      const entities = [player, ...enemiesRef.current];

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
          if (e.id === player.id) {
            respawnPlayer();
          } else if (!e.isShielded) {
            // Enemy sucked in (only if not shielded)
            enemiesRef.current = enemiesRef.current.filter((en) => en.id !== e.id);
            setScore((s) => s + 100);
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
        if (b.ownerId === player.id) {
          // Player bullet hitting enemy
          enemiesRef.current.forEach((en) => {
            if (en.isShielded) return; // Shielded enemies can't be pushed
            const edx = en.x - b.x;
            const edy = en.y - b.y;
            const edist = Math.sqrt(edx * edx + edy * edy);
            if (edist < SHIP_SIZE) {
              en.vx += b.vx * 0.5;
              en.vy += b.vy * 0.5;
              playSound('hit');
              b.life = 0; // Destroy bullet
            }
          });
        } else {
          // Enemy bullet hitting player
          const pdx = player.x - b.x;
          const pdy = player.y - b.y;
          const pdist = Math.sqrt(pdx * pdx + pdy * pdy);
          if (pdist < SHIP_SIZE) {
            // PUSH PLAYER instead of killing
            player.vx += b.vx * 0.8;
            player.vy += b.vy * 0.8;
            playSound('hit');
            b.life = 0;
          }
        }
      });
      bulletsRef.current = bulletsRef.current.filter((b) => b.life > 0);

      // 4. Enemy Spawning & AI
      if (frameCountRef.current % ENEMY_SPAWN_RATE === 0) {
        const colors = ['#ff00ff', '#00ffff', '#ffff00', '#ff4400'];
        const spawnAngle = Math.random() * Math.PI * 2;
        playSound('spawn');
        enemiesRef.current.push({
          id: nextIdRef.current++,
          x: bh.x,
          y: bh.y,
          vx: Math.cos(spawnAngle) * 6, // Even stronger initial burst
          vy: Math.sin(spawnAngle) * 6,
          angle: spawnAngle,
          color: colors[Math.floor(Math.random() * colors.length)],
          lastShot: frameCountRef.current,
          isShielded: true,
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

        const pdx = player.x - en.x;
        const pdy = player.y - en.y;
        const pdist = Math.sqrt(pdx * pdx + pdy * pdy);
        en.angle = Math.atan2(pdy, pdx);
        
        // Boost occasionally
        if (Math.random() < 0.02) {
          en.vx += Math.cos(en.angle) * 0.3;
          en.vy += Math.sin(en.angle) * 0.3;
          en.isMoving = true;
        } else {
          en.isMoving = false;
        }

        // Enemy shooting (only if not shielded)
        if (!en.isShielded && frameCountRef.current - (en.lastShot || 0) >= ENEMY_FIRE_RATE) {
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
      });

      frameCountRef.current++;
      render();
      animationFrameId = requestAnimationFrame(update);
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

      drawShip(playerRef.current);
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

      // 5. Draw Touch Controls (only on touch devices)
      if (isMobile.current) {
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
  }, [gameStarted, gameOver]);

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden font-mono text-white select-none">
      <canvas
        ref={canvasRef}
        className="block w-full h-full"
      />

      {/* UI Overlay */}
      <div className="absolute top-4 left-4 flex flex-col gap-1">
        <div className="text-2xl tracking-widest text-[#00ff00]">GRAVITY GRID</div>
        <div className="flex gap-8">
          <div className="text-xl">SCORE: {score.toString().padStart(6, '0')}</div>
          <div className="text-xl text-red-500">LIVES: {'❤'.repeat(lives)}</div>
        </div>
      </div>

      {!gameStarted && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10">
          <h1 className="text-6xl mb-8 text-[#00ff00] animate-pulse">GRAVITY GRID</h1>
          <div className="text-center mb-12 space-y-2 text-gray-400">
            <p>W/A/S/D or ARROWS to Move</p>
            <p>SPACE to Shoot</p>
            <p className="text-gray-500 text-sm mt-2">Mobile: Left side = joystick, Right side = fire</p>
            <p className="mt-4">Push enemies into the Black Hole</p>
            <p>Bullets don't kill, they PUSH</p>
          </div>
          <button
            onClick={() => {
              initAudio();
              setGameStarted(true);
            }}
            className="px-8 py-4 border-4 border-[#00ff00] text-[#00ff00] text-2xl hover:bg-[#00ff00] hover:text-black transition-colors"
          >
            START MISSION
          </button>
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
                resetGame();
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
          <div className="text-4xl mb-8">FINAL SCORE: {score}</div>
          <button
            onClick={() => window.location.reload()}
            className="px-8 py-4 border-4 border-white text-white text-2xl hover:bg-white hover:text-red-900 transition-colors"
          >
            TRY AGAIN
          </button>
        </div>
      )}

      <div className="absolute bottom-4 right-4 text-xs text-gray-500">
        8-BIT KINETIC SHOOTER V1.1
      </div>
    </div>
  );
}

