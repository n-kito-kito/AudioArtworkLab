import * as THREE from 'three';
import type { CompositionContext, DesignLayerCanvases } from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { ExpressionParam, LabExpression } from './Expression';
import { loadPrismAtlas, type PrismAtlas } from './prismAtlas';

/**
 * **Light Unified 2 — 第 1 歩「素材が形の膜」だけ。**
 *
 * ---
 * ## 出発点
 *
 * 3 表現（Spatial / Reactive / Element Lab 2）に出ていた「引っ掻き傷のような筋」は、
 * **筋を描く式から出ていない**。`prismAtlas` の 10 枚を細長い板に貼ったとき、
 * **素材の中にもともと在る線が拡大されて現れる副産物**だった。
 * だからこの表現は「**素材が形を作る**」を最初の原理に据える。
 *
 * **手続きで筋・羽毛・ハロ・ガウスを描くコードは 1 行も持たない。**
 * 輝度の源は素材ただ 1 つで、**素材が 0 の画素は厳密に 0**（`pow(0, g) = 0`）。
 * 掛けているのは
 *
 *     色 × 素材輝度 × 緩いビネット × 強度
 *
 * だけ。ビネットは板の四角い輪郭を消すためのもので、輝度を**足すことはない**。
 *
 * ## コア（第 2 歩）
 *
 * 中心の白熱を 1 個だけ置く。位置は画面中央に固定する（移動は音へ繋いだ後）。
 * `Core form` は形の混合ではなく**手続きの芯の寄与量**で、
 * **0 = 芯が満額（Lab2）⇄ 中間 = 素材の上に芯が加算（Reactive）⇄ 1 = 芯なし（Spatial）**。
 * 詳しくは `buildCore()` の注釈。使う素材は `Core seed` から決定論で引く。
 *
 * `Anchor` 軸は**膜とコアの位置関係**で、0 = 膜が画面内に散る ⇄ 1 = 膜がコアを起点に集まる。
 *
 * ## この段階でやらないこと
 *
 * - **音へ繋がない。** 静止画で質感だけを見る開発用の表現（PRD D33 の Study/Lab の例外）。
 * - 靄・破片・貫通線を作らない。**膜とコアだけ**。
 * - 既存の `LightUnified` を継承・改造しない。共有するのは素材アトラスだけ。
 *
 * ## 決定論
 *
 * 配置・素材番号・切り取り位置・向き・色相はすべて枚数と番号のハッシュから決まる。
 * `Math.random()` も `Date.now()` も使わない。同じつまみなら毎回同じ絵になる。
 */

