/* Marine Commander · first-person walk-around.
 *
 * Builds a 3D deck from the same Universal VTT scene files the tactical table
 * uses: `line_of_sight` polylines become walls, `objects_line_of_sight`
 * polygons become low furniture/crates, `portals` become sliding doors that
 * open as you walk up to them, `lights` become (nearest-N) point lights and
 * the painted map PNG is laid down as the floor.
 *
 * World units are grid squares: x → map x, z → map y, y is up.
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ config */
const WALL_H = 2.0;        // wall height, grid squares
const WALL_T = 0.12;       // wall thickness
const OBJ_H = 0.8;         // furniture / crate height
const DOOR_T = 0.09;       // door leaf thickness (thinner than the wall)
const EYE = 1.1;           // eye height
const RADIUS = 0.3;        // player collision radius
const WALK = 2.2;          // grid squares per second
const RUN = 4.2;
const TILE = 1.2;          // texture tile size in grid squares
const MAX_TEX = 8192;      // downscale floor art above this
const LIGHT_POOL = 6;      // simultaneous dynamic point lights
const DOOR_OPEN_DIST = 1.7;
const DOOR_CLOSE_DIST = 2.6;
const DOOR_SPEED = 2.2;    // open fraction per second
const STAIR_USE_DIST = 0.9;
const CELL = 4;            // collision hash cell size

const CFG = window.MC_CONFIG || {};
const MAPS = (Array.isArray(CFG.maps) ? CFG.maps : []).map(m => ({
  ...m,
  label: m.group ? `${m.name} · ${m.level || m.subtitle || ''}` : `${m.name}${m.subtitle ? ' · ' + m.subtitle : ''}`,
}));
const MAP_BY_ID = new Map(MAPS.map(m => [m.id, m]));

/* ------------------------------------------------------------------- dom */
const $ = id => document.getElementById(id);
const canvas = $('view');
const overlay = $('overlay');
const overlayMsg = $('overlayMsg');
const promptEl = $('prompt');
const statusEl = $('status');
const mapSelect = $('mapSelect');
const bigWrap = $('bigmap');
const bigCanvas = $('big');
const miniCanvas = $('mini');

/* ----------------------------------------------------------------- three */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.FogExp2(0x05070a, 0.035);
const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 200);
camera.rotation.order = 'YXZ';
scene.add(camera);

const ambient = new THREE.AmbientLight(0xffffff, 1);
scene.add(ambient);
const flash = new THREE.SpotLight(0xfff2dd, 12, 16, 0.55, 0.6, 1.4);
flash.position.set(0.15, -0.1, 0);
camera.add(flash);
const flashTarget = new THREE.Object3D();
flashTarget.position.set(0, 0, -5);
camera.add(flashTarget);
flash.target = flashTarget;

const lightPool = [];
for (let i = 0; i < LIGHT_POOL; i++) {
  const l = new THREE.PointLight(0xffffff, 0, 10, 1.3);
  scene.add(l);
  lightPool.push(l);
}

const anisotropy = renderer.capabilities.getMaxAnisotropy();
const texLoader = new THREE.TextureLoader();

/* CC0 textures from ambientCG, see assets/textures/CREDITS.md */
const texCache = new Map();
function loadTex(path, srgb) {
  const key = path;
  if (texCache.has(key)) return texCache.get(key);
  const t = texLoader.load(path);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}
function pbr(id, opts = {}) {
  const base = `assets/textures/${id}/`;
  return new THREE.MeshStandardMaterial({
    map: loadTex(base + 'color.jpg', true),
    normalMap: loadTex(base + 'normal.jpg', false),
    roughnessMap: loadTex(base + 'roughness.jpg', false),
    roughness: 1, metalness: 0.15,
    ...opts,
  });
}
const mats = {
  wall: pbr('MetalPlates017A'),
  ceiling: pbr('MetalPlates015A', { side: THREE.FrontSide }),
  object: pbr('MetalPlates016A'),
  door: pbr('PaintedMetal016', { color: 0xdddddd }),
};
const stairMat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85 });
const beamMat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });

