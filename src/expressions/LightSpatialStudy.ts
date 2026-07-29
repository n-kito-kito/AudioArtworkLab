import * as THREE from 'three';
import type {
  CompositionContext,
  DesignLayerCanvases,
} from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import {
  BandLightEventDetector,
  type BandFlux,
  type BandGateState,
  type BandLightEvent,
  type BandName,
} from '../engine/bandLightEvents';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { ExpressionParam, LabExpression } from './Expression';
import {
  LightSpatialMapping,
  trailSeconds,
  type LightMappingSettings,
} from './spatialMapping';

/**
 * Light Traces — Spatial Study。**3D 空間の検証表現**であり、完成版ではない。
 *
 * 2D の Core Study（`LightCoreStudy`）が「音の出来事と光の因果」を確かめる計測器なら、
 * こちらは「その光を奥行きのある空間に置いたとき、固定カメラで前後関係が読めるか」を
 * 確かめる計測器。音の検出は 2D とまったく同じ `BandLightEventDetector` を通す。
 * 2D は回帰確認用にそのまま残してあり、こちらが置き換えるものではない。
 *
 * 今回入れないもの: Core の移動 / Trail / Beam / Fog / Haze / RGB 分離 /
 * Bloom の焼き込み / 被写界深度 / カメラアニメーション。
 * **静止した Core が違う奥行きに在るだけで遠近が読める状態**までを見る。
 *
 * カメラは固定。原点から −Z を見るだけで、回転も移動もユーザー操作もしない。
 * Core はカメラを向く板ポリを 1 つの InstancedMesh で描く（1 ドロー）。
 * 光源（PointLight）は 1 つも使わない。
 *
 * 距離による減衰は今回は入れない。**遠近法だけで奥行きが読めるか**を見たいので、
 * 手前ほど明るいといった補助は足さず、同じワールドサイズの板が遠いほど小さく写る
 * ことだけで判断する。
 */

/**
 * この表現の定数はすべてここに集める。位置生成に渡すぶんは `position` にまとめてある
 * （`SpatialPositionResolver` はこのオブジェクトを受け取るだけで、自前の定数を持たない）。
 */
