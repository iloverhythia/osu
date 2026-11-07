'use strict';
/* UI: every screen of the game, drawn from the engine's state. */

const $ = id => document.getElementById(id);
const ui = { open: null, tab: 'skills', seen: new Set(), chan: 'general', favs: new Set(), browse: { id: null, page: 0 }, hudAt: 0, fps: 0, lastSave: 0, chatAt: 0, viz: 0 };
let canvas, ctx, view = { size: 600, dpr: 1 };
const PERSPECTIVE = 5;
const NOTE_COLORS = () => (NOTE_SETS[settings.noteSet] || NOTE_SETS.rhythia).colors || [settings.noteColorA, settings.noteColorB];
const cellPx = () => view.size / 4.2;

/* ---------- small helpers ---------- */
function toast(html, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}
Engine.on('toast', toast);
function showModal(html, buttons) {
  $('modalBody').innerHTML = html;
  const box = $('modalBtns');
  box.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.textContent = b.label;
    if (b.primary) el.className = 'primary';
    if (b.danger) el.className = 'danger';
    el.onclick = () => { $('modal').classList.add('hidden'); if (b.onClick) b.onClick(); };
    box.appendChild(el);
  }
  $('modal').classList.remove('hidden');
}
let tickerTimer = 0;
function tickerPush(html) {
  const el = $('ticker');
  el.innerHTML = html;
  clearTimeout(tickerTimer);
  tickerTimer = setTimeout(() => { el.innerHTML = ''; }, 9000);
}
const avatar = (name, hue) => `<span class="av" style="--h:${hue}">${esc((name || '?').slice(0, 1).toUpperCase())}</span>`;
const nameHue = name => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const shownName = n => settings.hideNames && n !== playerName() ? 'Player' : n;
const applyTheme = () => {
  const r = document.documentElement.style;
  r.setProperty('--accent', settings.accentColor); r.setProperty('--accent-2', settings.accentColor2);
  r.setProperty('--text', settings.textColor); r.setProperty('--panel', settings.panelColor); r.setProperty('--hud', settings.hudColor);
  $('btnAudio').classList.toggle('off', !settings.musicOn);
};

/* ---------- panels: one open at a time ---------- */
const PANELS = { maps: 'select', skills: 'skills', rankings: 'lbp', profile: 'pp', online: 'online', guide: 'guide', settings: 'settings', stats: 'statsP' };
function closePanels() {
  for (const id of Object.values(PANELS)) $(id).classList.add('hidden');
  $('goto').classList.add('hidden');
  ui.open = null;
  for (const b of document.querySelectorAll('#dock button')) b.classList.toggle('on', b.dataset.nav === 'play');
}
function openPanel(name) {
  if (ui.open === name) { closePanels(); return; }
  closePanels();
  if (name === 'play') return;
  ui.open = name;
  $(PANELS[name]).classList.remove('hidden');
  for (const b of document.querySelectorAll('#dock button')) b.classList.toggle('on', b.dataset.nav === name);
  ({ maps: renderSelect, skills: renderTabs, rankings: renderBoard, profile: renderProfilePage, online: renderOnline, guide: renderGuide, settings: renderSettings, stats: renderStats })[name]();
}

/* ---------- canvas ---------- */
function resize() {
  const w = $('canvasWrap').clientWidth || 600;
  view.size = w; view.dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * view.dpr); canvas.height = Math.round(w * view.dpr);
}
function roundRect(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function drawGrid(c, cx, cy, cell) {
  if (settings.gridLines) {
    c.strokeStyle = settings.gridColor; c.globalAlpha = settings.gridAlpha; c.lineWidth = 1;
    for (let i = -1.5; i <= 1.5; i++) {
      c.beginPath(); c.moveTo(cx + i * cell, cy - 1.5 * cell); c.lineTo(cx + i * cell, cy + 1.5 * cell); c.stroke();
      c.beginPath(); c.moveTo(cx - 1.5 * cell, cy + i * cell); c.lineTo(cx + 1.5 * cell, cy + i * cell); c.stroke();
    }
    c.globalAlpha = 1;
  }
  if (settings.gridBorder) { c.strokeStyle = settings.borderColor; c.lineWidth = 2; c.globalAlpha = .7; c.strokeRect(cx - 1.5 * cell, cy - 1.5 * cell, 3 * cell, 3 * cell); c.globalAlpha = 1; }
}
function drawNote(c, x, y, size, col) {
  c.fillStyle = col; c.strokeStyle = col; c.lineWidth = Math.max(1.5, size * 0.08);
  if (settings.noteGlow) { c.shadowColor = col; c.shadowBlur = size * 0.35; }
  if (settings.noteShape === 'circle') { c.beginPath(); c.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); }
  else roundRect(c, x, y, size, size, settings.noteShape === 'square' ? size * 0.05 : size * 0.22);
  if (settings.noteFill) c.fill(); else c.stroke();
  c.shadowBlur = 0;
}
function drawCursor(c, cx, cy, cell) {
  if (!isFinite(cursor.sx)) return;
  const x = cx + cursor.sx * cell, y = cy + cursor.sy * cell, s = cell * 0.22 * settings.cursorSize;
  if (settings.trail && cursor.trail.length > 1) {
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (let i = 1; i < cursor.trail.length; i++) {
      const p = i / cursor.trail.length, a = cursor.trail[i - 1], b = cursor.trail[i];
      const col = settings.trailStyle === 'rainbow' ? `hsl(${(performance.now() / 10 + i * 20) % 360} 90% 65%)` : settings.trailStyle === 'stardust' ? '#ffd54f' : settings.trailStyle === 'comet' ? '#dfe8ff' : settings.trailStyle === 'fade' ? mixColor(settings.trailColor2, settings.trailColor, p) : settings.trailColor;
      c.strokeStyle = col; c.globalAlpha = settings.trailAlpha * p; c.lineWidth = (settings.trailStyle === 'thin' ? 2 : s * 0.9) * p + 1;
      c.beginPath(); c.moveTo(cx + a.x * cell, cy + a.y * cell); c.lineTo(cx + b.x * cell, cy + b.y * cell); c.stroke();
    }
    c.globalAlpha = 1;
  }
  c.fillStyle = settings.cursorColor; c.strokeStyle = settings.cursorColor; c.lineWidth = 2;
  if (settings.cursorGlow) { c.shadowColor = settings.cursorColor; c.shadowBlur = 14; }
  switch (settings.cursorStyle) {
    case 'dot': c.beginPath(); c.arc(x, y, s * 0.5, 0, Math.PI * 2); c.fill(); break;
    case 'ring': c.beginPath(); c.arc(x, y, s * 0.6, 0, Math.PI * 2); c.stroke(); break;
    case 'cross': c.beginPath(); c.moveTo(x - s, y); c.lineTo(x + s, y); c.moveTo(x, y - s); c.lineTo(x, y + s); c.stroke(); break;
    case 'diamond': c.beginPath(); c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y); c.closePath(); c.fill(); break;
    case 'star': c.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? s * 0.4 : s, a = -Math.PI / 2 + i * Math.PI / 5; c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } c.closePath(); c.fill(); break;
    default: roundRect(c, x - s / 2, y - s / 2, s, s, s * 0.2); c.fill();
  }
  c.shadowBlur = 0;
}
function mixColor(a, b, t) {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',')})`;
}
function drawCenterText(S, text) {
  ctx.fillStyle = 'rgba(7,7,12,0.6)'; ctx.fillRect(0, 0, S, S);
  ctx.textAlign = 'center'; ctx.fillStyle = '#8b8aa3'; ctx.font = `600 ${S * 0.04}px Outfit, sans-serif`; ctx.fillText(text, S / 2, S / 2);
}
function render(dt) {
  const S = view.size, cx = S / 2, cy = S / 2, cell = cellPx();
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);
  if (settings.bgStyle === 'gradient') { const g = ctx.createLinearGradient(0, 0, S, S); g.addColorStop(0, settings.bgColor); g.addColorStop(1, settings.bgColor2); ctx.fillStyle = g; ctx.fillRect(0, 0, S, S); }
  else if (settings.bgStyle === 'color') { ctx.fillStyle = settings.bgColor; ctx.fillRect(0, 0, S, S); }
  ctx.fillStyle = settings.bgStyle === 'black' ? '#030306' : `rgba(3,3,6,${settings.bgDim})`;
  ctx.fillRect(0, 0, S, S);
  const plx = settings.parallax && !settings.reduceMotion && isFinite(cursor.sx) ? cell * 0.04 : 0;
  drawGrid(ctx, cx - (cursor.sx || 0) * plx, cy - (cursor.sy || 0) * plx, cell);
  if (run) {
    const visible = [];
    for (let j = run.idx; j < run.notes.length; j++) {
      const z = (run.notes[j].t - run.time) / (run.approach / settings.approachRate);
      if (z > 1) break;
      visible.push([run.notes[j], z]);
    }
    const cols = NOTE_COLORS(), gf = run.mods.ghost2 ? 0.4 : run.mods.ghost ? 0.2 : null;
    for (let k = visible.length - 1; k >= 0; k--) {
      const [n, z] = visible[k];
      const s = 1 / (1 + Math.max(0, z) * PERSPECTIVE * settings.spawnDistance), size = cell * 0.84 * s;
      let [px, py] = notePos(n, run.time);
      if (run.mods.chaos || run.mods.chaos2) { const a = n.i * 2.399, d = Math.max(0, z) * (run.mods.chaos2 ? 3.2 : 1.6); px += Math.cos(a) * d; py += Math.sin(a) * d; }
      const x = cx + px * cell * s - size / 2, y = cy + py * cell * s - size / 2;
      let alpha = Math.min(1, (1 - z) * 4) * (gf != null ? Math.max(0, Math.min(1, (z - gf) / 0.3)) : 1);
      if (run.mods.fi && z > 0.45) alpha = 0;
      if (run.mods.co && z > 0.6) alpha = 0;
      ctx.globalAlpha = alpha;
      if (alpha > 0.01) drawNote(ctx, x, y, size, cols[n.i % cols.length]);
    }
    ctx.globalAlpha = 1;
    if (run.mods.fl && isFinite(cursor.sx)) {
      const r = cell * (1.6 - Math.min(0.7, run.combo / 200));
      const g = ctx.createRadialGradient(cx + cursor.sx * cell, cy + cursor.sy * cell, r * 0.5, cx + cursor.sx * cell, cy + cursor.sy * cell, r);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.96)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    }
    if (run.mods.bl && run.blind > 0) { ctx.fillStyle = `rgba(10,10,14,${0.9 * run.blind})`; const h = S * 0.5 * run.blind; ctx.fillRect(0, 0, S, h); ctx.fillRect(0, S - h, S, h); }
  }
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i]; f.age += dt;
    if (f.age > 0.35) { fx.splice(i, 1); continue; }
    const x = cx + f.x * cell, y = cy + f.y * cell, r = cell * 0.18;
    ctx.globalAlpha = 1 - f.age / 0.35; ctx.strokeStyle = settings.missColor; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  drawCursor(ctx, cx, cy, cell);
  if (run && run.done && run.wait) drawCenterText(S, 'Results are up');
}

/* ---------- HUD ---------- */
const GRADE_OF = acc => acc >= 1 ? 'SS' : acc >= 0.98 ? 'S' : acc >= 0.95 ? 'A' : acc >= 0.9 ? 'B' : acc >= 0.8 ? 'C' : 'D';
function renderHud() {
  if (!run) return;
  const judged = run.hits + run.misses, acc = judged ? run.hits / judged : 1;
  $('combo').textContent = run.combo;
  $('earned').textContent = fmt(run.earned);
  $('acc').textContent = (acc * 100).toFixed(judged ? 2 : 0) + '%';
  $('misses').textContent = run.misses;
  $('health').style.width = run.health + '%';
  $('time').textContent = `${clock(Math.max(0, run.time) / run.speed)} / ${clock(run.map.length / run.speed)}`;
  $('progress').style.width = Math.min(100, Math.max(0, run.time / run.map.length * 100)) + '%';
  $('scGrade').textContent = GRADE_OF(acc); $('scGrade').style.color = GRADE_COLORS[GRADE_OF(acc)];
  $('scScore').textContent = String(Math.floor(run.earned)).padStart(8, '0');
  $('scAcc').textContent = judged ? (acc * 100).toFixed(2) + '%' : '--';
  $('scMods').innerHTML = (run.speed !== 1 ? `<span style="--mc:#fff">${run.speed}×</span>` : '') + MODS.filter(m => run.mods[m.id]).map(m => `<span style="--mc:${m.color}">${m.short}</span>`).join('');
  const w = state.warm;
  $('warmLabel').textContent = w >= 1 ? 'Hot' : w >= 0.6 ? 'Warm' : w >= 0.2 ? 'Warming' : 'Cold';
  $('warmMark').style.left = (w * 100) + '%';
  $('warmEffect').textContent = `${Math.round((1 - warmMult() / 1.15) * 100)}% fewer misses · ×${warmXpMult().toFixed(2)} XP`;
  const lit = new Set(['aim', 'reading', ...run.trains]);
  for (const row of $('profile').children) { const id = row.dataset.id; row.classList.toggle('lit', lit.has(id)); row.querySelector('span').textContent = `Lv ${skillLvl(id)}`; }
  renderGoals();
  renderWidgets(acc);
  $('mpClock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function profileSvg(rows, id) {
  const r = rows[id];
  if (!r) return '';
  const max = Math.max(1, ...r);
  const pts = r.map((v, i) => `${(i / (r.length - 1) * 100).toFixed(1)},${(15 - v / max * 14).toFixed(1)}`).join(' ');
  return `<svg class="pGraph" viewBox="0 0 100 15" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${skillById(id).color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}
