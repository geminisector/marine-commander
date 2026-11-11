/* Cortez tactical table — game client.
 * Host-authoritative state, rendered from snapshots. Solo mode uses localStorage.
 */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const CFG = window.MC_CONFIG || {};
const MAX_PLAYERS = CFG.maxPlayers || 8;
const STORE_KEY = 'cortez-solo-v4';
const HOST_SAVE_KEY = 'cortez-host-save-v4';
const CLIENT_KEY = 'cortez-client-id';
const APP_NAME = 'Cortez';
// Built-in characters keep their names when a seat changes hands or is kicked.
const FIXED_PLAYER_NAMES = new Set([
  "Leni 'Killmeister' Henari", "Keyan 'Enforcer' Steele",
  "Cyric 'Talon' Karde", "Derek 'Tinman' Miles"
]);

const cv = $('#cv'), ctx = cv.getContext('2d');
const imgs = new Map();
const dark = document.createElement('canvas'), dg = dark.getContext('2d', { willReadFrequently: true });
const tint = document.createElement('canvas'), tg = tint.getContext('2d');
const fog = document.createElement('canvas'), fg = fog.getContext('2d', { willReadFrequently: true });
const expl = document.createElement('canvas'), eg = expl.getContext('2d');
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const DOOR_NAMES = ['Bridge bulkhead','Red blast door (N)','Red blast door (S)','Quarters N1','Quarters N2','Quarters N3','Quarters S1','Quarters S2','Quarters S3','Hangar main door','Hangar to engines','Engines to fuel (N)','Engines to fuel (S)','Weapons N1','Weapons N2','Weapons N3','Weapons S1','Weapons S2','Weapons S3'];
const DEFAULT_OPEN = [0, 9, 14];
const MIN_ROOM = 9;

let map = null, tokens = [], nextId = 1;
let view = { x: 0, y: 0, k: 1 }, fitted = false;
let tool = 'move', selected = null, hoverTok = null, hoverDoor = null;
let ruler = null, ftPer = 5, unit = 'ft';
const layers = { rooms: { vis: true, lock: false }, light: { vis: true, lock: false }, gm: { vis: true, lock: false }, player: { vis: true, lock: false } };
const settings = { mode: 'auto', dark: 0.88, scale: 2.4, snap: true, peek: true, fog: true, explore: true, sight: 40, preview: false, gmPass: true, showStatus: false, showHp: true, turnBased: true, moveLimit: 0 };
let needDraw = true, lightDirty = true, fogDirty = true;

let sessionRole = 'solo';           // solo | host | player
let role = 'gm';                    // gm | player
let net = null, roomCode = '', hostName = '', hostOnline = true, netState = 'live';
let me = { clientId: getClientId(), name: '', tokenId: null };
let roster = [], logRows = [], rev = 0;
let turn = { number: 1, activeId: null, moved: {}, attacked: {} };
let anim = null;                    // unused animation slot kept for scene resets
let syncTimer = 0, saveTimer = 0, msgTimer = 0;
let pendingImg = null;
let combatCtx = null, combatChosenMove = 'strike';
const openStats = new Set();
let busy = false;

const pointers = new Map();
let drag = null, pinch = null;

