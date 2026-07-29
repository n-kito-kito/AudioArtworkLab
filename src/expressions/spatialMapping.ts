import type { AudioEventSnapshot, BandLightEvent, BandName } from '../engine/bandLightEvents';
import {
  SpatialPositionResolver,
  type SpatialPosition,
  type SpatialPositionConfig,
  type VisibleExtent,
} from './spatialPositions';

/**
 * 音 → 見え方の対応を決める唯一の場所。
 *
 * **描画側にはこの対応を一切書かない。** どの音の値をどの視覚要素へ結びつけるかは
 * これから何度も変わる見込みなので、変えるときに触るファイルを 1 つに保つ。
 * 表現（`LightSpatialStudy`）は `AudioEventSnapshot` を渡して
 * `LightVisualTraits` を受け取るだけで、中で何が起きているかを知らない。
 *
 * 入口は `AudioEventSnapshot`（発光の瞬間に凍らせた音の姿）だけ。
 * ここから位置・明るさ・大きさ・色・速度・寿命・軌跡を作る。
 *
 * **帯域比率に使えるのは素の `bandFlux` だけ。** 適応後の strength は帯域ごとに
 * 別の参照値で割った値なので、帯域どうしを比べると静かな帯域が不当に大きく出る。
 */

/** バーストの中での役割。メインは 1 つ、サブは複数。 */
export type LightRole = 'main' | 'sub';

/**
 * 光の形。**波形をそのまま光の形にはしない**（波を光で描くことになるため）。
 * うねりは「自然界にまっすぐは無い」ぶんの微妙な変形としてだけ使う。
 */
export type LightShapeKind = 'spark' | 'needle' | 'arc' | 'plane' | 'ray';

/** 形の指定。描画側はこれを見て板の張り方と減衰を変える。 */
export interface LightShape {
  readonly kind: LightShapeKind;
  /** 軸方向の伸び（1 で等方の点、大きいほど細長い光条）。 */
  readonly elongation: number;
  /** 軸の向き（ラジアン。画面平面での角度）。 */
  readonly angle: number;
  /** 軸のうねり（0 でまっすぐ、大きいほど曲がる）。**振幅は小さく保つ。** */
  readonly waviness: number;
  /**
   * **軸と直交する方向の太さ**（1 が基準）。長さとは独立した軸で、
   * `ray` では芯の画素幅への倍率になる。
   *
   * ここを持たないと「細い斜線が大量に飛ぶ斬撃」にしかならない。
   * 低い centroid・Bass 優勢・大音量では太い光条と幅のある膜になり、
   * 高い centroid では細い回折線に戻る。描画側は板を実際に横へ広げる
   * （長さを縮めるのではなく、幅が増える）。
   */
  readonly thickness: number;
  /**
   * `plane` のときだけ使う面の法線（ワールド空間）。
   * X/Y/Z 軸平面を基本に、seed で少し傾ける。他の形では null。
   */
  readonly normal: { readonly x: number; readonly y: number; readonly z: number } | null;
  /**
   * `plane` のときだけ使う図形の選択（0..1）。
   * **枚数そのものは描画側が持つ**ので、ここは割合だけを渡して結び付きを断ってある。
   */
  readonly pattern: number;
}

/**
 * **1 つの光の中の色の移り変わり。**
 *
 * 狙いは「発光体が一色で光る」ことではなく、**プリズムを通った光**が空間に現れた状態。
 * 1 要素の内部でスペクトル上を少し進む色相の並びを持ち、白 → 一色にはならない。
 *
 * 色相は**ラップさせずに連続値のまま**持つ（0.95 → 1.05 のような並びをそのまま補間し、
 * 描画側の `fract` で環に戻す）。0.95 → 0.05 に折り返すと補間が色相環を逆走する。
 */
export interface LightGradient {
  /**
   * 形式。`GRADIENT_FORM` の番号で、seed が選ぶ。
   * 0 放射状 / 1 放射状（反転）/ 2 軸方向 / 3 軸直交 / 4 角度方向。
   */
  readonly form: number;
  /** 等間隔 4 点へリサンプルした色相。元のストップ数は 2〜4。 */
  readonly hues: readonly [number, number, number, number];
  /** 同・彩度。0 で白。 */
  readonly saturations: readonly [number, number, number, number];
}

/** グラデーションの形式。描画側の分岐と 1 対 1 に対応する。 */
export const GRADIENT_FORM = {
  radial: 0,
  radialInverted: 1,
  axial: 2,
  transverse: 3,
  angular: 4,
} as const;

/** 1 つの光が生まれるときに決まる見え方。決まったら寿命の間は変えない。 */
export interface LightVisualTraits {
  readonly role: LightRole;
  readonly position: SpatialPosition;
  /** 明るさの倍率（0..1）。Core ごとの明るさはこれだけで決まる。 */
  readonly intensity: number;
  /** 大きさの倍率（1 が基準サイズ）。 */
  readonly size: number;
  /**
   * 代表色。明るさとは分けてあり、**比率だけ**を表す（最大成分が 1 に正規化される）。
   * 実際に描かれるのは `gradient` のほうで、これは検証・状態表示のための 1 点サンプル。
   */
  readonly color: { readonly r: number; readonly g: number; readonly b: number };
  /** 1 要素の内部で色相が動く並び。描画はこれを補間する。 */
  readonly gradient: LightGradient;
  /** 速度（ワールド単位 / 秒）。 */
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
  /** 寿命の 3 段階（秒）。 */
  readonly lifetime: {
    readonly attackSeconds: number;
    readonly holdSeconds: number;
    readonly decaySeconds: number;
  };
  /** 軌跡の長さ（0..1）。0 で軌跡なし。 */
  readonly trail: number;
  readonly shape: LightShape;
  /**
   * 大きさの時間変化（発生時 → 寿命の終わり）。
   * 平面のフラッシュは中心から外へ一気に開くので、ここが大きく動く。
   * 点や光条は 1 → 1 で、発生時のまま変わらない。
   */
  readonly expansion: { readonly from: number; readonly to: number };
}

/**
 * **Burst 全体を包む質感レイヤー（Macro layer）1 枚ぶんの見え方。**
 *
 * 中の小さな光 1 つ 1 つに画像を貼るのではなく、**1 バーストにつき 1〜3 枚だけ**、
 * 膜・霧・回折線を担う大きな板として置く。素材は 10 枚のアトラスから選ぶが、
 * クロップ・回転・反転・比率・歪み・色がすべて音由来の seed で変わるので、
 * 「10 枚の完成画像を切り替えている」ようには見えない。
 *
 * 時間設計は Transient（Core / Spark / Needle / Ray）と分ける。
 * 遅れて開き、Transient より長く残ってから黒へ戻る。
 */
export interface MacroLayerTraits {
  readonly position: SpatialPosition;
  /** アトラスの何番の素材か。 */
  readonly tile: number;
  /** 明るさの倍率（0..1）。 */
  readonly intensity: number;
  /**
   * 板の半幅・半高（**ワールド単位**）。奥行きで割らないので、
   * 同じ大きさの板でも手前は大きく・奥は小さく写る（遠近が成立する）。
   */
  readonly halfWidth: number;
  readonly halfHeight: number;
  /**
   * 面の法線（ワールド空間）。**カメラ正面固定にしない。**
   * ビルボードの集合は必ず平面に見えるので、seed で決まる向きに倒して
   * 実際の 3D 平面として置く。
   */
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
  /** 面内の回転（ラジアン）。素材の役割で寄り方が変わる。 */
  readonly spin: number;
  /** ごくゆっくりした奥行き方向のドリフト（ワールド単位 / 秒）。いまは常に 0。 */
  readonly drift: number;
  /**
   * **面内のゆっくりした漂い。** すべて「1 秒あたりの量」で、
   * 描画側は経過秒を掛けるだけ（時間の純関数なので毎フレームの音では揺れない）。
   *
   * **奥行き方向・カメラ方向へは動かない。** 面の中だけで滑る・ずれる・回る。
   * 量は「漂っている」と読める最小限で、「流れている」までは行かせない。
   */
  readonly motion: {
    /** 素材を面内で滑らせる速さ（クロップ座標 / 秒）。 */
    readonly scrollU: number;
    readonly scrollV: number;
    /** せん断（軸に沿って横へずれる量 / 秒）。膜がたわむ感じを作る。 */
    readonly shear: number;
    /** 面内の回転（ラジアン / 秒）。板ごと同じ面の中で回る。 */
    readonly spin: number;
  };
  /**
   * **中心の光かどうか。**
   *
   * `true` なら Burst の原点に置かれる要（Prismatic Anchor）。
   * 周囲の膜とまったく同じシェーダー・アトラス・分光・クロップ・マスクを通るので、
   * 「中心だけ別素材の丸い点光源」にはならない。小さく・短く光って先に消える。
   */
  readonly anchor: boolean;
  /**
   * UV のクロップ。素材のどこを・どれだけ切り出すか。
   * 中心 (u, v) と半径 (su, sv) で、全体は必ず 0..1 に収まる。
   */
  readonly crop: { readonly u: number; readonly v: number; readonly su: number; readonly sv: number };
  /** 面内の回転（ラジアン）と反転（±1）。 */
  readonly rotation: number;
  readonly flipX: number;
  readonly flipY: number;
  /** UV の歪み（量・周波数・位相）。**発光中は動かさず、seed で固定する。** */
  readonly warp: { readonly amount: number; readonly frequency: number; readonly phase: number };
  /** 音から作る色。既存の分光（`LightGradient`）をそのまま使う。 */
  readonly gradient: LightGradient;
  /** 素材そのものの色をどれだけ残すか（0 で完全に音の色へ置き換え）。 */
  readonly sourceTint: number;
  /** 多角形マスクの選択（0..1）と効き。板の四角い輪郭を隠し、形を不揃いにする。 */
  readonly maskPattern: number;
  readonly maskAmount: number;
  /** 寿命。Transient より長い。 */
  readonly lifetime: {
    readonly attackSeconds: number;
    readonly holdSeconds: number;
    readonly decaySeconds: number;
  };
}

/** Macro layer 1 枚ぶんの予定。Transient より遅れて開く。 */
export interface PlannedMacroLayer {
  readonly delaySeconds: number;
  readonly traits: MacroLayerTraits;
}

/**
 * バーストの中の光 1 つぶんの予定。
 * `delaySeconds` だけ遅れて生まれるので、1 つの打撃が連鎖して光る。
 */
export interface PlannedLight {
  readonly delaySeconds: number;
  readonly traits: LightVisualTraits;
}

