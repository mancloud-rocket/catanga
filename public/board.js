// Render SVG del tablero de Catan con estetica de juego fisico:
// tiles con arte de terreno, tokens numerados, puertos con muelle,
// ladron, piezas de jugadores y overlays clickeables.
// Expone window.renderBoard(container, state, ui).

(function () {
  'use strict';

  const S = 60; // pixels por unidad de geometria del server

  // Diffing liviano entre renders: solo para disparar animaciones de entrada.
  // El contenido final del render es identico con o sin esto.
  const seen = { pieces: null, robber: null };

  const TERRAIN_STYLE = {
    forest:    { base: '#2f6b35', edge: '#1f4a24' },
    pasture:   { base: '#a8cf5e', edge: '#7fa63e' },
    fields:    { base: '#e9c33f', edge: '#c39a20' },
    hills:     { base: '#cf7440', edge: '#a1502a' },
    mountains: { base: '#9aa5ad', edge: '#6e7a83' },
    desert:    { base: '#e8d9a8', edge: '#c8b478' },
  };

  const RES_ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '⛰️', any: '❓' };

  const PROB_DOTS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

  function el(name, attrs, children) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (children) for (const c of children) node.appendChild(c);
    return node;
  }

  function hexPoints(cx, cy, size) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      pts.push(`${cx + size * Math.cos(a)},${cy + size * Math.sin(a)}`);
    }
    return pts.join(' ');
  }

  // Fase determinista (para desincronizar loops de animacion sin estado JS)
  function phase(x, y, mod) {
    const v = (x * 7.13 + y * 3.71) % mod;
    return -((v % mod) + mod) % mod;
  }

  // Envuelve un nodo en un <g> animable (la animacion CSS no pisa el transform del nodo)
  function animWrap(node, cls, delay) {
    const g = el('g', { class: cls });
    if (delay) g.setAttribute('style', `animation-delay:${delay.toFixed(2)}s`);
    g.appendChild(node);
    return g;
  }

  // ---------- Decoraciones de terreno ----------

  function firTree(x, y, scale) {
    const g = el('g', { transform: `translate(${x},${y}) scale(${scale})` });
    g.appendChild(el('rect', { x: -1.5, y: 6, width: 3, height: 5, fill: '#5a3a1e' }));
    for (let i = 0; i < 3; i++) {
      const w = 11 - i * 2.6;
      const ty = 6 - i * 5;
      const p = el('polygon', {
        points: `${-w / 2},${ty} ${w / 2},${ty} 0,${ty - 7}`,
        fill: i % 2 ? '#1e5c28' : '#174a20',
        stroke: '#0f3416', 'stroke-width': 0.5,
      });
      g.appendChild(p);
    }
    return g;
  }

  function wheatRow(x, y, w) {
    const g = el('g', { transform: `translate(${x},${y})` });
    g.appendChild(el('path', {
      d: `M ${-w / 2} 0 Q 0 ${-3} ${w / 2} 0`,
      stroke: '#b8860b', 'stroke-width': 1.6, fill: 'none', opacity: 0.85,
    }));
    for (let i = -2; i <= 2; i++) {
      g.appendChild(el('line', {
        x1: i * (w / 5), y1: -1 - Math.abs(i) * -0.3, x2: i * (w / 5) + 1.5, y2: -6,
        stroke: '#a3760a', 'stroke-width': 1.1, 'stroke-linecap': 'round',
      }));
      g.appendChild(el('circle', { cx: i * (w / 5) + 1.7, cy: -6.5, r: 1.6, fill: '#c9982a' }));
    }
    return g;
  }

  function brickStack(x, y) {
    const g = el('g', { transform: `translate(${x},${y})` });
    const rows = [[0, 0, 2], [0.5, -5, 2], [1, -10, 1]];
    for (const [off, ry, count] of rows) {
      for (let i = 0; i < count; i++) {
        g.appendChild(el('rect', {
          x: -11 + i * 12 + off * 5, y: ry, width: 10.5, height: 4.6, rx: 0.8,
          fill: '#a33d1f', stroke: '#7c2b13', 'stroke-width': 0.7,
        }));
      }
    }
    return g;
  }

  function mountainPeak(x, y, scale) {
    const g = el('g', { transform: `translate(${x},${y}) scale(${scale})` });
    g.appendChild(el('polygon', {
      points: '-12,8 0,-10 12,8',
      fill: '#7d8a93', stroke: '#5a666e', 'stroke-width': 0.8,
    }));
    g.appendChild(el('polygon', {
      points: '-3.5,-4.6 0,-10 3.5,-4.6 1.5,-3 0,-4.5 -1.6,-3',
      fill: '#e8edf0', class: 'snow-glint',
      style: `animation-delay:${(x % 5).toFixed(2)}s`,
    }));
    return g;
  }

  function sheepShape(x, y, scale) {
    const g = el('g', { transform: `translate(${x},${y}) scale(${scale})` });
    g.appendChild(el('ellipse', { cx: 0, cy: 0, rx: 6, ry: 4, fill: '#f4f1e6', stroke: '#c9c2ac', 'stroke-width': 0.7 }));
    g.appendChild(el('circle', { cx: 5.4, cy: -1.6, r: 2.2, fill: '#4a4238' }));
    for (const lx of [-3, 0.5, 3.5]) {
      g.appendChild(el('line', { x1: lx, y1: 3.4, x2: lx, y2: 6, stroke: '#4a4238', 'stroke-width': 1 }));
    }
    return g;
  }

  function duneArc(x, y, w) {
    return el('path', {
      d: `M ${x - w / 2} ${y} Q ${x} ${y - 5} ${x + w / 2} ${y}`,
      stroke: '#c8ae6e', 'stroke-width': 1.6, fill: 'none', opacity: 0.9,
    });
  }

  function decorateHex(g, hex) {
    const cx = hex.x * S, cy = hex.y * S;
    switch (hex.terrain) {
      case 'forest':
        g.appendChild(animWrap(firTree(cx - 20, cy - 8, 1.5), 'sway', phase(cx, cy, 5)));
        g.appendChild(animWrap(firTree(cx + 16, cy - 16, 1.25), 'sway', phase(cx + 9, cy, 5)));
        g.appendChild(animWrap(firTree(cx + 22, cy + 14, 1.45), 'sway', phase(cx, cy + 7, 5)));
        g.appendChild(animWrap(firTree(cx - 8, cy + 22, 1.3), 'sway', phase(cx + 3, cy + 3, 5)));
        break;
      case 'fields':
        g.appendChild(animWrap(wheatRow(cx - 8, cy - 14, 26), 'wheat-sway', phase(cx, cy, 4)));
        g.appendChild(animWrap(wheatRow(cx + 14, cy + 4, 24), 'wheat-sway', phase(cx + 5, cy, 4)));
        g.appendChild(animWrap(wheatRow(cx - 16, cy + 20, 26), 'wheat-sway', phase(cx, cy + 5, 4)));
        break;
      case 'hills':
        g.appendChild(brickStack(cx - 14, cy - 10));
        g.appendChild(brickStack(cx + 12, cy + 16));
        break;
      case 'mountains':
        g.appendChild(mountainPeak(cx - 14, cy - 10, 1.35));
        g.appendChild(mountainPeak(cx + 15, cy - 4, 1.05));
        g.appendChild(mountainPeak(cx - 2, cy + 18, 1.5));
        break;
      case 'pasture':
        g.appendChild(animWrap(sheepShape(cx - 16, cy - 12, 1.15), 'sheep-bob', phase(cx, cy, 6)));
        g.appendChild(animWrap(sheepShape(cx + 14, cy + 14, 1.3), 'sheep-bob', phase(cx + 4, cy, 6)));
        for (const [tx, ty] of [[cx + 18, cy - 18], [cx - 22, cy + 12], [cx + 2, cy + 26], [cx - 2, cy - 24]]) {
          g.appendChild(el('path', {
            d: `M ${tx} ${ty} l 2 -4 l 2 4 M ${tx + 2} ${ty} l 0 -5`,
            stroke: '#6f9436', 'stroke-width': 1.1, fill: 'none', 'stroke-linecap': 'round',
          }));
        }
        break;
      case 'desert':
        g.appendChild(duneArc(cx - 10, cy - 12, 30));
        g.appendChild(duneArc(cx + 12, cy + 2, 26));
        g.appendChild(duneArc(cx - 14, cy + 18, 28));
        break;
    }
  }

  // ---------- Token numerado ----------

  function numberToken(hex) {
    const cx = hex.x * S, cy = hex.y * S;
    const red = hex.number === 6 || hex.number === 8;
    const g = el('g', {});
    g.appendChild(el('circle', {
      cx, cy, r: 15.5,
      fill: '#f2e3bd', stroke: '#b09a67', 'stroke-width': 1.4,
      filter: 'url(#tokenShadow)',
    }));
    const t = el('text', {
      x: cx, y: cy + (red ? 4.5 : 4),
      'text-anchor': 'middle',
      'font-family': "'Palatino Linotype', Georgia, serif",
      'font-size': red ? 17 : 14.5,
      'font-weight': 900,
      fill: red ? '#b3251a' : '#3a2a18',
    });
    t.textContent = hex.number;
    g.appendChild(t);
    const dots = PROB_DOTS[hex.number] || 0;
    for (let i = 0; i < dots; i++) {
      g.appendChild(el('circle', {
        cx: cx + (i - (dots - 1) / 2) * 3.4, cy: cy + 9.5, r: 1.15,
        fill: red ? '#b3251a' : '#3a2a18',
      }));
    }
    return g;
  }

  // ---------- Puertos ----------

  function portGroup(port, vertices) {
    const g = el('g', {});
    const bx = port.outX * S, by = port.outY * S;
    for (const vid of port.vertices) {
      const v = vertices[vid];
      g.appendChild(el('line', {
        x1: v.x * S, y1: v.y * S, x2: bx, y2: by,
        stroke: '#8a6534', 'stroke-width': 5, 'stroke-linecap': 'round',
        'stroke-dasharray': '7 4', opacity: 0.95,
      }));
    }
    g.appendChild(el('circle', {
      cx: bx, cy: by, r: 15,
      fill: '#f2e3bd', stroke: '#8a6534', 'stroke-width': 2,
      filter: 'url(#tokenShadow)',
    }));
    if (port.type === 'any') {
      const ratio = el('text', {
        x: bx, y: by + 4.5, 'text-anchor': 'middle',
        'font-size': 12, 'font-weight': 900, 'font-family': 'Georgia, serif', fill: '#3a2a18',
      });
      ratio.textContent = '3:1';
      g.appendChild(ratio);
    } else {
      const icon = el('text', {
        x: bx, y: by - 1, 'text-anchor': 'middle', 'font-size': 11,
      });
      icon.textContent = RES_ICON[port.type];
      g.appendChild(icon);
      const ratio = el('text', {
        x: bx, y: by + 10, 'text-anchor': 'middle',
        'font-size': 8.5, 'font-weight': 900, 'font-family': 'Georgia, serif', fill: '#3a2a18',
      });
      ratio.textContent = '2:1';
      g.appendChild(ratio);
    }
    return g;
  }

  // ---------- Ladron ----------

  function robberShape(hex, moved) {
    const cx = hex.x * S - 20, cy = hex.y * S + 6;
    const g = el('g', { opacity: 0.94, class: moved ? 'robber-drop' : '' });
    g.appendChild(el('ellipse', {
      cx, cy: cy + 12, rx: 13, ry: 4.6,
      fill: 'rgba(20,4,4,0.4)', class: 'robber-aura',
    }));
    g.appendChild(el('ellipse', { cx, cy: cy + 12, rx: 9.5, ry: 3.4, fill: 'rgba(0,0,0,0.35)' }));
    g.appendChild(el('path', {
      d: `M ${cx - 8} ${cy + 12} Q ${cx - 9} ${cy - 2} ${cx - 4.5} ${cy - 6}
          A 6.4 6.4 0 1 1 ${cx + 4.5} ${cy - 6}
          Q ${cx + 9} ${cy - 2} ${cx + 8} ${cy + 12} Z`,
      fill: '#3b3b46', stroke: '#17171d', 'stroke-width': 1.3,
    }));
    g.appendChild(el('circle', { cx, cy: cy - 9.5, r: 5.6, fill: '#3b3b46', stroke: '#17171d', 'stroke-width': 1.3 }));
    return g;
  }

  // ---------- Piezas de jugadores ----------

  function roadShape(edge, vertices, color) {
    const v1 = vertices[edge.v1], v2 = vertices[edge.v2];
    const x1 = v1.x * S, y1 = v1.y * S, x2 = v2.x * S, y2 = v2.y * S;
    const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const len = Math.hypot(x2 - x1, y2 - y1) * 0.62;
    return el('rect', {
      x: mx - len / 2, y: my - 4.5, width: len, height: 9, rx: 2,
      transform: `rotate(${angle} ${mx} ${my})`,
      fill: color, stroke: 'rgba(0,0,0,0.55)', 'stroke-width': 1.6,
      filter: 'url(#pieceShadow)',
    });
  }

  function settlementShape(v, color) {
    const x = v.x * S, y = v.y * S;
    return el('path', {
      d: `M ${x - 8} ${y + 7} L ${x - 8} ${y - 3} L ${x} ${y - 11} L ${x + 8} ${y - 3} L ${x + 8} ${y + 7} Z`,
      fill: color, stroke: 'rgba(0,0,0,0.6)', 'stroke-width': 1.8,
      'stroke-linejoin': 'round',
      filter: 'url(#pieceShadow)',
    });
  }

  function cityShape(v, color) {
    const x = v.x * S, y = v.y * S;
    return el('path', {
      d: `M ${x - 11} ${y + 8} L ${x - 11} ${y - 2} L ${x - 4} ${y - 2} L ${x - 4} ${y - 8}
          L ${x + 1} ${y - 14} L ${x + 6} ${y - 8} L ${x + 6} ${y - 2} L ${x + 11} ${y - 2}
          L ${x + 11} ${y + 8} Z`,
      fill: color, stroke: 'rgba(0,0,0,0.6)', 'stroke-width': 1.8,
      'stroke-linejoin': 'round',
      filter: 'url(#pieceShadow)',
    });
  }

  // ---------- Render principal ----------

  function renderBoard(container, state, ui) {
    const board = state.board;
    ui = ui || {};
    const hl = ui.highlights || {};
    const hlVertices = hl.vertices || new Set();
    const hlEdges = hl.edges || new Set();
    const hlHexes = hl.hexes || new Set();

    // Bounds a partir del anillo de mar
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const s of board.sea) {
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    }
    const m = 1.25;
    const vb = [(minX - m) * S, (minY - m) * S, (maxX - minX + 2 * m) * S, (maxY - minY + 2 * m) * S];

    const svg = el('svg', { viewBox: vb.join(' '), preserveAspectRatio: 'xMidYMid meet' });

    // defs: filtros y gradiente de agua
    const defs = el('defs', {});
    defs.innerHTML = `
      <filter id="tokenShadow" x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="0" dy="1.6" stdDeviation="1.4" flood-opacity="0.45"/>
      </filter>
      <filter id="pieceShadow" x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="0" dy="1.8" stdDeviation="1.6" flood-opacity="0.5"/>
      </filter>
      <radialGradient id="waterGrad" cx="50%" cy="42%" r="75%">
        <stop offset="0%" stop-color="#3d8ec4"/>
        <stop offset="60%" stop-color="#2a6f9e"/>
        <stop offset="100%" stop-color="#1d5478"/>
      </radialGradient>
      <radialGradient id="tileLight" cx="50%" cy="38%" r="80%">
        <stop offset="0%" stop-color="rgba(255,255,255,0.22)"/>
        <stop offset="70%" stop-color="rgba(255,255,255,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0.14)"/>
      </radialGradient>
      <filter id="goldGlow" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="3.2" result="b"/>
        <feMerge>
          <feMergeNode in="b"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    `;
    svg.appendChild(defs);

    // Marco de agua: un hexagono gigante con gradiente + hexes de mar sutiles
    svg.appendChild(el('polygon', {
      points: hexPoints(0, 0, (maxX + m) * S * 1.02),
      fill: 'url(#waterGrad)', stroke: '#164260', 'stroke-width': 8,
      transform: 'rotate(30)',
    }));
    for (const sHex of board.sea) {
      const sx = sHex.x * S, sy = sHex.y * S;
      svg.appendChild(el('polygon', {
        points: hexPoints(sx, sy, S * 0.995),
        fill: 'none', stroke: 'rgba(255,255,255,0.10)', 'stroke-width': 1.5,
      }));
      // olas en loop, desfasadas por posicion
      svg.appendChild(el('path', {
        d: `M ${sx - 18} ${sy} q 5 -4 10 0 q 5 4 10 0`,
        stroke: 'rgba(255,255,255,0.22)', 'stroke-width': 1.6, fill: 'none', 'stroke-linecap': 'round',
        class: 'sea-wave', style: `animation-delay:${phase(sx, sy, 4.5)}s`,
      }));
      svg.appendChild(el('path', {
        d: `M ${sx - 10} ${sy + 16} q 4 -3.5 8 0 q 4 3.5 8 0`,
        stroke: 'rgba(255,255,255,0.15)', 'stroke-width': 1.4, fill: 'none', 'stroke-linecap': 'round',
        class: 'sea-wave', style: `animation-delay:${phase(sx + 3, sy + 5, 4.5)}s`,
      }));
      svg.appendChild(el('path', {
        d: `M ${sx + 2} ${sy - 18} q 4 -3.5 8 0`,
        stroke: 'rgba(255,255,255,0.12)', 'stroke-width': 1.3, fill: 'none', 'stroke-linecap': 'round',
        class: 'sea-wave', style: `animation-delay:${phase(sx + 7, sy + 1, 4.5)}s`,
      }));
    }

    // Puertos (debajo de los tiles para que el muelle quede detras del borde)
    for (const port of board.ports) svg.appendChild(portGroup(port, board.vertices));

    // Primer render de la sesion: intro cinematica del tablero (tiles que aparecen)
    const isFirstRender = seen.pieces === null;

    // Tiles de tierra
    let tileIdx = 0;
    for (const hex of board.hexes) {
      const st = TERRAIN_STYLE[hex.terrain];
      const g = el('g', {});
      g.appendChild(el('polygon', {
        points: hexPoints(hex.x * S, hex.y * S, S * 0.985),
        fill: st.base, stroke: st.edge, 'stroke-width': 2.5,
      }));
      decorateHex(g, hex);
      // luz superior estilo tile impreso
      g.appendChild(el('polygon', {
        points: hexPoints(hex.x * S, hex.y * S, S * 0.985),
        fill: 'url(#tileLight)', stroke: '#e8d9a8', 'stroke-width': 1.2, 'stroke-opacity': 0.55,
      }));
      const delay = tileIdx * 0.05;
      svg.appendChild(isFirstRender ? animWrap(g, 'tile-in', delay) : g);
      if (hex.number) {
        const tok = numberToken(hex);
        svg.appendChild(isFirstRender ? animWrap(tok, 'tile-in', delay + 0.25) : tok);
      }
      tileIdx++;
    }

    // Diffing de piezas: las nuevas entran con pop (el contenido final es identico)
    const nowPieces = new Set();
    for (const pl of state.players) {
      for (const eid of pl.roads) nowPieces.add('r' + eid);
      for (const vid of pl.settlements) nowPieces.add('s' + vid);
      for (const vid of pl.cities) nowPieces.add('c' + vid);
    }
    const isNew = (k) => !isFirstRender && seen.pieces && !seen.pieces.has(k);

    // Piezas: caminos primero, despues edificios
    for (const pl of state.players) {
      for (const eid of pl.roads) {
        const shape = roadShape(board.edges[eid], board.vertices, pl.color);
        svg.appendChild(isNew('r' + eid) ? animWrap(shape, 'piece-pop', 0) : shape);
      }
    }
    for (const pl of state.players) {
      for (const vid of pl.settlements) {
        const shape = settlementShape(board.vertices[vid], pl.color);
        svg.appendChild(isNew('s' + vid) ? animWrap(shape, 'piece-pop', 0) : shape);
      }
      for (const vid of pl.cities) {
        const shape = cityShape(board.vertices[vid], pl.color);
        svg.appendChild(isNew('c' + vid) ? animWrap(shape, 'piece-pop', 0) : shape);
      }
    }

    // Ladron (con drop dramatico cuando se mueve)
    const robberMoved = seen.robber !== null && seen.robber !== state.robberHex;
    svg.appendChild(robberShape(board.hexes[state.robberHex], robberMoved));
    seen.pieces = nowPieces;
    seen.robber = state.robberHex;

    // Overlays interactivos
    if (hlHexes.size > 0) {
      for (const hex of board.hexes) {
        if (!hlHexes.has(hex.id)) continue;
        const p = el('polygon', {
          points: hexPoints(hex.x * S, hex.y * S, S * 0.9),
          fill: 'rgba(255,255,255,0.16)', stroke: '#ffd76a', 'stroke-width': 3,
          'stroke-dasharray': '10 6', cursor: 'pointer', class: 'hl-pulse hl-ants',
          filter: 'url(#goldGlow)',
        });
        p.addEventListener('click', () => ui.onHexClick && ui.onHexClick(hex.id));
        svg.appendChild(p);
      }
    }
    if (hlEdges.size > 0) {
      for (const edge of board.edges) {
        if (!hlEdges.has(edge.id)) continue;
        const v1 = board.vertices[edge.v1], v2 = board.vertices[edge.v2];
        const line = el('line', {
          x1: v1.x * S, y1: v1.y * S, x2: v2.x * S, y2: v2.y * S,
          stroke: 'rgba(255,215,106,0.85)', 'stroke-width': 10, 'stroke-linecap': 'round',
          'stroke-dasharray': '6 6', cursor: 'pointer', class: 'hl-pulse hl-ants',
          filter: 'url(#goldGlow)',
        });
        line.addEventListener('click', () => ui.onEdgeClick && ui.onEdgeClick(edge.id));
        svg.appendChild(line);
      }
    }
    if (hlVertices.size > 0) {
      for (const v of board.vertices) {
        if (!hlVertices.has(v.id)) continue;
        const c = el('circle', {
          cx: v.x * S, cy: v.y * S, r: 11,
          fill: 'rgba(255,215,106,0.55)', stroke: '#fff3cf', 'stroke-width': 2.5,
          cursor: 'pointer', class: 'hl-pulse hl-breathe',
          filter: 'url(#goldGlow)',
        });
        c.addEventListener('click', () => ui.onVertexClick && ui.onVertexClick(v.id));
        svg.appendChild(c);
      }
    }

    // Animaciones del tablero (CSS dentro del SVG: sobreviven re-renders,
    // se reinician gracefully y se pausan solas cuando la pantalla esta oculta)
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `
      .hl-pulse { animation: hlp 1.3s ease-in-out infinite; }
      .hl-ants { animation: hlp 1.3s ease-in-out infinite, ants 1.5s linear infinite; }
      .hl-breathe {
        transform-box: fill-box; transform-origin: 50% 50%;
        animation: hlp 1.3s ease-in-out infinite, breathe 1.3s ease-in-out infinite;
      }
      @keyframes hlp { 0%,100% { opacity: 0.55; } 50% { opacity: 1; } }
      @keyframes ants { to { stroke-dashoffset: -32; } }
      @keyframes breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.25); } }

      .sea-wave { animation: seaBob 4.5s ease-in-out infinite; }
      @keyframes seaBob {
        0%,100% { transform: translateY(0); opacity: 0.45; }
        50%     { transform: translateY(-3.5px); opacity: 1; }
      }
      .sway {
        transform-box: fill-box; transform-origin: 50% 100%;
        animation: sway 5s ease-in-out infinite;
      }
      @keyframes sway { 0%,100% { transform: rotate(-1.7deg); } 50% { transform: rotate(1.9deg); } }
      .wheat-sway {
        transform-box: fill-box; transform-origin: 50% 100%;
        animation: wheatSway 4s ease-in-out infinite;
      }
      @keyframes wheatSway { 0%,100% { transform: skewX(-3.5deg); } 50% { transform: skewX(3.5deg); } }
      .sheep-bob {
        transform-box: fill-box; transform-origin: 50% 100%;
        animation: sheepBob 6s ease-in-out infinite;
      }
      @keyframes sheepBob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1.4px); } }
      .snow-glint { animation: snowGlint 6s ease-in-out infinite; }
      @keyframes snowGlint { 0%,100% { opacity: 0.75; } 50% { opacity: 1; } }

      .robber-aura {
        transform-box: fill-box; transform-origin: 50% 50%;
        animation: robberAura 2.4s ease-in-out infinite;
      }
      @keyframes robberAura {
        0%,100% { transform: scale(1); opacity: 0.35; }
        50%     { transform: scale(1.45); opacity: 0.65; }
      }
      .robber-drop { animation: robberDrop 0.65s cubic-bezier(0.34, 1.56, 0.64, 1); }
      @keyframes robberDrop {
        from { transform: translateY(-30px); opacity: 0; }
        to   { transform: translateY(0); opacity: 0.94; }
      }
      .piece-pop {
        transform-box: fill-box; transform-origin: 50% 65%;
        animation: piecePop 0.55s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      @keyframes piecePop { from { transform: scale(0); } to { transform: scale(1); } }
      .tile-in {
        transform-box: fill-box; transform-origin: 50% 50%;
        animation: tileIn 0.6s ease both;
      }
      @keyframes tileIn {
        from { opacity: 0; transform: scale(0.8); }
        to   { opacity: 1; transform: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .sea-wave, .sway, .wheat-sway, .sheep-bob, .snow-glint, .robber-aura,
        .robber-drop, .piece-pop, .tile-in, .hl-ants, .hl-breathe, .hl-pulse {
          animation: none !important;
        }
      }
    `;
    svg.appendChild(style);

    container.innerHTML = '';
    container.appendChild(svg);
  }

  window.renderBoard = renderBoard;
})();
