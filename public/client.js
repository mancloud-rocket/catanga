// Cliente de Catan: manejo de socket, lobby y UI de partida.
// El server es autoritativo; este archivo solo pinta estado y envia acciones.

(function () {
  'use strict';

  const socket = io();

  const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
  const RES_NAME = { wood: 'Madera', brick: 'Ladrillo', sheep: 'Oveja', wheat: 'Trigo', ore: 'Mineral' };
  const RES_ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '⛰️' };
  const DEV_NAME = {
    knight: 'Caballero', victoryPoint: 'Punto de victoria', roadBuilding: 'Caminos',
    yearOfPlenty: 'Abundancia', monopoly: 'Monopolio',
  };
  const DEV_ICON = { knight: '⚔️', victoryPoint: '🏅', roadBuilding: '🛤️', yearOfPlenty: '🎁', monopoly: '🎩' };

  let state = null;       // gameState del server
  let lobby = null;       // roomUpdate del server
  let buildMode = null;   // 'road' | 'settlement' | 'city' | null
  let openModal = null;   // tipo de modal abierto, para no pisar inputs al rerender
  let discardSel = null;  // seleccion del modal de descarte
  let lastDice = null;

  const $ = (id) => document.getElementById(id);

  // ---------- Sesion ----------

  function saveSession(code, token, name) {
    localStorage.setItem('catanSession', JSON.stringify({ code, token, name }));
  }
  function getSession() {
    try { return JSON.parse(localStorage.getItem('catanSession')); } catch { return null; }
  }
  function clearSession() { localStorage.removeItem('catanSession'); }

  // ---------- Pantallas ----------

  function showScreen(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
    $(`screen-${name}`).classList.add('active');
    // Escena 3D del home/lobby (module que puede cargar despues que este script)
    if (window.Home3D) window.Home3D.onScreenChange(name);
    else (window.__home3dQueue = window.__home3dQueue || []).push(name);
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- Acciones ----------

  function act(action, cb) {
    socket.emit('action', action, (res) => {
      if (!res.ok) toast(res.error || 'Accion invalida');
      else if (cb) cb();
    });
  }

  // ---------- Home ----------

  function doCreateRoom(name) {
    socket.emit('createRoom', { name }, (res) => {
      if (!res.ok) return ($('home-error').textContent = res.error);
      saveSession(res.code, res.token, name);
      showScreen('lobby');
    });
  }

  $('btn-create').addEventListener('click', () => {
    const name = $('input-name').value.trim();
    if (!name) return ($('home-error').textContent = 'Pone tu nombre primero.');
    // Verificacion de seguridad (?): hay que atar a Gaston primero
    if (window.GastonCaptcha) window.GastonCaptcha.show(() => doCreateRoom(name));
    else doCreateRoom(name);
  });

  $('btn-join').addEventListener('click', joinFromInput);
  $('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromInput(); });

  function joinFromInput() {
    const name = $('input-name').value.trim();
    const code = $('input-code').value.trim().toUpperCase();
    if (!name) return ($('home-error').textContent = 'Pone tu nombre primero.');
    if (code.length !== 4) return ($('home-error').textContent = 'El codigo tiene 4 letras.');
    socket.emit('joinRoom', { code, name }, (res) => {
      if (!res.ok) return ($('home-error').textContent = res.error);
      saveSession(res.code, res.token, name);
      showScreen(res.started ? 'game' : 'lobby');
    });
  }

  $('btn-start').addEventListener('click', () => {
    socket.emit('startGame', (res) => { if (!res.ok) toast(res.error); });
  });

  $('btn-leave').addEventListener('click', () => {
    socket.emit('leaveRoom');
    clearSession();
    lobby = null;
    showScreen('home');
  });

  // Reconexion automatica: sesion guardada o ?code= en el link
  socket.on('connect', () => {
    const sess = getSession();
    const urlCode = new URLSearchParams(location.search).get('code');
    if (sess && sess.code) {
      socket.emit('joinRoom', { code: sess.code, name: sess.name, token: sess.token }, (res) => {
        if (res.ok) showScreen(res.started ? 'game' : 'lobby');
        else { clearSession(); if (urlCode) $('input-code').value = urlCode; }
      });
    } else if (urlCode) {
      $('input-code').value = urlCode.toUpperCase();
    }
  });

  // ---------- Lobby ----------

  socket.on('roomUpdate', (room) => {
    lobby = room;
    if (state && room.started) return; // ya en juego
    $('lobby-code').textContent = room.code;
    const colors = ['#c0392b', '#2471a3', '#e8e4d8', '#e67e22'];
    $('lobby-players').innerHTML = room.players.map((p, i) => `
      <div class="lobby-player ${p.connected ? '' : 'disconnected'}">
        <span class="dot" style="background:${colors[i]}"></span>
        ${esc(p.name)}
        ${p.isHost ? '<span class="host-tag">anfitrion</span>' : ''}
      </div>`).join('');
    $('btn-start').style.display = room.youAreHost && !room.started ? '' : 'none';
    $('lobby-hint').textContent = room.youAreHost
      ? (room.players.length < 2 ? 'Esperando jugadores... (3 o 4 es lo ideal)' : 'Cuando esten todos, dale a empezar.')
      : 'Esperando a que el anfitrion empiece...';
    if (!room.started && !state) showScreen('lobby');
  });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Estado de juego ----------

  socket.on('gameState', (gs) => {
    const prevDice = state ? state.dice : null;
    state = gs;
    showScreen('game');
    if (gs.dice && JSON.stringify(gs.dice) !== JSON.stringify(prevDice)) {
      lastDice = { dice: gs.dice, fresh: true };
      if (gs.dice[0] + gs.dice[1] === 7) bigMoment('¡Sale un 7!', 'El ladron entra en escena');
    }
    render();
    if (lastDice) lastDice.fresh = false;
  });

  // Banner cinematico para momentos dramaticos (se crea on-demand, fuera del re-render)
  function bigMoment(text, sub) {
    let bm = document.getElementById('big-moment');
    if (!bm) {
      bm = document.createElement('div');
      bm.id = 'big-moment';
      document.body.appendChild(bm);
    }
    bm.innerHTML = `<div class="bm-band"><div class="bm-text">${esc(text)}</div>${sub ? `<div class="bm-sub">${esc(sub)}</div>` : ''}</div>`;
    bm.classList.remove('show');
    void bm.offsetWidth; // fuerza reinicio de la animacion
    bm.classList.add('show');
    clearTimeout(bm._t);
    bm._t = setTimeout(() => bm.classList.remove('show'), 2400);
  }

  function me() { return state.players[state.you]; }
  function isMyTurn() { return state.turn === state.you && state.winner === null; }

  // ---------- Render principal ----------

  function render() {
    if (!state) return;
    renderBoardNow();
    renderOpponents();
    renderBankPanel();
    renderLog();
    renderMyArea();
    renderDice();
    renderBanner();
    renderTradeBanner();
    renderModals();
  }

  function currentHighlights() {
    const hl = { vertices: new Set(), edges: new Set(), hexes: new Set() };
    if (!isMyTurn() || !state.legal) return hl;
    const L = state.legal;
    if (state.phase === 'setup') {
      if (L.setupSettlements) L.setupSettlements.forEach((v) => hl.vertices.add(v));
      if (L.setupRoads) L.setupRoads.forEach((e) => hl.edges.add(e));
      return hl;
    }
    if (state.subPhase === 'robber' && L.robberHexes) {
      L.robberHexes.forEach((h) => hl.hexes.add(h));
      return hl;
    }
    if (state.subPhase === 'freeRoads' && L.roads) {
      L.roads.forEach((e) => hl.edges.add(e));
      return hl;
    }
    if (state.subPhase === 'main' && buildMode) {
      if (buildMode === 'road' && L.roads) L.roads.forEach((e) => hl.edges.add(e));
      if (buildMode === 'settlement' && L.settlements) L.settlements.forEach((v) => hl.vertices.add(v));
      if (buildMode === 'city' && L.cities) L.cities.forEach((v) => hl.vertices.add(v));
    }
    return hl;
  }

  function renderBoardNow() {
    renderBoard($('board-container'), state, {
      highlights: currentHighlights(),
      onVertexClick: (vid) => {
        if (state.phase === 'setup') return act({ type: 'placeSetupSettlement', vertexId: vid });
        if (buildMode === 'settlement') return act({ type: 'buildSettlement', vertexId: vid }, () => (buildMode = null));
        if (buildMode === 'city') return act({ type: 'buildCity', vertexId: vid }, () => (buildMode = null));
      },
      onEdgeClick: (eid) => {
        if (state.phase === 'setup') return act({ type: 'placeSetupRoad', edgeId: eid });
        if (state.subPhase === 'freeRoads') return act({ type: 'placeFreeRoad', edgeId: eid });
        if (buildMode === 'road') return act({ type: 'buildRoad', edgeId: eid }, () => (buildMode = null));
      },
      onHexClick: (hid) => {
        if (state.subPhase === 'robber') return act({ type: 'moveRobber', hexId: hid });
      },
    });
  }

  function renderOpponents() {
    const html = state.players.map((p, i) => {
      if (i === state.you) return '';
      return `
        <div class="opponent ${state.turn === i ? 'current-turn' : ''}" style="border-left-color:${p.color}">
          <div class="opponent-name">
            <span class="piece-dot" style="background:${p.color}"></span>
            ${esc(p.name)}
            <span class="vp-badge">${p.publicVp}</span>
          </div>
          <div class="opponent-stats">
            <span title="Cartas de recurso">🎴 ${p.resourceCount}</span>
            <span title="Cartas de desarrollo">🃏 ${p.devCardCount}</span>
            <span title="Caballeros jugados">⚔️ ${p.playedKnights}</span>
            <span title="Caminos">🛤️ ${p.roads.length}</span>
          </div>
          ${state.turn === i ? '<div class="turn-arrow">▶ jugando...</div>' : ''}
        </div>`;
    }).join('');
    $('opponents').innerHTML = html;
  }

  function renderBankPanel() {
    $('bank-info').innerHTML = RES.map((r) =>
      `<span class="bank-chip">${RES_ICON[r]} ${state.bank[r]}</span>`).join('');
    $('deck-info').textContent = `Mazo de desarrollo: ${state.devDeckCount} cartas`;
    const lr = state.longestRoad.holder !== null
      ? `${esc(state.players[state.longestRoad.holder].name)} (${state.longestRoad.length})` : 'nadie';
    const la = state.largestArmy.holder !== null
      ? `${esc(state.players[state.largestArmy.holder].name)} (${state.largestArmy.count})` : 'nadie';
    $('awards-info').innerHTML = `🛤️ Gran Ruta: <b>${lr}</b><br>⚔️ Gran Ejercito: <b>${la}</b>`;
  }

  function renderLog() {
    const el = $('game-log');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.innerHTML = state.log.map((l) => `<div>${esc(l)}</div>`).join('');
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  function renderMyArea() {
    const p = me();
    $('my-info').innerHTML = `
      <div class="my-name"><span class="piece-dot" style="background:${p.color}"></span>${esc(p.name)}</div>
      <div class="my-vp">⭐ <b>${p.vp}</b> puntos</div>
      <div class="my-vp">🏠 ${5 - p.settlements.length} · 🏰 ${4 - p.cities.length} · 🛤️ ${15 - p.roads.length}</div>`;

    $('my-hand').innerHTML = RES.map((r) => `
      <div class="res-card res-${r}" title="${RES_NAME[r]}">
        <div class="count">${p.resources ? p.resources[r] : 0}</div>
        <div class="icon">${RES_ICON[r]}</div>
        <div class="label">${RES_NAME[r]}</div>
      </div>`).join('');

    // Cartas de desarrollo (propias + compradas este turno)
    const dev = p.devCards || {};
    const newDev = p.newDevCards || {};
    let devHtml = '';
    for (const c of Object.keys(DEV_NAME)) {
      const owned = dev[c] || 0;
      const fresh = newDev[c] || 0;
      if (owned + fresh === 0) continue;
      const playable = owned > 0 && c !== 'victoryPoint' && canPlayDevNow();
      devHtml += `
        <div class="dev-card ${playable ? '' : 'disabled'} ${fresh > 0 && owned === 0 ? 'new-card' : ''}"
             data-card="${c}" title="${DEV_NAME[c]}${fresh > 0 ? ' (nueva: jugable el proximo turno)' : ''}">
          <div class="icon">${DEV_ICON[c]}</div>
          <div class="count">${owned + fresh}</div>
          <div>${DEV_NAME[c]}</div>
        </div>`;
    }
    $('my-devcards').innerHTML = devHtml;
    for (const card of $('my-devcards').querySelectorAll('.dev-card:not(.disabled)')) {
      card.addEventListener('click', () => playDev(card.dataset.card));
    }

    renderActions();
  }

  function canPlayDevNow() {
    return isMyTurn() && state.phase === 'play' && ['roll', 'main'].includes(state.subPhase) && !state.devPlayedThisTurn;
  }

  function playDev(card) {
    // Regla oficial: cualquier carta de desarrollo puede jugarse en cualquier
    // momento del turno, incluso antes de tirar los dados.
    if (card === 'knight') return act({ type: 'playKnight' });
    if (card === 'roadBuilding') return act({ type: 'playRoadBuilding' });
    if (card === 'yearOfPlenty') return openResourcePicker('yearOfPlenty');
    if (card === 'monopoly') return openResourcePicker('monopoly');
  }

  function renderActions() {
    const box = $('actions');
    if (!state || state.winner !== null) { box.innerHTML = ''; return; }
    if (!isMyTurn()) {
      box.innerHTML = `<span style="font-style:italic;color:#8a6c46">Turno de ${esc(state.players[state.turn].name)}...</span>`;
      return;
    }
    if (state.phase === 'setup') {
      box.innerHTML = `<span style="font-style:italic;color:#8a6c46">
        ${state.setupExpecting === 'settlement' ? 'Elegi un cruce para tu poblado' : 'Elegi un camino junto a tu poblado'}</span>`;
      return;
    }
    if (state.subPhase === 'roll') {
      box.innerHTML = `<button class="btn btn-primary" id="btn-roll">🎲 Tirar dados</button>`;
      $('btn-roll').addEventListener('click', () => act({ type: 'rollDice' }));
      return;
    }
    if (state.subPhase === 'robber') {
      box.innerHTML = `<span style="font-weight:bold;color:var(--red-catan)">Elegi el hex para el ladron</span>`;
      return;
    }
    if (state.subPhase === 'steal') {
      box.innerHTML = '';
      return; // modal
    }
    if (state.subPhase === 'freeRoads') {
      box.innerHTML = `<span style="font-weight:bold;color:var(--red-catan)">Coloca ${state.freeRoadsLeft} camino(s) gratis</span>`;
      return;
    }
    if (state.subPhase !== 'main') { box.innerHTML = ''; return; }

    const r = me().resources || {};
    const afford = {
      road: r.wood >= 1 && r.brick >= 1 && me().roads.length < 15,
      settlement: r.wood >= 1 && r.brick >= 1 && r.sheep >= 1 && r.wheat >= 1 && me().settlements.length < 5,
      city: r.wheat >= 2 && r.ore >= 3 && me().cities.length < 4 && me().settlements.length > 0,
      dev: r.sheep >= 1 && r.wheat >= 1 && r.ore >= 1 && state.devDeckCount > 0,
    };

    box.innerHTML = `
      <button class="btn btn-build ${buildMode === 'road' ? 'active-mode' : ''}" id="btn-b-road" ${afford.road ? '' : 'disabled'}>
        🛤️ Camino<span class="cost-hint">🌲🧱</span></button>
      <button class="btn btn-build ${buildMode === 'settlement' ? 'active-mode' : ''}" id="btn-b-set" ${afford.settlement ? '' : 'disabled'}>
        🏠 Poblado<span class="cost-hint">🌲🧱🐑🌾</span></button>
      <button class="btn btn-build ${buildMode === 'city' ? 'active-mode' : ''}" id="btn-b-city" ${afford.city ? '' : 'disabled'}>
        🏰 Ciudad<span class="cost-hint">🌾🌾⛰️⛰️⛰️</span></button>
      <button class="btn btn-build" id="btn-b-dev" ${afford.dev ? '' : 'disabled'}>
        🃏 Carta<span class="cost-hint">🐑🌾⛰️</span></button>
      <button class="btn" id="btn-trade">⚖️ Comerciar</button>
      <button class="btn btn-primary" id="btn-end">Terminar turno</button>`;

    const toggle = (m) => { buildMode = buildMode === m ? null : m; render(); };
    $('btn-b-road').addEventListener('click', () => toggle('road'));
    $('btn-b-set').addEventListener('click', () => toggle('settlement'));
    $('btn-b-city').addEventListener('click', () => toggle('city'));
    $('btn-b-dev').addEventListener('click', () => act({ type: 'buyDevCard' }));
    $('btn-trade').addEventListener('click', openTradeModal);
    $('btn-end').addEventListener('click', () => { buildMode = null; act({ type: 'endTurn' }); });
  }

  // ---------- Dados ----------

  const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

  function dieHtml(value, color, fresh) {
    let cells = '';
    for (let i = 1; i <= 9; i++) cells += PIPS[value].includes(i) ? '<span class="pip"></span>' : '<span></span>';
    return `<div class="die ${color} ${fresh ? 'rolling' : ''}">${cells}</div>`;
  }

  function renderDice() {
    const area = $('dice-area');
    if (!state.dice) { area.innerHTML = ''; return; }
    const fresh = lastDice && lastDice.fresh;
    area.innerHTML = dieHtml(state.dice[0], 'ivory', fresh) + dieHtml(state.dice[1], 'red', fresh)
      + `<div class="dice-total ${fresh ? 'pop' : ''}">= ${state.dice[0] + state.dice[1]}</div>`;
  }

  function renderBanner() {
    const b = $('status-banner');
    if (state.winner !== null) {
      b.textContent = `🏆 Gano ${state.players[state.winner].name}`;
      b.classList.remove('my-turn');
      return;
    }
    const name = state.players[state.turn].name;
    const mine = isMyTurn();
    b.classList.toggle('my-turn', mine);
    let msg;
    if (state.phase === 'setup') {
      msg = mine ? (state.setupExpecting === 'settlement' ? 'Tu turno: coloca un poblado' : 'Tu turno: coloca un camino')
        : `${name} esta colocando...`;
    } else if (state.subPhase === 'discard') {
      const pend = Object.keys(state.pendingDiscards).map((i) => state.players[i].name).join(', ');
      msg = `Descartando: ${pend}`;
    } else if (mine) {
      msg = { roll: 'Tu turno: tira los dados', main: 'Tu turno', robber: 'Move al ladron', steal: 'Elegi a quien robar', freeRoads: 'Caminos gratis' }[state.subPhase] || 'Tu turno';
    } else {
      msg = `Turno de ${name}`;
    }
    b.textContent = msg;
  }

  // ---------- Oferta de comercio (banner flotante) ----------

  function renderTradeBanner() {
    const existing = document.querySelector('.trade-offer-banner');
    if (existing) existing.remove();
    const offer = state.tradeOffer;
    if (!offer || state.winner !== null) return;

    const wrap = document.createElement('div');
    wrap.className = 'trade-offer-banner';
    const handTxt = (h) => RES.filter((r) => h[r] > 0).map((r) => `${h[r]}${RES_ICON[r]}`).join(' ');
    const from = state.players[offer.from];

    if (offer.from === state.you) {
      let btns = '';
      for (const [idx, resp] of Object.entries(offer.responses)) {
        if (resp === 'accepted') {
          btns += `<button class="btn btn-primary btn-confirm-trade" data-idx="${idx}">Cerrar con ${esc(state.players[idx].name)}</button>`;
        }
      }
      const rejected = Object.values(offer.responses).filter((r) => r === 'rejected').length;
      wrap.innerHTML = `<span>Tu oferta: das ${handTxt(offer.give)} por ${handTxt(offer.get)}</span>
        ${btns || `<span style="font-style:italic;font-weight:normal">esperando respuestas${rejected ? ` (${rejected} rechazos)` : ''}...</span>`}
        <button class="btn btn-ghost" id="btn-cancel-trade">Retirar</button>`;
    } else {
      const myResp = offer.responses[state.you];
      wrap.innerHTML = `<span>${esc(from.name)} ofrece ${handTxt(offer.give)} y pide ${handTxt(offer.get)}</span>
        ${myResp ? `<span style="font-style:italic">${myResp === 'accepted' ? 'aceptaste ✓' : 'rechazaste ✗'}</span>` : `
        <button class="btn btn-primary" id="btn-accept-trade">Aceptar</button>
        <button class="btn" id="btn-reject-trade">Rechazar</button>`}`;
    }
    document.querySelector('.board-wrap').appendChild(wrap);

    for (const b of wrap.querySelectorAll('.btn-confirm-trade')) {
      b.addEventListener('click', () => act({ type: 'confirmTrade', withIdx: Number(b.dataset.idx) }));
    }
    const cancel = wrap.querySelector('#btn-cancel-trade');
    if (cancel) cancel.addEventListener('click', () => act({ type: 'cancelTrade' }));
    const accept = wrap.querySelector('#btn-accept-trade');
    if (accept) accept.addEventListener('click', () => act({ type: 'respondTrade', accept: true }));
    const reject = wrap.querySelector('#btn-reject-trade');
    if (reject) reject.addEventListener('click', () => act({ type: 'respondTrade', accept: false }));
  }

  // ---------- Modales ----------

  function showModal(type, html) {
    openModal = type;
    $('modal-box').innerHTML = html;
    $('modal-overlay').style.display = 'flex';
  }
  function closeModal() {
    openModal = null;
    $('modal-overlay').style.display = 'none';
  }

  function renderModals() {
    // Descarte forzado
    if (state.subPhase === 'discard' && state.pendingDiscards[state.you]) {
      if (openModal !== 'discard') openDiscardModal();
      return;
    } else if (openModal === 'discard') closeModal();

    // Robo: elegir victima
    if (state.subPhase === 'steal' && isMyTurn()) {
      if (openModal !== 'steal') openStealModal();
      return;
    } else if (openModal === 'steal') closeModal();

    // Fin de partida
    if (state.winner !== null && openModal !== 'winner') openWinnerModal();
  }

  function stepperHtml(id, max) {
    return `<div class="stepper" data-id="${id}" data-max="${max}">
      <button class="st-up">▲</button><span class="val">0</span><button class="st-dn">▼</button>
    </div>`;
  }

  function wireSteppers(container, onChange) {
    for (const st of container.querySelectorAll('.stepper')) {
      const val = st.querySelector('.val');
      st.querySelector('.st-up').addEventListener('click', () => {
        const max = Number(st.dataset.max);
        if (Number(val.textContent) < max) val.textContent = Number(val.textContent) + 1;
        onChange && onChange();
      });
      st.querySelector('.st-dn').addEventListener('click', () => {
        if (Number(val.textContent) > 0) val.textContent = Number(val.textContent) - 1;
        onChange && onChange();
      });
    }
  }

  function readSteppers(container) {
    const out = {};
    for (const st of container.querySelectorAll('.stepper')) {
      const v = Number(st.querySelector('.val').textContent);
      if (v > 0) out[st.dataset.id] = v;
    }
    return out;
  }

  function openDiscardModal() {
    const need = state.pendingDiscards[state.you];
    const r = me().resources;
    showModal('discard', `
      <h2>Sale un 7: descarta ${need} cartas</h2>
      <div class="trade-grid">
        <span class="row-label">Tenes</span>
        ${RES.map((res) => `<span class="head">${RES_ICON[res]}<br><small>${r[res]}</small></span>`).join('')}
        <span class="row-label">Descartar</span>
        ${RES.map((res) => stepperHtml(res, r[res])).join('')}
      </div>
      <div class="modal-actions">
        <span id="discard-count" style="font-weight:bold;align-self:center;margin-right:auto">0 / ${need}</span>
        <button class="btn btn-primary" id="btn-do-discard" disabled>Descartar</button>
      </div>`);
    const box = $('modal-box');
    const update = () => {
      const sel = readSteppers(box);
      const total = Object.values(sel).reduce((a, b) => a + b, 0);
      $('discard-count').textContent = `${total} / ${need}`;
      $('btn-do-discard').disabled = total !== need;
    };
    wireSteppers(box, update);
    $('btn-do-discard').addEventListener('click', () => {
      act({ type: 'discard', hand: readSteppers(box) }, closeModal);
    });
  }

  function openStealModal() {
    showModal('steal', `
      <h2>¿A quien le robas una carta?</h2>
      <div class="steal-row">
        ${state.stealCandidates.map((i) => `
          <button class="btn steal-btn" data-idx="${i}">
            <span class="piece-dot" style="background:${state.players[i].color}"></span>
            ${esc(state.players[i].name)} (${state.players[i].resourceCount} 🎴)
          </button>`).join('')}
      </div>`);
    for (const b of $('modal-box').querySelectorAll('.steal-btn')) {
      b.addEventListener('click', () => act({ type: 'stealFrom', victimIdx: Number(b.dataset.idx) }, closeModal));
    }
  }

  function openResourcePicker(kind) {
    const isYop = kind === 'yearOfPlenty';
    showModal(kind, `
      <h2>${isYop ? 'Año de la abundancia: elegi 2 recursos' : 'Monopolio: elegi un recurso'}</h2>
      <div class="picker-row">
        ${RES.map((r) => `
          <div class="res-card res-${r} picker-card" data-res="${r}">
            <div class="count" data-picks="0"></div>
            <div class="icon">${RES_ICON[r]}</div>
            <div class="label">${RES_NAME[r]}</div>
          </div>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="btn-pick-cancel">Cancelar</button>
        <button class="btn btn-primary" id="btn-pick-ok" disabled>Jugar carta</button>
      </div>`);
    const picks = [];
    const maxPicks = isYop ? 2 : 1;
    const box = $('modal-box');
    for (const card of box.querySelectorAll('.picker-card')) {
      card.addEventListener('click', () => {
        const res = card.dataset.res;
        if (picks.length >= maxPicks) picks.shift();
        picks.push(res);
        for (const c of box.querySelectorAll('.picker-card')) {
          const n = picks.filter((p) => p === c.dataset.res).length;
          c.classList.toggle('selected', n > 0);
          c.querySelector('.count').textContent = n > 1 ? `x${n}` : '';
        }
        $('btn-pick-ok').disabled = picks.length !== maxPicks;
      });
    }
    $('btn-pick-cancel').addEventListener('click', closeModal);
    $('btn-pick-ok').addEventListener('click', () => {
      if (isYop) act({ type: 'playYearOfPlenty', res1: picks[0], res2: picks[1] }, closeModal);
      else act({ type: 'playMonopoly', res: picks[0] }, closeModal);
    });
  }

  function openTradeModal() {
    const r = me().resources;
    const ratios = (state.legal && state.legal.ratios) || { wood: 4, brick: 4, sheep: 4, wheat: 4, ore: 4 };
    showModal('trade', `
      <h2>Comerciar</h2>
      <p style="font-size:13px;color:#7a6242;margin-bottom:6px">
        <b>Con el banco:</b> tus ratios son ${RES.map((res) => `${RES_ICON[res]} ${ratios[res]}:1`).join(' · ')}
      </p>
      <div class="trade-grid">
        <span class="row-label">Das</span>
        ${RES.map((res) => `<span class="head">${RES_ICON[res]}<br><small>${r[res]}</small></span>`).join('')}
        <span class="row-label"></span>
        ${RES.map((res) => stepperHtml('give-' + res, r[res])).join('')}
        <span class="row-label">Recibis</span>
        ${RES.map((res) => `<span class="head">${RES_ICON[res]}</span>`).join('')}
        <span class="row-label"></span>
        ${RES.map((res) => stepperHtml('get-' + res, 19)).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="btn-trade-cancel">Cancelar</button>
        <button class="btn" id="btn-trade-bank">Con el banco</button>
        <button class="btn btn-primary" id="btn-trade-offer">Ofrecer a jugadores</button>
      </div>`);
    const box = $('modal-box');
    wireSteppers(box);
    const readTrade = () => {
      const all = readSteppers(box);
      const give = {}, get = {};
      for (const k of Object.keys(all)) {
        if (k.startsWith('give-')) give[k.slice(5)] = all[k];
        else get[k.slice(4)] = all[k];
      }
      return { give, get };
    };
    $('btn-trade-cancel').addEventListener('click', closeModal);
    $('btn-trade-bank').addEventListener('click', () => {
      const { give, get } = readTrade();
      act({ type: 'bankTrade', give, get }, closeModal);
    });
    $('btn-trade-offer').addEventListener('click', () => {
      const { give, get } = readTrade();
      act({ type: 'offerTrade', give, get }, closeModal);
    });
  }

  function openWinnerModal() {
    const w = state.players[state.winner];
    const rows = state.players
      .map((p, i) => ({ p, i }))
      .sort((a, b) => b.p.publicVp - a.p.publicVp)
      .map(({ p, i }) => `
        <tr>
          <td><span class="piece-dot" style="background:${p.color}"></span> ${esc(p.name)} ${i === state.winner ? '🏆' : ''}</td>
          <td><b>${p.publicVp}</b> VP</td>
          <td>⚔️ ${p.playedKnights}</td>
        </tr>`).join('');
    const palette = ['#e8b64c', '#c0392b', '#2471a3', '#6a9a34', '#e67e22'];
    const conf = Array.from({ length: 28 }, (_, i) =>
      `<i style="left:${(i * 37 + 11) % 100}%;background:${palette[i % 5]};` +
      `animation-delay:${((i % 13) * 0.19).toFixed(2)}s;animation-duration:${(2.6 + (i % 5) * 0.35).toFixed(2)}s"></i>`
    ).join('');
    showModal('winner', `
      <div class="winner-box">
        <div class="confetti" aria-hidden="true">${conf}</div>
        <div class="trophy-wrap"><div class="rays"></div><div class="trophy">🏆</div></div>
        <h2>¡${esc(w.name)} gana la partida!</h2>
        <table class="vp-table">
          <tr><th>Jugador</th><th>Puntos</th><th>Caballeros</th></tr>
          ${rows}
        </table>
        <div class="modal-actions" style="justify-content:center">
          <button class="btn btn-primary" id="btn-back-home">Volver al inicio</button>
        </div>
      </div>`);
    $('btn-back-home').addEventListener('click', () => {
      clearSession();
      socket.emit('leaveRoom');
      state = null;
      closeModal();
      showScreen('home');
    });
  }

  // ---------- Chat ----------

  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      socket.emit('chat', e.target.value.trim());
      e.target.value = '';
    }
  });

  socket.on('chat', ({ from, idx, text }) => {
    const colors = state ? state.players.map((p) => p.color) : ['#c0392b', '#2471a3', '#e8e4d8', '#e67e22'];
    const log = $('chat-log');
    const div = document.createElement('div');
    div.innerHTML = `<b style="color:${colors[idx] || '#3a2a18'}">${esc(from)}:</b> ${esc(text)}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  });
})();
