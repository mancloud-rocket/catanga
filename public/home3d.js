// Escena 3D hiperrealista para home/lobby: cielo atmosferico, oceano con
// reflexion real, isla de Catan procedural, cinematica de entrada y audio
// ambiente. ES module con fallback total al fondo CSS 2D (.cine-bg).
// Contrato con client.js: window.Home3D.onScreenChange(name) + cola
// window.__home3dQueue para eventos previos a la carga del module.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';

'use strict';

const params = new URLSearchParams(location.search);
const FORCE_2D = params.get('force2d') === '1';
const SKIP_INTRO = params.get('skipintro') === '1';
const DEBUG = params.get('debug3d') === '1';

const IS_TOUCH = navigator.maxTouchPoints > 0;
const IS_SMALL = window.innerWidth < 720;
const LOW_DETAIL = IS_TOUCH || IS_SMALL;

// ---------- Estado del modulo ----------

let renderer = null;
let scene = null;
let camera = null;
let clock = null;
let rafId = null;
let initialized = false;      // hay escena viva
let permanentFallback = false; // esta sesion queda en CSS 2D
let currentScreen = null;
let frameCount = 0;
let errorCount = 0;
let debugEl = null;

// La camara siempre mira a camTarget; GSAP anima solo numeros.
const camTarget = new THREE.Vector3(-5, 1.6, -2);
// Encuadre "oficial" de la pantalla actual; el parallax compone encima.
const baseCamPos = new THREE.Vector3(2, 9, 30);

const updaters = []; // funciones (t, dt) => void registradas por cada pieza

let introActive = false; // durante la cinematica GSAP controla la camara
let parallaxX = 0;
let parallaxY = 0;

window.addEventListener('error', () => { errorCount++; });

// ---------- Guards ----------

function webglSupported() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function fallbackReason() {
  if (FORCE_2D) return 'force2d';
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'reduced-motion';
  if (!webglSupported()) return 'no-webgl';
  return null;
}

// ---------- Debug overlay (visible aunque el canvas salga negro) ----------

function makeDebugOverlay() {
  debugEl = document.createElement('div');
  debugEl.id = 'debug3d';
  debugEl.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9999;background:rgba(0,0,0,0.75);' +
    'color:#7CFC00;font:12px/1.5 Consolas,monospace;padding:8px 12px;border-radius:6px;pointer-events:none;white-space:pre;';
  document.body.appendChild(debugEl);
}

function updateDebug(mode, fps) {
  if (!debugEl) return;
  const info = renderer ? renderer.info.render : { calls: 0, triangles: 0 };
  debugEl.textContent =
    `mode: ${mode}\n` +
    `frame: ${frameCount}\n` +
    `fps: ${fps.toFixed(0)}\n` +
    `calls: ${info.calls}  tris: ${info.triangles}\n` +
    `screen: ${currentScreen}\n` +
    `errors: ${errorCount}`;
}

// ---------- Cielo ----------

const sunDir = new THREE.Vector3();

function buildSky() {
  const sky = new Sky();
  sky.scale.setScalar(3000);
  const u = sky.material.uniforms;
  u.turbidity.value = 8;
  u.rayleigh.value = 2.6;
  u.mieCoefficient.value = 0.003;
  u.mieDirectionalG.value = 0.75;
  sunDir.setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - 4),  // sol bajo: golden hour dramatica
    THREE.MathUtils.degToRad(155)      // sol a la derecha del encuadre (glint visible)
  );
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);

  // Iluminacion: la luz "key" va mas alta que el sol visible (truco de cine:
  // el disco esta en el horizonte pero la isla recibe luz como a media mañana)
  const keyDir = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - 35),
    THREE.MathUtils.degToRad(150)
  );
  const sun = new THREE.DirectionalLight(0xffe0b0, 4.5);
  sun.position.copy(keyDir).multiplyScalar(120);
  sun.castShadow = !LOW_DETAIL;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -20;
  sun.shadow.camera.right = 20;
  sun.shadow.camera.top = 20;
  sun.shadow.camera.bottom = -20;
  sun.shadow.camera.near = 60;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0006;
  // El sol sigue a la isla (offset fijo): target en el centro de la isla
  sun.target.position.set(-14, 0, -5);
  scene.add(sun);
  scene.add(sun.target);

  scene.add(new THREE.HemisphereLight(0xbad4e8, 0x2a4a5a, 1.1));
}

// ---------- Oceano ----------

// Normal map procedural (fallback si falta waternormals.jpg): value-noise
// multi-octava convertido a normal map con sobel.
function makeProceduralWaterNormals() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);

  // heightfield tileable con 3 octavas de ruido senoidal desfasado
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * Math.PI * 2;
      const v = (y / size) * Math.PI * 2;
      h[y * size + x] =
        Math.sin(u * 3 + Math.cos(v * 2)) * 0.5 +
        Math.sin(v * 5 + Math.cos(u * 4) * 1.7) * 0.3 +
        Math.sin((u + v) * 8) * 0.2;
    }
  }
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      const i = (y * size + x) * 4;
      img.data[i] = (dx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (dy * 0.5 + 0.5) * 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

let water = null;

function buildOcean() {
  const loader = new THREE.TextureLoader();
  const normals = loader.load(
    '/vendor/three/textures/waternormals.jpg',
    (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; },
    undefined,
    () => {
      // textura ausente: normal map procedural
      if (water) water.material.uniforms.normalSampler.value = makeProceduralWaterNormals();
    }
  );
  normals.wrapS = normals.wrapT = THREE.RepeatWrapping;

  water = new Water(new THREE.PlaneGeometry(4000, 4000), {
    textureWidth: LOW_DETAIL ? 256 : 512,
    textureHeight: LOW_DETAIL ? 256 : 512,
    waterNormals: normals,
    sunDirection: sunDir.clone(),
    sunColor: 0xffdcb0,
    waterColor: 0x001e26,
    distortionScale: 3.7,
    fog: true,
  });
  water.rotation.x = -Math.PI / 2;
  scene.add(water);

  updaters.push((t, dt) => {
    water.material.uniforms.time.value += dt * 0.6;
  });
}

// Halo del sol: sprite aditivo con gradiente radial (bloom barato)
function buildSunHalo() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,238,200,0.75)');
  grad.addColorStop(0.2, 'rgba(255,200,130,0.22)');
  grad.addColorStop(0.5, 'rgba(255,170,95,0.07)');
  grad.addColorStop(0.8, 'rgba(255,170,95,0.02)');
  grad.addColorStop(1, 'rgba(255,170,95,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const mat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(sunDir).multiplyScalar(1800);
  sprite.scale.setScalar(380);
  sprite.renderOrder = 2;
  scene.add(sprite);
}

