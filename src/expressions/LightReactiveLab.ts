import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { CompositionContext, DesignLayerCanvases } from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import {
  BandLightEventDetector,
  type BandLightEvent,
  type BandName,
} from '../engine/bandLightEvents';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { ExpressionParam, LabExpression } from './Expression';
import { loadPrismAtlas, type PrismAtlas } from './prismAtlas';
import {
  PrismaticBurstPlanner,
  type BurstSettings,
  type CompositionType,
  type PlannedReactiveLayer,
  type ReactiveLayerTraits,
  type ReactiveStage,
} from './reactiveBurst';

/**
 * **Light Reactive Lab — 音イベントに反応するプリズム光。**
 *
 * 静的な `LightElementLab` で決めた光学（プリズム素材を輝度マスクとして読み、
 * 音から作った分光で着色する）をそのまま持ち込み、**音の出来事で発生させる**
 * ところまで進める表現。Spatial Study の Spark / Arc / Needle は持ち込まない
 * （細い斜線が大量に飛ぶ「斬撃」に戻ってしまうため）。
 *
 * 段階は Version ボタンで切り替える:
 *   1 Trigger    … Core だけ。発生と A/H/D のタイミングだけを見る
 *   2 Texture    … Core + Sheet。中心と周囲が同じ光としてまとまるかを見る
 *   3 Variation  … イベントごとに素材・色・構図が変わることを見る
 *   4 Composite  … Haze / Ray / Depth を足して 1 枚の絵にする
 *
 * データの流れ:
 *   AudioEngine → BandLightEventDetector → AudioEventSnapshot
 *     → PrismaticBurstPlanner（音 → 見え方はここだけ）
 *     → 各層の Envelope → 共通プリズム Shader（1 ドロー）→ Bloom → Effect
 *
 * **このクラスは見え方を決めない。** Planner が返した値を描くだけで、
 * `AudioEngine` の値を形や色へ直接入れることはしない。
 */

export type ReactiveMode = 'trigger' | 'texture' | 'variation' | 'composite';

const MODE_LABELS: Readonly<Record<ReactiveMode, string>> = {
  trigger: 'Trigger',
  texture: 'Texture',
  variation: 'Variation',
  composite: 'Composite',
};

const MODE_STAGE: Readonly<Record<ReactiveMode, ReactiveStage>> = {
  trigger: 1,
  texture: 2,
  variation: 3,
  composite: 4,
};

