'use strict';
/* Game engine: state, formulas, the autoplaying bot, progression layers, save and offline catch-up.
   No DOM here; the UI listens through Engine.on(). */

const ALL_SKILLS = SKILLS.slice();
const skillById = id => ALL_SKILLS.find(s => s.id === id) || ASC_SKILLS.find(s => s.id === id);
const activeSkills = () => ALL_SKILLS;
let PATTERN_SKILLS = ALL_SKILLS.filter(s => s.bits);
const patternSkills = () => PATTERN_SKILLS;
const ascSkillsOn = () => ALL_SKILLS.includes(ASC_SKILLS[0]);
function ascSkillsOpen() {
  if (ascSkillsOn()) return;
  ALL_SKILLS.push(...ASC_SKILLS);
  SKILL_GROUPS.push(ASC_GROUP);
  PATTERN_SKILLS = ALL_SKILLS.filter(s => s.bits);
}

/* ---------- settings ---------- */
const SETTING_DEFAULTS = {
  titleOnStart: true, autoContinue: true, keepPlaying: true, autoGear: 'always', awayPick: 'smart', awayLen: 'any', autoModMode: 'smart', autoModList: 'hr',
  submitScores: true, appearOffline: false, thumbnails: true, reduceMotion: false, numFormat: 'short',
  cursorSize: 1, trail: true, trailLength: 14, cursorStyle: 'cube', cursorColor: '#ffffff', cursorGlow: true, trailStyle: 'solid', trailColor: '#cfd9ff', trailColor2: '#ff8fc8', trailAlpha: 0.55,
  gridLines: true, gridBorder: true, gridColor: '#aabeff', gridAlpha: 0.16, borderColor: '#f5f5ff',
  noteSet: 'rhythia', noteColorA: '#8aa4ff', noteColorB: '#ff8fc8', noteShape: 'rounded', noteFill: true, noteGlow: true, missColor: '#ff4f6d',
  bgStyle: 'cover', bgColor: '#101020', bgColor2: '#3a1450', bgDim: 0.8, parallax: true, mapBg: true,
  wRp: true, wStats: false, wMedals: true,
  accentColor: '#ff5fa2', accentColor2: '#5fd4ff', textColor: '#ecebf5', hudColor: '#ffffff', panelColor: '#12121b',
  musicOn: false, master: 0.8, music: 0.5, effects: 0.7,
  hideChat: false, hideNames: false, playfield: 'grid', approachRate: 1, spawnDistance: 1, missFx: true, hints: true, greet: true,
  playerName: '',
};
const settings = Object.assign({}, SETTING_DEFAULTS);
const NOTE_SETS = {
  rhythia: { name: 'Rhythia', colors: ['#8aa4ff', '#ff8fc8'] }, mono: { name: 'Mono', colors: ['#ffffff', '#c9d4ff'] },
  sunset: { name: 'Sunset', colors: ['#ffb36b', '#ff4f6d'] }, mint: { name: 'Mint', colors: ['#7fe0c4', '#5fd4ff'] },
  gold: { name: 'Gold', colors: ['#ffd54f', '#ff8a3d'] }, custom: { name: 'Custom (pick below)', colors: null },
};

/* ---------- state ---------- */
function freshSkills(instincts = {}) {
  const out = {};
  for (const s of ALL_SKILLS) out[s.id] = { lvl: 5 * ((instincts[s.id] || {}).headstart || 0) + quickLvls(), xp: 0 };
  return out;
}
function starterMap() {
  const pool = MAPS.filter(m => m.status === 'ranked' && m.stars < 1 && m.length < 150);
  return (pool.sort((a, b) => b.plays - a.plays)[0] || MAPS[0]).id;
}
function defaultMods() { return { nofail: false, sd: false, hr: false, ghost: false, chaos: false, spin: false, mirror: 0, anon: false }; }
function defaultState() {
  return {
    points: 0, totalEarned: 0,
    skills: freshSkills(), gear: {}, instincts: {}, perks: {}, prestige: {},
    rebirths: 0, rebirthAt: 0, ascensions: 0, trial: null, relics: {}, relicsOn: [], transcends: 0, echoes: 0, echoTree: {},
    instinctPts: 0,
    best: {}, history: {}, mastery: {},
    stars: 0, seasons: 0,
    selectedMap: starterMap(), queue: [], speed: 1, mods: defaultMods(),
    warm: 0,
    player: null,
    filter: { tier: 'beginner', status: 'all', sort: 'stars', q: '' },
    tab: 'skills', ppsAvg: 0, lastTime: Date.now(),
    stats: { plays: 0, passes: 0, hits: 0, time: 0 },
    createdAt: Date.now(), rpLog: [], titleLog: [],
    daily: null, weekly: null, weeklyBadges: 0, streak: { count: 0, best: 0, last: null },
    ach: {}, seasonLog: [], seasonStart: { at: Date.now(), plays: 0 },
    comeback: null,
    shop: {}, starsSpent: 0, starsEver: 0, devotion: {},
    shardsEarned: 0, shardsSpent: 0, shardUnlocks: {}, overdrive: 0,
    playlists: [], playlistOn: null,
    goals: { at: 0, mod: false },
    globalRank: null, chat: [],
  };
}
const SEASON_KEEP = ['perks', 'prestige', 'rebirths', 'rebirthAt', 'playlists', 'playlistOn', 'shop', 'starsSpent', 'starsEver', 'devotion',
  'shardsEarned', 'shardsSpent', 'shardUnlocks', 'overdrive', 'ascensions', 'trial', 'relics', 'relicsOn', 'transcends', 'echoes', 'echoTree',
  'goals', 'mastery', 'ach', 'seasonLog', 'weeklyBadges', 'streak', 'daily', 'weekly', 'globalRank', 'chat', 'player'];

let state = defaultState();
let run = null;
let totalRpCache = 0;
let simulating = false;
const cursor = { x: 0, y: 0, vx: 0, vy: 0, trail: [], sx: NaN, sy: NaN, svx: 0, svy: 0 };
const fx = [];
const recentPlays = [];
const levelUps = [];
const listeners = {};
const Engine = {
  on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
  emit: (ev, ...a) => { for (const f of listeners[ev] || []) f(...a); },
};

/* ---------- lookups ---------- */
const instinct = (skill, id) => (state.instincts[skill] || {})[id] || 0;
const skillLvl = id => (state.skills[id] || { lvl: 0 }).lvl;
const effLvl = id => skillLvl(id) + 3 * instinct(id, 'gifted') + prestigeOf(id);
const perkRank = id => (state.perks || {})[id] || 0;
const shopRank = id => (state.shop || {})[id] || 0;
const prestigeOf = id => Math.min(PRESTIGE.max, (state.prestige || {})[id] || 0);
const prestigeReq = id => PRESTIGE.lvl + PRESTIGE.step * prestigeOf(id);
const prestigeReady = id => prestigeOf(id) < PRESTIGE.max && skillLvl(id) >= prestigeReq(id);
const echoRank = id => (state.echoTree || {})[id] || 0;
const memoryKeep = () => [0, 3, 5][echoRank('memory')];
const unlocked = id => { const i = REBIRTH_UNLOCKS.findIndex(u => u.id === id); return i >= 0 && i < Math.max(state.rebirths || 0, memoryKeep()); };
const rebirthSeasons = () => (state.rebirths || 0) >= 10 ? REBIRTH.seasonsLate : REBIRTH.seasons;
const seasonsSinceRebirth = () => state.seasons - (state.rebirthAt || 0);
const rebirthReady = () => seasonsSinceRebirth() >= rebirthSeasons();
const heirloomShare = () => unlocked('keeper') ? 0.4 : unlocked('heirloom') ? 0.2 : 0;
const offlineCap = () => CONFIG.offlineCapHours + (unlocked('longer') ? 4 : 0) + perkRank('nightowl') + shopRank('nightshift');
const kitTiers = () => unlocked('fullkit') ? 6 : unlocked('kit') ? 3 : 0;
function quickLvls() { try { return unlocked('quick') ? 10 : 0; } catch (e) { return 0; } }
const milestoneHave = id => { const m = STAR_MILESTONES.find(x => x.id === id); return !!m && (state.starsEver || 0) >= m.at; };
const perkMax = d => d.max + (unlocked('deep') ? 2 : 0) + (unlocked('deeper') ? 2 : 0) + (milestoneHave('perk') ? 1 : 0);
const instMax = d => d.max + (d.craft || d.twig ? 0 : (unlocked('deep') ? 2 : 0) + (unlocked('deeper') ? 2 : 0));
const starWallet = () => Math.max(0, (state.stars || 0) - (state.starsSpent || 0));
const shopDiscount = () => (1 - 0.05 * perkRank('patron')) * (milestoneHave('cheap') ? 0.9 : 1) * (milestoneHave('cheap2') ? 0.9 : 1);
const shopCost = d => Math.max(1, Math.round(d.cost(shopRank(d.id)) * shopDiscount()));
const devotionMax = () => 50 + (unlocked('devout') ? 25 : 0) + (unlocked('zealot') ? 25 : 0);
const devotionOf = id => (state.devotion || {})[id] || 0;
const devotionCost = id => Math.max(1, 4 + Math.floor(devotionOf(id) / 5) - (milestoneHave('devote') ? 1 : 0));
const devotionOpen = id => instinct(id, 'natural') >= instMax(INSTINCTS[0]);
const shardWallet = () => Math.max(0, (state.shardsEarned || 0) - (state.shardsSpent || 0));
const shardHas = id => !!(state.shardUnlocks && state.shardUnlocks[id]);
const speedOpen = sp => !sp.shard || shardHas(sp.shard);
const modOpen = m => !m.shard || shardHas(m.shard);
const shardReady = u => !shardHas(u.id) && (!u.after || shardHas(u.after));
const overdriveLeft = () => Math.max(0, (state.overdrive || 0) - Date.now());
const overdriveXpMult = () => !simulating && overdriveLeft() > 0 ? 2 : 1;
const ascRank = () => state.ascensions || 0;
const ascendReady = () => (state.rebirths || 0) >= ASCEND.rebirths;
const transcendNext = () => TRANSCEND.asc * ((state.transcends || 0) + 1);
const transcendReady = () => (state.ascensions || 0) >= transcendNext();
const trialDef = () => state.trial && TRIALS.find(x => x.id === state.trial.id);
const trialOn = id => { const t = trialDef(); return !!t && (t.id === id || (t.rules || []).includes(id)); };
const trialOpen = x => ascRank() >= (x.asc || 1) && (!x.mod || modOpen(MODS.find(m => m.id === x.mod)));
const trialGoal = () => ASCEND.trialGoal * (echoRank('focus') ? 0.5 : 1);
const relicSlots = () => ASCEND.relicSlots + (ascRank() >= 2 ? 1 : 0) + (ascRank() >= 4 ? 1 : 0) + echoRank('relic');
const relicOn = id => !!(state.relicsOn || []).includes(id) && !!(state.relics || {})[id];
const relicLvl = id => relicOn(id) ? (state.relics[id] >= 2 ? 2 : 1) : 0;
const relicXp = id => (id === 'reading' && relicOn('lantern')) || (id === 'consistency' && relicOn('shutter')) || (id === 'precision' && relicOn('scope')) ? 2 : 1;
const ascMult = () => Math.pow(ASCEND.mult, state.ascensions || 0) * Math.pow(TRANSCEND.mult, state.transcends || 0) * Math.pow(1.5, echoRank('resonance'));

