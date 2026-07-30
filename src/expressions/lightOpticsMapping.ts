/**
 * **固定された光学系 → 見え方（Light Element Lab 2）。**
 *
 * リファレンスの連番フレーム分析から確定した設計思想を、そのままコードの形にした層。
 * 「多数の光を個別に動かす」のではなく、**固定された光学系に、音がエネルギーと波長を
 * 注ぎ込む**。動くのはエネルギー（`OpticsDrive`）だけで、光学系の骨格は動かない。
 *
 * 4 層の時間構造（リファレンスの結論）:
 *   1 骨格   … 縦の細い線 + 横の帯 + 中央コアの十字。位置は全フレームで固定。
 *              回転・移動・うねりは一切ない
 *   2 コア   … エネルギーの脈動。**白へ到達してよいのはこの層だけ**
 *   3 断片   … 周縁の三角ヴェール片。不規則さはこの層だけが担う（決定論ハッシュ）
 *   4 扇     … コアからの放射状光条。高エネルギー時だけ出る（閾値ゲート）
 *
 * **音 → 見え方の対応はこのファイルだけが持つ**（`spatialMapping.ts` と同じ方式）。
 * 描画クラスは `OpticalLayerTraits` を受け取って描くだけで、シェーダーの中には
 * 音の前提も時間アニメーションも入らない。
 *
 * 次フェーズの配線口は `OpticsDrive` の 6 つの入力である:
 *   音量（持続）    → skeletonLevel   … 無音なら骨格ごと消えて黒（PRD D5）
 *   onset 強度      → corePulse       … コアの脈動
 *   帯域イベント    → fragmentEnergy  … 断片の誕生
 *   強 onset 閾値   → fanGate         … 放射の扇
 *   音色の持続値    → huePhase        … グローバル H のイベント的切替
 *   音由来のシード  → seed            … 断片の散らばり
 * 静止画スタディでは、この 6 つを開発つまみが直接与える。
 *
 * `Math.random()` は使わない。同じ `OpticsDrive` なら必ず同じ光になる。
 */

/** 描画側のフラグメント分岐と 1 対 1 で対応する形の種別。 */
export type OpticalKind = 'core' | 'beam' | 'veil' | 'fan' | 'haze' | 'curtain' | 'arm';

/** Version ボタンと 1 対 1。各層をそれぞれ単独で確かめるための単位。 */
export type OpticalGroup =
  | 'haze'
  | 'curtain'
  | 'skeleton'
  | 'core'
  | 'fragment'
  | 'fan'
  | 'all';

/** 種別 → シェーダーへ渡す番号。 */
export const KIND_INDEX: Readonly<Record<OpticalKind, number>> = {
  core: 0,
  beam: 1,
  veil: 2,
  fan: 3,
  haze: 4,
  curtain: 5,
  arm: 6,
};

/**
 * **アームの方向。** ビットで持ち、打撃ごとに部分集合が選ばれる。
 * 毎回上下左右すべてに出すと、どの打撃も同じ十字になってしまう。
 */
export const ARM_UP = 1;
export const ARM_RIGHT = 2;
export const ARM_DOWN = 4;
export const ARM_LEFT = 8;
export const ARM_ALL = ARM_UP | ARM_RIGHT | ARM_DOWN | ARM_LEFT;

/**
 * 方向の組み合わせの重み表。**1〜2 方向が出やすく、全方向はたまに**。
 * 重みぶん並べた平坦な表にしてあるので、層化して引けば偏らない。
 */
export const ARM_SETS: readonly number[] = [
  // 1 方向（各 3）
  ARM_UP, ARM_UP, ARM_UP,
  ARM_RIGHT, ARM_RIGHT, ARM_RIGHT,
  ARM_DOWN, ARM_DOWN, ARM_DOWN,
  ARM_LEFT, ARM_LEFT, ARM_LEFT,
  // 2 方向（各 2）
  ARM_UP | ARM_RIGHT, ARM_UP | ARM_RIGHT,
  ARM_RIGHT | ARM_DOWN, ARM_RIGHT | ARM_DOWN,
  ARM_DOWN | ARM_LEFT, ARM_DOWN | ARM_LEFT,
  ARM_LEFT | ARM_UP, ARM_LEFT | ARM_UP,
  ARM_UP | ARM_DOWN, ARM_UP | ARM_DOWN,
  ARM_LEFT | ARM_RIGHT, ARM_LEFT | ARM_RIGHT,
  // 3 方向（各 1）
  ARM_UP | ARM_RIGHT | ARM_DOWN,
  ARM_RIGHT | ARM_DOWN | ARM_LEFT,
  ARM_DOWN | ARM_LEFT | ARM_UP,
  ARM_LEFT | ARM_UP | ARM_RIGHT,
  // 全方向（1）
  ARM_ALL,
];

/**
 * **カーテンの形状族。** seed が族と個体差の両方を選ぶ。
 * 同じ族でも襞の周期・幅・折れの量・傾きが個体ごとに変わるので、
 * 「同じ形の使い回し」にはならない。
 */
export const CURTAIN_FAMILIES = ['standing-veil', 'drifting-band', 'folded-ribbon'] as const;
export type CurtainFamily = (typeof CURTAIN_FAMILIES)[number];

/**
 * **断片の形状族。** これも seed が族と個体差を選ぶ。
 * 三角 1 種類だと「同じ形が飛び回っている」ようにしか見えないので、
 * 輪郭の作り方そのものを 4 通り持つ。
 */
export const FRAGMENT_FAMILIES = ['shard', 'sliver', 'plate', 'chip'] as const;
export type FragmentFamily = (typeof FRAGMENT_FAMILIES)[number];

/**
 * **帯域イベントが生んだ断片 1 枚。**
 * 形も位置もこの `seed` と `slot` だけから決まるので、同じイベントなら同じ断片になる。
 */
export interface FragmentSpawn {
  /** イベント固有の音シード（整数）。形状族・位置・縦横比・欠け・傾きの元。 */
  readonly seed: number;
  /** そのイベントの中での通し番号。同時に生まれた枚数を散らす。 */
  readonly slot: number;
  /** 打撃の強さ（0..1）。誕生時に確定し、以後は変わらない。 */
  readonly strength: number;
  /** 発火帯域。控えめな寄せにだけ使う。 */
  readonly band: string;
}

