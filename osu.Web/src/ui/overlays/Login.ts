// Port of osu.Game/Overlays/LoginOverlay.cs + Login/LoginPanel.cs, LoginForm.cs, UserDropdown.cs, UserAction.cs and
// osu.Game/Users/UserRankPanel.cs, backed by offline profiles instead of the osu! API:
//   signed out → LoginForm (ACCOUNT, username, password, Remember username, Stay signed in, Sign in, Register),
//   signed in  → "Signed in", UserRankPanel (cover, avatar, username, Global Ranking / pp), UserDropdown
//                (Online / Do not disturb / Appear offline / Sign out).
// Signing in picks an existing offline profile (checking its password if it has one); Register creates one.

import './login.css';
import { settings } from '../../framework/Settings';
import { GUEST_ID, Profile, profileStatistics, Profiles, type UserStatus } from '../../game/Profiles';
import { confirmDialog } from '../confirm';
import { h } from '../dom';
import type { Game } from '../Game';
import { showContextMenu } from '../select/Components';
import { applyColours } from './settings/SettingsOverlay';
import { bindSetting, formCheckBox } from './settings/controls';
import { avatar, backfillPerformance, openProfile } from './Profile';

const STATUS: { action: UserStatus | 'signout'; text: string; colour: string }[] = [
  { action: 'online', text: 'Online', colour: '#88b300' }, // colours.Green
  { action: 'dnd', text: 'Do not disturb', colour: '#ed1121' }, // colours.Red
  { action: 'offline', text: 'Appear offline', colour: '#777777' }, // colours.Gray7
  { action: 'signout', text: 'Sign out', colour: '' },
];
export const statusColour = (s: UserStatus) => STATUS.find(x => x.action === s)?.colour ?? '#88b300';

let current: { el: HTMLElement; close: () => void; anchor: HTMLElement } | null = null;

export function isLoginOverlayOpen(): boolean {
  return current != null;
}

/** LoginOverlay.ToggleVisibility, anchored under the toolbar user button. */
export function toggleLoginOverlay(game: Game, anchor: HTMLElement): void {
  if (current) {
    const sameAnchor = current.anchor === anchor;
    current.close();
    if (sameAnchor) return;
  }
  openLoginOverlay(game, anchor);
}

export function openLoginOverlay(game: Game, anchor: HTMLElement): void {
  const panel = h('div', { class: 'lo-panel' });
  const root = h('div', { class: 'st-root lo-root' }, panel);
  applyColours(root);
  const el = h('div', { class: 'lo-overlay', onpointerdown: (e: PointerEvent) => e.stopPropagation(), onmousedown: (e: MouseEvent) => e.stopPropagation() }, root);

  const close = () => {
    if (!current || current.el !== el) return;
    current = null;
    unsubscribe();
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', onKey, true);
    el.classList.remove('shown');
    setTimeout(() => el.remove(), 400);
  };
  const outside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!el.contains(t) && !anchor.contains(t) && !(t instanceof Element && t.closest('.ss-context-menu, .dialog, .overlay'))) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape' && !document.querySelector('.ss-context-menu')) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  // LoginPanel.onlineStateChanged
  let signedIn: boolean | null = null;
  let renderedFor = '';
  const render = (force = false) => {
    const now = Profiles.signedIn();
    const id = Profiles.current().id;
    if (!force && now === signedIn && id === renderedFor) return;
    signedIn = now;
    renderedFor = id;
    panel.replaceChildren(now ? signedInView(game, close) : loginForm(game, close));
    if (!now) setTimeout(() => (panel.querySelector('.lo-username') as HTMLInputElement | null)?.focus(), 0);
  };
  const unsubscribe = settings.subscribe(k => {
    if (k === 'profile.current' || k === 'profiles') render(k === 'profiles');
  });
  render();

  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.top = `${r.bottom}px`;
  el.style.right = `${Math.max(0, innerWidth - r.right)}px`;
  requestAnimationFrame(() => el.classList.add('shown'));
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', onKey, true);
  }, 0);
  current = { el, close, anchor };
}

// ------------------------------------------------------------------ LoginForm

