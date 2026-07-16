'use strict';

// Maquina de estados de una partida de Catan base completa.
// El server es autoritativo: cada metodo valida jugador, fase y recursos.
// Todos los metodos de accion devuelven { ok: true } o { ok: false, error }.

const { generateBoard } = require('./board');
const R = require('./rules');
const {
  RESOURCES, COSTS, DEV_DECK, PIECES, BANK_PER_RESOURCE, VP_TO_WIN,
  PLAYER_COLORS, PLAYER_COLOR_NAMES,
} = require('./constants');

function emptyHand() {
  return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
}

function emptyDevCards() {
  return { knight: 0, victoryPoint: 0, roadBuilding: 0, yearOfPlenty: 0, monopoly: 0 };
}

function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Game {
  constructor(playerNames, rng = Math.random) {
    this.rng = rng;
    this.board = generateBoard(rng);
    this.players = playerNames.map((name, i) => ({
      name,
      color: PLAYER_COLORS[i],
      colorName: PLAYER_COLOR_NAMES[i],
      resources: emptyHand(),
      devCards: emptyDevCards(),
      newDevCards: emptyDevCards(), // compradas este turno, no jugables aun
      playedKnights: 0,
      roads: [],
      settlements: [],
      cities: [],
    }));
    this.bank = { wood: BANK_PER_RESOURCE, brick: BANK_PER_RESOURCE, sheep: BANK_PER_RESOURCE, wheat: BANK_PER_RESOURCE, ore: BANK_PER_RESOURCE };
    this.devDeck = shuffled(DEV_DECK, rng);
    this.robberHex = this.board.robberHex;

    this.phase = 'setup';
    // Orden serpiente: ida y vuelta; cada parada pide poblado + camino.
    const n = playerNames.length;
    this.setupOrder = [...Array(n).keys(), ...[...Array(n).keys()].reverse()];
    this.setupIndex = 0;
    this.setupExpecting = 'settlement';
    this.lastSetupVertex = null;

    this.turn = this.setupOrder[0];
    this.subPhase = null; // en play: roll | main | discard | robber | steal | freeRoads
    this.returnSubPhase = null; // adonde volver tras caballero pre-tirada
    this.pendingDiscards = {}; // playerIdx -> cantidad a descartar
    this.stealCandidates = [];
    this.freeRoadsLeft = 0;
    this.devPlayedThisTurn = false;
    this.tradeOffer = null;
    this.dice = null;
    this.winner = null;
    this.longestRoad = { holder: null, length: 0 };
    this.largestArmy = { holder: null, count: 0 };
    this.log = [];
    this._log(`Comienza la partida. Coloca ${this.players[this.turn].name}.`);
  }

  _log(msg) {
    this.log.push(msg);
    if (this.log.length > 200) this.log.shift();
  }

  _err(error) { return { ok: false, error }; }

  _requireTurn(p) {
    if (this.winner !== null) return 'La partida ya termino.';
    if (p !== this.turn) return 'No es tu turno.';
    return null;
  }

  // ---------- Puntos de victoria ----------

  victoryPoints(p, includeHidden = true) {
    const pl = this.players[p];
    let vp = pl.settlements.length + pl.cities.length * 2;
    if (this.longestRoad.holder === p) vp += 2;
    if (this.largestArmy.holder === p) vp += 2;
    if (includeHidden) vp += pl.devCards.victoryPoint + pl.newDevCards.victoryPoint;
    return vp;
  }

  _checkWin(p) {
    if (this.winner === null && this.victoryPoints(p) >= VP_TO_WIN) {
      this.winner = p;
      this.phase = 'ended';
      this._log(`${this.players[p].name} gana la partida con ${this.victoryPoints(p)} puntos.`);
    }
  }

  // ---------- Setup ----------

  placeSetupSettlement(p, vertexId) {
    const e = this._requireTurn(p);
    if (e) return this._err(e);
    if (this.phase !== 'setup' || this.setupExpecting !== 'settlement') return this._err('No corresponde colocar poblado ahora.');
    if (vertexId == null || !this.board.vertices[vertexId]) return this._err('Vertice invalido.');
    if (!R.respectsDistanceRule(this.board, this.players, vertexId)) return this._err('Muy cerca de otro poblado.');

    this.players[p].settlements.push(vertexId);
    this.lastSetupVertex = vertexId;
    this.setupExpecting = 'road';
    this._log(`${this.players[p].name} coloca un poblado.`);

    // Segundo poblado (segunda ronda): recursos iniciales de los hexes adyacentes.
    if (this.setupIndex >= this.players.length) {
      for (const hexId of this.board.vertices[vertexId].hexes) {
        const hex = this.board.hexes[hexId];
        if (hex.resource && this.bank[hex.resource] > 0) {
          this.bank[hex.resource]--;
          this.players[p].resources[hex.resource]++;
        }
      }
    }
    return { ok: true };
  }

  placeSetupRoad(p, edgeId) {
    const e = this._requireTurn(p);
    if (e) return this._err(e);
    if (this.phase !== 'setup' || this.setupExpecting !== 'road') return this._err('No corresponde colocar camino ahora.');
    const edge = this.board.edges[edgeId];
    if (!edge) return this._err('Arista invalida.');
    if (R.roadAt(this.players, edgeId) !== null) return this._err('Arista ocupada.');
    if (edge.v1 !== this.lastSetupVertex && edge.v2 !== this.lastSetupVertex) {
      return this._err('El camino debe tocar el poblado recien colocado.');
    }

    this.players[p].roads.push(edgeId);
    this._log(`${this.players[p].name} coloca un camino.`);

    this.setupIndex++;
    if (this.setupIndex >= this.setupOrder.length) {
      this.phase = 'play';
      this.turn = 0;
      this.subPhase = 'roll';
      this._log(`Termina la colocacion. Empieza ${this.players[0].name}.`);
    } else {
      this.turn = this.setupOrder[this.setupIndex];
      this.setupExpecting = 'settlement';
      this._log(`Coloca ${this.players[this.turn].name}.`);
    }
    return { ok: true };
  }

  // ---------- Tirada y reparto ----------

  rollDice(p) {
    const e = this._requireTurn(p);
    if (e) return this._err(e);
    if (this.phase !== 'play' || this.subPhase !== 'roll') return this._err('Ya tiraste los dados.');

    const d1 = 1 + Math.floor(this.rng() * 6);
    const d2 = 1 + Math.floor(this.rng() * 6);
    this.dice = [d1, d2];
    const roll = d1 + d2;
    this._log(`${this.players[p].name} tira ${d1} + ${d2} = ${roll}.`);

    if (roll === 7) {
      this.pendingDiscards = {};
      this.players.forEach((pl, i) => {
        const count = R.countResources(pl.resources);
        if (count > 7) this.pendingDiscards[i] = Math.floor(count / 2);
      });
      if (Object.keys(this.pendingDiscards).length > 0) {
        this.subPhase = 'discard';
        this._log('Sale un 7: hay manos con mas de 7 cartas que deben descartar la mitad.');
      } else {
        this.subPhase = 'robber';
        this._log('Sale un 7: hay que mover al ladron.');
      }
      return { ok: true };
    }

    const { gains, shortages } = R.computeDistribution(this.board, this.players, roll, this.robberHex, this.bank);
    gains.forEach((hand, i) => {
      for (const res of Object.keys(hand)) {
        this.bank[res] -= hand[res];
        this.players[i].resources[res] += hand[res];
      }
      const total = R.countResources(hand);
      if (total > 0) this._log(`${this.players[i].name} recibe ${this._handText(hand)}.`);
    });
    for (const res of shortages) this._log(`El banco no tiene suficiente ${res}: reparto anulado.`);
    this.subPhase = 'main';
    return { ok: true };
  }

  _handText(hand) {
    const names = { wood: 'madera', brick: 'ladrillo', sheep: 'oveja', wheat: 'trigo', ore: 'mineral' };
    return Object.keys(hand).filter((r) => hand[r] > 0).map((r) => `${hand[r]} ${names[r]}`).join(', ');
  }

  // ---------- Descartes y ladron ----------

  discard(p, hand) {
    if (this.subPhase !== 'discard') return this._err('No hay descartes pendientes.');
    const required = this.pendingDiscards[p];
    if (!required) return this._err('No tenes que descartar.');
    const total = R.countResources(hand);
    if (total !== required) return this._err(`Tenes que descartar exactamente ${required} cartas.`);
    if (!R.hasResources(this.players[p].resources, hand)) return this._err('No tenes esas cartas.');

    for (const res of Object.keys(hand)) {
      this.players[p].resources[res] -= hand[res] || 0;
      this.bank[res] += hand[res] || 0;
    }
    delete this.pendingDiscards[p];
    this._log(`${this.players[p].name} descarta ${total} cartas.`);

    if (Object.keys(this.pendingDiscards).length === 0) {
      this.subPhase = 'robber';
      this._log(`${this.players[this.turn].name} debe mover al ladron.`);
    }
    return { ok: true };
  }

  moveRobber(p, hexId) {
    const e = this._requireTurn(p);
    if (e) return this._err(e);
    if (this.subPhase !== 'robber') return this._err('No corresponde mover al ladron.');
    const hex = this.board.hexes[hexId];
    if (!hex) return this._err('Hex invalido.');
    if (hexId === this.robberHex) return this._err('El ladron debe moverse a otro hex.');

    this.robberHex = hexId;
    this._log(`${this.players[p].name} mueve al ladron.`);

    // Victimas posibles: jugadores rivales con edificio adyacente y cartas en mano.
    const victims = new Set();
    for (const v of hex.vertices) {
      const b = R.buildingAt(this.players, v);
      if (b && b.player !== p && R.countResources(this.players[b.player].resources) > 0) {
        victims.add(b.player);
      }
    }
    this.stealCandidates = [...victims];

    if (this.stealCandidates.length === 0) {
      this._afterRobber();
    } else if (this.stealCandidates.length === 1) {
      this._steal(p, this.stealCandidates[0]);
      this._afterRobber();
    } else {
      this.subPhase = 'steal';
    }
    return { ok: true };
  }

  stealFrom(p, victimIdx) {
    const e = this._requireTurn(p);
    if (e) return this._err(e);
    if (this.subPhase !== 'steal') return this._err('No corresponde robar ahora.');
    if (!this.stealCandidates.includes(victimIdx)) return this._err('No podes robarle a ese jugador.');
    this._steal(p, victimIdx);
    this._afterRobber();
    return { ok: true };
  }

  _steal(p, victimIdx) {
    const victim = this.players[victimIdx];
    const pool = [];
    for (const res of RESOURCES) for (let i = 0; i < victim.resources[res]; i++) pool.push(res);
    if (pool.length === 0) return;
    const res = pool[Math.floor(this.rng() * pool.length)];
    victim.resources[res]--;
    this.players[p].resources[res]++;
    this._log(`${this.players[p].name} le roba una carta a ${victim.name}.`);
  }

  _afterRobber() {
    this.stealCandidates = [];
    if (this.returnSubPhase) {
      this.subPhase = this.returnSubPhase;
      this.returnSubPhase = null;
    } else {
      this.subPhase = 'main';
    }
  }

  // ---------- Construccion ----------

  _pay(p, cost) {
    for (const res of Object.keys(cost)) {
      this.players[p].resources[res] -= cost[res];
      this.bank[res] += cost[res];
    }
  }

  _requireMain(p) {
    const e = this._requireTurn(p);
    if (e) return e;
    if (this.phase !== 'play' || this.subPhase !== 'main') return 'Solo puede hacerse en la fase principal del turno.';
    return null;
  }

  buildRoad(p, edgeId) {
    const e = this._requireMain(p);
    if (e) return this._err(e);
    const pl = this.players[p];
    if (pl.roads.length >= PIECES.roads) return this._err('No te quedan caminos.');
    if (!R.hasResources(pl.resources, COSTS.road)) return this._err('Te faltan recursos (1 madera, 1 ladrillo).');
    if (!this.board.edges[edgeId] || !R.canPlaceRoad(this.board, this.players, p, edgeId)) return this._err('No podes construir un camino ahi.');

    this._pay(p, COSTS.road);
    pl.roads.push(edgeId);
    this._log(`${pl.name} construye un camino.`);
    this._updateLongestRoad();
    this._checkWin(p);
    return { ok: true };
  }

  buildSettlement(p, vertexId) {
    const e = this._requireMain(p);
    if (e) return this._err(e);
    const pl = this.players[p];
    if (pl.settlements.length >= PIECES.settlements) return this._err('No te quedan poblados.');
    if (!R.hasResources(pl.resources, COSTS.settlement)) return this._err('Te faltan recursos (madera, ladrillo, oveja, trigo).');
    if (this.board.vertices[vertexId] == null || !R.canPlaceSettlement(this.board, this.players, p, vertexId)) {
      return this._err('No podes construir un poblado ahi.');
    }

    this._pay(p, COSTS.settlement);
    pl.settlements.push(vertexId);
    this._log(`${pl.name} construye un poblado.`);
    this._updateLongestRoad(); // un poblado puede cortar la ruta de un rival
    this._checkWin(p);
    return { ok: true };
  }

  buildCity(p, vertexId) {
    const e = this._requireMain(p);
    if (e) return this._err(e);
    const pl = this.players[p];
    if (pl.cities.length >= PIECES.cities) return this._err('No te quedan ciudades.');
    if (!R.hasResources(pl.resources, COSTS.city)) return this._err('Te faltan recursos (2 trigo, 3 mineral).');
    const idx = pl.settlements.indexOf(vertexId);
    if (idx === -1) return this._err('Solo podes mejorar un poblado propio.');

    this._pay(p, COSTS.city);
    pl.settlements.splice(idx, 1);
    pl.cities.push(vertexId);
    this._log(`${pl.name} mejora un poblado a ciudad.`);
    this._checkWin(p);
    return { ok: true };
  }

  // ---------- Cartas de desarrollo ----------

  buyDevCard(p) {
    const e = this._requireMain(p);
    if (e) return this._err(e);
    if (this.devDeck.length === 0) return this._err('No quedan cartas de desarrollo.');
    if (!R.hasResources(this.players[p].resources, COSTS.devCard)) return this._err('Te faltan recursos (oveja, trigo, mineral).');

    this._pay(p, COSTS.devCard);
    const card = this.devDeck.pop();
    this.players[p].newDevCards[card]++;
    this._log(`${this.players[p].name} compra una carta de desarrollo.`);
    this._checkWin(p); // por si es la carta de punto de victoria que llega a 10
    return { ok: true };
  }

  _canPlayDev(p, card) {
    if (this.winner !== null) return 'La partida ya termino.';
    if (p !== this.turn) return 'No es tu turno.';
    if (this.phase !== 'play') return 'Todavia no empezo la partida.';
    if (!['roll', 'main'].includes(this.subPhase)) return 'No podes jugar cartas ahora.';
    if (this.devPlayedThisTurn) return 'Ya jugaste una carta de desarrollo este turno.';
    if (this.players[p].devCards[card] < 1) return 'No tenes esa carta (las compradas este turno no se pueden jugar).';
    return null;
  }

  playKnight(p) {
    const e = this._canPlayDev(p, 'knight');
    if (e) return this._err(e);
    this.players[p].devCards.knight--;
    this.players[p].playedKnights++;
    this.devPlayedThisTurn = true;
    this._log(`${this.players[p].name} juega un caballero.`);
    this._updateLargestArmy(p);
    if (this.subPhase === 'roll') this.returnSubPhase = 'roll';
    this.subPhase = 'robber';
    this._checkWin(p);
    return { ok: true };
  }

  playRoadBuilding(p) {
    const e = this._canPlayDev(p, 'roadBuilding');
    if (e) return this._err(e);
    if (this.players[p].roads.length >= PIECES.roads) return this._err('No te quedan caminos.');
    if (!this._hasLegalRoad(p)) return this._err('No tenes ningun lugar donde construir caminos.');
    this.players[p].devCards.roadBuilding--;
    this.devPlayedThisTurn = true;
    this.freeRoadsLeft = Math.min(2, PIECES.roads - this.players[p].roads.length);
    // Jugada antes de tirar: al terminar los caminos gratis se vuelve a la tirada.
    if (this.subPhase === 'roll') this.returnSubPhase = 'roll';
    this.subPhase = 'freeRoads';
    this._log(`${this.players[p].name} juega Construccion de caminos.`);
    return { ok: true };
  }

  _hasLegalRoad(p) {
    return this.board.edges.some((e) => R.canPlaceRoad(this.board, this.players, p, e.id));
  }

  placeFreeRoad(p, edgeId) {
    const e = this._requireTurn(p);
    if (e) return this._err(e);
    if (this.subPhase !== 'freeRoads') return this._err('No hay caminos gratis pendientes.');
    if (!this.board.edges[edgeId] || !R.canPlaceRoad(this.board, this.players, p, edgeId)) return this._err('No podes construir un camino ahi.');

    this.players[p].roads.push(edgeId);
    this.freeRoadsLeft--;
    this._log(`${this.players[p].name} coloca un camino gratis.`);
    this._updateLongestRoad();
    this._checkWin(p);
    // Sin lugares legales restantes, el segundo camino gratis se pierde.
    if (this.freeRoadsLeft > 0 && !this._hasLegalRoad(p)) {
      this.freeRoadsLeft = 0;
      this._log('No quedan lugares para el otro camino gratis.');
    }
    if (this.freeRoadsLeft <= 0 && this.winner === null) {
      this.subPhase = this.returnSubPhase || 'main';
      this.returnSubPhase = null;
    }
    return { ok: true };
  }

  playYearOfPlenty(p, res1, res2) {
    const e = this._canPlayDev(p, 'yearOfPlenty');
    if (e) return this._err(e);
    if (!RESOURCES.includes(res1) || !RESOURCES.includes(res2)) return this._err('Recurso invalido.');
    const need = {};
    need[res1] = (need[res1] || 0) + 1;
    need[res2] = (need[res2] || 0) + 1;
    for (const r of Object.keys(need)) {
      if (this.bank[r] < need[r]) return this._err(`El banco no tiene suficiente ${r}.`);
    }
    this.players[p].devCards.yearOfPlenty--;
    this.devPlayedThisTurn = true;
    for (const r of Object.keys(need)) {
      this.bank[r] -= need[r];
      this.players[p].resources[r] += need[r];
    }
    this._log(`${this.players[p].name} juega Año de la abundancia y toma ${this._handText(need)}.`);
    return { ok: true };
  }

  playMonopoly(p, res) {
    const e = this._canPlayDev(p, 'monopoly');
    if (e) return this._err(e);
    if (!RESOURCES.includes(res)) return this._err('Recurso invalido.');
    this.players[p].devCards.monopoly--;
    this.devPlayedThisTurn = true;
    let taken = 0;
    this.players.forEach((pl, i) => {
      if (i === p) return;
      taken += pl.resources[res];
      this.players[p].resources[res] += pl.resources[res];
      pl.resources[res] = 0;
    });
    this._log(`${this.players[p].name} juega Monopolio y se lleva ${taken} de ese recurso.`);
    return { ok: true };
  }

  // ---------- Comercio ----------

  bankTrade(p, give, get) {
    const e = this._requireMain(p);
    if (e) return this._err(e);
    const giveRes = Object.keys(give).filter((r) => give[r] > 0);
    const getRes = Object.keys(get).filter((r) => get[r] > 0);
    if (giveRes.length !== 1 || getRes.length !== 1) return this._err('El intercambio con el banco es un recurso por otro.');
    const [gr] = giveRes;
    const [tr] = getRes;
    if (!RESOURCES.includes(gr) || !RESOURCES.includes(tr) || gr === tr) return this._err('Recursos invalidos.');
    const ratio = R.tradeRatio(this.board, this.players, p, gr);
    if (give[gr] !== ratio * get[tr]) return this._err(`Tu ratio para ese recurso es ${ratio}:1.`);
    if (this.players[p].resources[gr] < give[gr]) return this._err('No tenes suficientes cartas.');
    if (this.bank[tr] < get[tr]) return this._err('El banco no tiene ese recurso.');

    this.players[p].resources[gr] -= give[gr];
    this.bank[gr] += give[gr];
    this.bank[tr] -= get[tr];
    this.players[p].resources[tr] += get[tr];
    this._log(`${this.players[p].name} cambia ${give[gr]} ${gr} por ${get[tr]} ${tr} con el banco.`);
    return { ok: true };
  }

  offerTrade(p, give, get) {
    const e = this._requireMain(p);
    if (e) return this._err(e);
    // Una oferta nueva reemplaza a la propia anterior (comerciar varias veces
    // por turno es perfectamente legal).
    if (this.tradeOffer && this.tradeOffer.from !== p) return this._err('Hay una oferta de otro jugador activa.');
    const clean = (h) => {
      const out = {};
      for (const r of RESOURCES) if (h && h[r] > 0) out[r] = Math.floor(h[r]);
      return out;
    };
    give = clean(give);
    get = clean(get);
    if (R.countResources(give) === 0 || R.countResources(get) === 0) return this._err('La oferta debe dar y pedir algo.');
    // Regla oficial: no se puede comerciar el mismo recurso en ambos lados (regalo encubierto).
    for (const r of RESOURCES) {
      if (give[r] && get[r]) return this._err('No podes dar y pedir el mismo recurso.');
    }
    if (!R.hasResources(this.players[p].resources, give)) return this._err('No tenes esas cartas para ofrecer.');
    this.tradeOffer = { from: p, give, get, responses: {} };
    this._log(`${this.players[p].name} ofrece ${this._handText(give)} a cambio de ${this._handText(get)}.`);
    return { ok: true };
  }

  respondTrade(p, accept) {
    if (!this.tradeOffer) return this._err('No hay ninguna oferta.');
    if (p === this.tradeOffer.from) return this._err('La oferta es tuya.');
    if (accept && !R.hasResources(this.players[p].resources, this.tradeOffer.get)) {
      return this._err('No tenes las cartas que pide la oferta.');
    }
    this.tradeOffer.responses[p] = accept ? 'accepted' : 'rejected';
    this._log(`${this.players[p].name} ${accept ? 'acepta' : 'rechaza'} la oferta.`);

    // Si TODOS los rivales rechazaron, la oferta muere sola (el oferente
    // queda libre para ofertar de nuevo sin retirarla a mano).
    const rejections = Object.values(this.tradeOffer.responses).filter((r) => r === 'rejected').length;
    if (rejections === this.players.length - 1) {
      this.tradeOffer = null;
      this._log('Nadie acepto la oferta: queda retirada.');
    }
    return { ok: true };
  }

  confirmTrade(p, withIdx) {
    const e = this._requireMain(p);
    if (e) return this._err(e);
    if (!this.tradeOffer || this.tradeOffer.from !== p) return this._err('No hay una oferta tuya activa.');
    if (this.tradeOffer.responses[withIdx] !== 'accepted') return this._err('Ese jugador no acepto la oferta.');
    const { give, get } = this.tradeOffer;
    const other = this.players[withIdx];
    if (!R.hasResources(this.players[p].resources, give)) return this._err('Ya no tenes las cartas ofrecidas.');
    if (!R.hasResources(other.resources, get)) return this._err('El otro jugador ya no tiene las cartas.');

    for (const r of Object.keys(give)) { this.players[p].resources[r] -= give[r]; other.resources[r] += give[r]; }
    for (const r of Object.keys(get)) { other.resources[r] -= get[r]; this.players[p].resources[r] += get[r]; }
    this._log(`${this.players[p].name} y ${other.name} concretan el intercambio.`);
    this.tradeOffer = null;
    return { ok: true };
  }

  cancelTrade(p) {
    if (!this.tradeOffer || this.tradeOffer.from !== p) return this._err('No hay una oferta tuya activa.');
    this.tradeOffer = null;
    this._log(`${this.players[p].name} retira la oferta.`);
    return { ok: true };
  }

  // ---------- Fin de turno ----------

  endTurn(p) {
    const e = this._requireTurn(p);
    if (e) return this._err(e);
    if (this.phase !== 'play' || this.subPhase !== 'main') return this._err('Termina las acciones pendientes antes de pasar.');

    // Las cartas compradas este turno pasan a estar disponibles.
    const pl = this.players[p];
    for (const c of Object.keys(pl.newDevCards)) {
      pl.devCards[c] += pl.newDevCards[c];
      pl.newDevCards[c] = 0;
    }
    this.tradeOffer = null;
    this.devPlayedThisTurn = false;
    this.dice = null;
    this.turn = (this.turn + 1) % this.players.length;
    this.subPhase = 'roll';
    this._log(`Turno de ${this.players[this.turn].name}.`);
    // Regla oficial: tambien se gana al LLEGAR tu turno con 10+ puntos
    // (p. ej. si te transfirieron la Gran Ruta fuera de tu turno).
    this._checkWin(this.turn);
    return { ok: true };
  }

  // ---------- Cartas especiales ----------

  _updateLongestRoad() {
    const lengths = this.players.map((_, i) => R.longestRoadLength(this.board, this.players, i));
    const holder = this.longestRoad.holder;

    if (holder !== null) {
      this.longestRoad.length = lengths[holder];
      // Alguien supera estrictamente al poseedor actual
      const max = Math.max(...lengths);
      if (max > lengths[holder] && max >= 5) {
        const leaders = lengths.map((l, i) => (l === max ? i : -1)).filter((i) => i >= 0);
        if (leaders.length === 1) {
          this.longestRoad = { holder: leaders[0], length: max };
          this._log(`${this.players[leaders[0]].name} toma la Gran Ruta Comercial (${max}).`);
        } else {
          this.longestRoad = { holder: null, length: 0 };
          this._log('La Gran Ruta Comercial queda sin dueño por empate.');
        }
      } else if (lengths[holder] < 5) {
        // El poseedor perdio la ruta (cortada): pasa al unico lider >= 5 o queda vacante
        const max2 = Math.max(...lengths);
        const leaders = lengths.map((l, i) => (l === max2 ? i : -1)).filter((i) => i >= 0);
        if (max2 >= 5 && leaders.length === 1) {
          this.longestRoad = { holder: leaders[0], length: max2 };
          this._log(`${this.players[leaders[0]].name} toma la Gran Ruta Comercial (${max2}).`);
        } else {
          this.longestRoad = { holder: null, length: 0 };
          this._log('La Gran Ruta Comercial queda vacante.');
        }
      }
    } else {
      const max = Math.max(...lengths);
      if (max >= 5) {
        const leaders = lengths.map((l, i) => (l === max ? i : -1)).filter((i) => i >= 0);
        if (leaders.length === 1) {
          this.longestRoad = { holder: leaders[0], length: max };
          this._log(`${this.players[leaders[0]].name} toma la Gran Ruta Comercial (${max}).`);
        }
      }
    }
  }

  _updateLargestArmy(p) {
    const knights = this.players[p].playedKnights;
    if (knights >= 3 && knights > this.largestArmy.count) {
      if (this.largestArmy.holder !== p) {
        this._log(`${this.players[p].name} toma el Gran Ejercito (${knights} caballeros).`);
      }
      this.largestArmy = { holder: p, count: knights };
    }
  }

  // ---------- Jugadas legales (para resaltar en el cliente) ----------

  _legalMoves(p) {
    if (p !== this.turn || this.winner !== null) return null;
    const legal = {};
    if (this.phase === 'setup') {
      if (this.setupExpecting === 'settlement') {
        legal.setupSettlements = this.board.vertices
          .filter((v) => R.respectsDistanceRule(this.board, this.players, v.id))
          .map((v) => v.id);
      } else {
        legal.setupRoads = this.board.vertices[this.lastSetupVertex].edges
          .filter((e) => R.roadAt(this.players, e) === null);
      }
      return legal;
    }
    if (this.subPhase === 'robber') {
      legal.robberHexes = this.board.hexes.filter((h) => h.id !== this.robberHex).map((h) => h.id);
      return legal;
    }
    if (this.subPhase === 'freeRoads' || this.subPhase === 'main') {
      legal.roads = this.board.edges
        .filter((e) => R.canPlaceRoad(this.board, this.players, p, e.id))
        .map((e) => e.id);
    }
    if (this.subPhase === 'main') {
      legal.settlements = this.board.vertices
        .filter((v) => R.canPlaceSettlement(this.board, this.players, p, v.id))
        .map((v) => v.id);
      legal.cities = this.players[p].settlements.slice();
      legal.ratios = {};
      for (const res of RESOURCES) legal.ratios[res] = R.tradeRatio(this.board, this.players, p, res);
    }
    return legal;
  }

  // ---------- Serializacion por jugador ----------

  serialize(forPlayer) {
    return {
      board: this.board,
      robberHex: this.robberHex,
      phase: this.phase,
      subPhase: this.subPhase,
      turn: this.turn,
      setupExpecting: this.phase === 'setup' ? this.setupExpecting : null,
      dice: this.dice,
      winner: this.winner,
      bank: this.bank,
      devDeckCount: this.devDeck.length,
      longestRoad: this.longestRoad,
      largestArmy: this.largestArmy,
      pendingDiscards: this.pendingDiscards,
      stealCandidates: this.stealCandidates,
      freeRoadsLeft: this.freeRoadsLeft,
      devPlayedThisTurn: this.devPlayedThisTurn,
      tradeOffer: this.tradeOffer,
      log: this.log.slice(-60),
      you: forPlayer,
      legal: this._legalMoves(forPlayer),
      players: this.players.map((pl, i) => ({
        name: pl.name,
        color: pl.color,
        colorName: pl.colorName,
        roads: pl.roads,
        settlements: pl.settlements,
        cities: pl.cities,
        playedKnights: pl.playedKnights,
        resourceCount: R.countResources(pl.resources),
        devCardCount: Object.values(pl.devCards).reduce((a, b) => a + b, 0)
          + Object.values(pl.newDevCards).reduce((a, b) => a + b, 0),
        vp: this.victoryPoints(i, i === forPlayer || this.winner !== null),
        publicVp: this.victoryPoints(i, this.winner !== null),
        ...(i === forPlayer ? { resources: pl.resources, devCards: pl.devCards, newDevCards: pl.newDevCards } : {}),
      })),
    };
  }
}

module.exports = { Game };
