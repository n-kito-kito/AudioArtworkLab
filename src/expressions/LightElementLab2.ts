import * as THREE from 'three';
import type { CompositionContext, DesignLayerCanvases } from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { ExpressionParam, LabExpression } from './Expression';
import { loadPrismAtlas, type PrismAtlas, type PrismTile } from './prismAtlas';

/**
 * **Light Element Lab 2 — 1 つの光を R/G/B の 3 チャンネルとして重ねる検証。**
 *
 * V1（`LightElementLab`）は「発光ごとに色相グラデーションを割り当てる」方式で
 * 色を作っていた。ここではその方式を捨て、**色は 1 つの光の R/G/B を
 * わずかにずらして重ねることだけから生まれる**（CRT のシャドウマスクや
 * 色収差と同じ構造）という別の色生成方式を検証する。
 *
 * 検証の作りとしての約束:
 *   - **音へは繋がない。** 静止画で見え方だけを見る（分解して検証する）。
 *     無音でも固定表示するのは開発用の例外で、この表現だけの扱いである。
 *   - **要素は 1 つずつ見る。** Version ボタンで Core / Sheet / Haze / Ray / All を
 *     切り替える。単独モードはインスタンス 1 枚だけなので、画素を数えれば
 *     「どれだけずらすと色が出るか」をそのまま実測できる。
 *   - **色相グラデーションは既定で OFF。** つまみで ON にできるのは、
 *     V1 の方式と同じ画面で見比べるためだけである。
 *   - 素材（`prismAtlas` の 10 枚）は作り直さない。V1 と同じ素材・同じ輝度マスクを、
 *     チャンネルごとに微小オフセットした UV で 3 回読むだけである。
 *
 * 描画は **1 ドロー**。層は `InstancedBufferGeometry` の 1 メッシュで、
 * 種類（Core / Sheet / Haze / Ray）はフラグメントの分岐で切り替える。
 * チャンネル分離のためにインスタンスは増やさない（1 フラグメントで 3 回読む）。
 *
 * V1・Light Reactive Lab・Light Spatial Study のコードと状態は共有しない。
 * 再利用するのは `prismAtlas` と `EffectPipeline` だけである。
 */

export type LightElement2Mode = 'core' | 'sheet' | 'haze' | 'ray' | 'all';

const MODE_LABELS: Readonly<Record<LightElement2Mode, string>> = {
  core: 'Core',
  sheet: 'Sheet',
  haze: 'Haze',
  ray: 'Ray',
  all: 'All',
};

/** 種類 → シェーダーへ渡す番号。フラグメントの分岐と対応する。 */
const KIND_INDEX: Readonly<Record<Element2Kind, number>> = {
  core: 0,
  sheet: 1,
  haze: 2,
  ray: 3,
};

type Element2Kind = 'core' | 'sheet' | 'haze' | 'ray';

/**
 * 静的な層 1 枚の宣言。**すべて定数**で、音も時間も乱数も入らない。
 * 同じモードなら毎回まったく同じ絵になる。
 */
interface Element2Layer {
  readonly kind: Element2Kind;
  /** ワールド座標（カメラは原点で -Z を向く）。 */
  readonly position: readonly [number, number, number];
  /** 板の半幅・半高（ワールド単位）。 */
  readonly half: readonly [number, number];
  /** 面内回転（ラジアン）。面はカメラ正面に固定する（検証なので歪ませない）。 */
  readonly spin: number;
  /** 使いたい素材の役割。無ければ `fallbackTile`。 */
  readonly preferredRoles: readonly string[];
  readonly fallbackTile: number;
  /** UV クロップ（中心 u,v と半径 su,sv）。 */
  readonly crop: readonly [number, number, number, number];
  /** UV の回転（ラジアン）と反転。 */
  readonly uvAngle: number;
  readonly flipX: number;
  readonly flipY: number;
  /** 比較用の色相グラデーション（既定 OFF）でだけ使う値。 */
  readonly hueOffset: number;
  readonly hueSpan: number;
  readonly gradientForm: number;
  /** 1 枚あたりの明るさ。 */
  readonly intensity: number;
  /** 光条の芯の半幅（ray のみ・ローカル座標）。 */
  readonly rayWidth: number;
  /**
   * **その要素自身の軸**（単位ベクトル・ローカル平面）。
   * 「軸沿い」モードのチャンネル分離方向になる。面の要素は長辺（ローカル U）、
   * Ray だけは芯を横切る向き（ローカル V）— 芯に沿ってずらしても
   * 直線は自分自身に重なるだけで、色が出ないためである。
   */
  readonly axis: readonly [number, number];
}

