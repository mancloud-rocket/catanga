'use strict';
const assert = require('assert');
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

// Helper: hace el setup completo eligiendo vertices legales cualesquiera.
function autoSetup(g) {
  while (g.phase === 'setup') {
    const p = g.turn;
    if (g.setupExpecting === 'settlement') {
      const v = g.board.vertices.find((vv) => R.respectsDistanceRule(g.board, g.players, vv.id));
      assert.ok(g.placeSetupSettlement(p, v.id).ok);
    } else {
      const last = g.lastSetupVertex;
      const e = g.board.vertices[last].edges.find((ee) => R.roadAt(g.players, ee) === null);
      assert.ok(g.placeSetupRoad(p, e).ok);
    }
  }
}

// --- Setup: orden serpiente y recursos del segundo poblado ---
{
  const g = new Game(['Ana', 'Beto', 'Caro'], mulberry32(3));
  assert.strictEqual(g.phase, 'setup');
  assert.deepStrictEqual(g.setupOrder, [0, 1, 2, 2, 1, 0]);

  // Validaciones de turno
  assert.ok(!g.placeSetupSettlement(1, 0).ok, 'no es su turno');
  assert.ok(!g.placeSetupRoad(0, 0).ok, 'primero va poblado');

  autoSetup(g);
  assert.strictEqual(g.phase, 'play');
  assert.strictEqual(g.turn, 0);
  assert.strictEqual(g.subPhase, 'roll');
  for (const pl of g.players) {
    assert.strictEqual(pl.settlements.length, 2);
    assert.strictEqual(pl.roads.length, 2);
    // Segundo poblado da recursos (posiblemente 0 si toca desierto+costa, raro pero valido)
    assert.ok(R.countResources(pl.resources) <= 3);
  }
}

// --- Tirada, construccion y validaciones de recursos ---
{
  const g = new Game(['Ana', 'Beto'], mulberry32(5));
  autoSetup(g);
  assert.ok(!g.buildRoad(0, 0).ok, 'no se construye antes de tirar');
  assert.ok(g.rollDice(0).ok);
  if (g.subPhase === 'discard' || g.subPhase === 'robber') {
    // salio 7: resolver
    if (g.subPhase === 'discard') {
      for (const [pIdx, count] of Object.entries({ ...g.pendingDiscards })) {
        const pl = g.players[pIdx];
        const hand = {};
        let left = count;
        for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
          const take = Math.min(left, pl.resources[r]);
          if (take > 0) { hand[r] = take; left -= take; }
        }
        assert.ok(g.discard(Number(pIdx), hand).ok);
      }
    }
    const target = g.board.hexes.find((h) => h.id !== g.robberHex);
    assert.ok(g.moveRobber(0, target.id).ok);
    if (g.subPhase === 'steal') assert.ok(g.stealFrom(0, g.stealCandidates[0]).ok);
  }
  assert.strictEqual(g.subPhase, 'main');
  assert.ok(!g.rollDice(0).ok, 'no se tira dos veces');

  // Sin recursos suficientes: dar recursos a mano y construir
  g.players[0].resources = { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 };
  const legalEdge = g.board.edges.find((e) => R.canPlaceRoad(g.board, g.players, 0, e.id));
  assert.ok(g.buildRoad(0, legalEdge.id).ok);
  assert.strictEqual(R.countResources(g.players[0].resources), 0, 'pago el camino');
  assert.ok(!g.buildRoad(0, 0).ok, 'sin recursos falla');
}