/* --------------------------------------------------------- geometry utils */
class GeoBuilder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.idx = []; }
  /** a,b,c,d counter-clockwise seen from the side the normal points to. */
  quad(a, b, c, d, n, uvs) {
    const base = this.pos.length / 3;
    for (const [i, p] of [a, b, c, d].entries()) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[0], n[1], n[2]);
      this.uv.push(uvs[i][0], uvs[i][1]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(a, b, c, n, uvs) {
    const base = this.pos.length / 3;
    for (const [i, p] of [a, b, c].entries()) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[0], n[1], n[2]);
      this.uv.push(uvs[i][0], uvs[i][1]);
    }
    this.idx.push(base, base + 1, base + 2);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
  get empty() { return this.idx.length === 0; }
}

/** One face of a wall running P→Q, offset to its left (+n) by `off`, from y0..y1. */
function sideFace(gb, px, pz, qx, qz, off, y0, y1) {
  const dx = qx - px, dz = qz - pz;
  const L = Math.hypot(dx, dz);
  if (L < 1e-6) return;
  const ux = dx / L, uz = dz / L;
  const nx = -uz, nz = ux;
  const ax = px + nx * off, az = pz + nz * off;
  const bx = qx + nx * off, bz = qz + nz * off;
  const ua = (ax * ux + az * uz) / TILE, ub = (bx * ux + bz * uz) / TILE;
  gb.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], [nx, 0, nz],
    [[ua, y0 / TILE], [ub, y0 / TILE], [ub, y1 / TILE], [ua, y1 / TILE]]);
}

/** Thin wall slab around segment A–B (both faces + end caps). */
function wallSlab(gb, ax, az, bx, bz, t, h) {
  const dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz);
  if (L < 1e-6) return;
  const ux = dx / L, uz = dz / L;
  const h2 = t / 2;
  const px = ax - ux * h2, pz = az - uz * h2, qx = bx + ux * h2, qz = bz + uz * h2;
  sideFace(gb, px, pz, qx, qz, h2, 0, h);
  sideFace(gb, qx, qz, px, pz, h2, 0, h);
  const nx = -uz, nz = ux;
  // end caps
  const cap = (cx, cz, sx, sz, first) => {
    const l = [cx - nx * h2, cz - nz * h2], r = [cx + nx * h2, cz + nz * h2];
    const [p0, p1] = first ? [l, r] : [r, l];
    gb.quad([p0[0], 0, p0[1]], [p1[0], 0, p1[1]], [p1[0], h, p1[1]], [p0[0], h, p0[1]], [sx, 0, sz],
      [[0, 0], [t / TILE, 0], [t / TILE, h / TILE], [0, h / TILE]]);
  };
  cap(px, pz, -ux, -uz, true);
  cap(qx, qz, ux, uz, false);
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Extruded polygon (furniture / crates). Points are {x,y} in grid squares. */
function solidPolygon(gb, pts, h) {
  let p = pts.slice();
  if (p.length > 1 && p[0].x === p[p.length - 1].x && p[0].y === p[p.length - 1].y) p.pop();
  if (p.length < 3) return;
  if (signedArea(p) > 0) p.reverse(); // interior on the right → n is outward
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    sideFace(gb, a.x, a.y, b.x, b.y, 0, 0, h);
  }
  const contour = p.map(v => new THREE.Vector2(v.x, v.y));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  for (const [i, j, k] of tris) {
    const A = contour[i], B = contour[j], C = contour[k];
    const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
    const [b, c] = cross > 0 ? [C, B] : [B, C]; // make the top face point up (+y)
    gb.tri([A.x, h, A.y], [b.x, h, b.y], [c.x, h, c.y], [0, 1, 0],
      [[A.x / TILE, A.y / TILE], [b.x / TILE, b.y / TILE], [c.x / TILE, c.y / TILE]]);
  }
}