// ---------- Isla de Catan ----------

// rng determinista para que la isla sea identica en cada carga
function makeRng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = 2.55; // circunradio de cada tile
const TILE_H = { mountains: 1.15, forest: 0.78, hills: 0.62, pasture: 0.5, fields: 0.5, desert: 0.42 };
const TILE_COLOR = {
  forest: 0x2d6633, pasture: 0x92bd4e, fields: 0xdcb32e,
  hills: 0xbc6432, mountains: 0x8d99a3, desert: 0xdcc890,
};
// Composicion fija: montañas atras-izq (contra el sol), bosque al frente,
// desierto escondido atras, poblado heroe en el pasto frontal.
const ISLAND_LAYOUT = [
  { q: 0, r: -2, t: 'mountains', n: 8 }, { q: 1, r: -2, t: 'forest', n: 5 }, { q: 2, r: -2, t: 'pasture', n: 9 },
  { q: -1, r: -1, t: 'mountains', n: 6 }, { q: 0, r: -1, t: 'forest', n: 3 }, { q: 1, r: -1, t: 'fields', n: 11 },
  { q: 2, r: -1, t: 'desert', n: null },
  { q: -2, r: 0, t: 'mountains', n: 5 }, { q: -1, r: 0, t: 'hills', n: 10 }, { q: 0, r: 0, t: 'fields', n: 6 },
  { q: 1, r: 0, t: 'pasture', n: 4 }, { q: 2, r: 0, t: 'forest', n: 9 },
  { q: -2, r: 1, t: 'forest', n: 4 }, { q: -1, r: 1, t: 'fields', n: 12 }, { q: 0, r: 1, t: 'pasture', n: 10 },
  { q: 1, r: 1, t: 'hills', n: 8 },
  { q: -2, r: 2, t: 'hills', n: 3 }, { q: -1, r: 2, t: 'pasture', n: 2 }, { q: 0, r: 2, t: 'fields', n: 11 },
];

function axialToWorld(q, r) {
  return { x: Math.sqrt(3) * HEX * (q + r / 2) * 0.99, z: 1.5 * HEX * r * 0.99 };
}

let islandGroup = null;

function buildIsland() {
  const rng = makeRng(7);
  islandGroup = new THREE.Group();
  islandGroup.position.set(-14, 0.35, -5);
  islandGroup.scale.setScalar(0.65);

  // --- Base de arena con costa irregular y suave ---
  const baseGeo = new THREE.CylinderGeometry(13.8, 16.2, 1.7, 160, 1);
  const pos = baseGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const ang = Math.atan2(z, x);
    const wob = 1 + Math.sin(ang * 4 + 1.3) * 0.045 + Math.sin(ang * 7 + 4.1) * 0.025;
    pos.setX(i, x * wob);
    pos.setZ(i, z * wob);
  }
  baseGeo.computeVertexNormals();
  const base = new THREE.Mesh(
    baseGeo,
    new THREE.MeshStandardMaterial({ color: 0xd9c48c, roughness: 1 })
  );
  base.position.y = 0.15;
  base.receiveShadow = true;
  islandGroup.add(base);

  // --- Espuma alrededor de la costa (dos anillos con pulso) ---
  const foamMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.35,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const foam1 = new THREE.Mesh(new THREE.RingGeometry(15.6, 17.4, 128), foamMat);
  foam1.rotation.x = -Math.PI / 2;
  foam1.position.y = -0.42; // apenas sobre el agua (grupo en y=0.35, escala 0.65)
  islandGroup.add(foam1);
  const foam2 = new THREE.Mesh(new THREE.RingGeometry(17.8, 18.6, 128), foamMat.clone());
  foam2.material.opacity = 0.15;
  foam2.rotation.x = -Math.PI / 2;
  foam2.position.y = -0.44;
  islandGroup.add(foam2);
  updaters.push((t) => {
    foam1.material.opacity = 0.28 + Math.sin(t * 0.9) * 0.1;
    foam2.material.opacity = 0.12 + Math.sin(t * 0.9 + 1.5) * 0.06;
    const s = 1 + Math.sin(t * 0.9 + 0.7) * 0.012;
    foam2.scale.setScalar(s);
  });

  // --- Materiales por terreno (compartidos) ---
  const tileMats = {};
  for (const [terr, color] of Object.entries(TILE_COLOR)) {
    tileMats[terr] = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 });
  }
  const tileSideMat = new THREE.MeshStandardMaterial({ color: 0xcbb37e, roughness: 1 });

  // --- 19 tiles hexagonales ---
  const BASE_TOP = 1.0;
  const tileTopY = {}; // "q,r" -> altura de la cara superior (para deco)
  for (const cell of ISLAND_LAYOUT) {
    const { x, z } = axialToWorld(cell.q, cell.r);
    const h = TILE_H[cell.t];
    const geo = new THREE.CylinderGeometry(HEX, HEX, h, 6);
    const tile = new THREE.Mesh(geo, [tileSideMat, tileMats[cell.t], tileSideMat]);
    tile.position.set(x, BASE_TOP + h / 2, z);
    tile.rotation.y = Math.PI / 6; // pointy-top visto desde la camara
    tile.castShadow = true;
    tile.receiveShadow = true;
    islandGroup.add(tile);
    tileTopY[`${cell.q},${cell.r}`] = BASE_TOP + h;
  }

  buildTileDeco(rng, tileTopY);
  buildTokens(tileTopY);
  buildVillage(tileTopY);

  scene.add(islandGroup);
}