function loginForm(game: Game, close: () => void): HTMLElement {
  const username = h('input', { class: 'lo-textbox lo-username', type: 'text', placeholder: 'username', autocomplete: 'username', spellcheck: false, maxLength: 32 }) as HTMLInputElement;
  username.value = settings.get<boolean>('online.saveUsername', true) ? settings.get<string>('online.lastUsername', '') : '';
  const password = h('input', { class: 'lo-textbox', type: 'password', placeholder: 'password', autocomplete: 'current-password' }) as HTMLInputElement;
  const errorText = h('div', { class: 'lo-error' });
  const known = h('datalist', { id: 'lo-profiles' }, ...Profiles.all().map(p => h('option', { value: p.username })));
  username.setAttribute('list', 'lo-profiles');

  const showError = (msg: string) => {
    errorText.textContent = msg;
    errorText.classList.toggle('shown', !!msg);
  };
  const shake = (b: HTMLElement) => {
    b.classList.remove('lo-shake');
    void b.offsetWidth;
    b.classList.add('lo-shake');
  };

  const signInButton = h('button', { class: 'st-button' }, h('span', null, 'Sign in'));
  const registerButton = h('button', { class: 'st-button lo-register' }, h('span', null, 'Register'));

  const performLogin = async () => {
    if (!username.value.trim()) {
      shake(signInButton);
      username.focus();
      return;
    }
    const err = await Profiles.signIn(username.value, password.value);
    if (err) {
      showError(err);
      shake(signInButton);
      password.select();
      return;
    }
    game.toast(`Signed in as ${Profiles.current().username}`, 'success');
  };
  const register = async () => {
    const name = username.value.trim();
    if (!name) {
      shake(registerButton);
      username.focus();
      return;
    }
    if (name.toLowerCase() === 'guest') return showError('That username is reserved.');
    if (Profiles.find(name)) return showError('A profile with that username already exists.');
    await Profiles.create(name, password.value);
    game.toast(`Welcome, ${name}!`, 'success');
  };
  signInButton.addEventListener('click', () => void performLogin());
  registerButton.addEventListener('click', () => void register());

  for (const input of [username, password])
    input.addEventListener('keydown', e => {
      if (e.key !== 'Escape') e.stopPropagation();
      if (e.key === 'Enter') {
        if (input === username && !password.value && Profiles.find(username.value)?.passwordHash) password.focus();
        else void performLogin();
      }
    });
  username.addEventListener('input', () => showError(''));

  return h(
    'div',
    { class: 'lo-form' },
    h('div', { class: 'lo-padded' }, h('div', { class: 'lo-heading' }, 'ACCOUNT'), username, known, password, errorText),
    formCheckBox('Remember username', bindSetting<boolean>('online.saveUsername', [], true)).el,
    formCheckBox('Stay signed in', bindSetting<boolean>('online.staySignedIn', [], true)).el,
    h('div', { class: 'lo-note lo-padded' }, 'Profiles are stored offline in this browser. A password is optional.'),
    h('div', { class: 'st-button-item' }, signInButton),
    h('div', { class: 'st-button-item' }, registerButton),
  );
}

// ------------------------------------------------------------------ signed in: UserRankPanel + UserDropdown

function signedInView(game: Game, close: () => void): HTMLElement {
  const p = Profiles.current();
  return h('div', { class: 'lo-signed-in lo-padded' }, h('div', { class: 'lo-title' }, 'Signed in'), userRankPanel(game, p, close), userDropdown(game, close));
}