/* --------------------------------------------------------- collision hash */
class SegHash {
  constructor() { this.cells = new Map(); this.doors = []; }
  key(cx, cz) { return cx * 65536 + cz; }
  add(ax, az, bx, bz) {
    const s = [ax, az, bx, bz];
    const x0 = Math.floor(Math.min(ax, bx) / CELL), x1 = Math.floor(Math.max(ax, bx) / CELL);
    const z0 = Math.floor(Math.min(az, bz) / CELL), z1 = Math.floor(Math.max(az, bz) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = this.key(cx, cz);
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, l = []);
      l.push(s);
    }
  }
  /** Calls fn(seg) for segments in the 3×3 cells around (x,z). */
  near(x, z, fn) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const l = this.cells.get(this.key(cx + i, cz + j));
      if (l) for (const s of l) fn(s);
    }
  }
}

function closestOnSeg(px, pz, s, out) {
  const dx = s[2] - s[0], dz = s[3] - s[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - s[0]) * dx + (pz - s[1]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  out.x = s[0] + dx * t; out.z = s[1] + dz * t;
}

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > z) !== (b.y > z) && x < (b.x - a.x) * (z - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/* ------------------------------------------------------------- map state */
let current = null;   // loaded deck
let loadToken = 0;

const player = { x: 0, z: 0, yaw: 0, pitch: 0, bob: 0 };

function argb(hex, fallback = 0xffffff) {
  if (typeof hex !== 'string') return fallback;
  const h = hex.replace('#', '');
  return parseInt(h.length === 8 ? h.slice(2) : h, 16) || fallback;
}

function dirOf(url) { return url.slice(0, url.lastIndexOf('/') + 1); }

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not load ' + url));
    img.src = url;
  });
}

function scaledCanvas(img, maxSide) {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function disposeDeck(deck) {
  if (!deck) return;
  scene.remove(deck.group);
  deck.group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.userData.ownMaterial) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
}

