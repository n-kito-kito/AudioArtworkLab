import * as THREE from 'three';
import type {
  CompositionContext,
  DesignLayerCanvases,
} from '../compositions/Composition';
import type { AudioParameters } from '../audio/AudioEngine';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { ExpressionParam, LabExpression } from './Expression';

/**
 * Light Traces — Transient Optical Event System。
 *
 * **基準状態は暗闇である。** 画面は既定では黒く、光は「出来事」としてだけ現れる。
 * 強い光を常に増やすのではなく、**ほとんどを小さな光にして、強い光を稀にする**ことで
 * 強さを感じさせる。完全な暗闇のフレームが存在してよい（むしろ必要）。
 *
 * ここは「放射状の星形を画面に撒く（Radial Star Emitter）」ではない。
 * 均一なセル格子で小さな光を全面に撒く構造は星空になるため持たない。
 *
 * 構造:
 *   ① 発生（自己励起点過程 / Hawkes）
 *        均一な発生レートを持たない。1 つの発火が次の発火を呼び、やがて収まって
 *        静寂に戻る。λ(t) = μ + excitation、発火のたび excitation += α、
 *        時定数 EXCITATION_TAU で減衰する。分岐比 n = α·τ < 1 なので
 *        クラスターは必ず終わる。音のオンセットは excitation を跳ね上げて
 *        クラスターの起点になるが、クラスター内の連なりは音と独立に進む。
 *        結果として
 *        「暗い → 小さな光が数回 → 間 → 強い光が一度 → 細い軌跡 → 別の場所で連続 → 再び暗く」
 *        という時間構造になる。
 *   ② イベント種別（5 種）
 *        Spark 70% / Directional Flash 20% / Moving Trace 8% / Volumetric Flare 2%、
 *        および強い発光の**後にだけ**派生する Scattered Fragment。
 *   ③ 形の非対称
 *        主光条 1〜2 本 + 弱い副光条 0〜3 本。左右の長さを揃えず、角度も等間隔にしない。
 *        十字形・六方向形を基本形にしない。構造は光源ごとにシードで変える。
 *   ④ 層ごとに異なる時定数（全体を Opacity で消さない）
 *        Core 50〜150ms / Streak 100〜400ms / Trail 300ms〜1s / Haze 500ms〜2s。
 *   ⑤ 霧
 *        霧自体は発光しない。暗い霧があり、光が通った領域だけが一瞬見え、
 *        光が消えれば霧も見えなくなる。円形に囲まず、光の進行方向へ細長い。
 *        弱いイベントではほぼ見せず、強い光でだけ層・膜として浮かぶ。
 *
 * つまみ（PRD D25）:
 *   Trail / Sensitivity / Density / Intensity / Speed /
 *   Sharpness / Color / Fog / Fog Spread / Placement / Seed
 *
 * 音との対応（PRD §7。この表現での解釈）:
 *   onset      → クラスターの起点（自己励起へ加算）
 *   volume     → 背景レートと明るさをゆるやかに動かす（常時明るくはしない）
 *   flareDrive → Volumetric Flare（flareDrive() 参照。Response が帯域感度になる）
 *   bass       → 光条と霧を長く太く
 *   mid        → Moving Trace の曲がり
 *   treble     → Spark の細かさ
 *   centroid   → 色相の基準（低 = 青紫 / 高 = シアン）
 *   無音（active !== 1）は黒・発生ゼロ（D5）。
 *
 * 乱数は決定論ハッシュのみ。Math.random() は使わない。
 */

/** 同時に生きられるイベントの上限。寿命が短いので通常はこれを大きく下回る。 */
const MAX_LIGHTS = 28;

/** 光条スロットの上限（主 1〜2 + 副 0〜3）。 */
const MAX_RAYS = 5;

/** フィードバックバッファの長辺上限。 */
const MAX_BUFFER_EDGE = 1600;

/** Trail スライダー → 残る時間（秒）。 */
const TRAIL_ANCHORS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.25, 0.15],
  [0.5, 0.7],
  [0.75, 2],
  [1, 6.5],
];

/** 1% まで落ちるのを「消えた」とみなす（exp(-4.6) ≈ 0.01）。 */
const DECAY_DEPTH = 4.6;

/** 自己励起の減衰時定数（秒）。クラスターの長さを決める。 */
const EXCITATION_TAU = 0.32;

const clamp01 = (value: number | undefined): number => Math.min(Math.max(value ?? 0, 0), 1);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * イベント種別。1 種類の光源にしない。
 *   spark     小さく鋭い点。寿命が非常に短い。軌跡ほぼなし
 *   flash     強い芯 + 1〜2 方向へ長い光条。瞬間的
 *   trace     短時間だけ移動し細い軌跡が残る（移動が起きるのはここだけ）
 *   flare     霧や薄い膜を照らす。面・帯として広がる。余韻が長い
 *   fragment  強い発光の後にだけ派生する破片
 */
type LightKind = 'spark' | 'flash' | 'trace' | 'flare' | 'fragment';

interface LightSource {
  kind: LightKind;
  x: number;
  y: number;
  px: number;
  py: number;
  /** 軌跡の起点（移動履歴の始まり）。 */
  trailX: number;
  trailY: number;
  heading: number;
  curl: number;
  speed: number;
  age: number;
  /** 層ごとに異なる時定数（秒）。同時にフェードさせない。 */
  coreLife: number;
  streakLife: number;
  trailLife: number;
  hazeLife: number;
  coreAttack: number;
  peak: number;
  color: THREE.Color;
  coreSize: number;
  hazeRadius: number;
  hazeAxis: number;
  rayAngle: number;
  rayCount: number;
  rayLength: number;
  rayThin: number;
  /** 光条の左右非対称（0.5 で対称。両端に寄るほど片側だけ伸びる）。 */
  rayAsym: number;
  trailWidth: number;
  trailCurve: number;
  seed: number;
}