/**
 * **コアの形状族。** 打撃ごとに seed が選ぶので「毎回同じコア」にならない。
 * 素の芯（`coreShape < 0`）は静止画スタディ用に温存してある。
 */
export const CORE_SHAPES = [
  'cross-flare',
  'vertical-spike',
  'horizontal-flare',
  'compact-burst',
] as const;
export type CoreShape = (typeof CORE_SHAPES)[number];

/**
 * 形状族ごとの [族番号, 横フレアの利得, 縦スパイクの利得, 芯の強さ倍率]。
 * シェーダーの core 分岐がこの 4 値だけを見る。
 */
const CORE_SHAPE_PARAMS: readonly (readonly [number, number, number, number])[] = [
  [0, 0.5, 0.5, 1], // 十字フレア
  [1, 0.14, 0.92, 0.92], // 縦スパイク優勢
  [2, 0.92, 0.14, 0.92], // 横フレア優勢
  [3, 0.1, 0.1, 1.4], // コンパクトな星形バースト
];

/**
 * **形状族 → アームのスタイル**（長さ倍率・太さ倍率・ハローの利得）。
 *
 * 役割を分けてある: **形状族はアームの太さ・長さの「質」を決め、
 * どの方向へ出るかは独立に打撃のシードが決める。**
 * 芯まわりの小さなフレア（`CORE_SHAPE_PARAMS`）はアームの根元にあたり、
 * アームが出ている軸だけが光るように絞られる（重複しない）。
 */
const ARM_STYLE: readonly (readonly [number, number, number])[] = [
  [1, 1, 0.1], // 十字フレア: 標準
  [1.35, 0.6, 0.06], // 縦スパイク: 細く長い
  [0.9, 1.5, 0.14], // 横フレア: 太く短い
  [0.55, 0.9, 0.18], // コンパクト: 短く芯寄り
];

/**
 * **光は連続量として動かさない**（恒久方針）。
 * すべての光は「その瞬間の音に対応した状態」で瞬間的に現れ、瞬間的に消える。
 * フェード・補間・連続的なスケール変化は描かず、変化は表示 / 非表示の出し入れで表す。
 */
export const STROBE = {
  /** 既定のティック速度（fps 相当）。24 コマのコマ送り感を狙う。 */
  defaultRate: 24,
  /** 1 周期のティック数。2 なら 1 ティック点いて 1 ティック消える。 */
  period: 2,
  /** 1 周期のうち点いているティック数。 */
  onTicks: 1,
} as const;

/** 層のグループ識別子。ストロボの位相を層ごとに散らすための鍵。 */
const STROBE_KEY = {
  haze: 1000,
  curtain: 2000,
  skeleton: 3000,
  fragment: 4000,
  // 扇は 1 枚しかなく、出し入れは `OpticsAudioDrive` が寿命と一緒に決めるので鍵を持たない。
} as const;

/**
 * **速度の階層。** 膜がいちばんゆっくり呼吸し、断片がいちばん速い。
 * 静止画の段階では駆動しないので定数として置くだけで、
 * 次フェーズで音を平滑化するときの時定数（秒）になる。
 *
 * **膜は骨格と同じ入力**（`skeletonLevel` = 音量の持続）を、骨格よりさらに遅い
 * 時定数で受ける。膜のための音入力は作らない（onset・帯域イベントにも反応させない）。
 */
export const RESPONSE_SECONDS = {
  /** 膜 — 最遅。場そのものの明るさなので、曲の区間くらいの速さでしか動かない。 */
  haze: 2.6,
  /** カーテン — 膜より速く骨格より遅い。立ったまま長く残り、ゆっくり入れ替わる。 */
  curtain: 1.4,
  /** 骨格 — 音量の持続にゆっくり追従する。 */
  skeleton: 0.9,
  /** コア脈動 — onset で跳ねて引く。 */
  core: 0.12,
  /** 断片 — 帯域イベントで生まれて消える。最速。 */
  fragment: 0.05,
} as const;

/**
 * 音が注ぎ込むもの。**これ以外に見え方を変える入力はない。**
 * 値はすべて 0〜1（`seed` を除く）。
 */
export interface OpticsDrive {
  /**
   * 音量（持続）→ 骨格の基礎輝度。0 で骨格ごと消える（無音 = 黒）。
   *
   * **骨格・カーテン・膜は同じソース（音量の持続）を受ける。** 別のフィールドに
   * 分けてあるのは **時定数だけが違う**からで（`RESPONSE_SECONDS`）、
   * 音の入力を 3 つへ増やしたわけではない。
   */
  readonly skeletonLevel: number;
  /** 同じソースをカーテンの時定数で受けた値。 */
  readonly curtainLevel: number;
  /** 同じソースを膜の時定数で受けた値。**いちばん遅く、最後まで残って消える。** */
  readonly hazeLevel: number;
  /** onset 強度 → コアの脈動。1 で白熱の頂点。 */
  readonly corePulse: number;
  /** 帯域イベント → 断片の量と明るさ（Manual の静止画スタディ用）。 */
  readonly fragmentEnergy: number;
  /**
   * **帯域イベントが生んだ断片**（Audio）。空なら Manual の作り方へ落ちる。
   * ここに載っているのは**このティックで点いているものだけ**で、
   * 寿命と on/off の判定は `OpticsAudioDrive` が済ませてある（光は連続量として動かさない）。
   */
  readonly fragments: readonly FragmentSpawn[];
  /** 強 onset の閾値ゲート → 放射の扇。0 で出ない。1 で最大の広がりと強さ。 */
  readonly fanGate: number;
  /**
   * **扇 1 回ごとの個体差の元**（整数）。**−1 は素の扇**で、
   * 静止画スタディ（Manual）の見え方をそのまま保つ。
   * 0 以上では向き・角度幅・本数が打撃のシードで少しだけ振れる。
   */
  readonly fanSeed: number;
  /** 音色の持続値 → グローバル波長 H（0〜1 の位相）。**補間せずイベント的に切り替わる。** */
  readonly huePhase: number;
  /** 断片の散らばりを決めるシード（整数）。 */
  readonly seed: number;
  /**
   * **光学クロックのティック番号。** 光は連続量として動かさず、
   * このティック単位で表示 / 非表示を出し入れする（コマ送り・ストロボ）。
   * **−1 は連続表示**（Manual の静止画スタディ。計測器として温存する）。
   */
  readonly tick: number;
  /**
   * コアの形状族。**−1 は素の芯**（静止画スタディの既定）で、
   * 0 以上は `CORE_SHAPES` の番号。打撃ごとに seed が選ぶ。
   */
  readonly coreShape: number;
  /**
   * **打撃に同期したアームの方向**（`ARM_UP` などのビット和）。
   * 0 でアームを出さない（Manual の静止画スタディの既定）。
   */
  readonly armMask: number;
  /** アームの明るさ（0..1）。コアと同じ閾値・曲線の世界から来る。 */
  readonly armStrength: number;
  /** アーム 1 本ごとの個体差の元（整数）。毎回同じ十字にしないため。 */
  readonly armSeed: number;
  /**
   * 開発用の奥行き計測つまみ。0 で作者指定の z をそのまま使う。
   * 0 より大きいと、**見かけの位置と大きさを保ったまま**全層をその正規化深度へ移す。
   * 奥行きの式だけを単独で測るための道具で、音は触らない。
   */
  readonly depthProbe: number;
}