// --- Ciudad, compra de dev y no jugarla el mismo turno ---
{
  const g = new Game(['Ana', 'Beto'], mulberry32(11));
  autoSetup(g);
  assert.ok(g.rollDice(0).ok);
  while (g.subPhase !== 'main') {
    if (g.subPhase === 'discard') {
      for (const [pIdx, count] of Object.entries({ ...g.pendingDiscards })) {
        const pl = g.players[pIdx];
        const hand = {};
        let left = count;
        for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
          const take = Math.min(left, pl.resources[r]); if (take) { hand[r] = take; left -= take; }
        }
        g.discard(Number(pIdx), hand);
      }
    } else if (g.subPhase === 'robber') {
      g.moveRobber(0, g.board.hexes.find((h) => h.id !== g.robberHex).id);
    } else if (g.subPhase === 'steal') {
      g.stealFrom(0, g.stealCandidates[0]);
    }
  }

  g.players[0].resources = { wood: 0, brick: 0, sheep: 1, wheat: 3, ore: 4 };
  const settlement = g.players[0].settlements[0];
  assert.ok(g.buildCity(0, settlement).ok);
  assert.strictEqual(g.players[0].cities.length, 1);
  assert.strictEqual(g.players[0].settlements.length, 1);
  assert.ok(!g.buildCity(0, settlement).ok, 'ya es ciudad');

  assert.ok(g.buyDevCard(0).ok);
  const card = Object.keys(g.players[0].newDevCards).find((c) => g.players[0].newDevCards[c] > 0);
  if (card === 'knight') assert.ok(!g.playKnight(0).ok, 'comprada este turno no se juega');

  assert.ok(g.endTurn(0).ok);
  assert.strictEqual(g.turn, 1);
  const total = Object.values(g.players[0].devCards).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 1, 'la carta paso a jugable');
}

// --- Caballero: mueve ladron, roba, gran ejercito ---
{
  const g = new Game(['Ana', 'Beto'], mulberry32(2));
  autoSetup(g);
  g.players[0].devCards.knight = 3;
  g.players[1].resources.wood = 2;

  for (let k = 0; k < 3; k++) {
    // jugar caballero antes de tirar es legal
    assert.ok(g.playKnight(0).ok);
    assert.strictEqual(g.subPhase, 'robber');
    // mover a un hex con edificio de Beto
    const bVert = g.players[1].settlements[0];
    const hexId = g.board.vertices[bVert].hexes.find((h) => h !== g.robberHex);
    assert.ok(g.moveRobber(0, hexId).ok);
    if (g.subPhase === 'steal') g.stealFrom(0, g.stealCandidates.find((c) => c === 1) ?? g.stealCandidates[0]);
    assert.strictEqual(g.subPhase, 'roll', 'vuelve a la fase de tirada');
    assert.ok(!g.playKnight(0).ok, 'solo una dev por turno');
    assert.ok(g.rollDice(0).ok);
    while (g.subPhase !== 'main') {
      if (g.subPhase === 'discard') {
        for (const [pIdx, count] of Object.entries({ ...g.pendingDiscards })) {
          const pl = g.players[pIdx]; const hand = {}; let left = count;
          for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
            const take = Math.min(left, pl.resources[r]); if (take) { hand[r] = take; left -= take; }
          }
          g.discard(Number(pIdx), hand);
        }
      } else if (g.subPhase === 'robber') {
        g.moveRobber(0, g.board.hexes.find((h) => h.id !== g.robberHex).id);
      } else if (g.subPhase === 'steal') {
        g.stealFrom(0, g.stealCandidates[0]);
      }
    }
    g.endTurn(0);
    // turno de Beto: pasa rapido
    g.rollDice(1);
    while (g.subPhase !== 'main') {
      if (g.subPhase === 'discard') {
        for (const [pIdx, count] of Object.entries({ ...g.pendingDiscards })) {
          const pl = g.players[pIdx]; const hand = {}; let left = count;
          for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
            const take = Math.min(left, pl.resources[r]); if (take) { hand[r] = take; left -= take; }
          }
          g.discard(Number(pIdx), hand);
        }
      } else if (g.subPhase === 'robber') {
        g.moveRobber(1, g.board.hexes.find((h) => h.id !== g.robberHex).id);
      } else if (g.subPhase === 'steal') {
        g.stealFrom(1, g.stealCandidates[0]);
      }
    }
    g.endTurn(1);
  }
  assert.strictEqual(g.players[0].playedKnights, 3);
  assert.strictEqual(g.largestArmy.holder, 0, 'gran ejercito para Ana');
  assert.ok(g.victoryPoints(0) >= 2 + 2, 'poblados + ejercito');
}