/* ---------- small helpers ---------- */
function getClientId() {
  try {
    let id = sessionStorage.getItem(CLIENT_KEY);
    if (!/^[a-f0-9]{16,32}$/.test(id || '')) {
      id = window.CortezNet ? CortezNet.randomId(12) : Math.random().toString(16).slice(2).padEnd(24, '0');
      sessionStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  } catch (e) { return Math.random().toString(16).slice(2).padEnd(24, '0'); }
}
function makeRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(MIN_ROOM));
  const raw = [...bytes].map(b => A[b % A.length]).join('');
  return raw.slice(0, 3) + '-' + raw.slice(3, 6) + '-' + raw.slice(6, 9);
}
function normalizeRoom(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 9 ? s.slice(0, 3) + '-' + s.slice(3, 6) + '-' + s.slice(6, 9) : '';
}
function roomKeyOf(v) { return normalizeRoom(v).replace(/-/g, ''); }
function sanitizeName(v, fallback = 'Player') {
  const s = String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
  return s || fallback;
}
function showMsg(t) {
  const m = $('#msg');
  m.textContent = t;
  m.hidden = !t;
  clearTimeout(msgTimer);
  if (t) msgTimer = setTimeout(() => { m.hidden = true; }, 5200);
}
function bootStatus(t, kind = '') {
  const el = $('#bootStatus');
  el.textContent = t;
  el.dataset.kind = kind;
}
function fmt(n) { return (Math.round(n * 10) / 10).toString(); }
function parseColor(c) {
  c = String(c || 'ffffffff').replace('#', '');
  if (c.length === 8) c = c.slice(2);
  const n = parseInt(c.padEnd(6, 'f').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lum(hex) { const [r, g, b] = parseColor(hex); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
const tokenById = id => tokens.find(t => t.id === id) || null;
const isHost = () => sessionRole !== 'player';
const isLive = () => sessionRole === 'host' || sessionRole === 'player';
const hasHp = t => t.maxHp > 0;
const isDown = t => (t.maxHp > 0 && t.hp <= 0) || /^dead$/i.test((t.status || '').trim());
const canPass = () => isHost() && settings.gmPass;
const onlineCount = () => roster.filter(r => r.online).length;

/* ---------- combat rules (ported from melee.py) ---------- */
const WEAPONS = Object.freeze({
  knife:      { label: 'Knife',      damage: 2,   suckerDamage: 4,   sucker: 'backstabbed', verbs: ['stabbed'],            type: 'melee' },
  stick:      { label: 'Stick',      damage: 1.5, suckerDamage: 3,   sucker: 'struck',      verbs: ['hit', 'whacked'],     type: 'melee' },
  club:       { label: 'Club',       damage: 2,   suckerDamage: 4,   sucker: 'struck',      verbs: ['hit', 'whacked'],     type: 'melee' },
  sword:      { label: 'Sword',      damage: 3,   suckerDamage: 4.5, sucker: 'stabbed',     verbs: ['stabbed', 'slashed'], type: 'melee' },
  stunrod:    { label: 'Stun rod',   damage: 2,   suckerDamage: 5,   sucker: 'stunned',     verbs: ['zapped', 'electrocuted'], type: 'melee' },
  laser:      { label: 'Laser',      damage: 3,   suckerDamage: 4,   sucker: 'shot',        verbs: ['hit', 'struck'],      type: 'ranged' },
  mass_driver:{ label: 'Mass driver',damage: 3.5, suckerDamage: 3.5, sucker: 'shot',        verbs: ['hit', 'struck'],      type: 'ranged' },
  rifle:      { label: 'Rifle',      damage: 4,   suckerDamage: 4,   sucker: 'shot',        verbs: ['hit', 'struck'],      type: 'ranged' },
  laser_rifle:{ label: 'Laser rifle',damage: 4,   suckerDamage: 4,   sucker: 'shot',        verbs: ['hit', 'struck'],      type: 'ranged' }
});
const UNARMED = Object.freeze({ label: 'Unarmed', damage: 1, suckerDamage: 1.5, sucker: 'sucker-punched', verbs: ['punched', 'kicked', 'roundhoused', 'struck', 'smashed'], type: 'melee' });
const WEAPON_KEYS = Object.keys(WEAPONS);
const MOVES = { strike: 'grapple', grapple: 'counter', counter: 'strike' };
const WIN_MOVES = { strike: 'counter', grapple: 'strike', counter: 'grapple' };
const MOVE_LABEL = { strike: 'Strike', grapple: 'Grapple', counter: 'Counter' };
const MISS = { strike: ['punched', 'kicked', 'roundhoused', 'struck', 'smashed'], grapple: ['tripped', 'locked', 'barred', 'extended'] };
const HIT_ZONE = ['head', 'ribcage', 'arm', 'chest', 'neck', 'gut'];
const GRAPPLE_ZONE = ['ankle', 'knee', 'elbow', 'shoulder', 'neck'];

function choice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function clampStat(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(50, n)) : fallback;
}
function defaultStats(layer, size) {
  if (layer === 'gm') return size > 1
    ? { melee: 12, martialArts: 0, dance: 0, athletic: 14 }
    : { melee: 6, martialArts: 0, dance: 0, athletic: 3 };
  return { melee: 6, martialArts: 0, dance: 0, athletic: 3 };
}
function normalizeStats(raw, layer, size) {
  const b = defaultStats(layer, size);
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    melee: clampStat(raw.melee, b.melee),
    martialArts: clampStat(raw.martialArts, b.martialArts),
    dance: clampStat(raw.dance, b.dance),
    athletic: clampStat(raw.athletic, b.athletic)
  };
}
function computeStats(stats) {
  const skill = Math.max(stats.melee, stats.martialArts, stats.dance * 0.66);
  const damage = Math.max(Math.round(skill / 2), 1);
  const maxHp = Math.max(1, Math.round(stats.athletic * 2 + skill));
  return { skill, damage, maxHp };
}
function weaponKeyOf(t) { return t && Object.prototype.hasOwnProperty.call(WEAPONS, t.weapon) ? t.weapon : ''; }
function weaponOf(t) { return WEAPONS[weaponKeyOf(t)] || UNARMED; }
function weaponLabelOf(t) { return weaponOf(t).label; }
function tokenDamage(t) { return Math.max(1, computeStats(t.stats).damage); }
function tokenMaxHp(t) { return computeStats(t.stats).maxHp; }
function damageWithWeapon(t) { return tokenDamage(t) * weaponOf(t).damage; }
function critWithWeapon(t) { return weaponOf(t).suckerDamage; }
function attackVerb(t, fallback) { const w = weaponOf(t); return w.verbs && w.verbs.length ? choice(w.verbs) : fallback; }
function recalcMaxHp(t) {
  if (!t.stats) return;
  const oldMax = t.maxHp || 0;
  const nextMax = tokenMaxHp(t);
  const damageTaken = Math.max(0, oldMax - t.hp);
  t.maxHp = nextMax;
  t.hp = Math.max(0, Math.min(nextMax, nextMax - damageTaken));
}
function aiReaction(attackerMove) {
  const roll = 1 + Math.floor(Math.random() * 20);
  if (roll === 1) return { move: null, roll };
  if (roll < 10) return { move: MOVES[attackerMove] || null, roll };
  if (roll > 15) return { move: WIN_MOVES[attackerMove] || null, roll };
  return { move: choice(['strike', 'grapple', 'counter']), roll };
}
function healthPct(t) { return t.maxHp > 0 ? (t.hp * 100) / t.maxHp : 0; }
function combatReach(a, b) {
  if (!map) return { ok: true, text: '—' };
  const w = weaponOf(a);
  if (w.type === 'ranged') return { ok: true, text: 'Ranged · no range limit' };
  const d = Math.hypot(a.x - b.x, a.y - b.y) / map.ppg;
  const reach = (a.size + b.size) / 2 + 0.5;
  return { ok: d <= reach + 1e-6, text: `Melee · ${fmt(d)} sq / ${fmt(reach)} sq reach`, dist: d, reach };
}

function normalizeInv(inv) {
  return (Array.isArray(inv) ? inv : []).filter(x => x && typeof x.name === 'string' && x.name.trim())
    .slice(0, 40).map(x => ({
      name: x.name.trim().slice(0, 36),
      qty: Math.max(0, Math.min(999, Math.round(+x.qty || 0)))
    })).filter(x => x.qty > 0);
}
function cleanToken(t) {
  const layer = t.layer === 'gm' ? 'gm' : 'player';
  const size = Math.max(1, Math.min(4, +t.size || 1));
  const stats = normalizeStats(t.stats, layer, size);
  const maxHp = computeStats(stats).maxHp;
  let hp = Number.isFinite(+t.hp) ? Math.round(+t.hp) : maxHp;
  if (!t.stats && !(+t.maxHp > 0)) hp = maxHp;
  hp = Math.max(0, Math.min(maxHp, hp));
  return {
    id: +t.id, layer, name: String(t.name || 'Token').slice(0, 40),
    color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '#3cc4b1',
    size, x: +t.x || 0, y: +t.y || 0,
    hp, maxHp,
    stats, weapon: WEAPONS[t.weapon] ? t.weapon : '',
    status: String(t.status || '').slice(0, 30), img: typeof t.img === 'string' ? t.img : '',
    inventory: normalizeInv(t.inventory)
  };
}

/* ---------- map loading ---------- */
function imageSource(d, base) {
  if (!d || !d.image) return '';
  if (/^data:/i.test(d.image)) return d.image;
  if (/^(https?:|blob:|\.{0,2}\/)/i.test(d.image) || /\.(png|jpe?g|webp|gif)$/i.test(d.image)) {
    try { return new URL(d.image, base || location.href).href; } catch (e) { return d.image; }
  }
  return 'data:image/png;base64,' + d.image;
}
function loadMap(d, key, base) {
  return new Promise((resolve, reject) => {
    if (!d || !d.resolution || !d.image) return reject(new Error('This file is not a Universal VTT map (missing resolution or image).'));
    const img = new Image();
    img.onload = () => { try { build(d, img, key); resolve(); } catch (e) { reject(e); } };
    img.onerror = () => reject(new Error('The map image could not be decoded.'));
    img.src = imageSource(d, base);
  });
}
async function loadBuiltin() {
  const url = CFG.mapUrl || 'assets/maps/cortez.scene.json';
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error('Could not load the Cortez map (' + res.status + ').');
  const d = await res.json();
  await loadMap(d, 'cortez', new URL(url, location.href).href);
}

function build(d, img, key) {
  const ppg = d.resolution.pixels_per_grid || 50;
  const P = p => ({ x: p.x * ppg, y: p.y * ppg });
  const walls = [];
  for (const poly of [...(d.line_of_sight || []), ...(d.objects_line_of_sight || [])])
    for (let i = 0; i < poly.length - 1; i++) { const a = P(poly[i]), b = P(poly[i + 1]); walls.push([a.x, a.y, b.x, b.y]); }
  const doors = (d.portals || []).map((p, i) => ({ a: P(p.bounds[0]), b: P(p.bounds[1]), open: !p.closed, name: (key === 'cortez' && DOOR_NAMES[i]) || ('Door ' + (i + 1)), regs: [] }));
  const lights = (d.lights || []).map(l => ({ x: l.position.x * ppg, y: l.position.y * ppg, r: l.range * ppg, rgb: parseColor(l.color), force: null, region: 0, on: false }));
  map = { img, W: img.naturalWidth, H: img.naturalHeight, ppg, walls, doors, lights, blockers: [], key, name: key === 'cortez' ? 'Cortez deck plan' : 'Loaded map' };
  dark.width = tint.width = fog.width = expl.width = map.W;
  dark.height = tint.height = fog.height = expl.height = map.H;
  eg.clearRect(0, 0, map.W, map.H);
  imgs.clear(); openStats.clear(); anim = null; turn = { number: 1, activeId: null, moved: {}, attacked: {} }; selected = null; ruler = null;
  tokens = []; nextId = 1;
  if (key === 'cortez') {
    doors.forEach((dr, i) => { dr.open = DEFAULT_OPEN.includes(i); });
    tokens = defaultTokens();
  }
  computeRegions();
  rebuildBlockers();
  $('#mapinfo').textContent = `${map.name} · ${Math.round(map.W / ppg)}×${Math.round(map.H / ppg)} squares · ${doors.length} doors · ${lights.length} lights`;
  syncTokenImages();
  renderAll(); updateDoorCount(); lightDirty = true; fogDirty = true;
  requestAnimationFrame(() => { fitView(); invalidate(); });
}

function resetToDefaults() {
  if (!map) return;
  map.doors.forEach((d, i) => { d.open = map.key === 'cortez' ? DEFAULT_OPEN.includes(i) : false; });
  map.lights.forEach(l => { l.force = null; });
  nextId = 1; turn = { number: 1, activeId: null, moved: {}, attacked: {} }; anim = null;
  imgs.clear();
  tokens = map.key === 'cortez' ? defaultTokens() : [];
  syncTokenImages();
  roster = []; logRows = []; selected = null; ruler = null;
  clearExplored(); rebuildBlockers(); lightDirty = true; fogDirty = true;
  updateDoorCount(); renderAll(); invalidate();
}

/* ---------- rooms: label enclosed regions with every door treated as closed ---------- */
function computeRegions() {
  const s = Math.min(1, 1100 / map.W), cw = Math.ceil(map.W * s), ch = Math.ceil(map.H * s);
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
  g.strokeStyle = '#000'; g.lineWidth = 3.6; g.lineCap = 'square'; g.beginPath();
  for (const w of map.walls) { g.moveTo(w[0] * s, w[1] * s); g.lineTo(w[2] * s, w[3] * s); }
  for (const d of map.doors) { g.moveTo(d.a.x * s, d.a.y * s); g.lineTo(d.b.x * s, d.b.y * s); }
  g.stroke();
  const data = g.getImageData(0, 0, cw, ch).data, N = cw * ch, lab = new Int32Array(N);
  for (let i = 0; i < N; i++) if (data[i * 4] < 190) lab[i] = -1;
  const stack = new Int32Array(N), outside = new Set(); let n = 0;
  for (let st = 0; st < N; st++) {
    if (lab[st] !== 0) continue;
    n++; let sp = 0, edge = false; stack[sp++] = st; lab[st] = n;
    while (sp) {
      const p = stack[--sp], x = p % cw, y = (p / cw) | 0;
      if (x === 0 || y === 0 || x === cw - 1 || y === ch - 1) edge = true;
      if (x > 0 && lab[p - 1] === 0) { lab[p - 1] = n; stack[sp++] = p - 1; }
      if (x < cw - 1 && lab[p + 1] === 0) { lab[p + 1] = n; stack[sp++] = p + 1; }
      if (y > 0 && lab[p - cw] === 0) { lab[p - cw] = n; stack[sp++] = p - cw; }
      if (y < ch - 1 && lab[p + cw] === 0) { lab[p + cw] = n; stack[sp++] = p + cw; }
    }
    if (edge) outside.add(n);
  }
  const at = (cx, cy) => { cx = Math.round(cx); cy = Math.round(cy); return (cx < 0 || cy < 0 || cx >= cw || cy >= ch) ? 0 : Math.max(0, lab[cy * cw + cx]); };
  const near = (px, py) => {
    const cx = px * s, cy = py * s;
    for (let r = 0; r <= 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const v = at(cx + dx, cy + dy); if (v > 0) return v;
    }
    return 0;
  };
  for (const d of map.doors) {
    const mx = (d.a.x + d.b.x) / 2, my = (d.a.y + d.b.y) / 2, dx = d.b.x - d.a.x, dy = d.b.y - d.a.y, L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L, regs = new Set();
    for (const off of [6, 8, 10]) for (const sg of [-1, 1]) { const v = at(mx * s + nx * off * sg, my * s + ny * off * sg); if (v > 0 && !outside.has(v)) regs.add(v); }
    d.regs = [...regs];
  }
  for (const l of map.lights) { const r = near(l.x, l.y); l.region = outside.has(r) ? 0 : r; }
}

function rebuildBlockers() {
  if (!map) return;
  const ext = 1.5, out = [];
  const add = (a, b, c, d) => { const dx = c - a, dy = d - b, l = Math.hypot(dx, dy) || 1, ux = dx / l * ext, uy = dy / l * ext; out.push([a - ux, b - uy, c + ux, d + uy]); };
  for (const w of map.walls) add(w[0], w[1], w[2], w[3]);
  for (const d of map.doors) if (!d.open) add(d.a.x, d.a.y, d.b.x, d.b.y);
  map.blockers = out;
  map.hard = map.walls.concat(map.doors.filter(d => !d.open).map(d => [d.a.x, d.a.y, d.b.x, d.b.y]));
  fogDirty = true;
}

/* ---------- lighting ---------- */
function visPoly(ox, oy, R) {
  const segs = map.blockers.filter(s => !(Math.max(s[0], s[2]) < ox - R || Math.min(s[0], s[2]) > ox + R || Math.max(s[1], s[3]) < oy - R || Math.min(s[1], s[3]) > oy + R));
  const B = R * 1.05;
  const all = segs.concat([[ox - B, oy - B, ox + B, oy - B], [ox + B, oy - B, ox + B, oy + B], [ox + B, oy + B, ox - B, oy + B], [ox - B, oy + B, ox - B, oy - B]]);
  const angles = [];
  for (const s of all) for (let e = 0; e < 4; e += 2) { const a = Math.atan2(s[e + 1] - oy, s[e] - ox); angles.push(a - 1.2e-4, a, a + 1.2e-4); }
  angles.sort((p, q) => p - q);
  const pts = [];
  for (const a of angles) {
    const dx = Math.cos(a), dy = Math.sin(a); let best = Infinity;
    for (const s of all) {
      const ex = s[2] - s[0], ey = s[3] - s[1], den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((s[0] - ox) * ey - (s[1] - oy) * ex) / den, u = ((s[0] - ox) * dy - (s[1] - oy) * dx) / den;
      if (t >= 0 && u >= 0 && u <= 1 && t < best) best = t;
    }
    if (best < Infinity) pts.push([ox + dx * best, oy + dy * best]);
  }
  return pts;
}
function openRegions() { const s = new Set(); for (const d of map.doors) if (d.open) for (const r of d.regs) s.add(r); return s; }
function lightOn(l, open) {
  if (l.force !== null) return l.force;
  if (settings.mode === 'all') return true;
  if (settings.mode === 'off') return false;
  return l.region > 0 && open.has(l.region);
}
function lightPass() {
  if (!map) return;
  const open = openRegions();
  dg.globalCompositeOperation = 'source-over'; dg.clearRect(0, 0, dark.width, dark.height);
  dg.fillStyle = `rgba(4,7,12,${settings.dark})`; dg.fillRect(0, 0, dark.width, dark.height);
  tg.clearRect(0, 0, tint.width, tint.height);
  for (const l of map.lights) {
    l.on = lightOn(l, open); if (!l.on) continue;
    const R = l.r * settings.scale, poly = visPoly(l.x, l.y, R); if (poly.length < 3) continue;
    const path = c => { c.beginPath(); c.moveTo(poly[0][0], poly[0][1]); for (let i = 1; i < poly.length; i++) c.lineTo(poly[i][0], poly[i][1]); c.closePath(); };
    dg.save(); path(dg); dg.clip(); dg.globalCompositeOperation = 'destination-out';
    let gr = dg.createRadialGradient(l.x, l.y, 0, l.x, l.y, R);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(.55, 'rgba(0,0,0,.94)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    dg.fillStyle = gr; dg.fillRect(l.x - R, l.y - R, R * 2, R * 2); dg.restore();
    tg.save(); path(tg); tg.clip(); tg.globalCompositeOperation = 'lighter';
    gr = tg.createRadialGradient(l.x, l.y, 0, l.x, l.y, R);
    gr.addColorStop(0, `rgba(${l.rgb},.5)`); gr.addColorStop(1, `rgba(${l.rgb},0)`);
    tg.fillStyle = gr; tg.fillRect(l.x - R, l.y - R, R * 2, R * 2); tg.restore();
  }
  lightDirty = false;
}
function isLit(x, y) {
  if (!layers.light.vis) return true;
  if (lightDirty) lightPass();
  const px = Math.max(0, Math.min(dark.width - 1, Math.round(x))), py = Math.max(0, Math.min(dark.height - 1, Math.round(y)));
  return dg.getImageData(px, py, 1, 1).data[3] < settings.dark * 255 * 0.55;
}

/* ---------- tokens ---------- */
function defaultTokens() {
  nextId = 1;
  const mk = (layer, name, color, x, y, size = 1, stats = null, weapon = '', img = '', inv = null) => {
    const st = normalizeStats(stats, layer, size);
    const maxHp = computeStats(st).maxHp;
    const bag = inv || (layer === 'gm'
      ? [{ name: 'Frag grenade', qty: 1 }]
      : [{ name: 'Medkit', qty: 1 }, { name: 'Ammo', qty: 2 }]);
    const t = { id: nextId++, layer, name, color, size, x, y, status: '', hp: maxHp, maxHp, stats: st, weapon, inventory: bag, img };
    snapTok(t); return t;
  };
  // Pixel centre of a map square (the scene is 64 x 39.25 squares at 16 px each).
  const sq = (col, row) => [(col + 0.5) * (map ? map.ppg : 16), (row + 0.5) * (map ? map.ppg : 16)];
  const HUMANS = 'assets/tokens/human/';
  // Hostile boarding party: 4 pilots, 2 grunts, 2 navigators, 1 medic, 1 engineer.
  // The token images are referenced by path (not embedded), so saved layouts stay small.
  const hostile = (role, n, color, col, row, stats, weapon, img, inv) => {
    const [x, y] = sq(col, row);
    return mk('gm', role + (n ? ' ' + n : ''), color, x, y, 1, stats, weapon, HUMANS + img, inv);
  };
  // The four heroes are fixed characters: their names survive a player taking the seat.
  const hero = (name, color, x, y, stats, weapon, img, inv) =>
    mk('player', name, color, x, y, 1, stats, weapon, HUMANS + img, inv);
  return [
    hero("Leni 'Killmeister' Henari", '#3cc4b1', 552, 300,
      { melee: 11, martialArts: 0, dance: 7, athletic: 11 }, 'laser_rifle', 'killmeister.webp',
      [{ name: 'Combat knife', qty: 1 }, { name: 'Laser cell', qty: 2 }, { name: 'Medkit', qty: 1 }, { name: 'Frag grenade', qty: 1 }]),
    hero("Keyan 'Enforcer' Steele", '#6aa6ff', 552, 322,
      { melee: 6, martialArts: 0, dance: 0, athletic: 6 }, 'laser_rifle', 'enforcer-head.png',
      [{ name: 'Laser cell', qty: 2 }, { name: 'Medkit', qty: 1 }]),
    hero("Cyric 'Talon' Karde", '#f2a93b', 586, 300,
      { melee: 0, martialArts: 7, dance: 0, athletic: 5 }, 'laser_rifle', 'talon.jpg',
      [{ name: 'Laser cell', qty: 2 }, { name: 'Medkit', qty: 1 }]),
    hero("Derek 'Tinman' Miles", '#c58bff', 586, 322,
      { melee: 7, martialArts: 8, dance: 0, athletic: 9 }, 'laser_rifle', 'tinman.webp',
      [{ name: 'Laser cell', qty: 2 }, { name: 'Frag grenade', qty: 1 }, { name: 'Medkit', qty: 1 }]),

    hostile('Pilot', 1, '#e5604f', 41, 14, { melee: 5, martialArts: 2, dance: 0, athletic: 4 }, 'laser', 'pilot.png', [{ name: 'Laser cell', qty: 2 }]),
    hostile('Pilot', 2, '#e5604f', 45, 14, { melee: 5, martialArts: 2, dance: 0, athletic: 4 }, 'laser', 'pilot.png', [{ name: 'Laser cell', qty: 2 }]),
    hostile('Pilot', 3, '#e5604f', 42, 24, { melee: 5, martialArts: 2, dance: 0, athletic: 4 }, 'laser', 'pilot.png', [{ name: 'Laser cell', qty: 2 }]),
    hostile('Pilot', 4, '#e5604f', 49, 23, { melee: 5, martialArts: 2, dance: 0, athletic: 4 }, 'laser', 'pilot.png', [{ name: 'Laser cell', qty: 2 }]),

    hostile('Grunt', 1, '#c0392b', 42, 20, { melee: 8, martialArts: 3, dance: 0, athletic: 6 }, 'rifle', 'grunt.png', [{ name: 'Rifle magazine', qty: 2 }, { name: 'Frag grenade', qty: 1 }]),
    hostile('Grunt', 2, '#c0392b', 48, 20, { melee: 8, martialArts: 3, dance: 0, athletic: 6 }, 'rifle', 'grunt.png', [{ name: 'Rifle magazine', qty: 2 }, { name: 'Frag grenade', qty: 1 }]),

    hostile('Navigator', 1, '#ef7d4f', 11, 19, { melee: 4, martialArts: 1, dance: 0, athletic: 3 }, 'knife', 'navigator.png', [{ name: 'Datapad', qty: 1 }]),
    hostile('Navigator', 2, '#ef7d4f', 25, 19, { melee: 4, martialArts: 1, dance: 0, athletic: 3 }, 'knife', 'navigator.png', [{ name: 'Datapad', qty: 1 }]),

    hostile('Medic', 0, '#d9534f', 38, 20, { melee: 3, martialArts: 4, dance: 0, athletic: 4 }, 'stunrod', 'medic.png', [{ name: 'Medkit', qty: 2 }]),
    hostile('Engineer', 0, '#a93226', 53, 20, { melee: 6, martialArts: 2, dance: 0, athletic: 5 }, 'club', 'engineer.png', [{ name: 'Tool kit', qty: 1 }, { name: 'Frag grenade', qty: 1 }])
  ];
}
function snapTok(t) {
  if (!map) return;
  const g = map.ppg;
  if (t.size % 2 === 1) { t.x = (Math.floor(t.x / g) + .5) * g; t.y = (Math.floor(t.y / g) + .5) * g; }
  else { t.x = Math.round(t.x / g) * g; t.y = Math.round(t.y / g) * g; }
}
const tokRadius = t => Math.max(t.size * map.ppg * 0.46, 4);
function canTouch(t) {
  const L = layers[t.layer];
  if (!L.vis || L.lock) return false;
  if (isHost()) return true;
  return t.layer === 'player' && t.id === me.tokenId && !isDown(t);
}
const fogActive = () => settings.fog && (role === 'player' || settings.preview);
function visionTokens() {
  const alive = tokens.filter(t => t.layer === 'player' && !isDown(t));
  if (role === 'player' && me.tokenId) {
    const mine = tokenById(me.tokenId);
    return mine && !isDown(mine) ? [mine] : [];
  }
  return alive;
}
const polyPath = (c, poly) => { c.beginPath(); c.moveTo(poly[0][0], poly[0][1]); for (let i = 1; i < poly.length; i++) c.lineTo(poly[i][0], poly[i][1]); c.closePath(); };
function fogPass() {
  fg.globalCompositeOperation = 'source-over'; fg.globalAlpha = 1; fg.clearRect(0, 0, fog.width, fog.height);
  fg.fillStyle = '#000'; fg.fillRect(0, 0, fog.width, fog.height);
  fg.globalCompositeOperation = 'destination-out';
  if (settings.explore) { fg.globalAlpha = 0.5; fg.drawImage(expl, 0, 0); fg.globalAlpha = 1; }
  const R = settings.sight * map.ppg;
  for (const t of visionTokens()) {
    const poly = visPoly(t.x, t.y, R); if (poly.length < 3) continue;
    polyPath(fg, poly); fg.fillStyle = '#000'; fg.fill();
    polyPath(eg, poly); eg.fillStyle = '#fff'; eg.fill();
  }
  fg.globalCompositeOperation = 'source-over'; fogDirty = false;
}
function clearExplored() { eg.clearRect(0, 0, expl.width, expl.height); fogDirty = true; }
function seenByPlayers(x, y) {
  if (!settings.fog) return true;
  if (fogDirty) fogPass();
  const px = Math.max(0, Math.min(fog.width - 1, Math.round(x))), py = Math.max(0, Math.min(fog.height - 1, Math.round(y)));
  return fg.getImageData(px, py, 1, 1).data[3] < 20;
}
function tokVisible(t) {
  if (!layers[t.layer].vis) return false;
  if (t.layer === 'gm' && role === 'player') return seenByPlayers(t.x, t.y) && isLit(t.x, t.y);
  return true;
}
const canMoveNow = t => {
  if (!settings.turnBased) return true;
  if (isHost()) return true;
  return turn.activeId === t.id;
};

function ptSeg(px, py, s) {
  const dx = s[2] - s[0], dy = s[3] - s[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - s[0]) * dx + (py - s[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s[0] + t * dx), py - (s[1] + t * dy));
}
function segsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(ax, ay, bx, by, cx, cy), d2 = o(ax, ay, bx, by, dx, dy), d3 = o(cx, cy, dx, dy, ax, ay), d4 = o(cx, cy, dx, dy, bx, by);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function blockedMove(ax, ay, bx, by) {
  if (!map) return true;
  const cl = 2.5;
  for (const s of map.hard) {
    if (segsCross(ax, ay, bx, by, s[0], s[1], s[2], s[3])) return true;
    const d2 = ptSeg(bx, by, s); if (d2 < cl && d2 < ptSeg(ax, ay, s)) return true;
  }
  return false;
}
function computeMove(t, tx, ty, pass) {
  if (!map) return { x: t.x, y: t.y };
  tx = Math.max(0, Math.min(map.W, tx)); ty = Math.max(0, Math.min(map.H, ty));
  if (pass || !blockedMove(t.x, t.y, tx, ty)) return { x: tx, y: ty };
  if (!blockedMove(t.x, t.y, tx, t.y)) return { x: tx, y: t.y };
  if (!blockedMove(t.x, t.y, t.x, ty)) return { x: t.x, y: ty };
  return { x: t.x, y: t.y };
}
function moveTok(t, tx, ty) {
  const p = computeMove(t, tx, ty, canPass());
  t.x = p.x; t.y = p.y; fogDirty = true;
}
function snapSafe(t) {
  const ox = t.x, oy = t.y; snapTok(t);
  if (!canPass() && blockedMove(ox, oy, t.x, t.y)) { t.x = ox; t.y = oy; }
  fogDirty = true;
}
function hitToken(w) {
  const order = [...tokens.filter(t => t.layer === 'player'), ...tokens.filter(t => t.layer === 'gm')].reverse();
  for (const t of order) if (tokVisible(t) && Math.hypot(w.x - t.x, w.y - t.y) <= tokRadius(t) + 2 / view.k) return t;
  return null;
}
function distSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function hitDoor(w) {
  let best = null, bd = 10 / view.k;
  for (const d of map.doors) { const dd = distSeg(w, d.a, d.b); if (dd < bd) { bd = dd; best = d; } }
  return best;
}
function hitBulb(w) {
  let best = null, bd = 9 / view.k;
  for (const l of map.lights) { const dd = Math.hypot(w.x - l.x, w.y - l.y); if (dd < bd) { bd = dd; best = l; } }
  return best;
}

/* ---------- shared state ---------- */
const SHARED_SETTINGS = ['mode', 'dark', 'scale', 'snap', 'fog', 'explore', 'sight', 'preview', 'gmPass', 'showStatus', 'showHp', 'turnBased', 'moveLimit'];
function sharedSettings() { const o = {}; for (const k of SHARED_SETTINGS) o[k] = settings[k]; return o; }
function makeSnapshot() {
  rev++;
  return {
    v: 2, rev, ts: Date.now(), host: hostName || me.name || 'GM', mapKey: map ? map.key : 'cortez',
    turn: { number: turn.number, activeId: turn.activeId, moved: Object.assign({}, turn.moved), attacked: Object.assign({}, turn.attacked) },
    tokens: tokens.map(cleanToken),
    doors: map ? map.doors.map(d => d.open) : [],
    lights: map ? map.lights.map(l => l.force) : [],
    settings: sharedSettings(), ftPer, unit,
    roster: roster.map(r => ({ clientId: r.clientId, name: r.name, tokenId: r.tokenId, online: r.online, joinedAt: r.joinedAt })),
    log: logRows.slice(-70)
  };
}
function scheduleSync() {
  if (sessionRole !== 'host' || !net) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    net.publishState(makeSnapshot());
    net.updateMeta({ online: true, clients: onlineCount() });
    saveHostCheckpoint();
  }, 90);
}
function changed() {
  renderAll();
  if (sessionRole === 'host') scheduleSync();
  else if (sessionRole === 'solo') scheduleSave();
  invalidate();
}
function touch() {
  if (sessionRole === 'host') scheduleSync();
  else if (sessionRole === 'solo') scheduleSave();
  invalidate();
}
function applySnapshot(s, initial = false) {
  if (!s || s.v !== 2) return;
  if (!initial && s.rev <= rev) return;
  if (s.mapKey && map && s.mapKey !== map.key) {
    showMsg('This session uses a different map (' + s.mapKey + '). Ask the GM to load the default deck.');
    return;
  }
  rev = s.rev;
  hostName = s.host || hostName;
  tokens = (s.tokens || []).map(t => Object.assign(cleanToken(t), { plan: undefined }));
  nextId = Math.max(0, ...tokens.map(t => t.id)) + 1;
  syncTokenImages();
  if (map) {
    (s.doors || []).forEach((o, i) => { if (map.doors[i]) map.doors[i].open = !!o; });
    (s.lights || []).forEach((f, i) => { if (map.lights[i]) map.lights[i].force = f; });
    rebuildBlockers();
  }
  Object.assign(settings, s.settings || {});
  if (s.ftPer > 0) ftPer = s.ftPer;
  if (s.unit) unit = s.unit;
  turn = s.turn && typeof s.turn.number === 'number' ? { number: s.turn.number, activeId: s.turn.activeId ?? null, moved: s.turn.moved || {}, attacked: s.turn.attacked || {} } : { number: 1, activeId: null, moved: {}, attacked: {} };
  roster = Array.isArray(s.roster) ? s.roster : [];
  logRows = Array.isArray(s.log) ? s.log.slice(-70) : [];
  syncMyToken();
  syncSettingsUI(); updateDoorCount();
  fogDirty = true; lightDirty = true;
  renderAll();
  if (initial && !fitted) requestAnimationFrame(fitView);
  invalidate();
}
function syncMyToken() {
  const entry = roster.find(r => r.clientId === me.clientId);
  me.tokenId = entry && entry.tokenId != null ? entry.tokenId : null;
}
function syncSettingsUI() {
  if (!$('#lmode')) return;
  $('#lmode').value = settings.mode;
  $('#dark').value = Math.round(settings.dark * 100); $('#darkOut').textContent = Math.round(settings.dark * 100) + '%';
  $('#lscale').value = Math.round(settings.scale * 10); $('#lscaleOut').textContent = '×' + settings.scale.toFixed(1);
  $('#peek').checked = settings.peek; $('#snap').checked = settings.snap;
  $('#fogOn').checked = settings.fog; $('#explOn').checked = settings.explore;
  $('#sight').value = settings.sight; $('#sightOut').textContent = settings.sight + ' sq';
  $('#showHp').checked = settings.showHp; $('#turnOn').checked = settings.turnBased; $('#moveLim').value = settings.moveLimit;
  $('#preview').checked = settings.preview; $('#gmPass').checked = settings.gmPass; $('#showStatus').checked = settings.showStatus;
  $('#ftper').value = ftPer; $('#unit').value = unit;
  $$('.lrow[data-layer]').forEach(row => { const L = layers[row.dataset.layer]; $('.vis', row).checked = L.vis; const lk = $('.lock', row); if (lk) lk.checked = L.lock; });
}

