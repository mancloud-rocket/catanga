'use strict';
// Genera public/dev-state.json: una partida a mitad de juego para QA visual (dev.html).

const fs = require('fs');
const path = require('path');
const { Game } = require('../server/game/engine');
const R = require('../server/game/rules');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(42);
const g = new Game(['Fer', 'Rama', 'Nico', 'Caro'], rng);

// Setup completo
while (g.phase === 'setup') {
  const p = g.turn;
  if (g.setupExpecting === 'settlement') {
    // elige el vertice legal con mas produccion (mas puntos de probabilidad)
    const dots = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
    let best = null, bestScore = -1;
    for (const v of g.board.vertices) {
      if (!R.respectsDistanceRule(g.board, g.players, v.id)) continue;
      const score = v.hexes.reduce((s, h) => s + (dots[g.board.hexes[h].number] || 0), 0);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    g.placeSetupSettlement(p, best.id);
  } else {
    const edges = g.board.vertices[g.lastSetupVertex].edges.filter((e) => R.roadAt(g.players, e) === null);
    g.placeSetupRoad(p, edges[Math.floor(rng() * edges.length)]);
  }
}

// Unos turnos simulados para que haya piezas en el tablero
let guard = 0;
while (guard++ < 2000 && g.players.reduce((s, p) => s + p.roads.length, 0) < 22) {
  const p = g.turn;
  if (g.subPhase === 'roll') { g.rollDice(p); continue; }
  if (g.subPhase === 'discard') {
    const idx = Number(Object.keys(g.pendingDiscards)[0]);
    const pl = g.players[idx]; const hand = {}; let left = g.pendingDiscards[idx];
    for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
      const t = Math.min(left, pl.resources[r]); if (t) { hand[r] = t; left -= t; }
    }
    g.discard(idx, hand); continue;
  }
  if (g.subPhase === 'robber') {
    const hexes = g.board.hexes.filter((h) => h.id !== g.robberHex && h.resource);
    g.moveRobber(p, hexes[Math.floor(rng() * hexes.length)].id); continue;
  }
  if (g.subPhase === 'steal') { g.stealFrom(p, g.stealCandidates[0]); continue; }
  // main
  const pl = g.players[p];
  if (R.hasResources(pl.resources, { wheat: 2, ore: 3 }) && pl.settlements.length) {
    g.buildCity(p, pl.settlements[0]); continue;
  }
  if (R.hasResources(pl.resources, { wood: 1, brick: 1, sheep: 1, wheat: 1 })) {
    const spot = g.board.vertices.find((v) => R.canPlaceSettlement(g.board, g.players, p, v.id));
    if (spot) { g.buildSettlement(p, spot.id); continue; }
  }
  if (R.hasResources(pl.resources, { wood: 1, brick: 1 }) && pl.roads.length < 12) {
    const edge = g.board.edges.find((e) => R.canPlaceRoad(g.board, g.players, p, e.id));
    if (edge) { g.buildRoad(p, edge.id); continue; }
  }
  g.endTurn(p);
}

// Estado vistoso para el screenshot: turno de Fer (jugador 0), fase main, mano surtida
while (g.turn !== 0) {
  if (g.subPhase === 'roll') g.rollDice(g.turn);
  else if (g.subPhase === 'discard') {
    const idx = Number(Object.keys(g.pendingDiscards)[0]);
    const pl = g.players[idx]; const hand = {}; let left = g.pendingDiscards[idx];
    for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
      const t = Math.min(left, pl.resources[r]); if (t) { hand[r] = t; left -= t; }
    }
    g.discard(idx, hand);
  } else if (g.subPhase === 'robber') g.moveRobber(g.turn, g.board.hexes.find((h) => h.id !== g.robberHex).id);
  else if (g.subPhase === 'steal') g.stealFrom(g.turn, g.stealCandidates[0]);
  else g.endTurn(g.turn);
}
if (g.subPhase === 'roll') g.rollDice(0);
while (g.subPhase !== 'main') {
  if (g.subPhase === 'discard') {
    const idx = Number(Object.keys(g.pendingDiscards)[0]);
    const pl = g.players[idx]; const hand = {}; let left = g.pendingDiscards[idx];
    for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
      const t = Math.min(left, pl.resources[r]); if (t) { hand[r] = t; left -= t; }
    }
    g.discard(idx, hand);
  } else if (g.subPhase === 'robber') g.moveRobber(0, g.board.hexes.find((h) => h.id !== g.robberHex).id);
  else if (g.subPhase === 'steal') g.stealFrom(0, g.stealCandidates[0]);
}

g.players[0].resources = { wood: 2, brick: 1, sheep: 3, wheat: 2, ore: 1 };
g.players[0].devCards = { knight: 2, victoryPoint: 1, roadBuilding: 1, yearOfPlenty: 0, monopoly: 1 };
g.dice = [4, 6];

const out = path.join(__dirname, '..', 'public', 'dev-state.json');
fs.writeFileSync(out, JSON.stringify(g.serialize(0)));
console.log('dev-state.json generado:', out);
console.log('piezas:', g.players.map((p) => `${p.name}: ${p.roads.length}r/${p.settlements.length}s/${p.cities.length}c`).join('  '));
