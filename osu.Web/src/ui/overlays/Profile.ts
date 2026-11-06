// Offline profiles UI:
//   - the toolbar user button + profile switcher (standing in for LoginOverlay's UserGridPanel / status dropdown),
//   - the profile overlay, after UserProfileOverlay: header (cover, avatar, name, level badge + progress), statistics
//     (UserProfileStatisticsPanel: ranked score, hit accuracy, play count, total score, total hits, maximum combo,
//     replays watched, play time), pp, grade counts, and the Ranks section (best performance with weighting,
//     first place ranks) plus recent plays.

import './profile.css';
import { RULESET_DISPLAY_NAMES } from '../../brand';
import { settings } from '../../framework/Settings';
import { LegacyBeatmapDecoder } from '../../game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../game/mods/Mods';
import { belongsTo, Profile, profileStatistics, Profiles, ProfileScore, ProfileStatistics } from '../../game/Profiles';
import { availableRulesets, getRuleset } from '../../game/rulesets';
import { HitResult } from '../../game/scoring/HitResult';
import { calculatePerformance } from '../../game/scoring/Performance';
import { RANK_COLOURS, RANK_DISPLAY, type ScoreRank } from '../../game/scoring/ScoreRank';
import { Database, type ScoreRecord } from '../../game/storage/Database';
import { findFile } from '../../game/storage/Importer';
import { confirmDialog } from '../confirm';
import { h } from '../dom';
import type { Game } from '../Game';
import { rulesetIcon } from '../select/Icons';

// ------------------------------------------------------------------ avatar / level helpers

export function avatar(p: Profile, size: number): HTMLElement {
  return h(
    'div',
    { class: 'pf-avatar', style: { width: `${size}px`, height: `${size}px`, fontSize: `${size * 0.45}px`, background: `linear-gradient(135deg, hsl(${p.hue},70%,55%), hsl(${(p.hue + 40) % 360},70%,35%))` } },
    (p.username[0] ?? '?').toUpperCase(),
  );
}

/** LevelBadge: the level number in a hexagon. */
function levelBadge(level: number): HTMLElement {
  return h('div', { class: 'pf-level-badge', title: 'Level' }, h('span', null, String(Math.floor(level))));
}

/** LevelProgressBar: progress towards the next level. */
function levelProgress(level: number): HTMLElement {
  const pct = Math.floor((level % 1) * 100);
  return h('div', { class: 'pf-level-progress', title: 'Progress to next level' }, h('div', { class: 'pf-level-bar' }, h('div', { class: 'pf-level-fill', style: { width: `${pct}%` } })), h('span', null, `${pct}%`));
}

const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const pct2 = (v: number) => `${(v * 100).toFixed(2)}%`;

function formatPlayTime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const d = Math.floor(totalMinutes / 1440);
  const hrs = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  return d > 0 ? `${d}d ${hrs}h ${m}m` : `${hrs}h ${m}m`;
}

