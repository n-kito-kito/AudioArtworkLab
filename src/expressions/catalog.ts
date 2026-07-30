import type { Effect } from '../effects/Effect';
import type { Theme } from '../engine/themes';
import { applyTuning } from '../engine/tuning';
import { Cymatics } from '../fields/Cymatics';
import { CymaticsV2 } from '../fields/CymaticsV2';
import { CymaticsPlate } from './CymaticsPlate';
import { LightCoreStudy } from './LightCoreStudy';
import { LightElementLab, type LightElementMode } from './LightElementLab';
import { LightElementLab2, type LightElement2Mode } from './LightElementLab2';
import { LightReactiveLab, type ReactiveMode } from './LightReactiveLab';
import { LightSpatialStudy } from './LightSpatialStudy';
import { LightTraces } from './LightTraces';
import { ModularPatternField } from './ModularPatternField';
import { ReactiveGeometry } from './ReactiveGeometry';
import type { LabExpression } from './Expression';

/**
 * 表現のカタログ。
 *
 * V2 の開発中は V1 と V2 を併置し、同じ音源で見比べられるようにする（PRD D22）。
 * id は保存データに入るため安定させる。表示名だけを変えること。
 */

export type ExpressionId =
  | 'cymatics-v1'
  | 'cymatics-v2'
  | 'modular-v1'
  | 'light-traces-v1'
  | 'light-core-study-v1'
  | 'light-spatial-study-v1'
  | 'light-element-core-v1'
  | 'light-element-ray-v1'
  | 'light-element-sheet-v1'
  | 'light-element-haze-v1'
  | 'light-element-prism-v1'
  | 'light-element-depth-v1'
  | 'light-element-envelope-v1'
  | 'light-element-composite-v1'
  | 'light-element2-core-v1'
  | 'light-element2-sheet-v1'
  | 'light-element2-haze-v1'
  | 'light-element2-ray-v1'
  | 'light-element2-all-v1'
  | 'light-reactive-trigger-v1'
  | 'light-reactive-texture-v1'
  | 'light-reactive-variation-v1'
  | 'light-reactive-composite-v1'
  | 'reactive-geometry-v1';

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
  {
    id: 'modular',
    label: 'Modular Pattern Field',
    versions: [{ id: 'modular-v1', label: 'V1' }],
  },
  {
    id: 'light-traces',
    label: 'Light Traces',
    versions: [{ id: 'light-traces-v1', label: 'V1' }],
  },
  // 検証用の実験表現。音の立ち上がりと光の因果関係だけを見るための計測器で、
  // Light Traces 本体とはコードも状態も共有しない。
  {
    id: 'light-core-study',
    label: 'Light Traces — Core Study',
    versions: [{ id: 'light-core-study-v1', label: 'V1' }],
  },
  // 3D 空間の検証表現。音の検出は 2D Core Study と同じ検出器を共有し、
  // 「固定カメラの奥行きで前後関係が読めるか」だけを見る。2D は温存する。
  {
    id: 'light-spatial-study',
    label: 'Light Traces — Spatial Study',
    versions: [{ id: 'light-spatial-study-v1', label: 'V1' }],
  },
  // リファレンスの光を要素ごとに分けて観察する独立した実験室。
  // 各 Version は同じ固定条件を使い、最後の Composite だけで再結合する。
  {
    id: 'light-element-lab',
    label: 'Light Element Lab',
    versions: [
      { id: 'light-element-core-v1', label: 'Core' },
      { id: 'light-element-ray-v1', label: 'Ray' },
      { id: 'light-element-sheet-v1', label: 'Sheet' },
      { id: 'light-element-haze-v1', label: 'Haze' },
      { id: 'light-element-prism-v1', label: 'Prism' },
      { id: 'light-element-depth-v1', label: 'Depth' },
      { id: 'light-element-envelope-v1', label: 'Envelope' },
      { id: 'light-element-composite-v1', label: 'Composite' },
    ],
  },
  // 色の作り方だけを差し替えた 2 台目の実験室（V1 は無改変で温存する）。
  // 1 つの光を R/G/B の 3 チャンネルへ分け、わずかにずらして重ねる（CRT 的構造）。
  // 音へは繋がず、要素ごとに静止画で見え方だけを検証する。
  {
    id: 'light-element-lab-2',
    label: 'Light Element Lab 2',
    versions: [
      { id: 'light-element2-core-v1', label: 'Core' },
      { id: 'light-element2-sheet-v1', label: 'Sheet' },
      { id: 'light-element2-haze-v1', label: 'Haze' },
      { id: 'light-element2-ray-v1', label: 'Ray' },
      { id: 'light-element2-all-v1', label: 'All' },
    ],
  },
  // 静的な Light Element Lab の光学を、音イベントへ反応する表現へ進めた実験室。
  // Trigger → Texture → Variation → Composite の順に、接続する音の関係を増やす。
  {
    id: 'light-reactive-lab',
    label: 'Light Reactive Lab',
    versions: [
      { id: 'light-reactive-trigger-v1', label: 'Trigger' },
      { id: 'light-reactive-texture-v1', label: 'Texture' },
      { id: 'light-reactive-variation-v1', label: 'Variation' },
      { id: 'light-reactive-composite-v1', label: 'Composite' },
    ],
  },
  {
    id: 'reactive-geometry',
    label: 'Reactive Geometry',
    versions: [{ id: 'reactive-geometry-v1', label: 'V1' }],
  },
];