/** この検証の定数。質感の数値はすべてここに集める。 */
const ELEMENT2 = {
  /** インスタンスの上限。静的なので実際に使うのは All モードの 5 枚だけ。 */
  maximumLayers: 8,
  fieldOfView: 45,
  nearPlane: 0.1,
  farPlane: 80,
  atlas: {
    manifestUrl: 'assets/light-traces/manifest.json',
    cellPixels: 384,
    columns: 4,
  },
  /**
   * チャンネルごとの UV 歪みの非相関の強さ（つまみ 1.0 のときの UV 変位）。
   * クロップ座標なので 0.05 で素材の 5% ぶんずれる。
   */
  decorrelationScale: 0.05,
  /** 開発つまみの既定値。 */
  defaults: {
    redGain: 1,
    greenGain: 1,
    blueGain: 1,
    channelOffset: 0.03,
    decorrelation: 0,
    intensity: 1.6,
  },
  ranges: {
    redGain: { min: 0, max: 1, step: 0.01 },
    greenGain: { min: 0, max: 1, step: 0.01 },
    blueGain: { min: 0, max: 1, step: 0.01 },
    // 「ほんの少し」から「3 分離」まで通しで見たいので、上は広く取る。
    channelOffset: { min: 0, max: 0.5, step: 0.002 },
    decorrelation: { min: 0, max: 1, step: 0.01 },
    intensity: { min: 0, max: 4, step: 0.05 },
  },
} as const;

type Element2ParamKey = keyof typeof ELEMENT2.defaults;

/** 分離方向の決め方。 */
type OffsetMode = 'radial' | 'axis';

/**
 * バーストの中心（ワールド XY）。**放射状モードの原点**で、
 * 単独モードでは要素の中心と一致する。
 */
const BURST_CENTRE = { x: 0, y: 0 } as const;

/** 単独モードの 1 枚。中心に据え、画面いっぱいに見えるだけの大きさにする。 */
const SINGLE_LAYERS: Readonly<Record<Element2Kind, Element2Layer>> = {
  core: {
    kind: 'core',
    position: [0, 0, -5.6],
    half: [1.05, 1.05],
    spin: 0,
    preferredRoles: ['layered-sheets', 'curved-volume'],
    fallbackTile: 3,
    crop: [0.5, 0.5, 0.88, 0.88],
    uvAngle: 0,
    flipX: 1,
    flipY: 1,
    hueOffset: 0.12,
    hueSpan: 0.38,
    gradientForm: 0,
    intensity: 1,
    rayWidth: 0.06,
    axis: [1, 0],
  },
  sheet: {
    kind: 'sheet',
    position: [0, 0, -6.6],
    half: [1.85, 1.3],
    spin: 0,
    preferredRoles: ['wide-caustic', 'layered-sheets'],
    fallbackTile: 6,
    crop: [0.5, 0.5, 0.95, 0.72],
    uvAngle: 0,
    flipX: 1,
    flipY: 1,
    hueOffset: 0.08,
    hueSpan: 0.65,
    gradientForm: 0,
    intensity: 1,
    rayWidth: 0.06,
    axis: [1, 0],
  },
  haze: {
    kind: 'haze',
    position: [0, 0, -8.4],
    half: [3.1, 2.3],
    spin: 0,
    preferredRoles: ['wide-haze', 'curved-volume'],
    fallbackTile: 4,
    crop: [0.5, 0.5, 0.9, 0.78],
    uvAngle: 0,
    flipX: 1,
    flipY: 1,
    hueOffset: 0.66,
    hueSpan: 0.28,
    gradientForm: 1,
    intensity: 1,
    rayWidth: 0.06,
    axis: [1, 0],
  },
  ray: {
    kind: 'ray',
    position: [0, 0, -6],
    half: [2.35, 0.55],
    spin: 0,
    preferredRoles: [],
    fallbackTile: 0,
    crop: [0.5, 0.5, 0.9, 0.9],
    uvAngle: 0,
    flipX: 1,
    flipY: 1,
    hueOffset: 0,
    hueSpan: 0.4,
    gradientForm: 0,
    intensity: 1,
    rayWidth: 0.05,
    // 芯を横切る向き。芯沿いにずらしても直線は自分に重なるだけなので色が出ない。
    axis: [0, 1],
  },
};