// --- Monopolio y año de la abundancia ---
{
  const g = new Game(['Ana', 'Beto', 'Caro'], mulberry32(9));
  autoSetup(g);
  g.rollDice(0);
  while (g.subPhase !== 'main') {
    if (g.subPhase === 'discard') {
      for (const [pIdx, count] of Object.entries({ ...g.pendingDiscards })) {
        const pl = g.players[pIdx]; const hand = {}; let left = count;
        for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
          const take = Math.min(left, pl.resources[r]); if (take) { hand[r] = take; left -= take; }
        }
        g.discard(Number(pIdx), hand);
      }
    } else if (g.subPhase === 'robber') g.moveRobber(0, g.board.hexes.find((h) => h.id !== g.robberHex).id);
    else if (g.subPhase === 'steal') g.stealFrom(0, g.stealCandidates[0]);
  }

  g.players[0].devCards.monopoly = 1;
  g.players[1].resources.wheat = 3;
  g.players[2].resources.wheat = 2;
  const before = g.players[0].resources.wheat;
  assert.ok(g.playMonopoly(0, 'wheat').ok);
  assert.strictEqual(g.players[0].resources.wheat, before + 5);
  assert.strictEqual(g.players[1].resources.wheat, 0);

  g.devPlayedThisTurn = false;
  g.players[0].devCards.yearOfPlenty = 1;
  const woodBefore = g.players[0].resources.wood;
  assert.ok(g.playYearOfPlenty(0, 'wood', 'wood').ok);
  assert.strictEqual(g.players[0].resources.wood, woodBefore + 2);
}

// --- Comercio banco y entre jugadores ---
{
  const g = new Game(['Ana', 'Beto'], mulberry32(13));
  autoSetup(g);
  g.rollDice(0);
  while (g.subPhase !== 'main') {
    if (g.subPhase === 'discard') {
      for (const [pIdx, count] of Object.entries({ ...g.pendingDiscards })) {
        const pl = g.players[pIdx]; const hand = {}; let left = count;
        for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
          const take = Math.min(left, pl.resources[r]); if (take) { hand[r] = take; left -= take; }
        }
        g.discard(Number(pIdx), hand);
      }
    } else if (g.subPhase === 'robber') g.moveRobber(0, g.board.hexes.find((h) => h.id !== g.robberHex).id);
    else if (g.subPhase === 'steal') g.stealFrom(0, g.stealCandidates[0]);
  }

  g.players[0].resources = { wood: 4, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  assert.ok(!g.bankTrade(0, { wood: 3 }, { ore: 1 }).ok, 'ratio equivocado');
  assert.ok(g.bankTrade(0, { wood: 4 }, { ore: 1 }).ok, '4:1 ok');
  assert.strictEqual(g.players[0].resources.ore, 1);

  // Oferta entre jugadores
  g.players[0].resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 1 };
  g.players[1].resources = { wood: 2, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  assert.ok(g.offerTrade(0, { ore: 1 }, { wood: 2 }).ok);
  assert.ok(!g.confirmTrade(0, 1).ok, 'sin aceptacion no se confirma');
  assert.ok(g.respondTrade(1, true).ok);
  assert.ok(g.confirmTrade(0, 1).ok);
  assert.strictEqual(g.players[0].resources.wood, 2);
  assert.strictEqual(g.players[1].resources.ore, 1);
  assert.strictEqual(g.tradeOffer, null);
}

// --- Serializacion: manos ocultas ---
{
  const g = new Game(['Ana', 'Beto'], mulberry32(17));
  autoSetup(g);
  const view = g.serialize(0);
  assert.ok(view.players[0].resources, 'mano propia visible');
  assert.strictEqual(view.players[1].resources, undefined, 'mano rival oculta');
  assert.strictEqual(view.players[1].devCards, undefined, 'devs rivales ocultas');
  assert.ok(typeof view.players[1].resourceCount === 'number');
}

// Helper: resuelve discard/robber/steal hasta quedar en main.
function resolveToMain(g) {
  while (g.subPhase !== 'main' && g.winner === null) {
    if (g.subPhase === 'discard') {
      for (const [pIdx, count] of Object.entries({ ...g.pendingDiscards })) {
        const pl = g.players[pIdx]; const hand = {}; let left = count;
        for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
          const take = Math.min(left, pl.resources[r]); if (take) { hand[r] = take; left -= take; }
        }
        g.discard(Number(pIdx), hand);
      }
    } else if (g.subPhase === 'robber') {
      g.moveRobber(g.turn, g.board.hexes.find((h) => h.id !== g.robberHex).id);
    } else if (g.subPhase === 'steal') {
      g.stealFrom(g.turn, g.stealCandidates[0]);
    }
  }
}

