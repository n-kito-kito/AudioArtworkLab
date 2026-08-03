import * as THREE from 'three';
import type { CompositionContext, DesignLayerCanvases } from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { BandLightEventDetector, type BandLightEvent } from '../engine/bandLightEvents';
import { BindingResolver } from '../engine/binding/resolve';
import { defaultTransformFor } from '../engine/binding/types';
import { getSourceShelf, type AudioSourceShelf } from '../engine/binding/sources';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { ExpressionParam, LabExpression } from './Expression';
import { LightElementLab2 } from './LightElementLab2';
import { LightReactiveLab } from './LightReactiveLab';
import { LightSpatialStudy, type SpatialRecoveryMode } from './LightSpatialStudy';
import type { OpticalGroup } from './lightOpticsMapping';
import { loadPrismAtlas, type PrismAtlas } from './prismAtlas';

/**
 * **Light Unified 2 — 素材が形を作る光。**
 *
 * ---
 * ## 出発点（第 1 歩）
 *
 * 3 表現（Spatial / Reactive / Element Lab 2）に出ていた「引っ掻き傷のような筋」は、
 * **筋を描く式から出ていない**。`prismAtlas` の 10 枚を細長い板に貼ったとき、
 * **素材の中にもともと在る線が拡大されて現れる副産物**だった。
 * だからこの表現は「**素材が形を作る**」を最初の原理に据える。
 *
 * **手続きで筋・羽毛・ハロ・ガウスを描くコードは 1 行も持たない。**
 * 膜の輝度の源は素材ただ 1 つで、**素材が 0 の画素は厳密に 0**（`pow(0, g) = 0`）。
 * 掛けているのは
 *
 *     色 × 素材輝度 × 緩いビネット × 強度
 *
 * だけ。ビネットは板の四角い輪郭を消すためのもので、輝度を**足すことはない**。
 *
 * ## コア（第 2 歩）
 *
 * `Core Presence` は**独立した手続きコアの寄与量**で、
 * **0 = 素材の重なりだけ（Spatial）⇄ 中間 = 素材 + 白い芯（Reactive）⇄ 1 = 明確な芯（Lab2）**。
 * 詳しくは `buildCoreMesh()` の注釈。
 * **コア層全体の有無は `Core Layer Size`、独立した白い芯の量は `Core Presence` が担う。**
 *
 * ## 音（第 3 歩）
 *
 * 既存の `BandLightEventDetector` を**そのまま**使う（新しい解析は作らない）。
 * 打撃 1 個につき
 *
 * - **コアが 1 個生まれる**（短い寿命）。位置はイベント番号のハッシュから決まり、
 *   これがそのイベントの**起点**になる。素材も発光ごとに変わる。
 * - **膜が `Membranes` 枚生まれる**（長い寿命）。位置と奥行きは `Spatial Spread` 軸で
 *   **0 = 起点へ集中 ⇄ 1 = 3D空間へ分散・重畳**を連続に行き来する。
 *
 * 色は**コアと膜が 1 つの色相状態を共有**する（音色 = centroid と帯域バランスから作る）。
 * `resolveTint()` は全体の色調バランスだけを作り、各シェーダーは同じ素材をRGBごとに
 * 僅かに異なる位置から読む。これにより、白い焦点を残したまま素材の線・端だけが分光する。
 *
 * **無音 = 黒（PRD D5）。** イベントが無ければ生きている光が 0 個になり、
 * どちらのメッシュも `instanceCount = 0` になるので 1 画素も描かれない。
 *
 * ## この段階でやらないこと
 *
 * - 靄・破片・貫通線を作らない。**膜とコアだけ**。
 * - ストロボ・色相の離散化・ヒステリシスは持たない。
 * - 既存の `LightUnified` を継承・改造しない。共有するのは素材アトラスと検出器だけ。
 *
 * ## 決定論
 *
 * 位置・素材番号・切り取り・向き・大きさのばらつきは、すべて**イベント番号**の
 * ハッシュから決まる。`Math.random()` も `Date.now()` も使わない。
 */

/** 質感の定数。つまみは連続な混合係数だけを持ち、端の値はここに置く。 */
const UNIFIED2 = {
  /** 1 イベントで生む膜の枚数の上限（つまみの最大と揃える）。 */
  maximumMembranesPerEvent: 6,
  /** 同時に生かす膜の総数の上限。溢れたら古いものから捨てる。 */
  maximumLiveMembranes: 30,
  /** 同時に生かすコアの上限。 */
  maximumLiveCores: 10,
  /** Persistent Controllerが維持する固定個体。Eventの上限とは別枠で描画する。 */
  persistentMembranes: 6,
  persistentCores: 1,
  nearPlane: 0.1,
  farPlane: 80,
  fieldOfView: 45,
  /** 膜を置く奥行きの帯（カメラは原点で −Z を見る）。 */
  depthNear: 7,
  depthFar: 9.6,
  /** 1 フレームで進める時間の上限（秒）。タブ復帰時の巨大な delta を切る。 */
  maximumDelta: 0.05,
  atlas: {
    manifestUrl: `${import.meta.env.BASE_URL}assets/light-traces/manifest.json`,
    cellPixels: 512,
    columns: 5,
  },
  /** UV をマスの内側へ寄せる余白。隣の素材へ絶対に滲ませない。 */
  cellInset: 0.004,

  // ---- 軸の端（すべて `mix` の両端。分岐はしない）----
  /** 切り取り半幅。狭いほど素材の中の線が拡大されて筋になる。 */
  cropNarrow: 0.05,
  cropWide: 0.5,
  /** 膜の半径（その奥行きでの可視半高に対する割合）。 */
  scaleSmall: 0.16,
  scaleLarge: 1.15,
  /** 素材輝度の曲げ。>1 で明部だけ残り、<1 で暗部が持ち上がって靄になる。 */
  gammaSharp: 2.4,
  gammaFoggy: 0.55,
  /** 黒浮きを落とす敷居と幅。**必ず 0 より上**なので素材 0 は 0 のまま。 */
  floorSharp: 0.08,
  floorFoggy: 0.01,
  floorWidthSharp: 0.02,
  floorWidthFoggy: 0.05,
  /** ビネットが立ち上がる半径。小さいほど緩く、1 に近いほど硬い円で切る。 */
  windowLoose: 0.1,
  windowTight: 0.95,
  /** 膜ごとの大きさのばらつき。 */
  sizeJitter: 0.35,
  /** 板の縦横比の幅。**細長い板が素材の線を異方的に引き伸ばす**（筋の正体）。 */
  elongationMinimum: 0.45,
  elongationMaximum: 2.2,
  /** 画面内での散らばり（可視半径に対する割合）。膜の散る側とコアの起点で共有。 */
  positionSpread: 0.55,
  /** 時間特性。**1 組だけ**（ストロボは持たない）。 */
  envelope: {
    /** コアは瞬間的に立ち上がってすぐ落ちる。 */
    coreAttackSeconds: 0.012,
    coreDecaySeconds: 0.22,
    /** 膜はコアより遅く開き、長く残る。 */
    membraneAttackSeconds: 0.05,
    membraneDecaySeconds: 0.95,
    /** これを下回った光は捨てる。無音で厳密に 0 個へ落とすための敷居。 */
    cullLevel: 0.004,
  },
  persistent: {
    /** 再生中の静かな隙間でも残る最低光量。 */
    baseLevel: 0.18,
    /** 音量が上がったときの追従と、停止後に黒へ戻る時間。 */
    attackSeconds: 0.3,
    releaseSeconds: 2.4,
    /** 短いブレイクは保持し、これを超える無音は停止と同じく黒へ戻す。 */
    silenceHoldSeconds: 1.4,
    /** 同じ個体が宇宙空間を漂う移動量。可視半径に対する割合。 */
    driftAmount: 0.08,
    driftSpeed: 0.055,
  },
  renewal: {
    /** 1でLab2に近い短周期更新。中間値は更新頻度だけを連続に変える。 */
    maximumRate: 8,
    rateCurve: 2,
    epochStride: 1013,
  },

  /** 検出の固定値。つまみに出すのは感度 1 本だけ（PRD D17）。 */
  detection: {
    fluxGain: 2.5,
    cooldownSeconds: 0.06,
    relativeStrengthFloor: 1,
    thresholdScale: 1,
  },

  /** 色。**作る場所は `resolveTint()` の 1 箇所だけ。** */
  color: {
    /** centroid（音色の明るさ）が色相を回す量。 */
    centroidSpan: 0.6,
    /** 帯域バランス（treble − bass）が色相を回す量。 */
    tiltSpan: 0.25,
    /** 色相の出発点。 */
    hueOrigin: 0.55,
    /**
     * 色相の追従の時定数（秒）。**離散化でもヒステリシスでもない**素の 1 次遅れで、
     * フレームごとの centroid のばらつきで色がちらつくのを抑えるだけ。
     */
    hueTimeConstant: 0.25,
    /** 素材セル内でRGBを読む位置の差。色を塗らず、素材の縁でだけ分光を起こす。 */
    membraneDispersion: 0.0045,
    coreDispersion: 0.003,
  },

  // ---- コア ----
  core: {
    /** コアを置く奥行き。膜の帯のちょうど真ん中。 */
    depth: 8.3,
    /**
     * コアの半径（その奥行きでの可視半高に対する割合）。
     *
     * **下端は 0。コアの有無は明るさではなく大きさで切り替える。**
     * `Core size = 0` で板そのものが潰れて 1 画素も描かれない。消え方は
     * 面積が連続に縮むことだけで起きるので、途中で飛ぶ段はどこにも無い
     * （輝度を落として消す項は持たない）。
     */
    sizeSmall: 0,
    sizeLarge: 0.42,
    /** コアごとの大きさのばらつき。 */
    sizeJitter: 0.3,
    /**
     * 手続きの楕円の落ち方。`pow(1 - r^2, falloff)`。
     * 大きいほど芯が締まる。r = 1 で厳密に 0 なので板の四角は出ない。
     */
    falloff: 2.6,
    /** 素材側の黒浮きの敷居と幅。膜と同じで、**0 は 0 のまま**通る。 */
    floor: 0.02,
    floorWidth: 0.04,
    /**
     * **素材側の高さを手続き側と揃えるための補正利得。**
     *
     * 手続きの楕円は中心で 1.0（＝白）へ届くが、素材の輝度は実測で 0.017〜0.3 しかない。
     * これが無いと `Core Presence` は構造の軸ではなく、単なる明滅になってしまう。
     * **膜には掛けない**（膜は今までどおり素材の輝度をそのまま出す）。
     */
    materialGain: 3.3,
    /** 素材側だけに要る円窓。手続き側は自前で 0 へ落ちるが、掛けても形は変わらない。 */
    edgeFadeStart: 0.6,
    /** 素材の切り取り半幅。膜と違って軸に出さない。 */
    cropHalf: 0.3,
    /** ハッシュの味付け。**発光ごとの素材選び**はイベント番号からこの塩を通して引く。 */
    seedSalt: 41.3,
  },

  /** D29 の要素分離確認用。音へ接続する前の静止した靄 1 枚。 */
  hazeStudy: {
    depth: 9,
    y: -0.72,
    halfWidth: 3.35,
    halfHeight: 0.82,
    tile: 3,
    cropHalf: 0.48,
    floor: 0.008,
    floorWidth: 0.045,
    gamma: 0.62,
    intensity: 1.45,
    edgeFadeStart: 0.08,
    attackSeconds: 0.08,
    releaseSeconds: 0.5,
  },

  /** Drift候補を単体確認する静止Fragment。音・時間・既存要素から独立。 */
  fragmentStudy: {
    maximumCount: 24,
    count: 18,
    depthNear: 6.8,
    depthFar: 10.2,
    safeArea: 0.76,
    pointSize: 0.035,
    shardWidth: 0.028,
    shardHeight: 0.16,
    intensity: 0.68,
    attackSeconds: 0.06,
    releaseSeconds: 0.65,
  },

  /** Lab2 の中心光だけを音なしで確認する独立 Study。 */
  lab2CoreStudy: {
    depth: 8.4,
    halfWidth: 2.4,
    halfHeight: 1.35,
    intensity: 1.08,
    /** 音接続前の確認用。将来は各成分を別の音特徴量で上書きする。 */
    rgb: { r: 0.55, g: 0.85, b: 1 },
  },

  /** Lab2 Coreの周囲に置く、素材由来の静止プリズム片。 */
  lab2FragmentStudy: {
    maximumCount: 9,
    count: 9,
    floor: 0.014,
    floorWidth: 0.04,
    gamma: 0.68,
    intensity: 0.72,
    edgeFadeStart: 0.18,
  },

  /** Spatial の素材重畳だけを音なしで確認する独立 Study。 */
  spatialMaterialAnchorStudy: {
    maximumCount: 5,
    count: 5,
    floor: 0.01,
    floorWidth: 0.035,
    gamma: 0.6,
    intensity: 1.85,
    edgeFadeStart: 0.16,
  },

  /** Spatial Anchorと同じ素材が外側へ分裂・伸長する静止Fragment。 */
  spatialFragmentStudy: {
    maximumCount: 7,
    count: 7,
    floor: 0.012,
    floorWidth: 0.04,
    gamma: 0.67,
    intensity: 1.05,
    edgeFadeStart: 0.18,
  },

  defaults: {
    membranes: 4,
    // Spatial donorの重畳面積を回収しつつ、1枚で画面を覆い切らない中間値。
    scale: 0.62,
    crop: 0.35,
    softness: 0.5,
    carve: 0.35,
    spatialSpread: 0.68,
    persistence: 0,
    renewal: 0,
    coreSize: 0.48,
    corePresence: 0.5,
    saturation: 0.55,
    sensitivity: 0.5,
    // Spatial 2.2 / Lab2 1.6の間より少し低く置き、加算の白飛び余地を残す。
    intensity: 1.45,
  },
} as const;

type Unified2ParamKey =
  | 'membranes'
  | 'scale'
  | 'crop'
  | 'softness'
  | 'carve'
  | 'spatialSpread'
  | 'persistence'
  | 'renewal'
  | 'coreSize'
  | 'corePresence'
  | 'saturation'
  | 'sensitivity'
  | 'intensity';

const PARAM_RANGES: Record<Unified2ParamKey, { min: number; max: number; step: number }> = {
  membranes: { min: 3, max: UNIFIED2.maximumMembranesPerEvent, step: 1 },
  scale: { min: 0, max: 1, step: 0.01 },
  crop: { min: 0, max: 1, step: 0.01 },
  softness: { min: 0, max: 1, step: 0.01 },
  carve: { min: 0, max: 1, step: 0.01 },
  spatialSpread: { min: 0, max: 1, step: 0.01 },
  persistence: { min: 0, max: 1, step: 0.01 },
  renewal: { min: 0, max: 1, step: 0.01 },
  coreSize: { min: 0, max: 1, step: 0.01 },
  corePresence: { min: 0, max: 1, step: 0.01 },
  saturation: { min: 0, max: 1, step: 0.01 },
  sensitivity: { min: 0, max: 1, step: 0.01 },
  intensity: { min: 0, max: 3, step: 0.01 },
};

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

