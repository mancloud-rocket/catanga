'use strict';
const assert = require('assert');
const { generateBoard } = require('../server/game/board');
const R = require('../server/game/rules');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const board = generateBoard(mulberry32(7));
const P = () => ({ roads: [], settlements: [], cities: [] });

// --- Regla de distancia ---
{
  const players = [P(), P()];
  const v = board.hexes[9].vertices[0]; // hex central aprox
  assert.ok(R.respectsDistanceRule(board, players, v), 'vertice libre ok');
  players[1].settlements.push(v);
  assert.ok(!R.respectsDistanceRule(board, players, v), 'ocupado falla');
  const neighbor = board.vertices[v].neighbors[0];
  assert.ok(!R.respectsDistanceRule(board, players, neighbor), 'vecino de poblado falla');
  const far = board.vertices[v].neighbors
    .flatMap((n) => board.vertices[n].neighbors)
    .find((n2) => n2 !== v && !board.vertices[v].neighbors.includes(n2));
  assert.ok(R.respectsDistanceRule(board, players, far), 'a distancia 2 ok');
}

// --- Caminos: conectividad y bloqueo por rival ---
{
  const players = [P(), P()];
  const v = board.hexes[9].vertices[0];
  players[0].settlements.push(v);
  const e1 = board.vertices[v].edges[0];
  assert.ok(R.canPlaceRoad(board, players, 0, e1), 'camino junto a poblado propio');
  assert.ok(!R.canPlaceRoad(board, players, 1, e1), 'rival no conecta ahi');
  players[0].roads.push(e1);
  assert.ok(!R.canPlaceRoad(board, players, 0, e1), 'arista ocupada falla');

  // Extension: desde el otro extremo de e1
  const edge1 = board.edges[e1];
  const otherEnd = edge1.v1 === v ? edge1.v2 : edge1.v1;
  const e2 = board.vertices[otherEnd].edges.find((e) => e !== e1);
  assert.ok(R.canPlaceRoad(board, players, 0, e2), 'extension de camino propio');

  // Bloqueo: si un rival edifica en otherEnd, no se puede extender a traves
  players[1].settlements.push(otherEnd);
  assert.ok(!R.canPlaceRoad(board, players, 0, e2), 'bloqueado por edificio rival');
}

// --- Poblado en fase de juego requiere camino propio ---
{
  const players = [P(), P()];
  const v = board.hexes[4].vertices[2];
  assert.ok(!R.canPlaceSettlement(board, players, 0, v), 'sin camino falla');
  players[0].roads.push(board.vertices[v].edges[0]);
  assert.ok(R.canPlaceSettlement(board, players, 0, v), 'con camino ok');
}

// --- Ruta mas larga ---
{
  const players = [P(), P()];
  // Construye una cadena de 5 aristas siguiendo vecinos
  let v = board.hexes[0].vertices[0];
  const chain = [];
  const usedVerts = new Set([v]);
  while (chain.length < 5) {
    const nextEdge = board.vertices[v].edges.find((e) => {
      const edge = board.edges[e];
      const nv = edge.v1 === v ? edge.v2 : edge.v1;
      return !usedVerts.has(nv);
    });
    const edge = board.edges[nextEdge];
    const nv = edge.v1 === v ? edge.v2 : edge.v1;
    chain.push(nextEdge);
    usedVerts.add(nv);
    v = nv;
  }
  players[0].roads = chain;
  assert.strictEqual(R.longestRoadLength(board, players, 0), 5, 'cadena de 5');

  // Rival edifica en el medio de la cadena: la corta
  const midEdge = board.edges[chain[2]];
  const midVert = [...usedVerts][3]; // cuarto vertice tocado = entre chain[2] y chain[3]
  players[1].settlements.push(midVert);
  const cut = R.longestRoadLength(board, players, 0);
  assert.ok(cut < 5 && cut >= 2, `cadena cortada: ${cut}`);
}

// --- Reparto de recursos ---
{
  const players = [P(), P()];
  const hex = board.hexes.find((h) => h.resource && h.id !== board.robberHex);
  players[0].settlements.push(hex.vertices[0]);
  players[1].cities.push(hex.vertices[2]);
  const bank = { wood: 19, brick: 19, sheep: 19, wheat: 19, ore: 19 };
  const { gains } = R.computeDistribution(board, players, hex.number, board.robberHex, bank);
  assert.strictEqual(gains[0][hex.resource], 1, 'poblado da 1');
  assert.strictEqual(gains[1][hex.resource], 2, 'ciudad da 2');

  // Ladron sobre el hex: nadie cobra
  const { gains: g2 } = R.computeDistribution(board, players, hex.number, hex.id, bank);
  assert.ok(!g2[0][hex.resource] && !g2[1][hex.resource], 'ladron bloquea');

  // Escasez multi-jugador: banco corto y 2 jugadores afectados -> nadie cobra
  const poorBank = { ...bank, [hex.resource]: 2 };
  const { gains: g3, shortages } = R.computeDistribution(board, players, hex.number, board.robberHex, poorBank);
  assert.ok(!g3[0][hex.resource] && !g3[1][hex.resource], 'escasez multijugador');
  assert.ok(shortages.includes(hex.resource));

  // Escasez un solo jugador: recibe lo que queda
  const solo = [P(), P()];
  solo[0].cities.push(hex.vertices[0]);
  const { gains: g4 } = R.computeDistribution(board, solo, hex.number, board.robberHex, { ...bank, [hex.resource]: 1 });
  assert.strictEqual(g4[0][hex.resource], 1, 'unico jugador recibe resto');
}

// --- Ratios de puerto ---
{
  const players = [P(), P()];
  assert.strictEqual(R.tradeRatio(board, players, 0, 'wood'), 4, 'sin puerto 4:1');
  const anyPort = board.ports.find((p) => p.type === 'any');
  players[0].settlements.push(anyPort.vertices[0]);
  assert.strictEqual(R.tradeRatio(board, players, 0, 'wood'), 3, 'puerto generico 3:1');
  const woodPort = board.ports.find((p) => p.type === 'wood');
  players[0].settlements.push(woodPort.vertices[0]);
  assert.strictEqual(R.tradeRatio(board, players, 0, 'wood'), 2, 'puerto madera 2:1');
  assert.strictEqual(R.tradeRatio(board, players, 0, 'brick'), 3, 'otro recurso sigue 3:1');
}

// --- Helpers de mano ---
{
  assert.strictEqual(R.countResources({ wood: 2, ore: 1 }), 3);
  assert.ok(R.hasResources({ wood: 1, brick: 1 }, { wood: 1, brick: 1 }));
  assert.ok(!R.hasResources({ wood: 1 }, { wood: 1, brick: 1 }));
}

console.log('rules.test.js OK');
