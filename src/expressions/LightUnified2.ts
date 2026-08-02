import * as THREE from 'three';
import type { CompositionContext, DesignLayerCanvases } from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { BandLightEventDetector, type BandLightEvent } from '../engine/bandLightEvents';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { ExpressionParam, LabExpression } from './Expression';
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
 * `Core form` は形の混合ではなく**手続きの芯の寄与量**で、
 * **0 = 芯が満額（Lab2）⇄ 中間 = 素材の上に芯が加算（Reactive）⇄ 1 = 芯なし（Spatial）**。
 * 詳しくは `buildCoreMesh()` の注釈。
 * **コアの有無は `Core size`（0 で板が潰れて消える）が決め、`Core form` は質だけを担う。**
 *
 * ## 音（第 3 歩）
 *
 * 既存の `BandLightEventDetector` を**そのまま**使う（新しい解析は作らない）。
 * 打撃 1 個につき
 *
 * - **コアが 1 個生まれる**（短い寿命）。位置はイベント番号のハッシュから決まり、
 *   これがそのイベントの**起点**になる。素材も発光ごとに変わる。
 * - **膜が `Membranes` 枚生まれる**（長い寿命）。位置は `Anchor` 軸で
 *   **0 = 画面内に散る ⇄ 1 = 起点から生まれる**を連続に行き来する。
 *
 * 色は**コアと膜が 1 つの色相状態を共有**する（音色 = centroid と帯域バランスから作る）。
 * 色を作っている場所は `resolveTint()` の 1 箇所だけで、両方のシェーダーは
 * その結果 `uTint` を受け取るだけ。
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
  /**
   * **Anchor 1 でも残す散らばり。**
   * 0 にすると 1 イベントの膜が完全に重なって 1 枚に見えるので、わずかに残す。
   */
  anchorResidue: 0.08,

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
     * これが無いと `Core form` は「形が変わる軸」ではなく「消える軸」になってしまう。
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
    intensity: 0.72,
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
  },

  defaults: {
    membranes: 4,
    scale: 0.5,
    crop: 0.35,
    softness: 0.5,
    carve: 0.35,
    anchor: 0.35,
    coreSize: 0.4,
    coreForm: 0.5,
    saturation: 0.55,
    sensitivity: 0.5,
    intensity: 1,
  },
} as const;

type Unified2ParamKey =
  | 'membranes'
  | 'scale'
  | 'crop'
  | 'softness'
  | 'carve'
  | 'anchor'
  | 'coreSize'
  | 'coreForm'
  | 'saturation'
  | 'sensitivity'
  | 'intensity';

