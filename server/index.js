'use strict';

// Server de Catan multiplayer local: Express sirve el cliente estatico y
// Socket.IO maneja salas, reconexion y el despacho de acciones al motor.

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Game } = require('./game/engine');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// Pagina troll de verificacion de identidad (no toca el juego real)
app.get('/amigos', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'amigos.html'));
});

const server = http.createServer(app);
const io = new Server(server);

// code -> { code, players: [{ token, name, socketId, connected }], hostToken, game }
const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin I ni O para evitar confusiones
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function lobbyView(room) {
  return {
    code: room.code,
    started: !!room.game,
    players: room.players.map((p, i) => ({
      name: p.name,
      connected: p.connected,
      isHost: p.token === room.hostToken,
      idx: i,
    })),
  };
}

function broadcastLobby(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('roomUpdate', {
      ...lobbyView(room),
      youIdx: room.players.indexOf(p),
      youAreHost: p.token === room.hostToken,
    });
  }
}

function broadcastGame(room) {
  if (!room.game) return;
  room.players.forEach((p, i) => {
    if (p.socketId && p.connected) {
      io.to(p.socketId).emit('gameState', room.game.serialize(i));
    }
  });
}

// Mapa de acciones del cliente a metodos del motor.
const ACTIONS = {
  placeSetupSettlement: (g, p, a) => g.placeSetupSettlement(p, a.vertexId),
  placeSetupRoad: (g, p, a) => g.placeSetupRoad(p, a.edgeId),
  rollDice: (g, p) => g.rollDice(p),
  discard: (g, p, a) => g.discard(p, a.hand || {}),
  moveRobber: (g, p, a) => g.moveRobber(p, a.hexId),
  stealFrom: (g, p, a) => g.stealFrom(p, a.victimIdx),
  buildRoad: (g, p, a) => g.buildRoad(p, a.edgeId),
  buildSettlement: (g, p, a) => g.buildSettlement(p, a.vertexId),
  buildCity: (g, p, a) => g.buildCity(p, a.vertexId),
  buyDevCard: (g, p) => g.buyDevCard(p),
  playKnight: (g, p) => g.playKnight(p),
  playRoadBuilding: (g, p) => g.playRoadBuilding(p),
  placeFreeRoad: (g, p, a) => g.placeFreeRoad(p, a.edgeId),
  playYearOfPlenty: (g, p, a) => g.playYearOfPlenty(p, a.res1, a.res2),
  playMonopoly: (g, p, a) => g.playMonopoly(p, a.res),
  bankTrade: (g, p, a) => g.bankTrade(p, a.give || {}, a.get || {}),
  offerTrade: (g, p, a) => g.offerTrade(p, a.give || {}, a.get || {}),
  respondTrade: (g, p, a) => g.respondTrade(p, !!a.accept),
  confirmTrade: (g, p, a) => g.confirmTrade(p, a.withIdx),
  cancelTrade: (g, p) => g.cancelTrade(p),
  endTurn: (g, p) => g.endTurn(p),
};

