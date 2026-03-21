const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.PORT || '3001', 10);
const MAX_PLAYERS = 4;
const PLAYER_ID_LIST = [0, -1, -2, -3];

const rooms = new Map();
const socketToRoom = new Map();

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToRoom(room, msg, excludeWs) {
  const data = JSON.stringify(msg);
  if (room.host && room.host !== excludeWs && room.host.readyState === WebSocket.OPEN) {
    room.host.send(data);
  }
  for (const [, ws] of room.clients) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function getRoomPlayerCount(room) {
  return (room.host ? 1 : 0) + room.clients.size;
}

function removeFromRoom(ws) {
  const info = socketToRoom.get(ws);
  if (!info) return;

  const room = rooms.get(info.room);
  socketToRoom.delete(ws);
  if (!room) return;

  if (info.isHost) {
    room.host = null;
    console.log(`[RELAY] Host left room ${info.room} — closing room (${room.clients.size} clients disconnected)`);
    broadcastToRoom(room, { type: 'error', message: 'Host disconnected' });
    for (const [, clientWs] of room.clients) {
      clientWs.close();
    }
    rooms.delete(info.room);
    console.log(`[RELAY] Room ${info.room} destroyed (${rooms.size} active rooms)`);
  } else {
    room.clients.delete(info.playerId);
    console.log(`[RELAY] Player (id=${info.playerId}) left room ${info.room} (${getRoomPlayerCount(room)}/${MAX_PLAYERS} players remaining)`);
    broadcastToRoom(room, { type: 'player_left', playerId: info.playerId });
  }

  if (room && getRoomPlayerCount(room) === 0) {
    rooms.delete(info.room);
    console.log(`[RELAY] Room ${info.room} empty — cleaned up (${rooms.size} active rooms)`);
  }
}

// HTTP server for health checks (Render pings this)
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log(`[RELAY] New WebSocket connection`);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'list_rooms') {
      const available = [];
      for (const [code, room] of rooms) {
        if (room.host && getRoomPlayerCount(room) < MAX_PLAYERS) {
          available.push({ code, players: getRoomPlayerCount(room), maxPlayers: MAX_PLAYERS });
        }
      }
      send(ws, { type: 'room_list', rooms: available });
      console.log(`[RELAY] Room list requested — ${available.length} available rooms`);
      return;
    }

    if (msg.type === 'join') {
      const code = msg.room;
      const asHost = msg.asHost;

      if (asHost) {
        if (rooms.has(code)) {
          console.log(`[RELAY] Room creation failed — code ${code} already exists`);
          send(ws, { type: 'error', message: 'Room already exists' });
          return;
        }
        const room = { code, host: ws, clients: new Map(), nextPlayerIdx: 1 };
        rooms.set(code, room);
        socketToRoom.set(ws, { room: code, playerId: PLAYER_ID_LIST[0], isHost: true });
        send(ws, { type: 'assign', playerId: PLAYER_ID_LIST[0], playerIndex: 0, isHost: true });
        console.log(`[RELAY] Room ${code} created by host (${rooms.size} active rooms)`);
      } else {
        const room = rooms.get(code);
        if (!room) {
          console.log(`[RELAY] Join failed — room ${code} not found`);
          send(ws, { type: 'error', message: 'Room not found' });
          return;
        }
        if (getRoomPlayerCount(room) >= MAX_PLAYERS) {
          console.log(`[RELAY] Join failed — room ${code} is full (${MAX_PLAYERS}/${MAX_PLAYERS})`);
          send(ws, { type: 'room_full' });
          return;
        }
        const playerIdx = room.nextPlayerIdx++;
        const playerId = PLAYER_ID_LIST[playerIdx];
        room.clients.set(playerId, ws);
        socketToRoom.set(ws, { room: code, playerId, isHost: false });

        send(ws, { type: 'assign', playerId, playerIndex: playerIdx, isHost: false });
        broadcastToRoom(room, { type: 'player_joined', count: getRoomPlayerCount(room), playerId });
        console.log(`[RELAY] Player ${playerIdx} (id=${playerId}) joined room ${code} (${getRoomPlayerCount(room)}/${MAX_PLAYERS} players)`);
      }
      return;
    }

    // Relay messages between host and clients
    const info = socketToRoom.get(ws);
    if (!info) return;
    const room = rooms.get(info.room);
    if (!room) return;

    if (msg.type === 'input') {
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(data.toString());
      }
    } else if (msg.type === 'game_start') {
      console.log(`[RELAY] Game started in room ${info.room} with ${getRoomPlayerCount(room)} players`);
      const raw = data.toString();
      for (const [, clientWs] of room.clients) {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(raw);
        }
      }
    } else if (msg.type === 'state') {
      const raw = data.toString();
      for (const [, clientWs] of room.clients) {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(raw);
        }
      }
    }
  });

  ws.on('close', () => removeFromRoom(ws));
  ws.on('error', () => removeFromRoom(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[RELAY] Server listening on port ${PORT}`);
  console.log(`[RELAY] Max players per room: ${MAX_PLAYERS}`);
});
