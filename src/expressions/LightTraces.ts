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
 * Light Traces — 音をきっかけに黒い空間へ光が生まれ、軌跡を残す表現。
 *
 * 構造:
 *   ① 光源（CPU）  最大 24 個。オンセットで発生し、短い寿命の間だけ曲線を描いて動く。
 *                  位置・向き・色はシード付きの決定論ハッシュで決める（Math.random() は使わない）。
 *   ② 軌跡（GPU）  ping-pong の HalfFloat RenderTarget に
 *                  `feedback = previous * decay + emission` を毎フレーム積む。
 *                  emission は光源 N 個を解析的に描くフルスクリーンパス
 *                  （鋭いコア + 減衰グロー + 異方性の光条）。CPU に軌跡は持たない。
 *   ③ 表示         1 - exp(-x) のトーンマッピングで白飛びの継続を防ぐ。
 *
 * Trail スライダーは decay だけを差し替える。シミュレーションは再起動しないので、
 * VJ 中に「パチパチ → 線 → 帯 → 雲」を連続的に行き来できる。
 *
 * 音との対応（PRD §7。この表現での解釈）:
 *   onset/beat → 発生（数と閃光の強さ）
 *   volume     → 全体の明るさ・光源サイズ（平滑を通す。全画面の明滅にはしない）
 *   bass       → 太く長い光条・遅く強い光
 *   mid        → 移動速度・曲線の振れ幅
 *   treble     → 細かく鋭いスパーク（小さく短命）
 *   centroid   → 色相の傾き（低 = 青紫 / 高 = シアン白）と光条の鋭さ
 *   無音（active !== 1）は黒・発生ゼロ（D5）。
 */

/** シェーダーのループ上限。GLSL ES 1.0 のため定数で宣言する。 */
const MAX_LIGHTS = 24;

/** フィードバックバッファの長辺上限。高解像度でも塗り潰しコストを抑える。 */
const MAX_BUFFER_EDGE = 1920;

/** Trail スライダー → 残る時間（秒）。指示された対応表をそのまま折れ線で補間する。 */
const TRAIL_ANCHORS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.25, 0.15],
  [0.5, 0.7],
  [0.75, 2],
  [1, 6.5],
];

/** 1% まで落ちるのを「消えた」とみなす（exp(-4.6) ≈ 0.01）。 */
const DECAY_DEPTH = 4.6;

const clamp01 = (value: number | undefined): number => Math.min(Math.max(value ?? 0, 0), 1);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

interface LightSource {
  x: number;
  y: number;
  /** 前フレームの位置。軌跡は点ではなくこの区間の線分として焼く（点線にしない）。 */
  px: number;
  py: number;
  heading: number;
  curl: number;
  speed: number;
  /** 直線の高速移動をする個体。曲がらず伸びる。 */
  dash: boolean;
  peak: number;
  intensity: number;
  color: THREE.Color;
  life: number;
  age: number;
  attack: number;
  coreSize: number;
  glowRadius: number;
  rayLength: number;
  rayThin: number;
  rayGain: number;
  rayAngle: number;
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