/* ---------- drawing ---------- */
function requestDraw() { if (!needDraw) return; needDraw = false; requestAnimationFrame(draw); }
function invalidate() { needDraw = true; requestDraw(); }
function toWorld(e) { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k }; }
const toScreen = p => ({ x: p.x * view.k + view.x, y: p.y * view.k + view.y });

function draw() {
  needDraw = true;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = css('--stage'); ctx.fillRect(0, 0, cv.width, cv.height);
  if (!map) return;
  const k = view.k;
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.x, dpr * view.y);
  ctx.drawImage(map.img, 0, 0, map.W, map.H);

  if (layers.light.vis) {
    if (lightDirty) lightPass();
    ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = .55; ctx.drawImage(tint, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = (role === 'gm' && settings.peek) ? 0.42 : 1; ctx.drawImage(dark, 0, 0); ctx.globalAlpha = 1;
  }

  if (layers.rooms.vis) {
    ctx.lineCap = 'round'; ctx.lineWidth = 1.3 / k; ctx.strokeStyle = 'rgba(108,195,255,.5)'; ctx.beginPath();
    for (const wl of map.walls) { ctx.moveTo(wl[0], wl[1]); ctx.lineTo(wl[2], wl[3]); }
    ctx.stroke();
    for (const d of map.doors) {
      ctx.lineWidth = Math.max(3, (d === hoverDoor ? 6 : 4) / k); ctx.lineCap = 'butt';
      ctx.strokeStyle = d.open ? css('--open') : css('--gm');
      ctx.setLineDash(d.open ? [4 / k, 3 / k] : []);
      ctx.beginPath(); ctx.moveTo(d.a.x, d.a.y); ctx.lineTo(d.b.x, d.b.y); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  if (role === 'gm' && layers.light.vis) {
    for (const l of map.lights) {
      const r = 4.5 / k;
      ctx.beginPath(); ctx.arc(l.x, l.y, r, 0, 6.2832);
      if (l.on) { ctx.fillStyle = `rgb(${l.rgb})`; ctx.fill(); } else { ctx.fillStyle = 'rgba(7,10,15,.7)'; ctx.fill(); }
      ctx.lineWidth = 1.5 / k; ctx.strokeStyle = l.force === null ? 'rgba(255,255,255,.75)' : css('--accent');
      ctx.setLineDash(l.force === null ? [] : [2 / k, 2 / k]); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  if (settings.fog && fogDirty) fogPass();
  if (fogActive()) { ctx.globalAlpha = role === 'gm' ? 0.72 : 1; ctx.drawImage(fog, 0, 0); ctx.globalAlpha = 1; }
  for (const layer of ['gm', 'player']) for (const t of tokens) if (t.layer === layer && tokVisible(t)) drawToken(t);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawRuler();
}

function drawToken(t) {
  const r = tokRadius(t), k = view.k, isSel = t.id === selected, img = imgs.get(t.id), TAU = 6.2832;
  const ghost = t.layer === 'gm' && role === 'gm' && fogActive() && !(seenByPlayers(t.x, t.y) && isLit(t.x, t.y));
  const down = isDown(t), status = (t.status || '').trim();
  const showBar = t.maxHp > 0 && (role === 'gm' || settings.showHp || t.layer === 'player' || t.id === me.tokenId);
  const barH = Math.max(5 / k, 3.5);
  const active = settings.turnBased && turn.activeId === t.id;
  ctx.save(); ctx.globalAlpha = (ghost ? 0.35 : 1) * (down ? 0.6 : 1);
  if (active) {
    ctx.beginPath(); ctx.arc(t.x, t.y, r + 5 / k, 0, TAU); ctx.lineWidth = Math.max(2, 3 / k);
    ctx.strokeStyle = css('--accent'); ctx.setLineDash([6 / k, 4 / k]); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.beginPath(); ctx.arc(t.x, t.y + 1.2 / k, r, 0, TAU); ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fill();
  if (img) {
    // Cover-fit the portrait: centre-crop the largest square so faces are not squashed.
    // A dark backing disc keeps cut-out portraits legible against the map.
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const side = Math.min(iw, ih), sx = (iw - side) / 2, sy = (ih - side) / 2;
    ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, TAU); ctx.fillStyle = '#0d131b'; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, TAU); ctx.clip();
    ctx.drawImage(img, sx, sy, side, side, t.x - r, t.y - r, r * 2, r * 2);
    ctx.restore();
  }
  else { ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, TAU); ctx.fillStyle = t.color; ctx.fill(); }
  ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, TAU);
  if (t.layer === 'gm') {
    ctx.lineWidth = Math.max(1.6, 2 / k); ctx.strokeStyle = img ? t.color : '#1a0b08'; ctx.stroke();
    ctx.beginPath(); ctx.arc(t.x, t.y, r + 1.6 / k, 0, TAU); ctx.setLineDash([3 / k, 2 / k]); ctx.strokeStyle = css('--accent'); ctx.stroke(); ctx.setLineDash([]);
  } else { ctx.lineWidth = Math.max(1.8, (img ? 3 : 2) / k); ctx.strokeStyle = img ? t.color : (t.id === me.tokenId ? css('--player') : '#fff'); ctx.stroke(); }
  if (!img) {
    const px = Math.max(r * 0.95, 6);
    ctx.font = `600 ${px}px "Space Grotesk",Inter,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = lum(t.color) > 0.55 ? '#10151c' : '#fff'; ctx.fillText((t.name.trim()[0] || '?').toUpperCase(), t.x, t.y + px * 0.04);
  }
  if (down) {
    const q = r * 0.92; ctx.save(); ctx.globalAlpha = ghost ? 0.35 : 1; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(t.x - q, t.y - q); ctx.lineTo(t.x + q, t.y + q); ctx.moveTo(t.x + q, t.y - q); ctx.lineTo(t.x - q, t.y + q);
    ctx.lineWidth = Math.max(5, 6 / k); ctx.strokeStyle = 'rgba(40,0,0,.85)'; ctx.stroke();
    ctx.lineWidth = Math.max(3, 3.6 / k); ctx.strokeStyle = '#ff2d2d'; ctx.stroke(); ctx.restore();
  }
  if (t.layer === 'gm' && status && (role === 'gm' || settings.showStatus)) {
    const fs = Math.max(10 / k, 4), txt = status.slice(0, 24);
    ctx.font = `600 ${fs}px Inter,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(txt).width, pad = fs * 0.55, bh = fs * 1.55, by = t.y - r - bh - 2 / k;
    ctx.fillStyle = down ? '#8a99ad' : css('--accent'); ctx.beginPath(); ctx.roundRect(t.x - tw / 2 - pad, by, tw + pad * 2, bh, bh / 2); ctx.fill();
    ctx.fillStyle = '#10151c'; ctx.fillText(txt, t.x, by + bh / 2 + fs * 0.04);
  }
  if (showBar) {
    const bw = Math.max(r * 2.3, 24 / k), bx = t.x - bw / 2, by = t.y + r + 2 / k, f = Math.max(0, Math.min(1, t.hp / t.maxHp));
    ctx.fillStyle = 'rgba(8,12,18,.88)'; ctx.fillRect(bx - 1 / k, by - 1 / k, bw + 2 / k, barH + 2 / k);
    ctx.fillStyle = f > 0.5 ? '#58d68a' : f > 0.25 ? '#f2a93b' : '#ff4d3d'; ctx.fillRect(bx, by, bw * f, barH);
  }
  ctx.restore();
  if (isSel) { ctx.beginPath(); ctx.arc(t.x, t.y, r + 4 / k, 0, TAU); ctx.lineWidth = 2 / k; ctx.strokeStyle = css('--accent'); ctx.stroke(); }
  if (isSel || t === hoverTok || (role === 'player' && t.id === me.tokenId)) {
    const fs = Math.max(11 / k, 4); ctx.font = `500 ${fs}px Inter,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lbl = t.name + (showBar && (role === 'gm' || isSel || t === hoverTok || t.id === me.tokenId) ? ' · ' + t.hp + '/' + t.maxHp : '');
    const tw = ctx.measureText(lbl).width, pad = fs * 0.5, bx = t.x - tw / 2 - pad, by = t.y + r + fs * 0.35 + (showBar ? barH + 3 / k : 0), bh = fs * 1.5;
    ctx.fillStyle = 'rgba(11,15,21,.92)'; ctx.fillRect(bx, by, tw + pad * 2, bh);
    ctx.fillStyle = '#fff'; ctx.fillText(lbl, t.x, by + bh / 2);
  }
}

function drawRuler() {
  if (!ruler || !map) return;
  const a = toScreen(ruler.a), b = toScreen(ruler.b);
  ctx.lineWidth = 2; ctx.strokeStyle = css('--accent'); ctx.setLineDash([7, 5]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
  for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, 6.2832); ctx.fillStyle = css('--accent'); ctx.fill(); }
  const sq = Math.hypot(ruler.b.x - ruler.a.x, ruler.b.y - ruler.a.y) / map.ppg;
  const label = `${fmt(sq * ftPer)} ${unit}  ·  ${fmt(sq)} sq`;
  ctx.font = '500 12px "IBM Plex Mono",monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width + 16, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 18;
  ctx.fillStyle = 'rgba(11,15,21,.94)'; ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(mx - tw / 2, my - 11, tw, 22, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.fillText(label, mx, my + 0.5);
}

/* ---------- view ---------- */
function fitView() {
  if (!map) return; const r = cv.getBoundingClientRect(); if (!r.width) return;
  view.k = Math.min(r.width / map.W, r.height / map.H) * 0.97;
  view.x = (r.width - map.W * view.k) / 2; view.y = (r.height - map.H * view.k) / 2; fitted = true; invalidate();
}
function zoomAt(f, mx, my) {
  const nk = Math.max(0.15, Math.min(10, view.k * f)), wx = (mx - view.x) / view.k, wy = (my - view.y) / view.k;
  view.k = nk; view.x = mx - wx * nk; view.y = my - wy * nk; invalidate();
}
new ResizeObserver(() => { if (!fitted) fitView(); invalidate(); }).observe(cv);

/* ---------- input ---------- */
function snapRuler(w) { if (!settings.snap || !map) return w; const g = map.ppg; return { x: (Math.floor(w.x / g) + .5) * g, y: (Math.floor(w.y / g) + .5) * g }; }
const rectXY = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

cv.addEventListener('pointerdown', e => {
  if (!map) return; cv.focus({ preventScroll: true }); cv.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, rectXY(e));
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k, wx: ((a.x + b.x) / 2 - view.x) / view.k, wy: ((a.y + b.y) / 2 - view.y) / view.k }; drag = null; return; }
  const w = toWorld(e);
  if (tool === 'ruler') { const p = snapRuler(w); ruler = { a: p, b: p }; drag = { type: 'ruler' }; invalidate(); return; }
  const t = hitToken(w);
  if (t && tokVisible(t)) {
    selected = t.id; markSel(); invalidate();
    if (!canTouch(t)) {
      if (role === 'player' && t.layer === 'gm') showMsg('That hostile is under the GM\'s control.');
      else if (role === 'player' && t.id !== me.tokenId) showMsg('That character belongs to another player.');
      else showMsg('You cannot move that token right now.');
      return;
    }
    if (role === 'player' && (!hostOnline || netState !== 'live')) { showMsg('The GM is offline. The table is paused.'); return; }
    if (role === 'player') {
      if (!settings.turnBased) { /* free move */ }
      else if (turn.activeId !== t.id) {
        showMsg(turn.activeId ? 'It is not your turn yet. The GM assigns turns.' : 'The GM has not assigned a turn yet.');
        return;
      }
    }
    drag = { type: 'token', t, dx: t.x - w.x, dy: t.y - w.y, sx: t.x, sy: t.y, moved: false };
    invalidate(); return;
  }
  if (role === 'gm') {
    if (layers.light.vis) { const bl = hitBulb(w); if (bl) { bl.force = bl.force === null ? true : (bl.force === true ? false : null); lightDirty = true; logEvent(`GM turns a light ${bl.force === null ? 'to automatic' : bl.force ? 'on' : 'off'}.`); changed(); return; } }
    if (layers.rooms.vis && !layers.rooms.lock) {
      const d = hitDoor(w);
      if (d) { d.open = !d.open; rebuildBlockers(); lightDirty = true; updateDoorCount(); logEvent(`GM ${d.open ? 'opens' : 'closes'} ${d.name}.`); changed(); return; }
    }
  } else if (role === 'player') {
    const d = hitDoor(w);
    if (d) { requestDoor(d); return; }
  }
  selected = null; markSel();
  drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }; invalidate();
});
cv.addEventListener('pointermove', e => {
  if (!map) return;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, rectXY(e));
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y), nk = Math.max(0.15, Math.min(10, pinch.k * d / pinch.d));
    view.k = nk; view.x = (a.x + b.x) / 2 - pinch.wx * nk; view.y = (a.y + b.y) / 2 - pinch.wy * nk; invalidate(); return;
  }
  const w = toWorld(e);
  if (drag) {
    if (drag.type === 'pan') { view.x = drag.ox + e.clientX - drag.sx; view.y = drag.oy + e.clientY - drag.sy; }
    else if (drag.type === 'token') { moveTok(drag.t, w.x + drag.dx, w.y + drag.dy); drag.moved = true; }
    else if (drag.type === 'ruler') ruler.b = snapRuler(w);
    invalidate(); return;
  }
  const ht = hitToken(w);
  const hd = (layers.rooms.vis && !layers.rooms.lock) ? hitDoor(w) : null;
  const hb = (role === 'gm' && layers.light.vis) ? hitBulb(w) : null;
  if (ht !== hoverTok || hd !== hoverDoor) { hoverTok = ht; hoverDoor = ht ? null : hd; invalidate(); }
  cv.style.cursor = tool === 'ruler' ? 'crosshair' : (ht && canTouch(ht)) ? 'grab' : (hd || hb) ? 'pointer' : 'default';
  const own = ht && (isHost() || ht.id === me.tokenId);
  const turnMsg = ht && role === 'player' && settings.turnBased && turn.activeId !== ht.id ? ' · waiting for their turn' : '';
  setHint(hd && !ht ? (role === 'gm' ? `${hd.name} · ${hd.open ? 'open' : 'closed'} · click to ${hd.open ? 'close' : 'open'}` : `${hd.name} · ${hd.open ? 'open' : 'closed'} · click to ask the GM`) : hb && !ht ? `Light · ${hb.force === null ? 'automatic' : hb.force ? 'forced on' : 'forced off'} · click to cycle` : ht && own ? `${ht.name} · HP ${ht.hp}/${ht.maxHp}${turnMsg}` : null);
});
function endPointer(e) {
  pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null;
  if (drag && drag.type === 'token') {
    const t = drag.t;
    if (settings.snap) snapSafe(t);
    if (drag.moved) {
      if (role === 'player') {
        net && net.sendAction({ type: 'move', tokenId: t.id, x: t.x, y: t.y }).catch(() => showMsg('Could not send the move. Check your connection.'));
      } else {
        if (settings.turnBased && turn.activeId === t.id) {
          const d = Math.hypot(t.x - drag.sx, t.y - drag.sy) / map.ppg;
          turn.moved[t.id] = (turn.moved[t.id] || 0) + d;
        }
        fogDirty = true; changed();
      }
    }
  }
  drag = null; invalidate();
}
cv.addEventListener('pointerup', endPointer); cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('pointerleave', () => { if (hoverTok || hoverDoor) { hoverTok = hoverDoor = null; invalidate(); } setHint(null); });
cv.addEventListener('wheel', e => { e.preventDefault(); const p = rectXY(e); zoomAt(Math.exp(-e.deltaY * 0.0016), p.x, p.y); }, { passive: false });
cv.addEventListener('keydown', e => {
  if (e.key === 'Escape') { ruler = null; selected = null; markSel(); invalidate(); }
  else if (e.key === 'r' || e.key === 'R') setTool('ruler');
  else if (e.key === 'v' || e.key === 'V') setTool('move');
  else if (e.key === 'f' || e.key === 'F') fitView();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && role === 'gm' && selected) removeToken(selected);
});

const stage = $('#stage');
stage.addEventListener('dragover', e => e.preventDefault());
stage.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) readFile(f); });
function readFile(f) {
  if (sessionRole !== 'solo') { showMsg('Custom maps can only be loaded in Solo GM mode.'); return; }
  const fr = new FileReader();
  fr.onload = () => { try { loadMap(JSON.parse(fr.result), 'custom').catch(err => showMsg(err.message)); } catch (err) { showMsg('Could not read that file as JSON.'); } };
  fr.readAsText(f);
}
$('#file').addEventListener('change', e => { const f = e.target.files[0]; if (f) readFile(f); e.target.value = ''; });

/* ---------- hint + tools ---------- */
function setHint(extra) {
  const base = role === 'player'
    ? (tool === 'ruler' ? 'Drag to measure. Esc clears.'
      : !me.tokenId ? 'Waiting for the GM to assign you a character.'
      : settings.turnBased && turn.activeId !== me.tokenId ? 'Waiting for your turn. You can still measure and inspect the map.'
      : 'Drag your token to move. Click a door to ask the GM to open it. Wheel to zoom.')
    : (tool === 'ruler' ? 'Drag to measure. Esc clears.' : 'Assign turns · drag the active token · Attack from its row · click doors and lights · shift-drag places any token');
  $('#hint').textContent = extra || base;
}
function setTool(t) {
  tool = t; $('#toolMove').setAttribute('aria-pressed', t === 'move'); $('#toolRuler').setAttribute('aria-pressed', t === 'ruler');
  if (t === 'move') ruler = null; cv.style.cursor = t === 'ruler' ? 'crosshair' : 'default'; setHint(null); invalidate();
}
$('#toolMove').onclick = () => setTool('move'); $('#toolRuler').onclick = () => setTool('ruler');
$('#zIn').onclick = () => zoomAt(1.25, cv.clientWidth / 2, cv.clientHeight / 2);
$('#zOut').onclick = () => zoomAt(0.8, cv.clientWidth / 2, cv.clientHeight / 2);
$('#btnFit').onclick = fitView;

/* ---------- panel wiring ---------- */
$$('.lrow[data-layer]').forEach(row => {
  const L = layers[row.dataset.layer];
  const vis = $('.vis', row), lock = $('.lock', row);
  vis.onchange = () => { L.vis = vis.checked; changed(); };
  if (lock) lock.onchange = () => { L.lock = lock.checked; changed(); };
});
function updateDoorCount() {
  if (!map) return;
  const el = $('#doorCount'); if (!el) return;
  const n = map.doors.filter(d => d.open).length;
  el.textContent = `${n} of ${map.doors.length} open`;
}
function setAllDoors(v) {
  if (!map || role !== 'gm') return;
  map.doors.forEach(d => { d.open = v; }); rebuildBlockers(); lightDirty = true; updateDoorCount();
  logEvent(v ? 'GM opens every door.' : 'GM closes every door.'); changed();
}
$('#openAll').onclick = () => setAllDoors(true);
$('#closeAll').onclick = () => setAllDoors(false);
$('#lmode').onchange = e => { settings.mode = e.target.value; lightDirty = true; changed(); };
$('#dark').oninput = e => { settings.dark = e.target.value / 100; $('#darkOut').textContent = e.target.value + '%'; lightDirty = true; invalidate(); scheduleLightSync(); };
$('#lscale').oninput = e => { settings.scale = e.target.value / 10; $('#lscaleOut').textContent = '×' + settings.scale.toFixed(1); lightDirty = true; invalidate(); scheduleLightSync(); };
$('#peek').onchange = e => { settings.peek = e.target.checked; invalidate(); };
$('#snap').onchange = e => { settings.snap = e.target.checked; commitSetting(); };
$('#ftper').oninput = e => { const v = parseFloat(e.target.value); if (v > 0) { ftPer = v; invalidate(); scheduleLightSync(); } };
$('#unit').onchange = e => { unit = e.target.value; changed(); };
$('#fogOn').onchange = e => { settings.fog = e.target.checked; fogDirty = true; changed(); };
$('#explOn').onchange = e => { settings.explore = e.target.checked; fogDirty = true; changed(); };
$('#sight').oninput = e => { settings.sight = +e.target.value; $('#sightOut').textContent = settings.sight + ' sq'; fogDirty = true; invalidate(); scheduleLightSync(); };
$('#preview').onchange = e => { settings.preview = e.target.checked; changed(); };
$('#gmPass').onchange = e => { settings.gmPass = e.target.checked; commitSetting(); };
$('#showStatus').onchange = e => { settings.showStatus = e.target.checked; changed(); };
$('#showHp').onchange = e => { settings.showHp = e.target.checked; changed(); };
$('#clearExpl').onclick = () => { clearExplored(); invalidate(); };
$('#endTurn').onclick = () => nextTurn(1);
$('#nextTurn2').onclick = () => nextTurn(1);
$('#prevTurn').onclick = () => nextTurn(-1);
$('#clearTurn').onclick = () => { turn.activeId = null; turn.moved = {}; turn.attacked = {}; logEvent('GM unassigns the turn.'); changed(); };
$('#turnOn').onchange = e => { settings.turnBased = e.target.checked; if (!settings.turnBased) { turn.activeId = null; turn.moved = {}; turn.attacked = {}; } logEvent(settings.turnBased ? 'Turn-based play enabled.' : 'Free movement enabled.'); changed(); };
$('#moveLim').oninput = e => { const v = parseFloat(e.target.value); settings.moveLimit = v > 0 ? v : 0; commitSetting(); };
function commitSetting() { if (sessionRole === 'host') scheduleSync(); if (sessionRole === 'solo') scheduleSave(); }
function scheduleLightSync() { if (sessionRole === 'host') scheduleSync(); else if (sessionRole === 'solo') scheduleSave(); }

let confirmTimer = 0;
$('#btnReset').onclick = e => {
  const b = e.currentTarget;
  if (!b.classList.contains('danger')) { b.classList.add('danger'); b.textContent = 'Click again to reset'; confirmTimer = setTimeout(() => { b.classList.remove('danger'); b.textContent = 'Reset scene'; }, 3500); return; }
  clearTimeout(confirmTimer); b.classList.remove('danger'); b.textContent = 'Reset scene';
  if (!map) return;
  const keepRoster = roster;
  resetToDefaults();
  roster = keepRoster;
  roster.forEach(r => { r.tokenId = null; });
  logEvent('GM resets the scene.'); changed();
};

/* ---------- token list ---------- */
function markSel() { $$('.trow').forEach(r => r.classList.toggle('sel', +r.dataset.id === selected)); }
function renderAll() {
  if (!map) return;
  renderTokens(); renderRoster(); renderSheet(); renderTurnOrder(); renderLog(); updateTurnUI(); updateDoorCount(); setHint(null); invalidate();
}
function renderTokens() {
  for (const [layer, id] of [['player', '#rowsPlayer'], ['gm', '#rowsGm']]) {
    const box = $(id); if (!box) continue;
    box.textContent = '';
    const list = tokens.filter(t => t.layer === layer && (role === 'gm' || tokVisible(t)));
    if (layer === 'player') $('#plCount').textContent = tokens.filter(t => t.layer === 'player').length + '/' + MAX_PLAYERS;
    if (!list.length) {
      const p = document.createElement('div'); p.className = 'empty';
      p.textContent = layer === 'gm' ? (role === 'gm' ? 'No hostiles.' : 'No hostiles in sight.') : 'No player tokens.';
      box.append(p); continue;
    }
    for (const t of list) box.append(tokenRow(t));
  }
  $('#addPlayer').disabled = tokens.filter(t => t.layer === 'player').length >= MAX_PLAYERS;
  fogDirty = true; markSel(); updateTurnUI();
}
function tokenRow(t) {
  const row = document.createElement('div'); row.className = 'trow'; row.dataset.id = t.id;
  if (t.id === selected) row.classList.add('sel');
  if (t.id === me.tokenId) row.classList.add('mine');
  const l1 = document.createElement('div'); l1.className = 'l1';
  if (role === 'gm') {
    const col = document.createElement('input'); col.type = 'color'; col.value = t.color; col.setAttribute('aria-label', 'Colour for ' + t.name);
    col.oninput = () => { t.color = col.value; touch(); };
    col.onchange = () => changed();
    const nm = document.createElement('input'); nm.type = 'text'; nm.value = t.name; nm.setAttribute('aria-label', 'Token name');
    nm.oninput = () => { t.name = nm.value || ' '; touch(); };
    nm.onchange = () => changed();
    nm.onfocus = () => { selected = t.id; markSel(); invalidate(); };
    const sz = document.createElement('select'); sz.setAttribute('aria-label', 'Size');
    for (const n of [1, 2, 3, 4]) { const o = document.createElement('option'); o.value = n; o.textContent = n + '×' + n; if (n === t.size) o.selected = true; sz.append(o); }
    sz.onchange = () => { t.size = +sz.value; if (settings.snap) snapSafe(t); changed(); };
    const im = document.createElement('button'); im.type = 'button'; im.className = 'btn imgb' + (t.img ? ' has' : ''); im.textContent = 'Img';
    im.setAttribute('aria-label', 'Set image for ' + t.name); im.title = 'Upload a token image';
    if (t.img) im.style.backgroundImage = 'url("' + t.img + '")';
    im.onclick = () => { pendingImg = t.id; $('#imgFile').click(); };
    const x = document.createElement('button'); x.type = 'button'; x.className = 'btn x'; x.textContent = '×'; x.setAttribute('aria-label', 'Delete ' + t.name);
    x.onclick = () => removeToken(t.id);
    l1.append(col, nm, sz, im, x);
  } else {
    const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = t.color;
    const nm = document.createElement('span'); nm.className = 'tname'; nm.textContent = t.name;
    const badges = document.createElement('span'); badges.className = 'badges';
    if (t.id === me.tokenId) badges.append(badge('YOU', 'you'));
    if (settings.turnBased && turn.activeId === t.id) badges.append(badge('TURN', 'turn'));
    l1.append(sw, nm, badges);
    l1.classList.add('pv');
  }
  row.append(l1);
  if (role === 'gm') {
    const l2 = document.createElement('div'); l2.className = 'l2';
    const st = document.createElement('input'); st.type = 'text'; st.placeholder = 'Status (e.g. Wounded)'; st.value = t.status || ''; st.maxLength = 30;
    st.setAttribute('list', 'statusList'); st.setAttribute('aria-label', 'Status for ' + t.name);
    st.oninput = () => { t.status = st.value; touch(); };
    st.onchange = () => changed();
    st.onfocus = () => { selected = t.id; markSel(); invalidate(); };
    if (t.img) { const c = document.createElement('button'); c.type = 'button'; c.className = 'btn tiny'; c.textContent = 'Clear image'; c.onclick = () => { delete t.img; imgs.delete(t.id); changed(); }; l2.append(c); }
    l2.append(st); row.append(l2);
  }
  row.append(hpBlock(t, role === 'gm' || t.id === me.tokenId, role === 'gm'));
  if (role === 'gm' || t.id === me.tokenId) {
    row.append(combatRow(t));
    row.append(statsBlock(t, role === 'gm'));
  }
  if (role === 'gm' || t.id === me.tokenId) {
    const inv = document.createElement('div'); inv.className = 'invbox';
    const head = document.createElement('div'); head.className = 'invhead';
    const lab = document.createElement('span'); lab.textContent = 'Inventory'; head.append(lab);
    if (settings.turnBased && role === 'gm') {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn tiny' + (turn.activeId === t.id ? ' primary' : '');
      b.textContent = turn.activeId === t.id ? 'Has turn' : 'Give turn'; b.disabled = isDown(t);
      b.onclick = () => assignTurn(t.id);
      head.append(b);
    }
    inv.append(head, inventoryEditor(t, true));
    row.append(inv);
  } else if (t.layer === 'gm' && settings.showStatus && t.status) {
    const s = document.createElement('div'); s.className = 'muted statline'; s.textContent = t.status; row.append(s);
  }
  return row;
}
function badge(text, cls) { const b = document.createElement('span'); b.className = 'badge ' + cls; b.textContent = text; return b; }

function combatTargets(t) {
  return tokens.filter(o => o.id !== t.id && !isDown(o) &&
    (role === 'gm' || (o.layer === 'gm' && tokVisible(o))));
}
function attackBlockedReason(t) {
  if (!t || !map) return 'No map loaded';
  if (isDown(t)) return t.name + ' is down';
  if (role === 'player' && t.id !== me.tokenId) return 'Not your character';
  if (settings.turnBased) {
    if (turn.activeId !== t.id) return 'Not ' + t.name + "'s turn";
    if (turn.attacked && turn.attacked[t.id]) return t.name + ' has already attacked this turn';
  }
  const targets = combatTargets(t);
  if (!targets.length) return role === 'player' ? 'No hostile in sight' : 'No valid target';
  const usable = targets.some(o => combatReach(t, o).ok);
  if (!usable) return 'No target in reach for a ' + weaponOf(t).label;
  return '';
}
function combatRow(t) {
  const row = document.createElement('div'); row.className = 'l2 combatrow';
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn tiny primary'; b.textContent = settings.turnBased && turn.attacked && turn.attacked[t.id] ? 'Attack used' : 'Attack';
  const reason = attackBlockedReason(t);
  b.disabled = !!reason;
  b.title = reason || 'Choose a target and a move';
  b.onclick = () => openCombat(t.id);
  const w = weaponOf(t);
  const meta = document.createElement('span'); meta.className = 'mono muted combatmeta';
  meta.textContent = `${w.label} · ${w.type}` + (settings.turnBased && turn.attacked && turn.attacked[t.id] ? ' · used' : '');
  row.append(b, meta);
  return row;
}
function statsBlock(t, editable) {
  const d = computeStats(t.stats), w = weaponOf(t);
  const box = document.createElement('details'); box.className = 'statbox';
  box.open = selected === t.id || openStats.has(t.id);
  box.addEventListener('toggle', () => { if (box.open) openStats.add(t.id); else openStats.delete(t.id); });
  const sum = document.createElement('summary');
  const title = document.createElement('span'); title.textContent = 'Combat stats';
  const meta = document.createElement('span'); meta.className = 'mono muted';
  meta.textContent = `${fmt(d.skill)} skill · DMG ${d.damage} · ${w.label}${w.type === 'ranged' ? ' (ranged)' : ''}`;
  sum.append(title, meta); box.append(sum);
  const grid = document.createElement('div'); grid.className = 'statsgrid';
  const fields = [['melee', 'Melee'], ['martialArts', 'Martial Arts'], ['dance', 'Dance'], ['athletic', 'Athletic']];
  for (const [key, label] of fields) {
    const l = document.createElement('label'); l.textContent = label;
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = 0; inp.max = 50; inp.step = 1;
    inp.value = t.stats[key]; inp.disabled = !editable; inp.setAttribute('aria-label', label + ' for ' + t.name);
    inp.oninput = () => { t.stats[key] = clampStat(inp.value, t.stats[key]); recalcMaxHp(t); touch(); };
    inp.onchange = () => changed();
    l.append(inp); grid.append(l);
  }
  const wl = document.createElement('label'); wl.textContent = 'Weapon';
  const sel = document.createElement('select'); sel.disabled = !editable; sel.setAttribute('aria-label', 'Weapon for ' + t.name);
  const u = document.createElement('option'); u.value = ''; u.textContent = 'Unarmed (melee)'; sel.append(u);
  for (const key of WEAPON_KEYS) {
    const o = document.createElement('option'); o.value = key;
    o.textContent = `${WEAPONS[key].label} (${WEAPONS[key].type})`;
    if (key === weaponKeyOf(t)) o.selected = true;
    sel.append(o);
  }
  sel.onchange = () => { t.weapon = WEAPONS[sel.value] ? sel.value : ''; changed(); };
  wl.append(sel); grid.append(wl);
  const note = document.createElement('div'); note.className = 'sub statnote';
  note.textContent = 'Skill = best of Melee, Martial Arts, Dance × 0.66. Max HP = Athletic × 2 + skill. Damage = round(skill / 2), minimum 1, × weapon factor.';
  grid.append(note);
  box.append(grid);
  return box;
}

function openCombat(attackerId) {
  const a = tokenById(attackerId);
  if (!a) return;
  const reason = attackBlockedReason(a);
  if (reason) { showMsg(reason); return; }
  const targets = combatTargets(a);
  if (!targets.length) { showMsg('No valid targets.'); return; }
  combatCtx = { attackerId };
  combatChosenMove = 'strike';
  const sel = $('#combatTarget');
  sel.textContent = '';
  targets.sort((p, q) => {
    const dp = combatReach(a, p), dq = combatReach(a, q);
    if (dp.ok !== dq.ok) return dp.ok ? -1 : 1;
    return (dp.dist ?? 0) - (dq.dist ?? 0);
  });
  for (const t of targets) {
    const o = document.createElement('option');
    o.value = t.id;
    const reach = combatReach(a, t);
    o.textContent = t.name + ' · ' + t.hp + '/' + t.maxHp + ' HP' + (reach.ok ? '' : ' · out of reach');
    sel.append(o);
  }
  sel.value = targets[0].id;
  $('#combatAttackerName').textContent = a.name;
  const w = weaponOf(a), d = computeStats(a.stats);
  $('#combatAttackerStats').textContent = `${w.label} · ${w.type} · DMG ${d.damage} ×${w.damage}`;
  $('#combatResult').hidden = true;
  $('#combatResult').textContent = '';
  $$('#combatMoves [data-move]').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset.move === combatChosenMove ? 'true' : 'false');
    b.onclick = () => { combatChosenMove = b.dataset.move; updateCombatDialog(); };
  });
  sel.onchange = updateCombatDialog;
  updateCombatDialog();
  const dlg = $('#combatDlg');
  if (!dlg.open) dlg.showModal();
  sel.focus();
}
function updateCombatDialog() {
  if (!combatCtx) return;
  const a = tokenById(combatCtx.attackerId);
  const b = tokenById(+$('#combatTarget').value);
  if (!a || !b) return;
  const reach = combatReach(a, b);
  const w = weaponOf(b), d = computeStats(b.stats);
  $('#combatTargetStats').textContent = `HP ${b.hp}/${b.maxHp} · ${w.label} · ${w.type}${isDown(b) ? ' · down' : ''}`;
  $('#combatRange').textContent = reach.text + (reach.ok ? '' : ' — move closer or use a ranged weapon');
  $('#combatRange').dataset.ok = reach.ok ? 'yes' : 'no';
  $$('#combatMoves [data-move]').forEach(btn => btn.setAttribute('aria-pressed', btn.dataset.move === combatChosenMove ? 'true' : 'false'));
  const react = $('#combatReact');
  const forcedAuto = role === 'player' || b.layer === 'gm';
  react.disabled = forcedAuto;
  if (forcedAuto) react.value = 'auto';
  $('#combatReactWrap').title = forcedAuto ? 'Hostile reactions are always chosen by enemy AI.' : "The GM may choose the player defender's reaction or let the enemy AI roll.";
  $('#combatGo').disabled = !reach.ok || isDown(b);
  $('#combatGo').textContent = role === 'player' ? 'Send attack' : 'Attack';
}
function closeCombat() {
  const dlg = $('#combatDlg');
  if (dlg.open) dlg.close();
  combatCtx = null;
}
function healthConditions(pre, post, name, out) {
  if (post <= 60 && pre > 60) out.push(`${name} is staggered.`);
  if (post <= 30 && pre > 30) out.push(`${name} is bloodied.`);
  if (post < -25) out.push(`${name} requires immediate medical attention.`);
}
function dealCombatDamage(target, amount, messages) {
  const dmg = Math.max(0, Math.floor(amount));
  if (dmg <= 0) return 0;
  target.hp = Math.max(0, target.hp - dmg);
  messages.push(`${target.name} takes ${dmg} damage (${target.hp}/${target.maxHp}).`);
  if (weaponKeyOf(target)) {
    messages.push(`${target.name} is disarmed.`);
    target.weapon = '';
  }
  return dmg;
}
function resolveExchange(a, b, aMove, bMove, aiRoll) {
  const aPre = healthPct(a), bPre = healthPct(b);
  const messages = [];
  messages.push(`${a.name} chooses ${MOVE_LABEL[aMove]}; ${b.name} reacts with ${bMove ? MOVE_LABEL[bMove] : 'nothing'}.` + (aiRoll ? ` (d20 ${aiRoll})` : ''));
  if (!bMove) {
    const w = weaponOf(a);
    messages.push(`${b.name} was caught unaware, ${a.name} ${w.sucker} them.`);
    dealCombatDamage(b, damageWithWeapon(a) * critWithWeapon(a), messages);
  } else if (aMove === 'strike') {
    if (bMove === 'strike') {
      const aDmg = damageWithWeapon(a) + 0.25, bDmg = damageWithWeapon(b) + 0.25;
      dealCombatDamage(b, aDmg, messages);
      dealCombatDamage(a, bDmg, messages);
      messages.push(`Both ${a.name} and ${b.name} struck each other.`);
    } else if (bMove === 'grapple') {
      dealCombatDamage(b, damageWithWeapon(a), messages);
      messages.push(`${a.name} ${attackVerb(a, choice(MISS.strike))} ${b.name}'s ${choice(HIT_ZONE)}.`);
    } else if (bMove === 'counter') {
      dealCombatDamage(a, damageWithWeapon(b), messages);
      messages.push(`${b.name} saw ${a.name} telegraph their move, and countered by deflecting the shot and ${attackVerb(b, choice(MISS.strike))} their ${choice(HIT_ZONE)}.`);
    }
  } else if (aMove === 'grapple') {
    if (bMove === 'strike') {
      dealCombatDamage(a, damageWithWeapon(b), messages);
      messages.push(`${b.name} ${attackVerb(b, choice(MISS.strike))} ${a.name}'s ${choice(HIT_ZONE)}.`);
    } else if (bMove === 'grapple') {
      const aHp = a.hp, bHp = b.hp;
      if (aHp === bHp) messages.push('Both combatants attempted to grapple each other; there was no clear winner.');
      else if (bHp > aHp) {
        dealCombatDamage(a, damageWithWeapon(b), messages);
        messages.push(`${b.name} ${attackVerb(b, choice(MISS.grapple))} ${a.name}'s ${choice(GRAPPLE_ZONE)}.`);
      } else {
        dealCombatDamage(b, damageWithWeapon(a), messages);
        messages.push(`${a.name} ${attackVerb(a, choice(MISS.grapple))} ${b.name}'s ${choice(GRAPPLE_ZONE)}.`);
      }
    } else if (bMove === 'counter') {
      dealCombatDamage(b, damageWithWeapon(a), messages);
      messages.push(`${a.name} ${attackVerb(a, choice(MISS.grapple))} ${b.name}'s ${choice(GRAPPLE_ZONE)}.`);
    }
  } else if (aMove === 'counter') {
    if (bMove === 'strike') {
      dealCombatDamage(b, damageWithWeapon(a), messages);
      messages.push(`${a.name} saw ${b.name} telegraph their move, and countered by deflecting the shot and ${attackVerb(a, choice(MISS.strike))} their ${choice(HIT_ZONE)}.`);
    } else if (bMove === 'grapple') {
      dealCombatDamage(a, damageWithWeapon(b), messages);
      messages.push(`${b.name} ${attackVerb(b, choice(MISS.grapple))} ${a.name}'s ${choice(GRAPPLE_ZONE)}.`);
    } else if (bMove === 'counter') {
      messages.push(`${a.name} and ${b.name} stare each other down.`);
    }
  }
  healthConditions(aPre, healthPct(a), a.name, messages);
  healthConditions(bPre, healthPct(b), b.name, messages);
  if (b.hp <= 0 && a.hp > 0) messages.push(`${a.name} is victorious.`);
  else if (a.hp <= 0 && b.hp > 0) messages.push(`${b.name} is victorious.`);
  else if (a.hp <= 0 && b.hp <= 0) messages.push('Both combatants are down.');
  return messages;
}
function performAttack(attackerId, targetId, move, reaction, fromRemote = false) {
  const a = tokenById(attackerId), b = tokenById(targetId);
  if (!a || !b) return { error: 'That combatant is no longer on the table.' };
  if (a.id === b.id) return { error: 'A token cannot attack itself.' };
  if (isDown(a)) return { error: a.name + ' is down.' };
  if (isDown(b)) return { error: b.name + ' is already down.' };
  if (!MOVE_LABEL[move]) return { error: 'Choose Strike, Grapple or Counter.' };
  if (settings.turnBased) {
    if (turn.activeId !== a.id) return { error: 'It is not ' + a.name + "'s turn." };
    if (turn.attacked && turn.attacked[a.id]) return { error: a.name + ' has already attacked this turn.' };
  }
  if (role === 'player' && (a.layer !== 'player' || b.layer !== 'gm')) return { error: 'Players may only attack hostiles.' };
  const reach = combatReach(a, b);
  if (!reach.ok) return { error: a.name + ' is out of reach with a ' + weaponOf(a).label + '.' };
  let aiRoll = null, bMove = reaction;
  if (b.layer === 'gm' || bMove === 'auto' || !MOVE_LABEL[bMove]) {
    const ai = aiReaction(move);
    bMove = ai.move; aiRoll = ai.roll;
  }
  if (settings.turnBased) { turn.attacked = turn.attacked || {}; turn.attacked[a.id] = true; }
  const messages = resolveExchange(a, b, move, bMove, aiRoll);
  logEvent(`${a.name} attacks ${b.name}.\n${messages.join('\n')}`, 'combat');
  if (!fromRemote) showMsg(`${a.name} attacks ${b.name} — ${b.hp}/${b.maxHp} HP left.`);
  fogDirty = true;
  changed();
  return { ok: true, messages, targetHp: b.hp };
}
function submitCombat() {
  if (!combatCtx) return;
  const a = tokenById(combatCtx.attackerId);
  const b = tokenById(+$('#combatTarget').value);
  if (!a || !b) { closeCombat(); return; }
  const move = combatChosenMove;
  if (role === 'player') {
    if (sessionRole !== 'player' || !net) { showMsg('Not connected.'); return; }
    if (!hostOnline || netState !== 'live') { showMsg('The GM is offline. The table is paused.'); return; }
    net.sendAction({ type: 'attack', attackerId: a.id, targetId: b.id, move }).catch(() => showMsg('Could not send the attack.'));
    closeCombat();
    showMsg('Attack sent to the GM.');
    return;
  }
  const reaction = $('#combatReact').disabled ? 'auto' : $('#combatReact').value;
  const result = performAttack(a.id, b.id, move, reaction);
  if (result.error) {
    const box = $('#combatResult'); box.hidden = false; box.textContent = result.error;
    return;
  }
  closeCombat();
}
$('#combatGo').onclick = submitCombat;
$('#combatClose').onclick = closeCombat;
$('#combatCancel').onclick = closeCombat;
$('#combatDlg').addEventListener('cancel', e => { e.preventDefault(); closeCombat(); });
$('#combatDlg').addEventListener('click', e => { if (e.target === $('#combatDlg')) closeCombat(); });
function hpBlock(t, canEdit, canEditMax) {
  const wrap = document.createElement('div'); wrap.className = 'hpwrap';
  const r = document.createElement('div'); r.className = 'l2 hprow';
  const lab = document.createElement('span'); lab.className = 'mono muted'; lab.textContent = 'HP';
  const btn = (txt, label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn tiny'; b.textContent = txt; b.setAttribute('aria-label', label + ' for ' + t.name); b.onclick = fn; return b; };
  const num = (v, label, dis) => { const i = document.createElement('input'); i.type = 'number'; i.min = 0; i.step = 1; i.value = v; i.className = 'hpin'; i.setAttribute('aria-label', label + ' for ' + t.name); i.disabled = !dis; return i; };
  const cur = num(t.hp, 'Current HP', canEdit), max = num(t.maxHp, 'Maximum HP (derived)', false);
  max.title = 'Maximum HP is derived from Athletic + Melee skill';
  const slash = document.createElement('span'); slash.textContent = '/'; slash.className = 'muted';
  const commitHp = () => {
    const v = Math.max(0, Math.round(+cur.value || 0));
    if (role === 'player') {
      net && net.sendAction({ type: 'hp', tokenId: t.id, hp: v }).catch(() => {});
    } else {
      setHp(t, v); changed();
    }
  };
  cur.onchange = commitHp;
  const minus = btn('−', 'Lower HP', () => {
    if (role === 'player') { net && net.sendAction({ type: 'hp', tokenId: t.id, hp: Math.max(0, t.hp - 1) }).catch(() => {}); }
    else { setHp(t, t.hp - 1); changed(); }
  });
  const plus = btn('+', 'Raise HP', () => {
    if (role === 'player') { net && net.sendAction({ type: 'hp', tokenId: t.id, hp: Math.min(t.maxHp, t.hp + 1) }).catch(() => {}); }
    else { setHp(t, t.hp + 1); changed(); }
  });
  minus.disabled = !canEdit; plus.disabled = !canEdit;
  r.append(lab, minus, cur, slash, max, plus);
  const meter = document.createElement('div'); meter.className = 'hpbar';
  const track = document.createElement('div'); track.className = 'hptrack';
  const fill = document.createElement('i'); fill.style.width = Math.max(0, Math.min(100, t.maxHp > 0 ? (t.hp / t.maxHp) * 100 : 0)) + '%';
  fill.className = 'hpfill ' + (t.hp / Math.max(1, t.maxHp) > 0.5 ? 'good' : t.hp / Math.max(1, t.maxHp) > 0.25 ? 'warn' : 'bad');
  track.append(fill);
  const numEl = document.createElement('span'); numEl.className = 'mono hpnum'; numEl.textContent = `${t.hp} / ${t.maxHp}`;
  meter.append(track, numEl);
  wrap.append(r, meter);
  return wrap;
}
function setHp(t, value) {
  const prev = t.hp;
  t.hp = Math.max(0, Math.min(t.maxHp, Math.round(+value || 0)));
  if (t.hp < prev) logEvent(`${t.name} takes ${prev - t.hp} damage (${t.hp}/${t.maxHp}).`);
  else if (t.hp > prev) logEvent(`${t.name} recovers ${t.hp - prev} HP (${t.hp}/${t.maxHp}).`);
  if (prev > 0 && t.hp === 0) logEvent(`${t.name} is down!`);
}
function inventoryEditor(t, editable) {
  const box = document.createElement('div'); box.className = 'inv';
  if (!t.inventory.length) { const e = document.createElement('span'); e.className = 'muted empty'; e.textContent = 'Empty'; box.append(e); }
  t.inventory.forEach((it, idx) => {
    const chip = document.createElement('span'); chip.className = 'invitem';
    const nm = document.createElement('span'); nm.textContent = it.name;
    const q = document.createElement('b'); q.textContent = '×' + it.qty;
    chip.append(nm, q);
    if (editable) {
      const use = document.createElement('button'); use.type = 'button'; use.className = 'mini'; use.textContent = 'Use'; use.title = 'Use one';
      use.onclick = () => useItem(t, idx);
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'mini x'; rm.textContent = '×'; rm.title = 'Remove';
      rm.onclick = () => { t.inventory.splice(idx, 1); commitInventory(t); };
      chip.append(use, rm);
    }
    box.append(chip);
  });
  if (editable) {
    const add = document.createElement('div'); add.className = 'invadd';
    const nm = document.createElement('input'); nm.type = 'text'; nm.maxLength = 36; nm.placeholder = 'Add item'; nm.setAttribute('aria-label', 'New inventory item for ' + t.name);
    const qty = document.createElement('input'); qty.type = 'number'; qty.min = 1; qty.max = 999; qty.value = 1; qty.className = 'qtyin'; qty.setAttribute('aria-label', 'Quantity');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn tiny'; b.textContent = '+';
    const addIt = () => {
      const name = nm.value.trim(); if (!name) return;
      const n = Math.max(1, Math.min(999, Math.round(+qty.value || 1)));
      const found = t.inventory.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (found) found.qty = Math.min(999, found.qty + n); else t.inventory.push({ name: name.slice(0, 36), qty: n });
      nm.value = ''; qty.value = 1; commitInventory(t);
    };
    b.onclick = addIt; nm.onkeydown = e => { if (e.key === 'Enter') addIt(); };
    add.append(nm, qty, b); box.append(add);
  }
  return box;
}
function commitInventory(t) {
  t.inventory = normalizeInv(t.inventory);
  if (role === 'player') net && net.sendAction({ type: 'inventory', tokenId: t.id, inventory: t.inventory }).catch(() => {});
  else changed();
}
function useItem(t, idx) {
  const it = t.inventory[idx]; if (!it) return;
  if (role === 'player') {
    net && net.sendAction({ type: 'useItem', tokenId: t.id, name: it.name }).catch(() => {});
  } else {
    it.qty--; if (it.qty <= 0) t.inventory.splice(idx, 1);
    logEvent(`${t.name} uses ${it.name}.`); changed();
  }
}
function syncTokenImages() {
  const ids = new Set(tokens.map(t => t.id));
  for (const id of [...imgs.keys()]) if (!ids.has(id)) imgs.delete(id);
  for (const t of tokens) loadTokImg(t);
}
function loadTokImg(t) {
  if (!t.img) { imgs.delete(t.id); return; }
  const cur = imgs.get(t.id);
  if (cur && cur._mcSrc === t.img) return;   // same image already decoded
  const i = new Image();
  i._mcSrc = t.img;
  i.onload = () => {
    const tok = tokenById(t.id);
    if (!tok || tok.img !== t.img) return;   // token was removed or image changed again
    imgs.set(t.id, i); invalidate();
  };
  i.onerror = () => { if (imgs.get(t.id) === i) imgs.delete(t.id); };
  i.src = t.img;
}
$('#imgFile').addEventListener('change', e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || pendingImg == null) return;
  const id = pendingImg, fr = new FileReader();
  fr.onload = () => {
    const im = new Image();
    im.onload = () => {
      const t = tokenById(id); if (!t) return;
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const s = Math.min(im.width, im.height) || 1;
      c.getContext('2d').drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, 128, 128);
      t.img = c.toDataURL('image/webp', 0.82); loadTokImg(t); changed();
    };
    im.onerror = () => showMsg('That file could not be read as an image.');
    im.src = fr.result;
  };
  fr.readAsDataURL(f);
});
function removeToken(id) {
  if (role !== 'gm') return;
  tokens = tokens.filter(t => t.id !== id);
  imgs.delete(id); openStats.delete(id);
  roster.forEach(r => { if (r.tokenId === id) r.tokenId = null; });
  if (selected === id) selected = null;
  if (turn.activeId === id) { turn.activeId = null; turn.moved = {}; turn.attacked = {}; }
  changed();
}
function addToken(layer) {
  if (!map || role !== 'gm') return;
  if (layer === 'player' && tokens.filter(t => t.layer === 'player').length >= MAX_PLAYERS) { showMsg('The table is set for up to ' + MAX_PLAYERS + ' player tokens.'); return; }
  const r = cv.getBoundingClientRect(), size = +$('#newSize').value;
  const n = tokens.filter(t => t.layer === layer).length + 1;
  const name = $('#newName').value.trim() || (layer === 'gm' ? 'Hostile ' : 'Player ') + n;
  const stats = normalizeStats(null, layer, size);
  const derived = computeStats(stats);
  const t = { id: nextId++, layer, status: '', hp: derived.maxHp, maxHp: derived.maxHp, stats, weapon: '', name, color: $('#newColor').value, size, inventory: [], img: '', x: (r.width / 2 - view.x) / view.k, y: (r.height / 2 - view.y) / view.k };
  snapTok(t); tokens.push(t); selected = t.id; $('#newName').value = ''; changed();
}
$('#addPlayer').onclick = () => addToken('player'); $('#addGm').onclick = () => addToken('gm');

