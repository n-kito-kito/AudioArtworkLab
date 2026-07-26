import type { Composition } from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import type { ModeExciterState } from '../engine/modeBank';
import type { Theme } from '../engine/themes';

/**
 * 表現の識別子と、UI・プリセットが触れる面。
 *
 * V2 の開発中は V1 と V2 を併置する（PRD D22）。id は保存データに入るため
 * 安定させ、表示名だけを変えること。
 */

export type ExpressionId = 'cymatics-v1' | 'cymatics-v2';

export interface ExpressionDefinition {
  readonly id: ExpressionId;
  readonly label: string;
}

export const EXPRESSIONS: readonly ExpressionDefinition[] = [
  { id: 'cymatics-v1', label: 'Cymatics — Version 1' },
  { id: 'cymatics-v2', label: 'Cymatics — Version 2' },
];

/** 旧データ（'Cymatics' など id 以前の表記・不明値）はすべて V1 として扱う。 */
export function normalizeExpressionId(raw: unknown): ExpressionId {
  return raw === 'cymatics-v2' ? 'cymatics-v2' : 'cymatics-v1';
}

/**
 * 板の表現が UI へ見せる面。`CymaticsPlate`（V1/V2）と、開発用の
 * `ComparisonPlate`（V1 と V2 を同時に走らせる）が実装する。
 */
export interface PlateExpression extends Composition {
  readonly id: ExpressionId;
  getEffects(): readonly Effect[];
  moveEffect(effect: Effect, direction: -1 | 1): void;
  setEffectOrder(names: string[]): void;
  getTheme(): Theme;
  setTheme(theme: Theme): void;
  getDepth(): number;
  setDepth(amount: number): void;
  getZoom(): number;
  setZoom(zoom: number): void;
  setDebugView(view: number): void;
  getDebugState(): ModeExciterState;
}