async function loadDeck(meta, at) {
  const token = ++loadToken;
  overlayMsg.textContent = `Loading ${meta.label}…`;
  statusEl.textContent = 'loading…';
  const url = meta.scene;
  const data = await (await fetch(url)).json();
  const img = await loadImage(dirOf(url) + data.image);
  if (token !== loadToken) return;

  const res = data.resolution;
  const ppg = res.pixels_per_grid;
  const W = res.map_size.x, H = res.map_size.y;
  const group = new THREE.Group();
  const hash = new SegHash();

  /* floor: the painted map, unlit (it carries baked lighting) */
  const floorCanvas = scaledCanvas(img, MAX_TEX);
  const floorTex = new THREE.CanvasTexture(floorCanvas);
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.anisotropy = anisotropy;
  floorTex.generateMipmaps = true;
  floorTex.minFilter = THREE.LinearMipmapLinearFilter;
  const fg = new GeoBuilder();
  fg.quad([0, 0, 0], [W, 0, 0], [W, 0, H], [0, 0, H], [0, 1, 0], [[0, 1], [1, 1], [1, 0], [0, 0]]);
  // reverse winding so the face points up
  fg.idx = [0, 2, 1, 0, 3, 2];
  const floor = new THREE.Mesh(fg.build(), new THREE.MeshBasicMaterial({ map: floorTex, color: 0xf2f2f2 }));
  floor.userData.ownMaterial = true;
  group.add(floor);

  /* ceiling */
  const cg = new GeoBuilder();
  cg.quad([0, WALL_H, 0], [W, WALL_H, 0], [W, WALL_H, H], [0, WALL_H, H], [0, -1, 0],
    [[0, 0], [W / TILE, 0], [W / TILE, H / TILE], [0, H / TILE]]);
  cg.idx = [0, 1, 2, 0, 2, 3]; // faces down
  group.add(new THREE.Mesh(cg.build(), mats.ceiling));

  /* walls */
  const los = (data.line_of_sight || []).filter(l => l.length > 1);
  const wg = new GeoBuilder();
  for (const line of los) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      if (a.x === b.x && a.y === b.y) continue;
      wallSlab(wg, a.x, a.y, b.x, b.y, WALL_T, WALL_H);
      hash.add(a.x, a.y, b.x, b.y);
    }
  }
  if (!wg.empty) group.add(new THREE.Mesh(wg.build(), mats.wall));

  /* furniture / crates */
  const og = new GeoBuilder();
  for (const poly of data.objects_line_of_sight || []) {
    if (poly.length < 3) continue;
    solidPolygon(og, poly, OBJ_H);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (a.x !== b.x || a.y !== b.y) hash.add(a.x, a.y, b.x, b.y);
    }
  }
  if (!og.empty) group.add(new THREE.Mesh(og.build(), mats.object));

  /* doors: two leaves that slide apart into the wall */
  const doors = [];
  for (const p of data.portals || []) {
    if (!p.bounds || p.bounds.length < 2) continue;
    const [a, b] = p.bounds;
    const dx = b.x - a.x, dz = b.y - a.y;
    const w = Math.hypot(dx, dz);
    if (w < 0.2) continue;
    const ux = dx / w, uz = dz / w;
    const cx = (a.x + b.x) / 2, cz = (a.y + b.y) / 2;
    const leafW = w / 2 + 0.02;
    const leaves = [-1, 1].map(side => {
      const g = new THREE.BoxGeometry(leafW, WALL_H, DOOR_T);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        const big = i >= 16; // ±z faces
        uv.setXY(i, uv.getX(i) * (big ? leafW / TILE : 0.1), uv.getY(i) * (big ? WALL_H / TILE : 0.1));
      }
      const m = new THREE.Mesh(g, mats.door);
      m.rotation.y = -Math.atan2(uz, ux);
      m.position.y = WALL_H / 2;
      group.add(m);
      return { mesh: m, side };
    });
    doors.push({ cx, cz, ux, uz, w, open: 0, target: 0, leaves, a, b, wasOpen: false });
  }
  placeDoors(doors);

  /* lights */
  const lights = (data.lights || []).map(l => ({
    x: l.position.x, z: l.position.y,
    color: argb(l.color), range: l.range || 8, intensity: l.intensity ?? 1,
  }));

  /* lift / ladder pads */
  const stairs = (meta.stairs || []).map(s => ({ ...s }));
  for (const s of stairs) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.55, 40).rotateX(-Math.PI / 2), stairMat);
    ring.position.set(s.x, 0.03, s.y);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, WALL_H, 24, 1, true), beamMat);
    beam.position.set(s.x, WALL_H / 2, s.y);
    group.add(ring, beam);
  }

  /* ambient level from the scene environment, but never pitch black */
  const env = argb(data.environment && data.environment.ambient_light, 0x808080);
  const col = new THREE.Color(env);
  const lum = (col.r + col.g + col.b) / 3;
  const base = new THREE.Color().setScalar(0.32).lerp(col, 0.5);
  ambient.color.copy(base);
  ambient.intensity = lights.length ? 0.7 + 0.8 * lum : 1.6;

  const minimap = scaledCanvas(img, 2048);

  const deck = { meta, data, W, H, ppg, group, hash, doors, lights, stairs, los, floorTex, minimap };
  disposeDeck(current);
  current = deck;
  scene.add(group);

  /* spawn */
  const start = at && Number.isFinite(at.x) ? { x: at.x, z: at.z } : findSpawn(deck);
  player.x = start.x; player.z = start.z;
  player.yaw = bestYaw(deck, start.x, start.z);
  player.pitch = 0;
  deck.lightTimer = 0;
  updateLights(true);
  statusEl.textContent = '';
  overlayMsg.textContent = meta.label;
  mapSelect.value = meta.id;
  history.replaceState(null, '', '#' + meta.id);
}

