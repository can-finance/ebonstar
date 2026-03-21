import type { InputState, GameStateMsg, ServerMessage } from './protocol';

export class ClientConnection {
  private ws: WebSocket | null = null;
  private connected = false;
  private _playerId: number | null = null;
  private _playerIndex: number | null = null;

  // Interpolation: buffer two most recent states
  private prevState: GameStateMsg | null = null;
  private currState: GameStateMsg | null = null;
  private stateTimestamp = 0;
  private prevTimestamp = 0;

  onAssigned: ((playerId: number, playerIndex: number) => void) | null = null;
  onGameStart: ((playerCount: number) => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  onDisconnect: (() => void) | null = null;

  constructor(serverUrl: string, roomCode: string) {
    this.ws = new WebSocket(serverUrl);

    this.ws.onopen = () => {
      this.connected = true;
      this.ws!.send(JSON.stringify({ type: 'join', room: roomCode, asHost: false }));
    };

    this.ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data as string);

      if (msg.type === 'assign') {
        this._playerId = msg.playerId;
        this._playerIndex = msg.playerIndex;
        this.onAssigned?.(msg.playerId, msg.playerIndex);
      } else if (msg.type === 'state') {
        this.prevState = this.currState;
        this.prevTimestamp = this.stateTimestamp;
        this.currState = msg;
        this.stateTimestamp = performance.now();
      } else if (msg.type === 'game_start') {
        this.onGameStart?.(msg.playerCount);
      } else if (msg.type === 'error') {
        this.onError?.(msg.message);
      } else if (msg.type === 'room_full') {
        this.onError?.('Room is full');
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.onDisconnect?.();
    };

    this.ws.onerror = () => {
      this.connected = false;
      this.onError?.('Connection failed');
    };
  }

  sendInput(keys: InputState) {
    if (this.ws?.readyState === WebSocket.OPEN && this._playerId !== null) {
      this.ws.send(JSON.stringify({
        type: 'input',
        playerId: this._playerId,
        keys,
      }));
    }
  }

  // Get interpolated state for smooth rendering
  getInterpolatedState(): GameStateMsg | null {
    if (!this.currState) return null;
    if (!this.prevState) return this.currState;

    const now = performance.now();
    const interval = this.stateTimestamp - this.prevTimestamp;
    if (interval <= 0) return this.currState;

    const elapsed = now - this.stateTimestamp;
    const t = Math.min(elapsed / interval, 1.0); // 0 to 1, can extrapolate slightly

    // Lerp positions and angles for smooth rendering
    const lerp = (a: number, b: number) => a + (b - a) * t;
    const lerpAngle = (a: number, b: number) => {
      let diff = b - a;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      return a + diff * t;
    };

    const lerpEntities = (prev: any[], curr: any[]) => {
      return curr.map(c => {
        const p = prev.find(e => e.id === c.id);
        if (!p) return c;
        return {
          ...c,
          x: lerp(p.x, c.x),
          y: lerp(p.y, c.y),
          angle: lerpAngle(p.angle, c.angle),
        };
      });
    };

    return {
      ...this.currState,
      players: lerpEntities(this.prevState.players, this.currState.players),
      enemies: lerpEntities(this.prevState.enemies, this.currState.enemies),
      bullets: lerpEntities(this.prevState.bullets, this.currState.bullets),
      blackHole: {
        x: lerp(this.prevState.blackHole.x, this.currState.blackHole.x),
        y: lerp(this.prevState.blackHole.y, this.currState.blackHole.y),
        vx: this.currState.blackHole.vx,
        vy: this.currState.blackHole.vy,
      },
    };
  }

  get playerId(): number | null { return this._playerId; }
  get playerIndex(): number | null { return this._playerIndex; }
  isConnected(): boolean { return this.connected; }

  close() {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }
}
