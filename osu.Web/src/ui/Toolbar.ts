// Port of osu.Game/Overlays/Toolbar/Toolbar.cs as shown over the main menu: settings and home on the left, the
// ruleset selector, then the user button and clock (ToolbarClock's digital display) on the right.
// The online-only buttons (news, changelog, wiki, rankings, chat, social) are left out of this offline port.

import { RULESET_DISPLAY_NAMES } from '../brand';
import { settings } from '../framework/Settings';
import { availableRulesets } from '../game/rulesets';
import { h } from './dom';
import type { Game } from './Game';
import { userButton } from './overlays/Profile';
import { openSettings } from './overlays/Settings';
import { rulesetIcon } from './select/Icons';

const pad = (n: number) => String(n).padStart(2, '0');

/** DigitalClockDisplay: real time, plus the running time underneath. */
export function toolbarClock(): HTMLElement {
  const time = h('div', { class: 'tb-clock-time' });
  const running = h('div', { class: 'tb-clock-running' });
  const el = h('div', { class: 'tb-clock', title: 'Clock' }, time, running);
  const started = performance.now();
  const tick = () => {
    if (!el.isConnected && el.dataset.seen) return;
    if (el.isConnected) el.dataset.seen = '1';
    const d = new Date();
    time.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const s = Math.floor((performance.now() - started) / 1000);
    running.textContent = `running ${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    setTimeout(tick, 1000 - (Date.now() % 1000));
  };
  tick();
  return el;
}

export function createToolbar(game: Game, opts: { onHome?: () => void } = {}): HTMLElement {
  const rulesets = h('div', { class: 'ss-ruleset-selector tb-rulesets' });
  const renderRulesets = () =>
    rulesets.replaceChildren(
      ...availableRulesets().map(r =>
        h('button', { class: `ss-ruleset${r === game.ruleset ? ' active' : ''}`, title: RULESET_DISPLAY_NAMES[r.id] ?? r.name, onclick: () => game.setRuleset(r) }, rulesetIcon(r.id, 20), h('span', null, RULESET_DISPLAY_NAMES[r.id] ?? r.name)),
      ),
    );
  renderRulesets();
  const el = h(
    'div',
    { class: 'ss-toolbar tb-toolbar' },
    h('button', { class: 'ss-toolbar-button tb-icon', title: 'Settings (Ctrl+O)', onclick: () => openSettings(game) }, '⚙'),
    h('button', { class: 'ss-toolbar-button tb-icon', title: 'Home', onclick: () => opts.onHome?.() }, '⌂'),
    rulesets,
    h('div', { class: 'ss-toolbar-spacer' }),
    userButton(game),
    toolbarClock(),
  );
  let seen = false;
  const unsubscribe = settings.subscribe(k => {
    if (el.isConnected) seen = true;
    else if (seen) return unsubscribe();
    if (k === 'ui.ruleset') renderRulesets();
  });
  return el;
}