/* ---------- mods ---------- */
const PLUS_OF = { hr: 'hr2', ghost: 'ghost2', chaos: 'chaos2', spin: 'spin2' };
const modOn = (mods, id) => !!(mods[id] || (PLUS_OF[id] && mods[PLUS_OF[id]]));
const modStarMult = mods => MODS.reduce((a, m) => a * (mods[m.id] && m.stars ? m.stars : 1), 1);
const modPointsMult = mods => MODS.reduce((a, m) => a * (mods[m.id] ? m.points : 1), 1);
const modClash = (a, b) => (a.excludes || []).includes(b.id) || (b.excludes || []).includes(a.id);
const sdLike = mods => !!(mods.sd || mods.pf);
const shownStars = (map, speed = state.speed, mods = state.mods) => map.stars * speed * modStarMult(mods);
const modShort = mods => MODS.filter(x => mods[x.id]).map(x => x.short).join(' ');
const activeMods = mods => MODS.filter(x => x.id !== 'anon' && mods[x.id]).map(x => x.id);
function toggleMod(id) {
  const m = MODS.find(x => x.id === id);
  if (!m || !modOpen(m)) return false;
  if (m.cycle) { state.mods[id] = ((state.mods[id] || 0) + 1) % m.cycle.length; return true; }
  const on = !state.mods[id];
  state.mods[id] = on;
  if (on) for (const o of MODS) if (o !== m && modClash(m, o)) state.mods[o.id] = o.cycle ? 0 : false;
  return true;
}

/* ---------- formulas ---------- */
function playRp(stars, acc, speed, misses, nofail) {
  let s = stars * speed;
  if (nofail) s *= Math.pow(0.95, misses);
  const e = Math.max(5, 100 - 12 * s);
  const ease = acc === 0 ? 0 : Math.pow(2, e * acc - e);
  return Math.round(Math.pow(s * ease * 100 / 2, 2) / 1000) * 2;
}
const rawRp = (s, acc) => { const e = Math.max(5, 100 - 12 * s); return Math.pow(s * Math.pow(2, e * acc - e) * 50, 2) / 500; };
function computeTotalRp() {
  const rps = Object.values(state.best).map(b => b.rp).filter(Number.isFinite).sort((a, b) => b - a);
  let total = 0;
  for (let i = 0; i < rps.length && i < CONFIG.rpMaxPlays; i++) total += rps[i] * Math.pow(CONFIG.rpWeight, i);
  return total;
}
const totalRp = () => totalRpCache;
const rank = (rp = totalRp()) => {
  const gm = rp >= RANKS[4].rp && state.globalRank && state.globalRank <= GRANDMASTER_TOP;
  return gm ? RANKS[5] : RANKS.slice(0, 5).filter(r => rp >= r.rp).pop();
};
const nextRank = (rp = totalRp()) => RANKS.slice(0, 5).find(r => r.rp > rp) || null;

const cursorSpeed = (L = effLvl('aim')) => 4 * Math.pow(1.06, L) * (1 + 0.02 * state.stars);
const hitbox = (L = effLvl('precision')) => 0.45 + 0.5 * (1 - Math.pow(0.96, L));
const readCap = (L = effLvl('reading')) => Math.max(3.5, 2 + 0.3 * L);
const baseMiss = (L = effLvl('consistency')) => Math.min(0.015, 0.04 * Math.pow(0.92, L));
const patternMiss = L => Math.min(0.03, 0.08 * Math.pow(0.92, L));
const patRead = L => 1 + Math.min(1, 0.02 * L);
const stackRead = L => 1 + Math.min(2, 0.04 * L);
const DENSE_READ = [['streams', P.streams, patRead], ['bursts', P.bursts | P.walls, patRead], ['vibros', P.vibros, patRead], ['spins', P.spins, patRead],
  ['quantum', P.quantum | P.offgrid, patRead], ['stacks', P.stacks, stackRead], ['slides', P.slides, stackRead]];
const denseRead = note => DENSE_READ.reduce((m, [id, bits, f]) => note.tags & bits ? Math.max(m, f(effLvl(id))) : m, 1);
const fatigueStart = (L = effLvl('stamina')) => Math.max(60, 30 + 3 * L);
const fatigueRate = (L = effLvl('stamina')) => Math.min(0.0008, 0.0015 * Math.pow(0.95, L));
const missDamage = () => CONFIG.health / CONFIG.missesToFail;
const xpNeeded = l => CONFIG.xpBase * Math.pow(CONFIG.xpGrowth, l);
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const skillEffect = (id, L) => {
  switch (id) {
    case 'aim': return `Cursor speed ${cursorSpeed(L).toFixed(1)} cells/s`;
    case 'precision': return `Hitbox ${hitbox(L).toFixed(2)} cells`;
    case 'reading': return `Comfortable up to ${readCap(L).toFixed(1)} notes/s`;
    case 'consistency': return `${pct(baseMiss(L), 2)} random misses`;
    case 'stamina': return `Tires after ${fatigueStart(L).toFixed(0)}s · ${pct(patternMiss(L), 1)} on stamina sections`;
    case 'stacks': case 'slides': return `+${pct(patternMiss(L), 1)} miss chance, ×${stackRead(L).toFixed(2)} reading cap on them`;
    case 'jumps': case 'techs': case 'unconv': case 'oneshot': return `+${pct(patternMiss(L), 1)} miss chance on them`;
    default: return `+${pct(patternMiss(L), 1)} miss chance, ×${patRead(L).toFixed(2)} reading cap on them`;
  }
};

// gear
const gearReq = tier => Math.max(1, Math.round(tier * 10 / 3 - 5 / 3));
const gearMax = id => GEAR[id].length + prestigeOf(id);
const gearName = (id, t) => t < GEAR[id].length ? GEAR[id][t] : `${GEAR[id][GEAR[id].length - 1]} ${ROMAN[t - GEAR[id].length + 2] || '+' + (t - GEAR[id].length + 1)}`;
const gearCost = (skillIdx, tier) => 5 * Math.pow(2.55, tier) * (1 + skillIdx * 0.05) * (1 - 0.08 * perkRank('bargain'));
const SET_STEP = 5, SET_MULT = 1.15;
const groupOf = id => SKILL_GROUPS.find(g => g.ids.includes(id));
const setLevel = g => g ? Math.floor(Math.min(...g.ids.map(id => state.gear[id] || 0)) / SET_STEP) : 0;
const setXpMult = id => Math.pow(SET_MULT, setLevel(groupOf(id)));
const gearXpMult = id => trialOn('bare') ? 1 : Math.pow(CONFIG.gearMult, state.gear[id] || 0) * setXpMult(id);
const instinctXpMult = id => 1 + 0.3 * instinct(id, 'natural') + 0.1 * instinct(id, 'study');
const starXpMult = () => 1 + (0.1 + 0.01 * perkRank('starstruck')) * state.stars;
const prestigeXpMult = id => Math.pow(PRESTIGE.xp, prestigeOf(id));
const rebirthXpMult = () => Math.pow(REBIRTH.xp, state.rebirths || 0) * (unlocked('second') ? 1.5 : 1) * (unlocked('mythic') ? 1.5 : 1);
const warmXpMult = () => state.warm >= 1 ? 1.25 : state.warm >= 0.6 ? 1.12 : state.warm >= 0.2 ? 1.05 : 1;
const shopXpMult = id => (1 + 0.1 * shopRank('coach')) * (1 + 0.08 * perkRank('scholar')) * (1 + 0.06 * devotionOf(id))
  * (milestoneHave('xp1') ? 1.05 : 1) * (milestoneHave('xp2') ? 1.25 : 1) * (milestoneHave('xp3') ? 1.5 : 1) * (milestoneHave('xp4') ? 2 : 1);
const xpMult = id => gearXpMult(id) * instinctXpMult(id) * starXpMult() * prestigeXpMult(id) * rebirthXpMult() * warmXpMult() * shopXpMult(id) * overdriveXpMult() * ascMult() * relicXp(id);