/** この表現の質感はすべてここに集める。日本語の意味つきで 1 箇所に置く。 */
const REACTIVE = {
  /** 同時に生かす層の上限。上限に達したら最も古い層から捨てる。 */
  maximumLayers: 28,
  /** 固定カメラ。静的 Lab と同じ画角にして見え方を揃える。 */
  fieldOfView: 45,
  nearPlane: 0.1,
  farPlane: 80,
  /** 1 フレームで進める時間の上限（秒）。タブ復帰時の巨大な delta を切る。 */
  maximumDelta: 0.05,
  /** Decay の曲がり。大きいほど頭で速く落ちる。 */
  decayCurve: 3,

  /** プリズム素材のアトラス。静的 Lab と同じ素材・同じ解像度を使う。 */
  atlas: {
    manifestUrl: 'assets/light-traces/manifest.json',
    cellPixels: 384,
    columns: 4,
  },

  /**
   * 種類ごとの 1 枚あたりの濃度。
   * **膜と Haze が主役**になるよう、Core は締まった芯だけに絞り、
   * Ray は数が少ないぶん濃度を残す。
   */
  density: {
    core: 0.62,
    sheet: 0.58,
    haze: 0.32,
    ray: 0.42,
  },

  /**
   * **1 枚あたりの明るさの天井（ソフトニー）。**
   * `x / (1 + x/ceiling)` で上だけを潰す。色相は変えない。
   * 広い面が単独で Bloom の敷居を一斉に越えないので、
   * **白は違う色の層が狭い範囲で重なった場所にだけ**生まれる。
   */
  softCeiling: 0.8,

  /** 内部 Bloom。音量で直接動かさない（滲みが音に合わせて呼吸すると安っぽい）。 */
  bloomThreshold: 0.22,
  bloomStrength: 0.9,
  bloomRadius: 0.5,
  /** 画面全体の露出。トーンマップは `1 - exp(-x·exposure)` なので黒は黒のまま。 */
  exposure: 0.95,

  /** 開発つまみの既定値。 */
  defaults: {
    attackMs: 12,
    holdMs: 60,
    decayMs: 320,
    minimumIntensity: 0.45,
    maximumIntensity: 1,
    onsetSensitivity: 0.5,
    fluxGain: 2.5,
    cooldownMs: 60,
    thresholdScale: 0.5,
    layerDensity: 1,
    membraneMotion: 1,
    depthAmount: 1,
    intensity: 2,
    bloomThreshold: 0.22,
    bloomStrength: 0.9,
    bloomRadius: 0.5,
    exposure: 0.95,
  },
  ranges: {
    attackMs: { min: 0, max: 200, step: 1 },
    holdMs: { min: 0, max: 500, step: 5 },
    decayMs: { min: 40, max: 2000, step: 10 },
    minimumIntensity: { min: 0, max: 1, step: 0.01 },
    maximumIntensity: { min: 0, max: 1, step: 0.01 },
    onsetSensitivity: { min: 0, max: 1, step: 0.01 },
    fluxGain: { min: 1, max: 40, step: 0.5 },
    cooldownMs: { min: 0, max: 400, step: 5 },
    thresholdScale: { min: 0.15, max: 1.5, step: 0.05 },
    layerDensity: { min: 0, max: 2, step: 0.05 },
    membraneMotion: { min: 0, max: 1, step: 0.05 },
    depthAmount: { min: 0, max: 1, step: 0.05 },
    intensity: { min: 0, max: 5, step: 0.05 },
    bloomThreshold: { min: 0, max: 1, step: 0.01 },
    bloomStrength: { min: 0, max: 3, step: 0.05 },
    bloomRadius: { min: 0, max: 1.5, step: 0.01 },
    exposure: { min: 0.1, max: 3, step: 0.05 },
  },
} as const;

type ReactiveParamKey = keyof typeof REACTIVE.defaults;

/** 生きている層 1 枚。見え方は発生時に固定され、動くのは明るさと経過秒だけ。 */
interface LiveLayer {
  readonly traits: ReactiveLayerTraits;
  currentIntensity: number;
  age: number;
  completed: boolean;
}

/** 開発・検証用に外へ見せる状態。 */
export interface ReactiveLabState {
  readonly stage: ReactiveStage;
  readonly layers: number;
  readonly scheduled: number;
  readonly bursts: number;
  readonly tiles: number;
  readonly lastBand: BandName | null;
  readonly lastComposition: CompositionType | null;
  readonly recentCompositions: readonly CompositionType[];
  readonly live: readonly {
    readonly kind: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly tile: number;
    readonly hue: number;
    readonly intensity: number;
    readonly age: number;
  }[];
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);
const clamp01 = (value: number): number => clamp(value, 0, 1);

/** t = 0 で 1、t = 1 でちょうど 0 になる指数曲線。 */
const decayShape = (t: number): number => {
  const k = REACTIVE.decayCurve;
  const floor = Math.exp(-k);
  return (Math.exp(-k * t) - floor) / (1 - floor);
};

/** 種類 → シェーダーへ渡す番号。フラグメントの分岐と対応する。 */
const KIND_INDEX: Readonly<Record<ReactiveLayerTraits['kind'], number>> = {
  core: 0,
  sheet: 1,
  haze: 2,
  ray: 3,
};

const DENSITY: Readonly<Record<ReactiveLayerTraits['kind'], number>> = {
  core: REACTIVE.density.core,
  sheet: REACTIVE.density.sheet,
  haze: REACTIVE.density.haze,
  ray: REACTIVE.density.ray,
};

export class LightReactiveLab implements LabExpression {
  readonly animated = true;
  readonly name: string;
  readonly id: ExpressionId;
  readonly mode: ReactiveMode;

  private readonly stage: ReactiveStage;
  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  private readonly params: Record<ReactiveParamKey, number> = { ...REACTIVE.defaults };