io.on('connection', (socket) => {
  let myRoom = null;
  let myToken = null;

  const myIdx = () => (myRoom ? myRoom.players.findIndex((p) => p.token === myToken) : -1);

  socket.on('createRoom', ({ name }, cb) => {
    name = String(name || '').trim().slice(0, 16) || 'Jugador';
    const code = makeCode();
    const token = crypto.randomUUID();
    const room = { code, players: [{ token, name, socketId: socket.id, connected: true }], hostToken: token, game: null };
    rooms.set(code, room);
    myRoom = room;
    myToken = token;
    cb({ ok: true, code, token, idx: 0 });
    broadcastLobby(room);
  });

  socket.on('joinRoom', ({ code, name, token }, cb) => {
    code = String(code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'No existe esa sala.' });

    // Reconexion con token existente
    if (token) {
      const existing = room.players.find((p) => p.token === token);
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        myRoom = room;
        myToken = token;
        cb({ ok: true, code, token, idx: room.players.indexOf(existing), started: !!room.game });
        broadcastLobby(room);
        if (room.game) broadcastGame(room);
        return;
      }
    }

    if (room.game) return cb({ ok: false, error: 'La partida ya empezo.' });
    if (room.players.length >= 4) return cb({ ok: false, error: 'La sala esta llena (max 4).' });
    name = String(name || '').trim().slice(0, 16) || `Jugador ${room.players.length + 1}`;
    const newToken = crypto.randomUUID();
    room.players.push({ token: newToken, name, socketId: socket.id, connected: true });
    myRoom = room;
    myToken = newToken;
    cb({ ok: true, code, token: newToken, idx: room.players.length - 1 });
    broadcastLobby(room);
  });

  socket.on('startGame', (cb) => {
    if (!myRoom) return cb && cb({ ok: false, error: 'No estas en una sala.' });
    if (myToken !== myRoom.hostToken) return cb && cb({ ok: false, error: 'Solo el anfitrion puede empezar.' });
    if (myRoom.game) return cb && cb({ ok: false, error: 'Ya empezo.' });
    if (myRoom.players.length < 2) return cb && cb({ ok: false, error: 'Se necesitan al menos 2 jugadores (ideal 3 o 4).' });
    // Orden de turnos al azar (en el fisico empieza "el de mas edad").
    for (let i = myRoom.players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [myRoom.players[i], myRoom.players[j]] = [myRoom.players[j], myRoom.players[i]];
    }
    myRoom.game = new Game(myRoom.players.map((p) => p.name));
    cb && cb({ ok: true });
    broadcastLobby(myRoom);
    broadcastGame(myRoom);
  });

  socket.on('action', (action, cb) => {
    const idx = myIdx();
    if (!myRoom || !myRoom.game || idx === -1) return cb && cb({ ok: false, error: 'No estas en una partida.' });
    const fn = ACTIONS[action && action.type];
    if (!fn) return cb && cb({ ok: false, error: 'Accion desconocida.' });
    let result;
    try {
      result = fn(myRoom.game, idx, action);
    } catch (err) {
      console.error('Error en accion', action, err);
      result = { ok: false, error: 'Error interno del server.' };
    }
    cb && cb(result);
    if (result.ok) broadcastGame(myRoom);
  });

  socket.on('chat', (msg) => {
    const idx = myIdx();
    if (!myRoom || idx === -1) return;
    const text = String(msg || '').slice(0, 200);
    if (!text.trim()) return;
    for (const p of myRoom.players) {
      if (p.socketId && p.connected) {
        io.to(p.socketId).emit('chat', { from: myRoom.players[idx].name, idx, text });
      }
    }
  });

  socket.on('leaveRoom', () => {
    if (!myRoom) return;
    const idx = myIdx();
    if (idx !== -1 && !myRoom.game) {
      // En lobby: sale de verdad. Si era host, pasa el rol.
      myRoom.players.splice(idx, 1);
      if (myRoom.players.length === 0) {
        rooms.delete(myRoom.code);
      } else if (myToken === myRoom.hostToken) {
        myRoom.hostToken = myRoom.players[0].token;
      }
      broadcastLobby(myRoom);
    }
    myRoom = null;
    myToken = null;
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    const p = myRoom.players.find((pl) => pl.token === myToken);
    if (p) {
      p.connected = false;
      p.socketId = null;
      broadcastLobby(myRoom);
    }
    // Sala vacia sin partida: se limpia a los 10 minutos.
    const room = myRoom;
    setTimeout(() => {
      if (rooms.has(room.code) && room.players.every((pl) => !pl.connected)) {
        rooms.delete(room.code);
      }
    }, 10 * 60 * 1000);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Catan corriendo en http://localhost:${PORT}`);
  console.log('Para jugar en LAN, comparti tu IP local, por ejemplo: http://192.168.x.x:' + PORT);
});