// Deco low-poly instanciada por tipo de terreno
function buildTileDeco(rng, tileTopY) {
  const detail = LOW_DETAIL ? 0.5 : 1;

  const jitterOnTile = (cell, radius) => {
    const { x, z } = axialToWorld(cell.q, cell.r);
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * radius;
    return { x: x + Math.cos(a) * d, z: z + Math.sin(a) * d, top: tileTopY[`${cell.q},${cell.r}`] };
  };
  const cellsOf = (t) => ISLAND_LAYOUT.filter((c) => c.t === t);

  // --- Pinos: tronco + dos conos ---
  const pineCells = cellsOf('forest');
  const pinesPerTile = Math.round(7 * detail);
  const pineCount = pineCells.length * pinesPerTile;
  const trunkGeo = new THREE.CylinderGeometry(0.09, 0.13, 0.5, 8);
  const conesGeo = new THREE.ConeGeometry(0.55, 1.4, 10);
  const cone2Geo = new THREE.ConeGeometry(0.4, 1.0, 10);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1e, roughness: 1 });
  const pineMat = new THREE.MeshStandardMaterial({ color: 0x1d4f26, roughness: 0.9 });
  const pine2Mat = new THREE.MeshStandardMaterial({ color: 0x276333, roughness: 0.9 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, pineCount);
  const cones = new THREE.InstancedMesh(conesGeo, pineMat, pineCount);
  const cones2 = new THREE.InstancedMesh(cone2Geo, pine2Mat, pineCount);
  const m = new THREE.Matrix4();
  let pi = 0;
  for (const cell of pineCells) {
    for (let k = 0; k < pinesPerTile; k++) {
      const p = jitterOnTile(cell, HEX * 0.62);
      const s = 0.75 + rng() * 0.6;
      m.makeScale(s, s, s).setPosition(p.x, p.top + 0.25 * s, p.z);
      trunks.setMatrixAt(pi, m);
      m.makeScale(s, s, s).setPosition(p.x, p.top + 0.95 * s, p.z);
      cones.setMatrixAt(pi, m);
      m.makeScale(s, s, s).setPosition(p.x, p.top + 1.55 * s, p.z);
      cones2.setMatrixAt(pi, m);
      pi++;
    }
  }
  for (const im of [trunks, cones, cones2]) { im.castShadow = true; islandGroup.add(im); }

  // --- Montañas: conos desplazados con normales suaves + nieve ---
  const mtnCells = cellsOf('mountains');
  const rocksPerTile = 2;
  const rockGeo = new THREE.ConeGeometry(1.2, 2.4, 16, 8);
  {
    // desplaza los vertices con ruido senoidal (respetando la punta y la base)
    const rp = rockGeo.attributes.position;
    for (let i = 0; i < rp.count; i++) {
      const x = rp.getX(i), y = rp.getY(i), z = rp.getZ(i);
      const ang = Math.atan2(z, x);
      const hFactor = 1 - Math.abs(y) / 1.25; // 0 en punta/base, 1 al medio
      const n = (Math.sin(ang * 3 + y * 2.2) * 0.12 + Math.sin(ang * 6 + 1.7) * 0.07) * Math.max(0, hFactor);
      rp.setX(i, x * (1 + n));
      rp.setZ(i, z * (1 + n));
    }
    rockGeo.computeVertexNormals();
  }
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x7d8a93, roughness: 0.95 });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, mtnCells.length * rocksPerTile);
  const snowGeo = new THREE.ConeGeometry(0.4, 0.62, 16);
  const snowMat = new THREE.MeshStandardMaterial({ color: 0xe8edf0, roughness: 0.6 });
  const snows = new THREE.InstancedMesh(snowGeo, snowMat, mtnCells.length);
  let ri = 0, si = 0;
  for (const cell of mtnCells) {
    for (let k = 0; k < rocksPerTile; k++) {
      const p = jitterOnTile(cell, HEX * 0.38);
      const s = 0.75 + rng() * 0.5;
      m.makeRotationY(rng() * Math.PI);
      m.scale(new THREE.Vector3(s, s, s));
      m.setPosition(p.x, p.top + 1.2 * s, p.z);
      rocks.setMatrixAt(ri++, m);
      if (k === 0) {
        // gorro de nieve sobre la punta del pico grande
        m.makeRotationY(rng() * Math.PI);
        m.setPosition(p.x, p.top + 2.4 * s - 0.22, p.z);
        snows.setMatrixAt(si++, m);
      }
    }
  }
  rocks.castShadow = true;
  islandGroup.add(rocks, snows);

  // --- Trigo: hileras doradas ---
  const fieldCells = cellsOf('fields');
  const rowsPerTile = 3;
  const rowGeo = new THREE.BoxGeometry(2.4, 0.22, 0.5);
  const rowMat = new THREE.MeshStandardMaterial({ color: 0xc9982a, roughness: 0.9 });
  const rows = new THREE.InstancedMesh(rowGeo, rowMat, fieldCells.length * rowsPerTile);
  let fi = 0;
  for (const cell of fieldCells) {
    const { x, z } = axialToWorld(cell.q, cell.r);
    const top = tileTopY[`${cell.q},${cell.r}`];
    for (let k = 0; k < rowsPerTile; k++) {
      m.makeRotationY((rng() - 0.5) * 0.5);
      m.setPosition(x + (rng() - 0.5) * 1.2, top + 0.11, z + (k - 1) * 1.15);
      rows.setMatrixAt(fi++, m);
    }
  }
  rows.castShadow = true;
  islandGroup.add(rows);

  // --- Ovejas ---
  const pastCells = cellsOf('pasture');
  const sheepPerTile = Math.max(1, Math.round(2 * detail));
  const sheepGeo = new THREE.SphereGeometry(0.28, 14, 10);
  sheepGeo.scale(1.35, 1, 1);
  const sheepMat = new THREE.MeshStandardMaterial({ color: 0xf4f1e6, roughness: 1 });
  const sheep = new THREE.InstancedMesh(sheepGeo, sheepMat, pastCells.length * sheepPerTile);
  let shi = 0;
  for (const cell of pastCells) {
    for (let k = 0; k < sheepPerTile; k++) {
      const p = jitterOnTile(cell, HEX * 0.55);
      m.makeRotationY(rng() * Math.PI * 2);
      m.setPosition(p.x, p.top + 0.26, p.z);
      sheep.setMatrixAt(shi++, m);
    }
  }
  sheep.castShadow = true;
  islandGroup.add(sheep);

  // --- Ladrillos apilados ---
  const hillCells = cellsOf('hills');
  const stacksPerTile = 2;
  const brickGeo = new THREE.BoxGeometry(0.62, 0.3, 0.34);
  const brickMat = new THREE.MeshStandardMaterial({ color: 0x9c3c1e, roughness: 0.9 });
  const bricks = new THREE.InstancedMesh(brickGeo, brickMat, hillCells.length * stacksPerTile * 3);
  let bi = 0;
  for (const cell of hillCells) {
    for (let k = 0; k < stacksPerTile; k++) {
      const p = jitterOnTile(cell, HEX * 0.45);
      const rot = rng() * Math.PI;
      for (let lvl = 0; lvl < 3; lvl++) {
        m.makeRotationY(rot + lvl * 0.25);
        m.setPosition(p.x + (lvl % 2) * 0.1, p.top + 0.16 + lvl * 0.31, p.z);
        bricks.setMatrixAt(bi++, m);
      }
    }
  }
  bricks.castShadow = true;
  islandGroup.add(bricks);
}

