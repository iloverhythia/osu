'use strict';
/* Map catalogue and note chart generation.
   The catalogue (data/maps.js) carries each map's public metadata. The notes a map is played on are generated
   here, deterministically from the map id, so a map always plays the same: its length, note count and pattern
   shares shape the chart, and every note carries the pattern bits the skills test. */

const MAPS = (typeof MAP_CATALOGUE !== 'undefined' ? MAP_CATALOGUE : []).map(m => Object.assign({}, m, { patterns: m.patterns || {} }));
const mapIndex = new Map(MAPS.map(m => [m.id, m]));
const mapById = id => mapIndex.get(id);
const tierOf = map => TIERS.find(t => map.stars >= t.min && map.stars < t.max);
const starTier = stars => TIERS.find(t => stars >= t.min && stars < t.max);
const MIN_JUMP = 1.25;        // moves shorter than this merge into one for aim
const STACK_DIST = 0.15;
const CHORD_GAP = 0.004;      // notes closer in time than this are one chord

// a small seeded generator (mulberry32) so charts are repeatable
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const GRID = [-1, 0, 1];

function buildChart(map) {
  const r = rng(map.id * 2654435761 + 7);
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const length = Math.max(20, map.length || 60);
  const total = Math.max(20, map.notes || Math.round(length * 2));
  const shares = Object.assign({ jumps: 0.1, stacks: 0.05, slides: 0.08, streams: 0.1, bursts: 0.08 }, map.patterns);
  const kinds = Object.keys(shares).filter(k => P[k]);
  const weightSum = kinds.reduce((a, k) => a + shares[k], 0) || 1;
  // notes per second over the map, with a short lead-in and breaks between sections
  const base = length / total;              // mean gap between notes
  const notes = [];
  let t = 1.5, x = 0, y = 0;
  const stepTo = (nx, ny) => { x = Math.max(-1.45, Math.min(1.45, nx)); y = Math.max(-1.45, Math.min(1.45, ny)); };
  const add = (dt, tags) => { t += dt; notes.push({ t, x, y, tags }); };
  const nextCell = far => {
    let nx = x, ny = y, tries = 0;
    while ((nx === x && ny === y) && tries++ < 6) {
      nx = pick(GRID); ny = pick(GRID);
      if (far && Math.hypot(nx - x, ny - y) < 1.4) { nx = -Math.sign(x || 1); ny = pick(GRID); }
    }
    return [nx, ny];
  };
  while (notes.length < total) {
    // weighted pattern choice; the plain cell-to-cell walk fills the rest
    let roll = r() * (weightSum + 0.35), kind = null;
    for (const k of kinds) { roll -= shares[k]; if (roll <= 0) { kind = k; break; } }
    const tired = t > 60 && base < 0.4;
    const st = tired ? P.stamina : 0;
    const gap = base * (0.8 + r() * 0.4);
    switch (kind) {
      case 'jumps': { const [nx, ny] = nextCell(true); stepTo(nx, ny); add(gap * 1.4, P.jumps | st); break; }
      case 'stacks': { const n = 2 + Math.floor(r() * 3); for (let i = 0; i < n; i++) add(i ? gap * 0.5 : gap, P.stacks | st); break; }
      case 'slides': { const dx = pick([-1, 0, 1]), dy = dx ? pick([-1, 0, 1]) : pick([-1, 1]); stepTo(-dx, -dy); add(gap, P.slides | st); for (let i = 0; i < 2; i++) { stepTo(x + dx, y + dy); add(gap * 0.35, P.slides | st); } break; }
      case 'streams': { const n = 8 + Math.floor(r() * 10); for (let i = 0; i < n; i++) { const [nx, ny] = nextCell(false); stepTo(nx, ny); add(i ? gap * 0.45 : gap, P.streams | st | (n > 12 && t > 40 ? P.stamina : 0)); } break; }
      case 'bursts': { const n = 4 + Math.floor(r() * 3); for (let i = 0; i < n; i++) { const [nx, ny] = nextCell(false); stepTo(nx, ny); add(i ? gap * 0.22 : gap, P.bursts | st); } break; }
      case 'walls': { const col = pick(GRID); for (let i = 0; i < 3; i++) { stepTo(col, GRID[i]); add(i ? 0 : gap * 1.2, P.walls | st); } break; }
      case 'spins': { const ring = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]; let k = Math.floor(r() * 8); const n = 6 + Math.floor(r() * 6), dir = r() < 0.5 ? 1 : -1; for (let i = 0; i < n; i++) { k = (k + dir + 8) % 8; stepTo(ring[k][0], ring[k][1]); add(i ? gap * 0.5 : gap, P.spins | st); } break; }
      case 'vibros': { const n = 6 + Math.floor(r() * 6), side = pick(GRID); for (let i = 0; i < n; i++) { stepTo(i % 2 ? 1 : -1, side); add(i ? gap * 0.3 : gap, P.vibros | st); } break; }
      case 'quantum': { stepTo(Math.round(r() * 4 - 2) / 2, Math.round(r() * 4 - 2) / 2); add(gap, P.quantum | st); break; }
      case 'offgrid': { stepTo(pick([-1.35, 1.35]), r() * 2 - 1); add(gap, P.offgrid | P.quantum | st); break; }
      case 'techs': { const n = 3 + Math.floor(r() * 3); for (let i = 0; i < n; i++) { const [nx, ny] = nextCell(r() < 0.5); stepTo(nx, ny); add(gap * (i ? pick([0.25, 0.75, 0.5]) : 1), P.techs | st); } break; }
      case 'unconv': { const n = 5 + Math.floor(r() * 6); for (let i = 0; i < n; i++) { stepTo(r() * 2.4 - 1.2, r() * 2.4 - 1.2); add(gap * (i ? 0.3 + r() * 0.5 : 1.2), P.unconv | P.techs | st); } break; }
      case 'stamina': { const n = 10 + Math.floor(r() * 10); for (let i = 0; i < n; i++) { const [nx, ny] = nextCell(false); stepTo(nx, ny); add(i ? gap * 0.5 : gap, P.stamina | P.streams); } break; }
      case 'oneshot': { const [nx, ny] = nextCell(true); stepTo(nx, ny); add(gap * 1.5, P.oneshot | st); break; }
      default: { const [nx, ny] = nextCell(false); stepTo(nx, ny); add(gap, st); }
    }
    if (r() < 0.04) t += base * 4;   // a short break
  }
  notes.length = total;
  // fit the chart to the map's length
  const span = notes[notes.length - 1].t - notes[0].t || 1, scale = Math.max(0.3, (length - 2.5) / span);
  const t0 = notes[0].t;
  for (const n of notes) n.t = 1.5 + (n.t - t0) * scale;
  return finishChart(notes);
}

