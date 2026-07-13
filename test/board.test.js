'use strict';
const assert = require('assert');
const { generateBoard } = require('../server/game/board');

// RNG determinista simple para tests repetibles.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (let seed = 1; seed <= 25; seed++) {
  const b = generateBoard(mulberry32(seed));

  assert.strictEqual(b.hexes.length, 19, 'hexes');
  assert.strictEqual(b.vertices.length, 54, `vertices (seed ${seed}): ${b.vertices.length}`);
  assert.strictEqual(b.edges.length, 72, `edges (seed ${seed}): ${b.edges.length}`);
  assert.strictEqual(b.sea.length, 18, 'anillo de mar');

  const terrainCount = {};
  for (const h of b.hexes) terrainCount[h.terrain] = (terrainCount[h.terrain] || 0) + 1;
  assert.deepStrictEqual(terrainCount, {
    forest: 4, pasture: 4, fields: 4, hills: 3, mountains: 3, desert: 1,
  });

  const desert = b.hexes.find((h) => h.terrain === 'desert');
  assert.strictEqual(desert.number, null, 'desierto sin numero');
  assert.strictEqual(b.robberHex, desert.id, 'ladron en el desierto');

  const numbers = b.hexes.filter((h) => h.number !== null).map((h) => h.number).sort((a, z) => a - z);
  assert.deepStrictEqual(numbers, [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);

  // Regla 6/8: ningun par de rojos adyacentes.
  const byAxial = new Map(b.hexes.map((h) => [`${h.q},${h.r}`, h]));
  for (const h of b.hexes) {
    if (h.number !== 6 && h.number !== 8) continue;
    const neigh = [
      [h.q + 1, h.r], [h.q - 1, h.r], [h.q, h.r + 1],
      [h.q, h.r - 1], [h.q + 1, h.r - 1], [h.q - 1, h.r + 1],
    ];
    for (const [q, r] of neigh) {
      const o = byAxial.get(`${q},${r}`);
      if (o) assert.ok(o.number !== 6 && o.number !== 8, `6/8 adyacentes en seed ${seed}`);
    }
  }

  // Puertos: 9, 18 vertices distintos, todos costeros.
  assert.strictEqual(b.ports.length, 9);
  const portVerts = b.ports.flatMap((p) => p.vertices);
  assert.strictEqual(new Set(portVerts).size, 18, 'vertices de puerto distintos');
  const coastal = new Set();
  for (const e of b.edges) if (e.hexes.length === 1) { coastal.add(e.v1); coastal.add(e.v2); }
  assert.strictEqual(coastal.size, 30, 'vertices costeros');
  for (const v of portVerts) assert.ok(coastal.has(v), `puerto en vertice no costero (seed ${seed})`);
  const ratios = b.ports.map((p) => p.ratio).sort();
  assert.deepStrictEqual(ratios, [2, 2, 2, 2, 2, 3, 3, 3, 3]);

  // Cada puerto ocupa una arista costera real (vertices adyacentes entre si).
  for (const p of b.ports) {
    const [v1, v2] = p.vertices;
    assert.ok(b.vertices[v1].neighbors.includes(v2), `puerto ${p.id} no es arista (seed ${seed})`);
  }

  // Adyacencias sanas: cada vertice tiene 2 o 3 vecinos, cada hex 6 vertices.
  for (const v of b.vertices) assert.ok(v.neighbors.length >= 2 && v.neighbors.length <= 3);
  for (const h of b.hexes) assert.strictEqual(new Set(h.vertices).size, 6);
}

console.log('board.test.js OK (25 seeds)');
