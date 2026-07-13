'use strict';
// Simulacion: bots con estrategia simple juegan partidas completas.
// En cada paso se verifican invariantes globales del estado.

const assert = require('assert');
const { Game } = require('../server/game/engine');
const R = require('../server/game/rules');
const { RESOURCES, PIECES } = require('../server/game/constants');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkInvariants(g, step) {
  for (const res of RESOURCES) {
    const total = g.bank[res] + g.players.reduce((s, p) => s + p.resources[res], 0);
    assert.strictEqual(total, 19, `conservacion de ${res} en paso ${step}`);
    assert.ok(g.bank[res] >= 0, `banco negativo de ${res}`);
    for (const p of g.players) assert.ok(p.resources[res] >= 0, `mano negativa de ${res}`);
  }
  for (const p of g.players) {
    assert.ok(p.roads.length <= PIECES.roads, 'limite de caminos');
    assert.ok(p.settlements.length <= PIECES.settlements, 'limite de poblados');
    assert.ok(p.cities.length <= PIECES.cities, 'limite de ciudades');
  }
  const totalDev = g.devDeck.length + g.players.reduce((s, p) =>
    s + Object.values(p.devCards).reduce((a, b) => a + b, 0)
    + Object.values(p.newDevCards).reduce((a, b) => a + b, 0)
    + p.playedKnights, 0)
    + g.players.reduce((s, p) => s, 0);
  // Nota: roadBuilding/yearOfPlenty/monopoly jugadas salen del juego; se cuentan aparte.
  assert.ok(totalDev <= 25, 'mazo de desarrollo no crece');
  // Vertices: ningun vertice con dos edificios
  const seen = new Set();
  for (const p of g.players) {
    for (const v of [...p.settlements, ...p.cities]) {
      assert.ok(!seen.has(v), `vertice ${v} duplicado`);
      seen.add(v);
    }
  }
}

function greedyDiscard(g, pIdx, count) {
  const pl = g.players[pIdx];
  const hand = {};
  let left = count;
  for (const r of RESOURCES) {
    const take = Math.min(left, pl.resources[r]);
    if (take > 0) { hand[r] = take; left -= take; }
  }
  return hand;
}

