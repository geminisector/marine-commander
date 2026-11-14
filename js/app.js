/* Marine Commander — game client.
 * Host-authoritative state, rendered from snapshots. Solo mode uses localStorage.
 */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const CFG = window.MC_CONFIG || {};
const MAX_PLAYERS = CFG.maxPlayers || 8;
const STORE_KEY = 'marine-commander-solo-v4';
const HOST_SAVE_KEY = 'marine-commander-host-save-v4';
const CLIENT_KEY = 'marine-commander-client-id';
const PLAYER_NAME_KEY = 'marine-commander-player-name';
const LEGACY_KEYS = [
  ['cortez-solo-v4', STORE_KEY, 'local'],
  ['cortez-host-save-v4', HOST_SAVE_KEY, 'local'],
  ['cortez-player-name', PLAYER_NAME_KEY, 'local'],
  ['cortez-client-id', CLIENT_KEY, 'session']
];
const APP_NAME = 'Marine Commander';
const FALLBACK_MAP = { id: 'cortez', name: 'Cortez', subtitle: 'Deck plan', scene: CFG.mapUrl || 'assets/maps/cortez.scene.json', ppg: 16 };
const MAPS = (Array.isArray(CFG.maps) && CFG.maps.length ? CFG.maps : [FALLBACK_MAP])
  .filter(m => m && typeof m.id === 'string' && m.id)
  .map(m => Object.assign({ ppg: 16 }, m));
const MAP_BY_ID = new Map(MAPS.map(m => [m.id, m]));
const DEFAULT_MAP_ID = MAP_BY_ID.has(CFG.defaultMapId) ? CFG.defaultMapId : MAPS[0].id;
const mapLabel = m => m ? (m.name + (m.subtitle ? ' · ' + m.subtitle : '')) : 'Map';
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

migrateLegacyKeys();

let map = null, tokens = [], nextId = 1;
const mapStates = new Map();       // map id -> { doors: bool[], lights: force[] }
let snapshotLoading = false, pendingSnapshot = null;
let view = { x: 0, y: 0, k: 1 }, fitted = false;
let tool = 'move', selected = null, hoverTok = null, hoverDoor = null, hoverStair = null;
let ruler = null, ftPer = 5, unit = 'ft';
const layers = { rooms: { vis: true, lock: false }, light: { vis: true, lock: false }, gm: { vis: true, lock: false }, player: { vis: true, lock: false } };
const settings = { mode: 'auto', dark: 0.88, scale: 2.4, snap: true, peek: true, fog: true, explore: true, sight: 40, preview: false, gmPass: true, showStatus: false, showHp: true, turnBased: true, moveLimit: 0 };
let needDraw = true, lightDirty = true, fogDirty = true;

let sessionRole = 'solo';           // solo | host | player
let role = 'gm';                    // gm | player
let setupPhase = false;
let net = null, roomCode = '', hostName = '', hostOnline = true, netState = 'live';
let me = { clientId: getClientId(), name: '', tokenId: null };
let roster = [], logRows = [], rev = 0;
let mission = newMission();
let missionDamageCtx = null;
let turn = { number: 1, activeId: null, moved: {}, attacked: {} };
let anim = null;                    // unused animation slot kept for scene resets
let syncTimer = 0, saveTimer = 0, msgTimer = 0;
let pendingImg = null;
let combatCtx = null, combatChosenMove = 'strike';
const pendingDefense = new Map();    // host: requestId -> { clientId, attackerId, targetId, move, timer }
let incomingDefense = null;          // player: { requestId, move }
const DEFENSE_TIMEOUT_MS = 30000;
const pendingPlayerAttacks = new Map(); // host: requestId -> { id, clientId, attackerId, targetId, move, reaction, queuedAt }
let pendingAttacks = [];                // player: snapshot copy of the attack queue
let hostRequests = [], currentRequest = null; // host: player door/light requests
const openStats = new Set();
let busy = false;
let gmUnlocked = false, pendingHostAction = null;

const pointers = new Map();
let drag = null, pinch = null;