function renderProfile() {
  if (!run) return;
  const prof = buildProfile(run.notes, patternSkills());
  const ids = ['aim', 'reading', ...patternSkills().filter(s => prof.rows[s.id]).map(s => s.id)].slice(0, 9);
  $('profile').innerHTML = ids.map(id => `<div class="pRow" data-id="${id}"><b style="color:${skillById(id).color}">${skillById(id).name}</b><span>Lv ${skillLvl(id)}</span>${profileSvg(prof.rows, id)}</div>`).join('');
}
function renderGoals() {
  const g = currentGoal(), box = $('goals');
  if (!g) { box.hidden = true; }
  else { box.hidden = false; const have = Math.min(g.need, goalHave(g.id)); box.innerHTML = `<span>Goal: ${g.text}</span><div class="bar"><div style="width:${have / g.need * 100}%"></div></div><small>${fmt(have)}/${g.need}</small>`; }
  const hint = $('hintLine');
  const h = hintText();
  hint.hidden = !settings.hints || !h; if (h) { hint.textContent = h.text; hint.onclick = h.go; }
}
function hintText() {
  if (state.instinctPts > 0) return { text: `${state.instinctPts} instinct point${state.instinctPts > 1 ? 's' : ''} to spend`, go: () => { openPanel('skills'); setTab('instincts'); } };
  if (seasonStars() > 0 && seasonsSinceRebirth() < 999) return { text: `A new season would pay ${seasonStars()} star${seasonStars() > 1 ? 's' : ''}`, go: () => { openPanel('skills'); setTab('season'); } };
  if (ALL_SKILLS.some(s => prestigeReady(s.id))) return { text: 'A skill is ready to prestige', go: () => { openPanel('skills'); setTab('prestige'); } };
  if (STAR_SHOP.some(d => shopRank(d.id) < d.max && starWallet() >= shopCost(d))) return { text: 'Stars to spend in the shop', go: () => { openPanel('skills'); setTab('shop'); } };
  if (ALL_SKILLS.some(s => { const g = nextGear(s.id); return g && state.points >= g.cost && skillLvl(s.id) >= g.req; })) return { text: 'Gear you can afford', go: () => { openPanel('skills'); setTab('gear'); } };
  return null;
}
function renderWidgets(acc) {
  const rp = $('wRp'), st = $('wStats');
  rp.classList.toggle('hidden', !settings.wRp); st.classList.toggle('hidden', !settings.wStats);
  if (settings.wRp) {
    const left = run.notes.length - run.idx, ifFc = (run.hits + left) / Math.max(1, run.hits + run.misses + left);
    const b = state.best[run.map.id];
    rp.innerHTML = `<b>Live RP</b><span class="big">${playRp(run.map.stars * modStarMult(run.mods), acc, run.speed, run.misses, run.mods.nofail)}</span><br><small>FC the rest: ${playRp(run.map.stars * modStarMult(run.mods), ifFc, run.speed, run.misses, run.mods.nofail)} · best ${b ? b.rp : 0}</small>`;
  }
  if (settings.wStats) st.innerHTML = `<b>Play stats</b>${run.hits} hit · ${run.notes.length - run.idx} left<br>max combo ${run.maxCombo}x · ${(run.notes.length / run.map.length).toFixed(1)} notes/s<br>health ${Math.round(run.health)}%`;
}
function renderQueue() {
  topUpQueue();
  const q = state.queue.slice(0, 5);
  $('mpQueue').innerHTML = `<small>Up next${plPlaying() ? ` · playlist ${esc(plPlaying().name)}` : ''}</small>` + q.map((e, i) => { const m = mapById(e.id); return m ? `<div class="q${e.auto ? ' auto' : ''}"><i></i><span>${esc(m.title)}</span><small>${e.speed && e.speed !== 1 ? e.speed + '×' : ''} ${e.mods ? modShort(e.mods) : ''}</small><button data-dq="${i}" title="Remove">✕</button></div>` : ''; }).join('');
}
function renderPlayBoard() {
  if (!run) return;
  const rows = mapBoard(run.map);
  const meI = rows.findIndex(r => r.me);
  const show = meI < 0 ? rows.slice(0, 3).concat([{ name: playerName(), me: true, live: true }]) : rows.slice(Math.max(0, meI - 2), meI + 1);
  if (meI > 2) show.unshift(rows[0]);
  $('pvBoard').innerHTML = show.map(r => `<div class="pbRow${r.me ? ' me' : ''}">${avatar(r.name, r.me ? 320 : r.hue)}<div><b>${r.rank ? '#' + r.rank + ' ' : ''}${esc(shownName(r.name))}</b><small>${r.live ? 'playing now' : `${(r.acc * 100).toFixed(2)}% · ${r.rp} RP${r.speed !== 1 ? ' · ' + r.speed + '×' : ''}`}</small></div></div>`).join('');
}
function onRunStart() {
  const m = run.map;
  $('mapName').textContent = `${m.title} · mapped by ${m.mapper}`;
  $('mpTitle').textContent = m.title;
  $('mpState').textContent = `${shownStars(m, run.speed, run.mods).toFixed(2)}★`;
  $('pvBg').style.backgroundImage = settings.mapBg && m.img ? `url("${m.img}")` : '';
  hideResults();
  renderProfile();
  renderPlayBoard();
  renderQueue();
  renderHud();
}
Engine.on('runStart', onRunStart);
Engine.on('runEnd', () => {
  const r = run.result;
  goalCheck();
  if (settings.autoGear === 'always') buyAll();
  const line = r.passed ? `<b>${r.grade}</b> on <b>${esc(run.map.title)}</b> · ${(r.acc * 100).toFixed(2)}%${r.rp ? ` · ${r.rp} RP` : ''}${r.improved ? ' · new best' : ''}` : `Failed <b>${esc(run.map.title)}</b>${r.weak ? ` · weakest: ${r.weak}` : ''}`;
  tickerPush(line);
  for (const l of levelUps.splice(0)) toast(`<b>${skillById(l.id).name}</b> reached Lv ${l.lvl}`, 2000);
  const rk = rank();
  if (ui.lastRank && ui.lastRank !== rk.name) { toast(`<b>New title: ${rk.name}</b>`, 5000); state.titleLog.push({ at: Date.now(), name: rk.name }); }
  ui.lastRank = rk.name;
  renderPlayBoard();
  if (r.passed || settings.autoContinue === false) showResults();
  if (ui.open === 'skills') renderTabs();
});

/* ---------- results ---------- */
function healthSvg(end) {
  const W = 400, H = 100, hl = run.healthLog, at = run.healthAt, top = CONFIG.health, span = Math.max(1, end);
  const y = h => (8 + (1 - h / top) * (H - 16)).toFixed(1), x = t => (Math.min(1, Math.max(0, t / span)) * W).toFixed(1);
  let d = `M0,${y(top)}`, prev = top;
  for (let i = 0; i < hl.length; i++) { if (hl[i] === prev) continue; d += ` H${x(at[i])} V${y(hl[i])}`; prev = hl[i]; }
  d += ` H${x(end)}`;
  return `<svg class="rsHealth" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="rsHp" gradientUnits="userSpaceOnUse" x1="0" y1="${y(top)}" x2="0" y2="${y(0)}"><stop offset="0" stop-color="#5be37d"/><stop offset=".5" stop-color="#ffd54f"/><stop offset="1" stop-color="#ff4f6d"/></linearGradient></defs><path d="${d}"/></svg>`;
}
function showResults() {
  const r = run.result, m = run.map, el = $('results');
  if (!r) return;
  const end = r.passed ? m.length : Math.min(m.length, run.failTime || 0);
  const rows = [['Score', fmt(run.earned)], ['Accuracy', (r.acc * 100).toFixed(2) + '%'], ['Hits', fmt(run.hits)], ['Misses', fmt(run.misses)],
    ['RP', r.passed ? (r.improved ? `${r.rp} <small>${run.prevBestRp ? `was ${run.prevBestRp} · ` : ''}+${fmt(run.rpGain || 0)} total</small>` : `${r.rp} <small>best ${run.prevBestRp || 0} · +0 total</small>`) : '0'],
    r.passed ? ['Max combo', `${run.maxCombo}x`] : ['Fail time', clock((run.failTime || 0) / run.speed)]];
  const xp = Object.values(run.xp).reduce((a, b) => a + b, 0);
  if (xp) rows.push([r.passed ? 'XP banked' : 'XP lost', `${r.passed ? '+' : ''}${fmt(xp)}`]);
  const mods = [run.speed !== 1 ? `${run.speed}×` : '', ...MODS.filter(x => run.mods[x.id]).map(x => x.name)].filter(Boolean);
  const mask = state.mastery[m.id] || 0;
  el.innerHTML = `<div class="rsBg"${m.img ? ` style="background-image:url('${m.img}')"` : ''}></div><div class="rsBox">
    <header class="rsHead">${m.img ? `<img class="rsCover" src="${m.img}" alt="">` : '<div class="rsCover"></div>'}
      <div class="rsMap"><h2>${esc(m.title)}</h2><b>by ${esc(m.mapper)}</b>${r.passed || mask ? `<div class="msRs">${MASTERY_BITS.map(s => mask & s.bit ? '★' : '☆').join('')}${run.masteryNew ? ` <small>Mastery: ${MASTERY_BITS.filter(s => run.masteryNew & s.bit).map(s => s.name).join(', ')}</small>` : ''}</div>` : ''}
        <p>Played by ${esc(playerName())} on ${new Date().toLocaleString()}</p></div>
      <b class="rsGrade" style="color:${GRADE_COLORS[r.grade]}">${r.grade}</b></header>
    <section class="rsStats"><h3>Statistics</h3><div class="rsCard">${rows.map(([k, v]) => `<div class="rsRow"><span>${k}</span><i></i><b>${v}</b></div>`).join('')}</div></section>
    <section class="rsGraph"><h3>Health Graph</h3><div class="rsCard"><div class="rsTimes"><span>00:00</span><span>${clock(end)}</span></div>${healthSvg(end)}</div></section>
    <section class="rsMods"><h3>Mods</h3><div class="rsCard">${mods.length ? mods.map(x => `<span>${esc(x)}</span>`).join('') : '<small>None</small>'}</div></section>
    <footer class="rsFoot"><button data-rs="back">Back</button><div class="rsNext">${run.wait ? 'Retry, or go back to pick a map.' : `Next: ${state.queue[0] && mapById(state.queue[0].id) ? esc(mapById(state.queue[0].id).title) : r.passed ? 'playing again shortly' : 'retrying shortly'}`}</div><button data-rs="retry">Retry</button></footer></div>`;
  el.onclick = e => {
    const b = e.target.closest('[data-rs]');
    if (!b) return;
    if (b.dataset.rs === 'retry' && run && run.done) { run.wait = false; run.retry = true; run.endTimer = 0; hideResults(); }
    else if (b.dataset.rs === 'back') { hideResults(); openPanel('maps'); }
  };
  el.classList.remove('hidden');
}
const hideResults = () => $('results').classList.add('hidden');