function playBotAction(g, rng) {
  const p = g.turn;

  if (g.phase === 'setup') {
    if (g.setupExpecting === 'settlement') {
      // elige un vertice legal con buen numero cerca
      const candidates = g.board.vertices.filter((v) => R.respectsDistanceRule(g.board, g.players, v.id));
      const v = candidates[Math.floor(rng() * candidates.length)];
      assert.ok(g.placeSetupSettlement(p, v.id).ok, 'setup settlement');
    } else {
      const edges = g.board.vertices[g.lastSetupVertex].edges.filter((e) => R.roadAt(g.players, e) === null);
      assert.ok(g.placeSetupRoad(p, edges[Math.floor(rng() * edges.length)]).ok, 'setup road');
    }
    return;
  }

  if (g.subPhase === 'discard') {
    const idx = Number(Object.keys(g.pendingDiscards)[0]);
    assert.ok(g.discard(idx, greedyDiscard(g, idx, g.pendingDiscards[idx])).ok, 'discard');
    return;
  }
  if (g.subPhase === 'robber') {
    const targets = g.board.hexes.filter((h) => h.id !== g.robberHex);
    assert.ok(g.moveRobber(p, targets[Math.floor(rng() * targets.length)].id).ok, 'robber');
    return;
  }
  if (g.subPhase === 'steal') {
    assert.ok(g.stealFrom(p, g.stealCandidates[Math.floor(rng() * g.stealCandidates.length)]).ok, 'steal');
    return;
  }
  if (g.subPhase === 'freeRoads') {
    const legal = g.board.edges.filter((e) => R.canPlaceRoad(g.board, g.players, p, e.id));
    if (legal.length === 0) { g.freeRoadsLeft = 0; g.subPhase = 'main'; return; }
    assert.ok(g.placeFreeRoad(p, legal[Math.floor(rng() * legal.length)].id).ok, 'free road');
    return;
  }
  if (g.subPhase === 'roll') {
    // 30% de las veces juega caballero antes de tirar si puede
    if (!g.devPlayedThisTurn && g.players[p].devCards.knight > 0 && rng() < 0.3) {
      assert.ok(g.playKnight(p).ok, 'knight pre-roll');
      return;
    }
    assert.ok(g.rollDice(p).ok, 'roll');
    return;
  }

  // main: prioridad ciudad > poblado > dev > camino > trade banco > fin
  const pl = g.players[p];

  if (pl.settlements.length > 0 && R.hasResources(pl.resources, { wheat: 2, ore: 3 }) && pl.cities.length < PIECES.cities) {
    assert.ok(g.buildCity(p, pl.settlements[0]).ok, 'city');
    return;
  }
  if (R.hasResources(pl.resources, { wood: 1, brick: 1, sheep: 1, wheat: 1 }) && pl.settlements.length < PIECES.settlements) {
    const spot = g.board.vertices.find((v) => R.canPlaceSettlement(g.board, g.players, p, v.id));
    if (spot) { assert.ok(g.buildSettlement(p, spot.id).ok, 'settlement'); return; }
  }
  if (!g.devPlayedThisTurn) {
    const dc = pl.devCards;
    if (dc.knight > 0 && rng() < 0.5) { assert.ok(g.playKnight(p).ok); return; }
    if (dc.roadBuilding > 0 && pl.roads.length < PIECES.roads - 1) { assert.ok(g.playRoadBuilding(p).ok); return; }
    if (dc.yearOfPlenty > 0) {
      const r1 = RESOURCES[Math.floor(rng() * 5)];
      const r2 = RESOURCES[Math.floor(rng() * 5)];
      if (g.bank[r1] >= (r1 === r2 ? 2 : 1) && g.bank[r2] >= 1) { assert.ok(g.playYearOfPlenty(p, r1, r2).ok); return; }
    }
    if (dc.monopoly > 0 && rng() < 0.5) { assert.ok(g.playMonopoly(p, RESOURCES[Math.floor(rng() * 5)]).ok); return; }
  }
  if (R.hasResources(pl.resources, { sheep: 1, wheat: 1, ore: 1 }) && g.devDeck.length > 0 && rng() < 0.6) {
    assert.ok(g.buyDevCard(p).ok, 'buy dev');
    return;
  }
  if (R.hasResources(pl.resources, { wood: 1, brick: 1 }) && pl.roads.length < PIECES.roads && rng() < 0.7) {
    const legal = g.board.edges.find((e) => R.canPlaceRoad(g.board, g.players, p, e.id));
    if (legal) { assert.ok(g.buildRoad(p, legal.id).ok, 'road'); return; }
  }
  // trade con banco si esta inundado de un recurso
  for (const res of RESOURCES) {
    const ratio = R.tradeRatio(g.board, g.players, p, res);
    if (pl.resources[res] >= ratio + 2) {
      const want = RESOURCES.find((r) => r !== res && g.bank[r] > 0);
      if (want) { assert.ok(g.bankTrade(p, { [res]: ratio }, { [want]: 1 }).ok, 'bank trade'); return; }
    }
  }
  assert.ok(g.endTurn(p).ok, 'end turn');
}

let wins = 0;
const SEEDS = 12;
for (let seed = 1; seed <= SEEDS; seed++) {
  const rng = mulberry32(seed * 1000);
  const numPlayers = 3 + (seed % 2); // alterna 3 y 4 jugadores
  const g = new Game(Array.from({ length: numPlayers }, (_, i) => `Bot${i}`), rng);

  let steps = 0;
  const MAX_STEPS = 20000;
  while (g.winner === null && steps < MAX_STEPS) {
    playBotAction(g, rng);
    checkInvariants(g, steps);
    steps++;
  }
  if (g.winner !== null) {
    wins++;
    const vp = g.victoryPoints(g.winner);
    assert.ok(vp >= 10, `ganador con ${vp} puntos`);
    console.log(`  seed ${seed}: ${numPlayers} jugadores, gana ${g.players[g.winner].name} con ${vp} VP en ${steps} acciones`);
  } else {
    console.log(`  seed ${seed}: sin ganador en ${MAX_STEPS} acciones (valido pero raro)`);
  }
}

assert.ok(wins >= SEEDS - 2, `muy pocas partidas terminadas: ${wins}/${SEEDS}`);
console.log(`sim.test.js OK (${wins}/${SEEDS} partidas completadas)`);