/** 画角。板の長さを画面から決めるために使う（骨格は必ず画面を貫く）。 */
export interface OpticsViewport {
  readonly aspectRatio: number;
}

/** 1 層ぶんの見え方。**描画クラスはこれを描くだけ**で、音も時間も見ない。 */
export interface OpticalLayerTraits {
  readonly kind: OpticalKind;
  readonly position: readonly [number, number, number];
  readonly half: readonly [number, number];
  /** 面内回転（ラジアン）。面はカメラ正面に固定する。 */
  readonly spin: number;
  /** 素材の役割（アトラスを読む種別だけが使う）。 */
  readonly preferredRoles: readonly string[];
  readonly fallbackTile: number;
  readonly crop: readonly [number, number, number, number];
  readonly uvAngle: number;
  readonly flipX: number;
  readonly flipY: number;
  /**
   * **グローバル波長 H への小さなオフセット。** 層は独立した色を持たない。
   * H が動くと全層が一斉にスペクトル上をスライドする。
   */
  readonly hueDelta: number;
  /** 1 層の中を走る色の幅（勾配）。これも小さく保つ。 */
  readonly hueSpan: number;
  /** 勾配の形式（0 横 / 1 放射 / 2 縦 / 3 角度）。 */
  readonly gradientForm: number;
  readonly intensity: number;
  /**
   * 種別ごとの形の値。
   * beam: 幅・ハロー / veil: 縁・形状族・伸び・欠け / fan: 基準角・広がり・本数・到達 /
   * haze: 減衰・縁の始まり・縁の終わり・分光の深さ倍率 /
   * curtain: 形状族・襞の周期・帯の半幅・折れの量
   */
  readonly shape: readonly [number, number, number, number];
  /** 「軸沿い」モードでのチャンネル分離方向（単位ベクトル・ローカル平面）。 */
  readonly axis: readonly [number, number];
  /**
   * **白の予算。** true はこの層が白へ到達してよい（コアだけ）。
   * false の層は描画側で天井に当てられ、単独では白画素を 1 つも作れない。
   */
  readonly whiteAllowed: boolean;
  /**
   * **明るさの天井（この層の 1 画素が取りうる上限）。**
   * 明るさの階層そのもの: コア 1.0（白へ届く）> 骨格・断片・扇 0.30 > 膜 0.11。
   * 加算合成で大面積を足すと黒が浮くので、膜はここを特に厳しくしてある。
   */
  readonly ceiling: number;
  /**
   * **チャンネル分離の下限と倍率。** 白の予算を持たない層は下限を持ち、
   * つまみを 0 にしても 3 チャンネルが重なりきらない。
   * [オフセット倍率, 非相関倍率, オフセット下限, 非相関下限]
   */
  readonly channel: readonly [number, number, number, number];
}

/** この光学系の定数。質感の数値はすべてここに集める。 */
export const OPTICS = {
  fieldOfView: 45,
  /** 奥行きの手がかりを張る範囲（カメラからの距離）。 */
  depthNear: 4.6,
  depthFar: 14,
  /** 一番奥での明るさの落ち（1 本の式の終端）。 */
  depthDimFar: 0.3,
  /** 一番奥での鈍り（同じ式の終端）。 */
  depthSoftFar: 1,
  /**
   * **白の予算の天井。** コア以外の層はここで頭を押さえる。
   * 骨格は縦線・横帯・広い帯の 3 枚が中央で交差するので、
   * 3 枚ぶん足しても 250/255 に届かない値にしてある（0.30 × 3 = 0.90）。
   */
  nonCoreCeiling: 0.3,
  /**
   * **膜の天井。** 明るさの階層の最下段で、コア（1.0）の 1/9。
   * 膜は画面規模の大面積なので、ここを緩めると加算合成で黒が浮いて乳白色に濁る。
   * **迷ったら暗いほうへ倒すこと。**
   */
  hazeCeiling: 0.11,
  /**
   * **カーテンの天井。** 明るさの階層で膜（0.11）と断片（0.30）の間。
   * 膜よりはっきりした形を持つが、あくまで薄い層である。
   */
  curtainCeiling: 0.2,
  /**
   * **アームの天井。** コア（1.0）と他の層（0.30）の間。
   * コアの閃光の一部なので明るくてよいが、白（250/255）へは届かせない。
   */
  armCeiling: 0.62,
  /** 断片の枚数。 */
  fragmentCount: 6,
  /** カーテンの枚数。 */
  curtainCount: 3,
  /** アトラスを平均で読む半径（鈍りが 1 のとき。クロップ座標）。 */
  softSampleRadius: 0.045,
  /**
   * **波長の深さ。** 1 で純粋な分光、0 で白。
   * リファレンスの光は「染まった白」であって絵の具ではないので、白へ寄せておく。
   * ここを浅くすることでチャンネル分離の縁の色が見えるようになる。
   */
  tintDepth: 0.72,
} as const;