/** 表現から渡す、その時点の運転設定。 */
export interface LightMappingSettings {
  readonly minimumIntensity: number;
  readonly maximumIntensity: number;
  readonly attackSeconds: number;
  readonly holdSeconds: number;
  readonly decaySeconds: number;
  /** 大きさの効き（0 で音に依らず一定、1 で最大まで効く）。 */
  readonly sizeAmount: number;
  /** 色の効き（0 で白一色、1 で帯域比率をそのまま出す）。 */
  readonly colorAmount: number;
  /** 動きの効き（0 で静止）。 */
  readonly motionAmount: number;
  /** 軌跡の長さ（0..1）。 */
  readonly trailAmount: number;
  /** サブの光の個数の倍率（0〜2）。ユーザーが増減を調整する。 */
  readonly burstDensity: number;
  /** 太さの効き（0 で音に依らず基準の細さ、1 で範囲いっぱいまで太る）。 */
  readonly thicknessAmount: number;
  /** 質感レイヤーが画面周辺まで広がる度合い（0 で中心、1 で最大まで）。 */
  readonly macroSpreadAmount: number;
  /** 奥行きの散らばり（0 で中間の段だけ、1 で手前・奥まで使う）。 */
  readonly depthAmount: number;
  /** 横へ走る針の出やすさ（0 で縦だけ、1 で横に強く寄る）。 */
  readonly horizontalRayAmount: number;
  /** 膜が面内で漂う量（0 で完全静止、1 で最大）。 */
  readonly membraneMotion: number;
  /**
   * 発光の瞬間の sustain（0..1）。Macro layer の余韻の長さに使う。
   *
   * **`AudioEventSnapshot` へは足さない。** 検出層（`bandLightEvents.ts`）は
   * 2D Core Study と共有していて、1 バイトも変えない約束になっているため。
   * この値は発光の瞬間に表現側が読んで渡すので、凍結のタイミングは snapshot と同じ。
   */
  readonly sustain: number;
  /**
   * 配置の流儀。
   * `center` は原点付近へ集めて**光の層を重ねる**（既定）。
   * `scatter` は音由来の決定論配置で空間へ散らす（従来）。
   */
  readonly placementMode: 'center' | 'scatter';
}

/**
 * 対応づけの定数。**ここを触れば見え方の意味が変わる。**
 * 描画側の定数（半径・カメラ）とは分けてある。
 */