function placeDoors(doors) {
  for (const d of doors) {
    const slide = d.w / 2 * d.open * 0.98;
    for (const { mesh, side } of d.leaves) {
      const off = side * (d.w / 4 + slide);
      mesh.position.x = d.cx + d.ux * off;
      mesh.position.z = d.cz + d.uz * off;
    }
  }
}

/* inside-the-hull test (even-odd over every outline) and spawn search */
function isInside(deck, x, z) {
  let n = 0;
  for (const poly of deck.los) if (pointInPoly(x, z, poly)) n++;
  return (n & 1) === 1;
}
function clearance(deck, x, z) {
  let best = 99;
  const c = {};
  deck.hash.near(x, z, s => {
    closestOnSeg(x, z, s, c);
    best = Math.min(best, Math.hypot(x - c.x, z - c.z));
  });
  return best;
}
function walkable(deck, x, z) {
  return x > RADIUS && z > RADIUS && x < deck.W - RADIUS && z < deck.H - RADIUS && clearance(deck, x, z) >= RADIUS + 0.05;
}
function findSpawn(deck) {
  const cx = deck.W / 2, cz = deck.H / 2;
  let best = null, bestScore = Infinity;
  const consider = (x, z) => {
    if (!walkable(deck, x, z) || !isInside(deck, x, z) || clearance(deck, x, z) < 1.0) return;
    const score = Math.hypot(x - cx, z - cz);
    if (score < bestScore) { best = { x, z }; bestScore = score; }
  };
    for (let x = 0.5; x < deck.W; x += 1) for (let z = 0.5; z < deck.H; z += 1) consider(x, z);
  return best || { x: cx, z: cz };
}

/** Face the direction with the longest unobstructed view. */
function bestYaw(deck, x, z) {
  let best = 0, bestLen = -1;
  for (let i = 0; i < 24; i++) {
    const yaw = (i / 24) * Math.PI * 2;
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    let len = 0;
    while (len < 30 && walkable(deck, x + dx * (len + 0.25), z + dz * (len + 0.25))) len += 0.25;
    if (len > bestLen) { bestLen = len; best = yaw; }
  }
  return best;
}

/* --------------------------------------------------------------- lighting */
function updateLights(force) {
  if (!current) return;
  const ls = current.lights;
  const ranked = ls.map(l => ({ l, d: (l.x - player.x) ** 2 + (l.z - player.z) ** 2 }))
    .sort((a, b) => a.d - b.d).slice(0, LIGHT_POOL);
  lightPool.forEach((p, i) => {
    const r = ranked[i];
    if (!r) { p.intensity = 0; return; }
    p.position.set(r.l.x, WALL_H - 0.3, r.l.z);
    p.color.setHex(r.l.color);
    p.distance = Math.max(6, r.l.range * 1.4);
    p.intensity = 6 * Math.max(0.5, r.l.intensity);
  });
}

/* ---------------------------------------------------------------- movement */
const keys = Object.create(null);
let flashOn = true;
const scratch = {};

function resolveCollisions(deck) {
  for (let iter = 0; iter < 3; iter++) {
    let pushed = false;
    const test = s => {
      closestOnSeg(player.x, player.z, s, scratch);
      let dx = player.x - scratch.x, dz = player.z - scratch.z;
      const d = Math.hypot(dx, dz);
      if (d >= RADIUS) return;
      if (d < 1e-6) { // exactly on the line: push along the segment normal
        const sx = s[2] - s[0], sz = s[3] - s[1], l = Math.hypot(sx, sz) || 1;
        dx = -sz / l; dz = sx / l;
        player.x += dx * RADIUS; player.z += dz * RADIUS;
      } else {
        const k = (RADIUS - d) / d;
        player.x += dx * k; player.z += dz * k;
      }
      pushed = true;
    };
    deck.hash.near(player.x, player.z, test);
    for (const d of deck.doors) {
      if (d.open >= 0.6) continue;
      if (Math.abs(d.cx - player.x) > 3 || Math.abs(d.cz - player.z) > 3) continue;
      test([d.a.x, d.a.y, d.b.x, d.b.y]);
    }
    if (!pushed) break;
  }
  player.x = Math.min(deck.W - RADIUS, Math.max(RADIUS, player.x));
  player.z = Math.min(deck.H - RADIUS, Math.max(RADIUS, player.z));
}

