// Generacion del tablero base de Catan: 19 hexes de tierra (radio 2 en coords axiales),
// vertices y aristas deduplicados por geometria, tokens numerados y 9 puertos costeros.
// Hexes pointy-top. Toda la geometria se calcula con size=1; el cliente escala al renderizar.

'use strict';

const TERRAIN_POOL = [
  'forest', 'forest', 'forest', 'forest',
  'pasture', 'pasture', 'pasture', 'pasture',
  'fields', 'fields', 'fields', 'fields',
  'hills', 'hills', 'hills',
  'mountains', 'mountains', 'mountains',
  'desert',
];

const NUMBER_POOL = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

const TERRAIN_RESOURCE = {
  forest: 'wood',
  pasture: 'sheep',
  fields: 'wheat',
  hills: 'brick',
  mountains: 'ore',
  desert: null,
};

// Orden clasico de puertos recorriendo la costa: 4 genericos 3:1 y 5 especificos 2:1.
const PORT_TYPES = ['any', 'sheep', 'any', 'ore', 'wheat', 'any', 'wood', 'brick', 'any'];
// Separacion en vertices entre el final de un puerto y el inicio del siguiente (suma 12,
// que con 9 puertos de 2 vertices cubre los 30 vertices costeros).
const PORT_GAPS = [1, 1, 2, 1, 1, 2, 1, 1, 2];

function axialToPixel(q, r) {
  return {
    x: Math.sqrt(3) * (q + r / 2),
    y: 1.5 * r,
  };
}

function hexCorner(cx, cy, i) {
  const angle = (Math.PI / 180) * (60 * i - 30);
  return { x: cx + Math.cos(angle), y: cy + Math.sin(angle) };
}