export class LightTraces implements LabExpression {
  readonly animated = true;
  readonly name = 'Light Traces';
  readonly id: ExpressionId = 'light-traces-v1';

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  /**
   * 表現ごとの調整（PRD D25）。
   *
   * **この既定値そのものが唯一の見え方である。** つまみは UI から出していないため、
   * ここは「調整の初期位置」ではなく確定した設計値として扱う。
   *
   * 選定の根拠（合成信号 12 秒 × 各候補で実測し、ピークと静寂のフレームを見比べた）:
   *   placement 0.15 — 0.55（全面散布）と 1.0（一様）も見たが、
   *     0.15 は発生が画面中央の横帯へ寄り、Ref1 の横帯の構図に最も近い。
   *     全面散布は出来事が散って構図にならず、一様は暗すぎて像が立たない。
   *   trail 0.35（≒0.37s）— 0.50（0.7s）も見たが、そちらは光条の残りが重なって
   *     「レンズフレアの散らかり」に戻ってしまう。0.35 は静寂のフレームに
   *     細い軌跡が 1 本だけ残る状態を作れる。
   *   fog 0.40 — 強い光のときだけ進行方向へ細長い膜が浮かぶ量。0.28 では膜が見えず、
   *     0.55 以上では膜が常時見えて暗闇が壊れる。
   *   sharpness 0.70 — 芯が白く飽和し、周りの色づきが小さく収まる位置。
   *   color 0.45 — 実測の彩度中央値 0.24〜0.34 でリファレンス（0.24〜0.35）と一致する。
   *   speed 0 — 移動は Moving Trace（8%）の内部移動だけ。
   */
  private params = {
    trail: 0.35,
    sensitivity: 0.55,
    density: 0.5,
    intensity: 0.6,
    speed: 0,
    sharpness: 0.7,
    color: 0.45,
    fog: 0.4,
    fogSpread: 0.35,
    placement: 0.15,
    seed: 0.31,
  };

  private context: CompositionContext | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private emitScene: THREE.Scene | null = null;
  private displayScene: THREE.Scene | null = null;
  private emitGeometry: THREE.PlaneGeometry | null = null;
  private displayGeometry: THREE.PlaneGeometry | null = null;
  private emitMaterial: THREE.ShaderMaterial | null = null;
  private displayMaterial: THREE.ShaderMaterial | null = null;
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private current = 0;
  private needsClear = true;
  private pipeline: EffectPipeline | null = null;

  private bufferWidth = 512;
  private bufferHeight = 512;

  private readonly lights: LightSource[] = [];
  private readonly lightA = new Float32Array(MAX_LIGHTS * 4);
  private readonly lightB = new Float32Array(MAX_LIGHTS * 4);
  private readonly lightC = new Float32Array(MAX_LIGHTS * 4);
  private readonly lightD = new Float32Array(MAX_LIGHTS * 4);
  private readonly lightE = new Float32Array(MAX_LIGHTS * 4);
  private readonly lightF = new Float32Array(MAX_LIGHTS * 4);

  private previousElapsed = -1;
  /** 自己励起の強度。発火のたび跳ね上がり、時定数で減衰してクラスターを作る。 */
  private excitation = 0;
  private smoothedVolume = 0;
  private smoothedCentroid = 0.5;
  private smoothedBass = 0;
  private smoothedMid = 0;
  private smoothedTreble = 0;
  private previousOnset = 0;
  private rngCounter = 0;
  private audioSeed = 0;
  private lastFlareDrive = 0;
  /** フレアの冷却。稀さを保つために連続発火を止める。 */
  private flareCooldown = 0;

  // ---- 検証用の統計 ----
  private eventTally: Record<LightKind, number> = {
    spark: 0,
    flash: 0,
    trace: 0,
    flare: 0,
    fragment: 0,
  };
  private lastEventTime = -1;
  private elapsedNow = 0;
  private readonly intervals: number[] = [];

  constructor(effects: Effect[] = [], theme?: Theme) {
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
  }

  // ---------------------------------------------------------------- 決定論乱数

  private rand(): number {
    this.rngCounter += 1;
    const x =
      Math.sin(
        this.rngCounter * 12.9898 + this.audioSeed * 78.233 + this.params.seed * 311.7 + 0.5,
      ) * 43758.5453;
    return x - Math.floor(x);
  }

  private randRange(min: number, max: number): number {
    return min + (max - min) * this.rand();
  }

