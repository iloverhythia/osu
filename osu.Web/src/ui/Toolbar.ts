// Port of osu.Game/Overlays/Toolbar/Toolbar.cs (HEIGHT 40, Gray(0.1)) and its buttons: settings and home on the
// left with the ruleset selector, then (right) beatmap import, chart generator, now playing, the user button, the
// clock (ToolbarClock, four display modes cycled by clicking) and notifications with the unread count circle.
// Each ToolbarButton shows its tooltip under it on hover (title 22 bold, description, hotkey).
// The online-only buttons (news, changelog, wiki, rankings, chat, social) are left out of this offline port.

import './toolbar.css';
import { RULESET_DISPLAY_NAMES } from '../brand';
import { settings } from '../framework/Settings';
import { availableRulesets } from '../game/rulesets';
import { h } from './dom';
import type { Game } from './Game';
import { userButton } from './overlays/Profile';
import { openSettings } from './overlays/Settings';
import { rulesetIcon } from './select/Icons';

const pad = (n: number) => String(n).padStart(2, '0');

const fa = (d: string, viewBox = '0 0 512 512') => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', viewBox);
  s.innerHTML = `<path d="${d}"/>`;
  return s;
};
const ICONS = {
  settings:
    'M487.4 315.7l-42.6-24.6c4.3-23.2 4.3-47 0-70.2l42.6-24.6c4.9-2.8 7.1-8.6 5.5-14-11.1-35.6-30-67.8-54.7-94.6-3.8-4.1-10-5.1-14.8-2.3L380.8 110c-17.9-15.4-38.5-27.3-60.8-35.1V25.8c0-5.6-3.9-10.5-9.4-11.7-36.7-8.2-74.3-7.8-109.2 0-5.5 1.2-9.4 6.1-9.4 11.7V75c-22.2 7.9-42.8 19.8-60.8 35.1L88.7 85.5c-4.9-2.8-11-1.9-14.8 2.3-24.7 26.7-43.6 58.9-54.7 94.6-1.7 5.4.6 11.2 5.5 14L67.3 221c-4.3 23.2-4.3 47 0 70.2l-42.6 24.6c-4.9 2.8-7.1 8.6-5.5 14 11.1 35.6 30 67.8 54.7 94.6 3.8 4.1 10 5.1 14.8 2.3l42.6-24.6c17.9 15.4 38.5 27.3 60.8 35.1v49.2c0 5.6 3.9 10.5 9.4 11.7 36.7 8.2 74.3 7.8 109.2 0 5.5-1.2 9.4-6.1 9.4-11.7v-49.2c22.2-7.9 42.8-19.8 60.8-35.1l42.6 24.6c4.9 2.8 11 1.9 14.8-2.3 24.7-26.7 43.6-58.9 54.7-94.6 1.5-5.5-.7-11.3-5.6-14.1zM256 336c-44.1 0-80-35.9-80-80s35.9-80 80-80 80 35.9 80 80-35.9 80-80 80z',
  home: 'M280.37 148.26L96 300.11V464a16 16 0 0 0 16 16l112.06-.29a16 16 0 0 0 15.92-16V368a16 16 0 0 1 16-16h64a16 16 0 0 1 16 16v95.64a16 16 0 0 0 16 16.05L464 480a16 16 0 0 0 16-16V300L295.67 148.26a12.19 12.19 0 0 0-15.3 0zM571.6 251.47L488 182.56V44.05a12 12 0 0 0-12-12h-56a12 12 0 0 0-12 12v72.61L318.47 43a48 48 0 0 0-61 0L4.34 251.47a12 12 0 0 0-1.6 16.9l25.5 31A12 12 0 0 0 45.15 301l235.22-193.74a12.19 12.19 0 0 1 15.3 0L530.9 301a12 12 0 0 0 16.9-1.6l25.5-31a12 12 0 0 0-1.7-16.93z',
  music: 'M470.38 1.51L150.41 96A32 32 0 0 0 128 126.51v261.41A139 139 0 0 0 96 384c-53 0-96 28.66-96 64s43 64 96 64 96-28.66 96-64V214.32l256-75v184.61a138.4 138.4 0 0 0-32-3.93c-53 0-96 28.66-96 64s43 64 96 64 96-28.65 96-64V32a32 32 0 0 0-41.62-30.49z',
  bell: 'M224 512c35.32 0 63.97-28.65 63.97-64H160.03c0 35.35 28.65 64 63.97 64zm215.39-149.71c-19.32-20.76-55.47-51.99-55.47-154.29 0-77.7-54.48-139.9-127.94-155.16V32c0-17.67-14.32-32-31.98-32s-31.98 14.33-31.98 32v20.84C118.56 68.1 64.08 130.3 64.08 208c0 102.3-36.15 133.53-55.47 154.29-6 6.45-8.66 14.16-8.61 21.71.11 16.4 12.98 32 32.1 32h383.8c19.12 0 32-15.6 32.1-32 .05-7.55-2.61-15.27-8.61-21.71z',
  download: 'M216 0h80c13.3 0 24 10.7 24 24v168h87.7c17.8 0 26.7 21.5 14.1 34.1L269.7 378.3c-7.5 7.5-19.8 7.5-27.3 0L90.1 226.1c-12.6-12.6-3.7-34.1 14.1-34.1H192V24c0-13.3 10.7-24 24-24zm296 376v112c0 13.3-10.7 24-24 24H24c-13.3 0-24-10.7-24-24V376c0-13.3 10.7-24 24-24h146.7l49 49c20.1 20.1 52.5 20.1 72.6 0l49-49H488c13.3 0 24 10.7 24 24z',
  magic: 'M224 96l16-32 32-16-32-16-16-32-16 32-32 16 32 16 16 32zM80 160l26.66-53.33L160 80l-53.34-26.67L80 0 53.34 53.33 0 80l53.34 26.67L80 160zm352 128l-26.66 53.33L352 368l53.34 26.67L432 448l26.66-53.33L512 368l-53.34-26.67L432 288zm70.62-193.77L417.77 9.38C411.53 3.12 403.34 0 395.15 0c-8.19 0-16.38 3.12-22.63 9.38L9.38 372.52c-12.5 12.5-12.5 32.76 0 45.25l84.85 84.85c6.25 6.25 14.44 9.37 22.62 9.37 8.19 0 16.38-3.12 22.63-9.37l363.14-363.15c12.5-12.48 12.5-32.75 0-45.24zM359.45 203.46l-50.91-50.91 86.6-86.6 50.91 50.91-86.6 86.6z',
};