function coordKey(x, y) {
  return `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
}

function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Devuelve las 19 coordenadas axiales de tierra (radio 2) en orden estable.
function landCoords() {
  const coords = [];
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      const s = -q - r;
      if (Math.abs(s) <= 2) coords.push({ q, r });
    }
  }
  return coords;
}

// Anillo de mar (radio 3), solo para render del marco.
function seaCoords() {
  const coords = [];
  for (let q = -3; q <= 3; q++) {
    for (let r = -3; r <= 3; r++) {
      const s = -q - r;
      const dist = Math.max(Math.abs(q), Math.abs(r), Math.abs(s));
      if (dist === 3) coords.push({ q, r });
    }
  }
  return coords;
}

function axialNeighbors(q, r) {
  return [
    { q: q + 1, r }, { q: q - 1, r },
    { q, r: r + 1 }, { q, r: r - 1 },
    { q: q + 1, r: r - 1 }, { q: q - 1, r: r + 1 },
  ];
}

/**
 * Genera un tablero completo.
 * @param {() => number} rng - funcion tipo Math.random, inyectable para tests.
 * @returns {object} board con hexes, vertices, edges, ports y adyacencias.
 */
function generateBoard(rng = Math.random) {
  const coords = landCoords();

  // Terrenos y numeros: se rebaraja hasta que ningun 6/8 quede adyacente a otro 6/8.
  let hexes;
  for (let attempt = 0; attempt < 500; attempt++) {
    const terrains = shuffled(TERRAIN_POOL, rng);
    const numbers = shuffled(NUMBER_POOL, rng);
    let ni = 0;
    hexes = coords.map((c, i) => {
      const terrain = terrains[i];
      const number = terrain === 'desert' ? null : numbers[ni++];
      const { x, y } = axialToPixel(c.q, c.r);
      return { id: i, q: c.q, r: c.r, x, y, terrain, number, resource: TERRAIN_RESOURCE[terrain] };
    });
    if (!hasAdjacentRedNumbers(hexes)) break;
  }

  const hexByAxial = new Map(hexes.map((h) => [`${h.q},${h.r}`, h]));

  // Vertices y aristas deduplicados por posicion.
  const vertexByKey = new Map();
  const vertices = [];
  const edgeByKey = new Map();
  const edges = [];

  for (const hex of hexes) {
    const cornerIds = [];
    for (let i = 0; i < 6; i++) {
      const p = hexCorner(hex.x, hex.y, i);
      const key = coordKey(p.x, p.y);
      let v = vertexByKey.get(key);
      if (!v) {
        v = { id: vertices.length, x: p.x, y: p.y, hexes: [], edges: [], neighbors: [] };
        vertexByKey.set(key, v);
        vertices.push(v);
      }
      v.hexes.push(hex.id);
      cornerIds.push(v.id);
    }
    hex.vertices = cornerIds;

    for (let i = 0; i < 6; i++) {
      const a = cornerIds[i];
      const b = cornerIds[(i + 1) % 6];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      let e = edgeByKey.get(key);
      if (!e) {
        e = { id: edges.length, v1: Math.min(a, b), v2: Math.max(a, b), hexes: [] };
        edgeByKey.set(key, e);
        edges.push(e);
      }
      e.hexes.push(hex.id);
    }
  }

  for (const e of edges) {
    vertices[e.v1].edges.push(e.id);
    vertices[e.v2].edges.push(e.id);
    vertices[e.v1].neighbors.push(e.v2);
    vertices[e.v2].neighbors.push(e.v1);
  }

  const ports = placePorts(hexes, vertices, edges, hexByAxial);

  // El ladron arranca en el desierto.
  const desertHex = hexes.find((h) => h.terrain === 'desert');

  return {
    hexes,
    vertices: vertices.map((v) => ({
      id: v.id, x: v.x, y: v.y, hexes: v.hexes, edges: v.edges, neighbors: v.neighbors,
    })),
    edges,
    ports,
    sea: seaCoords().map((c) => ({ ...c, ...axialToPixel(c.q, c.r) })),
    robberHex: desertHex.id,
  };
}

function hasAdjacentRedNumbers(hexes) {
  const byAxial = new Map(hexes.map((h) => [`${h.q},${h.r}`, h]));
  for (const h of hexes) {
    if (h.number !== 6 && h.number !== 8) continue;
    for (const n of axialNeighbors(h.q, h.r)) {
      const other = byAxial.get(`${n.q},${n.r}`);
      if (other && (other.number === 6 || other.number === 8)) return true;
    }
  }
  return false;
}

// Recorre el perimetro costero como ciclo ordenado de vertices y ubica los 9 puertos.
function placePorts(hexes, vertices, edges, hexByAxial) {
  const coastalEdges = edges.filter((e) => e.hexes.length === 1);
  const nextByVertex = new Map();
  for (const e of coastalEdges) {
    if (!nextByVertex.has(e.v1)) nextByVertex.set(e.v1, []);
    if (!nextByVertex.has(e.v2)) nextByVertex.set(e.v2, []);
    nextByVertex.get(e.v1).push(e.v2);
    nextByVertex.get(e.v2).push(e.v1);
  }

  // Camina el ciclo costero empezando por el vertice costero de menor id.
  const start = Math.min(...nextByVertex.keys());
  const cycle = [start];
  let prev = -1;
  let cur = start;
  while (true) {
    const options = nextByVertex.get(cur);
    const next = options[0] === prev ? options[1] : options[0];
    if (next === start) break;
    cycle.push(next);
    prev = cur;
    cur = next;
  }

  const ports = [];
  let pos = 0;
  for (let i = 0; i < PORT_TYPES.length; i++) {
    const v1 = cycle[pos % cycle.length];
    const v2 = cycle[(pos + 1) % cycle.length];
    // Punto exterior para render: se aleja del centroide de los hexes vecinos.
    const mx = (vertices[v1].x + vertices[v2].x) / 2;
    const my = (vertices[v1].y + vertices[v2].y) / 2;
    const len = Math.hypot(mx, my) || 1;
    ports.push({
      id: i,
      type: PORT_TYPES[i],
      ratio: PORT_TYPES[i] === 'any' ? 3 : 2,
      vertices: [v1, v2],
      outX: mx + (mx / len) * 0.9,
      outY: my + (my / len) * 0.9,
    });
    pos += 2 + PORT_GAPS[i];
  }
  return ports;
}

module.exports = { generateBoard, TERRAIN_RESOURCE, landCoords };