/** All モード。同じ光として重なるかを見るだけの並び（V1 の Composite と同じ役割）。 */
const ALL_LAYERS: readonly Element2Layer[] = [
  { ...SINGLE_LAYERS.haze, position: [0, 0, -8.8], half: [3.3, 2.45], intensity: 0.62 },
  {
    ...SINGLE_LAYERS.sheet,
    position: [-0.62, 0.06, -7],
    half: [1.5, 1.18],
    spin: 0.12,
    intensity: 0.82,
  },
  {
    ...SINGLE_LAYERS.sheet,
    position: [0.74, -0.12, -6.4],
    half: [1.22, 1.02],
    spin: -0.2,
    uvAngle: 0.6,
    flipX: -1,
    preferredRoles: ['parallel-curtains', 'filament-and-curtain'],
    fallbackTile: 7,
    intensity: 0.72,
  },
  { ...SINGLE_LAYERS.ray, position: [0, 0.05, -6.1], half: [2.45, 0.5], intensity: 0.55 },
  { ...SINGLE_LAYERS.core, position: [0, 0, -5.6], half: [0.86, 0.86], intensity: 1 },
];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const layersFor = (mode: LightElement2Mode): readonly Element2Layer[] =>
  mode === 'all' ? ALL_LAYERS : [SINGLE_LAYERS[mode]];

export class LightElementLab2 implements LabExpression {
  readonly animated = true;
  readonly name: string;
  readonly id: ExpressionId;
  readonly mode: LightElement2Mode;

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  private readonly params: Record<Element2ParamKey, number> = { ...ELEMENT2.defaults };
  private offsetMode: OffsetMode = 'radial';
  /** 比較用に V1 の色相グラデーションを被せるか。既定は OFF（色はチャンネル分離だけから作る）。 */
  private hueGradient = false;

  private readonly layers: readonly Element2Layer[];

  private context: CompositionContext | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private geometry: THREE.InstancedBufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  private placeholder: THREE.DataTexture | null = null;
  private atlas: PrismAtlas | null = null;
  private pipeline: EffectPipeline | null = null;
  private disposed = false;

  // ---- インスタンス属性（静的。アトラスが届いたときだけ書き直す）----
  private readonly offsets = new Float32Array(ELEMENT2.maximumLayers * 3);
  private readonly sizes = new Float32Array(ELEMENT2.maximumLayers * 3);
  private readonly spins = new Float32Array(ELEMENT2.maximumLayers);
  private readonly crops = new Float32Array(ELEMENT2.maximumLayers * 4);
  private readonly orients = new Float32Array(ELEMENT2.maximumLayers * 4);
  private readonly tones = new Float32Array(ELEMENT2.maximumLayers * 4);
  private readonly extras = new Float32Array(ELEMENT2.maximumLayers * 4);
  private readonly centres = new Float32Array(ELEMENT2.maximumLayers * 2);
  private readonly attributes: Record<string, THREE.InstancedBufferAttribute> = {};