/** ToolbarButton with its hover tooltip. */
function toolbarButton(o: { icon?: SVGElement; content?: Node; main: string; sub: string; hotkey?: string; right?: boolean; cls?: string; onClick: () => void }): HTMLElement {
  const tooltip = h('div', { class: `tb-tooltip${o.right ? ' right' : ''}` }, h('div', { class: 'tb-tooltip-main' }, o.main), h('div', { class: 'tb-tooltip-sub' }, o.sub, o.hotkey ? h('span', { class: 'tb-hotkey' }, o.hotkey) : null));
  const flash = h('div', { class: 'tb-flash' });
  const el = h('button', { class: `tb-button ${o.cls ?? ''}` }, h('div', { class: 'tb-hover' }), flash, o.icon ? h('span', { class: 'tb-icon-wrap' }, o.icon) : null, o.content ?? null, tooltip);
  el.addEventListener('click', e => {
    e.stopPropagation();
    flash.classList.remove('go');
    void flash.offsetWidth;
    flash.classList.add('go');
    el.classList.add('tooltip-hidden');
    o.onClick();
  });
  el.addEventListener('pointerleave', () => el.classList.remove('tooltip-hidden'));
  return el;
}

// ------------------------------------------------------------------ ToolbarClock

type ClockMode = 'full' | 'digitalWithRuntime' | 'digital' | 'analog';
const NEXT_MODE: Record<ClockMode, ClockMode> = { analog: 'full', digital: 'analog', digitalWithRuntime: 'digital', full: 'digitalWithRuntime' };
const startedAt = performance.now();

