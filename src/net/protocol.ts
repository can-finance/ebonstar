// Player IDs for up to 4 players
export const PLAYER_ID_LIST = [0, -1, -2, -3];

export interface SerializedEntity {
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
  respawnTimer?: number;
  enemyType?: string;
}

export interface SerializedFloatingText {
  x: number; y: number;
  text: string;
  color: string;
  life: number;
}

export interface SerializedBullet extends SerializedEntity {
  life: number;
  ownerId: number;
}

// Host → Clients
export interface GameStateMsg {
  type: 'state';
  frame: number;
  players: SerializedEntity[];
  deadPlayers: number[];
  enemies: SerializedEntity[];
  bullets: SerializedBullet[];
  blackHole: { x: number; y: number; vx: number; vy: number; radius: number };
  scores: number[];
  lives: number[];
  gameOver: boolean;
  isPaused: boolean;
  floatingTexts?: SerializedFloatingText[];
}

export interface GameStartMsg {
  type: 'game_start';
  playerCount: number;
}

// Client → Host
export interface InputMsg {
  type: 'input';
  playerId: number;
  keys: InputState;
}

export interface InputState {
  left: boolean;
  right: boolean;
  thrust: boolean;
  fire: boolean;
  touchAngle?: number;
  touchMag?: number;
}

// Relay messages
export interface JoinMsg {
  type: 'join';
  room: string;
  asHost?: boolean;
}

export interface AssignMsg {
  type: 'assign';
  playerId: number;
  playerIndex: number;
  isHost: boolean;
}

export interface PlayerJoinedMsg {
  type: 'player_joined';
  count: number;
  playerId: number;
}

export interface PlayerLeftMsg {
  type: 'player_left';
  playerId: number;
}

export interface RoomFullMsg {
  type: 'room_full';
}

export interface ErrorMsg {
  type: 'error';
  message: string;
}

export interface ListRoomsMsg {
  type: 'list_rooms';
}

export interface RoomListMsg {
  type: 'room_list';
  rooms: { code: string; players: number; maxPlayers: number }[];
}

export type ServerMessage = AssignMsg | PlayerJoinedMsg | PlayerLeftMsg | RoomFullMsg | ErrorMsg | GameStateMsg | GameStartMsg | InputMsg | RoomListMsg;
export type ClientMessage = JoinMsg | InputMsg | GameStateMsg | GameStartMsg | ListRoomsMsg;

// Round floats for compact serialization
function r(n: number): number {
  return Math.round(n * 10) / 10;
}

export function serializeEntity(e: SerializedEntity): SerializedEntity {
  const s: SerializedEntity = {
    id: e.id, x: r(e.x), y: r(e.y),
    vx: r(e.vx), vy: r(e.vy),
    angle: r(e.angle), color: e.color,
  };
  if (e.isMoving) s.isMoving = true;
  if (e.lastShot) s.lastShot = e.lastShot;
  if (e.isShielded) s.isShielded = true;
  if (e.fuel !== undefined) s.fuel = r(e.fuel);
  if (e.lastHitBy !== undefined) s.lastHitBy = e.lastHitBy;
  if (e.respawnTimer) s.respawnTimer = e.respawnTimer;
  if (e.enemyType) s.enemyType = e.enemyType;
  return s;
}

export function serializeBullet(b: SerializedBullet): SerializedBullet {
  return {
    ...serializeEntity(b),
    life: r(b.life),
    ownerId: b.ownerId,
  };
}
