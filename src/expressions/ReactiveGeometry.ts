import * as THREE from 'three';
import type { AudioParameters } from '../audio/AudioEngine';
import type {
  CompositionContext,
  DesignLayerCanvases,
} from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { ExpressionParam, LabExpression } from './Expression';

/**
 * Reactive Geometry — 音に反応して線と幾何学図形が生まれ、育ち、消える表現。
 *
 * 完成したアニメーションの再生ではない。音響解析値と UI の操作から
 * 毎フレーム形を組み立てる。黒い空間にテーマの light 色ひと色だけを置き、
 * Bloom・VHS・グレイン・色収差・残像はここでは作らない（後段の Effect の役目）。
 *
 * ■ 内部は 2 系統
 *
 *   Line System   持続音・音程の変化に反応する。1 本 = 固定点数のリボン。
 *                 Wave / Straight / Orbit / Freeform をパラメトリック関数で描く。
 *                 CPU で毎フレーム頂点を更新し、フラグメントで縁を smoothstep する。
 *   Shape System  オンセット・短い音に反応する。1 つの InstancedMesh（クアッド）で、
 *                 フラグメントの SDF が Dot / Circle / Capsule / Bar / Ring を描き分ける。
 *
 * Mode（Lines / Shapes / Hybrid）は**どちらの系統が新しい要素を生むか**の切り替えで、
 * シミュレーションは再起動しない。Lines → Hybrid でも既存の線はそのまま生き、
 * 次の音響イベントから図形が加わる。線種・図形種の変更も同じで、
 * **これから生まれる要素にだけ効く**（生きている要素は作り替えない）。
 *
 * ■ 反応の規則（このプロジェクトで確立済み。破らない）
 *
 *   ① 連続量（太さ・速さ・明るさ）は 1.5〜2 秒の平滑を通す。
 *      **生きている要素の大きさを音で直接動かさない。** 大きさは誕生時に確定し、
 *      あとは全体アーチ（平滑した音量から作る緩い倍率）だけが掛かる。
 *   ② 離散イベント（誕生・消滅）はオンセット駆動。不応時間とトークン制の上限つき。
 *   ③ **音量が下がっても要素は消えない。** 静けさは新規発生が減ることでだけ現れる。
 *      目標密度は蓄積（buildup）の単調増加関数で、区切り（クライマックス）でだけ落ちる。
 *   ④ 消える要素はポップさせず 100〜200ms の遷移を通す。縮む／画面外へ出る／
 *      線が短くなる／順番に、をシードで選ぶ（フェード一辺倒にしない）。
 *
 * ■ 時間構造
 *
 * 固定周期は持たない。エネルギー履歴とオンセットで `buildup` が溜まり、
 * それが目標密度を決める。buildup が満ちるとクライマックスとして一部または全部が
 * 消え、新しいシードで次の構成が始まる。結果として
 * 空 → 少数 → 追加 → 複雑化 → 重なり → クライマックス → 消去 が
 * 曲の側の都合で伸び縮みする。
 *
 * 音との対応（PRD §7 の解釈。表現ごとに定義する = D25）:
 *   sustain           → 線の維持と伸長（reveal の到達点）
 *   pitch / centroid  → 波の空間周波数・軌道の比率・図形の型と配置範囲
 *   volume（平滑・帯域ゲイン）→ リボンの太さ・全体アーチ。像の量は動かさない
 *   mid               → 誕生時の曲率と振幅・位相の進む速さ
 *   bass              → 大きい円／カプセル・放射の初速・線の長さの偏り
 *   treble            → 小さい点／短い棒の割合
 *   onset             → 線の誕生と図形バースト（強いほど数と初速が増える）
 *   beat              → オンセットの補助トリガ
 *   flatness          → 角のある形（Bar / Capsule）と丸い形（Circle / Ring）の比
 *   seed / getSpectrum() → 決定論乱数の種と Freeform の倍音の重み
 *   無音（active !== 1）は黒・発生ゼロ・動きも停止（D5）。
 *
 * 乱数は `Math.random()` を使わない。音のシード・Seed スライダー・世代カウンタから
 * 決定論ハッシュを引くので、同じ音源・同じ設定・同じ Seed なら概ね同じ像になる。
 */

// ---------------------------------------------------------------- 定数

/** 線 1 本の点数。固定長のリボンにするので毎フレームの再確保が要らない。 */
const LINE_POINTS = 112;
/** 同時に生きられる線の本数。 */
const MAX_LINES = 20;
/** 同時に生きられる図形の数。InstancedMesh の確保数。 */
const MAX_SHAPES = 200;

const VERTS_PER_LINE = LINE_POINTS * 2;
const INDICES_PER_LINE = (LINE_POINTS - 1) * 6;
const TAU = Math.PI * 2;

const LINE_KINDS = ['wave', 'straight', 'orbit', 'freeform'] as const;
type LineKind = (typeof LINE_KINDS)[number];

const SHAPE_KINDS = ['dot', 'circle', 'capsule', 'bar', 'ring'] as const;
type ShapeKind = (typeof SHAPE_KINDS)[number];

/** 図形の配置。バースト 1 回ごとに 1 つ選ばれる。 */
type Placement = 'random' | 'radial' | 'ring' | 'spiral' | 'flock' | 'cluster';

type ModeId = 'lines' | 'shapes' | 'hybrid';
type LineTypeId = LineKind | 'mixed';
type ShapeTypeId = ShapeKind | 'mixed';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const clamp01 = (value: number | undefined): number => clamp(value ?? 0, 0, 1);

/** 0..1 を滑らかに折り返す補間。誕生と消滅の遷移に使う。 */
const smoothstep01 = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

interface LineElement {
  kind: LineKind;
  seed: number;
  /** 中心（板の物理座標）。 */
  cx: number;
  cy: number;
  /** ゆっくりした移動。 */
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  /** 誕生時に確定する寸法。音で後から動かさない（規則 ①）。 */
  sizeBias: number;
  length: number;
  amplitude: number;
  frequency: number;
  harmonic: number;
  radiusX: number;
  radiusY: number;
  ratioA: number;
  ratioB: number;
  delta: number;
  loops: number;
  /** Freeform の倍音（x/y それぞれ 3 本ぶんの振幅と位相）。 */
  hx: [number, number, number];
  hy: [number, number, number];
  px: [number, number, number];
  py: [number, number, number];
  phase: number;
  phaseSpeed: number;
  widthBias: number;
  /** 描かれている割合。sustain が高いほど伸びる。 */
  reveal: number;
  revealTarget: number;
  revealRate: number;
  life: number;
  maxLife: number;
  age: number;
  exiting: boolean;
  exitDelay: number;
  exitProgress: number;
  exitSeconds: number;
  exitMode: number;
}

interface ShapeElement {
  kind: ShapeKind;
  seed: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  /** 誕生時に確定する半径（板の物理座標）。 */
  sizeX: number;
  sizeY: number;
  /** Ring の太さ比 / Bar の角丸。 */
  detail: number;
  growSeconds: number;
  life: number;
  age: number;
  exiting: boolean;
  exitDelay: number;
  exitProgress: number;
  exitSeconds: number;
  exitMode: number;
}

export class ReactiveGeometry implements LabExpression {
  readonly animated = true;
  readonly name = 'Reactive Geometry';
  readonly id: ExpressionId = 'reactive-geometry-v1';

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  // ---- 表現ごとの調整（PRD D25。持つ機能はこの表現が宣言する）----
  private mode: ModeId = 'hybrid';
  private lineType: LineTypeId = 'mixed';
  private shapeType: ShapeTypeId = 'mixed';
  private params = {
    lineAmount: 0.7,
    shapeAmount: 0.6,
    size: 0.5,
    density: 0.5,
    motion: 0.45,
    complexity: 0.5,
    variation: 0.5,
    sensitivity: 0.55,
    seed: 0.37,
  };