  private context: CompositionContext | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private geometry: THREE.InstancedBufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  private placeholder: THREE.DataTexture | null = null;
  private atlas: PrismAtlas | null = null;
  private disposed = false;

  /** 内部 Bloom（Effect チェーンより前）と、その結果を貼る表示板。 */
  private bloomComposer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private displayScene: THREE.Scene | null = null;
  private displayCamera: THREE.OrthographicCamera | null = null;
  private displayGeometry: THREE.PlaneGeometry | null = null;
  private displayMaterial: THREE.ShaderMaterial | null = null;
  private pipeline: EffectPipeline | null = null;

  /** 音の出来事の検出。2D / 3D と同じ検出器をそのまま使う。 */
  private readonly detector = new BandLightEventDetector();
  /** 音 → 見え方を決める唯一の層。 */
  private readonly planner = new PrismaticBurstPlanner();

  private readonly layers: LiveLayer[] = [];
  private readonly scheduled: { at: number; traits: ReactiveLayerTraits }[] = [];
  private previousElapsed = -1;
  private burstCount = 0;
  private lastBand: BandName | null = null;
  private lastComposition: CompositionType | null = null;
  private lastSustain = 0;

  // ---- インスタンス属性（毎フレーム中身だけ書き換える）----
  private readonly offsets = new Float32Array(REACTIVE.maximumLayers * 3);
  private readonly sizes = new Float32Array(REACTIVE.maximumLayers * 3);
  private readonly intensities = new Float32Array(REACTIVE.maximumLayers);
  private readonly crops = new Float32Array(REACTIVE.maximumLayers * 4);
  private readonly orients = new Float32Array(REACTIVE.maximumLayers * 4);
  private readonly normals = new Float32Array(REACTIVE.maximumLayers * 4);
  private readonly tones = new Float32Array(REACTIVE.maximumLayers * 4);
  private readonly motions = new Float32Array(REACTIVE.maximumLayers * 4);
  private readonly extras = new Float32Array(REACTIVE.maximumLayers * 3);
  private readonly attributes: Record<string, THREE.InstancedBufferAttribute> = {};

  constructor(id: ExpressionId, mode: ReactiveMode, effects: Effect[] = [], theme?: Theme) {
    this.id = id;
    this.mode = mode;
    this.stage = MODE_STAGE[mode];
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
    this.name = `Light Reactive Lab — ${MODE_LABELS[mode]}`;
  }

  // ---------------------------------------------------------------- setup

  setup(context: CompositionContext): void {
    this.context = context;
    // 同じインスタンスが setup をやり直すことがある（表現の再適用）。
    // dispose の印を残したままだとアトラスを結び直さず、黙って真っ黒になる。
    this.disposed = false;
    this.previousElapsed = -1;

    this.camera = new THREE.PerspectiveCamera(
      REACTIVE.fieldOfView,
      this.aspectRatio,
      REACTIVE.nearPlane,
      REACTIVE.farPlane,
    );
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(0, 0, -1);

    this.placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.placeholder.colorSpace = THREE.SRGBColorSpace;
    this.placeholder.needsUpdate = true;

    this.buildMesh();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    if (this.mesh) this.scene.add(this.mesh);

    // ---- 内部 Bloom ----
    const size = new THREE.Vector2();
    context.renderer.getSize(size);
    this.bloomComposer = new EffectComposer(context.renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(size.x, 1), Math.max(size.y, 1)),
      REACTIVE.bloomStrength,
      REACTIVE.bloomRadius,
      REACTIVE.bloomThreshold,
    );
    this.bloomComposer.addPass(this.bloomPass);

