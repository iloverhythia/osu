// Port of osu.Game/Skinning/SkinLayoutInfo.cs + SerialisedDrawableInfo.cs for the HUD: each component's anchor, origin,
// position, scale, rotation and visibility, stored per skin. The defaults are ArgonSkin's MainHUDComponents layout
// (after DefaultSkinComponentsContainer's layout callback), as the HUD drew them before layouts were editable.

import { settings } from '../../framework/Settings';
import { ACTIVE_SKIN_SETTING } from '../../game/skinning';

export type Anchor = 'TopLeft' | 'TopCentre' | 'TopRight' | 'CentreLeft' | 'Centre' | 'CentreRight' | 'BottomLeft' | 'BottomCentre' | 'BottomRight';

export const ANCHORS: Anchor[] = ['TopLeft', 'TopCentre', 'TopRight', 'CentreLeft', 'Centre', 'CentreRight', 'BottomLeft', 'BottomCentre', 'BottomRight'];

export type HudComponentId = 'wedge1' | 'wedge2' | 'health' | 'score' | 'accuracy' | 'combo' | 'progress' | 'keyCounter' | 'hitErrorLeft' | 'hitErrorRight';

export interface ComponentLayout {
  anchor: Anchor;
  origin: Anchor;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  visible: boolean;
}

export const COMPONENT_NAMES: Record<HudComponentId, string> = {
  wedge1: 'Wedge',
  wedge2: 'Wedge (2)',
  health: 'Health display',
  score: 'Score counter',
  accuracy: 'Accuracy counter',
  combo: 'Combo counter',
  progress: 'Song progress',
  keyCounter: 'Key counter display',
  hitErrorLeft: 'Hit error meter',
  hitErrorRight: 'Hit error meter (2)',
};

const L = (anchor: Anchor, origin: Anchor, x: number, y: number, scaleX = 1, scaleY = scaleX): ComponentLayout => ({ anchor, origin, x, y, scaleX, scaleY, rotation: 0, visible: true });

/** ArgonSkin MainHUDComponents. */
export const DEFAULT_LAYOUT: Record<HudComponentId, ComponentLayout> = {
  wedge1: L('TopLeft', 'TopLeft', -50, 15),
  wedge2: L('TopLeft', 'TopLeft', -46, 20),
  health: L('TopLeft', 'TopLeft', 50, 20),
  score: L('TopLeft', 'TopRight', 250, 50),
  accuracy: L('TopRight', 'TopRight', -20, 20),
  combo: L('BottomLeft', 'BottomLeft', 36, -66, 1.3),
  progress: L('BottomCentre', 'BottomCentre', 0, -10, 0.9, 1),
  keyCounter: L('BottomRight', 'BottomRight', -36, -66),
  hitErrorLeft: L('CentreLeft', 'CentreLeft', 0, 0),
  hitErrorRight: L('CentreRight', 'CentreRight', 0, 0),
};

const key = (skinId: string | null) => `skin.layout.${skinId ?? 'argon'}`;

export function currentSkinId(): string | null {
  return settings.get<string | null>(ACTIVE_SKIN_SETTING, null);
}

export function loadLayout(skinId: string | null = currentSkinId()): Record<HudComponentId, ComponentLayout> {
  const stored = settings.get<Partial<Record<HudComponentId, Partial<ComponentLayout>>>>(key(skinId), {});
  const out = {} as Record<HudComponentId, ComponentLayout>;
  for (const id of Object.keys(DEFAULT_LAYOUT) as HudComponentId[]) out[id] = { ...DEFAULT_LAYOUT[id], ...(stored[id] ?? {}) };
  return out;
}

export function saveLayout(layout: Record<HudComponentId, ComponentLayout>, skinId: string | null = currentSkinId()): void {
  settings.set(key(skinId), JSON.parse(JSON.stringify(layout)));
}

export function resetLayout(skinId: string | null = currentSkinId()): void {
  settings.set(key(skinId), {});
}

/** Anchor / origin as a fraction of the parent / drawable size. */
export function anchorFraction(a: Anchor): { x: number; y: number } {
  const x = a.endsWith('Left') ? 0 : a.endsWith('Right') ? 1 : 0.5;
  const y = a.startsWith('Top') ? 0 : a.startsWith('Bottom') ? 1 : 0.5;
  return { x, y };
}

/** SkinSelectionHandler "Closest" anchor: the anchor of the screen ninth containing the point. */
export function closestAnchor(px: number, py: number, w: number, h: number): Anchor {
  const col = px < w / 3 ? 'Left' : px > (2 * w) / 3 ? 'Right' : 'Centre';
  const row = py < h / 3 ? 'Top' : py > (2 * h) / 3 ? 'Bottom' : 'Centre';
  if (row === 'Centre' && col === 'Centre') return 'Centre';
  if (row === 'Centre') return `Centre${col}` as Anchor;
  if (col === 'Centre') return `${row}Centre` as Anchor;
  return `${row}${col}` as Anchor;
}
