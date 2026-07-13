'use strict';

// Reglas puras de Catan: validaciones de colocacion, reparto de recursos,
// ruta mas larga y ratios de puerto. Sin estado propio: reciben board + players.
// players: [{ roads: [edgeId], settlements: [vertexId], cities: [vertexId], ... }]

const { RESOURCES } = require('./constants');

// Vertice ocupado por cualquier edificio (poblado o ciudad) de cualquier jugador.
function buildingAt(players, vertexId) {
  for (let i = 0; i < players.length; i++) {
    if (players[i].settlements.includes(vertexId)) return { player: i, type: 'settlement' };
    if (players[i].cities.includes(vertexId)) return { player: i, type: 'city' };
  }
  return null;
}

function roadAt(players, edgeId) {
  for (let i = 0; i < players.length; i++) {
    if (players[i].roads.includes(edgeId)) return i;
  }
  return null;
}

// Regla de distancia: el vertice y todos sus vecinos deben estar libres.
function respectsDistanceRule(board, players, vertexId) {
  if (buildingAt(players, vertexId)) return false;
  for (const n of board.vertices[vertexId].neighbors) {
    if (buildingAt(players, n)) return false;
  }
  return true;
}

// Colocacion de poblado en fase de juego: distancia + conectado a camino propio.
function canPlaceSettlement(board, players, playerIdx, vertexId) {
  if (!respectsDistanceRule(board, players, vertexId)) return false;
  return board.vertices[vertexId].edges.some((e) => roadAt(players, e) === playerIdx);
}

// Colocacion de camino: arista libre y conectada a camino o edificio propio.
// No se puede extender a traves de un edificio rival.
function canPlaceRoad(board, players, playerIdx, edgeId) {
  if (roadAt(players, edgeId) !== null) return false;
  const edge = board.edges[edgeId];
  for (const v of [edge.v1, edge.v2]) {
    const b = buildingAt(players, v);
    if (b && b.player === playerIdx) return true;
    if (b && b.player !== playerIdx) continue; // vertice bloqueado por rival
    const connected = board.vertices[v].edges.some(
      (e) => e !== edgeId && roadAt(players, e) === playerIdx
    );
    if (connected) return true;
  }
  return false;
}

// Ruta mas larga de un jugador: camino simple mas largo (sin repetir aristas)
// en su red, cortado por edificios rivales en vertices intermedios.
function longestRoadLength(board, players, playerIdx) {
  const myEdges = new Set(players[playerIdx].roads);
  if (myEdges.size === 0) return 0;

  const blockedVertex = (v) => {
    const b = buildingAt(players, v);
    return b !== null && b.player !== playerIdx;
  };

  let best = 0;
  const visited = new Set();

  const dfs = (vertex, length) => {
    best = Math.max(best, length);
    for (const e of board.vertices[vertex].edges) {
      if (!myEdges.has(e) || visited.has(e)) continue;
      const edge = board.edges[e];
      const next = edge.v1 === vertex ? edge.v2 : edge.v1;
      visited.add(e);
      // Se puede contar la arista, pero no continuar mas alla de un vertice bloqueado.
      if (blockedVertex(next)) best = Math.max(best, length + 1);
      else dfs(next, length + 1);
      visited.delete(e);
    }
  };

  // Arranca desde cada extremo de cada arista propia (cubre ciclos y ramas).
  const startVertices = new Set();
  for (const e of myEdges) {
    startVertices.add(board.edges[e].v1);
    startVertices.add(board.edges[e].v2);
  }
  for (const v of startVertices) {
    if (blockedVertex(v)) continue;
    dfs(v, 0);
  }
  return best;
}

// Reparto de recursos por tirada. Regla oficial de escasez: si el banco no
// alcanza para un recurso y hay mas de un jugador afectado, nadie lo recibe;
// si es uno solo, recibe lo que quede.
// Devuelve { gains: [{playerIdx: {res: n}}...], shortages: [res] } y NO muta.
function computeDistribution(board, players, roll, robberHex, bank) {
  const perPlayer = players.map(() => ({}));
  const perResource = {};

  for (const hex of board.hexes) {
    if (hex.number !== roll || hex.id === robberHex || !hex.resource) continue;
    for (const v of hex.vertices) {
      const b = buildingAt(players, v);
      if (!b) continue;
      const amount = b.type === 'city' ? 2 : 1;
      perPlayer[b.player][hex.resource] = (perPlayer[b.player][hex.resource] || 0) + amount;
      if (!perResource[hex.resource]) perResource[hex.resource] = { total: 0, players: new Set() };
      perResource[hex.resource].total += amount;
      perResource[hex.resource].players.add(b.player);
    }
  }

  const shortages = [];
  for (const res of Object.keys(perResource)) {
    const info = perResource[res];
    if (info.total <= bank[res]) continue;
    if (info.players.size > 1) {
      shortages.push(res);
      for (const p of perPlayer) delete p[res];
    } else {
      const only = [...info.players][0];
      perPlayer[only][res] = bank[res];
      if (bank[res] === 0) shortages.push(res);
    }
  }

  return { gains: perPlayer, shortages };
}

// Mejor ratio de intercambio con el banco para un recurso dado.
function tradeRatio(board, players, playerIdx, resource) {
  const myVerts = new Set([...players[playerIdx].settlements, ...players[playerIdx].cities]);
  let ratio = 4;
  for (const port of board.ports) {
    if (!port.vertices.some((v) => myVerts.has(v))) continue;
    if (port.type === 'any') ratio = Math.min(ratio, 3);
    else if (port.type === resource) ratio = Math.min(ratio, 2);
  }
  return ratio;
}

function countResources(hand) {
  return RESOURCES.reduce((sum, r) => sum + (hand[r] || 0), 0);
}

function hasResources(hand, cost) {
  return Object.keys(cost).every((r) => (hand[r] || 0) >= cost[r]);
}

module.exports = {
  buildingAt, roadAt, respectsDistanceRule, canPlaceSettlement, canPlaceRoad,
  longestRoadLength, computeDistribution, tradeRatio, countResources, hasResources,
};