function userRankPanel(game: Game, p: Profile, close: () => void): HTMLElement {
  const globalRank = h('div', { class: 'lo-value' }, '-');
  const pp = h('div', { class: 'lo-value' }, '-');
  const loading = h('div', { class: 'lo-loading' }, h('div', { class: 'lo-spinner' }));
  const panel = h(
    'button',
    { class: 'lo-rank-panel', title: 'View profile' },
    h(
      'div',
      { class: 'lo-rank-main' },
      h('div', { class: 'lo-cover', style: { background: `linear-gradient(120deg, hsl(${p.hue},55%,40%), hsl(${(p.hue + 60) % 360},55%,22%))` } }),
      h('div', { class: 'lo-rank-grid' }, avatar(p, 60), h('div', { class: 'lo-rank-names' }, h('div', { class: 'lo-flags' }, h('span', { class: 'lo-flag', title: 'Offline profile' }, 'OFFLINE')), h('div', { class: 'lo-username-text' }, p.username))),
    ),
    h(
      'div',
      { class: 'lo-rank-bottom' },
      h('div', { class: 'lo-value-display' }, h('div', { class: 'lo-value-title' }, 'Global Ranking'), globalRank),
      h('div', { class: 'lo-value-display' }, h('div', { class: 'lo-value-title' }, 'Performance'), pp),
    ),
    loading,
  );
  panel.addEventListener('click', () => {
    close();
    openProfile(game, p);
  });
  panel.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { text: 'View profile', type: 'highlighted', action: () => (close(), openProfile(game, p)) },
      {
        text: p.passwordHash ? 'Change password' : 'Set password',
        action: () => {
          panel.parentElement?.querySelector('.lo-password-row')?.remove();
          const input = h('input', { class: 'lo-textbox', type: 'password', placeholder: p.passwordHash ? 'new password (empty removes it)' : 'new password' }) as HTMLInputElement;
          const save = () => {
            const pw = input.value;
            void Profiles.setPassword(p.id, pw).then(() => game.toast(pw ? 'Password set' : 'Password removed', 'success'));
          };
          input.addEventListener('keydown', e => {
            if (e.key !== 'Escape') e.stopPropagation();
            if (e.key === 'Enter') save();
          });
          panel.after(h('div', { class: 'lo-password-row' }, input, h('button', { class: 'st-button lo-small', onclick: save }, h('span', null, 'Save'))));
          input.focus();
        },
      },
      {
        text: 'Delete profile',
        type: 'destructive',
        action: async () => {
          close();
          if (await confirmDialog(game, `Delete the profile "${p.username}"? Its scores stay on their leaderboards.`, 'Delete profile')) Profiles.remove(p.id);
        },
      },
    ]);
  });

  // LocalUserStatisticsProvider: pp per ruleset; the global rank is this profile's place among the local profiles.
  void (async () => {
    await backfillPerformance(game);
    const rid = game.ruleset.id;
    const mine = await profileStatistics(p, rid);
    const all = await Promise.all(Profiles.all().map(o => (o.id === p.id ? Promise.resolve(mine) : profileStatistics(o, rid))));
    const rank = 1 + all.filter(s => s.pp > mine.pp).length;
    globalRank.textContent = mine.pp > 0 ? `#${rank.toLocaleString('en-US')}` : '-';
    pp.textContent = `${Math.round(mine.pp).toLocaleString('en-US')}pp`;
    loading.remove();
  })();
  return panel;
}

/** UserDropdown (OsuEnumDropdown<UserAction>) with the status icon in its header. */
function userDropdown(game: Game, close: () => void): HTMLElement {
  const status = Profiles.status();
  const cur = STATUS.find(s => s.action === status)!;
  const icon = h('span', { class: 'lo-status-icon', style: { borderColor: cur.colour } });
  const label = h('span', { class: 'lo-dd-label' }, cur.text);
  const chevron = h('span', { class: 'lo-dd-chevron' }, '⌄');
  const header = h('button', { class: 'lo-dd-header' }, icon, label, chevron);
  const menu = h('div', { class: 'lo-dd-menu' });
  const dd = h('div', { class: 'lo-dropdown' }, header, menu);
  for (const s of STATUS)
    menu.appendChild(
      h(
        'button',
        {
          class: `lo-dd-item${s.action === status ? ' selected' : ''}`,
          onclick: () => {
            dd.classList.remove('open');
            if (s.action === 'signout') {
              Profiles.signOut();
              game.toast('Signed out', 'info');
              return;
            }
            Profiles.setStatus(s.action);
            icon.style.borderColor = s.colour;
            label.textContent = s.text;
            for (const b of menu.children) b.classList.toggle('selected', b.textContent === s.text);
          },
        },
        s.text,
      ),
    );
  header.addEventListener('click', () => dd.classList.toggle('open'));
  void close;
  return dd;
}

export { GUEST_ID };