const SPATIAL_STUDY = {
  /** 同時に生かす Core の上限。2D と揃える。 */
  maximumCores: 32,
  /** 固定カメラの垂直画角（度）。奥行きの見え方はこの値で決まる。 */
  fieldOfView: 50,
  nearPlane: 0.1,
  farPlane: 200,
  /**
   * Core 1 個のワールドサイズ（板の一辺）。**奥でも手前でも同じ大きさ**にしておき、
   * 画面上の大小は遠近法だけから出るようにする。
   */
  coreWorldSize: 0.62,
  /** ガウス減衰の鋭さ。板の端で exp(-3) ≈ 0.05 まで落ちる。 */
  coreFalloff: 3,
  /**
   * 軌跡 1 本ぶんの節の数。**3D の位置履歴**を固定長で持ち、同じ InstancedMesh の
   * 後ろ半分として 1 ドローで描く。増やすほど滑らかになるが描画量も増える。
   */
  trailSegments: 12,
  /** 軌跡の節の明るさ（先端 → 末尾）。0 で完全に消える。 */
  trailIntensityAtTail: 0,
  /** 軌跡の節の大きさ（先端に対する末尾の倍率）。細くなるほど「光跡」に見える。 */
  trailSizeAtTail: 0.35,

  /**
   * 光学的な質感。**1 つずつ切って比べられるように、効きを別々の定数にしてある。**
   * どれも「光がある場所でだけ見える」ものに限る。画面全体へ白をかぶせない。
   */
  optics: {
    /** 中心核の締まり具合。大きいほど芯が小さく硬くなる。 */
    coreSharpness: 3.4,
    /** 中距離の滲み（Bloom 相当）の広がり。核の何倍まで届くか。 */
    haloRadius: 3.2,
    /** 同・強さ。0 で滲みなし。 */
    haloStrength: 0.3,
    /** 広く弱い散乱光の広がり。 */
    scatterRadius: 6.5,
    /** 同・強さ。0 で散乱なし。**霧ではなく、光の周りにだけ出る。** */
    scatterStrength: 0.05,
    /**
     * 板を張る余裕（散乱半径の何倍まで確保するか）。
     *
     * ここを詰めすぎると、散乱がまだ十分明るいところで板の縁に達し、
     * **四角い継ぎ目**として見えてしまう（2D Light Traces の fog で踏んだのと同じ罠）。
     * 余裕を持たせたうえで、縁で必ず 0 になる窓関数も掛けて二重に防ぐ。
     */
    scatterSpanMargin: 1.7,
    /**
     * RGB の微小な空間分離。色収差のように、色ごとに滲みの半径をわずかに変える。
     * 0 で分離なし。大きくすると輪郭に色が付く。
     */
    chromaticSeparation: 0.09,
    /**
     * 距離によるごく弱いコントラスト差。奥ほどわずかに沈む。
     * 0 で完全に無効（遠近法だけで見る状態に戻る）。
     */
    distanceContrast: 0.22,
    /** 同・効き始める距離と効ききる距離。 */
    contrastNearDepth: 5,
    contrastFarDepth: 17,
    /** 画面全体の露出。核・滲み・散乱をすべて通したあとに最後に掛ける。 */
    exposure: 1,
  },
  /** 1 フレームで進める時間の上限（秒）。タブ復帰時の巨大な delta を切る。 */
  maximumDelta: 0.05,
  /** Decay の曲がり。大きいほど頭で速く落ちる。 */
  decayCurve: 3,

  /** 位置生成の定数（`SpatialPositionResolver` へそのまま渡す）。 */
  position: {
    /** 横方向の広がり。1.0 で「余白を除いた可視範囲いっぱい」まで使う。 */
    horizontalSpread: 0.92,
    /** 縦方向の広がり。 */
    verticalSpread: 0.86,
    /** 奥行き方向の広がり。1.0 で minimumDepth〜maximumDepth を全部使う。 */
    depthSpread: 1,
    /** 画面端に残す余白（可視範囲に対する割合）。どの Aspect でも切れないようにする。 */
    edgeMargin: 0.1,
    /** カメラからの距離の下限（ワールド単位）。 */
    minimumDepth: 4.5,
    /** カメラからの距離の上限。 */
    maximumDepth: 17,
    /** Core どうしを最低これだけ離す（ワールド単位）。同時発光が重ならないように。 */
    minimumCoreDistance: 1.1,
    /** ハッシュの味付け。見え方を変えたいときにここだけ動かす（本番 UI には出さない）。 */
    deterministicSeedSalt: 0.6180339887,
  },

  /** 開発用パラメータの既定値。2D Core Study と同じ意味・同じ既定値。 */
  defaults: {
    attackMs: 15,
    holdMs: 60,
    decayMs: 350,
    minimumIntensity: 0.35,
    maximumIntensity: 1,
    onsetSensitivity: 0.5,
    fluxGain: 2.5,
    cooldownMs: 60,
    relativeStrengthFloor: 1,
    /** 大きさ・色・動き・軌跡の効き。Phase を進めるごとに既定値を上げていく。 */
    sizeAmount: 0.85,
    colorAmount: 0.8,
    motionAmount: 0.7,
    trailAmount: 0.35,
    trailWidthAmount: 0.7,
  },
  ranges: {
    attackMs: { min: 1, max: 200, step: 1 },
    holdMs: { min: 0, max: 500, step: 1 },
    decayMs: { min: 20, max: 2000, step: 10 },
    minimumIntensity: { min: 0, max: 1, step: 0.01 },
    maximumIntensity: { min: 0, max: 1, step: 0.01 },
    onsetSensitivity: { min: 0, max: 1, step: 0.01 },
    fluxGain: { min: 1, max: 40, step: 0.5 },
    cooldownMs: { min: 0, max: 400, step: 5 },
    relativeStrengthFloor: { min: 0.4, max: 1, step: 0.05 },
    sizeAmount: { min: 0, max: 1, step: 0.05 },
    colorAmount: { min: 0, max: 1, step: 0.05 },
    motionAmount: { min: 0, max: 1, step: 0.05 },
    trailAmount: { min: 0, max: 1, step: 0.05 },
    trailWidthAmount: { min: 0, max: 1, step: 0.05 },
  },
} as const;

type SpatialParamKey = keyof typeof SPATIAL_STUDY.defaults;

export type SpatialCorePhase = 'attack' | 'hold' | 'decay' | 'done';

/**
 * 3D 空間の Core 1 個。
 * 大きさ・色・速度は発生時に確定して変えない。位置だけが速度ぶん進む。
 */
