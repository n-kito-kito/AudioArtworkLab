import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { THEMES, type Theme } from '../engine/themes';
import { getSourceShelf, type AudioSourceShelf } from '../engine/binding/sources';
import { BindingResolver } from '../engine/binding/resolve';
import { defaultTransformFor, type ParamDecl } from '../engine/binding/types';
import type { CompositionContext, DesignLayerCanvases } from '../compositions/Composition';
import type { ExpressionNumberParam, ExpressionParam, LabExpression } from './Expression';
import type { ExpressionId } from './catalog';
import { OpticsAudioDrive, hueOfPhase } from './opticsAudioDrive';
import { channelBalanceGain } from './channelBalance';
import type { FragmentSpawn } from './lightOpticsMapping';
import { loadPrismAtlas, type PrismAtlas } from './prismAtlas';
import { createPolygonAtlas, type PolygonAtlas } from './polygonAtlas';
import {
  AXIS_DECLS,
  AXIS_PRESETS,
  DEFAULT_AXES,
  tickRateOf,
  UNIFIED_GROUPS,
  type UnifiedAxes,
} from './unifiedAxes';
import {
  AXIS_MASTERS,
  applyAspect,
  applyMaster,
  applySpread,
  readAspect,
  readMaster,
  readSpread,
} from './unifiedMasters';
import {
  UNIFIED,
  UNIFIED_KIND_INDEX,
  buildUnifiedRig,
  capUnifiedRig,
  hash01,
  type UnifiedDrive,
  type UnifiedKind,
  type UnifiedLayer,
} from './unifiedRig';
import { DelayLine, EmissionShape, TIME, staggerOf } from './unifiedTime';

/**
 * **Light Unified — 3 つの Light 表現を連続軸で行き来する統合表現。**
 *
 * Spatial Study / Reactive Lab / Element Lab 2 は**無改変で温存**し、
 * ここは新規に書いたレンダラーである。持ち込むのは共有部品だけ
 * （帯域イベント検出・アトラス・結線・痕跡場を抱える `OpticsAudioDrive`）。
 *
 * **どの軸もコードパスの切替ではなく、描画数式の中の連続な混合係数**として効く。
 * だからスライダーの途中に、3 つのどれでもない見え方が現れる。
 *
 * 描画は **1 ドロー**。6 種別（核 / 光条 / 膜 / 靄 / 破片 / 扇）はフラグメントの
 * 分岐で切り替え、チャンネル分離のためにインスタンスは増やさない。
 */

const LIMITS = {
  /**
   * インスタンスの上限。靄 1 + 膜 4 + 光条 7 + 破片 36 + 扇 1 + 核 1 を超えるので、
   * 切るときは**種別ごとの枠**（`capUnifiedRig`）で切る。単純に先頭から取ると
   * 末尾の扇と核が落ち、白へ届いてよい唯一の層が消える。
   *
   * 素材の膜（`Material light`）の枠 8 を足したので 48 → 56。枠の合計 54 は
   * 上限より小さいままなので、**どの密度でも核と扇は必ず残る**。
   *
   * **上限を広げても従来の絵は 1 画素も動かない。** 既存 6 種別の枚数の合計は
   * どの軸でも枠の合計 46 を超えないので（枠はその種別が出しうる最大枚数）、
   * 旧上限 48 では `capUnifiedRig` がそもそも 1 枚も落としていなかった。
   * 軸 0 では素材の膜が 1 枚も作られないので、切る前も後も配列は同じである。
   */
  maximumLayers: 56,
  /** 尾を引いている破片も保持するので、生きている枚数より少し多く持つ。 */
  maximumFragmentShapes: 40,
  nearPlane: 0.1,
  farPlane: 90,
  /**
   * 素材アトラス。**列数は素材の枚数を割り切れること。** 10 枚を 4 列で並べると
   * 3 行目に空きマスが 2 つ残り、そこを引いたインスタンスが**真っ黒**になる。
   */
  atlas: { manifestUrl: 'assets/light-traces/manifest.json', cellPixels: 384, columns: 5 },
  /**
   * **板の四角さを削る多角形の帳面**（`Silhouette` 軸）。起動時に一度だけ焼く。
   * 中身は符号つき距離場なので、どこまで拡大しても縁が鋭い。
   */
  maskAtlas: {
    patterns: 12,
    columns: 4,
    cellPixels: 128,
    vertexMinimum: 5,
    vertexMaximum: 7,
    radiusMinimum: 0.42,
    radiusMaximum: 0.94,
    angleJitter: 0.62,
    distanceSpread: 0.7,
    seedSalt: 0.2718281828,
  },
  /** 多角形の縁の柔らかさ。**硬い面には見せない**ので広くぼかす。 */
  maskSoftness: 0.3,
} as const;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 0〜1 の滑らかな立ち上がり（GLSL の同名関数と同じ形）。 */
const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * **音へ繋げる軸 —— 上段に出ているものは全部。**
 *
 * 「触る場所」と「繋ぐ場所」を分けない — スライダーのそこにソース選択を直付けする。
 * どれも 0〜1 の連続量なので、基準値 ± 変調という結線の契約にそのまま乗る。
 * 発光そのもの（場・打撃・扇）と色相 H は、下流の時間規律を壊さないために
 * `OpticsAudioDrive` 側の 1 本（発光 All / H の音色）へ繋ぐ。
 *
 * **一覧は `AXIS_DECLS` から引く。** 「常に見えている行（`detail !== true`）は
 * すべて音へ繋げる」という規則そのものを書いてあるので、上段の軸を足したときに
 * ここを書き足し忘れて**繋げない行が生まれる**ことがない。
 * 折りたたみの中（詳細）は対象外で、そちらはマスター経由で動かす。
 */
const UNIFIED_LOOK_PARAMS: readonly ParamDecl[] = AXIS_DECLS.filter(
  (decl) => decl.detail !== true,
).map((decl) => ({
  id: decl.id,
  label: decl.label,
  min: 0,
  max: 1,
  default: DEFAULT_AXES[decl.id],
  kind: 'continuous' as const,
}));

const LOOK_KEYS = new Set(UNIFIED_LOOK_PARAMS.map((entry) => entry.id));

/**
 * **結線に出すマスター。** 軸そのものではなくマスターへ繋ぐので、
 * 1 本の音が配下をまとめて動かす（`Core` なら大きさ・形・ブルームが一緒に押される）。
 * マスターは上段に常時出ているので、`Spread` を含めて全部が対象になる。
 *
 * `Colour lock` だけは**入れない** — その行にはもともと**色相 H** が添えてあり
 *（H は下流に状態機械を持つので `OpticsAudioDrive` 側の 1 本へ繋ぐ）、
 * ここへも入れると同じ行から 2 系統が同時に駆動されてしまう。
 */
const MASTER_LOOK_PARAMS: readonly ParamDecl[] = [
  {
    id: 'spread',
    label: 'Spread',
    min: 0,
    max: 1,
    default: readSpread(DEFAULT_AXES),
    kind: 'continuous',
  },
  ...AXIS_MASTERS.filter((master) => master.id !== 'spread' && master.id !== 'colourLock').map(
    (master) => ({
      id: master.id,
      label: master.label,
      min: 0,
      max: 1,
      default: readMaster(master, DEFAULT_AXES),
      kind: 'continuous' as const,
    }),
  ),
];

const MASTER_LOOK_KEYS = new Set(MASTER_LOOK_PARAMS.map((entry) => entry.id));

/** `Hue stickiness` が伸ばす時間（秒）。 */
const HUE = { confirmMin: 0.2, confirmMax: 1.8, holdMin: 1, holdMax: 10 } as const;

/** `Density` 軸が生成核へ渡す倍率の範囲。 */
const DENSITY = { min: 0.45, max: 2.6 } as const;

/**
 * **`Band unison` 軸 → 検出器の相対の敷居。**
 *
 * 1.0 は「最強の 1 帯域だけ」＝ 現状。0.12 まで下げると、最強帯域の 12% 以上の
 * フラックスを出した帯域が全部通る（実測では 2〜3 帯域が同時に立つ）。
 * ここを 0 にはしない — 0 にすると鳴っていない帯域の微小なフラックスまで拾って
 * 「いつも 3 個」になり、同時発光が出来事として読めなくなる。
 */
const UNISON = { floorAtOne: 0.12, poolMaximum: 3 } as const;

/**
 * **打撃ごとに生まれる膜（`Event membrane` 軸）の実寸。**
 *
 * 数値はここにしか書かない。寿命は `Decay` 軸が伸ばし、枚数は `Density` 軸が掛ける。
 */
const EVENT_MEMBRANE = {
  /** 1 つの打撃が生む枚数（弱い打撃 → 強い打撃）。 */
  countAtWeakStrike: 2,
  countAtStrongStrike: 5,
  /** 同時に生きられる枚数。プールの上限。 */
  poolMaximum: 24,
  /**
   * **`Isolation` 軸 1 のときの枚数の倍率**（1 打撃ぶんと、同時に生きられる数）。
   *
   * 面積を絞っても**同じ場所へ何枚も重なれば床は戻る**ので、重なりの枚数そのものを
   * 上限で押さえる。軸 0 では 1 倍 ＝ 従来と 1 枚も変わらない。
   */
  countAtIsolated: 0.6,
  poolAtIsolated: 0.5,
  /** 開くまでの遅れ（秒）。打撃の直後ではなく、少し遅れて膜が追いつく。 */
  delayMinimum: 0.02,
  delayMaximum: 0.22,
  /** 生きる長さ（秒）。`Decay` 軸 0 で短命、1 で長い。 */
  lifeAtShortDecay: 0.3,
  lifeAtLongDecay: 2.1,
  /** 同じ打撃でも枚ごとに残り方を変える（まとめて消えないため）。 */
  lifeSpreadMinimum: 0.7,
  lifeSpreadMaximum: 1.35,
  /** 開ききるまでの割合と、落ち始める割合（寿命に対する比）。 */
  attackFractionAtSharp: 0.02,
  attackFractionAtSlow: 0.3,
  holdFraction: 0.32,
} as const;

/** 場の値を持つ種別（`Stagger` 軸が種別ごとに時間をずらす）。 */
const FIELD_KINDS: readonly UnifiedKind[] = [
  'core',
  'beam',
  'membrane',
  'haze',
  'fragment',
  'fan',
  // 素材の膜は打撃イベント（`drive.membranes`）で生死が決まるので場は読まないが、
  // 記録は全種別ぶん揃えておく（`fieldLevels` は全種別を持つ約束）。
  'sheet',
];

/** 散らばりのシード。**固定値**（同じ音なら必ず同じ絵になる）。 */
const UNIFIED_SEED = 7;

/** 無音の駆動。**1 画素も出ない**状態。 */
const SILENT_DRIVE: UnifiedDrive = {
  fieldLevels: { core: 0, beam: 0, membrane: 0, haze: 0, fragment: 0, fan: 0, sheet: 0 },
  corePulse: 0,
  coreShape: -1,
  beamMask: 0,
  beamStrength: 0,
  beamSeed: 0,
  fanPower: 0,
  fanSeed: -1,
  coreBand: '',
  cores: [],
  fragments: [],
  membranes: [],
  hue: 0,
  tick: 0,
  time: 0,
  seed: UNIFIED_SEED,
};

export interface LightUnifiedState {
  readonly layers: number;
  /** 上限で切る**前**の枚数。切り落としが起きたかを検証で読む。 */
  readonly rigLayers: number;
  /** 生きている「打撃ごとの膜」の枚数。 */
  readonly eventMembranes: number;
  readonly whiteAllowedLayers: number;
  readonly axes: UnifiedAxes;
  readonly hue: number;
  readonly kinds: readonly string[];
}