function movePlayer(dt) {
  const deck = current;
  if (!deck) return;
  const f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  const r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  let moving = false;
  if (f || r) {
    const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
    let vx = -sy * f + cy * r, vz = -cy * f - sy * r;
    const l = Math.hypot(vx, vz);
    vx /= l; vz /= l;
    const speed = (keys.ShiftLeft || keys.ShiftRight) ? RUN : WALK;
    const dist = speed * dt;
    const steps = Math.max(1, Math.ceil(dist / 0.08));
    for (let i = 0; i < steps; i++) {
      player.x += vx * dist / steps;
      player.z += vz * dist / steps;
      resolveCollisions(deck);
    }
    moving = true;
    player.bob += dt * speed * 2.6;
  }
  if (!moving) resolveCollisions(deck);
  return moving;
}

function updateDoors(dt) {
  const deck = current;
  if (!deck) return;
  for (const d of deck.doors) {
    const dist = Math.hypot(player.x - d.cx, player.z - d.cz);
    const reach = d.w / 2;
    if (dist < DOOR_OPEN_DIST + reach * 0.5) d.target = 1;
    else if (dist > DOOR_CLOSE_DIST + reach * 0.5) d.target = 0;
    if (d.target !== (d.wasOpen ? 1 : 0)) {
      d.wasOpen = d.target === 1;
      if (dist < 9) swish(d.target === 1, dist);
    }
    if (d.open !== d.target) {
      const step = DOOR_SPEED * dt;
      d.open = d.open < d.target ? Math.min(d.target, d.open + step) : Math.max(d.target, d.open - step);
    }
    // ease for the visual only
    const e = d.open; const eased = e * e * (3 - 2 * e);
    const real = d.open; d.open = eased; placeDoors([d]); d.open = real;
  }
}

function nearestStair() {
  if (!current) return null;
  let best = null, bd = STAIR_USE_DIST;
  for (const s of current.stairs) {
    const d = Math.hypot(player.x - s.x, player.z - s.y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

async function useStair() {
  const s = nearestStair();
  if (!s) return;
  const dest = MAP_BY_ID.get(s.to);
  if (!dest) return;
  const dir = s.dir === 'up' ? '▲' : s.dir === 'down' ? '▼' : '';
  statusEl.textContent = `${dir} ${s.name}`;
  await loadDeck(dest, { x: s.tx, z: s.ty });
  // face away from the pad so the player is not staring at a wall
}

/* ------------------------------------------------------------------ audio */
let audio = null;
function initAudio() {
  if (audio) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const len = ctx.sampleRate * 0.5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    audio = { ctx, buf };
  } catch (_) { audio = null; }
}
function swish(opening, dist) {
  if (!audio) return;
  const { ctx, buf } = audio;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.2;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  const vol = 0.22 / (1 + dist * 0.6);
  bp.frequency.setValueAtTime(opening ? 400 : 1600, t);
  bp.frequency.exponentialRampToValueAtTime(opening ? 1600 : 300, t + 0.45);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t);
  src.stop(t + 0.5);
}

/* ------------------------------------------------------------------ input */
let bigOpen = false;

function locked() { return document.pointerLockElement === canvas; }

window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLSelectElement) return;
  if (e.code === 'KeyM' && !e.repeat) { toggleBigMap(); e.preventDefault(); return; }
  if (e.code === 'Escape' && bigOpen) { toggleBigMap(); return; }
  keys[e.code] = true;
  if (e.repeat) return;
  if (e.code === 'KeyE' && locked()) useStair();
  if (e.code === 'KeyF') { flashOn = !flashOn; flash.visible = flashOn; }
  if (['ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

document.addEventListener('mousemove', e => {
  if (!locked()) return;
  player.yaw -= e.movementX * 0.0022;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch - e.movementY * 0.0022));
});