// Tokens numerados sobre los tiles (canvas con numero, rojo para 6/8)
function buildTokens(tileTopY) {
  const geo = new THREE.CylinderGeometry(0.46, 0.46, 0.09, 20);
  const sideMat = new THREE.MeshStandardMaterial({ color: 0xd9c9a0, roughness: 0.8 });
  for (const cell of ISLAND_LAYOUT) {
    if (cell.n === null) continue;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#f2e3bd';
    g.beginPath();
    g.arc(32, 32, 32, 0, Math.PI * 2);
    g.fill();
    const red = cell.n === 6 || cell.n === 8;
    g.fillStyle = red ? '#b3251a' : '#3a2a18';
    g.font = `900 ${red ? 34 : 30}px Georgia`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(cell.n), 32, 30);
    const dots = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 }[cell.n] || 0;
    for (let i = 0; i < dots; i++) {
      g.beginPath();
      g.arc(32 + (i - (dots - 1) / 2) * 7, 50, 2.2, 0, Math.PI * 2);
      g.fill();
    }
    const topMat = new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(c), roughness: 0.7 });
    const token = new THREE.Mesh(geo, [sideMat, topMat, sideMat]);
    const { x, z } = axialToWorld(cell.q, cell.r);
    token.position.set(x, tileTopY[`${cell.q},${cell.r}`] + 0.05, z);
    token.castShadow = true;
    islandGroup.add(token);
  }
}

// Poblado heroe: casitas con techo rojo + torre, en el pasto frontal
function buildVillage(tileTopY) {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xa32c22, roughness: 0.8 });
  const cell = ISLAND_LAYOUT.find((c) => c.q === 0 && c.r === 2); // pasto frontal... fields frontal
  const { x, z } = axialToWorld(cell.q, cell.r);
  const top = tileTopY[`${cell.q},${cell.r}`];

  const group = new THREE.Group();
  const housePositions = [[-0.9, 0.5], [0.4, -0.3], [1.0, 0.7]];
  for (const [hx, hz] of housePositions) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.55, 0.6), wallMat);
    wall.position.set(hx, 0.28, hz);
    const roofGeo = new THREE.CylinderGeometry(0.08, 0.55, 0.5, 4);
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.position.set(hx, 0.8, hz);
    wall.castShadow = roof.castShadow = true;
    group.add(wall, roof);
  }
  // torre-ciudad
  const tower = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.2, 0.55), wallMat);
  tower.position.set(-0.2, 0.6, -0.9);
  const towerRoof = new THREE.Mesh(new THREE.ConeGeometry(0.48, 0.6, 4), roofMat);
  towerRoof.rotation.y = Math.PI / 4;
  towerRoof.position.set(-0.2, 1.5, -0.9);
  tower.castShadow = towerRoof.castShadow = true;
  group.add(tower, towerRoof);

  group.position.set(x, top, z);
  islandGroup.add(group);
}

// ---------- Nubes, pajaros y parallax ----------

function makeCloudTexture(rng, blobs) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  for (let i = 0; i < blobs; i++) {
    const x = 40 + rng() * 176;
    const y = 45 + rng() * 40;
    const r = 22 + rng() * 34;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,250,244,0.55)');
    grad.addColorStop(0.6, 'rgba(255,246,238,0.28)');
    grad.addColorStop(1, 'rgba(255,246,238,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 128);
  }
  return new THREE.CanvasTexture(c);
}

const cloudMeshes = [];

function buildClouds() {
  const rng = makeRng(23);
  const textures = [makeCloudTexture(rng, 9), makeCloudTexture(rng, 12), makeCloudTexture(rng, 7)];
  const count = LOW_DETAIL ? 7 : 14;
  for (let i = 0; i < count; i++) {
    const highLayer = i < count * 0.4; // capa alta: la atraviesa la cinematica
    const mat = new THREE.MeshBasicMaterial({
      map: textures[i % 3],
      transparent: true,
      opacity: highLayer ? 0.8 : 0.55,
      depthWrite: false,
      fog: false,
    });
    const w = 90 + rng() * 140;
    const cloud = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.45), mat);
    if (highLayer) {
      cloud.position.set((rng() - 0.5) * 260, 55 + rng() * 35, (rng() - 0.5) * 260);
    } else {
      const ang = rng() * Math.PI * 2;
      const dist = 500 + rng() * 600;
      cloud.position.set(Math.cos(ang) * dist, 26 + rng() * 42, Math.sin(ang) * dist);
      cloud.scale.setScalar(2.5 + rng() * 2);
    }
    cloud.renderOrder = 3;
    cloud.userData.driftSpeed = 0.6 + rng() * 0.9;
    scene.add(cloud);
    cloudMeshes.push(cloud);
  }
  updaters.push((t, dt) => {
    for (const cloud of cloudMeshes) {
      cloud.quaternion.copy(camera.quaternion); // billboard
      cloud.position.x += cloud.userData.driftSpeed * dt;
      if (cloud.position.x > 700) cloud.position.x = -700;
    }
  });
}

// Gaviota: cuerpo + cabeza + alas curvas con punta oscura, montadas en
// pivotes de hombro para aletear. Silueta real de gaviota vista desde abajo.
function makeGullWing(bodyMat, tipMat) {
  // Ala en el plano XY (x = hacia afuera, y = adelante), luego acostada a XZ
  const shape = new THREE.Shape();
  shape.moveTo(0.15, 0.05);
  shape.bezierCurveTo(0.8, 0.35, 1.4, 0.42, 1.9, 0.3);
  shape.bezierCurveTo(2.5, 0.16, 2.9, 0.0, 3.1, -0.18);
  shape.bezierCurveTo(2.7, -0.14, 2.3, -0.12, 1.9, -0.16);
  shape.bezierCurveTo(1.3, -0.22, 0.7, -0.28, 0.15, -0.25);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape, 10);
  geo.rotateX(-Math.PI / 2); // acostada: x afuera, z adelante

  // punta oscura (ultimo tercio del ala)
  const tipShape = new THREE.Shape();
  tipShape.moveTo(2.15, 0.22);
  tipShape.bezierCurveTo(2.5, 0.16, 2.9, 0.0, 3.1, -0.18);
  tipShape.bezierCurveTo(2.8, -0.15, 2.45, -0.13, 2.15, -0.15);
  tipShape.closePath();
  const tipGeo = new THREE.ShapeGeometry(tipShape, 6);
  tipGeo.rotateX(-Math.PI / 2);
  tipGeo.translate(0, 0.005, 0);

  const wing = new THREE.Group();
  wing.add(new THREE.Mesh(geo, bodyMat));
  wing.add(new THREE.Mesh(tipGeo, tipMat));
  return wing;
}