export class LightUnified implements LabExpression {
  readonly animated = true;
  readonly name = 'Light Unified';
  readonly id: ExpressionId;

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  /** 連続軸。**この 20 本が見え方のすべてを決める。** */
  private readonly axes: UnifiedAxes = { ...DEFAULT_AXES };
  /**
   * **結線を通した実効値（このフレームぶん）。**
   *
   * 上段の軸をすべて音へ繋げるようにしたので、**軸を読む場所は 1 つに揃える**必要が出た。
   * `this.axes` を直接読んでいる場所が 1 つでも残っていると、その軸だけ
   * 「繋いでも動かない」という壊れ方をする。ここは 1 フレームに 1 回だけ作り、
   * 描画も時間の形も検出器への受け渡しも全部この写しから読む。
   *
   * 繋いでいない軸は基準値（スライダーの位置）がそのまま入るので、
   * **全部 None の既定では `this.axes` と同じ値**である。
   */
  private look: UnifiedAxes = { ...DEFAULT_AXES };

  /** 音 → 生成核。3 表現と同じ検出・結線・痕跡場をそのまま使う。 */
  private readonly audioDrive = new OpticsAudioDrive();
  /** 見え方の軸を音へ繋ぐ解決器（発光と H は生成核の側に持つ）。 */
  private readonly lookResolver = new BindingResolver();
  private shelf: AudioSourceShelf | null = null;
  private previousElapsed = -1;

  /**
   * 時間軸（Strobe / Attack / Decay）が作る発光の形。
   * `hold` は**尾を引いているあいだも同じ形・同じ向きで消える**ように覚えておく値。
   */
  /**
   * 種別ごとの場の形。**`Stagger` 軸が「後から開いて長く残る」層を作る**ので、
   * 1 本の値を共有できない（軸 0 では 6 本とも同じ値になる）。
   */
  private readonly fieldShapes: Record<UnifiedKind, EmissionShape> = {
    core: new EmissionShape(),
    beam: new EmissionShape(),
    membrane: new EmissionShape(),
    haze: new EmissionShape(),
    fragment: new EmissionShape(),
    fan: new EmissionShape(),
    sheet: new EmissionShape(),
  };
  /** 素の駆動を数フレームぶん覚えておく遅延線（遅れて開くため）。 */
  private readonly fieldLine = new DelayLine();
  private readonly coreLine = new DelayLine();
  private readonly fanLine = new DelayLine();
  private readonly beamLine = new DelayLine();
  private readonly coreLight = { emission: new EmissionShape(), hold: -1 };
  /**
   * **同時に光る追加のコア 1 個ずつの時間の形。**
   *
   * 主コアと同じ `Attack` / `Decay` / `Strobe` を通す（尾の倍率も核の `Stagger`）。
   * `Band unison` 軸が 0 のあいだ生成核が 1 つも出さないので、この表は常に空である。
   */
  private readonly companionCores = new Map<
    string,
    { band: string; seed: number; pulse: number; emission: EmissionShape; alive: boolean }
  >();
  private readonly fanLight = { emission: new EmissionShape(), hold: -1 };
  private readonly beamShape = new EmissionShape();
  private beamMaskHeld = 0;
  private beamSeedHeld = 0;
  /**
   * **打撃ごとに生まれた膜のプール。**
   *
   * リグ（`buildUnifiedRig`）は状態を持たない純関数なので、
   * 「いつ生まれて、いつ死ぬか」はここが持つ。位置も形も素材も
   * **その打撃の seed** から決まるので、同じ音なら同じ膜が同じ順に生まれる。
   */
  private readonly eventMembranes: {
    readonly seed: number;
    readonly slot: number;
    readonly strength: number;
    readonly band: string;
    readonly delay: number;
    readonly life: number;
    age: number;
  }[] = [];

  /** 破片 1 枚ごとの時間の形（死んでも尾のあいだは残す）。 */
  private readonly fragmentShapes = new Map<
    number,
    { spawn: FragmentSpawn; emission: EmissionShape; alive: boolean; age: number }
  >();

  private drive: UnifiedDrive = SILENT_DRIVE;
  private layers: readonly UnifiedLayer[] = [];
  /** 上限で切る前の枚数（検証用）。 */
  private rigLayers = 0;
  private context: CompositionContext | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private geometry: THREE.InstancedBufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  private placeholder: THREE.DataTexture | null = null;
  private atlas: PrismAtlas | null = null;
  private maskAtlas: PolygonAtlas | null = null;
  private pipeline: EffectPipeline | null = null;
  /**
   * **内部ブルームと露出（`Core bloom` 軸）。**
   * 表現の中で完結しており、外側の Effect チェーンは「ブルーム済みの板」を入口にする。
   * 他の表現には一切触れない。
   */
  private bloomComposer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private displayScene: THREE.Scene | null = null;
  private displayCamera: THREE.OrthographicCamera | null = null;
  private displayGeometry: THREE.PlaneGeometry | null = null;
  private displayMaterial: THREE.ShaderMaterial | null = null;
  private disposed = false;

