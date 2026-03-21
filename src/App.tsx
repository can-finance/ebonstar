/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { HostConnection } from './net/host';
import { ClientConnection } from './net/client';
import type { GameStateMsg, InputState } from './net/protocol';
import { serializeEntity, serializeBullet, PLAYER_ID_LIST } from './net/protocol';

// --- Constants ---
const GRID_SIZE = 40;
const GRAVITY_STRENGTH = 800;
const BLACK_HOLE_RADIUS = 30;
const SHIP_SIZE = 20;
const BULLET_SPEED = 5;
const BULLET_LIFETIME = 55;
const PLAYER_ACCEL = 0.09;
const PLAYER_MAX_SPEED = 2.5;
const PLAYER_ROT_SPEED = 0.05;
const PLAYER_FIRE_RATE = 9;
const FRICTION = 0.96;
const ENEMY_SPAWN_RATE = 300;
const ENEMY_FIRE_RATE = 280;
const BLACK_HOLE_SPEED = 0.3;
const MAX_LIVES = 3;
const NET_SEND_INTERVAL = 3; // Send state every 3rd tick (20Hz)
const RELAY_PORT = 3001;

// Fixed world size — game logic always runs in this coordinate space
const WORLD_W = 1920;
const WORLD_H = 1080;

// Player IDs for up to 4 players
const PLAYER_IDS = new Set(PLAYER_ID_LIST);
const PLAYER_COLORS = ['#00ff00', '#00aaff', '#ff8800', '#aa44ff'];

// Control schemes (local keyboard: up to 2 players)
const CONTROLS = [
  { left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], thrust: ['ArrowUp', 'KeyW'], fire: ['Space'] },
  { left: ['KeyJ'], right: ['KeyL'], thrust: ['KeyI'], fire: ['Enter'] },
];

type Point = { x: number; y: number; vx?: number; vy?: number };

interface Entity {
  id: number;
  x: number; y: number;
  vx: number; vy: number;
  angle: number;
  color: string;
  isMoving?: boolean;
  lastShot?: number;
  isShielded?: boolean;
  fuel?: number;
  lastHitBy?: number;
  respawnTimer?: number; // frames remaining until respawn (0 = alive)
}

interface Bullet extends Entity {
  life: number;
  ownerId: number;
}

interface FloatingText {
  x: number; y: number;
  text: string;
  color: string;
  life: number; // frames remaining
}

type GameMode = 'menu' | 'lobby_host' | 'lobby_client' | 'playing';
type NetworkRole = 'none' | 'host' | 'client';

function makePlayer(id: number, x: number, y: number): Entity {
  const idx = PLAYER_ID_LIST.indexOf(id);
  return {
    id, x, y,
    vx: 0, vy: 0,
    angle: -Math.PI / 2,
    color: PLAYER_COLORS[idx] || '#ffffff',
    isMoving: false,
    lastShot: 0,
  };
}

const MIN_SPAWN_DIST_FROM_BH = 250; // Minimum distance from black hole to spawn