/* ---------- small helpers ---------- */
function migrateLegacyKeys() {
  try {
    for (const [from, to, area] of LEGACY_KEYS) {
      const store = area === 'session' ? sessionStorage : localStorage;
      const oldValue = store.getItem(from);
      if (oldValue != null && store.getItem(to) == null) store.setItem(to, oldValue);
    }
  } catch (e) { /* storage can be blocked; the new keys still work in memory */ }
}
function getClientId() {
  try {
    let id = sessionStorage.getItem(CLIENT_KEY);
    if (!/^[a-f0-9]{16,32}$/.test(id || '')) {
      id = window.MarineCommanderNet ? MarineCommanderNet.randomId(12) : Math.random().toString(16).slice(2).padEnd(24, '0');
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
const onLevel = t => !!t && (!map || !t.mapKey || t.mapKey === map.key);
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
const HUMAN_TOKENS = 'assets/tokens/human/';
const KILRATHI_TOKENS = 'assets/tokens/kilrathi/';
const HOSTILE_PRESETS = Object.freeze({
  Pilot:    { color: '#e5604f', stats: { melee: 5, martialArts: 2, dance: 0, athletic: 4 }, weapon: 'laser',   img: 'pilot.png',     inv: [{ name: 'Laser cell', qty: 2 }] },
  Grunt:    { color: '#c0392b', stats: { melee: 8, martialArts: 3, dance: 0, athletic: 6 }, weapon: 'rifle',   img: 'grunt.png',     inv: [{ name: 'Rifle magazine', qty: 2 }, { name: 'Frag grenade', qty: 1 }] },
  Navigator:{ color: '#ef7d4f', stats: { melee: 4, martialArts: 1, dance: 0, athletic: 3 }, weapon: 'knife',   img: 'navigator.png', inv: [{ name: 'Datapad', qty: 1 }] },
  Medic:    { color: '#d9534f', stats: { melee: 3, martialArts: 4, dance: 0, athletic: 4 }, weapon: 'stunrod', img: 'medic.png',     inv: [{ name: 'Medkit', qty: 2 }] },
  Engineer: { color: '#a93226', stats: { melee: 6, martialArts: 2, dance: 0, athletic: 5 }, weapon: 'club',    img: 'engineer.png',  inv: [{ name: 'Tool kit', qty: 1 }, { name: 'Frag grenade', qty: 1 }] },

  KCaptain:    { name: 'Kal Shintar Kalra',   label: 'Kilrathi Captain · Kal Shintar Kalra',       color: '#b06be0', stats: { melee: 9,  martialArts: 3, dance: 0, athletic: 9  }, weapon: 'laser',      dir: KILRATHI_TOKENS, img: 'kcaptain.png',   inv: [{ name: 'Laser cell', qty: 2 }, { name: 'Medkit', qty: 1 }] },
  KOfficer:    { name: 'Dejjar',              label: 'Kilrathi Officer · Dejjar',                  color: '#8e6bd8', stats: { melee: 8,  martialArts: 4, dance: 0, athletic: 8  }, weapon: 'laser',      dir: KILRATHI_TOKENS, img: 'kofficer.png',   inv: [{ name: 'Laser cell', qty: 2 }] },
  KNavigator:  { name: 'First Fang Bhurj',    label: 'Kilrathi Navigator · First Fang Bhurj',      color: '#e67e22', stats: { melee: 7,  martialArts: 3, dance: 0, athletic: 8  }, weapon: 'knife',      dir: KILRATHI_TOKENS, img: 'knavigator.png', inv: [{ name: 'Datapad', qty: 1 }, { name: 'Laser cell', qty: 2 }] },
  KConscript:  { name: 'Least Claw Bhurj',    label: 'Kilrathi Conscript · Least Claw Bhurj',      color: '#95a5a6', stats: { melee: 7,  martialArts: 2, dance: 0, athletic: 9  }, weapon: 'laser',      dir: KILRATHI_TOKENS, img: 'kconscript.png',     inv: [{ name: 'Laser cell', qty: 2 }] },
  KMedic:      { name: "First Fang Ga'Ree",   label: "Kilrathi Medic · First Fang Ga'Ree",         color: '#d9534f', stats: { melee: 4,  martialArts: 2, dance: 0, athletic: 6  }, weapon: 'stunrod',    dir: KILRATHI_TOKENS, img: 'kmedic.png',     inv: [{ name: 'Medkit', qty: 2 }] },
  KSoldier:    { name: 'Third Claw Jorn',     label: 'Kilrathi Soldier · Third Claw Jorn',         color: '#e5604f', stats: { melee: 10, martialArts: 4, dance: 0, athletic: 12 }, weapon: 'laser_rifle', dir: KILRATHI_TOKENS, img: 'kgrunt.jpg',    inv: [{ name: 'Laser cell', qty: 2 }, { name: 'Frag grenade', qty: 1 }] },
  KCommOfficer:{ name: 'Second Fang Kalluss', label: 'Kilrathi Comm Officer · Second Fang Kalluss', color: '#16a085', stats: { melee: 3,  martialArts: 2, dance: 0, athletic: 6  }, weapon: 'laser',      dir: KILRATHI_TOKENS, img: 'kpilot.png',     inv: [{ name: 'Laser cell', qty: 2 }, { name: 'Datapad', qty: 1 }] },
  KTerrorist:  { name: "Second Claw L'urr",   label: "Kilrathi Terrorist · Second Claw L'urr",      color: '#d35400', stats: { melee: 7,  martialArts: 3, dance: 0, athletic: 8  }, weapon: 'laser',      dir: KILRATHI_TOKENS, img: 'kterrorist.png', inv: [{ name: 'Laser cell', qty: 2 }, { name: 'Frag grenade', qty: 3 }] },
  KScience:    { name: 'Kilrathi Scientist',  label: 'Kilrathi Scientist',                         color: '#5dade2', stats: { melee: 2,  martialArts: 1, dance: 0, athletic: 5  }, weapon: 'laser',      dir: KILRATHI_TOKENS, img: 'kscience.png',   inv: [{ name: 'Laser cell', qty: 1 }, { name: 'Datapad', qty: 1 }, { name: 'Medkit', qty: 1 }] }
});
const HOSTILE_ROLES = Object.keys(HOSTILE_PRESETS);
const cloneInventory = inv => (inv || []).map(x => ({ name: x.name, qty: x.qty }));
const MOVES = { strike: 'grapple', grapple: 'counter', counter: 'strike' };
const WIN_MOVES = { strike: 'counter', grapple: 'strike', counter: 'grapple' };
const MOVE_LABEL = { strike: 'Strike', grapple: 'Grapple', counter: 'Counter' };
const FORCE_MOVES = { win: 'Win', lose: 'Lose' };
const WIN_PAIRS = [['strike', 'grapple'], ['grapple', 'counter'], ['counter', 'strike']];
const LOSE_PAIRS = [['strike', 'counter'], ['grapple', 'strike'], ['counter', 'grapple']];
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
function rangedAutoLoss(a, b) {
  if (!a || !b || !map) return false;
  if (weaponOf(a).type !== 'ranged' || weaponOf(b).type === 'ranged') return false;
  const d = Math.hypot(a.x - b.x, a.y - b.y) / map.ppg;
  const reach = (a.size + b.size) / 2 + 0.5;
  return d > reach + 1e-6;
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
  const mapKey = typeof t.mapKey === 'string' && t.mapKey ? t.mapKey : (map ? map.key : DEFAULT_MAP_ID);
  return {
    id: +t.id, layer, mapKey, name: String(t.name || 'Token').slice(0, 40),
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
function loadMap(d, key, base, meta) {
  return new Promise((resolve, reject) => {
    if (!d || !d.resolution || !d.image) return reject(new Error('This file is not a Universal VTT map (missing resolution or image).'));
    const img = new Image();
    img.onload = () => { try { build(d, img, key, meta); resolve(); } catch (e) { reject(e); } };
    img.onerror = () => reject(new Error('The map image could not be decoded.'));
    img.src = imageSource(d, base);
  });
}
function cacheCurrentMapState() {
  if (!map) return;
  mapStates.set(map.key, {
    doors: map.doors.map(d => !!d.open),
    lights: map.lights.map(l => l.force)
  });
}
function applyMapStateToCurrent() {
  if (!map) return;
  const st = mapStates.get(map.key);
  if (!st) { cacheCurrentMapState(); return; }
  (st.doors || []).forEach((o, i) => { if (map.doors[i]) map.doors[i].open = !!o; });
  (st.lights || []).forEach((f, i) => { if (map.lights[i]) map.lights[i].force = f; });
}
function allMapStates() {
  cacheCurrentMapState();
  const out = {};
  for (const [id, st] of mapStates) if (MAP_BY_ID.has(id)) out[id] = st;
  return out;
}
function restoreMapStates(raw) {
  if (!raw || typeof raw !== 'object') return;
  for (const [id, st] of Object.entries(raw)) {
    if (!MAP_BY_ID.has(id) || !st || typeof st !== 'object') continue;
    mapStates.set(id, {
      doors: Array.isArray(st.doors) ? st.doors.map(Boolean) : [],
      lights: Array.isArray(st.lights) ? st.lights.slice() : []
    });
  }
  applyMapStateToCurrent();
}
async function loadMapById(id) {
  const meta = MAP_BY_ID.get(id);
  if (!meta) throw new Error('Unknown map "' + id + '".');
  if (map && map.key === id) return map;
  const url = meta.scene || (id === 'cortez' ? CFG.mapUrl : '');
  if (!url) throw new Error('No scene file is configured for ' + mapLabel(meta) + '.');
  const abs = new URL(url, location.href).href;
  const res = await fetch(abs, { cache: 'force-cache' });
  if (!res.ok) throw new Error('Could not load ' + mapLabel(meta) + ' (' + res.status + ').');
  const d = await res.json();
  cacheCurrentMapState();
  await loadMap(d, id, abs, meta);
  return map;
}
async function loadDefaultMap() {
  const id = MAP_BY_ID.has(map && map.key) ? map.key : DEFAULT_MAP_ID;
  await loadMapById(id);
}

function build(d, img, key, meta) {
  const ppg = d.resolution.pixels_per_grid || (meta && meta.ppg) || 50;
  const P = p => ({ x: p.x * ppg, y: p.y * ppg });
  const walls = [];
  for (const poly of [...(d.line_of_sight || []), ...(d.objects_line_of_sight || [])])
    for (let i = 0; i < poly.length - 1; i++) { const a = P(poly[i]), b = P(poly[i + 1]); walls.push([a.x, a.y, b.x, b.y]); }
  const doors = (d.portals || []).map((p, i) => ({ idx: i, a: P(p.bounds[0]), b: P(p.bounds[1]), open: !p.closed, name: (key === 'cortez' && DOOR_NAMES[i]) || ('Door ' + (i + 1)), regs: [] }));
  const lights = (d.lights || []).map((l, i) => ({ idx: i, x: l.position.x * ppg, y: l.position.y * ppg, r: l.range * ppg, rgb: parseColor(l.color), force: null, region: 0, on: false }));
  const stairs = ((meta && meta.stairs) || []).map(s => Object.assign({}, s, {
    gx: +s.x, gy: +s.y, x: (+s.x) * ppg, y: (+s.y) * ppg
  }));
  if (MAP_BY_ID.has(key)) mission.maps.add(key);
  map = {
    img, W: img.naturalWidth, H: img.naturalHeight, ppg, walls, doors, lights, stairs, blockers: [],
    key, name: meta ? mapLabel(meta) : (key === 'cortez' ? 'Cortez · Deck plan' : 'Loaded map'),
    group: meta && meta.group || '', level: meta && meta.level || ''
  };
  dark.width = tint.width = fog.width = expl.width = map.W;
  dark.height = tint.height = fog.height = expl.height = map.H;
  eg.clearRect(0, 0, map.W, map.H);
  imgs.clear(); openStats.clear(); selected = null; ruler = null;
  if (!mapStates.has(key) && key === 'cortez') doors.forEach((dr, i) => { dr.open = DEFAULT_OPEN.includes(i); });
  applyMapStateToCurrent();
  computeRegions();
  rebuildBlockers();
  $('#mapinfo').textContent = `${map.name} · ${Math.round(map.W / ppg)}×${Math.round(map.H / ppg)} squares · ${doors.length} doors · ${lights.length} lights`;
  syncMapSelect();
  syncTokenImages();
  renderAll(); updateDoorCount(); lightDirty = true; fogDirty = true;
  requestAnimationFrame(() => { fitView(); invalidate(); });
}

function resetToDefaults() {
  resetMission();
  clearPendingPlayerAttacks();
  if (!map) return;
  mapStates.clear();
  map.doors.forEach((d, i) => { d.open = map.key === 'cortez' ? DEFAULT_OPEN.includes(i) : false; });
  map.lights.forEach(l => { l.force = null; });
  cacheCurrentMapState();
  nextId = 1; turn = { number: 1, activeId: null, moved: {}, attacked: {} }; anim = null;
  imgs.clear();
  tokens = map.key === 'cortez' ? defaultTokens() : [];
  syncTokenImages();
  roster = []; logRows = []; selected = null; ruler = null;
  clearExplored(); rebuildBlockers(); lightDirty = true; fogDirty = true;
  updateDoorCount(); renderAll(); invalidate();
}

async function loadCustomMap(d) {
  cacheCurrentMapState();
  await loadMap(d, 'custom', location.href, { name: 'Custom map' });
  resetMission();
  mapStates.clear();
  tokens = []; nextId = 1; turn = { number: 1, activeId: null, moved: {}, attacked: {} };
  roster = []; logRows = []; selected = null; ruler = null;
  clearExplored(); cacheCurrentMapState();
  logEvent('Custom map loaded. It is local to this solo session.');
  renderAll(); invalidate();
}

function populateMapSelect() {
  const sel = $('#mapSelect');
  if (!sel || sel.dataset.ready) return;
  sel.textContent = '';
  let group = null, groupEl = null;
  for (const m of MAPS) {
    if (m.group) {
      if (!groupEl || group !== m.group) {
        group = m.group;
        groupEl = document.createElement('optgroup');
        groupEl.label = m.name;
        sel.append(groupEl);
      }
    } else groupEl = null;
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.subtitle ? m.name + ' · ' + m.subtitle : m.name;
    (groupEl || sel).append(o);
  }
  sel.dataset.ready = '1';
}
function syncMapSelect() {
  populateMapSelect();
  const sel = $('#mapSelect');
  if (sel && map) sel.value = map.key;
}
async function selectMap(id, opts = {}) {
  if (!MAP_BY_ID.has(id)) { showMsg('That map is not in the map list.'); syncMapSelect(); return; }
  if (map && map.key === id) { syncMapSelect(); return; }
  const sel = $('#mapSelect');
  if (sel) sel.disabled = true;
  try {
    await loadMapById(id);
    if (selected != null && !onLevel(tokenById(selected))) selected = null;
    if (!opts.silent) logEvent(`GM switches the table to ${map.name}.`);
    changed();
  } catch (err) {
    showMsg(err.message || 'Could not load that map.');
    syncMapSelect();
  } finally {
    if (sel) sel.disabled = false;
  }
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
  map.floor = { s, w: cw, h: ch, lab, outside };
}
function isFloorPoint(x, y) {
  const f = map && map.floor;
  if (!f) return true;
  const cx = Math.round(x * f.s), cy = Math.round(y * f.s);
  if (cx < 0 || cy < 0 || cx >= f.w || cy >= f.h) return false;
  const v = f.lab[cy * f.w + cx];
  return v > 0 && !f.outside.has(v);
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
  if (setupPhase) return true;
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
    const t = { id: nextId++, layer, mapKey: map ? map.key : DEFAULT_MAP_ID, name, color, size, x, y, status: '', hp: maxHp, maxHp, stats: st, weapon, inventory: bag, img };
    snapTok(t); return t;
  };
  // Pixel centre of a map square (the scene is 64 x 39.25 squares at 16 px each).
  const sq = (col, row) => [(col + 0.5) * (map ? map.ppg : 16), (row + 0.5) * (map ? map.ppg : 16)];
  // Hostile boarding party: 4 pilots, 2 grunts, 2 navigators, 1 medic, 1 engineer.
  // The token images are referenced by path (not embedded), so saved layouts stay small.
  const hostile = (role, n, col, row) => {
    const preset = HOSTILE_PRESETS[role];
    const [x, y] = sq(col, row);
    return mk('gm', role + (n ? ' ' + n : ''), preset.color, x, y, 1, preset.stats,
      preset.weapon, HUMAN_TOKENS + preset.img, cloneInventory(preset.inv));
  };
  // The four heroes are fixed characters: their names survive a player taking the seat.
  const hero = (name, color, x, y, stats, weapon, img, inv) =>
    mk('player', name, color, x, y, 1, stats, weapon, HUMAN_TOKENS + img, inv);
  return [
    hero("Leni 'Killmeister' Henari", '#3cc4b1', 700, 300,
      { melee: 11, martialArts: 0, dance: 7, athletic: 11 }, 'laser_rifle', 'killmeister.webp',
      [{ name: 'Combat knife', qty: 1 }, { name: 'Laser cell', qty: 2 }, { name: 'Medkit', qty: 1 }, { name: 'Frag grenade', qty: 1 }]),
    hero("Keyan 'Enforcer' Steele", '#6aa6ff', 680, 311,
      { melee: 6, martialArts: 0, dance: 0, athletic: 6 }, 'laser_rifle', 'enforcer-head.png',
      [{ name: 'Laser cell', qty: 2 }, { name: 'Medkit', qty: 1 }]),
    hero("Cyric 'Talon' Karde", '#f2a93b', 660, 300,
      { melee: 0, martialArts: 7, dance: 0, athletic: 5 }, 'laser_rifle', 'talon.jpg',
      [{ name: 'Laser cell', qty: 2 }, { name: 'Medkit', qty: 1 }]),
    hero("Derek 'Tinman' Miles", '#c58bff', 680, 280,
      { melee: 7, martialArts: 8, dance: 0, athletic: 9 }, 'laser_rifle', 'tinman.webp',
      [{ name: 'Laser cell', qty: 2 }, { name: 'Frag grenade', qty: 1 }, { name: 'Medkit', qty: 1 }]),

    hostile('Pilot', 1, 40, 11),
    hostile('Pilot', 2, 37, 14),
    hostile('Pilot', 3, 27, 21),
    hostile('Pilot', 4, 49, 28),

    hostile('Grunt', 1, 37, 25),
    hostile('Grunt', 2, 52, 20),

    hostile('Navigator', 1, 11, 19),
    hostile('Navigator', 2, 14, 20),

    hostile('Medic', 0, 21, 21),
    hostile('Engineer', 0, 53, 20)
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
  const alive = tokens.filter(t => t.layer === 'player' && !isDown(t) && onLevel(t));
  if (role === 'player' && me.tokenId) {
    const mine = tokenById(me.tokenId);
    return mine && !isDown(mine) && onLevel(mine) ? [mine] : [];
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
  const order = [...tokens.filter(t => t.layer === 'player' && onLevel(t)), ...tokens.filter(t => t.layer === 'gm' && onLevel(t))].reverse();
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
function hitStair(w) {
  if (!map || !map.stairs) return null;
  return map.stairs.find(s => Math.hypot(w.x - s.x, w.y - s.y) <= map.ppg * 0.7) || null;
}
function stairsFor(mapKey) {
  const meta = MAP_BY_ID.get(mapKey);
  return (meta && Array.isArray(meta.stairs)) ? meta.stairs : [];
}
function moveTokenThroughStair(t, st) {
  const from = t.mapKey || (map ? map.key : '');
  if (!st || st.to === from) return false;
  const srcPpg = (MAP_BY_ID.get(from) || {}).ppg || (map ? map.ppg : 50);
  const gx = st.gx != null ? st.gx : +st.x, gy = st.gy != null ? st.gy : +st.y;
  if (Math.hypot(t.x / srcPpg - gx, t.y / srcPpg - gy) > 1.6) return false;
  const dstMeta = MAP_BY_ID.get(st.to);
  if (!dstMeta) return false;
  const dstPpg = dstMeta.ppg || srcPpg;
  t.mapKey = st.to;
  t.x = (+st.tx) * dstPpg;
  t.y = (+st.ty) * dstPpg;
  if (settings.snap) {
    const tmp = { size: t.size, x: t.x, y: t.y };
    const g = dstPpg;
    if (t.size % 2 === 1) { tmp.x = (Math.floor(tmp.x / g) + .5) * g; tmp.y = (Math.floor(tmp.y / g) + .5) * g; }
    else { tmp.x = Math.round(tmp.x / g) * g; tmp.y = Math.round(tmp.y / g) * g; }
    t.x = tmp.x; t.y = tmp.y;
  }
  return true;
}
async function useStair(t, st) {
  if (!t || !st) return;
  const from = t.mapKey || (map ? map.key : '');
  if (!moveTokenThroughStair(t, st)) { showMsg('Move the token onto the stair marker first.'); return; }
  const dest = MAP_BY_ID.get(st.to);
  missionToken(t).stairs++;
  recordMissionAction(t, `Took ${st.name} to ${mapLabel(dest)}.`);
  logEvent(`${t.name} takes ${st.name} to ${mapLabel(dest)}.`);
  fogDirty = true;
  if (map && map.key === from) await selectMap(st.to, { silent: true });
  selected = t.id;
  changed();
}
function clickStair(st) {
  if (!st) return;
  if (setupPhase && role === 'player') { showMsg('The GM is setting up the mission.'); return; }
  if (role === 'gm') {
    const t = tokenById(selected);
    if (t && onLevel(t)) useStair(t, st);
    else selectMap(st.to, { silent: true });
    return;
  }
  const own = tokenById(me.tokenId);
  if (!own || !onLevel(own)) { showMsg('You need a character on this deck to use the stair.'); return; }
  if (!hostOnline || netState !== 'live') { showMsg('The GM is offline. The table is paused.'); return; }
  net && net.sendAction({ type: 'useStair', tokenId: own.id, stairId: st.id }).catch(() => showMsg('Could not send the stair move.'));
  showMsg('Using ' + st.name + '…');
}

/* ---------- shared state ---------- */
const SHARED_SETTINGS = ['mode', 'dark', 'scale', 'snap', 'fog', 'explore', 'sight', 'preview', 'gmPass', 'showStatus', 'showHp', 'turnBased', 'moveLimit'];
function sharedSettings() { const o = {}; for (const k of SHARED_SETTINGS) o[k] = settings[k]; return o; }
function makeSnapshot() {
  rev++;
  return {
    v: 2, rev, ts: Date.now(), host: hostName || me.name || 'GM', mapKey: map ? map.key : DEFAULT_MAP_ID,
    setup: setupPhase,
    turn: { number: turn.number, activeId: turn.activeId, moved: Object.assign({}, turn.moved), attacked: Object.assign({}, turn.attacked) },
    tokens: tokens.map(cleanToken),
    doors: map ? map.doors.map(d => d.open) : [],
    lights: map ? map.lights.map(l => l.force) : [],
    mapStates: allMapStates(),
    settings: sharedSettings(), ftPer, unit,
    roster: roster.map(r => ({ clientId: r.clientId, name: r.name, tokenId: r.tokenId, online: r.online, joinedAt: r.joinedAt })),
    pendingAttacks: [...pendingPlayerAttacks.values()].map(e => ({
      id: e.id, clientId: e.clientId, attackerId: e.attackerId, targetId: e.targetId,
      move: e.move, reaction: e.reaction, queuedAt: e.queuedAt
    })),
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
function snapshotMapKey(s) {
  return MAP_BY_ID.has(s.mapKey) ? s.mapKey : (map ? map.key : DEFAULT_MAP_ID);
}
function applySnapshot(s, initial = false) {
  if (!s || s.v !== 2) return;
  if (!initial && s.rev <= rev) return;
  const wanted = snapshotMapKey(s);
  if (wanted && (!map || wanted !== map.key)) {
    if (snapshotLoading) { pendingSnapshot = { s, initial }; return; }
    snapshotLoading = true;
    pendingSnapshot = { s, initial };
    loadMapById(wanted).then(() => {
      snapshotLoading = false;
      const next = pendingSnapshot; pendingSnapshot = null;
      if (next) applySnapshot(next.s, next.initial);
    }).catch(err => {
      snapshotLoading = false;
      showMsg(err.message || 'Could not load the selected map.');
    });
    return;
  }
  rev = s.rev;
  hostName = s.host || hostName;
  setupPhase = !!s.setup;
  tokens = (s.tokens || []).map(t => Object.assign(cleanToken(t), { plan: undefined }));
  nextId = Math.max(0, ...tokens.map(t => t.id)) + 1;
  syncTokenImages();
  if (s.mapStates) restoreMapStates(s.mapStates);
  if (map) {
    (s.doors || []).forEach((o, i) => { if (map.doors[i]) map.doors[i].open = !!o; });
    (s.lights || []).forEach((f, i) => { if (map.lights[i]) map.lights[i].force = f; });
    cacheCurrentMapState();
    rebuildBlockers();
  }
  Object.assign(settings, s.settings || {});
  if (s.ftPer > 0) ftPer = s.ftPer;
  if (s.unit) unit = s.unit;
  turn = s.turn && typeof s.turn.number === 'number' ? { number: s.turn.number, activeId: s.turn.activeId ?? null, moved: s.turn.moved || {}, attacked: s.turn.attacked || {} } : { number: 1, activeId: null, moved: {}, attacked: {} };
  roster = Array.isArray(s.roster) ? s.roster : [];
  pendingAttacks = Array.isArray(s.pendingAttacks) ? s.pendingAttacks : [];
  if (initial && sessionRole === 'host') {
    pendingPlayerAttacks.clear();
    for (const entry of pendingAttacks) if (entry && entry.id) pendingPlayerAttacks.set(entry.id, Object.assign({}, entry));
  }
  logRows = Array.isArray(s.log) ? s.log.slice(-70) : [];
  if (!mission.events.length && logRows.length) {
    mission.events = logRows.map(e => Object.assign({}, e));
    const first = logRows[0].t || Date.now();
    if (first < mission.startedAt) mission.startedAt = first;
  }
  if (map) mission.maps.add(map.key);
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

  if (layers.light.vis) {
    if (role === 'gm') {
      for (const l of map.lights) {
        const r = 4.5 / k;
        ctx.beginPath(); ctx.arc(l.x, l.y, r, 0, 6.2832);
        if (l.on) { ctx.fillStyle = `rgb(${l.rgb})`; ctx.fill(); } else { ctx.fillStyle = 'rgba(7,10,15,.7)'; ctx.fill(); }
        ctx.lineWidth = 1.5 / k; ctx.strokeStyle = l.force === null ? 'rgba(255,255,255,.75)' : css('--accent');
        ctx.setLineDash(l.force === null ? [] : [2 / k, 2 / k]); ctx.stroke(); ctx.setLineDash([]);
      }
    } else {
      for (const l of map.lights) {
        const r = 3.2 / k;
        ctx.beginPath(); ctx.arc(l.x, l.y, r, 0, 6.2832);
        ctx.fillStyle = 'rgba(242,169,59,.35)'; ctx.fill();
        ctx.lineWidth = 1 / k; ctx.strokeStyle = 'rgba(242,169,59,.9)'; ctx.stroke();
      }
    }
  }

  if (settings.fog && fogDirty) fogPass();
  if (fogActive()) { ctx.globalAlpha = role === 'gm' ? 0.72 : 1; ctx.drawImage(fog, 0, 0); ctx.globalAlpha = 1; }
  for (const s of map.stairs || []) drawStair(s);
  drawRequestHighlight();
  for (const layer of ['gm', 'player']) for (const t of tokens) if (t.layer === layer && onLevel(t) && tokVisible(t)) drawToken(t);

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

function drawStair(s) {
  const k = view.k, r = Math.max(7 / k, map.ppg * 0.3);
  ctx.save();
  ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, 6.2832);
  ctx.fillStyle = 'rgba(18,25,35,.88)'; ctx.fill();
  ctx.lineWidth = Math.max(1.5, (s === hoverStair ? 4 : 2.5) / k);
  ctx.strokeStyle = css('--accent'); ctx.setLineDash([4 / k, 3 / k]); ctx.stroke(); ctx.setLineDash([]);
  const arrow = s.to.includes('top') ? '↑' : s.to.includes('bottom') ? '↓' : '↕';
  ctx.font = `600 ${Math.max(12 / k, r * 0.95)}px Inter,sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = css('--accent'); ctx.fillText(arrow, s.x, s.y + r * 0.04);
  const fs = Math.max(10 / k, 4);
  const label = s.name.replace(/\s*·\s*/, ' ');
  ctx.font = `500 ${fs}px Inter,sans-serif`;
  const tw = ctx.measureText(label).width, pad = fs * 0.45, bh = fs * 1.5;
  const bx = s.x - tw / 2 - pad, by = s.y + r + 3 / k;
  ctx.fillStyle = 'rgba(11,15,21,.9)'; ctx.fillRect(bx, by, tw + pad * 2, bh);
  ctx.fillStyle = '#fff'; ctx.fillText(label, s.x, by + bh / 2);
  ctx.restore();
}

function drawRequestHighlight() {
  const req = currentRequest;
  if (!req || !map || req.mapKey !== map.key) return;
  const k = view.k;
  let x, y, label;
  ctx.save();
  ctx.strokeStyle = '#ff5bd0';
  if (req.kind === 'door') {
    const d = map.doors[req.index];
    if (!d) { ctx.restore(); return; }
    x = (d.a.x + d.b.x) / 2; y = (d.a.y + d.b.y) / 2;
    ctx.lineWidth = Math.max(6, 8 / k);
    ctx.setLineDash([8 / k, 5 / k]);
    ctx.beginPath(); ctx.moveTo(d.a.x, d.a.y); ctx.lineTo(d.b.x, d.b.y); ctx.stroke();
    ctx.setLineDash([]);
    label = `${req.player} · ${req.value ? 'open' : 'close'}`;
  } else {
    const l = map.lights[req.index];
    if (!l) { ctx.restore(); return; }
    x = l.x; y = l.y;
    const r = Math.max(10 / k, map.ppg * 0.45);
    ctx.lineWidth = Math.max(2, 3 / k);
    ctx.setLineDash([5 / k, 4 / k]);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.stroke();
    ctx.setLineDash([]);
    label = `${req.player} · light ${req.value ? 'on' : 'off'}`;
  }
  ctx.restore();
  const fs = Math.max(10 / k, 4);
  ctx.font = `600 ${fs}px Inter,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width, pad = fs * 0.55, bh = fs * 1.55;
  const by = y - Math.max(16 / k, map.ppg * 0.55) - bh;
  ctx.fillStyle = 'rgba(255,91,208,.94)';
  ctx.beginPath(); ctx.roundRect(x - tw / 2 - pad, by, tw + pad * 2, bh, bh / 2); ctx.fill();
  ctx.fillStyle = '#10151c'; ctx.fillText(label, x, by + bh / 2 + fs * 0.04);
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
  const st = hitStair(w);
  if (st) { clickStair(st); return; }
  if (role === 'gm') {
    if (layers.light.vis) { const bl = hitBulb(w); if (bl) { bl.force = bl.force === null ? true : (bl.force === true ? false : null); lightDirty = true; logEvent(`GM turns a light ${bl.force === null ? 'to automatic' : bl.force ? 'on' : 'off'}.`); changed(); return; } }
    if (layers.rooms.vis && !layers.rooms.lock) {
      const d = hitDoor(w);
      if (d) { d.open = !d.open; rebuildBlockers(); lightDirty = true; updateDoorCount(); logEvent(`GM ${d.open ? 'opens' : 'closes'} ${d.name}.`); changed(); return; }
    }
  } else if (role === 'player') {
    const bl = layers.light.vis ? hitBulb(w) : null;
    if (bl) { requestLight(bl); return; }
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
  const hb = layers.light.vis ? hitBulb(w) : null;
  const hs = hitStair(w);
  if (ht !== hoverTok || hd !== hoverDoor || hs !== hoverStair) { hoverTok = ht; hoverDoor = ht ? null : hd; hoverStair = ht ? null : hs; invalidate(); }
  cv.style.cursor = tool === 'ruler' ? 'crosshair' : (ht && canTouch(ht)) ? 'grab' : (hd || hb || hs) ? 'pointer' : 'default';
  const own = ht && (isHost() || ht.id === me.tokenId);
  const turnMsg = ht && role === 'player' && settings.turnBased && turn.activeId !== ht.id ? ' · waiting for their turn' : '';
  setHint(hs && !ht ? `${hs.name} · click to travel to ${mapLabel(MAP_BY_ID.get(hs.to))}` : hd && !ht ? (role === 'gm' ? `${hd.name} · ${hd.open ? 'open' : 'closed'} · click to ${hd.open ? 'close' : 'open'}` : `${hd.name} · ${hd.open ? 'open' : 'closed'} · click to ask the GM`) : hb && !ht ? (role === 'gm' ? `Light · ${hb.force === null ? 'automatic' : hb.force ? 'forced on' : 'forced off'} · click to cycle` : `Light · click to ask the GM to turn it ${hb.on ? 'off' : 'on'}`) : ht && own ? `${ht.name} · HP ${ht.hp}/${ht.maxHp}${turnMsg}` : null);
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
        const d = Math.hypot(t.x - drag.sx, t.y - drag.sy) / map.ppg;
        addMissionDistance(t, d);
        if (settings.turnBased && turn.activeId === t.id) turn.moved[t.id] = (turn.moved[t.id] || 0) + d;
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
  fr.onload = () => { try { loadCustomMap(JSON.parse(fr.result)).catch(err => showMsg(err.message)); } catch (err) { showMsg('Could not read that file as JSON.'); } };
  fr.readAsText(f);
}
$('#file').addEventListener('change', e => { const f = e.target.files[0]; if (f) readFile(f); e.target.value = ''; });

/* ---------- hint + tools ---------- */
function setHint(extra) {
  const base = role === 'player'
    ? (tool === 'ruler' ? 'Drag to measure. Esc clears.'
      : setupPhase ? 'The GM is setting up the mission.'
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
$('#mapSelect').onchange = e => selectMap(e.target.value);
$('#btnEndMission').onclick = endMission;
$('#placeUnit').onclick = placeSetupUnit;
$('#placeParty').onclick = movePlayersToDeck;
$('#spawnEnemies').onclick = () => spawnEnemies($('#spawnRole').value, $('#spawnCount').value);
$('#beginMission').onclick = beginMission;

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
  renderSetup(); renderTokens(); renderRoster(); renderSheet(); renderTurnOrder(); renderPendingAttacks(); renderLog(); updateTurnUI(); updateDoorCount(); setHint(null); invalidate();
}
function viewCenterWorld() {
  const r = cv.getBoundingClientRect();
  return {
    x: Math.max(map.ppg, Math.min(map.W - map.ppg, (r.width / 2 - view.x) / view.k)),
    y: Math.max(map.ppg, Math.min(map.H - map.ppg, (r.height / 2 - view.y) / view.k))
  };
}
function populateSpawnRoles() {
  const sel = $('#spawnRole');
  if (!sel || sel.dataset.ready) return;
  sel.textContent = '';
  const groups = new Map();
  for (const role of HOSTILE_ROLES) {
    const preset = HOSTILE_PRESETS[role];
    const key = preset.dir === KILRATHI_TOKENS ? 'Kilrathi characters' : 'Boarding party';
    let group = groups.get(key);
    if (!group) {
      group = document.createElement('optgroup'); group.label = key;
      groups.set(key, group); sel.append(group);
    }
    const o = document.createElement('option');
    o.value = role;
    o.textContent = preset.label || role;
    group.append(o);
  }
  sel.dataset.ready = '1';
}
function renderSetup() {
  const sel = $('#setupToken');
  if (!sel || !map) return;
  populateSpawnRoles();
  const previous = sel.value;
  sel.textContent = '';
  const addGroup = (label, list) => {
    if (!list.length) return;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const t of list) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = `${t.name} · ${mapLabel(MAP_BY_ID.get(t.mapKey))}`;
      group.append(o);
    }
    sel.append(group);
  };
  addGroup('Player characters', tokens.filter(t => t.layer === 'player'));
  addGroup('Hostiles', tokens.filter(t => t.layer !== 'player'));
  if (previous && [...sel.options].some(o => o.value === previous)) sel.value = previous;
  else if (sel.options.length) sel.value = sel.options[0].value;
  sel.disabled = !sel.options.length;
  const note = $('#setupNote');
  if (note) note.textContent = setupPhase
    ? 'Setup phase — place the party and hostiles, then begin the mission.'
    : 'Mission in progress. The GM can still move units between decks from here.';
  const begin = $('#beginMission');
  if (begin) begin.hidden = !setupPhase;
  const place = $('#placeUnit');
  if (place) place.disabled = !sel.value;
}
function nextHostileNumber(base) {
  let max = 0;
  const safe = String(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + safe + '(?: (\\d+))?$');
  for (const t of tokens) {
    if (t.layer !== 'gm') continue;
    const m = String(t.name || '').match(re);
    if (m) max = Math.max(max, +(m[1] || 0));
  }
  return max + 1;
}
function freeSpawnSlots(count, center) {
  const g = map.ppg;
  const maxCol = Math.max(1, Math.floor(map.W / g)), maxRow = Math.max(1, Math.floor(map.H / g));
  const used = new Set();
  for (const t of tokens) {
    if (t.mapKey && t.mapKey !== map.key) continue;
    used.add(Math.floor(t.x / g) + ',' + Math.floor(t.y / g));
  }
  const cc = Math.max(0, Math.min(maxCol - 1, Math.floor(center.x / g)));
  const cr = Math.max(0, Math.min(maxRow - 1, Math.floor(center.y / g)));
  const offsets = [[0, 0]];
  const maxR = Math.max(maxCol, maxRow);
  for (let r = 1; r <= maxR; r++) {
    for (let x = -r; x <= r; x++) { offsets.push([x, -r], [x, r]); }
    for (let y = -r + 1; y < r; y++) { offsets.push([-r, y], [r, y]); }
  }
  const out = [];
  for (const [dx, dy] of offsets) {
    const col = cc + dx, row = cr + dy;
    if (col < 0 || row < 0 || col >= maxCol || row >= maxRow) continue;
    const key = col + ',' + row;
    if (used.has(key)) continue;
    const wx = (col + 0.5) * g, wy = (row + 0.5) * g;
    if (!isFloorPoint(wx, wy)) continue;
    used.add(key);
    out.push({ x: wx, y: wy });
    if (out.length >= count) break;
  }
  while (out.length < count) out.push({ x: center.x, y: center.y });
  return out;
}
function spawnEnemies(role, count) {
  if (!isHost() || !map) return;
  const preset = HOSTILE_PRESETS[role];
  if (!preset) return;
  count = Math.max(1, Math.min(50, Math.round(+count || 1)));
  const base = preset.name || role;
  const start = nextHostileNumber(base);
  const slots = freeSpawnSlots(count, viewCenterWorld());
  let last = null;
  for (let i = 0; i < count; i++) {
    const stats = normalizeStats(preset.stats, 'gm', 1);
    const maxHp = computeStats(stats).maxHp;
    const n = start + i;
    const name = preset.name ? (n === 1 ? base : base + ' ' + n) : base + ' ' + n;
    const t = {
      id: nextId++, layer: 'gm', mapKey: map.key, name,
      color: preset.color, size: 1, x: slots[i].x, y: slots[i].y,
      status: '', hp: maxHp, maxHp, stats, weapon: preset.weapon,
      inventory: cloneInventory(preset.inv), img: (preset.dir || HUMAN_TOKENS) + preset.img
    };
    tokens.push(t);
    loadTokImg(t);
    last = t;
  }
  if (last) selected = last.id;
  const unitLabel = preset.label || role;
  logEvent(`GM spawns ${count} × ${unitLabel} on ${map.name}.`);
  changed();
  const playersHere = tokens.filter(t => t.layer === 'player' && t.mapKey === map.key && !isDown(t)).length;
  const noVision = playersHere ? '' : ' No player character is on this deck, so players will not see them.';
  const darkRooms = settings.mode === 'auto' && !map.doors.some(d => d.open)
    ? ' Rooms stay dark until a door opens; use Lighting → All lights on to reveal them.' : '';
  showMsg(`${count} × ${unitLabel} spawned. Drag them into position.${noVision}${darkRooms}`);
}
function placeSetupUnit() {
  if (!isHost() || !map) return;
  const id = +$('#setupToken').value;
  const t = tokenById(id);
  if (!t) return;
  if (t.mapKey !== map.key) {
    const slot = freeSpawnSlots(1, viewCenterWorld())[0] || viewCenterWorld();
    t.mapKey = map.key;
    t.x = slot.x; t.y = slot.y;
    snapTok(t);
    logEvent(`GM places ${t.name} on ${map.name}.`);
  }
  selected = t.id;
  changed();
  showMsg(`${t.name} is on ${map.name}. Drag it to its spawn square.`);
}
function movePlayersToDeck() {
  if (!isHost() || !map) return;
  const players = tokens.filter(t => t.layer === 'player');
  const moving = players.filter(t => t.mapKey !== map.key);
  if (!moving.length) { showMsg('All player characters are already on this deck.'); return; }
  const slots = freeSpawnSlots(moving.length, viewCenterWorld());
  moving.forEach((t, i) => {
    const slot = slots[i] || viewCenterWorld();
    t.mapKey = map.key;
    t.x = slot.x; t.y = slot.y;
    snapTok(t);
  });
  logEvent(`GM moves ${moving.length} player character${moving.length === 1 ? '' : 's'} to ${map.name}.`);
  changed();
  showMsg(`Player characters moved to ${map.name}. Drag them into their spawn positions.`);
}
function beginMission() {
  if (!isHost() || !setupPhase) return;
  setupPhase = false;
  resetMission();
  if (map) mission.maps.add(map.key);
  logEvent('Setup complete. Mission begins.');
  lightDirty = true; fogDirty = true;
  changed();
  showMsg('Mission started.');
}
function renderTokens() {
  for (const [layer, id] of [['player', '#rowsPlayer'], ['gm', '#rowsGm']]) {
    const box = $(id); if (!box) continue;
    box.textContent = '';
    const list = tokens.filter(t => t.layer === layer && onLevel(t) && (role === 'gm' || tokVisible(t)));
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
  return tokens.filter(o => o.id !== t.id && !isDown(o) && onLevel(o) &&
    (role === 'gm' || (o.layer === 'gm' && tokVisible(o))));
}
function pendingAttackFor(tokenId) {
  const list = sessionRole === 'player' ? pendingAttacks : [...pendingPlayerAttacks.values()];
  return list.find(e => +e.attackerId === +tokenId) || null;
}
function attackBlockedReason(t) {
  if (!t || !map) return 'No map loaded';
  if (setupPhase) return 'Setup phase — begin the mission first';
  if (isDown(t)) return t.name + ' is down';
  if (role === 'player' && t.id !== me.tokenId) return 'Not your character';
  if (pendingAttackFor(t.id)) return t.name + "'s attack is waiting for the GM";
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
  const queued = pendingAttackFor(t.id);
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn tiny primary';
  b.textContent = queued ? 'Attack queued' : settings.turnBased && turn.attacked && turn.attacked[t.id] ? 'Attack used' : 'Attack';
  const reason = attackBlockedReason(t);
  b.disabled = !!reason;
  b.title = reason || 'Choose a target and a move';
  b.onclick = () => openCombat(t.id);
  const w = weaponOf(t);
  const meta = document.createElement('span'); meta.className = 'mono muted combatmeta';
  meta.textContent = `${w.label} · ${w.type}` + (queued ? ' · awaiting GM' : settings.turnBased && turn.attacked && turn.attacked[t.id] ? ' · used' : '');
  row.append(b, meta);
  return row;
}
function resolveQueuedPlayerAttack(id) {
  const entry = pendingPlayerAttacks.get(id);
  if (!entry) return;
  pendingPlayerAttacks.delete(id);
  const a = tokenById(entry.attackerId), b = tokenById(entry.targetId);
  if (!a || !b) {
    net && net.notify(entry.clientId, 'That attack could not be resolved: a combatant is gone.');
    changed(); return;
  }
  // GM override: "enemy wins/loses" is expressed from the hostile's point of
  // view, while performForcedExchange takes the attacker's point of view.
  const forced = entry.reaction === 'enemy-win' ? 'lose'
    : entry.reaction === 'enemy-lose' ? 'win' : null;
  const result = forced
    ? performForcedExchange(a.id, b.id, forced, { fromQueue: true })
    : performAttack(a.id, b.id, entry.move, entry.reaction, false, { fromQueue: true });
  if (result.error) {
    net && net.notify(entry.clientId, 'Attack failed: ' + result.error);
    showMsg(result.error);
  } else {
    net && net.notify(entry.clientId, `${a.name}'s attack was resolved — ${b.name} is at ${b.hp}/${b.maxHp} HP.`);
  }
  changed();
}
function cancelQueuedPlayerAttack(id) {
  const entry = pendingPlayerAttacks.get(id);
  if (!entry) return;
  pendingPlayerAttacks.delete(id);
  if (settings.turnBased && turn.attacked && turn.attacked[entry.attackerId] && !pendingAttackFor(entry.attackerId)) {
    delete turn.attacked[entry.attackerId];
  }
  const a = tokenById(entry.attackerId);
  logEvent(`GM cancels ${a ? a.name : 'the player'}'s attack request.`);
  net && net.notify(entry.clientId, 'The GM cancelled your attack. You can act again.');
  changed();
}
function clearPendingPlayerAttacks() {
  pendingPlayerAttacks.clear();
  pendingAttacks = [];
}
function renderPendingAttacks() {
  const box = $('#pendingAttacks');
  if (!box) return;
  box.textContent = '';
  const list = [...pendingPlayerAttacks.values()].sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
  if (!list.length) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No attacks waiting.';
    box.append(e); return;
  }
  for (const entry of list) {
    const a = tokenById(entry.attackerId), b = tokenById(entry.targetId);
    const outranged = !!(a && b && rangedAutoLoss(a, b));
    const row = document.createElement('div'); row.className = 'pendingattack';
    const who = document.createElement('div'); who.className = 'who';
    who.textContent = `${a ? a.name : 'Unknown'} → ${b ? b.name : 'Unknown'} · ${MOVE_LABEL[entry.move] || 'Attack'}` +
      (b ? ` · ${b.hp}/${b.maxHp} HP` : '') + (outranged ? ' · defender outranged, automatic win' : '');
    const controls = document.createElement('div'); controls.className = 'controls';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Hostile stance for ' + (b ? b.name : 'target'));
    const stanceGroup = document.createElement('optgroup'); stanceGroup.label = 'Hostile stance';
    const overrideGroup = document.createElement('optgroup'); overrideGroup.label = 'GM override';
    if (outranged) {
      const o = document.createElement('option'); o.value = 'auto';
      o.textContent = 'Automatic win — no ranged reply';
      if ((entry.reaction || 'auto') === 'auto') o.selected = true;
      stanceGroup.append(o);
    } else {
      for (const [value, label] of [['auto', 'AI random stance'], ['strike', 'Strike'], ['grapple', 'Grapple'], ['counter', 'Counter']]) {
        const o = document.createElement('option'); o.value = value; o.textContent = label;
        if ((entry.reaction || 'auto') === value) o.selected = true;
        stanceGroup.append(o);
      }
    }
    for (const [value, label] of [['enemy-win', 'Hostile auto-wins'], ['enemy-lose', 'Hostile auto-loses']]) {
      const o = document.createElement('option'); o.value = value; o.textContent = label;
      if (entry.reaction === value) o.selected = true;
      overrideGroup.append(o);
    }
    if (stanceGroup.children.length) sel.append(stanceGroup);
    sel.append(overrideGroup);
    sel.onchange = () => { entry.reaction = sel.value; };
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn tiny primary'; go.textContent = 'Resolve attack';
    go.onclick = () => resolveQueuedPlayerAttack(entry.id);
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn tiny'; cancel.textContent = 'Cancel';
    cancel.onclick = () => cancelQueuedPlayerAttack(entry.id);
    controls.append(sel, go, cancel);
    row.append(who, controls);
    box.append(row);
  }
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
  $$('#combatMoves .force-option').forEach(btn => { btn.hidden = role !== 'gm'; });
  $$('#combatMoves [data-move]').forEach(btn => btn.setAttribute('aria-pressed', btn.dataset.move === combatChosenMove ? 'true' : 'false'));
  const reactInfo = $('#combatReactInfo');
  const forced = role === 'gm' && FORCE_MOVES[combatChosenMove];
  if (forced) {
    reactInfo.textContent = combatChosenMove === 'win'
      ? 'The exchange will be decided in the attacker’s favour.'
      : 'The exchange will be decided in the defender’s favour.';
  } else if (b.layer === 'gm') reactInfo.textContent = 'Enemy AI · the hostile picks a random stance.';
  else if (role === 'player') reactInfo.textContent = 'The GM controls this defender.';
  else {
    const owner = controllerOf(b.id);
    reactInfo.textContent = owner && owner.online
      ? `${owner.name} will be asked to choose their stance.`
      : 'No player is online for this character · random stance.';
  }
  $('#combatGo').disabled = !reach.ok || isDown(b);
  $('#combatGo').textContent = role === 'player' ? 'Send attack' : forced ? 'Resolve exchange' : 'Attack';
}
function controllerOf(tokenId) {
  return roster.find(r => r.tokenId === tokenId) || null;
}
function closeCombat() {
  const dlg = $('#combatDlg');
  if (dlg.open) dlg.close();
  combatCtx = null;
}
function updateHealthStatus(t, prePct, postPct, out = null) {
  if (postPct <= 30 && prePct > 30) {
    t.status = 'Bloodied';
    if (out) out.push(`${t.name} is bloodied.`);
  } else if (postPct <= 60 && prePct > 60) {
    t.status = 'Staggered';
    if (out) out.push(`${t.name} is staggered.`);
  }
}
function healthConditions(t, pre, post, out) {
  updateHealthStatus(t, pre, post, out);
  if (post < -25) out.push(`${t.name} requires immediate medical attention.`);
}
function dealCombatDamage(target, amount, messages) {
  const dmg = Math.max(0, Math.floor(amount));
  if (dmg <= 0) return 0;
  target.hp = Math.max(0, target.hp - dmg);
  if (missionDamageCtx) missionDamageCtx.push({ targetId: target.id, amount: dmg });
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
  healthConditions(a, aPre, healthPct(a), messages);
  healthConditions(b, bPre, healthPct(b), messages);
  if (b.hp <= 0 && a.hp > 0) messages.push(`${a.name} is victorious.`);
  else if (a.hp <= 0 && b.hp > 0) messages.push(`${b.name} is victorious.`);
  else if (a.hp <= 0 && b.hp <= 0) messages.push('Both combatants are down.');
  return messages;
}
function performAttack(attackerId, targetId, move, reaction, fromRemote = false, opts = {}) {
  const a = tokenById(attackerId), b = tokenById(targetId);
  if (!a || !b) return { error: 'That combatant is no longer on the table.' };
  if (a.id === b.id) return { error: 'A token cannot attack itself.' };
  if (isDown(a)) return { error: a.name + ' is down.' };
  if (isDown(b)) return { error: b.name + ' is already down.' };
  if (!MOVE_LABEL[move]) return { error: 'Choose Strike, Grapple or Counter.' };
  if (settings.turnBased && !opts.fromQueue) {
    if (turn.activeId !== a.id) return { error: 'It is not ' + a.name + "'s turn." };
    if (turn.attacked && turn.attacked[a.id]) return { error: a.name + ' has already attacked this turn.' };
  }
  if (role === 'player' && (a.layer !== 'player' || b.layer !== 'gm')) return { error: 'Players may only attack hostiles.' };
  const reach = combatReach(a, b);
  if (!reach.ok) return { error: a.name + ' is out of reach with a ' + weaponOf(a).label + '.' };
  const outranged = rangedAutoLoss(a, b);
  let aiRoll = null, bMove = reaction;
  if (outranged) {
    bMove = MOVES[move] || 'grapple'; aiRoll = null;
  } else if (bMove === 'auto' || !MOVE_LABEL[bMove]) {
    const ai = aiReaction(move);
    bMove = ai.move; aiRoll = ai.roll;
  }
  if (settings.turnBased) { turn.attacked = turn.attacked || {}; turn.attacked[a.id] = true; }
  missionToken(a); missionToken(b);
  missionDamageCtx = [];
  const messages = resolveExchange(a, b, move, bMove, aiRoll);
  if (outranged) messages.push(`${b.name} has no ranged weapon and cannot answer at this range.`);
  let aDamageTaken = 0, bDamageTaken = 0;
  for (const hit of missionDamageCtx) {
    if (hit.targetId === a.id) aDamageTaken += hit.amount;
    else if (hit.targetId === b.id) bDamageTaken += hit.amount;
  }
  missionDamageCtx = null;
  const recA = missionToken(a), recB = missionToken(b);
  recA.damageDealt += bDamageTaken; recA.damageTaken += aDamageTaken; recA.attacksMade++;
  recB.damageDealt += aDamageTaken; recB.damageTaken += bDamageTaken; recB.attacksReceived++;
  recB.stances[bMove || 'none'] = (recB.stances[bMove || 'none'] || 0) + 1;
  const reactionLabel = bMove ? MOVE_LABEL[bMove] : 'caught unaware';
  recordMissionAction(a, `Attacked ${b.name} with ${MOVE_LABEL[move]}; ${b.name} used ${reactionLabel}; dealt ${bDamageTaken} damage.`);
  recordMissionAction(b, `Defended against ${a.name} with ${reactionLabel}; took ${bDamageTaken} damage; dealt ${aDamageTaken} damage.`);
  mission.attacks.push({
    t: Date.now(), attackerId: a.id, attacker: a.name, targetId: b.id, target: b.name,
    attack: MOVE_LABEL[move], reaction: reactionLabel, aiRoll,
    damageToTarget: bDamageTaken, damageToAttacker: aDamageTaken,
    targetHp: b.hp, targetMax: b.maxHp, attackerHp: a.hp, attackerMax: a.maxHp
  });
  logEvent(`${a.name} attacks ${b.name}.\n${messages.join('\n')}`, 'combat');
  if (!fromRemote) showMsg(`${a.name} attacks ${b.name} — ${b.hp}/${b.maxHp} HP left.`);
  fogDirty = true;
  changed();
  return { ok: true, messages, targetHp: b.hp };
}
function performForcedExchange(attackerId, targetId, outcome, opts = {}) {
  const a = tokenById(attackerId), b = tokenById(targetId);
  if (!a || !b) return { error: 'That combatant is no longer on the table.' };
  if (a.id === b.id) return { error: 'A token cannot fight itself.' };
  if (!FORCE_MOVES[outcome]) return { error: 'Choose Win or Lose.' };
  if (setupPhase) return { error: 'Begin the mission before resolving combat.' };
  if (isDown(a)) return { error: a.name + ' is down.' };
  if (isDown(b)) return { error: b.name + ' is already down.' };
  if (settings.turnBased && !opts.fromQueue) {
    if (turn.activeId !== a.id) return { error: 'It is not ' + a.name + "'s turn." };
    if (turn.attacked && turn.attacked[a.id]) return { error: a.name + ' has already attacked this turn.' };
  }
  const reach = combatReach(a, b);
  if (!reach.ok) return { error: a.name + ' is out of reach with a ' + weaponOf(a).label + '.' };
  if (settings.turnBased) { turn.attacked = turn.attacked || {}; turn.attacked[a.id] = true; }

  // Resolve the requested outcome through an ordinary winning/losing stance pair,
  // so the log reads as Strike/Grapple/Counter rather than a GM override.
  const [aMove, bMove] = choice(outcome === 'win' ? WIN_PAIRS : LOSE_PAIRS);
  missionToken(a); missionToken(b);
  missionDamageCtx = [];
  const messages = resolveExchange(a, b, aMove, bMove, null);
  let aDamageTaken = 0, bDamageTaken = 0;
  for (const hit of missionDamageCtx) {
    if (hit.targetId === a.id) aDamageTaken += hit.amount;
    else if (hit.targetId === b.id) bDamageTaken += hit.amount;
  }
  missionDamageCtx = null;
  const recA = missionToken(a), recB = missionToken(b);
  recA.damageDealt += bDamageTaken; recA.damageTaken += aDamageTaken; recA.attacksMade++;
  recB.damageDealt += aDamageTaken; recB.damageTaken += bDamageTaken; recB.attacksReceived++;
  recB.stances[bMove] = (recB.stances[bMove] || 0) + 1;
  recordMissionAction(a, `Attacked ${b.name} with ${MOVE_LABEL[aMove]}; ${b.name} used ${MOVE_LABEL[bMove]}; dealt ${bDamageTaken} damage.`);
  recordMissionAction(b, `Defended against ${a.name} with ${MOVE_LABEL[bMove]}; took ${bDamageTaken} damage; dealt ${aDamageTaken} damage.`);
  mission.attacks.push({
    t: Date.now(), attackerId: a.id, attacker: a.name, targetId: b.id, target: b.name,
    attack: MOVE_LABEL[aMove], reaction: MOVE_LABEL[bMove], aiRoll: null,
    damageToTarget: bDamageTaken, damageToAttacker: aDamageTaken,
    targetHp: b.hp, targetMax: b.maxHp, attackerHp: a.hp, attackerMax: a.maxHp
  });
  logEvent(`${a.name} attacks ${b.name}.\n${messages.join('\n')}`, 'combat');
  showMsg(`${a.name} attacks ${b.name} — ${b.hp}/${b.maxHp} HP left.`);
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
    showMsg('Attack queued for the GM.');
    return;
  }
  if (FORCE_MOVES[move]) {
    const forced = performForcedExchange(a.id, b.id, move);
    if (forced.error) {
      const box = $('#combatResult'); box.hidden = false; box.textContent = forced.error;
      return;
    }
    closeCombat(); return;
  }
  if (!rangedAutoLoss(a, b) && b.layer === 'player' && requestPlayerDefense(a, b, move)) { closeCombat(); return; }
  const result = performAttack(a.id, b.id, move, 'auto');
  if (result.error) {
    const box = $('#combatResult'); box.hidden = false; box.textContent = result.error;
    return;
  }
  closeCombat();
}
function requestPlayerDefense(a, b, move) {
  const owner = controllerOf(b.id);
  if (!owner || !owner.online || owner.clientId === me.clientId || !net) return false;
  const requestId = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const entry = { requestId, clientId: owner.clientId, attackerId: a.id, targetId: b.id, move, timer: 0 };
  entry.timer = setTimeout(() => {
    if (!pendingDefense.has(requestId)) return;
    pendingDefense.delete(requestId);
    net && net.notify(owner.clientId, 'No stance chosen in time — the enemy AI rolled for you.', { kind: 'defenseCancel', requestId });
    const result = performAttack(entry.attackerId, entry.targetId, entry.move, 'auto');
    if (result.error) { showMsg(result.error); scheduleSync(); }
    else { logEvent(`${owner.name} did not answer in time; ${b.name}'s reaction was rolled randomly.`); changed(); }
  }, DEFENSE_TIMEOUT_MS);
  pendingDefense.set(requestId, entry);
  net.notify(owner.clientId, `Incoming attack from ${a.name}`, {
    kind: 'defenseRequest', requestId,
    attackerId: a.id, targetId: b.id, move,
    timeoutMs: DEFENSE_TIMEOUT_MS
  });
  showMsg(`Waiting for ${owner.name} to choose a stance…`);
  return true;
}
function resolvePlayerDefense(requestId, move) {
  const entry = pendingDefense.get(requestId);
  if (!entry || !MOVE_LABEL[move]) return false;
  clearTimeout(entry.timer);
  pendingDefense.delete(requestId);
  const result = performAttack(entry.attackerId, entry.targetId, entry.move, move);
  if (result.error) { showMsg(result.error); scheduleSync(); return true; }
  net && net.notify(entry.clientId, 'Stance accepted: ' + MOVE_LABEL[move] + '.', { kind: 'defenseResolved', requestId });
  return true;
}
function clearDefenseRequests() {
  for (const entry of pendingDefense.values()) {
    clearTimeout(entry.timer);
    net && net.notify(entry.clientId, 'The GM cancelled the attack.', { kind: 'defenseCancel', requestId: entry.requestId });
  }
  pendingDefense.clear();
}
$('#combatGo').onclick = submitCombat;
$('#combatClose').onclick = closeCombat;
$('#combatCancel').onclick = closeCombat;
$('#combatDlg').addEventListener('cancel', e => { e.preventDefault(); closeCombat(); });
$('#combatDlg').addEventListener('click', e => { if (e.target === $('#combatDlg')) closeCombat(); });

function showDefenseRequest(data) {
  if (!data || !data.requestId || !MOVE_LABEL[data.move]) return;
  const a = tokenById(data.attackerId), b = tokenById(data.targetId);
  if (!a || !b || b.id !== me.tokenId) return;
  incomingDefense = { requestId: data.requestId, move: data.move };
  $('#defenseAttackerName').textContent = a.name;
  const aw = weaponOf(a), ad = computeStats(a.stats);
  $('#defenseAttackerStats').textContent = `${aw.label} · ${aw.type} · ${MOVE_LABEL[data.move]}`;
  $('#defenseTargetName').textContent = b.name;
  const bw = weaponOf(b), bd = computeStats(b.stats);
  $('#defenseTargetStats').textContent = `HP ${b.hp}/${b.maxHp} · ${bw.label} · DMG ${bd.damage} ×${bw.damage}`;
  $('#defenseRange').textContent = combatReach(a, b).text;
  $('#defenseResult').hidden = true;
  $('#defenseResult').textContent = '';
  $$('#defenseMoves [data-def-move]').forEach(btn => { btn.disabled = false; });
  const dlg = $('#defenseDlg');
  if (!dlg.open) dlg.showModal();
}
function closeDefense() {
  const dlg = $('#defenseDlg');
  if (dlg.open) dlg.close();
}
function sendDefense(move) {
  if (!incomingDefense || !MOVE_LABEL[move]) return;
  if (sessionRole !== 'player' || !net) { showMsg('Not connected.'); return; }
  if (!hostOnline || netState !== 'live') { showMsg('The GM is offline. The table is paused.'); return; }
  net.sendAction({ type: 'defend', requestId: incomingDefense.requestId, move })
    .catch(() => showMsg('Could not send your stance.'));
  $$('#defenseMoves [data-def-move]').forEach(btn => { btn.disabled = true; });
  $('#defenseResult').hidden = false;
  $('#defenseResult').textContent = 'Stance sent to the GM: ' + MOVE_LABEL[move] + '.';
  setTimeout(closeDefense, 900);
}
$$('#defenseMoves [data-def-move]').forEach(btn => { btn.onclick = () => sendDefense(btn.dataset.defMove); });
$('#defenseClose').onclick = closeDefense;
$('#defenseDlg').addEventListener('cancel', e => { e.preventDefault(); closeDefense(); });
$('#defenseDlg').addEventListener('click', e => { if (e.target === $('#defenseDlg')) closeDefense(); });

function handleNotice(text, data) {
  if (data && data.kind === 'defenseRequest') { showDefenseRequest(data); return; }
  if (data && data.kind === 'defenseCancel') {
    if (incomingDefense && incomingDefense.requestId === data.requestId) { incomingDefense = null; closeDefense(); }
    showMsg(text);
    return;
  }
  if (data && data.kind === 'defenseResolved') {
    if (incomingDefense && incomingDefense.requestId === data.requestId) { incomingDefense = null; closeDefense(); }
    return;
  }
  showMsg(text);
}
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
  const prePct = t.maxHp > 0 ? (prev * 100) / t.maxHp : 0;
  t.hp = Math.max(0, Math.min(t.maxHp, Math.round(+value || 0)));
  const postPct = t.maxHp > 0 ? (t.hp * 100) / t.maxHp : 0;
  if (t.hp < prev) logEvent(`${t.name} takes ${prev - t.hp} damage (${t.hp}/${t.maxHp}).`);
  else if (t.hp > prev) logEvent(`${t.name} recovers ${t.hp - prev} HP (${t.hp}/${t.maxHp}).`);
  const notices = [];
  if (t.hp < prev) updateHealthStatus(t, prePct, postPct, notices);
  for (const n of notices) logEvent(n);
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
    missionToken(t).items.push(it.name);
    recordMissionAction(t, `Used ${it.name}.`);
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
function clearAllHostiles() {
  if (role !== 'gm' || !map) return;
  const doomed = tokens.filter(t => t.layer === 'gm');
  if (!doomed.length) { showMsg('There are no hostiles to clear.'); return; }
  if (!confirm(`Remove all ${doomed.length} hostile token${doomed.length === 1 ? '' : 's'}?`)) return;
  const ids = new Set(doomed.map(t => t.id));
  tokens = tokens.filter(t => t.layer !== 'gm');
  for (const id of ids) { imgs.delete(id); openStats.delete(id); }
  for (const [id, entry] of [...pendingPlayerAttacks]) {
    if (!ids.has(entry.targetId)) continue;
    pendingPlayerAttacks.delete(id);
    net && net.notify(entry.clientId, 'Your queued attack was cancelled: the target was removed.');
  }
  for (const [id, entry] of [...pendingDefense]) {
    if (!ids.has(entry.attackerId)) continue;
    clearTimeout(entry.timer);
    pendingDefense.delete(id);
    net && net.notify(entry.clientId, 'The incoming attack was cancelled: the attacker was removed.', { kind: 'defenseCancel', requestId: id });
  }
  if (ids.has(selected)) selected = null;
  if (ids.has(turn.activeId)) { turn.activeId = null; turn.moved = {}; turn.attacked = {}; }
  if (hoverTok && ids.has(hoverTok.id)) hoverTok = null;
  logEvent(`GM clears ${ids.size} hostile token${ids.size === 1 ? '' : 's'}.`);
  changed();
  showMsg(`Cleared ${ids.size} hostile token${ids.size === 1 ? '' : 's'}.`);
}
function addToken(layer) {
  if (!map || role !== 'gm') return;
  if (layer === 'player' && tokens.filter(t => t.layer === 'player').length >= MAX_PLAYERS) { showMsg('The table is set for up to ' + MAX_PLAYERS + ' player tokens.'); return; }
  const r = cv.getBoundingClientRect(), size = +$('#newSize').value;
  const n = tokens.filter(t => t.layer === layer).length + 1;
  const name = $('#newName').value.trim() || (layer === 'gm' ? 'Hostile ' : 'Player ') + n;
  const stats = normalizeStats(null, layer, size);
  const derived = computeStats(stats);
  const t = { id: nextId++, layer, mapKey: map.key, status: '', hp: derived.maxHp, maxHp: derived.maxHp, stats, weapon: '', name, color: $('#newColor').value, size, inventory: [], img: '', x: (r.width / 2 - view.x) / view.k, y: (r.height / 2 - view.y) / view.k };
  snapTok(t); tokens.push(t); selected = t.id; $('#newName').value = ''; changed();
}
$('#addPlayer').onclick = () => addToken('player'); $('#addGm').onclick = () => addToken('gm');
$('#clearHostiles').onclick = clearAllHostiles;

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
  const offLevel = t.mapKey && map && t.mapKey !== map.key;
  const status = document.createElement('div'); status.className = 'sub';
  status.textContent = 'HP ' + t.hp + ' / ' + t.maxHp + (t.status ? ' · ' + t.status : '') + (offLevel ? ' · on ' + mapLabel(MAP_BY_ID.get(t.mapKey)) : '');
  body.append(status);
  if (offLevel) {
    const note = document.createElement('div'); note.className = 'sub';
    note.textContent = 'The GM is viewing ' + map.name + '. Your character is on another deck.';
    body.append(note);
  }
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
    t = { id: nextId++, layer: 'player', mapKey: map ? map.key : DEFAULT_MAP_ID, status: '', hp: der.maxHp, maxHp: der.maxHp, stats: st, weapon: 'knife', name: member.name, color: ['#3cc4b1', '#6aa6ff', '#f2a93b', '#c58bff', '#58d68a', '#ff8fa3'][n % 6], size: 1, inventory: [{ name: 'Medkit', qty: 1 }], img: '', x: (map ? map.W / 2 : 552) + (n % 2) * 34, y: (map ? map.H / 2 : 300) + Math.floor(n / 2) * 22 };
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
    const offLevel = map && t.mapKey && t.mapKey !== map.key;
    meta.textContent = (t.layer === 'gm' ? 'hostile' : 'player') + (offLevel ? ` · ${mapLabel(MAP_BY_ID.get(t.mapKey))}` : '') + (turn.activeId === t.id && settings.moveLimit > 0 ? ` · ${fmt(moved)}/${fmt(settings.moveLimit)} sq` : '') + (settings.turnBased && turn.attacked && turn.attacked[t.id] ? ' · attacked' : '');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn tiny' + (turn.activeId === t.id ? ' primary' : '');
    b.textContent = turn.activeId === t.id ? 'Active' : 'Give turn'; b.disabled = isDown(t);
    b.onclick = () => assignTurn(t.id);
    row.append(nm, meta, b); box.append(row);
  }
}
function assignTurn(tokenId) {
  if (role !== 'gm') return;
  if (setupPhase) { showMsg('Begin the mission before assigning turns.'); return; }
  const t = tokenById(tokenId); if (!t) return;
  turn.number++; turn.activeId = tokenId; turn.moved = {}; turn.attacked = {}; selected = tokenId;
  logEvent(`Turn ${turn.number}: ${t.name}.`);
  if (t.mapKey && map && t.mapKey !== map.key) selectMap(t.mapKey, { silent: true });
  changed();
}
function nextTurn(dir) {
  if (role !== 'gm' || !settings.turnBased) return;
  if (setupPhase) { showMsg('Begin the mission before assigning turns.'); return; }
  const alive = tokens.filter(t => !isDown(t));
  if (!alive.length) { showMsg('There is no one left to take a turn.'); return; }
  let idx = alive.findIndex(t => t.id === turn.activeId);
  if (idx < 0) idx = dir > 0 ? -1 : 0;
  const next = alive[(idx + dir + alive.length) % alive.length];
  turn.number++; turn.activeId = next.id; turn.moved = {}; turn.attacked = {}; selected = next.id;
  logEvent(`Turn ${turn.number}: ${next.name}.`);
  if (next.mapKey && map && next.mapKey !== map.key) selectMap(next.mapKey, { silent: true });
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
  const entry = { id: Math.random().toString(36).slice(2), t: Date.now(), text: String(text).slice(0, kind === 'combat' ? 1200 : 300), kind };
  logRows.push(entry);
  if (logRows.length > 90) logRows = logRows.slice(-90);
  mission.events.push(entry);
  if (mission.events.length > 5000) mission.events.splice(0, mission.events.length - 5000);
}
function newMission() {
  return { startedAt: Date.now(), endedAt: null, maps: new Set(), events: [], attacks: [], tokens: new Map() };
}
function resetMission() { mission = newMission(); }
function exportMission() {
  return {
    startedAt: mission.startedAt,
    endedAt: mission.endedAt,
    maps: [...mission.maps],
    events: mission.events.slice(-5000),
    attacks: mission.attacks.slice(-1000),
    tokens: [...mission.tokens.values()].map(r => Object.assign({}, r, {
      stances: Object.assign({}, r.stances),
      items: r.items.slice(-100),
      actions: r.actions.slice(-250)
    }))
  };
}
function importMission(raw) {
  if (!raw || !Number.isFinite(+raw.startedAt)) return false;
  const tokens = new Map();
  for (const r of Array.isArray(raw.tokens) ? raw.tokens : []) {
    if (!r || !Number.isFinite(+r.id)) continue;
    tokens.set(+r.id, Object.assign({
      id: +r.id, name: 'Token', layer: 'gm', mapKey: '', weapon: '', maxHp: 0, hp: 0,
      status: '', startHp: 0, damageDealt: 0, damageTaken: 0, attacksMade: 0, attacksReceived: 0,
      stances: { strike: 0, grapple: 0, counter: 0, none: 0 },
      distance: 0, stairs: 0, items: [], actions: [], firstSeen: +raw.startedAt
    }, r, {
      stances: Object.assign({ strike: 0, grapple: 0, counter: 0, none: 0 }, r.stances || {}),
      items: Array.isArray(r.items) ? r.items : [],
      actions: Array.isArray(r.actions) ? r.actions : []
    }));
  }
  mission = {
    startedAt: +raw.startedAt,
    endedAt: raw.endedAt || null,
    maps: new Set(Array.isArray(raw.maps) ? raw.maps : []),
    events: Array.isArray(raw.events) ? raw.events : [],
    attacks: Array.isArray(raw.attacks) ? raw.attacks : [],
    tokens
  };
  return true;
}
function missionToken(t) {
  if (!t) return null;
  let rec = mission.tokens.get(t.id);
  if (!rec) {
    rec = {
      id: t.id, name: t.name, layer: t.layer, mapKey: t.mapKey, weapon: t.weapon,
      maxHp: t.maxHp, hp: t.hp, status: t.status || '', startHp: t.hp || 0,
      damageDealt: 0, damageTaken: 0, attacksMade: 0, attacksReceived: 0,
      stances: { strike: 0, grapple: 0, counter: 0, none: 0 },
      distance: 0, stairs: 0, items: [], actions: [], firstSeen: Date.now()
    };
    mission.tokens.set(t.id, rec);
  }
  rec.name = t.name; rec.layer = t.layer; rec.mapKey = t.mapKey; rec.weapon = t.weapon;
  rec.maxHp = t.maxHp; rec.hp = t.hp; rec.status = t.status || '';
  return rec;
}
function recordMissionAction(t, text) {
  const rec = missionToken(t);
  if (!rec) return;
  rec.actions.push({ t: Date.now(), text: String(text).slice(0, 300) });
  if (rec.actions.length > 250) rec.actions.splice(0, rec.actions.length - 250);
}
function addMissionDistance(t, squares) {
  if (!t || !Number.isFinite(squares) || squares <= 0) return;
  missionToken(t).distance += squares;
}
function escapeMd(v) { return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim(); }
function clockOf(t) {
  return new Date(t || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function durationText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + sec + 's';
}
function missionDeck(rec) {
  const meta = MAP_BY_ID.get(rec.mapKey);
  return meta ? mapLabel(meta) : 'Custom map';
}
function missionController(rec) {
  if (rec.layer !== 'player') return 'GM';
  const member = roster.find(r => r.tokenId === rec.id);
  return member ? member.name : 'Unassigned';
}
function missionStatus(rec) {
  if (rec.hp <= 0) return 'Down';
  return rec.status || 'Active';
}
function missionWeapon(rec) {
  return (WEAPONS[rec.weapon] || UNARMED).label;
}
function itemSummary(items) {
  const counts = new Map();
  for (const name of items || []) counts.set(name, (counts.get(name) || 0) + 1);
  return [...counts].map(([name, n]) => n > 1 ? `${name} ×${n}` : name).join(', ') || '—';
}
function buildMissionReport() {
  if (map) mission.maps.add(map.key);
  for (const t of tokens) missionToken(t);
  const endedAt = mission.endedAt || Date.now();
  const records = [...mission.tokens.values()].sort((a, b) =>
    (a.layer === b.layer ? a.name.localeCompare(b.name) : a.layer === 'player' ? -1 : 1));
  const players = records.filter(r => r.layer === 'player');
  const hostiles = records.filter(r => r.layer !== 'player');
  const down = r => r.hp <= 0 || /^dead$/i.test((r.status || '').trim());
  const pAlive = players.filter(r => !down(r)).length;
  const hAlive = hostiles.filter(r => !down(r)).length;
  const outcome = !players.length ? 'No player characters' : !pAlive ? 'Mission failure'
    : hostiles.length && !hAlive ? 'Player victory' : 'Mission ended with hostiles still standing';
  const maps = [...mission.maps].map(id => mapLabel(MAP_BY_ID.get(id))).filter(Boolean);
  const session = roomCode ? 'Live session ' + roomCode : 'Solo GM';
  const L = [];
  L.push('# Marine Commander — Mission Combat Log', '');
  L.push('- **Mission started:** ' + new Date(mission.startedAt).toLocaleString());
  L.push('- **Mission ended:** ' + new Date(endedAt).toLocaleString());
  L.push('- **Duration:** ' + durationText(endedAt - mission.startedAt));
  L.push('- **Session:** ' + session);
  L.push('- **Host:** ' + (hostName || me.name || 'GM'));
  L.push('- **Deck(s):** ' + (maps.length ? maps.join(', ') : '—'));
  L.push('- **Outcome:** ' + outcome);
  L.push('- **Players standing:** ' + pAlive + '/' + players.length + ' · **Hostiles standing:** ' + hAlive + '/' + hostiles.length);
  L.push('');

  const writeRoster = (title, list) => {
    L.push('## ' + title, '');
    if (!list.length) { L.push('_None._', ''); return; }
    L.push('| Character | Controller | Deck | HP | Status | Weapon | Damage dealt | Damage taken | Attacks made / suffered | Stances (S/G/C) | Moved (sq) |');
    L.push('| --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const r of list) {
      const st = r.stances || {};
      L.push('| ' + [
        escapeMd(r.name), escapeMd(missionController(r)), escapeMd(missionDeck(r)),
        r.hp + '/' + r.maxHp, escapeMd(missionStatus(r)), escapeMd(missionWeapon(r)),
        fmt(r.damageDealt), fmt(r.damageTaken), r.attacksMade + ' / ' + r.attacksReceived,
        (st.strike || 0) + '/' + (st.grapple || 0) + '/' + (st.counter || 0),
        fmt(r.distance)
      ].join(' | ') + ' |');
    }
    L.push('');
  };
  writeRoster('Player characters', players);
  writeRoster('Hostiles and NPCs', hostiles);

  L.push('## What each combatant did', '');
  for (const r of records) {
    L.push('### ' + r.name + ' — ' + (r.layer === 'player' ? 'player' : 'hostile'));
    const notes = [];
    if (r.items.length) notes.push('Items used: ' + itemSummary(r.items) + '.');
    if (r.stairs) notes.push('Used stairs ' + r.stairs + ' time' + (r.stairs === 1 ? '' : 's') + '.');
    if (r.distance > 0) notes.push('Moved ' + fmt(r.distance) + ' squares.');
    if (r.actions.length) {
      for (const a of r.actions) notes.push('[' + clockOf(a.t) + '] ' + a.text);
    }
    if (!notes.length) notes.push('No recorded actions.');
    for (const n of notes) L.push('- ' + n);
    L.push('');
  }

  L.push('## Combat exchanges', '');
  if (!mission.attacks.length) L.push('_No attacks were made._', '');
  else {
    L.push('| # | Time | Attacker | Target | Attack | Defence | Damage to target | Damage to attacker | Target HP after |');
    L.push('| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- |');
    mission.attacks.forEach((a, i) => {
      L.push('| ' + [
        i + 1, clockOf(a.t), escapeMd(a.attacker), escapeMd(a.target), escapeMd(a.attack),
        escapeMd(a.reaction + (a.aiRoll ? ' (d20 ' + a.aiRoll + ')' : '')),
        fmt(a.damageToTarget), fmt(a.damageToAttacker), a.targetHp + '/' + a.targetMax
      ].join(' | ') + ' |');
    });
    L.push('');
  }

  L.push('## Full mission log', '');
  if (!mission.events.length) L.push('_No events recorded._');
  else {
    for (const e of mission.events) {
      const lines = String(e.text || '').split(/\r?\n/);
      L.push('- **' + clockOf(e.t) + '** [' + (e.kind || 'sys') + '] ' + lines[0]);
      for (const line of lines.slice(1)) L.push('  ' + line);
    }
  }
  L.push('');
  return L.join('\n');
}
function downloadMissionReport() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const text = buildMissionReport();
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'marine-commander-combat-log-' + stamp + '.md';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function endMission() {
  if (!isHost()) return;
  if (setupPhase) { showMsg('Begin the mission before ending it.'); return; }
  if (!confirm('End this mission and download the combat log?')) return;
  mission.endedAt = Date.now();
  logEvent('Mission ended. Combat log downloaded.');
  downloadMissionReport();
  showMsg('Mission ended — combat log downloaded.');
  changed();
}
function updateTurnUI() {
  const active = tokenById(turn.activeId);
  const turnHost = role === 'gm';
  const pill = $('#turnPill'), phase = $('#phasePill');
  let label = '', cls = 'player';
  if (setupPhase) {
    label = turnHost ? 'Setup phase' : 'GM is setting up';
    pill.hidden = true; pill.textContent = label; pill.dataset.kind = 'gm';
    phase.hidden = false; phase.textContent = label; phase.dataset.phase = 'gm';
    $('#turnInfo').textContent = 'Setup';
    $('#endTurn').hidden = true;
    setHint(null);
    return;
  }
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
  if (!net || !map) return;
  const open = !d.open;
  net.sendAction({ type: 'requestDoor', mapKey: map.key, index: d.idx, value: open, label: d.name }).catch(() => {});
  showMsg(`Asked the GM to ${open ? 'open' : 'close'} ${d.name}.`);
}
function requestLight(l) {
  if (!net || !map) return;
  const on = !l.on;
  net.sendAction({ type: 'requestLight', mapKey: map.key, index: l.idx, value: on }).catch(() => {});
  showMsg(`Asked the GM to turn ${on ? 'on' : 'off'} light ${l.idx + 1}.`);
}
function requestActionLabel(req) {
  const target = req.kind === 'door' ? (req.label || ('Door ' + (req.index + 1))) : ('light ' + (req.index + 1));
  return req.kind === 'door' ? `${req.value ? 'open' : 'close'} ${target}` : `turn ${req.value ? 'on' : 'off'} ${target}`;
}
async function showNextHostRequest() {
  if (role !== 'gm' || currentRequest || !hostRequests.length) return;
  currentRequest = hostRequests.shift();
  const req = currentRequest;
  if (map && req.mapKey !== map.key) {
    try { await selectMap(req.mapKey, { silent: true }); } catch (e) { /* popup can still be reviewed */ }
  }
  if (map && map.key === req.mapKey) {
    if (req.kind === 'door') {
      const d = map.doors[req.index];
      if (d) req.label = d.name;
    } else {
      const l = map.lights[req.index];
      if (l) req.label = 'light ' + (req.index + 1);
    }
  }
  $('#requestFrom').textContent = req.player || 'Player';
  $('#requestDeck').textContent = mapLabel(MAP_BY_ID.get(req.mapKey)) || 'Unknown deck';
  $('#requestWhat').textContent = requestActionLabel(req);
  $('#requestQueueInfo').textContent = hostRequests.length ? hostRequests.length + ' more waiting' : '';
  $('#requestReason').value = '';
  const dlg = $('#requestDlg');
  if (!dlg.open) dlg.showModal();
  setTimeout(() => $('#requestReason').focus(), 40);
  invalidate();
}
function respondToHostRequest(approve) {
  const req = currentRequest;
  if (!req) return;
  const reason = $('#requestReason').value.trim().slice(0, 160);
  let applied = false;
  if (approve && map && map.key === req.mapKey) {
    if (req.kind === 'door') {
      const d = map.doors[req.index];
      if (d) {
        d.open = !!req.value;
        rebuildBlockers(); lightDirty = true; updateDoorCount(); applied = true;
      }
    } else {
      const l = map.lights[req.index];
      if (l) {
        l.force = !!req.value;
        lightDirty = true; fogDirty = true; applied = true;
      }
    }
    if (applied) cacheCurrentMapState();
  }
  const action = requestActionLabel(req);
  const result = approve ? (applied ? 'approved' : 'approved, but the target was no longer available') : 'denied';
  const tell = `Your request to ${action} was ${result}.` + (reason ? ' Reason: ' + reason : '');
  net && net.notify(req.clientId, tell);
  logEvent(`GM ${approve ? 'approves' : 'denies'} ${req.player}'s request to ${action}${reason ? ': ' + reason : ''}.`);
  const dlg = $('#requestDlg');
  if (dlg.open) dlg.close();
  currentRequest = null;
  invalidate(); changed();
  setTimeout(showNextHostRequest, 250);
}
$('#requestApprove').onclick = () => respondToHostRequest(true);
$('#requestDeny').onclick = () => respondToHostRequest(false);
$('#requestDlg').addEventListener('cancel', e => e.preventDefault());
$('#requestReason').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); respondToHostRequest(true); }
});
function clearHostRequests() {
  hostRequests = [];
  currentRequest = null;
  const dlg = $('#requestDlg');
  if (dlg.open) dlg.close();
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
async function handleAction(msg) {
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
    case 'requestDoor':
    case 'requestLight': {
      const kind = action.type === 'requestDoor' ? 'door' : 'light';
      const mapKey = MAP_BY_ID.has(action.mapKey) ? action.mapKey : map.key;
      const index = Math.max(0, Math.min(10000, Math.round(+action.index || 0)));
      const value = !!action.value;
      const label = kind === 'door' ? String(action.label || ('Door ' + (index + 1))).slice(0, 40) : ('light ' + (index + 1));
      const req = {
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        clientId, player: member.name, kind, mapKey, index, value, label, queuedAt: Date.now()
      };
      hostRequests.push(req);
      const verb = kind === 'door' ? (value ? 'open' : 'close') : (value ? 'turn on' : 'turn off');
      logEvent(`${member.name} asks the GM to ${verb} ${label}.`);
      net.notify(clientId, 'Your request was sent to the GM.');
      showMsg(`${member.name} asks the GM to ${verb} ${label}.`);
      changed();
      showNextHostRequest();
      return;
    }
    case 'chat': {
      const text = String(action.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
      if (text) { logEvent(`${member.name}: ${text}`, 'chat'); changed(); }
      return;
    }
    case 'defend': {
      const entry = pendingDefense.get(String(action.requestId || ''));
      if (!entry || entry.clientId !== clientId) { net.notify(clientId, 'That defence request is no longer active.'); return; }
      if (!MOVE_LABEL[action.move]) { net.notify(clientId, 'Choose Strike, Grapple or Counter.'); return; }
      resolvePlayerDefense(entry.requestId, action.move);
      return;
    }
    case 'useStair': {
      if (!own || action.tokenId !== own.id) { net.notify(clientId, 'You can only use a stair with your own character.'); return; }
      if (setupPhase) { net.notify(clientId, 'The GM is still setting up the mission.'); return; }
      if (isDown(own)) { net.notify(clientId, 'Your character is down.'); return; }
      const from = own.mapKey || map.key;
      const st = stairsFor(from).find(s => s.id === action.stairId);
      if (!st) { net.notify(clientId, 'That stair is not connected.'); scheduleSync(); return; }
      if (!moveTokenThroughStair(own, st)) { net.notify(clientId, 'Move onto the stair marker first.'); scheduleSync(); return; }
      missionToken(own).stairs++;
      recordMissionAction(own, `Took ${st.name} to ${mapLabel(MAP_BY_ID.get(st.to))}.`);
      logEvent(`${own.name} takes ${st.name} to ${mapLabel(MAP_BY_ID.get(st.to))}.`);
      net.notify(clientId, 'You arrive on ' + mapLabel(MAP_BY_ID.get(st.to)) + '.');
      if (map && map.key === from) await selectMap(st.to, { silent: true });
      else changed();
      return;
    }
    case 'move': {
      if (!own || action.tokenId !== own.id) { net.notify(clientId, 'You can only move your own character.'); return; }
      if (setupPhase) { net.notify(clientId, 'The GM is still setting up the mission.'); return; }
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
      addMissionDistance(own, dist);
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
      missionToken(own).items.push(it.name);
      recordMissionAction(own, `Used ${it.name}.`);
      logEvent(`${member.name} uses ${it.name}.`); changed(); return;
    }
    case 'attack': {
      if (!own || +action.attackerId !== own.id) { net.notify(clientId, 'You can only attack with your own character.'); return; }
      if (setupPhase) { net.notify(clientId, 'The GM is still setting up the mission.'); return; }
      const target = tokenById(+action.targetId);
      if (!target || target.layer !== 'gm') { net.notify(clientId, 'Choose a hostile target.'); return; }
      if (!MOVE_LABEL[action.move]) { net.notify(clientId, 'Choose Strike, Grapple or Counter.'); return; }
      if (pendingAttackFor(own.id)) { net.notify(clientId, 'Your attack is already waiting for the GM.'); scheduleSync(); return; }
      if (settings.turnBased && turn.activeId !== own.id) { net.notify(clientId, 'It is not your turn yet.'); scheduleSync(); return; }
      if (settings.turnBased && turn.attacked && turn.attacked[own.id]) { net.notify(clientId, 'You have already attacked this turn.'); scheduleSync(); return; }
      if (!combatReach(own, target).ok) { net.notify(clientId, own.name + ' is out of reach with a ' + weaponOf(own).label + '.'); scheduleSync(); return; }
      const id = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      pendingPlayerAttacks.set(id, {
        id, clientId, attackerId: own.id, targetId: target.id,
        move: action.move, reaction: 'auto', queuedAt: Date.now()
      });
      if (settings.turnBased) { turn.attacked = turn.attacked || {}; turn.attacked[own.id] = true; }
      logEvent(`${own.name} requests an attack on ${target.name} with ${MOVE_LABEL[action.move]}. Waiting for the GM to set the hostile stance.`);
      net.notify(clientId, 'Attack queued. The GM will set the hostile stance or result and resolve it.');
      changed(); return;
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
    if (sessionRole === 'solo' && map && MAP_BY_ID.has(map.key)) saveSolo();
    else if (sessionRole === 'host') saveHostCheckpoint();
  }, 450);
}
function saveSolo() {
  try {
    const snap = makeSnapshot();
    snap.mission = exportMission();
    localStorage.setItem(STORE_KEY, JSON.stringify(snap));
  } catch (e) { showMsg('Could not save in this browser (storage full). Smaller token images help.'); }
}
function saveHostCheckpoint() {
  if (sessionRole !== 'host' || !map || !MAP_BY_ID.has(map.key)) return;
  try { localStorage.setItem(HOST_SAVE_KEY, JSON.stringify({ room: roomCode, name: me.name, snapshot: makeSnapshot(), mission: exportMission(), ts: Date.now() })); } catch (e) {}
}
function readSaved(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
async function loadSoloSave() {
  const s = readSaved(STORE_KEY);
  if (!s || !MAP_BY_ID.has(s.mapKey) || !Array.isArray(s.tokens)) return false;
  if (!map || map.key !== s.mapKey) await loadMapById(s.mapKey);
  applySnapshot(s, true);
  if (s.mission) importMission(s.mission);
  return true;
}
function loadHostCheckpoint() {
  const s = readSaved(HOST_SAVE_KEY);
  if (!s || !s.room || !s.snapshot || !MAP_BY_ID.has(s.snapshot.mapKey) || !normalizeRoom(s.room)) return null;
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
  clearDefenseRequests();
  clearPendingPlayerAttacks();
  clearHostRequests();
  incomingDefense = null; closeDefense();
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
  if (v) { try { localStorage.setItem(PLAYER_NAME_KEY, v); } catch (e) {} }
  return v;
}
async function ensureMap() {
  if (map) return;
  const meta = MAP_BY_ID.get(DEFAULT_MAP_ID);
  bootStatus('Loading ' + mapLabel(meta) + '…');
  await loadDefaultMap();
}

function openHostGate(action) {
  const expected = String(CFG.hostPassword || '');
  if (!expected || gmUnlocked) { action(); return; }
  pendingHostAction = action;
  const err = $('#gmAuthError');
  err.textContent = '';
  err.dataset.kind = '';
  $('#gmPassword').value = '';
  const dlg = $('#gmAuthDlg');
  if (!dlg.open) dlg.showModal();
  setTimeout(() => $('#gmPassword').focus(), 40);
}
function closeHostGate() {
  pendingHostAction = null;
  const dlg = $('#gmAuthDlg');
  if (dlg.open) dlg.close();
  $('#gmPassword').value = '';
  $('#gmAuthError').textContent = '';
}
function submitHostGate() {
  const expected = String(CFG.hostPassword || '');
  if ($('#gmPassword').value !== expected || !expected) {
    const err = $('#gmAuthError');
    err.textContent = 'That password does not match.';
    err.dataset.kind = 'err';
    $('#gmPassword').select();
    return;
  }
  gmUnlocked = true;
  const action = pendingHostAction;
  closeHostGate();
  if (action) action();
}
$('#gmAuthGo').onclick = submitHostGate;
$('#gmAuthClose').onclick = closeHostGate;
$('#gmAuthCancel').onclick = closeHostGate;
$('#gmPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitHostGate(); }
});
$('#gmAuthDlg').addEventListener('cancel', e => { e.preventDefault(); closeHostGate(); });
$('#gmAuthDlg').addEventListener('click', e => { if (e.target === $('#gmAuthDlg')) closeHostGate(); });

async function startHost(resume) {
  if (busy) return;
  if (!(window.crypto && crypto.subtle)) { bootStatus('Live sync needs a secure page (HTTPS or localhost).', 'err'); return; }
  const name = pickName() || 'GM';
  setBusy(true, 'Opening a live session…');
  try {
    await ensureMap();
    if (!resume) { resetToDefaults(); rev = 0; setupPhase = true; }
    sessionRole = 'host'; role = 'gm'; me.name = name; hostName = name; netState = 'live';
    roomCode = resume ? normalizeRoom(resume.room) : makeRoomCode();
    if (resume) {
      if (resume.snapshot.mapKey && (!map || resume.snapshot.mapKey !== map.key)) await loadMapById(resume.snapshot.mapKey);
      applySnapshot(resume.snapshot, true);
      if (resume.mission) importMission(resume.mission);
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
      onNotice: handleNotice, onStatus: handleNetStatus
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
    resetToDefaults(); rev = 0; setupPhase = true;
    sessionRole = 'solo'; role = 'gm'; me.name = name; hostName = name; roomCode = '';
    const restored = await loadSoloSave();
    if (!restored) logEvent('Solo session started. You are the GM.');
    history.replaceState(null, '', location.pathname + location.search);
    enterGame();
    setBusy(false);
  } catch (err) {
    setBusy(false);
    bootStatus(err.message || 'Could not load the map.', 'err');
  }
}

$('#btnHost').onclick = () => openHostGate(() => startHost(null));
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
$('#btnSolo').onclick = () => openHostGate(startSolo);
$('#btnResume').onclick = () => { const saved = loadHostCheckpoint(); if (saved) openHostGate(() => startHost(saved)); };
$('#playerName').addEventListener('keydown', e => { if (e.key === 'Enter' && $('#joinRow').hidden) openHostGate(() => startHost(null)); });

function roomFromHash() {
  const m = location.hash.match(/(?:room|host)=([A-Za-z0-9-]{9,14})/);
  return m ? normalizeRoom(m[1]) : '';
}

/* ---------- boot ---------- */
$('#darkOut').textContent = '88%'; $('#lscaleOut').textContent = '×2.4'; $('#sightOut').textContent = '40 sq';
try { $('#playerName').value = localStorage.getItem(PLAYER_NAME_KEY) || ''; } catch (e) {}
const hashRoom = roomFromHash();
if (hashRoom && !location.hash.startsWith('#host=')) {
  $('#joinRow').hidden = false;
  $('#roomCode').value = hashRoom;
  setTimeout(() => $('#playerName').focus(), 100);
}
checkResumeAvailability();
setHint(null);

populateMapSelect();
const bootMapPromise = loadDefaultMap().catch(err => {
  bootStatus(err.message || 'Could not load the map.', 'err');
});
window.__marineCommander = {
  get map() { return map; }, get tokens() { return tokens; }, get settings() { return settings; },
  get turn() { return turn; }, get role() { return role; }, get sessionRole() { return sessionRole; }, get setupPhase() { return setupPhase; },
  get roster() { return roster; }, get log() { return logRows; }, get view() { return view; }, get doors() { return map ? map.doors.map(d => ({ name: d.name, open: d.open })) : []; }, get me() { return me; },
  get mission() { return mission; }, buildMissionReport,
  selectMap, useStair, changed
};

window.addEventListener('pagehide', () => { try { if (net) net.disconnect(); } catch (e) {} });
window.addEventListener('beforeunload', () => { try { if (net) net.disconnect(); } catch (e) {} });

})();