const comboMult = combo => 1 + Math.min(combo / 100, 1);
const rpPointsMult = () => 1 + totalRp() / 1000;
const starPointsMult = () => 1 + 0.25 * state.stars;
const mapPointsMult = (stars, speed) => Math.pow(Math.max(0.5, stars) * speed, 1.5);
const comebackActive = () => !simulating && !!state.comeback && Date.now() < state.comeback.until;
const incomeBoost = () => (1 + 0.15 * perkRank('crowd')) * (unlocked('encore') ? 2 : 1) * (unlocked('legend') ? 3 : 1) * (unlocked('ovation') ? 4 : 1) * (unlocked('mythic') ? 5 : 1)
  * (1 + 0.2 * shopRank('sponsor')) * (milestoneHave('pts') ? 1.1 : 1) * (milestoneHave('pts2') ? 1.25 : 1) * ascMult() * (comebackActive() ? state.comeback.mult : 1);
const pointsPerHit = (r, combo) => comboMult(combo) * mapPointsMult(r.map.stars, r.speed) * rpPointsMult() * starPointsMult() * modPointsMult(r.mods);
const seasonStars = (rp = totalRp()) => rp < CONFIG.seasonMinRp ? 0 : Math.floor(Math.pow(rp / 2000, 1.6) * (unlocked('bright') ? 1.25 : 1) * (unlocked('brighter') ? 1.25 : 1) * (unlocked('brightest') ? 1.25 : 1));
const warmMult = () => 1.15 - 0.3 * state.warm;

// craft and twigs, active in their moment
const CRAFT_WHEN = {
  always: () => true, combo: () => run.combo >= 100, after: () => run.time - (run.lastMissT ?? -1e9) < 3,
  start: () => run.time < 30, end: () => run.time > 0.9 * run.map.length, warm: () => state.warm >= 1, fast: () => run.speed > 1,
  hr: () => modOn(run.mods, 'hr'), ghost: () => modOn(run.mods, 'ghost'), spin: () => modOn(run.mods, 'spin'), later: () => false,
};
function craftNow(id) {
  if (!run) return 0;
  const owned = instinct(id, 'craft'), list = CRAFT[id] || [];
  let sum = 0;
  for (let k = 0; k < owned && k < list.length; k++) if (CRAFT_WHEN[list[k][1]]()) sum += list[k][2];
  const boost = TWIG_BOOST.has(id);
  sum += (boost ? 0.02 : 0.03) * instinct(id, 'clean');
  if (run.health < CONFIG.health / 2) sum += (boost ? 0.03 : 0.05) * instinct(id, 'clutch');
  return sum;
}
const craftCut = id => Math.max(0.3, 1 - craftNow(id));
const craftBoost = id => 1 + craftNow(id);
const craftLater = () => 1 + (instinct('stamina', 'craft') >= 1 ? CRAFT.stamina[0][2] : 0);
const twigText = (sid, id) => {
  const strong = { aim: ['Cursor', 'faster'], precision: ['Hitbox', 'bigger'], reading: ['Reads', 'denser'] }[sid];
  const n = TWIG_BOOST.has(sid) ? (id === 'clutch' ? 3 : 2) : (id === 'clutch' ? 5 : 3);
  if (id === 'tough') return 'Its misses cost 8% less health';
  if (id === 'study') return '+10% XP';
  const tail = id === 'clutch' ? ' below half health' : '';
  if (strong) return `${strong[0]} ${n}% ${strong[1]}${tail}`;
  const what = sid === 'consistency' ? 'random' : sid === 'stamina' ? 'tired' : skillById(sid).name.toLowerCase();
  return `${n}% fewer ${what} misses${tail}`;
};

const mf = (tbl, mods) => Object.keys(tbl).reduce((a, k) => a * (mods[k] ? tbl[k] : 1), 1);
const runHitbox = () => hitbox() * mf(MOD_FX.hitbox, run.mods) * craftBoost('precision');
const runReadCap = () => readCap() * mf(MOD_FX.read, run.mods) * (run.mods.bl ? 1 - MOD_FX.blindRead * (run.blind || 0) : 1) * craftBoost('reading');
const runCursorSpeed = () => cursorSpeed() / mf(MOD_FX.field, run.mods) * mf(MOD_FX.aim, run.mods) * craftBoost('aim');
const missScale = () => Math.pow(run.speed, CONFIG.speedMissExp) * warmMult() * (1 - 0.05 * perkRank('steady'));

function notePos(n, t) {
  let x = n.x, y = n.y;
  if (run.mods.mirror & 1) x = -x;
  if (run.mods.mirror & 2) y = -y;
  if (run.mods.spin || run.mods.spin2) {
    const a = t * (run.mods.spin2 ? MOD_FX.spin2Rate : MOD_FX.spinRate), c = Math.cos(a), s = Math.sin(a);
    [x, y] = [x * c - y * s, x * s + y * c];
  }
  return [x, y];
}

// which pattern skills a map trains (its biggest pattern shares, long maps always Stamina)
const TRAIN_SHARE = 0.15, MAX_TRAINS = 4, LONG_MAP = 180;
const TRAIN_SHARE_OF = { stamina: 0.08, jumps: 0.29, streams: 0.24, slides: 0.09, bursts: 0.31, spins: 0.12, vibros: 0.02, stacks: 0.05, quantum: 0.05, oneshot: 9, techs: 0.05, unconv: 0.02 };
function skillShare(map, id) {
  const s = skillById(id);
  if (!s || !s.bits) return 0;
  if (id === 'stamina') return map.length / 600;
  return Object.entries(map.patterns || {}).reduce((a, [k, v]) => a + (s.bits & P[k] ? v : 0), 0);
}
function mapTrains(map, n = MAX_TRAINS) {
  return patternSkills()
    .map(s => ({ s, share: Object.entries(map.patterns || {}).reduce((a, [k, v]) => a + (s.bits & P[k] ? v : 0), 0) }))
    .map(x => x.s.id === 'stamina' && map.length >= LONG_MAP ? { s: x.s, share: Math.max(x.share, TRAIN_SHARE) } : x)
    .filter(x => x.share >= (TRAIN_SHARE_OF[x.s.id] || TRAIN_SHARE))
    .sort((a, b) => b.share - a.share).slice(0, n).map(x => x.s);
}
function grade(acc) { return acc >= 1 ? 'SS' : acc >= 0.98 ? 'S' : acc >= 0.95 ? 'A' : acc >= 0.9 ? 'B' : acc >= 0.8 ? 'C' : 'D'; }

/* ---------- formatting ---------- */
const SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
function fmt(n, dec = 0) {
  if (!isFinite(n)) return '∞';
  if (n < 1000) return dec && n < 100 ? (+n.toFixed(dec)).toString() : Math.floor(n).toString();
  if (settings.numFormat === 'full' && n < 1e15) return Math.floor(n).toLocaleString('en-US');
  if (settings.numFormat === 'sci') return n.toExponential(2).replace('+', '');
  const e = Math.floor(Math.log10(n) / 3);
  if (e < SUFFIX.length) return (n / Math.pow(1000, e)).toFixed(2) + SUFFIX[e];
  return n.toExponential(2).replace('+', '');
}
function fmtTime(sec) { const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return h ? `${h}h ${m}m` : m ? `${m}m ${Math.floor(sec % 60)}s` : `${Math.floor(sec)}s`; }
const fmtLen = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const clock = sec => fmtLen(Math.max(0, sec)).padStart(5, '0');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ---------- the play ---------- */
const FIELD_EDGE = 1.4, NOTE_HALF = 0.42, AIM_PEAK = 1.6, CURSOR_SPRING = 40;
const gauss = () => { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); };
let pendingMods = null, pendingSpeed = null;

function startRun() {
  const map = mapById(state.selectedMap) || mapById(starterMap());
  const mods = Object.assign({}, pendingMods || state.mods, state.mods.mirror ? { mirror: state.mods.mirror } : {});
  run = {
    map, trains: new Set(mapTrains(map).map(s => s.id)),
    speed: pendingSpeed || state.speed, mods,
    notes: notesFor(map), approach: Math.max(0.4, 1.1 - map.stars * 0.05),
    time: -1.2, idx: 0, hits: 0, misses: 0, missBy: {}, blind: 0, rolls: new Map(), xp: {},
    combo: 0, maxCombo: 0, healthLog: [], healthAt: [], health: CONFIG.health, earned: 0,
    done: false, endTimer: 0, result: null, lastMissT: null, charmUsed: 0, startedAt: Date.now(),
  };
  if (trialOn('onelife')) { run.mods.sd = true; run.mods.nofail = false; }
  { const tm = trialDef(), m = tm && tm.mod && MODS.find(x => x.id === tm.mod);
    if (m) { for (const o of MODS) if (o !== m && modClash(m, o)) run.mods[o.id] = o.cycle ? 0 : false; run.mods[m.id] = true; } }
  pendingMods = null; pendingSpeed = null;
  Object.assign(cursor, { x: 0, y: 0, vx: 0, vy: 0, sx: NaN, sy: NaN });
  cursor.trail.length = 0;
  if (!simulating) Engine.emit('runStart', run);
}

