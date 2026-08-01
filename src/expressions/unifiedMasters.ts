import type { UnifiedAxes } from './unifiedAxes';

/**
 * **マスター軸（Light Unified）。**
 *
 * 31 本の軸は、3 プリセットの座標を並べると**実質 7 つの束**としてしか動いていない。
 * たとえば `Texture grain` / `Silhouette` / `Fragment character` は
 * (0.82, 0.70, 0.85) / (0.60, 0.50, 0.70) / (0.12, 0.08, 0.15) と 3 枚ともほぼ同じ順で、
 * **3 本を別々に触っているが、やりたいことは 1 つ**だった。
 *
 * ---
 * ## 作り
 *
 * マスターは**状態を持たない**。`UnifiedAxes` に新しい欄は増えず、
 * マスターは配下の軸への**写像関数 1 本**として実装してある。
 *
 * - `apply(axes, value)` … 配下を一斉に書く（マスターを動かすと配下が追従する）
 * - `read(axes)` … 配下から位置を逆算する（**詳細を直接触ればマスターの表示がそちらへ動く**）
 *
 * 状態を持たないので、**詳細を直接触ったほうが常に優先**される。
 * `normalizeAxes` もプリセットも決定論も、マスターの存在を知らないまま動く。
 *
 * ## 幅を狭めないこと
 *
 * マスターは**詳細を消さない**。配下の軸はすべて折りたたみの中に残っており、
 * マスターの線から外れた座標（例: 質感だけ強く、輪郭は素のまま）もそのまま作れる。
 * マスターは「よく使う斜めの線」を 1 本引いただけで、空間そのものは 31 次元のままである。
 */

/** 配下 1 本ぶん。マスター 0 / 1 のときの値を持つ（間は線形）。 */
export interface MasterTarget {
  readonly id: keyof UnifiedAxes;
  readonly low: number;
  readonly high: number;
}

export interface AxisMaster {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly low: string;
  readonly high: string;
  /** 配下の軸。**この一覧が短くなることはあっても、詳細の軸自体は消さない。** */
  readonly targets: readonly MasterTarget[];
}

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * **マスターの一覧。**
 *
 * 両端は 3 プリセットの座標から取ってある（0 側が optics、1 側が spatial に近い）ので、
 * マスター 1 本を端まで振ると 3 枚のうち 2 枚のその側面がだいたい再現される。
 */
export const AXIS_MASTERS: readonly AxisMaster[] = [
  {
    id: 'spread',
    label: 'Spread',
    group: '配置・空間',
    low: '中心',
    high: 'ばらける',
    // 縦横は**潰さない**（実測で sx / sy は独立に動く）。偏りは Aspect が持つ。
    targets: [
      { id: 'spreadX', low: 0.05, high: 0.9 },
      { id: 'spreadY', low: 0.05, high: 0.9 },
    ],
  },
  {
    id: 'time',
    label: 'Time',
    group: '時間',
    low: '鋭い・短い',
    high: '遅い・長い・ずれる',
    targets: [
      { id: 'attack', low: 0, high: 0.35 },
      { id: 'decay', low: 0.15, high: 0.9 },
      { id: 'stagger', low: 0.06, high: 0.85 },
    ],
  },
  {
    id: 'colourLock',
    label: 'Colour lock',
    group: '色',
    low: '要素ごと・滑らか',
    high: '全体 1 色・保持',
    // **`Hue depth` は入れない。** 要素どうし（coherence）と要素の中（depth）は
    // 彩度という 1 つの観測量を逆向きに動かすので、束ねると打ち消し合って何も起きない。
    targets: [
      { id: 'hueCoherence', low: 0.35, high: 1 },
      { id: 'hueStickiness', low: 0.2, high: 1 },
    ],
  },
  {
    id: 'core',
    label: 'Core',
    group: '構成',
    low: '小さい点',
    high: '光る面',
    // **`Blur` は入れない。** 核の半径にも効くが、膜・破片・靄・光条の縁にも効くので、
    // 束ねると「シャープな縁のまま大きい核」が作れなくなる。
    targets: [
      { id: 'coreSize', low: 0.35, high: 0.6 },
      { id: 'coreShape', low: 0.12, high: 0.55 },
      { id: 'coreBloom', low: 0.18, high: 0.45 },
    ],
  },
  {
    id: 'membrane',
    label: 'Membrane',
    group: '構成',
    low: '固定・画面基準',
    high: '打撃ごと・空間',
    // **`Membrane–Beam` は入れない。** 膜と光条の配分は別の次元で、
    // 束ねると「膜が優勢だが画面基準（平面的）」が作れなくなる。
    targets: [
      { id: 'membraneScale', low: 0.06, high: 0.9 },
      { id: 'eventMembrane', low: 0.05, high: 0.8 },
    ],
  },
  {
    id: 'material',
    label: 'Material',
    group: '構成',
    low: '素の形',
    high: '素材が支配',
    // 3 本は核への効き方が逆（grain は加算・silhouette は核に効かない）なので、
    // **詳細は必ず残す**。ここは「よく使う斜めの線」を 1 本引いているだけ。
    targets: [
      { id: 'textureGrain', low: 0.12, high: 0.82 },
      { id: 'silhouette', low: 0.08, high: 0.7 },
      { id: 'fragmentCharacter', low: 0.15, high: 0.85 },
    ],
  },
];