interface SpatialCore {
  /** 現在位置。速度がゼロなら発生時のまま動かない。 */
  position: { x: number; y: number; z: number };
  /** 発生時の位置。軌跡や検証で「どこから出たか」を見るために残す。 */
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  /** 速度（ワールド単位 / 秒）。発生時に音から決まり、以後変わらない。 */
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
  readonly band: BandName;
  readonly onsetStrength: number;
  readonly peakIntensity: number;
  /** 基準サイズに対する倍率。発生時に確定してちらつかせない。 */
  readonly size: number;
  /** 色の比率（明るさは含まない）。発生時に確定する。 */
  readonly color: { readonly r: number; readonly g: number; readonly b: number };
  currentIntensity: number;
  readonly attackSeconds: number;
  readonly holdSeconds: number;
  readonly decaySeconds: number;
  age: number;
  phase: SpatialCorePhase;
  completed: boolean;
  /**
   * 位置の履歴（新しい順に x,y,z の並び）。固定長のリングではなく、
   * 節の数ぶんだけ確保した配列を先頭から詰め直す（節が少ないので十分速い）。
   */
  readonly history: Float32Array;
  /** 履歴に入っている節の数。 */
  historyCount: number;
  /** 次に履歴へ 1 点足すまでの残り秒。 */
  sampleCountdown: number;
  /** この Core の軌跡の長さ（0..1）。発生時に確定する。 */
  readonly trail: number;
  /** この Core の軌跡の太さ倍率。発生時に確定する。 */
  readonly trailWidth: number;
}

/** 開発・検証用に外へ見せる Core 1 個ぶんの状態。 */
export interface SpatialCoreSnapshot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly speed: number;
  readonly band: BandName;
  readonly size: number;
  readonly color: { readonly r: number; readonly g: number; readonly b: number };
  readonly onsetStrength: number;
  readonly peakIntensity: number;
  readonly currentIntensity: number;
  readonly age: number;
  readonly phase: SpatialCorePhase;
}

/** 開発・検証用の表現全体の状態。 */
export interface SpatialStudyState {
  readonly count: number;
  readonly lastBand: BandName | null;
  readonly lastOnsetStrength: number;
  readonly lastPeakIntensity: number;
  readonly lastPosition: { x: number; y: number; z: number } | null;
  readonly lastColor: { r: number; g: number; b: number };
  readonly lastSize: number;
  readonly lastPhase: SpatialCorePhase | null;
  readonly lastEventCores: number;
  readonly flux: BandFlux;
  readonly bands: Readonly<Record<BandName, BandGateState>>;
  readonly cores: readonly SpatialCoreSnapshot[];
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const clamp01 = (value: number): number => clamp(value, 0, 1);

/** t = 0 で 1、t = 1 でちょうど 0 になる指数曲線（2D と同じ形）。 */
const decayShape = (t: number): number => {
  const k = SPATIAL_STUDY.decayCurve;
  const floor = Math.exp(-k);
  return (Math.exp(-k * t) - floor) / (1 - floor);
};

export class LightSpatialStudy implements LabExpression {
  readonly animated = true;
  readonly name = 'Light Traces — Spatial Study';
  readonly id: ExpressionId = 'light-spatial-study-v1';

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  private readonly params: Record<SpatialParamKey, number> = { ...SPATIAL_STUDY.defaults };

  private context: CompositionContext | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private scene: THREE.Scene | null = null;
  private geometry: THREE.InstancedBufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  private pipeline: EffectPipeline | null = null;