function lockPointer() {
  initAudio();
  if (audio && audio.ctx.state === 'suspended') audio.ctx.resume();
  const p = canvas.requestPointerLock && canvas.requestPointerLock();
  if (p && p.catch) p.catch(() => {});
}
overlay.addEventListener('click', () => { if (current) lockPointer(); });
canvas.addEventListener('click', () => { if (!locked() && !bigOpen) lockPointer(); });
document.addEventListener('pointerlockchange', () => {
  const on = locked();
  overlay.style.display = (on || bigOpen) ? 'none' : 'flex';
  $('crosshair').style.display = on ? 'block' : 'none';
  if (!on) for (const k in keys) keys[k] = false;
});

mapSelect.addEventListener('change', () => {
  const m = MAP_BY_ID.get(mapSelect.value);
  mapSelect.blur();
  if (m) loadDeck(m).catch(showError);
});

/* -------------------------------------------------------------- map views */
function toggleBigMap() {
  bigOpen = !bigOpen;
  bigWrap.style.display = bigOpen ? 'block' : 'none';
  if (bigOpen) {
    if (document.exitPointerLock) document.exitPointerLock();
    overlay.style.display = 'none';
    sizeBig();
  } else if (!locked()) {
    overlay.style.display = 'flex';
  }
}
function sizeBig() {
  const r = bigWrap.getBoundingClientRect();
  bigCanvas.width = Math.max(10, Math.floor(r.width - 20));
  bigCanvas.height = Math.max(10, Math.floor(r.height - 16));
}
function bigLayout() {
  const d = current;
  const k = Math.min(bigCanvas.width / d.W, bigCanvas.height / d.H);
  return { k, ox: (bigCanvas.width - d.W * k) / 2, oy: (bigCanvas.height - d.H * k) / 2 };
}
bigCanvas.addEventListener('click', e => {
  if (!current) return;
  const r = bigCanvas.getBoundingClientRect();
  const sx = (e.clientX - r.left) * bigCanvas.width / r.width;
  const sy = (e.clientY - r.top) * bigCanvas.height / r.height;
  const { k, ox, oy } = bigLayout();
  const x = (sx - ox) / k, z = (sy - oy) / k;
  if (!walkable(current, x, z)) return;
  if (!isInside(current, x, z)) return;
  player.x = x; player.z = z;
  updateLights(true);
  toggleBigMap();
  lockPointer();
});

function drawMarkers(g, toScreen, s) {
  const d = current;
  g.fillStyle = '#ffb347';
  for (const st of d.stairs) {
    const [x, y] = toScreen(st.x, st.y);
    g.beginPath(); g.arc(x, y, 5 * s, 0, 7); g.fill();
  }
  for (const dr of d.doors) {
    const [x, y] = toScreen(dr.cx, dr.cz);
    g.fillStyle = dr.open > 0.5 ? '#6fe39a' : '#e5654a';
    g.fillRect(x - 2 * s, y - 2 * s, 4 * s, 4 * s);
  }
}