const TAU = Math.PI * 2;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const clamp01 = (value: number): number => clamp(value, 0, 1);

/**
 * **持続の場（膜・カーテン・骨格）の上限。**
 *
 * 静止画スタディ（Manual）はつまみが 0〜1 なので、この上限には決して触れない
 * ＝ Manual の見え方は 1 画素も変わらない。
 *
 * 1 を超えられるようにしてあるのは **Audio のため**である。ストロボは毎ティック
 * 各グループの層を半分だけ見せるので、同じ level でも 1 フレームに写る面積は
 * 静止画の半分になる。**天井（`OPTICS.hazeCeiling` など）はそのまま**なので、
 * ここを上げても白が増えるのではなく、天井に届く**面積**が広がるだけである。
 */
const fieldLevel = (value: number): number => clamp(value, 0, 3);

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * 決定論ハッシュ。`Math.random()` は使わない。
 * 同じ (seed, index) なら必ず同じ値を返す。
 */
export const hash01 = (seed: number, index: number): number => {
  let h = (Math.imul(seed | 0, 0x27d4eb2d) ^ Math.imul(index | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
};

/**
 * **その層がこのティックで表示されるか。**
 *
 * 光は連続量として動かさないので、変化はここの出し入れだけで起きる。
 * 位相は層ごとに違う。全要素が同時に消えて画面全体が明滅するのを避けるため、
 * **同じグループの中では位相を層化**（`index` で 1 ずつずらす）してあり、
 * 2 枚以上ある層は必ずどれか 1 枚が点いている。オフセットは seed 由来で決定論。
 *
 * `tick < 0` は連続表示（Manual の静止画スタディ。計測器として温存する）。
 */
export const strobeVisible = (
  tick: number,
  seed: number,
  groupKey: number,
  index: number,
): boolean => {
  if (tick < 0) return true;
  const offset = Math.floor(hash01(seed + groupKey, 7717) * STROBE.period);
  const phase = (((tick + index + offset) % STROBE.period) + STROBE.period) % STROBE.period;
  return phase < STROBE.onTicks;
};

/**
 * **奥行きの手がかり（1 本の式）。**
 * 静止画では視差が使えないので、z だけから「遠いほど暗く・遠いほど鈍く」を出す。
 * 層ごとの個別調整はしない — どの層もこの同じ式を通る。
 */
export const depthCue = (z: number): { readonly dim: number; readonly soft: number } => {
  const distance = Math.abs(z);
  const t = clamp01((distance - OPTICS.depthNear) / (OPTICS.depthFar - OPTICS.depthNear));
  return { dim: mix(1, OPTICS.depthDimFar, t), soft: t * OPTICS.depthSoftFar };
};

/** その奥行きで画面に収まる範囲（半分の幅と高さ）。 */
const visibleHalfExtent = (
  z: number,
  viewport: OpticsViewport,
): { readonly halfWidth: number; readonly halfHeight: number } => {
  const halfHeight = Math.tan((OPTICS.fieldOfView * Math.PI) / 360) * Math.abs(z);
  return { halfHeight, halfWidth: halfHeight * Math.max(viewport.aspectRatio, 1e-6) };
};

/** 既定値の穴埋め。宣言を短く保つためだけのもの。 */
const layer = (
  base: Partial<OpticalLayerTraits> & Pick<OpticalLayerTraits, 'kind' | 'position' | 'half'>,
): OpticalLayerTraits => ({
  spin: 0,
  preferredRoles: [],
  fallbackTile: 0,
  crop: [0.5, 0.5, 0.9, 0.9],
  uvAngle: 0,
  flipX: 1,
  flipY: 1,
  hueDelta: 0,
  hueSpan: 0.06,
  gradientForm: 0,
  intensity: 1,
  shape: [0, 0, 0, 0],
  axis: [1, 0],
  whiteAllowed: false,
  ceiling: OPTICS.nonCoreCeiling,
  channel: [1, 1, 0, 0],
  ...base,
});

/**
 * **ストロボの間引き。** 光は連続量として動かさないので、
 * 組み上がった層のうち「このティックで点いているもの」だけを残す。
 * `tick < 0`（Manual）では全部残るので、静止画スタディは連続表示のまま。
 */
const strobed = (
  layers: readonly OpticalLayerTraits[],
  drive: OpticsDrive,
  groupKey: number,
): OpticalLayerTraits[] =>
  layers.filter((_, index) =>
    strobeVisible(drive.tick, Math.round(drive.seed), groupKey, index),
  );

/**
 * **⓪ 膜。** 画面全体をまとめる大面積・低輝度の霞。**リグでいちばん遠く、いちばん暗い。**
 * 役割は 3 つ — ① 明るさの階層の床（黒と中輝度の間を埋める）② 光が散乱する媒質の存在感
 * ③ 最遠の奥行き層。要素が黒に浮いて孤立するのを防ぐためだけに置く。
 *
 * **音入力は増やさない。** 骨格と同じ `skeletonLevel` を受け、
 * 速度だけが違う（`RESPONSE_SECONDS.haze` が最遅）。onset にも帯域イベントにも反応しない。
 *
 * 加算合成で大面積を足すと黒が浮くので、天井（`OPTICS.hazeCeiling`）と
 * **画面の縁で黒へ落ちるフォールオフ**が保険になっている。どちらも外さないこと。
 */
const buildHaze = (drive: OpticsDrive, viewport: OpticsViewport): OpticalLayerTraits[] => {
  const level = fieldLevel(drive.hazeLevel);
  if (level <= 0) return [];
  // リグでもっとも遠い面（断片の最奥 −12.6 より奥）。奥行きの式でさらに 0.33 倍に落ちる。
  const z = -13.6;
  const extent = visibleHalfExtent(z, viewport);
  return strobed([
    // コア中心の大きな放射グロー。板は画面の 1.25 倍で、縁の窓は画面の内側で 0 になる。
    layer({
      kind: 'haze',
      position: [0, 0, z],
      half: [extent.halfWidth * 1.25, extent.halfHeight * 1.25],
      preferredRoles: ['wide-haze', 'curved-wavefront'],
      fallbackTile: 4,
      crop: [0.5, 0.5, 0.92, 0.92],
      hueDelta: 0.015,
      // 彩度は低め。膜が独立の色を持たないよう、勾配も分光の深さも小さく取る。
      hueSpan: 0.05,
      gradientForm: 1,
      intensity: 0.16 * level,
      // [減衰, 縁の始まり, 縁の終わり, 分光の深さ倍率]
      shape: [2.2, 0.34, 0.76, 0.55],
      axis: [1, 0],
      ceiling: OPTICS.hazeCeiling,
      channel: [1.2, 1.5, 0.04, 0.35],
    }),
    // 交差（コアの高さ）に横たわる水平の帯。板は画面の 1.4 倍幅。
    layer({
      kind: 'haze',
      position: [0, 0, z],
      half: [extent.halfWidth * 1.4, extent.halfHeight * 0.44],
      preferredRoles: ['wide-caustic', 'wide-haze'],
      fallbackTile: 6,
      crop: [0.5, 0.5, 0.95, 0.6],
      uvAngle: 0.4,
      hueDelta: -0.02,
      hueSpan: 0.06,
      gradientForm: 0,
      intensity: 0.12 * level,
      shape: [1.5, 0.28, 0.7, 0.5],
      axis: [0, 1],
      ceiling: OPTICS.hazeCeiling,
      channel: [1.2, 1.5, 0.04, 0.35],
    }),
  ], drive, STROBE_KEY.haze);
};

/**
 * **⓪-b カーテン。** 膜よりはっきりした形を持つが、あくまで薄い層。
 * 明るさの階層では膜（0.11）と断片（0.30）の間に入り、白へは到達しない。
 *
 * **形状族は 3 つ**（`CURTAIN_FAMILIES`）で、seed が族と個体差の両方を選ぶ:
 *   standing-veil  … 縦に立つ襞のあるヴェール
 *   drifting-band  … 斜めに流れる帯
 *   folded-ribbon  … 折れたリボン状
 * 素材はアトラスのカーテン系・リボン系（`parallel-curtains` / `filament-and-curtain` /
 * `curved-volume`）を族ごとに選び分ける。
 *
 * 音入力は増やさない（骨格と同じ `skeletonLevel`。速度は `RESPONSE_SECONDS.curtain`）。
 */
const buildCurtains = (
  drive: OpticsDrive,
  viewport: OpticsViewport,
): OpticalLayerTraits[] => {
  const level = fieldLevel(drive.curtainLevel);
  if (level <= 0) return [];
  const seed = Math.round(drive.seed);
  const out: OpticalLayerTraits[] = [];
  // 族は層化して引く（素のハッシュだと seed によっては 3 枚とも同じ族になる）。
  const familyOffset = Math.floor(
    hash01(seed + 2027, 11) * CURTAIN_FAMILIES.length,
  );
  for (let index = 0; index < OPTICS.curtainCount; index++) {
    // 断片とハッシュ列が相関しないよう、別の添字空間を使う。
    const a = hash01(seed + 977, index * 7 + 1);
    const b = hash01(seed + 977, index * 7 + 2);
    const c = hash01(seed + 977, index * 7 + 3);
    const d = hash01(seed + 977, index * 7 + 4);
    const e = hash01(seed + 977, index * 7 + 5);
    const f = hash01(seed + 977, index * 7 + 6);
    const family =
      (index + familyOffset + (a > 0.78 ? 1 : 0)) % CURTAIN_FAMILIES.length;
    // 中間〜遠め。断片（−5.2〜−12.6）と膜（−13.6）の間に立たせる。
    const z = -(8.2 + b * 3.6);
    const extent = visibleHalfExtent(z, viewport);

    // 族ごとに板の比率が変わる。伸びは板が持ち、輪郭だけを形状族が作る。
    const shapeOf = (): {
      half: [number, number];
      spin: number;
      roles: string[];
      tile: number;
      params: [number, number, number, number];
    } => {
      if (family === 0) {
        // 縦に立つ襞のあるヴェール。
        return {
          half: [extent.halfWidth * (0.22 + c * 0.16), extent.halfHeight * (0.7 + d * 0.28)],
          spin: (e - 0.5) * 0.22,
          roles: ['parallel-curtains', 'filament-and-curtain'],
          tile: 7,
          params: [0, 5.5 + f * 7, 0.34 + c * 0.22, 0],
        };
      }
      if (family === 1) {
        // 斜めに流れる帯。
        return {
          half: [extent.halfWidth * (0.9 + c * 0.5), extent.halfHeight * (0.32 + d * 0.22)],
          spin: (e - 0.5) * 1.5,
          roles: ['wide-caustic', 'curved-wavefront'],
          tile: 6,
          params: [1, 3 + f * 5, 0.3 + c * 0.24, (d - 0.5) * 0.5],
        };
      }
      // 折れたリボン状。
      return {
        half: [extent.halfWidth * (0.7 + c * 0.4), extent.halfHeight * (0.5 + d * 0.3)],
        spin: (e - 0.5) * 1.1,
        roles: ['folded-ribbon', 'curved-volume'],
        tile: 2,
        params: [2, 4 + f * 4, 0.24 + c * 0.18, 0.5 + d * 0.7],
      };
    };

    const s = shapeOf();
    out.push(
      layer({
        kind: 'curtain',
        position: [
          (a - 0.5) * 2 * extent.halfWidth * 0.72,
          (b - 0.5) * 2 * extent.halfHeight * 0.4,
          z,
        ],
        half: s.half,
        spin: s.spin,
        preferredRoles: s.roles,
        fallbackTile: s.tile,
        crop: [0.28 + a * 0.44, 0.28 + d * 0.44, 0.6, 0.6],
        uvAngle: f * TAU,
        flipX: c > 0.5 ? -1 : 1,
        flipY: d > 0.5 ? -1 : 1,
        // H への小さなオフセットだけ。カーテンが独立の色を持たないようにする。
        hueDelta: (c - 0.5) * 0.08,
        hueSpan: 0.11,
        gradientForm: 2,
        // 薄い層なので暗いほうへ倒す。黒の支配（画面の 7〜8 割）を壊さない範囲。
        intensity: (0.14 + d * 0.09) * level,
        shape: s.params,
        axis: [1, 0],
        ceiling: OPTICS.curtainCeiling,
        channel: [1.3, 1.5, 0.045, 0.28],
      }),
    );
  }
  return strobed(out, drive, STROBE_KEY.curtain);
};

/**
 * **① 骨格。** 縦の細い線 + 横の帯 + 中央の十字。位置は中央軸に固定で、
 * 音が変えるのは基礎輝度だけ（`skeletonLevel`）。回転も移動もしない。
 */
const buildSkeleton = (drive: OpticsDrive, viewport: OpticsViewport): OpticalLayerTraits[] => {
  const level = fieldLevel(drive.skeletonLevel);
  if (level <= 0) return [];
  const z = -6;
  const extent = visibleHalfExtent(z, viewport);
  // 板は必ず画面を貫く長さにする（画角が変わっても線が途中で切れない）。
  const reach = Math.max(extent.halfWidth, extent.halfHeight) * 1.3;
  return strobed([
    // 縦の極細線。板ごと 90° 倒し、ローカル x が画面の縦になる。
    layer({
      kind: 'beam',
      position: [0, 0, z],
      half: [reach, 0.34],
      spin: Math.PI / 2,
      shape: [0.012, 0.05, 0, 0],
      hueDelta: 0,
      hueSpan: 0.05,
      gradientForm: 2,
      intensity: 0.36 * level,
      axis: [0, 1],
      channel: [1, 1, 0.02, 0.12],
    }),
    // 横の帯（芯）。
    layer({
      kind: 'beam',
      position: [0, 0, z],
      half: [reach, 0.3],
      shape: [0.02, 0.06, 0, 0],
      hueDelta: 0.02,
      hueSpan: 0.07,
      intensity: 0.3 * level,
      axis: [0, 1],
      channel: [1, 1, 0.024, 0.12],
    }),
    // 横の帯（広い裾）。十字の周りの空気になる。黒を大半に保つため薄く。
    layer({
      kind: 'beam',
      position: [0, 0, z],
      half: [reach, 0.9],
      shape: [0.1, 0.006, 0, 0],
      hueDelta: 0.04,
      hueSpan: 0.09,
      intensity: 0.1 * level,
      axis: [0, 1],
      channel: [1, 1, 0.03, 0.2],
    }),
  ], drive, STROBE_KEY.skeleton);
};

/**
 * **② コア。** 中央の白熱。**白へ到達してよい唯一の層**。
 *
 * **強い打撃のときだけ大きく強く光る。** 弱い打撃で毎回明るく出ると
 * 「常に光っている」ように見えてしまうので、閾値は `OpticsAudioDrive` 側で切り、
 * ここへ来る `corePulse` は既に「閾値を越えたぶんを強い側へ寄せた」値である。
 *
 * 形状族は `drive.coreShape`（打撃ごとに seed が選ぶ）。
 * **−1 は素の芯**で、静止画スタディの既定の見え方をそのまま保つ。
 */
const buildCore = (drive: OpticsDrive): OpticalLayerTraits[] => {
  const pulse = clamp01(drive.corePulse);
  if (pulse <= 0) return [];
  const shapeIndex = Math.round(drive.coreShape);
  const shape =
    shapeIndex >= 0 && shapeIndex < CORE_SHAPE_PARAMS.length
      ? CORE_SHAPE_PARAMS[shapeIndex]!
      : ([-1, 0, 0, 1] as const);
  const mask = Math.round(drive.armMask);
  // 芯まわりのフレアはアームの根元。**アームが出ている軸だけ光らせる**ので、
  // 方向のランダム化と矛盾しない（mask が 0 の Manual では従来どおり）。
  const flareH =
    mask === 0 ? shape[1] : (mask & (ARM_LEFT | ARM_RIGHT)) !== 0 ? shape[1] : 0;
  const flareV =
    mask === 0 ? shape[2] : (mask & (ARM_UP | ARM_DOWN)) !== 0 ? shape[2] : 0;
  return [
    layer({
      kind: 'core',
      position: [0, 0, -5.6],
      // 大きさも打撃の強さで決まる。**表示のたびに確定し、その表示中は動かない。**
      // 強い側の強調は `OpticsAudioDrive` の曲線が済ませてあるので、ここは線形でよい。
      half: [mix(0.34, 0.5, pulse), mix(0.34, 0.5, pulse)],
      preferredRoles: ['layered-sheets', 'curved-volume'],
      fallbackTile: 3,
      crop: [0.5, 0.5, 0.86, 0.86],
      hueDelta: 0,
      hueSpan: 0.08,
      gradientForm: 1,
      // 頂点で中心の芯だけが確実に飽和するだけの利得（白はここで生まれる）。
      // 大きくしすぎると白が塊になるので、白は芯の項に持たせて広い項は抑える。
      intensity: mix(0.4, 1.55, pulse),
      // [形状族, 横フレアの利得, 縦スパイクの利得, 芯の強さ倍率]
      shape: [shape[0], flareH, flareV, shape[3]],
      whiteAllowed: true,
      ceiling: 1,
      channel: [1, 1, 0, 0],
    }),
    ...buildArms(drive, shapeIndex),
  ];
};

/** アームの向き（ローカル +x がこの向きになるよう板ごと回す）。 */
const ARM_DIRECTIONS: readonly { readonly bit: number; readonly spin: number }[] = [
  { bit: ARM_RIGHT, spin: 0 },
  { bit: ARM_UP, spin: Math.PI / 2 },
  { bit: ARM_LEFT, spin: Math.PI },
  { bit: ARM_DOWN, spin: -Math.PI / 2 },
];

/**
 * **打撃に同期したアームの閃光。**
 *
 * 骨格の常設の十字（音量で光る層）とは別物で、**打撃の瞬間だけ重なる一時的な光条**。
 * どの方向へ出るかは打撃のシードが選んだ `armMask` が決め、
 * 太さ・長さの質はコアの形状族が決める（役割が重複しない）。
 * 長さと強さには 1 本ごとの個体差を入れて、毎回同じ十字にならないようにする。
 */
const buildArms = (drive: OpticsDrive, shapeIndex: number): OpticalLayerTraits[] => {
  const mask = Math.round(drive.armMask);
  const power = clamp01(drive.armStrength);
  if (mask === 0 || power <= 0) return [];
  const style = ARM_STYLE[shapeIndex >= 0 && shapeIndex < ARM_STYLE.length ? shapeIndex : 0]!;
  const seed = Math.round(drive.armSeed);
  const out: OpticalLayerTraits[] = [];
  for (let index = 0; index < ARM_DIRECTIONS.length; index++) {
    const direction = ARM_DIRECTIONS[index]!;
    if ((mask & direction.bit) === 0) continue;
    const a = hash01(seed, index * 3 + 1);
    const b = hash01(seed, index * 3 + 2);
    // 強い打撃ほど長く、1 本ごとに少しばらつく。
    const length = 1.55 * style[0] * (0.78 + 0.44 * a) * (0.62 + 0.6 * power);
    const thickness = 0.06 * style[1] * (0.85 + 0.3 * b);
    out.push(
      layer({
        kind: 'arm',
        position: [0, 0, -5.62],
        half: [length, thickness],
        spin: direction.spin,
        hueDelta: 0.01,
        hueSpan: 0.07,
        gradientForm: 0,
        intensity: (0.5 + 0.85 * power) * (0.82 + 0.3 * a),
        // [芯の半幅, ハローの利得, 減衰の始まり, 減衰の終わり]
        shape: [0.22, style[2], 0.2 + 0.25 * b, 1],
        axis: [0, 1],
        ceiling: OPTICS.armCeiling,
        channel: [1, 1, 0.02, 0.1],
      }),
    );
  }
  return out;
};

/**
 * **③ 断片。** 周縁の一時的なヴェール片。**不規則さを担うのはこの層だけ**で、
 * 位置・大きさ・向き・**形状族**は決定論ハッシュから来る（同じ seed なら同じ配置）。
 *
 * **形状族は 4 つ**（`FRAGMENT_FAMILIES`）。三角 1 種類だと
 * 「同じ形がただ飛び回っている」ようにしか見えないので、輪郭の作り方から変える:
 *   shard  … 三角シャード / sliver … 細長いスリヴァー
 *   plate  … 不等辺の四辺形の板片 / chip … 角の欠けた小片
 * 伸び（縦横比）は板が持ち、輪郭だけを形状族が作る。
 */
/**
 * 断片 1 枚を組む。**Manual（seed + energy）と Audio（イベントごとの spawn）で
 * まったく同じ式を通す**ので、生まれ方が違っても見え方の文法は 1 つである。
 *
 * `bias` は発火帯域による**控えめな**寄せ（強い固定ルールにはしない）。
 */
const makeFragment = (
  seed: number,
  index: number,
  familyOffset: number,
  intensityScale: number,
  bias: { readonly size: number; readonly lift: number; readonly family: number },
  viewport: OpticsViewport,
): OpticalLayerTraits => {
  const a = hash01(seed, index * 7 + 1);
  const b = hash01(seed, index * 7 + 2);
  const c = hash01(seed, index * 7 + 3);
  const d = hash01(seed, index * 7 + 4);
  const e = hash01(seed, index * 7 + 5);
  const g = hash01(seed, index * 7 + 6);
  const h = hash01(seed, index * 7 + 7);
  // **族は層化して引く。** 素のハッシュだと seed によっては全部同じ族になり、
  // 「同じ形の使い回し」に逆戻りする。並び順を seed でずらしつつ、
  // ときどき 1 つ飛ばして規則性も消す。
  const family =
    (index + familyOffset + bias.family + (g > 0.72 ? 1 : 0) + FRAGMENT_FAMILIES.length) %
    FRAGMENT_FAMILIES.length;
  const z = -(5.2 + b * 7.4);
  const extent = visibleHalfExtent(z, viewport);
  // 周縁に散らす。中央軸は骨格のものなので、半径の下限を置いて避ける。
  const angle = a * TAU;
  const radius = 0.44 + c * 0.52;
  const size = (0.2 + d * 0.4) * (Math.abs(z) / 6) * bias.size;
  // 族ごとの縦横比。伸びは板が持つので、輪郭の式は正方の p 空間で書ける。
  const stretch =
    family === 1
      ? 2.1 + h * 1.5 // sliver は細長い
      : family === 2
        ? 1.1 + h * 0.7 // plate は少し横長
        : 0.85 + h * 0.5; // shard / chip はほぼ等方
  return layer({
    kind: 'veil',
    position: [
      Math.cos(angle) * extent.halfWidth * radius,
      Math.sin(angle) * extent.halfHeight * radius + extent.halfHeight * bias.lift,
      z,
    ],
    half: [size * stretch, size / Math.sqrt(stretch)],
    spin: e * TAU,
    preferredRoles: ['wide-caustic', 'wide-haze', 'layered-sheets'],
    fallbackTile: (index * 3 + seed) % 10,
    crop: [0.3 + a * 0.4, 0.3 + c * 0.4, 0.5, 0.5],
    uvAngle: d * TAU,
    flipX: e > 0.5 ? -1 : 1,
    // H への小さなオフセットだけ。断片が独立の色を持たないようにする。
    hueDelta: (a - 0.5) * 0.07,
    hueSpan: 0.1,
    gradientForm: 3,
    // 断片は「一時的で半透明」。輪郭が立つと貼り紙に見えるので薄く保つ。
    intensity: (0.14 + c * 0.13) * intensityScale,
    // [縁, 形状族, 形の中の伸び, 欠けの深さ]
    shape: [0.34, family, 0.75 + h * 0.6, 0.04 + d * 0.2],
    axis: [1, 0],
    // 白の予算を持たないので、下限で必ずチャンネルをずらす。
    channel: [1.4, 1.6, 0.05, 0.3],
  });
};

/** 発火帯域による控えめな寄せ。大きさ・高さ・族の並びを少しだけ動かす。 */
const BAND_BIAS: Readonly<
  Record<string, { readonly size: number; readonly lift: number; readonly family: number }>
> = {
  // 低い音は「やや大きめ・やや低い位置」。
  bass: { size: 1.26, lift: -0.16, family: 0 },
  mid: { size: 1, lift: 0, family: 1 },
  // 高い音は「小さめ・やや高い位置」で、細長い族へ寄りやすい。
  treble: { size: 0.78, lift: 0.12, family: 2 },
};

const NEUTRAL_BIAS = { size: 1, lift: 0, family: 0 } as const;

const buildFragments = (
  drive: OpticsDrive,
  viewport: OpticsViewport,
): OpticalLayerTraits[] => {
  // ---- Audio: 帯域イベントが生んだ断片。**すでに寿命とティックで間引かれている** ----
  if (drive.fragments.length > 0) {
    return drive.fragments.map((spawn) => {
      const bias = BAND_BIAS[spawn.band] ?? NEUTRAL_BIAS;
      const familyOffset = Math.floor(
        hash01(spawn.seed + 1013, 7) * FRAGMENT_FAMILIES.length,
      );
      // 打撃が強いほど少しだけ濃い。フェードはしないので、これは誕生時に確定する。
      return makeFragment(
        spawn.seed,
        spawn.slot,
        familyOffset,
        0.62 + 0.5 * clamp01(spawn.strength),
        bias,
        viewport,
      );
    });
  }

  // ---- Manual: つまみの energy と seed から作る静止画スタディ ----
  const energy = clamp01(drive.fragmentEnergy);
  if (energy <= 0) return [];
  const seed = Math.round(drive.seed);
  const out: OpticalLayerTraits[] = [];
  // 枚数もエネルギーで決まる（帯域イベントが増えるほど断片が増える）。
  const count = Math.max(Math.round(OPTICS.fragmentCount * energy), 1);
  const familyOffset = Math.floor(
    hash01(seed + 1013, 7) * FRAGMENT_FAMILIES.length,
  );
  for (let index = 0; index < count; index++) {
    out.push(makeFragment(seed, index, familyOffset, energy, NEUTRAL_BIAS, viewport));
  }
  return strobed(out, drive, STROBE_KEY.fragment);
};

/**
 * **④ 扇。** コアからの放射状光条。**強打の閾値**（`fanGate`）が開いたときだけ出る。
 * 中心は骨格と同じ中央軸で、**下向きが基本**。リファレンスの扇は下方向と斜めにだけ
 * 伸びるので、全周へは回さない。
 *
 * 打撃ごとの個体差は `fanSeed` が担う — 左右の偏り（±0.25 rad ≒ ±14°）と
 * 角度幅・本数が少し振れるだけで、**下向きという性格は動かさない**。
 * `fanSeed < 0`（Manual）は素の扇で、静止画スタディの見え方をそのまま保つ。
 *
 * 広がり・到達・強さは `fanGate`（＝打撃の強さ）に追従する。
 * **on / off の出し入れは `OpticsAudioDrive` が済ませてある**ので、
 * 断片と同じくここでは間引かない（光は連続量として動かさない）。
 */
const buildFan = (drive: OpticsDrive): OpticalLayerTraits[] => {
  const gate = clamp01(drive.fanGate);
  if (gate <= 0) return [];
  const seed = Math.round(drive.fanSeed);
  // 素の扇（Manual）は中立値 0.5 を使う ＝ 従来の固定値と完全に一致する。
  const a = seed >= 0 ? hash01(seed, 101) : 0.5;
  const b = seed >= 0 ? hash01(seed, 102) : 0.5;
  const c = seed >= 0 ? hash01(seed, 103) : 0.5;
  return [
    layer({
      kind: 'fan',
      position: [0, 0, -5.9],
      // 強打ほど板ごと大きい（＝広がりが増える）。
      half: [2.5 * mix(0.82, 1, gate), 2.5 * mix(0.82, 1, gate)],
      // 基準角は下向き。左右の偏りだけが打撃ごとに変わる。
      // [基準角, 広がり, 本数, 到達]
      shape: [
        -1.42 + (a - 0.5) * 0.5,
        0.82 + (b - 0.5) * 0.4,
        3.2 + (c - 0.5) * 1.2,
        mix(0.46, 0.66, gate),
      ],
      preferredRoles: ['caustic-fan', 'wide-caustic'],
      fallbackTile: 1,
      crop: [0.5, 0.5, 0.8, 0.8],
      hueDelta: 0.03,
      hueSpan: 0.13,
      gradientForm: 3,
      intensity: 0.44 * gate,
      axis: [1, 0],
      channel: [1.3, 1.4, 0.04, 0.22],
    }),
  ];
};

/**
 * 光学系を組み立てる。**音 → 見え方の判断はここだけ**にある。
 * `group` は開発用の切り出し（Version ボタン）で、`all` が本来の 1 枚である。
 */
export const buildOpticalRig = (
  group: OpticalGroup,
  drive: OpticsDrive,
  viewport: OpticsViewport,
): OpticalLayerTraits[] => {
  const layers: OpticalLayerTraits[] = [];
  // 奥のものから順に積む（加算合成なので順序は見え方を変えないが、意図を残す）。
  if (group === 'haze' || group === 'all') layers.push(...buildHaze(drive, viewport));
  if (group === 'curtain' || group === 'all') layers.push(...buildCurtains(drive, viewport));
  if (group === 'skeleton' || group === 'all') layers.push(...buildSkeleton(drive, viewport));
  if (group === 'fragment' || group === 'all') layers.push(...buildFragments(drive, viewport));
  if (group === 'fan' || group === 'all') layers.push(...buildFan(drive));
  if (group === 'core' || group === 'all') layers.push(...buildCore(drive));
  return drive.depthProbe > 0 ? layers.map((entry) => applyDepthProbe(entry, drive.depthProbe)) : layers;
};

/**
 * 奥行き計測つまみ。層を指定の正規化深度へ移しつつ、
 * **見かけの位置と大きさを保つ**ように大きさと位置を比例させる。
 * これで明るさと鈍りの変化だけを単独で測れる。
 */
const applyDepthProbe = (entry: OpticalLayerTraits, probe: number): OpticalLayerTraits => {
  const target = -mix(OPTICS.depthNear, OPTICS.depthFar, clamp01(probe));
  const scale = Math.abs(target) / Math.max(Math.abs(entry.position[2]), 1e-6);
  return {
    ...entry,
    position: [entry.position[0] * scale, entry.position[1] * scale, target],
    half: [entry.half[0] * scale, entry.half[1] * scale],
  };
};