const clamp01 = (value: number): number => clamp(value, 0, 1);

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** FNV-1a を土台にした 0..1 のハッシュ。`polygonAtlas` と同じ作り。 */
const hash01 = (...values: number[]): number => {
  let hash = 0x811c9dc5;
  for (const value of values) {
    const quantized = Math.round(value * 4096) | 0;
    for (let shift = 0; shift < 32; shift += 8) {
      hash ^= (quantized >>> shift) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return ((hash >>> 0) % 1000003) / 1000003;
};

/**
 * 立ち上がり × 減衰。**分岐は無い**（`clamp` と `exp` だけ）。
 * 立ち上がりきる前に減衰も始まっているが、attack が decay よりずっと短いので
 * 頂点はほぼ 1 に届く。時間特性はこの 1 組だけで、ストロボは持たない。
 */
const envelopeLevel = (age: number, attack: number, decay: number): number =>
  clamp01(age / Math.max(attack, 1e-4)) * Math.exp(-Math.max(age, 0) / Math.max(decay, 1e-4));

/** 生きている光 1 個ぶん。見え方の解釈はここでは持たず、種と起点だけを持つ。 */
interface LiveLight {
  /** 生まれた時刻（秒）。 */
  readonly bornAt: number;
  /** イベント通し番号。**すべてのばらつきの種**。 */
  readonly seed: number;
  /** 局所正規化された打撃の強さ（0..1）。 */
  readonly strength: number;
  /** 起点（コアの位置）。膜はここから生まれる。 */
  readonly originX: number;
  readonly originY: number;
  /** 膜だけが持つ、1 イベントの中の通し番号。コアは 0。 */
  readonly slot: number;
  /** Eventではなく、同じ個体を維持するPersistent Controllerの光か。 */
  readonly persistent?: boolean;
}

type Lab2AssemblyPreview =
  | 'off'
  | 'core'
  | 'cross-ray'
  | 'refraction-veil'
  | 'fan-spill'
  | 'haze-curtain'
  | 'all';

type SpatialRecoveryPreview = 'off' | SpatialRecoveryMode;
type ReactiveRecoveryPreview = 'off' | 'audio';
type RecoveryPreview =
  | 'off'
  | 'reactive-audio'
  | 'spatial-audio'
  | 'spatial-freeze'
  | `lab2-${Exclude<Lab2AssemblyPreview, 'off'>}`;

type LightAnchorPreset = 'custom' | 'spatial' | 'reactive' | 'lab2' | 'drift';

/**
 * 完成表現を切り替えるプリセットではなく、同じ4軸空間へ戻るための開始座標。
 * 個別レイヤーや色・素材の値は触らないので、ここから連続して混ぜられる。
 */
const LIGHT_ANCHOR_PRESETS: Record<Exclude<LightAnchorPreset, 'custom'>, {
  corePresence: number;
  spatialSpread: number;
  persistence: number;
  renewal: number;
}> = {
  spatial: { corePresence: 0, spatialSpread: 0.85, persistence: 0, renewal: 0 },
  reactive: { corePresence: 0.5, spatialSpread: 0.55, persistence: 0, renewal: 0 },
  lab2: { corePresence: 1, spatialSpread: 0.25, persistence: 0, renewal: 1 },
  drift: { corePresence: 0.7, spatialSpread: 0.75, persistence: 1, renewal: 0 },
};

export class LightUnified2 implements LabExpression {
  readonly animated = true;
  readonly name = 'Light Unified 2';
  readonly id: ExpressionId;

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  private readonly params: Record<Unified2ParamKey, number> = { ...UNIFIED2.defaults };
  /** Commonの最初の結線。基準値を残したまま、音のEnergyだけを上乗せする。 */
  private readonly commonResolver = new BindingResolver();
  private sourceShelf: AudioSourceShelf | null = null;

  private context: CompositionContext | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private geometry: THREE.InstancedBufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  private coreGeometry: THREE.InstancedBufferGeometry | null = null;
  private coreMaterial: THREE.ShaderMaterial | null = null;
  private coreMesh: THREE.Mesh | null = null;
  private hazeGeometry: THREE.PlaneGeometry | null = null;
  private hazeMaterial: THREE.ShaderMaterial | null = null;
  private hazeMesh: THREE.Mesh | null = null;
  /** Study 中だけ無音で形を確認する。音接続時には off に戻す。 */
  private hazePreview: 'off' | 'static' | 'audio' = 'audio';
  private hazeLevel = 0;
  private fragmentGeometry: THREE.InstancedBufferGeometry | null = null;
  private fragmentMaterial: THREE.ShaderMaterial | null = null;
  private fragmentMesh: THREE.Mesh | null = null;
  private fragmentPreview: 'off' | 'static' | 'audio' = 'off';
  private fragmentLevel = 0;
  private lab2CoreStudyPreview: 'off' | 'static' = 'off';
  private readonly lab2CoreRgb = new THREE.Vector3(
    UNIFIED2.lab2CoreStudy.rgb.r,
    UNIFIED2.lab2CoreStudy.rgb.g,
    UNIFIED2.lab2CoreStudy.rgb.b,
  );
  private lab2CoreStudyGeometry: THREE.PlaneGeometry | null = null;
  private lab2CoreStudyMaterial: THREE.ShaderMaterial | null = null;
  private lab2CoreStudyMesh: THREE.Mesh | null = null;
  private lab2FragmentStudyPreview: 'off' | 'static' | 'with-core' = 'off';
  private lab2FragmentSeed = 40;
  private lab2FragmentPattern: 'cluster' | 'scatter' | 'radial' | 'asymmetric' = 'cluster';
  private lab2FragmentStudyGeometry: THREE.InstancedBufferGeometry | null = null;
  private lab2FragmentStudyMaterial: THREE.ShaderMaterial | null = null;
  private lab2FragmentStudyMesh: THREE.Mesh | null = null;
  private spatialMaterialAnchorPreview: 'off' | 'static' = 'off';
  private spatialMaterialAnchorGeometry: THREE.InstancedBufferGeometry | null = null;
  private spatialMaterialAnchorMaterial: THREE.ShaderMaterial | null = null;
  private spatialMaterialAnchorMesh: THREE.Mesh | null = null;
  private spatialFragmentStudyPreview: 'off' | 'static' | 'with-anchor' = 'off';
  private spatialFragmentStudyGeometry: THREE.InstancedBufferGeometry | null = null;
  private spatialFragmentStudyMaterial: THREE.ShaderMaterial | null = null;
  private spatialFragmentStudyMesh: THREE.Mesh | null = null;
  /** 旧Lab2の完成済み光学系を、そのまま回収して確認するAssembly。 */
  private lab2AssemblyPreview: Lab2AssemblyPreview = 'off';
  private readonly lab2AssemblyRgb = new THREE.Vector3(0.82, 1, 0.82);
  private readonly lab2AssemblyLevels = {
    core: 1,
    crossRay: 1,
    fragment: 1,
    fanSpill: 1,
    hazeCurtain: 1,
    globalIntensity: 1,
  };
  private lab2Assembly: LightElementLab2 | null = null;
  /** 旧Spatialの完成済み描画器を再利用するRecovery。新しい同等シェーダーは持たない。 */
  private spatialRecoveryPreview: SpatialRecoveryPreview = 'off';
  private spatialRecovery: LightSpatialStudy | null = null;
  /** 旧Reactive Compositeを比較するRecovery。正式なStyle Presetではない。 */
  private reactiveRecoveryPreview: ReactiveRecoveryPreview = 'off';
  private reactiveRecovery: LightReactiveLab | null = null;
  private placeholder: THREE.DataTexture | null = null;
  private atlas: PrismAtlas | null = null;
  private pipeline: EffectPipeline | null = null;
  private disposed = false;

  // ---- 音 ----
  /** **既存の検出器をそのまま使う。** 新しい解析は 1 つも作らない。 */
  private readonly detector = new BandLightEventDetector();
  private previousElapsed = -1;
  /** コアと膜が共有する色相状態（0..1）。1 次遅れで音色を追う。 */
  private hue: number = UNIFIED2.color.hueOrigin;
  private readonly tint = new THREE.Color(1, 1, 1);

  private readonly cores: LiveLight[] = [];
  private readonly membranes: LiveLight[] = [];
  private readonly persistentCores: LiveLight[] = [];
  private readonly persistentMembranes: LiveLight[] = [];
  /** 再生中は音の隙間に床を持ち、停止後はゆっくり0へ戻る。 */
  private persistentLevel = 0;
  private persistentSilenceSeconds = 0;

  // ---- 膜のインスタンス属性 ----
  private readonly offsets = new Float32Array(
    (UNIFIED2.maximumLiveMembranes + UNIFIED2.persistentMembranes) * 3,
  );
  /** 半幅 / 半高 / 素材番号。 */
  private readonly sizes = new Float32Array(
    (UNIFIED2.maximumLiveMembranes + UNIFIED2.persistentMembranes) * 3,
  );
  /** 切り取りの中心 UV と半幅。 */
  private readonly crops = new Float32Array(
    (UNIFIED2.maximumLiveMembranes + UNIFIED2.persistentMembranes) * 4,
  );
  /** 面内回転の cos / sin と UV の反転。 */
  private readonly orients = new Float32Array(
    (UNIFIED2.maximumLiveMembranes + UNIFIED2.persistentMembranes) * 4,
  );
  /** 振幅（エンベロープ × 打撃の強さ）。 */
  private readonly levels = new Float32Array(
    UNIFIED2.maximumLiveMembranes + UNIFIED2.persistentMembranes,
  );
  private readonly attributes: Record<string, THREE.InstancedBufferAttribute> = {};

  // ---- コアのインスタンス属性 ----
  private readonly coreOffsets = new Float32Array(
    (UNIFIED2.maximumLiveCores + UNIFIED2.persistentCores) * 3,
  );
  /** 半径 / 素材番号（コアは正方形）。 */
  private readonly coreSizes = new Float32Array(
    (UNIFIED2.maximumLiveCores + UNIFIED2.persistentCores) * 2,
  );
  /** 切り取りの中心 UV と面内回転の cos / sin。 */
  private readonly coreCells = new Float32Array(
    (UNIFIED2.maximumLiveCores + UNIFIED2.persistentCores) * 4,
  );
  /** UV の反転。 */
  private readonly coreFlips = new Float32Array(
    (UNIFIED2.maximumLiveCores + UNIFIED2.persistentCores) * 2,
  );
  private readonly coreLevels = new Float32Array(
    UNIFIED2.maximumLiveCores + UNIFIED2.persistentCores,
  );
  private readonly coreAttributes: Record<string, THREE.InstancedBufferAttribute> = {};

  constructor(id: ExpressionId, effects: Effect[] = [], theme?: Theme) {
    this.id = id;
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
    this.commonResolver.declare([
      {
        id: 'intensity',
        label: 'Global Intensity',
        min: PARAM_RANGES.intensity.min,
        max: PARAM_RANGES.intensity.max,
        default: UNIFIED2.defaults.intensity,
        kind: 'continuous',
      },
    ]);
  }

  // ---------------------------------------------------------------- setup

  setup(context: CompositionContext): void {
    this.context = context;
    this.disposed = false;
    this.sourceShelf = getSourceShelf(context.audioEngine);
    this.commonResolver.setSources(this.sourceShelf.list());
    this.commonResolver.reset();
    const energy = this.sourceShelf.find('volume');
    this.commonResolver.bind({
      paramId: 'intensity',
      sourceId: energy?.id ?? null,
      // 0..3の全幅に対する0.25。最大入力でも +0.75 に留め、白飛びの余地を残す。
      depth: 0.25,
      transform: energy ? defaultTransformFor(energy.kind, 'continuous') : null,
    });

    this.camera = new THREE.PerspectiveCamera(
      UNIFIED2.fieldOfView,
      this.aspectRatio,
      UNIFIED2.nearPlane,
      UNIFIED2.farPlane,
    );
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(0, 0, -1);
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();

    // アトラスが届くまでの仮の 1×1 黒。素材が無い間は 1 画素も出ない。
    this.placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.placeholder.colorSpace = THREE.SRGBColorSpace;
    this.placeholder.needsUpdate = true;

    // 表現を開き直したら前の曲の余韻は持ち越さない。
    this.detector.reset();
    this.previousElapsed = -1;
    this.hue = UNIFIED2.color.hueOrigin;
    this.hazeLevel = 0;
    this.fragmentLevel = 0;
    this.cores.length = 0;
    this.membranes.length = 0;
    this.persistentCores.length = 0;
    this.persistentMembranes.length = 0;
    this.persistentLevel = 0;
    this.persistentSilenceSeconds = 0;

    this.buildMembraneMesh();
    this.buildCoreMesh();
    this.buildHazeStudyMesh();
    this.buildFragmentStudyMesh();
    this.buildLab2CoreStudyMesh();
    this.buildLab2FragmentStudyMesh();
    this.buildSpatialMaterialAnchorStudyMesh();
    this.buildSpatialFragmentStudyMesh();

    // 新しい同等シェーダーを描かず、旧Lab2の描画器とprismAtlas処理を丸ごと再利用する。
    this.lab2Assembly = new LightElementLab2('light-element2-all-v1', 'all', [], this.theme);
    this.lab2Assembly.setup(context);
    this.lab2Assembly.setAspect(this.aspectId, this.aspectRatio);
    this.lab2Assembly.setZoom(this.zoom);
    this.syncLab2Assembly();

    this.spatialRecovery = new LightSpatialStudy([], this.theme);
    this.spatialRecovery.setup(context);
    this.spatialRecovery.setAspect(this.aspectId, this.aspectRatio);
    this.spatialRecovery.setZoom(this.zoom);
    this.spatialRecovery.setRecoveryMode(null);

    // Reactive固有のBurst Plannerと4層構成を描き直さず、完成済みCompositeを再利用する。
    this.reactiveRecovery = new LightReactiveLab(
      'light-reactive-composite-v1',
      'composite',
      [],
      this.theme,
    );
    this.reactiveRecovery.setup(context);
    this.reactiveRecovery.setAspect(this.aspectId, this.aspectRatio);
    this.reactiveRecovery.setZoom(this.zoom);
    this.syncCommonIntensity();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    if (this.mesh) this.scene.add(this.mesh);
    if (this.coreMesh) this.scene.add(this.coreMesh);
    if (this.hazeMesh) this.scene.add(this.hazeMesh);
    if (this.fragmentMesh) this.scene.add(this.fragmentMesh);
    if (this.lab2CoreStudyMesh) this.scene.add(this.lab2CoreStudyMesh);
    if (this.lab2FragmentStudyMesh) this.scene.add(this.lab2FragmentStudyMesh);
    if (this.spatialMaterialAnchorMesh) this.scene.add(this.spatialMaterialAnchorMesh);
    if (this.spatialFragmentStudyMesh) this.scene.add(this.spatialFragmentStudyMesh);

    this.pipeline = new EffectPipeline(context.renderer, this.scene, this.camera, this.effects);

    // 素材は非同期。届くまで 1 画素も出ないだけで、表現は壊れない。
    void loadPrismAtlas(UNIFIED2.atlas).then((atlas) => {
      if (!atlas) return;
      if (this.disposed) {
        atlas.texture.dispose();
        return;
      }
      this.atlas = atlas;
      for (const material of [
        this.material,
        this.coreMaterial,
        this.hazeMaterial,
        this.lab2FragmentStudyMaterial,
        this.spatialMaterialAnchorMaterial,
        this.spatialFragmentStudyMaterial,
      ]) {
        if (!material) continue;
        material.uniforms.uAtlas!.value = atlas.texture;
        (material.uniforms.uGrid!.value as THREE.Vector2).set(atlas.columns, atlas.rows);
      }
    });
  }

  /**
   * 第 1 段の確認用の「靄」。音・時間・イベントを一切参照しない静止画として描く。
   * 輝度源は膜と同じ prismAtlas だけで、ガウス光や bloom は足さない。
   */
  private buildHazeStudyMesh(): void {
    const haze = UNIFIED2.hazeStudy;
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.placeholder },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uTile: { value: haze.tile },
        uCropHalf: { value: haze.cropHalf },
        uShape: {
          value: new THREE.Vector4(
            haze.floor,
            haze.floorWidth,
            haze.gamma,
            haze.edgeFadeStart,
          ),
        },
        uIntensity: { value: haze.intensity },
        uInset: { value: UNIFIED2.cellInset },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      vertexShader: /* glsl */ `
        varying vec2 vLocal;

        void main() {
          vLocal = position.xy;
          vec3 world = vec3(
            position.x * ${haze.halfWidth.toFixed(4)},
            ${haze.y.toFixed(4)} + position.y * ${haze.halfHeight.toFixed(4)},
            -${haze.depth.toFixed(4)}
          );
          gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec2 uGrid;
        uniform float uTile;
        uniform float uCropHalf;
        uniform vec4 uShape;
        uniform float uIntensity;
        uniform float uInset;
        varying vec2 vLocal;

        void main() {
          // 板の境界だけを消す。光そのものを手続きで足す処理ではない。
          vec2 edgeDistance = 1.0 - abs(vLocal);
          float window = smoothstep(0.0, 1.0 - uShape.w, edgeDistance.x)
            * smoothstep(0.0, 1.0 - uShape.w, edgeDistance.y);
          if (window <= 0.0) discard;

          vec2 cell = clamp(vec2(0.5) + vLocal * uCropHalf, uInset, 1.0 - uInset);
          float column = mod(uTile, uGrid.x);
          float row = floor(uTile / uGrid.x);
          vec2 atlasUv = (vec2(column, row) + cell) / uGrid;
          vec3 source = texture2D(uAtlas, atlasUv).rgb;
          float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
          luminance *= smoothstep(uShape.x, uShape.x + uShape.y, luminance);
          luminance = pow(max(luminance, 0.0), uShape.z);

          // 静止確認では白寄りの微かな紫だけ。色・強度の音接続は次段に残す。
          vec3 tint = vec3(0.86, 0.82, 1.0);
          gl_FragColor = vec4(tint * luminance * window * uIntensity, 1.0);
        }
      `,
    });

    this.hazeGeometry = geometry;
    this.hazeMaterial = material;
    this.hazeMesh = new THREE.Mesh(geometry, material);
    this.hazeMesh.visible = this.hazePreview !== 'off';
    this.hazeMesh.frustumCulled = false;
  }

  /** Fragment / Particleの第1段。決定論的な静止配置だけを確認する。 */
  private buildFragmentStudyMesh(): void {
    const study = UNIFIED2.fragmentStudy;
    const plane = new THREE.PlaneGeometry(2, 2);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = plane.index;
    geometry.setAttribute('position', plane.getAttribute('position'));
    geometry.setAttribute('uv', plane.getAttribute('uv'));
    plane.dispose();

    const offsets = new Float32Array(study.maximumCount * 3);
    const sizes = new Float32Array(study.maximumCount * 3);
    const rotations = new Float32Array(study.maximumCount * 2);
    const colors = new Float32Array(study.maximumCount * 3);
    const add = (name: string, data: Float32Array, size: number): void => {
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, size));
    };
    add('aOffset', offsets, 3);
    add('aSize', sizes, 3);
    add('aRotation', rotations, 2);
    add('aColor', colors, 3);

    const color = new THREE.Color();
    for (let index = 0; index < study.count; index++) {
      const depth = mix(study.depthNear, study.depthFar, hash01(index, 70.1));
      const halfHeight = this.halfHeightAt(depth) * study.safeArea;
      // 対応画角で最も狭い9:16を基準にし、切替後も画面外へ出さない。
      const halfWidth = halfHeight * (9 / 16);
      const point = hash01(index, 71.3) < 0.38;
      const scale = mix(0.72, 1.28, hash01(index, 72.7));
      const angle = hash01(index, 73.9) * Math.PI;
      const offsetIndex = index * 3;
      const sizeIndex = index * 3;
      const rotationIndex = index * 2;
      const colorIndex = index * 3;
      offsets[offsetIndex] = (hash01(index, 74.3) * 2 - 1) * halfWidth;
      offsets[offsetIndex + 1] = (hash01(index, 75.1) * 2 - 1) * halfHeight;
      offsets[offsetIndex + 2] = -depth;
      sizes[sizeIndex] = (point ? study.pointSize : study.shardWidth) * scale;
      sizes[sizeIndex + 1] = (point ? study.pointSize : study.shardHeight) * scale;
      sizes[sizeIndex + 2] = point ? 0 : 1;
      rotations[rotationIndex] = Math.cos(angle);
      rotations[rotationIndex + 1] = Math.sin(angle);
      color.setHSL(hash01(index, 76.7), 0.48, 0.72);
      colors[colorIndex] = color.r;
      colors[colorIndex + 1] = color.g;
      colors[colorIndex + 2] = color.b;
    }
    geometry.instanceCount = study.count;

    const material = new THREE.ShaderMaterial({
      uniforms: { uIntensity: { value: study.intensity } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec3 aSize;
        attribute vec2 aRotation;
        attribute vec3 aColor;
        varying vec2 vLocal;
        varying float vShape;
        varying vec3 vColor;
        void main() {
          vLocal = position.xy;
          vShape = aSize.z;
          vColor = aColor;
          vec2 local = position.xy * aSize.xy;
          local = vec2(
            local.x * aRotation.x - local.y * aRotation.y,
            local.x * aRotation.y + local.y * aRotation.x
          );
          gl_Position = projectionMatrix * modelViewMatrix * vec4(aOffset + vec3(local, 0.0), 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uIntensity;
        varying vec2 vLocal;
        varying float vShape;
        varying vec3 vColor;
        void main() {
          float pointMask = 1.0 - smoothstep(0.52, 1.0, length(vLocal));
          float shardDistance = abs(vLocal.x) + abs(vLocal.y) * 0.42;
          float shardMask = 1.0 - smoothstep(0.72, 1.0, shardDistance);
          float mask = mix(pointMask, shardMask, vShape);
          if (mask <= 0.0) discard;
          gl_FragColor = vec4(vColor * mask * uIntensity, 1.0);
        }
      `,
    });

    this.fragmentGeometry = geometry;
    this.fragmentMaterial = material;
    this.fragmentMesh = new THREE.Mesh(geometry, material);
    this.fragmentMesh.visible = this.fragmentPreview === 'static';
    this.fragmentMesh.frustumCulled = false;
    this.fragmentMesh.renderOrder = 2;
  }

  /** Lab2 の白い焦点と、その内部の屈折殻・色収差だけを確認する静止 Study。 */
  private buildLab2CoreStudyMesh(): void {
    const study = UNIFIED2.lab2CoreStudy;
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uIntensity: { value: study.intensity },
        uRgb: { value: this.lab2CoreRgb.clone() },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      vertexShader: /* glsl */ `
        varying vec2 vLocal;
        void main() {
          vLocal = position.xy;
          vec3 world = vec3(
            position.x * ${study.halfWidth.toFixed(4)},
            position.y * ${study.halfHeight.toFixed(4)},
            -${study.depth.toFixed(4)}
          );
          gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uIntensity;
        uniform vec3 uRgb;
        varying vec2 vLocal;

        float focus(vec2 point, vec2 radius, float falloff) {
          vec2 q = point / radius;
          return exp(-dot(q, q) * falloff);
        }

        vec2 rotatePoint(vec2 point, float angle) {
          float c = cos(angle);
          float s = sin(angle);
          return vec2(point.x * c - point.y * s, point.x * s + point.y * c);
        }

        float refractionShard(
          vec2 point,
          vec2 offset,
          float angle,
          vec2 radius,
          float skew
        ) {
          vec2 q = rotatePoint(point - offset, angle);
          q.x += q.y * skew;
          vec2 n = q / radius;
          float irregular = abs(n.x) + abs(n.y) * 0.72;
          irregular += sin(n.x * 3.1 + n.y * 2.3) * 0.055;
          return 1.0 - smoothstep(0.54, 1.0, irregular);
        }

        float refractionShell(vec2 point) {
          float shell = 0.0;
          shell += refractionShard(point, vec2(-0.067, 0.041), -0.46, vec2(0.112, 0.047), 0.28);
          shell += refractionShard(point, vec2(0.083, -0.025), 0.59, vec2(0.118, 0.041), -0.34);
          shell += refractionShard(point, vec2(0.012, 0.086), 1.03, vec2(0.082, 0.029), 0.18);
          shell += refractionShard(point, vec2(-0.029, -0.078), 0.17, vec2(0.086, 0.027), -0.22);
          shell += refractionShard(point, vec2(0.112, 0.052), -0.18, vec2(0.066, 0.021), 0.31);
          return clamp(shell, 0.0, 1.0);
        }

        void main() {
          vec2 p = vLocal;
          float edge = smoothstep(0.0, 0.16, 1.0 - max(abs(p.x), abs(p.y)));

          // White Focus: RGB比率に左右されない鋭い白色の焦点。
          float whiteBody = focus(p, vec2(0.096, 0.168), 2.85);
          float whiteFocus = focus(p - vec2(0.002, 0.001), vec2(0.037, 0.066), 3.45);

          // Refraction Shell: Core直近に閉じた、左右非対称な屈折片の集合。
          float shell = refractionShell(p);
          float shellInner = refractionShell(p * 1.09 + vec2(0.004, -0.003));
          float shellEdge = clamp(shell - shellInner * 0.58, 0.0, 1.0);

          // Color Fringe: 同じShellを僅かにずらしてRGB各成分へ渡す。
          // RGBが均等なら重なりが白へ寄り、比率差があると連続的に発色が変わる。
          vec3 rgbRatio = max(uRgb, vec3(0.0));
          rgbRatio /= max(max(rgbRatio.r, rgbRatio.g), max(rgbRatio.b, 0.0001));
          vec2 aberration = vec2(0.006, -0.0035);
          vec3 fringeField = vec3(
            refractionShell(p + aberration),
            shell,
            refractionShell(p - aberration)
          );
          fringeField = clamp(fringeField - vec3(shellInner * 0.62), 0.0, 1.0);

          // Local Spill: Shellと同じ屈折片を広げ、焦点直近にだけ淡く漏らす。
          float spill = refractionShell(p * 0.72 + vec2(-0.012, 0.006));
          spill *= 1.0 - smoothstep(0.12, 0.29, length(p));

          vec3 color = vec3(whiteBody * 0.72 + whiteFocus * 1.12);
          color += vec3(shell * 0.24 + shellEdge * 0.17);
          color += fringeField * rgbRatio * 0.31;
          color += mix(vec3(1.0), rgbRatio, 0.42) * spill * 0.085;
          color *= edge * uIntensity;

          float peak = max(color.r, max(color.g, color.b));
          if (peak < 0.002) discard;
          gl_FragColor = vec4(min(color, vec3(1.0)), 1.0);
        }
      `,
    });

    this.lab2CoreStudyGeometry = geometry;
    this.lab2CoreStudyMaterial = material;
    this.lab2CoreStudyMesh = new THREE.Mesh(geometry, material);
    this.lab2CoreStudyMesh.visible = false;
    this.lab2CoreStudyMesh.frustumCulled = false;
    this.lab2CoreStudyMesh.renderOrder = 3;
  }

  /** Lab2専用。prismAtlasの切片だけで、Core周囲の静止Fragmentを作る。 */
  private buildLab2FragmentStudyMesh(): void {
    const study = UNIFIED2.lab2FragmentStudy;
    const plane = new THREE.PlaneGeometry(2, 2);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = plane.index;
    geometry.setAttribute('position', plane.getAttribute('position'));
    geometry.setAttribute('uv', plane.getAttribute('uv'));
    plane.dispose();

    const offsets = new Float32Array(study.maximumCount * 3);
    const sizes = new Float32Array(study.maximumCount * 3);
    const crops = new Float32Array(study.maximumCount * 4);
    const rotations = new Float32Array(study.maximumCount * 2);
    const colors = new Float32Array(study.maximumCount * 3);
    const levels = new Float32Array(study.maximumCount);
    const add = (name: string, data: Float32Array, size: number): void => {
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, size));
    };
    add('aOffset', offsets, 3);
    add('aSize', sizes, 3);
    add('aCrop', crops, 4);
    add('aRotation', rotations, 2);
    add('aColor', colors, 3);
    add('aLevel', levels, 1);

    const fragmentShapes = [
      { w: 0.48, h: 0.13, tile: 1, cx: 0.43, cy: 0.55, cropX: 0.15, cropY: 0.1, color: [0.82, 1.0, 0.86] },
      { w: 0.43, h: 0.11, tile: 4, cx: 0.56, cy: 0.43, cropX: 0.13, cropY: 0.08, color: [0.76, 0.9, 1.0] },
      { w: 0.16, h: 0.4, tile: 8, cx: 0.5, cy: 0.47, cropX: 0.08, cropY: 0.16, color: [0.9, 1.0, 0.84] },
      { w: 0.58, h: 0.09, tile: 6, cx: 0.4, cy: 0.58, cropX: 0.14, cropY: 0.07, color: [0.8, 0.82, 1.0] },
      { w: 0.38, h: 0.08, tile: 9, cx: 0.52, cy: 0.5, cropX: 0.12, cropY: 0.07, color: [0.88, 1.0, 0.9] },
      { w: 0.44, h: 0.09, tile: 3, cx: 0.48, cy: 0.46, cropX: 0.12, cropY: 0.07, color: [0.7, 0.94, 1.0] },
      { w: 0.32, h: 0.075, tile: 5, cx: 0.55, cy: 0.55, cropX: 0.1, cropY: 0.065, color: [0.78, 1.0, 0.82] },
      { w: 0.72, h: 0.085, tile: 2, cx: 0.44, cy: 0.52, cropX: 0.11, cropY: 0.065, color: [0.9, 0.96, 1.0] },
      { w: 0.28, h: 0.07, tile: 7, cx: 0.46, cy: 0.48, cropX: 0.09, cropY: 0.06, color: [0.76, 1.0, 0.86] },
    ] as const;
    const seed = this.lab2FragmentSeed;
    const fragments = fragmentShapes.map((shape, index) => {
      const unitAngle = (index / study.count) * Math.PI * 2;
      const randomAngle = hash01(seed, index, 101.3) * Math.PI * 2;
      const jitter = (hash01(seed, index, 102.7) * 2 - 1) * 0.28;
      let x: number;
      let y: number;
      let angle = randomAngle;
      if (this.lab2FragmentPattern === 'cluster') {
        const radius = mix(0.24, 0.78, hash01(seed, index, 103.9));
        x = Math.cos(randomAngle) * radius;
        y = Math.sin(randomAngle) * radius;
      } else if (this.lab2FragmentPattern === 'scatter') {
        x = mix(-1.5, 1.5, hash01(seed, index, 104.3));
        y = mix(-1.35, 1.35, hash01(seed, index, 105.1));
      } else if (this.lab2FragmentPattern === 'radial') {
        const radialAngle = unitAngle + jitter;
        const radius = mix(0.42, 1.42, hash01(seed, index, 106.7));
        x = Math.cos(radialAngle) * radius;
        y = Math.sin(radialAngle) * radius;
        angle = radialAngle + Math.PI * 0.5;
      } else {
        const side = hash01(seed, index, 107.9) < 0.72 ? -1 : 1;
        x = side * mix(0.3, 1.52, hash01(seed, index, 108.5));
        y = mix(-1.18, 1.18, hash01(seed, index, 109.1));
      }
      const radius = Math.hypot(x, y);
      return {
        ...shape,
        x,
        y,
        z: -mix(8.1, 8.75, hash01(seed, index, 110.3)),
        angle,
        level: mix(1.0, 0.44, clamp01(radius / 1.7)),
      };
    });

    fragments.forEach((fragment, index) => {
      offsets.set([fragment.x, fragment.y, fragment.z], index * 3);
      sizes.set([fragment.w, fragment.h, fragment.tile], index * 3);
      crops.set([fragment.cx, fragment.cy, fragment.cropX, fragment.cropY], index * 4);
      rotations.set([Math.cos(fragment.angle), Math.sin(fragment.angle)], index * 2);
      colors.set(fragment.color, index * 3);
      levels[index] = fragment.level;
    });
    geometry.instanceCount = study.count;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.placeholder },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uShape: { value: new THREE.Vector4(study.floor, study.floorWidth, study.gamma, study.edgeFadeStart) },
        uIntensity: { value: study.intensity },
        uInset: { value: UNIFIED2.cellInset },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec3 aSize;
        attribute vec4 aCrop;
        attribute vec2 aRotation;
        attribute vec3 aColor;
        attribute float aLevel;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCrop;
        varying vec3 vColor;
        varying float vLevel;
        void main() {
          vLocal = position.xy;
          vTile = aSize.z;
          vCrop = aCrop;
          vColor = aColor;
          vLevel = aLevel;
          vec2 local = position.xy * aSize.xy;
          local = vec2(local.x * aRotation.x - local.y * aRotation.y,
            local.x * aRotation.y + local.y * aRotation.x);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(aOffset + vec3(local, 0.0), 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec2 uGrid;
        uniform vec4 uShape;
        uniform float uIntensity;
        uniform float uInset;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCrop;
        varying vec3 vColor;
        varying float vLevel;
        void main() {
          vec2 edgeDistance = 1.0 - abs(vLocal);
          float window = smoothstep(0.0, uShape.w, edgeDistance.x)
            * smoothstep(0.0, uShape.w, edgeDistance.y);
          if (window <= 0.0) discard;
          vec2 cell = clamp(vCrop.xy + vLocal * vCrop.zw, uInset, 1.0 - uInset);
          float column = mod(vTile, uGrid.x);
          float row = floor(vTile / uGrid.x);
          vec3 source = texture2D(uAtlas, (vec2(column, row) + cell) / uGrid).rgb;
          float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
          luminance *= smoothstep(uShape.x, uShape.x + uShape.y, luminance);
          luminance = pow(max(luminance, 0.0), uShape.z);
          vec3 color = vColor * luminance * window * vLevel * uIntensity;
          if (max(color.r, max(color.g, color.b)) < 0.002) discard;
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    if (this.atlas) {
      material.uniforms.uAtlas!.value = this.atlas.texture;
      (material.uniforms.uGrid!.value as THREE.Vector2).set(
        this.atlas.columns,
        this.atlas.rows,
      );
    }

    this.lab2FragmentStudyGeometry = geometry;
    this.lab2FragmentStudyMaterial = material;
    this.lab2FragmentStudyMesh = new THREE.Mesh(geometry, material);
    this.lab2FragmentStudyMesh.visible = false;
    this.lab2FragmentStudyMesh.frustumCulled = false;
    this.lab2FragmentStudyMesh.renderOrder = 2;
  }

  /** Seed / Pattern変更時だけ作り直す。時間更新では呼ばない。 */
  private rebuildLab2FragmentStudyMesh(): void {
    if (this.lab2FragmentStudyMesh && this.scene) {
      this.scene.remove(this.lab2FragmentStudyMesh);
    }
    this.lab2FragmentStudyGeometry?.dispose();
    this.lab2FragmentStudyMaterial?.dispose();
    this.lab2FragmentStudyGeometry = null;
    this.lab2FragmentStudyMaterial = null;
    this.lab2FragmentStudyMesh = null;
    this.buildLab2FragmentStudyMesh();
    if (this.lab2FragmentStudyMesh && this.scene) {
      this.scene.add(this.lab2FragmentStudyMesh);
    }
    this.updateLab2CoreStudy();
  }

  /** Spatial の原理確認。4枚の同種素材だけを変形・重畳し、独立Coreは描かない。 */
  private buildSpatialMaterialAnchorStudyMesh(): void {
    const study = UNIFIED2.spatialMaterialAnchorStudy;
    const plane = new THREE.PlaneGeometry(2, 2);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = plane.index;
    geometry.setAttribute('position', plane.getAttribute('position'));
    geometry.setAttribute('uv', plane.getAttribute('uv'));
    plane.dispose();

    const offsets = new Float32Array(study.maximumCount * 3);
    const sizes = new Float32Array(study.maximumCount * 3);
    const crops = new Float32Array(study.maximumCount * 4);
    const rotations = new Float32Array(study.maximumCount * 2);
    const colors = new Float32Array(study.maximumCount * 3);
    const levels = new Float32Array(study.maximumCount);
    const add = (name: string, data: Float32Array, size: number): void => {
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, size));
    };
    add('aOffset', offsets, 3);
    add('aSize', sizes, 3);
    add('aCrop', crops, 4);
    add('aRotation', rotations, 2);
    add('aColor', colors, 3);
    add('aLevel', levels, 1);

    const layers = [
      { x: -0.06, y: 0.02, z: -8.2, w: 1.75, h: 0.52, tile: 1, cx: 0.46, cy: 0.52, crop: 0.2, angle: -0.18, color: [0.62, 1.0, 0.76], level: 1.0 },
      { x: 0.02, y: 0.04, z: -8.45, w: 0.9, h: 1.25, tile: 4, cx: 0.55, cy: 0.47, crop: 0.24, angle: 0.62, color: [0.68, 0.76, 1.0], level: 0.95 },
      { x: 0.07, y: -0.04, z: -8.7, w: 1.95, h: 0.42, tile: 6, cx: 0.42, cy: 0.56, crop: 0.17, angle: 0.24, color: [1.0, 0.62, 0.88], level: 0.9 },
      { x: -0.02, y: -0.02, z: -8.28, w: 1.05, h: 0.92, tile: 8, cx: 0.51, cy: 0.44, crop: 0.28, angle: -0.78, color: [0.92, 1.0, 0.74], level: 1.0 },
      { x: 0.01, y: 0.01, z: -8.36, w: 1.25, h: 0.58, tile: 9, cx: 0.49, cy: 0.5, crop: 0.28, angle: 0.08, color: [0.92, 1.0, 0.92], level: 1.0 },
    ] as const;

    layers.forEach((layer, index) => {
      offsets[index * 3] = layer.x;
      offsets[index * 3 + 1] = layer.y;
      offsets[index * 3 + 2] = layer.z;
      sizes[index * 3] = layer.w;
      sizes[index * 3 + 1] = layer.h;
      sizes[index * 3 + 2] = layer.tile;
      crops[index * 4] = layer.cx;
      crops[index * 4 + 1] = layer.cy;
      crops[index * 4 + 2] = layer.crop;
      crops[index * 4 + 3] = layer.crop;
      rotations[index * 2] = Math.cos(layer.angle);
      rotations[index * 2 + 1] = Math.sin(layer.angle);
      colors[index * 3] = layer.color[0];
      colors[index * 3 + 1] = layer.color[1];
      colors[index * 3 + 2] = layer.color[2];
      levels[index] = layer.level;
    });
    geometry.instanceCount = study.count;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.placeholder },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uShape: {
          value: new THREE.Vector4(
            study.floor,
            study.floorWidth,
            study.gamma,
            study.edgeFadeStart,
          ),
        },
        uIntensity: { value: study.intensity },
        uInset: { value: UNIFIED2.cellInset },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec3 aSize;
        attribute vec4 aCrop;
        attribute vec2 aRotation;
        attribute vec3 aColor;
        attribute float aLevel;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCrop;
        varying vec3 vColor;
        varying float vLevel;

        void main() {
          vLocal = position.xy;
          vTile = aSize.z;
          vCrop = aCrop;
          vColor = aColor;
          vLevel = aLevel;
          vec2 local = position.xy * aSize.xy;
          local = vec2(
            local.x * aRotation.x - local.y * aRotation.y,
            local.x * aRotation.y + local.y * aRotation.x
          );
          gl_Position = projectionMatrix * modelViewMatrix * vec4(aOffset + vec3(local, 0.0), 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec2 uGrid;
        uniform vec4 uShape;
        uniform float uIntensity;
        uniform float uInset;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCrop;
        varying vec3 vColor;
        varying float vLevel;

        void main() {
          vec2 edgeDistance = 1.0 - abs(vLocal);
          float window = smoothstep(0.0, uShape.w, edgeDistance.x)
            * smoothstep(0.0, uShape.w, edgeDistance.y);
          if (window <= 0.0) discard;

          vec2 cell = clamp(vCrop.xy + vLocal * vCrop.zw, uInset, 1.0 - uInset);
          float column = mod(vTile, uGrid.x);
          float row = floor(vTile / uGrid.x);
          vec2 atlasUv = (vec2(column, row) + cell) / uGrid;
          vec3 source = texture2D(uAtlas, atlasUv).rgb;
          float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
          luminance *= smoothstep(uShape.x, uShape.x + uShape.y, luminance);
          luminance = pow(max(luminance, 0.0), uShape.z);

          vec3 color = vColor * luminance * window * vLevel * uIntensity;
          if (max(color.r, max(color.g, color.b)) < 0.002) discard;
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });

    this.spatialMaterialAnchorGeometry = geometry;
    this.spatialMaterialAnchorMaterial = material;
    this.spatialMaterialAnchorMesh = new THREE.Mesh(geometry, material);
    this.spatialMaterialAnchorMesh.visible = false;
    this.spatialMaterialAnchorMesh.frustumCulled = false;
    this.spatialMaterialAnchorMesh.renderOrder = 3;
  }

  /** Spatial専用。Anchorと一部を重ね、同じ素材が外へ伸びる静止Fragment。 */
  private buildSpatialFragmentStudyMesh(): void {
    const study = UNIFIED2.spatialFragmentStudy;
    const plane = new THREE.PlaneGeometry(2, 2);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = plane.index;
    geometry.setAttribute('position', plane.getAttribute('position'));
    geometry.setAttribute('uv', plane.getAttribute('uv'));
    plane.dispose();

    const offsets = new Float32Array(study.maximumCount * 3);
    const sizes = new Float32Array(study.maximumCount * 3);
    const crops = new Float32Array(study.maximumCount * 4);
    const rotations = new Float32Array(study.maximumCount * 2);
    const colors = new Float32Array(study.maximumCount * 3);
    const levels = new Float32Array(study.maximumCount);
    const add = (name: string, data: Float32Array, size: number): void => {
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, size));
    };
    add('aOffset', offsets, 3);
    add('aSize', sizes, 3);
    add('aCrop', crops, 4);
    add('aRotation', rotations, 2);
    add('aColor', colors, 3);
    add('aLevel', levels, 1);

    const fragments = [
      { x: -0.36, y: 0.04, z: -8.22, w: 0.92, h: 0.17, tile: 1, cx: 0.44, cy: 0.53, cropX: 0.17, cropY: 0.09, angle: -0.2, color: [0.68, 1.0, 0.8], level: 0.96 },
      { x: 0.42, y: -0.03, z: -8.4, w: 1.02, h: 0.15, tile: 6, cx: 0.42, cy: 0.56, cropX: 0.16, cropY: 0.08, angle: 0.23, color: [1.0, 0.66, 0.88], level: 0.88 },
      { x: -0.82, y: 0.42, z: -8.55, w: 0.88, h: 0.11, tile: 8, cx: 0.52, cy: 0.44, cropX: 0.14, cropY: 0.07, angle: -0.72, color: [0.78, 0.92, 1.0], level: 0.68 },
      { x: 0.92, y: 0.48, z: -8.7, w: 0.82, h: 0.1, tile: 4, cx: 0.55, cy: 0.47, cropX: 0.13, cropY: 0.07, angle: 0.68, color: [0.72, 1.0, 0.84], level: 0.62 },
      { x: -1.28, y: -0.52, z: -8.42, w: 0.76, h: 0.085, tile: 9, cx: 0.49, cy: 0.5, cropX: 0.12, cropY: 0.065, angle: 0.38, color: [0.9, 1.0, 0.84], level: 0.5 },
      { x: 1.38, y: -0.62, z: -8.62, w: 0.9, h: 0.08, tile: 2, cx: 0.45, cy: 0.52, cropX: 0.12, cropY: 0.06, angle: -0.46, color: [0.8, 0.84, 1.0], level: 0.44 },
      { x: 0.12, y: 1.02, z: -8.76, w: 0.18, h: 0.72, tile: 5, cx: 0.54, cy: 0.5, cropX: 0.07, cropY: 0.14, angle: 0.14, color: [0.76, 1.0, 0.86], level: 0.4 },
    ] as const;

    fragments.forEach((fragment, index) => {
      offsets.set([fragment.x, fragment.y, fragment.z], index * 3);
      sizes.set([fragment.w, fragment.h, fragment.tile], index * 3);
      crops.set([fragment.cx, fragment.cy, fragment.cropX, fragment.cropY], index * 4);
      rotations.set([Math.cos(fragment.angle), Math.sin(fragment.angle)], index * 2);
      colors.set(fragment.color, index * 3);
      levels[index] = fragment.level;
    });
    geometry.instanceCount = study.count;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.placeholder },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uShape: { value: new THREE.Vector4(study.floor, study.floorWidth, study.gamma, study.edgeFadeStart) },
        uIntensity: { value: study.intensity },
        uInset: { value: UNIFIED2.cellInset },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec3 aSize;
        attribute vec4 aCrop;
        attribute vec2 aRotation;
        attribute vec3 aColor;
        attribute float aLevel;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCrop;
        varying vec3 vColor;
        varying float vLevel;
        void main() {
          vLocal = position.xy;
          vTile = aSize.z;
          vCrop = aCrop;
          vColor = aColor;
          vLevel = aLevel;
          vec2 local = position.xy * aSize.xy;
          local = vec2(local.x * aRotation.x - local.y * aRotation.y,
            local.x * aRotation.y + local.y * aRotation.x);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(aOffset + vec3(local, 0.0), 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec2 uGrid;
        uniform vec4 uShape;
        uniform float uIntensity;
        uniform float uInset;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCrop;
        varying vec3 vColor;
        varying float vLevel;
        void main() {
          vec2 edgeDistance = 1.0 - abs(vLocal);
          float window = smoothstep(0.0, uShape.w, edgeDistance.x)
            * smoothstep(0.0, uShape.w, edgeDistance.y);
          if (window <= 0.0) discard;
          vec2 cell = clamp(vCrop.xy + vLocal * vCrop.zw, uInset, 1.0 - uInset);
          float column = mod(vTile, uGrid.x);
          float row = floor(vTile / uGrid.x);
          vec3 source = texture2D(uAtlas, (vec2(column, row) + cell) / uGrid).rgb;
          float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
          luminance *= smoothstep(uShape.x, uShape.x + uShape.y, luminance);
          luminance = pow(max(luminance, 0.0), uShape.z);
          vec3 color = vColor * luminance * window * vLevel * uIntensity;
          if (max(color.r, max(color.g, color.b)) < 0.002) discard;
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });

    this.spatialFragmentStudyGeometry = geometry;
    this.spatialFragmentStudyMaterial = material;
    this.spatialFragmentStudyMesh = new THREE.Mesh(geometry, material);
    this.spatialFragmentStudyMesh.visible = false;
    this.spatialFragmentStudyMesh.frustumCulled = false;
    this.spatialFragmentStudyMesh.renderOrder = 2;
  }

  // ---------------------------------------------------------------- 描画

  private buildMembraneMesh(): void {
    const plane = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = plane.index;
    geometry.setAttribute('position', plane.getAttribute('position'));
    geometry.setAttribute('uv', plane.getAttribute('uv'));
    plane.dispose();

    const add = (name: string, data: Float32Array, size: number): void => {
      const attribute = new THREE.InstancedBufferAttribute(data, size);
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
      this.attributes[name] = attribute;
    };
    add('aOffset', this.offsets, 3);
    add('aSize', this.sizes, 3);
    add('aCrop', this.crops, 4);
    add('aOrient', this.orients, 4);
    add('aLevel', this.levels, 1);
    geometry.instanceCount = 0;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.placeholder },
        uGrid: { value: new THREE.Vector2(1, 1) },
        // ビネットの立ち上がり / 黒浮きの敷居 / 同・幅 / 素材輝度の曲げ。
        uShape: {
          value: new THREE.Vector4(
            UNIFIED2.windowLoose,
            UNIFIED2.floorSharp,
            UNIFIED2.floorWidthSharp,
            UNIFIED2.gammaSharp,
          ),
        },
        // **コアと共有する色。** 作っているのは `resolveTint()` の 1 箇所だけ。
        uTint: { value: this.tint },
        uHue: { value: this.hue },
        uDispersion: { value: UNIFIED2.defaults.saturation },
        uIntensity: { value: UNIFIED2.defaults.intensity },
        uInset: { value: UNIFIED2.cellInset },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec3 aSize;
        attribute vec4 aCrop;
        attribute vec4 aOrient;
        attribute float aLevel;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying float vLevel;

        void main() {
          // 板の中を −1..1 で持つ。ビネットも UV も全部この座標で作る。
          vLocal = position.xy * 2.0;
          vTile = aSize.z;
          vCrop = aCrop;
          vOrient = aOrient;
          vLevel = aLevel;
          // カメラ正面固定の平面。奥行きの前後関係はこの段階では作らない。
          vec3 world = aOffset + vec3(vLocal.x * aSize.x, vLocal.y * aSize.y, 0.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec2 uGrid;
        uniform vec4 uShape;
        uniform vec3 uTint;
        uniform float uHue;
        uniform float uDispersion;
        uniform float uIntensity;
        uniform float uInset;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying float vLevel;

        vec3 spectralRgb(float hue, float saturation) {
          vec3 phase = fract(vec3(hue) + vec3(0.0, 0.6666667, 0.3333333)) * 6.0;
          vec3 value = clamp(min(phase, 4.0 - phase), 0.0, 1.0);
          return 1.0 - clamp(saturation, 0.0, 1.0) * (1.0 - value);
        }

        float gradientPosition(vec2 p, float form) {
          float radius = clamp(length(p), 0.0, 1.0);
          if (form < 0.5) return radius;
          if (form < 1.5) return 1.0 - radius;
          if (form < 2.5) return 0.5 + p.x * 0.5;
          if (form < 3.5) return 0.5 + p.y * 0.5;
          return atan(p.y, p.x) * 0.1591549 + 0.5;
        }

        void main() {
          vec2 p = vLocal;
          // ① ビネット。板の四角い輪郭を消すためだけの掛け算で、輝度は足さない。
          float window = 1.0 - smoothstep(uShape.x, 1.0, length(p));
          if (window <= 0.0) discard;

          // ② 面内回転と反転。同じ素材でも毎回別の切り口になる。
          vec2 q = vec2(p.x * vOrient.x - p.y * vOrient.y, p.x * vOrient.y + p.y * vOrient.x);
          q *= vec2(vOrient.z, vOrient.w);

          // ③ 切り取り。半幅が狭いほど素材が拡大され、中に在る線が筋として立つ。
          vec2 cell = clamp(vCrop.xy + q * vCrop.zw, uInset, 1.0 - uInset);
          float column = mod(vTile, uGrid.x);
          float row = floor(vTile / uGrid.x);
          // ④ 素材色を維持した、浅い色収差。RGBずらしは縁の補助に限定する。
          vec2 dispersion = vec2(${UNIFIED2.color.membraneDispersion.toFixed(4)}, -${(UNIFIED2.color.membraneDispersion * 0.58).toFixed(4)})
            * clamp(uDispersion, 0.0, 1.0);
          vec2 cellR = clamp(cell + dispersion, uInset, 1.0 - uInset);
          vec2 cellB = clamp(cell - dispersion, uInset, 1.0 - uInset);
          vec3 sourceR = texture2D(uAtlas, (vec2(column, row) + cellR) / uGrid).rgb;
          vec3 sourceG = texture2D(uAtlas, (vec2(column, row) + cell) / uGrid).rgb;
          vec3 sourceB = texture2D(uAtlas, (vec2(column, row) + cellB) / uGrid).rgb;
          vec3 chromaMask = vec3(
            dot(sourceR, vec3(0.2126, 0.7152, 0.0722)),
            dot(sourceG, vec3(0.2126, 0.7152, 0.0722)),
            dot(sourceB, vec3(0.2126, 0.7152, 0.0722))
          );
          float luminance = dot(sourceG, vec3(0.2126, 0.7152, 0.0722));
          luminance *= smoothstep(uShape.y, uShape.y + uShape.z, luminance);
          luminance = pow(max(luminance, 0.0), uShape.w);
          chromaMask *= smoothstep(vec3(uShape.y), vec3(uShape.y + uShape.z), chromaMask);
          chromaMask = pow(max(chromaMask, vec3(0.0)), vec3(uShape.w));

          // Spatial donorと同じ考え方：素材固有色と、面内を連続する波長勾配を混ぜる。
          float sourcePeak = max(sourceG.r, max(sourceG.g, sourceG.b));
          vec3 sourceHue = sourceG / max(sourcePeak, 0.0001);
          float gradient = gradientPosition(q, mod(vTile, 5.0));
          vec3 wavelength = spectralRgb(fract(uHue + gradient * 0.42), 0.86);
          vec3 tone = mix(wavelength, sourceHue, 0.52);
          tone = mix(vec3(1.0), tone, clamp(uDispersion, 0.0, 1.0) * 0.96);
          tone *= mix(vec3(1.0), max(uTint, vec3(0.2)), 0.12);

          // 中央輝度を主体にし、RGB別マスクは縁へ細かな色差を足すだけにする。
          vec3 opticalMask = mix(vec3(luminance), chromaMask, 0.22 * uDispersion);
          vec3 color = tone * opticalMask
            * window * max(vLevel, 0.0) * uIntensity;
          gl_FragColor = vec4(max(color, 0.0), 1.0);
        }
      `,
    });

    this.geometry = geometry;
    this.material = material;
    this.mesh = new THREE.Mesh(geometry, material);
    // 板はシェーダーで広げるので three の境界球では判定できない。
    this.mesh.frustumCulled = false;
  }

  /**
   * **コア。打撃ごとに 1 個生まれる中心の白熱。**
   *
   * ---
   * ## `Core Presence` は「**独立した手続きコアの寄与量**」
   *
   * 3 表現を見直すと、Spatial に独立したコア部品は無く、中心にあったのは
   * **素材が形の膜が強く光っていたもの**（Prismatic Anchor）だった。
   * Lab2 は**手続きの楕円 + 素材を加算**、Reactive は**素材が形 + 白い芯を加算**。
   * つまり 3 表現は「**手続きの芯がどれだけ乗るか**」の 1 本の軸に並ぶ。
   *
   *     mask = 素材の輝度 + 手続きの楕円 × Core Presence
   *
   * - `Core Presence = 0`: 芯は無く、素材の重なりだけ（＝ Spatial）
   * - 中間: 素材が形の上に芯が加算で乗る（＝ Reactive）
   * - `Core Presence = 1`: 芯が満額で乗る（＝ Lab2）
   *
   * 素材側は軸のどこでも常に居る。変わるのは芯の質だけで、分岐は無く連続。
   *
   * ## 有無と質は別のつまみ
   *
   * **素材を含むコア層全体を消したいときは `Core size` を 0 にする。**
   * `Core Presence` が0でも素材由来の白熱は残り、Spatial側の端点として成立する。
   */
  private buildCoreMesh(): void {
    // 板の中を −1..1 で持つ。膜と同じ座標系にして、式の読み比べができるようにする。
    const plane = new THREE.PlaneGeometry(2, 2);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = plane.index;
    geometry.setAttribute('position', plane.getAttribute('position'));
    geometry.setAttribute('uv', plane.getAttribute('uv'));
    plane.dispose();

    const add = (name: string, data: Float32Array, size: number): void => {
      const attribute = new THREE.InstancedBufferAttribute(data, size);
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
      this.coreAttributes[name] = attribute;
    };
    add('aOffset', this.coreOffsets, 3);
    add('aSize', this.coreSizes, 2);
    add('aCell', this.coreCells, 4);
    add('aFlip', this.coreFlips, 2);
    add('aLevel', this.coreLevels, 1);
    geometry.instanceCount = 0;

    const core = UNIFIED2.core;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.placeholder },
        uGrid: { value: new THREE.Vector2(1, 1) },
        // 手続きの芯の寄与量 / 楕円の落ち方 / 素材側の補正利得 / 円窓の始まり。
        uCore: {
          value: new THREE.Vector4(
            UNIFIED2.defaults.corePresence,
            core.falloff,
            core.materialGain,
            core.edgeFadeStart,
          ),
        },
        // 素材側の黒浮きの敷居・幅 / 切り取り半幅 / マスの内側の余白。
        uCoreCrop: {
          value: new THREE.Vector4(core.floor, core.floorWidth, core.cropHalf, UNIFIED2.cellInset),
        },
        // **膜と共有する色。** 同じ `THREE.Color` の実体を両方が指す。
        uTint: { value: this.tint },
        uHue: { value: this.hue },
        uDispersion: { value: UNIFIED2.defaults.saturation },
        uIntensity: { value: UNIFIED2.defaults.intensity },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec2 aSize;
        attribute vec4 aCell;
        attribute vec2 aFlip;
        attribute float aLevel;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCell;
        varying vec2 vFlip;
        varying float vLevel;

        void main() {
          vLocal = position.xy;
          vTile = aSize.y;
          vCell = aCell;
          vFlip = aFlip;
          vLevel = aLevel;
          vec3 world = aOffset + vec3(vLocal * aSize.x, 0.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec2 uGrid;
        uniform vec4 uCore;
        uniform vec4 uCoreCrop;
        uniform vec3 uTint;
        uniform float uHue;
        uniform float uDispersion;
        uniform float uIntensity;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCell;
        varying vec2 vFlip;
        varying float vLevel;

        vec3 spectralRgb(float hue, float saturation) {
          vec3 phase = fract(vec3(hue) + vec3(0.0, 0.6666667, 0.3333333)) * 6.0;
          vec3 value = clamp(min(phase, 4.0 - phase), 0.0, 1.0);
          return 1.0 - clamp(saturation, 0.0, 1.0) * (1.0 - value);
        }

        void main() {
          vec2 p = vLocal;
          float radius2 = dot(p, p);

          // ① 手続きの芯（楕円）。r = 1 で厳密に 0 なので、板の四角はこの側では出ない。
          //    寄与量 uCore.x は Core Presence 0 で厳密に0になり、素材だけが残る。
          float ellipse = pow(clamp(1.0 - radius2, 0.0, 1.0), uCore.y) * max(uCore.x, 0.0);

          // ② 素材が形。膜とまったく同じ読み方（敷居も 0 を 0 のまま通す）。
          //    切り取りの中心・回転・反転は発光ごとの種から来る。
          vec2 q = vec2(
            p.x * vCell.z - p.y * vCell.w,
            p.x * vCell.w + p.y * vCell.z
          );
          q *= vFlip;
          vec2 cell = clamp(
            vCell.xy + q * uCoreCrop.z,
            uCoreCrop.w,
            1.0 - uCoreCrop.w
          );
          float column = mod(vTile, uGrid.x);
          float row = floor(vTile / uGrid.x);
          vec2 dispersion = vec2(${UNIFIED2.color.coreDispersion.toFixed(4)}, -${(UNIFIED2.color.coreDispersion * 0.58).toFixed(4)})
            * clamp(uDispersion, 0.0, 1.0);
          vec2 cellR = clamp(cell + dispersion, uCoreCrop.w, 1.0 - uCoreCrop.w);
          vec2 cellB = clamp(cell - dispersion, uCoreCrop.w, 1.0 - uCoreCrop.w);
          vec3 sourceR = texture2D(uAtlas, (vec2(column, row) + cellR) / uGrid).rgb;
          vec3 sourceG = texture2D(uAtlas, (vec2(column, row) + cell) / uGrid).rgb;
          vec3 sourceB = texture2D(uAtlas, (vec2(column, row) + cellB) / uGrid).rgb;
          vec3 chromaMask = vec3(
            dot(sourceR, vec3(0.2126, 0.7152, 0.0722)),
            dot(sourceG, vec3(0.2126, 0.7152, 0.0722)),
            dot(sourceB, vec3(0.2126, 0.7152, 0.0722))
          );
          float luminance = dot(sourceG, vec3(0.2126, 0.7152, 0.0722));
          luminance *= smoothstep(uCoreCrop.x, uCoreCrop.x + uCoreCrop.y, luminance);
          chromaMask *= smoothstep(vec3(uCoreCrop.x), vec3(uCoreCrop.x + uCoreCrop.y), chromaMask);

          float sourcePeak = max(sourceG.r, max(sourceG.g, sourceG.b));
          vec3 sourceHue = sourceG / max(sourcePeak, 0.0001);
          float gradient = clamp(length(p) * 0.72 + atan(p.y, p.x) * 0.08, 0.0, 1.0);
          vec3 wavelength = spectralRgb(fract(uHue + gradient * 0.34), 0.82);
          vec3 tone = mix(wavelength, sourceHue, 0.56);
          tone = mix(vec3(1.0), tone, clamp(uDispersion, 0.0, 1.0) * 0.9);
          tone *= mix(vec3(1.0), max(uTint, vec3(0.2)), 0.1);
          vec3 opticalMask = mix(vec3(luminance), chromaMask, 0.18 * uDispersion) * uCore.z;

          // ③ **加算。** 独立コアは常に白。素材だけが緻密な中間色を持つ。
          vec3 light = vec3(ellipse) + tone * opticalMask;

          // ④ 素材側に要る円窓。板の四角い輪郭を消すための掛け算で、輝度は足さない。
          float window = 1.0 - smoothstep(uCore.w, 1.0, length(p));

          // コアの有無は Core size ＝ 板のスケールが決める。
          vec3 color = light * window * max(vLevel, 0.0) * uIntensity;
          gl_FragColor = vec4(max(color, 0.0), 1.0);
        }
      `,
    });

    this.coreGeometry = geometry;
    this.coreMaterial = material;
    this.coreMesh = new THREE.Mesh(geometry, material);
    this.coreMesh.frustumCulled = false;
    // 加算なので順序は絵に影響しないが、膜の後に描いておく。
    this.coreMesh.renderOrder = 1;
  }

  // ---------------------------------------------------------------- 音 → 光

  /** その奥行きでの可視半高（ワールド単位）。カメラは原点で −Z を見る。 */
  private halfHeightAt(depth: number): number {
    const half = Math.tan((UNIFIED2.fieldOfView * Math.PI) / 360) * depth;
    return half / Math.max(this.zoom, 0.01);
  }

  /**
   * **既存の検出器へ 1 フレーム渡す。** 新しい解析はここでも作らない。
   * 確定したイベント 1 個につき、コア 1 個と膜 `Membranes` 枚を生む。
   */
  private detectEvents(elapsed: number, delta: number): void {
    const engine = this.context?.audioEngine;
    const audio = engine?.getParameters() ?? {};
    const spectrum = engine?.getSpectrum?.() ?? null;
    const events = this.detector.update(
      spectrum,
      {
        volume: clamp01(audio.volume ?? 0),
        bass: clamp01(audio.bass ?? 0),
        mid: clamp01(audio.mid ?? 0),
        treble: clamp01(audio.treble ?? 0),
        spectralCentroid: clamp01(audio.centroid ?? 0),
        spectralFlatness: clamp01(audio.flatness ?? 0),
        audioSeed: clamp01(audio.seed ?? 0),
      },
      elapsed,
      delta,
      {
        fluxGain: UNIFIED2.detection.fluxGain,
        onsetSensitivity: clamp01(this.params.sensitivity),
        cooldownSeconds: UNIFIED2.detection.cooldownSeconds,
        relativeStrengthFloor: UNIFIED2.detection.relativeStrengthFloor,
        thresholdScale: UNIFIED2.detection.thresholdScale,
        adaptiveThreshold: true,
        adaptiveStrength: true,
      },
    );
    for (const event of events) this.spawn(event, elapsed);
  }

  /**
   * イベント 1 個から光を生む。**位置はイベント番号のハッシュだけで決まる**ので、
   * 同じ音源なら毎回同じ場所に出る（`Math.random()` は使わない）。
   */
  private spawn(event: BandLightEvent, elapsed: number): void {
    const seed = event.eventIndex;
    const strength = clamp01(event.strength);
    // 起点。コアの奥行きの平面で決め、膜はこれを自分の奥行きへ投影して使う。
    const halfHeight = this.halfHeightAt(UNIFIED2.core.depth);
    const halfWidth = halfHeight * Math.max(this.aspectRatio, 0.01);
    const originX = (hash01(seed, 1.7) * 2 - 1) * halfWidth * UNIFIED2.positionSpread;
    const originY = (hash01(seed, 3.1) * 2 - 1) * halfHeight * UNIFIED2.positionSpread;

    const core: LiveLight = { bornAt: elapsed, seed, strength, originX, originY, slot: 0 };
    if (this.cores.length >= UNIFIED2.maximumLiveCores) this.cores.shift();
    this.cores.push(core);

    const count = Math.round(clamp(this.params.membranes, 3, UNIFIED2.maximumMembranesPerEvent));
    for (let slot = 0; slot < count; slot++) {
      if (this.membranes.length >= UNIFIED2.maximumLiveMembranes) this.membranes.shift();
      this.membranes.push({ bornAt: elapsed, seed, strength, originX, originY, slot });
    }
  }

  /**
   * Persistent Controllerの個体を一度だけ用意する。
   * Event個体とは配列を分け、Persistenceを戻しても既存Eventの寿命を変更しない。
   */
  private ensurePersistentLights(elapsed: number): void {
    if (this.persistentCores.length > 0) return;

    const seed = -1001;
    const halfHeight = this.halfHeightAt(UNIFIED2.core.depth);
    const halfWidth = halfHeight * Math.max(this.aspectRatio, 0.01);
    const originX = (hash01(seed, 1.7) * 2 - 1) * halfWidth * UNIFIED2.positionSpread * 0.35;
    const originY = (hash01(seed, 3.1) * 2 - 1) * halfHeight * UNIFIED2.positionSpread * 0.35;
    this.persistentCores.push({
      bornAt: elapsed,
      seed,
      strength: 1,
      originX,
      originY,
      slot: 0,
      persistent: true,
    });
    for (let slot = 0; slot < UNIFIED2.persistentMembranes; slot++) {
      this.persistentMembranes.push({
        bornAt: elapsed,
        seed,
        strength: 0.72 + hash01(seed, slot + 41) * 0.28,
        originX,
        originY,
        slot,
        persistent: true,
      });
    }
  }

  /** 再生中は光の床を維持し、停止・長い無音ではゆっくり黒へ戻す。 */
  private updatePersistence(delta: number): void {
    const audio = this.context?.audioEngine.getParameters() ?? {};
    const active = audio.active === 1;
    const volume = clamp01(audio.volume ?? 0);
    const persistent = UNIFIED2.persistent;
    this.persistentSilenceSeconds = active && volume <= 0.012
      ? this.persistentSilenceSeconds + Math.max(delta, 0)
      : 0;
    const withinMusicalGap = this.persistentSilenceSeconds <= persistent.silenceHoldSeconds;
    const target = active && withinMusicalGap
      ? persistent.baseLevel + (1 - persistent.baseLevel) * Math.pow(volume, 0.72)
      : 0;
    const seconds = target > this.persistentLevel
      ? persistent.attackSeconds
      : persistent.releaseSeconds;
    const follow = 1 - Math.exp(-Math.max(delta, 0) / Math.max(seconds, 1e-4));
    this.persistentLevel += (target - this.persistentLevel) * follow;

    if (active && this.params.persistence > 0.001) this.ensurePersistentLights(this.previousElapsed);
  }

  /** Persistent個体だけに与える、seedで決まるゆっくりした漂い。 */
  private persistentDrift(
    light: LiveLight,
    elapsed: number,
    halfWidth: number,
    halfHeight: number,
  ): { readonly x: number; readonly y: number } {
    if (!light.persistent) return { x: 0, y: 0 };
    const amount = UNIFIED2.persistent.driftAmount * clamp01(this.params.persistence);
    const phase = hash01(light.seed, light.slot + 71) * Math.PI * 2;
    const phaseY = hash01(light.seed, light.slot + 83) * Math.PI * 2;
    const speed = UNIFIED2.persistent.driftSpeed * (0.75 + hash01(light.seed, light.slot + 97) * 0.5);
    return {
      x: Math.sin(elapsed * speed * Math.PI * 2 + phase) * halfWidth * amount,
      y: Math.cos(elapsed * speed * Math.PI * 1.46 + phaseY) * halfHeight * amount,
    };
  }

  /**
   * Persistent個体の位置と寿命は変えず、素材の選択・切り取り・向きだけを更新する種。
   * `Renewal = 0`では永久に同じ種、1では最大8回/秒で別の光学内容へ切り替わる。
   */
  private renewedAppearanceKey(light: LiveLight, elapsed: number, stableKey: number): number {
    if (!light.persistent) return stableKey;
    const renewal = clamp01(this.params.renewal);
    const rate = UNIFIED2.renewal.maximumRate * Math.pow(renewal, UNIFIED2.renewal.rateCurve);
    const epoch = Math.floor(Math.max(elapsed, 0) * rate);
    return stableKey + epoch * UNIFIED2.renewal.epochStride;
  }

  /** 寿命の切れた光を捨てる。**無音なら 0 個まで落ちる**（＝ 黒）。 */
  private cull(elapsed: number): void {
    const envelope = UNIFIED2.envelope;
    const alive = (list: LiveLight[], attack: number, decay: number): void => {
      let write = 0;
      for (let read = 0; read < list.length; read++) {
        const light = list[read]!;
        if (envelopeLevel(elapsed - light.bornAt, attack, decay) < envelope.cullLevel) continue;
        list[write] = light;
        write += 1;
      }
      list.length = write;
    };
    alive(this.cores, envelope.coreAttackSeconds, envelope.coreDecaySeconds);
    alive(this.membranes, envelope.membraneAttackSeconds, envelope.membraneDecaySeconds);
  }

  /**
   * **色は 1 箇所でしか作らない。**
   *
   * 音色（centroid）と帯域バランス（treble − bass）から色相を作り、1 次遅れで追う。
   * 彩度は軸そのもの（0 = 白 ⇄ 1 = 濃い）。結果はコアと膜が同じ実体を共有する。
   */
  private resolveTint(delta: number): void {
    const audio = this.context?.audioEngine.getParameters() ?? {};
    const centroid = clamp01(audio.centroid ?? 0);
    const tilt = clamp01((clamp01(audio.treble ?? 0) - clamp01(audio.bass ?? 0)) * 0.5 + 0.5);
    const color = UNIFIED2.color;
    const target =
      (color.hueOrigin + centroid * color.centroidSpan + tilt * color.tiltSpan) % 1;
    // 環になっているので近い方向へ回す。0.99 → 0.01 で長い方を回らない。
    let difference = target - this.hue;
    if (difference > 0.5) difference -= 1;
    if (difference < -0.5) difference += 1;
    const follow = 1 - Math.exp(-Math.max(delta, 0) / color.hueTimeConstant);
    this.hue = (this.hue + difference * follow + 1) % 1;

    // 分光。`spectralRgb` と同じ形をそのまま TypeScript で書いたもの。
    const saturation = clamp01(this.params.saturation);
    const channel = (offset: number): number => {
      const phase = ((this.hue + offset) % 1) * 6;
      const value = clamp01(Math.min(phase, 4 - phase));
      return 1 - saturation * (1 - value);
    };
    this.tint.setRGB(channel(0), channel(0.6666667), channel(0.3333333));
  }

  /**
   * 生きている光をインスタンス属性へ書き出す。
   * 見え方のばらつきはすべて `seed`（イベント番号）と `slot` のハッシュから引くので、
   * 同じ音源・同じつまみなら毎回同じ絵になる。
   */
  private writeLights(elapsed: number): void {
    const envelope = UNIFIED2.envelope;
    const persistence = clamp01(this.params.persistence);
    const eventWeight = 1 - persistence;

    // ---- 膜 ----
    if (this.geometry) {
      const cropHalf = mix(UNIFIED2.cropNarrow, UNIFIED2.cropWide, clamp01(this.params.crop));
      const scale = mix(UNIFIED2.scaleSmall, UNIFIED2.scaleLarge, clamp01(this.params.scale));
      // **Spatial Spread。** 0 = 起点へ集中 ⇄ 1 = 3D空間へ分散・重畳。
      // 位置と奥行きを同じ意味で動かし、Core Presenceなど他の見え方は変えない。
      const spatialSpread = clamp01(this.params.spatialSpread);
      const lights = [...this.persistentMembranes, ...this.membranes];
      const count = this.atlas ? lights.length : 0;
      const tileCount = Math.max(this.atlas?.tiles.length ?? 1, 1);

      for (let index = 0; index < count; index++) {
        const light = lights[index]!;
        const key = light.seed * 16 + light.slot;
        const appearanceKey = this.renewedAppearanceKey(light, elapsed, key);
        const scatteredDepth = mix(UNIFIED2.depthNear, UNIFIED2.depthFar, hash01(key, 11.3));
        const depth = mix(UNIFIED2.core.depth, scatteredDepth, spatialSpread);
        const halfHeight = this.halfHeightAt(depth);
        const halfWidth = halfHeight * Math.max(this.aspectRatio, 0.01);

        // 散る側の位置と、起点をこの奥行きへ投影した位置。連続に混ぜる。
        const scatterX = (hash01(key, 1.7) * 2 - 1) * halfWidth * UNIFIED2.positionSpread;
        const scatterY = (hash01(key, 3.1) * 2 - 1) * halfHeight * UNIFIED2.positionSpread;
        const projection = depth / UNIFIED2.core.depth;
        const drift = this.persistentDrift(light, elapsed, halfWidth, halfHeight);
        this.offsets[index * 3 + 0] = mix(
          light.originX * projection,
          scatterX,
          spatialSpread,
        ) + drift.x;
        this.offsets[index * 3 + 1] = mix(
          light.originY * projection,
          scatterY,
          spatialSpread,
        ) + drift.y;
        this.offsets[index * 3 + 2] = -depth;

        // 板の縦横比。**細長い板が素材の線を異方的に引き伸ばす**（筋はこの副産物）。
        const elongation = mix(
          UNIFIED2.elongationMinimum,
          UNIFIED2.elongationMaximum,
          hash01(key, 5.9),
        );
        const jitter = 1 + (hash01(key, 7.3) * 2 - 1) * UNIFIED2.sizeJitter;
        const radius = halfHeight * scale * jitter;
        this.sizes[index * 3 + 0] = radius * Math.sqrt(elongation);
        this.sizes[index * 3 + 1] = radius / Math.sqrt(elongation);
        this.sizes[index * 3 + 2] =
          Math.floor(hash01(appearanceKey, 13.7) * tileCount) % tileCount;

        // 切り取りの中心。半幅を差し引いた範囲に収めて、マスの外へは出さない。
        const room = Math.max(0.5 - cropHalf, 0);
        this.crops[index * 4 + 0] =
          0.5 + (hash01(appearanceKey, 17.1) * 2 - 1) * room;
        this.crops[index * 4 + 1] =
          0.5 + (hash01(appearanceKey, 19.3) * 2 - 1) * room;
        this.crops[index * 4 + 2] = cropHalf;
        this.crops[index * 4 + 3] = cropHalf;

        const spin = hash01(appearanceKey, 23.9) * Math.PI * 2;
        this.orients[index * 4 + 0] = Math.cos(spin);
        this.orients[index * 4 + 1] = Math.sin(spin);
        this.orients[index * 4 + 2] = hash01(appearanceKey, 29.5) < 0.5 ? -1 : 1;
        this.orients[index * 4 + 3] = hash01(appearanceKey, 31.1) < 0.5 ? -1 : 1;

        const eventLevel = envelopeLevel(
            elapsed - light.bornAt,
            envelope.membraneAttackSeconds,
            envelope.membraneDecaySeconds,
          ) * light.strength;
        this.levels[index] = light.persistent
          ? this.persistentLevel * persistence * light.strength
          : eventLevel * eventWeight;
      }
      this.geometry.instanceCount = count;
      for (const attribute of Object.values(this.attributes)) attribute.needsUpdate = true;
    }

    // ---- コア ----
    if (this.coreGeometry) {
      const core = UNIFIED2.core;
      const baseRadius =
        this.halfHeightAt(core.depth) *
        mix(core.sizeSmall, core.sizeLarge, clamp01(this.params.coreSize));
      const lights = [...this.persistentCores, ...this.cores];
      const count = this.atlas ? lights.length : 0;
      const tileCount = Math.max(this.atlas?.tiles.length ?? 1, 1);
      const room = Math.max(0.5 - core.cropHalf, 0);

      for (let index = 0; index < count; index++) {
        const light = lights[index]!;
        const seed = light.seed;
        const appearanceSeed = this.renewedAppearanceKey(light, elapsed, seed);
        const halfHeight = this.halfHeightAt(core.depth);
        const halfWidth = halfHeight * Math.max(this.aspectRatio, 0.01);
        const drift = this.persistentDrift(light, elapsed, halfWidth, halfHeight);
        this.coreOffsets[index * 3 + 0] = light.originX + drift.x;
        this.coreOffsets[index * 3 + 1] = light.originY + drift.y;
        this.coreOffsets[index * 3 + 2] = -core.depth;

        // **Core size = 0 なら半径 0 ＝ 板が潰れて 1 画素も描かれない。**
        const jitter = 1 + (hash01(seed, core.seedSalt + 5.3) * 2 - 1) * core.sizeJitter;
        this.coreSizes[index * 2 + 0] = baseRadius * jitter;
        this.coreSizes[index * 2 + 1] =
          Math.floor(hash01(appearanceSeed, core.seedSalt) * tileCount) % tileCount;

        const spin = hash01(appearanceSeed, core.seedSalt + 2.7) * Math.PI * 2;
        this.coreCells[index * 4 + 0] =
          0.5 + (hash01(appearanceSeed, core.seedSalt + 1.3) * 2 - 1) * room;
        this.coreCells[index * 4 + 1] =
          0.5 + (hash01(appearanceSeed, core.seedSalt + 1.9) * 2 - 1) * room;
        this.coreCells[index * 4 + 2] = Math.cos(spin);
        this.coreCells[index * 4 + 3] = Math.sin(spin);
        this.coreFlips[index * 2 + 0] =
          hash01(appearanceSeed, core.seedSalt + 3.1) < 0.5 ? -1 : 1;
        this.coreFlips[index * 2 + 1] =
          hash01(appearanceSeed, core.seedSalt + 3.7) < 0.5 ? -1 : 1;

        const eventLevel = envelopeLevel(
            elapsed - light.bornAt,
            envelope.coreAttackSeconds,
            envelope.coreDecaySeconds,
          ) * light.strength;
        this.coreLevels[index] = light.persistent
          ? this.persistentLevel * persistence
          : eventLevel * eventWeight;
      }
      this.coreGeometry.instanceCount = count;
      for (const attribute of Object.values(this.coreAttributes)) attribute.needsUpdate = true;
    }
  }

  /** 軸のうち、フラグメント側の数式へ直に効くもの。毎フレーム流し込む。 */
  private syncUniforms(): void {
    const intensity = Math.max(this.commonResolver.valueOf('intensity'), 0);
    const material = this.material;
    if (material) {
      const softness = clamp01(this.params.softness);
      const carve = clamp01(this.params.carve);
      (material.uniforms.uShape!.value as THREE.Vector4).set(
        mix(UNIFIED2.windowLoose, UNIFIED2.windowTight, carve),
        mix(UNIFIED2.floorSharp, UNIFIED2.floorFoggy, softness),
        mix(UNIFIED2.floorWidthSharp, UNIFIED2.floorWidthFoggy, softness),
        mix(UNIFIED2.gammaSharp, UNIFIED2.gammaFoggy, softness),
      );
      material.uniforms.uIntensity!.value = intensity;
      material.uniforms.uHue!.value = this.hue;
      material.uniforms.uDispersion!.value = clamp01(this.params.saturation);
    }

    const core = this.coreMaterial;
    if (core) {
      // 構造の軸。0で素材だけ、1で独立した手続きの芯が満額で加わる。
      // **コアの有無はここでは決めない**（大きさが決める）。
      (core.uniforms.uCore!.value as THREE.Vector4).x = clamp01(this.params.corePresence);
      core.uniforms.uIntensity!.value = intensity;
      core.uniforms.uHue!.value = this.hue;
      core.uniforms.uDispersion!.value = clamp01(this.params.saturation);
    }
  }

  update(elapsed: number): void {
    const delta =
      this.previousElapsed < 0
        ? 0
        : clamp(elapsed - this.previousElapsed, 0, UNIFIED2.maximumDelta);
    this.previousElapsed = elapsed;

    // 音の棚はengineごとに共有され、同一フレーム内では一度だけ更新される。
    this.sourceShelf?.update(delta);
    this.commonResolver.updateParam('intensity', delta);

    // **捨てるのが先。** 生まれた瞬間の光は age = 0 ＝ 振幅 0 なので、
    // 検出のあとに捨てると生まれたそばから消えてしまう。
    this.updatePersistence(delta);
    this.cull(elapsed);
    this.detectEvents(elapsed, delta);
    this.resolveTint(delta);
    this.syncUniforms();
    this.writeLights(elapsed);

    const audio = this.context?.audioEngine.getParameters() ?? {};
    this.updateHazeStudy(clamp01(audio.volume ?? 0), delta);
    this.updateFragmentStudy(clamp01(audio.volume ?? 0), delta);
    this.updateLab2CoreStudy();
    if (this.lab2AssemblyPreview !== 'off') this.lab2Assembly?.update(elapsed);
    if (this.spatialRecoveryPreview !== 'off') this.spatialRecovery?.update(elapsed);
    if (this.reactiveRecoveryPreview !== 'off') this.reactiveRecovery?.update(elapsed);
    this.pipeline?.update(audio, elapsed);
  }

  private assemblyOpticalGroup(): OpticalGroup {
    if (this.lab2AssemblyPreview === 'core') return 'core';
    if (this.lab2AssemblyPreview === 'cross-ray') return 'skeleton';
    if (this.lab2AssemblyPreview === 'refraction-veil') return 'fragment';
    if (this.lab2AssemblyPreview === 'fan-spill') return 'fan';
    if (this.lab2AssemblyPreview === 'haze-curtain') return 'atmosphere';
    return 'all';
  }

  private syncLab2Assembly(): void {
    this.lab2Assembly?.setAssemblyControls({
      coreLevel: this.lab2AssemblyLevels.core,
      crossRayLevel: this.lab2AssemblyLevels.crossRay,
      fragmentLevel: this.lab2AssemblyLevels.fragment,
      fanSpillLevel: this.lab2AssemblyLevels.fanSpill,
      hazeCurtainLevel: this.lab2AssemblyLevels.hazeCurtain,
      globalIntensity: this.lab2AssemblyLevels.globalIntensity,
    });
    this.lab2Assembly?.setAssemblyView(
      this.assemblyOpticalGroup(),
      [this.lab2AssemblyRgb.x, this.lab2AssemblyRgb.y, this.lab2AssemblyRgb.z],
    );
  }

  /**
   * 共通値1で各ドナー本来の光量を保ち、0..2を同じ相対倍率として渡す。
   * ドナー固有の露出・Bloom・層ごとの濃度は変更しない。
   */
  private syncCommonIntensity(): void {
    const factor = clamp(
      this.params.intensity / Math.max(UNIFIED2.defaults.intensity, 1e-4),
      0,
      2,
    );
    this.lab2AssemblyLevels.globalIntensity = factor;
    this.syncLab2Assembly();
    this.spatialRecovery?.setExpressionParam('intensity', 2.2 * factor);
    this.reactiveRecovery?.setExpressionParam('intensity', 2 * factor);
  }

  /** Recoveryは比較用の一時表示なので、UI上も常に1つだけを選ぶ。 */
  private activeRecoveryPreview(): RecoveryPreview {
    if (this.reactiveRecoveryPreview !== 'off') return 'reactive-audio';
    if (this.spatialRecoveryPreview === 'audio') return 'spatial-audio';
    if (this.spatialRecoveryPreview === 'freeze') return 'spatial-freeze';
    if (this.lab2AssemblyPreview !== 'off') return 'lab2-all';
    return 'off';
  }

  /** 現在値が開始座標と一致するときだけ、その名前を表示する。 */
  private activeAnchorPreset(): LightAnchorPreset {
    const epsilon = 0.001;
    for (const [name, coordinates] of Object.entries(LIGHT_ANCHOR_PRESETS)) {
      if (
        Math.abs(this.params.corePresence - coordinates.corePresence) <= epsilon
        && Math.abs(this.params.spatialSpread - coordinates.spatialSpread) <= epsilon
        && Math.abs(this.params.persistence - coordinates.persistence) <= epsilon
        && Math.abs(this.params.renewal - coordinates.renewal) <= epsilon
      ) return name as Exclude<LightAnchorPreset, 'custom'>;
    }
    return 'custom';
  }

  /** Recovery比較を閉じ、同じ描画構造の4軸だけを開始座標へ戻す。 */
  private applyAnchorPreset(preset: Exclude<LightAnchorPreset, 'custom'>): void {
    Object.assign(this.params, LIGHT_ANCHOR_PRESETS[preset]);
    this.reactiveRecoveryPreview = 'off';
    this.spatialRecoveryPreview = 'off';
    this.spatialRecovery?.setRecoveryMode(null);
    this.lab2AssemblyPreview = 'off';
    this.syncLab2Assembly();
  }

  /** Study中は既存レイヤーを描画せず、静止Coreだけを黒背景に表示する。 */
  private updateLab2CoreStudy(): void {
    const lab2FragmentActive = this.lab2FragmentStudyPreview !== 'off';
    const lab2Active = this.lab2CoreStudyPreview === 'static'
      || this.lab2FragmentStudyPreview === 'with-core';
    const spatialFragmentActive = this.spatialFragmentStudyPreview !== 'off';
    const spatialActive = this.spatialMaterialAnchorPreview === 'static'
      || this.spatialFragmentStudyPreview === 'with-anchor';
    const isolated = lab2Active || lab2FragmentActive || spatialActive || spatialFragmentActive;
    if (this.lab2CoreStudyMesh) this.lab2CoreStudyMesh.visible = lab2Active;
    if (this.lab2CoreStudyMaterial) {
      (this.lab2CoreStudyMaterial.uniforms.uRgb!.value as THREE.Vector3).copy(this.lab2CoreRgb);
    }
    if (this.lab2FragmentStudyMesh) {
      this.lab2FragmentStudyMesh.visible = lab2FragmentActive;
    }
    if (this.spatialMaterialAnchorMesh) this.spatialMaterialAnchorMesh.visible = spatialActive;
    if (this.spatialFragmentStudyMesh) {
      this.spatialFragmentStudyMesh.visible = spatialFragmentActive;
    }
    if (this.mesh) this.mesh.visible = !isolated;
    if (this.coreMesh) this.coreMesh.visible = !isolated;
    if (this.hazeMesh) this.hazeMesh.visible = !isolated && this.hazePreview !== 'off';
    if (this.fragmentMesh) {
      this.fragmentMesh.visible = !isolated && this.fragmentPreview !== 'off';
    }
  }

  /** 靄の第 2 段。連続した音量だけを明るさへ繋ぎ、形・位置・色はまだ動かさない。 */
  private updateHazeStudy(volume: number, delta: number): void {
    if (!this.hazeMesh || !this.hazeMaterial) return;
    this.hazeMesh.visible = this.hazePreview !== 'off';
    if (this.hazePreview === 'off') return;

    if (this.hazePreview === 'static') {
      this.hazeLevel = 1;
    } else {
      const seconds = volume > this.hazeLevel
        ? UNIFIED2.hazeStudy.attackSeconds
        : UNIFIED2.hazeStudy.releaseSeconds;
      const follow = 1 - Math.exp(-Math.max(delta, 0) / Math.max(seconds, 1e-4));
      this.hazeLevel += (volume - this.hazeLevel) * follow;
    }
    this.hazeMaterial.uniforms.uIntensity!.value =
      UNIFIED2.hazeStudy.intensity * this.hazeLevel * this.commonResolver.valueOf('intensity');
  }

  /** Fragmentの第2段。形・位置・色を固定し、Volumeを明るさだけへ接続する。 */
  private updateFragmentStudy(volume: number, delta: number): void {
    if (!this.fragmentMesh || !this.fragmentMaterial) return;
    this.fragmentMesh.visible = this.fragmentPreview !== 'off';
    if (this.fragmentPreview === 'off') return;

    if (this.fragmentPreview === 'static') {
      this.fragmentLevel = 1;
    } else {
      const seconds = volume > this.fragmentLevel
        ? UNIFIED2.fragmentStudy.attackSeconds
        : UNIFIED2.fragmentStudy.releaseSeconds;
      const follow = 1 - Math.exp(-Math.max(delta, 0) / Math.max(seconds, 1e-4));
      this.fragmentLevel += (volume - this.fragmentLevel) * follow;
    }
    this.fragmentMaterial.uniforms.uIntensity!.value =
      UNIFIED2.fragmentStudy.intensity * this.fragmentLevel * this.commonResolver.valueOf('intensity');
  }

  render(): void {
    if (this.reactiveRecoveryPreview !== 'off') {
      this.reactiveRecovery?.render();
      return;
    }
    if (this.spatialRecoveryPreview !== 'off') {
      this.spatialRecovery?.render();
      return;
    }
    if (this.lab2AssemblyPreview !== 'off') {
      this.lab2Assembly?.render();
      return;
    }
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    const ratio = Math.max(width / Math.max(height, 1), 0.01);
    if (this.camera) {
      this.camera.aspect = ratio;
      this.camera.updateProjectionMatrix();
    }
    this.pipeline?.resize(width, height);
    this.lab2Assembly?.resize(width, height);
    this.spatialRecovery?.resize(width, height);
    this.reactiveRecovery?.resize(width, height);
  }

  // ---------------------------------------------------------------- UI の面

  setGeneratorsVisible(visible: boolean): void {
    if (this.scene) this.scene.visible = visible;
    this.lab2Assembly?.setGeneratorsVisible(visible);
  }

  setDesignLayerCanvases(canvases: DesignLayerCanvases): void {
    this.pipeline?.setOverlayCanvases(canvases);
  }

  updateDesignLayerCanvases(): void {
    this.pipeline?.updateOverlayCanvases();
  }

  getEffects(): readonly Effect[] {
    return this.effects;
  }

  moveEffect(effect: Effect, direction: -1 | 1): void {
    this.pipeline?.move(effect, direction);
  }

  setEffectOrder(names: string[]): void {
    this.pipeline?.setOrder(names);
  }

  getTheme(): Theme {
    return this.theme;
  }

  setTheme(theme: Theme): void {
    // 黒背景固定。色は音から作った色相と彩度の軸だけで決まる。
    this.theme = theme;
  }

  usesTheme(): boolean {
    return false;
  }

  getZoom(): number {
    return this.zoom;
  }

  setZoom(zoom: number): void {
    this.zoom = clamp(zoom, 0.5, 2);
    if (this.camera) {
      this.camera.zoom = this.zoom;
      this.camera.updateProjectionMatrix();
    }
    this.lab2Assembly?.setZoom(this.zoom);
    this.spatialRecovery?.setZoom(this.zoom);
    this.reactiveRecovery?.setZoom(this.zoom);
  }

  getResponse(): { bass: number; mid: number; treble: number } {
    return { ...this.response };
  }

  setResponse(gains: Partial<{ bass: number; mid: number; treble: number }>): void {
    // 帯域ごとの重みはまだ繋いでいない。保存の往復のために保持だけする。
    this.response = {
      bass: gains.bass ?? this.response.bass,
      mid: gains.mid ?? this.response.mid,
      treble: gains.treble ?? this.response.treble,
    };
  }

  getAspectId(): string {
    return this.aspectId;
  }

  getAspectRatio(): number {
    return this.aspectRatio;
  }

  setAspect(id: string, ratio: number): void {
    this.aspectId = id;
    this.aspectRatio = ratio;
    if (this.camera) {
      this.camera.aspect = ratio;
      this.camera.updateProjectionMatrix();
    }
    this.lab2Assembly?.setAspect(id, ratio);
    this.spatialRecovery?.setAspect(id, ratio);
    this.reactiveRecovery?.setAspect(id, ratio);
  }

  setDebugView(view: number): void {
    void view;
  }

  getDebugState(): null {
    return null;
  }

  getDepth(): number {
    return 0;
  }

  setDepth(amount: number): void {
    void amount;
  }

  /** 開発用の読み出し。**無音で 0 / 0 になる**ことがそのまま D5 の確認になる。 */
  getPhase(): string {
    return `cores ${this.cores.length} / membranes ${this.membranes.length} / hue ${this.hue.toFixed(2)}`;
  }

  /**
   * **開発用の軸。**
   *
   * 「Spatial 的 ⇄ Reactive 的 ⇄ Lab2 的」の質感の差を作れるだけの本数に絞る。
   * すべて連続な混合係数で、`if (axis > 0.5)` のような分岐はどこにも無い。
   */
  getExpressionParams(): ExpressionParam[] {
    const row = (
      key: Unified2ParamKey,
      label: string,
      group: string,
    ): ExpressionParam => {
      const parameter: ExpressionParam = {
        key,
        label,
        group,
        ...PARAM_RANGES[key],
        value: this.params[key],
      };
      if (key !== 'intensity') return parameter;
      const binding = this.commonResolver.getBinding('intensity');
      return {
        ...parameter,
        bind: {
          paramId: 'intensity',
          sourceId: binding?.sourceId ?? null,
          depth: binding?.depth ?? 0.25,
          sources: (this.sourceShelf?.visible() ?? []).map((source) => ({
            id: source.id,
            label: source.label,
            kind: source.kind,
          })),
          liveValue: this.commonResolver.valueOf('intensity'),
        },
      };
    };
    const membrane = '膜（素材が形）';
    const seamless = 'Seamless / Structure';
    const elements = 'Elements / Advanced';
    const common = 'Common';
    const unifiedSpecific = 'Light Unified 2 / Color & Trigger';
    const study = 'Study preview';
    const recovery = 'Development / Recovery';
    const params: ExpressionParam[] = [
      {
        key: 'anchorPreset',
        label: 'Start point',
        type: 'select',
        presentation: 'buttons',
        group: seamless,
        options: [
          { value: 'spatial', label: 'Spatial' },
          { value: 'reactive', label: 'Reactive' },
          { value: 'lab2', label: 'Lab2' },
          { value: 'drift', label: 'Drift' },
          { value: 'custom', label: 'Custom' },
        ],
        value: this.activeAnchorPreset(),
      },
      {
        key: 'recoveryPreview',
        label: 'Recovery preset',
        type: 'select',
        presentation: 'buttons',
        group: recovery,
        options: [
          { value: 'off', label: 'Off' },
          { value: 'reactive-audio', label: 'Reactive' },
          { value: 'spatial-audio', label: 'Spatial Audio' },
          { value: 'spatial-freeze', label: 'Spatial Freeze' },
          { value: 'lab2-all', label: 'Lab2 All' },
        ],
        value: this.activeRecoveryPreview(),
      },
      {
        key: 'lab2AssemblyCoreLevel',
        label: 'Core Level',
        group: recovery,
        min: 0,
        max: 2,
        step: 0.01,
        value: this.lab2AssemblyLevels.core,
      },
      {
        key: 'lab2AssemblyCrossRayLevel',
        label: 'Cross Ray Level',
        group: recovery,
        min: 0,
        max: 2,
        step: 0.01,
        value: this.lab2AssemblyLevels.crossRay,
      },
      {
        key: 'lab2AssemblyFragmentLevel',
        label: 'Fragment Level',
        group: recovery,
        min: 0,
        max: 2,
        step: 0.01,
        value: this.lab2AssemblyLevels.fragment,
      },
      {
        key: 'lab2AssemblyFanSpillLevel',
        label: 'Fan / Spill Level',
        group: recovery,
        min: 0,
        max: 2,
        step: 0.01,
        value: this.lab2AssemblyLevels.fanSpill,
      },
      {
        key: 'lab2AssemblyHazeCurtainLevel',
        label: 'Haze / Curtain Level',
        group: recovery,
        min: 0,
        max: 2,
        step: 0.01,
        value: this.lab2AssemblyLevels.hazeCurtain,
      },
      {
        key: 'lab2AssemblyRed',
        label: 'Assembly R (static)',
        group: recovery,
        min: 0,
        max: 1,
        step: 0.01,
        value: this.lab2AssemblyRgb.x,
      },
      {
        key: 'lab2AssemblyGreen',
        label: 'Assembly G (static)',
        group: recovery,
        min: 0,
        max: 1,
        step: 0.01,
        value: this.lab2AssemblyRgb.y,
      },
      {
        key: 'lab2AssemblyBlue',
        label: 'Assembly B (static)',
        group: recovery,
        min: 0,
        max: 1,
        step: 0.01,
        value: this.lab2AssemblyRgb.z,
      },
      {
        key: 'spatialMaterialAnchorPreview',
        label: 'Spatial Material Anchor Study',
        group: study,
        type: 'select',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'static', label: 'Static' },
        ],
        value: this.spatialMaterialAnchorPreview,
      },
      {
        key: 'spatialFragmentStudyPreview',
        label: 'Spatial Fragment Study (静止確認)',
        group: study,
        type: 'select',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'static', label: 'Fragment only' },
          { value: 'with-anchor', label: 'With Spatial Anchor' },
        ],
        value: this.spatialFragmentStudyPreview,
      },
      {
        key: 'lab2CoreStudyPreview',
        label: 'Lab2 Core Study (静止確認)',
        group: study,
        type: 'select',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'static', label: 'Static' },
        ],
        value: this.lab2CoreStudyPreview,
      },
      {
        key: 'lab2CoreRed',
        label: 'Lab2 Core R (static)',
        group: study,
        min: 0,
        max: 1,
        step: 0.01,
        value: this.lab2CoreRgb.x,
      },
      {
        key: 'lab2CoreGreen',
        label: 'Lab2 Core G (static)',
        group: study,
        min: 0,
        max: 1,
        step: 0.01,
        value: this.lab2CoreRgb.y,
      },
      {
        key: 'lab2CoreBlue',
        label: 'Lab2 Core B (static)',
        group: study,
        min: 0,
        max: 1,
        step: 0.01,
        value: this.lab2CoreRgb.z,
      },
      {
        key: 'lab2FragmentStudyPreview',
        label: 'Lab2 Fragment Study (静止確認)',
        group: study,
        type: 'select',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'static', label: 'Fragment only' },
          { value: 'with-core', label: 'With Lab2 Core' },
        ],
        value: this.lab2FragmentStudyPreview,
      },
      {
        key: 'lab2FragmentPattern',
        label: 'Lab2 Fragment Pattern',
        group: study,
        type: 'select',
        options: [
          { value: 'cluster', label: 'Core cluster' },
          { value: 'scatter', label: 'Full scatter' },
          { value: 'radial', label: 'Radial' },
          { value: 'asymmetric', label: 'Asymmetric' },
        ],
        value: this.lab2FragmentPattern,
      },
      {
        key: 'lab2FragmentSeed',
        label: 'Lab2 Fragment Seed',
        group: study,
        min: 0,
        max: 99,
        step: 1,
        value: this.lab2FragmentSeed,
      },
      {
        key: 'hazePreview',
        label: 'Haze (音なし静止確認)',
        group: study,
        type: 'select',
        options: [
          { value: 'static', label: 'Static' },
          { value: 'audio', label: 'Audio volume' },
          { value: 'off', label: 'Off' },
        ],
        value: this.hazePreview,
      },
      {
        key: 'fragmentPreview',
        label: 'Fragment / Particle (静止確認)',
        group: study,
        type: 'select',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'static', label: 'Static' },
          { value: 'audio', label: 'Audio volume' },
        ],
        value: this.fragmentPreview,
      },
      row('crop', 'Crop (狭い＝素材の線が筋になる ⇄ 広い＝細かい濃淡)', membrane),
      row('scale', 'Scale (小さい ⇄ 画面より大きい)', membrane),
      row('softness', 'Softness (鋭い＝明部だけ残る ⇄ 霧状＝暗部まで一様)', membrane),
      row('carve', 'Carve (緩いビネット＝素材が形 ⇄ 硬い円窓＝外形で切る)', membrane),
      row('membranes', 'Membranes (1 打撃で生む枚数)', membrane),
      row('corePresence', 'Core Presence (素材白熱 ⇄ 独立コア)', seamless),
      row('spatialSpread', 'Spatial Spread (起点へ集中 ⇄ 3D空間へ分散)', seamless),
      row('persistence', 'Persistence (発生して消える ⇄ 常在して漂う)', seamless),
      row('renewal', 'Renewal (同じ素材を維持 ⇄ 光学内容を短周期更新)', seamless),
      row('coreSize', 'Core Layer Size (0 = 層全体を消す ⇄ 大)', elements),
      row('intensity', 'Global Intensity', common),
      row('saturation', 'Saturation (0 = 白 ⇄ 1 = 色が濃い)', unifiedSpecific),
      row('sensitivity', 'Sensitivity (発火の感度)', unifiedSpecific),
    ];
    return params.filter((param) => param.group !== study);
  }

  setExpressionParam(key: string, value: number | string): void {
    // Commonの最初の音接続。既存のIntensity行へ添え、UIの行数は増やさない。
    if (key.startsWith('bind:intensity:')) {
      const what = key.split(':')[2];
      const current = this.commonResolver.getBinding('intensity');
      if (what === 'source') {
        const sourceId = String(value) === 'none' ? null : String(value);
        const source = sourceId ? this.sourceShelf?.find(sourceId) ?? null : null;
        this.commonResolver.bind({
          paramId: 'intensity',
          sourceId,
          depth: current?.depth ?? 0.25,
          transform: source ? defaultTransformFor(source.kind, 'continuous') : null,
        });
        return;
      }
      if (what === 'depth') {
        const depth = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(depth)) return;
        this.commonResolver.bind({
          paramId: 'intensity',
          sourceId: current?.sourceId ?? null,
          depth: clamp(depth, -1, 1),
          transform: current?.transform ?? null,
        });
        return;
      }
    }
    // 旧Core formは向きが逆だった。保存済みプリセットだけを新しい意味へ変換する。
    if (key === 'coreForm' && typeof value === 'number') {
      this.params.corePresence = 1 - clamp01(value);
      return;
    }
    // 旧Anchorは向きが逆だった。保存済みプリセットをSpatial Spreadへ移行する。
    if (key === 'anchor' && typeof value === 'number') {
      this.params.spatialSpread = 1 - clamp01(value);
      return;
    }
    if (
      key === 'anchorPreset'
      && typeof value === 'string'
      && value !== 'custom'
      && value in LIGHT_ANCHOR_PRESETS
    ) {
      this.applyAnchorPreset(value as Exclude<LightAnchorPreset, 'custom'>);
      return;
    }
    if (key === 'recoveryPreview' && typeof value === 'string') {
      const allowed: readonly RecoveryPreview[] = [
        'off',
        'reactive-audio',
        'spatial-audio',
        'spatial-freeze',
        'lab2-core',
        'lab2-cross-ray',
        'lab2-refraction-veil',
        'lab2-fan-spill',
        'lab2-haze-curtain',
        'lab2-all',
      ];
      if (!allowed.includes(value as RecoveryPreview)) return;

      this.reactiveRecoveryPreview = value === 'reactive-audio' ? 'audio' : 'off';
      this.spatialRecoveryPreview = value === 'spatial-audio'
        ? 'audio'
        : value === 'spatial-freeze'
          ? 'freeze'
          : 'off';
      this.spatialRecovery?.setRecoveryMode(
        this.spatialRecoveryPreview === 'off' ? null : this.spatialRecoveryPreview,
      );
      // 過去の部品別値を読み込んだ場合も、現在のUIではAllへ集約する。
      this.lab2AssemblyPreview = value.startsWith('lab2-') ? 'all' : 'off';
      this.syncLab2Assembly();
      return;
    }
    if (
      key === 'reactiveRecoveryPreview'
      && typeof value === 'string'
      && ['off', 'audio'].includes(value)
    ) {
      this.reactiveRecoveryPreview = value as ReactiveRecoveryPreview;
      if (value !== 'off') {
        this.spatialRecoveryPreview = 'off';
        this.spatialRecovery?.setRecoveryMode(null);
        this.lab2AssemblyPreview = 'off';
        this.syncLab2Assembly();
      }
      return;
    }
    if (
      key === 'spatialRecoveryPreview'
      && typeof value === 'string'
      && ['off', 'audio', 'freeze'].includes(value)
    ) {
      this.spatialRecoveryPreview = value as SpatialRecoveryPreview;
      this.spatialRecovery?.setRecoveryMode(value === 'off' ? null : value as SpatialRecoveryMode);
      if (value !== 'off') {
        this.reactiveRecoveryPreview = 'off';
        this.lab2AssemblyPreview = 'off';
        this.syncLab2Assembly();
      }
      return;
    }
    if (
      key === 'lab2AssemblyPreview'
      && typeof value === 'string'
      && ['off', 'core', 'cross-ray', 'refraction-veil', 'fan-spill', 'haze-curtain', 'all'].includes(value)
    ) {
      this.lab2AssemblyPreview = value as Lab2AssemblyPreview;
      if (value !== 'off') {
        this.reactiveRecoveryPreview = 'off';
        this.spatialRecoveryPreview = 'off';
        this.spatialRecovery?.setRecoveryMode(null);
      }
      this.syncLab2Assembly();
      return;
    }
    if (typeof value === 'number') {
      if (key === 'lab2AssemblyGlobalIntensity') {
        this.params.intensity = clamp(value, PARAM_RANGES.intensity.min, PARAM_RANGES.intensity.max);
        this.syncCommonIntensity();
        return;
      }
      const assemblyLevelKey = {
        lab2AssemblyCoreLevel: 'core',
        lab2AssemblyCrossRayLevel: 'crossRay',
        lab2AssemblyFragmentLevel: 'fragment',
        lab2AssemblyFanSpillLevel: 'fanSpill',
        lab2AssemblyHazeCurtainLevel: 'hazeCurtain',
      } as const;
      const target = assemblyLevelKey[key as keyof typeof assemblyLevelKey];
      if (target) {
        this.lab2AssemblyLevels[target] = clamp(value, 0, 2);
        this.syncLab2Assembly();
        return;
      }
    }
    if (
      (key === 'lab2AssemblyRed' || key === 'lab2AssemblyGreen' || key === 'lab2AssemblyBlue')
      && typeof value === 'number'
    ) {
      const channel = key === 'lab2AssemblyRed' ? 'x' : key === 'lab2AssemblyGreen' ? 'y' : 'z';
      this.lab2AssemblyRgb[channel] = clamp01(value);
      this.syncLab2Assembly();
      return;
    }
    if (
      (key === 'lab2CoreRed' || key === 'lab2CoreGreen' || key === 'lab2CoreBlue')
      && typeof value === 'number'
    ) {
      const channel = key === 'lab2CoreRed' ? 'x' : key === 'lab2CoreGreen' ? 'y' : 'z';
      this.lab2CoreRgb[channel] = clamp01(value);
      this.updateLab2CoreStudy();
      return;
    }
    if (key === 'spatialMaterialAnchorPreview' && (value === 'off' || value === 'static')) {
      this.spatialMaterialAnchorPreview = value;
      if (value === 'static') {
        this.lab2CoreStudyPreview = 'off';
        this.lab2FragmentStudyPreview = 'off';
        this.spatialFragmentStudyPreview = 'off';
      }
      this.updateLab2CoreStudy();
      return;
    }
    if (key === 'lab2CoreStudyPreview' && (value === 'off' || value === 'static')) {
      this.lab2CoreStudyPreview = value;
      if (value === 'static') {
        this.spatialMaterialAnchorPreview = 'off';
        this.spatialFragmentStudyPreview = 'off';
        this.lab2FragmentStudyPreview = 'off';
      }
      this.updateLab2CoreStudy();
      return;
    }
    if (
      key === 'lab2FragmentStudyPreview'
      && (value === 'off' || value === 'static' || value === 'with-core')
    ) {
      this.lab2FragmentStudyPreview = value;
      if (value !== 'off') {
        this.spatialMaterialAnchorPreview = 'off';
        this.spatialFragmentStudyPreview = 'off';
        this.lab2CoreStudyPreview = 'off';
      }
      this.updateLab2CoreStudy();
      return;
    }
    if (
      key === 'spatialFragmentStudyPreview'
      && (value === 'off' || value === 'static' || value === 'with-anchor')
    ) {
      this.spatialFragmentStudyPreview = value;
      if (value !== 'off') {
        this.spatialMaterialAnchorPreview = 'off';
        this.lab2CoreStudyPreview = 'off';
        this.lab2FragmentStudyPreview = 'off';
      }
      this.updateLab2CoreStudy();
      return;
    }
    if (
      key === 'lab2FragmentPattern'
      && (value === 'cluster' || value === 'scatter' || value === 'radial' || value === 'asymmetric')
    ) {
      this.lab2FragmentPattern = value;
      this.rebuildLab2FragmentStudyMesh();
      return;
    }
    if (key === 'lab2FragmentSeed' && typeof value === 'number') {
      const nextSeed = Math.round(clamp(value, 0, 99));
      if (nextSeed === this.lab2FragmentSeed) return;
      this.lab2FragmentSeed = nextSeed;
      this.rebuildLab2FragmentStudyMesh();
      return;
    }
    if (key === 'hazePreview' && (value === 'off' || value === 'static' || value === 'audio')) {
      this.hazePreview = value;
      this.hazeLevel = value === 'static' ? 1 : 0;
      if (this.hazeMesh) this.hazeMesh.visible = value !== 'off';
      return;
    }
    if (
      key === 'fragmentPreview' &&
      (value === 'off' || value === 'static' || value === 'audio')
    ) {
      this.fragmentPreview = value;
      this.fragmentLevel = value === 'static' ? 1 : 0;
      if (this.fragmentMesh) this.fragmentMesh.visible = value !== 'off';
      return;
    }
    if (typeof value !== 'number') return;
    if (!(key in PARAM_RANGES)) return;
    const typed = key as Unified2ParamKey;
    const range = PARAM_RANGES[typed];
    // どの軸も次のフレームの書き出しで効く。生きている光は作り直さない。
    this.params[typed] = clamp(value, range.min, range.max);
    if (typed === 'intensity') {
      this.commonResolver.setBase('intensity', this.params.intensity);
      this.syncCommonIntensity();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.lab2Assembly?.dispose();
    this.spatialRecovery?.dispose();
    this.reactiveRecovery?.dispose();
    this.pipeline?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.coreGeometry?.dispose();
    this.coreMaterial?.dispose();
    this.hazeGeometry?.dispose();
    this.hazeMaterial?.dispose();
    this.fragmentGeometry?.dispose();
    this.fragmentMaterial?.dispose();
    this.lab2CoreStudyGeometry?.dispose();
    this.lab2CoreStudyMaterial?.dispose();
    this.lab2FragmentStudyGeometry?.dispose();
    this.lab2FragmentStudyMaterial?.dispose();
    this.spatialMaterialAnchorGeometry?.dispose();
    this.spatialMaterialAnchorMaterial?.dispose();
    this.spatialFragmentStudyGeometry?.dispose();
    this.spatialFragmentStudyMaterial?.dispose();
    this.placeholder?.dispose();
    this.atlas?.texture.dispose();
    if (this.mesh && this.scene) this.scene.remove(this.mesh);
    if (this.coreMesh && this.scene) this.scene.remove(this.coreMesh);
    if (this.hazeMesh && this.scene) this.scene.remove(this.hazeMesh);
    if (this.fragmentMesh && this.scene) this.scene.remove(this.fragmentMesh);
    if (this.lab2CoreStudyMesh && this.scene) this.scene.remove(this.lab2CoreStudyMesh);
    if (this.lab2FragmentStudyMesh && this.scene) {
      this.scene.remove(this.lab2FragmentStudyMesh);
    }
    if (this.spatialMaterialAnchorMesh && this.scene) {
      this.scene.remove(this.spatialMaterialAnchorMesh);
    }
    if (this.spatialFragmentStudyMesh && this.scene) {
      this.scene.remove(this.spatialFragmentStudyMesh);
    }
    this.cores.length = 0;
    this.membranes.length = 0;
    this.persistentCores.length = 0;
    this.persistentMembranes.length = 0;
    this.persistentLevel = 0;
    this.persistentSilenceSeconds = 0;
    this.pipeline = null;
    this.geometry = null;
    this.material = null;
    this.coreGeometry = null;
    this.coreMaterial = null;
    this.coreMesh = null;
    this.hazeGeometry = null;
    this.hazeMaterial = null;
    this.hazeMesh = null;
    this.fragmentGeometry = null;
    this.fragmentMaterial = null;
    this.fragmentMesh = null;
    this.lab2CoreStudyGeometry = null;
    this.lab2CoreStudyMaterial = null;
    this.lab2CoreStudyMesh = null;
    this.lab2FragmentStudyGeometry = null;
    this.lab2FragmentStudyMaterial = null;
    this.lab2FragmentStudyMesh = null;
    this.spatialMaterialAnchorGeometry = null;
    this.spatialMaterialAnchorMaterial = null;
    this.spatialMaterialAnchorMesh = null;
    this.spatialFragmentStudyGeometry = null;
    this.spatialFragmentStudyMaterial = null;
    this.spatialFragmentStudyMesh = null;
    this.fragmentMesh = null;
    this.placeholder = null;
    this.atlas = null;
    this.lab2Assembly = null;
    this.spatialRecovery = null;
    this.reactiveRecovery = null;
    this.mesh = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
    this.sourceShelf = null;
  }
}