function renderSheet() {
  const sec = $('#sheetSec');
  if (sessionRole !== 'player') { sec.hidden = true; return; }
  sec.hidden = false;
  const body = $('#sheetBody'); body.textContent = '';
  const t = tokenById(me.tokenId);
  if (!t) {
    const p = document.createElement('div'); p.className = 'sub';
    p.textContent = 'You are spectating. The GM can assign you one of the player tokens.';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn tiny'; b.textContent = 'Ask the GM for a character';
    b.onclick = () => { net && net.sendAction({ type: 'requestSeat' }).catch(() => {}); showMsg('Asked the GM for a character.'); };
    body.append(p, b); return;
  }
  const head = document.createElement('div'); head.className = 'sheethead';
  const sw = document.createElement('span'); sw.className = 'swatch big'; sw.style.background = t.color;
  const nm = document.createElement('strong'); nm.textContent = t.name;
  head.append(sw, nm);
  if (settings.turnBased && turn.activeId === t.id) head.append(badge('YOUR TURN', 'turn'));
  body.append(head);
  const status = document.createElement('div'); status.className = 'sub'; status.textContent = 'HP ' + t.hp + ' / ' + t.maxHp + (t.status ? ' · ' + t.status : '');
  body.append(status);
  body.append(hpBlock(t, true, false));
  body.append(combatRow(t));
  body.append(statsBlock(t, false));
  const inv = document.createElement('div'); inv.className = 'invbox';
  const lab = document.createElement('div'); lab.className = 'invhead'; lab.append(Object.assign(document.createElement('span'), { textContent: 'Inventory' }));
  inv.append(lab, inventoryEditor(t, true)); body.append(inv);
  const hint = document.createElement('div'); hint.className = 'sub';
  hint.textContent = settings.turnBased ? (turn.activeId === t.id ? 'Your turn: drag, attack a hostile, click doors to ask for them, or use items.' : 'Wait for the GM to assign your turn.') : 'Free movement is on. Drag, attack, or use items when ready.';
  body.append(hint);
}