function makeGull(wingMat, tipMat, bodyMat) {
  const gull = new THREE.Group();

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 9), bodyMat);
  body.scale.set(0.55, 0.42, 1.35);
  gull.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), bodyMat);
  head.position.set(0, 0.1, 0.48);
  gull.add(head);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.42, 8), bodyMat);
  tail.rotation.x = Math.PI / 2;
  tail.scale.set(1.6, 1, 0.4);
  tail.position.set(0, 0.02, -0.55);
  gull.add(tail);

  const wingL = new THREE.Group();
  wingL.add(makeGullWing(wingMat, tipMat));
  wingL.position.set(0.1, 0.06, 0.05);
  gull.add(wingL);

  const wingR = new THREE.Group();
  const wr = makeGullWing(wingMat, tipMat);
  wr.scale.x = -1;
  wingR.add(wr);
  wingR.position.set(-0.1, 0.06, 0.05);
  gull.add(wingR);

  gull.userData.wings = { l: wingL, r: wingR };
  gull.rotation.order = 'YXZ';
  return gull;
}

function buildBirds() {
  const wingMat = new THREE.MeshBasicMaterial({ color: 0xdfe6ea, side: THREE.DoubleSide, fog: false });
  const tipMat = new THREE.MeshBasicMaterial({ color: 0x5f6c76, side: THREE.DoubleSide, fog: false });
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0xf2f5f7, fog: false });

  const flocks = [
    { cx: -14, cz: -5, r: 15, h: 13, speed: 0.14, n: 3 },
    { cx: 6, cz: -30, r: 24, h: 18, speed: -0.1, n: 3 },
  ];
  const gulls = [];
  for (const f of flocks) {
    for (let i = 0; i < f.n; i++) {
      const g = makeGull(wingMat, tipMat, bodyMat);
      g.scale.setScalar(0.75 + (i % 3) * 0.12);
      g.userData.orbit = { ...f, phase: (i / f.n) * Math.PI * 2 + f.cx };
      g.userData.flap = { speed: 6.5 + i * 0.7, phase: i * 1.7, glide: i * 2.3 };
      scene.add(g);
      gulls.push(g);
    }
  }

  updaters.push((t) => {
    for (const g of gulls) {
      const o = g.userData.orbit;
      const f = g.userData.flap;
      const a = t * o.speed + o.phase;

      g.position.set(
        o.cx + Math.cos(a) * o.r,
        o.h + Math.sin(t * 0.5 + o.phase) * 1.4,
        o.cz + Math.sin(a) * o.r
      );
      // orientacion: tangente a la orbita + banking hacia el centro del giro
      g.rotation.y = -a + (o.speed > 0 ? 0 : Math.PI);
      g.rotation.z = 0.22 * Math.sign(o.speed);
      g.rotation.x = Math.sin(t * 0.5 + o.phase) * 0.08; // cabeceo suave

      // aleteo en rafagas: plana casi siempre, aletea unos segundos y repite
      const burst = Math.max(0, Math.sin(t * 0.28 + f.glide));
      const amp = 0.06 + burst * burst * 0.7;
      const flap = Math.sin(t * f.speed + f.phase) * amp;
      const dihedral = 0.14 * (1 - burst); // alas en V leve al planear
      g.userData.wings.l.rotation.z = flap + dihedral;
      g.userData.wings.r.rotation.z = -flap - dihedral;
    }
  });
}

// Parallax con mouse + deriva automatica en reposo
let idleTime = 0;
let mouseX = 0;
let mouseY = 0;

function setupParallax() {
  window.addEventListener('pointermove', (e) => {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    idleTime = 0;
  });
  updaters.push((t, dt) => {
    idleTime += dt;
    const drift = idleTime > 3 ? Math.sin(t * 0.15) * 0.7 : 0;
    const targetX = IS_TOUCH ? drift : mouseX * 3.4 + drift;
    const targetY = IS_TOUCH ? 0 : mouseY * 1.7;
    const k = Math.min(1, dt * 3.2);
    parallaxX += (targetX - parallaxX) * k;
    parallaxY += (targetY - parallaxY) * k;
  });
}

// ---------- Potas voladoras (homenaje a Gaston) ----------

const POTION_LABELS = ['POTA LOCA', 'TOMATE UNA POTA'];
const potions = [];
const droplets = [];

function makePotionLabel(text) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#f3e5c3';
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#8a6534';
  g.lineWidth = 8;
  g.strokeRect(6, 6, 244, 116);
  g.fillStyle = '#a32c22';
  g.font = '900 34px Georgia';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const words = text.split(' ');
  if (words.length > 2) {
    g.fillText(words.slice(0, 2).join(' '), 128, 44);
    g.fillText(words.slice(2).join(' '), 128, 86);
  } else if (words.length === 2) {
    g.fillText(words[0], 128, 44);
    g.fillText(words[1], 128, 86);
  } else {
    g.fillText(text, 128, 64);
  }
  return new THREE.CanvasTexture(c);
}