  /** インスタンス属性。毎フレーム中身だけ書き換え、確保し直さない。 */
  /**
   * Core 本体 + 軌跡の節を 1 本の配列にまとめて持つ。
   * こうしておけば軌跡が増えても**ドローコールは 1 のまま**。
   */
  private static readonly INSTANCE_CAPACITY =
    SPATIAL_STUDY.maximumCores * (1 + SPATIAL_STUDY.trailSegments);
  private readonly offsets = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY * 3);
  private readonly intensities = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY);
  private readonly sizes = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY);
  private readonly colors = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY * 3);
  private offsetAttribute: THREE.InstancedBufferAttribute | null = null;
  private intensityAttribute: THREE.InstancedBufferAttribute | null = null;
  private sizeAttribute: THREE.InstancedBufferAttribute | null = null;
  private colorAttribute: THREE.InstancedBufferAttribute | null = null;

  /** 音イベントの検出。2D Core Study とまったく同じ検出器を使う。 */
  private readonly detector = new BandLightEventDetector();
  /**
   * 音 → 見え方の対応を決める唯一の層（`spatialMapping.ts`）。
   * 位置・明るさ・大きさ・色・速度・寿命・軌跡はすべてここが決め、
   * この表現は受け取った値をそのまま描くだけにする。
   */
  private readonly mapping = new LightSpatialMapping(
    SPATIAL_STUDY.position,
    SPATIAL_STUDY.maximumCores,
  );
  private readonly cores: SpatialCore[] = [];

  private previousElapsed = -1;
  private lastBand: BandName | null = null;
  private lastOnsetStrength = 0;
  private lastPeakIntensity = 0;
  private lastPosition: { x: number; y: number; z: number } | null = null;
  private lastColor: { r: number; g: number; b: number } = { r: 1, g: 1, b: 1 };
  private lastSize = 1;
  private lastEventCores = 0;
  private adaptiveThreshold = true;
  private adaptiveStrength = true;

  constructor(effects: Effect[] = [], theme?: Theme) {
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
  }

  // ---------------------------------------------------------------- setup

  setup(context: CompositionContext): void {
    this.context = context;
    this.camera = new THREE.PerspectiveCamera(
      SPATIAL_STUDY.fieldOfView,
      this.aspectRatio,
      SPATIAL_STUDY.nearPlane,
      SPATIAL_STUDY.farPlane,
    );
    // 固定カメラ。原点から −Z を見るだけで、以降まったく動かさない。
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(0, 0, -1);

    // 1 枚の板を InstancedBufferGeometry にして、1 ドローで全 Core を描く。
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = plane.index;
    this.geometry.setAttribute('position', plane.getAttribute('position'));
    this.geometry.setAttribute('uv', plane.getAttribute('uv'));
    plane.dispose();

    this.offsetAttribute = new THREE.InstancedBufferAttribute(this.offsets, 3);
    this.offsetAttribute.setUsage(THREE.DynamicDrawUsage);
    this.intensityAttribute = new THREE.InstancedBufferAttribute(this.intensities, 1);
    this.intensityAttribute.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttribute = new THREE.InstancedBufferAttribute(this.sizes, 1);
    this.sizeAttribute.setUsage(THREE.DynamicDrawUsage);
    this.colorAttribute = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.colorAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aOffset', this.offsetAttribute);
    this.geometry.setAttribute('aIntensity', this.intensityAttribute);
    this.geometry.setAttribute('aSize', this.sizeAttribute);
    this.geometry.setAttribute('aColor', this.colorAttribute);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: SPATIAL_STUDY.coreWorldSize },
        uFalloff: { value: SPATIAL_STUDY.coreFalloff },
        uCoreSharpness: { value: SPATIAL_STUDY.optics.coreSharpness },
        uHalo: { value: new THREE.Vector2(SPATIAL_STUDY.optics.haloRadius, SPATIAL_STUDY.optics.haloStrength) },
        uScatter: { value: new THREE.Vector2(SPATIAL_STUDY.optics.scatterRadius, SPATIAL_STUDY.optics.scatterStrength) },
        uChromatic: { value: SPATIAL_STUDY.optics.chromaticSeparation },
        uExposure: { value: SPATIAL_STUDY.optics.exposure },
        // 板を張る倍率。散乱がいちばん外まで届くので、その半径 × 余裕で決める。
        uSpan: {
          value: Math.max(
            SPATIAL_STUDY.optics.scatterRadius * SPATIAL_STUDY.optics.scatterSpanMargin,
            1,
          ),
        },
        uContrast: {
          value: new THREE.Vector3(
            SPATIAL_STUDY.optics.distanceContrast,
            SPATIAL_STUDY.optics.contrastNearDepth,
            SPATIAL_STUDY.optics.contrastFarDepth,
          ),
        },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      // 加算合成なので前後の描画順に依存しない。深度は書かず、テストもしない。
      depthWrite: false,
      depthTest: false,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute float aIntensity;
        attribute float aSize;
        attribute vec3 aColor;
        uniform float uSize;
        uniform float uSpan;
        uniform vec3 uContrast;
        varying vec2 vLocal;
        varying float vIntensity;
        varying vec3 vColor;
        varying float vDistanceFade;

        void main() {
          // 板は「核 + 滲み + 散乱」を全部含む大きさで張る。
          // vLocal は核の半径を 1 とした座標なので、散乱の広がりぶん外側まで伸びる。
          vLocal = position.xy * 2.0 * uSpan;
          vIntensity = aIntensity;
          vColor = aColor;
          // ビュー空間で板を広げるので、板は常にカメラを向く（ビルボード）。
          // 大きさはワールド単位のまま置くだけで、遠近は投影行列が付ける。
          vec4 viewPosition = modelViewMatrix * vec4(aOffset, 1.0);
          viewPosition.xy += position.xy * uSize * aSize * uSpan;
          // 奥ほどわずかに沈ませる（距離のコントラスト差）。強くはしない。
          float depth = -viewPosition.z;
          float t = clamp((depth - uContrast.y) / max(uContrast.z - uContrast.y, 0.001), 0.0, 1.0);
          vDistanceFade = 1.0 - uContrast.x * t;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uFalloff;
        uniform float uSpan;
        uniform float uCoreSharpness;
        uniform vec2 uHalo;
        uniform vec2 uScatter;
        uniform float uChromatic;
        uniform float uExposure;
        varying vec2 vLocal;
        varying float vIntensity;
        varying vec3 vColor;
        varying float vDistanceFade;

        // 半径 r のガウス。radius を変えるだけで核・滲み・散乱を作り分ける。
        float glow(float d2, float radius) {
          return exp(-d2 / max(radius * radius, 0.0001));
        }

        void main() {
          float d2 = dot(vLocal, vLocal);

          // ① 明るい中心核。締まった芯。
          float core = glow(d2 * uCoreSharpness, 1.0 / max(uFalloff, 0.0001));
          // ② 中距離の滲み。核の周りにだけ出る（画面全体には広げない）。
          float halo = glow(d2, uHalo.x) * uHalo.y;
          // ③ 広く弱い散乱光。**光がある場所でだけ**見えるので、
          //    白いオーバーレイのように画面へかぶせることはない。
          float scatter = glow(d2, uScatter.x) * uScatter.y;

          // ④ RGB の微小な空間分離。色ごとに滲みの半径をわずかにずらす。
          vec3 spread = vec3(1.0 + uChromatic, 1.0, 1.0 - uChromatic);
          vec3 chroma = vec3(
            glow(d2, uHalo.x * spread.r),
            glow(d2, uHalo.x * spread.g),
            glow(d2, uHalo.x * spread.b)
          ) * uHalo.y * uChromatic;

          // 明るさ（vIntensity）と色の比率（vColor）は最後まで別々に持つ。
          // 音量が大きいだけで色が白へ飽和しないようにするための分離。
          vec3 level = vColor * (core + halo + scatter) + chroma * vColor;
          level *= max(vIntensity, 0.0) * vDistanceFade * uExposure;
          // 板の縁で必ず 0 にする窓。これがないと散乱が四角く切れて継ぎ目が見える。
          float edge = clamp(1.0 - d2 / (uSpan * uSpan), 0.0, 1.0);
          gl_FragColor = vec4(max(level * edge * edge, 0.0), 1.0);
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // 板はシェーダーで広げるので、three の境界球では正しく判定できない。
    this.mesh.frustumCulled = false;

    this.scene = new THREE.Scene();
    // 無音は黒（PRD D5）。背景を明示しておかないと透明のまま抜ける。
    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.mesh);

    this.pipeline = new EffectPipeline(context.renderer, this.scene, this.camera, this.effects);
  }

  // ---------------------------------------------------------------- 可視範囲

  /**
   * カメラからの距離 `depth` において画面に収まる範囲（半分の幅と高さ）。
   * 画角と Aspect から逆算するので、どの画角・どのウィンドウ幅でも
   * 「画面外へ出さない」条件を自動的に満たせる。
   */
  private visibleHalfExtent(depth: number): { halfWidth: number; halfHeight: number } {
    const halfHeight = Math.tan((SPATIAL_STUDY.fieldOfView * Math.PI) / 360) * depth;
    return { halfHeight, halfWidth: halfHeight * Math.max(this.aspectRatio, 1e-6) };
  }

  // ---------------------------------------------------------------- 検出

  private detectEvents(elapsed: number, delta: number): void {
    const audio = this.context?.audioEngine.getParameters() ?? {};
    const spectrum = this.context?.audioEngine.getSpectrum?.() ?? null;
    const events = this.detector.update(
      spectrum,
      {
        volume: clamp01(audio.volume ?? 0),
        bass: clamp01(audio.bass ?? 0),
        mid: clamp01(audio.mid ?? 0),
        treble: clamp01(audio.treble ?? 0),
        // centroid は engine が対数で 0..1 に正規化済み。Hz の生値は使わない。
        spectralCentroid: clamp01(audio.centroid ?? 0),
        spectralFlatness: clamp01(audio.flatness ?? 0),
        audioSeed: clamp01(audio.seed ?? 0),
      },
      elapsed,
      delta,
      {
        fluxGain: this.params.fluxGain,
        onsetSensitivity: this.params.onsetSensitivity,
        cooldownSeconds: this.params.cooldownMs / 1000,
        relativeStrengthFloor: this.params.relativeStrengthFloor,
        adaptiveThreshold: this.adaptiveThreshold,
        adaptiveStrength: this.adaptiveStrength,
      },
    );
    if (events.length === 0) return;
    this.lastEventCores = events.length;
    for (const event of events) this.spawn(event);
  }

  /**
   * イベント 1 個から Core を 1 個作る。
   *
   * 位置は `SpatialPositionResolver` が音だけから決める（`Math.random()` は使わない）。
   * 決めた位置は寿命の間ずっと動かさない。
   */
  private spawn(event: BandLightEvent): void {
    if (this.cores.length >= SPATIAL_STUDY.maximumCores) this.cores.shift();
    const traits = this.mapping.resolve(
      event,
      (depth) => this.visibleHalfExtent(depth),
      this.mappingSettings(),
    );

    this.cores.push({
      position: { ...traits.position },
      origin: { ...traits.position },
      velocity: traits.velocity,
      band: event.band,
      onsetStrength: event.strength,
      peakIntensity: traits.intensity,
      size: traits.size,
      color: traits.color,
      currentIntensity: 0,
      attackSeconds: traits.lifetime.attackSeconds,
      holdSeconds: traits.lifetime.holdSeconds,
      decaySeconds: traits.lifetime.decaySeconds,
      age: 0,
      phase: 'attack',
      completed: false,
      history: new Float32Array(SPATIAL_STUDY.trailSegments * 3),
      historyCount: 0,
      sampleCountdown: 0,
      trail: traits.trail,
      trailWidth: traits.trailWidth,
    });
    this.lastBand = event.band;
    this.lastOnsetStrength = event.strength;
    this.lastPeakIntensity = traits.intensity;
    this.lastPosition = { ...traits.position };
    this.lastColor = { ...traits.color };
    this.lastSize = traits.size;
  }

  /** Mapping 層へ渡す運転設定。開発用パラメータをそのまま束ねるだけ。 */
  private mappingSettings(): LightMappingSettings {
    return {
      minimumIntensity: this.params.minimumIntensity,
      maximumIntensity: this.params.maximumIntensity,
      attackSeconds: this.params.attackMs / 1000,
      holdSeconds: this.params.holdMs / 1000,
      decaySeconds: this.params.decayMs / 1000,
      sizeAmount: this.params.sizeAmount,
      colorAmount: this.params.colorAmount,
      motionAmount: this.params.motionAmount,
      trailAmount: this.params.trailAmount,
      trailWidthAmount: this.params.trailWidthAmount,
    };
  }

  // ---------------------------------------------------------------- 一生

  /**
   * 経過秒だけ進める。明るさは age の純粋な関数。
   * 位置は速度ぶんだけ進む（速度は発生時に確定しているので、経路も決定論）。
   */
  private advance(core: SpatialCore, delta: number): void {
    core.age += delta;
    core.position.x += core.velocity.x * delta;
    core.position.y += core.velocity.y * delta;
    core.position.z += core.velocity.z * delta;
    this.sampleHistory(core, delta);
    const { attackSeconds: attack, holdSeconds: hold, decaySeconds: decay } = core;

    if (core.age < attack) {
      core.phase = 'attack';
      core.currentIntensity = core.peakIntensity * (attack <= 0 ? 1 : core.age / attack);
      return;
    }
    if (core.age < attack + hold) {
      core.phase = 'hold';
      core.currentIntensity = core.peakIntensity;
      return;
    }
    const t = decay <= 0 ? 1 : (core.age - attack - hold) / decay;
    if (t >= 1) {
      core.phase = 'done';
      core.currentIntensity = 0;
      core.completed = true;
      return;
    }
    core.phase = 'decay';
    core.currentIntensity = core.peakIntensity * decayShape(t);
  }

  /**
   * 位置の履歴を一定間隔で 1 点ずつ足す。
   * 間隔は「軌跡の長さ ÷ 節の数」なので、Trail を動かすと履歴の張る時間だけが変わる。
   */
  private sampleHistory(core: SpatialCore, delta: number): void {
    if (core.trail <= 0) {
      core.historyCount = 0;
      return;
    }
    core.sampleCountdown -= delta;
    if (core.sampleCountdown > 0) return;
    const interval = Math.max(
      trailSeconds(core.trail) / SPATIAL_STUDY.trailSegments,
      1 / 240,
    );
    core.sampleCountdown = interval;

    // 先頭へ新しい点を差し込み、古い点を 1 つ後ろへずらす。
    const history = core.history;
    const last = Math.min(core.historyCount, SPATIAL_STUDY.trailSegments - 1);
    for (let i = last; i > 0; i--) {
      history[i * 3] = history[(i - 1) * 3]!;
      history[i * 3 + 1] = history[(i - 1) * 3 + 1]!;
      history[i * 3 + 2] = history[(i - 1) * 3 + 2]!;
    }
    history[0] = core.position.x;
    history[1] = core.position.y;
    history[2] = core.position.z;
    core.historyCount = Math.min(core.historyCount + 1, SPATIAL_STUDY.trailSegments);
  }

  /** 進めながら、終わった Core を詰めて捨てる（参照を残さない）。 */
  private advanceCores(delta: number): void {
    let write = 0;
    for (let read = 0; read < this.cores.length; read++) {
      const core = this.cores[read]!;
      this.advance(core, delta);
      if (core.completed) continue;
      this.cores[write] = core;
      write += 1;
    }
    this.cores.length = write;
  }

  /** インスタンス属性へ書き戻す。確保はせず、中身と instanceCount だけ更新する。 */
  private syncInstances(): void {
    if (!this.geometry || !this.offsetAttribute || !this.intensityAttribute) return;
    if (!this.sizeAttribute || !this.colorAttribute) return;
    let slot = 0;
    const write = (
      x: number,
      y: number,
      z: number,
      intensity: number,
      size: number,
      color: { r: number; g: number; b: number },
    ): void => {
      this.offsets[slot * 3] = x;
      this.offsets[slot * 3 + 1] = y;
      this.offsets[slot * 3 + 2] = z;
      this.intensities[slot] = intensity;
      this.sizes[slot] = size;
      this.colors[slot * 3] = color.r;
      this.colors[slot * 3 + 1] = color.g;
      this.colors[slot * 3 + 2] = color.b;
      slot += 1;
    };

    for (const core of this.cores) {
      // 大きさと色は発生時に確定した値。毎フレーム作り直さないのでちらつかない。
      write(core.position.x, core.position.y, core.position.z, core.currentIntensity, core.size, core.color);
    }
    // 軌跡は 3D の位置履歴そのもの（2D の残像合成ではない）。
    // 先端ほど明るく太く、末尾へ向かって細く暗くなる。
    for (const core of this.cores) {
      if (core.trail <= 0) continue;
      for (let k = 0; k < core.historyCount; k++) {
        const fade = (k + 1) / SPATIAL_STUDY.trailSegments;
        const intensity =
          core.currentIntensity * (1 - fade) * (1 - fade) * (1 - SPATIAL_STUDY.trailIntensityAtTail);
        if (intensity <= 0.002) continue;
        // 軌跡の太さは帯域が決める（trailWidth）。先端 → 末尾の細りはその上へ掛かる。
        const size = core.size * core.trailWidth * (1 - fade * (1 - SPATIAL_STUDY.trailSizeAtTail));
        write(core.history[k * 3]!, core.history[k * 3 + 1]!, core.history[k * 3 + 2]!, intensity, size, core.color);
      }
    }

    this.geometry.instanceCount = slot;
    this.offsetAttribute.needsUpdate = true;
    this.intensityAttribute.needsUpdate = true;
    this.sizeAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
  }

  // ---------------------------------------------------------------- update

  update(elapsed: number): void {
    if (!this.context || !this.material) return;
    const audio = this.context.audioEngine.getParameters();
    const active = audio.active === 1;

    const delta =
      this.previousElapsed < 0
        ? 0
        : clamp(elapsed - this.previousElapsed, 0, SPATIAL_STUDY.maximumDelta);
    this.previousElapsed = elapsed;

    if (!active) {
      // PRD D5: 音がなければ発生も余韻もない（無音＝黒画面が正常）。
      this.cores.length = 0;
      this.resetDetection();
      this.syncInstances();
      this.pipeline?.update(audio, elapsed);
      return;
    }

    this.detectEvents(elapsed, delta);
    this.advanceCores(delta);
    this.syncInstances();
    this.pipeline?.update(audio, elapsed);
  }

  private resetDetection(): void {
    this.detector.reset();
    this.lastBand = null;
    this.lastEventCores = 0;
    this.lastPosition = null;
    this.mapping.reset();
  }

  render(): void {
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    if (this.camera && height > 0) {
      // キャンバスは画角（Aspect）に合わせて main 側がリサイズする。
      // カメラの比率もそれに揃えないと、Core が縦横に潰れて見える。
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    this.pipeline?.resize(width, height);
  }

  // ---------------------------------------------------------------- LabExpression

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
    this.theme = theme;
  }

  /** 色のテーマは持たない（黒背景と白い Core だけ）。 */
  usesTheme(): boolean {
    return false;
  }

  getZoom(): number {
    return this.zoom;
  }

  setZoom(zoom: number): void {
    this.zoom = clamp(zoom, 0.25, 8);
  }

  getResponse(): { bass: number; mid: number; treble: number } {
    return { ...this.response };
  }

  /** 帯域ゲインは状態として持つだけ。検証中は像に効かせない（2D と同じ扱い）。 */
  setResponse(gains: Partial<{ bass: number; mid: number; treble: number }>): void {
    const pick = (value: number | undefined, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 2) : fallback;
    this.response = {
      bass: pick(gains.bass, this.response.bass),
      mid: pick(gains.mid, this.response.mid),
      treble: pick(gains.treble, this.response.treble),
    };
  }

  getAspectId(): string {
    return this.aspectId;
  }

  getAspectRatio(): number {
    return this.aspectRatio;
  }

  setAspect(id: string, ratio: number): void {
    if (id === this.aspectId) return;
    this.aspectId = id;
    this.aspectRatio = clamp(ratio, 0.25, 4);
    if (this.camera) {
      this.camera.aspect = this.aspectRatio;
      this.camera.updateProjectionMatrix();
    }
  }

  setDebugView(): void {
    // 切り替える中間表現を持たない。
  }

  getDebugState(): null {
    return null;
  }

  getDepth(): number {
    return 0;
  }

  setDepth(): void {
    // 奥行きスライダーは持たない（空間そのものが奥行きを持つ）。
  }

  getPhase(): string {
    const f = this.detector.bandFlux;
    const p = this.lastPosition;
    return (
      `cores ${this.cores.length} / last ${this.lastBand ?? '-'} ` +
      `${p ? `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})` : '-'} / ` +
      `flux b${f.bass.toFixed(2)} m${f.mid.toFixed(2)} t${f.treble.toFixed(2)}`
    );
  }

  /** 開発・検証用。Inspector と `window.__lab` から読む。 */
  getSpatialStudyState(): SpatialStudyState {
    return {
      count: this.cores.length,
      lastBand: this.lastBand,
      lastOnsetStrength: this.lastOnsetStrength,
      lastPeakIntensity: this.lastPeakIntensity,
      lastPosition: this.lastPosition ? { ...this.lastPosition } : null,
      lastColor: { ...this.lastColor },
      lastSize: this.lastSize,
      lastPhase: this.cores.length > 0 ? this.cores[this.cores.length - 1]!.phase : null,
      lastEventCores: this.lastEventCores,
      flux: this.detector.bandFlux,
      bands: {
        bass: this.detector.bandState('bass'),
        mid: this.detector.bandState('mid'),
        treble: this.detector.bandState('treble'),
      },
      cores: this.cores.map((core) => ({
        x: core.position.x,
        y: core.position.y,
        z: core.position.z,
        speed: Math.hypot(core.velocity.x, core.velocity.y, core.velocity.z),
        band: core.band,
        size: core.size,
        color: { ...core.color },
        onsetStrength: core.onsetStrength,
        peakIntensity: core.peakIntensity,
        currentIntensity: core.currentIntensity,
        age: core.age,
        phase: core.phase,
      })),
    };
  }

  // ---------------------------------------------------------------- 開発用パラメータ

  getExpressionParams(): ExpressionParam[] {
    const row = (key: SpatialParamKey, label: string): ExpressionParam => ({
      key,
      label,
      ...SPATIAL_STUDY.ranges[key],
      value: this.params[key],
    });
    const onOff = (key: string, label: string, enabled: boolean): ExpressionParam => ({
      key,
      label,
      type: 'select',
      options: [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
      value: enabled ? 'on' : 'off',
    });
    return [
      row('attackMs', 'Attack (ms)'),
      row('holdMs', 'Hold (ms)'),
      row('decayMs', 'Decay (ms)'),
      row('minimumIntensity', 'Min intensity'),
      row('maximumIntensity', 'Max intensity'),
      row('onsetSensitivity', 'Onset sensitivity'),
      row('fluxGain', 'Flux gain'),
      row('cooldownMs', 'Cooldown (ms)'),
      row('relativeStrengthFloor', 'Band floor'),
      row('sizeAmount', 'Size amount'),
      row('colorAmount', 'Color amount'),
      row('motionAmount', 'Motion amount'),
      row('trailAmount', 'Trail'),
      row('trailWidthAmount', 'Trail width'),
      onOff('adaptiveThreshold', 'Adaptive threshold', this.adaptiveThreshold),
      onOff('adaptiveStrength', 'Adaptive strength', this.adaptiveStrength),
    ];
  }

  setExpressionParam(key: string, value: number | string): void {
    if (key === 'adaptiveThreshold' || key === 'adaptiveStrength') {
      const enabled = value === 'on' || value === 1;
      if (key === 'adaptiveThreshold') this.adaptiveThreshold = enabled;
      else this.adaptiveStrength = enabled;
      return;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return;
    if (!(key in this.params)) return;
    const range = SPATIAL_STUDY.ranges[key as SpatialParamKey];
    this.params[key as SpatialParamKey] = clamp(numeric, range.min, range.max);
  }

  setGeneratorsVisible(): void {
    // 表示の切り替えは存在しない。
  }

  setDesignLayerCanvases(canvases: DesignLayerCanvases): void {
    this.pipeline?.setOverlayCanvases(canvases);
  }

  updateDesignLayerCanvases(): void {
    this.pipeline?.updateOverlayCanvases();
  }

  dispose(): void {
    this.pipeline?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.cores.length = 0;
    this.resetDetection();
    if (this.mesh && this.scene) this.scene.remove(this.mesh);
    this.pipeline = null;
    this.mesh = null;
    this.scene = null;
    this.geometry = null;
    this.material = null;
    this.offsetAttribute = null;
    this.intensityAttribute = null;
    this.sizeAttribute = null;
    this.colorAttribute = null;
    this.camera = null;
    this.context = null;
  }
}