function relative(date: number): string {
  const s = Math.max(0, (Date.now() - date) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} minute${Math.floor(s / 60) === 1 ? '' : 's'} ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hour${Math.floor(s / 3600) === 1 ? '' : 's'} ago`;
  const d = Math.floor(s / 86400);
  return d < 30 ? `${d} day${d === 1 ? '' : 's'} ago` : new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ------------------------------------------------------------------ pp backfill

/** Fills in pp for stored scores that don't have it yet (older scores, or rulesets that had no calculator then). */
export async function backfillPerformance(game: Game, onProgress?: (done: number, total: number) => void): Promise<number> {
  let scores: ScoreRecord[] = [];
  try {
    scores = (await Database.getAllScores()).filter(s => s.pp == null && s.id != null);
  } catch {
    return 0;
  }
  await game.library.load();
  let done = 0;
  for (const s of scores) {
    const found = game.library.sets.flatMap(set => set.beatmaps.map(entry => ({ set, entry }))).find(x => x.entry.hash === s.beatmapHash);
    if (found) {
      try {
        const blob = findFile(found.set.files, found.entry.filename);
        if (blob) {
          const beatmap = LegacyBeatmapDecoder.decode(await blob.text());
          const mods = new ModSet(s.mods, s.modSettings ?? {});
          const playable = getRuleset(s.rulesetId).createPlayable(beatmap, mods);
          const statistics = new Map<HitResult, number>(Object.entries(s.statistics).map(([k, v]) => [HitResult[k as keyof typeof HitResult], v]));
          const pp = calculatePerformance(s.rulesetId, playable, { statistics, maxCombo: s.maxCombo, accuracy: s.accuracy, mods });
          if (pp != null && Number.isFinite(pp)) await Database.putScore({ ...s, pp });
        }
      } catch {
        /* skip */
      }
    }
    onProgress?.(++done, scores.length);
    await new Promise(r => setTimeout(r, 0));
  }
  return done;
}

// ------------------------------------------------------------------ profile overlay

let openOverlay: HTMLElement | null = null;

export function openProfile(game: Game, profile: Profile = Profiles.current(), rulesetId = game.ruleset.id): void {
  if (openOverlay) game.closeOverlay(openOverlay);
  let ruleset = rulesetId;
  const body = h('div', { class: 'pf-body' }, h('div', { class: 'pf-loading' }, 'Loading profile…'));
  const tabs = h('div', { class: 'pf-ruleset-tabs' });
  const renderTabs = () =>
    tabs.replaceChildren(
      ...availableRulesets().map(r =>
        h(
          'button',
          {
            class: `pf-ruleset${r.id === ruleset ? ' active' : ''}`,
            onclick: () => {
              ruleset = r.id;
              renderTabs();
              void load();
            },
          },
          rulesetIcon(r.id, 16),
          h('span', null, RULESET_DISPLAY_NAMES[r.id]),
        ),
      ),
    );
  renderTabs();

  const close = () => {
    openOverlay = null;
    game.closeOverlay(el);
  };
  const panel = h(
    'div',
    { class: 'pf-panel', onclick: (e: MouseEvent) => e.stopPropagation() },
    h('div', { class: 'pf-topbar' }, h('div', { class: 'pf-topbar-title' }, h('b', null, 'player'), ' info'), tabs, h('button', { class: 'pf-close', onclick: close, title: 'Close' }, '✕')),
    body,
  );
  const el = h('div', { class: 'overlay pf-overlay', onclick: close }, panel);
  openOverlay = el;
  game.openOverlay(el, {
    capture: true,
    onClose: () => (openOverlay = null),
    onKey: e => {
      if (e.code === 'Escape') {
        close();
        return true;
      }
      return false;
    },
  });

  let loadToken = 0;
  const load = async () => {
    const token = ++loadToken;
    body.replaceChildren(h('div', { class: 'pf-loading' }, 'Loading profile…'));
    // Scores saved before pp existed for their ruleset get it calculated first.
    await backfillPerformance(game, (d, t) => {
      if (token === loadToken) body.replaceChildren(h('div', { class: 'pf-loading' }, `Calculating performance… ${d}/${t}`));
    });
    const stats = await profileStatistics(profile, ruleset);
    if (token !== loadToken) return;
    body.replaceChildren(render(game, profile, ruleset, stats, close));
  };
  void load();
}

function scoreRow(game: Game, s: ProfileScore | ScoreRecord, opts: { weighted?: boolean; showPp?: boolean }, close: () => void): HTMLElement {
  const found = game.library.sets.flatMap(set => set.beatmaps.map(entry => ({ set, entry }))).find(x => x.entry.hash === s.beatmapHash);
  const e = found?.entry;
  const rank = s.rank as ScoreRank;
  const ps = s as ProfileScore;
  const ppEl =
    opts.showPp && s.pp != null
      ? h(
          'div',
          { class: 'pf-score-pp' },
          h('div', { class: 'pf-pp-value' }, `${Math.round(opts.weighted && ps.weightedPp != null ? ps.weightedPp : s.pp)}pp`),
          opts.weighted && ps.weight != null ? h('div', { class: 'pf-pp-weight' }, `weighted ${Math.round(ps.weight * 100)}% (${Math.round(s.pp)}pp)`) : null,
        )
      : null;
  const row = h(
    'div',
    { class: 'pf-score', title: found ? 'Show in song select' : '' },
    h('div', { class: 'pf-score-rank', style: { color: RANK_COLOURS[rank] ?? '#fff' } }, RANK_DISPLAY[rank] ?? s.rank),
    h(
      'div',
      { class: 'pf-score-info' },
      h('div', { class: 'pf-score-title' }, e ? `${e.title} ` : 'Unknown beatmap ', e ? h('span', { class: 'pf-score-artist' }, `by ${e.artist}`) : null),
      h('div', { class: 'pf-score-sub' }, h('span', { class: 'pf-score-diff' }, e?.difficultyName ?? ''), h('span', { class: 'pf-score-date' }, relative(s.date))),
    ),
    h('div', { class: 'pf-score-mods' }, ...s.mods.map(m => h('span', { class: 'pf-mod' }, m))),
    h('div', { class: 'pf-score-acc' }, pct2(s.accuracy)),
    ppEl,
  );
  if (found)
    row.addEventListener('click', () => {
      game.select(found.set, found.entry);
      close();
    });
  return row;
}

function render(game: Game, p: Profile, rulesetId: number, s: ProfileStatistics, close: () => void): HTMLElement {
  const stat = (label: string, value: string) => h('div', { class: 'pf-stat' }, h('span', { class: 'pf-stat-label' }, label), h('span', { class: 'pf-stat-value' }, value));
  const grade = (rank: ScoreRank, value: number) => h('div', { class: 'pf-grade' }, h('div', { class: `pf-grade-badge g-${rank}` }, RANK_DISPLAY[rank]), h('div', { class: 'pf-grade-count' }, n0(value)));
  const section = (title: string, count: number | null, rows: HTMLElement[], empty: string) =>
    h('div', { class: 'pf-section' }, h('div', { class: 'pf-section-title' }, title, count != null ? h('span', { class: 'pf-count' }, n0(count)) : null), rows.length ? h('div', { class: 'pf-scores' }, ...rows) : h('div', { class: 'pf-empty' }, empty));
  const showMore = (all: HTMLElement[], initial: number) => {
    const shown = all.slice(0, initial);
    if (all.length > initial) {
      const more = h('button', { class: 'pf-more', onclick: () => more.replaceWith(...all.slice(initial)) }, 'show more');
      shown.push(more);
    }
    return shown;
  };

  const header = h(
    'div',
    { class: 'pf-header', style: { '--pf-hue': String(p.hue) } as unknown as Partial<CSSStyleDeclaration> },
    h('div', { class: 'pf-cover', style: { background: `linear-gradient(120deg, hsl(${p.hue},55%,30%), hsl(${(p.hue + 60) % 360},55%,18%))` } }),
    h(
      'div',
      { class: 'pf-identity' },
      avatar(p, 110),
      h(
        'div',
        { class: 'pf-names' },
        h('div', { class: 'pf-username' }, p.username),
        h('div', { class: 'pf-meta' }, `Offline profile · joined ${new Date(p.createdAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`),
      ),
      h('div', { class: 'pf-level' }, levelBadge(s.level), levelProgress(s.level)),
    ),
  );
  const rankings = h(
    'div',
    { class: 'pf-rankings' },
    h('div', { class: 'pf-big' }, h('div', { class: 'pf-big-label' }, 'Global Ranking'), h('div', { class: 'pf-big-value' }, '-')),
    h('div', { class: 'pf-big' }, h('div', { class: 'pf-big-label' }, 'pp'), h('div', { class: 'pf-big-value' }, n0(s.pp))),
    h('div', { class: 'pf-grades' }, grade('XH', s.grades.XH), grade('X', s.grades.X), grade('SH', s.grades.SH), grade('S', s.grades.S), grade('A', s.grades.A)),
  );
  const statistics = h(
    'div',
    { class: 'pf-stats' },
    stat('Ranked Score', n0(s.rankedScore)),
    stat('Hit Accuracy', pct2(s.hitAccuracy)),
    stat('Play Count', n0(s.playCount)),
    stat('Total Score', n0(s.totalScore)),
    stat('Total Hits', n0(s.totalHits)),
    stat('Maximum Combo', n0(s.maxCombo)),
    stat('Replays Watched', n0(s.replaysWatched)),
    stat('Play Time', formatPlayTime(s.playTime)),
    stat('Bonus pp', `${n0(s.bonusPp)}pp`),
  );
  const best = s.best.map(x => scoreRow(game, x, { weighted: true, showPp: true }, close));
  const firsts = s.firsts.map(x => scoreRow(game, x, { showPp: true }, close));
  const recent = s.recent.map(x => scoreRow(game, x, { showPp: true }, close));
  void rulesetId;
  return h(
    'div',
    null,
    header,
    rankings,
    statistics,
    section('Best Performance', s.best.length, showMore(best, 10), 'No performance records. :('),
    section('First Place Ranks', s.firsts.length, showMore(firsts, 5), 'No awesome performance records yet. :('),
    section('Recent Plays (24h)', null, recent.filter((_, i) => Date.now() - s.recent[i].date < 86400000).slice(0, 20), 'No performance records. :('),
  );
}

// ------------------------------------------------------------------ toolbar user button + profile switcher

/** ToolbarUserButton: avatar + username; opens the profile switcher. */
export function userButton(game: Game): HTMLElement {
  const el = h('button', { class: 'pf-user-button', title: 'Profile' });
  const render = () => {
    const p = Profiles.current();
    el.replaceChildren(avatar(p, 26), h('span', { class: 'pf-user-name' }, p.username));
  };
  render();
  let seen = false;
  const unsubscribe = settings.subscribe(k => {
    // Drop the listener once the button has left the page (its screen was disposed).
    if (el.isConnected) seen = true;
    else if (seen) return unsubscribe();
    if (k === 'profiles' || k === 'profile.current') render();
  });
  el.addEventListener('click', e => {
    e.stopPropagation();
    openProfileSwitcher(game, el);
  });
  return el;
}

export function openProfileSwitcher(game: Game, anchor: HTMLElement): void {
  document.querySelector('.pf-switcher')?.remove();
  const current = Profiles.current();
  const level = h('span', { class: 'pf-sw-level' });
  void backfillPerformance(game)
    .then(() => profileStatistics(current, game.ruleset.id))
    .then(s => (level.textContent = `Lv ${Math.floor(s.level)} · ${n0(s.pp)}pp`));
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e: PointerEvent) => {
    if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const others = Profiles.all().filter(p => p.id !== current.id);
  const nameInput = h('input', { class: 'pf-sw-input', type: 'text', placeholder: 'New profile name', maxLength: 32 }) as HTMLInputElement;
  const create = () => {
    const name = nameInput.value.trim();
    if (!name) return;
    if (Profiles.all().some(p => p.username.toLowerCase() === name.toLowerCase())) {
      game.toast('A profile with that name already exists', 'error');
      return;
    }
    Profiles.create(name);
    game.toast(`Switched to ${name}`, 'success');
    close();
  };
  nameInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') create();
    if (e.key === 'Escape') close();
  });
  const pop = h(
    'div',
    { class: 'pf-switcher', onpointerdown: (e: PointerEvent) => e.stopPropagation() },
    h(
      'div',
      { class: 'pf-sw-current' },
      avatar(current, 48),
      h('div', { class: 'pf-sw-names' }, h('div', { class: 'pf-sw-name' }, current.username), level),
    ),
    h(
      'div',
      { class: 'pf-sw-actions' },
      h('button', { class: 'pf-sw-button primary', onclick: () => (close(), openProfile(game)) }, 'View profile'),
      h(
        'button',
        {
          class: 'pf-sw-button',
          onclick: () => {
            const input = h('input', { class: 'pf-sw-input', type: 'text', value: current.username, maxLength: 32 }) as HTMLInputElement;
            input.addEventListener('keydown', e => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                const v = input.value.trim();
                if (v) Profiles.rename(current.id, v);
                close();
              }
              if (e.key === 'Escape') close();
            });
            pop.querySelector('.pf-sw-current .pf-sw-name')?.replaceWith(input);
            input.focus();
            input.select();
          },
        },
        'Rename',
      ),
      others.length > 0
        ? h(
            'button',
            {
              class: 'pf-sw-button danger',
              onclick: async () => {
                close();
                if (await confirmDialog(game, `Delete the profile "${current.username}"? Its scores stay on their leaderboards.`, 'Delete profile')) Profiles.remove(current.id);
              },
            },
            'Delete',
          )
        : null,
    ),
    others.length ? h('div', { class: 'pf-sw-heading' }, 'Switch profile') : null,
    ...others.map(p =>
      h(
        'button',
        {
          class: 'pf-sw-profile',
          onclick: () => {
            Profiles.switchTo(p.id);
            game.toast(`Switched to ${p.username}`, 'success');
            close();
          },
        },
        avatar(p, 30),
        h('span', null, p.username),
      ),
    ),
    h('div', { class: 'pf-sw-heading' }, 'New profile'),
    h('div', { class: 'pf-sw-new' }, nameInput, h('button', { class: 'pf-sw-button primary', onclick: create }, 'Create')),
  );
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
}

export { belongsTo };