// Botella fiel a la referencia: esfera de vidrio, liquido verde, corcho
// grande, soga con puntas negras y medallon dorado con gema azul.
function makePotion(labelText) {
  const potion = new THREE.Group();

  // vidrio con alpha clasico: consistente en cualquier GPU (sin transmission)
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xd6ecf2, transparent: true, opacity: 0.26,
    roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08,
    depthWrite: false,
  });
  const glass = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 22), glassMat);
  glass.renderOrder = 1;
  potion.add(glass);

  const liquid = new THREE.Mesh(
    new THREE.SphereGeometry(0.82, 22, 18),
    new THREE.MeshStandardMaterial({
      color: 0x35c05a, roughness: 0.3,
      emissive: 0x1d8f3c, emissiveIntensity: 0.55,
      transparent: true, opacity: 0.92,
    })
  );
  liquid.scale.y = 0.88;
  liquid.position.y = -0.12;
  potion.add(liquid);
  // brillo especular del liquido (medialuna clara arriba)
  const gloss = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x8fe8a8, transparent: true, opacity: 0.35 })
  );
  gloss.scale.set(1, 0.5, 1);
  gloss.position.set(-0.15, 0.28, 0.25);
  potion.add(gloss);

  // cuello + corcho + tapa
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.35, 16), glassMat);
  neck.position.y = 1.05;
  potion.add(neck);
  const corkMat = new THREE.MeshStandardMaterial({
    color: 0xc08a5e, roughness: 0.9, emissive: 0x3a2113, emissiveIntensity: 0.25,
  });
  const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.35, 14), corkMat);
  cork.position.y = 1.32;
  potion.add(cork);
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.38, 0.26, 16),
    new THREE.MeshStandardMaterial({
      color: 0xa9714f, roughness: 0.85, emissive: 0x2e1a0e, emissiveIntensity: 0.25,
    })
  );
  cap.position.y = 1.56;
  potion.add(cap);

  // soga alrededor del cuello con dos puntas
  const ropeMat = new THREE.MeshStandardMaterial({ color: 0xd9b98a, roughness: 1 });
  const rope = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.09, 8, 24), ropeMat);
  rope.rotation.x = Math.PI / 2 + 0.18;
  rope.position.y = 0.98;
  potion.add(rope);
  const tipMat = new THREE.MeshStandardMaterial({ color: 0x1c1c22, roughness: 0.7 });
  for (const side of [-1, 1]) {
    const end = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.5, 8), ropeMat);
    end.position.set(side * 0.72, 0.88, 0.1);
    end.rotation.z = side * 1.15;
    potion.add(end);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.11, 0.18, 8), tipMat);
    tip.position.set(side * 0.95, 0.78, 0.1);
    tip.rotation.z = side * 1.15;
    potion.add(tip);
  }

  // medallon dorado con gema azul
  const medal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.2, 0.06, 6),
    new THREE.MeshStandardMaterial({ color: 0xd8a93c, roughness: 0.35, metalness: 0.8 })
  );
  medal.rotation.x = Math.PI / 2;
  medal.position.set(0, 0.72, 0.72);
  potion.add(medal);
  const gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.13, 0),
    new THREE.MeshPhysicalMaterial({
      color: 0x1a4fd6, roughness: 0.1, metalness: 0.2,
      emissive: 0x0a2a80, emissiveIntensity: 0.5,
    })
  );
  gem.position.set(0, 0.72, 0.78);
  potion.add(gem);

  // etiqueta POTA LOCA
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(0.85, 0.42),
    new THREE.MeshStandardMaterial({ map: makePotionLabel(labelText), roughness: 0.9 })
  );
  label.position.set(0, -0.25, 0.94);
  label.rotation.x = -0.22;
  potion.add(label);

  return potion;
}

function spawnDroplet(pos, vel) {
  let d = droplets.find((dd) => !dd.alive);
  if (!d) {
    if (droplets.length >= (LOW_DETAIL ? 8 : 18)) return;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 6),
      new THREE.MeshStandardMaterial({
        color: 0x2fae4e, emissive: 0x1a7d33, emissiveIntensity: 0.5,
        transparent: true, opacity: 0.9,
      })
    );
    scene.add(mesh);
    d = { mesh, vel: new THREE.Vector3(), life: 0, alive: false };
    droplets.push(d);
  }
  d.mesh.position.copy(pos);
  d.vel.copy(vel);
  d.life = 1.1;
  d.alive = true;
  d.mesh.visible = true;
}

function launchPotion(t) {
  let p = potions.find((pp) => !pp.alive);
  if (!p) {
    if (potions.length >= (LOW_DETAIL ? 1 : 2)) return;
    p = { group: makePotion(POTION_LABELS[potions.length % 2]), alive: false };
    scene.add(p.group);
    potions.push(p);
  }
  const dir = Math.random() < 0.5 ? 1 : -1;
  p.start = new THREE.Vector3(dir * (26 + Math.random() * 8), 3, -22 + Math.random() * 14);
  p.end = new THREE.Vector3(-dir * (24 + Math.random() * 8), 2.5, 4 + Math.random() * 8);
  p.peak = 9 + Math.random() * 6;
  p.t0 = t;
  p.dur = 6.5 + Math.random() * 2.5;
  p.spin = new THREE.Vector3(0.8 + Math.random(), 0.5, 1.2 + Math.random() * 0.8);
  p.nextDrip = 0;
  p.alive = true;
  p.group.visible = true;
  p.group.scale.setScalar(1.15);
}

function buildPotions() {
  let nextLaunch = 5.5; // la primera pota vuela despues de la intro
  updaters.push((t, dt) => {
    if (t >= nextLaunch) {
      launchPotion(t);
      nextLaunch = t + 9 + Math.random() * 6;
    }
    for (const p of potions) {
      if (!p.alive) continue;
      const u = (t - p.t0) / p.dur;
      if (u >= 1) {
        p.alive = false;
        p.group.visible = false;
        continue;
      }
      p.group.position.lerpVectors(p.start, p.end, u);
      p.group.position.y += Math.sin(u * Math.PI) * p.peak;
      p.group.rotation.x += p.spin.x * dt;
      p.group.rotation.y += p.spin.y * dt;
      p.group.rotation.z += p.spin.z * dt;
      // derrame: gotas desde el cuello mientras esta dada vuelta
      if (t >= p.nextDrip) {
        p.nextDrip = t + 0.28;
        const mouth = new THREE.Vector3(0, 1.4, 0).applyQuaternion(p.group.quaternion).add(p.group.position);
        spawnDroplet(mouth, new THREE.Vector3((Math.random() - 0.5) * 1.5, 1 + Math.random(), (Math.random() - 0.5) * 1.5));
      }
    }
    for (const d of droplets) {
      if (!d.alive) continue;
      d.life -= dt;
      d.vel.y -= 9 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.material.opacity = Math.max(0, d.life * 0.85);
      if (d.life <= 0 || d.mesh.position.y < 0.1) {
        d.alive = false;
        d.mesh.visible = false;
      }
    }
  });
}

// ---------- Cinematica de intro (GSAP) ----------