// derived per-note values: index, distance from the last note, the jump aim sees, and local reading density
function finishChart(notes) {
  let anchor = null;
  notes.forEach((n, i) => {
    const prev = notes[i - 1];
    n.i = i;
    n.dist = prev ? Math.hypot(n.x - prev.x, n.y - prev.y) : 0;
    const fromAnchor = anchor ? Math.hypot(n.x - anchor.x, n.y - anchor.y) : 0;
    n.jump = fromAnchor >= MIN_JUMP ? fromAnchor : 0;
    if (!anchor || n.jump) anchor = n;
  });
  const readWeight = d => d < STACK_DIST ? 0.1 : Math.min(1, 0.35 + 0.65 * d);
  const moments = new Float64Array(notes.length + 1), mw = new Float64Array(notes.length);
  for (let k = 0; k < notes.length; k++) {
    const start = k === 0 || notes[k].t - notes[k - 1].t >= CHORD_GAP;
    mw[k] = !start ? mw[k - 1] : k === 0 ? 1 : readWeight(notes[k].dist);
    moments[k + 1] = moments[k] + (start ? mw[k] : 0);
  }
  let lo = 0, hi = 0;
  for (const n of notes) {
    while (notes[lo].t < n.t - 0.5) lo++;
    while (hi < notes.length && notes[hi].t <= n.t + 0.5) hi++;
    n.nps = moments[hi] - moments[lo];
  }
  return notes;
}

const chartCache = new Map();
function notesFor(map) {
  let c = chartCache.get(map.id);
  if (!c) {
    c = buildChart(map);
    chartCache.set(map.id, c);
    if (chartCache.size > 40) chartCache.delete(chartCache.keys().next().value);
  }
  return c;
}

// profile rows for the play view: how much of each skill every slice of the map asks for
const PROFILE_BINS = 64;
function buildProfile(notes, patternSkills) {
  const end = notes.length ? notes[notes.length - 1].t : 1, rows = {};
  const add = (k, i, v) => { (rows[k] = rows[k] || new Array(PROFILE_BINS).fill(0))[i] += v; };
  for (const n of notes) {
    const i = Math.min(PROFILE_BINS - 1, Math.floor(n.t / end * PROFILE_BINS));
    add('reading', i, 1);
    add('aim', i, n.jump);
    for (const s of patternSkills) if (n.tags & s.bits) add(s.id, i, 1);
  }
  return { end, rows };
}

/* Daily maps: one ranked map per tier each UTC day, and the day's mod, the same for everyone. */
const DAILY = (() => {
  const TIER_RANGES = [['beginner', 0.5, 2.2], ['intermediate', 3, 5], ['hard', 5, 7], ['expert', 7, Infinity]];
  const DAY_MODS = ['', 'hr', 'ghost', 'chaos', 'spin', 'mirror', ''];
  const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  function pick(day) {
    const list = MAPS.filter(m => m.status === 'ranked' && m.length >= 45 && m.length <= 240).sort((a, b) => a.id - b.id);
    const out = {};
    for (const [t, lo, hi] of TIER_RANGES) {
      const pool = list.filter(m => m.stars >= lo && m.stars < hi);
      if (pool.length) out[t] = pool[hash(day + ':' + t) % pool.length].id;
    }
    return { day, maps: out, mod: DAY_MODS[hash(day + ':mod') % DAY_MODS.length] };
  }
  const WEEK_MS = 7 * 864e5;
  const weekStart = (t = Date.now()) => { const d = Math.floor(t / 864e5); return (d - (d + 3) % 7) * 864e5; };
  const weekEnd = (t = Date.now()) => weekStart(t) + WEEK_MS;
  function weekKey(t = Date.now()) {
    const thu = new Date(weekStart(t) + 3 * 864e5), y = thu.getUTCFullYear();
    const w = 1 + Math.floor((thu - Date.UTC(y, 0, 1)) / WEEK_MS);
    return y + '-W' + String(w).padStart(2, '0');
  }
  function pickWeekly(week) {
    const list = MAPS.filter(m => m.status === 'ranked' && m.length >= 60 && m.length <= 240).sort((a, b) => a.id - b.id);
    let pool = list.filter(m => m.stars >= 4 && m.stars <= 6);
    if (!pool.length) pool = list;
    return { week, mapId: pool.length ? pool[hash('weekly:' + week) % pool.length].id : null };
  }
  return { dayKey, pick, hash, weekStart, weekEnd, weekKey, pickWeekly, WEEK_MS };
})();
