import type { Game } from '../Game';

export function openSkinEditor(game: Game): void {
  game.toast('Skin editor', 'info');
}