const HOME_CAM = { pos: { x: 2, y: 9, z: 30 }, target: { x: -5, y: 1.6, z: -2 } };
// Lobby: misma direccion de vista que el home pero mas cerca de la isla
const LOBBY_CAM = { pos: { x: -4, y: 5.8, z: 17 }, target: { x: -7.5, y: 1.8, z: -3 } };

let introTl = null;
let skipBtn = null;

function homeCard() {
  return document.querySelector('#screen-home .home-card');
}

function runIntro() {
  if (!window.gsap || SKIP_INTRO) {
    snapToFrame(HOME_CAM);
    return;
  }
  introActive = true;

  // Estado inicial: camara alta entre las nubes, DOM oculto
  camera.position.set(12, 80, 115);
  camTarget.set(-14, 0, -5);
  const card = homeCard();
  const title = card ? card.querySelector('.game-title') : null;
  if (card) gsap.set(card, { opacity: 0, y: 40 });
  if (title) gsap.set(title, { opacity: 0, scale: 1.35, filter: 'blur(14px)' });

  makeSkipButton();

  introTl = gsap.timeline({
    defaults: { ease: 'power2.inOut' },
    onComplete: endIntro,
  });
  introTl
    // caida entre las nubes
    .to(camera.position, { x: 7, y: 28, z: 60, duration: 1.7, ease: 'power1.in' }, 0)
    .to(camTarget, { x: -11, y: 1.5, z: -4, duration: 1.7 }, 0)
    // frenada y encuadre final
    .to(camera.position, { ...HOME_CAM.pos, duration: 2.0, ease: 'power3.out' }, 1.65)
    .to(camTarget, { ...HOME_CAM.target, duration: 2.0, ease: 'power3.out' }, 1.65)
    // reveal del logo y la card
    .fromTo(title || {}, { opacity: 0, scale: 1.35, filter: 'blur(14px)' },
      { opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.9, ease: 'power2.out' }, 2.35)
    .fromTo(card || {}, { opacity: 0, y: 40 },
      { opacity: 1, y: 0, duration: 0.7, ease: 'back.out(1.4)' }, 2.85);
}

function endIntro() {
  introActive = false;
  baseCamPos.set(HOME_CAM.pos.x, HOME_CAM.pos.y, HOME_CAM.pos.z);
  camTarget.set(HOME_CAM.target.x, HOME_CAM.target.y, HOME_CAM.target.z);
  const card = homeCard();
  const title = card ? card.querySelector('.game-title') : null;
  if (card) gsap.set(card, { clearProps: 'all', opacity: 1 });
  if (title) gsap.set(title, { clearProps: 'all', opacity: 1 });
  if (skipBtn) { skipBtn.remove(); skipBtn = null; }
  introTl = null;
}

function skipIntro() {
  if (introTl) introTl.progress(1); // dispara onComplete -> endIntro
}

function snapToFrame(frame) {
  introActive = false;
  baseCamPos.set(frame.pos.x, frame.pos.y, frame.pos.z);
  camTarget.set(frame.target.x, frame.target.y, frame.target.z);
  camera.position.copy(baseCamPos);
}

function makeSkipButton() {
  skipBtn = document.createElement('button');
  skipBtn.id = 'btn-skip-intro';
  skipBtn.className = 'fab-3d';
  skipBtn.textContent = 'Saltar ⏭';
  skipBtn.addEventListener('click', skipIntro);
  document.body.appendChild(skipBtn);
}

// Reencuadre suave entre home y lobby (la escena persiste)
function reframeTo(frame) {
  if (introActive) skipIntro();
  if (!window.gsap) { snapToFrame(frame); return; }
  gsap.to(baseCamPos, { ...frame.pos, duration: 1.6, ease: 'power2.inOut' });
  gsap.to(camTarget, { ...frame.target, duration: 1.6, ease: 'power2.inOut' });
}

// ---------- Audio ambiente procedural ----------

let audioCtx = null;
let audioMaster = null;
let audioMuted = true;
let muteBtn = null;
let gullTimer = null;

function startAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioMaster = audioCtx.createGain();
  audioMaster.gain.value = 1;
  audioMaster.connect(audioCtx.destination);

  // Olas: ruido blanco -> lowpass modulado por dos LFOs desincronizados
  const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 4, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = audioCtx.createBufferSource();
  noise.buffer = buf;
  noise.loop = true;

  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 420;
  lp.Q.value = 0.8;

  const waveGain = audioCtx.createGain();
  waveGain.gain.value = 0.13;

  const lfo1 = audioCtx.createOscillator();
  lfo1.frequency.value = 0.11; // swell largo
  const lfo1g = audioCtx.createGain();
  lfo1g.gain.value = 240;
  lfo1.connect(lfo1g).connect(lp.frequency);

  const lfo2 = audioCtx.createOscillator();
  lfo2.frequency.value = 0.07; // volumen que respira
  const lfo2g = audioCtx.createGain();
  lfo2g.gain.value = 0.05;
  lfo2.connect(lfo2g).connect(waveGain.gain);

  noise.connect(lp).connect(waveGain).connect(audioMaster);
  noise.start();
  lfo1.start();
  lfo2.start();

  scheduleGull();
}

// Gaviota: 2-4 chirps sawtooth -> bandpass, con paneo aleatorio
function scheduleGull() {
  gullTimer = setTimeout(() => {
    if (audioCtx && !audioMuted) playGull();
    scheduleGull();
  }, 8000 + Math.random() * 12000);
}

function playGull() {
  const t0 = audioCtx.currentTime;
  const pan = audioCtx.createStereoPanner();
  pan.pan.value = Math.random() * 1.6 - 0.8;
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2400;
  bp.Q.value = 2.5;
  bp.connect(pan).connect(audioMaster);

  const chirps = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < chirps; i++) {
    const osc = audioCtx.createOscillator();
    osc.type = 'sawtooth';
    const g = audioCtx.createGain();
    const start = t0 + i * 0.32;
    osc.frequency.setValueAtTime(1380, start);
    osc.frequency.exponentialRampToValueAtTime(960, start + 0.22);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.05, start + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
    osc.connect(g).connect(bp);
    osc.start(start);
    osc.stop(start + 0.32);
  }
}

function toggleMute() {
  audioMuted = !audioMuted;
  if (!audioMuted && !audioCtx) startAudio();
  if (audioCtx) {
    if (audioMuted) audioCtx.suspend();
    else audioCtx.resume();
  }
  if (muteBtn) muteBtn.textContent = audioMuted ? '🔇' : '🔊';
}

