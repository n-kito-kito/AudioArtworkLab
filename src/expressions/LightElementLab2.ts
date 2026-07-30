import * as THREE from 'three';
import type { CompositionContext, DesignLayerCanvases } from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { ExpressionParam, LabExpression } from './Expression';
import {
  CORE_SHAPES,
  CURTAIN_FAMILIES,
  FRAGMENT_FAMILIES,
  KIND_INDEX,
  OPTICS,
  STROBE,
  buildOpticalRig,
  depthCue,
  type OpticalGroup,
  type OpticalLayerTraits,
  type OpticsDrive,
} from './lightOpticsMapping';
import {
  OPTICS_THRESHOLDS,
  OpticsAudioDrive,
  type OpticsDriveLevels,
} from './opticsAudioDrive';
import { loadPrismAtlas, type PrismAtlas, type PrismTile } from './prismAtlas';

/**
 * **Light Element Lab 2 — 固定された光学系に、エネルギーと波長を注ぎ込む静止画スタディ。**
 *
 * 色は「1 つの光を R/G/B の 3 チャンネルへ分け、わずかにずらして重ねる」ことから
 * 生まれる（CRT 的構造）。V1（発光ごとに色相グラデーションを割り当てる方式）は
 * 無改変で温存し、比較対象として残してある。
 *
 * リファレンスの連番フレーム分析から確定した 4 点をここで満たす:
 *   1 **白の予算制** — 3 チャンネルが重なって白へ到達してよいのはコア層だけ。
 *     ほかの層はチャンネル分離の下限と天井で押さえ、単独では白画素を作れない
 *   2 **奥行きの手がかり** — z へ 1 本の式（`depthCue`）で「遠いほど暗く・鈍く」を紐づける。
 *     層ごとの個別調整はしない
 *   3 **構図** — 骨格は中央軸に固定。不規則さは断片層だけが担い、位置は決定論ハッシュ
 *   4 **グローバル位相 H** — 各層は `spectrum(H + 層の小オフセット + 勾配)` で発色し、
 *     層が独立の色を持たない。H が動くと全要素が一斉にスペクトル上をスライドする
 *
 * **このクラスは見え方を決めない。** `lightOpticsMapping.ts` が返した traits を描くだけで、
 * シェーダーの中に音の前提も時間アニメーションも入らない。静止画なので時計も持たない。
 *
 * 描画は **1 ドロー**。4 種別（core / beam / veil / fan）はフラグメントの分岐で切り替え、
 * チャンネル分離のためにインスタンスは増やさない（1 フラグメントで 3 回評価する）。
 */

const GROUP_LABELS: Readonly<Record<OpticalGroup, string>> = {
  haze: 'Haze',
  curtain: 'Curtain',
  skeleton: 'Skeleton',
  core: 'Core',
  fragment: 'Fragment',
  fan: 'Fan',
  all: 'All',
};

/** この表現の描画側の定数。光学系そのものの数値は `lightOpticsMapping.ts` にある。 */
const LAB2 = {
  /**
   * インスタンスの上限。Audio の最悪ケース
   * （膜 2 + カーテン 3 + 骨格 3 + 断片 12 + 扇 1 + コア 1 + アーム 4）に余裕を持たせる。
   */
  maximumLayers: 28,
  nearPlane: 0.1,
  farPlane: 80,
  atlas: {
    manifestUrl: 'assets/light-traces/manifest.json',
    cellPixels: 384,
    columns: 4,
  },
  /** チャンネルごとの UV 歪みの非相関の強さ（つまみ 1.0 のときの UV 変位）。 */
  decorrelationScale: 0.05,
  /** 開発つまみの既定値。静止画のターゲットはリファレンスの頂点フレーム 1 枚。 */
  defaults: {
    huePhase: 0.62,
    skeletonLevel: 1,
    corePulse: 1,
    fragmentEnergy: 1,
    fragmentSeed: 7,
    redGain: 1,
    greenGain: 1,
    blueGain: 1,
    channelOffset: 0.03,
    decorrelation: 0.25,
    intensity: 1.6,
    depthProbe: 0,
  },
  ranges: {
    huePhase: { min: 0, max: 1, step: 0.005 },
    skeletonLevel: { min: 0, max: 1, step: 0.01 },
    corePulse: { min: 0, max: 1, step: 0.01 },
    fragmentEnergy: { min: 0, max: 1, step: 0.01 },
    fragmentSeed: { min: 0, max: 64, step: 1 },
    redGain: { min: 0, max: 1, step: 0.01 },
    greenGain: { min: 0, max: 1, step: 0.01 },
    blueGain: { min: 0, max: 1, step: 0.01 },
    channelOffset: { min: 0, max: 0.5, step: 0.002 },
    decorrelation: { min: 0, max: 1, step: 0.01 },
    intensity: { min: 0, max: 4, step: 0.05 },
    depthProbe: { min: 0, max: 1, step: 0.05 },
  },
} as const;

type Lab2ParamKey = keyof typeof LAB2.defaults;

/** 分離方向の決め方。 */
type OffsetMode = 'radial' | 'axis';

/**
 * ドライブの供給元。
 * `manual` は開発つまみがそのまま `OpticsDrive` になる（静止画スタディ）。
 * `audio` は `OpticsAudioDrive` が音から作る（段階的に配線していく）。
 */
type DriveMode = 'manual' | 'audio';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** 開発・検証用に外へ見せる状態。 */
export interface LightElementLab2State {
  readonly group: OpticalGroup;
  readonly layers: number;
  readonly whiteAllowedLayers: number;
  readonly huePhase: number;
  readonly depth: readonly {
    readonly kind: string;
    readonly z: number;
    readonly dim: number;
    readonly soft: number;
  }[];
  /** 形状族を持つ層（断片・カーテン）の内訳。検証で分布を数えるために出す。 */
  readonly families: readonly { readonly kind: string; readonly family: string }[];
  /** ドライブの供給元と、音から平滑された 3 層の基礎輝度。 */
  readonly driveMode: DriveMode;
  readonly levels: OpticsDriveLevels;
}