// --- Regla oficial: ganas al LLEGAR tu turno con 10+ PV ---
{
  const g = new Game(['Ana', 'Beto'], mulberry32(21));
  autoSetup(g);
  g.rollDice(0); resolveToMain(g);
  g.endTurn(0); // turno de Beto
  // Ana llega a 10 fuera de su turno (2 poblados + 8 PV ocultos)
  g.players[0].devCards.victoryPoint = 8;
  g.rollDice(1); resolveToMain(g);
  assert.strictEqual(g.winner, null, 'todavia no gano (no es su turno)');
  g.endTurn(1); // al llegar el turno de Ana, gana
  assert.strictEqual(g.winner, 0, 'Ana gana al llegar su turno');
}

// --- Cartas de progreso jugables antes de tirar ---
{
  const g = new Game(['Ana', 'Beto'], mulberry32(23));
  autoSetup(g);
  assert.strictEqual(g.subPhase, 'roll');
  g.players[0].devCards.roadBuilding = 1;
  assert.ok(g.playRoadBuilding(0).ok, 'roadBuilding antes de tirar');
  assert.strictEqual(g.subPhase, 'freeRoads');
  const R2 = require('../server/game/rules');
  for (let i = 0; i < 2; i++) {
    const e = g.board.edges.find((ee) => R2.canPlaceRoad(g.board, g.players, 0, ee.id));
    assert.ok(g.placeFreeRoad(0, e.id).ok, `camino gratis ${i + 1}`);
  }
  assert.strictEqual(g.subPhase, 'roll', 'vuelve a la tirada tras los caminos gratis');
  assert.ok(g.rollDice(0).ok, 'puede tirar despues');
}

// --- Monopolio antes de tirar ---
{
  const g = new Game(['Ana', 'Beto'], mulberry32(27));
  autoSetup(g);
  g.players[0].devCards.monopoly = 1;
  g.players[1].resources.ore = 2;
  assert.strictEqual(g.subPhase, 'roll');
  assert.ok(g.playMonopoly(0, 'ore').ok, 'monopolio pre-tirada');
  assert.strictEqual(g.subPhase, 'roll', 'sigue en fase de tirada');
  assert.ok(g.players[0].resources.ore >= 2, 'se llevo el mineral');
  assert.ok(g.rollDice(0).ok);
}

// --- Trade: mismo recurso en ambos lados prohibido ---
{
  const g = new Game(['Ana', 'Beto'], mulberry32(29));
  autoSetup(g);
  g.rollDice(0); resolveToMain(g);
  g.players[0].resources = { wood: 3, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  const r = g.offerTrade(0, { wood: 3 }, { wood: 1 });
  assert.ok(!r.ok, 'mismo recurso en ambos lados rechazado');
  assert.ok(g.offerTrade(0, { wood: 3 }, { ore: 1 }).ok, 'oferta valida ok');
}

// --- Trades: la oferta muere cuando todos rechazan y se puede reofertar ---
{
  const g = new Game(['Ana', 'Beto', 'Caro'], mulberry32(31));
  autoSetup(g);
  g.rollDice(0); resolveToMain(g);
  g.players[0].resources = { wood: 3, brick: 0, sheep: 0, wheat: 0, ore: 0 };

  assert.ok(g.offerTrade(0, { wood: 1 }, { ore: 1 }).ok);
  assert.ok(g.respondTrade(1, false).ok);
  assert.ok(g.tradeOffer !== null, 'con un solo rechazo sigue viva');
  assert.ok(g.respondTrade(2, false).ok);
  assert.strictEqual(g.tradeOffer, null, 'muere sola cuando todos rechazan');

  // reoferta inmediata sin tener que retirar nada
  assert.ok(g.offerTrade(0, { wood: 2 }, { wheat: 1 }).ok, 'puede ofertar de nuevo');
  // y una oferta nueva reemplaza a la propia anterior
  assert.ok(g.offerTrade(0, { wood: 1 }, { sheep: 1 }).ok, 'reemplaza su propia oferta');
  assert.strictEqual(g.tradeOffer.get.sheep, 1, 'quedo la ultima');
}

console.log('engine.test.js OK');