function drawMini() {
  const d = current;
  if (!d) return;
  const g = miniCanvas.getContext('2d');
  const R = 100, view = 12; // grid squares from centre to edge
  const s = R / view;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#05070a';
  g.fillRect(0, 0, 200, 200);
  g.save();
  g.translate(R, R);
  g.rotate(player.yaw);
  g.scale(s, s);
  g.translate(-player.x, -player.z);
  g.drawImage(d.minimap, 0, 0, d.W, d.H);
  g.restore();
  g.save();
  g.translate(R, R);
  g.rotate(player.yaw);
  drawMarkers(g, (x, z) => [(x - player.x) * s, (z - player.z) * s], 0.8);
  g.restore();
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(R, R - 8); g.lineTo(R + 5, R + 5); g.lineTo(R - 5, R + 5); g.closePath(); g.fill();
}

function drawBig() {
  const d = current;
  if (!d) return;
  const g = bigCanvas.getContext('2d');
  g.fillStyle = '#05070a';
  g.fillRect(0, 0, bigCanvas.width, bigCanvas.height);
  const { k, ox, oy } = bigLayout();
  g.drawImage(d.minimap, ox, oy, d.W * k, d.H * k);
  drawMarkers(g, (x, z) => [ox + x * k, oy + z * k], 1.4);
  const px = ox + player.x * k, pz = oy + player.z * k;
  g.save();
  g.translate(px, pz);
  g.rotate(-player.yaw);
  g.fillStyle = '#4cc2ff';
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, -12); g.lineTo(8, 9); g.lineTo(-8, 9); g.closePath(); g.fill(); g.stroke();
  g.restore();
}

/* ------------------------------------------------------------------- loop */
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (bigOpen) sizeBig();
}
window.addEventListener('resize', resize);

function showError(err) {
  console.error(err);
  overlay.style.display = 'flex';
  overlayMsg.innerHTML = '';
  const s = document.createElement('span');
  s.id = 'fatal';
  s.textContent = String(err && err.message || err);
  overlayMsg.appendChild(s);
}

let last = performance.now();
let lightClock = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!current) return;
  if (locked()) movePlayer(dt);
  updateDoors(dt);
  lightClock += dt;
  if (lightClock > 0.2) { lightClock = 0; updateLights(); }

  const bob = Math.sin(player.bob) * 0.025;
  camera.position.set(player.x, EYE + bob, player.z);
  camera.rotation.set(player.pitch, player.yaw, 0);

  const st = nearestStair();
  if (st && locked()) {
    const dest = MAP_BY_ID.get(st.to);
    promptEl.innerHTML = `<kbd>E</kbd> ${st.name}${dest ? ' → ' + dest.label : ''}`;
    promptEl.style.display = 'block';
  } else promptEl.style.display = 'none';

  renderer.render(scene, camera);
  drawMini();
  if (bigOpen) drawBig();
  window.__walk = { player, deck: current, three: { camera, scene } };
}

/* ------------------------------------------------------------------- boot */
async function boot() {
  if (!MAPS.length) { showError(new Error('No maps configured in js/config.js')); return; }
  for (const m of MAPS) {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.label;
    mapSelect.appendChild(o);
  }
  resize();
  requestAnimationFrame(frame);
  const wanted = MAP_BY_ID.get(decodeURIComponent(location.hash.slice(1))) || MAPS[0];
  try {
    const q = new URLSearchParams(location.search);
    const at = q.has('x') && q.has('z') ? { x: +q.get('x'), z: +q.get('z') } : null;
    await loadDeck(wanted, at);
    if (q.has('shot')) overlay.style.display = 'none';
    if (q.has('yaw')) player.yaw = +q.get('yaw');
    if (q.has('pitch')) player.pitch = +q.get('pitch');
    if (q.has('open')) for (const d of current.doors) { d.open = d.target = 1; d.wasOpen = true; }
  } catch (e) { showError(e); }
}
window.__walkApi = {
  loadDeck: id => loadDeck(MAP_BY_ID.get(id)),
  teleport: (x, z, yaw) => { player.x = x; player.z = z; if (yaw !== undefined) player.yaw = yaw; updateLights(true); },
  setLook: (yaw, pitch) => { player.yaw = yaw; player.pitch = pitch; },
};
boot();