  private context: CompositionContext | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private pipeline: EffectPipeline | null = null;

  private lineGeometry: THREE.BufferGeometry | null = null;
  private lineMaterial: THREE.ShaderMaterial | null = null;
  private lineMesh: THREE.Mesh | null = null;
  private shapeGeometry: THREE.PlaneGeometry | null = null;
  private shapeMaterial: THREE.ShaderMaterial | null = null;
  private shapeMesh: THREE.InstancedMesh | null = null;

  private readonly linePositions = new Float32Array(MAX_LINES * VERTS_PER_LINE * 3);
  private readonly lineEdges = new Float32Array(MAX_LINES * VERTS_PER_LINE);
  private readonly lineHalfWidths = new Float32Array(MAX_LINES * VERTS_PER_LINE);
  private readonly lineAlphas = new Float32Array(MAX_LINES * VERTS_PER_LINE);
  /** 1 本ぶんの中心線の作業領域（毎フレーム使い回す）。 */
  private readonly curve = new Float32Array(LINE_POINTS * 2);

  private readonly shapeTypes = new Float32Array(MAX_SHAPES);
  private readonly shapeOpacities = new Float32Array(MAX_SHAPES);
  private readonly shapeSizes = new Float32Array(MAX_SHAPES * 2);
  private readonly shapeDetails = new Float32Array(MAX_SHAPES);
  private readonly instanceMatrix = new THREE.Matrix4();
  private readonly instanceQuaternion = new THREE.Quaternion();
  private readonly instancePosition = new THREE.Vector3();
  private readonly instanceScale = new THREE.Vector3(1, 1, 1);

  private readonly lines: LineElement[] = [];
  private readonly shapes: ShapeElement[] = [];

  private previousElapsed = -1;
  private canvasHeight = 720;

  // ---- 平滑した解析値（規則 ①: 連続量はすべてここを通す）----
  private smoothedVolume = 0;
  private smoothedBass = 0;
  private smoothedMid = 0;
  private smoothedTreble = 0;
  private smoothedCentroid = 0.5;
  private smoothedPitch = 0.5;
  private smoothedSustain = 0;
  private smoothedFlatness = 0.4;

  // ---- 離散イベント（規則 ②）----
  private previousOnset = 0;
  private spawnCooldown = 0;
  private eventTokens = 2;
  private lineTimer = 0;
  private retireTimer = 0;

  // ---- 時間構造 ----
  private buildup = 0;
  private placement: Placement = 'random';
  private variationSeed = 0;
  private rngCounter = 0;
  private audioSeed = 0;

  constructor(effects: Effect[] = [], theme?: Theme) {
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
  }

  // ---------------------------------------------------------------- 決定論乱数

  /**
   * 決定論ハッシュ。`Math.random()` は使わない。
   * 乱数源は「音のシード × Seed スライダー × 世代カウンタ」なので、
   * 同じ音源・同じ設定なら同じ列になる。
   */
  private rand(): number {
    this.rngCounter += 1;
    const x =
      Math.sin(
        this.rngCounter * 12.9898 +
          this.audioSeed * 78.233 +
          this.params.seed * 311.7 +
          this.variationSeed * 57.31 +
          0.5,
      ) * 43758.5453;
    return x - Math.floor(x);
  }

  private randRange(min: number, max: number): number {
    return min + (max - min) * this.rand();
  }

  private pick<T>(items: readonly T[]): T {
    return items[Math.min(Math.floor(this.rand() * items.length), items.length - 1)]!;
  }

  // ---------------------------------------------------------------- 板の寸法

  /** 板の半辺長（面積 1 正規化）。距離が等方になるので図形が楕円に潰れない。 */
  private plateExtents(): { x: number; y: number } {
    const s = Math.sqrt(Math.max(this.aspectRatio, 1e-6));
    return { x: s, y: 1 / s };
  }

  /** 1 ピクセルが板の物理座標でどれだけかを返す。縁の smoothstep 幅に使う。 */
  private pixelWidth(): number {
    const extents = this.plateExtents();
    return ((2 * extents.y) / Math.max(this.zoom, 0.05) / Math.max(this.canvasHeight, 1)) * 1.1;
  }

  private syncCamera(): void {
    if (!this.camera) return;
    const extents = this.plateExtents();
    this.camera.left = -extents.x;
    this.camera.right = extents.x;
    this.camera.top = extents.y;
    this.camera.bottom = -extents.y;
    this.camera.zoom = clamp(this.zoom, 0.25, 8);
    this.camera.updateProjectionMatrix();
    const pixel = this.pixelWidth();
    if (this.lineMaterial) this.lineMaterial.uniforms.uPixel!.value = pixel;
    if (this.shapeMaterial) this.shapeMaterial.uniforms.uPixel!.value = pixel;
  }

  private syncColor(): void {
    // テーマの light 色ひと色だけを使う。背景は黒で固定（D13 のモノクロ既定を壊さない）。
    const [r, g, b] = this.theme.light;
    (this.lineMaterial?.uniforms.uColor!.value as THREE.Color | undefined)?.setRGB(r, g, b);
    (this.shapeMaterial?.uniforms.uColor!.value as THREE.Color | undefined)?.setRGB(r, g, b);
  }

  // ---------------------------------------------------------------- setup

  setup(context: CompositionContext): void {
    this.context = context;
    const extents = this.plateExtents();

    this.camera = new THREE.OrthographicCamera(
      -extents.x,
      extents.x,
      extents.y,
      -extents.y,
      0.1,
      10,
    );
    this.camera.position.z = 2;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);

    this.buildLineMesh();
    this.buildShapeMesh();
    this.scene.add(this.lineMesh!, this.shapeMesh!);