export class LightElementLab2 implements LabExpression {
  readonly animated = true;
  readonly name: string;
  readonly id: ExpressionId;
  readonly group: OpticalGroup;

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  private readonly params: Record<Lab2ParamKey, number> = { ...LAB2.defaults };
  private offsetMode: OffsetMode = 'radial';
  /** グローバル波長 H を掛けるか。OFF はチャンネル構造だけを見る比較用。 */
  private globalTint = true;
  /** 扇の閾値ゲートの代役（静止画では手動トグル）。 */
  private fanGateOpen = true;
  /**
   * 膜を出すか。**音入力ではなく開発用の表示トグル**で、
   * 膜あり・なしを往復して黒の面積と濁りを比べるために置いてある。
   */
  private hazeVisible = true;
  /**
   * 静止画スタディで見せるコアの形状族。**−1 は素の芯**（既定）。
   * Audio では打撃ごとに音のシードが選ぶので、ここは効かない。
   */
  private coreShape = -1;
  /** 静止画スタディで見せるアームの方向（0 = 出さない。既定）。 */
  private manualArmMask = 0;
  /** ストロボ（光学クロックの量子化）。A/B 比較のために切れる。 */
  private strobeEnabled = true;
  private strobeRate: number = STROBE.defaultRate;
  /**
   * **発光の閾値（開発つまみ・Audio のみ）。** 既定はアダプタの焼き込み値。
   * コア（弱打を落とす）< 扇（強打だけ開く）という階層を保つための道具で、
   * 本番 UI には出さない（PRD D17）。
   */
  private coreThreshold: number = OPTICS_THRESHOLDS.core;
  private fanThreshold: number = OPTICS_THRESHOLDS.fan;
  /**
   * **H の切替の粘り（開発つまみ・Audio のみ）。**
   * 確認時間を短くすると音色の揺れで色が動きやすくなり、
   * 最短保持を長くすると「1 つの色の回」が長くなる。
   */
  private hueConfirm: number = OPTICS_THRESHOLDS.hueConfirm;
  private hueHold: number = OPTICS_THRESHOLDS.hueHold;
  /**
   * **持続の濃さ（開発つまみ・Audio のみ）。** 音量 → 基礎輝度の曲線。
   * 小さいほど暗い側が持ち上がって場が濃くなる（1 で音量そのまま）。
   */
  private sustainGamma: number = OPTICS_THRESHOLDS.sustainGamma;
  /**
   * **場の利得（開発つまみ・Audio のみ）。** ストロボで半分になる面積を補う。
   * 天井は変わらないので、上げても白は増えず、天井に届く面積が広がるだけ。
   */
  private fieldGain: number = OPTICS_THRESHOLDS.fieldGain;
  /**
   * **痕跡場の効き（開発つまみ・Audio のみ）。**
   * 断片が消えた場所に痕跡が積もり、次の断片がそこへ引き寄せられる（蓄積）。
   * **0 で蓄積を切る**＝写像だけの従来の見え方に戻る。
   */
  private traceAmount: number = OPTICS_THRESHOLDS.traceAmount;
  /**
   * **帯域 → R/G/B の効き（開発つまみ・Audio のみ）。**
   * 0 で手動の R/G/B つまみのまま、1 で完全に帯域バランスが色調を決める。
   * 中間はブレンドで、**接続の強さそのものを調整できる**（対応を焼き込まない）。
   */
  private channelDrive: number = OPTICS_THRESHOLDS.channelDrive;
  /** ドライブの供給元。既定は Manual（静止画スタディの見え方を変えないため）。 */
  private driveMode: DriveMode = 'manual';
  /** 音 → ドライブの変換。対応の記述はこのアダプタ 1 つに集約する。 */
  private readonly audioDrive = new OpticsAudioDrive();
  /** 前フレームの時計。dt ベースの平滑に使う（フレームレート非依存）。 */
  private previousElapsed = -1;

  private layers: readonly OpticalLayerTraits[] = [];

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

  // ---- インスタンス属性（静的。つまみが動いたときだけ書き直す）----
  private readonly offsets = new Float32Array(LAB2.maximumLayers * 3);
  private readonly sizes = new Float32Array(LAB2.maximumLayers * 3);
  private readonly spins = new Float32Array(LAB2.maximumLayers);
  private readonly crops = new Float32Array(LAB2.maximumLayers * 4);
  private readonly orients = new Float32Array(LAB2.maximumLayers * 4);
  private readonly tones = new Float32Array(LAB2.maximumLayers * 4);
  private readonly shapes = new Float32Array(LAB2.maximumLayers * 4);
  private readonly axes = new Float32Array(LAB2.maximumLayers * 4);
  private readonly depths = new Float32Array(LAB2.maximumLayers * 4);
  private readonly channels = new Float32Array(LAB2.maximumLayers * 4);
  private readonly attributes: Record<string, THREE.InstancedBufferAttribute> = {};

  constructor(id: ExpressionId, group: OpticalGroup, effects: Effect[] = [], theme?: Theme) {
    this.id = id;
    this.group = group;
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
    this.name = `Light Element Lab 2 — ${GROUP_LABELS[group]}`;
  }

  // ---------------------------------------------------------------- setup

