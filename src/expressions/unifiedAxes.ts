/**
 * **統合表現の連続軸（Light Unified）。**
 *
 * Spatial Study / Reactive Lab / Element Lab 2 の 3 つの見え方を、
 * **行き来できる 1 本の連続軸の集合**として置き直したもの。
 *
 * ---
 * ## 原則
 *
 * - **どの軸も「コードパスの切替」ではなく、描画数式の中の連続な混合係数**である。
 *   スライダーの途中の値が常に意味を持ち、**軸の中間に新しい見え方が現れる**ことが価値。
 *   `if (axis > 0.5)` のような分岐で見え方を切り替えてはいけない。
 * - 3 つの既存表現は**比較用に無改変で温存**する。ここは新規のコードで、
 *   共有部品（帯域イベント検出・アトラス・結線・痕跡場）だけを再利用する。
 * - 3 つの見え方は絶対解ではない。プリセットは**参考座標**であって、
 *   厳密な再現ではなく「だいたいの雰囲気」が置ければよい。
 *
 * ## 不変条件（どの軸設定でも壊れない）
 *
 * - **無音 = 黒**（音が無ければ 1 画素も出ない）
 * - **白の予算**: 白へ届いてよいのは核だけ
 * - **決定論**: `Math.random()` も `Date.now()` も使わない
 */

/** 軸 1 本の定義。すべて 0〜1 に正規化して持つ（`tickRate` だけ実寸を別に持つ）。 */
export interface AxisDecl {
  readonly id: keyof UnifiedAxes;
  readonly label: string;
  readonly group: string;
  /** 0 側 / 1 側が何を意味するか。UI の補足に出す。 */
  readonly low: string;
  readonly high: string;
}

export interface UnifiedAxes {
  // ---- 配置 ----
  /** 0 = 中心に集まる ⇄ 1 = 画面いっぱいにばらける。 */
  spreadX: number;
  spreadY: number;
  /** 中心・骨格軸への引力。1 で軸に吸い寄せられる。 */
  anchorPull: number;

  // ---- 時間 ----
  /**
   * 0 = 連続エンベロープ ⇄ 1 = フルティック明滅。
   * **ラッチ量と off ティックの減衰深さを同時に補間する**ので、途中は
   * 「少しコマ送りっぽい連続」になる（切替ではない）。
   */
  strobe: number;
  /** 光学クロックの速さ（12〜48 の実寸を 0〜1 で持つ）。 */
  tickRate: number;
  /** 0 = 即時 ⇄ 1 = ゆっくり立ち上がる。 */
  attack: number;
  /** 0 = 一瞬で消える ⇄ 1 = 長い尾を引く。 */
  decay: number;

  // ---- 光学 ----
  /**
   * 0 = シャープな縁・弱いブルーム ⇄ 1 = にじんだ縁・強いブルーム・広いハロ。
   * 縁の `smoothstep` 幅・ハロの利得・散乱の広がりを**1 本の軸で束ねる**。
   */
  blur: number;

  // ---- 空間 ----
  /** 0 = 平面（全部同じ奥行き）⇄ 1 = Near/Far に散る。 */
  depthSpread: number;
  /** 0 = 正面 ⇄ 1 = 3D の傾き。 */
  tilt: number;

  // ---- 色 ----
  /** 0 = 要素ごとに seed の色 ⇄ 1 = 全体が 1 つの色相。 */
  hueCoherence: number;
  /** 0 = 滑らかに追従 ⇄ 1 = 離散状態 + 長い保持。 */
  hueStickiness: number;
  /** RGB のオフセットと非相関の量。 */
  dispersion: number;
  /**
   * **チャンネルの偏り 1 本。** 0 = R 優勢 / 0.5 = G 優勢 / 1 = B 優勢の**非循環**な経路。
   * 利得の最大は常に 1 なので、**白の予算は動かない**（`channelBalance.ts`）。
   */
  channelBalance: number;

  // ---- 構成 ----
  /** 0 = 膜が優勢 ⇄ 1 = 光条が優勢。性格の軸。 */
  membraneBeam: number;
  /** 破片の量。 */
  fragments: number;
  /** 靄の床（画面をまとめる最下段の明るさ）。 */
  hazeFloor: number;
  /** 常設の十字（骨格）の存在感。 */
  skeleton: number;

  // ---- 動き ----
  /** 0 = 静止 ⇄ 1 = 面内をゆっくり漂う。 */
  motion: number;
  /** 痕跡場の効き（消えた場所へ次が引き寄せられる）。 */
  trace: number;

  // ---- 明るさ ----
  intensity: number;
}