function noteRoll(j) {
  let r = run.rolls.get(j);
  if (r) return r;
  const miss = rollAutoMiss(run.notes[j]);
  const n = run.notes[j], [x, y] = notePos(n, n.t);
  const p = j > 0 ? run.notes[j - 1] : null, [px, py] = p ? notePos(p, p.t) : [cursor.x, cursor.y];
  let off;
  if (miss) {
    let a = Math.hypot(x - px, y - py) > 0.05 ? Math.atan2(y - py, x - px) : Math.random() * Math.PI * 2;
    if (Math.random() < 0.35) a += Math.PI;
    a += (Math.random() * 2 - 1) * 0.5;
    const c = Math.cos(a), s = Math.sin(a), m = runHitbox() * (1.04 + Math.random() * 0.1) / Math.max(Math.abs(c), Math.abs(s));
    off = [c * m, s * m];
    if (Math.abs(x + off[0]) > FIELD_EDGE) off[0] = -off[0];
    if (Math.abs(y + off[1]) > FIELD_EDGE) off[1] = -off[1];
  } else {
    const d = Math.hypot(x - px, y - py), ux = d > 0.05 ? (x - px) / d : 1, uy = d > 0.05 ? (y - py) / d : 0;
    const face = Math.min(runHitbox(), NOTE_HALF), lim = face * 0.7, cl = v => Math.max(-lim, Math.min(lim, v));
    const along = (d > 0.3 ? -0.1 : 0) + 0.25 * gauss() * face, side = 0.2 * gauss() * face;
    off = [cl(ux * along - uy * side), cl(uy * along + ux * side)];
  }
  r = { miss, off, bend: gauss() * 0.15 };
  run.rolls.set(j, r);
  if (run.rolls.size > 8) for (const k of run.rolls.keys()) { if (k < run.idx - 3) run.rolls.delete(k); else break; }
  return r;
}
const ONESHOT_SOFT = 0.25;
const oneShotNow = note => !run.mods.nofail && (!!(note.tags & P.oneshot) || sdLike(run.mods) || run.health <= missDamage() + 1e-6);
function rollAutoMiss(note) {
  const nps = note.nps * run.speed, cap = runReadCap() * denseRead(note), k = missScale();
  if (Math.random() < baseMiss() * k * craftCut('consistency')) return 'consistency';
  if (nps > cap && Math.random() < Math.min(0.4, (nps / cap - 1) * 0.25)) return 'reading';
  for (const s of patternSkills()) {
    if (note.tags & s.bits && Math.random() < patternMiss(effLvl(s.id)) * k * craftCut(s.id) * (s.id === 'slides' && run.mods.st ? 2 : 1)) return s.id;
  }
  if (ascSkillsOn() && !(note.tags & P.oneshot) && oneShotNow(note) && Math.random() < ONESHOT_SOFT * patternMiss(effLvl('oneshot')) * k * craftCut('oneshot')) return 'oneshot';
  const tired = run.time - fatigueStart() * craftLater();
  if (tired > 0 && Math.random() < tired * fatigueRate() * k * craftCut('stamina')) return 'stamina';
  return null;
}

// the cursor's goal: the next note (with its rolled landing spot), reached no faster than Aim allows
function moveCursor(dt) {
  const target = run.notes[run.idx];
  if (!target) return;
  const roll = noteRoll(run.idx);
  const [tx, ty] = notePos(target, run.time);
  const gx = tx + roll.off[0], gy = ty + roll.off[1];
  const left = Math.max(0.0001, (target.t - run.time) / run.speed);
  const dx = gx - cursor.x, dy = gy - cursor.y, d = Math.hypot(dx, dy);
  if (d < 1e-4) return;
  // ease in: the cursor travels faster the closer the note's moment is, within Aim's speed
  const want = d / left, vmax = runCursorSpeed() * AIM_PEAK;
  const v = Math.min(vmax, Math.max(want, runCursorSpeed() * 0.35));
  const stepLen = Math.min(d, v * dt);
  cursor.x += dx / d * stepLen;
  cursor.y += dy / d * stepLen;
}

function step(dt) {
  if (!run) return;
  if (run.done) {
    if (run.wait && !simulating) return;
    run.endTimer -= dt;
    if (run.endTimer <= 0) {
      if (run.retry) { pendingMods = run.mods; pendingSpeed = run.speed; }
      else { const id = takeQueued(); if (id != null) state.selectedMap = id; }
      startRun();
    }
    return;
  }
  state.stats.time += dt;
  const end = run.time + dt * run.speed, x0 = cursor.x, y0 = cursor.y, hb = runHitbox();
  while (run.idx < run.notes.length && run.notes[run.idx].t <= end) {
    const nt = run.notes[run.idx].t;
    if (nt > run.time) { const sub = (nt - run.time) / run.speed; run.time = nt; moveCursor(sub); }
    while (run.idx < run.notes.length && run.notes[run.idx].t <= run.time) {
      const roll = noteRoll(run.idx), note = run.notes[run.idx++];
      const [nx, ny] = notePos(note, note.t);
      const inBox = Math.abs(cursor.x - nx) <= hb && Math.abs(cursor.y - ny) <= hb;
      const missedBy = roll.miss || (inBox ? null : 'aim');
      if (missedBy) onMiss(note, missedBy, nx, ny); else onHit(note, nx, ny);
      if (run.done) return;
    }
  }
  if (end > run.time) { const sub = (end - run.time) / run.speed; run.time = end; moveCursor(sub); }
  if (dt > 0) { cursor.vx = (cursor.x - x0) / dt; cursor.vy = (cursor.y - y0) / dt; }
  if (!simulating) {
    if (!isFinite(cursor.sx) || Math.hypot(cursor.x - cursor.sx, cursor.y - cursor.sy) > 3) Object.assign(cursor, { sx: cursor.x, sy: cursor.y, svx: 0, svy: 0 });
    else if (dt > 0) {
      const h = Math.min(dt, 0.05), w = CURSOR_SPRING, e = Math.exp(-w * h);
      for (const [p, v, t] of [['sx', 'svx', 'x'], ['sy', 'svy', 'y']]) {
        const x0 = cursor[p] - cursor[t], v0 = cursor[v], c = v0 + w * x0;
        cursor[p] = Math.max(-FIELD_EDGE, Math.min(FIELD_EDGE, cursor[t] + (x0 + c * h) * e));
        cursor[v] = (v0 - w * c * h) * e;
      }
    }
    cursor.trail.push({ x: cursor.sx, y: cursor.sy });
    while (cursor.trail.length > settings.trailLength) cursor.trail.shift();
  }
  const last = run.notes[run.notes.length - 1];
  if (run.idx >= run.notes.length && run.time > last.t + 0.5) finishRun(true);
}

function addXp(id, amount) {
  if (!state.skills[id]) return;
  const gain = amount * xpMult(id) * CONFIG.xpGain;
  if (run && !run.done) { if (!run.mods.nofail) run.xp[id] = (run.xp[id] || 0) + gain; return; }
  applyXp(id, gain);
}
function applyXp(id, gain) {
  const s = state.skills[id];
  if (!s) return;
  s.xp += gain;
  let gained = 0;
  while (s.lvl < CONFIG.maxLvl && s.xp >= xpNeeded(s.lvl)) { s.xp -= xpNeeded(s.lvl); s.lvl++; gained++; }
  if (s.lvl >= CONFIG.maxLvl) s.xp = 0;
  if (gained) levelUps.push({ id, lvl: s.lvl });
}
function grantXp(note, hit) {
  const u = Math.pow(Math.max(0.5, run.map.stars) * run.speed, 1.3) * (hit ? 1 : CONFIG.missXp) * (run.mods.ez ? 0.5 : 1);
  const m = Object.assign({}, run.mods, { sd: sdLike(run.mods) });
  const fast = run.speed > 1, b = (on, x) => on ? x : 1;
  addXp('aim', u * (0.4 + note.dist) * b(m.spin, 1.5) * b(m.spin2, 2.2) * b(m.sd, 1.5) * b(m.chaos, 1.3) * b(m.chaos2, 1.5) * b(m.st, 1.5));
  addXp('precision', u * 0.5 * b(m.pf, 1.8) * b(m.hr, 2) * b(m.hr2, 3) * b(m.sd, 1.5) * b(m.ghost, 1.3) * b(m.ghost2, 1.5) * b(fast, 1.5));
  addXp('reading', u * 0.5 * Math.min(2, note.nps * run.speed / runReadCap()) * b(m.ghost, 2.5) * b(m.ghost2, 4) * b(m.chaos, 1.5) * b(m.chaos2, 2.2) * b(m.sd, 1.5) * b(m.spin, 1.3) * b(m.spin2, 1.5) * b(fast, 1.5) * b(m.fl, 3) * b(m.bl, 1.8) * b(m.fi, 2) * b(m.co, 1.5));
  addXp('consistency', u * 0.4 * (1 + Math.min(run.combo, 100) / 100) * b(m.sd, 2) * b(m.ghost, 1.3) * b(m.ghost2, 1.5) * b(m.chaos, 1.3) * b(m.chaos2, 1.5) * b(fast, 1.5) * b(m.ac, 1.6) * b(m.bl, 1.3));
  for (const s of patternSkills()) if (note.tags & s.bits && run.trains.has(s.id)) addXp(s.id, u * CONFIG.patternXp * (s.id === 'slides' && m.st ? 2 : 1));
  if (run.time > fatigueStart() && run.trains.has('stamina')) addXp('stamina', u * 0.4);
  if (fast || m.sd) addXp('stamina', u * 0.2 * ((fast ? 1 : 0) + (m.sd ? 1 : 0)));
  if (m.spin || m.spin2) addXp('spins', u * CONFIG.patternXp * (m.spin2 ? 1 : 0.5));
  if (ascSkillsOn() && oneShotNow(note)) addXp('oneshot', u * CONFIG.patternXp);
}