  // ---- インスタンス属性 ----
  private readonly offsets = new Float32Array(LIMITS.maximumLayers * 3);
  private readonly sizes = new Float32Array(LIMITS.maximumLayers * 4);
  /** [面内回転, 傾き X, 傾き Y, 多角形マスクの効き] */
  private readonly spins = new Float32Array(LIMITS.maximumLayers * 4);
  private readonly tones = new Float32Array(LIMITS.maximumLayers * 4);
  private readonly shapes = new Float32Array(LIMITS.maximumLayers * 4);
  private readonly axesAttr = new Float32Array(LIMITS.maximumLayers * 4);
  private readonly channels = new Float32Array(LIMITS.maximumLayers * 4);
  /** 素材の切り出し [中心 u, 中心 v, 半径 u, 半径 v]。 */
  private readonly crops = new Float32Array(LIMITS.maximumLayers * 4);
  /** 素材の向き [cos, sin, 反転 X, 反転 Y]。 */
  private readonly orients = new Float32Array(LIMITS.maximumLayers * 4);
  /** 素材の読み方 [タイル番号, 量, 素材色の残し, 予備]。 */
  private readonly textures = new Float32Array(LIMITS.maximumLayers * 4);
  /** 要素の中の色の旅（等間隔 4 点の色相と彩度）。 */
  private readonly hues = new Float32Array(LIMITS.maximumLayers * 4);
  private readonly saturations = new Float32Array(LIMITS.maximumLayers * 4);
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
      UNIFIED.fieldOfView,
      this.aspectRatio,
      LIMITS.nearPlane,
      LIMITS.farPlane,
    );
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(0, 0, -1);
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();

    // 多角形の帳面は起動時に一度だけ焼く（決定論。毎フレームの費用はゼロ）。
    this.maskAtlas = createPolygonAtlas(LIMITS.maskAtlas);
    this.placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.placeholder.colorSpace = THREE.SRGBColorSpace;
    this.placeholder.needsUpdate = true;

    this.audioDrive.reset();
    this.audioDrive.setStrobe(true, tickRateOf(this.axes));
    this.previousElapsed = -1;
    this.shelf = getSourceShelf(context.audioEngine);
    this.audioDrive.setShelf(this.shelf);
    this.lookResolver.declare([...UNIFIED_LOOK_PARAMS, ...MASTER_LOOK_PARAMS]);
    this.lookResolver.setSources(this.shelf.list());
    this.lookResolver.reset();
    for (const decl of UNIFIED_LOOK_PARAMS) {
      this.lookResolver.setBase(decl.id, this.axes[decl.id as keyof UnifiedAxes]);
    }
    this.syncMasterBases();

    this.applyStickiness();
    this.applyDensity();
    this.audioDrive.setTraceAmount(this.axes.trace);
    this.resetShapes();
    this.buildMesh();
    this.rebuild();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    if (this.mesh) this.scene.add(this.mesh);

    // ---- 内部ブルーム（Spatial / Reactive と同じ構成）----
    const size = new THREE.Vector2();
    context.renderer.getSize(size);
    this.bloomComposer = new EffectComposer(context.renderer);
    // 画面には出さない。結果は readBuffer に残し、表示用の板が読み取る。
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(size.x, 1), Math.max(size.y, 1)),
      0,
      UNIFIED.bloom.radius,
      UNIFIED.bloom.threshold,
    );
    // 軸 0 では 5 段のぼかしを 1 枚も走らせない（寄与が 0 なので費用だけが残る）。
    this.bloomPass.enabled = false;
    this.bloomComposer.addPass(this.bloomPass);

    // ---- 表示用の板（露出だけを掛ける）----
    this.displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.displayCamera.position.z = 1;
    this.displayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: UNIFIED.bloom.exposureAtOne },
        // **軸 0 では素通し。** 混合係数なので、途中の値も実在する。
        uTone: { value: 0 },
      },
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
        uniform float uTone;
        varying vec2 vUv;

        void main() {
          vec3 colour = max(texture2D(tDiffuse, vUv).rgb, 0.0);
          // 露出つきの指数トーンマップ。x = 0 なら必ず 0 なので、
          // 無音の黒が浮くことはない。軸 0 では素通しへ連続に戻る。
          vec3 mapped = vec3(1.0) - exp(-colour * uExposure);
          gl_FragColor = vec4(mix(colour, mapped, clamp(uTone, 0.0, 1.0)), 1.0);
        }
      `,
    });
    this.displayGeometry = new THREE.PlaneGeometry(2, 2);
    this.displayScene = new THREE.Scene();
    this.displayScene.background = new THREE.Color(0x000000);
    this.displayScene.add(new THREE.Mesh(this.displayGeometry, this.displayMaterial));

    // Effect チェーンは「ブルーム済みの板」を入口にする。外側の構成は変えない。
    this.pipeline = new EffectPipeline(
      context.renderer,
      this.displayScene,
      this.displayCamera,
      this.effects,
    );

    void loadPrismAtlas(LIMITS.atlas).then((atlas) => {
      if (!atlas) return;
      if (this.disposed) {
        atlas.texture.dispose();
        return;
      }
      this.atlas = atlas;
      if (this.material) {
        this.material.uniforms.uAtlas!.value = atlas.texture;
        this.material.uniforms.uGrid!.value.set(atlas.columns, atlas.rows);
        this.material.uniforms.uHasAtlas!.value = 1;
      }
      this.writeLayers();
    });
  }

  /**
   * **音の状態を統合の駆動へ写す。**
   *
   * 生成核（検出・結線・痕跡場）は 3 表現と共有だが、**時間の形はここで作る**。
   * `Attack` / `Decay` は素の held 値を追うエンベロープの時定数、
   * `Strobe` はティックへのラッチ量（ここ）と off ティックの消灯深さ（層ごと・リグ側）
   * という**連続な係数**として掛かる（`unifiedTime.ts`）。門の入り切りではない。
   */
  /**
   * **結線を通した軸の値。** 繋いでいなければ基準値（スライダー）そのもの。
   * 変調は「基準値 ± 深さ」なので、繋いだ瞬間に見え方が飛ばない。
   */
  private lookValue(key: string): number {
    const binding = this.lookResolver.getBinding(key);
    if (!binding || !binding.sourceId) return this.axes[key as keyof UnifiedAxes];
    return clamp(this.lookResolver.valueOf(key), 0, 1);
  }

  /**
   * **描画が実際に使う軸。** 結線した軸とマスターだけが基準値から動く。
   *
   * マスターは**この写しの上へ**書く（`this.axes` は触らない）ので、
   * 音が揺らしてもユーザーのスライダー位置は失われない ＝ 結線の契約
   *「基準値 ± 変調」がマスターでもそのまま成り立つ。
   */
  private effectiveAxes(): UnifiedAxes {
    const out = { ...this.axes };
    for (const decl of UNIFIED_LOOK_PARAMS) {
      out[decl.id as keyof UnifiedAxes] = this.lookValue(decl.id);
    }
    for (const decl of MASTER_LOOK_PARAMS) {
      const binding = this.lookResolver.getBinding(decl.id);
      if (!binding || !binding.sourceId) continue;
      const value = clamp(this.lookResolver.valueOf(decl.id), 0, 1);
      Object.assign(out, this.masterPatch(decl.id, value, out));
    }
    return out;
  }

  /**
   * **マスターの基準値をスライダーの側から取り直す。**
   * マスターは状態を持たないので、基準値は毎フレーム配下から逆算する
   *（詳細を直接動かしたときも、結線の中心がそこへ付いてくる）。
   */
  private syncMasterBases(): void {
    for (const decl of MASTER_LOOK_PARAMS) {
      this.lookResolver.setBase(decl.id, this.readMaster(decl.id, this.axes));
    }
  }

  /** マスター 1 本の位置を軸から逆算する。 */
  private readMaster(id: string, axes: UnifiedAxes): number {
    if (id === 'spread') return readSpread(axes);
    if (id === 'aspect') return readAspect(axes);
    const master = AXIS_MASTERS.find((entry) => entry.id === id);
    return master ? readMaster(master, axes) : 0;
  }

  private advanceDrive(elapsed: number, delta: number): void {
    const raw = this.audioDrive.sustained();
    // **結線を通した値で回す。** 繋いでいなければ基準値そのものなので、
    // 既定では `this.axes` を読んでいたときと 1 ビットも変わらない。
    const { attack, decay, strobe, stagger } = this.look;
    const tick = raw.tick;
    /**
     * **二重の時間軸。** 種別ごとに「どれだけ遅れて開くか」と「どれだけ長く残るか」を
     * `Stagger` 軸から引く。0 なら遅れ 0・倍率 1 なので、従来と 1 画素も変わらない。
     * 遅れは短い遅延線に素の駆動を貯めて、その種別の時刻を読むだけで作る。
     */
    const lag = (kind: UnifiedKind): { delay: number; decayScale: number } =>
      staggerOf(stagger, kind);

    // ---- 場: 種別ごとに遅れと尾の長さが違う（速い光が先・遅い膜が後）----
    this.fieldLine.push(elapsed, raw.field);
    const fieldLevels = {} as Record<UnifiedKind, number>;
    for (const kind of FIELD_KINDS) {
      const { delay, decayScale } = lag(kind);
      const shape = this.fieldShapes[kind];
      shape.advance(this.fieldLine.read(elapsed - delay), delta, tick, attack, decay, decayScale);
      const level = Math.min(shape.read(strobe) * UNIFIED.fieldGain, 1);
      // **無音 = 黒。** 平滑は 0 へ漸近するだけなので、下限を切って 1 枚も出さない。
      fieldLevels[kind] = level < UNIFIED.fieldFloor ? 0 : level;
    }

    // ---- 核: 生きているあいだの形状族を覚えておき、尾のあいだも同じ形で消える ----
    if (raw.coreAlive) this.coreLight.hold = raw.coreShape;
    const coreLag = lag('core');
    this.coreLine.push(elapsed, raw.coreAlive ? raw.corePulse : 0);
    this.coreLight.emission.advance(
      this.coreLine.read(elapsed - coreLag.delay),
      delta,
      tick,
      attack,
      decay,
      coreLag.decayScale,
    );
    const corePulse = this.coreLight.emission.read(strobe);

    // ---- 同時に光る追加のコア（`Band unison` 軸 0 では 1 個も来ない）----
    for (const entry of this.companionCores.values()) entry.alive = false;
    for (const live of raw.companions) {
      /**
       * **枠は帯域ごとに 1 つ。** 主コアが 1 スロットしか持たない（新しい打撃が
       * 前の打撃を上書きする）のと同じ規律にしてある。seed で持つと尾が溜まって
       * 「同時に 9 個」になり、**同時発光ではなく残像の山**になってしまう。
       */
      let entry = this.companionCores.get(live.band);
      if (!entry) {
        if (this.companionCores.size >= UNISON.poolMaximum) continue;
        entry = {
          band: live.band,
          seed: live.seed,
          pulse: live.pulse,
          emission: new EmissionShape(),
          alive: true,
        };
        this.companionCores.set(live.band, entry);
      }
      entry.band = live.band;
      entry.seed = live.seed;
      entry.pulse = live.pulse;
      entry.alive = true;
      entry.emission.advance(live.pulse, delta, tick, attack, decay, coreLag.decayScale);
    }
    const cores: UnifiedDrive['cores'][number][] = [];
    for (const [key, entry] of this.companionCores) {
      // 死んだ追加コアも、尾を引いているあいだは主コアと同じ時定数で消えていく。
      if (!entry.alive) {
        entry.emission.advance(0, delta, tick, attack, decay, coreLag.decayScale);
        if (entry.emission.level <= 0) {
          this.companionCores.delete(key);
          continue;
        }
      }
      const gain = entry.emission.read(strobe);
      if (gain <= 0) continue;
      cores.push({ seed: entry.seed, band: entry.band, pulse: gain });
    }

    // ---- 扇 ----
    if (raw.fanAlive) this.fanLight.hold = raw.fanSeed;
    const fanLag = lag('fan');
    this.fanLine.push(elapsed, raw.fanAlive ? raw.fanPower : 0);
    this.fanLight.emission.advance(
      this.fanLine.read(elapsed - fanLag.delay),
      delta,
      tick,
      attack,
      decay,
      fanLag.decayScale,
    );
    const fanPower = this.fanLight.emission.read(strobe);

    // ---- 光条の閃光 ----
    if (raw.armAlive) {
      this.beamMaskHeld = raw.armMask;
      this.beamSeedHeld = raw.armSeed;
    }
    const beamLag = lag('beam');
    this.beamLine.push(elapsed, raw.armAlive ? raw.armStrength : 0);
    this.beamShape.advance(
      this.beamLine.read(elapsed - beamLag.delay),
      delta,
      tick,
      attack,
      decay,
      beamLag.decayScale,
    );
    const beamStrength = this.beamShape.read(strobe);
    const fragmentLag = lag('fragment');

    // ---- 破片: 1 枚ずつが自分のエンベロープを持つ。**死んでも尾のあいだは残す** ----
    for (const entry of this.fragmentShapes.values()) entry.alive = false;
    for (const live of raw.fragments) {
      const key = Math.round(live.spawn.seed) * 32 + Math.round(live.spawn.slot);
      let entry = this.fragmentShapes.get(key);
      if (!entry) {
        if (this.fragmentShapes.size >= LIMITS.maximumFragmentShapes) continue;
        entry = { spawn: live.spawn, emission: new EmissionShape(), alive: true, age: 0 };
        this.fragmentShapes.set(key, entry);
      }
      entry.spawn = live.spawn;
      entry.alive = true;
      entry.age += delta;
      // 遅れて開く: 自分の歳が遅れを越えるまでは目標 0（＝まだ点かない）。
      entry.emission.advance(
        entry.age >= fragmentLag.delay ? 1 : 0,
        delta,
        tick,
        attack,
        decay,
        fragmentLag.decayScale,
      );
    }
    // 生きているものを先に置く。**尾を引いている破片が枠を占めて新しい破片を
    // 締め出さない**ようにするためで、どちらの並びも誕生順（決定論）のまま。
    const fragments: UnifiedDrive['fragments'][number][] = [];
    const tails: UnifiedDrive['fragments'][number][] = [];
    for (const [key, entry] of this.fragmentShapes) {
      if (!entry.alive) {
        entry.emission.advance(0, delta, tick, attack, decay, fragmentLag.decayScale);
        if (entry.emission.level <= 0) {
          this.fragmentShapes.delete(key);
          continue;
        }
      }
      const gain = entry.emission.read(strobe);
      if (gain <= 0) continue;
      (entry.alive ? fragments : tails).push({ ...entry.spawn, gain });
    }
    for (const tail of tails) fragments.push(tail);

    this.advanceEventMembranes(delta);

    this.drive = {
      fieldLevels,
      corePulse,
      coreShape: corePulse > 0 ? this.coreLight.hold : -1,
      coreBand: raw.coreBand,
      cores,
      beamMask: beamStrength > 0 ? this.beamMaskHeld : 0,
      beamStrength,
      beamSeed: this.beamSeedHeld,
      fanPower,
      fanSeed: fanPower > 0 ? this.fanLight.hold : -1,
      fragments,
      membranes: this.eventMembraneDrive(),
      hue: this.hueOf(),
      tick,
      time: elapsed,
      seed: UNIFIED_SEED,
    };
  }

  /**
   * **色相。** `hueStickiness` が 0 なら音色をそのまま滑らかに追い、
   * 1 なら 8 つの離散状態に留まる。**同じ道の上を混ぜる**ので、
   * 途中は「少しだけ段のある滑らかさ」になる（切替ではない）。
   * 円周上の最短路で混ぜるので、0 と 1 の境目でも跳ばない。
   */
  /**
   * **打撃ごとの膜を生み、歳を取らせ、死んだものを捨てる。**
   *
   * 生成核が「このフレームで発火した打撃」を読み出し窓として出しているので、
   * ここはそれを数えるだけ。枚数は打撃の強さと `Density` 軸、
   * 寿命は `Decay` 軸が決める。位置も形も**その打撃の seed** から決まるので決定論。
   */
  private advanceEventMembranes(delta: number): void {
    const amount = clamp(this.look.eventMembrane, 0, 1);
    for (let index = this.eventMembranes.length - 1; index >= 0; index--) {
      const entry = this.eventMembranes[index]!;
      entry.age += delta;
      if (entry.age >= entry.delay + entry.life) this.eventMembranes.splice(index, 1);
    }
    // 軸が 0 のあいだは 1 枚も抱えない（無音 = 黒と同じで、状態も持たない）。
    if (amount <= 0) {
      this.eventMembranes.length = 0;
      return;
    }
    const density = clamp(this.look.density, 0, 1);
    const decay = clamp(this.look.decay, 0, 1);
    // **重なりの上限（`Isolation` 軸）。** どちらも軸 0 では 1 倍。
    const isolate = clamp(this.look.isolation, 0, 1);
    const thin = 1 + (EVENT_MEMBRANE.countAtIsolated - 1) * isolate;
    const pool = Math.max(
      1,
      Math.round(EVENT_MEMBRANE.poolMaximum * (1 + (EVENT_MEMBRANE.poolAtIsolated - 1) * isolate)),
    );
    // 膜は「後から開いて長く残る」側。`Stagger` 軸 0 では遅れず、寿命の倍率も 1。
    const { delay: lagScale, decayScale } = staggerOf(this.look.stagger, 'membrane');
    const spread = TIME.stagger.delay.membrane! > 0 ? lagScale / TIME.stagger.delay.membrane! : 0;
    for (const strike of this.audioDrive.strikes()) {
      const strength = clamp(strike.strength, 0, 1);
      /**
       * 枚数に下限は置かない。**置くと軸をどれだけ絞っても打撃ごとに 1 枚生まれ**、
       * 0 側で「固定の膜だけ」に戻らなくなる。連続性は明るさの配分（`eventShare`）が持つ。
       */
      const wanted = Math.round(
        (EVENT_MEMBRANE.countAtWeakStrike +
          (EVENT_MEMBRANE.countAtStrongStrike - EVENT_MEMBRANE.countAtWeakStrike) * strength) *
          (DENSITY.min + density * (DENSITY.max - DENSITY.min)) *
          amount *
          thin,
      );
      for (let slot = 0; slot < wanted; slot++) {
        if (this.eventMembranes.length >= pool) break;
        const h = (salt: number): number => hash01(strike.seed + 8093, slot * 11 + salt);
        this.eventMembranes.push({
          seed: strike.seed,
          slot,
          strength,
          band: strike.band,
          delay:
            (EVENT_MEMBRANE.delayMinimum +
              h(1) * (EVENT_MEMBRANE.delayMaximum - EVENT_MEMBRANE.delayMinimum)) *
            spread,
          life:
            (EVENT_MEMBRANE.lifeAtShortDecay +
              decay * (EVENT_MEMBRANE.lifeAtLongDecay - EVENT_MEMBRANE.lifeAtShortDecay)) *
            (EVENT_MEMBRANE.lifeSpreadMinimum +
              h(2) * (EVENT_MEMBRANE.lifeSpreadMaximum - EVENT_MEMBRANE.lifeSpreadMinimum)) *
            decayScale,
          age: 0,
        });
      }
    }
  }

  /**
   * 生きている膜の**いまの明るさ**。遅れて開き、少し保ち、寿命の終わりで 0 へ戻る。
   * `Attack` 軸が開き方の速さを決める（0 で即座に開く）。
   */
  private eventMembraneDrive(): UnifiedDrive['membranes'] {
    const attack = clamp(this.look.attack, 0, 1);
    const rise =
      EVENT_MEMBRANE.attackFractionAtSharp +
      attack * (EVENT_MEMBRANE.attackFractionAtSlow - EVENT_MEMBRANE.attackFractionAtSharp);
    const out: UnifiedDrive['membranes'][number][] = [];
    for (const entry of this.eventMembranes) {
      const t = (entry.age - entry.delay) / Math.max(entry.life, 1e-4);
      if (t <= 0) continue;
      const gain =
        smoothstep(0, rise, t) * (1 - smoothstep(EVENT_MEMBRANE.holdFraction, 1, t));
      if (gain <= 0) continue;
      out.push({
        seed: entry.seed,
        slot: entry.slot,
        strength: entry.strength,
        band: entry.band,
        gain,
      });
    }
    return out;
  }

  /** `Density` 軸を生成核へ渡す（1 バーストの枚数・同時数・打撃の間隔）。 */
  private applyDensity(): void {
    const density = this.look.density;
    this.audioDrive.setDensity(DENSITY.min + clamp(density, 0, 1) * (DENSITY.max - DENSITY.min));
  }

  /**
   * `Band unison` 軸を検出器へ渡す。**軸 0 では敷居 1.0 ＝ 最強の 1 帯域だけ**なので、
   * 検出器のイベント列も追加コアも従来と 1 ビットも変わらない。
   */
  private applyUnison(): void {
    const unison = clamp(this.look.bandUnison, 0, 1);
    this.audioDrive.setBandFloor(1 - unison * (1 - UNISON.floorAtOne));
  }

  private applyStickiness(): void {
    const sticky = clamp(this.axes.hueStickiness, 0, 1);
    // 粘りが強いほど「色の回」が長くなる。確認時間も一緒に伸びる。
    this.audioDrive.setHueConfirm(HUE.confirmMin + sticky * (HUE.confirmMax - HUE.confirmMin));
    this.audioDrive.setHueHold(HUE.holdMin + sticky * (HUE.holdMax - HUE.holdMin));
  }

  private hueOf(): number {
    const sticky = clamp(this.look.hueStickiness, 0, 1);
    const smooth = hueOfPhase(this.audioDrive.levels().timbre);
    const state = this.audioDrive.huePhase();
    let delta = state - smooth;
    delta -= Math.round(delta);
    return ((smooth + delta * sticky) % 1 + 1) % 1;
  }

  /** 時間の形を初期化する。前の曲の尾を持ち越さない。 */
  private resetShapes(): void {
    for (const shape of Object.values(this.fieldShapes)) shape.reset();
    this.fieldLine.reset();
    this.coreLine.reset();
    this.fanLine.reset();
    this.beamLine.reset();
    this.coreLight.emission.reset();
    this.coreLight.hold = -1;
    this.companionCores.clear();
    this.fanLight.emission.reset();
    this.fanLight.hold = -1;
    this.beamShape.reset();
    this.fragmentShapes.clear();
    this.eventMembranes.length = 0;
    this.beamMaskHeld = 0;
    this.beamSeedHeld = 0;
    this.drive = SILENT_DRIVE;
  }

  private rebuild(): void {
    // 設定や preset から呼ばれたときのために、ここでも写しを取り直す。
    // フレームの中では `update()` が先に取っているので、同じ値をもう一度作るだけ。
    this.look = this.effectiveAxes();
    const rig = buildUnifiedRig(this.drive, this.look, {
      aspectRatio: this.aspectRatio,
    });
    this.rigLayers = rig.length;
    this.layers = capUnifiedRig(rig, LIMITS.maximumLayers);
    this.writeLayers();
  }

  /** **1 ドローで全層を描く板。** */
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
    add('aSize', this.sizes, 4);
    add('aSpin', this.spins, 4);
    add('aTone', this.tones, 4);
    add('aShape', this.shapes, 4);
    add('aAxis', this.axesAttr, 4);
    add('aChannel', this.channels, 4);
    add('aCrop', this.crops, 4);
    add('aOrient', this.orients, 4);
    add('aTexture', this.textures, 4);
    add('aHues', this.hues, 4);
    add('aSaturations', this.saturations, 4);
    geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.placeholder },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uIntensity: { value: 1.6 },
        uOffset: { value: 0.03 },
        uDecorrelation: { value: 0.25 },
        uTint: { value: UNIFIED.tintDepth },
        // 彩度の並びは既にこの高さを掛けてあるので、割り戻して二重掛けを避ける。
        uTintBase: { value: UNIFIED.tintDepth },
        uChannelGain: { value: new THREE.Vector3(1, 1, 1) },
        // [黒浮きの敷居, 同・幅, 輝度の曲げ, マスの内側へ寄せる余白]
        uGrain: {
          value: new THREE.Vector4(
            UNIFIED.grain.blackFloor,
            UNIFIED.grain.blackFloorWidth,
            UNIFIED.grain.gamma,
            UNIFIED.grain.inset,
          ),
        },
        uGrainGain: { value: UNIFIED.grain.gain },
        // [核へ足す素材の量, 楕円窓の始まり, 同・終わり]
        uCoreMaterial: {
          value: new THREE.Vector3(
            UNIFIED.coreMaterialGain,
            UNIFIED.coreWindow.start,
            UNIFIED.coreWindow.end,
          ),
        },
        /**
         * **核へ足す素材の期待値（明るさの中立化）。**
         * 核だけは素材を加算するので、`Texture grain` を上げると核の光量が増える。
         * 加算のぶんだけ土台を割り戻して、軸が明るさではなく**質感**だけを変えるようにする。
         */
        uCoreGrainNeutral: { value: UNIFIED.neutral.coreGrainMean },
        // アトラスが届くまでは 0。**素材が無い間は手続きの形だけで描く**
        //（1x1 の黒を掛けて画面が消えないようにするため）。
        uHasAtlas: { value: 0 },
        uMask: { value: this.maskAtlas?.texture ?? this.placeholder },
        uMaskGrid: {
          value: new THREE.Vector2(this.maskAtlas?.columns ?? 1, this.maskAtlas?.rows ?? 1),
        },
        uMaskSoftness: { value: LIMITS.maskSoftness },
        /**
         * **縁の締まり。** どちらも 0 で厳密に現状（すべての式が 1 倍 / 恒等）へ戻る。
         * `uEdgeContrast` は破片・膜・光条・扇・素材・多角形マスクの縁に、
         * `uCoreFocus` は核の裾だけに効く。
         */
        uEdgeContrast: { value: 0 },
        uCoreFocus: { value: 0 },
        // 破片の型抜きの強さ。0 で手続きの形、1 で素材の輝度が外形になる。
        uFragmentCarve: { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec4 aSize;
        attribute vec4 aSpin;
        attribute vec4 aTone;
        attribute vec4 aShape;
        attribute vec4 aAxis;
        attribute vec4 aChannel;
        attribute vec4 aCrop;
        attribute vec4 aOrient;
        attribute vec4 aTexture;
        attribute vec4 aHues;
        attribute vec4 aSaturations;
        varying vec2 vUv;
        varying vec4 vTone;
        varying vec4 vShape;
        varying vec4 vAxis;
        varying vec4 vChannel;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying vec4 vTexture;
        varying vec4 vHues;
        varying vec4 vSaturations;
        varying float vMask;
        varying float vEdge;
        varying float vHalo;
        varying float vPad;

        void main() {
          vUv = uv;
          vCrop = aCrop;
          vOrient = aOrient;
          vTexture = aTexture;
          vMask = aSpin.w;
          vHues = aHues;
          vSaturations = aSaturations;
          vTone = aTone;
          vShape = aShape;
          vAxis = aAxis;
          vChannel = aChannel;
          vEdge = aSize.z;
          vHalo = aSize.w;
          vPad = max(aAxis.z, 1.0);

          vec3 local = vec3(position.xy * aSize.xy, 0.0);
          // 面内回転
          float c = cos(aSpin.x);
          float s = sin(aSpin.x);
          local.xy = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
          // 傾き（Tilt 軸が 0 なら両方 0 = 正面のまま）
          float cx = cos(aSpin.y);
          float sx = sin(aSpin.y);
          local.yz = vec2(local.y * cx - local.z * sx, local.y * sx + local.z * cx);
          float cy = cos(aSpin.z);
          float sy = sin(aSpin.z);
          local.xz = vec2(local.x * cy + local.z * sy, -local.x * sy + local.z * cy);

          gl_Position = projectionMatrix * modelViewMatrix * vec4(local + aOffset, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec2 uGrid;
        uniform float uIntensity;
        uniform float uOffset;
        uniform float uDecorrelation;
        uniform float uTint;
        uniform float uTintBase;
        uniform vec3 uChannelGain;
        uniform vec4 uGrain;
        uniform float uGrainGain;
        uniform vec3 uCoreMaterial;
        uniform float uCoreGrainNeutral;
        uniform float uHasAtlas;
        uniform sampler2D uMask;
        uniform vec2 uMaskGrid;
        uniform float uMaskSoftness;
        uniform float uEdgeContrast;
        uniform float uCoreFocus;
        uniform float uFragmentCarve;
        varying vec2 vUv;
        varying vec4 vTone;
        varying vec4 vShape;
        varying vec4 vAxis;
        varying vec4 vChannel;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying vec4 vTexture;
        varying vec4 vHues;
        varying vec4 vSaturations;
        varying float vMask;
        varying float vEdge;
        varying float vHalo;
        varying float vPad;

        /**
         * **板の縁が絵に出ないための余白。** ここから外側は必ず 0 へ落とす。
         * 0.86 は「余白の内側 14% を使って落とす」という意味で、
         * 落とし方が滑らかなので直線の段にはならない。
         */
        const float FRAME_START = 0.86;

        const float TAU = 6.28318530718;
        const float LN2 = 0.69314718;

        /**
         * **縁の締まりの実寸**（UNIFIED.definition）。質感の数値はコードへ直接書かず、
         * ここでも tuning 側の 1 か所から流し込む。どれも「軸 1 のときの倍率」で、
         * 軸 0 では mix(1.0, X, 0.0) = 1.0 なので恒等式に戻る。
         */
        const float EDGE_WIDTH_AT_ONE = ${UNIFIED.definition.edgeWidthAtOne.toFixed(4)};
        const float KIND_HALO_AT_ONE = ${UNIFIED.definition.kindHaloAtOne.toFixed(4)};
        const float HALO_TIGHTEN_AT_ONE = ${UNIFIED.definition.haloTightenAtOne.toFixed(4)};
        const float GRAIN_GAMMA_AT_ONE = ${UNIFIED.definition.grainGammaAtOne.toFixed(4)};
        const float GRAIN_GAIN_AT_ONE = ${UNIFIED.definition.grainGainAtOne.toFixed(4)};
        const float MASK_SOFTNESS_AT_ONE = ${UNIFIED.definition.maskSoftnessAtOne.toFixed(4)};
        const float CORE_SUPER_GAUSS_AT_ONE = ${UNIFIED.definition.coreSuperGaussAtOne.toFixed(4)};
        const float CORE_FLAKE_TIGHTEN_AT_ONE = ${UNIFIED.definition.coreFlakeTightenAtOne.toFixed(4)};
        const float EDGE_GAIN_AT_ONE = ${UNIFIED.definition.edgeGainAtOne.toFixed(4)};
        const float CORE_FOCUS_GAIN_AT_ONE = ${UNIFIED.definition.coreFocusGainAtOne.toFixed(4)};

        /** **素材の膜**（Spatial のマクロ膜からそのまま移した実寸）。 */
        const float SHEET_VIGNETTE = ${UNIFIED.sheet.vignetteStart.toFixed(4)};
        const float SHEET_FLOOR = ${UNIFIED.sheet.blackFloor.toFixed(4)};
        const float SHEET_FLOOR_WIDTH = ${UNIFIED.sheet.blackFloorWidth.toFixed(4)};
        const float SHEET_GAMMA = ${UNIFIED.sheet.gamma.toFixed(4)};
        const float SHEET_INSET = ${UNIFIED.sheet.cellInset.toFixed(4)};

        vec3 spectrum(float h) {
          vec3 phase = vec3(0.0, 2.0943951, 4.1887902);
          return clamp(0.5 + 0.5 * cos(TAU * h + phase), 0.0, 1.0);
        }

        /**
         * **等間隔 4 点の折れ線。** Hue depth 軸 0 では 4 点が直線上に並ぶので、
         * これは 1 本の直線に戻る（＝従来の 1 段の走りとまったく同じ）。
         */
        float ramp4(vec4 stops, float t) {
          float u = clamp(t, 0.0, 1.0) * 3.0;
          return mix(
            mix(mix(stops.x, stops.y, clamp(u, 0.0, 1.0)), stops.z, clamp(u - 1.0, 0.0, 1.0)),
            stops.w,
            clamp(u - 2.0, 0.0, 1.0)
          );
        }

        float gradientAt(vec2 p, float form) {
          if (form < 0.5) return p.x * 0.5 + 0.5;
          if (form < 1.5) return clamp(length(p), 0.0, 1.0);
          if (form < 2.5) return p.y * 0.5 + 0.5;
          return atan(p.y, p.x) / TAU + 0.5;
        }

        /** 核の緩い楕円窓。板の縁より内側で 0 になるので、四角い枠が出ない。 */
        float coreWindow(vec2 p) {
          return 1.0 - smoothstep(uCoreMaterial.y, uCoreMaterial.z, length(p));
        }

        /**
         * **縁の柔らかさ。** Blur 軸が 0 なら鋭く、1 なら広くにじむ。
         * Edge contrast は**その窓幅そのものを詰める**ので、Blur を動かさずに
         * 「にじんだ光のまま縁だけ硬い」まで行ける。軸 0 では厳密に従来の幅。
         */
        float softEdge(float d, float width) {
          float w = mix(0.008, 0.16, clamp(vEdge, 0.0, 1.0)) * mix(1.0, EDGE_WIDTH_AT_ONE, uEdgeContrast) + width;
          return 1.0 - smoothstep(-w, w, d);
        }

        /** 要素ごとの形。**分岐は種別だけで、軸は係数として入っている。** */
        float baseMask(vec2 p) {
          float kind = vTone.z;
          // 種別ごとの局所ハロ（膜の帯・光条の芯が裾として使う）。
          float halo = mix(0.04, 0.4, clamp(vEdge, 0.0, 1.0)) * mix(1.0, KIND_HALO_AT_ONE, uEdgeContrast);

          // ---- 扇 ----
          if (kind > 4.5) {
            float r = length(p);
            if (r < 1e-4) return 0.0;
            float delta = atan(p.y, p.x) - vShape.x;
            delta = atan(sin(delta), cos(delta));
            float sector = exp(-pow(delta / max(vShape.y, 1e-3), 4.0));
            if (sector <= 0.002) return 0.0;
            float blades = pow(abs(cos(delta * vShape.z)), mix(15.0, 5.0, vEdge) * mix(1.0, 2.2, uEdgeContrast));
            float radial = smoothstep(0.05, 0.3, r) * exp(-pow(r / max(vShape.w, 1e-3), 2.0));
            return sector * blades * radial;
          }

          // ---- 破片 ----
          if (kind > 3.5) {
            float family = vShape.y;
            vec2 q = vec2(p.x / max(vShape.z, 0.15), p.y * max(vShape.z, 0.15));
            float d;
            if (family < 0.5) {
              d = max(max(dot(q, vec2(0.0, -1.0)), dot(q, vec2(0.8660254, 0.5))),
                      dot(q, vec2(-0.8660254, 0.5))) - 0.55;
            } else if (family < 1.5) {
              d = max(abs(q.x) - 0.72, abs(q.y) - 0.34);
            } else if (family < 2.5) {
              d = max(max(dot(q, vec2(0.9487, 0.3162)), dot(q, vec2(-0.8575, 0.5145))),
                      dot(q, vec2(0.0, -0.95))) - 0.5;
            } else {
              d = max(max(dot(q, vec2(0.0, -1.0)), dot(q, vec2(0.8660254, 0.5))),
                      dot(q, vec2(-0.8660254, 0.5))) - 0.55 + vShape.w;
            }
            float shard = softEdge(d, vShape.x * 0.1);
            float character = clamp(vAxis.w, 0.0, 1.0);
            /**
             * **型抜きをやめる側（Fragment carve）。**
             * 上の 4 族も羽毛も「こちらが決めた形」で、素材はそれで削られている。
             * 1 側ではその形を**緩いビネットだけ**へ溶かし、外形を素材へ明け渡す
             *（素材の掛け算は main 側で全量へ切り替わる）。ビネットは板の四角さを
             * 隠すだけで形は作らないので、素材の膜と同じものを使う。
             * 0 では mix(x, y, 0.0) = x なので手続きの形が厳密にそのまま残る。
             */
            float carve = clamp(uFragmentCarve, 0.0, 1.0);
            float open = 1.0 - smoothstep(SHEET_VIGNETTE, 1.0, length(p));
            if (character <= 0.0) return mix(shard, open, carve);
            /**
             * **引っ掻き傷（羽毛・筋）。**
             * 芯は細く長く、伸びる向きに沿って羽毛のような濃淡が走る。
             * 端は必ず 0 へ落ちる（板の縁とは無関係に、形そのものが閉じている）。
             */
            vec2 f = vec2(p.x, p.y * mix(1.0, 3.2, character));
            float spine = exp(-abs(f.y) * mix(5.0, 2.0, vEdge) * mix(1.0, 2.8, uEdgeContrast));
            float along = 1.0 - smoothstep(mix(0.12, 0.55, uEdgeContrast), 0.96, abs(f.x));
            /**
             * **羽毛の濃淡の谷を深くする。** 0.45 の底は「筋のあいだも半分は光る」
             * ということで、引っ掻き傷が地と分かれない主因だった。底を下げつつ
             * 山は 1 のまま（floor + (1 − floor)·|sin|）なので、明るさの頭は動かない。
             */
            float barbFloor = mix(0.45, 0.12, uEdgeContrast);
            float barbs = barbFloor + (1.0 - barbFloor) * abs(sin(f.x * 7.0 + f.y * 3.0 + vShape.y));
            float taper = 1.0 - smoothstep(0.0, 1.5, abs(f.y) * (0.35 + abs(f.x)));
            float filament = spine * along * barbs * max(taper, 0.0);
            return mix(mix(shard, filament, character), open, carve);
          }

          // ---- 靄 ----
          if (kind > 2.5) {
            float r = length(p);
            float body = exp(-vShape.x * r * r);
            float window = 1.0 - smoothstep(vShape.y, vShape.z, r);
            return window * body;
          }

          // ---- 膜 ----
          if (kind > 1.5) {
            float folds = 0.5 + 0.5 * sin(p.x * vShape.y + p.y * vShape.w * 2.0);
            // 帯の内側の平らな部分を広げ、落ちるところで落とす（幅は変えない）。
            float band = 1.0 - smoothstep(vShape.z * mix(0.6, 0.9, uEdgeContrast), vShape.z * 1.6 + halo, abs(p.y));
            float ends = 1.0 - smoothstep(mix(0.72, 0.91, uEdgeContrast), 1.0, abs(p.x));
            // 襞の谷を深くする。山は 1 のままなので明るさの頭は動かない。
            return band * ends * mix(mix(0.55, 0.16, uEdgeContrast), 1.0, folds);
          }

          // ---- 光条 ----
          if (kind > 0.5) {
            float core = 1.0 - smoothstep(vShape.x * mix(0.4, 0.85, uEdgeContrast), vShape.x + halo, abs(p.y));
            // 芯の外へ広がる裾。締めると線が「太い光」から「細い筋」になる。
            float glow = exp(-abs(p.y) / max(vShape.y + halo, 1e-3) * mix(1.0, 2.6, uEdgeContrast)) *
                         mix(0.5, 0.22, uEdgeContrast);
            float along = 1.0 - smoothstep(vShape.z, vShape.w, abs(p.x));
            /**
             * **片側化と根元のフェード。**
             * 打撃の閃光を両側に描くと、4 本が中心で重なって**点が 4 重に加算**され、
             * 「面」ではなく「点」が強調される。片側だけへ伸ばし、根元も芯に隠す。
             * 常設の骨格（性格 0）は十字の桁なので両側のまま。
             */
            float oneSided = clamp(vAxis.w, 0.0, 1.0);
            float root = mix(1.0, smoothstep(0.0, 0.09, p.x), oneSided);
            return (core + glow) * along * root;
          }

          // ---- 核 ----
          /**
           * **核。**
           * シャープ側（vEdge 0）は「強烈な点 + 髪の毛のように細い貫通線 +
           * わずかなフレア」、にじみ側（1）は「大きく滲んだ塊」。
           * 同じ 1 本の式で、係数だけが Blur 軸に沿って動く。
           */
          float r = length(p);
          /**
           * **頂の平らさ（超ガウス）。**
           * 指数が 1 のときは普通のガウス（＝点が光る）。1 を超えると
           * **頂が平らになり縁が急に落ちる** ＝ 面が光る見えになる。
           * 芯の白い点（下の spark）は 1 のまま残すので、面の中に芯が居る形になる。
           */
          float form = clamp(vAxis.w, 0.0, 1.0);
          float rr = max(r * r, 1e-6);
          /**
           * **Core focus: 大きさを変えずに裾だけを切る。**
           *
           * 超ガウス exp(−(r²)^n · k) の半値半径は r² = (ln2/k)^(1/n) なので、
           * n を上げるときに k = kBase · (kBase/ln2)^(n/nBase − 1) と置けば
           * **半値半径はそのまま**で、頂が平らになり裾だけが急に落ちる。
           * 軸 0 では指数が 0 ＝ pow(x, 0.0) = 1.0 なので k = kBase に厳密に戻る。
           */
          float nBase = mix(1.0, 1.9, form);
          float n = nBase + uCoreFocus * CORE_SUPER_GAUSS_AT_ONE;
          float kBase = mix(120.0, 7.0, vEdge);
          float k = kBase * pow(kBase / LN2, n / nBase - 1.0);
          float centre = exp(-pow(rr, n) * k) * vShape.w;
          // 芯の白熱。シャープ側ほど小さく強い点になる。
          float spark = exp(-r * r * mix(900.0, 40.0, vEdge)) * mix(1.4, 0.35, vEdge);
          // 貫通線。シャープ側は極細で遠くまで、にじみ側は太く短い。
          float lineH = exp(-abs(p.y) * mix(220.0, 11.0, vEdge)) *
                        (1.0 - smoothstep(mix(0.75, 0.2, vEdge), 1.0, abs(p.x))) * vShape.y;
          float lineV = exp(-abs(p.x) * mix(220.0, 11.0, vEdge)) *
                        (1.0 - smoothstep(mix(0.75, 0.2, vEdge), 1.0, abs(p.y))) * vShape.z;
          // フレア片。シャープ側では点在する小さなかけら、にじみ側では広い裾。
          float flakes = exp(-r * mix(22.0, 2.6, vEdge) * mix(1.0, CORE_FLAKE_TIGHTEN_AT_ONE, uCoreFocus)) *
                         (0.35 + 0.65 * abs(sin(atan(p.y, p.x) * 5.0 + r * 9.0))) *
                         mix(0.18, 0.45, vEdge);
          // **緩い楕円窓。** 縁を板の内側で溶かす。芯には届かない広さに取ってある。
          return (centre + spark + lineH + lineV + flakes) * coreWindow(p);
        }

        /**
         * **Blur 軸の 1 本が縁とハロを同時に動かす。**
         * ハロ量は 0 でぴったり 0 なので、シャープ側では散乱が 1 画素も足されない。
         */
        float elementMask(vec2 p) {
          float base = baseMask(p);
          if (vHalo <= 0.0) return base;
          /**
           * **丸いハロが「大きく滲んだ塊」の正体だった。**
           * 既定（Blur 0.5）では、核の半径 0.5 の位置の明るさ 0.106 のうち
           * 形そのものの寄与は 0.0007 しかなく、残りは全部このハロである。
           * 量はリグ側（haloOf）が削り、広がりはここで詰める。どちらも軸 0 で 1 倍。
           */
          float spread = mix(6.0, 1.6, clamp(vEdge, 0.0, 1.0)) *
                         mix(1.0, HALO_TIGHTEN_AT_ONE, uEdgeContrast);
          return base + vHalo * exp(-dot(p, p) * spread);
        }

        /**
         * **アトラスのマスの位置。** 行は下から数える（Canvas 由来で flipY が効く）。
         */
        vec2 atlasUvOf(vec2 cell) {
          float column = mod(vTexture.x, max(uGrid.x, 1.0));
          float row = max(uGrid.y - 1.0, 0.0) - floor(vTexture.x / max(uGrid.x, 1.0));
          return (vec2(column, row) + cell) / max(uGrid, vec2(1.0));
        }

        /**
         * **素材の膜。** Spatial Study のマクロ膜の式をそのまま移したもの。
         *
         * **輝度の源は素材ただ 1 つ**である。手続きの窓も、丸いハロも、
         * 分光のチャンネル分離も**持たない** — アトラス 10 枚はほとんどが黒なので、
         * 素材が 0 の場所は厳密に 0 になり、**見えている外形が素材の筋の形**になる。
         * ビネットは板の四角さを隠すだけで、形は作らない。
         */
        vec3 sheetColour(vec2 q) {
          float window = 1.0 - smoothstep(SHEET_VIGNETTE, 1.0, length(q));
          if (window <= 0.0) discard;

          // 回転・反転・歪み。位相は誕生時に固定なので、発光中に形はちらつかない。
          vec2 s = vec2(q.x * vOrient.x - q.y * vOrient.y, q.x * vOrient.y + q.y * vOrient.x);
          s *= vec2(vOrient.z, vOrient.w);
          s += vec2(
            sin(s.y * vShape.y + vShape.z),
            cos(s.x * vShape.y * 0.87 + vShape.z * 1.31)
          ) * vShape.x;
          // 面内のゆっくりした漂い。せん断で膜がたわみ、素材が面の中を滑る。
          s.y += s.x * vChannel.z;
          s += vChannel.xy;

          // クロップ。素材のどこを切り出すかが毎回変わる。
          vec2 cell = clamp(vCrop.xy + s * vCrop.zw, SHEET_INSET, 1.0 - SHEET_INSET);
          vec3 source = texture2D(uAtlas, atlasUvOf(cell)).rgb;
          /**
           * アトラスは sRGB として読み込むので、届く時点では線形。
           * 敷居も曲げも Spatial が**見た目の明るさ**で決めた値なので、一度戻す。
           */
          vec3 tex = pow(max(source, 0.0), vec3(0.4545));
          float luminance = dot(tex, vec3(0.2126, 0.7152, 0.0722));
          // 黒浮きを加算の前に落とす。これが無いと薄い膜が画面全体を灰色に持ち上げる。
          luminance *= smoothstep(SHEET_FLOOR, SHEET_FLOOR + SHEET_FLOOR_WIDTH, luminance);
          luminance = pow(max(luminance, 0.0), SHEET_GAMMA);

          // 色は音から。素材そのものの色みは割合で混ぜるだけ（明るさは輝度が持つ）。
          float t = gradientAt(q, vTone.w);
          vec3 tint = mix(
            vec3(1.0),
            spectrum(ramp4(vHues, t)),
            clamp(ramp4(vSaturations, t), 0.0, 1.0) * uTint / max(uTintBase, 1e-4)
          );
          vec3 sourceHue = tex / max(max(tex.r, max(tex.g, tex.b)), 1e-4);
          vec3 tone = mix(tint, sourceHue, clamp(vTexture.z, 0.0, 1.0));

          vec3 colour = tone * luminance * window * max(vAxis.x, 0.0) * uIntensity * uHasAtlas;
          // 上だけを潰すソフトニー。**1 枚では白へ行けない**（白は重なりからだけ生まれる）。
          float peak = max(colour.r, max(colour.g, colour.b));
          return colour / (1.0 + peak / max(vAxis.y, 1e-4));
        }

        void main() {
          // **板の座標**（−1〜1。縁がどこかを知っているのはこれだけ）。
          vec2 q = vUv * 2.0 - 1.0;
          /**
           * **素材の膜だけは別の式。** 他の 6 種別は「手続きで描いた形 × 素材の濃淡」で、
           * 素材は外形を作れない。ここは輝度の源が素材ただ 1 つなので、下の
           * 手続きの窓・ハロ・分光のどれも通さずに抜ける。
           */
          if (vTone.z > 5.5) {
            gl_FragColor = vec4(max(sheetColour(q), 0.0), 1.0);
            return;
          }
          // **要素の座標**。板を余白ぶん広げてあるので、要素はその内側に収まる。
          vec2 p = q * vPad;
          /**
           * **四角い枠を出さないガード。**
           * どの種別・どの軸設定でも、板の縁より内側で必ず 0 になる。
           * 円形の裾（ハロ）を四角い板で切ると縁が直線に見えるので、
           * 切るのではなく**縁へ向かって滑らかに 0 へ寄せる**。
           */
          float frame = 1.0 - smoothstep(FRAME_START, 1.0, max(abs(q.x), abs(q.y)));
          if (frame <= 0.0) discard;
          // チャンネル分離。中心からの放射方向へ 3 チャンネルをずらす。
          vec2 dir = length(p) > 1e-4 ? normalize(p) : vec2(1.0, 0.0);
          float offsetAmount = max(uOffset * vChannel.x, vChannel.z);
          float decorrelation = max(uDecorrelation * vChannel.y, vChannel.w) * 0.05;
          vec2 shift = dir * offsetAmount;
          vec3 channels = max(vec3(
            elementMask(p + shift + vec2(decorrelation, 0.0)),
            elementMask(p),
            elementMask(p - shift - vec2(decorrelation, 0.0))
          ), 0.0) * frame;
          if (channels.r + channels.g + channels.b <= 0.0) discard;

          /**
           * **素材（アトラス）。**
           * 板の座標を要素ごとの角度で回して反転し、要素ごとのクロップで切り出す。
           * 同じ素材でも切り口と向きが毎回違うので、10 枚を切り替えているようには見えない。
           * 素材は絵ではなく**輝度マスク**として読む。
           */
          float grain = clamp(vTexture.y, 0.0, 1.0) * uHasAtlas;
          vec2 tq = vec2(q.x * vOrient.x - q.y * vOrient.y, q.x * vOrient.y + q.y * vOrient.x);
          tq *= vec2(vOrient.z, vOrient.w);
          vec2 cell = clamp(vCrop.xy + tq * vCrop.zw, uGrain.w, 1.0 - uGrain.w);
          float column = mod(vTexture.x, max(uGrid.x, 1.0));
          /**
           * **行は下から数える。** アトラスは Canvas から作るので flipY が効いており、
           * テクスチャの v = 0 はキャンバスの**いちばん下の行**にあたる。
           * 上から数えると素材の割り当てが行ごと入れ替わる。
           */
          float row = max(uGrid.y - 1.0, 0.0) - floor(vTexture.x / max(uGrid.x, 1.0));
          vec3 raw = texture2D(uAtlas, (vec2(column, row) + cell) / max(uGrid, vec2(1.0))).rgb;
          /**
           * **素材を人の目の尺度へ戻す。**
           * アトラスは sRGB として読み込むので、シェーダーへ届く時点で線形になっている
           * （0.1 の階調が 0.009 まで沈む）。敷居も曲げも「見た目の明るさ」で決めたいので、
           * ここで一度 sRGB へ戻す。**戻さないと敷居がほぼ全画素を切り落として真っ黒になる。**
           */
          vec3 tex = pow(max(raw, 0.0), vec3(0.4545));
          float luminance = dot(tex, vec3(0.2126, 0.7152, 0.0722));
          // 黒浮きを加算の前に落とす。これが無いと薄い霧が画面全体を灰色に持ち上げる。
          luminance *= smoothstep(uGrain.x, uGrain.x + uGrain.y, luminance);
          /**
           * **素材のガンマ。** 既定の 0.45 は暗部を持ち上げる向きで、素材の中の
           * 筋と地の差を潰していた。Edge contrast はガンマを 1 の側へ寄せて
           * 差を開き、そのぶん暗くなる中央値を利得で返す（明るさは中立）。
           */
          float grainGamma = uGrain.z * mix(1.0, GRAIN_GAMMA_AT_ONE, uEdgeContrast);
          luminance = pow(max(luminance, 0.0), grainGamma) * uGrainGain *
                      mix(1.0, GRAIN_GAIN_AT_ONE, uEdgeContrast);
          /**
           * **核だけは素材を「足す」。**
           * 他の種別は素材で削る（乗算）が、核でそれをやると芯が痩せるだけで
           * 質感が乗らない。核では乗算を 1 に固定し、下で加算する。
           * 分岐は**種別だけ**で、軸はどちらの経路でも係数のまま。
           */
          float isCore = 1.0 - step(0.5, vTone.z);
          // 0 でぴったり 1（＝素材を 1 画素も読まない手続きの形だけ）。
          float material = mix(1.0, clamp(luminance, 0.0, 2.2), grain * (1.0 - isCore));
          /**
           * **破片の型抜きをやめる（Fragment carve）。**
           * 手続きの形はビネットへ溶けている（baseMask）ので、外形を持てるのは
           * 素材だけになる。素材の効き（Texture grain）ごと 1 へ振り切るのは、
           * 途中の grain では「削る量」が足りず外形が素材から生まれないため。
           * アトラスが無いときは 1 のまま（＝ ビネットだけの淡い光）にして、
           * 素材待ちのあいだに破片が消えないようにする。
           * 破片以外の種別には掛からず、軸 0 では mix(x, y, 0.0) = x で恒等。
           */
          float isFragment = step(3.5, vTone.z) * (1.0 - step(4.5, vTone.z));
          material = mix(
            material,
            mix(1.0, clamp(luminance, 0.0, 2.2), uHasAtlas),
            clamp(uFragmentCarve, 0.0, 1.0) * isFragment
          );

          // 色。層ごとの色相はリグが決めてある（要素ごと ⇄ 全体 1 色の混合済み）。
          float gradient = gradientAt(q, vTone.w);
          // **1 要素の中の色の旅。** 色相も彩度も 4 点の折れ線から読む。
          // 彩度 0 で白、1 で純色。白の予算はここでは動かない（天井が別に効く）。
          vec3 tint = mix(
            vec3(1.0),
            spectrum(ramp4(vHues, gradient)),
            clamp(ramp4(vSaturations, gradient), 0.0, 1.0) * uTint / max(uTintBase, 1e-4)
          );
          /**
           * **素材の色を捨てない。** 灰色にしてしまうと、羽毛状・引っ掻き傷状の
           * 見えが「明るさの揺らぎ」に痩せる。素材の色みは正規化して比率だけを取り、
           * 音から作った色と割合で混ぜる（明るさは上の輝度マスクが持つ）。
           */
          vec3 sourceHue = tex / max(max(tex.r, max(tex.g, tex.b)), 1e-4);
          tint = mix(tint, sourceHue, clamp(vTexture.z, 0.0, 1.0) * grain);

          // **チャンネルの偏り。** 最大は常に 1 なので、白の予算は動かない。
          /**
           * **多角形で外形を削る。** 板の四角い輪郭を隠しつつ、要素ごとに違う
           * 不揃いな縁を作る。帳面は符号つき距離場（0.5 がちょうど輪郭）なので、
           * どれだけ引き伸ばしても縁がぼけない。効きが 0 なら 1 画素も削らない。
           */
          vec2 maskCell = mix(vec2(0.004), vec2(0.996), clamp(q * 0.5 + 0.5, 0.0, 1.0));
          float maskColumn = mod(vTexture.w, max(uMaskGrid.x, 1.0));
          float maskRow = floor(vTexture.w / max(uMaskGrid.x, 1.0));
          float sdf = texture2D(uMask, (vec2(maskColumn, maskRow) + maskCell) / max(uMaskGrid, vec2(1.0))).r;
          // 多角形の縁も同じ 1 本で締める（0.3 の柔らかさが外形をぼかしていた）。
          float maskSoftness = max(uMaskSoftness * mix(1.0, MASK_SOFTNESS_AT_ONE, uEdgeContrast), 1e-4);
          float polygon = smoothstep(0.5 - maskSoftness, 0.5 + maskSoftness, sdf);
          float silhouette = mix(1.0, polygon, clamp(vMask, 0.0, 1.0));

          /**
           * **核の素材を明るさ中立にする。** 核だけは素材を**加算**するので、
           * Texture grain を上げると核の光量そのものが増えてしまう
           *（他の種別は乗算で、マスクの平均が 1 になるよう grain.gain が置いてある）。
           * 加算で足すぶんだけ土台を割り戻し、軸が**質感の配り方**だけを変えるようにする。
           * grain = 0 では厳密に 1 なので、素材が無いときの見え方は変わらない。
           */
          float coreNeutral =
            1.0 / (1.0 + isCore * grain * uCoreMaterial.x * uCoreGrainNeutral);

          /**
           * **縁を締めたぶんの明るさの戻し。**
           * 裾（こぼれた光）を消すと総量が落ちるので、そのぶんを利得へ返す
           * ＝ 軸が動かすのは光の**配り方**だけで、明るさは Intensity の 1 本が持つ。
           * 核の側は isCore で選ぶので、他の種別には 1 画素も掛からない。
           * どちらの軸も 0 では mix が 1.0 を返すので、厳密に恒等へ戻る。
           */
          float defGain = mix(1.0, EDGE_GAIN_AT_ONE, uEdgeContrast) *
                          mix(1.0, mix(1.0, CORE_FOCUS_GAIN_AT_ONE, isCore), uCoreFocus);

          vec3 colour = channels * uChannelGain * tint;
          colour *= uIntensity * vAxis.x * material * silhouette * coreNeutral * defGain;
          // **核へ素材を加算する。** 楕円窓の内側だけなので、板の四角さは出ない。
          colour += tint * uChannelGain * uIntensity * vAxis.x * frame * coreNeutral * defGain *
                    isCore * grain * uCoreMaterial.x * clamp(luminance, 0.0, 2.2) * coreWindow(p);
          // **白の予算。** 核以外はここで頭を押さえる。
          colour = min(colour, vec3(vAxis.y));
          gl_FragColor = vec4(colour, 1.0);
        }
      `,
    });

    this.geometry = geometry;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  /**
   * **役割の希望からタイル番号を解く。**
   *
   * アトラスは非同期に届くので、リグはタイルの中身を知らない。ここでだけ
   * manifest の役割と重みを見て、希望に合う素材を重みつきで引く。
   * 希望から外れた素材にも余地を残す（0 にすると同じ数枚しか出ない）。
   */
  private resolveTile(roles: readonly string[], pick: number): number {
    const tiles = this.atlas?.tiles;
    if (!tiles || tiles.length === 0) return 0;
    let total = 0;
    const weights = tiles.map((tile) => {
      const weight = tile.weight * (roles.includes(tile.role) ? 1 : UNIFIED.grain.offRoleWeight);
      total += weight;
      return weight;
    });
    if (total <= 0) return 0;
    let remaining = clamp(pick, 0, 1) * total;
    for (let index = 0; index < weights.length; index++) {
      remaining -= weights[index]!;
      if (remaining <= 0) return index;
    }
    return weights.length - 1;
  }

  private writeLayers(): void {
    const count = Math.min(this.layers.length, LIMITS.maximumLayers);
    for (let index = 0; index < count; index++) {
      const layer = this.layers[index]!;
      this.offsets[index * 3 + 0] = layer.position[0];
      this.offsets[index * 3 + 1] = layer.position[1];
      this.offsets[index * 3 + 2] = layer.position[2];
      // 板は余白ぶん広げる（要素の大きさはシェーダー側で割り直すので変わらない）。
      this.sizes[index * 4 + 0] = layer.half[0] * 2 * layer.pad;
      this.sizes[index * 4 + 1] = layer.half[1] * 2 * layer.pad;
      this.sizes[index * 4 + 2] = layer.edge;
      this.sizes[index * 4 + 3] = layer.halo;
      this.spins[index * 4 + 0] = layer.spin;
      this.spins[index * 4 + 1] = layer.tiltX;
      this.spins[index * 4 + 2] = layer.tiltY;
      this.spins[index * 4 + 3] = layer.material.maskAmount;
      this.tones[index * 4 + 0] = layer.hue;
      this.tones[index * 4 + 1] = layer.hueSpan;
      this.tones[index * 4 + 2] = UNIFIED_KIND_INDEX[layer.kind];
      this.tones[index * 4 + 3] = layer.gradientForm;
      this.shapes[index * 4 + 0] = layer.shape[0];
      this.shapes[index * 4 + 1] = layer.shape[1];
      this.shapes[index * 4 + 2] = layer.shape[2];
      this.shapes[index * 4 + 3] = layer.shape[3];
      this.axesAttr[index * 4 + 0] = layer.intensity;
      this.axesAttr[index * 4 + 1] = layer.ceiling;
      this.axesAttr[index * 4 + 2] = layer.pad;
      this.axesAttr[index * 4 + 3] = layer.character;
      this.channels[index * 4 + 0] = layer.channel[0];
      this.channels[index * 4 + 1] = layer.channel[1];
      this.channels[index * 4 + 2] = layer.channel[2];
      this.channels[index * 4 + 3] = layer.channel[3];
      const material = layer.material;
      this.crops[index * 4 + 0] = material.crop[0];
      this.crops[index * 4 + 1] = material.crop[1];
      this.crops[index * 4 + 2] = material.crop[2];
      this.crops[index * 4 + 3] = material.crop[3];
      this.orients[index * 4 + 0] = material.orient[0];
      this.orients[index * 4 + 1] = material.orient[1];
      this.orients[index * 4 + 2] = material.orient[2];
      this.orients[index * 4 + 3] = material.orient[3];
      this.textures[index * 4 + 0] = this.resolveTile(material.roles, material.pick);
      this.textures[index * 4 + 1] = material.grain;
      this.textures[index * 4 + 2] = material.sourceTint;
      this.textures[index * 4 + 3] = this.maskAtlas
        ? Math.min(
            Math.floor(clamp(material.maskPick, 0, 1) * this.maskAtlas.patterns),
            this.maskAtlas.patterns - 1,
          )
        : 0;
      for (let stop = 0; stop < 4; stop++) {
        this.hues[index * 4 + stop] = layer.hues[stop]!;
        this.saturations[index * 4 + stop] = layer.saturations[stop]!;
      }
    }
    if (this.geometry) this.geometry.instanceCount = count;
    for (const attribute of Object.values(this.attributes)) attribute.needsUpdate = true;
  }

  // ---------------------------------------------------------------- 毎フレーム

  update(elapsed: number): void {
    const delta =
      this.previousElapsed < 0 ? 0 : Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.25);
    const engine = this.context?.audioEngine;
    const audio = engine?.getParameters() ?? {};
    const spectrum = engine?.getSpectrum?.() ?? null;
    this.shelf?.update(delta);
    this.syncMasterBases();
    for (const decl of UNIFIED_LOOK_PARAMS) this.lookResolver.updateParam(decl.id, delta);
    for (const decl of MASTER_LOOK_PARAMS) this.lookResolver.updateParam(decl.id, delta);
    // **このフレームの実効値を 1 回だけ作る。** 以降はどこもここを読む。
    this.look = this.effectiveAxes();
    // **結線した `Density` を生成核へも通す**（枚数・同時数・不応期はここが決める）。
    this.applyDensity();
    this.applyUnison();
    // **`Strobe` を繋いだときに時計も付いてくる。** 光学クロックの速さは軸から来るので、
    // 設定のときだけ渡していると「繋いでも明滅の速さが変わらない」になる。
    // 繋いでいなければ設定で渡した値と同じなので、既定では何も起きない。
    this.audioDrive.setStrobe(true, tickRateOf(this.look));
    this.audioDrive.update(audio, spectrum, elapsed, delta);
    this.previousElapsed = elapsed;
    this.advanceDrive(elapsed, delta);
    this.rebuild();

    const material = this.material;
    if (material) {
      const look = this.look;
      material.uniforms.uIntensity!.value =
        UNIFIED.intensityRange.min +
        look.intensity * (UNIFIED.intensityRange.max - UNIFIED.intensityRange.min);
      material.uniforms.uOffset!.value = 0.01 + look.dispersion * 0.09;
      material.uniforms.uDecorrelation!.value = look.dispersion;
      const gain = channelBalanceGain(look.channelBalance);
      (material.uniforms.uChannelGain!.value as THREE.Vector3).set(gain[0], gain[1], gain[2]);
      // **縁の締まり。** どちらも 0 で式が恒等へ戻るので、渡すだけで安全。
      material.uniforms.uEdgeContrast!.value = clamp(look.edgeContrast, 0, 1);
      material.uniforms.uCoreFocus!.value = clamp(look.coreFocus, 0, 1);
      // **破片の型抜き。** 0 で式が恒等へ戻るので、渡すだけで安全。
      material.uniforms.uFragmentCarve!.value = clamp(look.fragmentCarve, 0, 1);
    }
    // **内部ブルームと露出。** どちらも軸そのものが混合係数なので、0 で素通しへ戻る。
    // `Core` マスターの配下なので、結線を通した実効値を使う。
    const bloom = clamp(this.look.coreBloom, 0, 1);
    /**
     * **`Core focus` はブルームの広がり方だけを動かす。**
     * 閾値を上げて滲む画素を芯へ絞り、半径を詰める。強さ（`Core bloom`）は触らないので、
     * 「強く光るが滲まない核」も「弱く広く滲む核」も作れる。軸 0 で従来の値に厳密に戻る。
     */
    const focus = clamp(this.look.coreFocus, 0, 1);
    if (this.bloomPass) {
      this.bloomPass.strength = bloom * UNIFIED.bloom.strengthAtOne;
      this.bloomPass.radius =
        UNIFIED.bloom.radius * mix(1, UNIFIED.definition.bloomRadiusAtOne, focus);
      this.bloomPass.threshold =
        UNIFIED.bloom.threshold + focus * UNIFIED.definition.bloomThresholdRise;
      this.bloomPass.enabled = bloom > 0;
    }
    if (this.displayMaterial) {
      this.displayMaterial.uniforms.uTone!.value = bloom;
      this.displayMaterial.uniforms.uExposure!.value = UNIFIED.bloom.exposureAtOne;
    }
    this.pipeline?.update(audio, elapsed);
  }

  render(): void {
    if (this.bloomComposer && this.displayMaterial) {
      this.bloomComposer.render();
      // 合成器は毎フレーム読み書きバッファを入れ替えるので、都度つなぎ直す。
      this.displayMaterial.uniforms.tDiffuse!.value = this.bloomComposer.readBuffer.texture;
    }
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    const ratio = Math.max(width / Math.max(height, 1), 0.01);
    if (this.camera) {
      this.camera.aspect = ratio;
      this.camera.updateProjectionMatrix();
    }
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);
    this.bloomComposer?.setSize(w, h);
    this.bloomPass?.setSize(w, h);
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
    this.rebuild();
  }

  setDebugView(view: number): void {
    void view;
  }

  getDebugState(): null {
    return null;
  }

  getDepth(): number {
    return this.axes.depthSpread;
  }

  setDepth(amount: number): void {
    this.axes.depthSpread = clamp(amount, 0, 1);
  }

  getPhase(): string {
    const levels = this.audioDrive.levels();
    return `Unified: field ${levels.skeleton.toFixed(2)} / core ${levels.corePulse.toFixed(2)} / H ${levels.huePhase.toFixed(2)} / layers ${this.layers.length}`;
  }

  /** 開発・検証用。 */
  getUnifiedState(): LightUnifiedState {
    return {
      layers: this.layers.length,
      rigLayers: this.rigLayers,
      eventMembranes: this.eventMembranes.length,
      whiteAllowedLayers: this.layers.filter((entry) => entry.whiteAllowed).length,
      axes: { ...this.axes },
      hue: this.drive.hue,
      kinds: this.layers.map((entry) => entry.kind),
    };
  }

  /** 棚（UI に出す代表 7 本）。 */
  private sourceList(): { id: string; label: string; kind: string }[] {
    return (this.shelf?.visible() ?? []).map((source) => ({
      id: source.id,
      label: source.label,
      kind: source.kind,
    }));
  }

  /**
   * **発光 All 1 行。** 選んだ音がリグ全体の発光を駆動する。
   * 下流の時間規律（場の時定数・打撃検出・扇の閾値・ストロボ・H の状態機械）は
   * 表現の側に残るので、繋ぎ替えても明滅の規律は壊れない。
   */
  private emissionParam(): ExpressionParam {
    const emission = this.audioDrive.emission();
    return {
      key: 'emission',
      label: '発光 All',
      type: 'binding' as const,
      min: 0,
      max: 1,
      step: 0.01,
      value: this.audioDrive.bindings().getBase('fieldDrive'),
      sourceId: emission.sourceId,
      depth: emission.depth,
      sources: this.sourceList(),
      transform: this.audioDrive.transformName('fieldDrive'),
      transformOptions: [
        { value: 'auto', label: 'Auto' },
        { value: 'none', label: 'None' },
        { value: 'gate', label: 'Gate' },
        { value: 'envelope-sharp', label: 'Envelope · Sharp' },
        { value: 'envelope-default', label: 'Envelope · Default' },
        { value: 'envelope-soft', label: 'Envelope · Soft' },
      ],
      liveValue: this.audioDrive.bindings().resolve('fieldDrive').value,
      liveSignal: this.audioDrive.bindings().resolve('fieldDrive').signal,
    };
  }

  /** 軸のスライダーに音のソースを添える（行は増やさない）。 */
  private axisRow(decl: (typeof AXIS_DECLS)[number]): ExpressionParam {
    const row = {
      key: decl.id,
      label: `${decl.label} (${decl.low} ⇄ ${decl.high})`,
      group: decl.group,
      detail: decl.detail === true,
      min: 0,
      max: 1,
      step: 0.01,
      value: this.axes[decl.id],
    };
    if (!LOOK_KEYS.has(decl.id)) return row;
    const binding = this.lookResolver.getBinding(decl.id);
    return {
      ...row,
      bind: {
        paramId: decl.id,
        sourceId: binding?.sourceId ?? null,
        depth: binding?.depth ?? 1,
        sources: this.sourceList(),
        liveValue: this.lookValue(decl.id),
      },
    };
  }

  getExpressionParams(): ExpressionParam[] {
    return [
      {
        key: 'preset',
        label: 'Preset (座標を代入)',
        type: 'select',
        options: [
          { value: 'keep', label: '— (現在の値)' },
          { value: 'spatial', label: 'Spatial 風' },
          { value: 'reactive', label: 'Reactive 風' },
          { value: 'optics', label: 'Lab2 風' },
          { value: 'default', label: '中間（既定）' },
        ],
        value: 'keep',
      },
      this.emissionParam(),
      ...this.groupedRows(),
    ];
  }

  /**
   * **グループごとに、マスター → 上段の軸 → 詳細の軸 の順で並べる。**
   *
   * マスターは状態を持たない（`unifiedMasters.ts`）ので、値は毎回配下から逆算する。
   * 詳細を直接動かせばマスターの表示がそちらへ付いてくる ＝ **詳細のほうが常に優先**。
   */
  private groupedRows(): ExpressionParam[] {
    const out: ExpressionParam[] = [];
    for (const group of UNIFIED_GROUPS) {
      for (const master of AXIS_MASTERS) {
        if (master.group !== group) continue;
        // `Spread` は「量」と「偏り」の 2 座標で出すので、この汎用の並びには載せない。
        if (master.id === 'spread') continue;
        out.push({
          key: `master:${master.id}`,
          label: `${master.label} (${master.low} ⇄ ${master.high})`,
          group,
          min: 0,
          max: 1,
          step: 0.01,
          value: readMaster(master, this.axes),
          ...this.masterBind(master.id),
        });
      }
      // 散らばりの量（`Spread`）と縦横の偏り（`Aspect`）は同じ 2 軸を別の座標で見たもの。
      // 量はマスター、偏りは詳細。**`Spread X` / `Spread Y` も生のまま残してある。**
      if (group === '配置・空間') {
        out.push({
          key: 'master:spread',
          label: 'Spread (中心 ⇄ ばらける)',
          group,
          min: 0,
          max: 1,
          step: 0.01,
          value: readSpread(this.axes),
          ...this.masterBind('spread'),
        });
        out.push({
          key: 'master:aspect',
          label: 'Aspect (縦長 ⇄ 横長)',
          group,
          detail: true,
          min: 0,
          max: 1,
          step: 0.01,
          value: readAspect(this.axes),
        });
      }
      for (const decl of AXIS_DECLS) {
        if (decl.group === group && decl.detail !== true) out.push(this.axisRow(decl));
      }
      for (const decl of AXIS_DECLS) {
        if (decl.group === group && decl.detail === true) out.push(this.axisRow(decl));
      }
    }
    return out;
  }

  /** マスター 1 本ぶんの「配下へ書く値」。`Spread` と `Aspect` は同じ 2 軸の別座標。 */
  private masterPatch(
    id: string,
    value: number,
    axes: UnifiedAxes = this.axes,
  ): Partial<Record<keyof UnifiedAxes, number>> {
    if (id === 'spread') return applySpread(axes, value);
    if (id === 'aspect') return applyAspect(axes, value);
    const master = AXIS_MASTERS.find((entry) => entry.id === id);
    return master ? applyMaster(master, value) : {};
  }

  /**
   * **軸をまとめて書く。** 1 本ずつの `setExpressionParam` と同じ副作用
   *（結線の基準値・光学クロック・痕跡場・色の粘り・密度）を必ず通す。
   */
  private writeAxes(patch: Partial<Record<keyof UnifiedAxes, number>>): void {
    let clock = false;
    for (const [id, next] of Object.entries(patch)) {
      if (typeof next !== 'number' || !Number.isFinite(next)) continue;
      const axis = id as keyof UnifiedAxes;
      this.axes[axis] = clamp(next, 0, 1);
      if (LOOK_KEYS.has(axis)) this.lookResolver.setBase(axis, this.axes[axis]);
      if (axis === 'strobe') clock = true;
      if (axis === 'trace') this.audioDrive.setTraceAmount(this.axes.trace);
      if (axis === 'hueStickiness') this.applyStickiness();
      if (axis === 'density') this.applyDensity();
    }
    if (clock) this.audioDrive.setStrobe(true, tickRateOf(this.axes));
    this.rebuild();
  }

  /** マスターに音のソースを添える（結線に出すマスターだけ）。 */
  private masterBind(id: string): Partial<ExpressionNumberParam> {
    // 色のまとめ役の行には**色相 H** を添える（H は下流の時間規律を持つので
    // 軸ではなく `OpticsAudioDrive` 側の 1 本へ繋ぐ）。行は増やさない。
    if (id === 'colourLock') {
      const hue = this.audioDrive.hueBinding();
      return {
        bind: {
          paramId: 'colourLock',
          sourceId: hue.sourceId,
          depth: hue.depth,
          sources: this.sourceList(),
          liveValue: this.drive.hue,
        },
      };
    }
    if (!MASTER_LOOK_KEYS.has(id)) return {};
    const binding = this.lookResolver.getBinding(id);
    return {
      bind: {
        paramId: id,
        sourceId: binding?.sourceId ?? null,
        depth: binding?.depth ?? 1,
        sources: this.sourceList(),
        liveValue: this.lookValue(id),
      },
    };
  }

  setExpressionParam(key: string, value: number | string): void {
    // ---- 発光 All の結線 ----
    if (key.startsWith('emission')) {
      const what = key.split(':')[1];
      const current = this.audioDrive.emission();
      if (what === 'source') {
        const next = String(value);
        this.audioDrive.setEmission(next === 'none' ? null : next, current.depth);
        return;
      }
      if (what === 'depth') {
        const depth = Number(value);
        if (Number.isFinite(depth)) this.audioDrive.setEmission(current.sourceId, clamp(depth, -1, 1));
        return;
      }
      if (what === 'transform') {
        for (const paramId of ['fieldDrive', 'coreStrike', 'fanStrike']) {
          this.audioDrive.setTransform(paramId, String(value));
        }
        return;
      }
      const base = Number(value);
      if (!Number.isFinite(base)) return;
      for (const paramId of ['fieldDrive', 'coreStrike', 'fanStrike']) {
        this.audioDrive.bindings().setBase(paramId, base);
      }
      return;
    }
    // ---- 軸に添えたソース（`bind:<axis>:source|depth`）----
    if (key.startsWith('bind:')) {
      const [, paramId, what] = key.split(':');
      if (!paramId) return;
      const isHue = paramId === 'colourLock';
      const hue = this.audioDrive.hueBinding();
      const binding = isHue ? null : this.lookResolver.getBinding(paramId);
      if (what === 'source') {
        const next = String(value);
        const sourceId = next === 'none' ? null : next;
        if (isHue) {
          this.audioDrive.setHueSource(sourceId, hue.depth);
          return;
        }
        // 軸でもマスターでも同じ扱いにする（打撃のソースには自動で包絡が挟まる）。
        const decl =
          UNIFIED_LOOK_PARAMS.find((entry) => entry.id === paramId) ??
          MASTER_LOOK_PARAMS.find((entry) => entry.id === paramId);
        const source = this.lookResolver.listSources().find((entry) => entry.id === sourceId);
        this.lookResolver.bind({
          paramId,
          sourceId,
          depth: binding?.depth ?? 1,
          transform: decl && source ? defaultTransformFor(source.kind, decl.kind) : null,
        });
        return;
      }
      if (what === 'depth') {
        const depth = Number(value);
        if (!Number.isFinite(depth)) return;
        if (isHue) {
          this.audioDrive.setHueSource(hue.sourceId, clamp(depth, -1, 1));
          return;
        }
        this.lookResolver.bind({
          paramId,
          sourceId: binding?.sourceId ?? null,
          depth: clamp(depth, -1, 1),
          transform: binding?.transform ?? null,
        });
      }
      return;
    }
    // ---- マスター（配下へ書くだけ。状態は持たない）----
    if (key.startsWith('master:')) {
      const id = key.slice('master:'.length);
      const next = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(next)) return;
      this.writeAxes(this.masterPatch(id, clamp(next, 0, 1)));
      return;
    }
    if (key === 'preset') {
      const name = String(value);
      if (name === 'keep') return;
      const preset = name === 'default' ? DEFAULT_AXES : AXIS_PRESETS[name];
      if (!preset) return;
      // **スライダー値を一括代入するだけ。** 表現を切り替えるのではない。
      for (const decl of AXIS_DECLS) {
        const next = preset[decl.id];
        if (typeof next === 'number') this.axes[decl.id] = clamp(next, 0, 1);
        if (LOOK_KEYS.has(decl.id)) this.lookResolver.setBase(decl.id, this.axes[decl.id]);
      }
      this.audioDrive.setStrobe(true, tickRateOf(this.axes));
      this.audioDrive.setTraceAmount(this.axes.trace);
      this.applyStickiness();
      this.applyDensity();
      this.rebuild();
      return;
    }
    const decl = AXIS_DECLS.find((entry) => entry.id === key);
    if (!decl) return;
    const next = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(next)) return;
    this.axes[decl.id] = clamp(next, 0, 1);
    if (LOOK_KEYS.has(decl.id)) this.lookResolver.setBase(decl.id, this.axes[decl.id]);
    // 光学クロックの速さは `Strobe` が持つ（旧 `Tick rate` 軸を吸収した）。
    if (decl.id === 'strobe') this.audioDrive.setStrobe(true, tickRateOf(this.axes));
    if (decl.id === 'trace') this.audioDrive.setTraceAmount(this.axes.trace);
    if (decl.id === 'hueStickiness') this.applyStickiness();
    if (decl.id === 'density') this.applyDensity();
    this.rebuild();
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
    this.maskAtlas?.texture.dispose();
    if (this.mesh && this.scene) this.scene.remove(this.mesh);
    this.layers = [];
    this.fragmentShapes.clear();
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
    this.maskAtlas = null;
    this.mesh = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
    this.shelf = null;
  }
}