/* ---------- skills panel ---------- */
const TAB_INTRO = {
  skills: 'Skills level up by playing: every note trains the skills it tests. Higher levels miss less, read denser sections and reach further.',
  gear: 'Gear multiplies a skill\'s XP. Each tier needs the skill at a minimum level. Owning five tiers on every skill of a group adds a set bonus.',
  instincts: 'Instinct points come from seasons. Natural, Head start, Gifted and Craft make one skill stronger for good; perks help the whole game.',
  prestige: 'A skill at Lv 50 can prestige: it starts over with ×1.1 XP for good and one more gear tier. Up to five times per skill.',
  shop: 'Stars are a wallet too: buy boosts and looks with them. The passive star bonus keeps counting every star you have.',
  unlocks: 'Shards come from seasons that ran two hours or more. They buy faster speeds, plus mods and Overdrive.',
  season: 'A season ends when you want it to: stars are paid from your total RP, skills, gear, points and bests start over, instincts stay.',
  rebirth: 'After five seasons, a rebirth starts you over from no stars and no instincts, keeping prestiges, and unlocks one feature each time.',
  ascend: 'After ten rebirths, an Ascension resets everything else for three new skills, Trials, Relics and ×2 XP and points for good.',
  transcend: 'Every five Ascensions, Transcendence pays Echoes for the echo tree and ×10 XP and points. It resets nothing.',
  boosts: 'Everything multiplying your XP and points right now, and where it comes from.',
};
function setTab(id) { ui.tab = id; state.tab = id; ui.seen.add(id); renderTabs(); }
function renderTabs() {
  for (const b of $('tabs').querySelectorAll('button')) { b.classList.toggle('on', b.dataset.tab === ui.tab); b.classList.toggle('isNew', tabNew(b.dataset.tab)); }
  $('tabWhere').innerHTML = `<span>Points <b>${fmt(state.points)}</b> · ${fmt(state.ppsAvg)}/s</span><span>RP <b>${totalRp().toFixed(0)}</b></span><span>Stars <b>${state.stars}</b> (${starWallet()} free)</span><span>Instinct points <b>${state.instinctPts}</b></span><span>Shards <b>${shardWallet()}</b></span><span>Season <b>${state.seasons + 1}</b></span>`;
  $('tabIntro').textContent = TAB_INTRO[ui.tab] || '';
  const body = $('tabBody');
  body.innerHTML = ({ skills: skillsHtml, gear: gearHtml, instincts: instinctsHtml, prestige: prestigeHtml, shop: shopHtml, unlocks: unlocksHtml, season: seasonHtml, rebirth: rebirthHtml, ascend: ascendHtml, transcend: transcendHtml, boosts: boostsHtml })[ui.tab]();
}
function tabNew(id) {
  if (ui.seen.has(id)) return false;
  return (id === 'instincts' && state.instinctPts > 0) || (id === 'season' && seasonStars() > 0) || (id === 'prestige' && ALL_SKILLS.some(s => prestigeReady(s.id))) || (id === 'rebirth' && rebirthReady()) || (id === 'ascend' && ascendReady()) || (id === 'shop' && starWallet() > 0) || (id === 'unlocks' && shardWallet() > 0);
}
function groupsHtml(rowFn, tab) {
  return SKILL_GROUPS.map(g => `<section class="grp" data-grp="${tab}${g.id}"><div class="grpHead" data-grp-toggle><span class="grpDots">${g.ids.map(id => `<i style="background:${skillById(id).color}"></i>`).join('')}</span><b>${g.name}</b><small>${g.ids.length} skills</small><span class="grpSum">${tab === 'gear' ? `set bonus ×${Math.pow(SET_MULT, setLevel(g)).toFixed(2)} <button data-buyall="${g.ids.join(',')}">Buy all</button>` : `Lv ${g.ids.reduce((a, id) => a + skillLvl(id), 0)} total`}</span><span class="grpChev"></span></div><div class="grpBody">${g.ids.map(rowFn).join('')}</div></section>`).join('');
}
function skillsHtml() {
  return groupsHtml(id => { const s = skillById(id), sk = state.skills[id], need = xpNeeded(sk.lvl);
    return `<div class="sRow"><div class="sName"><i style="background:${s.color}"></i>${s.name}</div><div class="sLvl">Lv ${sk.lvl}${effLvl(id) > sk.lvl ? `<small> +${effLvl(id) - sk.lvl}</small>` : ''}</div><div class="sInfo"><span>${skillEffect(id, effLvl(id))}</span><div class="bar"><div style="width:${sk.lvl >= CONFIG.maxLvl ? 100 : sk.xp / need * 100}%"></div></div><span>${sk.lvl >= CONFIG.maxLvl ? 'maxed' : `${fmt(sk.xp)} / ${fmt(need)} XP`} · ×${xpMult(id).toFixed(2)} XP · trains on ${s.trains}</span></div><div class="sAct"><small>${s.blurb}</small></div></div>`; }, 'skills');
}
function gearHtml() {
  return `<div class="wallet"><span>Points <b>${fmt(state.points)}</b></span><span>Auto-buy: <b>${settings.autoGear === 'always' ? 'after every play' : settings.autoGear === 'away' ? 'while away' : 'off'}</b></span><button data-buyall="${ALL_SKILLS.map(s => s.id).join(',')}">Buy everything you can</button></div>` +
    groupsHtml(id => { const s = skillById(id), g = nextGear(id), own = state.gear[id] || 0;
      return `<div class="sRow${g && state.points >= g.cost && skillLvl(id) >= g.req ? ' ready' : ''}"><div class="sName"><i style="background:${s.color}"></i>${s.name}</div><div class="sLvl">${own}<small>/${gearMax(id)}</small></div><div class="sInfo"><span>${own ? `Owned: ${gearName(id, own - 1)} · ×${gearXpMult(id).toFixed(2)} XP` : 'No gear yet'}</span><span>${g ? `Next: <b>${g.name}</b> · needs Lv ${g.req}` : 'Every tier owned'}</span></div><div class="sAct">${g ? `<button data-gear="${id}" ${state.points < g.cost || skillLvl(id) < g.req ? 'disabled' : ''}>${fmt(g.cost)} pts</button>` : ''}</div></div>`; }, 'gear');
}
function instinctsHtml() {
  const sel = ui.instSkill && skillById(ui.instSkill) ? ui.instSkill : ALL_SKILLS[0].id;
  ui.instSkill = sel;
  const nodes = INSTINCTS.map(d => { const have = instinct(sel, d.id), max = instMax(d);
    const detail = d.craft ? CRAFT[sel].slice(0, Math.max(1, have)).map((c, k) => `${c[0]}: ${c[3]}`).join(' · ') + (have < max ? ` · next: ${CRAFT[sel][have][0]} (${CRAFT[sel][have][3]})` : '') : d.twig ? twigText(sel, d.id) : d.desc(Math.max(1, have)) + (have ? ` now · next ${d.desc(have + 1)}` : '');
    return `<div class="node"><div><b>${d.name}</b> <span class="dots">${Array.from({ length: max }, (_, i) => `<i class="${i < have ? 'on' : ''}"></i>`).join('')}</span><small>${detail}</small></div><button data-inst="${sel}:${d.id}" ${have >= max || state.instinctPts < d.cost ? 'disabled' : ''}>${have >= max ? 'Max' : `${d.cost} pt${d.cost > 1 ? 's' : ''}`}</button></div>`; }).join('');
  const dev = devotionOpen(sel) ? `<div class="node"><div><b>Devotion</b> ${devotionOf(sel)}/${devotionMax()}<small>+6% XP per rank on ${skillById(sel).name}, for good</small></div><button data-dev="${sel}" ${devotionOf(sel) >= devotionMax() || state.instinctPts < devotionCost(sel) ? 'disabled' : ''}>${devotionCost(sel)} pts</button></div>` : `<p class="small">Devotion opens once Natural is complete on this skill.</p>`;
  const perks = PERKS.map(d => `<div class="node"><div><b>${d.name}</b> <span class="cRank">${perkRank(d.id)}/${perkMax(d)}</span><small>${d.desc(Math.max(1, perkRank(d.id)))}${perkRank(d.id) && perkRank(d.id) < perkMax(d) ? ` · next ${d.desc(perkRank(d.id) + 1)}` : ''}</small></div><button data-perk="${d.id}" ${perkRank(d.id) >= perkMax(d) || state.instinctPts < d.cost ? 'disabled' : ''}>${perkRank(d.id) >= perkMax(d) ? 'Max' : `${d.cost} pt${d.cost > 1 ? 's' : ''}`}</button></div>`).join('');
  return `<div class="wallet"><span>Instinct points <b>${state.instinctPts}</b></span><button data-respec>Respec (refund everything, skills restart)</button></div>
    <div class="inst"><div class="list">${ALL_SKILLS.map(s => `<button data-instsel="${s.id}" class="${s.id === sel ? 'on' : ''}"><span style="color:${s.color}">${s.name}</span><small>${Object.values(state.instincts[s.id] || {}).reduce((a, b) => a + b, 0)} pts</small></button>`).join('')}</div>
    <div class="instNodes"><h3 style="color:${skillById(sel).color}">${skillById(sel).name}</h3>${nodes}${dev}<h3 style="margin-top:14px">Perks</h3>${perks}</div></div>`;
}
function prestigeHtml() {
  return groupsHtml(id => { const s = skillById(id), p = prestigeOf(id), ready = prestigeReady(id);
    return `<div class="sRow${ready ? ' ready' : ''}"><div class="sName"><i style="background:${s.color}"></i>${s.name}</div><div class="sLvl">${ROMAN[p] || '–'}<small> /${ROMAN[PRESTIGE.max]}</small></div><div class="sInfo"><span>Lv ${skillLvl(id)} · ${p >= PRESTIGE.max ? 'fully prestiged' : `needs Lv ${prestigeReq(id)}`}</span><span>×${prestigeXpMult(id).toFixed(2)} XP · ${gearMax(id)} gear tiers</span></div><div class="sAct"><button data-prestige="${id}" ${ready ? '' : 'disabled'}>Prestige</button></div></div>`; }, 'prestige');
}
function shopHtml() {
  const items = STAR_SHOP.map(d => `<div class="card${shopRank(d.id) >= d.max ? ' done' : ''}"><b>${d.name} <span class="cRank">${shopRank(d.id)}/${d.max}</span></b><span>${d.desc(Math.max(1, shopRank(d.id)))}</span>${shopRank(d.id) < d.max ? `<button data-shop="${d.id}" ${starWallet() < shopCost(d) ? 'disabled' : ''}>${shopCost(d)} ★</button>` : '<small>Owned</small>'}</div>`).join('');
  const ms = STAR_MILESTONES.map(m => `<div class="card${milestoneHave(m.id) ? ' done' : ' locked'}"><b>${m.at} stars ever</b><span>${m.desc}</span></div>`).join('');
  return `<div class="wallet"><span>Stars <b>${starWallet()}</b> free of ${state.stars}</span><span>Stars ever <b>${state.starsEver || 0}</b></span><span>Shop discount <b>${Math.round((1 - shopDiscount()) * 100)}%</b></span></div><h3>Star shop</h3><div class="cardGrid">${items}</div><h3 style="margin-top:16px">Star milestones</h3><div class="cardGrid">${ms}</div>`;
}
function unlocksHtml() {
  const items = SHARD_UNLOCKS.map(u => `<div class="card${shardHas(u.id) ? ' done' : shardReady(u) ? '' : ' locked'}"><b>${u.name}</b><span>${u.desc}</span>${shardHas(u.id) ? '<small>Owned</small>' : `<button data-shard="${u.id}" ${!shardReady(u) || shardWallet() < u.cost ? 'disabled' : ''}>${u.cost} shards${u.after && !shardHas(u.after) ? ' · needs ' + u.after + '×' : ''}</button>`}</div>`).join('');
  return `<div class="wallet"><span>Shards <b>${shardWallet()}</b></span><span>Each season of ${SEASON_SHARD_HOURS}h+ that reaches ${CONFIG.seasonMinRp} RP pays ${SEASON_SHARDS}</span><button data-overdrive ${shardWallet() < OVERDRIVE.cost ? 'disabled' : ''}>Overdrive: ×2 XP for ${OVERDRIVE.minutes} min (${OVERDRIVE.cost} shards)${overdriveLeft() ? ` · ${Math.ceil(overdriveLeft() / 60000)} min left` : ''}</button></div><div class="cardGrid">${items}</div>`;
}
function seasonHtml() {
  const gain = seasonStars(), rp = totalRp();
  const badges = (state.seasonLog || []).slice(-12).map(s => `<span>S${s.n} · ${s.rp} RP · ${s.stars}★</span>`).join('');
  return `<div class="resetCard"><h3>Season ${state.seasons + 1}</h3><div class="big">${gain} ★</div><p class="small">${rp < CONFIG.seasonMinRp ? `Stars start at ${CONFIG.seasonMinRp} RP: you have ${rp.toFixed(0)}.` : `Ending now pays ${gain} star${gain === 1 ? '' : 's'} and ${seasonPoints(gain)} instinct point${seasonPoints(gain) === 1 ? '' : 's'}. Each star: +10% XP, +25% points, +2% cursor speed.`}</p>
    <ul><li>Resets: skill levels, gear, points, map bests and RP</li><li>Keeps: stars, instincts, perks, prestiges, shop, shards, playlists, mastery</li><li>Season so far: ${fmtTime((Date.now() - state.seasonStart.at) / 1000)} · ${state.stats.plays - state.seasonStart.plays} plays · title ${rank().name}</li></ul>
    <div><button class="primary" data-season ${gain ? '' : 'disabled'}>Start a new season</button></div></div>
    <h3 style="margin-top:16px">Season badges</h3><div class="seasonBadges">${badges || '<small>No seasons finished yet.</small>'}</div>`;
}
function rebirthHtml() {
  const n = state.rebirths || 0, next = REBIRTH_UNLOCKS[n];
  const list = REBIRTH_UNLOCKS.map((u, i) => `<div class="card${unlocked(u.id) ? ' done' : i === n ? '' : ' locked'}"><b>${i + 1}. ${u.name}</b><span>${u.desc}</span></div>`).join('');
  return `<div class="resetCard"><h3>Rebirth ${n + 1}</h3><div class="big">${seasonsSinceRebirth()} / ${rebirthSeasons()} seasons</div><p class="small">A rebirth starts you over from no stars${heirloomShare() ? ` (Heirloom keeps ${Math.round(heirloomShare() * 100)}%)` : ''} and no instincts. Prestiges, the shop, shards and mastery stay. Every rebirth adds ×${REBIRTH.xp} XP for good${next ? ` and unlocks <b>${next.name}</b>` : ''}.</p><div><button class="primary" data-rebirth ${rebirthReady() ? '' : 'disabled'}>Rebirth</button></div></div><h3 style="margin-top:16px">Unlocks</h3><div class="cardGrid">${list}</div>`;
}
function ascendHtml() {
  const a = ascRank();
  const trials = TRIALS.map(t => { const on = state.trial && state.trial.id === t.id; return `<div class="card${on ? ' done' : trialOpen(t) ? '' : ' locked'}"><b>${t.name}${t.lvl === 2 ? ' II' : ''}</b><span>${t.rule}</span><small>Relic: ${RELICS.find(r => r.id === t.relic).name}${t.asc > 1 ? ` · Ascension ${t.asc}` : ''}</small>${on ? `<span>Progress ${state.trial.prog.toFixed(1)} / ${trialGoal()} stars</span>` : a >= 1 && trialOpen(t) ? `<button data-trial="${t.id}">Start trial</button>` : ''}</div>`; }).join('');
  const relics = RELICS.map(r => { const have = (state.relics || {})[r.id]; return `<div class="card${relicOn(r.id) ? ' done' : have ? '' : ' locked'}"><b>${r.name}${have >= 2 ? ' II' : ''}</b><span>${have >= 2 && r.desc2 ? r.desc2 : r.desc}</span>${have ? `<button data-relic="${r.id}">${relicOn(r.id) ? 'Take off' : 'Wear'}</button>` : '<small>Not won yet</small>'}</div>`; }).join('');
  return `<div class="resetCard"><h3>Ascension ${a + 1}</h3><div class="big">${state.rebirths || 0} / ${ASCEND.rebirths} rebirths</div><p class="small">An Ascension resets rebirths, prestiges, the shop and Devotion too. It opens three new skills (One Shot, Techs, Unconventional), Trials and Relics, and multiplies XP and points by ×${ASCEND.mult} for good.</p>
    ${ASC_MILESTONES[a + 1] ? `<ul>${ASC_MILESTONES[a + 1].map(x => `<li>${x}</li>`).join('')}</ul>` : ''}<div><button class="primary" data-ascend ${ascendReady() ? '' : 'disabled'}>Ascend</button></div></div>
    <h3 style="margin-top:16px">Trials ${a ? `· relic slots ${(state.relicsOn || []).length}/${relicSlots()}` : '(after the first Ascension)'}</h3><div class="cardGrid">${trials}</div><h3 style="margin-top:16px">Relics</h3><div class="cardGrid">${relics}</div>`;
}
function transcendHtml() {
  const tree = ECHO_NODES.map(d => { const r = echoRank(d.id); return `<div class="card${r >= d.costs.length ? ' done' : ''}"><b>${d.name} <span class="cRank">${r}/${d.costs.length}</span></b><span>${d.desc}</span>${r < d.costs.length ? `<button data-echo="${d.id}" ${(state.echoes || 0) < d.costs[r] ? 'disabled' : ''}>${d.costs[r]} echo${d.costs[r] > 1 ? 'es' : ''}</button>` : '<small>Complete</small>'}</div>`; }).join('');
  return `<div class="resetCard"><h3>Transcendence ${(state.transcends || 0) + 1}</h3><div class="big">${ascRank()} / ${transcendNext()} Ascensions</div><p class="small">Transcendence resets nothing. It pays ${TRANSCEND.asc} Echoes and multiplies XP and points by ×${TRANSCEND.mult}, for good.</p><div><button class="primary" data-transcend ${transcendReady() ? '' : 'disabled'}>Transcend</button></div></div>
    <h3 style="margin-top:16px">Echo tree · ${state.echoes || 0} echoes</h3><div class="cardGrid">${tree}</div>`;
}
function boostsHtml() {
  const rows = [
    ['Gear (average over skills)', `×${(ALL_SKILLS.reduce((a, s) => a + gearXpMult(s.id), 0) / ALL_SKILLS.length).toFixed(2)} XP`],
    ['Stars', `×${starXpMult().toFixed(2)} XP · ×${starPointsMult().toFixed(2)} points`],
    ['Warm-up', `×${warmXpMult().toFixed(2)} XP · ${Math.round((1 - warmMult() / 1.15) * 100)}% fewer misses`],
    ['Rebirths', `×${rebirthXpMult().toFixed(2)} XP`],
    ['Shop, perks, milestones', `×${shopXpMult('aim').toFixed(2)} XP (Aim)`],
    ['Overdrive', `×${overdriveXpMult()} XP`],
    ['Ascension, Transcendence, Echoes', `×${ascMult().toFixed(1)} XP and points`],
    ['RP', `×${rpPointsMult().toFixed(2)} points`],
    ['Income boosts (perks, unlocks, shop, welcome back)', `×${incomeBoost().toFixed(2)} points`],
    ['Daily streak', `${state.streak.count} day${state.streak.count === 1 ? '' : 's'} · ×${streakMult().toFixed(2)}`],
    ['Points per second (recent)', `${fmt(state.ppsAvg)}/s`],
  ];
  return `<table class="boostTable">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
}
$('tabBody').addEventListener('click', e => {
  const t = e.target.closest('button, [data-grp-toggle]');
  if (!t) return;
  const d = t.dataset;
  if (t.hasAttribute('data-grp-toggle')) { if (e.target.closest('[data-buyall]')) return; t.parentElement.classList.toggle('shut'); return; }
  if (d.buyall) { const n = buyAll(d.buyall.split(',')); toast(n ? `Bought ${n} gear tier${n > 1 ? 's' : ''}` : 'Nothing affordable yet'); }
  else if (d.gear) buyGear(d.gear);
  else if (d.instsel) ui.instSkill = d.instsel;
  else if (d.inst) { const [sk, id] = d.inst.split(':'); buyInstinct(sk, id); }
  else if (d.dev) buyDevotion(d.dev);
  else if (d.perk) buyPerk(d.perk);
  else if (t.hasAttribute('data-respec')) { showModal('<h3>Respec instincts?</h3><p>Every instinct point and perk is refunded. Skills start this season over.</p>', [{ label: 'Cancel' }, { label: 'Respec', primary: true, onClick: () => { const n = respecInstincts(); toast(`${n} instinct points refunded`); renderTabs(); } }]); return; }
  else if (d.prestige) { if (prestigeSkill(d.prestige)) toast(`<b>${skillById(d.prestige).name}</b> prestiged`); }
  else if (d.shop) buyShop(d.shop);
  else if (d.shard) buyShardUnlock(d.shard);
  else if (t.hasAttribute('data-overdrive')) buyOverdrive();
  else if (t.hasAttribute('data-season')) { showModal(`<h3>Start a new season?</h3><p>You get ${seasonStars()} stars and ${seasonPoints(seasonStars())} instinct points. Skills, gear, points and bests start over.</p>`, [{ label: 'Cancel' }, { label: 'New season', primary: true, onClick: () => { startSeason(); renderTabs(); } }]); return; }
  else if (t.hasAttribute('data-rebirth')) { showModal('<h3>Rebirth?</h3><p>Stars and instincts are gone. Prestiges, the shop and shards stay.</p>', [{ label: 'Cancel' }, { label: 'Rebirth', primary: true, onClick: () => { rebirth(); toast('<b>Reborn</b>'); renderTabs(); } }]); return; }
  else if (t.hasAttribute('data-ascend')) { showModal('<h3>Ascend?</h3><p>Everything but Ascensions, relics and echoes starts over.</p>', [{ label: 'Cancel' }, { label: 'Ascend', primary: true, onClick: () => { ascend(); toast('<b>Ascended</b>: three new skills opened'); renderTabs(); } }]); return; }
  else if (t.hasAttribute('data-transcend')) transcend();
  else if (d.trial) startTrial(d.trial);
  else if (d.relic) wearRelic(d.relic);
  else if (d.echo) buyEcho(d.echo);
  renderTabs();
});
Engine.on('season', r => toast(`<b>Season ${r.n} done</b> · ${r.stars} stars · ${r.rp} RP · ${r.plays} plays`, 7000));

/* ---------- map select ---------- */
const LIST_TABS = () => [...TIERS, { id: 'custom', name: 'Custom', color: '#c58bff', custom: true }, { id: 'lists', name: 'Playlists', color: '#7c9dff', lists: true }];
function listMaps() {
  const f = state.filter, tab = LIST_TABS().find(t => t.id === f.tier) || TIERS[0], q = f.q.trim().toLowerCase();
  let list;
  if (tab.lists) { const pl = plById(ui.pl) || state.playlists[0]; list = pl ? pl.maps.map(mapById).filter(Boolean) : []; }
  else if (tab.custom) list = MAPS.filter(m => m.status === 'custom');
  else list = MAPS.filter(m => m.status !== 'custom' && m.stars >= tab.min && m.stars < tab.max);
  if (f.status !== 'all') list = list.filter(m => m.status === f.status);
  if (q) list = (tab.lists ? list : MAPS).filter(m => m.title.toLowerCase().includes(q) || m.mapper.toLowerCase().includes(q));
  const sorts = { stars: (a, b) => a.stars - b.stars, starsDesc: (a, b) => b.stars - a.stars, plays: (a, b) => b.plays - a.plays, length: (a, b) => a.length - b.length, title: (a, b) => a.title.localeCompare(b.title),
    best: (a, b) => ((state.best[b.id] || {}).rp || 0) - ((state.best[a.id] || {}).rp || 0), unplayed: (a, b) => ((state.best[a.id] || {}).passes || 0) - ((state.best[b.id] || {}).passes || 0), pass: (a, b) => passChance(b) - passChance(a) };
  if (f.sort.startsWith('skill:')) { const id = f.sort.slice(6); list.sort((a, b) => skillShare(b, id) - skillShare(a, id)); }
  else list.sort(sorts[f.sort] || sorts.stars);
  return list;
}
function renderSelect() {
  if (!ui.browse.id) ui.browse.id = state.selectedMap;
  const f = state.filter, d = dailyToday();
  $('selControls').innerHTML = `<div class="tierTabs">${LIST_TABS().map(t => `<button data-tier="${t.id}" class="${f.tier === t.id ? 'on' : ''}" style="--tier:${t.color}">${t.name}</button>`).join('')}</div>
    <div class="mapFilters"><input id="mapSearch" type="search" placeholder="Search maps or mappers" value="${esc(f.q)}"><select id="mapSort">${[['stars', 'Stars ↑'], ['starsDesc', 'Stars ↓'], ['pass', 'Pass chance'], ['plays', 'Most played'], ['best', 'Your best RP'], ['unplayed', 'Unplayed first'], ['length', 'Length'], ['title', 'Title'], ...patternSkills().map(s => ['skill:' + s.id, 'Most ' + s.name.toLowerCase()])].map(([v, n]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${n}</option>`).join('')}</select><select id="mapStatus">${[['all', 'All'], ['ranked', 'Ranked'], ['legacy', 'Legacy'], ['custom', 'Custom']].map(([v, n]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    <div class="dailyRow"><b>Daily</b>${TIERS.map(t => { const id = d.maps[t.id], done = state.daily.done[t.id]; return id ? `<button data-daily="${id}" data-dtier="${t.id}" class="${done ? 'done' : ''}" style="color:${t.color}">${t.name}${done ? ' ✓ ' + done.grade : ''}</button>` : ''; }).join('')}<small>${d.mod ? `mod: ${MODS.find(m => m.id === d.mod).name}` : 'no mod'} · resets in ${untilReset()} · +${fmt(dailyBonus())} each</small></div>
    ${f.tier === 'lists' ? `<div class="plBar">${state.playlists.map(p => `<button data-pl="${p.id}" class="${(plById(ui.pl) || state.playlists[0]) === p ? 'on' : ''}">${esc(p.name)} (${p.maps.length})</button>`).join('')}<button data-plnew>+ New playlist</button>${plById(ui.pl) ? `<button data-plplay>Play</button><button data-plshuffle>Shuffle</button><button data-plren>Rename</button><button data-pldel class="danger">Delete</button>` : ''}${plPlaying() ? '<button data-plstop>Stop playlist</button>' : ''}</div>` : ''}`;
  renderSelectList();
  renderSelectDetail();
}
function renderSelectList() {
  const list = listMaps(), page = ui.browse.page, PER = 40;
  const shown = list.slice(0, (page + 1) * PER);
  $('selList').innerHTML = shown.map(m => { const t = tierOf(m), b = state.best[m.id];
    return `<button class="selCard${m.id === ui.browse.id ? ' on' : ''}" data-map="${m.id}" style="--tier:${t.color}">${settings.thumbnails && m.img ? `<img src="${m.img}" alt="" loading="lazy">` : '<div class="noCover"></div>'}<div><div class="t">${esc(m.title)}</div><div class="s"><span>${esc(m.mapper)}</span><span>${fmtLen(m.length)}</span><span>${m.notes} notes</span><span class="status">${m.status}</span>${b && b.passes ? `<span>best ${b.rp} RP</span>` : ''}</div></div><div class="sr">${m.stars.toFixed(2)}★${b && b.passes ? `<span class="gr" style="color:${GRADE_COLORS[b.grade]}">${b.grade}</span>` : ''}</div></button>`; }).join('')
    + (shown.length < list.length ? `<button class="selMore" data-more>Show more (${list.length - shown.length} left)</button>` : '') + (!list.length ? '<p class="small">No maps match.</p>' : '');
}
function renderSelectDetail() {
  const m = mapById(ui.browse.id);
  if (!m) { $('selDetail').innerHTML = ''; return; }
  const b = state.best[m.id], hist = state.history[m.id] || [], trains = mapTrains(m), board = mapBoard(m), pc = passChance(m, state.speed, state.mods);
  const mask = state.mastery[m.id] || 0;
  $('selDetail').innerHTML = `${m.img ? `<img class="selCover" src="${m.img}" alt="">` : '<div class="selCover none">no cover</div>'}
    <div class="selTitle">${esc(m.title)}</div>
    <div class="selMeta"><span>mapped by <b>${esc(m.mapper)}</b></span><span><b>${shownStars(m).toFixed(2)}★</b> ${state.speed !== 1 || modStarMult(state.mods) !== 1 ? `(${m.stars.toFixed(2)} base)` : ''}</span><span><b>${fmtLen(m.length / state.speed)}</b></span><span><b>${m.notes}</b> notes</span><span><b>${fmt(m.plays)}</b> plays</span><span class="status">${m.status}</span></div>
    <div class="selMeta"><span>Pass chance <b style="color:${pc > 0.7 ? 'var(--good)' : pc > 0.4 ? '#ffd54f' : 'var(--bad)'}">${Math.round(pc * 100)}%</b></span><span>Best <b>${b && b.passes ? `${b.rp} RP · ${(b.acc * 100).toFixed(2)}% ${b.grade}` : 'not passed'}</b></span><span>Mastery <b class="msRs">${MASTERY_BITS.map(s => mask & s.bit ? '★' : '☆').join('')}</b></span></div>
    <div class="selTrains">${trains.map(s => `<span style="--c:${s.color}">${s.name}</span>`).join('') || '<small>Trains only the fundamentals</small>'}</div>
    <div class="selPlayRow"><button class="primary selPlay" data-play="${m.id}">Play</button><button data-queue="${m.id}">+ Queue</button><button data-plAdd="${m.id}">+ Playlist</button></div>
    <h2>Speed</h2><div class="speedRow">${SPEEDS.map(s => `<button class="speedBtn${state.speed === s.rate ? ' on' : ''}${speedOpen(s) ? '' : ' lock'}" data-speed="${s.rate}" title="${speedOpen(s) ? '' : 'Buy in Skills, Unlocks'}">${s.label}${speedOpen(s) ? '' : ' 🔒'}</button>`).join('')}</div>
    <h2>Mods</h2><div class="modGroups">${MOD_GROUPS.map(g => `<div class="modGroup"><small>${g.name}</small><div>${g.ids.map(id => { const x = MODS.find(mm => mm.id === id); const on = x.cycle ? state.mods[id] > 0 : !!state.mods[id]; return `<button class="modBtn${on ? ' on' : ''}${modOpen(x) ? '' : ' lock'}" style="--mc:${x.color}" data-mod="${id}" title="${esc(x.tip)}. ${esc(x.effect)}">${x.name}${x.cycle && state.mods[id] ? ': ' + x.cycle[state.mods[id]] : ''}${modOpen(x) ? '' : ' 🔒'}</button>`; }).join('')}</div></div>`).join('')}</div>
    <h2>Map leaderboard</h2><div class="boardMini">${board.map(r => `<div class="r${r.me ? ' me' : ''}"><span>#${r.rank}</span><span>${esc(shownName(r.name))}</span><span>${(r.acc * 100).toFixed(1)}%</span><span>${r.rp} RP</span></div>`).join('') || '<small>No plays yet</small>'}</div>
    <h2>Recent plays</h2><div class="histList">${hist.slice(0, 6).map(h => `<span>${h.passed ? `<b style="color:${GRADE_COLORS[h.grade]}">${h.grade}</b> ${(h.acc * 100).toFixed(2)}% · ${h.rp} RP` : `<b style="color:var(--bad)">F</b> at ${clock(h.failAt || 0)}`} · ${h.speed}× ${h.mods} · ${new Date(h.at).toLocaleDateString()}</span>`).join('') || '<small>Not played yet</small>'}</div>`;
}
$('select').addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  if (d.tier) { state.filter.tier = d.tier; ui.browse.page = 0; renderSelect(); }
  else if (d.map) { ui.browse.id = +d.map; $('select').classList.add('detail'); renderSelectList(); renderSelectDetail(); }
  else if (t.hasAttribute('data-more')) { ui.browse.page++; renderSelectList(); }
  else if (d.play) { closePanels(); playNow(+d.play); }
  else if (d.queue) { addToQueue(+d.queue); toast('Added to Up next'); renderQueue(); }
  else if (d.daily) { closePanels(); playNow(+d.daily, { daily: true }); }
  else if (d.speed) { state.speed = +d.speed; if (!speedOpen(SPEEDS.find(s => s.rate === state.speed))) { state.speed = 1; toast('That speed needs shards: Skills, Unlocks'); } renderSelectDetail(); }
  else if (d.mod) { if (!toggleMod(d.mod)) toast('That mod needs shards: Skills, Unlocks'); renderSelectDetail(); }
  else if (d.plAdd) { const pl = plById(ui.pl) || state.playlists[0]; if (!pl) { const x = plCreate('My playlist', +d.plAdd); ui.pl = x.id; toast('Playlist made'); } else { plToggle(pl, +d.plAdd); toast(pl.maps.includes(+d.plAdd) ? `Added to ${esc(pl.name)}` : `Removed from ${esc(pl.name)}`); } renderSelectList(); }
  else if (d.pl) { ui.pl = +d.pl; renderSelect(); }
  else if (t.hasAttribute('data-plnew')) { const x = plCreate(prompt('Playlist name') || 'New playlist'); if (x) ui.pl = x.id; renderSelect(); }
  else if (t.hasAttribute('data-plplay')) { plPlay(plById(ui.pl)); toast('Playlist playing'); renderQueue(); renderSelect(); }
  else if (t.hasAttribute('data-plshuffle')) { plPlay(plById(ui.pl), true); renderQueue(); renderSelect(); }
  else if (t.hasAttribute('data-plren')) { const x = plById(ui.pl); x.name = (prompt('New name', x.name) || x.name).slice(0, 40); renderSelect(); }
  else if (t.hasAttribute('data-pldel')) { plDelete(plById(ui.pl)); ui.pl = null; renderSelect(); }
  else if (t.hasAttribute('data-plstop')) { plStop(); renderQueue(); renderSelect(); }
});
$('selControls').addEventListener('input', e => {
  if (e.target.id === 'mapSearch') { state.filter.q = e.target.value; ui.browse.page = 0; renderSelectList(); }
  if (e.target.id === 'mapSort') { state.filter.sort = e.target.value; renderSelectList(); }
  if (e.target.id === 'mapStatus') { state.filter.status = e.target.value; renderSelectList(); }
});
$('selClose').onclick = () => { if ($('select').classList.contains('detail') && innerWidth <= 900) $('select').classList.remove('detail'); else closePanels(); };
$('mpQueue').addEventListener('click', e => { const b = e.target.closest('[data-dq]'); if (b) { state.queue.splice(+b.dataset.dq, 1); renderQueue(); } });
$('mpNext').onclick = () => { if (run && !run.done) { run.done = true; run.endTimer = 0; run.wait = false; hideResults(); } };

/* ---------- rankings ---------- */
function renderBoard() {
  const rows = globalBoard();
  ui.boardView = ui.boardView || 'global';
  const list = ui.boardView === 'friends' ? rows.filter(r => r.me || ui.favs.has(r.name)) : rows;
  $('lbpBox').innerHTML = `<h3>Leaderboards</h3><div class="rkHead">${[['global', 'Global'], ['friends', 'Friends']].map(([v, n]) => `<button data-bv="${v}" class="${ui.boardView === v ? 'on' : ''}">${n}</button>`).join('')}<small style="align-self:center">Rankings are simulated locally: no game server is attached.</small></div>
    <div class="rkRow" style="color:var(--muted);font-size:12px"><span>Rank</span><span>Player</span><span class="rkRp">RP</span><span class="rkPc">Plays</span></div>
    ${list.map(x => `<div class="rkRow${x.me ? ' me' : ''}${x.rank <= 3 ? ' r' + x.rank : ''}"><span class="rkRank">#${x.rank}</span><span class="rkWho">${avatar(x.name, x.me ? 320 : x.hue)}<b>${esc(shownName(x.name))}${x.country ? ` <span class="flag">${x.country}</span>` : ''}<span class="lvPill">Lv ${x.level}</span></b></span><span class="rkRp">${x.rp.toFixed(2)}</span><span class="rkPc">${fmt(x.plays)}</span></div>`).join('')}`;
  $('lbpBox').onclick = e => { const b = e.target.closest('[data-bv]'); if (b) { ui.boardView = b.dataset.bv; renderBoard(); } };
}

/* ---------- profile ---------- */
function rpGraphSvg(log) {
  if (log.length < 2) return '<div class="ppGraph"></div>';
  const W = 400, H = 120, t0 = log[0].at, t1 = log[log.length - 1].at || t0 + 1, max = Math.max(1, ...log.map(l => l.rp));
  const pts = log.map(l => `${((l.at - t0) / Math.max(1, t1 - t0) * W).toFixed(1)},${(H - 8 - l.rp / max * (H - 16)).toFixed(1)}`);
  return `<svg class="ppGraph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="area" d="M0,${H} L${pts.join(' L')} L${W},${H} Z"/><path d="M${pts.join(' L')}"/></svg>`;
}
function renderProfilePage() {
  const rk = rank(), nx = nextRank(), rows = globalBoard();
  const bests = Object.entries(state.best).filter(([, b]) => b.passes).map(([id, b]) => ({ m: mapById(+id), b })).filter(x => x.m).sort((a, b) => b.b.rp - a.b.rp).slice(0, 10);
  const w = weeklyNow();
  $('ppBox').innerHTML = `<div class="ppHead"><div class="ppAv" style="--h:320">${esc(playerName().slice(0, 1).toUpperCase())}</div><div><h2>${esc(playerName())}</h2><div class="rk" style="color:${rk.color}">${rk.name}</div><small>${nx ? `${Math.max(0, nx.rp - totalRp()).toFixed(0)} RP to ${nx.name}` : rk.range} · global #${state.globalRank} of ${rows.length}</small></div><div style="margin-left:auto"><button data-rename>Change name</button></div></div>
    <div class="ppStats">${[['RP', totalRp().toFixed(2)], ['Points', fmt(state.points)], ['Stars', state.stars], ['Plays', state.stats.plays], ['Passes', state.stats.passes], ['Hits', fmt(state.stats.hits)], ['Play time', fmtTime(state.stats.time)], ['Hardest pass', hardestPassed().toFixed(2) + '★'], ['Season', state.seasons + 1], ['Rebirths', state.rebirths || 0], ['Ascensions', state.ascensions || 0], ['Daily streak', `${state.streak.count} (best ${state.streak.best})`]].map(([k, v]) => `<div class="card"><small>${k}</small><b>${v}</b></div>`).join('')}</div>
    <h3>RP over time</h3>${rpGraphSvg(state.rpLog)}
    <h3 style="margin-top:16px">Best plays</h3>${bests.map((x, i) => `<div class="rkRow"><span class="rkRank">#${i + 1}</span><span class="rkWho"><b>${esc(x.m.title)}</b> <small>${x.m.stars.toFixed(2)}★ · ${x.b.speed}× ${x.b.mods || ''}</small></span><span class="rkRp">${x.b.rp} RP</span><span class="rkPc" style="color:${GRADE_COLORS[x.b.grade]}">${x.b.grade} ${(x.b.acc * 100).toFixed(2)}%</span></div>`).join('') || '<p class="small">No passes yet this season.</p>'}
    <h3 style="margin-top:16px">Weekly challenges · resets in ${weeklyUntil()} · +${fmt(weeklyReward())} each${w.badge ? ' · ★ badge earned' : ''}</h3><div class="cardGrid">${w.list.map(e => { const c = WEEKLY_POOL.find(x => x.id === e.id); return `<div class="card${e.done ? ' done' : ''}"><b>${c.text}</b><div class="bar"><div style="width:${Math.min(100, e.prog / c.goal * 100)}%"></div></div><small>${e.prog}/${c.goal}</small></div>`; }).join('')}</div>
    <h3 style="margin-top:16px">Achievements · ${Object.keys(state.ach).length}/${ACHIEVEMENTS.length}</h3><div class="achGrid">${ACHIEVEMENTS.map(a => `<div class="ach${state.ach[a.id] ? ' on' : ''}"><b>${a.name}</b>${a.desc}</div>`).join('')}</div>
    <h3 style="margin-top:16px">Season badges</h3><div class="seasonBadges">${(state.seasonLog || []).map(s => `<span title="${new Date(s.at).toLocaleDateString()}">S${s.n} · ${s.title} · ${s.rp} RP · ${s.stars}★ · ${s.plays} plays</span>`).join('') || '<small>None yet</small>'}</div>
    <h3 style="margin-top:16px">Save</h3><div class="row"><button data-export>Export save</button><button data-import>Import save</button><button data-reset class="danger">Hard reset</button></div>`;
  $('ppBox').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-rename')) { const n = prompt('Your name', playerName()); if (n) { settings.playerName = n.trim().slice(0, 24); saveSettings(); renderProfilePage(); } }
    else if (b.hasAttribute('data-export')) showModal(`<h3>Export save</h3><p>Copy this text somewhere safe.</p><textarea readonly>${exportSave()}</textarea>`, [{ label: 'Close' }]);
    else if (b.hasAttribute('data-import')) showModal('<h3>Import save</h3><p>Paste an exported save. It replaces the current one.</p><textarea id="impText"></textarea>', [{ label: 'Cancel' }, { label: 'Import', primary: true, onClick: () => { if (importSave($('impText').value)) { toast('Save imported'); fullRefresh(); } else toast('That save could not be read'); } }]);
    else if (b.hasAttribute('data-reset')) showModal('<h3>Hard reset?</h3><p>This deletes everything, including stars and instincts. It cannot be undone.</p>', [{ label: 'Cancel' }, { label: 'Delete everything', danger: true, onClick: () => { hardReset(); fullRefresh(); } }]);
  };
}

/* ---------- stats ---------- */
function renderStats() {
  const s = state.stats;
  $('statsBox').innerHTML = `<h3>Game stats</h3><div class="ppStats">${[['Plays', s.plays], ['Passes', s.passes], ['Pass rate', s.plays ? Math.round(s.passes / s.plays * 100) + '%' : '–'], ['Notes hit', fmt(s.hits)], ['Play time', fmtTime(s.time)], ['Points earned ever', fmt(state.totalEarned)], ['Maps with a best', Object.keys(state.best).length], ['Mastery stars', Object.values(state.mastery).reduce((a, m) => a + (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1), 0)], ['Playing since', new Date(state.createdAt).toLocaleDateString()], ['Frames per second', ui.fps.toFixed(0)]].map(([k, v]) => `<div class="card"><small>${k}</small><b>${v}</b></div>`).join('')}</div>
    <h3>Skills</h3><table class="boostTable">${ALL_SKILLS.map(sk => `<tr><td style="color:${sk.color}">${sk.name}</td><td>Lv ${skillLvl(sk.id)} · gear ${state.gear[sk.id] || 0} · prestige ${prestigeOf(sk.id)} · ×${xpMult(sk.id).toFixed(2)} XP</td></tr>`).join('')}</table>`;
}

/* ---------- guide ---------- */
function renderGuide() {
  $('guideBox').innerHTML = `<h3>How the game works</h3>
    <p>Your player plays rhythm maps on its own, around the clock. Every note it hits pays points; every pass gives RP; every note trains the skills it tested. You spend what it earns on gear, pick its maps, mods and speed, and decide when a season ends.</p>
    <h2>Skills</h2><p>Four fundamentals apply to every note: Aim (cursor speed), Precision (hitbox), Reading (how dense a section can get) and Consistency (random misses). Pattern skills cover jumps, streams, slides, bursts, spins, vibros, stacks, quantum notes and stamina. A map trains the pattern skills it has the most of. Skills level up to 120 and never cost anything.</p>
    <h2>Points and gear</h2><p>Points come from hits, scaled by combo, map stars, speed, mods, RP and stars. Gear multiplies one skill's XP; each tier needs the skill at a level. Five tiers on every skill of a group adds a set bonus.</p>
    <h2>RP and titles</h2><p>Each map keeps your best play. RP uses Rhythia's formula: stars × speed and accuracy, with mods that raise the star rating. Your total weighs your best 99 plays, 0.97 less each. Titles: Novice, Expert at 1,500, Candidate Master at 2,500, Master at 5,000, Candidate Grandmaster at 10,000, Grandmaster for the global top 30.</p>
    <h2>Warm-up</h2><p>Clears warm your player up, fails cool it down. Warm players miss less and learn faster. A cold player misses 15% more.</p>
    <h2>Seasons</h2><p>From 3,500 RP a season can end. It pays stars, each worth +10% XP, +25% points and +2% cursor speed, and instinct points, spent on one skill for good (Natural, Head start, Gifted, Craft) or on perks for the whole game. Everything else starts over.</p>
    <h2>Prestige, rebirth, ascension, transcendence</h2><p>A skill at Lv 50 can prestige for ×1.1 XP and an extra gear tier, five times. After five seasons a rebirth drops stars and instincts for a permanent unlock and ×1.25 XP. After ten rebirths an Ascension resets almost everything for three new skills, Trials, Relics and ×2 XP and points. Every five Ascensions, Transcendence pays Echoes and ×10.</p>
    <h2>Shards, mods and speeds</h2><p>A season that ran two hours or more pays two shards. They buy speeds past 1.45×, the plus mods, the vision mods and Overdrive (×2 XP for 30 minutes).</p>
    <h2>Daily and weekly</h2><p>Each UTC day has one map per tier with the day's mod; clearing one pays about fifteen minutes of income and keeps your streak. Weekly challenges pay about 45 minutes each; finishing all four earns a badge.</p>
    <h2>Time away</h2><p>With the game closed, your player keeps playing for up to ${offlineCap()} hours; the time is played out when you come back. Long absences also grant a welcome-back points boost.</p>
    <h2>Shortcuts</h2><p>Esc opens map select or closes a panel · Ctrl+K or / finds any screen · F9 online · Ctrl+O settings · Ctrl+Shift+G stats.</p>`;
}

/* ---------- settings ---------- */
const pct0 = v => Math.round(v * 100) + '%';
const SETTING_PAGES = [
  { id: 'system', name: 'System', rows: [
    { k: 'titleOnStart', type: 'toggle', label: 'Show the title screen at startup' },
    { k: 'greet', type: 'toggle', label: 'Welcome and goodbye screens' },
    { k: 'autoContinue', type: 'toggle', label: 'Auto-continue after a play', hint: 'On: the next map starts by itself. Off: the results stay up until you retry or pick a map.' },
    { k: 'keepPlaying', type: 'toggle', label: 'Keep playing while the game is closed', hint: 'Time away, up to the away cap, is played out when you come back.' },
    { k: 'autoGear', type: 'select', label: 'Auto-buy gear', options: [['always', 'After every play'], ['away', 'Only while away'], ['off', 'Off']] },
    { k: 'awayPick', type: 'select', label: 'Next map', hint: 'What plays next when a play moves on by itself. Maps you queue go first.', options: [['smart', 'Smart: the game picks what helps most'], ['mix', 'Random maps that suit your skills'], ['climb', 'Maps near your hardest pass'], ['rp', 'Maps that raise your RP the most'], ['weak', 'Maps for your weakest skill'], ['shuffle', 'Any map'], ['same', 'The same map again']] },
    { k: 'awayLen', type: 'select', label: 'Map length for the next maps', options: [['any', 'Any length'], ['short', 'Short: under 2 minutes'], ['mid', 'Medium: 2 to 4 minutes'], ['long', 'Long: over 4 minutes']] },
    { k: 'autoModMode', type: 'select', label: 'Mods for the next maps', options: [['smart', 'Smart: the game picks'], ['custom', 'My choice'], ['off', 'No mods']] },
    { k: 'autoModList', type: 'text', label: 'Mods to use (ids, space separated)', hint: 'e.g. hr ghost sd', show: () => settings.autoModMode === 'custom' },
    { k: 'hints', type: 'toggle', label: 'Show what to do next' },
  ] },
  { id: 'online', name: 'Online', rows: [
    { k: 'playerName', type: 'text', label: 'Leaderboard name' },
    { k: 'submitScores', type: 'toggle', label: 'Submit scores to the leaderboard', hint: 'Off works like the Anonymous mod on every play.' },
    { k: 'appearOffline', type: 'toggle', label: 'Appear offline' },
  ] },
  { id: 'interface', name: 'Interface', rows: [
    { k: 'accentColor', type: 'color', label: 'Accent colour' }, { k: 'accentColor2', type: 'color', label: 'Second accent colour' }, { k: 'textColor', type: 'color', label: 'Text colour' }, { k: 'panelColor', type: 'color', label: 'Panel colour' }, { k: 'hudColor', type: 'color', label: 'In-play text colour' },
    { k: 'numFormat', type: 'select', label: 'Number format', options: [['short', 'Short (1.78K)'], ['full', 'Full (1,780)'], ['sci', 'Scientific (1.78e3)']] },
    { k: 'thumbnails', type: 'toggle', label: 'Show map covers in lists' }, { k: 'reduceMotion', type: 'toggle', label: 'Reduce motion' },
  ] },
  { id: 'cursor', name: 'Cursor', rows: [
    { k: 'cursorStyle', type: 'select', label: 'Cursor', options: [['cube', 'Cube (default)'], ['dot', 'Dot'], ['ring', 'Ring'], ['cross', 'Crosshair'], ['diamond', 'Diamond'], ['star', 'Star']] },
    { k: 'cursorColor', type: 'color', label: 'Cursor colour' }, { k: 'cursorGlow', type: 'toggle', label: 'Cursor glow' },
    { k: 'cursorSize', type: 'range', label: 'Cursor size', min: 0.5, max: 2, step: 0.1, fmt: v => v.toFixed(1) + '×' },
    { k: 'trail', type: 'toggle', label: 'Cursor trail' },
    { k: 'trailStyle', type: 'select', label: 'Trail style', options: () => [['solid', 'Solid'], ['fade', 'Two-colour fade'], ['rainbow', 'Rainbow'], ['thin', 'Thin'], ...(shopRank('stardust') ? [['stardust', 'Stardust ★']] : []), ...(shopRank('comet') ? [['comet', 'Comet ★']] : [])] },
    { k: 'trailColor', type: 'color', label: 'Trail colour' }, { k: 'trailColor2', type: 'color', label: 'Trail end colour', show: () => settings.trailStyle === 'fade' },
    { k: 'trailLength', type: 'range', label: 'Trail length', min: 4, max: 30, step: 1, fmt: v => String(v) }, { k: 'trailAlpha', type: 'range', label: 'Trail opacity', min: 0.1, max: 1, step: 0.05, fmt: pct0 },
  ] },
  { id: 'audio', name: 'Audio', rows: [
    { k: 'musicOn', type: 'toggle', label: 'Music', hint: 'A soft generated tone set; no song files ship with the clone.' },
    { k: 'master', type: 'range', label: 'Master volume', min: 0, max: 1, step: 0.05, fmt: pct0 }, { k: 'music', type: 'range', label: 'Music volume', min: 0, max: 1, step: 0.05, fmt: pct0 }, { k: 'effects', type: 'range', label: 'Effects volume', min: 0, max: 1, step: 0.05, fmt: pct0 },
  ] },
  { id: 'backgrounds', name: 'Backgrounds', rows: [
    { k: 'bgStyle', type: 'select', label: 'Play background', options: [['cover', 'The map cover'], ['black', 'Plain black'], ['color', 'One colour'], ['gradient', 'Gradient']] },
    { k: 'bgColor', type: 'color', label: 'Background colour' }, { k: 'bgColor2', type: 'color', label: 'Second background colour', show: () => settings.bgStyle === 'gradient' },
    { k: 'mapBg', type: 'toggle', label: 'Map cover behind the play view' },
    { k: 'bgDim', type: 'range', label: 'Background dim', min: 0.3, max: 1, step: 0.05, fmt: pct0 }, { k: 'parallax', type: 'toggle', label: 'Parallax' },
  ] },
  { id: 'notes', name: 'Notes', rows: [
    { k: 'noteSet', type: 'select', label: 'Colour set', options: Object.entries(NOTE_SETS).map(([id, x]) => [id, x.name]) },
    { k: 'noteColorA', type: 'color', label: 'Note colour 1', show: () => settings.noteSet === 'custom' }, { k: 'noteColorB', type: 'color', label: 'Note colour 2', show: () => settings.noteSet === 'custom' },
    { k: 'noteShape', type: 'select', label: 'Note shape', options: [['rounded', 'Rounded square'], ['square', 'Square'], ['circle', 'Circle']] },
    { k: 'noteFill', type: 'toggle', label: 'Filled notes' }, { k: 'noteGlow', type: 'toggle', label: 'Note glow' }, { k: 'missFx', type: 'toggle', label: 'Miss marks' }, { k: 'missColor', type: 'color', label: 'Miss colour' },
    { k: 'gridLines', type: 'toggle', label: 'Grid lines' }, { k: 'gridBorder', type: 'toggle', label: 'Grid border' }, { k: 'gridColor', type: 'color', label: 'Grid colour' }, { k: 'gridAlpha', type: 'range', label: 'Grid opacity', min: 0.05, max: 0.6, step: 0.01, fmt: pct0 }, { k: 'borderColor', type: 'color', label: 'Border colour' },
    { k: 'approachRate', type: 'range', label: 'Approach rate', min: 0.5, max: 2, step: 0.1, fmt: v => v.toFixed(1) + '×' }, { k: 'spawnDistance', type: 'range', label: 'Spawn distance', min: 0.5, max: 2, step: 0.1, fmt: v => v.toFixed(1) + '×' },
  ] },
  { id: 'widgets', name: 'Play widgets', rows: [{ k: 'wRp', type: 'toggle', label: 'Live RP' }, { k: 'wStats', type: 'toggle', label: 'Play stats' }] },
  { id: 'streamer', name: 'Streamer', rows: [{ k: 'hideChat', type: 'toggle', label: 'Hide chat' }, { k: 'hideNames', type: 'toggle', label: 'Hide other players\' names' }] },
  { id: 'about', name: 'About', rows: [{ type: 'info', label: 'Idle for Rhythia', hint: 'A from-scratch recreation of the idle game. Map names, mappers, ratings and cover art come from the public Rhythia map listing; they belong to Rhythia and the mappers and artists behind them.' }, { type: 'info', label: 'Version', hint: PATCH_NOTES[0].v }] },
];
function renderSettings() {
  const q = ($('setSearch').value || '').trim().toLowerCase();
  $('setBody').innerHTML = SETTING_PAGES.map(p => {
    const rows = p.rows.filter(r => (!r.show || r.show()) && (!q || (r.label + ' ' + (r.hint || '')).toLowerCase().includes(q)));
    if (!rows.length) return '';
    return `<div class="setPage"><h4>${p.name}</h4>${rows.map(r => `<div class="setRow"><div><label>${r.label}</label>${r.hint ? `<small>${r.hint}</small>` : ''}</div><div>${settingControl(r)}</div></div>`).join('')}</div>`;
  }).join('');
}
function settingControl(r) {
  const v = settings[r.k];
  switch (r.type) {
    case 'toggle': return `<button class="toggle${v ? ' on' : ''}" data-sk="${r.k}" data-st="toggle" aria-pressed="${!!v}"></button>`;
    case 'select': { const opts = typeof r.options === 'function' ? r.options() : r.options; return `<select data-sk="${r.k}">${opts.map(([val, n]) => `<option value="${val}" ${String(v) === String(val) ? 'selected' : ''}>${n}</option>`).join('')}</select>`; }
    case 'range': return `<input type="range" data-sk="${r.k}" min="${r.min}" max="${r.max}" step="${r.step}" value="${v}"><span class="val">${r.fmt(+v)}</span>`;
    case 'color': return `<input type="color" data-sk="${r.k}" value="${v}">`;
    case 'text': return `<input type="text" data-sk="${r.k}" value="${esc(v || '')}">`;
    default: return '';
  }
}
$('setBody').addEventListener('click', e => { const b = e.target.closest('[data-st="toggle"]'); if (b) { settings[b.dataset.sk] = !settings[b.dataset.sk]; afterSetting(b.dataset.sk); renderSettings(); } });
$('setBody').addEventListener('input', e => {
  const el = e.target, k = el.dataset.sk; if (!k) return;
  settings[k] = el.type === 'range' ? +el.value : el.value;
  if (el.type === 'range') el.nextElementSibling.textContent = SETTING_PAGES.flatMap(p => p.rows).find(r => r.k === k).fmt(+el.value);
  afterSetting(k);
  if (el.tagName === 'SELECT') renderSettings();
});
function afterSetting(k) {
  saveSettings(); applyTheme();
  if (k === 'mapBg' || k === 'bgStyle') $('pvBg').style.backgroundImage = settings.mapBg && run && run.map.img ? `url("${run.map.img}")` : '';
  if (k === 'trailLength') cursor.trail.length = 0;
  if (k === 'musicOn') music(settings.musicOn);
}
$('setSearch').oninput = renderSettings;
$('setClose').onclick = closePanels;
document.querySelector('.setTools').onclick = e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'exportSettings') showModal(`<h3>Export settings</h3><textarea readonly>${btoa(JSON.stringify(settings))}</textarea>`, [{ label: 'Close' }]);
  else if (b.dataset.act === 'importSettings') showModal('<h3>Import settings</h3><textarea id="impSet"></textarea>', [{ label: 'Cancel' }, { label: 'Import', primary: true, onClick: () => { try { Object.assign(settings, SETTING_DEFAULTS, JSON.parse(atob($('impSet').value.trim()))); saveSettings(); applyTheme(); renderSettings(); toast('Settings imported'); } catch (err) { toast('Could not read those settings'); } } }]);
  else if (b.dataset.act === 'resetSettings') { Object.assign(settings, SETTING_DEFAULTS); saveSettings(); applyTheme(); renderSettings(); toast('Settings reset'); }
};

/* ---------- online and chat ---------- */
function renderOnline() {
  const bots = botsOnline(), q = ($('onlineSearch').value || '').toLowerCase();
  const me = { name: playerName(), hue: 320, rp: totalRp(), playing: run && run.map, me: true };
  let list = settings.appearOffline ? bots : [me, ...bots];
  if (ui.friendsOnly) list = list.filter(x => x.me || ui.favs.has(x.name));
  if (q) list = list.filter(x => x.name.toLowerCase().includes(q));
  $('onlineHead').textContent = `${bots.length + (settings.appearOffline ? 0 : 1)} online · simulated players, no server attached`;
  $('onlineCount').textContent = bots.length + 1;
  $('onlineList').innerHTML = list.map(x => `<div class="oPlayer">${avatar(x.name, x.hue)}<div><b>${esc(shownName(x.name))}${x.me ? ' (you)' : ''}</b><small>${rank(x.rp).name} · ${x.rp.toFixed(0)} RP</small><small>${x.playing ? 'playing ' + esc(x.playing.title) : 'idle'}</small></div>${x.me ? '' : `<button class="oFav${ui.favs.has(x.name) ? ' on' : ''}" data-fav="${esc(x.name)}" title="Friend">♥</button>`}</div>`).join('');
  $('onlineFeed').classList.toggle('on', !!ui.friendsOnly);
  renderChat();
}
function renderChat() {
  const log = (state.chat || []).filter(c => c.ch === ui.chan).slice(-120);
  $('chatTitle').textContent = ui.chan;
  $('chatLog').innerHTML = settings.hideChat ? '<small>Chat hidden (Settings, Streamer)</small>' : log.map(c => `<div class="chatMsg"><span class="cTime">${new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span class="cRank" style="--rk:${rank(c.rp || 0).color}">${rank(c.rp || 0).name.split(' ').map(w => w[0]).join('')}</span><span class="cName" style="color:hsl(${c.hue} 70% 70%)">${esc(shownName(c.name))}</span>: ${esc(c.text)}</div>`).join('');
  $('chatLog').scrollTop = 1e6;
}
function chatPush(msg) { state.chat = (state.chat || []).concat([msg]).slice(-400); if (ui.open === 'online') renderChat(); else if (!settings.hideChat) tickerPush(`<b>${esc(shownName(msg.name))}</b>: ${esc(msg.text)}`); }
$('chatForm').onsubmit = e => { e.preventDefault(); const t = $('chatInput').value.trim(); if (!t) return; chatPush({ name: playerName(), text: t, at: Date.now(), hue: 320, rp: totalRp(), ch: ui.chan }); $('chatInput').value = ''; if (/^(hi|hello|hey)/i.test(t)) setTimeout(() => { const b = botChatLine(); if (b) chatPush({ ...b, text: 'hello ' + playerName() + '!', ch: ui.chan }); }, 1500); };
$('channels').onclick = e => { const b = e.target.closest('[data-ch]'); if (b) { ui.chan = b.dataset.ch; for (const x of $('channels').children) x.classList.toggle('on', x === b); renderChat(); } };
$('onlineList').onclick = e => { const b = e.target.closest('[data-fav]'); if (b) { const n = b.dataset.fav; if (ui.favs.has(n)) ui.favs.delete(n); else ui.favs.add(n); try { localStorage.setItem('rhythiaIdleClone.favs', JSON.stringify([...ui.favs])); } catch (err) { /* blocked */ } renderOnline(); } };
$('onlineSearch').oninput = renderOnline;
$('onlineFeed').onclick = () => { ui.friendsOnly = !ui.friendsOnly; renderOnline(); };
$('onlineClose').onclick = closePanels;

/* ---------- goto ---------- */
const GOTO = () => [['Play', 'the play view', () => closePanels()], ['Maps', 'map select', () => openPanel('maps')], ['Skills', 'skills tab', () => { openPanel('skills'); setTab('skills'); }], ['Gear', 'gear tab', () => { openPanel('skills'); setTab('gear'); }], ['Instincts', 'instincts and perks', () => { openPanel('skills'); setTab('instincts'); }], ['Prestige', 'skill prestiges', () => { openPanel('skills'); setTab('prestige'); }], ['Shop', 'star shop', () => { openPanel('skills'); setTab('shop'); }], ['Unlocks', 'shard unlocks', () => { openPanel('skills'); setTab('unlocks'); }], ['Season', 'end the season', () => { openPanel('skills'); setTab('season'); }], ['Rebirth', 'rebirth and unlocks', () => { openPanel('skills'); setTab('rebirth'); }], ['Ascension', 'trials and relics', () => { openPanel('skills'); setTab('ascend'); }], ['Transcendence', 'echo tree', () => { openPanel('skills'); setTab('transcend'); }], ['Boosts', 'every multiplier', () => { openPanel('skills'); setTab('boosts'); }], ['Rankings', 'leaderboards', () => openPanel('rankings')], ['Profile', 'your profile', () => openPanel('profile')], ['Online', 'players and chat', () => openPanel('online')], ['Guide', 'how the game works', () => openPanel('guide')], ['Settings', 'settings', () => openPanel('settings')], ['Stats', 'game stats', () => openPanel('stats')], ['Title screen', 'main menu', () => openTitle()]];
function openGoto() { closePanels(); $('goto').classList.remove('hidden'); $('gotoInput').value = ''; renderGoto(); $('gotoInput').focus(); }
function renderGoto() {
  const q = $('gotoInput').value.trim().toLowerCase();
  const list = GOTO().filter(([n, d]) => !q || (n + ' ' + d).toLowerCase().includes(q));
  $('gotoList').innerHTML = list.map(([n, d], i) => `<button data-go="${n}" class="${i === 0 ? 'sel' : ''}"><span>${n}</span><small>${d}</small></button>`).join('');
}
$('gotoInput').oninput = renderGoto;
$('gotoInput').onkeydown = e => { if (e.key === 'Enter') { const b = $('gotoList').querySelector('button'); if (b) b.click(); } };
$('gotoList').onclick = e => { const b = e.target.closest('[data-go]'); if (b) { $('goto').classList.add('hidden'); GOTO().find(x => x[0] === b.dataset.go)[2](); } };
$('goto').onclick = e => { if (e.target === $('goto')) $('goto').classList.add('hidden'); };

/* ---------- title screen ---------- */
const title = { open: false };
function openTitle() {
  closePanels();
  title.open = true;
  const m = run && run.map;
  $('titleBg').style.backgroundImage = m && m.img ? `url("${m.img}")` : '';
  $('titleNow').innerHTML = `<span>${m ? 'Now playing ' + esc(m.title) : ''}</span><span>${rank().name} · ${totalRp().toFixed(0)} RP · season ${state.seasons + 1}</span>`;
  $('title').classList.remove('hidden');
}
function closeTitle() { title.open = false; $('title').classList.add('hidden'); }
document.querySelector('.titleMenu').onclick = e => {
  const b = e.target.closest('[data-t]'); if (!b) return;
  const t = b.dataset.t;
  closeTitle();
  if (t === 'play') openPanel('maps'); else if (t === 'exit') sayGoodbye(); else openPanel(t);
};
$('titleLogo').onclick = () => { closeTitle(); openPanel('maps'); };
$('titleNotes').onclick = () => showModal(`<h3>Patch notes</h3>${PATCH_NOTES.map(n => `<b>${n.v}</b> <small>${n.date}</small><ul>${n.notes.map(x => `<li>${x}</li>`).join('')}</ul>`).join('')}`, [{ label: 'Close' }]);
function drawTitle(dt) {
  if (!title.open) return;
  const c = $('viz'), box = c.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(box.width * dpr)) { c.width = Math.round(box.width * dpr); c.height = c.width; c.style.width = box.width + 'px'; c.style.height = box.width + 'px'; }
  const g = c.getContext('2d'), S = c.width, cx = S / 2, R = S * 0.33;
  ui.viz += dt;
  g.clearRect(0, 0, S, S);
  const n = 64;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, len = R * (0.08 + 0.12 * Math.abs(Math.sin(ui.viz * 1.5 + i * 0.4)) * (settings.reduceMotion ? 0.3 : 1));
    g.strokeStyle = `hsla(${230 + i * 2}, 80%, 70%, .6)`; g.lineWidth = Math.max(1, S * 0.006);
    g.beginPath(); g.moveTo(cx + Math.cos(a) * R, cx + Math.sin(a) * R); g.lineTo(cx + Math.cos(a) * (R + len), cx + Math.sin(a) * (R + len)); g.stroke();
  }
}
function greetShow(head, sub, ms) {
  if (!settings.greet) return;
  const el = document.createElement('div');
  el.className = 'greet'; el.innerHTML = `<div><h2>${esc(head)}</h2><p>${sub}</p></div>`;
  document.body.appendChild(el);
  const hide = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 500); };
  el.onclick = hide;
  setTimeout(hide, ms);
}
function sayGoodbye() {
  save();
  greetShow('See you next time', `Saved. Your player keeps playing while you are away, for up to ${offlineCap()} hours.`, 2500);
  setTimeout(openTitle, 100);
}

/* ---------- audio: a soft generated pad when music is on ---------- */
const audio = { ctx: null, nodes: [] };
function music(on) {
  if (!on) { for (const n of audio.nodes) { try { n.stop(); } catch (e) { /* already stopped */ } } audio.nodes = []; return; }
  try {
    audio.ctx = audio.ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
    const g = audio.ctx.createGain(); g.gain.value = 0.04 * settings.master * settings.music; g.connect(audio.ctx.destination);
    for (const f of [130.81, 196, 261.63, 329.63]) { const o = audio.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; const lfo = audio.ctx.createOscillator(); const lg = audio.ctx.createGain(); lfo.frequency.value = 0.1 + Math.random() * 0.2; lg.gain.value = 2; lfo.connect(lg).connect(o.frequency); o.connect(g); o.start(); lfo.start(); audio.nodes.push(o, lfo); }
  } catch (e) { /* no audio */ }
}
$('btnAudio').onclick = () => { settings.musicOn = !settings.musicOn; saveSettings(); applyTheme(); music(settings.musicOn); };

/* ---------- navigation, keys ---------- */
$('dock').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'btnGoto') return openGoto();
  if (b.id === 'btnStats') return openPanel('stats');
  if (b.id === 'btnAudio') return;
  if (b.dataset.nav === 'play') { closePanels(); closeTitle(); return; }
  if (title.open) closeTitle();
  openPanel(b.dataset.nav);
};
$('skillsClose').onclick = closePanels;
$('tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); };
$('btnAbort').onclick = () => { if (run && !run.done) { abortRun(); } };
$('btnQuit').onclick = () => openPanel('maps');
for (const id of ['lbp', 'guide', 'pp', 'statsP']) $(id).addEventListener('click', e => { if (e.target === $(id)) closePanels(); });
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select') && e.key !== 'Escape') return;
  if (e.key === 'Escape') { if (!$('modal').classList.contains('hidden')) $('modal').classList.add('hidden'); else if (!$('goto').classList.contains('hidden')) $('goto').classList.add('hidden'); else if (ui.open) closePanels(); else if (title.open) closeTitle(); else openPanel('maps'); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openGoto(); }
  else if (e.key === '/' && !ui.open) { e.preventDefault(); openGoto(); }
  else if (e.key === 'F9') { e.preventDefault(); openPanel('online'); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); openPanel('settings'); }
  else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); openPanel('stats'); }
});
function fullRefresh() { closePanels(); if (run) onRunStart(); renderQueue(); renderHud(); }

/* ---------- main loop ---------- */
let lastFrame = performance.now(), secondAcc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  ui.fps = ui.fps * 0.95 + (dt ? 1 / dt : 60) * 0.05;
  if (!catching) {
    step(dt);
    render(dt);
    drawTitle(dt);
    if (now - ui.hudAt > 80) { ui.hudAt = now; renderHud(); }
    secondAcc += dt;
    if (secondAcc >= 1) {
      secondAcc = 0;
      sampleIncome();
      if (state.comeback && Date.now() > state.comeback.until) { state.comeback = null; toast('Welcome back bonus over'); }
      if (Date.now() - ui.lastSave > 15000) { ui.lastSave = Date.now(); save(); }
      if (Date.now() - ui.chatAt > 25000 + Math.random() * 40000) { ui.chatAt = Date.now(); const b = botChatLine(); if (b) chatPush({ ...b, ch: 'general' }); if (ui.open === 'online') renderOnline(); }
      if (ui.open === 'skills' && (ui.tab === 'gear' || ui.tab === 'skills')) renderTabs();
      const d = dailyToday(); void d;
    }
  }
  requestAnimationFrame(frame);
}

/* ---------- away report ---------- */
function showAwayReport(r) {
  if (!r) return;
  const lv = r.levels.slice(0, 6).map(([s, a, b]) => `${s.name} ${a}→${b}`).join(', ');
  showModal(`<h3>While you were away</h3><p>${fmtTime(r.sec)} played out${r.capped ? ` (capped at ${offlineCap()} hours)` : ''}.</p>
    <ul><li><b>${fmt(r.points)}</b> points earned</li><li><b>${r.passes}</b> passes in ${r.plays} plays on ${r.maps} maps${r.firsts ? `, ${r.firsts} first clears` : ''}</li><li>RP <b>${r.rpFrom.toFixed(0)} → ${(r.rpFrom + r.rp).toFixed(0)}</b>${r.bests ? ` (${r.bests} new bests)` : ''}</li>${r.best ? `<li>Best play: <b>${esc(r.best.map.title)}</b> ${r.best.grade} ${(r.best.acc * 100).toFixed(2)}% · ${r.best.rp} RP</li>` : ''}${r.gear ? `<li>${r.gear} gear tiers bought</li>` : ''}${lv ? `<li>Levels: ${lv}${r.levels.length > 6 ? ` and ${r.levels.length - 6} more` : ''}</li>` : ''}${r.dailies.length ? `<li>Daily maps cleared: ${r.dailies.join(', ')}</li>` : ''}</ul>${state.comeback ? `<p>Welcome back bonus: ×${state.comeback.mult} points for a while.</p>` : ''}`, [{ label: 'Nice', primary: true }]);
}

/* ---------- boot ---------- */
async function boot() {
  canvas = $('game'); ctx = canvas.getContext('2d');
  const had = load();
  try { ui.favs = new Set(JSON.parse(localStorage.getItem('rhythiaIdleClone.favs')) || []); } catch (e) { /* blocked */ }
  applyTheme();
  resize();
  addEventListener('resize', resize);
  if (!settings.playerName) settings.playerName = 'Player' + String(Math.floor(Math.random() * 9000) + 1000);
  ui.lastRank = rank().name;
  dailyToday(); weeklyNow();
  startRun();
  renderQueue();
  const away = had ? Date.now() - (state.lastTime || Date.now()) : 0;
  if (away > 5000 && settings.keepPlaying) {
    const box = document.createElement('div');
    box.className = 'catchUp'; box.innerHTML = `<div><b>Catching up</b><small>Playing out the ${fmtTime(Math.min(away / 1000, offlineCap() * 3600))} you were away</small><div class="cuBar"><i></i></div></div>`;
    document.body.appendChild(box);
    const r = await catchUp(away, p => { box.querySelector('i').style.width = (p * 100).toFixed(1) + '%'; });
    box.remove();
    if (run) onRunStart();
    showAwayReport(r);
  }
  greetShow(had ? 'Welcome back' : 'Welcome', `${esc(playerName())}${away > 60000 ? ' · away for ' + fmtTime(away / 1000) : ''}`, 1800);
  if (settings.titleOnStart) openTitle();
  if (!had) setTimeout(() => toast('<b>Your player is playing.</b> Open Skills to see it learn, Maps to pick what it plays.', 7000), 2500);
  addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  addEventListener('beforeunload', save);
  requestAnimationFrame(frame);
}
boot();