  constructor(
    id: ExpressionId,
    mode: LightElement2Mode,
    effects: Effect[] = [],
    theme?: Theme,
  ) {
    this.id = id;
    this.mode = mode;
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
    this.layers = layersFor(mode);
    this.name = `Light Element Lab 2 — ${MODE_LABELS[mode]}`;
  }

  // ---------------------------------------------------------------- setup

  setup(context: CompositionContext): void {
    this.context = context;
    // 同じインスタンスが setup をやり直すことがある。印を残すとアトラスを結び直さない。
    this.disposed = false;

    this.camera = new THREE.PerspectiveCamera(
      ELEMENT2.fieldOfView,
      this.aspectRatio,
      ELEMENT2.nearPlane,
      ELEMENT2.farPlane,
    );
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(0, 0, -1);
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();

    this.placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.placeholder.colorSpace = THREE.SRGBColorSpace;
    this.placeholder.needsUpdate = true;

    this.buildMesh();
    this.writeLayers();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    if (this.mesh) this.scene.add(this.mesh);

    this.pipeline = new EffectPipeline(
      context.renderer,
      this.scene,
      this.camera,
      this.effects,
    );

    // 素材は非同期。届くまで層は素材を読めないだけで、表現は壊れない。
    void loadPrismAtlas(ELEMENT2.atlas).then((atlas) => {
      if (!atlas) return;
      if (this.disposed) {
        atlas.texture.dispose();
        return;
      }
      this.atlas = atlas;
      if (this.material) {
        this.material.uniforms.uAtlas!.value = atlas.texture;
        this.material.uniforms.uGrid!.value.set(atlas.columns, atlas.rows);
      }
      this.writeLayers();
    });
  }

