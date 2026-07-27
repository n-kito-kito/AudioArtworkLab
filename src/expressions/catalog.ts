import type { Effect } from '../effects/Effect';
import type { Theme } from '../engine/themes';
import { applyTuning } from '../engine/tuning';
import { Cymatics } from '../fields/Cymatics';
import { CymaticsV2 } from '../fields/CymaticsV2';
import { CymaticsPlate } from './CymaticsPlate';

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
): CymaticsPlate {
  applyTuning(id);
  const field = id === 'cymatics-v2' ? new CymaticsV2() : new Cymatics();
  return new CymaticsPlate(effects, theme, field, id);
}