let ppsBucket = 0;
function addPoints(p) {
  p *= incomeBoost();
  state.points += p;
  state.totalEarned += p;
  ppsBucket += p;
}
function onHit(note, x, y) {
  run.hits++; run.combo++;
  run.maxCombo = Math.max(run.maxCombo, run.combo);
  run.health = Math.min(CONFIG.health, run.health + CONFIG.hitHeal * (1 + relicLvl('mend')));
  if (run.blind) run.blind = Math.max(0, run.blind - 0.02);
  const pts = pointsPerHit(run, run.combo);
  addPoints(pts);
  run.earned += pts;
  state.stats.hits++;
  grantXp(note, true);
  run.healthLog.push(run.health); run.healthAt.push(note.t);
}
function onMiss(note, missedBy, x, y) {
  run.misses++;
  run.lastMissT = run.time;
  run.missBy[missedBy] = (run.missBy[missedBy] || 0) + 1;
  if ((run.charmUsed || 0) < relicLvl('charm')) run.charmUsed++;
  else {
    run.combo = 0;
    run.health = sdLike(run.mods) || (ascSkillsOn() && note.tags & P.oneshot && !run.mods.nofail) ? 0
      : Math.max(0, run.health - missDamage() * (1 - 0.08 * instinct(missedBy, 'tough')) * (trialOn('glass') ? 2 : 1) * (run.mods.ez ? 0.5 : 1));
  }
  if (run.mods.bl) run.blind = Math.min(1, (run.blind || 0) + 0.2);
  if (run.mods.ac && !run.mods.nofail && run.hits + run.misses >= MOD_FX.acFrom && run.hits / (run.hits + run.misses) < MOD_FX.acLine) run.health = 0;
  if (run.health < 1e-6) run.health = 0;
  run.healthLog.push(run.health); run.healthAt.push(note.t);
  grantXp(note, false);
  if (!simulating && settings.missFx) fx.push({ type: 'miss', x, y, age: 0 });
  if (run.health <= 0 && !run.mods.nofail) finishRun(false);
}
function weakSpot(missBy) {
  const top = Object.entries(missBy).sort((a, b) => b[1] - a[1])[0];
  return top && skillById(top[0]) ? skillById(top[0]).name : null;
}

const HISTORY_PER_MAP = 10, HISTORY_MAPS = 200, RP_LOG_MAX = 300;
function logRp() {
  state.rpLog.push({ at: Date.now(), rp: Math.round(totalRpCache) });
  if (state.rpLog.length > RP_LOG_MAX) state.rpLog.splice(0, state.rpLog.length - RP_LOG_MAX);
}
const awayLog = { best: null, bests: 0, dailies: [], cleared: new Set(), firsts: 0, played: new Set() };
function finishRun(passed) {
  run.done = true;
  run.endTimer = (sdLike(run.mods) || run.mods.ac) && !passed ? 1 : CONFIG.nextPause;
  run.wait = !settings.autoContinue && !simulating && passed;
  run.failTime = passed ? null : Math.max(0, run.time);
  state.warm = passed ? Math.min(1, state.warm + 0.2) : Math.max(0, state.warm - 0.25 * (1 - 0.25 * perkRank('warmblood')));
  if (trialOn('cold')) state.warm = 0; else if (relicOn('ember')) state.warm = 1;
  const judged = run.hits + run.misses, acc = judged ? run.hits / judged : 0;
  state.stats.plays++;
  let rp = 0, bonus = 0, improved = false;
  run.rpGain = 0;
  if (simulating) awayLog.played.add(run.map.id);
  if (passed) {
    state.stats.passes++;
    for (const [id, xp] of Object.entries(run.xp)) applyXp(id, xp);
    rp = playRp(run.map.stars * modStarMult(run.mods), acc, run.speed, run.misses, run.mods.nofail);
    bonus = run.earned * 0.25;
    addPoints(bonus);
    const b = state.best[run.map.id] || { rp: 0, acc: 0, speed: 1, grade: 'D', passes: 0 };
    b.passes++;
    run.prevBestRp = b.rp;
    if (rp > b.rp || (b.rp === 0 && acc > b.acc)) {
      improved = rp > b.rp;
      Object.assign(b, { rp, acc, speed: run.speed, grade: grade(acc), misses: run.misses, mods: modShort(run.mods), at: Date.now(), anon: !!run.mods.anon });
    }
    state.best[run.map.id] = b;
    const before = totalRpCache;
    totalRpCache = computeTotalRp();
    run.rpGain = totalRpCache - before;
    if (run.rpGain) logRp();
    // mastery: pass, S rank, full combo or 1.35x
    const was = state.mastery[run.map.id] || 0;
    let now = was | 1;
    if (acc >= 0.98) now |= 2;
    if (run.misses === 0 || run.speed >= 1.35) now |= 4;
    run.masteryNew = now & ~was;
    if (run.masteryNew) { state.mastery[run.map.id] = now; const n = (run.masteryNew & 1) + ((run.masteryNew >> 1) & 1) + ((run.masteryNew >> 2) & 1); addPoints(Math.max(50, state.ppsAvg * 180) * n * (1 + 0.5 * perkRank('collector'))); }
    if (simulating) {
      const bb = awayLog.best;
      if (!bb || rp > bb.rp) awayLog.best = { map: run.map, rp, acc, grade: grade(acc), mods: modShort(run.mods) };
      if (improved) awayLog.bests++;
      awayLog.cleared.add(run.map.id);
      if (b.passes === 1) awayLog.firsts++;
    }
    if (run.speed !== 1 || activeMods(run.mods).length) state.goals.mod = true;
  }
  dailyAfterRun(passed, acc);
  weeklyAfterRun(passed, acc);
  trialAfterRun(passed);
  const xpTop = Object.entries(run.xp).sort((a, b) => b[1] - a[1]).slice(0, 5);
  run.result = { passed, acc, rp, bonus, improved, grade: passed ? grade(acc) : 'F', weak: weakSpot(run.missBy), xpTop };
  const h = state.history[run.map.id] || [];
  h.unshift({ passed, acc, misses: run.misses, grade: run.result.grade, rp, speed: run.speed, mods: modShort(run.mods), failAt: run.failTime, at: Date.now() });
  if (h.length > HISTORY_PER_MAP) h.length = HISTORY_PER_MAP;
  delete state.history[run.map.id];
  state.history[run.map.id] = h;
  const keys = Object.keys(state.history);
  for (let i = 0; i < keys.length - HISTORY_MAPS; i++) delete state.history[keys[i]];
  recentPlays.unshift({ map: run.map, speed: run.speed, mods: modShort(run.mods), ...run.result, rpGain: run.rpGain || 0 });
  if (recentPlays.length > 8) recentPlays.pop();
  checkAchievements();
  if (!simulating) Engine.emit('runEnd', run);
}
function abortRun() { if (run && !run.done) { run.health = 0; finishRun(false); } }

/* ---------- income sampling ---------- */
const ppsHistory = [];
function sampleIncome() {
  ppsHistory.push(ppsBucket);
  ppsBucket = 0;
  if (ppsHistory.length > 30) ppsHistory.shift();
  state.ppsAvg = ppsHistory.reduce((a, b) => a + b, 0) / ppsHistory.length;
}
function resetIncome() { ppsHistory.length = 0; ppsBucket = 0; state.ppsAvg = 0; }