/** 軸の並び（UI の順序でもある）。 */
export const AXIS_DECLS: readonly AxisDecl[] = [
  { id: 'spreadX', label: 'Spread X', group: '配置', low: '中心', high: 'ばらける' },
  { id: 'spreadY', label: 'Spread Y', group: '配置', low: '中心', high: 'ばらける' },
  { id: 'anchorPull', label: 'Anchor pull', group: '配置', low: '自由', high: '軸へ吸着' },
  { id: 'strobe', label: 'Strobe', group: '時間', low: '連続', high: 'コマ送り' },
  { id: 'tickRate', label: 'Tick rate', group: '時間', low: '12fps', high: '48fps' },
  { id: 'attack', label: 'Attack', group: '時間', low: '即時', high: 'ゆっくり' },
  { id: 'decay', label: 'Decay', group: '時間', low: '一瞬', high: '長い尾' },
  { id: 'blur', label: 'Blur', group: '光学', low: 'シャープ', high: 'にじみ' },
  { id: 'depthSpread', label: 'Depth spread', group: '空間', low: '平面', high: '前後に散る' },
  { id: 'tilt', label: 'Tilt', group: '空間', low: '正面', high: '傾き' },
  { id: 'hueCoherence', label: 'Hue coherence', group: '色', low: '要素ごと', high: '全体 1 色' },
  { id: 'hueStickiness', label: 'Hue stickiness', group: '色', low: '滑らか', high: '離散・保持' },
  { id: 'dispersion', label: 'Dispersion', group: '色', low: '重なる', high: 'ずれる' },
  { id: 'channelBalance', label: 'Channel balance', group: '色', low: 'R 優勢', high: 'B 優勢' },
  { id: 'membraneBeam', label: 'Membrane–Beam', group: '構成', low: '膜', high: '光条' },
  { id: 'fragments', label: 'Fragments', group: '構成', low: '無し', high: '多い' },
  { id: 'hazeFloor', label: 'Haze floor', group: '構成', low: '無し', high: '厚い' },
  { id: 'skeleton', label: 'Skeleton', group: '構成', low: '無し', high: 'はっきり' },
  { id: 'motion', label: 'Motion', group: '動き', low: '静止', high: '漂う' },
  { id: 'trace', label: 'Trace', group: '動き', low: '無し', high: '強い' },
  { id: 'intensity', label: 'Intensity', group: '明るさ', low: '暗い', high: '明るい' },
];

/**
 * **既定値。** 3 つのプリセット座標のだいたい中間から始める。
 * ここが「まだ誰も見ていない中間の見え方」の出発点になる。
 */
export const DEFAULT_AXES: UnifiedAxes = {
  spreadX: 0.5,
  spreadY: 0.5,
  anchorPull: 0.35,
  strobe: 0.45,
  tickRate: 0.45,
  attack: 0.3,
  decay: 0.45,
  blur: 0.5,
  depthSpread: 0.45,
  tilt: 0.3,
  hueCoherence: 0.6,
  hueStickiness: 0.5,
  dispersion: 0.35,
  channelBalance: 0.5,
  membraneBeam: 0.5,
  fragments: 0.5,
  hazeFloor: 0.45,
  skeleton: 0.4,
  motion: 0.35,
  trace: 0.4,
  intensity: 0.5,
};

/**
 * **参考座標（プリセット）。**
 * ボタンで表現を切り替えるのではなく、**スライダー値を一括代入するだけ**の入口。
 * 代入したあとはどの軸も自由に動かせる。
 */
export const AXIS_PRESETS: Readonly<Record<string, Partial<UnifiedAxes>>> = {
  /** Spatial Study 風: 空間に散る・連続・にじむ。 */
  spatial: {
    spreadX: 0.85,
    spreadY: 0.85,
    anchorPull: 0.1,
    strobe: 0,
    tickRate: 0.45,
    attack: 0.35,
    decay: 0.55,
    blur: 0.92,
    depthSpread: 0.9,
    tilt: 0.75,
    hueCoherence: 0.2,
    hueStickiness: 0.2,
    dispersion: 0.4,
    channelBalance: 0.42,
    membraneBeam: 0.55,
    fragments: 0.45,
    hazeFloor: 0.35,
    skeleton: 0,
    motion: 0.5,
    trace: 0.35,
    intensity: 0.5,
  },
  /** Reactive Lab 風: 膜が優勢・長い尾・にじむ。 */
  reactive: {
    spreadX: 0.8,
    spreadY: 0.8,
    anchorPull: 0.15,
    strobe: 0,
    tickRate: 0.45,
    attack: 0.25,
    decay: 0.9,
    blur: 0.8,
    depthSpread: 0.5,
    tilt: 0.35,
    hueCoherence: 0.45,
    hueStickiness: 0.3,
    dispersion: 0.5,
    channelBalance: 0.62,
    membraneBeam: 0.15,
    fragments: 0.5,
    hazeFloor: 0.5,
    skeleton: 0,
    motion: 0.3,
    trace: 0.5,
    intensity: 0.34,
  },
  /** Element Lab 2 風: 中心に固定・フルコマ送り・シャープ・1 色相。 */
  optics: {
    spreadX: 0.08,
    spreadY: 0.08,
    anchorPull: 0.85,
    strobe: 1,
    tickRate: 0.5,
    attack: 0,
    decay: 0.15,
    blur: 0.2,
    depthSpread: 0.2,
    tilt: 0.05,
    hueCoherence: 1,
    hueStickiness: 1,
    dispersion: 0.3,
    channelBalance: 0.5,
    membraneBeam: 0.5,
    fragments: 0.55,
    hazeFloor: 0.4,
    skeleton: 1,
    motion: 0.05,
    trace: 0.2,
    intensity: 0.56,
  },
};

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/** 保存や UI から来た値を安全な軸へ整える。 */
export const normalizeAxes = (raw: Partial<UnifiedAxes> | null | undefined): UnifiedAxes => {
  const out = { ...DEFAULT_AXES };
  if (!raw) return out;
  for (const decl of AXIS_DECLS) {
    const value = raw[decl.id];
    if (typeof value === 'number' && Number.isFinite(value)) out[decl.id] = clamp01(value);
  }
  return out;
};

/** ティック速度の実寸（fps）。軸 0〜1 を 12〜48 へ写す。 */
export const tickRateOf = (axes: UnifiedAxes): number => 12 + clamp01(axes.tickRate) * 36;