const PARAM_RANGES: Record<Unified2ParamKey, { min: number; max: number; step: number }> = {
  membranes: { min: 3, max: UNIFIED2.maximumMembranesPerEvent, step: 1 },
  scale: { min: 0, max: 1, step: 0.01 },
  crop: { min: 0, max: 1, step: 0.01 },
  softness: { min: 0, max: 1, step: 0.01 },
  carve: { min: 0, max: 1, step: 0.01 },
  anchor: { min: 0, max: 1, step: 0.01 },
  coreSize: { min: 0, max: 1, step: 0.01 },
  coreForm: { min: 0, max: 1, step: 0.01 },
  saturation: { min: 0, max: 1, step: 0.01 },
  sensitivity: { min: 0, max: 1, step: 0.01 },
  intensity: { min: 0, max: 2, step: 0.01 },
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
}

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
  private fragmentPreview: 'off' | 'static' = 'off';
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

  // ---- 膜のインスタンス属性 ----
  private readonly offsets = new Float32Array(UNIFIED2.maximumLiveMembranes * 3);
  /** 半幅 / 半高 / 素材番号。 */
  private readonly sizes = new Float32Array(UNIFIED2.maximumLiveMembranes * 3);
  /** 切り取りの中心 UV と半幅。 */
  private readonly crops = new Float32Array(UNIFIED2.maximumLiveMembranes * 4);
  /** 面内回転の cos / sin と UV の反転。 */
  private readonly orients = new Float32Array(UNIFIED2.maximumLiveMembranes * 4);
  /** 振幅（エンベロープ × 打撃の強さ）。 */
  private readonly levels = new Float32Array(UNIFIED2.maximumLiveMembranes);
  private readonly attributes: Record<string, THREE.InstancedBufferAttribute> = {};

  // ---- コアのインスタンス属性 ----
  private readonly coreOffsets = new Float32Array(UNIFIED2.maximumLiveCores * 3);
  /** 半径 / 素材番号（コアは正方形）。 */
  private readonly coreSizes = new Float32Array(UNIFIED2.maximumLiveCores * 2);
  /** 切り取りの中心 UV と面内回転の cos / sin。 */
  private readonly coreCells = new Float32Array(UNIFIED2.maximumLiveCores * 4);
  /** UV の反転。 */
  private readonly coreFlips = new Float32Array(UNIFIED2.maximumLiveCores * 2);
  private readonly coreLevels = new Float32Array(UNIFIED2.maximumLiveCores);
  private readonly coreAttributes: Record<string, THREE.InstancedBufferAttribute> = {};

  constructor(id: ExpressionId, effects: Effect[] = [], theme?: Theme) {
    this.id = id;
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
  }

  // ---------------------------------------------------------------- setup

  setup(context: CompositionContext): void {
    this.context = context;
    this.disposed = false;

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
    this.cores.length = 0;
    this.membranes.length = 0;

    this.buildMembraneMesh();
    this.buildCoreMesh();
    this.buildHazeStudyMesh();
    this.buildFragmentStudyMesh();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    if (this.mesh) this.scene.add(this.mesh);
    if (this.coreMesh) this.scene.add(this.coreMesh);
    if (this.hazeMesh) this.scene.add(this.hazeMesh);
    if (this.fragmentMesh) this.scene.add(this.fragmentMesh);

    this.pipeline = new EffectPipeline(context.renderer, this.scene, this.camera, this.effects);

    // 素材は非同期。届くまで 1 画素も出ないだけで、表現は壊れない。
    void loadPrismAtlas(UNIFIED2.atlas).then((atlas) => {
      if (!atlas) return;
      if (this.disposed) {
        atlas.texture.dispose();
        return;
      }
      this.atlas = atlas;
      for (const material of [this.material, this.coreMaterial, this.hazeMaterial]) {
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
        uniform float uIntensity;
        uniform float uInset;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying float vLevel;

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
          vec2 atlasUv = (vec2(column, row) + cell) / uGrid;
          vec3 source = texture2D(uAtlas, atlasUv).rgb;

          // ④ 素材輝度。**輝度の源はここだけ。** 敷居も曲げも 0 を 0 のまま通す。
          float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
          luminance *= smoothstep(uShape.y, uShape.y + uShape.z, luminance);
          luminance = pow(max(luminance, 0.0), uShape.w);

          // ⑤ 色 × 素材輝度 × ビネット × 振幅 × 強度。これ以外は掛けない。
          vec3 color = uTint * luminance * window * max(vLevel, 0.0) * uIntensity;
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
   * ## `Core form` は「混合」ではなく「**手続きの芯の寄与量**」
   *
   * 3 表現を見直すと、Spatial に独立したコア部品は無く、中心にあったのは
   * **素材が形の膜が強く光っていたもの**（Prismatic Anchor）だった。
   * Lab2 は**手続きの楕円 + 素材を加算**、Reactive は**素材が形 + 白い芯を加算**。
   * つまり 3 表現は「**手続きの芯がどれだけ乗るか**」の 1 本の軸に並ぶ。
   *
   *     mask = 素材の輝度 + 手続きの楕円 × (1 − Core form)
   *
   * - `Core form = 0`: 芯が満額で乗る（楕円が主役 ＝ Lab2）
   * - 中間: 素材が形の上に芯が加算で乗る（＝ Reactive）
   * - `Core form = 1`: **芯の寄与が厳密に 0**。素材だけが光る（＝ Spatial）
   *
   * 素材側は軸のどこでも常に居る。変わるのは芯の質だけで、分岐は無く連続。
   *
   * ## 有無と質は別のつまみ
   *
   * **コアを消したいときは `Core size` を 0 にする。** 板のスケールが 0 になって
   * 1 画素も描かれない。`Core form` は質の軸であって、明るさで消す役割は持たない。
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
            1 - UNIFIED2.defaults.coreForm,
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
        uniform float uIntensity;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCell;
        varying vec2 vFlip;
        varying float vLevel;

        void main() {
          vec2 p = vLocal;
          float radius2 = dot(p, p);

          // ① 手続きの芯（楕円）。r = 1 で厳密に 0 なので、板の四角はこの側では出ない。
          //    寄与量 uCore.x は Core form 1 で厳密に 0 になり、芯は完全に消える。
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
          vec3 source = texture2D(uAtlas, (vec2(column, row) + cell) / uGrid).rgb;
          float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
          luminance *= smoothstep(uCoreCrop.x, uCoreCrop.x + uCoreCrop.y, luminance);
          float material = luminance * uCore.z;

          // ③ **加算。** 素材は軸のどこでも居て、変わるのは芯の量だけ（分岐は無い）。
          float mask = material + ellipse;

          // ④ 素材側に要る円窓。板の四角い輪郭を消すための掛け算で、輝度は足さない。
          float window = 1.0 - smoothstep(uCore.w, 1.0, length(p));

          // **色は膜と共有**（uTint）。コアの有無は Core size ＝ 板のスケールが決める。
          vec3 color = uTint * mask * window * max(vLevel, 0.0) * uIntensity;
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

    // ---- 膜 ----
    if (this.geometry) {
      const cropHalf = mix(UNIFIED2.cropNarrow, UNIFIED2.cropWide, clamp01(this.params.crop));
      const scale = mix(UNIFIED2.scaleSmall, UNIFIED2.scaleLarge, clamp01(this.params.scale));
      // **Anchor。** 0 = 画面内に散る ⇄ 1 = 起点（コア）から生まれる。
      // 1 でも散らばりをわずかに残す（残さないと 1 枚に見える）。
      const toOrigin = clamp01(this.params.anchor) * (1 - UNIFIED2.anchorResidue);
      const count = this.atlas ? this.membranes.length : 0;
      const tileCount = Math.max(this.atlas?.tiles.length ?? 1, 1);

      for (let index = 0; index < count; index++) {
        const light = this.membranes[index]!;
        const key = light.seed * 16 + light.slot;
        const depth = mix(UNIFIED2.depthNear, UNIFIED2.depthFar, hash01(key, 11.3));
        const halfHeight = this.halfHeightAt(depth);
        const halfWidth = halfHeight * Math.max(this.aspectRatio, 0.01);

        // 散る側の位置と、起点をこの奥行きへ投影した位置。連続に混ぜる。
        const scatterX = (hash01(key, 1.7) * 2 - 1) * halfWidth * UNIFIED2.positionSpread;
        const scatterY = (hash01(key, 3.1) * 2 - 1) * halfHeight * UNIFIED2.positionSpread;
        const projection = depth / UNIFIED2.core.depth;
        this.offsets[index * 3 + 0] = mix(scatterX, light.originX * projection, toOrigin);
        this.offsets[index * 3 + 1] = mix(scatterY, light.originY * projection, toOrigin);
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
        this.sizes[index * 3 + 2] = Math.floor(hash01(key, 13.7) * tileCount) % tileCount;

        // 切り取りの中心。半幅を差し引いた範囲に収めて、マスの外へは出さない。
        const room = Math.max(0.5 - cropHalf, 0);
        this.crops[index * 4 + 0] = 0.5 + (hash01(key, 17.1) * 2 - 1) * room;
        this.crops[index * 4 + 1] = 0.5 + (hash01(key, 19.3) * 2 - 1) * room;
        this.crops[index * 4 + 2] = cropHalf;
        this.crops[index * 4 + 3] = cropHalf;

        const spin = hash01(key, 23.9) * Math.PI * 2;
        this.orients[index * 4 + 0] = Math.cos(spin);
        this.orients[index * 4 + 1] = Math.sin(spin);
        this.orients[index * 4 + 2] = hash01(key, 29.5) < 0.5 ? -1 : 1;
        this.orients[index * 4 + 3] = hash01(key, 31.1) < 0.5 ? -1 : 1;

        this.levels[index] =
          envelopeLevel(
            elapsed - light.bornAt,
            envelope.membraneAttackSeconds,
            envelope.membraneDecaySeconds,
          ) * light.strength;
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
      const count = this.atlas ? this.cores.length : 0;
      const tileCount = Math.max(this.atlas?.tiles.length ?? 1, 1);
      const room = Math.max(0.5 - core.cropHalf, 0);

      for (let index = 0; index < count; index++) {
        const light = this.cores[index]!;
        const seed = light.seed;
        this.coreOffsets[index * 3 + 0] = light.originX;
        this.coreOffsets[index * 3 + 1] = light.originY;
        this.coreOffsets[index * 3 + 2] = -core.depth;

        // **Core size = 0 なら半径 0 ＝ 板が潰れて 1 画素も描かれない。**
        const jitter = 1 + (hash01(seed, core.seedSalt + 5.3) * 2 - 1) * core.sizeJitter;
        this.coreSizes[index * 2 + 0] = baseRadius * jitter;
        this.coreSizes[index * 2 + 1] =
          Math.floor(hash01(seed, core.seedSalt) * tileCount) % tileCount;

        const spin = hash01(seed, core.seedSalt + 2.7) * Math.PI * 2;
        this.coreCells[index * 4 + 0] = 0.5 + (hash01(seed, core.seedSalt + 1.3) * 2 - 1) * room;
        this.coreCells[index * 4 + 1] = 0.5 + (hash01(seed, core.seedSalt + 1.9) * 2 - 1) * room;
        this.coreCells[index * 4 + 2] = Math.cos(spin);
        this.coreCells[index * 4 + 3] = Math.sin(spin);
        this.coreFlips[index * 2 + 0] = hash01(seed, core.seedSalt + 3.1) < 0.5 ? -1 : 1;
        this.coreFlips[index * 2 + 1] = hash01(seed, core.seedSalt + 3.7) < 0.5 ? -1 : 1;

        this.coreLevels[index] =
          envelopeLevel(
            elapsed - light.bornAt,
            envelope.coreAttackSeconds,
            envelope.coreDecaySeconds,
          ) * light.strength;
      }
      this.coreGeometry.instanceCount = count;
      for (const attribute of Object.values(this.coreAttributes)) attribute.needsUpdate = true;
    }
  }

  /** 軸のうち、フラグメント側の数式へ直に効くもの。毎フレーム流し込む。 */
  private syncUniforms(): void {
    const intensity = Math.max(this.params.intensity, 0);
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
    }

    const core = this.coreMaterial;
    if (core) {
      // 質の軸。軸 1 で手続きの芯が抜け、素材の形だけが残る。
      // **コアの有無はここでは決めない**（大きさが決める）。
      (core.uniforms.uCore!.value as THREE.Vector4).x = 1 - clamp01(this.params.coreForm);
      core.uniforms.uIntensity!.value = intensity;
    }
  }

  update(elapsed: number): void {
    const delta =
      this.previousElapsed < 0
        ? 0
        : clamp(elapsed - this.previousElapsed, 0, UNIFIED2.maximumDelta);
    this.previousElapsed = elapsed;

    // **捨てるのが先。** 生まれた瞬間の光は age = 0 ＝ 振幅 0 なので、
    // 検出のあとに捨てると生まれたそばから消えてしまう。
    this.cull(elapsed);
    this.detectEvents(elapsed, delta);
    this.resolveTint(delta);
    this.syncUniforms();
    this.writeLights(elapsed);

    const audio = this.context?.audioEngine.getParameters() ?? {};
    this.updateHazeStudy(clamp01(audio.volume ?? 0), delta);
    this.pipeline?.update(audio, elapsed);
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
      UNIFIED2.hazeStudy.intensity * this.hazeLevel * this.params.intensity;
  }

  render(): void {
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    const ratio = Math.max(width / Math.max(height, 1), 0.01);
    if (this.camera) {
      this.camera.aspect = ratio;
      this.camera.updateProjectionMatrix();
    }
    this.pipeline?.resize(width, height);
  }

  // ---------------------------------------------------------------- UI の面

  setGeneratorsVisible(visible: boolean): void {
    if (this.scene) this.scene.visible = visible;
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
    ): ExpressionParam => ({
      key,
      label,
      group,
      ...PARAM_RANGES[key],
      value: this.params[key],
    });
    const membrane = '膜（素材が形）';
    const core = 'コア（打撃で生まれる）';
    const common = '色と音';
    const study = 'Study preview';
    return [
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
        ],
        value: this.fragmentPreview,
      },
      row('crop', 'Crop (狭い＝素材の線が筋になる ⇄ 広い＝細かい濃淡)', membrane),
      row('scale', 'Scale (小さい ⇄ 画面より大きい)', membrane),
      row('softness', 'Softness (鋭い＝明部だけ残る ⇄ 霧状＝暗部まで一様)', membrane),
      row('carve', 'Carve (緩いビネット＝素材が形 ⇄ 硬い円窓＝外形で切る)', membrane),
      row('anchor', 'Anchor (画面内に散る ⇄ 起点から生まれる)', membrane),
      row('membranes', 'Membranes (1 打撃で生む枚数)', membrane),
      row('coreForm', 'Core form (手続きの芯 ⇄ 素材が形)', core),
      row('coreSize', 'Core size (0 = コアを消す ⇄ 大)', core),
      row('saturation', 'Saturation (0 = 白 ⇄ 1 = 色が濃い)', common),
      row('sensitivity', 'Sensitivity (発火の感度)', common),
      row('intensity', 'Intensity (全体の強度)', common),
    ];
  }

  setExpressionParam(key: string, value: number | string): void {
    if (key === 'hazePreview' && (value === 'off' || value === 'static' || value === 'audio')) {
      this.hazePreview = value;
      this.hazeLevel = value === 'static' ? 1 : 0;
      if (this.hazeMesh) this.hazeMesh.visible = value !== 'off';
      return;
    }
    if (key === 'fragmentPreview' && (value === 'off' || value === 'static')) {
      this.fragmentPreview = value;
      if (this.fragmentMesh) this.fragmentMesh.visible = value === 'static';
      return;
    }
    if (typeof value !== 'number') return;
    if (!(key in PARAM_RANGES)) return;
    const typed = key as Unified2ParamKey;
    const range = PARAM_RANGES[typed];
    // どの軸も次のフレームの書き出しで効く。生きている光は作り直さない。
    this.params[typed] = clamp(value, range.min, range.max);
  }

  dispose(): void {
    this.disposed = true;
    this.pipeline?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.coreGeometry?.dispose();
    this.coreMaterial?.dispose();
    this.hazeGeometry?.dispose();
    this.hazeMaterial?.dispose();
    this.fragmentGeometry?.dispose();
    this.fragmentMaterial?.dispose();
    this.placeholder?.dispose();
    this.atlas?.texture.dispose();
    if (this.mesh && this.scene) this.scene.remove(this.mesh);
    if (this.coreMesh && this.scene) this.scene.remove(this.coreMesh);
    if (this.hazeMesh && this.scene) this.scene.remove(this.hazeMesh);
    if (this.fragmentMesh && this.scene) this.scene.remove(this.fragmentMesh);
    this.cores.length = 0;
    this.membranes.length = 0;
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
    this.placeholder = null;
    this.atlas = null;
    this.mesh = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
  }
}
