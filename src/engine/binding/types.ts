/**
 * **音 × 表現パラメーターの結線（契約）。**
 *
 * 「どの音を、どのパラメーターに、どれだけ効かせるか」を UI から繋ぎ替えられるようにする
 * ための最小の型。**ここには音の解析も見え方の判断も入らない** — 音の側は
 * `AudioSource` を差し出すだけ、表現の側は `ParamDecl` を宣言するだけで、
 * 両者を結ぶのは `Binding` 1 本と、下の解決式だけである。
 *
 * ---
 * ## 解決式（仕様として固定）
 *
 * ```
 * value = clamp(base + depth × signal × (max − min), min, max)
 * ```
 *
 * - `base` … **ユーザーの基準値スライダー**。結線したあとも手で動かせて生き続ける。
 * - `signal` … 変換を通したあとのソース値（0〜1）。
 * - `depth` … −1〜1。**負で逆方向**（音が大きいほど値が下がる）。
 *
 * 「基準の周りで揺れる」という手触りをそのまま式にしたもので、
 * 結線しても基準値が消えないのが要点である。
 *
 * `Math.random()` と `Date.now()` は使わない（決定論）。
 */

/** ソースの性質。連続値か、発火系か。 */
export type SourceKind = 'level' | 'event';

/**
 * **音のソース。**
 * `value()` は毎フレーム 0〜1 の較正済み値を返す（範囲外は clamp して返すこと）。
 */
export interface AudioSource {
  readonly id: string;
  readonly label: string;
  readonly kind: SourceKind;
  value(): number;
}

/** パラメーターの性質。連続量か、引き金か。 */
export type ParamKind = 'continuous' | 'trigger';

/** **表現が宣言するパラメーター。** 表現はこれを差し出すだけで、結線の作法を知らない。 */
export interface ParamDecl {
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  /** 基準値。結線していないときの値であり、結線後は揺れの中心になる。 */
  readonly default: number;
  readonly kind: ParamKind;
}

/**
 * **変換。** ソースの生の値を、そのパラメーターに合う形へ整える。
 *
 * - `gate` … 閾値未満を 0 にする。連続値を引き金として使うときの既定。
 * - `envelope` … 立ち上がり → 減衰のカーブ。発火を連続量として使うときの既定。
 */
export type Transform =
  | { readonly type: 'gate'; readonly threshold: number }
  | { readonly type: 'envelope'; readonly attack: number; readonly decay: number };

/** 1 本の結線。`sourceId` が `null` なら「なし」＝基準値がそのまま出る。 */
export interface Binding {
  readonly paramId: string;
  readonly sourceId: string | null;
  /** −1〜1。0 で音が効かない。 */
  readonly depth: number;
  readonly transform: Transform | null;
}

/**
 * **語のプリセット。** 数値そのものではなく言葉で選べるようにしておく。
 * 選んだあとで数値を微調整してもよい（`Transform` は素の数値を持つ）。
 */
export const ENVELOPE_PRESETS = {
  /** 鋭い。ほぼ瞬間で立ち上がり、すぐ落ちる。 */
  sharp: { attack: 0.004, decay: 0.12 },
  /** 既定。打撃らしい立ち上がりと、目で追える減衰。 */
  default: { attack: 0.012, decay: 0.35 },
  /** 柔らかい。ゆっくり立ち上がり、長く残る。 */
  soft: { attack: 0.06, decay: 1.2 },
} as const satisfies Record<string, { readonly attack: number; readonly decay: number }>;

export type EnvelopePresetName = keyof typeof ENVELOPE_PRESETS;

/** ゲートの既定の閾値。 */
export const GATE_DEFAULT_THRESHOLD = 0.5;

/** 結線の定数はここに集める（時定数・閾値・既定の深さ）。 */
export const BINDING = {
  /** 深さの範囲。 */
  depthMinimum: -1,
  depthMaximum: 1,
  /** 語のプリセットの既定。 */
  envelopeDefault: 'default' satisfies EnvelopePresetName,
  gateThreshold: GATE_DEFAULT_THRESHOLD,
} as const;

/** 語のプリセットから `Transform` を作る。 */
export const envelopeTransform = (preset: EnvelopePresetName): Transform => ({
  type: 'envelope',
  ...ENVELOPE_PRESETS[preset],
});

/** 閾値から `Transform` を作る。 */
export const gateTransform = (threshold: number = GATE_DEFAULT_THRESHOLD): Transform => ({
  type: 'gate',
  threshold,
});

/**
 * **種類が合わない結線に入れる既定の変換。**
 *
 * - 発火 → 連続量 … `envelope`（Default）。生のパルスをそのまま連続量にすると 1 フレームで消える。
 * - 連続量 → 引き金 … `gate`。連続値は「越えたかどうか」に落とさないと引き金にならない。
 *
 * 種類が合っているときは変換なし（`null`）で素通しする。
 */
export const defaultTransformFor = (
  source: SourceKind,
  param: ParamKind,
): Transform | null => {
  if (source === 'event' && param === 'continuous') {
    return envelopeTransform(BINDING.envelopeDefault);
  }
  if (source === 'level' && param === 'trigger') return gateTransform();
  return null;
};