function renderRoster() {
  const sec = $('#sessionSec');
  if (sessionRole === 'solo') { sec.hidden = true; return; }
  sec.hidden = false;
  $('#roomLabel').textContent = roomCode || '—';
  $('#hostLine').textContent = sessionRole === 'host'
    ? (onlineCount() ? onlineCount() + ' player' + (onlineCount() === 1 ? '' : 's') + ' connected. Assign characters below.' : 'You are the GM. Share the invite so players can join.')
    : ('GM: ' + (hostName || '…') + (me.tokenId ? '' : ' · waiting to be assigned a character'));
  const box = $('#roster'); box.textContent = '';
  if (sessionRole === 'host') {
    if (!roster.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No players yet. Copy the invite link.'; box.append(e); }
    for (const r of roster) {
      const row = document.createElement('div'); row.className = 'rrow';
      const dot = document.createElement('span'); dot.className = 'dot' + (r.online ? ' on' : '');
      const nm = document.createElement('span'); nm.className = 'rname'; nm.textContent = r.name;
      const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Character for ' + r.name);
      const opt0 = document.createElement('option'); opt0.value = ''; opt0.textContent = 'Spectator'; sel.append(opt0);
      for (const t of tokens.filter(t => t.layer === 'player')) {
        const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; if (r.tokenId === t.id) o.selected = true; sel.append(o);
      }
      sel.onchange = () => assignSeat(r.clientId, sel.value ? +sel.value : null);
      const kick = document.createElement('button'); kick.type = 'button'; kick.className = 'mini x'; kick.textContent = '×'; kick.title = 'Remove player';
      kick.onclick = () => kickPlayer(r.clientId);
      row.append(dot, nm, sel, kick); box.append(row);
    }
  } else {
    const hostRow = document.createElement('div'); hostRow.className = 'rrow hostrow';
    const dot = document.createElement('span'); dot.className = 'dot' + (hostOnline ? ' on' : '');
    const nm = document.createElement('span'); nm.className = 'rname'; nm.textContent = (hostName || 'GM') + ' (GM)';
    hostRow.append(dot, nm); box.append(hostRow);
    for (const r of roster) {
      const row = document.createElement('div'); row.className = 'rrow' + (r.clientId === me.clientId ? ' me' : '');
      const dot = document.createElement('span'); dot.className = 'dot' + (r.online ? ' on' : '');
      const nm = document.createElement('span'); nm.className = 'rname'; nm.textContent = r.name + (r.clientId === me.clientId ? ' (you)' : '');
      const who = document.createElement('span'); who.className = 'muted tiny';
      const t = tokenById(r.tokenId); who.textContent = t ? t.name : 'spectator';
      row.append(dot, nm, who); box.append(row);
    }
  }
  updateConnUI();
}
function assignSeat(clientId, tokenId) {
  if (role !== 'gm') return;
  const member = roster.find(r => r.clientId === clientId); if (!member) return;
  roster.forEach(r => { if (r.clientId !== clientId && tokenId != null && r.tokenId === tokenId) r.tokenId = null; });
  member.tokenId = tokenId;
  const t = tokenById(tokenId);
  if (t) {
    if (/^Player \d+$/.test(t.name)) t.name = member.name;
    logEvent(`${member.name} now controls ${t.name}.`);
  } else logEvent(`${member.name} is now a spectator.`);
  changed();
}
function autoSeat(member) {
  if (member.tokenId && tokenById(member.tokenId)) return;
  let t = tokens.find(x => x.layer === 'player' && !roster.some(r => r.tokenId === x.id));
  if (!t && tokens.filter(x => x.layer === 'player').length < MAX_PLAYERS) {
    const n = tokens.filter(x => x.layer === 'player').length;
    const st = normalizeStats(null, 'player', 1), der = computeStats(st);
    t = { id: nextId++, layer: 'player', status: '', hp: der.maxHp, maxHp: der.maxHp, stats: st, weapon: 'knife', name: member.name, color: ['#3cc4b1', '#6aa6ff', '#f2a93b', '#c58bff', '#58d68a', '#ff8fa3'][n % 6], size: 1, inventory: [{ name: 'Medkit', qty: 1 }], img: '', x: 552 + (n % 2) * 34, y: 300 + Math.floor(n / 2) * 22 };
    snapTok(t); tokens.push(t); loadTokImg(t);
  }
  if (t) {
    roster.forEach(r => { if (r.clientId !== member.clientId && r.tokenId === t.id) r.tokenId = null; });
    member.tokenId = t.id;
    if (/^Player \d+$/.test(t.name)) t.name = member.name;
    logEvent(`${member.name} takes control of ${t.name}.`);
  } else {
    logEvent(`${member.name} joins as a spectator (no free character).`);
  }
}
function kickPlayer(clientId) {
  if (role !== 'gm') return;
  const member = roster.find(r => r.clientId === clientId); if (!member) return;
  roster = roster.filter(r => r.clientId !== clientId);
  if (member.tokenId) {
    const t = tokenById(member.tokenId);
    if (t && !FIXED_PLAYER_NAMES.has(t.name)) t.name = 'Player';
  }
  if (net) net.notify(clientId, 'You were removed from the table by the GM.');
  logEvent(`${member.name} was removed from the table.`);
  changed();
}
function renderTurnOrder() {
  const box = $('#turnOrder'); if (!box) return;
  box.textContent = '';
  if (!settings.turnBased) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Free movement is on.'; box.append(e); return; }
  if (!tokens.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No tokens.'; box.append(e); return; }
  for (const t of tokens) {
    const row = document.createElement('div'); row.className = 'turnrow' + (turn.activeId === t.id ? ' active' : '') + (isDown(t) ? ' down' : '');
    const nm = document.createElement('span'); nm.className = 'tname'; nm.textContent = t.name;
    const meta = document.createElement('span'); meta.className = 'mono muted';
    const moved = turn.moved[t.id] || 0;
    meta.textContent = (t.layer === 'gm' ? 'hostile' : 'player') + (turn.activeId === t.id && settings.moveLimit > 0 ? ` · ${fmt(moved)}/${fmt(settings.moveLimit)} sq` : '') + (settings.turnBased && turn.attacked && turn.attacked[t.id] ? ' · attacked' : '');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn tiny' + (turn.activeId === t.id ? ' primary' : '');
    b.textContent = turn.activeId === t.id ? 'Active' : 'Give turn'; b.disabled = isDown(t);
    b.onclick = () => assignTurn(t.id);
    row.append(nm, meta, b); box.append(row);
  }
}
function assignTurn(tokenId) {
  if (role !== 'gm') return;
  const t = tokenById(tokenId); if (!t) return;
  turn.number++; turn.activeId = tokenId; turn.moved = {}; turn.attacked = {}; selected = tokenId;
  logEvent(`Turn ${turn.number}: ${t.name}.`);
  changed();
}
function nextTurn(dir) {
  if (role !== 'gm' || !settings.turnBased) return;
  const alive = tokens.filter(t => !isDown(t));
  if (!alive.length) { showMsg('There is no one left to take a turn.'); return; }
  let idx = alive.findIndex(t => t.id === turn.activeId);
  if (idx < 0) idx = dir > 0 ? -1 : 0;
  const next = alive[(idx + dir + alive.length) % alive.length];
  turn.number++; turn.activeId = next.id; turn.moved = {}; turn.attacked = {}; selected = next.id;
  logEvent(`Turn ${turn.number}: ${next.name}.`);
  changed();
}

function renderLog() {
  const box = $('#log'); if (!box) return;
  box.textContent = '';
  if (!logRows.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Nothing yet.'; box.append(e); return; }
  for (const entry of logRows.slice(-70)) {
    const row = document.createElement('div'); row.className = 'logrow ' + (entry.kind || 'sys');
    const time = document.createElement('span'); time.className = 'logtime mono'; time.textContent = new Date(entry.t || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const txt = document.createElement('span'); txt.textContent = entry.text;
    row.append(time, txt); box.append(row);
  }
  box.scrollTop = box.scrollHeight;
}
function logEvent(text, kind = 'sys') {
  logRows.push({ id: Math.random().toString(36).slice(2), t: Date.now(), text: String(text).slice(0, kind === 'combat' ? 1200 : 300), kind });
  if (logRows.length > 90) logRows = logRows.slice(-90);
}
function updateTurnUI() {
  const active = tokenById(turn.activeId);
  const turnHost = role === 'gm';
  const pill = $('#turnPill'), phase = $('#phasePill');
  let label = '', cls = 'player';
  if (!settings.turnBased) { label = 'Free move'; cls = 'player'; }
  else if (!active) { label = turnHost ? 'Assign a turn' : 'Waiting for the GM'; cls = 'gm'; }
  else if (turnHost) { label = `${active.name}'s turn`; cls = active.layer === 'gm' ? 'gm' : 'player'; }
  else if (active.id === me.tokenId) { label = 'Your turn'; cls = 'player'; }
  else { label = `${active.name}'s turn`; cls = 'gm'; }
  pill.hidden = true; pill.textContent = label; pill.dataset.kind = cls;
  phase.hidden = false; phase.textContent = label; phase.dataset.phase = cls;
  $('#turnInfo').textContent = settings.turnBased ? `Turn ${turn.number}` : 'Free movement';
  $('#endTurn').hidden = role !== 'gm' || !settings.turnBased;
  $('#endTurn').disabled = !!anim;
  setHint(null);
}
function updateConnUI() {
  const el = $('#conn');
  if (sessionRole === 'solo') { el.hidden = true; return; }
  el.hidden = false;
  let state = 'live', text = '';
  if (netState === 'reconnecting') { state = 'reconnecting'; text = 'Reconnecting…'; }
  else if (netState === 'offline') { state = 'offline'; text = 'Offline'; }
  else if (sessionRole === 'host') { text = 'Live · ' + onlineCount() + ' player' + (onlineCount() === 1 ? '' : 's'); }
  else if (!hostOnline) { state = 'offline'; text = 'GM offline'; }
  else { text = 'Live · ' + (hostName || 'GM'); }
  el.dataset.state = state;
  $('#connText').textContent = text;
}
function setConnState(state, text) {
  const el = $('#conn');
  el.hidden = sessionRole === 'solo';
  el.dataset.state = state;
  $('#connText').textContent = text || state;
}

/* ---------- table actions ---------- */
function requestDoor(d) {
  if (!net) return;
  net.sendAction({ type: 'requestDoor', door: d.name, open: !d.open }).catch(() => {});
  showMsg(`Asked the GM to ${d.open ? 'close' : 'open'} ${d.name}.`);
}
function sendChat() {
  const inp = $('#chatInput'); const text = inp.value.trim(); if (!text) return;
  inp.value = '';
  if (sessionRole === 'player') { net && net.sendAction({ type: 'chat', text }).catch(() => {}); }
  else { logEvent(`${me.name || 'GM'}: ${text}`, 'chat'); changed(); }
}
$('#copyInvite').onclick = async () => {
  if (!roomCode) return;
  const url = location.origin + location.pathname + '#room=' + roomCode;
  try { await navigator.clipboard.writeText(url); showMsg('Invite copied: ' + roomCode); }
  catch (e) { window.prompt('Copy this invite link', url); }
};
$('#chatSend').onclick = sendChat;
$('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

/* ---------- live session ---------- */
const rate = new Map();
function rateAllowed(clientId) {
  const now = Date.now(), r = rate.get(clientId) || { t: now, n: 0 };
  if (now - r.t > 1000) { r.t = now; r.n = 0; }
  r.n++; rate.set(clientId, r);
  return r.n <= 30;
}
function handleAction(msg) {
  if (sessionRole !== 'host' || !msg || !msg.action) return;
  const action = msg.action, clientId = String(msg.clientId || '');
  if (!clientId || !rateAllowed(clientId)) return;
  let member = roster.find(r => r.clientId === clientId);
  const now = Date.now();
  if (action.type === 'join') {
    const name = sanitizeName(action.name || msg.name, 'Player');
    if (member) {
      const wasOffline = !member.online;
      member.name = name; member.online = true; member.lastSeen = now;
      if (wasOffline) logEvent(`${name} reconnected.`);
      autoSeat(member);
      if (!wasOffline && member.tokenId) { /* already seated */ }
    } else {
      if (roster.length >= 16) { net.notify(clientId, 'The table is full.'); return; }
      member = { clientId, name, tokenId: null, online: true, lastSeen: now, joinedAt: now };
      roster.push(member);
      logEvent(`${name} joined the table.`);
      autoSeat(member);
    }
    net.updateMeta({ online: true, clients: onlineCount() });
    changed(); return;
  }
  if (!member) { net.notify(clientId, 'You are not on this table’s roster. Rejoin with the code.'); return; }
  const wasOffline = !member.online;
  member.online = true; member.lastSeen = now;
  if (wasOffline) { logEvent(`${member.name} reconnected.`); }
  const own = member.tokenId != null ? tokenById(member.tokenId) : null;
  switch (action.type) {
    case 'ping': {
      if (wasOffline) { net.updateMeta({ clients: onlineCount() }); changed(); }
      return;
    }
    case 'leave': {
      member.online = false; member.lastSeen = 0;
      logEvent(`${member.name} left the table.`);
      net.updateMeta({ clients: onlineCount() }); changed(); return;
    }
    case 'requestSeat': {
      logEvent(`${member.name} asks for a character.`);
      net.notify(clientId, 'The GM has been asked to assign you a character.');
      showMsg(`${member.name} asks for a character.`);
      changed(); return;
    }
    case 'requestDoor': {
      const name = String(action.door || 'a door').slice(0, 40);
      const verb = action.open === false ? 'close' : 'open';
      logEvent(`${member.name} asks the GM to ${verb} ${name}.`);
      net.notify(clientId, 'Your door request was sent to the GM.');
      showMsg(`${member.name} asks the GM to ${verb} ${name}.`);
      changed(); return;
    }
    case 'chat': {
      const text = String(action.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
      if (text) { logEvent(`${member.name}: ${text}`, 'chat'); changed(); }
      return;
    }
    case 'move': {
      if (!own || action.tokenId !== own.id) { net.notify(clientId, 'You can only move your own character.'); return; }
      if (settings.turnBased && turn.activeId !== own.id) { net.notify(clientId, 'It is not your turn yet.'); scheduleSync(); return; }
      if (isDown(own)) { net.notify(clientId, 'Your character is down.'); return; }
      const targetX = +action.x, targetY = +action.y;
      if (!isFinite(targetX) || !isFinite(targetY)) return;
      const sx = own.x, sy = own.y;
      const p = computeMove(own, targetX, targetY, false);
      let nx = p.x, ny = p.y;
      if (settings.snap) { const tmp = { size: own.size, x: nx, y: ny }; snapTok(tmp); if (!blockedMove(nx, ny, tmp.x, tmp.y)) { nx = tmp.x; ny = tmp.y; } }
      const dist = Math.hypot(nx - sx, ny - sy) / map.ppg;
      if (settings.turnBased && settings.moveLimit > 0) {
        const used = turn.moved[own.id] || 0;
        if (used + dist > settings.moveLimit + 1e-6) {
          net.notify(clientId, `That would use ${fmt(used + dist)} squares; only ${fmt(settings.moveLimit)} are allowed this turn.`);
          scheduleSync(); return;
        }
      }
      if (Math.hypot(nx - sx, ny - sy) < 0.5) { net.notify(clientId, 'That move is blocked.'); scheduleSync(); return; }
      own.x = nx; own.y = ny;
      if (settings.turnBased) turn.moved[own.id] = (turn.moved[own.id] || 0) + dist;
      fogDirty = true; changed(); return;
    }
    case 'hp': {
      if (!own || action.tokenId !== own.id) { net.notify(clientId, 'You can only change your own HP.'); return; }
      const v = Math.max(0, Math.min(own.maxHp, Math.round(+action.hp || 0)));
      setHp(own, v); changed(); return;
    }
    case 'inventory': {
      if (!own || action.tokenId !== own.id) { net.notify(clientId, 'You can only change your own inventory.'); return; }
      own.inventory = normalizeInv(action.inventory); changed(); return;
    }
    case 'useItem': {
      if (!own || action.tokenId !== own.id) { net.notify(clientId, 'You can only use your own items.'); return; }
      const it = own.inventory.find(x => x.name === String(action.name || ''));
      if (!it) return;
      it.qty--; if (it.qty <= 0) own.inventory = own.inventory.filter(x => x !== it);
      logEvent(`${member.name} uses ${it.name}.`); changed(); return;
    }
    case 'attack': {
      if (!own || +action.attackerId !== own.id) { net.notify(clientId, 'You can only attack with your own character.'); return; }
      const target = tokenById(+action.targetId);
      if (!target || target.layer !== 'gm') { net.notify(clientId, 'Choose a hostile target.'); return; }
      if (!MOVE_LABEL[action.move]) { net.notify(clientId, 'Choose Strike, Grapple or Counter.'); return; }
      const result = performAttack(own.id, target.id, action.move, 'auto', true);
      if (result.error) { net.notify(clientId, result.error); scheduleSync(); return; }
      const b = tokenById(target.id);
      net.notify(clientId, `${own.name} attacks ${b ? b.name : 'the target'} — ${b ? b.hp + '/' + b.maxHp : '?'} HP left.`);
      return;
    }
    default: return;
  }
}

function handleMeta(meta) {
  if (sessionRole !== 'player') return;
  hostName = meta.host || hostName;
  const age = Date.now() - (+meta.ts || 0);
  hostOnline = !!meta.online && age < (CFG.hostTimeoutMs || 32000);
  updateConnUI();
  if (!hostOnline) setConnState('offline', 'GM offline');
}
function handleNetStatus(state) {
  netState = state;
  updateConnUI();
}
function checkHostPresence() {
  if (sessionRole !== 'player' || !net) return;
  const meta = net.lastMeta;
  if (!meta) return;
  const online = !!meta.online && Date.now() - (+meta.ts || 0) < (CFG.hostTimeoutMs || 32000);
  if (online !== hostOnline) { hostOnline = online; updateConnUI(); if (!online) showMsg('The GM went offline. The table is paused.'); }
}
setInterval(checkHostPresence, 4000);
setInterval(() => {
  if (sessionRole !== 'host') return;
  const cutoff = Date.now() - (CFG.hostTimeoutMs || 32000);
  let dirty = false;
  for (const r of roster) if (r.online && r.lastSeen < cutoff) { r.online = false; logEvent(`${r.name} disconnected.`); dirty = true; }
  if (dirty) { net && net.updateMeta({ clients: onlineCount() }); changed(); }
}, 5000);

/* ---------- solo persistence ---------- */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (sessionRole === 'solo' && map && map.key === 'cortez') saveSolo();
    else if (sessionRole === 'host') saveHostCheckpoint();
  }, 450);
}
function saveSolo() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(makeSnapshot())); } catch (e) { showMsg('Could not save in this browser (storage full). Smaller token images help.'); }
}
function saveHostCheckpoint() {
  if (sessionRole !== 'host' || !map || map.key !== 'cortez') return;
  try { localStorage.setItem(HOST_SAVE_KEY, JSON.stringify({ room: roomCode, name: me.name, snapshot: makeSnapshot(), ts: Date.now() })); } catch (e) {}
}
function readSaved(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
function loadSoloSave() {
  const s = readSaved(STORE_KEY);
  if (!s || s.mapKey !== 'cortez' || !Array.isArray(s.tokens)) return false;
  applySnapshot(s, true);
  if (s.settings && Array.isArray(s.roster)) { /* applied */ }
  return true;
}
function loadHostCheckpoint() {
  const s = readSaved(HOST_SAVE_KEY);
  if (!s || !s.room || !s.snapshot || s.snapshot.mapKey !== 'cortez' || !normalizeRoom(s.room)) return null;
  return s;
}

/* ---------- enter / leave ---------- */
function enterGame() {
  $('#boot').hidden = true;
  $('#app').hidden = false;
  $('#app').dataset.role = role;
  $('#sessionSec').hidden = sessionRole === 'solo';
  $('#btnLeave').hidden = sessionRole === 'solo';
  $('#fileLabel').hidden = sessionRole !== 'solo';
  bootStatus('');
  $('#btnLeave2').hidden = false;
  syncSettingsUI(); renderAll();
  requestAnimationFrame(() => { fitView(); invalidate(); });
}
function leaveToBoot() {
  $('#app').hidden = true; $('#boot').hidden = false;
  $('#bootStatus').textContent = ''; $('#bootStatus').dataset.kind = '';
  $('#joinRow').hidden = true;
  $('#btnResume').hidden = true;
  history.replaceState(null, '', location.pathname + location.search);
  checkResumeAvailability();
}
function leaveSession() {
  if (busy) return;
  if (sessionRole === 'host' && !confirm('End this live session? Players will be disconnected.')) return;
  busy = true;
  try { if (net) net.disconnect(); } catch (e) {}
  net = null; sessionRole = 'solo'; role = 'gm'; roomCode = ''; roster = []; hostOnline = true; netState = 'live';
  $('#conn').hidden = true;
  leaveToBoot();
  busy = false;
}
$('#btnLeave').onclick = leaveSession;
$('#btnLeave2').onclick = leaveSession;

function checkResumeAvailability() {
  const saved = loadHostCheckpoint();
  const b = $('#btnResume');
  if (saved) { b.hidden = false; b.textContent = `Resume hosted session ${saved.room}`; }
  else b.hidden = true;
}

/* ---------- start screen ---------- */
function setBusy(v, text) {
  busy = v;
  for (const id of ['#btnHost', '#btnJoin', '#btnJoinGo', '#btnSolo', '#btnResume']) $(id).disabled = v;
  if (text) bootStatus(text);
}
function pickName() {
  const v = sanitizeName($('#playerName').value, '');
  if (v) { try { localStorage.setItem('cortez-player-name', v); } catch (e) {} }
  return v;
}
async function ensureMap() {
  if (map) return;
  bootStatus('Loading the Cortez deck plan…');
  await loadBuiltin();
}

async function startHost(resume) {
  if (busy) return;
  if (!(window.crypto && crypto.subtle)) { bootStatus('Live sync needs a secure page (HTTPS or localhost).', 'err'); return; }
  const name = pickName() || 'GM';
  setBusy(true, 'Opening a live session…');
  try {
    await ensureMap();
    if (!resume) { resetToDefaults(); rev = 0; }
    sessionRole = 'host'; role = 'gm'; me.name = name; hostName = name; netState = 'live';
    roomCode = resume ? normalizeRoom(resume.room) : makeRoomCode();
    if (resume) {
      applySnapshot(resume.snapshot, true);
      roster = (resume.snapshot.roster || []).map(r => Object.assign({}, r, { online: false, lastSeen: 0 }));
      logRows = Array.isArray(resume.snapshot.log) ? resume.snapshot.log.slice(-70) : [];
      renderAll();
    }
    net = new LiveSession({
      role: 'host', room: roomKeyOf(roomCode), clientId: me.clientId, name,
      onState: () => {}, onMeta: () => {}, onAction: handleAction,
      onNotice: () => {}, onStatus: handleNetStatus,
      onHostState: () => {}
    });
    await net.connect();
    enterGame();
    logEvent(resume ? `Session ${roomCode} resumed.` : `Session ${roomCode} opened. Share the invite link.`);
    scheduleSync();
    history.replaceState(null, '', location.pathname + location.search + '#host=' + roomCode);
    setBusy(false);
  } catch (err) {
    try { if (net) net.disconnect(false); } catch (e) {}
    net = null; sessionRole = 'solo'; role = 'gm';
    setBusy(false);
    bootStatus(err.message || 'Could not open the session.', 'err');
  }
}

async function startPlayer(code) {
  if (busy) return;
  const room = normalizeRoom(code);
  if (!room) { bootStatus('That code does not look right. Use the ABC-DEF-GHJ format.', 'err'); return; }
  const name = pickName() || 'Player';
  if (!(window.crypto && crypto.subtle)) { bootStatus('Live sync needs a secure page (HTTPS or localhost).', 'err'); return; }
  setBusy(true, 'Connecting to the table…');
  try {
    await ensureMap();
    sessionRole = 'player'; role = 'player'; me.name = name; roomCode = room; hostOnline = true; netState = 'live';
    net = new LiveSession({
      role: 'player', room: roomKeyOf(room), clientId: me.clientId, name,
      onState: s => applySnapshot(s), onMeta: handleMeta, onAction: () => {},
      onNotice: text => showMsg(text), onStatus: handleNetStatus
    });
    await net.connect();
    const meta = await net.waitForMeta(6500);
    if (!meta) throw new Error('No live session found for ' + room + '. Check the code and that the GM has the table open.');
    if (!meta.online || Date.now() - (+meta.ts || 0) > (CFG.hostTimeoutMs || 32000)) throw new Error('The GM is offline for ' + room + '. Ask them to reopen the table.');
    hostName = sanitizeName(meta.host, 'GM'); hostOnline = true;
    history.replaceState(null, '', location.pathname + location.search + '#room=' + room);
    enterGame();
    updateConnUI();
    setBusy(false);
  } catch (err) {
    try { if (net) net.disconnect(false); } catch (e) {}
    net = null; sessionRole = 'solo'; role = 'gm'; roomCode = '';
    setBusy(false);
    bootStatus(err.message || 'Could not join the session.', 'err');
  }
}

async function startSolo() {
  if (busy) return;
  const name = pickName() || 'GM';
  setBusy(true, 'Opening the table…');
  try {
    await ensureMap();
    resetToDefaults(); rev = 0;
    sessionRole = 'solo'; role = 'gm'; me.name = name; hostName = name; roomCode = '';
    const restored = loadSoloSave();
    if (!restored) logEvent('Solo session started. You are the GM.');
    history.replaceState(null, '', location.pathname + location.search);
    enterGame();
    setBusy(false);
  } catch (err) {
    setBusy(false);
    bootStatus(err.message || 'Could not load the map.', 'err');
  }
}

$('#btnHost').onclick = () => startHost(null);
$('#btnJoin').onclick = () => {
  const row = $('#joinRow');
  if (row.hidden) {
    row.hidden = false;
    const hashRoom = roomFromHash();
    if (hashRoom) $('#roomCode').value = hashRoom;
  }
  $('#roomCode').focus();
};
$('#btnJoinGo').onclick = () => startPlayer($('#roomCode').value);
$('#roomCode').addEventListener('keydown', e => { if (e.key === 'Enter') startPlayer($('#roomCode').value); });
$('#btnSolo').onclick = startSolo;
$('#btnResume').onclick = () => { const saved = loadHostCheckpoint(); if (saved) startHost(saved); };
$('#playerName').addEventListener('keydown', e => { if (e.key === 'Enter' && $('#joinRow').hidden) startHost(null); });

function roomFromHash() {
  const m = location.hash.match(/(?:room|host)=([A-Za-z0-9-]{9,14})/);
  return m ? normalizeRoom(m[1]) : '';
}

/* ---------- boot ---------- */
$('#darkOut').textContent = '88%'; $('#lscaleOut').textContent = '×2.4'; $('#sightOut').textContent = '40 sq';
try { $('#playerName').value = localStorage.getItem('cortez-player-name') || ''; } catch (e) {}
const hashRoom = roomFromHash();
if (hashRoom && !location.hash.startsWith('#host=')) {
  $('#joinRow').hidden = false;
  $('#roomCode').value = hashRoom;
  setTimeout(() => $('#playerName').focus(), 100);
}
checkResumeAvailability();
setHint(null);

const bootMapPromise = loadBuiltin().catch(err => {
  bootStatus(err.message || 'Could not load the map.', 'err');
});
window.__cortez = {
  get map() { return map; }, get tokens() { return tokens; }, get settings() { return settings; },
  get turn() { return turn; }, get role() { return role; }, get sessionRole() { return sessionRole; },
  get roster() { return roster; }, get log() { return logRows; }, get view() { return view; }, get doors() { return map ? map.doors.map(d => ({ name: d.name, open: d.open })) : []; }, get me() { return me; }
};

window.addEventListener('pagehide', () => { try { if (net) net.disconnect(); } catch (e) {} });
window.addEventListener('beforeunload', () => { try { if (net) net.disconnect(); } catch (e) {} });

})();