  private randNormal(): number {
    const u = Math.max(this.rand(), 1e-6);
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Poisson 乱数（Knuth）。決定論ハッシュの列から引く。 */
  private randPoisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 12) {
      // 大きい λ では正規近似（バースト時に反復が伸びるのを避ける）。
      return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.randNormal()));
    }
    const target = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k += 1;
      p *= this.rand();
    } while (p > target && k < 64);
    return k - 1;
  }

  // ---------------------------------------------------------------- 板の寸法

  private plateExtents(): { x: number; y: number } {
    const s = Math.sqrt(Math.max(this.aspectRatio, 1e-6));
    return { x: s, y: 1 / s };
  }

  // ---------------------------------------------------------------- Trail

  private trailSeconds(): number {
    const t = clamp(this.params.trail, 0, 1);
    for (let i = 1; i < TRAIL_ANCHORS.length; i++) {
      const [x1, y1] = TRAIL_ANCHORS[i]!;
      const [x0, y0] = TRAIL_ANCHORS[i - 1]!;
      if (t <= x1) return y0 + ((y1 - y0) * (t - x0)) / Math.max(x1 - x0, 1e-6);
    }
    return TRAIL_ANCHORS[TRAIL_ANCHORS.length - 1]![1];
  }

  private decayFor(delta: number): number {
    const hold = this.trailSeconds();
    if (hold <= 1e-4) return 0;
    return Math.exp((-DECAY_DEPTH * delta) / hold);
  }

  // ---------------------------------------------------------------- setup

  setup(context: CompositionContext): void {
    this.context = context;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;

    this.createTargets(this.bufferWidth, this.bufferHeight);

    this.emitMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tPrev: { value: null },
        uDecay: { value: 0 },
        uGain: { value: 1 },
        uClear: { value: 1 },
        uPlate: { value: new THREE.Vector2(1, 1) },
        uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        uLightCount: { value: 0 },
        uLightA: { value: this.lightA },
        uLightB: { value: this.lightB },
        uLightC: { value: this.lightC },
        uLightD: { value: this.lightD },
        uLightE: { value: this.lightE },
        uLightF: { value: this.lightF },
        uMaxAccum: { value: 24 },
        uCoreGain: { value: 2.4 },
        uHaloGain: { value: 1 },
        uCoreWhite: { value: 0.8 },
        uPrism: { value: 0.18 },
        uFog: { value: 0 },
        uSpreadMix: { value: 0 },
        uSpreadRadius: { value: 0 },
        uDrift: { value: new THREE.Vector2(0, 0) },
        uBandPull: { value: 0 },
        uTime: { value: 0 },
        uSeed: { value: 0.31 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tPrev;
        uniform float uDecay;
        uniform float uGain;
        uniform float uClear;
        uniform vec2 uPlate;
        uniform vec2 uTexel;
        uniform float uLightCount;
        uniform vec4 uLightA[${MAX_LIGHTS}];
        uniform vec4 uLightB[${MAX_LIGHTS}];
        uniform vec4 uLightC[${MAX_LIGHTS}];
        uniform vec4 uLightD[${MAX_LIGHTS}];
        uniform vec4 uLightE[${MAX_LIGHTS}];
        uniform vec4 uLightF[${MAX_LIGHTS}];
        uniform float uMaxAccum;
        uniform float uCoreGain;
        uniform float uHaloGain;
        uniform float uCoreWhite;
        uniform float uPrism;
        uniform float uFog;
        uniform float uSpreadMix;
        uniform float uSpreadRadius;
        uniform vec2 uDrift;
        uniform float uBandPull;
        uniform float uTime;
        uniform float uSeed;

        const float PI = 3.141592653589793;

        float hash1(float p) {
          return fract(sin(p * 127.1 + uSeed * 97.3) * 43758.5453);
        }
        vec2 hash2(vec2 p) {
          return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))
            + uSeed * 97.3) * 43758.5453);
        }
        /** 1 次元の値ノイズ。軌跡に沿った明暗・太さの変化に使う。 */
        float vnoise(float x) {
          float i = floor(x), f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(hash1(i), hash1(i + 1.0), f);
        }

        float haloTerm(float r2, float radius) {
          float s = max(radius * radius, 1e-8);
          float t = s / (s + r2);
          return t * t;
        }

        void main() {
          vec2 p = (vUv * 2.0 - 1.0) * uPlate;

          vec3 emit = vec3(0.0);
          // 散乱の照度。霧は自ら光らないので「いま光があること」だけがこれを立てる。
          vec3 irradiance = vec3(0.0);

          for (int i = 0; i < ${MAX_LIGHTS}; i++) {
            if (float(i) >= uLightCount) break;
            vec4 a = uLightA[i];  // xy = 位置 / z = Core の包絡 / w = 芯の半径
            vec4 b = uLightB[i];  // rgb = 色 / w = 霧の半径
            vec4 c = uLightC[i];  // x = 主光条の角 / y = 長さ / z = 細さ / w = Streak の包絡
            vec4 d = uLightD[i];  // xy = 前フレーム位置 / z = 光条の本数 / w = 左右非対称
            vec4 e = uLightE[i];  // xy = 軌跡の起点 / z = Trail の包絡 / w = 軌跡の太さ
            vec4 f = uLightF[i];  // x = Haze の包絡 / y = 個体シード / z = 霧の軸 / w = 軌跡の曲率

            vec3 tint = b.rgb;
            vec3 coreCol = mix(tint, vec3(1.0), uCoreWhite);
            vec2 dHead = p - a.xy;
            float r2Head = dot(dHead, dHead);

            // ---- Core（50〜150ms）。動いている間だけ前フレームとの線分に伸ばす。
            if (a.z > 1e-4) {
              vec2 seg = a.xy - d.xy;
              float segLen2 = dot(seg, seg);
              float h = segLen2 > 1e-10 ? clamp(dot(p - d.xy, seg) / segLen2, 0.0, 1.0) : 1.0;
              vec2 dc = p - (d.xy + seg * h);
              float rc2 = dot(dc, dc);
              float core = exp(-rc2 / max(a.w * a.w, 1e-9));
              // 芯のすぐ外だけの小さな色づき。円形の大きな雲にはしない。
              vec3 bloom = vec3(
                haloTerm(rc2, a.w * 4.0 * (1.0 + uPrism)),
                haloTerm(rc2, a.w * 4.0),
                haloTerm(rc2, a.w * 4.0 * max(1.0 - uPrism, 0.15))
              );
              emit += a.z * (coreCol * core * uCoreGain + tint * bloom * uHaloGain * 0.35);
            }

            // ---- Streak（100〜400ms）。主 1〜2 本 + 副 0〜3 本。
            // 等間隔にも左右対称にもしない（星形を基本形にしない）。
            if (c.w > 1e-4) {
              vec3 star = vec3(0.0);
              for (int k = 0; k < ${MAX_RAYS}; k++) {
                if (float(k) >= d.z) break;
                vec2 hj = hash2(vec2(f.y * 37.0 + float(k) * 11.3, f.y * 91.0 + 4.1));
                float isMain = step(float(k), 1.5);
                // 主光条は基準角の近く、副光条は自由な向き。k=0 は基準角そのもの。
                float ang = c.x + (hj.x - 0.5) * mix(6.2831, 0.9, isMain) * step(0.5, float(k));
                float baseLen = c.y * mix(0.12 + 0.3 * hj.y, 0.55 + 0.65 * hj.y, isMain);
                // 左右で長さを変える（片側だけ伸びる）。
                float lenPos = baseLen * (0.35 + d.w * 1.3);
                float lenNeg = baseLen * (1.65 - d.w * 1.3);
                float w = mix(0.22, 1.0, isMain);
                vec2 dir = vec2(cos(ang), sin(ang));
                float u = dot(dHead, dir);
                float v = abs(dHead.x * -dir.y + dHead.y * dir.x);
                float len = u >= 0.0 ? lenPos : lenNeg;
                float thin = c.z * (0.6 + hj.y * 0.9);
                float s = exp(-abs(u) / max(len, 1e-4)) * exp(-v / max(thin, 1e-5));
                star += w * s * mix(vec3(1.0), tint, clamp(abs(u) / max(len, 1e-4) * 0.8, 0.0, 1.0));
              }
              emit += c.w * star;
            }

            // ---- Trail（300ms〜1s）。直線が薄くなるだけにしない。
            // 「移動履歴と周囲の散乱が部分的に残る」ものとして描く。
            if (e.z > 1e-4) {
              vec2 seg = a.xy - e.xy;
              float L = length(seg);
              if (L > 1e-4) {
                vec2 dir = seg / L;
                vec2 nrm = vec2(-dir.y, dir.x);
                vec2 rel = p - e.xy;
                float t = clamp(dot(rel, dir) / L, 0.0, 1.0);
                // わずかに曲がる。
                float lat = dot(rel, nrm) - f.w * sin(t * PI) * L;
                // 太さは沿って変化し、古い部分（起点側）ほど広がる。
                float wid = e.w * (0.45 + 1.1 * vnoise(t * 5.0 + f.y * 31.0))
                                * (1.0 + (1.0 - t) * 1.9);
                // 一部だけ明るい / 途中が切れる / 古いほど粒へ崩れる。
                float bright = 0.25 + 0.95 * vnoise(t * 7.0 + f.y * 17.0);
                float gap = step(0.28, vnoise(t * 13.0 + f.y * 53.0));
                float grain = mix(1.0, step(0.42, hash1(floor(t * 90.0) + f.y * 7.0)), 1.0 - t);
                float head = mix(0.35, 1.0, t);
                // 色は途中で分離する（チャンネルごとに太さを変える）。
                vec3 prof = vec3(
                  exp(-lat * lat / max(pow(wid * (1.0 + uPrism), 2.0), 1e-9)),
                  exp(-lat * lat / max(wid * wid, 1e-9)),
                  exp(-lat * lat / max(pow(wid * max(1.0 - uPrism, 0.15), 2.0), 1e-9))
                );
                emit += e.z * bright * gap * grain * head * prof * tint;
              }
            }

            // ---- Haze（500ms〜2s）。円形に囲まず、進行方向へ細長い膜。
            // 弱いイベントは f.x = 0 なので、そもそも霧を見せない。
            if (f.x > 1e-4) {
              vec2 ha = vec2(cos(f.z), sin(f.z));
              float hu = dot(dHead, ha);
              float hv = dHead.x * -ha.y + dHead.y * ha.x;
              // 進行方向 0.28 倍・直交方向 3.4 倍 = 細長い膜。
              float he2 = hu * hu * 0.28 + hv * hv * 3.4;
              emit += f.x * tint * haloTerm(he2, b.w) * uHaloGain;
              irradiance += tint * f.x / (he2 + 0.02);
            }
            // 芯もわずかに霧を照らすが、弱いイベントでは見えない量にとどめる。
            irradiance += tint * a.z * 0.1 / (r2Head + 0.02);
          }

          // ---- 霧（媒質）の読み出し。漂い＋拡散でゆっくり広がり変形する。
          vec2 flow = uDrift * vec2(sin(uTime * 0.21 + vUv.y * 3.1), 1.0);
          flow.y -= (vUv.y - 0.5) * uBandPull;
          vec2 sUv = clamp(vUv + flow, vec2(0.0), vec2(1.0));
          vec3 prev = texture2D(tPrev, sUv).rgb;
          if (uSpreadMix > 1e-4) {
            vec2 o = uTexel * uSpreadRadius;
            vec3 blurred = 0.25 * (
              texture2D(tPrev, clamp(sUv + vec2(o.x, 0.0), vec2(0.0), vec2(1.0))).rgb +
              texture2D(tPrev, clamp(sUv - vec2(o.x, 0.0), vec2(0.0), vec2(1.0))).rgb +
              texture2D(tPrev, clamp(sUv + vec2(0.0, o.y), vec2(0.0), vec2(1.0))).rgb +
              texture2D(tPrev, clamp(sUv - vec2(0.0, o.y), vec2(0.0), vec2(1.0))).rgb
            );
            prev = mix(prev, blurred, uSpreadMix);
          }
          prev *= uClear;

          // ---- 単散乱近似:
          //   scattered(x) = fogDensity(x) × Σ_i I_i / (dist_i² + ε)
          // 霧自体は光らない。いま光が無ければ irradiance が 0 になり、霧は見えない。
          //
          // 散乱は「そこにある霧のうち、いま照らされている分」なので prev に比例する。
          // そのため decay と合わせた prev への実効ゲインが 1 を超えると霧が自己増幅して
          // 際限なく明るくなる（暗闇に戻らなくなる）。上限を置いて必ず収束させる。
          float irr = min(dot(irradiance, vec3(0.2126, 0.7152, 0.0722)), 200.0);
          float scatterGain = min(irr * uFog, max(0.985 - uDecay, 0.0));
          // 散乱光は光源の色を帯びる（albedo）。
          vec3 irrTint = irradiance / max(max(irradiance.r, max(irradiance.g, irradiance.b)), 1e-5);
          vec3 scattered = prev * scatterGain * irrTint;

          vec3 acc = prev * uDecay + scattered + max(emit, vec3(0.0)) * uGain;
          gl_FragColor = vec4(min(acc, vec3(uMaxAccum)), 1.0);
        }
      `,
    });

    this.displayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tFeedback: { value: null },
        uActive: { value: 0 },
        uZoom: { value: this.zoom },
        uExposure: { value: 0.85 },
        uDebugView: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tFeedback;
        uniform float uActive;
        uniform float uZoom;
        uniform float uExposure;
        uniform float uDebugView;

        void main() {
          // D5: 音が鳴っていなければ何も見せない。
          if (uActive < 0.5) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          vec2 q = (vUv - 0.5) / max(uZoom, 0.05) + 0.5;
          if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          vec3 raw = max(texture2D(tFeedback, q).rgb, vec3(0.0));
          if (uDebugView > 0.5) {
            gl_FragColor = vec4(clamp(raw * 0.05, 0.0, 1.0), 1.0);
            return;
          }

          vec3 mapped = vec3(1.0) - exp(-raw * uExposure);
          mapped = pow(clamp(mapped, 0.0, 1.0), vec3(0.88));
          gl_FragColor = vec4(mapped, 1.0);
        }
      `,
    });

    this.emitScene = new THREE.Scene();
    this.emitGeometry = new THREE.PlaneGeometry(2, 2);
    this.emitScene.add(new THREE.Mesh(this.emitGeometry, this.emitMaterial));

    this.displayScene = new THREE.Scene();
    this.displayGeometry = new THREE.PlaneGeometry(2, 2);
    this.displayScene.add(new THREE.Mesh(this.displayGeometry, this.displayMaterial));

    this.pipeline = new EffectPipeline(
      context.renderer,
      this.displayScene,
      this.camera,
      this.effects,
    );

    this.syncPlateUniforms();
  }

  private createTargets(width: number, height: number): void {
    this.targets?.forEach((target) => target.dispose());
    const w = Math.max(width, 16);
    const h = Math.max(height, 16);
    const make = (): THREE.WebGLRenderTarget =>
      new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
    this.targets = [make(), make()];
    this.current = 0;
    this.needsClear = true;
    if (this.emitMaterial) {
      (this.emitMaterial.uniforms.uTexel!.value as THREE.Vector2).set(1 / w, 1 / h);
    }
  }

  private syncPlateUniforms(): void {
    if (!this.emitMaterial) return;
    const extents = this.plateExtents();
    (this.emitMaterial.uniforms.uPlate!.value as THREE.Vector2).set(extents.x, extents.y);
  }

  // ---------------------------------------------------------------- 色

  private hueBase(): number {
    return 0.7 - clamp01(this.smoothedCentroid) * 0.17;
  }

  private hueRange(): number {
    return 0.05 + Math.pow(clamp(this.params.color, 0, 1), 1.9) * 1.9;
  }

  private pickColor(kind: LightKind): THREE.Color {
    const spread = clamp(this.params.color, 0, 1);
    const hue = this.hueBase() + (this.rand() - 0.5) * this.hueRange();
    const saturation = mix(this.randRange(0.18, 0.45), this.randRange(0.62, 1), spread);
    const lightness = kind === 'flare' ? this.randRange(0.5, 0.62) : this.randRange(0.46, 0.6);
    return new THREE.Color().setHSL(((hue % 1) + 1) % 1, saturation, lightness);
  }

  // ---------------------------------------------------------------- 発生位置

  private pickPosition(): { x: number; y: number } {
    const plate = this.plateExtents();
    const placement = clamp(this.params.placement, 0, 1);
    const x = this.randRange(-plate.x * 0.95, plate.x * 0.95);
    const sigma = mix(0.09, 0.75, placement) * plate.y;
    const y = clamp(this.randNormal() * sigma, -plate.y, plate.y);
    return { x, y };
  }

  // ---------------------------------------------------------------- イベント

  /**
   * 1 イベントを起こす。種別ごとに、持つ層と時定数がまったく違う。
   * origin を与えると（破片のとき）そこから飛ばす。
   */
  private spawn(
    kind: LightKind,
    strength: number,
    origin?: { x: number; y: number; angle: number },
  ): void {
    if (this.lights.length >= MAX_LIGHTS) {
      // 最も古いものを押し出す。強いイベントは残す。
      let worst = -1;
      for (let i = 0; i < this.lights.length; i++) {
        const candidate = this.lights[i]!;
        if (candidate.kind === 'flare' && kind !== 'flare') continue;
        if (worst < 0 || candidate.age > this.lights[worst]!.age) worst = i;
      }
      if (worst < 0) return;
      this.lights.splice(worst, 1);
    }

    this.eventTally[kind] += 1;
    if (this.lastEventTime >= 0) {
      const gap = this.elapsedNow - this.lastEventTime;
      if (gap >= 0) {
        this.intervals.push(gap);
        if (this.intervals.length > 4000) this.intervals.shift();
      }
    }
    this.lastEventTime = this.elapsedNow;

    const bass = this.smoothedBass;
    const treble = this.smoothedTreble;
    const sharp = clamp(this.params.sharpness, 0, 1);
    const intensityGain = 0.3 + this.params.intensity * 1.7;
    // 芯の大きさ。小さすぎると 1 画素未満になって画面から消えるため下限を持たせる。
    const coreScale = mix(3.4, 1.15, sharp);
    const speedGain = clamp(this.params.speed, 0, 1);

    const base = origin ? { x: origin.x, y: origin.y } : this.pickPosition();

    // 層ごとに独立した時定数（秒）。同時にフェードさせない。
    // Core は種別ごとに必ず設定される（下の分岐がすべて代入する）。
    let coreLife: number;
    let streakLife = 0;
    let trailLife = 0;
    let hazeLife = 0;
    let peak = strength * intensityGain;
    let coreSize = this.randRange(0.0025, 0.006) * coreScale;
    let rayCount = 0;
    let rayLength = 0;
    let rayThin = this.randRange(0.0012, 0.003);
    let hazeRadius = 0;
    let speed = 0;
    let trailWidth = 0;

    if (kind === 'spark') {
      // 小さく鋭い点。寿命が非常に短い。軌跡なし。
      coreLife = this.randRange(0.05, 0.11);
      coreSize *= 0.75 - treble * 0.2;
      peak *= this.randRange(0.35, 0.7);
      // 半分ほどは光条を持たない。持っても 1 本だけ。
      if (this.rand() < 0.45) {
        rayCount = 1;
        streakLife = this.randRange(0.1, 0.2);
        rayLength = this.randRange(0.01, 0.035);
      }
    } else if (kind === 'flash') {
      // 強い芯 + 1〜2 方向へ長い光条。瞬間的。
      coreLife = this.randRange(0.06, 0.15);
      streakLife = this.randRange(0.12, 0.4);
      coreSize *= this.randRange(1.1, 1.7);
      peak *= this.randRange(1.2, 2.2);
      rayCount = this.rand() < 0.6 ? 1 : 2;
      // 弱い副光条を 0〜3 本足す。
      rayCount += Math.floor(this.randRange(0, 3.99));
      rayLength = this.randRange(0.12, 0.4) * (0.7 + bass * 0.8);
      rayThin = this.randRange(0.002, 0.005);
      if (strength > 1.1) {
        hazeLife = this.randRange(0.5, 1);
        hazeRadius = this.randRange(0.06, 0.14);
      }
    } else if (kind === 'trace') {
      // 短時間だけ移動し細い軌跡が残る。移動が起きるのはこの種別だけ。
      coreLife = this.randRange(0.08, 0.15);
      streakLife = this.randRange(0.1, 0.22);
      trailLife = this.randRange(0.3, 1);
      peak *= this.randRange(0.6, 1.1);
      rayCount = this.rand() < 0.5 ? 1 : 2;
      rayLength = this.randRange(0.02, 0.06);
      trailWidth = this.randRange(0.0016, 0.0042);
      // Speed = 0 でもこの種別だけは内部的に短距離移動する（定義上の移動）。
      speed = this.randRange(0.35, 0.9) * (1 + speedGain * 2.2);
    } else if (kind === 'flare') {
      // 霧や薄い膜を照らす。面・帯として広がる。余韻が長い。
      coreLife = this.randRange(0.09, 0.15);
      streakLife = this.randRange(0.2, 0.4);
      trailLife = this.randRange(0.4, 0.9);
      hazeLife = this.randRange(0.9, 2);
      coreSize *= this.randRange(1.6, 2.6);
      peak *= this.randRange(2.2, 3.4);
      rayCount = 2 + Math.floor(this.randRange(0, 3.99));
      rayLength = this.randRange(0.3, 0.8) * (0.7 + bass * 0.8);
      rayThin = this.randRange(0.003, 0.007);
      hazeRadius = this.randRange(0.2, 0.5);
      trailWidth = this.randRange(0.003, 0.007);
    } else {
      // Scattered Fragment: 強い発光の後にだけ派生する破片。
      coreLife = this.randRange(0.05, 0.13);
      streakLife = this.randRange(0.1, 0.2);
      coreSize *= this.randRange(0.7, 1.1);
      peak *= this.randRange(0.3, 0.7);
      rayCount = this.rand() < 0.7 ? 1 : 2;
      rayLength = this.randRange(0.02, 0.08);
      trailLife = this.rand() < 0.4 ? this.randRange(0.3, 0.6) : 0;
      trailWidth = this.randRange(0.0012, 0.003);
      speed = this.randRange(0.5, 1.4) * (1 + speedGain * 1.5);
    }

    const heading = origin ? origin.angle : this.randRange(0, Math.PI * 2);

    this.lights.push({
      kind,
      x: base.x,
      y: base.y,
      px: base.x,
      py: base.y,
      trailX: base.x,
      trailY: base.y,
      heading,
      curl: (this.rand() - 0.5) * 5,
      speed,
      age: 0,
      coreLife,
      streakLife,
      trailLife,
      hazeLife,
      coreAttack: this.randRange(0.004, 0.016),
      peak,
      color: this.pickColor(kind),
      coreSize,
      hazeRadius,
      // 霧の軸は光の進行方向（動かないものは主光条の向きに合わせる）。
      hazeAxis: heading,
      rayAngle: this.randRange(0, Math.PI * 2),
      rayCount: clamp(rayCount, 0, MAX_RAYS),
      rayLength,
      rayThin,
      // 0.5 で左右対称。両端に寄るほど片側だけが伸びる。
      rayAsym: this.randRange(0.08, 0.92),
      trailWidth,
      trailCurve: (this.rand() - 0.5) * 0.35,
      seed: this.rand(),
    });

    // 強い発光の後にだけ破片が派生する。すべてが同じ方向へは飛ばない。
    if (!origin && (kind === 'flare' || (kind === 'flash' && strength > 1.3))) {
      const count = 2 + Math.floor(this.randRange(0, 3.99));
      // 方向を等分せず、区間内でランダムに散らす。
      const offset = this.randRange(0, Math.PI * 2);
      for (let i = 0; i < count; i++) {
        const angle = offset + ((i + this.randRange(0.15, 0.85)) / count) * Math.PI * 2;
        this.spawn('fragment', strength * this.randRange(0.3, 0.6), {
          x: base.x + Math.cos(angle) * this.randRange(0.01, 0.05),
          y: base.y + Math.sin(angle) * this.randRange(0.01, 0.05),
          angle,
        });
      }
    }
  }

  /**
   * イベント種別を引く。Spark 70% / Flash 20% / Trace 8% / Flare 2%。
   * 強い瞬間だけ Flare の取り分がわずかに増えるが、それでも稀なまま。
   */
  private pickKind(flareBoost: number): LightKind {
    const u = this.rand();
    // 抽選ぶんは 2% を下回るところに置く。オンセット由来の上乗せと合わせて
    // 全体で 2〜3% に収まるようにしてある（フレアの稀さがこの表現の核）。
    const flareP = 0.012 + clamp(flareBoost, 0, 1) * 0.025;
    if (u < 0.7) return 'spark';
    if (u < 0.9) return 'flash';
    if (u < 1 - flareP) return 'trace';
    return 'flare';
  }

  private advanceLights(delta: number): void {
    const extents = this.plateExtents();
    const mid = this.smoothedMid;
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const light = this.lights[i]!;
      light.age += delta;
      const last = Math.max(light.coreLife, light.streakLife, light.trailLife, light.hazeLife);
      if (light.age >= last) {
        this.lights.splice(i, 1);
        continue;
      }

      light.px = light.x;
      light.py = light.y;
      if (light.speed <= 0) continue;
      // 移動するのは trace と fragment だけ。減速しながら短い距離を進む。
      const slow = Math.exp((-2.6 * light.age) / Math.max(light.coreLife, 1e-3));
      light.heading += light.curl * (0.3 + mid * 1.2) * delta;
      light.x += Math.cos(light.heading) * light.speed * slow * delta;
      light.y += Math.sin(light.heading) * light.speed * slow * delta;
      light.x = clamp(light.x, -extents.x, extents.x);
      light.y = clamp(light.y, -extents.y, extents.y);
    }
  }

  /** 層ごとの包絡。立ち上がりは即時、終わりはきれいに 0 へ落とす。 */
  private envelope(age: number, life: number, attack: number): number {
    if (life <= 1e-5 || age >= life) return 0;
    const a = Math.min(age / Math.max(attack, 1e-4), 1);
    const t = age / life;
    return a * Math.exp(-3.2 * t) * (1 - smoothstep(0.72, 1, t));
  }

  private packLights(volumeGain: number): number {
    const count = Math.min(this.lights.length, MAX_LIGHTS);
    for (let i = 0; i < count; i++) {
      const l = this.lights[i]!;
      const o = i * 4;
      const gain = l.peak * volumeGain;
      this.lightA[o] = l.x;
      this.lightA[o + 1] = l.y;
      this.lightA[o + 2] = gain * this.envelope(l.age, l.coreLife, l.coreAttack);
      this.lightA[o + 3] = l.coreSize;
      this.lightB[o] = l.color.r;
      this.lightB[o + 1] = l.color.g;
      this.lightB[o + 2] = l.color.b;
      this.lightB[o + 3] = l.hazeRadius;
      this.lightC[o] = l.rayAngle;
      this.lightC[o + 1] = l.rayLength;
      this.lightC[o + 2] = l.rayThin;
      this.lightC[o + 3] = gain * 0.8 * this.envelope(l.age, l.streakLife, l.coreAttack);
      this.lightD[o] = l.px;
      this.lightD[o + 1] = l.py;
      this.lightD[o + 2] = l.rayCount;
      this.lightD[o + 3] = l.rayAsym;
      this.lightE[o] = l.trailX;
      this.lightE[o + 1] = l.trailY;
      this.lightE[o + 2] = gain * 0.5 * this.envelope(l.age, l.trailLife, 0.01);
      this.lightE[o + 3] = l.trailWidth;
      this.lightF[o] = gain * 0.08 * this.envelope(l.age, l.hazeLife, 0.03);
      this.lightF[o + 1] = l.seed;
      this.lightF[o + 2] = l.hazeAxis;
      this.lightF[o + 3] = l.trailCurve;
    }
    return count;
  }

  // ---------------------------------------------------------------- 音 → 発生

  /**
   * Volumetric Flare を立てる駆動量。実データ（reference.wav の 2 区間）で探索して決めた式。
   *
   *   bandEnergy = (Rbass·bass + Rmid·mid + Rtreble·treble) / 3
   *   flareDrive = onset × (0.35 + 0.85 × 平滑音量) × bandEnergy
   *
   * 分母を 3 に固定してあるので、Response のスライダーを上げた帯域ほど強い光が出る
   * （＝ Response が帯域感度になる。PRD D24）。
   */
  private flareDrive(onset: number, bass: number, mid: number, treble: number): number {
    const bandEnergy =
      (this.response.bass * bass + this.response.mid * mid + this.response.treble * treble) / 3;
    return onset * (0.35 + 0.85 * this.smoothedVolume) * bandEnergy;
  }

  /**
   * 発生（自己励起点過程 / Hawkes）。均一なレートは持たない。
   *
   *   λ(t) = μ + excitation
   *   発火のたび excitation += α、時定数 τ = EXCITATION_TAU で減衰。
   *   分岐比 n = α·τ（< 1）で平均クラスターサイズは 1/(1-n)。
   *   音のオンセットは excitation を跳ね上げてクラスターの起点になるが、
   *   クラスター内の連なりは音とは独立に減衰的に進む。
   */
  private spawnLights(audio: AudioParameters, delta: number): void {
    const onset = clamp01(audio.onset);
    const beat = clamp01(audio.beat);
    const sensitivity = clamp(this.params.sensitivity, 0, 1);
    const density = clamp(this.params.density, 0, 1);
    const rising = onset > this.previousOnset;
    this.previousOnset = onset;

    // 減衰（クラスターは放っておけば必ず終わり、静寂に戻る）。
    this.excitation *= Math.exp(-delta / EXCITATION_TAU);

    // 音のオンセットはクラスターの起点。閾値は Sensitivity が動かす。
    const trigger = Math.max(onset, beat * 0.7);
    const threshold = 0.4 - sensitivity * 0.32;
    if (rising && trigger >= threshold) {
      this.excitation += (1.5 + density * 3) * trigger;
    }

    // 背景レート。静寂が成立する程度に抑えつつ、クラスターが目に見える密度は保つ。
    const mu = (0.8 + density * 5.5) * (0.45 + this.smoothedVolume * 0.9);
    const lambda = mu + this.excitation;

    const branching = 0.5 + density * 0.35;
    const alpha = branching / EXCITATION_TAU;

    const events = this.randPoisson(lambda * delta);
    for (let i = 0; i < events; i++) {
      const kind = this.pickKind(this.lastFlareDrive);
      // 強さは音量に緩く連動するが、ほとんどのイベントは小さいまま。
      const strength = clamp(
        (0.45 + this.smoothedVolume * 0.6) * this.randRange(0.7, 1.5) +
          (kind === 'flare' || kind === 'flash' ? trigger * 0.5 : 0),
        0.15,
        2.6,
      );
      this.spawn(kind, strength);
      this.excitation += alpha;
    }

    const drive = this.flareDrive(
      onset,
      clamp01(audio.bass),
      clamp01(audio.mid),
      clamp01(audio.treble),
    );
    this.flareCooldown = Math.max(this.flareCooldown - delta, 0);
    if (rising && drive >= 0.42 - sensitivity * 0.22 && this.flareCooldown <= 0) {
      this.lastFlareDrive = drive;
      // 強い瞬間には Volumetric Flare を 1 本だけ立てる。
      // 冷却を置かないと、オンセットの密な曲でフレアが連続して稀さが壊れる。
      this.flareCooldown = 0.7;
      this.spawn('flare', clamp(1.1 + drive, 0, 2.6));
      this.excitation += alpha;
    } else {
      this.lastFlareDrive *= Math.exp(-delta * 1.5);
    }
  }

  // ---------------------------------------------------------------- update

  update(elapsed: number): void {
    if (!this.context || !this.emitMaterial || !this.displayMaterial) return;
    const audio = this.context.audioEngine.getParameters();
    const active = audio.active === 1;

    const delta =
      this.previousElapsed < 0
        ? 0
        : Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.05);
    this.previousElapsed = elapsed;
    this.elapsedNow = elapsed;

    this.displayMaterial.uniforms.uActive!.value = active ? 1 : 0;

    if (!active) {
      // D5: 無音では発生も残像もない。
      if (this.lights.length > 0) this.lights.length = 0;
      this.needsClear = true;
      this.smoothedVolume = 0;
      this.excitation = 0;
      this.pipeline?.update(audio, elapsed);
      return;
    }

    const volume = clamp01(audio.volume);
    const bass = clamp01(audio.bass);
    const mid = clamp01(audio.mid);
    const treble = clamp01(audio.treble);
    this.smoothedVolume += (volume - this.smoothedVolume) * Math.min(delta * 6, 1);
    this.smoothedBass += (bass - this.smoothedBass) * Math.min(delta * 8, 1);
    this.smoothedMid += (mid - this.smoothedMid) * Math.min(delta * 8, 1);
    this.smoothedTreble += (treble - this.smoothedTreble) * Math.min(delta * 10, 1);
    this.smoothedCentroid +=
      (clamp01(audio.centroid) - this.smoothedCentroid) * Math.min(delta * 4, 1);
    if (typeof audio.seed === 'number' && Number.isFinite(audio.seed)) {
      this.audioSeed = audio.seed;
    }

    this.spawnLights(audio, delta);
    this.advanceLights(delta);

    const volumeGain = 0.6 + this.smoothedVolume * 0.7;
    const count = this.packLights(volumeGain);

    const decay = this.decayFor(delta);
    const tau = this.trailSeconds() / DECAY_DEPTH;
    const gainBase = 1 / (1 + tau * 2.4);
    const frameNorm = clamp(delta > 0 ? delta * 60 : 1, 0.5, 2);

    const sharp = clamp(this.params.sharpness, 0, 1);
    const color = clamp(this.params.color, 0, 1);
    const fog = clamp(this.params.fog, 0, 1);
    const spread = clamp(this.params.fogSpread, 0, 1);
    const placement = clamp(this.params.placement, 0, 1);

    const u = this.emitMaterial.uniforms;
    u.uLightCount!.value = count;
    u.uLightA!.value = this.lightA;
    u.uLightB!.value = this.lightB;
    u.uLightC!.value = this.lightC;
    u.uLightD!.value = this.lightD;
    u.uLightE!.value = this.lightE;
    u.uLightF!.value = this.lightF;
    u.uDecay!.value = decay;
    u.uGain!.value = gainBase * frameNorm;
    u.uClear!.value = this.needsClear ? 0 : 1;
    u.uTime!.value = elapsed;
    u.uSeed!.value = this.params.seed;

    u.uCoreGain!.value = mix(0.7, 3.4, sharp);
    u.uHaloGain!.value = mix(1.9, 0.45, sharp);
    u.uCoreWhite!.value = mix(0.45, 0.92, sharp);
    u.uPrism!.value = 0.05 + color * 0.28;

    // 散乱の強さ。上のシェーダーで実効ゲインに上限が掛かるので、
    // ここは「どれだけ早く上限へ届くか」を決める係数になる。
    u.uFog!.value = fog * fog * 0.05;
    u.uSpreadMix!.value = spread * 0.85;
    u.uSpreadRadius!.value = 1 + spread * 3;
    (u.uDrift!.value as THREE.Vector2).set(
      spread * 0.012 * frameNorm * 0.016,
      spread * 0.01 * frameNorm * 0.016,
    );
    // 霧が中央の帯へ寄る度合いは Placement に連動させる（独立つまみにしない）。
    u.uBandPull!.value = (1 - placement) * spread * 0.02 * frameNorm;

    this.stepFeedback();
    this.pipeline?.update(audio, elapsed);
  }

  private stepFeedback(): void {
    if (!this.context || !this.targets || !this.emitMaterial || !this.emitScene) return;
    if (!this.camera || !this.displayMaterial) return;
    const renderer = this.context.renderer;
    const next = 1 - this.current;
    const previous = renderer.getRenderTarget();
    this.emitMaterial.uniforms.tPrev!.value = this.targets[this.current]!.texture;
    renderer.setRenderTarget(this.targets[next]!);
    renderer.render(this.emitScene, this.camera);
    renderer.setRenderTarget(previous);
    this.current = next;
    this.needsClear = false;
    this.displayMaterial.uniforms.tFeedback!.value = this.targets[this.current]!.texture;
  }

  render(): void {
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    const edge = Math.max(width, height);
    const scale = edge > MAX_BUFFER_EDGE ? MAX_BUFFER_EDGE / edge : 1;
    const nextWidth = Math.max(Math.round(width * scale), 16);
    const nextHeight = Math.max(Math.round(height * scale), 16);
    if (nextWidth !== this.bufferWidth || nextHeight !== this.bufferHeight) {
      this.bufferWidth = nextWidth;
      this.bufferHeight = nextHeight;
      if (this.targets) this.createTargets(nextWidth, nextHeight);
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

  /** テーマは当面この表現では使わない。黒背景と Color スライダーで色を決める。 */
  getTheme(): Theme {
    return this.theme;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  getZoom(): number {
    return this.zoom;
  }

  setZoom(zoom: number): void {
    this.zoom = clamp(zoom, 0.25, 8);
    if (this.displayMaterial) this.displayMaterial.uniforms.uZoom!.value = this.zoom;
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
    this.syncPlateUniforms();
    const extents = this.plateExtents();
    for (const light of this.lights) {
      light.x = clamp(light.x, -extents.x, extents.x);
      light.y = clamp(light.y, -extents.y, extents.y);
      light.px = light.x;
      light.py = light.y;
      light.trailX = clamp(light.trailX, -extents.x, extents.x);
      light.trailY = clamp(light.trailY, -extents.y, extents.y);
    }
  }

  /** 開発用: 0 = 最終 / 1 = 霧バッファの生値。 */
  setDebugView(view: number): void {
    if (this.displayMaterial) this.displayMaterial.uniforms.uDebugView!.value = view;
  }

  getDebugState(): null {
    return null;
  }

  getDepth(): number {
    return 0;
  }

  setDepth(): void {
    // 奥行きは持たない。
  }

  getPhase(): string {
    const t = this.eventTally;
    return (
      `${this.lights.length} live / exc ${this.excitation.toFixed(1)} / ` +
      `sp${t.spark} fl${t.flash} tr${t.trace} vf${t.flare} frag${t.fragment} / ` +
      `trail ${this.trailSeconds().toFixed(2)}s`
    );
  }

  // ---- 開発・検証用 ----

  /** イベント種別ごとの累積回数。 */
  getEventTally(): Record<LightKind, number> {
    return { ...this.eventTally };
  }

  /** 発生間隔の統計。ポアソンなら CV = 1、クラスター化していれば 1 を超える。 */
  getIntervalStats(): { count: number; mean: number; cv: number } {
    const n = this.intervals.length;
    if (n < 2) return { count: n, mean: 0, cv: 0 };
    const mean = this.intervals.reduce((a, b) => a + b, 0) / n;
    const variance = this.intervals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
    return { count: n, mean, cv: Math.sqrt(variance) / Math.max(mean, 1e-9) };
  }

  /** 発生間隔のヒストグラム（秒の境界を与える）。 */
  getIntervalHistogram(edges: number[]): number[] {
    const hist = new Array(edges.length + 1).fill(0);
    for (const gap of this.intervals) {
      let slot = edges.length;
      for (let i = 0; i < edges.length; i++) {
        if (gap < edges[i]!) {
          slot = i;
          break;
        }
      }
      hist[slot] += 1;
    }
    return hist;
  }

  /** 生きているイベントの光条本数の分布（等間隔放射でないことの確認用）。 */
  getRayHistogram(): number[] {
    const hist = new Array(MAX_RAYS + 1).fill(0);
    for (const light of this.lights) hist[Math.round(light.rayCount)] += 1;
    return hist;
  }

  /** 層ごとの時定数の実測レンジ（生きているイベントから）。 */
  getLayerLives(): Record<string, { min: number; max: number } | null> {
    const pick = (get: (l: LightSource) => number): { min: number; max: number } | null => {
      const values = this.lights.map(get).filter((v) => v > 0);
      if (!values.length) return null;
      return { min: Math.min(...values), max: Math.max(...values) };
    };
    return {
      core: pick((l) => l.coreLife),
      streak: pick((l) => l.streakLife),
      trail: pick((l) => l.trailLife),
      haze: pick((l) => l.hazeLife),
    };
  }

  resetStats(): void {
    this.eventTally = { spark: 0, flash: 0, trace: 0, flare: 0, fragment: 0 };
    this.intervals.length = 0;
    this.lastEventTime = -1;
  }

  // ---------------------------------------------------------------- 表現ごとの調整

  getExpressionParams(): ExpressionParam[] {
    const row = (key: keyof typeof this.params, label: string, step = 0.01): ExpressionParam => ({
      key,
      label,
      min: 0,
      max: 1,
      step,
      value: this.params[key],
    });
    return [
      row('trail', 'Trail'),
      row('sensitivity', 'Sensitivity'),
      row('density', 'Density'),
      row('intensity', 'Intensity'),
      row('speed', 'Speed'),
      row('sharpness', 'Sharpness'),
      row('color', 'Color'),
      row('fog', 'Fog'),
      row('fogSpread', 'Fog Spread'),
      row('placement', 'Placement'),
      row('seed', 'Seed', 0.001),
    ];
  }

  setExpressionParam(key: string, value: number): void {
    if (!Number.isFinite(value)) return;
    if (!(key in this.params)) return;
    (this.params as Record<string, number>)[key] = clamp(value, 0, 1);
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
    this.targets?.forEach((target) => target.dispose());
    this.emitGeometry?.dispose();
    this.displayGeometry?.dispose();
    this.emitMaterial?.dispose();
    this.displayMaterial?.dispose();
    this.lights.length = 0;
    this.targets = null;
    this.pipeline = null;
    this.emitScene = null;
    this.displayScene = null;
    this.emitGeometry = null;
    this.displayGeometry = null;
    this.emitMaterial = null;
    this.displayMaterial = null;
    this.camera = null;
    this.context = null;
  }
}