function getSpawnPos(playerIdx: number, bh?: { x: number; y: number }): [number, number] {
  const candidates: [number, number][] = [
    [100, 100],                     // P1: top-left
    [WORLD_W - 100, WORLD_H - 100], // P2: bottom-right
    [WORLD_W - 100, 100],           // P3: top-right
    [100, WORLD_H - 100],           // P4: bottom-left
  ];
  const preferred = candidates[playerIdx] || [WORLD_W / 2, WORLD_H / 2];

  if (!bh) return preferred;

  // Check if preferred spot is too close to the black hole
  const dx = preferred[0] - bh.x;
  const dy = preferred[1] - bh.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist >= MIN_SPAWN_DIST_FROM_BH) return preferred;

  // Pick the candidate farthest from the black hole
  let bestDist = 0;
  let bestPos = preferred;
  for (const pos of candidates) {
    const cdx = pos[0] - bh.x;
    const cdy = pos[1] - bh.y;
    const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
    if (cdist > bestDist) {
      bestDist = cdist;
      bestPos = pos;
    }
  }

  // If even the best candidate is too close, push away from the black hole
  if (bestDist < MIN_SPAWN_DIST_FROM_BH) {
    const angle = Math.atan2(bestPos[1] - bh.y, bestPos[0] - bh.x);
    return [
      Math.max(50, Math.min(WORLD_W - 50, bh.x + Math.cos(angle) * MIN_SPAWN_DIST_FROM_BH)),
      Math.max(50, Math.min(WORLD_H - 50, bh.y + Math.sin(angle) * MIN_SPAWN_DIST_FROM_BH)),
    ];
  }

  return bestPos;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [scores, setScores] = useState<number[]>([0]);
  const [livesArray, setLivesArray] = useState<number[]>([MAX_LIVES]);
  const [gameOver, setGameOver] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  // Refs that mirror state for access inside game loop closures
  const scoresRef = useRef<number[]>([0]);
  const livesRef = useRef<number[]>([MAX_LIVES]);
  const gameOverRef = useRef(false);
  const [playerCount, setPlayerCount] = useState<number>(1);

  // Keep refs in sync with state for game loop access
  useEffect(() => { scoresRef.current = scores; }, [scores]);
  useEffect(() => { livesRef.current = livesArray; }, [livesArray]);
  useEffect(() => { gameOverRef.current = gameOver; }, [gameOver]);

  // Network state
  const [gameMode, setGameMode] = useState<GameMode>('menu');
  const [networkRole, setNetworkRole] = useState<NetworkRole>('none');
  const [roomCode, setRoomCode] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [lobbyPlayerCount, setLobbyPlayerCount] = useState(1);
  const [networkError, setNetworkError] = useState('');
  const [localPlayerCount, setLocalPlayerCount] = useState(1);
  const [availableRooms, setAvailableRooms] = useState<{ code: string; players: number; maxPlayers: number }[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);

  const hostRef = useRef<HostConnection | null>(null);
  const clientRef = useRef<ClientConnection | null>(null);
  const networkRoleRef = useRef<NetworkRole>('none');
  const clientStateRef = useRef<GameStateMsg | null>(null);

  // Sound System
  const noiseBufferRef = useRef<AudioBuffer | null>(null);
  const reverbNodeRef = useRef<ConvolverNode | null>(null);
  const reverbGainRef = useRef<GainNode | null>(null);
  const dryGainRef = useRef<GainNode | null>(null);
  const droneOscRef = useRef<OscillatorNode[]>([]);
  const droneGainRef = useRef<GainNode | null>(null);
  const droneFilterRef = useRef<BiquadFilterNode | null>(null);

  const initAudio = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioCtxRef.current;

    // Create noise buffer (reusable for impacts/explosions)
    if (!noiseBufferRef.current) {
      const bufferSize = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
      noiseBufferRef.current = buffer;
    }

    // Create reverb impulse response (simple synthetic reverb)
    if (!reverbNodeRef.current) {
      const reverbLen = ctx.sampleRate * 0.8;
      const impulse = ctx.createBuffer(2, reverbLen, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch);
        for (let i = 0; i < reverbLen; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / reverbLen, 2.5);
        }
      }
      const convolver = ctx.createConvolver();
      convolver.buffer = impulse;
      const reverbGain = ctx.createGain();
      reverbGain.gain.value = 0.15;
      convolver.connect(reverbGain);
      reverbGain.connect(ctx.destination);
      reverbNodeRef.current = convolver;
      reverbGainRef.current = reverbGain;

      const dryGain = ctx.createGain();
      dryGain.gain.value = 1.0;
      dryGain.connect(ctx.destination);
      dryGainRef.current = dryGain;
    }

    // Create black hole ambient drone
    if (droneOscRef.current.length === 0) {
      const droneGain = ctx.createGain();
      droneGain.gain.value = 0;
      const droneFilter = ctx.createBiquadFilter();
      droneFilter.type = 'lowpass';
      droneFilter.frequency.value = 120;
      droneFilter.Q.value = 2;
      droneFilter.connect(droneGain);
      droneGain.connect(ctx.destination);
      droneGainRef.current = droneGain;
      droneFilterRef.current = droneFilter;

      const freqs = [40, 80, 120.5]; // fundamental + harmonics, slightly detuned
      const types: OscillatorType[] = ['sine', 'sine', 'triangle'];
      freqs.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        osc.type = types[i];
        osc.frequency.value = freq;
        const oscGain = ctx.createGain();
        oscGain.gain.value = i === 0 ? 0.5 : i === 1 ? 0.3 : 0.15;
        osc.connect(oscGain);
        oscGain.connect(droneFilter);
        osc.start();
        droneOscRef.current.push(osc);
      });
    }
  };

  // Route a node through both dry and reverb sends
  const connectWithReverb = (node: AudioNode, reverbAmount: number = 0.3) => {
    if (dryGainRef.current) node.connect(dryGainRef.current);
    if (reverbNodeRef.current && reverbAmount > 0) {
      const sendGain = audioCtxRef.current!.createGain();
      sendGain.gain.value = reverbAmount;
      node.connect(sendGain);
      sendGain.connect(reverbNodeRef.current);
    }
  };

  // Create a noise burst with filter
  const playNoiseBurst = (duration: number, volume: number, filterFreq: number, filterQ: number, reverbAmt: number = 0.2) => {
    const ctx = audioCtxRef.current!;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = noiseBufferRef.current;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(filterFreq, now);
    filter.Q.value = filterQ;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    source.connect(filter);
    filter.connect(gain);
    connectWithReverb(gain, reverbAmt);
    source.start(now);
    source.stop(now + duration);
  };

  // Update drone volume based on nearest player distance to black hole
  const updateDrone = (minPlayerDist: number) => {
    if (!droneGainRef.current || !droneFilterRef.current || !audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const now = ctx.currentTime;
    // Volume ramps up as player gets closer (max at dist=0, silent beyond 600)
    const normalizedDist = Math.max(0, Math.min(1, 1 - minPlayerDist / 600));
    const targetVol = normalizedDist * normalizedDist * 0.12;
    droneGainRef.current.gain.setTargetAtTime(targetVol, now, 0.1);
    // Filter opens up as player gets closer
    const targetFreq = 80 + normalizedDist * 200;
    droneFilterRef.current.frequency.setTargetAtTime(targetFreq, now, 0.1);
  };

  const playSound = (type: 'shoot' | 'hit' | 'death' | 'spawn' | 'score' | 'enemyShoot' | 'enemyAbsorbed' | 'shieldBreak') => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;

    // Pitch variation helper
    const vary = (base: number, range: number = 0.08) => base * (1 - range + Math.random() * range * 2);

    if (type === 'shoot') {
      // Layered: noise snap + pitched sweep
      playNoiseBurst(0.03, 0.08, vary(3000), 1, 0.1);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(vary(520), now);
      osc.frequency.exponentialRampToValueAtTime(vary(130), now + 0.08);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.08);
      osc.connect(gain);
      connectWithReverb(gain, 0.1);
      osc.start(now); osc.stop(now + 0.08);

    } else if (type === 'enemyShoot') {
      // Deeper, more menacing shot
      playNoiseBurst(0.02, 0.05, vary(1500), 2, 0.1);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(vary(280), now);
      osc.frequency.exponentialRampToValueAtTime(vary(70), now + 0.1);
      gain.gain.setValueAtTime(0.03, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.1);
      osc.connect(gain);
      connectWithReverb(gain, 0.15);
      osc.start(now); osc.stop(now + 0.1);

    } else if (type === 'hit') {
      // Noise impact + low thud
      playNoiseBurst(0.08, 0.12, vary(800), 3, 0.3);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(vary(180), now);
      osc.frequency.linearRampToValueAtTime(vary(40), now + 0.15);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.15);
      osc.connect(gain);
      connectWithReverb(gain, 0.25);
      osc.start(now); osc.stop(now + 0.15);

    } else if (type === 'death') {
      // Layered explosion: noise burst + two detuned oscillators + rumble
      playNoiseBurst(0.4, 0.2, vary(600), 1.5, 0.4);
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(vary(110), now);
      osc1.frequency.linearRampToValueAtTime(20, now + 0.6);
      gain1.gain.setValueAtTime(0.12, now);
      gain1.gain.linearRampToValueAtTime(0, now + 0.6);
      osc1.connect(gain1);
      connectWithReverb(gain1, 0.5);
      osc1.start(now); osc1.stop(now + 0.6);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'square';
      osc2.frequency.setValueAtTime(vary(55), now);
      osc2.frequency.linearRampToValueAtTime(15, now + 0.5);
      gain2.gain.setValueAtTime(0.08, now);
      gain2.gain.linearRampToValueAtTime(0, now + 0.5);
      osc2.connect(gain2);
      connectWithReverb(gain2, 0.4);
      osc2.start(now); osc2.stop(now + 0.5);

    } else if (type === 'spawn') {
      // Shimmering rise: two sine oscillators with harmonics
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(vary(110), now);
      osc1.frequency.exponentialRampToValueAtTime(vary(660), now + 0.35);
      gain1.gain.setValueAtTime(0.04, now);
      gain1.gain.setValueAtTime(0.05, now + 0.15);
      gain1.gain.linearRampToValueAtTime(0, now + 0.35);
      osc1.connect(gain1);
      connectWithReverb(gain1, 0.4);
      osc1.start(now); osc1.stop(now + 0.35);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(vary(165), now);
      osc2.frequency.exponentialRampToValueAtTime(vary(990), now + 0.35);
      gain2.gain.setValueAtTime(0.02, now);
      gain2.gain.setValueAtTime(0.03, now + 0.15);
      gain2.gain.linearRampToValueAtTime(0, now + 0.35);
      osc2.connect(gain2);
      connectWithReverb(gain2, 0.4);
      osc2.start(now); osc2.stop(now + 0.35);

    } else if (type === 'score') {
      // Two-note chime with reverb
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(vary(880), now);
      gain1.gain.setValueAtTime(0.06, now);
      gain1.gain.linearRampToValueAtTime(0, now + 0.2);
      osc1.connect(gain1);
      connectWithReverb(gain1, 0.5);
      osc1.start(now); osc1.stop(now + 0.2);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(vary(1320), now + 0.08);
      gain2.gain.setValueAtTime(0, now);
      gain2.gain.setValueAtTime(0.06, now + 0.08);
      gain2.gain.linearRampToValueAtTime(0, now + 0.3);
      osc2.connect(gain2);
      connectWithReverb(gain2, 0.5);
      osc2.start(now); osc2.stop(now + 0.3);

    } else if (type === 'enemyAbsorbed') {
      // Implosion: pitch sweep down + noise crunch
      playNoiseBurst(0.25, 0.15, vary(400), 4, 0.4);
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(vary(300), now);
      osc.frequency.exponentialRampToValueAtTime(25, now + 0.3);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2000, now);
      filter.frequency.exponentialRampToValueAtTime(80, now + 0.3);
      filter.Q.value = 5;
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.3);
      osc.connect(filter);
      filter.connect(gain);
      connectWithReverb(gain, 0.5);
      osc.start(now); osc.stop(now + 0.3);

    } else if (type === 'shieldBreak') {
      // Quick shimmer: high-freq noise + descending chime
      playNoiseBurst(0.06, 0.06, vary(6000), 2, 0.3);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(vary(2200), now);
      osc.frequency.exponentialRampToValueAtTime(vary(800), now + 0.15);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.15);
      osc.connect(gain);
      connectWithReverb(gain, 0.4);
      osc.start(now); osc.stop(now + 0.15);
    }
  };

  // Game state refs
  const playersRef = useRef<Entity[]>([makePlayer(PLAYER_ID_LIST[0], 100, 100)]);
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
  const floatingTextsRef = useRef<FloatingText[]>([]);

  // Viewport scaling — maps fixed world coords to canvas pixels with letterboxing
  const viewportRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });
  const updateViewport = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const scaleX = canvas.width / WORLD_W;
    const scaleY = canvas.height / WORLD_H;
    const scale = Math.min(scaleX, scaleY);
    viewportRef.current = {
      scale,
      offsetX: (canvas.width - WORLD_W * scale) / 2,
      offsetY: (canvas.height - WORLD_H * scale) / 2,
    };
  };

  // Convert screen coordinates (touch/click) to world coordinates
  const screenToWorld = (sx: number, sy: number): [number, number] => {
    const { scale, offsetX, offsetY } = viewportRef.current;
    return [(sx - offsetX) / scale, (sy - offsetY) / scale];
  };

  // Mobile touch controls
  const isMobile = useRef(false);
  const joystickRef = useRef<{ active: boolean; startX: number; startY: number; dx: number; dy: number; touchId: number | null }>({
    active: false, startX: 0, startY: 0, dx: 0, dy: 0, touchId: null,
  });
  const fireRef = useRef<{ active: boolean; touchId: number | null }>({ active: false, touchId: null });

  const getRelayUrl = () => {
    const loc = window.location;
    const isLocal = loc.hostname === 'localhost' || loc.hostname === '127.0.0.1' || /^(192\.|10\.|172\.)/.test(loc.hostname);
    if (isLocal) {
      // Local dev — use Vite proxy path
      return `ws://${loc.hostname || 'localhost'}:${loc.port || '3000'}/relay`;
    }
    // Production — connect to relay server (set VITE_RELAY_URL in .env or replace default)
    return import.meta.env.VITE_RELAY_URL || 'wss://ebonstar.onrender.com';
  };

  const resetGame = (numPlayers: number = 1) => {
    const initScores = Array(numPlayers).fill(0);
    const initLives = Array(numPlayers).fill(MAX_LIVES);
    setScores(initScores);
    setLivesArray(initLives);
    setGameOver(false);
    setIsPaused(false);
    enemiesRef.current = [];
    bulletsRef.current = [];
    deadPlayersRef.current = new Set();
    playerCountRef.current = numPlayers;

    playersRef.current = [];
    for (let i = 0; i < numPlayers; i++) {
      const [sx, sy] = getSpawnPos(i, blackHoleRef.current);
      playersRef.current.push(makePlayer(PLAYER_ID_LIST[i], sx, sy));
    }
    frameCountRef.current = 0;
  };

  const RESPAWN_DELAY = 300; // 5 seconds at 60fps

  const respawnPlayer = (playerIndex: number) => {
    playSound('death');
    const p = playersRef.current[playerIndex];
    if (!p) return;
    // Move player off-screen and set respawn timer
    p.x = -9999; p.y = -9999;
    p.vx = 0; p.vy = 0;
    p.respawnTimer = RESPAWN_DELAY;

    setLivesArray((prev) => {
      const next = [...prev];
      next[playerIndex] = Math.max(0, next[playerIndex] - 1);
      livesRef.current = next; // sync ref immediately for broadcast
      if (next[playerIndex] <= 0) {
        deadPlayersRef.current.add(p.id);
        if (deadPlayersRef.current.size >= playerCountRef.current) {
          gameOverRef.current = true;
          // Broadcast final game over state to clients immediately before the effect stops
          if (networkRoleRef.current === 'host' && hostRef.current) {
            const bh = blackHoleRef.current;
            const finalState: GameStateMsg = {
              type: 'state',
              frame: frameCountRef.current,
              players: playersRef.current.map(serializeEntity),
              deadPlayers: Array.from(deadPlayersRef.current),
              enemies: enemiesRef.current.map(serializeEntity),
              bullets: bulletsRef.current.map(serializeBullet),
              blackHole: { x: bh.x, y: bh.y, vx: bh.vx, vy: bh.vy },
              scores: scoresRef.current,
              lives: next,
              gameOver: true,
              isPaused: false,
            };
            hostRef.current.broadcastState(finalState);
          }
          setGameOver(true);
        }
      }
      return next;
    });
  };

  // --- Network: Host game ---
  const checkServerThen = (callback: () => void) => {
    setNetworkError('');
    const ws = new WebSocket(getRelayUrl());
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      setNetworkError('Server not found');
    }, 3000);
    ws.onopen = () => {
      clearTimeout(timeout);
      ws.close();
      callback();
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      setNetworkError('Server not found');
    };
  };

  const hostGame = (localPlayers: number) => {
    setGameMode('lobby_host');
    setNetworkError('');
    setLobbyPlayerCount(localPlayers);
    setLocalPlayerCount(localPlayers);
    setRoomCode('');

    checkServerThen(() => {
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * 26)]).join('');
      setRoomCode(code);
      setNetworkRole('host');
      networkRoleRef.current = 'host';

      const conn = new HostConnection(getRelayUrl(), code);
      hostRef.current = conn;

      conn.onPlayerJoined = (count, playerId) => {
        setLobbyPlayerCount(count);
      };
      conn.onPlayerLeft = (playerId) => {
        setLobbyPlayerCount((c) => Math.max(1, c - 1));
        // Remove player from game if playing
        const idx = playersRef.current.findIndex(p => p.id === playerId);
        if (idx >= 0) {
          deadPlayersRef.current.add(playerId);
          playersRef.current = playersRef.current.filter(p => p.id !== playerId);
          playerCountRef.current = playersRef.current.length;
        }
      };
      conn.onError = (msg) => {
        setNetworkError(msg);
        hostRef.current?.close();
        hostRef.current = null;
      };
    });
  };

  const startHostedGame = () => {
    const totalPlayers = lobbyPlayerCount;
    setPlayerCount(totalPlayers);
    resetGame(totalPlayers);
    initAudio();
    setGameStarted(true);
    setGameMode('playing');
    hostRef.current?.sendGameStart(totalPlayers);
  };

  // --- Network: Browse available games ---
  const browseGames = () => {
    setNetworkError('');
    setAvailableRooms([]);
    setLoadingRooms(true);
    setGameMode('lobby_client');
    // Don't set networkRole yet — we're just browsing, not joining
    networkRoleRef.current = 'none';
    setNetworkRole('none');

    let gotResponse = false;
    const ws = new WebSocket(getRelayUrl());
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'list_rooms' }));
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === 'room_list') {
        gotResponse = true;
        setAvailableRooms(msg.rooms);
        setLoadingRooms(false);
        ws.close();
      }
    };
    ws.onerror = () => {
      setNetworkError('Server not found');
      setLoadingRooms(false);
    };
    ws.onclose = () => {
      if (!gotResponse) {
        setLoadingRooms(false);
        if (!networkError) setNetworkError('Server not found');
      }
    };
    // Timeout fallback
    setTimeout(() => {
      if (!gotResponse) {
        setLoadingRooms(false);
        setNetworkError('Server not responding');
        try { ws.close(); } catch {}
      }
    }, 3000);
  };

  // --- Network: Join game ---
  const joinGame = (code: string) => {
    setNetworkError('');
    setGameMode('lobby_client');
    setNetworkRole('client');
    networkRoleRef.current = 'client';

    const conn = new ClientConnection(getRelayUrl(), code);
    clientRef.current = conn;

    conn.onAssigned = (playerId, playerIndex) => {
      // We have our player assignment
    };
    conn.onGameStart = (numPlayers) => {
      setPlayerCount(numPlayers);
      setScores(Array(numPlayers).fill(0));
      setLivesArray(Array(numPlayers).fill(MAX_LIVES));
      initAudio();
      setGameStarted(true);
      setGameMode('playing');
    };
    conn.onError = (msg) => {
      setNetworkError(msg);
      setGameMode('menu');
    };
    conn.onDisconnect = () => {
      // Host left — clean up and return to menu
      clientRef.current?.close();
      clientRef.current = null;
      setNetworkError('Host disconnected');
      setGameStarted(false);
      setGameOver(false);
      setIsPaused(false);
      setGameMode('menu');
      setNetworkRole('none');
      networkRoleRef.current = 'none';
    };
  };

  const backToMenu = () => {
    hostRef.current?.close();
    clientRef.current?.close();
    hostRef.current = null;
    clientRef.current = null;
    setGameMode('menu');
    setNetworkRole('none');
    networkRoleRef.current = 'none';
    setGameStarted(false);
    setGameOver(false);
    setIsPaused(false);
    setNetworkError('');
    setRoomCode('');
    setJoinCode('');
  };

  // Initialize game
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        updateViewport();
        if (!gameStarted) {
          blackHoleRef.current.x = WORLD_W * 0.75;
          blackHoleRef.current.y = WORLD_H * 0.4;
        }
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();

    const activateMobile = () => {
      isMobile.current = true;
      window.removeEventListener('touchstart', activateMobile);
    };
    if (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) {
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

    // Touch handlers
    const JOYSTICK_ZONE_WIDTH = 0.5;
    const handleTouchStart = (e: TouchEvent) => {
      if (!gameStarted || gameOver || isPaused) return;
      // Disable touch only for 2-player local (both share same screen/keyboard)
      if (playerCountRef.current > 1 && networkRoleRef.current === 'none') return;
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

  // --- Client: send input & apply state each frame ---
  useEffect(() => {
    if (!gameStarted || gameMode !== 'playing' || networkRoleRef.current !== 'client') return;
    const conn = clientRef.current;
    if (!conn) return;

    let animId: number;
    let inputTick = 0;

    // Track previous state for sound detection
    let prevBulletIds = new Set<number>();
    let prevEnemyCount = 0;
    let prevShieldedIds = new Set<number>();
    let prevRespawning = new Set<number>();
    let prevScores: number[] = [];

    const clientLoop = () => {
      // Send input at 20Hz
      if (inputTick % NET_SEND_INTERVAL === 0) {
        const keys = keysRef.current;
        const ctrl = CONTROLS[0]; // Client always uses P1 controls locally
        const js = joystickRef.current;
        const touchActive = js.active && Math.sqrt(js.dx * js.dx + js.dy * js.dy) > 15;
        const input: InputState = {
          left: ctrl.left.some(k => keys[k]),
          right: ctrl.right.some(k => keys[k]),
          thrust: ctrl.thrust.some(k => keys[k]) || touchActive,
          fire: ctrl.fire.some(k => keys[k]) || fireRef.current.active,
          // Send touch joystick angle so host can apply it
          touchAngle: touchActive ? Math.atan2(js.dy, js.dx) : undefined,
          touchMag: touchActive ? Math.min(Math.sqrt(js.dx * js.dx + js.dy * js.dy) / 80, 1) : undefined,
        };
        conn.sendInput(input);
      }
      inputTick++;

      // Apply interpolated state from host
      const state = conn.getInterpolatedState();
      if (state) {
        // Apply state to refs for rendering
        playersRef.current = state.players.map(p => ({ ...p } as Entity));
        deadPlayersRef.current = new Set(state.deadPlayers);
        enemiesRef.current = state.enemies.map(e => ({ ...e } as Entity));
        bulletsRef.current = state.bullets.map(b => ({ ...b } as Bullet));
        blackHoleRef.current = { ...state.blackHole };
        frameCountRef.current = state.frame;
        playerCountRef.current = state.players.length;

        // Apply floating texts from host
        if (state.floatingTexts) {
          floatingTextsRef.current = state.floatingTexts;
        }

        // Detect events for sound effects
        const currentBulletIds = new Set(state.bullets.map(b => b.id));
        const enemyCount = state.enemies.length;
        const nowRespawning = new Set(state.players.filter(p => p.respawnTimer && p.respawnTimer > 0).map(p => p.id));
        const nowShieldedIds = new Set(state.enemies.filter(e => e.isShielded).map(e => e.id));

        // New bullets appeared → distinguish player vs enemy shots
        for (const b of state.bullets) {
          if (!prevBulletIds.has(b.id)) {
            if (b.ownerId <= 0) playSound('shoot');
            else playSound('enemyShoot');
          }
        }

        // Enemy count decreased → could be score or despawn
        if (enemyCount < prevEnemyCount) {
          const scored = state.scores.some((s, i) => s > (prevScores[i] || 0));
          if (scored) {
            playSound('enemyAbsorbed');
            playSound('score');
          }
        }

        // Shield break detection
        for (const id of prevShieldedIds) {
          if (!nowShieldedIds.has(id)) playSound('shieldBreak');
        }

        // Player started respawning → death sound
        for (const id of nowRespawning) {
          if (!prevRespawning.has(id)) playSound('death');
        }

        // Player stopped respawning → spawn sound
        for (const id of prevRespawning) {
          if (!nowRespawning.has(id)) playSound('spawn');
        }

        // Update drone for client
        const alivePlayers = state.players.filter(p => !(p.respawnTimer && p.respawnTimer > 0));
        if (alivePlayers.length > 0) {
          let minDist = Infinity;
          for (const p of alivePlayers) {
            const dx = state.blackHole.x - p.x;
            const dy = state.blackHole.y - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) minDist = dist;
          }
          updateDrone(minDist);
        } else {
          updateDrone(Infinity);
        }

        prevBulletIds = currentBulletIds;
        prevEnemyCount = enemyCount;
        prevShieldedIds = nowShieldedIds;
        prevRespawning = nowRespawning;
        prevScores = [...state.scores];

        // Update React state for UI
        setScores(state.scores);
        setLivesArray(state.lives);
        if (state.gameOver) setGameOver(true);
        if (state.isPaused !== isPaused) setIsPaused(state.isPaused);
      }

      render();
      animId = requestAnimationFrame(clientLoop);
    };

    const render = buildRenderFn();
    animId = requestAnimationFrame(clientLoop);
    return () => cancelAnimationFrame(animId);
  }, [gameStarted, gameMode, isPaused]);

  // Build the render function (shared between host and client)
  const buildRenderFn = () => {
    return () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;

      const { scale, offsetX, offsetY } = viewportRef.current;

      // Clear full canvas (including letterbox bars)
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Begin world-space rendering
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);

      // World background
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, WORLD_W, WORLD_H);

      // Grid with distortion
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

      for (let y = 0; y <= WORLD_H; y += GRID_SIZE) {
        for (let x = 0; x < WORLD_W; x += GRID_SIZE) {
          drawGridLine({ x, y }, { x: x + GRID_SIZE, y });
        }
      }
      for (let x = 0; x <= WORLD_W; x += GRID_SIZE) {
        for (let y = 0; y < WORLD_H; y += GRID_SIZE) {
          drawGridLine({ x, y }, { x, y: y + GRID_SIZE });
        }
      }

      // Black Hole
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(bh.x, bh.y, BLACK_HOLE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ff00ff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Ships
      const drawShip = (e: Entity) => {
        ctx.save();
        ctx.translate(e.x, e.y);
        ctx.rotate(e.angle);
        if (e.isMoving) {
          ctx.fillStyle = '#ff8800';
          ctx.beginPath();
          ctx.moveTo(-SHIP_SIZE / 2, -SHIP_SIZE / 4);
          ctx.lineTo(-SHIP_SIZE - Math.random() * 10, 0);
          ctx.lineTo(-SHIP_SIZE / 2, SHIP_SIZE / 4);
          ctx.fill();
        }
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.moveTo(SHIP_SIZE / 2, 0);
        ctx.lineTo(-SHIP_SIZE / 2, -SHIP_SIZE / 2);
        ctx.lineTo(-SHIP_SIZE / 2, SHIP_SIZE / 2);
        ctx.closePath();
        ctx.fill();
        if (e.isShielded) {
          ctx.strokeStyle = '#00ffff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(0, 0, SHIP_SIZE * 0.8, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(0, 255, 255, 0.2)';
          ctx.fill();
        }
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.moveTo(SHIP_SIZE / 2, 0);
        ctx.lineTo(0, -SHIP_SIZE / 4);
        ctx.lineTo(0, SHIP_SIZE / 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      };

      const dead = deadPlayersRef.current;
      playersRef.current.forEach(p => {
        if (!dead.has(p.id) && !(p.respawnTimer && p.respawnTimer > 0)) drawShip(p);
      });
      enemiesRef.current.forEach(drawShip);

      // Respawn countdown text (in world space, centered)
      playersRef.current.forEach((p, idx) => {
        if (p.respawnTimer && p.respawnTimer > 0 && !dead.has(p.id)) {
          const secs = Math.ceil(p.respawnTimer / 60);
          ctx.save();
          ctx.fillStyle = p.color;
          ctx.globalAlpha = 0.7;
          ctx.font = 'bold 24px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`P${idx + 1} RESPAWN IN ${secs}`, WORLD_W / 2, 60 + idx * 30);
          ctx.restore();
        }
      });

      // Bullets
      bulletsRef.current.forEach((b) => {
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.angle);
        ctx.fillStyle = b.color;
        ctx.fillRect(-5, -1.5, 10, 3);
        ctx.shadowBlur = 10;
        ctx.shadowColor = b.color;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(-5, -1.5, 10, 3);
        ctx.restore();
      });

      // Floating score texts
      floatingTextsRef.current.forEach(ft => {
        const alpha = ft.life / 60;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = ft.color;
        ctx.font = `bold ${24 + (1 - alpha) * 12}px monospace`;
        ctx.textAlign = 'center';
        ctx.shadowColor = ft.color;
        ctx.shadowBlur = 10;
        ctx.fillText(ft.text, ft.x, ft.y);
        ctx.shadowBlur = 0;
      });
      ctx.globalAlpha = 1;

      // End world-space rendering
      ctx.restore();

      // --- Screen-space overlays (touch controls) ---
      // Touch Controls (show when mobile and not 2-player local)
      if (isMobile.current && !(playerCountRef.current > 1 && networkRoleRef.current === 'none')) {
        ctx.save();
        ctx.globalAlpha = 0.25;
        const jsBaseX = 120;
        const jsBaseY = canvas.height - 140;
        const jsRadius = 60;
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(jsBaseX, jsBaseY, jsRadius, 0, Math.PI * 2);
        ctx.stroke();
        const js = joystickRef.current;
        let thumbX = jsBaseX, thumbY = jsBaseY;
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
  };

  // --- Host / Local Game Loop ---
  useEffect(() => {
    if (!gameStarted || gameOver || isPaused) return;
    if (networkRoleRef.current === 'client') return; // clients don't run tick

    let animationFrameId: number;
    let lastTime = performance.now();
    let accumulator = 0;
    const TICK_RATE = 1000 / 60;

    const update = (now: number = performance.now()) => {
      const canvas = canvasRef.current;
      if (!canvas || isPaused) return;

      const elapsed = Math.min(now - lastTime, 100);
      lastTime = now;
      accumulator += elapsed;

      while (accumulator >= TICK_RATE) {
        accumulator -= TICK_RATE;
        tick(canvas);
      }

      render();
      animationFrameId = requestAnimationFrame(update);
    };

    const processPlayerInput = (player: Entity, idx: number, keys: Record<string, boolean>) => {
      const dead = deadPlayersRef.current;
      if (dead.has(player.id)) return;
      if (player.respawnTimer && player.respawnTimer > 0) return; // waiting to respawn

      // Check if this player is local (has keyboard controls)
      const ctrl = CONTROLS[idx];
      const isLocalPlayer = !!ctrl && (networkRoleRef.current === 'none' || idx < localPlayerCount);

      if (isLocalPlayer) {
        // Keyboard input
        if (ctrl.left.some(k => keys[k])) player.angle -= PLAYER_ROT_SPEED;
        if (ctrl.right.some(k => keys[k])) player.angle += PLAYER_ROT_SPEED;
        player.isMoving = ctrl.thrust.some(k => keys[k]);
        if (player.isMoving) {
          player.vx += Math.cos(player.angle) * PLAYER_ACCEL;
          player.vy += Math.sin(player.angle) * PLAYER_ACCEL;
        }

        // Touch joystick (local P1 only — works in single-player, network client, or 1-local-player host)
        if (idx === 0 && (playerCountRef.current === 1 || networkRoleRef.current === 'client' || (networkRoleRef.current === 'host' && localPlayerCount === 1))) {
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

        // Fire
        const touchFire = idx === 0 && (playerCountRef.current === 1 || networkRoleRef.current === 'client' || (networkRoleRef.current === 'host' && localPlayerCount === 1)) && fireRef.current.active;
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
      } else if (networkRoleRef.current === 'host') {
        // Remote player — get input from network
        const remoteInput = hostRef.current?.getRemoteInputs().get(player.id);
        if (remoteInput) {
          // Touch joystick from remote player
          if (remoteInput.touchAngle !== undefined && remoteInput.touchMag !== undefined) {
            let angleDiff = remoteInput.touchAngle - player.angle;
            while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
            while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
            player.angle += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), PLAYER_ROT_SPEED * 2);
            const thrust = remoteInput.touchMag * PLAYER_ACCEL;
            player.vx += Math.cos(player.angle) * thrust;
            player.vy += Math.sin(player.angle) * thrust;
            player.isMoving = true;
          } else {
            // Keyboard input from remote player
            if (remoteInput.left) player.angle -= PLAYER_ROT_SPEED;
            if (remoteInput.right) player.angle += PLAYER_ROT_SPEED;
            player.isMoving = remoteInput.thrust;
            if (player.isMoving) {
              player.vx += Math.cos(player.angle) * PLAYER_ACCEL;
              player.vy += Math.sin(player.angle) * PLAYER_ACCEL;
            }
          }
          if (remoteInput.fire && frameCountRef.current - (player.lastShot || 0) >= PLAYER_FIRE_RATE) {
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
        }
      }
    };

    const tick = (canvas: HTMLCanvasElement) => {
      const players = playersRef.current;
      const keys = keysRef.current;
      const bh = blackHoleRef.current;
      const dead = deadPlayersRef.current;

      // 0. Update Black Hole
      bh.x += bh.vx;
      bh.y += bh.vy;
      if (bh.x < BLACK_HOLE_RADIUS || bh.x > WORLD_W - BLACK_HOLE_RADIUS) bh.vx *= -1;
      if (bh.y < BLACK_HOLE_RADIUS || bh.y > WORLD_H - BLACK_HOLE_RADIUS) bh.vy *= -1;

      // 1. Player Input
      players.forEach((player, idx) => processPlayerInput(player, idx, keys));

      // 2. Respawn timer countdown
      players.forEach((p, idx) => {
        if (p.respawnTimer && p.respawnTimer > 0) {
          p.respawnTimer--;
          if (p.respawnTimer <= 0) {
            // Actually respawn now
            const [sx, sy] = getSpawnPos(idx, blackHoleRef.current);
            p.x = sx; p.y = sy;
            p.vx = 0; p.vy = 0;
            p.angle = -Math.PI / 2;
            p.respawnTimer = 0;
            playSound('spawn');
          }
        }
      });

      // 3. Physics & Gravity
      const alivePlayers = players.filter(p => !dead.has(p.id) && !(p.respawnTimer && p.respawnTimer > 0));
      const entities = [...alivePlayers, ...enemiesRef.current];

      entities.forEach((e) => {
        const dx = bh.x - e.x;
        const dy = bh.y - e.y;
        const distSq = dx * dx + dy * dy;
        const dist = Math.sqrt(distSq);
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

        // Bounce off edges
        if (e.x < SHIP_SIZE / 2) { e.x = SHIP_SIZE / 2; e.vx *= -1; }
        if (e.x > WORLD_W - SHIP_SIZE / 2) { e.x = WORLD_W - SHIP_SIZE / 2; e.vx *= -1; }
        if (e.y < SHIP_SIZE / 2) { e.y = SHIP_SIZE / 2; e.vy *= -1; }
        if (e.y > WORLD_H - SHIP_SIZE / 2) { e.y = WORLD_H - SHIP_SIZE / 2; e.vy *= -1; }

        // Black hole collision
        if (dist < BLACK_HOLE_RADIUS) {
          const playerIdx = players.findIndex(p => p.id === e.id);
          if (playerIdx >= 0) {
            respawnPlayer(playerIdx);
          } else if (!e.isShielded) {
            const lastHitter = (e as Entity).lastHitBy;
            if (lastHitter !== undefined) {
              const hitterIdx = players.findIndex(p => p.id === lastHitter);
              if (hitterIdx >= 0) {
                setScores((prev) => {
                  const next = [...prev];
                  next[hitterIdx] = (next[hitterIdx] || 0) + 100;
                  scoresRef.current = next; // sync ref immediately for broadcast
                  return next;
                });
                floatingTextsRef.current.push({
                  x: bh.x, y: bh.y - 30,
                  text: '+100',
                  color: PLAYER_COLORS[hitterIdx],
                  life: 60,
                });
              }
            }
            enemiesRef.current = enemiesRef.current.filter((en) => en.id !== e.id);
            playSound('enemyAbsorbed');
            playSound('score');
          }
        }

        if (e.isShielded && dist > BLACK_HOLE_RADIUS * 4.5) {
          e.isShielded = false;
          playSound('shieldBreak');
        }
      });

      // 3. Bullets
      bulletsRef.current.forEach((b) => {
        b.x += b.vx;
        b.y += b.vy;
        b.life--;
        if (b.x < 0 || b.x > WORLD_W) { b.vx *= -1; b.angle = Math.atan2(b.vy, b.vx); }
        if (b.y < 0 || b.y > WORLD_H) { b.vy *= -1; b.angle = Math.atan2(b.vy, b.vx); }
        const dx = bh.x - b.x;
        const dy = bh.y - b.y;
        const distSq = dx * dx + dy * dy;
        const dist = Math.sqrt(distSq);
        const force = (GRAVITY_STRENGTH * 0.5) / (distSq + 1000);
        b.vx += (dx / dist) * force;
        b.vy += (dy / dist) * force;

        const isPlayerBullet = PLAYER_IDS.has(b.ownerId);
        if (isPlayerBullet) {
          // Player bullets hit enemies
          enemiesRef.current.forEach((en) => {
            if (en.isShielded) return;
            const edx = en.x - b.x;
            const edy = en.y - b.y;
            const edist = Math.sqrt(edx * edx + edy * edy);
            if (edist < SHIP_SIZE) {
              en.vx += b.vx * 0.8;
              en.vy += b.vy * 0.8;
              en.lastHitBy = b.ownerId;
              playSound('hit');
              b.life = 0;
            }
          });
          // Player bullets also hit other players
          if (b.life > 0) {
            for (const player of alivePlayers) {
              if (player.id === b.ownerId) continue; // don't hit yourself
              if (player.respawnTimer && player.respawnTimer > 0) continue; // don't hit respawning players
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
        } else {
          // Enemy bullets hit players
          for (const player of alivePlayers) {
            if (player.respawnTimer && player.respawnTimer > 0) continue; // don't hit respawning players
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
          x: bh.x, y: bh.y,
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
          en.isMoving = true;
          en.vx += Math.cos(en.angle) * 0.25;
          en.vy += Math.sin(en.angle) * 0.25;
          return;
        }

        // Find nearest alive player
        let target = alivePlayers[0];
        if (!target) return;
        let minDist = Infinity;
        alivePlayers.forEach(p => {
          const d = Math.hypot(p.x - en.x, p.y - en.y);
          if (d < minDist) { minDist = d; target = p; }
        });

        const pdx = target.x - en.x;
        const pdy = target.y - en.y;
        const bhdx = bh.x - en.x;
        const bhdy = bh.y - en.y;
        const bhdist = Math.sqrt(bhdx * bhdx + bhdy * bhdy);
        const pbhdx = bh.x - target.x;
        const pbhdy = bh.y - target.y;
        const pbhdist = Math.sqrt(pbhdx * pbhdx + pbhdy * pbhdy);

        const fuel = en.fuel ?? 0;
        const FUEL_MAX = 150;
        const FUEL_RECHARGE = 0.2;
        const BH_DANGER_ZONE = BLACK_HOLE_RADIUS * 6;
        const BH_FLEE_ZONE = BLACK_HOLE_RADIUS * 4;

        let fuelUsed = 0;
        let desiredAngle = en.angle;
        let wantsBoost = false;
        let boostStrength = 0;

        if (bhdist < BH_FLEE_ZONE && fuel > 5) {
          desiredAngle = Math.atan2(-bhdy, -bhdx);
          wantsBoost = true; boostStrength = 0.2; fuelUsed = 3;
        } else if (bhdist < BH_DANGER_ZONE && fuel > 2) {
          desiredAngle = Math.atan2(-bhdy, -bhdx);
          wantsBoost = true; boostStrength = 0.08; fuelUsed = 1;
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
            wantsBoost = true; boostStrength = 0.18; fuelUsed = 1.5;
          } else if (Math.random() < 0.01 && fuel > 1) {
            desiredAngle = Math.atan2(pdy, pdx);
            wantsBoost = true; boostStrength = 0.15; fuelUsed = 1;
          } else {
            desiredAngle = Math.atan2(pdy, pdx);
          }
        }

        const ENEMY_ROT_SPEED = 0.05;
        let angleDiff = desiredAngle - en.angle;
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
        en.angle += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), ENEMY_ROT_SPEED);

        if (wantsBoost && Math.abs(angleDiff) < Math.PI / 4) {
          en.vx += Math.cos(en.angle) * boostStrength;
          en.vy += Math.sin(en.angle) * boostStrength;
          en.isMoving = true;
        } else if (wantsBoost) {
          fuelUsed = 0; en.isMoving = false;
        } else {
          en.isMoving = false;
        }
        en.fuel = Math.min(FUEL_MAX, fuel - fuelUsed + FUEL_RECHARGE);

        // Enemy shooting
        if (!en.isShielded && frameCountRef.current - (en.lastShot || 0) >= ENEMY_FIRE_RATE) {
          const angleToPlayer = Math.atan2(pdy, pdx);
          const anglePlayerToBH = Math.atan2(pbhdy, pbhdx);
          let aDiff = Math.abs(angleToPlayer - anglePlayerToBH);
          if (aDiff > Math.PI) aDiff = 2 * Math.PI - aDiff;
          const fireThreshold = aDiff < Math.PI / 2 ? ENEMY_FIRE_RATE : ENEMY_FIRE_RATE * 1.5;
          if (frameCountRef.current - (en.lastShot || 0) >= fireThreshold) {
            en.lastShot = frameCountRef.current;
            playSound('enemyShoot');
            bulletsRef.current.push({
              id: nextIdRef.current++,
              x: en.x + Math.cos(en.angle) * SHIP_SIZE,
              y: en.y + Math.sin(en.angle) * SHIP_SIZE,
              vx: Math.cos(en.angle) * (BULLET_SPEED * 0.7),
              vy: Math.sin(en.angle) * (BULLET_SPEED * 0.7),
              angle: en.angle, color: en.color,
              life: BULLET_LIFETIME * 1.5,
              ownerId: en.id,
            });
          }
        }
      });

      frameCountRef.current++;

      // Update black hole drone based on nearest alive player distance
      if (alivePlayers.length > 0) {
        let minDist = Infinity;
        for (const p of alivePlayers) {
          const dx = bh.x - p.x;
          const dy = bh.y - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < minDist) minDist = dist;
        }
        updateDrone(minDist);
      } else {
        updateDrone(Infinity);
      }

      // Update floating texts
      floatingTextsRef.current = floatingTextsRef.current
        .map(ft => ({ ...ft, life: ft.life - 1, y: ft.y - 1 }))
        .filter(ft => ft.life > 0);

      // Broadcast state to clients at 20Hz (or immediately on game over)
      const isGameOver = gameOverRef.current;
      if (networkRoleRef.current === 'host' && (frameCountRef.current % NET_SEND_INTERVAL === 0 || isGameOver)) {
        const state: GameStateMsg = {
          type: 'state',
          frame: frameCountRef.current,
          players: playersRef.current.map(serializeEntity),
          deadPlayers: Array.from(deadPlayersRef.current),
          enemies: enemiesRef.current.map(serializeEntity),
          bullets: bulletsRef.current.map(serializeBullet),
          blackHole: { x: bh.x, y: bh.y, vx: bh.vx, vy: bh.vy },
          scores: scoresRef.current,
          lives: livesRef.current,
          gameOver: gameOverRef.current,
          isPaused,
          floatingTexts: floatingTextsRef.current,
        };
        hostRef.current?.broadcastState(state);
      }
    };

    const render = buildRenderFn();

    animationFrameId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animationFrameId);
  }, [gameStarted, gameOver, isPaused]);

  // Determine winner for game over
  const getWinner = () => {
    if (playerCount <= 1) return null;
    const maxScore = Math.max(...scores);
    const winners = scores.map((s, i) => s === maxScore ? i : -1).filter(i => i >= 0);
    if (winners.length === 1) return `PLAYER ${winners[0] + 1} WINS!`;
    return 'TIE GAME!';
  };

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden font-mono text-white select-none">
      <canvas ref={canvasRef} className="block w-full h-full" />

      {/* HUD */}
      {gameStarted && (
        <div className="absolute top-4 left-4 flex flex-col gap-1">
          <div className="text-2xl tracking-widest text-[#00ff00]">GRAVITY GRID</div>
          {playerCount === 1 ? (
            <div className="flex gap-8">
              <div className="text-xl">SCORE: {(scores[0] || 0).toString().padStart(6, '0')}</div>
              <div className="text-xl text-red-500">LIVES: {'❤'.repeat(livesArray[0] || 0)}</div>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {playersRef.current.map((p, i) => (
                <div key={p.id} className="flex gap-6">
                  <div className="text-lg" style={{ color: PLAYER_COLORS[i] }}>
                    P{i + 1}: {(scores[i] || 0).toString().padStart(6, '0')}
                  </div>
                  <div className="text-lg text-red-500">{'❤'.repeat(livesArray[i] || 0)}</div>
                </div>
              ))}
            </div>
          )}
          {networkRole !== 'none' && (
            <div className="text-xs text-gray-500 mt-1">
              {networkRole === 'host' ? `HOSTING: ${roomCode}` : `CONNECTED`}
            </div>
          )}
        </div>
      )}

      {/* Main Menu */}
      {gameMode === 'menu' && !gameStarted && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10">
          <h1 className="text-6xl mb-8 text-[#00ff00] animate-pulse">GRAVITY GRID</h1>
          <div className="text-center mb-8 space-y-2 text-gray-400">
            <p className="text-[#00ff00]">P1: W/A/S/D or ARROWS to Move, SPACE to Shoot</p>
            <p className="text-[#00aaff]">P2: I/J/K/L to Move, ENTER to Shoot</p>
            <p className="mt-4">Push enemies into the Black Hole</p>
            <p>Bullets don't kill, they PUSH</p>
            <p className="text-yellow-400 text-sm mt-2">Last player to hit an enemy before it's sucked in scores the points!</p>
          </div>
          <div className="flex flex-col gap-4 items-center">
            <p className="text-gray-500 text-sm mb-1">LOCAL</p>
            <div className="flex gap-4">
              <button
                onClick={() => { setPlayerCount(1); resetGame(1); initAudio(); setGameStarted(true); setGameMode('playing'); setNetworkRole('none'); networkRoleRef.current = 'none'; }}
                className="px-6 py-3 border-4 border-[#00ff00] text-[#00ff00] text-xl hover:bg-[#00ff00] hover:text-black transition-colors"
              >
                1 PLAYER
              </button>
              <button
                onClick={() => { setPlayerCount(2); resetGame(2); initAudio(); setGameStarted(true); setGameMode('playing'); setNetworkRole('none'); networkRoleRef.current = 'none'; }}
                className="px-6 py-3 border-4 border-[#00aaff] text-[#00aaff] text-xl hover:bg-[#00aaff] hover:text-black transition-colors"
              >
                2 PLAYERS
              </button>
            </div>
            <p className="text-gray-500 text-sm mt-4 mb-1">MULTIPLAYER</p>
            <div className="flex gap-4">
              <button
                onClick={() => hostGame(1)}
                className="px-6 py-3 border-4 border-[#ff8800] text-[#ff8800] text-xl hover:bg-[#ff8800] hover:text-black transition-colors"
              >
                HOST GAME
              </button>
              <button
                onClick={browseGames}
                className="px-6 py-3 border-4 border-[#aa44ff] text-[#aa44ff] text-xl hover:bg-[#aa44ff] hover:text-black transition-colors"
              >
                JOIN GAME
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Host Lobby */}
      {gameMode === 'lobby_host' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10">
          <h2 className="text-4xl mb-6 text-[#ff8800]">HOSTING GAME</h2>
          {roomCode ? (
            <>
              <div className="text-6xl mb-8 font-bold tracking-[0.3em] text-white">{roomCode}</div>
              <p className="text-gray-400 mb-2">Share this code with other players</p>
              <p className="text-xl mb-8 text-[#00ff00]">{lobbyPlayerCount} player{lobbyPlayerCount !== 1 ? 's' : ''} connected</p>
              <div className="flex gap-4">
                <button
                  onClick={startHostedGame}
                  disabled={lobbyPlayerCount < 2}
                  className={`px-8 py-4 border-4 text-2xl transition-colors ${
                    lobbyPlayerCount >= 2
                      ? 'border-[#00ff00] text-[#00ff00] hover:bg-[#00ff00] hover:text-black'
                      : 'border-gray-600 text-gray-600 cursor-not-allowed'
                  }`}
                >
                  START GAME
                </button>
                <button onClick={backToMenu} className="px-8 py-4 border-4 border-red-500 text-red-500 text-2xl hover:bg-red-500 hover:text-black transition-colors">
                  CANCEL
                </button>
              </div>
            </>
          ) : !networkError ? (
            <>
              <p className="text-xl text-gray-400 mb-6">Connecting to server...</p>
              <button onClick={backToMenu} className="px-8 py-4 border-4 border-red-500 text-red-500 text-2xl hover:bg-red-500 hover:text-black transition-colors">
                CANCEL
              </button>
            </>
          ) : (
            <>
              <button onClick={backToMenu} className="px-8 py-4 border-4 border-red-500 text-red-500 text-2xl hover:bg-red-500 hover:text-black transition-colors">
                BACK
              </button>
            </>
          )}
          {networkError && <p className="mt-4 text-red-500">{networkError}</p>}
        </div>
      )}

      {/* Join Lobby — Browse available games */}
      {gameMode === 'lobby_client' && !gameStarted && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10">
          <h2 className="text-4xl mb-6 text-[#aa44ff]">JOIN GAME</h2>
          {!clientRef.current ? (
            <>
              {loadingRooms ? (
                <p className="text-xl text-gray-400 mb-6">Searching for games...</p>
              ) : availableRooms.length > 0 ? (
                <div className="flex flex-col gap-3 mb-6 max-h-64 overflow-y-auto">
                  {availableRooms.map((room) => (
                    <button
                      key={room.code}
                      onClick={() => joinGame(room.code)}
                      className="px-8 py-3 border-2 border-[#aa44ff] text-[#aa44ff] text-xl hover:bg-[#aa44ff] hover:text-black transition-colors flex justify-between gap-8"
                    >
                      <span>ROOM {room.code}</span>
                      <span className="text-gray-400">{room.players}/{room.maxPlayers} players</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xl text-gray-500 mb-6">No games found</p>
              )}
              <div className="flex gap-4">
                <button
                  onClick={browseGames}
                  className="px-6 py-3 border-4 border-[#aa44ff] text-[#aa44ff] text-xl hover:bg-[#aa44ff] hover:text-black transition-colors"
                >
                  REFRESH
                </button>
                <button onClick={backToMenu} className="px-6 py-3 border-4 border-red-500 text-red-500 text-xl hover:bg-red-500 hover:text-black transition-colors">
                  BACK
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xl text-gray-400 mb-4">Connected! Waiting for host to start...</p>
              <button onClick={backToMenu} className="px-6 py-3 border-4 border-red-500 text-red-500 text-xl hover:bg-red-500 hover:text-black transition-colors">
                LEAVE
              </button>
            </>
          )}
          {networkError && <p className="mt-4 text-red-500">{networkError}</p>}
        </div>
      )}

      {/* Pause */}
      {isPaused && networkRoleRef.current !== 'client' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm z-30">
          <h2 className="text-6xl mb-8 text-[#00ff00]">PAUSED</h2>
          <div className="flex flex-col gap-4">
            <button onClick={() => setIsPaused(false)} className="px-8 py-4 border-4 border-[#00ff00] text-[#00ff00] text-2xl hover:bg-[#00ff00] hover:text-black transition-colors">
              RESUME
            </button>
            <button
              onClick={() => { resetGame(playerCount); backToMenu(); }}
              className="px-8 py-4 border-4 border-red-500 text-red-500 text-2xl hover:bg-red-500 hover:text-black transition-colors"
            >
              QUIT TO MENU
            </button>
          </div>
          <div className="mt-8 text-gray-400">Press ESC to Resume</div>
        </div>
      )}

      {/* Game Over */}
      {gameOver && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-900/40 backdrop-blur-sm z-20">
          <h2 className="text-8xl mb-4 text-white font-bold">GAME OVER</h2>
          {playerCount === 1 ? (
            <div className="text-4xl mb-8">FINAL SCORE: {scores[0] || 0}</div>
          ) : (
            <div className="text-center mb-8 space-y-2">
              {scores.map((s, i) => (
                <div key={i} className="text-3xl" style={{ color: PLAYER_COLORS[i] }}>
                  P{i + 1}: {s}
                </div>
              ))}
              <div className="text-4xl mt-4 text-yellow-400">{getWinner()}</div>
            </div>
          )}
          {networkError && <p className="text-red-500 mb-4">{networkError}</p>}
          <button
            onClick={() => { backToMenu(); }}
            className="px-8 py-4 border-4 border-white text-white text-2xl hover:bg-white hover:text-red-900 transition-colors"
          >
            BACK TO MENU
          </button>
        </div>
      )}

      <div className="absolute bottom-4 right-4 text-xs text-gray-500">
        8-BIT KINETIC SHOOTER V2.0
      </div>
    </div>
  );
}
