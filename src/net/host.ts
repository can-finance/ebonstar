import type { InputState, GameStateMsg, ServerMessage, GameStartMsg } from './protocol';

export class HostConnection {
  private ws: WebSocket | null = null;
  private remoteInputs = new Map<number, InputState>();
  private roomCode: string;
  private connected = false;
  private pendingError: string | null = null;

  onPlayerJoined: ((count: number, playerId: number) => void) | null = null;
  onPlayerLeft: ((playerId: number) => void) | null = null;
  private _onError: ((msg: string) => void) | null = null;

  set onError(handler: ((msg: string) => void) | null) {
    this._onError = handler;
    // Flush any error that arrived before the handler was set
    if (handler && this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      handler(err);
    }
  }

  private emitError(msg: string) {
    if (this._onError) {
      this._onError(msg);
    } else {
      this.pendingError = msg;
    }
  }

  constructor(serverUrl: string, roomCode: string) {
    this.roomCode = roomCode;
    this.ws = new WebSocket(serverUrl);

    // Timeout — if no assign message within 3s, relay is not reachable
    let gotAssign = false;
    const timeout = setTimeout(() => {
      if (!gotAssign) {
        this.connected = false;
        this.ws?.close();
        this.emitError('Relay server not responding');
      }
    }, 3000);

    this.ws.onopen = () => {
      this.connected = true;
      this.ws!.send(JSON.stringify({ type: 'join', room: roomCode, asHost: true }));
    };

    this.ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data as string);

      if (msg.type === 'assign') {
        gotAssign = true;
        clearTimeout(timeout);
      } else if (msg.type === 'input') {
        this.remoteInputs.set(msg.playerId, msg.keys);
      } else if (msg.type === 'player_joined') {
        this.onPlayerJoined?.(msg.count, msg.playerId);
      } else if (msg.type === 'player_left') {
        this.remoteInputs.delete(msg.playerId);
        this.onPlayerLeft?.(msg.playerId);
      } else if (msg.type === 'error') {
        this.emitError(msg.message);
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      if (!gotAssign) {
        clearTimeout(timeout);
        this.emitError('Connection lost');
      }
    };

    this.ws.onerror = () => {
      this.connected = false;
      clearTimeout(timeout);
      this.emitError('Connection failed');
    };
  }

  getRemoteInputs(): Map<number, InputState> {
    return this.remoteInputs;
  }

  broadcastState(state: GameStateMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(state));
    }
  }

  sendGameStart(playerCount: number) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg: GameStartMsg = { type: 'game_start', playerCount };
      this.ws.send(JSON.stringify(msg));
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getRoomCode(): string {
    return this.roomCode;
  }

  close() {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }
}
