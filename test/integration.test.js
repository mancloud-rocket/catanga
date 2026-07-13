'use strict';
// Integracion end-to-end: levanta el server real y juega una partida
// completa con 3 clientes socket.io, tomando siempre jugadas legales.

process.env.PORT = 3199;
require('../server/index');
const { io } = require('socket.io-client');
const assert = require('assert');

const URL = 'http://localhost:3199';

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { forceNew: true });
    s.on('connect', () => resolve(s));
  });
}

function emit(sock, event, payload) {
  return new Promise((resolve) => {
    if (payload === undefined) sock.emit(event, resolve);
    else sock.emit(event, payload, resolve);
  });
}

function nextState(sock) {
  return new Promise((resolve) => sock.once('gameState', resolve));
}

async function main() {
  // --- Lobby ---
  const [a, b, c] = await Promise.all([connect(), connect(), connect()]);
  const created = await emit(a, 'createRoom', { name: 'Ana' });
  assert.ok(created.ok, 'createRoom');
  const code = created.code;

  const jb = await emit(b, 'joinRoom', { code, name: 'Beto' });
  const jc = await emit(c, 'joinRoom', { code, name: 'Caro' });
  assert.ok(jb.ok && jc.ok, 'joins');
  assert.strictEqual(jb.idx, 1);
  assert.strictEqual(jc.idx, 2);

  const bad = await emit(b, 'startGame');
  assert.ok(!bad.ok, 'solo host empieza');

  const socks = [a, b, c];
  const states = [null, null, null];
  socks.forEach((s, i) => s.on('gameState', (gs) => { states[i] = gs; }));

  const started = await emit(a, 'startGame');
  assert.ok(started.ok, 'startGame');

  // Espera estados iniciales
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(states[0] && states[1] && states[2], 'todos reciben estado');
  assert.strictEqual(states[0].phase, 'setup');

  // El orden de turnos es aleatorio: cada cliente conserva su identidad por nombre.
  const names = ['Ana', 'Beto', 'Caro'];
  states.forEach((st, i) => {
    assert.strictEqual(st.players[st.you].name, names[i], `asiento correcto de ${names[i]}`);
  });
  const seats = states.map((st) => st.you);
  assert.strictEqual(new Set(seats).size, 3, 'asientos distintos');

  // Manos ocultas entre jugadores
  const otherSeat = states[0].players.findIndex((_, idx) => idx !== states[0].you);
  assert.ok(states[0].players[otherSeat].resources === undefined, 'mano rival oculta para Ana');

  // --- Juego automatico: cada cliente juega su jugada legal cuando le toca ---
  async function playStep() {
    // usa el estado del jugador al que le toca
    const anyState = states.find((s) => s && s.winner === null) || states[0];
    let actor = anyState.turn;

    // descartes: los maneja cada jugador pendiente
    if (anyState.subPhase === 'discard') {
      actor = Number(Object.keys(anyState.pendingDiscards)[0]);
    }
    // actor es un asiento del juego; buscar que cliente lo ocupa
    const ci = states.findIndex((s) => s && s.you === actor);
    assert.ok(ci !== -1, `cliente del asiento ${actor}`);
    const st = states[ci];
    const sock = socks[ci];
    const L = st.legal || {};
    const myRes = st.players[actor].resources;

    let action = null;
    if (st.phase === 'setup') {
      if (st.setupExpecting === 'settlement') {
        action = { type: 'placeSetupSettlement', vertexId: L.setupSettlements[0] };
      } else {
        action = { type: 'placeSetupRoad', edgeId: L.setupRoads[0] };
      }
    } else if (st.subPhase === 'discard') {
      const need = st.pendingDiscards[actor];
      const hand = {};
      let left = need;
      for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
        const t = Math.min(left, myRes[r]); if (t) { hand[r] = t; left -= t; }
      }
      action = { type: 'discard', hand };
    } else if (st.subPhase === 'robber') {
      action = { type: 'moveRobber', hexId: L.robberHexes[0] };
    } else if (st.subPhase === 'steal') {
      action = { type: 'stealFrom', victimIdx: st.stealCandidates[0] };
    } else if (st.subPhase === 'freeRoads') {
      if (L.roads && L.roads.length) action = { type: 'placeFreeRoad', edgeId: L.roads[0] };
      else action = { type: 'endTurn' };
    } else if (st.subPhase === 'roll') {
      action = { type: 'rollDice' };
    } else {
      // main: construye si puede, sino termina
      const has = (cost) => Object.keys(cost).every((r) => myRes[r] >= cost[r]);
      if (has({ wheat: 2, ore: 3 }) && st.players[actor].settlements.length > 0) {
        action = { type: 'buildCity', vertexId: st.players[actor].settlements[0] };
      } else if (has({ wood: 1, brick: 1, sheep: 1, wheat: 1 }) && L.settlements && L.settlements.length) {
        action = { type: 'buildSettlement', vertexId: L.settlements[0] };
      } else if (has({ wood: 1, brick: 1 }) && L.roads && L.roads.length && st.players[actor].roads.length < 13) {
        action = { type: 'buildRoad', edgeId: L.roads[0] };
      } else {
        // banco 4:1 si esta inundado de un recurso, para destrabar la partida
        const ratios = L.ratios || {};
        const flooded = ['wood', 'brick', 'sheep', 'wheat', 'ore'].find((r) => myRes[r] >= (ratios[r] || 4) + 2);
        if (flooded) {
          const want = ['ore', 'wheat', 'sheep', 'brick', 'wood'].find((r) => r !== flooded && st.bank[r] > 0);
          action = { type: 'bankTrade', give: { [flooded]: ratios[flooded] || 4 }, get: { [want]: 1 } };
        } else {
          action = { type: 'endTurn' };
        }
      }
    }

    const res = await emit(sock, 'action', action);
    assert.ok(res.ok, `accion ${action.type} fallo: ${res.error}`);
    await new Promise((r) => setTimeout(r, 25)); // deja llegar el broadcast
  }

  let steps = 0;
  while (states[0].winner === null && steps < 4000) {
    await playStep();
    steps++;
  }
  console.log(`  partida por sockets: ${steps} acciones, ganador: ${states[0].winner !== null ? states[0].players[states[0].winner].name : 'ninguno (limite)'}`);

  // Consistencia entre las 3 vistas
  for (const st of states) {
    assert.strictEqual(st.turn, states[0].turn, 'turn consistente');
    assert.strictEqual(st.winner, states[0].winner, 'winner consistente');
  }

  // --- Reconexion: Beto se cae y vuelve con su token ---
  const tokenB = jb.token;
  b.disconnect();
  await new Promise((r) => setTimeout(r, 200));
  const b2 = await connect();
  // registrar el listener ANTES de reconectar: el server emite el estado al toque
  const statePromise = nextState(b2);
  const betoSeat = states[1].you;
  const rejoined = await emit(b2, 'joinRoom', { code, name: 'Beto', token: tokenB });
  assert.ok(rejoined.ok, 'reconexion');
  assert.strictEqual(rejoined.idx, betoSeat, 'mismo asiento');
  const st2 = await Promise.race([
    statePromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('sin estado tras reconectar')), 2000)),
  ]);
  assert.strictEqual(st2.you, betoSeat, 'estado personalizado tras reconexion');
  assert.ok(st2.players[betoSeat].resources, 'recupera su mano');

  console.log('integration.test.js OK');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