/** ToolbarClock: AnalogClockDisplay + DigitalClockDisplay (with the running time); click cycles the mode. */
export function toolbarClock(): HTMLElement {
  const svgNs = 'http://www.w3.org/2000/svg';
  const analog = document.createElementNS(svgNs, 'svg');
  analog.setAttribute('viewBox', '-15 -15 30 30');
  analog.classList.add('tb-analog');
  analog.innerHTML = '<circle r="13" class="tb-face"/><line class="tb-hand hour" y2="-6"/><line class="tb-hand minute" y2="-9.5"/><line class="tb-hand second" y2="-10.5"/><circle r="1.5" class="tb-centre"/>';
  const time = h('div', { class: 'tb-clock-time' });
  const running = h('div', { class: 'tb-clock-running' });
  const digital = h('div', { class: 'tb-digital' }, time, running);
  const el = h('button', { class: 'tb-clock', title: '' }, analog, digital);
  const apply = () => {
    const mode = settings.get<ClockMode>('ui.toolbarClockMode', 'full');
    analog.style.display = mode === 'analog' || mode === 'full' ? '' : 'none';
    digital.style.display = mode === 'analog' ? 'none' : '';
    running.style.display = mode === 'digitalWithRuntime' || mode === 'full' ? '' : 'none';
  };
  apply();
  el.addEventListener('click', e => {
    e.stopPropagation();
    settings.set('ui.toolbarClockMode', NEXT_MODE[settings.get<ClockMode>('ui.toolbarClockMode', 'full')]);
  });
  const hands = analog.querySelectorAll('line');
  let seen = false;
  const tick = () => {
    if (el.isConnected) seen = true;
    else if (seen) return;
    apply();
    const d = new Date();
    const h24 = settings.get<boolean>('ui.prefer24h', false);
    const hr = h24 ? d.getHours() : d.getHours() % 12 || 12;
    time.textContent = `${h24 ? pad(hr) : hr}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${h24 ? '' : d.getHours() < 12 ? ' AM' : ' PM'}`;
    const s = Math.floor((performance.now() - startedAt) / 1000);
    running.textContent = `running ${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    const sec = d.getSeconds();
    const min = d.getMinutes() + sec / 60;
    const hour = (d.getHours() % 12) + min / 60;
    hands[0].setAttribute('transform', `rotate(${hour * 30})`);
    hands[1].setAttribute('transform', `rotate(${min * 6})`);
    hands[2].setAttribute('transform', `rotate(${sec * 6})`);
    setTimeout(tick, 1000 - (Date.now() % 1000));
  };
  tick();
  return el;
}

// ------------------------------------------------------------------ Toolbar

export interface ToolbarOptions {
  onHome?: () => void;
  onGenerate?: () => void;
}

export function createToolbar(game: Game, opts: ToolbarOptions = {}): HTMLElement {
  const rulesets = h('div', { class: 'tb-rulesets' });
  const renderRulesets = () =>
    rulesets.replaceChildren(
      ...availableRulesets().map((r, i) => {
        const name = RULESET_DISPLAY_NAMES[r.id] ?? r.name;
        const b = toolbarButton({ icon: rulesetIcon(r.id, 20) as unknown as SVGElement, main: name, sub: `play some ${name}`, hotkey: `Ctrl+${i + 1}`, cls: `tb-ruleset${r === game.ruleset ? ' active' : ''}`, onClick: () => game.setRuleset(r) });
        return b;
      }),
    );
  renderRulesets();

  const countCircle = h('div', { class: 'tb-count' });
  const updateCount = () => {
    const n = game.notifications.unreadCount;
    countCircle.textContent = n > 99 ? '99+' : String(n);
    countCircle.classList.toggle('shown', n > 0);
  };
  updateCount();

  const el = h(
    'div',
    { class: 'tb-toolbar' },
    h(
      'div',
      { class: 'tb-left' },
      toolbarButton({ icon: fa(ICONS.settings), main: 'settings', sub: 'change the way osu! behaves', hotkey: 'Ctrl+O', onClick: () => openSettings(game) }),
      toolbarButton({ icon: fa(ICONS.home, '0 0 576 512'), main: 'home', sub: 'return to the main menu', hotkey: 'Alt+Home', onClick: () => opts.onHome?.() }),
    ),
    rulesets,
    h('div', { class: 'tb-spacer' }),
    h(
      'div',
      { class: 'tb-right' },
      toolbarButton({ icon: fa(ICONS.download), main: 'import', sub: 'import beatmaps, skins and replays', right: true, onClick: () => game.openFilePicker() }),
      opts.onGenerate ? toolbarButton({ icon: fa(ICONS.magic), main: 'chart generator', sub: 'generate a beatmap for any mode', hotkey: 'Ctrl+G', right: true, onClick: () => opts.onGenerate?.() }) : null,
      toolbarButton({
        icon: fa(ICONS.music),
        main: 'now playing',
        sub: 'manage the currently playing track',
        hotkey: 'F6',
        right: true,
        cls: 'tb-music',
        onClick: () => {
          game.notifications.hide();
          game.nowPlaying.toggle();
        },
      }),
      userButton(game),
      toolbarClock(),
      toolbarButton({
        icon: fa(ICONS.bell, '0 0 448 512'),
        content: countCircle,
        main: 'notifications',
        sub: "waiting for 'ya",
        hotkey: 'Ctrl+N',
        right: true,
        cls: 'tb-notifications',
        onClick: () => {
          game.nowPlaying.hide();
          game.notifications.toggle();
        },
      }),
    ),
  );
  let seen = false;
  const alive = () => {
    if (el.isConnected) seen = true;
    return !(seen && !el.isConnected);
  };
  const unsubSettings = settings.subscribe(k => {
    if (!alive()) return unsubSettings();
    if (k === 'ui.ruleset') renderRulesets();
  });
  const unsubNotifications = game.notifications.subscribe(() => {
    if (!alive()) return void unsubNotifications();
    updateCount();
  });
  return el;
}