/* ---------- queue and map picking ---------- */
const QUEUE_LEN = 5;
let skillModelAt = -1e9, skillModelVal = null;
function skillModel() {
  if (Date.now() - skillModelAt < 2000 && skillModelVal) return skillModelVal;
  skillModelAt = Date.now();
  skillModelVal = { base: baseMiss(), cap: readCap(), hb: hitbox(), aim: cursorSpeed(), pats: Object.fromEntries(patternSkills().map(s => [s.id, patternMiss(effLvl(s.id))])) };
  return skillModelVal;
}
// expected miss share on a map at a speed with mods, from the skills alone
function predictMiss(m, speed = 1, mods = {}) {
  const sm = skillModel(), k = Math.pow(speed, CONFIG.speedMissExp) * warmMult();
  let miss = sm.base * k;
  for (const s of patternSkills()) miss += skillShare(m, s.id) * sm.pats[s.id] * k;
  const nps = (m.notes / Math.max(20, m.length)) * 2.2 * speed, cap = sm.cap * mf(MOD_FX.read, mods) * 1.3;
  if (nps > cap) miss += Math.min(0.4, (nps / cap - 1) * 0.25);
  // aim: a jump-heavy map past the cursor's speed misses more
  const need = Math.max(0.5, m.stars) * 2.2 * speed / mf(MOD_FX.field, mods);
  if (need > sm.aim * mf(MOD_FX.aim, mods)) miss += Math.min(0.5, (need / (sm.aim * mf(MOD_FX.aim, mods)) - 1) * 0.6);
  const hb = sm.hb * mf(MOD_FX.hitbox, mods);
  if (hb < 0.5) miss += (0.5 - hb) * 0.4;
  return Math.min(0.95, miss);
}
function passChance(m, speed = 1, mods = {}) {
  if (mods.nofail) return 1;
  const f = predictMiss(m, speed, mods);
  const line = sdLike(mods) ? 1 / Math.max(20, m.notes) : 0.075;
  return 1 / (1 + Math.exp((f - line) / 0.018));
}
function hardestPassed() { return Math.max(0, ...Object.entries(state.best).map(([id, b]) => { const m = mapById(+id); return m && b.passes ? m.stars * (b.speed || 1) : 0; })); }
const AWAY_LEN = { short: [0, 120], mid: [120, 240], long: [240, Infinity] };
function awayCandidates(mode = settings.awayPick) {
  const lenOk = m => { const b = AWAY_LEN[settings.awayLen]; return !b || (m.length >= b[0] && m.length < b[1]); };
  let pool = MAPS.filter(m => m.status !== 'custom' && lenOk(m));
  if (!pool.length) pool = MAPS.slice();
  if (mode === 'same') return [state.selectedMap];
  if (mode === 'shuffle') return pool.sort(() => Math.random() - 0.5).slice(0, 12).map(m => m.id);
  const top = hardestPassed();
  const scored = pool.map(m => ({ m, p: passChance(m, 1, {}) }));
  let list;
  if (mode === 'climb') list = scored.filter(x => x.p > 0.35 && x.p < 0.9 && m_near(x.m, top)).sort((a, b) => b.m.stars - a.m.stars);
  else if (mode === 'rp') list = scored.filter(x => x.p > 0.5).map(x => ({ ...x, g: rawRp(x.m.stars, 0.97 * x.p) - ((state.best[x.m.id] || {}).rp || 0) })).filter(x => x.g > 0).sort((a, b) => b.g - a.g);
  else if (mode === 'weak') { const weak = ALL_SKILLS.filter(s => s.bits).sort((a, b) => skillLvl(a.id) - skillLvl(b.id))[0]; list = scored.filter(x => x.p > 0.5 && skillShare(x.m, weak.id) >= (TRAIN_SHARE_OF[weak.id] || TRAIN_SHARE)).sort((a, b) => skillShare(b.m, weak.id) - skillShare(a.m, weak.id)); }
  else if (mode === 'mix') list = scored.filter(x => x.p > 0.6).sort(() => Math.random() - 0.5);
  else { // smart: mostly RP climbs, some practice near the edge, a little variety
    const r = Math.random();
    return awayCandidates(r < 0.5 ? 'rp' : r < 0.8 ? 'climb' : 'mix');
  }
  if (!list.length) list = scored.filter(x => x.p > 0.5).sort((a, b) => b.m.stars - a.m.stars);
  if (!list.length) list = scored.sort((a, b) => b.p - a.p);
  return list.slice(0, 12).map(x => x.m.id);
}
const m_near = (m, top) => m.stars >= top - 1 && m.stars <= top + 0.8;
const MOD_FOR_SKILL = { aim: ['spin', 'st'], precision: ['hr', 'pf'], reading: ['ghost', 'fl', 'fi', 'co', 'bl'], consistency: ['sd', 'ac'] };
function pickMods(map, speed = 1) {
  const out = defaultMods();
  if (settings.autoModMode === 'off') return out;
  if (settings.autoModMode === 'custom') { for (const id of String(settings.autoModList || '').split(/[ ,]+/)) if (MODS.find(m => m.id === id) && modOpen(MODS.find(m => m.id === id))) out[id] = id === 'mirror' ? 1 : true; return out; }
  // smart: the mod training the weakest core skill, if the map still passes with it
  const weakest = SKILLS.filter(s => s.core).sort((a, b) => effLvl(a.id) - effLvl(b.id))[0];
  for (const id of MOD_FOR_SKILL[weakest.id]) {
    const m = MODS.find(x => x.id === id);
    if (!modOpen(m)) continue;
    const trial = Object.assign({}, out, { [id]: true });
    if (passChance(map, speed, trial) > 0.75) { out[id] = true; break; }
  }
  return out;
}
function pickSpeed(map, mods) {
  let best = 1;
  for (const sp of SPEEDS) if (speedOpen(sp) && sp.rate > 1 && passChance(map, sp.rate, mods) > 0.8) best = sp.rate;
  return best;
}
function topUpQueue() {
  const auto = state.queue.filter(e => e.auto).length;
  if (state.queue.length >= QUEUE_LEN) return;
  const pl = plPlaying();
  if (pl) { while (state.queue.length < QUEUE_LEN) { const id = plNext(); if (id == null) break; state.queue.push({ id, auto: true, pl: true }); } return; }
  const cands = awayCandidates().filter(id => !state.queue.some(e => e.id === id));
  for (const id of cands) { if (state.queue.length >= QUEUE_LEN) break; const m = mapById(id); const mods = pickMods(m); state.queue.push({ id, auto: true, mods, speed: pickSpeed(m, mods) }); }
  void auto;
}
function takeQueued() {
  topUpQueue();
  const e = state.queue.shift();
  if (!e) return null;
  if (e.auto && e.mods) { pendingMods = e.mods; pendingSpeed = e.speed || 1; }
  const d = dailyToday();
  if (d && Object.values(d.maps).includes(e.id) && e.daily) { pendingMods = dailyMods(d); pendingSpeed = 1; }
  return e.id;
}
function addToQueue(id, opts = {}) {
  state.queue = state.queue.filter(e => !e.auto);
  if (state.queue.length < 20) state.queue.push(Object.assign({ id, auto: false }, opts));
  topUpQueue();
}
function playNow(id, opts = {}) {
  state.selectedMap = id;
  if (opts.daily) { const d = dailyToday(); pendingMods = dailyMods(d); pendingSpeed = 1; }
  startRun();
}

/* ---------- playlists ---------- */
const plById = id => (state.playlists || []).find(x => x.id === id) || null;
const plPlaying = () => state.playlistOn && plById(state.playlistOn.id);
function plCreate(name, first) {
  if ((state.playlists || []).length >= 30) return null;
  const x = { id: Date.now(), name: (name || 'New playlist').slice(0, 40), maps: first != null ? [first] : [] };
  state.playlists.push(x);
  return x;
}
function plToggle(x, mapId) { const i = x.maps.indexOf(mapId); if (i >= 0) x.maps.splice(i, 1); else if (x.maps.length < 300) x.maps.push(mapId); }
function plDelete(x) { state.playlists = state.playlists.filter(y => y !== x); if (state.playlistOn && state.playlistOn.id === x.id) state.playlistOn = null; }
function plPlay(x, shuffle) { state.playlistOn = { id: x.id, at: 0, shuffle: !!shuffle }; state.queue = state.queue.filter(e => !e.auto); topUpQueue(); }
function plStop() { state.playlistOn = null; state.queue = state.queue.filter(e => !e.pl); }
function plNext() {
  const x = plPlaying();
  if (!x || !x.maps.length) return null;
  const on = state.playlistOn;
  const id = on.shuffle ? x.maps[Math.floor(Math.random() * x.maps.length)] : x.maps[on.at % x.maps.length];
  on.at++;
  return id;
}

/* ---------- daily maps, weekly challenges, streak ---------- */
const dailyCache = { day: null, d: null };
function dailyToday() {
  const day = DAILY.dayKey();
  if (dailyCache.day !== day) { dailyCache.day = day; dailyCache.d = DAILY.pick(day); }
  if (!state.daily || state.daily.day !== day) state.daily = { day, done: {}, tries: {} };
  return dailyCache.d;
}
const dailyMods = d => Object.assign(defaultMods(), d.mod ? { [d.mod]: d.mod === 'mirror' ? 1 : true } : {}, { anon: state.mods.anon });
const dailyBonus = () => Math.max(250, state.ppsAvg * 900);
const untilReset = () => { const t = new Date(); const ms = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1) - t; const h = Math.floor(ms / 36e5); return h ? `${h}h ${Math.floor(ms % 36e5 / 6e4)}m` : `${Math.max(1, Math.floor(ms / 6e4))}m`; };
function dailyTierOf(r) {
  const d = dailyToday();
  const tier = Object.keys(d.maps).find(t => d.maps[t] === r.map.id);
  if (!tier || r.speed !== 1) return null;
  const want = d.mod ? [d.mod] : [];
  const have = activeMods(r.mods);
  return want.join() === have.join() ? tier : null;
}
function dailyAfterRun(passed, acc) {
  const tier = dailyTierOf(run);
  if (!tier) return;
  state.daily.tries[tier] = (state.daily.tries[tier] || 0) + 1;
  if (!passed) return;
  const done = state.daily.done[tier];
  if (!done) {
    const b = dailyBonus();
    addPoints(b);
    if (simulating) awayLog.dailies.push(tier); else Engine.emit('toast', `<b>Daily map cleared</b> (${TIERS.find(t => t.id === tier).name}) · +${fmt(b)} points`, 5000);
    streakTouch();
  }
  if (!done || acc > done.acc) state.daily.done[tier] = { acc, grade: grade(acc) };
}
function streakTouch() {
  const day = DAILY.dayKey(), s = state.streak;
  if (s.last === day) return;
  const yesterday = DAILY.dayKey(Date.now() - 864e5);
  s.count = s.last === yesterday ? s.count + 1 : 1;
  s.best = Math.max(s.best, s.count);
  s.last = day;
}
const streakMult = () => { const s = state.streak; if (!s.last || (s.last !== DAILY.dayKey() && s.last !== DAILY.dayKey(Date.now() - 864e5))) return 1; return 1 + Math.min(0.3, 0.02 * s.count); };
const WEEKLY_POOL = [
  { id: 'pass10', text: 'Pass 10 maps', goal: 10, kind: 'pass' },
  { id: 'pass40', text: 'Pass 40 maps', goal: 40, kind: 'pass' },
  { id: 'srank5', text: 'Get 5 S ranks', goal: 5, kind: 's' },
  { id: 'fc3', text: 'Full combo 3 maps', goal: 3, kind: 'fc' },
  { id: 'mods5', text: 'Pass 5 maps with a mod on', goal: 5, kind: 'mod' },
  { id: 'fast5', text: 'Pass 5 maps at 1.15× or faster', goal: 5, kind: 'fast' },
  { id: 'hard3', text: 'Pass 3 maps near your hardest', goal: 3, kind: 'hard' },
  { id: 'long3', text: 'Pass 3 maps over 3 minutes', goal: 3, kind: 'long' },
  { id: 'ss1', text: 'Get an SS', goal: 1, kind: 'ss' },
];
const weeklyReward = () => Math.max(500, state.ppsAvg * 2700);
function weeklyNow() {
  const week = DAILY.weekKey();
  if (!state.weekly || state.weekly.week !== week) {
    const h = DAILY.hash(week + ':wk');
    const picks = [];
    for (let i = 0; picks.length < 4 && i < 20; i++) { const c = WEEKLY_POOL[(h + i * 7) % WEEKLY_POOL.length]; if (!picks.includes(c)) picks.push(c); }
    state.weekly = { week, badge: false, list: picks.map(c => ({ id: c.id, prog: 0, done: false })) };
  }
  return state.weekly;
}
const weeklyUntil = () => { const ms = DAILY.weekEnd() - Date.now(); const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5); return d ? `${d}d ${h}h` : `${h}h`; };
function weeklyAfterRun(passed, acc) {
  if (!passed) return;
  const w = weeklyNow(), top = hardestPassed();
  for (const e of w.list) {
    if (e.done) continue;
    const c = WEEKLY_POOL.find(x => x.id === e.id);
    const ok = c.kind === 'pass' || (c.kind === 's' && acc >= 0.98) || (c.kind === 'fc' && run.misses === 0) || (c.kind === 'mod' && activeMods(run.mods).length)
      || (c.kind === 'fast' && run.speed >= 1.15) || (c.kind === 'hard' && run.map.stars * run.speed >= top - 0.5) || (c.kind === 'long' && run.map.length >= 180) || (c.kind === 'ss' && acc >= 1);
    if (!ok) continue;
    e.prog++;
    if (e.prog >= c.goal) { e.done = true; addPoints(weeklyReward()); if (!simulating) Engine.emit('toast', `<b>Weekly challenge done</b>: ${c.text} · +${fmt(weeklyReward())} points`, 5000); }
  }
  if (!w.badge && w.list.every(e => e.done)) { w.badge = true; state.weeklyBadges++; }
}