/** 配下から位置を逆算する（各配下の位置の平均）。 */
export const readMaster = (master: AxisMaster, axes: UnifiedAxes): number => {
  let total = 0;
  for (const target of master.targets) {
    const span = target.high - target.low;
    total += Math.abs(span) < 1e-6 ? 0 : clamp01((axes[target.id] - target.low) / span);
  }
  return clamp01(total / Math.max(master.targets.length, 1));
};

/** 配下を一斉に書く。**戻り値は書いた軸だけの差分。** */
export const applyMaster = (
  master: AxisMaster,
  value: number,
): Partial<Record<keyof UnifiedAxes, number>> => {
  const t = clamp01(value);
  const out: Partial<Record<keyof UnifiedAxes, number>> = {};
  for (const target of master.targets) out[target.id] = clamp01(mix(target.low, target.high, t));
  return out;
};

/**
 * **縦横の偏り（Aspect）。**
 *
 * `Spread` が「どれだけ散るか」を持ち、こちらが「縦横のどちらへ寄るか」を持つ。
 * 2 本で `spreadX` / `spreadY` の張る面をそのまま覆うので、**到達できる配置は減らない**
 * （実測で `Spread X` は sx だけ、`Spread Y` は sy だけを動かす＝軸は独立している）。
 *
 * 0.5 で等方。0 側で縦長（Y が広い）、1 側で横長（X が広い）。
 */
export const readAspect = (axes: UnifiedAxes): number => {
  const sum = clamp01(axes.spreadX) + clamp01(axes.spreadY);
  if (sum <= 1e-6) return 0.5;
  return clamp01(0.5 + (clamp01(axes.spreadX) - clamp01(axes.spreadY)) / (2 * sum));
};

/** 散らばりの量を保ったまま、縦横の偏りだけを書き換える。 */
export const applyAspect = (
  axes: UnifiedAxes,
  value: number,
): Partial<Record<keyof UnifiedAxes, number>> => {
  const amount = (clamp01(axes.spreadX) + clamp01(axes.spreadY)) * 0.5;
  const bias = clamp01(value) * 2 - 1;
  return {
    spreadX: clamp01(amount * (1 + bias)),
    spreadY: clamp01(amount * (1 - bias)),
  };
};

/** `Spread` は偏りを保ったまま量だけを動かす（Aspect と直交させる）。 */
export const applySpread = (
  axes: UnifiedAxes,
  value: number,
): Partial<Record<keyof UnifiedAxes, number>> => {
  const master = AXIS_MASTERS[0]!;
  const target = mix(master.targets[0]!.low, master.targets[0]!.high, clamp01(value));
  return applyAspect({ ...axes, spreadX: target, spreadY: target }, readAspect(axes));
};

/** `Spread` の位置（量）。 */
export const readSpread = (axes: UnifiedAxes): number => {
  const master = AXIS_MASTERS[0]!;
  const { low, high } = master.targets[0]!;
  const amount = (clamp01(axes.spreadX) + clamp01(axes.spreadY)) * 0.5;
  return clamp01((amount - low) / Math.max(high - low, 1e-6));
};