/** 質感の定数。つまみは連続な混合係数だけを持ち、端の値はここに置く。 */
const UNIFIED2 = {
  /** 同時に置ける膜の上限（つまみの最大と揃える）。 */
  maximumMembranes: 6,
  nearPlane: 0.1,
  farPlane: 80,
  fieldOfView: 45,
  /** 膜を置く奥行きの帯（カメラは原点で −Z を見る）。 */
  depthNear: 7,
  depthFar: 9.6,
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
  /** 画面内での散らばり（可視半径に対する割合）。 */
  positionSpread: 0.55,
  /** 色の濃さ。色そのものは軸に出さない（この段階では膜の質感だけを見る）。 */
  saturation: 0.55,
  /**
   * **Anchor 1 で膜の中心をコアへどこまで寄せるか。**
   * 0 にすると全部が完全に重なって 1 枚に見えるので、わずかに残す。
   */
  anchorResidue: 0.08,

  // ---- コア（第 2 歩で足した層）----
  core: {
    /** コアを置く奥行き。膜の帯のちょうど真ん中。 */
    depth: 8.3,
    /** コアの半径（その奥行きでの可視半高に対する割合）。 */
    sizeSmall: 0.06,
    sizeLarge: 0.42,
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
    /** 素材の切り取り半幅。膜と違って軸に出さない（コアの軸は寄与量と大きさだけ）。 */
    cropHalf: 0.3,
    /** ハッシュの味付け。**発光ごとの素材選び**は `Core seed` からこの塩を通して引く。 */
    seedSalt: 41.3,
    /** `Core seed` を整数の発光番号へ量子化する段数。隣の値で別の素材へ移る。 */
    seedSteps: 997,
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
    coreSeed: 0.2,
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
  | 'coreSeed'
  | 'intensity';

const PARAM_RANGES: Record<Unified2ParamKey, { min: number; max: number; step: number }> = {
  membranes: { min: 3, max: UNIFIED2.maximumMembranes, step: 1 },
  scale: { min: 0, max: 1, step: 0.01 },
  crop: { min: 0, max: 1, step: 0.01 },
  softness: { min: 0, max: 1, step: 0.01 },
  carve: { min: 0, max: 1, step: 0.01 },
  anchor: { min: 0, max: 1, step: 0.01 },
  coreSize: { min: 0, max: 1, step: 0.01 },
  coreForm: { min: 0, max: 1, step: 0.01 },
  coreSeed: { min: 0, max: 1, step: 0.01 },
  intensity: { min: 0, max: 2, step: 0.01 },
};

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

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
  // コアは 1 個しか無いのでインスタンス化しない。素の平面 1 枚で Draw Call も 1。
  private coreGeometry: THREE.PlaneGeometry | null = null;
  private coreMaterial: THREE.ShaderMaterial | null = null;
  private coreMesh: THREE.Mesh | null = null;
  private placeholder: THREE.DataTexture | null = null;
  private atlas: PrismAtlas | null = null;
  private pipeline: EffectPipeline | null = null;
  private disposed = false;

  // インスタンス属性。膜は最大 6 枚なので確保も書き換えも安い。
  private readonly offsets = new Float32Array(UNIFIED2.maximumMembranes * 3);
  /** 半幅 / 半高 / 素材番号。 */
  private readonly sizes = new Float32Array(UNIFIED2.maximumMembranes * 3);
  /** 切り取りの中心 UV と半幅。 */
  private readonly crops = new Float32Array(UNIFIED2.maximumMembranes * 4);
  /** 面内回転の cos / sin と UV の反転。 */
  private readonly orients = new Float32Array(UNIFIED2.maximumMembranes * 4);
  /** 色相 / 彩度 / 1 枚あたりの重み / 予備。 */
  private readonly tones = new Float32Array(UNIFIED2.maximumMembranes * 4);
  private readonly attributes: Record<string, THREE.InstancedBufferAttribute> = {};

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

    this.buildMesh();
    this.buildCore();
    this.writeCore();
    this.writeMembranes();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    if (this.mesh) this.scene.add(this.mesh);
    if (this.coreMesh) this.scene.add(this.coreMesh);

    this.pipeline = new EffectPipeline(context.renderer, this.scene, this.camera, this.effects);

    void loadPrismAtlas(UNIFIED2.atlas).then((atlas) => {
      if (!atlas) return;
      if (this.disposed) {
        atlas.texture.dispose();
        return;
      }
      this.atlas = atlas;
      if (this.material) {
        this.material.uniforms.uAtlas!.value = atlas.texture;
        (this.material.uniforms.uGrid!.value as THREE.Vector2).set(atlas.columns, atlas.rows);
      }
      if (this.coreMaterial) {
        this.coreMaterial.uniforms.uAtlas!.value = atlas.texture;
        (this.coreMaterial.uniforms.uGrid!.value as THREE.Vector2).set(atlas.columns, atlas.rows);
      }
      this.writeCore();
      this.writeMembranes();
    });
  }

  // ---------------------------------------------------------------- 描画

  private buildMesh(): void {
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
    add('aTone', this.tones, 4);
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
        attribute vec4 aTone;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying vec4 vTone;

        void main() {
          // 板の中を −1..1 で持つ。ビネットも UV も全部この座標で作る。
          vLocal = position.xy * 2.0;
          vTile = aSize.z;
          vCrop = aCrop;
          vOrient = aOrient;
          vTone = aTone;
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
        uniform float uIntensity;
        uniform float uInset;
        varying vec2 vLocal;
        varying float vTile;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying vec4 vTone;

        vec3 spectralRgb(float hue, float saturation) {
          vec3 p = fract(vec3(hue) + vec3(0.0, 0.6666667, 0.3333333)) * 6.0;
          vec3 v = clamp(min(p, 4.0 - p), 0.0, 1.0);
          return 1.0 - clamp(saturation, 0.0, 1.0) * (1.0 - v);
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
          vec2 atlasUv = (vec2(column, row) + cell) / uGrid;
          vec3 source = texture2D(uAtlas, atlasUv).rgb;

          // ④ 素材輝度。**輝度の源はここだけ。** 敷居も曲げも 0 を 0 のまま通す。
          float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
          luminance *= smoothstep(uShape.y, uShape.y + uShape.z, luminance);
          luminance = pow(max(luminance, 0.0), uShape.w);

          // ⑤ 色 × 素材輝度 × ビネット × 強度。これ以外は掛けない。
          vec3 tint = spectralRgb(vTone.x, vTone.y);
          vec3 color = tint * luminance * window * max(vTone.z, 0.0) * uIntensity;
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
   * **コア（1 個）。中心の白熱。**
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
   * 素材側は軸のどこでも常に居る（Lab2 も「楕円 + 素材」だったため）。
   * 変わるのは芯の量だけで、分岐は無く連続。色は白のみ。
   */
  private buildCore(): void {
    // 板の中を −1..1 で持つ。膜と同じ座標系にして、式の読み比べができるようにする。
    const geometry = new THREE.PlaneGeometry(2, 2);
    const core = UNIFIED2.core;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.placeholder },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uTile: { value: 0 },
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
        // 発光ごとの素材の見え方: 切り取りの中心 UV と面内回転の cos / sin。
        uCoreCell: { value: new THREE.Vector4(0.5, 0.5, 1, 0) },
        /** 同・UV の反転。 */
        uCoreFlip: { value: new THREE.Vector2(1, 1) },
        uIntensity: { value: UNIFIED2.defaults.intensity },
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
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec2 uGrid;
        uniform float uTile;
        uniform vec4 uCore;
        uniform vec4 uCoreCrop;
        uniform vec4 uCoreCell;
        uniform vec2 uCoreFlip;
        uniform float uIntensity;
        varying vec2 vLocal;

        void main() {
          vec2 p = vLocal;
          float radius2 = dot(p, p);

          // ① 手続きの芯（楕円）。r = 1 で厳密に 0 なので、板の四角はこの側では出ない。
          //    寄与量 uCore.x は Core form 1 で厳密に 0 になり、芯は完全に消える。
          float ellipse = pow(clamp(1.0 - radius2, 0.0, 1.0), uCore.y) * max(uCore.x, 0.0);

          // ② 素材が形。膜とまったく同じ読み方（敷居も 0 を 0 のまま通す）。
          //    切り取りの中心・回転・反転は発光ごとの seed から来る。
          vec2 q = vec2(
            p.x * uCoreCell.z - p.y * uCoreCell.w,
            p.x * uCoreCell.w + p.y * uCoreCell.z
          );
          q *= uCoreFlip;
          vec2 cell = clamp(
            uCoreCell.xy + q * uCoreCrop.z,
            uCoreCrop.w,
            1.0 - uCoreCrop.w
          );
          float column = mod(uTile, uGrid.x);
          float row = floor(uTile / uGrid.x);
          vec3 source = texture2D(uAtlas, (vec2(column, row) + cell) / uGrid).rgb;
          float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
          luminance *= smoothstep(uCoreCrop.x, uCoreCrop.x + uCoreCrop.y, luminance);
          float material = luminance * uCore.z;

          // ③ **加算。** 素材は軸のどこでも居て、変わるのは芯の量だけ（分岐は無い）。
          float mask = material + ellipse;

          // ④ 素材側に要る円窓。板の四角い輪郭を消すための掛け算で、輝度は足さない。
          float window = 1.0 - smoothstep(uCore.w, 1.0, length(p));

          // 白のみ（膜のような色相を持たない）。
          vec3 color = vec3(1.0) * mask * window * uIntensity;
          gl_FragColor = vec4(max(color, 0.0), 1.0);
        }
      `,
    });

    this.coreGeometry = geometry;
    this.coreMaterial = material;
    this.coreMesh = new THREE.Mesh(geometry, material);
    this.coreMesh.position.set(0, 0, -core.depth);
    this.coreMesh.frustumCulled = false;
    // 加算なので順序は絵に影響しないが、膜の後に描いておく。
    this.coreMesh.renderOrder = 1;
  }

  /**
   * **発光ごとのコアの素材を決める。**
   *
   * アトラス 10 枚のどれを使うか・素材のどこを切り出すか・面内回転・反転を、
   * `Core seed` を量子化した**発光番号**のハッシュから引く（膜と同じ流儀）。
   * `Math.random()` は使わないので、同じ seed なら毎回同じ素材・同じ切り口になる。
   *
   * 発光が複数になったら、この番号がインスタンス番号へ置き換わるだけで式は変わらない。
   */
  private writeCore(): void {
    const material = this.coreMaterial;
    if (!material) return;
    const core = UNIFIED2.core;
    const tileCount = Math.max(this.atlas?.tiles.length ?? 1, 1);
    // 連続なスライダーを整数の発光番号へ落とす。隣の値でも別の素材へ移る。
    const emission = Math.round(clamp(this.params.coreSeed, 0, 1) * core.seedSteps);

    material.uniforms.uTile!.value =
      Math.floor(hash01(emission, core.seedSalt) * tileCount) % tileCount;

    // 切り取りの中心。半幅を差し引いた範囲に収めて、マスの外へは出さない。
    const room = Math.max(0.5 - core.cropHalf, 0);
    const spin = hash01(emission, core.seedSalt + 2.7) * Math.PI * 2;
    (material.uniforms.uCoreCell!.value as THREE.Vector4).set(
      0.5 + (hash01(emission, core.seedSalt + 1.3) * 2 - 1) * room,
      0.5 + (hash01(emission, core.seedSalt + 1.9) * 2 - 1) * room,
      Math.cos(spin),
      Math.sin(spin),
    );
    (material.uniforms.uCoreFlip!.value as THREE.Vector2).set(
      hash01(emission, core.seedSalt + 3.1) < 0.5 ? -1 : 1,
      hash01(emission, core.seedSalt + 3.7) < 0.5 ? -1 : 1,
    );
  }

  /** その奥行きでの可視半高（ワールド単位）。カメラは原点で −Z を見る。 */
  private halfHeightAt(depth: number): number {
    const half = Math.tan((UNIFIED2.fieldOfView * Math.PI) / 360) * depth;
    return half / Math.max(this.zoom, 0.01);
  }

  /**
   * 膜を並べ直す。位置・素材・切り取り・向き・色相はすべてハッシュから決まるので、
   * つまみが同じなら何度呼んでも同じ絵になる。
   */
  private writeMembranes(): void {
    if (!this.geometry) return;
    const count = Math.round(clamp(this.params.membranes, 3, UNIFIED2.maximumMembranes));
    const tileCount = Math.max(this.atlas?.tiles.length ?? 1, 1);
    const cropHalf = mix(UNIFIED2.cropNarrow, UNIFIED2.cropWide, clamp(this.params.crop, 0, 1));
    const scale = mix(UNIFIED2.scaleSmall, UNIFIED2.scaleLarge, clamp(this.params.scale, 0, 1));
    // **Anchor。** コア（画面中央）を起点に膜の中心を引き寄せる連続な係数。
    // 1 でも完全には重ねない（重ねると 6 枚が 1 枚に見えてしまう）。
    const anchorPull = mix(1, UNIFIED2.anchorResidue, clamp(this.params.anchor, 0, 1));

    for (let index = 0; index < count; index++) {
      // 枚数を変えても既存の膜が総入れ替えにならないよう、種は番号だけから作る。
      const depth = mix(UNIFIED2.depthNear, UNIFIED2.depthFar, hash01(index, 11.3));
      const halfHeight = this.halfHeightAt(depth);
      const halfWidth = halfHeight * Math.max(this.aspectRatio, 0.01);

      this.offsets[index * 3 + 0] =
        (hash01(index, 1.7) * 2 - 1) * halfWidth * UNIFIED2.positionSpread * anchorPull;
      this.offsets[index * 3 + 1] =
        (hash01(index, 3.1) * 2 - 1) * halfHeight * UNIFIED2.positionSpread * anchorPull;
      this.offsets[index * 3 + 2] = -depth;

      // 板の縦横比。**細長い板が素材の線を異方的に引き伸ばす**（筋はこの副産物）。
      const elongation = mix(
        UNIFIED2.elongationMinimum,
        UNIFIED2.elongationMaximum,
        hash01(index, 5.9),
      );
      const jitter = 1 + (hash01(index, 7.3) * 2 - 1) * UNIFIED2.sizeJitter;
      const radius = halfHeight * scale * jitter;
      this.sizes[index * 3 + 0] = radius * Math.sqrt(elongation);
      this.sizes[index * 3 + 1] = radius / Math.sqrt(elongation);
      this.sizes[index * 3 + 2] = Math.floor(hash01(index, 13.7) * tileCount) % tileCount;

      // 切り取りの中心。半幅を差し引いた範囲に収めて、マスの外へは出さない。
      const room = Math.max(0.5 - cropHalf, 0);
      this.crops[index * 4 + 0] = 0.5 + (hash01(index, 17.1) * 2 - 1) * room;
      this.crops[index * 4 + 1] = 0.5 + (hash01(index, 19.3) * 2 - 1) * room;
      this.crops[index * 4 + 2] = cropHalf;
      this.crops[index * 4 + 3] = cropHalf;

      const spin = hash01(index, 23.9) * Math.PI * 2;
      this.orients[index * 4 + 0] = Math.cos(spin);
      this.orients[index * 4 + 1] = Math.sin(spin);
      this.orients[index * 4 + 2] = hash01(index, 29.5) < 0.5 ? -1 : 1;
      this.orients[index * 4 + 3] = hash01(index, 31.1) < 0.5 ? -1 : 1;

      this.tones[index * 4 + 0] = hash01(index, 37.7);
      this.tones[index * 4 + 1] = UNIFIED2.saturation;
      this.tones[index * 4 + 2] = 1;
      this.tones[index * 4 + 3] = 0;
    }

    this.geometry.instanceCount = this.atlas ? count : 0;
    for (const attribute of Object.values(this.attributes)) attribute.needsUpdate = true;
  }

  /** 軸のうち、フラグメント側の数式へ直に効くもの。毎フレーム流し込む。 */
  private syncUniforms(): void {
    const intensity = Math.max(this.params.intensity, 0);
    const material = this.material;
    if (material) {
      const softness = clamp(this.params.softness, 0, 1);
      const carve = clamp(this.params.carve, 0, 1);
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
      // 軸 1 で厳密に 0 ＝ 手続きの芯が完全に消える。
      (core.uniforms.uCore!.value as THREE.Vector4).x = 1 - clamp(this.params.coreForm, 0, 1);
      core.uniforms.uIntensity!.value = intensity;
    }
    if (this.coreMesh) {
      const radius =
        this.halfHeightAt(UNIFIED2.core.depth) *
        mix(UNIFIED2.core.sizeSmall, UNIFIED2.core.sizeLarge, clamp(this.params.coreSize, 0, 1));
      this.coreMesh.scale.set(radius, radius, 1);
    }
  }

  update(elapsed: number): void {
    // 静止画。時間で変わるものは 1 つも持たない（音へも繋がない）。
    this.syncUniforms();
    const audio = this.context?.audioEngine.getParameters() ?? {};
    this.pipeline?.update(audio, elapsed);
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
    // 黒背景固定。色は膜ごとの色相からだけ作る。
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
    this.writeMembranes();
  }

  getResponse(): { bass: number; mid: number; treble: number } {
    return { ...this.response };
  }

  setResponse(gains: Partial<{ bass: number; mid: number; treble: number }>): void {
    // 音へ繋いでいないので効かない。保存の往復のために保持だけする。
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
    this.writeMembranes();
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

  /**
   * **開発用の軸。**
   *
   * 「Spatial 的 ⇄ Reactive 的 ⇄ Lab2 的」の質感の差を静止画で作れるだけの本数に絞る。
   * すべて連続な混合係数で、`if (axis > 0.5)` のような分岐はどこにも無い。
   */
  getExpressionParams(): ExpressionParam[] {
    const row = (key: Unified2ParamKey, label: string): ExpressionParam => ({
      key,
      label,
      group: '膜（素材が形）',
      ...PARAM_RANGES[key],
      value: this.params[key],
    });
    const coreRow = (key: Unified2ParamKey, label: string): ExpressionParam => ({
      ...(row(key, label) as ExpressionParam),
      group: 'コア（白熱）',
    });
    return [
      row('crop', 'Crop (狭い＝素材の線が筋になる ⇄ 広い＝細かい濃淡)'),
      row('scale', 'Scale (小さい ⇄ 画面より大きい)'),
      row('softness', 'Softness (鋭い＝明部だけ残る ⇄ 霧状＝暗部まで一様)'),
      row('carve', 'Carve (緩いビネット＝素材が形 ⇄ 硬い円窓＝外形で切る)'),
      row('anchor', 'Anchor (画面内に散る ⇄ コアを起点に集まる)'),
      row('membranes', 'Membranes (枚数)'),
      coreRow('coreForm', 'Core form (手続きの芯が満額 ⇄ 芯なし＝素材だけが光る)'),
      coreRow('coreSize', 'Core size (小 ⇄ 大)'),
      coreRow('coreSeed', 'Core seed (発光ごとの素材・切り口)'),
      coreRow('intensity', 'Intensity (全体の強度)'),
    ];
  }

  setExpressionParam(key: string, value: number | string): void {
    if (typeof value !== 'number') return;
    if (!(key in PARAM_RANGES)) return;
    const typed = key as Unified2ParamKey;
    const range = PARAM_RANGES[typed];
    this.params[typed] = clamp(value, range.min, range.max);
    // 配置に効く軸だけ並べ直す。曲げ・ビネット・コア・強度は uniform なので毎フレーム届く。
    if (typed === 'membranes' || typed === 'scale' || typed === 'crop' || typed === 'anchor') {
      this.writeMembranes();
    }
    if (typed === 'coreSeed') this.writeCore();
  }

  dispose(): void {
    this.disposed = true;
    this.pipeline?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.coreGeometry?.dispose();
    this.coreMaterial?.dispose();
    this.placeholder?.dispose();
    this.atlas?.texture.dispose();
    if (this.mesh && this.scene) this.scene.remove(this.mesh);
    if (this.coreMesh && this.scene) this.scene.remove(this.coreMesh);
    this.pipeline = null;
    this.geometry = null;
    this.material = null;
    this.coreGeometry = null;
    this.coreMaterial = null;
    this.coreMesh = null;
    this.placeholder = null;
    this.atlas = null;
    this.mesh = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
  }
}