/* ---------- buying: gear, instincts, perks, shop, devotion, shards ---------- */
function nextGear(id) {
  const t = state.gear[id] || 0;
  if (t >= gearMax(id)) return null;
  return { tier: t, name: gearName(id, t), cost: gearCost(ALL_SKILLS.findIndex(s => s.id === id), t), req: relicOn('gloves') ? 0 : gearReq(t) };
}
function buyGear(id) {
  const g = nextGear(id);
  if (!g || state.points < g.cost || skillLvl(id) < g.req) return false;
  state.points -= g.cost;
  state.gear[id] = (state.gear[id] || 0) + 1;
  return true;
}
function buyAll(ids = ALL_SKILLS.map(s => s.id)) {
  let n = 0, again = true;
  while (again) { again = false; for (const id of ids) { const g = nextGear(id); if (g && state.points >= g.cost && skillLvl(id) >= g.req) { buyGear(id); n++; again = true; } } }
  return n;
}
function buyInstinct(skill, id) {
  const d = INSTINCTS.find(x => x.id === id), have = instinct(skill, id);
  if (!d || have >= instMax(d) || state.instinctPts < d.cost) return false;
  state.instinctPts -= d.cost;
  state.instincts[skill] = Object.assign({}, state.instincts[skill], { [id]: have + 1 });
  return true;
}
function respecInstincts() {
  let refund = 0;
  for (const sk of Object.keys(state.instincts)) for (const [id, r] of Object.entries(state.instincts[sk])) { const d = INSTINCTS.find(x => x.id === id); if (d) refund += d.cost * r; }
  for (const [id, r] of Object.entries(state.perks || {})) { const d = PERKS.find(x => x.id === id); if (d) refund += d.cost * r; }
  state.instincts = {}; state.perks = {};
  state.instinctPts += refund;
  state.skills = freshSkills();
  return refund;
}
function buyPerk(id) {
  const d = PERKS.find(x => x.id === id);
  if (!d || perkRank(id) >= perkMax(d) || state.instinctPts < d.cost) return false;
  state.instinctPts -= d.cost;
  state.perks = Object.assign({}, state.perks, { [id]: perkRank(id) + 1 });
  return true;
}
function buyShop(id) {
  const d = STAR_SHOP.find(x => x.id === id);
  if (!d || shopRank(id) >= d.max) return false;
  const c = shopCost(d);
  if (starWallet() < c) return false;
  state.starsSpent = (state.starsSpent || 0) + c;
  state.shop = Object.assign({}, state.shop, { [id]: shopRank(id) + 1 });
  return true;
}
function buyDevotion(id) {
  if (!devotionOpen(id) || devotionOf(id) >= devotionMax()) return false;
  const c = devotionCost(id);
  if (state.instinctPts < c) return false;
  state.instinctPts -= c;
  state.devotion = Object.assign({}, state.devotion, { [id]: devotionOf(id) + 1 });
  return true;
}
function buyShardUnlock(id) {
  const u = SHARD_UNLOCKS.find(x => x.id === id);
  if (!u || !shardReady(u) || shardWallet() < u.cost) return false;
  state.shardsSpent += u.cost;
  state.shardUnlocks = Object.assign({}, state.shardUnlocks, { [id]: 1 });
  return true;
}
function buyOverdrive() {
  if (shardWallet() < OVERDRIVE.cost) return false;
  state.shardsSpent += OVERDRIVE.cost;
  state.overdrive = Math.max(Date.now(), state.overdrive || 0) + OVERDRIVE.minutes * 60000;
  return true;
}
function prestigeSkill(id) {
  if (!prestigeReady(id)) return false;
  state.prestige = Object.assign({}, state.prestige, { [id]: prestigeOf(id) + 1 });
  state.skills[id] = { lvl: 5 * instinct(id, 'headstart') + quickLvls(), xp: 0 };
  state.gear[id] = Math.min(Math.max(kitTiers(), shopRank('gearbag')), GEAR[id].length);
  return true;
}
function buyEcho(id) {
  const d = ECHO_NODES.find(x => x.id === id), r = echoRank(id);
  if (!d || r >= d.costs.length || (state.echoes || 0) < d.costs[r]) return false;
  state.echoes -= d.costs[r];
  state.echoTree = Object.assign({}, state.echoTree, { [id]: r + 1 });
  return true;
}
function startTrial(id) {
  const x = TRIALS.find(t => t.id === id);
  if (!x || !trialOpen(x)) return false;
  state.trial = { id, prog: 0 };
  if (id === 'cold') state.warm = 0;
  return true;
}
function wearRelic(id) {
  if (!(state.relics || {})[id]) return false;
  const on = (state.relicsOn || []).filter(x => x !== id);
  if (on.length === (state.relicsOn || []).length) { if (on.length >= relicSlots()) return false; on.push(id); }
  state.relicsOn = on;
  if (relicOn('ember') && !trialOn('cold')) state.warm = 1;
  return true;
}
function trialAfterRun(passed) {
  const t = trialDef();
  if (!t || !passed || run.mods.nofail) return;
  state.trial.prog += run.map.stars * run.speed;
  if (state.trial.prog < trialGoal()) return;
  state.trial = null;
  state.relics = Object.assign({}, state.relics, { [t.relic]: Math.max((state.relics || {})[t.relic] || 0, t.lvl || 1) });
  if ((state.relicsOn || []).length < relicSlots() && !state.relicsOn.includes(t.relic)) state.relicsOn = [...state.relicsOn, t.relic];
  const rl = RELICS.find(x => x.id === t.relic);
  if (!simulating) Engine.emit('toast', `<b>${esc(t.name)}</b> trial done · relic: <b>${esc(rl.name)}${t.lvl === 2 ? ' II' : ''}</b>`, 7000);
}

/* ---------- seasons, rebirths, ascensions, transcendence ---------- */
const seasonPoints = gain => Math.floor(gain * (unlocked('clarity') ? 2 : unlocked('insight') ? 1.5 : 1)) + shopRank('tutor') + (milestoneHave('instinct') ? 3 : 0);
function seasonRecap(gain) {
  return { n: state.seasons + 1, at: Date.now(), rp: Math.round(totalRp()), title: rank().name, best: hardestPassed(), plays: state.stats.plays - state.seasonStart.plays, stars: gain, maps: Object.keys(state.best).length, dur: Date.now() - state.seasonStart.at };
}
function startSeason() {
  const gain = seasonStars();
  if (!gain) return false;
  const recap = seasonRecap(gain);
  const hours = (Date.now() - state.seasonStart.at) / 36e5;
  if (hours >= SEASON_SHARD_HOURS) state.shardsEarned = (state.shardsEarned || 0) + SEASON_SHARDS;
  seasonReset({ stars: state.stars + gain, instinctPts: state.instinctPts + seasonPoints(gain), starsEver: (state.starsEver || 0) + gain });
  state.seasonLog.push(recap);
  if (state.seasonLog.length > 60) state.seasonLog.shift();
  Engine.emit('season', recap);
  return true;
}
function seasonReset(over) {
  const keep = { stars: state.stars, instinctPts: state.instinctPts, instincts: state.instincts, seasons: state.seasons + 1, tab: state.tab, mods: state.mods,
    stats: state.stats, createdAt: state.createdAt, rpLog: state.rpLog, titleLog: state.titleLog, history: state.history, filter: state.filter };
  for (const k of SEASON_KEEP) keep[k] = state[k];
  state = Object.assign(defaultState(), keep, over);
  state.skills = freshSkills(state.instincts);
  const kit = Math.max(kitTiers(), shopRank('gearbag'));
  if (kit) for (const sk of ALL_SKILLS) state.gear[sk.id] = Math.min(kit, GEAR[sk.id].length);
  totalRpCache = 0;
  logRp();
  resetIncome();
  state.seasonStart = { at: Date.now(), plays: state.stats.plays };
  startRun();
}
function rebirth() {
  if (!rebirthReady()) return false;
  const n = (state.rebirths || 0) + 1;
  seasonReset({ stars: Math.floor(heirloomShare() * state.stars), instinctPts: 0, instincts: {}, perks: {}, starsSpent: 0, devotion: {} });
  state.rebirths = n;
  state.rebirthAt = state.seasons;
  checkAchievements();
  return true;
}
function ascend() {
  if (!ascendReady()) return false;
  ascSkillsOpen();
  seasonReset({ stars: 0, instinctPts: 0, instincts: {}, perks: {}, starsSpent: 0, devotion: {}, prestige: {}, shop: {}, rebirths: 0, ascensions: (state.ascensions || 0) + 1 });
  state.rebirthAt = state.seasons;
  checkAchievements();
  return true;
}
function transcend() {
  if (!transcendReady()) return false;
  state.transcends = (state.transcends || 0) + 1;
  state.echoes = (state.echoes || 0) + TRANSCEND.asc;
  resetIncome();
  return true;
}