    this.pipeline = new EffectPipeline(context.renderer, this.scene, this.camera, this.effects);
    this.syncCamera();
    this.syncColor();
  }

  /** リボン（三角形ストリップ）1 枚。全ての線が 1 つの draw call に入る。 */
  private buildLineMesh(): void {
    const geometry = new THREE.BufferGeometry();
    const indices = new Uint16Array(MAX_LINES * INDICES_PER_LINE);
    let cursor = 0;
    for (let line = 0; line < MAX_LINES; line++) {
      const base = line * VERTS_PER_LINE;
      for (let i = 0; i < LINE_POINTS - 1; i++) {
        const v0 = base + i * 2;
        indices[cursor++] = v0;
        indices[cursor++] = v0 + 1;
        indices[cursor++] = v0 + 2;
        indices[cursor++] = v0 + 1;
        indices[cursor++] = v0 + 3;
        indices[cursor++] = v0 + 2;
      }
      // 縁の符号は静的。頂点の並びは「左・右」の繰り返し。
      for (let i = 0; i < LINE_POINTS; i++) {
        this.lineEdges[base + i * 2] = 1;
        this.lineEdges[base + i * 2 + 1] = -1;
      }
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    geometry.setAttribute('aEdge', new THREE.BufferAttribute(this.lineEdges, 1));
    geometry.setAttribute('aHalf', new THREE.BufferAttribute(this.lineHalfWidths, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.lineAlphas, 1));
    geometry.setDrawRange(0, 0);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1, 1, 1) },
        uPixel: { value: 0.003 },
      },
      vertexShader: /* glsl */ `
        attribute float aEdge;
        attribute float aHalf;
        attribute float aAlpha;
        varying float vEdge;
        varying float vHalf;
        varying float vAlpha;
        void main() {
          vEdge = aEdge;
          vHalf = aHalf;
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor;
        uniform float uPixel;
        varying float vEdge;
        varying float vHalf;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.002) discard;
          // 縁の柔らかさは常に約 1 ピクセル。太さが変わっても輪郭の印象が揃う。
          float aa = clamp(uPixel / max(vHalf, 1e-5), 0.02, 0.9);
          float edge = 1.0 - smoothstep(1.0 - aa, 1.0, abs(vEdge));
          float alpha = clamp(edge * vAlpha, 0.0, 1.0);
          if (alpha <= 0.002) discard;
          gl_FragColor = vec4(uColor, alpha);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.lineGeometry = geometry;
    this.lineMaterial = material;
    this.lineMesh = new THREE.Mesh(geometry, material);
    this.lineMesh.frustumCulled = false;
    this.lineMesh.renderOrder = 1;
    this.lineMesh.visible = false;
  }

  /** 図形はクアッド 1 枚の InstancedMesh。型ごとの形は SDF がフラグメントで描く。 */
  private buildShapeMesh(): void {
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.setAttribute(
      'aType',
      new THREE.InstancedBufferAttribute(this.shapeTypes, 1),
    );
    geometry.setAttribute(
      'aOpacity',
      new THREE.InstancedBufferAttribute(this.shapeOpacities, 1),
    );
    geometry.setAttribute(
      'aSize',
      new THREE.InstancedBufferAttribute(this.shapeSizes, 2),
    );
    geometry.setAttribute(
      'aDetail',
      new THREE.InstancedBufferAttribute(this.shapeDetails, 1),
    );

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1, 1, 1) },
        uPixel: { value: 0.003 },
      },
      vertexShader: /* glsl */ `
        attribute float aType;
        attribute float aOpacity;
        attribute vec2 aSize;
        attribute float aDetail;
        varying vec2 vLocal;
        varying float vType;
        varying float vOpacity;
        varying vec2 vSize;
        varying float vDetail;
        void main() {
          vLocal = position.xy;
          vType = aType;
          vOpacity = aOpacity;
          vSize = aSize;
          vDetail = aDetail;
          vec4 local = vec4(position, 1.0);
          #ifdef USE_INSTANCING
            local = instanceMatrix * local;
          #endif
          gl_Position = projectionMatrix * modelViewMatrix * local;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor;
        uniform float uPixel;
        varying vec2 vLocal;
        varying float vType;
        varying float vOpacity;
        varying vec2 vSize;
        varying float vDetail;

        float sdCircle(vec2 p, float r) {
          return length(p) - r;
        }

        float sdSegment(vec2 p, float h, float r) {
          vec2 q = p;
          q.x -= clamp(q.x, -h, h);
          return length(q) - r;
        }

        float sdRoundBox(vec2 p, vec2 b, float r) {
          vec2 d = abs(p) - b + r;
          return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
        }

        void main() {
          if (vOpacity <= 0.002) discard;
          // クアッド内の座標を物理座標に戻すと、SDF の丸みが縦横で潰れない。
          vec2 q = vLocal * vSize;
          float sx = max(vSize.x, 1e-5);
          float sy = max(vSize.y, 1e-5);
          float small = min(sx, sy);
          float d;
          if (vType < 0.5) {
            d = sdCircle(q, small * 0.46);                      // Dot
          } else if (vType < 1.5) {
            d = sdCircle(q, small * 0.86);                      // Circle
          } else if (vType < 2.5) {
            float r = sy * 0.86;                                // Capsule
            d = sdSegment(q, max(sx - r, 0.0), r);
          } else if (vType < 3.5) {
            d = sdRoundBox(q, vec2(sx * 0.9, sy * 0.86), small * vDetail); // Bar
          } else {
            float r = small * 0.82;                             // Ring
            d = abs(sdCircle(q, r)) - max(r * vDetail, uPixel);
          }
          float alpha = (1.0 - smoothstep(-uPixel, uPixel, d)) * vOpacity;
          if (alpha <= 0.002) discard;
          gl_FragColor = vec4(uColor, clamp(alpha, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.shapeGeometry = geometry;
    this.shapeMaterial = material;
    this.shapeMesh = new THREE.InstancedMesh(geometry, material, MAX_SHAPES);
    this.shapeMesh.frustumCulled = false;
    this.shapeMesh.renderOrder = 2;
    this.shapeMesh.count = 0;
    this.shapeMesh.visible = false;
  }

  // ---------------------------------------------------------------- 有効な系統

  private get linesEnabled(): boolean {
    return this.mode !== 'shapes' && this.params.lineAmount > 0.001;
  }

  private get shapesEnabled(): boolean {
    return this.mode !== 'lines' && this.params.shapeAmount > 0.001;
  }

  /** 目標本数。buildup の単調増加関数なので、音量が下がっても減らない（規則 ③）。 */
  private targetLineCount(): number {
    if (!this.linesEnabled) return 0;
    const growth = 0.12 + 0.88 * Math.pow(clamp(this.buildup, 0, 1), 1.15);
    const count =
      this.params.lineAmount * MAX_LINES * growth * (0.45 + this.params.density * 0.75);
    return clamp(Math.round(count), 1, MAX_LINES);
  }

  private targetShapeCount(): number {
    if (!this.shapesEnabled) return 0;
    const growth = 0.06 + 0.94 * Math.pow(clamp(this.buildup, 0, 1), 1.1);
    const count =
      this.params.shapeAmount * MAX_SHAPES * growth * (0.35 + this.params.density * 0.8);
    return clamp(Math.round(count), 1, MAX_SHAPES);
  }

  // ---------------------------------------------------------------- 線の誕生

  private resolveLineKind(): LineKind {
    if (this.lineType !== 'mixed') return this.lineType;
    // Mixed は音とシードで選ぶ。高い音・明るい音ほど軌道と自由曲線に寄る。
    const roll = this.rand() * (0.6 + this.params.variation * 0.8);
    const bright = this.smoothedCentroid;
    if (roll < 0.3 - bright * 0.12) return 'wave';
    if (roll < 0.5 - bright * 0.16) return 'straight';
    if (roll < 0.82 + bright * 0.1) return 'orbit';
    return 'freeform';
  }

  /** Freeform の倍音の重み。スペクトルがあればその形を借りる。 */
  private harmonicWeights(): [number, number, number] {
    const spectrum = this.context?.audioEngine.getSpectrum?.() ?? null;
    if (!spectrum || spectrum.magnitudes.length < 12) {
      return [this.randRange(0.5, 1), this.randRange(0.2, 0.6), this.randRange(0.1, 0.35)];
    }
    const bins = spectrum.magnitudes;
    const third = Math.floor(bins.length / 3);
    const band = (from: number, to: number): number => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += bins[i] ?? 0;
      return sum / Math.max(to - from, 1) / 255;
    };
    const low = band(0, third);
    const midBand = band(third, third * 2);
    const high = band(third * 2, bins.length);
    const norm = Math.max(low, midBand, high, 1e-3);
    return [
      0.45 + (low / norm) * 0.65,
      0.15 + (midBand / norm) * 0.6,
      0.06 + (high / norm) * 0.4,
    ];
  }

  private spawnLine(strength: number): void {
    if (this.lines.length >= Math.min(this.targetLineCount(), MAX_LINES)) return;
    const plate = this.plateExtents();
    const kind = this.resolveLineKind();
    const complexity = this.params.complexity;
    const variation = this.params.variation;
    const seed = this.rand();

    // 誕生時に寸法を確定する（規則 ①）。以後、音は形の位相しか動かさない。
    const sizeBias = this.randRange(0.6, 1.35) * (0.55 + this.params.size * 1.1);
    const spread = 0.35 + variation * 0.75;
    const cx = this.randRange(-plate.x * spread, plate.x * spread);
    const cy = this.randRange(-plate.y * spread, plate.y * spread);

    // 直線は水平・垂直・対角へ量子化する（画面を横切る直線群）。
    const straightAngles = [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4];
    const rotation =
      kind === 'straight'
        ? this.pick(straightAngles) + (this.rand() - 0.5) * 0.12 * variation
        : this.randRange(0, TAU);

    const weights = kind === 'freeform' ? this.harmonicWeights() : [1, 0.4, 0.2];
    const motion = this.params.motion;

    this.lines.push({
      kind,
      seed,
      cx,
      cy,
      vx: (this.rand() - 0.5) * 0.06 * motion,
      vy: (this.rand() - 0.5) * 0.06 * motion,
      rotation,
      // 回転はごく緩く。表示中の図形を振り回さない。
      rotationSpeed: (this.rand() - 0.5) * 0.35 * motion * (kind === 'straight' ? 0.25 : 1),
      sizeBias,
      // bass が強いほど長い線が生まれる（誕生時にだけ効く）。
      length: this.randRange(1.1, 2.4) * (0.7 + this.smoothedBass * 0.7),
      // mid が曲率と振幅を決める。
      amplitude: this.randRange(0.05, 0.28) * (0.45 + this.smoothedMid * 1.3),
      // pitch が波の空間周波数を決める。点数（LINE_POINTS）で表せる範囲に収める。
      frequency: Math.min(1 + Math.round(this.smoothedPitch * 4 + complexity * 2 * this.rand()), 6),
      harmonic: complexity * this.randRange(0.15, 0.55),
      radiusX: this.randRange(0.25, 0.7),
      // centroid が軌道の縦横比（円 ↔ 扁平な楕円）を決める。
      radiusY: this.randRange(0.25, 0.7) * (0.35 + this.smoothedCentroid * 1.1),
      // リサージュの次数。上げすぎると 112 点では折れ線が粗くなるので 3 で止める。
      ratioA: 1 + Math.round(complexity * 2 * this.rand()),
      ratioB: 1 + Math.round(complexity * 2 * this.rand()),
      delta: this.randRange(0, TAU),
      loops: this.rand() < 0.75 ? 1 : 2,
      hx: [weights[0]!, weights[1]!, weights[2]!],
      hy: [
        weights[0]! * this.randRange(0.6, 1.2),
        weights[1]! * this.randRange(0.5, 1.4),
        weights[2]! * this.randRange(0.4, 1.6),
      ],
      px: [this.randRange(0, TAU), this.randRange(0, TAU), this.randRange(0, TAU)],
      py: [this.randRange(0, TAU), this.randRange(0, TAU), this.randRange(0, TAU)],
      phase: this.randRange(0, TAU),
      phaseSpeed: (this.rand() < 0.5 ? -1 : 1) * this.randRange(0.15, 0.9) * (0.2 + motion * 1.6),
      widthBias: this.randRange(0.7, 1.4) * (0.6 + clamp(strength, 0, 2) * 0.35),
      reveal: 0,
      revealTarget: 0.45 + this.smoothedSustain * 0.55,
      revealRate: this.randRange(1.6, 4.2),
      // 線は長生きさせる。静かな区間で画面が空になるのは「新規発生が減った」結果であって、
      // 音量が下がったから消える、という挙動にはしない（規則 ③）。
      life: this.randRange(5, 13) * (0.6 + this.params.variation * 0.8),
      maxLife: 30,
      age: 0,
      exiting: false,
      exitDelay: 0,
      exitProgress: 0,
      exitSeconds: this.randRange(0.1, 0.2),
      exitMode: Math.floor(this.rand() * 4),
    });
  }

  // ---------------------------------------------------------------- 図形の誕生

  private resolveShapeKind(): ShapeKind {
    if (this.shapeType !== 'mixed') return this.shapeType;
    // treble が高いと小さい点と短い棒、bass が強いと大きい円とカプセル。
    // flatness（雑音的か音程的か）が角のある形と丸い形の比を決める。
    const angular = clamp(this.smoothedFlatness * 1.2, 0, 1);
    const roll = this.rand();
    if (roll < 0.24 + this.smoothedTreble * 0.3) return 'dot';
    if (roll < 0.4 + angular * 0.22) return this.smoothedTreble > 0.45 ? 'bar' : 'capsule';
    if (roll < 0.6 + angular * 0.18) return 'capsule';
    if (roll < 0.84 - this.smoothedCentroid * 0.12) return 'circle';
    return 'ring';
  }

  private resolvePlacement(strength: number): Placement {
    // 強いオンセットは中央からの放射展開になる。
    if (strength > 1.05 && this.rand() < 0.75) return 'radial';
    const roll = this.rand() * (0.7 + this.params.variation * 0.6);
    if (roll < 0.22) return 'random';
    if (roll < 0.38) return 'ring';
    if (roll < 0.54) return 'spiral';
    if (roll < 0.74) return 'flock';
    if (roll < 0.9) return 'cluster';
    return 'radial';
  }

  private spawnShapeBurst(strength: number): void {
    const headroom = Math.min(this.targetShapeCount(), MAX_SHAPES) - this.shapes.length;
    if (headroom <= 0) return;
    const wanted = 1 + Math.round(clamp(strength, 0, 2) * (1.5 + this.params.density * 5));
    const count = Math.min(wanted, headroom);
    this.placement = this.resolvePlacement(strength);

    const plate = this.plateExtents();
    // centroid が配置の広がりを決める（明るい音ほど外へ散る）。
    const spread = (0.25 + this.smoothedCentroid * 0.7) * (0.5 + this.params.variation * 0.9);
    const clusterX = this.randRange(-plate.x * spread, plate.x * spread);
    const clusterY = this.randRange(-plate.y * spread, plate.y * spread);
    const baseAngle = this.randRange(0, TAU);
    const ringRadius = this.randRange(0.25, 0.85) * spread * 1.4;
    const flockVx = (this.rand() - 0.5) * 0.35 * this.params.motion;
    const flockVy = (this.rand() - 0.5) * 0.35 * this.params.motion;
    const groupSeconds = this.randRange(0.9, 3.4) * (0.6 + this.params.variation * 0.9);
    const groupExit = Math.floor(this.rand() * 4);
    // 「順番に」消える構成。誕生順に少しずつ寿命をずらす。
    const stagger = this.rand() < 0.45 ? this.randRange(0.02, 0.09) : 0;

    for (let i = 0; i < count; i++) {
      const kind = this.resolveShapeKind();
      const t = count > 1 ? i / (count - 1) : 0;
      let x: number;
      let y: number;
      let vx = 0;
      let vy = 0;
      const angle = baseAngle + t * TAU * (this.placement === 'spiral' ? 1.6 : 1);

      switch (this.placement) {
        case 'random':
          x = this.randRange(-plate.x * 0.92, plate.x * 0.92);
          y = this.randRange(-plate.y * 0.92, plate.y * 0.92);
          break;
        case 'radial': {
          // 中央から放射。bass が強いほど初速が速い。
          const speed =
            this.randRange(0.25, 0.85) *
            (0.4 + clamp(strength, 0, 2) * 0.5) *
            (0.6 + this.smoothedBass * 1.1) *
            (0.3 + this.params.motion * 1.4);
          const a = angle + (this.rand() - 0.5) * 0.5;
          x = Math.cos(a) * 0.02;
          y = Math.sin(a) * 0.02;
          vx = Math.cos(a) * speed;
          vy = Math.sin(a) * speed;
          break;
        }
        case 'ring':
          x = clusterX + Math.cos(angle) * ringRadius * plate.x;
          y = clusterY + Math.sin(angle) * ringRadius * plate.y;
          break;
        case 'spiral': {
          const r = ringRadius * (0.15 + t * 0.95);
          x = clusterX + Math.cos(angle) * r * plate.x;
          y = clusterY + Math.sin(angle) * r * plate.y;
          break;
        }
        case 'flock':
          x = clusterX + (this.rand() - 0.5) * plate.x * spread * 2.2;
          y = clusterY + (this.rand() - 0.5) * plate.y * spread * 2.2;
          vx = flockVx + (this.rand() - 0.5) * 0.05;
          vy = flockVy + (this.rand() - 0.5) * 0.05;
          break;
        case 'cluster':
        default:
          x = clusterX + (this.rand() - 0.5) * 0.22 * spread;
          y = clusterY + (this.rand() - 0.5) * 0.22 * spread;
          break;
      }

      // 寸法は誕生時に確定する（規則 ①）。以後は全体アーチだけが掛かる。
      const sizeGain = (0.45 + this.params.size * 1.25) * (0.75 + clamp(strength, 0, 2) * 0.3);
      const bassGain = 0.65 + this.smoothedBass * 0.9;
      const trebleShrink = 1 - this.smoothedTreble * 0.35;
      let sizeX: number;
      let sizeY: number;
      switch (kind) {
        case 'dot':
          sizeX = this.randRange(0.006, 0.017) * sizeGain * trebleShrink;
          sizeY = sizeX;
          break;
        case 'circle':
          sizeX = this.randRange(0.018, 0.075) * sizeGain * bassGain;
          sizeY = sizeX;
          break;
        case 'capsule':
          sizeY = this.randRange(0.006, 0.018) * sizeGain * bassGain;
          sizeX = sizeY * this.randRange(2.2, 6.5);
          break;
        case 'bar':
          sizeY = this.randRange(0.003, 0.011) * sizeGain * trebleShrink;
          sizeX = sizeY * this.randRange(3, 11);
          break;
        case 'ring':
        default:
          sizeX = this.randRange(0.025, 0.1) * sizeGain * bassGain;
          sizeY = sizeX;
          break;
      }

      this.shapes.push({
        kind,
        seed: this.rand(),
        x,
        y,
        vx,
        vy,
        rotation: kind === 'capsule' || kind === 'bar' ? this.randRange(0, TAU) : 0,
        rotationSpeed: (this.rand() - 0.5) * 1.1 * this.params.motion,
        sizeX,
        sizeY,
        detail:
          kind === 'ring'
            ? this.randRange(0.08, 0.3)
            : this.randRange(0.1, 0.45) * this.params.variation,
        growSeconds: this.randRange(0.07, 0.24),
        life: groupSeconds * this.randRange(0.7, 1.4) + i * stagger,
        age: 0,
        exiting: false,
        exitDelay: 0,
        exitProgress: 0,
        exitSeconds: this.randRange(0.1, 0.2),
        exitMode: this.rand() < 0.6 ? groupExit : Math.floor(this.rand() * 4),
      });
    }
  }

  // ---------------------------------------------------------------- 消滅

  /** 消滅はポップさせない。遷移に入るだけで、実際に消えるのは exitSeconds 後（規則 ④）。 */
  private retireLine(line: LineElement, delay = 0): void {
    if (line.exiting) return;
    line.exiting = true;
    line.exitDelay = delay;
    line.exitProgress = 0;
  }

  private retireShape(shape: ShapeElement, delay = 0): void {
    if (shape.exiting) return;
    shape.exiting = true;
    shape.exitDelay = delay;
    shape.exitProgress = 0;
  }

  /** クライマックス。一部または全部を順に消し、新しいシードで次の構成へ移る。 */
  private endCycle(): void {
    const full = this.rand() < 0.42;
    const fraction = full ? 1 : 0.4 + this.rand() * 0.35;
    const step = this.randRange(0.015, 0.07);
    let index = 0;
    for (const line of this.lines) {
      if (full || this.rand() < fraction) this.retireLine(line, index * step);
      index += 1;
    }
    index = 0;
    for (const shape of this.shapes) {
      if (full || this.rand() < fraction) this.retireShape(shape, index * step * 0.4);
      index += 1;
    }
    this.buildup = full ? 0 : 0.1 + this.rand() * 0.2;
    this.variationSeed += 1;
  }

  // ---------------------------------------------------------------- 進行

  private advanceLines(delta: number): void {
    const extents = this.plateExtents();
    const bound = Math.max(extents.x, extents.y) * 1.9;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i]!;

      // 位相・回転・移動。形は変わるが大きさは変わらない。
      line.phase += line.phaseSpeed * delta * (0.4 + this.smoothedMid * 1.1);
      line.rotation += line.rotationSpeed * delta;
      line.cx += line.vx * delta;
      line.cy += line.vy * delta;

      // sustain が続く限り線は維持され、伸びる。
      line.revealTarget = clamp(0.45 + this.smoothedSustain * 0.55, 0.2, 1);
      line.reveal += (line.revealTarget - line.reveal) * Math.min(delta * line.revealRate, 1);
      if (this.smoothedSustain > 0.3 && !line.exiting) {
        line.life = Math.min(line.life + delta * this.smoothedSustain * 0.9, line.maxLife);
      }

      if (line.exiting) {
        if (line.exitDelay > 0) {
          line.exitDelay -= delta;
        } else {
          line.exitProgress += delta / Math.max(line.exitSeconds, 1e-3);
          if (line.exitProgress >= 1) {
            this.lines.splice(i, 1);
            continue;
          }
        }
      } else {
        line.age += delta;
        if (line.age >= line.life) this.retireLine(line);
      }

      // 板から遠ざかりすぎた個体は畳む（外で生き続けて枠を埋めない）。
      if (Math.abs(line.cx) > bound || Math.abs(line.cy) > bound) this.retireLine(line);
    }
  }

  private advanceShapes(delta: number): void {
    const extents = this.plateExtents();
    const bound = Math.max(extents.x, extents.y) * 1.6;
    const drag = Math.exp(-delta * 1.4);
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const shape = this.shapes[i]!;
      shape.x += shape.vx * delta;
      shape.y += shape.vy * delta;
      shape.vx *= drag;
      shape.vy *= drag;
      shape.rotation += shape.rotationSpeed * delta;

      if (shape.exiting) {
        if (shape.exitDelay > 0) {
          shape.exitDelay -= delta;
        } else {
          shape.exitProgress += delta / Math.max(shape.exitSeconds, 1e-3);
          if (shape.exitProgress >= 1) {
            this.shapes.splice(i, 1);
            continue;
          }
        }
      } else {
        shape.age += delta;
        if (shape.age >= shape.life) this.retireShape(shape);
      }

      if (Math.abs(shape.x) > bound || Math.abs(shape.y) > bound) this.retireShape(shape);
    }
  }

  // ---------------------------------------------------------------- 線の頂点

  /** 中心線 1 点を求める。結果は `curve` に書く。 */
  private evaluateLine(line: LineElement, u: number, scale: number, out: number): void {
    let lx: number;
    let ly: number;
    switch (line.kind) {
      case 'wave': {
        lx = (u - 0.5) * line.length;
        const base = Math.sin(u * line.frequency * TAU + line.phase);
        const second = Math.sin(u * line.frequency * 2 * TAU + line.phase * 1.7 + 1.3);
        ly = line.amplitude * (base + line.harmonic * second);
        break;
      }
      case 'straight':
        lx = (u - 0.5) * line.length;
        ly = 0;
        break;
      case 'orbit': {
        const theta = u * TAU * line.loops + line.phase;
        lx = line.radiusX * Math.sin(line.ratioA * theta + line.delta);
        ly = line.radiusY * Math.sin(line.ratioB * theta);
        break;
      }
      case 'freeform':
      default: {
        const theta = u * TAU + line.phase;
        lx =
          line.hx[0] * Math.sin(theta + line.px[0]) * 0.45 +
          line.hx[1] * Math.sin(2 * theta + line.px[1]) * 0.26 +
          line.hx[2] * Math.sin(3 * theta + line.px[2]) * 0.15;
        ly =
          line.hy[0] * Math.sin(theta + line.py[0]) * 0.45 +
          line.hy[1] * Math.sin(2 * theta + line.py[1]) * 0.26 +
          line.hy[2] * Math.sin(3 * theta + line.py[2]) * 0.15;
        break;
      }
    }
    const cos = Math.cos(line.rotation);
    const sin = Math.sin(line.rotation);
    this.curve[out] = line.cx + (lx * cos - ly * sin) * scale;
    this.curve[out + 1] = line.cy + (lx * sin + ly * cos) * scale;
  }

  /**
   * 線をリボンへ焼く。幅は平滑した音量からの全体値 × 誕生時の偏りで、
   * 生きている線の大きさを音が直接動かすことはない（規則 ①）。
   */
  private writeLines(arch: number, baseHalfWidth: number): void {
    const count = Math.min(this.lines.length, MAX_LINES);
    for (let index = 0; index < count; index++) {
      const line = this.lines[index]!;
      const base = index * VERTS_PER_LINE;

      // 消滅の遷移（規則 ④）。縮む／頭から短く／尾から短く／画面外へ。
      const exit = line.exiting && line.exitDelay <= 0 ? smoothstep01(line.exitProgress) : 0;
      let spanStart = 0;
      let spanEnd = Math.max(line.reveal, 0.02);
      let scale = line.sizeBias * arch;
      let widthMul = 1;
      let alphaMul = 1;
      let offsetX = 0;
      let offsetY = 0;
      if (exit > 0) {
        switch (line.exitMode) {
          case 0:
            spanEnd = Math.max(spanEnd * (1 - exit), 0.01);
            widthMul = 1 - exit * exit * 0.75;
            break;
          case 1:
            spanStart = spanEnd * exit * 0.99;
            widthMul = 1 - exit * exit * 0.75;
            break;
          case 2:
            // 縮む線は太さも一緒に絞る。太さだけ残ると縮退した染みになる。
            scale *= 1 - exit;
            widthMul = 1 - exit;
            break;
          default: {
            const away = Math.atan2(line.cy, line.cx || 1e-4);
            offsetX = Math.cos(away) * exit * exit * 2.4;
            offsetY = Math.sin(away) * exit * exit * 2.4;
            alphaMul = 1 - smoothstep01((exit - 0.6) / 0.4);
            break;
          }
        }
        alphaMul *= 1 - exit * exit * exit * 0.35;
      }

      // 誕生の立ち上がり。太さと明るさだけが上がる（形は最初から確定している）。
      const birth = line.exiting ? 1 : smoothstep01(line.age / 0.28);
      const half = baseHalfWidth * line.widthBias * widthMul * (0.35 + birth * 0.65);
      const alpha = clamp(alphaMul * (0.35 + birth * 0.65), 0, 1);

      // 中心線をまとめて求めてから、隣の点との差で法線を出す。
      const step = (spanEnd - spanStart) / (LINE_POINTS - 1);
      for (let i = 0; i < LINE_POINTS; i++) {
        this.evaluateLine(line, spanStart + step * i, scale, i * 2);
      }

      // 初期の法線は線全体の弦から取る。先頭が縮退していても向きが決まる。
      let normalX = 0;
      let normalY = 1;
      const chordX = this.curve[(LINE_POINTS - 1) * 2]! - this.curve[0]!;
      const chordY = this.curve[(LINE_POINTS - 1) * 2 + 1]! - this.curve[1]!;
      const chordLength = Math.hypot(chordX, chordY);
      if (chordLength > 1e-6) {
        normalX = -chordY / chordLength;
        normalY = chordX / chordLength;
      }

      for (let i = 0; i < LINE_POINTS; i++) {
        const prev = Math.max(i - 1, 0);
        const next = Math.min(i + 1, LINE_POINTS - 1);
        const tx = this.curve[next * 2]! - this.curve[prev * 2]!;
        const ty = this.curve[next * 2 + 1]! - this.curve[prev * 2 + 1]!;
        const length = Math.hypot(tx, ty);
        // 縮退（点が重なった区間）では向きが数値ノイズで暴れる。閾値を下回ったら
        // 直前の法線を保つ。閾値を小さくしすぎると扇形の破綻になる。
        if (length > 1e-4) {
          let nx = -ty / length;
          let ny = tx / length;
          // 曲線が折り返す点（尖点）では法線が 180° 跳ぶ。そのまま使うとリボンが
          // ねじれて楔形の破綻が出るので、直前の向きに揃えておく。
          if (i > 0 && nx * normalX + ny * normalY < 0) {
            nx = -nx;
            ny = -ny;
          }
          normalX = nx;
          normalY = ny;
        }
        // 端はわずかに細める（切り口が四角く見えない）。長い線では端の減衰が
        // 広く伸びて滲みに見えるので、幅も不透明度もごく短い区間だけで落とす。
        const f = i / (LINE_POINTS - 1);
        const taper = 0.72 + 0.28 * Math.pow(Math.sin(Math.PI * clamp(f, 0, 1)), 0.35);
        const w = half * taper;
        const fade = smoothstep01(f / 0.02) * smoothstep01((1 - f) / 0.02);

        const x = this.curve[i * 2]! + offsetX;
        const y = this.curve[i * 2 + 1]! + offsetY;
        const v0 = (base + i * 2) * 3;
        const v1 = v0 + 3;
        this.linePositions[v0] = x + normalX * w;
        this.linePositions[v0 + 1] = y + normalY * w;
        this.linePositions[v0 + 2] = 0;
        this.linePositions[v1] = x - normalX * w;
        this.linePositions[v1 + 1] = y - normalY * w;
        this.linePositions[v1 + 2] = 0;
        this.lineHalfWidths[base + i * 2] = w;
        this.lineHalfWidths[base + i * 2 + 1] = w;
        this.lineAlphas[base + i * 2] = alpha * fade;
        this.lineAlphas[base + i * 2 + 1] = alpha * fade;
      }
    }

    if (this.lineGeometry) {
      this.lineGeometry.setDrawRange(0, count * INDICES_PER_LINE);
      const positions = this.lineGeometry.getAttribute('position');
      positions.needsUpdate = true;
      this.lineGeometry.getAttribute('aHalf').needsUpdate = true;
      this.lineGeometry.getAttribute('aAlpha').needsUpdate = true;
    }
    if (this.lineMesh) this.lineMesh.visible = count > 0 && this.params.lineAmount > 0.001;
  }

  private writeShapes(arch: number): void {
    const mesh = this.shapeMesh;
    if (!mesh) return;
    const count = Math.min(this.shapes.length, MAX_SHAPES);
    for (let i = 0; i < count; i++) {
      const shape = this.shapes[i]!;
      const exit = shape.exiting && shape.exitDelay <= 0 ? smoothstep01(shape.exitProgress) : 0;
      const grow = shape.exiting ? 1 : 1 - Math.pow(1 - clamp(shape.age / shape.growSeconds, 0, 1), 3);

      let scaleX = shape.sizeX * arch * grow;
      let scaleY = shape.sizeY * arch * grow;
      let opacity = 1;
      let x = shape.x;
      let y = shape.y;

      if (exit > 0) {
        switch (shape.exitMode) {
          case 0:
            scaleX *= 1 - exit;
            scaleY *= 1 - exit;
            break;
          case 1: {
            // 画面外へ抜ける。速度の向きへそのまま伸ばす。
            const speed = Math.hypot(shape.vx, shape.vy);
            const dirX = speed > 1e-4 ? shape.vx / speed : Math.cos(shape.seed * TAU);
            const dirY = speed > 1e-4 ? shape.vy / speed : Math.sin(shape.seed * TAU);
            x += dirX * exit * exit * 1.6;
            y += dirY * exit * exit * 1.6;
            scaleX *= 1 - exit * 0.3;
            scaleY *= 1 - exit * 0.3;
            opacity = 1 - smoothstep01((exit - 0.55) / 0.45);
            break;
          }
          case 2:
            opacity = 1 - exit;
            break;
          default:
            // 縮んで一本の線になる。
            scaleX *= 1 - exit;
            scaleY *= 1 - exit * 0.15;
            opacity = 1 - smoothstep01((exit - 0.7) / 0.3);
            break;
        }
      }

      // クアッドは SDF の外周と縁の柔らかさぶんだけ余白を持たせる。
      const padX = Math.max(scaleX * 1.15, scaleX + 0.006);
      const padY = Math.max(scaleY * 1.15, scaleY + 0.006);
      this.instancePosition.set(x, y, 0);
      this.instanceQuaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), shape.rotation);
      this.instanceScale.set(padX, padY, 1);
      this.instanceMatrix.compose(
        this.instancePosition,
        this.instanceQuaternion,
        this.instanceScale,
      );
      mesh.setMatrixAt(i, this.instanceMatrix);

      this.shapeTypes[i] = SHAPE_KINDS.indexOf(shape.kind);
      this.shapeOpacities[i] = clamp(opacity, 0, 1);
      this.shapeSizes[i * 2] = padX;
      this.shapeSizes[i * 2 + 1] = padY;
      this.shapeDetails[i] = shape.detail;
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    const geometry = mesh.geometry;
    geometry.getAttribute('aType').needsUpdate = true;
    geometry.getAttribute('aOpacity').needsUpdate = true;
    geometry.getAttribute('aSize').needsUpdate = true;
    geometry.getAttribute('aDetail').needsUpdate = true;
    mesh.visible = count > 0 && this.params.shapeAmount > 0.001;
  }

  // ---------------------------------------------------------------- update

  update(elapsed: number): void {
    if (!this.context || !this.pipeline) return;
    const audio = this.context.audioEngine.getParameters();
    const active = audio.active === 1;

    const delta =
      this.previousElapsed < 0
        ? 0
        : Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.05);
    this.previousElapsed = elapsed;

    if (!active) {
      // D5: 無音では黒。発生も動きもない（要素は保持したまま止める）。
      if (this.lineMesh) this.lineMesh.visible = false;
      if (this.shapeMesh) this.shapeMesh.visible = false;
      this.pipeline.update(audio, elapsed);
      return;
    }

    this.smooth(audio, delta);

    // 反応の調整（D24）: 帯域ごとのゲイン。
    const bass = clamp01(audio.bass);
    const mid = clamp01(audio.mid);
    const treble = clamp01(audio.treble);
    const bandTotal = bass + mid + treble;
    const bandWeight =
      bandTotal > 1e-4
        ? (this.response.bass * bass + this.response.mid * mid + this.response.treble * treble) /
          bandTotal
        : 1;

    this.advanceTime(audio, delta);
    this.advanceLines(delta);
    this.advanceShapes(delta);
    this.enforceTargets(delta);

    // 連続量はすべて平滑を通す（規則 ①）。
    const arch = 0.82 + this.smoothedVolume * 0.36;
    const halfWidth =
      (0.0035 + this.params.size * 0.019) *
      (0.55 + this.smoothedVolume * 0.9) *
      clamp(bandWeight, 0.3, 1.8);

    this.writeLines(arch, halfWidth);
    this.writeShapes(arch);
    this.pipeline.update(audio, elapsed);
  }

  private smooth(audio: AudioParameters, delta: number): void {
    const follow = (current: number, target: number, tau: number): number =>
      current + (target - current) * Math.min(delta / tau, 1);
    // 太さ・明るさに効く量は 1.8 秒。音量の揺れが像の量に出ないようにする。
    this.smoothedVolume = follow(this.smoothedVolume, clamp01(audio.volume), 1.8);
    this.smoothedBass = follow(this.smoothedBass, clamp01(audio.bass), 0.9);
    this.smoothedMid = follow(this.smoothedMid, clamp01(audio.mid), 0.9);
    this.smoothedTreble = follow(this.smoothedTreble, clamp01(audio.treble), 0.7);
    this.smoothedCentroid = follow(this.smoothedCentroid, clamp01(audio.centroid), 0.6);
    this.smoothedPitch = follow(this.smoothedPitch, clamp01(audio.pitch), 0.5);
    this.smoothedSustain = follow(this.smoothedSustain, clamp01(audio.sustain), 0.4);
    this.smoothedFlatness = follow(this.smoothedFlatness, clamp01(audio.flatness), 1.2);
    if (typeof audio.seed === 'number' && Number.isFinite(audio.seed)) {
      this.audioSeed = audio.seed;
    }
  }

  /**
   * 時間構造。固定周期は持たず、エネルギーとオンセットで buildup が溜まる。
   * 満ちるとクライマックスとして消去が起き、次の構成が始まる。
   */
  private advanceTime(audio: AudioParameters, delta: number): void {
    const complexity = 0.55 + this.params.complexity * 0.9;
    this.buildup += delta * (0.012 + this.smoothedVolume * 0.075) * complexity;

    const strength = this.detectEvent(audio, delta);
    if (strength > 0) {
      this.buildup += 0.01 * strength * complexity;
      if (this.shapesEnabled) this.spawnShapeBurst(strength);
      if (this.linesEnabled && this.rand() < 0.35 + strength * 0.3) this.spawnLine(strength);
    }

    // 持続音は線を呼ぶ。オンセットがなくても、鳴り続けていれば線は増える。
    this.lineTimer -= delta;
    if (this.linesEnabled && this.lineTimer <= 0) {
      if (this.smoothedSustain > 0.2 || this.smoothedVolume > 0.1) {
        this.spawnLine(0.5 + this.smoothedSustain);
      }
      this.lineTimer = 0.3 + (1 - this.smoothedSustain) * 1.3;
    }

    if (this.buildup >= 1) this.endCycle();
  }

  /**
   * オンセット検出（規則 ②）。不応時間とトークン制で 1 拍あたりの上限を作る。
   * 返り値は 0（イベントなし）または 0 より大きい強度。
   */
  private detectEvent(audio: AudioParameters, delta: number): number {
    this.spawnCooldown = Math.max(this.spawnCooldown - delta, 0);
    this.eventTokens = Math.min(
      this.eventTokens + delta * (1.4 + this.params.density * 4.2),
      3,
    );

    const onset = clamp01(audio.onset);
    const beat = clamp01(audio.beat);
    const rising = onset > this.previousOnset + 0.005;
    this.previousOnset = onset;

    const sensitivity = clamp(this.params.sensitivity, 0, 1);
    const threshold = 0.46 - sensitivity * 0.36;
    const trigger = Math.max(onset, beat * 0.7);
    if (this.spawnCooldown > 0 || this.eventTokens < 1) return 0;
    if (trigger < threshold) return 0;
    if (!rising && beat < 0.5) return 0;

    this.eventTokens -= 1;
    this.spawnCooldown = 0.06 + (1 - this.smoothedVolume) * 0.2;
    return clamp(trigger * (0.7 + this.smoothedVolume * 0.8), 0.05, 2);
  }

  /**
   * 目標を超えた分だけを静かに畳む。目標は buildup の単調増加関数なので、
   * ここが働くのは「区切り」か「つまみを絞ったとき」だけになる（規則 ③）。
   */
  private enforceTargets(delta: number): void {
    this.retireTimer -= delta;
    if (this.retireTimer > 0) return;
    this.retireTimer = 0.12;

    const lineTarget = this.targetLineCount();
    const liveLines = this.lines.filter((line) => !line.exiting);
    if (liveLines.length > lineTarget && liveLines.length > 0) {
      let oldest = liveLines[0]!;
      for (const line of liveLines) if (line.age > oldest.age) oldest = line;
      this.retireLine(oldest);
    }

    const shapeTarget = this.targetShapeCount();
    const liveShapes = this.shapes.filter((shape) => !shape.exiting);
    if (liveShapes.length > shapeTarget && liveShapes.length > 0) {
      let oldest = liveShapes[0]!;
      for (const shape of liveShapes) if (shape.age > oldest.age) oldest = shape;
      this.retireShape(oldest);
    }
  }

  render(): void {
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    this.canvasHeight = Math.max(height, 1);
    this.syncCamera();
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
    this.syncColor();
  }

  getZoom(): number {
    return this.zoom;
  }

  /** ズームは開発用（D17）。表示の尺度だけを変え、生成には触らない。 */
  setZoom(zoom: number): void {
    this.zoom = clamp(zoom, 0.25, 8);
    this.syncCamera();
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
    this.syncCamera();
    // 板の形が変われば居場所も変わる。外へ出た要素は縁へ寄せる。
    const extents = this.plateExtents();
    for (const line of this.lines) {
      line.cx = clamp(line.cx, -extents.x, extents.x);
      line.cy = clamp(line.cy, -extents.y, extents.y);
    }
    for (const shape of this.shapes) {
      shape.x = clamp(shape.x, -extents.x, extents.x);
      shape.y = clamp(shape.y, -extents.y, extents.y);
    }
  }

  setDebugView(): void {
    // この表現に切り替える可視化はない。
  }

  /** モード励起はこの表現にはない（PRD D25）。 */
  getDebugState(): null {
    return null;
  }

  /** 奥行きは持たない（PRD D25）。 */
  getDepth(): number {
    return 0;
  }

  setDepth(): void {
    // 奥行きは持たない。
  }

  getPhase(): string {
    return `lines ${this.lines.length} / shapes ${this.shapes.length} / density ${this.buildup.toFixed(
      2,
    )} / ${this.placement}`;
  }

  // ---------------------------------------------------------------- 表現ごとの調整

  getExpressionParams(): ExpressionParam[] {
    return [
      {
        type: 'select',
        key: 'mode',
        label: 'Mode',
        value: this.mode,
        options: [
          { value: 'lines', label: 'Lines' },
          { value: 'shapes', label: 'Shapes' },
          { value: 'hybrid', label: 'Hybrid' },
        ],
      },
      {
        type: 'select',
        key: 'lineType',
        label: 'Line Type',
        value: this.lineType,
        options: [
          { value: 'wave', label: 'Wave' },
          { value: 'straight', label: 'Straight' },
          { value: 'orbit', label: 'Orbit' },
          { value: 'freeform', label: 'Freeform' },
          { value: 'mixed', label: 'Mixed' },
        ],
      },
      {
        type: 'select',
        key: 'shapeType',
        label: 'Shape Type',
        value: this.shapeType,
        options: [
          { value: 'dot', label: 'Dot' },
          { value: 'circle', label: 'Circle' },
          { value: 'capsule', label: 'Capsule' },
          { value: 'bar', label: 'Bar' },
          { value: 'ring', label: 'Ring' },
          { value: 'mixed', label: 'Mixed' },
        ],
      },
      {
        key: 'lineAmount',
        label: 'Line Amount',
        min: 0,
        max: 1,
        step: 0.01,
        value: this.params.lineAmount,
      },
      {
        key: 'shapeAmount',
        label: 'Shape Amount',
        min: 0,
        max: 1,
        step: 0.01,
        value: this.params.shapeAmount,
      },
      { key: 'size', label: 'Size', min: 0, max: 1, step: 0.01, value: this.params.size },
      { key: 'density', label: 'Density', min: 0, max: 1, step: 0.01, value: this.params.density },
      { key: 'motion', label: 'Motion', min: 0, max: 1, step: 0.01, value: this.params.motion },
      {
        key: 'complexity',
        label: 'Complexity',
        min: 0,
        max: 1,
        step: 0.01,
        value: this.params.complexity,
      },
      {
        key: 'variation',
        label: 'Variation',
        min: 0,
        max: 1,
        step: 0.01,
        value: this.params.variation,
      },
      {
        key: 'sensitivity',
        label: 'Sensitivity',
        min: 0,
        max: 1,
        step: 0.01,
        value: this.params.sensitivity,
      },
      { key: 'seed', label: 'Seed', min: 0, max: 1, step: 0.001, value: this.params.seed },
      { type: 'action', key: 'clear', label: 'Clear' },
      { type: 'action', key: 'newVariation', label: 'New Variation' },
    ];
  }

  /**
   * 調整はすべて実行中に効き、生成は再起動しない。
   * Mode と型の変更は**これから生まれる要素**にだけ効く。生きている要素は作り替えず、
   * 無効になった系統は消滅の遷移を通ってから消える（ポップしない）。
   */
  setExpressionParam(key: string, value: number | string): void {
    if (key === 'mode') {
      if (value === 'lines' || value === 'shapes' || value === 'hybrid') {
        if (this.mode === value) return;
        this.mode = value;
        // 無効になった系統は静かに畳む。有効になった系統は次のイベントから加わる。
        if (this.mode === 'lines') this.retireAllShapes();
        if (this.mode === 'shapes') this.retireAllLines();
      }
      return;
    }
    if (key === 'lineType') {
      if ((LINE_KINDS as readonly string[]).includes(value as string) || value === 'mixed') {
        this.lineType = value as LineTypeId;
      }
      return;
    }
    if (key === 'shapeType') {
      if ((SHAPE_KINDS as readonly string[]).includes(value as string) || value === 'mixed') {
        this.shapeType = value as ShapeTypeId;
      }
      return;
    }
    if (key === 'clear') {
      this.clearAll();
      return;
    }
    if (key === 'newVariation') {
      this.newVariation();
      return;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    if (key in this.params) {
      (this.params as Record<string, number>)[key] = clamp(value, 0, 1);
    }
  }

  private retireAllLines(): void {
    let index = 0;
    for (const line of this.lines) {
      this.retireLine(line, index * 0.02);
      index += 1;
    }
  }

  private retireAllShapes(): void {
    let index = 0;
    for (const shape of this.shapes) {
      this.retireShape(shape, index * 0.008);
      index += 1;
    }
  }

  /** Clear: いま出ているものを即座に消す。次の音から作り直す。 */
  private clearAll(): void {
    this.lines.length = 0;
    this.shapes.length = 0;
    this.buildup = 0;
    this.lineTimer = 0;
    if (this.lineGeometry) this.lineGeometry.setDrawRange(0, 0);
    if (this.lineMesh) this.lineMesh.visible = false;
    if (this.shapeMesh) {
      this.shapeMesh.count = 0;
      this.shapeMesh.visible = false;
    }
  }

  /** New Variation: シードを変えて新しい構成を始める。 */
  private newVariation(): void {
    this.variationSeed += 1;
    this.rngCounter = 0;
    this.clearAll();
  }

  setGeneratorsVisible(): void {
    // 表現の表示切り替えは存在しない。
  }

  setDesignLayerCanvases(canvases: DesignLayerCanvases): void {
    this.pipeline?.setOverlayCanvases(canvases);
  }

  updateDesignLayerCanvases(): void {
    this.pipeline?.updateOverlayCanvases();
  }

  dispose(): void {
    this.pipeline?.dispose();
    this.shapeMesh?.dispose();
    this.shapeGeometry?.dispose();
    this.shapeMaterial?.dispose();
    this.lineGeometry?.dispose();
    this.lineMaterial?.dispose();
    this.scene?.clear();
    this.lines.length = 0;
    this.shapes.length = 0;
    this.pipeline = null;
    this.shapeMesh = null;
    this.shapeGeometry = null;
    this.shapeMaterial = null;
    this.lineMesh = null;
    this.lineGeometry = null;
    this.lineMaterial = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
  }
}
