import type { Effect } from '../effects/Effect';
import type { Theme } from '../engine/themes';
import { applyTuning } from '../engine/tuning';
import { Cymatics } from '../fields/Cymatics';
import { CymaticsV2 } from '../fields/CymaticsV2';
import { CymaticsPlate } from './CymaticsPlate';
import type { LabExpression } from './Expression';

/**
 * 表現のカタログ。
 *
 * V2 の開発中は V1 と V2 を併置し、同じ音源で見比べられるようにする（PRD D22）。
 * id は保存データに入るため安定させる。表示名だけを変えること。
 */

export type ExpressionId = 'cymatics-v1' | 'cymatics-v2';

export interface ExpressionVersion {
  readonly id: ExpressionId;
  readonly label: string;
}

/**
 * 表現のファミリー。UI はまずファミリー（サイマティクス等）を選び、
 * 版（V1/V2）はその下のボタンで切り替える。今後の表現はファミリーとして増える。
 */
export interface ExpressionFamily {
  readonly id: string;
  readonly label: string;
  readonly versions: readonly ExpressionVersion[];
}

/**
 * 画角。板そのものがこの比率の長方形になる（D26。切り取りや余白ではない）。
 * ratio = 幅 / 高さ。
 */
export interface AspectDefinition {
  readonly id: string;
  readonly label: string;
  readonly ratio: number;
}

export const ASPECT_RATIOS: readonly AspectDefinition[] = [
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '2:3', label: '2:3', ratio: 2 / 3 },
];

/** 不明な画角 id は 1:1 に寄せる（保存データへの防御）。 */
export function normalizeAspectId(raw: unknown): string {
  return ASPECT_RATIOS.some((entry) => entry.id === raw) ? (raw as string) : '1:1';
}

export const EXPRESSION_FAMILIES: readonly ExpressionFamily[] = [
  {
    id: 'cymatics',
    label: 'Cymatics',
    versions: [
      { id: 'cymatics-v1', label: 'V1' },
      { id: 'cymatics-v2', label: 'V2' },
    ],
  },
];

/** 旧データ（'Cymatics' など id 以前の表記・不明値）はすべて V1 として扱う。 */
export function normalizeExpressionId(raw: unknown): ExpressionId {
  return raw === 'cymatics-v2' ? 'cymatics-v2' : 'cymatics-v1';
}

/**
 * 表現を生成する。V1 と V2 は場（振動モードの体系）だけが異なり、
 * 砂の物理シミュレーションと Effect チェーンは同じ基盤を共有する。
 * インスタンスは別々に作られ、状態は一切共有しない。
 *
 * 質感（`TUNING`）は版ごとに焼き込まれているため、ここで読み込む。
 * これにより V1 は V2 のチューニングに影響されない。
 */
export function createExpression(
  id: ExpressionId,
  effects: Effect[],
  theme?: Theme,
): LabExpression {
  applyTuning(id);
  const field = id === 'cymatics-v2' ? new CymaticsV2() : new Cymatics();
  return new CymaticsPlate(effects, theme, field, id);
}
