// Captcha falso "Arrastra a Gaston a su correa": chiste interno para molestar
// a Gaston (toma muchas potas y se queda bajo torre). Expone
// window.GastonCaptcha.show(onSuccess). Usa GSAP si esta disponible.

(function () {
  'use strict';

  const QUIPS = [
    'Gaston se escapo a comprar potas.',
    'Casi. Gaston vio una ardilla.',
    'Gaston dice que esta full bajo torre.',
    'Se te resbalo. Gaston es escurridizo.',
    'Gaston fue a farmear la ola de subditos.',
  ];

  // Posiciones dentro de la escena de 460x250
  const DOG_START = { x: 55, y: 132 };
  const TARGET = { x: 318, y: 168 };
  const HIT_RADIUS = 46;

  let overlay = null;
  let fails = 0;

  function sceneSvg() {
    return `
<svg viewBox="0 0 460 250" width="100%" height="100%">
  <defs>
    <linearGradient id="capSky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#a8c8de"/>
      <stop offset="0.62" stop-color="#e8c9a0"/>
      <stop offset="0.66" stop-color="#c9dba8"/>
      <stop offset="1" stop-color="#9ec27c"/>
    </linearGradient>
  </defs>
  <rect width="460" height="250" fill="url(#capSky)"/>
  <circle cx="70" cy="42" r="18" fill="#ffedb8" opacity="0.9"/>
  <ellipse cx="150" cy="52" rx="34" ry="10" fill="#fff" opacity="0.5"/>
  <ellipse cx="255" cy="30" rx="26" ry="8" fill="#fff" opacity="0.4"/>

  <!-- arbol -->
  <g stroke="#3a2a18" stroke-width="2.5" stroke-linejoin="round">
    <path fill="#8f5a3c" d="M398 210 C396 175 394 150 390 128 L386 96 L402 96 L400 128 C400 152 402 178 408 210 Z"/>
    <path fill="#8f5a3c" d="M390 120 C378 112 370 104 366 94 L376 90 C382 100 388 108 394 114 Z"/>
    <ellipse cx="394" cy="70" rx="52" ry="36" fill="#4a7c3a"/>
    <ellipse cx="356" cy="88" rx="30" ry="22" fill="#568a44"/>
    <ellipse cx="432" cy="88" rx="28" ry="20" fill="#568a44"/>
  </g>

  <!-- correa atada al arbol -->
  <path id="cap-leash" d="M392 130 C 372 158 348 172 ${TARGET.x + 14} ${TARGET.y - 6}"
        fill="none" stroke="#b98a54" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="7 5"/>
  <!-- collar / lugar de Gaston -->
  <ellipse cx="${TARGET.x}" cy="${TARGET.y + 22}" rx="40" ry="9" fill="rgba(40,25,10,0.18)"/>
  <circle id="cap-target" cx="${TARGET.x}" cy="${TARGET.y}" r="34" fill="rgba(255,215,106,0.18)"
          stroke="#c9a24c" stroke-width="2.5" stroke-dasharray="8 7"/>
  <g stroke="#3a2a18" stroke-width="2">
    <circle cx="${TARGET.x + 14}" cy="${TARGET.y - 4}" r="7" fill="none" stroke="#a32c22" stroke-width="4"/>
  </g>
  <!-- cartelito -->
  <g stroke="#3a2a18" stroke-width="2" stroke-linejoin="round">
    <rect x="${TARGET.x - 32}" y="${TARGET.y + 32}" width="64" height="20" rx="3" fill="#d9b98a"/>
    <line x1="${TARGET.x}" y1="${TARGET.y + 30}" x2="${TARGET.x}" y2="${TARGET.y + 26}"/>
  </g>
  <text x="${TARGET.x}" y="${TARGET.y + 46}" text-anchor="middle"
        font-family="Georgia, serif" font-size="12" font-weight="900" fill="#5a3a20">GASTON</text>

  <!-- huesito y pota tiradas -->
  <g stroke="#3a2a18" stroke-width="1.6">
    <path fill="#f3ecdc" d="M180 216 l16 -5 a4 4 0 1 1 5 5 a4 4 0 1 1 -7 3 l-16 5 a4 4 0 1 1 -5 -5 a4 4 0 1 1 7 -3 Z"/>
  </g>
  <g stroke="#3a2a18" stroke-width="1.6">
    <circle cx="120" cy="222" r="9" fill="#7fd490"/>
    <circle cx="120" cy="222" r="9" fill="none" stroke="#dfeef4" stroke-width="2" opacity="0.7"/>
    <rect x="117" y="209" width="6" height="6" rx="1.5" fill="#a9714f"/>
  </g>
</svg>`;
  }

  function dogSvg() {
    return `
<svg viewBox="0 0 110 100" width="110" height="100" style="overflow:visible">
  <g stroke="#3a2a18" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">
    <!-- cola (wag con CSS) -->
    <g class="cap-tail">
      <path fill="#c98d5a" d="M18 62 C8 56 4 46 8 38 C12 42 16 48 24 52 Z"/>
    </g>
    <!-- pata trasera -->
    <ellipse cx="34" cy="66" rx="20" ry="18" fill="#c98d5a"/>
    <!-- cuerpo -->
    <path fill="#c98d5a" d="M30 80 C28 62 36 46 54 42 L74 46 C82 58 84 70 82 82 C70 86 44 86 30 80 Z"/>
    <!-- mancha -->
    <path fill="#8f5a3c" d="M44 58 C52 52 62 52 68 58 C66 66 52 68 44 64 Z" stroke="none"/>
    <!-- patas delanteras -->
    <path fill="#c98d5a" d="M56 66 L55 84 C55 87 58 88 61 88 L64 88 C66 88 66 85 65 83 L64 66 Z"/>
    <path fill="#c98d5a" d="M70 66 L70 84 C70 87 73 88 76 88 L79 88 C81 88 81 85 80 83 L78 66 Z"/>
    <!-- cabeza -->
    <g class="cap-head">
      <circle cx="76" cy="34" r="21" fill="#c98d5a"/>
      <!-- oreja caida -->
      <path fill="#8f5a3c" d="M60 20 C54 26 53 38 58 46 C64 44 67 36 67 28 C65 23 63 20 60 20 Z"/>
      <path fill="#8f5a3c" d="M88 16 C94 22 96 32 92 40 C86 38 83 30 84 23 C85 19 86 16 88 16 Z"/>
      <!-- hocico -->
      <ellipse cx="88" cy="42" rx="12" ry="9" fill="#f3e5c3"/>
      <ellipse cx="93" cy="38" rx="4.5" ry="3.6" fill="#3a2a18" stroke="none"/>
      <path d="M88 44 C90 47 93 47 95 45" fill="none"/>
      <!-- ojo -->
      <circle cx="74" cy="30" r="2.6" fill="#3a2a18" stroke="none"/>
      <path d="M68 24 C70 22 73 22 75 23" fill="none" stroke-width="1.8"/>
    </g>
    <!-- collar rojo -->
    <path fill="#a32c22" d="M60 48 C66 52 76 53 84 50 L84 56 C76 59 66 58 59 54 Z"/>
    <circle cx="72" cy="57" r="3.4" fill="#e8b64c"/>
  </g>
</svg>`;
  }

  function buildDom() {
    overlay = document.createElement('div');
    overlay.className = 'cap-overlay';
    overlay.innerHTML = `
      <div class="cap-box">
        <div class="cap-head-bar">
          <div class="cap-shield">🛡️</div>
          <div>
            <div class="cap-title">Verificacion de seguridad</div>
            <div class="cap-sub">Comproba que no sos un bot (ni Gaston)</div>
          </div>
        </div>
        <div class="cap-task">Arrastra a <b>Gaston</b> hasta su correa</div>
        <div class="cap-scene">
          ${sceneSvg()}
          <div class="cap-dog" id="cap-dog">${dogSvg()}</div>
          <div class="cap-msg" id="cap-msg"></div>
          <div class="cap-success" id="cap-success">
            <div class="cap-check">✔</div>
            <div>Verificado: Gaston atado a su torre</div>
          </div>
        </div>
        <div class="cap-foot">
          <span class="cap-fakebox"></span> No soy Gaston
          <span class="cap-brand">CAPTCHA™ Torre Segura v0.9</span>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }

  function show(onSuccess) {
    if (overlay) return;
    fails = 0;
    buildDom();

    const box = overlay.querySelector('.cap-box');
    const dog = overlay.querySelector('#cap-dog');
    const msg = overlay.querySelector('#cap-msg');
    const scene = overlay.querySelector('.cap-scene');
    const g = window.gsap;

    // Posicion inicial directa (la entrada animada la hace CSS: .cap-overlay/.cap-box/.cap-dog)
    if (g) g.set(dog, { x: DOG_START.x, y: DOG_START.y });
    else dog.style.transform = `translate(${DOG_START.x}px, ${DOG_START.y}px)`;

    let dragging = false;
    let pos = { ...DOG_START };
    let last = { x: 0, y: 0 };

    const setDog = (x, y, extra) => {
      pos = { x, y };
      if (g) g.set(dog, { x, y, ...extra });
      else dog.style.transform = `translate(${x}px, ${y}px)`;
    };

    dog.addEventListener('pointerdown', (e) => {
      dragging = true;
      dog.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
      dog.classList.add('dragging');
      if (g) g.to(dog, { scale: 1.08, duration: 0.15 });
    });

    dog.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = scene.getBoundingClientRect();
      const k = 460 / rect.width; // la escena escala responsive
      const nx = Math.max(-10, Math.min(370, pos.x + (e.clientX - last.x) * k));
      const ny = Math.max(0, Math.min(165, pos.y + (e.clientY - last.y) * k));
      const tilt = Math.max(-14, Math.min(14, (e.clientX - last.x) * 1.6));
      last = { x: e.clientX, y: e.clientY };
      setDog(nx, ny, { rotation: tilt });
    });

    dog.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      dog.classList.remove('dragging');
      // el centro del perro dibujado cae ~(55,55) dentro de su svg de 110x100
      const cx = pos.x + 55;
      const cy = pos.y + 55;
      const dist = Math.hypot(cx - TARGET.x, cy - TARGET.y);
      if (dist <= HIT_RADIUS) success();
      else fail();
    });

    function fail() {
      fails++;
      msg.textContent = QUIPS[(fails - 1) % QUIPS.length];
      msg.classList.add('show');
      setTimeout(() => msg.classList.remove('show'), 2200);
      if (g) {
        g.to(dog, {
          x: DOG_START.x, y: DOG_START.y, rotation: 0, scale: 1,
          duration: 0.8, ease: 'elastic.out(1, 0.55)',
        });
        g.fromTo(box, { x: 0 }, { x: 7, duration: 0.06, repeat: 5, yoyo: true, clearProps: 'x' });
        pos = { ...DOG_START };
      } else {
        setDog(DOG_START.x, DOG_START.y);
      }
    }

    function success() {
      const target = overlay.querySelector('#cap-target');
      const leash = overlay.querySelector('#cap-leash');
      const banner = overlay.querySelector('#cap-success');

      // acomoda al perro en el circulo y conecta la correa al collar
      const snapX = TARGET.x - 55;
      const snapY = TARGET.y - 52;
      if (g) g.to(dog, { x: snapX, y: snapY, rotation: 0, scale: 1, duration: 0.35, ease: 'power2.out' });
      else setDog(snapX, snapY);
      pos = { x: snapX, y: snapY };

      leash.setAttribute('d', `M392 130 C 372 160 ${TARGET.x + 40} ${TARGET.y - 40} ${TARGET.x + 18} ${TARGET.y + 2}`);
      leash.removeAttribute('stroke-dasharray');
      if (g) {
        const len = leash.getTotalLength();
        g.fromTo(leash, { strokeDasharray: len, strokeDashoffset: len },
          { strokeDashoffset: 0, duration: 0.55, delay: 0.3, ease: 'power2.inOut' });
        g.to(target, { opacity: 0, duration: 0.4, delay: 0.3 });
      } else {
        target.style.opacity = 0;
      }
      dog.classList.add('happy');

      setTimeout(() => banner.classList.add('show'), 850);
      setTimeout(() => {
        if (g) g.to(overlay, { opacity: 0, duration: 0.35, onComplete: close });
        else close();
        onSuccess();
      }, 2100);
    }

    function close() {
      if (overlay) { overlay.remove(); overlay = null; }
    }

    // click afuera no cierra (es un "captcha", no hay escapatoria)
  }

  window.GastonCaptcha = { show };
})();