function makeMuteButton() {
  if (muteBtn) return;
  muteBtn = document.createElement('button');
  muteBtn.id = 'btn-mute';
  muteBtn.className = 'fab-3d';
  muteBtn.textContent = '🔇';
  muteBtn.title = 'Sonido ambiente';
  muteBtn.addEventListener('click', toggleMute);
  document.body.appendChild(muteBtn);
}

function stopAudio() {
  if (gullTimer) { clearTimeout(gullTimer); gullTimer = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; audioMaster = null; }
  audioMuted = true;
  if (muteBtn) { muteBtn.remove(); muteBtn = null; }
}

// ---------- Init / loop ----------

function init() {
  const reason = fallbackReason();
  if (DEBUG) makeDebugOverlay();
  if (reason) {
    if (DEBUG) { debugEl.textContent = `mode: FALLBACK-CSS\nreason: ${reason}`; }
    return false;
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.id = 'home3d-canvas';
    document.body.prepend(canvas);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOW_DETAIL });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, LOW_DETAIL ? 1.25 : 1.75));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.52;
    renderer.shadowMap.enabled = !LOW_DETAIL;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xc9a06c, 0.0005);

    camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.5, 4000);
    camera.position.copy(baseCamPos);

    clock = new THREE.Clock();

    buildSky();
    buildOcean();
    buildSunHalo();
    buildIsland();
    buildClouds();
    buildBirds();
    buildPotions();
    setupParallax();
    makeMuteButton();

    // QA visual de las botellas: ?pota=1 planta dos potas quietas en camara
    if (params.get('pota') === '1') {
      const p1 = makePotion('POTA LOCA');
      p1.position.set(6.5, 7, 19);
      p1.rotation.set(0.15, 0.3, 0.45);
      p1.scale.setScalar(1.5);
      scene.add(p1);
      const p2 = makePotion('TOMATE UNA POTA');
      p2.position.set(-7.5, 9, 16);
      p2.rotation.set(-0.2, -0.4, -2.3);
      p2.scale.setScalar(1.3);
      scene.add(p2);
    }

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      teardownToFallback('context-lost');
    });

    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    document.body.classList.add('has-3d');
    startLoop();
    return true;
  } catch (err) {
    console.warn('Home3D: fallo el init, fallback a CSS 2D.', err);
    teardownToFallback('init-error');
    return false;
  }
}

let fpsAvg = 60;

function startLoop() {
  if (rafId !== null || !initialized) return;
  clock.getDelta(); // descarta el delta acumulado durante la pausa
  const tick = () => {
    rafId = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;

    for (const fn of updaters) fn(t, dt);

    // Posicion de camara: encuadre oficial + parallax + bob marino.
    // Durante la cinematica GSAP anima camera.position directamente.
    if (!introActive) {
      camera.position.set(
        baseCamPos.x + parallaxX,
        baseCamPos.y - parallaxY + Math.sin(t * 0.4) * 0.12,
        baseCamPos.z
      );
    }
    camera.lookAt(camTarget);
    renderer.render(scene, camera);
    frameCount++;

    fpsAvg = fpsAvg * 0.95 + (1 / Math.max(dt, 0.001)) * 0.05;
    if (DEBUG && (frameCount === 1 || frameCount % 15 === 0)) {
      updateDebug(renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1', fpsAvg);
    }
  };
  tick();
}

function pauseLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function onResize() {
  if (!renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onVisibility() {
  if (!renderer) return;
  if (document.hidden) {
    pauseLoop();
    if (audioCtx && !audioMuted) audioCtx.suspend();
  } else if (currentScreen !== 'game') {
    startLoop();
    if (audioCtx && !audioMuted) audioCtx.resume();
  }
}

// ---------- Dispose ----------

function disposeScene() {
  pauseLoop();
  initialized = false;
  if (window.gsap) {
    if (introTl) { introTl.kill(); introTl = null; }
    gsap.killTweensOf([camera && camera.position, camTarget, baseCamPos].filter(Boolean));
  }
  introActive = false;
  if (skipBtn) { skipBtn.remove(); skipBtn = null; }
  if (scene) {
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          for (const k of Object.keys(m)) {
            if (m[k] && m[k].isTexture) m[k].dispose();
          }
          m.dispose();
        }
      }
    });
  }
  if (renderer) {
    renderer.dispose();
    renderer.forceContextLoss();
    if (renderer.domElement && renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  }
  window.removeEventListener('resize', onResize);
  document.removeEventListener('visibilitychange', onVisibility);
  renderer = null;
  scene = null;
  camera = null;
  updaters.length = 0;
  cloudMeshes.length = 0;
  potions.length = 0;
  droplets.length = 0;
  islandGroup = null;
  water = null;
  stopAudio();
  document.body.classList.remove('has-3d');
}

function teardownToFallback(reason) {
  try { disposeScene(); } catch { /* mejor esfuerzo */ }
  permanentFallback = true;
  if (DEBUG && debugEl) debugEl.textContent = `mode: FALLBACK-CSS\nreason: ${reason}`;
}

// ---------- API publica ----------

function ensureScene() {
  if (permanentFallback) return false;
  if (initialized) return true;
  initialized = init();
  return initialized;
}

function onScreenChange(name) {
  currentScreen = name;
  if (name === 'game') {
    if (initialized) disposeScene();
    return;
  }
  if (name !== 'home' && name !== 'lobby') return;

  const fresh = !initialized;
  if (!ensureScene()) return;
  if (fresh) {
    // Primera vez: intro cinematica en el home; directo al encuadre si es
    // una reconexion que cae al lobby.
    if (name === 'home') runIntro();
    else snapToFrame(LOBBY_CAM);
  } else {
    reframeTo(name === 'home' ? HOME_CAM : LOBBY_CAM);
  }
  if (!document.hidden) startLoop();
}

window.Home3D = { onScreenChange };

// Drena eventos que client.js emitio antes de que cargara este module,
// y detecta la pantalla activa si no hubo eventos (dev.html, carga directa).
const queued = window.__home3dQueue || [];
if (queued.length > 0) {
  onScreenChange(queued[queued.length - 1]);
} else {
  const active = document.querySelector('.screen.active');
  if (active) onScreenChange(active.id.replace('screen-', ''));
}