export const LIGHT_MAPPING = {
  /** 大きさ: 音量 0 → 1 でこの範囲を動く（基準サイズに対する倍率）。 */
  sizeAtSilence: 0.72,
  sizeAtFullVolume: 1.55,
  /**
   * 色は**音の seed が決める個別の色相**で、帯域から直接は作らない。
   *
   * 「中心は必ず白」にはしない。白は**重なりで創発させる** —
   * バーストの光が近くで交わったところが加算合成で自然に白へ寄る、という因果。
   * 単体で白いのは、下の `colorWhiteAtExtreme` を超える極端に強い発光だけ。
   */
  /** 彩度の範囲（seed 由来）。低いほど白っぽい光が混ざる。 */
  colorSaturationMinimum: 0.35,
  colorSaturationMaximum: 0.95,
  /** centroid で彩度をどれだけ動かすか。明るい音ほど色が立つ。 */
  colorSaturationFromCentroid: 0.28,
  /**
   * 単体でも白へ寄り始める強さ。これを超えると彩度が落ちて白熱して見える。
   * リファレンスの「白熱した交差点」は基本的に重なりで作るので、高めに置く。
   */
  colorWhiteAtExtreme: 0.86,
  /**
   * バーストの中で色相をどれだけずらすか（分光の幅）。
   * **ここが狭いと白が生まれない。** 似た色を足しても明るくなるだけで、
   * 白は「違う色が交わったとき」にしか出ないため、色相環をそれなりに使う。
   */
  colorHueSpreadInBurst: 0.44,
  // ---- 1 要素の内部の分光（グラデーション）----
  /**
   * **1 つの発光の中で色相が連続的に変わる**ようにするための並び。
   * 単体では「白 → 一色」で終わらせず、プリズムの分光のように
   * スペクトル上を少し進んだ色が 1 要素の中に同居する。
   */
  /** 形式の種類数。0..この数−1 を seed が選ぶ（`GRADIENT_FORM` と対応）。 */
  gradientFormCount: 5,
  /**
   * 色相の走る幅（狭い側 = 隣接色、広い側 = やや離れた色）。1.0 で色相環一周。
   * 狭い側でも 0.1（36°）は動かす。これ以下だと単色にしか見えない。
   * 広い側は 0.5（180°）まで。ここを超えると 1 要素の中で補色が同居して濁る。
   */
  gradientSpanNarrow: 0.1,
  gradientSpanWide: 0.5,
  /** ストップの数（2〜4）。少ないほど単純な移り、多いほど虹寄りになる。 */
  gradientStopsMinimum: 2,
  gradientStopsMaximum: 4,
  /**
   * 走りの途中で色相が折り返す確率（ストップ 3 個以上のとき）。
   * 直線の走りばかりだと分光が均質に見えるので、山形も混ぜる。
   */
  gradientTurnProbability: 0.38,
  /**
   * 彩度の端の落ち具合。白い端（芯が白く抜けるプリズムらしさ）を作る側の倍率。
   * 0 で完全な白、1 で落とさない。
   */
  gradientWhiteEndScale: 0.14,
  /** 彩度が一定の並びを選ぶ確率。残りは白 → 色 と 色 → 白 に半々で割れる。 */
  gradientFlatSaturationProbability: 0.26,

  /** 速度: 帯域ごとの基準の速さ（ワールド単位 / 秒）。 */
  speedByBand: { bass: 0.55, mid: 1.15, treble: 2.1 },
  /** 速度: onsetStrength 0 → 1 でこの倍率を掛ける。 */
  speedAtWeakOnset: 0.45,
  speedAtStrongOnset: 1.35,
  /**
   * 向き: Bass は奥行き方向へ重く、Treble は画面と平行に鋭く散る。
   * 0 で完全に画面平行、1 で完全に奥行き方向。
   */
  depthBiasByBand: { bass: 0.78, mid: 0.42, treble: 0.12 },
  /** 向き: centroid が高いほど散らばりの角度が狭く（鋭く）なる。 */
  spreadAtLowCentroid: 1,
  spreadAtHighCentroid: 0.45,
  /** 軌跡: Trail 0 → 1 でこの秒数ぶんの履歴を残す。 */
  trailSecondsAtMinimum: 0,
  trailSecondsAtMaximum: 0.9,

  // ---- バースト（1 つの打撃 = メイン 1 + サブ N の連鎖）----
  /**
   * サブの個数。**周波数の高さでは増やさない**（低音中心の曲で発生が枯れるため）。
   *   N = (base + volume 寄与 + onset 寄与 + 新奇性 寄与) × burstDensity
   */
  subCountBase: 3,
  subCountPerVolume: 8,
  subCountPerOnset: 5,
  subCountPerNovelty: 6,
  /**
   * 1 バーストのサブの上限。
   * 原点へ集めて層を重ねる狙いなので、以前より厚くしてある。
   * 上限は 60fps とドローコール 1 を保てる範囲で実測して決めた。
   */
  subCountMaximum: 30,
  /** サブが遅れて生まれる幅（秒）。この間に連鎖しているように見える。 */
  subDelayMinimum: 0.005,
  subDelayMaximum: 0.15,
  /**
   * サブがメインからどれだけ離れるか（可視範囲の半分に対する割合）。
   * 近いほど交わって白が立ち、遠いほど破片として散る。両方が要るので幅を持たせる。
   */
  subSpreadMinimum: 0.02,
  subSpreadMaximum: 0.13,
  /** サブの奥行きのばらつき（ワールド単位）。 */
  subDepthSpread: 1.8,
  /** サブの大きさ（メインに対する倍率）。**メインが最大**になるよう 1 未満に収める。 */
  subSizeMinimum: 0.18,
  subSizeMaximum: 0.72,
  /** サブの明るさ（メインに対する倍率）。 */
  subIntensityMinimum: 0.3,
  subIntensityMaximum: 0.85,
  /** サブの寿命（メインに対する倍率）。**さらに短命で、ばらつく**。 */
  subLifetimeMinimum: 0.28,
  subLifetimeMaximum: 0.85,
  /** サブの速さ（メインに対する倍率）。 */
  subSpeedMinimum: 0.6,
  subSpeedMaximum: 2.2,

  // ---- 形（針状の光条 / 点のスパーク / 短い波打つ弧）----
  /**
   * 形の出やすさは**帯域比率**で決まる。
   * 低域優勢 → 太めで遅い弧、高域優勢 → 針とスパーク。
   * 各値は「その帯域が主役のときの重み」で、合計が 1 になるよう正規化する。
   */
  shapeWeightsWhenBassLeads: { spark: 0.2, needle: 0.25, arc: 0.55 },
  shapeWeightsWhenMidLeads: { spark: 0.34, needle: 0.36, arc: 0.3 },
  shapeWeightsWhenTrebleLeads: { spark: 0.42, needle: 0.46, arc: 0.12 },
  /** 光条の伸び。centroid が高いほど細く長くなる。 */
  needleElongationAtLowCentroid: 2.6,
  needleElongationAtHighCentroid: 7,
  /** 弧の伸び。光条より短くて太い。 */
  arcElongationAtLowCentroid: 2.2,
  arcElongationAtHighCentroid: 4.2,
  /**
   * うねりの量。**flatness（音の濁り）が乱れの量**を決める。
   * まっすぐな光条は不自然なので、澄んだ音でも 0 にはしない。
   */
  /**
   * うねりの量。**輪郭の主軸は直線として読めること**が優先。
   * ここが大きいと引っ掻き傷・爪痕に見えるので、以前（0.18 / 0.85）の 2 割以下に落とした。
   * 0 にはしない — 完全な人工直線にはせず、ごく小さな光学的揺らぎだけ残す。
   */
  wavinessAtPureTone: 0.03,
  wavinessAtNoise: 0.15,
  /** メインの光は等方の点のまま（伸ばさない）。 */
  mainElongation: 1,
  /**
   * 光条の向きの偏り。**横に伸びるもの・縦に伸びるものを主にする。**
   * 完全な自由方向だと放射状の花火に見えてしまい、リファレンスの
   * 「層が重なる」感じから離れる。0 で完全に水平／垂直、1 で自由。
   */
  // 水平・垂直から ±約 7 度。ここを広げると放射状の斬撃に見える。
  needleAxisDeviation: 0.04,

  // ---- 原点集中の配置（`placementMode: 'center'`）----
  /** 中心からのゆらぎ（ワールド単位）。同一点に重ねず、わずかにずらして層にする。 */
  centerJitter: 0.55,
  /** 中心配置で使う奥行きの幅（ワールド単位）。狭いほど層が密に重なる。 */
  centerDepthJitter: 2.6,
  /** 中心配置の基準の奥行き。 */
  centerDepth: 9,
  /** 中心から少し離して散らすサブの割合（0..1）。「周辺の細かい散り」。 */
  outerFraction: 0.26,
  /** 同・離す距離（可視範囲の半分に対する割合）。 */
  outerSpreadMinimum: 0.25,
  outerSpreadMaximum: 0.72,
  /** 同・大きさの倍率。周辺は小さく細かく。 */
  outerSizeScale: 0.42,

  // ---- 軸平面のフラッシュ ----
  /** 1 バーストで開く平面の枚数（下限・上限）。onset の強さで増える。 */
  planeCountMinimum: 1,
  // 質感レイヤーが膜を担うようになったので、硬い面は数も減らす。
  planeCountMaximum: 3,
  /** 平面の法線を軸からどれだけ傾けるか（0 で完全な軸平面、1 で自由）。 */
  planeAxisDeviation: 0.3,
  /** 平面の開き始めと開ききりの大きさ（Core の基準サイズに対する倍率）。 */
  planeScaleFrom: 0.5,
  planeScaleTo: 16,
  /** 平面の明るさ（メインに対する倍率）。**透けるように淡く。** */
  planeIntensityMinimum: 0.1,
  planeIntensityMaximum: 0.26,
  /** 平面の寿命（メインに対する倍率）。瞬間的に開いて消える。 */
  planeLifetimeMinimum: 0.5,
  planeLifetimeMaximum: 1.1,

  // ---- Burst を包む質感レイヤー（Macro layer）----
  /**
   * **素材の系統は帯域が決める**（README の対応表）。
   * ここに書くのは manifest の `role` で、ファイル名も枚数も知らない。
   * アトラスに無い役割は単に選ばれないので、素材が増減しても壊れない。
   */
  macroRolesByBand: {
    // 低域: 広い霧・並ぶ縦膜・広いプリズム扇。長い Decay。
    bass: ['wide-haze', 'parallel-curtains', 'wide-caustic', 'layered-sheets'],
    // 中域: 重なる膜と縦膜を主にする。曲がるボリュームは脇役へ回した
    //（曲率の強い素材に寄せると、膜ではなく引っ掻き傷に見えるため）。
    mid: ['layered-sheets', 'parallel-curtains', 'wide-haze', 'caustic-fan'],
    // 高域: 途切れた斜光と細い回折線。短い Decay。
    treble: ['segmented-rays', 'fine-filaments', 'filament-and-curtain'],
  } as Readonly<Record<BandName, readonly string[]>>,
  /**
   * 帯域に合わない素材が選ばれる余地。
   * 0 にすると帯域ごとに同じ数枚しか出なくなり、素材の切り替えに見えてしまう。
   */
  macroOffBandWeight: 0.12,
  /** 1 バーストの枚数（下限・上限）。**Burst 全体で 1〜4 枚まで。** */
  macroCountMinimum: 1,
  macroCountMaximum: 4,
  /** 遅れて開くまでの時間（秒）。Transient のあとに膜が追いつく。 */
  macroDelayMinimum: 0.02,
  macroDelayMaximum: 0.16,
  /**
   * 時間設計（ミリ秒）。**Transient とは別の時間軸。**
   * Bass と Sustain が高いほど長く、Treble 優勢では短くする。
   */
  macroAttackMsShort: 10,
  macroAttackMsLong: 80,
  macroHoldMsShort: 40,
  macroHoldMsLong: 250,
  macroDecayMsShort: 350,
  macroDecayMsLong: 1800,
  /**
   * 大きさ（**ワールド単位**の基準に対する倍率）。Volume が広さと密度を決める。
   * 可視範囲から逆算しない — それをやると奥ほど板も大きくなって遠近が相殺され、
   * 板の集合が平面に見えてしまう（2D 感の元凶）。
   */
  macroSizeAtSilence: 0.55,
  macroSizeAtFullVolume: 1.25,
  /** 縦横比のばらつき（seed）。1 で正方形、外れるほど引き伸ばされる。 */
  macroAspectMinimum: 0.68,
  macroAspectMaximum: 1.45,
  /** 明るさ（onsetStrength に対する倍率）。**膜なので Transient より淡い。** */
  macroIntensityMinimum: 0.42,
  macroIntensityMaximum: 0.85,
  /**
   * 中心からのずれ（可視範囲の半分に対する割合）。**固定値にしない。**
   * `Volume + Sustain + Novelty` で動かし、強い音・持続音では画面周辺まで
   * 膜が広がり、静かな音では中心へ戻る。
   */
  macroSpreadMinimum: 0.25,
  macroSpreadMaximum: 0.8,
  /**
   * **Hybrid 配置。** 中心に主役を残しつつ、この割合の層だけ周辺へ大きく飛ばす。
   * center / scatter の二択にはしない。
   */
  macroOuterFraction: 0.38,
  /** 周辺へ飛ばす層の追加倍率（上の spread に掛かる）。 */
  macroOuterSpreadScale: 1.35,
  /** UV クロップの大きさ（半径。0.5 で素材の半分を使う）。 */
  macroCropMinimum: 0.3,
  macroCropMaximum: 0.62,
  /**
   * UV の歪み。**flatness（音の濁り）が歪み方を決める。**
   * 発光中は動かさず、seed で固定する（毎フレーム入れるとちらつく）。
   */
  /**
   * UV の歪み。**flatness は輪郭を曲げるためではなく、濃淡と内部質感を
   * わずかに乱すためだけに使う。** 大きいと膜の縁がうねって斬撃に見える。
   */
  macroWarpAtPureTone: 0.005,
  macroWarpAtNoise: 0.028,
  macroWarpFrequencyMinimum: 1.4,
  macroWarpFrequencyMaximum: 5.2,
  /**
   * 素材そのものの色を残す割合。0 で完全に音の色へ置き換える。
   * 素材の分光色を固定色として使わないための調整幅で、Color amount が
   * 大きいほど音の色が勝つ。
   */
  macroSourceTintAtZeroColor: 0.85,
  macroSourceTintAtFullColor: 0.45,
  /**
   * Macro layer の彩度の下限（Color amount に比例）。
   *
   * Transient は極端に強い打撃で白熱する設計（`colorWhiteAtExtreme`）だが、
   * 膜まで一緒に白くなると「虹色の膜が層になる」画にならない。
   * **白は層が重なった場所で作る**ので、1 枚ずつには色を残す。
   */
  macroSaturationFloor: 0.42,
  /** 多角形マスクの効き（板の四角い輪郭を隠し、形を不揃いにする）。 */
  macroMaskAmountMinimum: 0.32,
  macroMaskAmountMaximum: 0.7,
  /** Macro layer の分光の広がり（Transient より広く取り、虹寄りにする）。 */
  macroHueSpread: 0.62,

  // ---- 中心の要（Prismatic Anchor）----
  /**
   * **中心も周囲と同じプリズム光にする。**
   * 丸いガウスの点光源を中心に置くと「中心の点 + 周囲の別素材」に見えてしまうので、
   * 原点にも Macro layer を 1 枚だけ置き、同じ描画経路を通す。
   */
  /** 周囲の層に対する大きさの倍率。**周囲より小さい。** */
  macroAnchorSizeScale: 0.42,
  /** 同・明るさの倍率。中心は強くてよいが、白い円にはしない。 */
  macroAnchorIntensityScale: 1.2,
  /** 立ち上がりと保持（ミリ秒）。周囲より短く、打撃の瞬間に間に合う。 */
  macroAnchorAttackMs: 6,
  macroAnchorHoldMs: 28,
  /** 減衰の倍率（周囲の層に対する）。先に消えて、周囲の膜が残る。 */
  macroAnchorDecayScale: 0.42,
  /** クロップの倍率。中心は寄って切り出し、構造が読める密度にする。 */
  macroAnchorCropScale: 0.72,
  /** 面の傾きの倍率。中心は正面寄りに立てて要として読ませる。 */
  macroAnchorTiltScale: 0.4,

  // ---- 面内のゆっくりした漂い（Membrane motion）----
  /**
   * **発光時に確定し、以後は経過秒の純関数として動く。**
   * リファレンスの膜は静止しておらず、面の中でゆっくり漂ってせん断している。
   * ただし動きが見えすぎると「流れる」になってしまうので、上限は控えめに置く。
   */
  /** 素材を滑らせる速さ（クロップ座標 / 秒）。 */
  motionScrollMinimum: 0.014,
  motionScrollMaximum: 0.12,
  /** せん断の速さ（/ 秒）。 */
  motionShearMinimum: 0,
  motionShearMaximum: 0.09,
  /** 面内回転の速さ（ラジアン / 秒）。1 秒で最大 6.3 度ほど。 */
  motionSpinMinimum: 0,
  motionSpinMaximum: 0.11,
  /**
   * Sustain が長い音ほどゆっくり大きく漂う。
   * 逆に Treble 優勢の短命な層はほとんど動かない（余韻が無いので漂う時間もない）。
   */
  motionFromSustain: 0.65,
  motionFromBassShare: 0.35,
  /** Treble 優勢のときに掛ける倍率。短命な層はほぼ静止させる。 */
  motionAtTrebleLead: 0.25,
  /** クロップ中心に空けておく余白。滑った先がマスの縁へ届かないようにする。 */
  motionCropMargin: 0.1,

  // ---- 配置の偏りを崩す（anti-clustering）----
  /**
   * 連続したバーストが近い位置へ落ちると、画面が 1〜2 秒だけ片側へ寄る。
   * cores（`spatialPositions`）にある最低距離の仕組みを質感レイヤーにも入れる。
   * **引き直しはハッシュ列の次の値**を使うので決定論は崩れない。
   */
  macroPlacementRetries: 5,
  /** 画面正規化での最低距離。これより近いと混み合っていると見なす。 */
  macroMinimumSeparation: 0.62,
  /** 混雑度がこの値以下なら合格として引き直しを止める。 */
  macroCrowdingTolerance: 0.55,
  /** 判定に使う直近の配置の数（およそ 4 バースト＝層の寿命ぶん）。 */
  macroRecentLimit: 14,

  /**
   * 中心に残す白い芯（Hotspot）の大きさの倍率。
   * 丸い Main Spark は主役から降ろし、**ごく小さな芯**としてだけ残す。
   */
  mainHotspotScale: 0.3,
  /**
   * **必ず 1 枚は広い膜系にする。** 細線素材（fine-filaments / segmented-rays）
   * だけで Macro 全体が構成されると、質感ではなく斬撃の束にしか見えない。
   */
  macroWideRoles: [
    'wide-haze',
    'wide-caustic',
    'parallel-curtains',
    'layered-sheets',
    'curved-volume',
  ] as readonly string[],
  /**
   * **奥行きの 3 段。** 手前 / 中間 / 奥へ散らす（ワールド単位のカメラ距離）。
   * 板のワールドサイズは深度に比例させないので、手前ほど大きく・奥ほど小さく写る。
   */
  macroDepthBands: [
    // 手前は少し大きく明るい。ワールドサイズはむしろ抑えてある —
    // 遠近だけで既に 2 倍以上に写るので、そのままだと画面から溢れる。
    { near: 3, far: 6, size: 0.85, intensity: 1.15 },
    { near: 7, far: 12, size: 1, intensity: 1 },
    // 奥は遠近で小さくなりすぎるので、ワールドサイズだけ少し戻す。
    { near: 13, far: 22, size: 1.2, intensity: 0.72 },
  ],
  /** 段の選ばれ方（手前・中間・奥の相対的な出やすさ）。中間をいちばん厚くする。 */
  macroDepthWeights: [0.28, 0.44, 0.28],
  /**
   * 面の傾き（0 でカメラ正面のビルボード、1 で自由な向き）。
   * **ビルボードのままだと板の集合が平面に見える**ので、seed で必ず倒す。
   */
  macroTiltMinimum: 0.25,
  macroTiltMaximum: 0.85,
  /** 役割ごとの面内回転の寄り方（0 で自由、1 でその向きに固定）。 */
  macroRotationBias: {
    // 縦膜は縦のまま立たせる。
    'parallel-curtains': { angle: 0, strength: 0.8 },
    'filament-and-curtain': { angle: 0, strength: 0.7 },
    'vertical-veil': { angle: 0, strength: 0.7 },
    // 途切れた斜光は水平・垂直を中心に。
    'segmented-rays': { angle: Math.PI / 2, strength: 0.62 },
    // 広い霧は自由。
    'wide-haze': { angle: 0, strength: 0 },
    'wide-caustic': { angle: 0, strength: 0.12 },
  } as Readonly<Record<string, { angle: number; strength: number }>>,
  /** 3D の傾きを強めに取る役割（曲がるボリューム）。 */
  macroStrongTiltRoles: ['layered-sheets', 'parallel-curtains', 'wide-haze'] as readonly string[],
  /** 板の基準の半サイズ（ワールド単位）。中間の段で画面をほぼ埋める大きさ。 */
  macroWorldHalfSize: 3.4,
  /**
   * **奥行き方向の移動は持たない。**
   * 手前へ寄ってくる動きは「カメラに迫る」印象になり、
   * 層が置かれた奥行きに留まっている感じを壊す。
   * 奥行きは発生位置と面の傾きだけで感じさせ、動きは発光・拡大・減衰・色で作る。
   */
  macroDrift: 0,

  // ---- 太さ（thickness）----
  /**
   * **太さは 3 つの音の量から作る。** 低い centroid が主役で、
   * Bass 比率と Volume が足す（README の「低音・低 centroid・大音量 = 太い光条」）。
   */
  thicknessFromLowCentroid: 0.55,
  thicknessFromBassShare: 0.3,
  thicknessFromVolume: 0.15,
  /** 形ごとの太さの範囲（基準サイズに対する倍率）。 */
  thicknessNeedleMinimum: 0.55,
  thicknessNeedleMaximum: 2.4,
  thicknessArcMinimum: 0.9,
  thicknessArcMaximum: 3,
  /** 針（ray）は芯の画素幅への倍率。基準 1.1px に対して 0.7〜3.2px になる。 */
  thicknessRayMinimum: 0.64,
  thicknessRayMaximum: 2.9,

  // ---- 画面を貫く針（ray）----
  /**
   * **中心から上下左右へ、一瞬で画面外まで伸びる極細の針。**
   * 有限長の光条（needle）とは別物で、画面端を越える長さを持つ。
   * 強い打撃のときだけ出したいので、onset に敷居を設ける。
   */
  rayOnsetThreshold: 0.45,
  /** 敷居を超えたときの本数（下限・上限）。onset の強さで増える。 */
  rayCountMinimum: 1,
  rayCountMaximum: 4,
  /**
   * **横に走る確率。** 縦の斬撃が並ぶより、画面外まで抜ける横の一閃のほうが
   * 空間の広さを作る。0.5 で縦横同数、1.0 で全部横。
   */
  rayHorizontalProbability: 0.68,
  /**
   * 垂直・水平からの傾き（ラジアン）。
   * 完全な十字だと図形的すぎるので、seed でわずかにだけ逸らす。
   */
  rayTiltRadians: 0.055,
  /** 明るさ（メインに対する倍率）。細いので強くても白く潰れない。 */
  rayIntensityMinimum: 0.75,
  rayIntensityMaximum: 1.2,
  /** 寿命（メインに対する倍率）。**消えは短い減衰**。 */
  rayLifetimeMinimum: 0.35,
  rayLifetimeMaximum: 0.7,
  /** 生まれる遅れの上限（秒）。打撃とほぼ同時に走らせる。 */
  rayDelayMaximum: 0.02,
} as const;

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