const KNOWN_EXPRESSION_IDS = new Set<string>(
  EXPRESSION_FAMILIES.flatMap((family) => family.versions.map((version) => version.id)),
);

const LIGHT_ELEMENT_MODES: Partial<Record<ExpressionId, LightElementMode>> = {
  'light-element-core-v1': 'core',
  'light-element-ray-v1': 'ray',
  'light-element-sheet-v1': 'sheet',
  'light-element-haze-v1': 'haze',
  'light-element-prism-v1': 'prism',
  'light-element-depth-v1': 'depth',
  'light-element-envelope-v1': 'envelope',
  'light-element-composite-v1': 'composite',
};

const LIGHT_ELEMENT2_MODES: Partial<Record<ExpressionId, LightElement2Mode>> = {
  'light-element2-core-v1': 'core',
  'light-element2-sheet-v1': 'sheet',
  'light-element2-haze-v1': 'haze',
  'light-element2-ray-v1': 'ray',
  'light-element2-all-v1': 'all',
};

const LIGHT_REACTIVE_MODES: Partial<Record<ExpressionId, ReactiveMode>> = {
  'light-reactive-trigger-v1': 'trigger',
  'light-reactive-texture-v1': 'texture',
  'light-reactive-variation-v1': 'variation',
  'light-reactive-composite-v1': 'composite',
};

/** 旧データ（'Cymatics' など id 以前の表記・不明値）はすべて V1 として扱う。 */
export function normalizeExpressionId(raw: unknown): ExpressionId {
  return typeof raw === 'string' && KNOWN_EXPRESSION_IDS.has(raw)
    ? (raw as ExpressionId)
    : 'cymatics-v1';
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
  // サイマティクス以外の表現は TUNING を使わない（質感の定数は表現ごとに持つ）。
  if (id === 'modular-v1') return new ModularPatternField(effects, theme);
  if (id === 'light-traces-v1') return new LightTraces(effects, theme);
  if (id === 'light-core-study-v1') return new LightCoreStudy(effects, theme);
  if (id === 'light-spatial-study-v1') return new LightSpatialStudy(effects, theme);
  const lightElementMode = LIGHT_ELEMENT_MODES[id];
  if (lightElementMode) return new LightElementLab(id, lightElementMode, effects, theme);
  const lightElement2Mode = LIGHT_ELEMENT2_MODES[id];
  if (lightElement2Mode) return new LightElementLab2(id, lightElement2Mode, effects, theme);
  const reactiveMode = LIGHT_REACTIVE_MODES[id];
  if (reactiveMode) return new LightReactiveLab(id, reactiveMode, effects, theme);
  if (id === 'reactive-geometry-v1') return new ReactiveGeometry(effects, theme);
  applyTuning(id);
  const field = id === 'cymatics-v2' ? new CymaticsV2() : new Cymatics();
  return new CymaticsPlate(effects, theme, field, id);
}