  /**
   * **1 ドローで全層を描く板。**
   * チャンネル分離はフラグメントの中で 3 回読むだけなので、
   * インスタンス数は V1 と同じ（分離のために 3 倍にはしない）。
   */
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
    add('aSpin', this.spins, 1);
    add('aCrop', this.crops, 4);
    add('aOrient', this.orients, 4);
    add('aTone', this.tones, 4);
    add('aExtra', this.extras, 4);
    add('aCentre', this.centres, 2);
    geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.placeholder },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uIntensity: { value: ELEMENT2.defaults.intensity },
        uChannelGain: { value: new THREE.Vector3(1, 1, 1) },
        uOffset: { value: ELEMENT2.defaults.channelOffset },
        uOffsetMode: { value: 0 },
        uDecorrelation: { value: ELEMENT2.defaults.decorrelation },
        uGradient: { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec3 aSize;
        attribute float aSpin;
        attribute vec4 aCrop;
        attribute vec4 aOrient;
        attribute vec4 aTone;
        attribute vec4 aExtra;
        attribute vec2 aCentre;
        varying vec2 vLocal;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying vec4 vTone;
        varying vec4 vExtra;
        varying vec2 vCentre;
        varying float vTile;

        void main() {
          vLocal = position.xy * 2.0;
          vCrop = aCrop;
          vOrient = aOrient;
          vTone = aTone;
          vExtra = aExtra;
          vCentre = aCentre;
          vTile = aSize.z;

          // 面はカメラ正面。検証なので遠近以外の歪みを入れない。
          float cs = cos(aSpin);
          float sn = sin(aSpin);
          vec2 planar = vec2(
            vLocal.x * aSize.x * cs - vLocal.y * aSize.y * sn,
            vLocal.x * aSize.x * sn + vLocal.y * aSize.y * cs
          );
          vec3 world = aOffset + vec3(planar, 0.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec2 uGrid;
        uniform float uIntensity;
        uniform vec3 uChannelGain;
        uniform float uOffset;
        uniform float uOffsetMode;
        uniform float uDecorrelation;
        uniform float uGradient;
        varying vec2 vLocal;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying vec4 vTone;
        varying vec4 vExtra;
        varying vec2 vCentre;
        varying float vTile;

        const float TAU = 6.28318530718;
        const float DECORRELATION_SCALE = ${ELEMENT2.decorrelationScale.toFixed(4)};

        float labLuminance(vec3 color) {
          return dot(color, vec3(0.2126, 0.7152, 0.0722));
        }

        vec3 sampleTile(vec2 localUv) {
          float column = mod(vTile, uGrid.x);
          float row = floor(vTile / uGrid.x);
          float textureRow = uGrid.y - 1.0 - row;
          vec2 safeUv = clamp(localUv, vec2(0.02), vec2(0.98));
          return texture2D(uAtlas, (vec2(column, textureRow) + safeUv) / uGrid).rgb;
        }

        /** 比較用（V1 方式）の分光。既定では通らない。 */
        vec3 spectrum(float t) {
          vec3 phase = vec3(0.0, 0.34, 0.67);
          return 0.52 + 0.48 * cos(TAU * (t + phase));
        }

        float gradientAt(vec2 p, float form) {
          if (form < 0.5) return p.x * 0.5 + 0.5;
          if (form < 1.5) return clamp(length(p), 0.0, 1.0);
          if (form < 2.5) return p.y * 0.5 + 0.5;
          return atan(p.y, p.x) * 0.1591549 + 0.5;
        }

        /**
         * チャンネルごとの UV 歪みの非相関。**0 なら 3 チャンネル完全に同一の歪み**で、
         * 色は幾何的なオフセットだけから生まれる。上げると膜の内部で
         * チャンネルの読む場所が別々にずれる。時間には依らない（静止画）。
         */
        vec2 decorrelate(vec2 uv, float channel) {
          if (uDecorrelation <= 0.0) return uv;
          float phase = channel * 2.0943951;
          vec2 warp = vec2(
            sin(uv.y * 9.0 + phase),
            cos(uv.x * 7.5 + phase * 1.37)
          );
          return uv + warp * uDecorrelation * DECORRELATION_SCALE;
        }

        /**
         * **1 チャンネルぶんの輝度マスク。** 素材の読み位置も窓の位置も
         * 渡された p で決まるので、p をずらせばそのチャンネルの光ごとずれる。
         */
        float elementMask(vec2 p, float channel) {
          float kind = vTone.z;

          // ---- Ray: 直線だけ。素材は読まない ----
          if (kind > 2.5) {
            float across = abs(p.y) / max(vExtra.x, 0.0001);
            float spine = exp(-across * across);
            float halo = exp(-across * across * 0.02) * 0.1;
            float along = clamp(1.0 - abs(p.x), 0.0, 1.0);
            return (spine + halo) * pow(along, 0.25);
          }

          // ---- Core / Sheet / Haze: 素材の輝度を読む ----
          vec2 q = vec2(
            p.x * vOrient.x - p.y * vOrient.y,
            p.x * vOrient.y + p.y * vOrient.x
          );
          q *= vec2(vOrient.z, vOrient.w);
          vec2 localUv = vCrop.xy + q * 0.5 * vec2(vCrop.z, vCrop.w);
          vec3 source = sampleTile(decorrelate(localUv, channel));
          float sourceLight = pow(max(labLuminance(source) * 3.2, 0.0), 0.55);

          // 板の四角い輪郭は見せない。楕円の窓で必ず 0 にする。
          float ellipse = length(p / vec2(1.0, 0.78));
          float softEdge = 1.0 - smoothstep(0.58, 1.03, ellipse);
          if (softEdge <= 0.0) return 0.0;

          float radial2 = dot(p, p);
          float nucleus = exp(-radial2 * 34.0);
          float localHalo = exp(-radial2 * 4.2);
          float coreShape =
            softEdge * (sourceLight * 1.38 + nucleus * 0.34 + localHalo * 0.045);
          float centralVeil = exp(-p.y * p.y * 4.0) * exp(-p.x * p.x * 0.72);
          float sheetShape = softEdge * (sourceLight * 1.08 + centralVeil * 0.055);
          float hazeShape = softEdge * sourceLight * 0.72;
          return kind < 0.5 ? coreShape : (kind < 1.5 ? sheetShape : hazeShape);
        }

        void main() {
          vec2 p = vLocal;

          // 分離の向き。放射状はバースト中心から外向き、軸沿いは要素自身の軸。
          vec2 dir;
          if (uOffsetMode < 0.5) {
            vec2 away = p - vCentre;
            dir = dot(away, away) > 1e-8 ? normalize(away) : vec2(1.0, 0.0);
          } else {
            dir = normalize(vExtra.zw);
          }
          vec2 shift = dir * uOffset;

          // R は +、G は中央、B は −。等間隔なので R=G=B のときは無彩色になる。
          float maskR = elementMask(p + shift, 0.0);
          float maskG = elementMask(p, 1.0);
          float maskB = elementMask(p - shift, 2.0);
          vec3 channels = max(vec3(maskR, maskG, maskB), 0.0) * uChannelGain;
          if (channels.r + channels.g + channels.b <= 0.0) discard;

          vec3 color = channels * vTone.w * uIntensity;

          // 比較用に V1 の色相グラデーションを掛ける（既定は通らない）。
          if (uGradient > 0.5) {
            color *= spectrum(vTone.x + gradientAt(p, vExtra.y) * vTone.y);
          }

          gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
        }
      `,
    });

    this.geometry = geometry;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  /** 静的な層をインスタンス属性へ書く。アトラスが届いたときも素材番号だけ更新される。 */
  private writeLayers(): void {
    if (!this.geometry) return;
    const count = Math.min(this.layers.length, ELEMENT2.maximumLayers);
    for (let index = 0; index < count; index++) {
      const layer = this.layers[index]!;
      const tile = this.tileFor(layer);
      this.offsets[index * 3] = layer.position[0];
      this.offsets[index * 3 + 1] = layer.position[1];
      this.offsets[index * 3 + 2] = layer.position[2];
      this.sizes[index * 3] = layer.half[0];
      this.sizes[index * 3 + 1] = layer.half[1];
      this.sizes[index * 3 + 2] = tile;
      this.spins[index] = layer.spin;
      this.crops[index * 4] = layer.crop[0];
      this.crops[index * 4 + 1] = layer.crop[1];
      this.crops[index * 4 + 2] = layer.crop[2];
      this.crops[index * 4 + 3] = layer.crop[3];
      this.orients[index * 4] = Math.cos(layer.uvAngle);
      this.orients[index * 4 + 1] = Math.sin(layer.uvAngle);
      this.orients[index * 4 + 2] = layer.flipX;
      this.orients[index * 4 + 3] = layer.flipY;
      this.tones[index * 4] = layer.hueOffset;
      this.tones[index * 4 + 1] = layer.hueSpan;
      this.tones[index * 4 + 2] = KIND_INDEX[layer.kind];
      this.tones[index * 4 + 3] = layer.intensity;
      this.extras[index * 4] = layer.rayWidth;
      this.extras[index * 4 + 1] = layer.gradientForm;
      this.extras[index * 4 + 2] = layer.axis[0];
      this.extras[index * 4 + 3] = layer.axis[1];
      // バースト中心をその層のローカル座標へ写す（放射状モードの原点）。
      this.centres[index * 2] = (BURST_CENTRE.x - layer.position[0]) / layer.half[0];
      this.centres[index * 2 + 1] = (BURST_CENTRE.y - layer.position[1]) / layer.half[1];
    }
    for (const attribute of Object.values(this.attributes)) attribute.needsUpdate = true;
    this.geometry.instanceCount = count;
  }

  /** 役割で素材を選ぶ。アトラスが未着なら 0 番として扱う（黒いまま）。 */
  private tileFor(layer: Element2Layer): number {
    const tiles: readonly PrismTile[] = this.atlas?.tiles ?? [];
    if (tiles.length === 0) return 0;
    for (const role of layer.preferredRoles) {
      const index = tiles.findIndex((tile) => tile.role === role);
      if (index >= 0) return index;
    }
    return clamp(layer.fallbackTile, 0, tiles.length - 1);
  }

  // ---------------------------------------------------------------- 毎フレーム

  update(elapsed: number): void {
    // 静止画の検証なので、時間で変わるものは 1 つも持たない。
    // ここで流すのはつまみの値と Effect チェーンだけである。
    const material = this.material;
    if (material) {
      material.uniforms.uIntensity!.value = this.params.intensity;
      (material.uniforms.uChannelGain!.value as THREE.Vector3).set(
        this.params.redGain,
        this.params.greenGain,
        this.params.blueGain,
      );
      material.uniforms.uOffset!.value = this.params.channelOffset;
      material.uniforms.uOffsetMode!.value = this.offsetMode === 'radial' ? 0 : 1;
      material.uniforms.uDecorrelation!.value = this.params.decorrelation;
      material.uniforms.uGradient!.value = this.hueGradient ? 1 : 0;
    }
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
    // 黒背景固定。色はチャンネル分離だけから作るので、テーマ色は描画に使わない。
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
    // 音へ繋いでいないので値は効かない。保存の往復のために保持だけする。
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

  getPhase(): string {
    const offset = this.params.channelOffset.toFixed(3);
    return `Element 2: ${MODE_LABELS[this.mode]} — offset ${offset} (${this.offsetMode})`;
  }

  getExpressionParams(): ExpressionParam[] {
    const row = (key: Element2ParamKey, label: string): ExpressionParam => ({
      key,
      label,
      ...ELEMENT2.ranges[key],
      value: this.params[key],
    });
    return [
      row('redGain', 'Red'),
      row('greenGain', 'Green'),
      row('blueGain', 'Blue'),
      row('channelOffset', 'Channel offset'),
      {
        key: 'offsetMode',
        label: 'Offset direction',
        type: 'select',
        options: [
          { value: 'radial', label: 'Radial from burst centre' },
          { value: 'axis', label: 'Along element axis' },
        ],
        value: this.offsetMode,
      },
      row('decorrelation', 'Channel decorrelation'),
      row('intensity', 'Intensity'),
      {
        key: 'hueGradient',
        label: 'Hue gradient (compare with V1)',
        type: 'select',
        options: [
          { value: 'off', label: 'Off (channels only)' },
          { value: 'on', label: 'On (V1 style)' },
        ],
        value: this.hueGradient ? 'on' : 'off',
      },
    ];
  }

  setExpressionParam(key: string, value: number | string): void {
    if (key === 'offsetMode') {
      this.offsetMode = value === 'axis' ? 'axis' : 'radial';
      return;
    }
    if (key === 'hueGradient') {
      this.hueGradient = value === 'on';
      return;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return;
    if (!(key in this.params)) return;
    const range = ELEMENT2.ranges[key as Element2ParamKey];
    this.params[key as Element2ParamKey] = clamp(numeric, range.min, range.max);
  }

  dispose(): void {
    this.disposed = true;
    this.pipeline?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.placeholder?.dispose();
    this.atlas?.texture.dispose();
    if (this.mesh && this.scene) this.scene.remove(this.mesh);
    this.pipeline = null;
    this.geometry = null;
    this.material = null;
    this.placeholder = null;
    this.atlas = null;
    this.mesh = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
  }
}