  setup(context: CompositionContext): void {
    this.context = context;
    // 同じインスタンスが setup をやり直すことがある。印を残すとアトラスを結び直さない。
    this.disposed = false;

    this.camera = new THREE.PerspectiveCamera(
      OPTICS.fieldOfView,
      this.aspectRatio,
      LAB2.nearPlane,
      LAB2.farPlane,
    );
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(0, 0, -1);
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();

    this.placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.placeholder.colorSpace = THREE.SRGBColorSpace;
    this.placeholder.needsUpdate = true;

    // 表現を開き直したら前の曲の余韻は持ち越さない。
    this.audioDrive.reset();
    this.previousElapsed = -1;

    this.buildMesh();
    this.rebuildRig();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    if (this.mesh) this.scene.add(this.mesh);

    this.pipeline = new EffectPipeline(
      context.renderer,
      this.scene,
      this.camera,
      this.effects,
    );

    // 素材は非同期。届くまで素材を読む層が暗いだけで、表現は壊れない。
    void loadPrismAtlas(LAB2.atlas).then((atlas) => {
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
   * 開発つまみがそのまま作るドライブ（Manual）。
   * 骨格・カーテン・膜は同じつまみを受けるので、静止画では 3 層が揃って動く。
   */
  private manualDrive(): OpticsDrive {
    return {
      skeletonLevel: this.params.skeletonLevel,
      curtainLevel: this.params.skeletonLevel,
      hazeLevel: this.params.skeletonLevel,
      corePulse: this.params.corePulse,
      fragmentEnergy: this.params.fragmentEnergy,
      // 静止画スタディは spawn を持たない（つまみの energy と seed から作る）。
      fragments: [],
      fanGate: this.fanGateOpen ? 1 : 0,
      // 静止画スタディの扇は素のまま（−1）。個体差は打撃が持つので Audio 側の仕事。
      fanSeed: -1,
      huePhase: this.params.huePhase,
      seed: this.params.fragmentSeed,
      // 静止画スタディは計測器なので連続表示のまま（ストロボは Audio 側の仕事）。
      tick: -1,
      coreShape: this.coreShape,
      // 静止画スタディはアームを持たない（打撃に同期する光なので Audio 側の仕事）。
      armMask: this.manualArmMask,
      armStrength: this.params.corePulse,
      armSeed: this.params.fragmentSeed,
      depthProbe: this.params.depthProbe,
    };
  }

  /**
   * **いま効いているグローバル波長 H。**
   * Manual は開発つまみ（静止画スタディの見え方を変えない）、
   * Audio は音色の持続値が選んだ離散状態（Step 5）。
   */
  private activeHue(): number {
    return this.driveMode === 'audio' ? this.audioDrive.huePhase() : this.params.huePhase;
  }

  /**
   * **いま効いているチャンネル利得。**
   * Manual は手動の R/G/B つまみ、Audio は帯域バランスとのブレンド。
   * 帯域が均等なら利得は (1, 1, 1) ＝ 無彩なので、**チルトが無いときは従来と同じ**。
   * 利得は必ず 1 以下なので、白の予算（コアだけが白へ届く）は動かない。
   */
  private channelTilt(): readonly [number, number, number] {
    const manual: readonly [number, number, number] = [
      this.params.redGain,
      this.params.greenGain,
      this.params.blueGain,
    ];
    if (this.driveMode !== 'audio' || this.channelDrive <= 0) return manual;
    const driven = this.audioDrive.channelGain();
    const t = this.channelDrive;
    return [
      manual[0] + (manual[0] * driven[0] - manual[0]) * t,
      manual[1] + (manual[1] * driven[1] - manual[1]) * t,
      manual[2] + (manual[2] * driven[2] - manual[2]) * t,
    ];
  }

  /** いま採用するドライブ。供給元を切り替えるだけで、リグ側は何も変わらない。 */
  private drive(): OpticsDrive {
    const manual = this.manualDrive();
    return this.driveMode === 'audio' ? this.audioDrive.toDrive(manual) : manual;
  }

  /** 光学系を組み直す。見え方の判断は `lightOpticsMapping.ts` の中だけで起きる。 */
  private rebuildRig(): void {
    const rig = buildOpticalRig(this.group, this.drive(), {
      aspectRatio: this.aspectRatio,
    });
    // 膜の表示トグルは開発用の A/B なので、対応そのものではなくここで間引く。
    const visible = this.hazeVisible ? rig : rig.filter((entry) => entry.kind !== 'haze');
    this.layers = visible.slice(0, LAB2.maximumLayers);
    this.writeLayers();
  }

  /**
   * **1 ドローで全層を描く板。**
   * チャンネル分離はフラグメントの中で 3 回評価するだけなので、
   * 分離のためにインスタンスを 3 倍にはしない。
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
    add('aShape', this.shapes, 4);
    add('aAxis', this.axes, 4);
    add('aDepth', this.depths, 4);
    add('aChannel', this.channels, 4);
    geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.placeholder },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uIntensity: { value: LAB2.defaults.intensity },
        uChannelGain: { value: new THREE.Vector3(1, 1, 1) },
        uOffset: { value: LAB2.defaults.channelOffset },
        uOffsetMode: { value: 0 },
        uDecorrelation: { value: LAB2.defaults.decorrelation },
        uHue: { value: LAB2.defaults.huePhase },
        uTint: { value: 1 },
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
        attribute vec4 aShape;
        attribute vec4 aAxis;
        attribute vec4 aDepth;
        attribute vec4 aChannel;
        varying vec2 vLocal;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying vec4 vTone;
        varying vec4 vShape;
        varying vec4 vAxis;
        varying vec4 vDepth;
        varying vec4 vChannel;
        varying float vTile;

        void main() {
          vLocal = position.xy * 2.0;
          vCrop = aCrop;
          vOrient = aOrient;
          vTone = aTone;
          vShape = aShape;
          vAxis = aAxis;
          vDepth = aDepth;
          vChannel = aChannel;
          vTile = aSize.z;

          // 面はカメラ正面に固定する。骨格は回転も移動もしない（構図は不動）。
          float cs = cos(aSpin);
          float sn = sin(aSpin);
          vec2 planar = vec2(
            vLocal.x * aSize.x * cs - vLocal.y * aSize.y * sn,
            vLocal.x * aSize.x * sn + vLocal.y * aSize.y * cs
          );
          gl_Position =
            projectionMatrix * modelViewMatrix * vec4(aOffset + vec3(planar, 0.0), 1.0);
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
        uniform float uHue;
        uniform float uTint;
        varying vec2 vLocal;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying vec4 vTone;
        varying vec4 vShape;
        varying vec4 vAxis;
        varying vec4 vDepth;
        varying vec4 vChannel;
        varying float vTile;

        const float TAU = 6.28318530718;
        const float DECORRELATION_SCALE = ${LAB2.decorrelationScale.toFixed(4)};
        const float SOFT_SAMPLE_RADIUS = ${OPTICS.softSampleRadius.toFixed(4)};
        const float TINT_DEPTH = ${OPTICS.tintDepth.toFixed(4)};

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

        /** グローバル波長。層は H に小さなオフセットを足すだけで独立の色を持たない。 */
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
         * チャンネルごとの UV 歪みの非相関。0 なら 3 チャンネル完全に同一の歪みで、
         * 色は幾何的なオフセットだけから生まれる。層ごとの下限を持つので、
         * **白の予算を持たない層はつまみを 0 にしても重なりきらない。**
         */
        vec2 decorrelate(vec2 uv, float channel) {
          float amount = max(uDecorrelation * vChannel.y, vChannel.w);
          if (amount <= 0.0) return uv;
          float phase = channel * 2.0943951;
          vec2 warp = vec2(sin(uv.y * 9.0 + phase), cos(uv.x * 7.5 + phase * 1.37));
          return uv + warp * amount * DECORRELATION_SCALE;
        }

        /**
         * 素材の輝度。**遠いほど広い平均で読む**ので、奥の層は鈍って見える
         * （奥行きの手がかりの片側。もう片側は明るさ vDepth.x）。
         */
        float atlasLight(vec2 p, float channel) {
          vec2 q = vec2(
            p.x * vOrient.x - p.y * vOrient.y,
            p.x * vOrient.y + p.y * vOrient.x
          );
          q *= vec2(vOrient.z, vOrient.w);
          vec2 uv = decorrelate(vCrop.xy + q * 0.5 * vec2(vCrop.z, vCrop.w), channel);
          float r = vDepth.y * SOFT_SAMPLE_RADIUS;
          vec3 sum = sampleTile(uv);
          sum += sampleTile(uv + vec2(r, 0.0));
          sum += sampleTile(uv - vec2(r, 0.0));
          sum += sampleTile(uv + vec2(0.0, r));
          sum += sampleTile(uv - vec2(0.0, r));
          return pow(max(labLuminance(sum * 0.2) * 3.2, 0.0), 0.55);
        }

        /**
         * **1 チャンネルぶんの輝度マスク。** 読む位置も窓も渡された p で決まるので、
         * p をずらせばそのチャンネルの光ごとずれる。
         */
        float elementMask(vec2 p, float channel) {
          float kind = vTone.z;
          float soft = vDepth.y;

          // ---- アーム: 打撃に同期した一時的な光条。コアから片側だけへ伸びる ----
          if (kind > 5.5) {
            if (p.x <= 0.0) return 0.0;
            float across = p.y / max(vShape.x, 1e-4);
            float spine = exp(-across * across);
            float halo = exp(-across * across * 0.06) * vShape.y;
            // 根元は芯に隠す。ここを 0 にしておくと複数のアームが中心で重ならない。
            float root = smoothstep(0.0, 0.09, p.x);
            float taper = 1.0 - smoothstep(vShape.z, vShape.w, p.x);
            return (spine + halo) * root * taper;
          }

          // ---- カーテン: 膜よりはっきりした形を持つが、あくまで薄い層 ----
          // 形状族は 3 つ。族と個体差は seed が選び、ここは受け取った値を描くだけ。
          if (kind > 4.5) {
            float family = vShape.x;
            float width = max(vShape.z, 0.02);
            float body;
            float along;
            if (family < 0.5) {
              // 縦に立つ襞のあるヴェール。横断は x、伸びは y。
              float across = p.x / width;
              body = exp(-across * across) * (0.55 + 0.45 * sin(p.x * vShape.y + p.y * 1.7));
              along = 1.0 - smoothstep(0.38, 0.9, abs(p.y));
            } else if (family < 1.5) {
              // 斜めに流れる帯。板ごと回してあるので、ここは緩い傾きだけ足す。
              float across = (p.y + p.x * vShape.w) / width;
              body = exp(-across * across) * (0.6 + 0.4 * sin(p.x * vShape.y));
              along = 1.0 - smoothstep(0.34, 0.88, abs(p.x));
            } else {
              // 折れたリボン状。中心線に V 字の折れを入れる。
              float centre = vShape.w * (abs(p.x) - 0.45);
              float across = (p.y - centre) / width;
              body = exp(-across * across) * (0.58 + 0.42 * sin(p.x * vShape.y + 1.1));
              along = 1.0 - smoothstep(0.34, 0.88, abs(p.x));
            }
            if (along <= 0.0) return 0.0;
            return max(body, 0.0) * along * (0.26 + atlasLight(p, channel) * 0.95);
          }

          // ---- 膜: 画面全体をまとめる大面積の霞。明るさの階層のいちばん下 ----
          if (kind > 3.5) {
            float r = length(p);
            // **画面の縁で必ず黒へ落とす窓。** 板は画面より大きく取ってあるので、
            // ここが 0 になる半径は画面の内側にある。加算合成で縁が浮かない保険。
            float window = 1.0 - smoothstep(vShape.y, vShape.z, r);
            if (window <= 0.0) return 0.0;
            float body = exp(-r * r * vShape.x);
            // 低周波のムラ。ベタの放射グラデーションにはしない。
            float mottle =
              0.62 + 0.38 * sin(p.x * 2.7 + p.y * 1.9) * cos(p.y * 3.3 - p.x * 1.4);
            // 細かい粒。素材と合わせて「媒質」に見せる。
            float grain = 0.9 + 0.1 * sin(dot(p, vec2(97.3, 61.7)));
            return window * body * mottle * grain * (0.3 + atlasLight(p, channel) * 0.9);
          }

          // ---- 扇: コアからの放射状光条。閾値ゲートが開いたときだけ描かれる ----
          if (kind > 2.5) {
            float r = length(p);
            if (r < 1e-4) return 0.0;
            float delta = atan(p.y, p.x) - vShape.x;
            delta = atan(sin(delta), cos(delta));
            // 4 乗の窓。扇は基準角の周りだけに出て、反対側へは回り込まない。
            float sector = exp(-pow(delta / max(vShape.y, 1e-3), 4.0));
            if (sector <= 0.002) return 0.0;
            // 光条はレーザーではなくカウスティクスなので、鋭さを抑えて素材で割る。
            float blades = pow(abs(cos(delta * vShape.z)), mix(15.0, 6.0, soft));
            float radial =
              smoothstep(0.05, 0.3, r) * exp(-pow(r / max(vShape.w, 1e-3), 2.0));
            return sector * blades * radial * (0.35 + atlasLight(p, channel) * 0.95);
          }

          // ---- 断片: 一時的なヴェール片。輪郭の作り方そのものが 4 通りある ----
          // 三角 1 種類だと「同じ形が飛び回っている」ようにしか見えないため。
          if (kind > 1.5) {
            float family = vShape.y;
            // 形の中の伸び。板の比率と掛かって、同じ族でも個体差が出る。
            vec2 q = vec2(p.x / max(vShape.z, 0.15), p.y * max(vShape.z, 0.15));
            float d;
            if (family < 0.5) {
              // 三角シャード。
              d = max(
                max(dot(q, vec2(0.0, -1.0)), dot(q, vec2(0.8660254, 0.5))),
                dot(q, vec2(-0.8660254, 0.5))
              );
            } else if (family < 1.5) {
              // 細長いスリヴァー。2 つの円の交わりで両端の尖ったレンズを作る。
              d = max(
                length(q - vec2(0.0, -0.95)) - 1.22,
                length(q - vec2(0.0, 0.95)) - 1.22
              ) + 0.34;
            } else if (family < 2.5) {
              // 不等辺の四辺形の板片。
              d = max(
                max(dot(q, vec2(0.9487, 0.3162)), dot(q, vec2(-0.8575, 0.5145))),
                max(dot(q, vec2(-0.1961, -0.9806)), dot(q, vec2(0.6, -0.8)))
              );
            } else {
              // 角の欠けた小片。三角から 1 辺ぶん落とす。
              float tri = max(
                max(dot(q, vec2(0.0, -1.0)), dot(q, vec2(0.8660254, 0.5))),
                dot(q, vec2(-0.8660254, 0.5))
              );
              d = max(tri, dot(q, vec2(0.6402, 0.7682)) + vShape.w);
            }
            float inside = 1.0 - smoothstep(
              vShape.x - mix(0.18, 0.44, soft),
              vShape.x + mix(0.10, 0.34, soft),
              d
            );
            if (inside <= 0.0) return 0.0;
            return inside * (0.28 + atlasLight(p, channel) * 0.85);
          }

          // ---- 骨格: 直線。縦の細い線と横の帯が中央で十字を作る ----
          if (kind > 0.5) {
            float width = max(vShape.x, 1e-4) * (1.0 + soft * 2.0);
            float across = p.y / width;
            float spine = exp(-across * across);
            float halo = exp(-across * across * 0.02) * vShape.y;
            float along = clamp(1.0 - abs(p.x), 0.0, 1.0);
            return (spine + halo) * pow(along, mix(0.22, 0.6, soft));
          }

          // ---- コア: 白熱する芯。白へ到達してよい唯一の層 ----
          float ellipse = length(p / vec2(1.0, 0.92));
          float softEdge = 1.0 - smoothstep(0.56 - soft * 0.2, 1.04 + soft * 0.3, ellipse);
          if (softEdge <= 0.0) return 0.0;
          float radial2 = dot(p, p);
          // 白は「芯」だけが持つ。素材ぶんは白へ届かない高さに抑える。
          float nucleus = exp(-radial2 * mix(52.0, 14.0, soft));
          float wide = exp(-radial2 * mix(4.2, 1.6, soft));
          float body = atlasLight(p, channel) * 0.8 + nucleus * 1.7 * vShape.w + wide * 0.05;
          // 形状族のフレア。vShape.x < 0 は素の芯（静止画スタディの既定）。
          if (vShape.x >= 0.0) {
            float flareH = exp(-p.y * p.y * 220.0) * exp(-p.x * p.x * 1.1);
            float flareV = exp(-p.x * p.x * 220.0) * exp(-p.y * p.y * 1.1);
            body += flareH * vShape.y + flareV * vShape.z;
          }
          return softEdge * body;
        }

        void main() {
          vec2 p = vLocal;

          // 分離の向き。放射状は構図の中心から外向き、軸沿いは要素自身の軸。
          vec2 dir;
          if (uOffsetMode < 0.5) {
            vec2 away = p - vAxis.zw;
            dir = dot(away, away) > 1e-8 ? normalize(away) : vec2(1.0, 0.0);
          } else {
            dir = normalize(vAxis.xy);
          }
          // 白の予算を持たない層は下限を持つので、つまみ 0 でも重なりきらない。
          vec2 shift = dir * max(uOffset * vChannel.x, vChannel.z);

          // R は +、G は中央、B は −。等間隔なので R=G=B のときは無彩色になる。
          vec3 channels = max(
            vec3(
              elementMask(p + shift, 0.0),
              elementMask(p, 1.0),
              elementMask(p - shift, 2.0)
            ),
            0.0
          ) * uChannelGain;
          if (channels.r + channels.g + channels.b <= 0.0) discard;

          // **グローバル波長 H。** 層は H に小さなオフセットと勾配を足すだけなので、
          // H が動くと全要素が一斉にスペクトル上をスライドする。
          // 分光は白へ少し寄せる。光は「染まった白」であって絵の具ではないので、
          // ここを浅くしておくとチャンネル分離の縁の色が波長の下から見えてくる。
          // 膜だけは彩度をさらに落とす（媒質が独立の色を持つと全体の色相ルールが崩れる）。
          // カーテン（種別 5）も 3.5 より大きいので、膜（種別 4）だけを取り出す。
          float isHaze = step(3.5, vTone.z) * step(vTone.z, 4.5);
          float tintDepth = TINT_DEPTH * mix(1.0, vShape.w, isHaze);
          vec3 tint = uTint > 0.5
            ? mix(
                vec3(1.0),
                spectrum(uHue + vTone.x + gradientAt(p, vDepth.w) * vTone.y),
                tintDepth
              )
            : vec3(1.0);

          // vTone.w = 層の明るさ / vDepth.x = 奥行きの減光（1 本の式の片側）。
          vec3 color = channels * tint * vTone.w * vDepth.x * uIntensity;

          // **明るさの階層の天井。** コアだけが 1.0（白へ届く）で、
          // 骨格・断片・扇は 0.30、膜は 0.11。層は自分の段より上へは出られない。
          color = min(color, vec3(vDepth.z));

          gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
        }
      `,
    });

    this.geometry = geometry;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  /** traits をインスタンス属性へ書く。奥行きの式もここで 1 度だけ通す。 */
  private writeLayers(): void {
    if (!this.geometry) return;
    const count = Math.min(this.layers.length, LAB2.maximumLayers);
    for (let index = 0; index < count; index++) {
      const entry = this.layers[index]!;
      const cue = depthCue(entry.position[2]);
      this.offsets[index * 3] = entry.position[0];
      this.offsets[index * 3 + 1] = entry.position[1];
      this.offsets[index * 3 + 2] = entry.position[2];
      this.sizes[index * 3] = entry.half[0];
      this.sizes[index * 3 + 1] = entry.half[1];
      this.sizes[index * 3 + 2] = this.tileFor(entry);
      this.spins[index] = entry.spin;
      this.crops[index * 4] = entry.crop[0];
      this.crops[index * 4 + 1] = entry.crop[1];
      this.crops[index * 4 + 2] = entry.crop[2];
      this.crops[index * 4 + 3] = entry.crop[3];
      this.orients[index * 4] = Math.cos(entry.uvAngle);
      this.orients[index * 4 + 1] = Math.sin(entry.uvAngle);
      this.orients[index * 4 + 2] = entry.flipX;
      this.orients[index * 4 + 3] = entry.flipY;
      this.tones[index * 4] = entry.hueDelta;
      this.tones[index * 4 + 1] = entry.hueSpan;
      this.tones[index * 4 + 2] = KIND_INDEX[entry.kind];
      this.tones[index * 4 + 3] = entry.intensity;
      this.shapes[index * 4] = entry.shape[0];
      this.shapes[index * 4 + 1] = entry.shape[1];
      this.shapes[index * 4 + 2] = entry.shape[2];
      this.shapes[index * 4 + 3] = entry.shape[3];
      this.axes[index * 4] = entry.axis[0];
      this.axes[index * 4 + 1] = entry.axis[1];
      // 構図の中心（原点）をその層のローカル座標へ写す（放射状モードの原点）。
      this.axes[index * 4 + 2] = -entry.position[0] / Math.max(entry.half[0], 1e-6);
      this.axes[index * 4 + 3] = -entry.position[1] / Math.max(entry.half[1], 1e-6);
      this.depths[index * 4] = cue.dim;
      this.depths[index * 4 + 1] = cue.soft;
      // 明るさの階層の天井（コア 1.0 / 骨格・断片・扇 0.30 / 膜 0.11）。
      this.depths[index * 4 + 2] = entry.ceiling;
      this.depths[index * 4 + 3] = entry.gradientForm;
      this.channels[index * 4] = entry.channel[0];
      this.channels[index * 4 + 1] = entry.channel[1];
      this.channels[index * 4 + 2] = entry.channel[2];
      this.channels[index * 4 + 3] = entry.channel[3];
    }
    for (const attribute of Object.values(this.attributes)) attribute.needsUpdate = true;
    this.geometry.instanceCount = count;
  }

  /** 役割で素材を選ぶ。アトラスが未着なら 0 番として扱う。 */
  private tileFor(entry: OpticalLayerTraits): number {
    const tiles: readonly PrismTile[] = this.atlas?.tiles ?? [];
    if (tiles.length === 0) return 0;
    for (const role of entry.preferredRoles) {
      const index = tiles.findIndex((tile) => tile.role === role);
      if (index >= 0) return index;
    }
    return clamp(entry.fallbackTile, 0, tiles.length - 1);
  }

  // ---------------------------------------------------------------- 毎フレーム

  update(elapsed: number): void {
    // Manual は静止画のスタディなので、時間で変わるものを 1 つも持たない。
    // Audio のときだけ、音を受けて基礎輝度と脈動が動く。
    if (this.driveMode === 'audio') {
      // dt はこの時計の差分。タブ復帰の巨大な delta は切る。
      const delta =
        this.previousElapsed < 0 ? 0 : Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.25);
      const engine = this.context?.audioEngine;
      const audio = engine?.getParameters() ?? {};
      // 打撃の検出はスペクトルを見る。無いエンジンでも持続だけは動く。
      const spectrum = engine?.getSpectrum?.() ?? null;
      this.audioDrive.update(audio, spectrum, elapsed, delta);
      this.rebuildRig();
    }
    this.previousElapsed = elapsed;

    const material = this.material;
    if (material) {
      material.uniforms.uIntensity!.value = this.params.intensity;
      // **チャンネル利得。** Audio では帯域バランスが色調を傾ける（Bass=R / Mid=G / Treble=B）。
      // つまみ 0 で手動のまま、1 で完全に帯域駆動、中間はブレンド。
      const tilt = this.channelTilt();
      (material.uniforms.uChannelGain!.value as THREE.Vector3).set(tilt[0], tilt[1], tilt[2]);
      material.uniforms.uOffset!.value = this.params.channelOffset;
      material.uniforms.uOffsetMode!.value = this.offsetMode === 'radial' ? 0 : 1;
      material.uniforms.uDecorrelation!.value = this.params.decorrelation;
      material.uniforms.uHue!.value = this.activeHue();
      material.uniforms.uTint!.value = this.globalTint ? 1 : 0;
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
    // 黒背景固定。色はグローバル波長とチャンネル構造だけから作る。
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
    // 骨格は画角が変わっても画面を貫く必要があるので、板の長さを取り直す。
    this.rebuildRig();
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
    const hue = this.activeHue().toFixed(2);
    const levels = this.audioDrive.levels();
    const drive =
      this.driveMode === 'audio'
        ? `audio src ${levels.source.toFixed(2)} → sk ${levels.skeleton.toFixed(2)} / cu ${levels.curtain.toFixed(2)} / ha ${levels.haze.toFixed(2)} / pulse ${levels.corePulse.toFixed(2)} ×${levels.pulseCount}/${levels.strikeCount} / shape ${levels.coreShape} / arms ${levels.armMask} / frag ${levels.visibleFragments}/${levels.liveFragments} (×${levels.fragmentBirths}) / fan ${levels.fanPower.toFixed(2)} ×${levels.fanCount} / tone ${levels.timbre.toFixed(2)} → H${levels.hueState} ×${levels.hueSwitches} / tick ${levels.tick}`
        : `manual pulse ${this.params.corePulse.toFixed(2)}`;
    return `Optics: ${GROUP_LABELS[this.group]} — H ${hue} / ${drive} / layers ${this.layers.length}`;
  }

  /** 開発・検証用。`window.__lab` と Inspector から読む。 */
  getOpticsState(): LightElementLab2State {
    return {
      group: this.group,
      layers: this.layers.length,
      whiteAllowedLayers: this.layers.filter((entry) => entry.whiteAllowed).length,
      // **いま効いている H**（Manual はつまみ・Audio は音色が選んだ状態）。
      huePhase: this.activeHue(),
      depth: this.layers.map((entry) => ({
        kind: entry.kind,
        z: entry.position[2],
        ...depthCue(entry.position[2]),
      })),
      families: this.layers
        .filter((entry) => entry.kind === 'veil' || entry.kind === 'curtain')
        .map((entry) => ({
          kind: entry.kind,
          family:
            entry.kind === 'veil'
              ? (FRAGMENT_FAMILIES[entry.shape[1]] ?? 'unknown')
              : (CURTAIN_FAMILIES[entry.shape[0]] ?? 'unknown'),
        })),
      driveMode: this.driveMode,
      levels: this.audioDrive.levels(),
    };
  }

  /**
   * 開発つまみ（AudioInspector の dev ブロック）。**本番 UI には出さない**（PRD D17）。
   *
   * ---
   * ## つまみは減らさない（2026-07-30 夜の方針）
   *
   * **ツールを 1 つの見え方に最適化しない。** 音 × 視覚の接続は調整可能に保ち、
   * 好みの見え方は**プリセット**として実現する。
   * **変数の数がそのまま「出せる絵の幅」になる**ので、探索が終わって値が確定したものでも
   * つまみ自体は残す（確定したのは**既定値**であって、動かせないという意味ではない）。
   *
   * いったん撤去した 9 本（`Strobe rate` / `Arms (Manual)` / `Haze layer` /
   * `Red` `Green` `Blue` / `Offset direction` / `Global tint (H)` / `Depth probe`）は
   * この方針でここへ戻してある。**既定値は実楽曲での通し計測で決めた値のまま。**
   */
  getExpressionParams(): ExpressionParam[] {
    const row = (key: Lab2ParamKey, label: string): ExpressionParam => ({
      key,
      label,
      ...LAB2.ranges[key],
      value: this.params[key],
    });
    return [
      {
        key: 'driveMode',
        label: 'Drive',
        type: 'select',
        options: [
          { value: 'manual', label: 'Manual (static study)' },
          { value: 'audio', label: 'Audio' },
        ],
        value: this.driveMode,
      },
      {
        key: 'strobe',
        label: 'Strobe (Audio only)',
        type: 'select',
        options: [
          { value: 'on', label: 'On (24fps ticks)' },
          { value: 'off', label: 'Off (continuous)' },
        ],
        value: this.strobeEnabled ? 'on' : 'off',
      },
      {
        key: 'strobeRate',
        label: 'Strobe rate (fps)',
        min: 6,
        max: 60,
        step: 1,
        value: this.strobeRate,
      },
      // ---- 場の濃さと発光の閾値（Audio のみ）----
      {
        key: 'sustainGamma',
        label: 'Sustain gamma',
        min: 0.1,
        max: 1,
        step: 0.01,
        value: this.sustainGamma,
      },
      {
        key: 'fieldGain',
        label: 'Field gain',
        min: 0.5,
        max: 3,
        step: 0.05,
        value: this.fieldGain,
      },
      {
        key: 'channelDrive',
        label: 'Channel drive',
        min: 0,
        max: 1,
        step: 0.01,
        value: this.channelDrive,
      },
      {
        key: 'traceAmount',
        label: 'Trace amount',
        min: 0,
        max: 1,
        step: 0.01,
        value: this.traceAmount,
      },
      {
        key: 'coreThreshold',
        label: 'Core threshold',
        min: 0,
        max: 0.8,
        step: 0.01,
        value: this.coreThreshold,
      },
      {
        key: 'fanThreshold',
        label: 'Fan threshold',
        min: 0,
        max: 1,
        step: 0.01,
        value: this.fanThreshold,
      },
      // ---- H の切替の粘り（Audio のみ。Manual のつまみは下の Global hue H）----
      {
        key: 'hueConfirm',
        label: 'Hue confirm (s)',
        min: 0.2,
        max: 3,
        step: 0.05,
        value: this.hueConfirm,
      },
      {
        key: 'hueHold',
        label: 'Hue hold (s)',
        min: 1,
        max: 12,
        step: 0.5,
        value: this.hueHold,
      },
      {
        key: 'coreShape',
        label: 'Core shape (Manual)',
        type: 'select',
        options: [
          { value: '-1', label: 'Plain' },
          ...CORE_SHAPES.map((name, index) => ({ value: String(index), label: name })),
        ],
        value: String(this.coreShape),
      },
      {
        key: 'manualArms',
        label: 'Arms (Manual)',
        type: 'select',
        options: [
          { value: '0', label: 'None' },
          { value: '1', label: 'Up' },
          { value: '2', label: 'Right' },
          { value: '4', label: 'Down' },
          { value: '8', label: 'Left' },
          { value: '3', label: 'Up + Right' },
          { value: '12', label: 'Down + Left' },
          { value: '10', label: 'Left + Right' },
          { value: '5', label: 'Up + Down' },
          { value: '15', label: 'All' },
        ],
        value: String(this.manualArmMask),
      },
      // ---- 音が注ぎ込むもの（Audio では未配線のものだけつまみが効く）----
      row('huePhase', 'Global hue H'),
      row('skeletonLevel', 'Skeleton level'),
      row('corePulse', 'Core pulse'),
      row('fragmentEnergy', 'Fragment energy'),
      row('fragmentSeed', 'Fragment seed'),
      {
        key: 'fanGate',
        label: 'Fan gate',
        type: 'select',
        options: [
          { value: 'open', label: 'Open (high energy)' },
          { value: 'closed', label: 'Closed' },
        ],
        value: this.fanGateOpen ? 'open' : 'closed',
      },
      {
        key: 'hazeVisible',
        label: 'Haze layer (dev A/B)',
        type: 'select',
        options: [
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ],
        value: this.hazeVisible ? 'on' : 'off',
      },
      // ---- チャンネル構造（色の作り方そのもの）----
      row('redGain', 'Red'),
      row('greenGain', 'Green'),
      row('blueGain', 'Blue'),
      row('channelOffset', 'Channel offset'),
      {
        key: 'offsetMode',
        label: 'Offset direction',
        type: 'select',
        options: [
          { value: 'radial', label: 'Radial from centre' },
          { value: 'axis', label: 'Along element axis' },
        ],
        value: this.offsetMode,
      },
      row('decorrelation', 'Channel decorrelation'),
      row('intensity', 'Intensity'),
      {
        key: 'globalTint',
        label: 'Global tint (H)',
        type: 'select',
        options: [
          { value: 'on', label: 'On (one wavelength)' },
          { value: 'off', label: 'Off (channels only)' },
        ],
        value: this.globalTint ? 'on' : 'off',
      },
      // ---- 計測用 ----
      row('depthProbe', 'Depth probe (0 = off)'),
    ];
  }

  setExpressionParam(key: string, value: number | string): void {
    if (key === 'driveMode') {
      const next: DriveMode = value === 'audio' ? 'audio' : 'manual';
      if (next !== this.driveMode) {
        // 切り替えた瞬間に前のモードの余韻が残らないようにする。
        this.audioDrive.reset();
        this.previousElapsed = -1;
        this.driveMode = next;
        this.rebuildRig();
      }
      return;
    }
    if (key === 'offsetMode') {
      this.offsetMode = value === 'axis' ? 'axis' : 'radial';
      return;
    }
    if (key === 'globalTint') {
      this.globalTint = value !== 'off';
      return;
    }
    if (key === 'fanGate') {
      this.fanGateOpen = value !== 'closed';
      this.rebuildRig();
      return;
    }
    if (key === 'hazeVisible') {
      this.hazeVisible = value !== 'off';
      this.rebuildRig();
      return;
    }
    if (key === 'strobe') {
      this.strobeEnabled = value !== 'off';
      this.audioDrive.setStrobe(this.strobeEnabled, this.strobeRate);
      return;
    }
    if (key === 'strobeRate') {
      const rate = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(rate)) return;
      this.strobeRate = clamp(Math.round(rate), 6, 60);
      this.audioDrive.setStrobe(this.strobeEnabled, this.strobeRate);
      return;
    }
    if (key === 'coreThreshold' || key === 'fanThreshold') {
      const gate = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(gate)) return;
      if (key === 'coreThreshold') {
        this.coreThreshold = clamp(gate, 0, 0.8);
        this.audioDrive.setCoreThreshold(this.coreThreshold);
      } else {
        this.fanThreshold = clamp(gate, 0, 1);
        this.audioDrive.setFanThreshold(this.fanThreshold);
      }
      return;
    }
    if (key === 'sustainGamma') {
      const gamma = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(gamma)) return;
      this.sustainGamma = clamp(gamma, 0.1, 1);
      this.audioDrive.setSustainGamma(this.sustainGamma);
      return;
    }
    if (key === 'channelDrive') {
      const drive = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(drive)) return;
      this.channelDrive = clamp(drive, 0, 1);
      return;
    }
    if (key === 'traceAmount') {
      const amount = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(amount)) return;
      this.traceAmount = clamp(amount, 0, 1);
      this.audioDrive.setTraceAmount(this.traceAmount);
      return;
    }
    if (key === 'fieldGain') {
      const gain = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(gain)) return;
      this.fieldGain = clamp(gain, 0.5, 3);
      this.audioDrive.setFieldGain(this.fieldGain);
      return;
    }
    if (key === 'hueConfirm' || key === 'hueHold') {
      const seconds = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(seconds)) return;
      if (key === 'hueConfirm') {
        this.hueConfirm = clamp(seconds, 0.2, 3);
        this.audioDrive.setHueConfirm(this.hueConfirm);
      } else {
        this.hueHold = clamp(seconds, 1, 12);
        this.audioDrive.setHueHold(this.hueHold);
      }
      return;
    }
    if (key === 'manualArms') {
      const mask = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(mask)) return;
      this.manualArmMask = clamp(Math.round(mask), 0, 15);
      this.rebuildRig();
      return;
    }
    if (key === 'coreShape') {
      const index = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(index)) return;
      this.coreShape = clamp(Math.round(index), -1, CORE_SHAPES.length - 1);
      this.rebuildRig();
      return;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return;
    if (!(key in this.params)) return;
    const range = LAB2.ranges[key as Lab2ParamKey];
    this.params[key as Lab2ParamKey] = clamp(numeric, range.min, range.max);
    // 光学系そのものを組み直すつまみ（色とチャンネルは uniform で足りる）。
    if (
      key === 'skeletonLevel' ||
      key === 'corePulse' ||
      key === 'fragmentEnergy' ||
      key === 'fragmentSeed' ||
      key === 'depthProbe'
    ) {
      this.rebuildRig();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pipeline?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.placeholder?.dispose();
    this.atlas?.texture.dispose();
    if (this.mesh && this.scene) this.scene.remove(this.mesh);
    this.layers = [];
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
