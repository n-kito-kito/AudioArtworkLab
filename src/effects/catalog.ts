import type { Effect } from './Effect';
import { BloomEffect } from './BloomEffect';
import { BlurEffect } from './BlurEffect';
import { GlassEffect } from './GlassEffect';
import { GlitchEffect } from './GlitchEffect';
import { GrainEffect } from './GrainEffect';
import { HalftoneEffect } from './HalftoneEffect';
import { PaletteMapEffect } from './PaletteMapEffect';
import { RepeatEffect } from './RepeatEffect';
import { RgbSplitEffect } from './RgbSplitEffect';
import { ScanDriftEffect } from './ScanDriftEffect';
import { WarpEffect } from './WarpEffect';
import { GridRevealModifier } from '../modifiers/GridRevealModifier';
import { PixelStretchModifier } from '../modifiers/PixelStretchModifier';

/**
 * ③ 質感レイヤーの一覧。Composition ごとに新しいインスタンスを作る
 * （Effect は dispose されるとシェーダーを失うため共有できない)。
 *
 * すべて無効で始まる。表現から逆算して必要なものだけを有効にする方針
 * (DESIGN.md §1)。
 */
export function createEffects(): Effect[] {
  return [
    new GrainEffect(),
    new BlurEffect(),
    new PaletteMapEffect(),
    new RgbSplitEffect(),
    new GlitchEffect(),
    new WarpEffect(),
    new ScanDriftEffect(),
    new RepeatEffect(),
    new PixelStretchModifier(),
    new GridRevealModifier(),
    new HalftoneEffect(),
    new GlassEffect(),
    new BloomEffect(),
  ];
}

/** Effect の状態を別インスタンスの集合へ引き継ぐ（Renderer 切替時に設定を保つ）。 */
export function transferEffectState(from: readonly Effect[], to: readonly Effect[]): void {
  for (const source of from) {
    const target = to.find((effect) => effect.name === source.name);
    if (!target) continue;
    target.enabled = source.enabled;
    target.setParameterValues(source.getParameterValues());
    target.setAudioMappings(source.getAudioMappings());
  }
}