/* ---------- goals and achievements ---------- */
const maxSkillLvl = () => Math.max(0, ...ALL_SKILLS.map(s => skillLvl(s.id)));
function goalHave(id) {
  switch (id) {
    case 'pass3': case 'pass20': return state.stats.passes;
    case 'gear': return ALL_SKILLS.some(s => state.gear[s.id] > 0) ? 1 : 0;
    case 'lv10': return maxSkillLvl();
    case 'mod': return state.goals.mod ? 1 : 0;
    case 'rp500': return totalRp();
    case 'gear5': return Math.max(0, ...ALL_SKILLS.map(s => state.gear[s.id] || 0));
    case 'inter': return hardestPassed() >= 3 ? 1 : 0;
  }
  return 0;
}
function currentGoal() { return GOALS[state.goals.at] || null; }
function goalCheck() {
  const g = currentGoal();
  if (!g || goalHave(g.id) < g.need) return null;
  const pay = Math.max(g.floor, state.ppsAvg * 60 * g.min);
  addPoints(pay);
  state.goals.at++;
  Engine.emit('toast', `<b>Goal done</b>: ${g.text} · +${fmt(pay)} points`, 5000);
  return g;
}
function checkAchievements() {
  const have = id => !!state.ach[id];
  const give = id => { if (!have(id)) { state.ach[id] = Date.now(); if (!simulating) Engine.emit('toast', `<b>Achievement</b>: ${ACHIEVEMENTS.find(a => a.id === id).name}`, 4000); } };
  const r = run, res = r && r.result, passedNow = res ? res.passed : (r && !r.done && false);
  if (state.stats.passes >= 1) give('plays1');
  if (state.stats.passes >= 50) give('plays50');
  if (state.stats.passes >= 500) give('plays500');
  if (r && r.done === true && r.health > 0 && r.hits > 0) {
    if (r.misses === 0) give('fc0');
    const acc = r.hits / (r.hits + r.misses);
    if (acc >= 1) give('ss0');
    const st = r.map.stars * r.speed;
    if (st >= 3) give('clear3'); if (st >= 5) give('clear5'); if (st >= 7) give('clear7'); if (st >= 10) give('clear10');
    if (r.speed >= 1.45) give('speed145');
    if (activeMods(r.mods).length >= 3) give('mods3');
  }
  void passedNow;
  if (totalRp() >= 1500) give('rp1500');
  if (totalRp() >= 5000) give('rp5000');
  if (state.seasons >= 1) give('season1');
  if (state.rebirths >= 1) give('rebirth1');
  if (state.ascensions >= 1) give('ascend1');
  if (maxSkillLvl() >= 50) give('lv50');
  if (maxSkillLvl() >= 120) give('lv120');
  if (ALL_SKILLS.some(s => (state.gear[s.id] || 0) >= 15)) give('gear15');
  if (state.daily && Object.keys(state.daily.done).length) give('daily');
}

/* ---------- save and load ---------- */
function save() {
  state.lastTime = Date.now();
  try { localStorage.setItem(CONFIG.saveKey, JSON.stringify(state)); } catch (e) { /* storage blocked */ }
}
function saveSettings() { try { localStorage.setItem(CONFIG.settingsKey, JSON.stringify(settings)); } catch (e) { /* blocked */ } }
function loadSettings() { try { Object.assign(settings, SETTING_DEFAULTS, JSON.parse(localStorage.getItem(CONFIG.settingsKey)) || {}); } catch (e) { /* blocked */ } }
function applySave(data) {
  const d = defaultState();
  state = Object.assign(d, data);
  for (const k of ['skills', 'gear', 'instincts', 'perks', 'prestige', 'best', 'history', 'mastery', 'shop', 'devotion', 'shardUnlocks', 'relics', 'echoTree', 'ach', 'stats', 'filter', 'goals', 'streak', 'seasonStart']) if (!state[k] || typeof state[k] !== 'object') state[k] = d[k];
  if (!Array.isArray(state.queue)) state.queue = [];
  if (!Array.isArray(state.playlists)) state.playlists = [];
  if (state.ascensions > 0) ascSkillsOpen();
  for (const s of ALL_SKILLS) if (!state.skills[s.id]) state.skills[s.id] = { lvl: 0, xp: 0 };
  if (!mapById(state.selectedMap)) state.selectedMap = starterMap();
  state.mods = Object.assign(defaultMods(), state.mods);
  totalRpCache = computeTotalRp();
}
function load() {
  loadSettings();
  let raw = null;
  try { raw = localStorage.getItem(CONFIG.saveKey); } catch (e) { /* blocked */ }
  if (!raw) return false;
  try { applySave(JSON.parse(raw)); return true; } catch (e) { return false; }
}
function exportSave() { return btoa(unescape(encodeURIComponent(JSON.stringify(state)))); }
function importSave(text) {
  try { applySave(JSON.parse(decodeURIComponent(escape(atob(text.trim()))))); save(); startRun(); return true; } catch (e) { return false; }
}
function hardReset() {
  state = defaultState(); totalRpCache = 0; recentPlays.length = 0; resetIncome(); save(); startRun();
}

/* ---------- offline catch-up and welcome back ---------- */
const COMEBACK = [{ awayH: 48, mult: 2, min: 10 }, { awayH: 12, mult: 1.5, min: 5 }];
function comebackGrant(ms) {
  const t = COMEBACK.find(x => ms >= x.awayH * 36e5);
  if (t) state.comeback = { until: Date.now() + t.min * 60000, mult: t.mult };
}
let catching = false;
async function catchUp(ms, onProgress) {
  if (catching) return null;
  comebackGrant(ms);
  const sec = Math.min(ms / 1000, offlineCap() * 3600);
  if (!settings.keepPlaying || sec < 5 || !run) return null;
  const before = { points: state.points, rp: totalRp(), plays: state.stats.plays, passes: state.stats.passes, lv: Object.fromEntries(ALL_SKILLS.map(s => [s.id, skillLvl(s.id)])) };
  Object.assign(awayLog, { best: null, bests: 0, dailies: [], cleared: new Set(), firsts: 0, played: new Set() });
  simulating = true; catching = true;
  let gearBought = 0;
  const autoGear = settings.autoGear !== 'off';
  const total = Math.floor(sec * 60);
  try {
    for (let left = total; left > 0;) {
      const n = Math.min(left, 30000);
      for (let i = 0; i < n; i++) { step(1 / 60); if (autoGear && i % 3600 === 3599) gearBought += buyAll(); if (i % 60 === 59) sampleIncome(); }
      left -= n;
      if (onProgress && left > 0) { onProgress(1 - left / total); await new Promise(r => setTimeout(r, 0)); }
    }
  } finally { simulating = false; catching = false; }
  if (autoGear) gearBought += buyAll();
  levelUps.length = 0; fx.length = 0;
  if (run && run.done) run.wait = false;
  return { gear: gearBought, sec, capped: sec < ms / 1000, points: state.points - before.points, rp: totalRp() - before.rp, rpFrom: before.rp,
    plays: state.stats.plays - before.plays, passes: state.stats.passes - before.passes, maps: awayLog.played.size, cleared: awayLog.cleared.size, firsts: awayLog.firsts,
    best: awayLog.best, bests: awayLog.bests, dailies: awayLog.dailies.slice(),
    levels: ALL_SKILLS.map(s => [s, before.lv[s.id], skillLvl(s.id)]).filter(x => x[2] > x[1]) };
}

/* ---------- bots: a local stand-in for the online players, boards and chat ---------- */
const BOTS = (() => {
  const r = rng(424242), out = [];
  BOT_NAMES.forEach((name, i) => {
    const rp = Math.round(Math.pow(r(), 2.2) * 14000 + 40);
    out.push({ name, rp, plays: Math.round(200 + r() * 6000), country: COUNTRIES[Math.floor(r() * COUNTRIES.length)], hue: Math.floor(r() * 360), online: r() < 0.45, seed: i, level: 1 + Math.floor(rp / 300) });
  });
  return out.sort((a, b) => b.rp - a.rp);
})();
const playerName = () => settings.playerName || (state.player && state.player.name) || 'Player';
function globalBoard() {
  const me = { name: playerName(), rp: totalRp(), plays: state.stats.passes, country: '', me: true, hue: 320, level: 1 + Math.floor(state.stats.passes / 20) };
  const rows = BOTS.concat([me]).sort((a, b) => b.rp - a.rp);
  rows.forEach((x, i) => x.rank = i + 1);
  state.globalRank = rows.find(x => x.me).rank;
  return rows;
}
// each map's board: a few bots whose play depends on the map and their RP, plus you
function mapBoard(map) {
  const r = rng(map.id * 31 + 5), rows = [];
  const n = Math.min(8, 2 + Math.floor(map.plays / 400));
  for (let i = 0; i < n; i++) {
    const bot = BOTS[Math.floor(r() * BOTS.length)];
    const skill = Math.min(1, bot.rp / 9000 + 0.2);
    const acc = Math.min(1, 0.86 + 0.14 * skill * (0.7 + r() * 0.3) - map.stars * 0.004);
    const speed = skill > 0.8 && r() < 0.5 ? 1.15 : 1;
    rows.push({ name: bot.name, hue: bot.hue, acc, speed, rp: playRp(map.stars, acc, speed, 0, false), grade: grade(acc), mods: '' });
  }
  const b = state.best[map.id];
  if (b && b.passes && !b.anon) rows.push({ name: playerName(), me: true, acc: b.acc, speed: b.speed, rp: b.rp, grade: b.grade, mods: b.mods || '' });
  rows.sort((a, b2) => b2.rp - a.rp || b2.acc - a.acc);
  rows.forEach((x, i) => x.rank = i + 1);
  return rows;
}
function botsOnline() {
  const h = Math.floor(Date.now() / 600000);
  return BOTS.filter(b => ((b.seed * 7 + h) % 5) !== 0 && b.online).map(b => ({ ...b, playing: MAPS[(b.seed * 97 + h) % MAPS.length] }));
}
function botChatLine() {
  const bots = botsOnline();
  if (!bots.length) return null;
  const b = bots[Math.floor(Math.random() * bots.length)];
  return { name: b.name, text: BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)], at: Date.now(), hue: b.hue, rp: b.rp };
}
