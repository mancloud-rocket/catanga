'use strict';

// Server de Catan multiplayer local: Express sirve el cliente estatico y
// Socket.IO maneja salas, reconexion y el despacho de acciones al motor.

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Game } = require('./game/engine');
const R = require('./game/rules');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// Pagina troll de verificacion de identidad (no toca el juego real)
app.get('/amigos', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'amigos.html'));
});

const server = http.createServer(app);
const io = new Server(server);

// code -> { code, players: [{ token, name, sockets, connected }], hostToken, game }
const rooms = new Map();

function log(...args) {
  console.log(new Date().toISOString(), '|', ...args);
}

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

// Cada jugador puede tener VARIOS sockets vivos (dos pestañas, o el socket
// viejo de un celular que todavia no hizo timeout). Se emite a todos.
function emitToPlayer(p, event, payload) {
  for (const sid of p.sockets) io.to(sid).emit(event, payload);
}

function broadcastLobby(room) {
  for (const p of room.players) {
    emitToPlayer(p, 'roomUpdate', {
      ...lobbyView(room),
      youIdx: room.players.indexOf(p),
      youAreHost: p.token === room.hostToken,
    });
  }
}

function broadcastGame(room) {
  if (!room.game) return;
  room.players.forEach((p, i) => {
    const state = room.game.serialize(i);
    state.retiredSeats = [...room.retiredSeats];
    emitToPlayer(p, 'gameState', state);
  });
}

// ---------- Autopiloto para asientos retirados ----------
// Juega lo minimo para que la partida nunca se trabe: tira dados, descarta,
// mueve al ladron y pasa el turno. No construye ni comercia.

function autoStep(g) {
  const p = g.turn;
  if (g.phase === 'setup') {
    if (g.setupExpecting === 'settlement') {
      const v = g.board.vertices.find((vv) => R.respectsDistanceRule(g.board, g.players, vv.id));
      return v ? g.placeSetupSettlement(p, v.id) : { ok: false };
    }
    const e = g.board.vertices[g.lastSetupVertex].edges.find((ee) => R.roadAt(g.players, ee) === null);
    return e !== undefined ? g.placeSetupRoad(p, e) : { ok: false };
  }
  if (g.subPhase === 'roll') return g.rollDice(p);
  if (g.subPhase === 'robber') {
    const hex = g.board.hexes.find((h) => h.id !== g.robberHex);
    return g.moveRobber(p, hex.id);
  }
  if (g.subPhase === 'steal') return g.stealFrom(p, g.stealCandidates[0]);
  if (g.subPhase === 'freeRoads') {
    const edge = g.board.edges.find((e) => R.canPlaceRoad(g.board, g.players, p, e.id));
    if (edge) return g.placeFreeRoad(p, edge.id);
    g.freeRoadsLeft = 0;
    g.subPhase = 'main';
    return { ok: true };
  }
  if (g.subPhase === 'main') return g.endTurn(p);
  return { ok: false };
}

function greedyDiscardFor(g, idx) {
  const pl = g.players[idx];
  const hand = {};
  let left = g.pendingDiscards[idx];
  for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
    const take = Math.min(left, pl.resources[r]);
    if (take > 0) { hand[r] = take; left -= take; }
  }
  return g.discard(idx, hand);
}