    // ---- 表示板（露出とトーンマップだけ）----
    this.displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.displayCamera.position.z = 1;
    this.displayMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uExposure: { value: REACTIVE.exposure } },
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform float uExposure;
        varying vec2 vUv;
        void main() {
          vec3 color = texture2D(tDiffuse, vUv).rgb;
          // x = 0 なら必ず 0。無音の黒が浮くことはない。
          gl_FragColor = vec4(vec3(1.0) - exp(-max(color, 0.0) * uExposure), 1.0);
        }
      `,
    });
    this.displayGeometry = new THREE.PlaneGeometry(2, 2);
    this.displayScene = new THREE.Scene();
    this.displayScene.background = new THREE.Color(0x000000);
    this.displayScene.add(new THREE.Mesh(this.displayGeometry, this.displayMaterial));

    this.pipeline = new EffectPipeline(
      context.renderer,
      this.displayScene,
      this.displayCamera,
      this.effects,
    );

    // 素材は非同期。届くまでは層が 1 枚も出ないだけで、無音＝黒は保たれる。
    void loadPrismAtlas(REACTIVE.atlas).then((atlas) => {
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
      this.planner.setTextures(atlas.tiles);
    });
  }

  /**
   * **1 ドローですべての層を描く板。**
   * 種類（Core / Sheet / Haze / Ray）はフラグメントの分岐で切り替え、
   * 素材ごと・層ごとに Material を作らない。
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
    add('aIntensity', this.intensities, 1);
    add('aCrop', this.crops, 4);
    add('aOrient', this.orients, 4);
    add('aNormal', this.normals, 4);
    add('aTone', this.tones, 4);
    add('aMotion', this.motions, 4);
    add('aExtra', this.extras, 3);
    geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.placeholder },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uIntensity: { value: REACTIVE.defaults.intensity },
        uCeiling: { value: REACTIVE.softCeiling },
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
        attribute float aIntensity;
        attribute vec4 aCrop;
        attribute vec4 aOrient;
        attribute vec4 aNormal;
        attribute vec4 aTone;
        attribute vec4 aMotion;
        attribute vec3 aExtra;
        varying vec2 vLocal;
        varying float vIntensity;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying vec4 vTone;
        varying vec4 vMotion;
        varying vec3 vExtra;
        varying float vTile;

        void main() {
          vLocal = position.xy * 2.0;
          vIntensity = aIntensity;
          vCrop = aCrop;
          vOrient = aOrient;
          vTone = aTone;
          vMotion = aMotion;
          vExtra = aExtra;
          vTile = aSize.z;

          // **面はカメラ正面に固定しない。** 法線から接線・従法線を組み、
          // ワールド空間で傾いた平面として広げる。大きさはワールド単位のままなので、
          // 手前は大きく・奥は小さく写る（遠近が成立する）。
          vec3 n = normalize(aNormal.xyz);
          vec3 helper = abs(n.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
          vec3 tangent = normalize(cross(helper, n));
          vec3 bitangent = cross(n, tangent);
          // 面内回転に、面内だけのゆっくりした回転を経過秒ぶん足す。
          float spin = aNormal.w + aMotion.w * aExtra.x;
          float cs = cos(spin);
          float sn = sin(spin);
          vec3 axisU = tangent * cs + bitangent * sn;
          vec3 axisV = bitangent * cs - tangent * sn;
          // 面内のごく弱い平行移動。**Z へは動かさない。**
          vec3 slide = axisU * (aMotion.x * 0.0) + axisV * (aMotion.y * 0.0);
          vec3 centre = aOffset + slide;
          vec3 world = centre + axisU * (vLocal.x * aSize.x) + axisV * (vLocal.y * aSize.y);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec2 uGrid;
        uniform float uIntensity;
        uniform float uCeiling;
        varying vec2 vLocal;
        varying float vIntensity;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying vec4 vTone;
        varying vec4 vMotion;
        varying vec3 vExtra;
        varying float vTile;

        const float TAU = 6.28318530718;

        // 静的 Light Element Lab と同じ分光。Core も Sheet も同じ式を通る。
        vec3 spectrum(float t) {
          vec3 phase = vec3(0.0, 0.34, 0.67);
          return 0.52 + 0.48 * cos(TAU * (t + phase));
        }

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

        /** 分光の位置。形式は seed が選ぶ。 */
        float gradientAt(vec2 p, float form) {
          if (form < 0.5) return p.x * 0.5 + 0.5;
          if (form < 1.5) return clamp(length(p), 0.0, 1.0);
          if (form < 2.5) return p.y * 0.5 + 0.5;
          return atan(p.y, p.x) * 0.1591549 + 0.5;
        }

        void main() {
          vec2 p = vLocal;
          float kind = vTone.z;
          float age = vExtra.x;

          // ---- Ray: 直線だけ。水平垂直が基本で、板ごと回して向きを作る ----
          if (kind > 2.5) {
            float across = abs(p.y) / max(vExtra.y, 0.0001);
            float spine = exp(-across * across);
            float halo = exp(-across * across * 0.02) * 0.1;
            float along = clamp(1.0 - abs(p.x), 0.0, 1.0);
            float taper = pow(along, 0.25);
            vec3 tint = spectrum(vTone.x + gradientAt(p, 0.0) * vTone.y);
            vec3 color = tint * (spine + halo) * taper * max(vIntensity, 0.0) * uIntensity;
            float peak = max(color.r, max(color.g, color.b));
            color /= 1.0 + peak / max(uCeiling, 0.0001);
            gl_FragColor = vec4(max(color, 0.0), 1.0);
            return;
          }

          // ---- 共通のプリズム光学（Core / Sheet / Haze）----
          // 回転・反転・面内スクロール・せん断を掛けた UV で素材を読む。
          vec2 q = vec2(p.x * vOrient.x - p.y * vOrient.y, p.x * vOrient.y + p.y * vOrient.x);
          q *= vec2(vOrient.z, vOrient.w);
          q.y += q.x * vMotion.z * age;
          q += vMotion.xy * age;
          vec2 localUv = vCrop.xy + q * 0.5 * vec2(vCrop.z, vCrop.w);
          vec3 source = sampleTile(localUv);
          float sourceLight = pow(max(labLuminance(source) * 3.2, 0.0), 0.55);

          // 板の四角い輪郭は絶対に見せない。楕円の窓で必ず 0 にする。
          float ellipse = length(p / vec2(1.0, 0.78));
          float softEdge = 1.0 - smoothstep(0.58, 1.03, ellipse);
          if (softEdge <= 0.0) discard;
          float grain = 0.96 + 0.04 * sin(dot(p, vec2(49.3, 81.7)));

          float radial2 = dot(p, p);
          float nucleus = exp(-radial2 * 34.0);
          float localHalo = exp(-radial2 * 4.2);
          float coreShape = softEdge * (sourceLight * 1.38 + nucleus * 0.34 + localHalo * 0.045);
          float centralVeil = exp(-p.y * p.y * 4.0) * exp(-p.x * p.x * 0.72);
          float sheetShape = softEdge * (sourceLight * 1.08 + centralVeil * 0.055);
          // Haze は素材の濃淡だけを広く薄く敷く。芯を作らない。
          float hazeShape = softEdge * sourceLight * 0.72;

          float shape = kind < 0.5 ? coreShape : (kind < 1.5 ? sheetShape : hazeShape);

          float hue = vTone.x + gradientAt(p, vExtra.z) * vTone.y + sourceLight * 0.06;
          vec3 spectral = spectrum(hue);
          vec3 sourceTint = source / max(max(source.r, source.g), max(source.b, 0.02));
          vec3 color = mix(spectral, sourceTint, clamp(vTone.w, 0.0, 1.0));

          // Core の中心にだけ、ごく小さな白い芯を残す。
          float whiteCentre = kind < 0.5 ? nucleus * 0.42 : 0.0;
          color = mix(color, vec3(0.96, 0.98, 1.0), whiteCentre);
          color *= shape * grain * max(vIntensity, 0.0) * uIntensity;

          // 上だけを潰すソフトニー。1 枚では白へ行けないので、
          // 白は違う色の層が重なった場所にだけ生まれる。
          float peak = max(color.r, max(color.g, color.b));
          color /= 1.0 + peak / max(uCeiling, 0.0001);
          gl_FragColor = vec4(max(color, 0.0), 1.0);
        }
      `,
    });

    this.geometry = geometry;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  // ---------------------------------------------------------------- 可視範囲

  /** その奥行きで画面に収まる範囲（半分の幅と高さ）。 */
  private visibleHalfExtent(depth: number): { halfWidth: number; halfHeight: number } {
    const halfHeight = Math.tan((REACTIVE.fieldOfView * Math.PI) / 360) * depth;
    return { halfHeight, halfWidth: halfHeight * Math.max(this.aspectRatio, 1e-6) };
  }

  // ---------------------------------------------------------------- 検出

  private detectEvents(elapsed: number, delta: number): void {
    const audio = this.context?.audioEngine.getParameters() ?? {};
    const spectrum = this.context?.audioEngine.getSpectrum?.() ?? null;
    // 発光の瞬間の余韻。Snapshot は検出層と共有なので汚さず、ここで拾って渡す。
    this.lastSustain = clamp01(audio.sustain ?? 0);
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
        fluxGain: this.params.fluxGain,
        onsetSensitivity: this.params.onsetSensitivity,
        cooldownSeconds: this.params.cooldownMs / 1000,
        relativeStrengthFloor: 1,
        adaptiveThreshold: true,
        adaptiveStrength: true,
        thresholdScale: this.params.thresholdScale,
      },
    );
    for (const event of events) this.scheduleBurst(event, elapsed);
  }

  /** イベント 1 個から Burst を予約する。見え方はすべて Planner が決めている。 */
  private scheduleBurst(event: BandLightEvent, elapsed: number): void {
    const plan = this.planner.plan(
      event,
      (depth) => this.visibleHalfExtent(depth),
      this.plannerSettings(),
    );
    this.burstCount += 1;
    this.lastBand = event.band;
    this.lastComposition = plan.composition;
    for (const layer of plan.layers) this.enqueue(layer, elapsed);
  }

  private enqueue(layer: PlannedReactiveLayer, elapsed: number): void {
    if (layer.delaySeconds <= 0) {
      this.spawn(layer.traits);
      return;
    }
    this.scheduled.push({ at: elapsed + layer.delaySeconds, traits: layer.traits });
  }

  private spawn(traits: ReactiveLayerTraits): void {
    if (this.layers.length >= REACTIVE.maximumLayers) this.layers.shift();
    this.layers.push({ traits, currentIntensity: 0, age: 0, completed: false });
  }

  private releaseScheduled(elapsed: number): void {
    if (this.scheduled.length === 0) return;
    let write = 0;
    for (let read = 0; read < this.scheduled.length; read++) {
      const entry = this.scheduled[read]!;
      if (entry.at <= elapsed) {
        this.spawn(entry.traits);
        continue;
      }
      this.scheduled[write] = entry;
      write += 1;
    }
    this.scheduled.length = write;
  }

  /** Planner へ渡す運転設定。開発つまみを束ねるだけ。 */
  private plannerSettings(): BurstSettings {
    return {
      stage: this.stage,
      minimumIntensity: this.params.minimumIntensity,
      maximumIntensity: this.params.maximumIntensity,
      attackSeconds: this.params.attackMs / 1000,
      holdSeconds: this.params.holdMs / 1000,
      decaySeconds: this.params.decayMs / 1000,
      layerDensity: this.params.layerDensity,
      membraneMotion: this.params.membraneMotion,
      depthAmount: this.params.depthAmount,
      sustain: this.lastSustain,
    };
  }

  // ---------------------------------------------------------------- 一生

  /** 明るさは age の純粋な関数。形も色も発生時から変わらない。 */
  private advance(delta: number): void {
    let write = 0;
    for (let read = 0; read < this.layers.length; read++) {
      const layer = this.layers[read]!;
      layer.age += delta;
      const { attackSeconds: attack, holdSeconds: hold, decaySeconds: decay } =
        layer.traits.lifetime;
      const peak = layer.traits.intensity;
      if (layer.age < attack) {
        layer.currentIntensity = peak * (attack <= 0 ? 1 : layer.age / attack);
      } else if (layer.age < attack + hold) {
        layer.currentIntensity = peak;
      } else {
        const t = decay <= 0 ? 1 : (layer.age - attack - hold) / decay;
        if (t >= 1) {
          layer.completed = true;
          layer.currentIntensity = 0;
        } else {
          layer.currentIntensity = peak * decayShape(t);
        }
      }
      if (layer.completed) continue;
      this.layers[write] = layer;
      write += 1;
    }
    this.layers.length = write;
  }

  /** 発生時に決めた拡大。頭が速く、あとは緩やかに開く。 */
  private expansionAt(layer: LiveLayer): number {
    const { from, to } = layer.traits.expansion;
    if (from === to) return from;
    const life = Math.max(
      layer.traits.lifetime.attackSeconds +
        layer.traits.lifetime.holdSeconds +
        layer.traits.lifetime.decaySeconds,
      1e-4,
    );
    const t = clamp01(layer.age / life);
    return from + (to - from) * (1 - (1 - t) * (1 - t));
  }

  /** インスタンス属性へ書き戻す。確保はせず、中身と instanceCount だけ更新する。 */
  private syncInstances(): void {
    if (!this.geometry) return;
    let slot = 0;
    for (const layer of this.layers) {
      const t = layer.traits;
      const scale = this.expansionAt(layer);
      // 面内のごく弱い平行移動。**z は触らない。**
      this.offsets[slot * 3] = t.position.x + t.motion.slideX * layer.age;
      this.offsets[slot * 3 + 1] = t.position.y + t.motion.slideY * layer.age;
      this.offsets[slot * 3 + 2] = t.position.z;
      this.sizes[slot * 3] = t.halfWidth * scale;
      this.sizes[slot * 3 + 1] = t.halfHeight * scale;
      this.sizes[slot * 3 + 2] = t.tile;
      this.intensities[slot] = layer.currentIntensity * DENSITY[t.kind];
      this.crops[slot * 4] = t.crop.u;
      this.crops[slot * 4 + 1] = t.crop.v;
      this.crops[slot * 4 + 2] = t.crop.su;
      this.crops[slot * 4 + 3] = t.crop.sv;
      this.orients[slot * 4] = Math.cos(t.uvAngle);
      this.orients[slot * 4 + 1] = Math.sin(t.uvAngle);
      this.orients[slot * 4 + 2] = t.flipX;
      this.orients[slot * 4 + 3] = t.flipY;
      this.normals[slot * 4] = t.normal.x;
      this.normals[slot * 4 + 1] = t.normal.y;
      this.normals[slot * 4 + 2] = t.normal.z;
      this.normals[slot * 4 + 3] = t.spin;
      this.tones[slot * 4] = t.hueOffset;
      this.tones[slot * 4 + 1] = t.hueSpan;
      this.tones[slot * 4 + 2] = KIND_INDEX[t.kind];
      this.tones[slot * 4 + 3] = t.sourceTint;
      this.motions[slot * 4] = t.motion.scrollU;
      this.motions[slot * 4 + 1] = t.motion.scrollV;
      this.motions[slot * 4 + 2] = t.motion.shear;
      this.motions[slot * 4 + 3] = t.motion.spin;
      this.extras[slot * 3] = layer.age;
      this.extras[slot * 3 + 1] = t.rayWidth;
      this.extras[slot * 3 + 2] = t.gradientForm;
      slot += 1;
    }
    this.geometry.instanceCount = slot;
    for (const attribute of Object.values(this.attributes)) attribute.needsUpdate = true;
  }

  // ---------------------------------------------------------------- update

  update(elapsed: number): void {
    if (!this.context || !this.material) return;
    const audio = this.context.audioEngine.getParameters();
    const active = audio.active === 1;

    const delta =
      this.previousElapsed < 0 ? 0 : clamp(elapsed - this.previousElapsed, 0, REACTIVE.maximumDelta);
    this.previousElapsed = elapsed;

    this.syncOptics();

    if (!active) {
      // 音がなければ発生も余韻もない（無音＝黒画面が正常）。
      this.layers.length = 0;
      this.scheduled.length = 0;
      this.detector.reset();
      this.planner.reset();
      this.burstCount = 0;
      this.lastBand = null;
      this.lastComposition = null;
      this.syncInstances();
      this.pipeline?.update(audio, elapsed);
      return;
    }

    this.detectEvents(elapsed, delta);
    this.releaseScheduled(elapsed);
    this.advance(delta);
    this.syncInstances();
    this.pipeline?.update(audio, elapsed);
  }

  /** 開発つまみを Bloom と露出へ流す。**音量では動かさない。** */
  private syncOptics(): void {
    if (this.material) this.material.uniforms.uIntensity!.value = this.params.intensity;
    if (this.bloomPass) {
      this.bloomPass.threshold = this.params.bloomThreshold;
      this.bloomPass.strength = this.params.bloomStrength;
      this.bloomPass.radius = this.params.bloomRadius;
    }
    if (this.displayMaterial) {
      this.displayMaterial.uniforms.uExposure!.value = this.params.exposure;
    }
  }

  render(): void {
    if (this.bloomComposer && this.displayMaterial) {
      this.bloomComposer.render();
      this.displayMaterial.uniforms.tDiffuse!.value = this.bloomComposer.readBuffer.texture;
    }
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    if (this.camera && height > 0) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);
    this.bloomComposer?.setSize(w, h);
    this.bloomPass?.setSize(w, h);
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

  /** 黒背景と素材由来の色で成立させるので、テーマは持たない。 */
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
    // 奥行きは空間そのものが持つ。
  }

  getPhase(): string {
    return (
      `${MODE_LABELS[this.mode]} / layers ${this.layers.length} / ` +
      `bursts ${this.burstCount} / ${this.lastComposition ?? '-'}`
    );
  }

  /** 開発・検証用。Inspector と `window.__lab` から読む。 */
  getReactiveLabState(): ReactiveLabState {
    return {
      stage: this.stage,
      layers: this.layers.length,
      scheduled: this.scheduled.length,
      bursts: this.burstCount,
      tiles: this.atlas?.tiles.length ?? 0,
      lastBand: this.lastBand,
      lastComposition: this.lastComposition,
      recentCompositions: this.planner.recentCompositions(),
      live: this.layers.map((layer) => ({
        kind: layer.traits.kind,
        x: layer.traits.position.x,
        y: layer.traits.position.y,
        z: layer.traits.position.z,
        tile: layer.traits.tile,
        hue: layer.traits.hueOffset,
        intensity: layer.currentIntensity,
        age: layer.age,
      })),
    };
  }

  getExpressionParams(): ExpressionParam[] {
    const row = (key: ReactiveParamKey, label: string): ExpressionParam => ({
      key,
      label,
      ...REACTIVE.ranges[key],
      value: this.params[key],
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
      row('thresholdScale', 'Onset reach'),
      row('layerDensity', 'Layer density'),
      row('membraneMotion', 'Membrane motion'),
      row('depthAmount', 'Depth'),
      row('intensity', 'Intensity'),
      row('bloomThreshold', 'Bloom threshold'),
      row('bloomStrength', 'Bloom strength'),
      row('bloomRadius', 'Bloom radius'),
      row('exposure', 'Exposure'),
    ];
  }

  setExpressionParam(key: string, value: number | string): void {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return;
    if (!(key in this.params)) return;
    const range = REACTIVE.ranges[key as ReactiveParamKey];
    this.params[key as ReactiveParamKey] = clamp(numeric, range.min, range.max);
  }

  setGeneratorsVisible(visible: boolean): void {
    if (this.scene) this.scene.visible = visible;
  }

  setDesignLayerCanvases(canvases: DesignLayerCanvases): void {
    this.pipeline?.setOverlayCanvases(canvases);
  }

  updateDesignLayerCanvases(): void {
    this.pipeline?.updateOverlayCanvases();
  }

  dispose(): void {
    this.disposed = true;
    this.pipeline?.dispose();
    this.bloomPass?.dispose();
    this.bloomComposer?.dispose();
    this.displayGeometry?.dispose();
    this.displayMaterial?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.placeholder?.dispose();
    this.atlas?.texture.dispose();
    if (this.mesh && this.scene) this.scene.remove(this.mesh);
    this.layers.length = 0;
    this.scheduled.length = 0;
    this.detector.reset();
    this.planner.reset();
    this.pipeline = null;
    this.bloomPass = null;
    this.bloomComposer = null;
    this.displayScene = null;
    this.displayCamera = null;
    this.displayGeometry = null;
    this.displayMaterial = null;
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