const mix = (a: number, b: number, t: number): number => a + (b - a) * clamp01(t);

/**
 * 決定論ハッシュ（`Math.random()` は使わない）。
 * 位置生成と同じ作りで、味付けだけ変えて別の流れを取る。
 */
const hash01 = (...values: number[]): number => {
  let hash = 0x811c9dc5;
  for (const value of values) {
    const quantized = Math.round(value * 4096) | 0;
    for (let shift = 0; shift < 32; shift += 8) {
      hash ^= (quantized >>> shift) & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash / 0x100000000;
};

const BAND_INDEX: Readonly<Record<BandName, number>> = { bass: 0, mid: 1, treble: 2 };

export class LightSpatialMapping {
  private readonly positions: SpatialPositionResolver;
  /**
   * Macro layer が選べる素材の一覧（役割と重みだけ）。
   * アトラスが読み込まれるまでは空で、そのあいだ Macro layer は 1 枚も出ない。
   * **描画側はどれを選ぶかを決めない** — 決めるのはこの層だけ。
   */
  private tiles: readonly { readonly role: string; readonly weight: number }[] = [];
  /**
   * 直近に置いた質感レイヤーの**画面正規化位置**。
   * 偏りの判定にだけ使い、見え方そのものは決めない。
   */
  private readonly recentMacro: { x: number; y: number }[] = [];

  constructor(positionConfig: SpatialPositionConfig, recentLimit: number) {
    this.positions = new SpatialPositionResolver(positionConfig, recentLimit);
  }

  /** 素材が読み込めたら教えてもらう。順番が素材番号になる。 */
  setTextures(tiles: readonly { readonly role: string; readonly weight: number }[]): void {
    this.tiles = tiles;
  }

  reset(): void {
    this.positions.reset();
    this.recentMacro.length = 0;
  }

  /**
   * **Burst 全体を包む質感レイヤーを 1〜3 枚だけ組み立てる。**
   *
   * 中の小さな光とは別の時間軸で動き、遅れて開いて長く残る。
   * 素材の系統は勝った帯域が、大きさは音量が、歪みは flatness が、
   * 長さは低域寄りかどうかと sustain が決める（README の対応表）。
   */
  resolveMacroLayers(
    event: BandLightEvent,
    visible: VisibleExtent,
    settings: LightMappingSettings,
  ): PlannedMacroLayer[] {
    if (this.tiles.length === 0) return [];
    const snapshot = event.snapshot;
    const origin =
      settings.placementMode === 'center'
        ? this.centerOrigin(snapshot, visible)
        : this.positions.resolve(event, visible);

    const strength = clamp01(snapshot.onsetStrength);
    const volume = clamp01(snapshot.volume);
    const seed = [snapshot.audioSeed, snapshot.eventIndex, BAND_INDEX[snapshot.winningBand]];
    // 枚数は onset の強さと音量から。強い打撃ほど層が厚くなる。
    const count = Math.max(
      Math.round(
        mix(
          LIGHT_MAPPING.macroCountMinimum,
          LIGHT_MAPPING.macroCountMaximum,
          clamp01(strength * 0.65 + volume * 0.5),
        ),
      ),
      LIGHT_MAPPING.macroCountMinimum,
    );

    // 時間の長さ。低域寄り・sustain が高いほど長く、高域優勢では短い。
    const { bass, mid, treble } = snapshot.bandFlux;
    const total = Math.max(bass + mid + treble, 1e-6);
    const lengthT = clamp01(
      0.5 + 0.55 * (bass / total - treble / total) + 0.3 * (clamp01(settings.sustain) - 0.5),
    );

    // 画面周辺までの広がり。**固定値にしない** — 強い音・持続音・新奇な打撃ほど
    // 膜が外へ届き、静かな音では中心へ戻る。
    const reach = clamp01(
      volume * 0.45 + clamp01(settings.sustain) * 0.35 + clamp01(snapshot.novelty) * 0.2,
    );
    const spreadBase =
      mix(LIGHT_MAPPING.macroSpreadMinimum, LIGHT_MAPPING.macroSpreadMaximum, reach) *
      clamp01(settings.macroSpreadAmount);
    // 太さの素は膜の幅にも効く（低音・低い centroid では幅のある膜になる）。
    const width = this.thickness(snapshot, settings, 'arc');

    const layers: PlannedMacroLayer[] = [];
    // i = -1 は**中心の要（Prismatic Anchor）**。周囲の膜とまったく同じ経路を通し、
    // 位置・大きさ・寿命・傾きだけを変える。中心に別種の光を置かないための一手。
    for (let i = -1; i < count; i++) {
      const anchor = i === -1;
      const h = (salt: number): number => hash01(...seed, 500 + i, salt);
      // **最低 1 枚は広い膜系。** 細線素材だけで構成されると斬撃の束に見える。
      // 中心の要も同じ系統から選び、周囲と地続きに見せる。
      const tile = anchor || i === 0 ? this.pickWideTile(snapshot, h) : this.pickTile(snapshot, h);
      const role = this.tiles[tile]?.role ?? '';

      // 奥行きは 3 段（手前 / 中間 / 奥）。段ごとに大きさと明るさが違う。
      // 中心の要だけは Burst の原点の奥行きにそのまま置く。
      const band = this.pickDepthBand(h(41), clamp01(settings.depthAmount));
      const depth = anchor ? Math.max(-origin.z, 1) : mix(band.near, band.far, h(3));
      const extent = visible(depth);
      // 中心に主役を残しつつ、一部だけ周辺へ大きく飛ばす（Hybrid 配置）。
      const outer = !anchor && h(43) < LIGHT_MAPPING.macroOuterFraction;
      const spread = anchor ? 0 : spreadBase * (outer ? LIGHT_MAPPING.macroOuterSpreadScale : 1);
      // **偏りを崩す。** 直近の層と混み合う候補は、ハッシュ列の次の値で引き直す。
      const placement = anchor
        ? { x: 0, y: 0 }
        : this.placeMacro(h, spread, origin, extent);
      const size =
        mix(LIGHT_MAPPING.macroSizeAtSilence, LIGHT_MAPPING.macroSizeAtFullVolume, volume) *
        (anchor ? LIGHT_MAPPING.macroAnchorSizeScale : band.size);
      const aspect = mix(LIGHT_MAPPING.macroAspectMinimum, LIGHT_MAPPING.macroAspectMaximum, h(5));
      // 素材のどこを切り出すか。中心も大きさも毎回変わるので、
      // 同じ素材でも別の絵に見える。全体は必ず 0..1 に収まるよう寄せる。
      const halfCrop =
        mix(LIGHT_MAPPING.macroCropMinimum, LIGHT_MAPPING.macroCropMaximum, h(7)) *
        (anchor ? LIGHT_MAPPING.macroAnchorCropScale : 1);
      const margin = LIGHT_MAPPING.motionCropMargin;
      const cropCenter = (value: number): number =>
        halfCrop + margin + value * Math.max(1 - halfCrop * 2 - margin * 2, 0);
      const hueOffset = (h(9) * 2 - 1) * LIGHT_MAPPING.macroHueSpread;
      // 板のワールド半径。**可視範囲では割らない** — 割ると奥ほど板も大きくなって
      // 遠近が相殺され、板の集合が 1 枚の平面に見えてしまう。
      const half = LIGHT_MAPPING.macroWorldHalfSize * size;

      layers.push({
        // 中心の要は打撃と同時。周囲の膜だけが遅れて開く。
        delaySeconds: anchor
          ? 0
          : mix(LIGHT_MAPPING.macroDelayMinimum, LIGHT_MAPPING.macroDelayMaximum, h(11)),
        traits: {
          position: {
            x: origin.x + placement.x * extent.halfWidth,
            y: origin.y + placement.y * extent.halfHeight,
            z: -depth,
          },
          tile,
          intensity:
            mix(LIGHT_MAPPING.macroIntensityMinimum, LIGHT_MAPPING.macroIntensityMaximum, strength) *
            mix(0.7, 1, h(17)) *
            (anchor ? LIGHT_MAPPING.macroAnchorIntensityScale : band.intensity),
          halfWidth: half * aspect * mix(1, width, 0.35),
          halfHeight: (half / aspect) * mix(1, width, 0.35),
          // 面はカメラ正面に固定しない。seed の向きへ倒して実 3D 平面として置く。
          normal: this.macroNormal(
            role,
            h,
            clamp01(settings.depthAmount) * (anchor ? LIGHT_MAPPING.macroAnchorTiltScale : 1),
          ),
          spin: this.macroSpin(role, h),
          // 奥行き方向へは動かさない（発生した奥行きに留まる）。
          drift: LIGHT_MAPPING.macroDrift,
          motion: this.membraneMotion(snapshot, settings, h),
          anchor,
          crop: { u: cropCenter(h(19)), v: cropCenter(h(21)), su: halfCrop, sv: halfCrop },
          rotation: h(23) * Math.PI * 2,
          flipX: h(25) < 0.5 ? -1 : 1,
          flipY: h(27) < 0.5 ? -1 : 1,
          warp: {
            amount: mix(
              LIGHT_MAPPING.macroWarpAtPureTone,
              LIGHT_MAPPING.macroWarpAtNoise,
              clamp01(snapshot.spectralFlatness),
            ) * mix(0.6, 1.4, h(29)),
            frequency: mix(
              LIGHT_MAPPING.macroWarpFrequencyMinimum,
              LIGHT_MAPPING.macroWarpFrequencyMaximum,
              h(31),
            ),
            phase: h(33) * Math.PI * 2,
          },
          gradient: this.saturate(
            this.gradient(snapshot, settings, hueOffset, 500 + i),
            LIGHT_MAPPING.macroSaturationFloor * clamp01(settings.colorAmount),
          ),
          sourceTint: mix(
            LIGHT_MAPPING.macroSourceTintAtZeroColor,
            LIGHT_MAPPING.macroSourceTintAtFullColor,
            clamp01(settings.colorAmount),
          ),
          maskPattern: h(35),
          maskAmount: mix(
            LIGHT_MAPPING.macroMaskAmountMinimum,
            LIGHT_MAPPING.macroMaskAmountMaximum,
            h(37),
          ),
          lifetime: {
            // 中心の要は立ち上がりも保持も短い。打撃の瞬間に間に合い、先に消える。
            attackSeconds: anchor
              ? LIGHT_MAPPING.macroAnchorAttackMs / 1000
              : mix(LIGHT_MAPPING.macroAttackMsShort, LIGHT_MAPPING.macroAttackMsLong, lengthT) / 1000,
            holdSeconds: anchor
              ? LIGHT_MAPPING.macroAnchorHoldMs / 1000
              : mix(LIGHT_MAPPING.macroHoldMsShort, LIGHT_MAPPING.macroHoldMsLong, lengthT) / 1000,
            // 同じバーストでも層ごとに残り方を変え、まとめて消えないようにする。
            // 上限は README の 1800ms を超えないよう抑える。
            decaySeconds:
              Math.min(
                mix(LIGHT_MAPPING.macroDecayMsShort, LIGHT_MAPPING.macroDecayMsLong, lengthT) *
                  mix(0.7, 1.25, h(39)),
                LIGHT_MAPPING.macroDecayMsLong,
              ) *
              (anchor ? LIGHT_MAPPING.macroAnchorDecayScale : 1) /
              1000,
          },
        },
      });
    }
    return layers;
  }

  /**
   * **配置の偏りを崩す。**
   *
   * 連続したバーストが近い offset に落ちると、画面が 1〜2 秒だけ片側へ寄る。
   * 直近に置いた層と混み合う候補は、**ハッシュ列の次の値**で引き直す
   * （`Math.random()` は使わないので、同じ音・同じ seed なら同じ結果になる）。
   * 何度引いても混んでいるときは、その中で最も空いている候補を採る。
   *
   * 中心の要（Anchor）はこの対象外で、常に原点に置く。
   */
  private placeMacro(
    h: (salt: number) => number,
    spread: number,
    origin: SpatialPosition,
    extent: { readonly halfWidth: number; readonly halfHeight: number },
  ): { x: number; y: number } {
    // 判定は画面正規化で行う。原点そのもののずれも含めて混雑を見る。
    const baseX = origin.x / Math.max(extent.halfWidth, 1e-6);
    const baseY = origin.y / Math.max(extent.halfHeight, 1e-6);
    let best: { x: number; y: number; score: number } | null = null;
    for (let attempt = 0; attempt <= LIGHT_MAPPING.macroPlacementRetries; attempt++) {
      const x = (h(60 + attempt * 2) * 2 - 1) * spread;
      const y = (h(61 + attempt * 2) * 2 - 1) * spread;
      const score = this.crowding(baseX + x, baseY + y);
      if (best === null || score < best.score) best = { x, y, score };
      if (score <= LIGHT_MAPPING.macroCrowdingTolerance) break;
    }
    const chosen = best ?? { x: 0, y: 0 };
    this.recentMacro.push({ x: baseX + chosen.x, y: baseY + chosen.y });
    if (this.recentMacro.length > LIGHT_MAPPING.macroRecentLimit) this.recentMacro.shift();
    return { x: chosen.x, y: chosen.y };
  }

  /**
   * 候補の悪さ。**直近の層に近いほど悪い。**
   *
   * 重心を中央へ引き戻す項も試したが、片寄りの指標（重心が 0.35 を超えた
   * フレームの割合）は改善せず、象限の散らばりだけが悪化したので入れていない。
   * 隣どうしを離すだけで、片寄りは 21.2% → 11.6% まで下がる。
   */
  private crowding(x: number, y: number): number {
    const limit = LIGHT_MAPPING.macroMinimumSeparation;
    let score = 0;
    for (const point of this.recentMacro) {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < limit) score += 1 - distance / limit;
    }
    return score;
  }

  /**
   * **面内のゆっくりした漂い。**
   *
   * 発光の瞬間の音（Snapshot）と seed で速さと向きを確定し、以後は経過秒を
   * 掛けるだけの純関数として動かす。毎フレームの生の音響値は入れないので、
   * 音が揺れても軌道は変わらない。
   *
   * Sustain が長い音ほどゆっくり大きく漂い、Treble 優勢の短命な層はほぼ静止する。
   */
  private membraneMotion(
    snapshot: AudioEventSnapshot,
    settings: LightMappingSettings,
    h: (salt: number) => number,
  ): { scrollU: number; scrollV: number; shear: number; spin: number } {
    const amount = clamp01(settings.membraneMotion);
    if (amount <= 0) return { scrollU: 0, scrollV: 0, shear: 0, spin: 0 };

    const { bass, mid, treble } = snapshot.bandFlux;
    const total = Math.max(bass + mid + treble, 1e-6);
    const trebleLead = clamp01((treble / total - 0.45) / 0.55);
    // 余韻の長さが漂いの大きさを決める。低域寄りも少し足す。
    const drive =
      clamp01(
        LIGHT_MAPPING.motionFromSustain * clamp01(settings.sustain) +
          LIGHT_MAPPING.motionFromBassShare * (bass / total),
      ) * mix(1, LIGHT_MAPPING.motionAtTrebleLead, trebleLead);
    const scale = drive * amount;

    // 向きは seed 由来。面内のどちらへでも滑る（奥行きへは動かない）。
    const heading = h(71) * Math.PI * 2;
    const speed = mix(LIGHT_MAPPING.motionScrollMinimum, LIGHT_MAPPING.motionScrollMaximum, h(73)) * scale;
    return {
      scrollU: Math.cos(heading) * speed,
      scrollV: Math.sin(heading) * speed,
      shear:
        mix(LIGHT_MAPPING.motionShearMinimum, LIGHT_MAPPING.motionShearMaximum, h(75)) *
        scale *
        (h(77) < 0.5 ? -1 : 1),
      spin:
        mix(LIGHT_MAPPING.motionSpinMinimum, LIGHT_MAPPING.motionSpinMaximum, h(79)) *
        scale *
        (h(81) < 0.5 ? -1 : 1),
    };
  }

  /**
   * **必ず 1 枚は広い膜系から選ぶ。**
   * 細線素材（fine-filaments / segmented-rays）だけで Macro が構成されると、
   * 質感ではなく「細い斬撃の束」にしか見えない。強いイベントでも最低 1 枚は
   * Haze / Sheet 系を確保する。該当が無ければ通常の選び方へ落ちる。
   */
  private pickWideTile(snapshot: AudioEventSnapshot, h: (salt: number) => number): number {
    const wide = LIGHT_MAPPING.macroWideRoles;
    let total = 0;
    const weights = this.tiles.map((tile) => {
      const weight = wide.includes(tile.role) ? tile.weight : 0;
      total += weight;
      return weight;
    });
    if (total <= 0) return this.pickTile(snapshot, h);
    let pick = h(47) * total;
    for (let i = 0; i < weights.length; i++) {
      pick -= weights[i]!;
      if (pick <= 0) return i;
    }
    return weights.length - 1;
  }

  /**
   * 奥行きの段（手前 / 中間 / 奥）。
   * `amount` が 0 なら中間だけ、1 で手前と奥まで使う。
   */
  private pickDepthBand(
    value: number,
    amount: number,
  ): { near: number; far: number; size: number; intensity: number } {
    const bands = LIGHT_MAPPING.macroDepthBands;
    const middle = bands[1]!;
    const weights = LIGHT_MAPPING.macroDepthWeights.map((weight, index) =>
      index === 1 ? weight + (1 - amount) * (1 - weight) : weight * amount,
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let pick = value * total;
    for (let i = 0; i < weights.length; i++) {
      pick -= weights[i]!;
      if (pick <= 0) return bands[i] ?? middle;
    }
    return middle;
  }

  /**
   * 面の法線。**カメラ正面（0,0,1）に固定しない。**
   * ビルボードの集合はどれだけ数を増やしても平面にしか見えないので、
   * seed で決まる向きへ倒す。役割によって倒し方の強さを変える
   * （曲がるボリューム系は強く、縦膜はカメラ寄りのまま立たせる）。
   */
  private macroNormal(
    role: string,
    h: (salt: number) => number,
    amount: number,
  ): { x: number; y: number; z: number } {
    const strong = LIGHT_MAPPING.macroStrongTiltRoles.includes(role);
    const tilt =
      mix(LIGHT_MAPPING.macroTiltMinimum, LIGHT_MAPPING.macroTiltMaximum, h(51)) *
      (strong ? 1 : 0.7) *
      Math.max(amount, 0.15);
    // カメラ方向（+Z）から tilt ぶんだけ倒す。方位は seed で自由。
    const azimuth = h(53) * Math.PI * 2;
    const lean = tilt * (Math.PI / 2) * 0.85;
    const sine = Math.sin(lean);
    return normalise({
      x: Math.cos(azimuth) * sine,
      y: Math.sin(azimuth) * sine,
      z: Math.cos(lean),
    });
  }

  /**
   * 面内の回転。役割ごとに寄せる向きが違う
   * （縦膜は縦のまま / 途切れた斜光は水平垂直中心 / 広い霧は自由）。
   */
  private macroSpin(role: string, h: (salt: number) => number): number {
    const bias = LIGHT_MAPPING.macroRotationBias[role];
    const free = h(55) * Math.PI * 2;
    if (!bias || bias.strength <= 0) return free;
    // 目標の向き（180° 対称なので π で畳む）へ、strength ぶんだけ引き寄せる。
    const target = bias.angle + (h(57) < 0.5 ? 0 : Math.PI);
    return free + (target - free) * clamp01(bias.strength);
  }

  /** 分光に彩度の下限を入れる。色相の並びはそのまま。 */
  private saturate(gradient: LightGradient, floor: number): LightGradient {
    if (floor <= 0) return gradient;
    const lift = (value: number): number => Math.max(value, floor);
    const [a, b, c, d] = gradient.saturations;
    return { ...gradient, saturations: [lift(a), lift(b), lift(c), lift(d)] };
  }

  /**
   * 素材を 1 枚選ぶ。**勝った帯域の役割を優先し、他の役割にも余地を残す。**
   * 完全に帯域固定にすると、同じ帯域の曲で同じ数枚しか出なくなる。
   */
  private pickTile(snapshot: AudioEventSnapshot, h: (salt: number) => number): number {
    const preferred = LIGHT_MAPPING.macroRolesByBand[snapshot.winningBand];
    let total = 0;
    const weights = this.tiles.map((tile) => {
      const weight =
        tile.weight * (preferred.includes(tile.role) ? 1 : LIGHT_MAPPING.macroOffBandWeight);
      total += weight;
      return weight;
    });
    let pick = h(41) * total;
    for (let i = 0; i < weights.length; i++) {
      pick -= weights[i]!;
      if (pick <= 0) return i;
    }
    return weights.length - 1;
  }

  /**
   * イベント 1 個から**バースト**を組み立てる。
   *
   * メインの光 1 つと、5〜150ms 遅れて連鎖するサブの光 N 個を返す。
   * 遅れ・位置・大きさ・寿命はすべて音由来の決定論ハッシュで決まるので、
   * 同じ音源なら同じ連鎖になる（`Math.random()` は使わない）。
   */
  resolveBurst(
    event: BandLightEvent,
    visible: VisibleExtent,
    settings: LightMappingSettings,
  ): PlannedLight[] {
    const snapshot = event.snapshot;
    const origin =
      settings.placementMode === 'center'
        ? this.centerOrigin(snapshot, visible)
        : this.positions.resolve(event, visible);
    const mainIntensity = this.intensity(snapshot, settings);
    const mainSize = this.size(snapshot, settings);
    const color = this.color(snapshot, settings);
    const mainVelocity = this.velocity(snapshot, settings);
    const trail = clamp01(settings.trailAmount);

    const main: PlannedLight = {
      delaySeconds: 0,
      traits: {
        role: 'main',
        position: origin,
        intensity: mainIntensity,
        // **丸い点光源は主役から降ろす。** 中心の見え方は Prismatic Anchor が担い、
        // ここはその内側に残るごく小さな白い芯にとどめる。
        size: mainSize * LIGHT_MAPPING.mainHotspotScale,
        color,
        gradient: this.gradient(snapshot, settings, 0, 0),
        velocity: mainVelocity,
        lifetime: {
          attackSeconds: settings.attackSeconds,
          holdSeconds: settings.holdSeconds,
          decaySeconds: settings.decaySeconds,
        },
        trail,
        // メインは等方の点。形のバリエーションはサブが担う。
        shape: {
          kind: 'spark',
          elongation: LIGHT_MAPPING.mainElongation,
          angle: 0,
          waviness: 0,
          thickness: 1,
          normal: null,
          pattern: 0,
        },
        expansion: { from: 1, to: 1 },
      },
    };

    const count = this.subCount(snapshot, settings);
    const lights: PlannedLight[] = [main];
    const seed = [snapshot.audioSeed, BAND_INDEX[snapshot.winningBand], snapshot.eventIndex];
    const depth = -origin.z;
    const extent = visible(depth);

    for (let i = 0; i < count; i++) {
      const h = (salt: number): number => hash01(...seed, i, salt);
      const delay = mix(LIGHT_MAPPING.subDelayMinimum, LIGHT_MAPPING.subDelayMaximum, h(3));
      // メインの近くに散らす。近くで交わるほど、加算で白が生まれる。
      // 一部だけは遠くへ小さく飛ばして「周辺の細かい散り」を作る。
      const outer = h(41) < LIGHT_MAPPING.outerFraction;
      const angle = h(5) * Math.PI * 2;
      const radius = outer
        ? mix(LIGHT_MAPPING.outerSpreadMinimum, LIGHT_MAPPING.outerSpreadMaximum, h(7))
        : mix(LIGHT_MAPPING.subSpreadMinimum, LIGHT_MAPPING.subSpreadMaximum, h(7));
      const dz = (h(9) * 2 - 1) * LIGHT_MAPPING.subDepthSpread;
      const subDepth = Math.max(depth + dz, 1);
      const subExtent = visible(subDepth);
      const usable = 1 - 0.05;
      const position = {
        // 画面外へこぼさないよう、その奥行きの可視範囲で必ず抑える。
        x: clampAbs(origin.x + Math.cos(angle) * radius * extent.halfWidth, subExtent.halfWidth * usable),
        y: clampAbs(origin.y + Math.sin(angle) * radius * extent.halfHeight, subExtent.halfHeight * usable),
        z: -subDepth,
      };
      const sizeScale =
        mix(LIGHT_MAPPING.subSizeMinimum, LIGHT_MAPPING.subSizeMaximum, h(11)) *
        (outer ? LIGHT_MAPPING.outerSizeScale : 1);
      const intensityScale = mix(
        LIGHT_MAPPING.subIntensityMinimum,
        LIGHT_MAPPING.subIntensityMaximum,
        h(13),
      );
      const lifeScale = mix(
        LIGHT_MAPPING.subLifetimeMinimum,
        LIGHT_MAPPING.subLifetimeMaximum,
        h(17),
      );
      const speedScale = mix(LIGHT_MAPPING.subSpeedMinimum, LIGHT_MAPPING.subSpeedMaximum, h(19));
      // 分光: サブごとに色相を少しずらす。交わったところで色が混ざって白が立つ。
      const hueOffset = (h(23) * 2 - 1) * LIGHT_MAPPING.colorHueSpreadInBurst;
      lights.push({
        delaySeconds: delay,
        traits: {
          role: 'sub',
          position,
          intensity: mainIntensity * intensityScale,
          size: mainSize * sizeScale,
          color: this.color(snapshot, settings, hueOffset),
          gradient: this.gradient(snapshot, settings, hueOffset, 1 + i),
          velocity: {
            x: mainVelocity.x * speedScale,
            y: mainVelocity.y * speedScale,
            z: mainVelocity.z * speedScale,
          },
          lifetime: {
            // Attack はほぼゼロ。点いた瞬間に最大で、あとは落ちるだけ。
            attackSeconds: settings.attackSeconds * 0.5,
            holdSeconds: settings.holdSeconds * lifeScale * 0.6,
            decaySeconds: settings.decaySeconds * lifeScale,
          },
          trail,
          // 遠くへ飛ぶものは細かいスパークに寄せる。
          shape: outer
            ? { kind: 'spark', elongation: 1, angle: 0, waviness: 0, thickness: 1, normal: null, pattern: 0 }
            : this.shape(snapshot, settings, h),
          expansion: { from: 1, to: 1 },
        },
      });
    }

    // 軸平面のフラッシュ。原点から XY / XZ / YZ 平面に沿って一気に開く。
    const planes = Math.round(
      mix(
        LIGHT_MAPPING.planeCountMinimum,
        LIGHT_MAPPING.planeCountMaximum,
        clamp01(snapshot.onsetStrength),
      ),
    );
    for (let i = 0; i < planes; i++) {
      const h = (salt: number): number => hash01(...seed, 900 + i, salt);
      // 3 軸平面のどれかを基本にして、seed で少し傾ける（完全な軸固定にしない）。
      const axis = Math.floor(h(2) * 3) % 3;
      const base = [
        { x: 0, y: 0, z: 1 }, // XY 平面
        { x: 0, y: 1, z: 0 }, // XZ 平面
        { x: 1, y: 0, z: 0 }, // YZ 平面
      ][axis]!;
      const tilt = LIGHT_MAPPING.planeAxisDeviation;
      const normal = normalise({
        x: base.x + (h(4) * 2 - 1) * tilt,
        y: base.y + (h(6) * 2 - 1) * tilt,
        z: base.z + (h(8) * 2 - 1) * tilt,
      });
      const lifeScale = mix(
        LIGHT_MAPPING.planeLifetimeMinimum,
        LIGHT_MAPPING.planeLifetimeMaximum,
        h(10),
      );
      const planeHueOffset = (h(16) * 2 - 1) * LIGHT_MAPPING.colorHueSpreadInBurst;
      lights.push({
        delaySeconds: mix(0, LIGHT_MAPPING.subDelayMaximum * 0.5, h(12)),
        traits: {
          role: 'sub',
          position: origin,
          intensity:
            mainIntensity *
            mix(LIGHT_MAPPING.planeIntensityMinimum, LIGHT_MAPPING.planeIntensityMaximum, h(14)),
          size: mainSize,
          color: this.color(snapshot, settings, planeHueOffset),
          gradient: this.gradient(snapshot, settings, planeHueOffset, 900 + i),
          // 平面は動かない。開くことそのものが動き。
          velocity: { x: 0, y: 0, z: 0 },
          lifetime: {
            attackSeconds: settings.attackSeconds * 0.5,
            holdSeconds: settings.holdSeconds * lifeScale * 0.4,
            decaySeconds: settings.decaySeconds * lifeScale,
          },
          trail: 0,
          // 図形は 8 種類以上の不均一な多角形から seed が 1 つ選ぶ。
          shape: { kind: 'plane', elongation: 1, angle: 0, waviness: 0, thickness: 1, normal, pattern: h(18) },
          expansion: { from: LIGHT_MAPPING.planeScaleFrom, to: LIGHT_MAPPING.planeScaleTo },
        },
      });
    }

    // 画面を貫く針。**強い打撃のときだけ** 1〜数本、垂直・水平に走る。
    for (const ray of this.rays(snapshot, settings, origin, mainIntensity)) lights.push(ray);
    return lights;
  }

  /**
   * **画面を貫く針。**
   *
   * 有限長の光条（needle）とは別で、板の長さを画面の対角より長く取り、
   * 数フレームで全長へ伸びてすぐ消える。伸び方は描画側が `expansion` から作る。
   * 敷居を超えない打撃では 1 本も出さないので、弱い音では現れない。
   */
  private rays(
    snapshot: AudioEventSnapshot,
    settings: LightMappingSettings,
    origin: SpatialPosition,
    mainIntensity: number,
  ): PlannedLight[] {
    const strength = clamp01(snapshot.onsetStrength);
    if (strength < LIGHT_MAPPING.rayOnsetThreshold) return [];
    const above = clamp01(
      (strength - LIGHT_MAPPING.rayOnsetThreshold) /
        Math.max(1 - LIGHT_MAPPING.rayOnsetThreshold, 0.01),
    );
    const count = Math.round(
      mix(LIGHT_MAPPING.rayCountMinimum, LIGHT_MAPPING.rayCountMaximum, above),
    );

    const seed = [snapshot.audioSeed, snapshot.eventIndex, BAND_INDEX[snapshot.winningBand]];
    const lights: PlannedLight[] = [];
    for (let i = 0; i < count; i++) {
      const h = (salt: number): number => hash01(...seed, 700 + i, salt);
      // **横に走るほうを主にする。** 画面外まで抜ける横の一閃が空間の広さを作る。
      // 縦の斬撃が並ぶ状態にしないためのバイアスで、確率はつまみで動かせる。
      const horizontalChance = mix(
        0.5,
        LIGHT_MAPPING.rayHorizontalProbability,
        clamp01(settings.horizontalRayAmount),
      );
      const vertical = h(3) >= horizontalChance;
      const angle = (vertical ? Math.PI / 2 : 0) + (h(5) * 2 - 1) * LIGHT_MAPPING.rayTiltRadians;
      const hueOffset = (h(7) * 2 - 1) * LIGHT_MAPPING.colorHueSpreadInBurst;
      const lifeScale = mix(
        LIGHT_MAPPING.rayLifetimeMinimum,
        LIGHT_MAPPING.rayLifetimeMaximum,
        h(9),
      );
      lights.push({
        delaySeconds: mix(0, LIGHT_MAPPING.rayDelayMaximum, h(11)),
        traits: {
          role: 'sub',
          position: origin,
          intensity:
            mainIntensity *
            mix(LIGHT_MAPPING.rayIntensityMinimum, LIGHT_MAPPING.rayIntensityMaximum, h(13)),
          size: 1,
          color: this.color(snapshot, settings, hueOffset),
          gradient: this.gradient(snapshot, settings, hueOffset, 700 + i),
          // 針は動かない。伸びることそのものが動き。
          velocity: { x: 0, y: 0, z: 0 },
          lifetime: {
            attackSeconds: 0,
            holdSeconds: settings.holdSeconds * lifeScale * 0.3,
            decaySeconds: settings.decaySeconds * lifeScale,
          },
          trail: 0,
          shape: {
            kind: 'ray',
            elongation: 1,
            angle,
            waviness: 0,
            // Bass 寄り = 淡く太い / 高 centroid・Treble = 細く鋭い。
            thickness: this.thickness(snapshot, settings, 'ray'),
            normal: null,
            pattern: 0,
          },
          // 長さの割合。描画側が数フレームで 1 まで伸ばす。
          expansion: { from: 0, to: 1 },
        },
      });
    }
    return lights;
  }

  /**
   * 原点付近の位置。**同一点には置かず、決定論の微小ジッターでわずかにずらす。**
   * こうすると光が「ほぼ中心・少しずつずれて層になる」状態になり、
   * 加算で重なった中心が複雑に見える。
   */
  private centerOrigin(snapshot: AudioEventSnapshot, visible: VisibleExtent): SpatialPosition {
    const seed = [snapshot.audioSeed, snapshot.eventIndex, BAND_INDEX[snapshot.winningBand]];
    const depth =
      LIGHT_MAPPING.centerDepth +
      (hash01(...seed, 61) * 2 - 1) * LIGHT_MAPPING.centerDepthJitter;
    const extent = visible(Math.max(depth, 1));
    const jitter = LIGHT_MAPPING.centerJitter;
    return {
      x: clampAbs((hash01(...seed, 63) * 2 - 1) * jitter, extent.halfWidth * 0.9),
      y: clampAbs((hash01(...seed, 65) * 2 - 1) * jitter, extent.halfHeight * 0.9),
      z: -Math.max(depth, 1),
    };
  }

  /**
   * サブの形。種類の出やすさは帯域比率、細さと長さは centroid、
   * うねりの乱れ量は flatness が決める。
   *
   * **波形をそのまま形にはしない。** うねりは「まっすぐな光条は不自然だから
   * わずかに曲げる」ためだけの微小な変形で、波を描くものではない。
   */
  private shape(
    snapshot: AudioEventSnapshot,
    settings: LightMappingSettings,
    h: (salt: number) => number,
  ): LightShape {
    const { bass, mid, treble } = snapshot.bandFlux;
    const total = Math.max(bass + mid + treble, 1e-6);
    const weights = {
      spark:
        (bass / total) * LIGHT_MAPPING.shapeWeightsWhenBassLeads.spark +
        (mid / total) * LIGHT_MAPPING.shapeWeightsWhenMidLeads.spark +
        (treble / total) * LIGHT_MAPPING.shapeWeightsWhenTrebleLeads.spark,
      needle:
        (bass / total) * LIGHT_MAPPING.shapeWeightsWhenBassLeads.needle +
        (mid / total) * LIGHT_MAPPING.shapeWeightsWhenMidLeads.needle +
        (treble / total) * LIGHT_MAPPING.shapeWeightsWhenTrebleLeads.needle,
      arc:
        (bass / total) * LIGHT_MAPPING.shapeWeightsWhenBassLeads.arc +
        (mid / total) * LIGHT_MAPPING.shapeWeightsWhenMidLeads.arc +
        (treble / total) * LIGHT_MAPPING.shapeWeightsWhenTrebleLeads.arc,
    };
    const sum = weights.spark + weights.needle + weights.arc;
    const pick = h(29) * sum;
    const kind: LightShapeKind =
      pick < weights.spark ? 'spark' : pick < weights.spark + weights.needle ? 'needle' : 'arc';

    const centroid = clamp01(snapshot.spectralCentroid);
    const elongation =
      kind === 'spark'
        ? 1
        : kind === 'needle'
          ? mix(
              LIGHT_MAPPING.needleElongationAtLowCentroid,
              LIGHT_MAPPING.needleElongationAtHighCentroid,
              centroid,
            )
          : mix(
              LIGHT_MAPPING.arcElongationAtLowCentroid,
              LIGHT_MAPPING.arcElongationAtHighCentroid,
              centroid,
            );
    const waviness =
      kind === 'spark'
        ? 0
        : mix(
            LIGHT_MAPPING.wavinessAtPureTone,
            LIGHT_MAPPING.wavinessAtNoise,
            clamp01(snapshot.spectralFlatness),
          // 弧だけを余分に曲げる倍率は廃止。曲率の差は elongation だけで付ける。
          ) * (0.6 + h(31) * 0.8);

    // 向きは水平か垂直を基本にして、seed で少しだけ逸らす。
    // 自由方向のままだと放射状の花火に見えて、層の重なりが読めなくなる。
    const vertical = h(39) < 0.5;
    const angle =
      (vertical ? Math.PI / 2 : 0) +
      (h(37) * 2 - 1) * LIGHT_MAPPING.needleAxisDeviation * Math.PI;

    return {
      kind,
      elongation,
      angle,
      waviness,
      // 太さは長さと独立。低い centroid・Bass 優勢・大音量で実際に幅が増える。
      thickness: this.thickness(snapshot, settings, kind),
      normal: null,
      pattern: 0,
    };
  }

  /**
   * **軸と直交する方向の太さ。**
   *
   * 「細い斜線が中心から大量に飛ぶ」状態を抜けるための軸で、長さとは独立させる。
   *   太さの素 = 低い centroid 55% + Bass 比率 30% + Volume 15%
   * 低音・低い centroid・大音量では太い光条に、高い centroid では細い回折線に戻る。
   * `thicknessAmount` が 0 なら音に依らずぴたりと 1.0（基準の細さ）へ戻る。
   */
  private thickness(
    snapshot: AudioEventSnapshot,
    settings: LightMappingSettings,
    kind: LightShapeKind,
  ): number {
    const { bass, mid, treble } = snapshot.bandFlux;
    const total = Math.max(bass + mid + treble, 1e-6);
    const raw = clamp01(
      LIGHT_MAPPING.thicknessFromLowCentroid * (1 - clamp01(snapshot.spectralCentroid)) +
        LIGHT_MAPPING.thicknessFromBassShare * (bass / total) +
        LIGHT_MAPPING.thicknessFromVolume * clamp01(snapshot.volume),
    );
    const scaled =
      kind === 'arc'
        ? mix(LIGHT_MAPPING.thicknessArcMinimum, LIGHT_MAPPING.thicknessArcMaximum, raw)
        : kind === 'ray'
          ? mix(LIGHT_MAPPING.thicknessRayMinimum, LIGHT_MAPPING.thicknessRayMaximum, raw)
          : mix(LIGHT_MAPPING.thicknessNeedleMinimum, LIGHT_MAPPING.thicknessNeedleMaximum, raw);
    return mix(1, scaled, clamp01(settings.thicknessAmount));
  }

  /**
   * サブの個数。**音量が基礎、onset と新奇性が上乗せ、スライダーが倍率。**
   * 周波数の高さ（centroid）は使わない — 低音中心の曲で発生が枯れてしまうため。
   */
  private subCount(snapshot: AudioEventSnapshot, settings: LightMappingSettings): number {
    const raw =
      LIGHT_MAPPING.subCountBase +
      LIGHT_MAPPING.subCountPerVolume * clamp01(snapshot.volume) +
      LIGHT_MAPPING.subCountPerOnset * clamp01(snapshot.onsetStrength) +
      LIGHT_MAPPING.subCountPerNovelty * clamp01(snapshot.novelty);
    const scaled = raw * Math.max(settings.burstDensity, 0);
    return Math.min(Math.round(scaled), LIGHT_MAPPING.subCountMaximum);
  }

  /**
   * 明るさ。**onsetStrength だけで決める。**
   * 帯域比率（色）とは完全に分けてあるので、色が濃い＝明るい にはならない。
   */
  private intensity(snapshot: AudioEventSnapshot, settings: LightMappingSettings): number {
    const minimum = clamp01(settings.minimumIntensity);
    const maximum = Math.max(clamp01(settings.maximumIntensity), minimum);
    return minimum + clamp01(snapshot.onsetStrength) * (maximum - minimum);
  }

  /** 大きさ。音量（RMS）で決める。明るさとは別の軸にしておく。 */
  private size(snapshot: AudioEventSnapshot, settings: LightMappingSettings): number {
    const scaled = mix(
      LIGHT_MAPPING.sizeAtSilence,
      LIGHT_MAPPING.sizeAtFullVolume,
      clamp01(snapshot.volume),
    );
    // 効きが 0 のときはぴたりと 1.0（基準サイズ）に戻す。
    return mix(1, scaled, clamp01(settings.sizeAmount));
  }

  /**
   * 色。**音の seed から決まる個別の色**で、帯域から直接は作らない。
   *
   * 白は 1 つの光の中では作らない。バーストの光が近くで交わったところが
   * 加算合成で白へ寄る、という**重なりの結果として創発**させる。
   * 例外は極端に強い発光だけで、そのときは彩度が落ちて白熱して見える。
   *
   * `hueOffset` はバーストの中での分光。同じ打撃から出た光を少しずつ違う色相に
   * ずらすので、交差したところで色が混ざって白が立ちやすくなる。
   */
  private color(
    snapshot: AudioEventSnapshot,
    settings: LightMappingSettings,
    hueOffset = 0,
  ): { r: number; g: number; b: number } {
    const { hue, saturation } = this.tone(snapshot, settings, hueOffset);
    return hueToRgb(hue, saturation);
  }

  /**
   * 色の素（色相と彩度）。`color` と `gradient` はどちらもここから作るので、
   * 代表色とグラデーションが別々の色相を持つことはない。
   *
   * **色相はラップさせずに返す**（0.98 + 0.1 = 1.08 のまま）。
   * グラデーションの補間は連続値でないと色相環を逆走してしまう。
   */
  private tone(
    snapshot: AudioEventSnapshot,
    settings: LightMappingSettings,
    hueOffset: number,
  ): { hue: number; saturation: number } {
    const seed = [snapshot.audioSeed, snapshot.eventIndex, snapshot.spectralCentroid];
    const hue = hash01(...seed, 101) + hueOffset;
    const saturationSeed = mix(
      LIGHT_MAPPING.colorSaturationMinimum,
      LIGHT_MAPPING.colorSaturationMaximum,
      hash01(...seed, 103),
    );
    // 明るい音ほど色が立つ。ただし色相そのものは centroid で決めない。
    const withCentroid = clamp01(
      saturationSeed +
        (clamp01(snapshot.spectralCentroid) - 0.5) * LIGHT_MAPPING.colorSaturationFromCentroid,
    );
    // 極端に強い発光だけは単体でも白へ寄る。
    const extreme = clamp01(
      (clamp01(snapshot.onsetStrength) - LIGHT_MAPPING.colorWhiteAtExtreme) /
        Math.max(1 - LIGHT_MAPPING.colorWhiteAtExtreme, 0.01),
    );
    const saturation = withCentroid * (1 - extreme);
    return { hue, saturation: mix(0, saturation, clamp01(settings.colorAmount)) };
  }

  /**
   * **1 要素の内部の分光。** 形式・色相の走る幅・向き・ストップ数・彩度の並びを
   * すべて音由来の決定論ハッシュで決める（`Math.random()` は使わない）。
   *
   * `variant` は同じイベントの中で光ごとに別の流れを取るための番号。
   * これがないとバースト中の全部が同じグラデーションになる。
   */
  private gradient(
    snapshot: AudioEventSnapshot,
    settings: LightMappingSettings,
    hueOffset: number,
    variant: number,
  ): LightGradient {
    const { hue, saturation } = this.tone(snapshot, settings, hueOffset);
    const seed = [snapshot.audioSeed, snapshot.eventIndex, variant];
    const h = (salt: number): number => hash01(...seed, salt);

    const form = Math.min(
      Math.floor(h(211) * LIGHT_MAPPING.gradientFormCount),
      LIGHT_MAPPING.gradientFormCount - 1,
    );
    const range = LIGHT_MAPPING.gradientStopsMaximum - LIGHT_MAPPING.gradientStopsMinimum;
    const stops = Math.min(
      LIGHT_MAPPING.gradientStopsMinimum + Math.floor(h(213) * (range + 1)),
      LIGHT_MAPPING.gradientStopsMaximum,
    );
    const span =
      mix(LIGHT_MAPPING.gradientSpanNarrow, LIGHT_MAPPING.gradientSpanWide, h(215)) *
      (h(217) < 0.5 ? -1 : 1);
    // 3 ストップ以上のときだけ、走った色相が途中で折り返す並びを混ぜる。
    const turns = stops >= 3 && h(219) < LIGHT_MAPPING.gradientTurnProbability;
    // 彩度の並び: 0 = 白 → 色 / 1 = 色 → 白 / 2 = 一定。
    const saturationMode =
      h(221) < LIGHT_MAPPING.gradientFlatSaturationProbability ? 2 : h(223) < 0.5 ? 0 : 1;

    const hueStops: number[] = [];
    const saturationStops: number[] = [];
    for (let i = 0; i < stops; i++) {
      const u = i / (stops - 1);
      // 折り返す並びは山形（0 → 1 → 0）にして、同じ幅の中を往復させる。
      const travel = turns ? 1 - Math.abs(u * 2 - 1) : u;
      hueStops.push(hue + span * travel);
      const white = LIGHT_MAPPING.gradientWhiteEndScale;
      const ramp = saturationMode === 2 ? 1 : saturationMode === 0 ? mix(white, 1, u) : mix(1, white, u);
      saturationStops.push(saturation * ramp);
    }
    return { form, hues: resample4(hueStops), saturations: resample4(saturationStops) };
  }

  /**
   * 速度。帯域が「重さ」を、onsetStrength が初速を、centroid が散らばりの鋭さを決める。
   * 向きは決定論ハッシュなので、同じ帯域でも上下左右どこへでも出る
   * （帯域を固定の方向に縛らない）。
   *
   * **奥行き方向（z）へは動かさない。** 前後に動くと「カメラへ迫ってくる」
   * 印象になり、層がその奥行きに置かれている感じが壊れる。
   * 奥行きは発生位置と面の傾きだけで感じさせる。
   */
  private velocity(
    snapshot: AudioEventSnapshot,
    settings: LightMappingSettings,
  ): { x: number; y: number; z: number } {
    const amount = clamp01(settings.motionAmount);
    if (amount <= 0) return { x: 0, y: 0, z: 0 };

    const band = snapshot.winningBand;
    const base = LIGHT_MAPPING.speedByBand[band];
    const speed =
      base *
      mix(
        LIGHT_MAPPING.speedAtWeakOnset,
        LIGHT_MAPPING.speedAtStrongOnset,
        clamp01(snapshot.onsetStrength),
      );

    const seed = [
      snapshot.audioSeed,
      BAND_INDEX[band],
      snapshot.eventIndex,
      snapshot.spectralCentroid,
    ];
    // 球面上の一様な向き。どの帯域でも全方向へ出られる。
    const azimuth = hash01(...seed, 71) * Math.PI * 2;
    const cosine = hash01(...seed, 89) * 2 - 1;
    const sine = Math.sqrt(Math.max(1 - cosine * cosine, 0));

    // 散らばりの鋭さ。centroid が高いほど画面平行成分が絞られる。
    const spread = mix(
      LIGHT_MAPPING.spreadAtLowCentroid,
      LIGHT_MAPPING.spreadAtHighCentroid,
      clamp01(snapshot.spectralCentroid),
    );
    // 帯域ごとの奥行き寄り。0 で画面平行、1 で奥行き方向。
    const depthBias = LIGHT_MAPPING.depthBiasByBand[band];
    const planar = (1 - depthBias) * spread;

    return {
      x: Math.cos(azimuth) * sine * speed * planar * amount,
      y: Math.sin(azimuth) * sine * speed * planar * amount,
      // 前後には動かさない。帯域ごとの「重さ」は画面平行の速さだけに残る。
      z: 0,
    };
  }
}

/** Trail のスライダー値（0..1）を履歴の秒数へ写す。 */
export const trailSeconds = (trail: number): number =>
  mix(LIGHT_MAPPING.trailSecondsAtMinimum, LIGHT_MAPPING.trailSecondsAtMaximum, trail);

const clampAbs = (value: number, limit: number): number =>
  Math.min(Math.max(value, -limit), limit);

/**
 * 2〜4 個のストップからなる折れ線を、等間隔 4 点へリサンプルする。
 * 描画側は常に 4 点を受け取るので、ストップ数が変わっても属性の形は変わらない
 * （インスタンス属性は固定長でないと 1 ドローを保てない）。
 */
const resample4 = (values: number[]): [number, number, number, number] => {
  const last = Math.max(values.length - 1, 1);
  const at = (t: number): number => {
    const u = clamp01(t) * last;
    const index = Math.min(Math.floor(u), last - 1);
    const a = values[index] ?? 0;
    const b = values[index + 1] ?? a;
    return a + (b - a) * (u - index);
  };
  return [at(0), at(1 / 3), at(2 / 3), at(1)];
};

/**
 * 色相（0..1）と彩度から RGB を作る。**最大成分は必ず 1**（明るさは含めない）。
 * 彩度 0 で白、1 で純色。加算合成で重なったときに白へ寄るのはこの外側で起きる。
 */
const hueToRgb = (hue: number, saturation: number): { r: number; g: number; b: number } => {
  const h = ((hue % 1) + 1) % 1;
  const channel = (offset: number): number => {
    const position = ((h + offset) % 1) * 6;
    const value = Math.max(0, Math.min(1, Math.min(position, 4 - position, 1)));
    // 彩度 0 で 1（白）、1 でその成分そのもの。
    return 1 - clamp01(saturation) * (1 - value);
  };
  return { r: channel(0), g: channel(2 / 3), b: channel(1 / 3) };
};

/**
 * **Bloom を音で駆動するための差し込み口。**
 *
 * いまは何もせず素通しする（スライダーの値がそのまま効く）。
 * 音に紐づけるときはここだけを書き換えれば、表現側は 1 行も変わらない。
 * 例: 盛り上がりで滲みを強くするなら `strengthScale` に sustain や
 * 直近のバースト密度を、静かな区間で敷居を上げるなら `thresholdOffset` に
 * volume の逆数を返す、といった形になる。
 *
 * 音のどの値を使うかはまだ決めていないので、引数もあえて取っていない。
 * 駆動を入れるときに `AudioEventSnapshot` を受け取る形へ広げる。
 */
export const bloomDrive = (): { strengthScale: number; thresholdOffset: number } => ({
  strengthScale: 1,
  thresholdOffset: 0,
});

/** 単位ベクトルへ。長さが 0 のときは Z 軸へ倒す。 */
const normalise = (v: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!(length > 1e-6)) return { x: 0, y: 0, z: 1 };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
};
