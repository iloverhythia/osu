// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Legacy (osu!stable .osk / beatmap) skin rendering for osu!catch. Ports osu.Game.Rulesets.Catch/Skinning/Legacy:
// CatchLegacySkinTransformer (component availability + CatchSkinColour lookups), LegacyCatchHitObjectPiece, LegacyFruitPiece,
// LegacyBananaPiece, LegacyDropletPiece, LegacyCatcher / LegacyCatcherNew / LegacyCatcherOld, plus the catcher colouring of
// Catcher / CatcherTrailDisplay. Only rendering is done here.

import type { RGB } from '../../Skin';
import type { LoadedSkin } from '../../skinning/LegacySkin';
import { SkinAnimation, SkinSource, type MaxSize } from '../../skinning/SkinSource';
import { drawSprite, type SkinTexture } from '../../skinning/SkinTexture';
import { OBJECT_RADIUS } from './objects';

const FRUIT_MAX_SIZE: MaxSize = { width: 160, height: 160 };

/** Catcher.DEFAULT_HYPER_DASH_COLOUR */
const DEFAULT_HYPER_DASH_COLOUR: RGB = [255, 0, 0];

/** CatcherAnimationState */
export type CatcherAnimationState = 'idle' | 'fail' | 'kiai';

export type LegacyCatchPieceKind = 'fruit' | 'droplet' | 'banana';

/** FruitVisualRepresentation (IndexInBeatmap % 4) → legacy texture names. */
const FRUIT_NAMES = ['pear', 'grapes', 'apple', 'orange'];

export class CatchLegacySkinRenderer {
  readonly has: { fruit: boolean; banana: boolean; droplet: boolean; catcher: boolean };

  /** CatchSkinColour.HyperDash */
  readonly hyperDashColour: RGB;
  /** CatchSkinColour.HyperDashAfterImage */
  readonly hyperDashAfterImageColour: RGB;
  /** CatchSkinColour.HyperDashFruit */
  private readonly hyperDashFruitColour: RGB;

  private readonly textures = new Map<string, { main: SkinTexture | null; overlay: SkinTexture | null }>();
  private readonly catcherStyle: 'old' | 'new' | null = null;
  private readonly catcherAnimations = new Map<CatcherAnimationState, SkinAnimation | null>();
  private readonly source: SkinSource;

  constructor(sources: readonly LoadedSkin[]) {
    const source = new SkinSource(sources);
    this.source = source;
    const per = (pred: (s: SkinSource) => boolean) => source.sources.some(s => pred(source.only(s)));

    const colour = (name: string): RGB | null => {
      const c = source.customColour(name);
      // LegacyColourCompatibility.DisallowZeroAlpha (alpha isn't used when tinting here)
      return c ? [c[0], c[1], c[2]] : null;
    };
    this.hyperDashColour = colour('HyperDash') ?? DEFAULT_HYPER_DASH_COLOUR;
    this.hyperDashAfterImageColour = colour('HyperDashAfterImage') ?? this.hyperDashColour;
    this.hyperDashFruitColour = colour('HyperDashFruit') ?? colour('HyperDash') ?? DEFAULT_HYPER_DASH_COLOUR;

    // CatchSkinComponents.Catcher: per skin, old style (fruit-ryuuta) for versions below 2.3, then new style (fruit-catcher-idle).
    for (const skin of source.sources) {
      const s = source.only(skin);
      const version = s.version ?? 1;
      const hasOld = s.hasTexture('fruit-ryuuta') || s.hasTexture('fruit-ryuuta-0');
      const hasNew = s.hasTexture('fruit-catcher-idle') || s.hasTexture('fruit-catcher-idle-0');
      if (version < 2.3 && hasOld) {
        this.catcherStyle = 'old';
        break;
      }
      if (hasNew) {
        this.catcherStyle = 'new';
        break;
      }
    }

    this.has = {
      fruit: per(s => s.hasTexture('fruit-pear')),
      banana: per(s => s.hasTexture('fruit-bananas')),
      droplet: per(s => s.hasTexture('fruit-drop')),
      catcher: this.catcherStyle != null,
    };
  }

  private texturesFor(name: string): { main: SkinTexture | null; overlay: SkinTexture | null } {
    let t = this.textures.get(name);
    if (!t) {
      t = { main: this.source.getTexture(name, FRUIT_MAX_SIZE), overlay: this.source.getTexture(`${name}-overlay`, FRUIT_MAX_SIZE) };
      this.textures.set(name, t);
    }
    return t;
  }

  /**
   * LegacyCatchHitObjectPiece: hyper-dash sprite (additive, behind), combo-coloured sprite, then the overlay.
   * `radius` is the displayed object radius in pixels (OBJECT_RADIUS * scale), `rotation` in degrees.
   */
  drawPiece(
    g: CanvasRenderingContext2D,
    kind: LegacyCatchPieceKind,
    indexInBeatmap: number,
    x: number,
    y: number,
    radius: number,
    rotation: number,
    colour: RGB,
    hyperDash: boolean,
    alpha: number,
  ): void {
    if (alpha <= 0) return;
    const name = kind === 'fruit' ? `fruit-${FRUIT_NAMES[((indexInBeatmap % 4) + 4) % 4]}` : kind === 'banana' ? 'fruit-bananas' : 'fruit-drop';
    const t = this.texturesFor(name);
    // Sprites are shown at their natural size within the OBJECT_RADIUS * 2 sized piece; LegacyDropletPiece has Scale = 0.8.
    const scale = (radius / OBJECT_RADIUS) * (kind === 'droplet' ? 0.8 : 1);
    if (hyperDash) drawSprite(g, t.main, x, y, { scale: scale * 1.2, rotation, alpha: alpha * 0.7, colour: this.hyperDashFruitColour, additive: true });
    drawSprite(g, t.main, x, y, { scale, rotation, alpha, colour });
    drawSprite(g, t.overlay, x, y, { scale, rotation, alpha });
  }

  private catcherAnimation(state: CatcherAnimationState): SkinAnimation | null {
    if (this.catcherAnimations.has(state)) return this.catcherAnimations.get(state)!;
    let anim: SkinAnimation | null;
    if (this.catcherStyle === 'old') anim = this.source.getAnimation('fruit-ryuuta', true, true, true);
    else anim = this.source.getAnimation(`fruit-catcher-${state}`, true, true, true) ?? this.source.getAnimation('fruit-catcher-idle', true, true, true);
    this.catcherAnimations.set(state, anim);
    return anim;
  }

  /**
   * LegacyCatcher: sprites at their raw size scaled by 0.5 * 0.7, with the origin 16px below the sprite's top
   * placed at the catcher's position (top of the plate). `unit` = pixels per playfield unit, `catcherScale` = Catcher.Scale.
   */
  drawCatcher(
    g: CanvasRenderingContext2D,
    x: number,
    plateY: number,
    unit: number,
    catcherScale: number,
    direction: number,
    state: CatcherAnimationState,
    elapsed: number,
    colour: readonly number[],
    alpha = 1,
    additive = false,
  ): void {
    const anim = this.catcherAnimation(state);
    if (!anim || alpha <= 0) return;
    const frame = anim.frameAt(elapsed);
    const s = 0.5 * 0.7 * catcherScale * unit;
    drawSprite(g, frame, x, plateY - 16 * s, { scaleX: s * (direction < 0 ? -1 : 1), scaleY: s, originX: 0.5, originY: 0, alpha, colour, additive });
  }
}