function pumpAutoplay(room) {
  const g = room.game;
  if (!g || room.retiredSeats.size === 0) return;
  let acted = false;
  let guard = 0;

  while (g.winner === null && guard++ < 80) {
    // descartes pendientes de retirados (pueden deber cartas en turno ajeno)
    if (g.subPhase === 'discard') {
      const pend = Object.keys(g.pendingDiscards).map(Number).filter((i) => room.retiredSeats.has(i));
      if (pend.length > 0) {
        for (const idx of pend) greedyDiscardFor(g, idx);
        acted = true;
        continue;
      }
    }
    if (!room.retiredSeats.has(g.turn)) break;
    const res = autoStep(g);
    if (!res || !res.ok) break;
    acted = true;
  }

  // los retirados rechazan ofertas automaticamente
  if (g.winner === null && g.tradeOffer) {
    for (const idx of [...room.retiredSeats]) {
      if (!g.tradeOffer) break;
      if (idx !== g.tradeOffer.from && !g.tradeOffer.responses[idx]) {
        g.respondTrade(idx, false);
        acted = true;
      }
    }
  }

  if (acted) broadcastGame(room);
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
  log(`socket conectado ${socket.id}`);

  const myIdx = () => (myRoom ? myRoom.players.findIndex((p) => p.token === myToken) : -1);

  socket.on('createRoom', ({ name }, cb) => {
    name = String(name || '').trim().slice(0, 16) || 'Jugador';
    const code = makeCode();
    const token = crypto.randomUUID();
    const room = { code, players: [{ token, name, sockets: [socket.id], connected: true }], hostToken: token, game: null, retiredSeats: new Set() };
    rooms.set(code, room);
    myRoom = room;
    myToken = token;
    log(`sala ${code} creada por ${name} (${socket.id})`);
    cb({ ok: true, code, token, idx: 0 });
    broadcastLobby(room);
  });

  socket.on('joinRoom', ({ code, name, token }, cb) => {
    code = String(code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'No existe esa sala.' });

    // Reconexion con token existente (suma el socket nuevo sin pisar otros)
    if (token) {
      const existing = room.players.find((p) => p.token === token);
      if (existing) {
        if (!existing.sockets.includes(socket.id)) existing.sockets.push(socket.id);
        existing.connected = true;
        myRoom = room;
        myToken = token;
        // si se habia retirado y nadie tomo su lugar, vuelve a la partida
        const seatIdx = room.players.indexOf(existing);
        if (room.retiredSeats.has(seatIdx)) {
          room.retiredSeats.delete(seatIdx);
          if (room.game) room.game._log(`${existing.name} se arrepintio y volvio a la partida.`);
          log(`sala ${code}: ${existing.name} volvio (asiento ${seatIdx})`);
        }
        log(`sala ${code}: ${existing.name} reconecta (${socket.id}), sockets activos: ${existing.sockets.length}`);
        cb({ ok: true, code, token, idx: seatIdx, started: !!room.game });
        broadcastLobby(room);
        if (room.game) broadcastGame(room);
        return;
      }
    }

    // Partida empezada: solo se puede entrar tomando un asiento retirado
    if (room.game) {
      const freeIdx = [...room.retiredSeats][0];
      if (freeIdx === undefined) return cb({ ok: false, error: 'La partida ya empezo y no hay lugares libres.' });
      const seat = room.players[freeIdx];
      const oldName = room.game.players[freeIdx].name;
      name = String(name || '').trim().slice(0, 16) || 'Jugador';
      const newToken = crypto.randomUUID();
      seat.token = newToken;
      seat.name = name;
      seat.sockets = [socket.id];
      seat.connected = true;
      room.retiredSeats.delete(freeIdx);
      room.game.players[freeIdx].name = name; // hereda piezas, recursos y cartas
      room.game._log(`${name} toma el lugar de ${oldName}. Hereda todo lo suyo.`);
      myRoom = room;
      myToken = newToken;
      log(`sala ${code}: ${name} tomo el asiento ${freeIdx} (era de ${oldName})`);
      cb({ ok: true, code, token: newToken, idx: freeIdx, started: true });
      broadcastLobby(room);
      broadcastGame(room);
      return;
    }
    if (room.players.length >= 4) return cb({ ok: false, error: 'La sala esta llena (max 4).' });
    name = String(name || '').trim().slice(0, 16) || `Jugador ${room.players.length + 1}`;
    const newToken = crypto.randomUUID();
    room.players.push({ token: newToken, name, sockets: [socket.id], connected: true });
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
    log(`sala ${myRoom.code}: partida iniciada con ${myRoom.players.map((p) => p.name).join(', ')}`);
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
    if (result.ok) {
      broadcastGame(myRoom);
      pumpAutoplay(myRoom); // por si el turno cayo en un asiento retirado
      if (myRoom.game.winner !== null && !myRoom.winnerLogged) {
        myRoom.winnerLogged = true;
        log(`sala ${myRoom.code}: gana ${myRoom.game.players[myRoom.game.winner].name}`);
      }
    }
  });

  // Retirarse: el asiento queda libre y el autopiloto lo mantiene vivo
  socket.on('retire', (cb) => {
    const idx = myIdx();
    if (!myRoom || !myRoom.game || idx === -1) return cb && cb({ ok: false, error: 'No estas en una partida.' });
    if (myRoom.game.winner !== null) return cb && cb({ ok: false, error: 'La partida ya termino.' });
    if (myRoom.retiredSeats.has(idx)) return cb && cb({ ok: false, error: 'Ya te diste.' });
    myRoom.retiredSeats.add(idx);
    myRoom.game._log(`${myRoom.game.players[idx].name} se retira. Su lugar queda libre: entra con el codigo ${myRoom.code}.`);
    log(`sala ${myRoom.code}: ${myRoom.game.players[idx].name} se retiro (asiento ${idx})`);
    cb && cb({ ok: true });
    broadcastGame(myRoom);
    pumpAutoplay(myRoom);
  });

  socket.on('chat', (msg) => {
    const idx = myIdx();
    if (!myRoom || idx === -1) return;
    const text = String(msg || '').slice(0, 200);
    if (!text.trim()) return;
    for (const p of myRoom.players) {
      emitToPlayer(p, 'chat', { from: myRoom.players[idx].name, idx, text });
    }
  });

  // Refresco de estado bajo demanda (al volver de background, tras reconectar)
  socket.on('getState', (cb) => {
    const idx = myIdx();
    if (!myRoom || idx === -1 || typeof cb !== 'function') return cb && cb({ ok: false });
    if (myRoom.game) {
      const state = myRoom.game.serialize(idx);
      state.retiredSeats = [...myRoom.retiredSeats];
      cb({ ok: true, state });
    } else cb({ ok: true, lobby: true });
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
      // Solo remueve ESTE socket: si el jugador reconecto con otro socket
      // (celular que desperto, otra pestaña), ese sigue vivo y recibiendo.
      p.sockets = p.sockets.filter((sid) => sid !== socket.id);
      p.connected = p.sockets.length > 0;
      log(`sala ${myRoom.code}: ${p.name} perdio el socket ${socket.id}, quedan ${p.sockets.length}`);
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