  // ---- 表現ごとの調整（PRD D25。持つ機能はこの表現が宣言する）----
  private params = {
    trail: 0.5,
    sensitivity: 0.55,
    density: 0.5,
    intensity: 0.6,
    speed: 0.45,
    bloom: 0.4,
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

  private previousElapsed = -1;
  private spawnCooldown = 0;
  private smoothedVolume = 0;
  private smoothedCentroid = 0.5;
  private smoothedBass = 0;
  private smoothedMid = 0;
  private smoothedTreble = 0;
  private previousOnset = 0;
  private rngCounter = 0;
  /** 音のシード（オンセットごとに変わる）。発生の乱数源はこれと Seed スライダー。 */
  private audioSeed = 0;

  constructor(effects: Effect[] = [], theme?: Theme) {
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
  }

  // ---------------------------------------------------------------- 決定論乱数

  /**
   * 決定論ハッシュ。Math.random() は使わない（乱数源は音のシードと Seed スライダー）。
   * 呼ぶたびに内部カウンタが進むので、同じ音源・同じ Seed なら同じ列になる。
   */
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

  // ---------------------------------------------------------------- 板の寸法

  /** 板の半辺長（面積 1 正規化）。距離が等方になるので光が楕円に潰れない。 */
  private plateExtents(): { x: number; y: number } {
    const s = Math.sqrt(Math.max(this.aspectRatio, 1e-6));
    return { x: s, y: 1 / s };
  }

  // ---------------------------------------------------------------- Trail

  /** Trail スライダー → 残る時間（秒）。折れ線補間。 */
  private trailSeconds(): number {
    const t = clamp(this.params.trail, 0, 1);
    for (let i = 1; i < TRAIL_ANCHORS.length; i++) {
      const [x1, y1] = TRAIL_ANCHORS[i]!;
      const [x0, y0] = TRAIL_ANCHORS[i - 1]!;
      if (t <= x1) return y0 + ((y1 - y0) * (t - x0)) / Math.max(x1 - x0, 1e-6);
    }
    return TRAIL_ANCHORS[TRAIL_ANCHORS.length - 1]![1];
  }

  /**
   * decay は deltaTime の指数減衰にする（フレームレート非依存）。
   * Trail = 0 のときは 0 を返し、前フレームを完全に消す。
   */
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
        uLightCount: { value: 0 },
        uLightA: { value: this.lightA },
        uLightB: { value: this.lightB },
        uLightC: { value: this.lightC },
        uLightD: { value: this.lightD },
        uMaxAccum: { value: 28 },
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
        uniform float uLightCount;
        uniform vec4 uLightA[${MAX_LIGHTS}];
        uniform vec4 uLightB[${MAX_LIGHTS}];
        uniform vec4 uLightC[${MAX_LIGHTS}];
        uniform vec4 uLightD[${MAX_LIGHTS}];
        uniform float uMaxAccum;

        // 光条（スターバースト）。dir 方向へ長く、直交方向へ細い異方性の帯。
        float ray(vec2 d, vec2 dir, float len, float thin) {
          float u = abs(dot(d, dir));
          float v = abs(d.x * -dir.y + d.y * dir.x);
          return exp(-u / max(len, 1e-4)) * exp(-v / max(thin, 1e-5));
        }

        void main() {
          // 物理座標。板の比率で伸ばしてあるので距離が等方になる。
          vec2 p = (vUv * 2.0 - 1.0) * uPlate;

          vec3 emit = vec3(0.0);
          for (int i = 0; i < ${MAX_LIGHTS}; i++) {
            if (float(i) >= uLightCount) break;
            vec4 a = uLightA[i];  // xy = 位置 / z = 強度 / w = コア半径
            vec4 b = uLightB[i];  // xyz = 色 / w = グロー半径
            vec4 c = uLightC[i];  // x = 光条の角度 / y = 長さ / z = 細さ / w = 強さ
            vec4 e = uLightD[i];  // xy = 前フレームの位置

            // 軌跡は点ではなく「前フレーム → 現フレーム」の線分として焼く。
            // 点で焼くと速い光ほど点線になり、曲線がつながらない。
            vec2 seg = a.xy - e.xy;
            float segLen2 = dot(seg, seg);
            float h = segLen2 > 1e-12 ? clamp(dot(p - e.xy, seg) / segLen2, 0.0, 1.0) : 0.0;
            vec2 d = p - (e.xy + seg * h);
            float r2 = dot(d, d);

            // 鋭いコア。先頭を最も明るくして進行方向がわかるようにする。
            float core = exp(-r2 / max(a.w * a.w, 1e-8)) * mix(0.55, 1.0, h);
            // 減衰グロー。半径は Bloom スライダーが決める。
            float g2 = max(b.w * b.w, 1e-8);
            float glow = g2 / (g2 + r2 * 6.0);
            glow *= glow;

            // 光条は光源そのものから伸びる。線分ではなく現在位置を基準にする。
            vec2 dHead = p - a.xy;
            // 異方性の光条: 主軸 + 直交 + 斜め 2 本。
            vec2 dir = vec2(cos(c.x), sin(c.x));
            vec2 perp = vec2(-dir.y, dir.x);
            vec2 diagA = normalize(dir + perp);
            vec2 diagB = normalize(dir - perp);
            float star =
              ray(dHead, dir, c.y, c.z) +
              ray(dHead, perp, c.y * 0.4, c.z * 0.85) * 0.28 +
              (ray(dHead, diagA, c.y * 0.5, c.z * 0.9) +
                ray(dHead, diagB, c.y * 0.5, c.z * 0.9)) * 0.2;
            star *= c.w;

            vec3 tint = b.rgb;
            vec3 hot = mix(tint, vec3(1.0), clamp(core * 0.9, 0.0, 1.0));
            emit += a.z * (hot * core * 2.4 + tint * glow * 0.55 + mix(tint, vec3(1.0), 0.22) * star);
          }

          vec3 prev = texture2D(tPrev, vUv).rgb * uClear;
          vec3 acc = prev * uDecay + max(emit, vec3(0.0)) * uGain;
          // 白飛びが焼き付いたまま残らないよう、蓄積そのものに天井を置く。
          gl_FragColor = vec4(min(acc, vec3(uMaxAccum)), 1.0);
        }
      `,
    });

    this.displayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tFeedback: { value: null },
        uActive: { value: 0 },
        uZoom: { value: this.zoom },
        uExposure: { value: 1 },
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

          // ズームは開発用（D17）。表示の尺度だけを変える。
          vec2 q = (vUv - 0.5) / max(uZoom, 0.05) + 0.5;
          if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          vec3 raw = max(texture2D(tFeedback, q).rgb, vec3(0.0));
          if (uDebugView > 0.5) {
            gl_FragColor = vec4(clamp(raw / max(uExposure, 0.001) * 0.05, 0.0, 1.0), 1.0);
            return;
          }

          // トーンマッピング。いくら積んでも 1 を超えないので、
          // 長残像でも白飛びが続かない。
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
    const make = (): THREE.WebGLRenderTarget =>
      new THREE.WebGLRenderTarget(Math.max(width, 16), Math.max(height, 16), {
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
  }

  private syncPlateUniforms(): void {
    if (!this.emitMaterial) return;
    const extents = this.plateExtents();
    (this.emitMaterial.uniforms.uPlate!.value as THREE.Vector2).set(extents.x, extents.y);
  }

  // ---------------------------------------------------------------- 光源

  /** 色。centroid が低いと青紫、高いとシアン寄り。ときどきマゼンタが差す。 */
  private pickColor(centroid: number, spark: boolean): THREE.Color {
    // 0.52 = シアン / 0.63 = 青 / 0.72 = 青紫 / 0.85 = マゼンタ
    let hue = 0.72 - clamp01(centroid) * 0.19 + (this.rand() - 0.5) * 0.09;
    if (this.rand() < 0.16) hue = 0.84 + (this.rand() - 0.5) * 0.06;
    // 明度を上げすぎると蓄積とトーンマッピングで白へ飽和し、色が残らない。
    const saturation = spark ? this.randRange(0.55, 0.8) : this.randRange(0.7, 0.95);
    return new THREE.Color().setHSL(hue % 1, saturation, this.randRange(0.46, 0.6));
  }

  /**
   * 光源を 1 つ生む。spark は treble 由来の小さく短命な個体。
   * 位置・向き・寿命はすべて決定論ハッシュから引く。
   */
  private spawn(strength: number, spark: boolean): void {
    const limit = Math.round(4 + this.params.density * (MAX_LIGHTS - 8));
    if (this.lights.length >= Math.min(limit, MAX_LIGHTS)) {
      // 一番弱った光源を押し出す。数が上限でも新しい発生は止めない。
      let worst = 0;
      for (let i = 1; i < this.lights.length; i++) {
        if (this.lights[i]!.intensity < this.lights[worst]!.intensity) worst = i;
      }
      this.lights.splice(worst, 1);
    }

    const plate = this.plateExtents();
    const bass = this.smoothedBass;
    const mid = this.smoothedMid;
    const centroid = this.smoothedCentroid;
    const intensityGain = 0.25 + this.params.intensity * 1.75;
    const speedGain = 0.15 + this.params.speed * 1.5;

    // bass は遅く強く太い光、treble のスパークは速く小さく短命。
    const heavy = spark ? 0 : bass;
    const peak =
      strength *
      intensityGain *
      (spark ? this.randRange(0.35, 0.75) : this.randRange(0.75, 1.35)) *
      (0.6 + heavy * 0.8);

    const life = spark
      ? this.randRange(0.12, 0.45)
      : this.randRange(0.5, 1.7) * (0.7 + heavy * 0.8);

    // 光条: bass ほど長く太く、centroid が高いほど鋭い。
    const sharpness = 0.35 + clamp01(centroid) * 0.65;

    const x = this.randRange(-plate.x * 0.9, plate.x * 0.9);
    const y = this.randRange(-plate.y * 0.9, plate.y * 0.9);

    this.lights.push({
      x,
      y,
      px: x,
      py: y,
      heading: this.randRange(0, Math.PI * 2),
      // 曲率。移動は短く、その代わりよく曲がる（直線が画面を横断しないように）。
      curl: (this.rand() - 0.5) * 7,
      speed: (spark ? this.randRange(0.14, 0.5) : this.randRange(0.04, 0.26)) * speedGain,
      dash: this.rand() < (spark ? 0.3 : 0.14),
      peak,
      intensity: 0,
      color: this.pickColor(centroid, spark),
      life,
      age: 0,
      attack: spark ? 0.012 : this.randRange(0.02, 0.07),
      coreSize: (spark ? this.randRange(0.002, 0.005) : this.randRange(0.004, 0.011)) *
        (0.75 + this.smoothedVolume * 0.6),
      glowRadius: this.randRange(0.02, 0.05) + this.params.bloom * this.randRange(0.03, 0.13),
      rayLength: (spark ? this.randRange(0.015, 0.05) : this.randRange(0.04, 0.15)) *
        (0.5 + heavy * 1.4) *
        (0.5 + strength),
      rayThin: (spark ? 0.0015 : 0.0025 + heavy * 0.004) / sharpness,
      rayGain: (spark ? 0.35 : 0.8) * (0.3 + strength * 1.2),
      // 主軸はほぼ水平（リファレンスのアナモルフィック帯）。わずかに振らす。
      rayAngle: (this.rand() - 0.5) * 0.9 + (mid > 0.6 && this.rand() < 0.25 ? Math.PI * 0.5 : 0),
      seed: this.rand(),
    });
  }

  /** 光源を 1 フレーム進める。滑らかな曲線移動と、ときどきの直線高速移動。 */
  private advanceLights(delta: number): void {
    const extents = this.plateExtents();
    const mid = this.smoothedMid;
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const light = this.lights[i]!;
      light.age += delta;
      if (light.age >= light.life) {
        this.lights.splice(i, 1);
        continue;
      }

      // 立ち上がりは速く、減衰は指数。閃光として立ち、尾を引いて消える。
      const attack = Math.min(light.age / Math.max(light.attack, 1e-3), 1);
      const decay = Math.exp((-3.2 * light.age) / light.life);
      light.intensity = light.peak * attack * decay;

      // 向きの変化。mid が曲線の振れ幅を決める。dash 個体は曲がらず伸びる。
      const curl = light.dash ? light.curl * 0.12 : light.curl * (0.35 + mid * 1.5);
      light.heading += curl * delta;
      // 加減速。個体ごとに位相をずらした緩い揺らぎ（決定論）。
      const wobble =
        1 + 0.45 * Math.sin(light.age * (2.1 + light.seed * 3.4) + light.seed * 19.7);
      const speed = light.speed * (light.dash ? 1.9 : 1) * wobble;
      light.px = light.x;
      light.py = light.y;
      light.x += Math.cos(light.heading) * speed * delta;
      light.y += Math.sin(light.heading) * speed * delta;

      // 板の外へ出たら向きを折り返す（画面外へ消えて発生数だけ減るのを防ぐ）。
      // 折り返した瞬間は線分の始点も畳んで、板を横断する偽の筋を出さない。
      if (light.x < -extents.x || light.x > extents.x) {
        light.heading = Math.PI - light.heading;
        light.x = clamp(light.x, -extents.x, extents.x);
        light.px = light.x;
      }
      if (light.y < -extents.y || light.y > extents.y) {
        light.heading = -light.heading;
        light.y = clamp(light.y, -extents.y, extents.y);
        light.py = light.y;
      }
    }
  }

  /** CPU の光源配列を uniform 配列へ書き出す。 */
  private packLights(volumeGain: number): number {
    const count = Math.min(this.lights.length, MAX_LIGHTS);
    for (let i = 0; i < count; i++) {
      const light = this.lights[i]!;
      const o = i * 4;
      this.lightA[o] = light.x;
      this.lightA[o + 1] = light.y;
      this.lightA[o + 2] = light.intensity * volumeGain;
      this.lightA[o + 3] = light.coreSize;
      this.lightB[o] = light.color.r;
      this.lightB[o + 1] = light.color.g;
      this.lightB[o + 2] = light.color.b;
      this.lightB[o + 3] = light.glowRadius;
      this.lightC[o] = light.rayAngle;
      this.lightC[o + 1] = light.rayLength;
      this.lightC[o + 2] = light.rayThin;
      this.lightC[o + 3] = light.rayGain;
      this.lightD[o] = light.px;
      this.lightD[o + 1] = light.py;
      this.lightD[o + 2] = 0;
      this.lightD[o + 3] = 0;
    }
    return count;
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

    this.displayMaterial.uniforms.uActive!.value = active ? 1 : 0;

    if (!active) {
      // D5: 無音では発生も残像もない。次に鳴ったとき前の絵が出ないよう消しておく。
      if (this.lights.length > 0) this.lights.length = 0;
      this.needsClear = true;
      this.smoothedVolume = 0;
      this.spawnCooldown = 0;
      this.pipeline?.update(audio, elapsed);
      return;
    }

    // 平滑。全画面が音量で明滅しないよう、明るさ系はすべてここを通す。
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

    // 反応の調整（D24）: 帯域ごとのゲイン。どの帯域が発生に効くかを VJ 中に変えられる。
    const bandTotal = bass + mid + treble;
    const bandWeight =
      bandTotal > 1e-4
        ? (this.response.bass * bass + this.response.mid * mid + this.response.treble * treble) /
          bandTotal
        : 1;

    this.spawnLights(audio, delta, volume, bandWeight);
    this.advanceLights(delta);

    // 明るさは平滑した音量から。急変させない。
    const volumeGain = (0.35 + this.smoothedVolume * 0.9) * clamp(bandWeight, 0.2, 2);
    const count = this.packLights(volumeGain);

    const decay = this.decayFor(delta);
    const hold = this.trailSeconds();
    const tau = hold / DECAY_DEPTH;
    // 残像が長いほど 1 点に積み上がる。溜まり方を抑えて雲の明るさを揃える。
    const gainBase = 1 / (1 + tau * 2.4);
    const frameNorm = clamp(delta > 0 ? delta * 60 : 1, 0.5, 2);

    const u = this.emitMaterial.uniforms;
    u.uLightCount!.value = count;
    u.uLightA!.value = this.lightA;
    u.uLightB!.value = this.lightB;
    u.uLightC!.value = this.lightC;
    u.uLightD!.value = this.lightD;
    u.uDecay!.value = decay;
    u.uGain!.value = gainBase * frameNorm;
    u.uClear!.value = this.needsClear ? 0 : 1;
    // 露出を上げすぎると全チャンネルが 1 へ張り付いて色が失われる。
    this.displayMaterial.uniforms.uExposure!.value = 0.85;

    this.stepFeedback();
    this.pipeline?.update(audio, elapsed);
  }

  /**
   * 発生。オンセット（立ち上がり）が主で、beat が補助。
   * 静かなときは頻度が落ち、無音では呼ばれない。音量だけでは光らせない。
   */
  private spawnLights(
    audio: AudioParameters,
    delta: number,
    volume: number,
    bandWeight: number,
  ): void {
    this.spawnCooldown = Math.max(this.spawnCooldown - delta, 0);
    const onset = clamp01(audio.onset);
    const beat = clamp01(audio.beat);
    const sensitivity = clamp(this.params.sensitivity, 0, 1);
    // Sensitivity が高いほど小さな立ち上がりでも拾う。
    const threshold = 0.45 - sensitivity * 0.40;
    const trigger = Math.max(onset, beat * 0.75);
    const rising = onset > this.previousOnset;
    this.previousOnset = onset;

    if (this.spawnCooldown > 0) return;
    if (trigger < threshold) {
      // 立ち上がりのない区間。完全には止めず、小さなスパークだけがまばらに出る。
      // 頻度は音量に比例するので、静かなほど自然に間遠になる。
      const sparkChance =
        clamp01(volume) * (0.4 + this.params.density * 0.8) * (0.3 + sensitivity);
      if (volume > 0.02 && this.rand() < sparkChance * delta * 6) {
        this.spawn(0.25 + this.smoothedTreble * 0.6, true);
        this.spawnCooldown = 0.12;
      }
      return;
    }
    if (!rising && beat < 0.5) return;

    const strength = clamp(trigger * (0.6 + bandWeight * 0.5), 0, 2);
    // 強いオンセットほど一度に多く出す（1〜3）。
    const burst = 1 + (strength > 0.65 ? 1 : 0) + (strength > 1.0 ? 1 : 0);
    const extra = Math.round(this.params.density * 1.4);
    for (let i = 0; i < burst + extra; i++) {
      // treble が強いフレームでは細かいスパークの割合が上がる。
      const spark = this.rand() < this.smoothedTreble * 0.65;
      this.spawn(strength * (spark ? 0.7 : 1), spark);
    }
    // 静かなほど間隔を空ける。
    this.spawnCooldown = 0.055 + (1 - clamp01(volume)) * 0.28;
  }

  /** ping-pong を 1 ステップ進める。 */
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
    // 軌跡はバッファそのものなので、作り直すと内容は消える（仕様どおり）。
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

  /**
   * テーマは当面この表現では使わない。黒背景とリファレンス由来の色で見え方を決める。
   * 値だけは保持し、プリセットの往復で失われないようにする。
   */
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
    // 板の形が変われば光源の居場所も変わる。外に出た個体は縁へ寄せる。
    const extents = this.plateExtents();
    for (const light of this.lights) {
      light.x = clamp(light.x, -extents.x, extents.x);
      light.y = clamp(light.y, -extents.y, extents.y);
      light.px = light.x;
      light.py = light.y;
    }
  }

  /** 開発用: 0 = 最終 / 1 = 蓄積バッファの生値。 */
  setDebugView(view: number): void {
    if (this.displayMaterial) this.displayMaterial.uniforms.uDebugView!.value = view;
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
    return `${this.lights.length} lights / trail ${this.trailSeconds().toFixed(2)}s`;
  }

  // ---------------------------------------------------------------- 表現ごとの調整

  getExpressionParams(): ExpressionParam[] {
    return [
      { key: 'trail', label: 'Trail', min: 0, max: 1, step: 0.01, value: this.params.trail },
      {
        key: 'sensitivity',
        label: 'Sensitivity',
        min: 0,
        max: 1,
        step: 0.01,
        value: this.params.sensitivity,
      },
      { key: 'density', label: 'Density', min: 0, max: 1, step: 0.01, value: this.params.density },
      {
        key: 'intensity',
        label: 'Intensity',
        min: 0,
        max: 1,
        step: 0.01,
        value: this.params.intensity,
      },
      { key: 'speed', label: 'Speed', min: 0, max: 1, step: 0.01, value: this.params.speed },
      { key: 'bloom', label: 'Bloom', min: 0, max: 1, step: 0.01, value: this.params.bloom },
      { key: 'seed', label: 'Seed', min: 0, max: 1, step: 0.001, value: this.params.seed },
    ];
  }

  /**
   * 調整はすべて実行中に効く。特に Trail は decay を差し替えるだけなので、
   * 軌跡バッファも光源もリセットされない（操作で絵が飛ばない）。
   */
  setExpressionParam(key: string, value: number): void {
    if (!Number.isFinite(value)) return;
    const next = clamp(value, 0, 1);
    if (key in this.params) {
      (this.params as Record<string, number>)[key] = next;
    }
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
