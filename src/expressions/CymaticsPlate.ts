import * as THREE from 'three';
import type {
  Composition,
  CompositionContext,
  DesignLayerCanvases,
} from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { Cymatics } from '../fields/Cymatics';
import type { ExpressionId } from './catalog';
import { THEMES, type Theme } from '../engine/themes';
import { TUNING } from '../engine/tuning';

/**
 * サイマティクス表現 — Granular Plate Model。
 *
 * 画面全体を上から見た一枚の板として扱う。完成した節線や図形は描かない。
 *
 * 実機構に沿った砂の運動:
 *   板の加速度が重力を超えた場所で砂粒は跳ね上げられ、着地位置が動く。
 *   腹では跳ね続け、節（振幅ゼロ）では跳ねないので動きが止まり、そこに溜まる。
 *   すなわち「移動度 ∝ 振動振幅」の自己捕捉ランダムウォークであり、
 *   砂は速度を蓄えない（慣性を持たない）。跳ねて着地するだけである。
 *
 *   - 密度場は GPU の ping-pong RenderTarget（R = 密度のみ）
 *   - 保存形の風上フラックス + 再正規化で総量を一定に保つ
 *   - CFL 制限を回避するため 1 フレームを分割して進める（TUNING.substeps）
 *   - 表示するのは砂だけ。節線そのものは描画しない
 *   - モードが変わると場は瞬時に切り替わり、腹に取り残された砂が跳ね始めて
 *     新しい節へ再配置される。中間形状は存在しない
 *
 * 音との対応（PRD §7。この表現での解釈）:
 *   周波数構成 → 主振動モード（＝図形の種類。Cymatics の L2）
 *   volume     → 励振の強さ＝どれだけ砂が跳ねるか（図形の種類は変えない）
 *   onset      → 一斉に跳ねる。旧配置が崩れ、再配置が促される
 *   flatness   → モードの崩れ
 *
 * 乱数源は座標と時間と音のシードによる決定論的ハッシュ。Math.random() は使わない。
 */

// 密度場の解像度。低いほど 1 サブステップで砂が遠くまで運べる（CFL は texel 幅に比例）。
// 表示側はバイリニアで読んで確率的に粒を撒くので、この解像度でも粗さは出ない。
const SIM_SIZE = 256;

const clamp01 = (value: number | undefined): number => Math.min(Math.max(value ?? 0, 0), 1);

export class CymaticsPlate implements Composition {
  readonly animated = true;
  readonly name = 'Cymatics';
  /** 表現の安定 id（保存データに入る）。V1 = 'cymatics-v1' / V2 = 'cymatics-v2'。 */
  readonly id: ExpressionId;

  private readonly field: Cymatics;
  private readonly effects: Effect[];
  private theme: Theme;
  private depthAmount = 0;
  private smoothedBass = 0;
  private zoom = 1;
  /**
   * 演奏面（PRD D24 案 1）: 各帯域が砂の励振へどれだけ寄与するか（0..2、既定 1）。
   * 像を結ぶ値（モード選択）には触れない。全部 1 のとき従来の音量駆動と厳密に一致する。
   */
  private response = { bass: 1, mid: 1, treble: 1 };
  /**
   * 画角（D26）。板そのものがこの比率の長方形になる。
   * 面積 1 に正規化: 半辺長は (√r, 1/√r)。シムのテクセルは物理的に正方形を保つ。
   */
  private aspectId = '1:1';
  private aspectRatio = 1;

  private context: CompositionContext | null = null;
  private displayScene: THREE.Scene | null = null;
  private simScene: THREE.Scene | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private displayGeometry: THREE.PlaneGeometry | null = null;
  private simGeometry: THREE.PlaneGeometry | null = null;
  private displayMaterial: THREE.ShaderMaterial | null = null;
  private simMaterial: THREE.ShaderMaterial | null = null;
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private massTarget: THREE.WebGLRenderTarget | null = null;
  private massScene: THREE.Scene | null = null;
  private massGeometry: THREE.PlaneGeometry | null = null;
  private massMaterial: THREE.ShaderMaterial | null = null;
  private current = 0;
  private needsInit = true;
  private pipeline: EffectPipeline | null = null;
  private previousElapsed = -1;

  /**
   * 場（振動モードの体系）は注入できる。省略時は V1（Cymatics）。
   * V2 は同じ砂の物理・Effect 基盤の上で場だけを差し替える（catalog.ts 経由で作る）。
   */
  constructor(
    effects: Effect[] = [],
    theme?: Theme,
    field: Cymatics = new Cymatics(),
    id: ExpressionId = 'cymatics-v1',
  ) {
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
    this.field = field;
    this.id = id;
  }

  /** 板の半辺長（面積 1 正規化）。x が √r、y が 1/√r。 */
  private plateExtents(): { x: number; y: number } {
    const s = Math.sqrt(Math.max(this.aspectRatio, 1e-6));
    return { x: s, y: 1 / s };
  }

  /**
   * シムターゲットを板の比率で作る。テクセルが物理的に正方形になるよう
   * 解像度も比率で割り振る（CFL・拡散の等方性が保たれる）。
   */
  private createSimTargets(): void {
    this.targets?.forEach((target) => target.dispose());
    const extents = this.plateExtents();
    const width = Math.max(Math.round(SIM_SIZE * extents.x), 16);
    const height = Math.max(Math.round(SIM_SIZE * extents.y), 16);
    const makeTarget = (): THREE.WebGLRenderTarget =>
      new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
    this.targets = [makeTarget(), makeTarget()];
    this.needsInit = true;
    if (this.simMaterial) {
      (this.simMaterial.uniforms.uTexel!.value as THREE.Vector2).set(1 / width, 1 / height);
    }
  }

  setup(context: CompositionContext): void {
    this.context = context;
    // 固有モードの励起はスペクトル全体から計算する（modeBank.ts）。
    this.field.setSpectrumSource(() => context.audioEngine.getSpectrum?.() ?? null);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;

    this.createSimTargets();

    // ---- 質量の計測（1×1 に平均密度を落とす） ----
    // 数値誤差でも粒子が減り続けないよう、シミュレーションはこの平均を
    // 目標量と比べてゆるやかに補正する。板の砂は常に一定量ある。
    this.massTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.massMaterial = new THREE.ShaderMaterial({
      uniforms: { tDensity: { value: null } },
      vertexShader: /* glsl */ `
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDensity;
        void main() {
          // 40×40 の層化サンプリング。バイリニアで各点が 4 テクセルを平均する。
          float sum = 0.0;
          for (int i = 0; i < 40; i++) {
            for (int j = 0; j < 40; j++) {
              sum += texture2D(tDensity, (vec2(float(i), float(j)) + 0.5) / 40.0).r;
            }
          }
          gl_FragColor = vec4(sum / 1600.0, 0.0, 0.0, 1.0);
        }
      `,
    });
    this.massScene = new THREE.Scene();
    this.massGeometry = new THREE.PlaneGeometry(2, 2);
    this.massScene.add(new THREE.Mesh(this.massGeometry, this.massMaterial));

    // ---- シミュレーション（板の 1 ステップ） ----
    this.simMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tState: { value: null },
        tMass: { value: null },
        uTargetMass: { value: TUNING.sandAmount },
        uInitState: { value: 1 },
        uDelta: { value: 0.002 },
        uTime: { value: 0 },
        uDrift: { value: TUNING.driftSpeed },
        uMobFloor: { value: TUNING.mobilityFloor },
        uMobSoft: { value: TUNING.mobilitySoft },
        uAgitation: { value: 1 },
        uNoise: { value: TUNING.agitationNoise },
        uRepulsion: { value: TUNING.repulsion },
        uDiffusion: { value: TUNING.diffusion },
        uRelease: { value: 0 },
        uScatter: { value: TUNING.releaseScatter },
        uReverse: { value: TUNING.releaseReverse },
        uTexel: { value: new THREE.Vector2(1 / SIM_SIZE, 1 / SIM_SIZE) },
        ...this.field.uniforms,
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
        uniform sampler2D tState;
        uniform sampler2D tMass;
        uniform float uTargetMass;
        uniform float uInitState;
        uniform float uDelta;
        uniform float uTime;
        uniform float uDrift;
        uniform float uMobFloor;
        uniform float uMobSoft;
        uniform float uAgitation;
        uniform float uNoise;
        uniform float uRepulsion;
        uniform float uDiffusion;
        uniform float uRelease;
        uniform float uScatter;
        uniform float uReverse;
        uniform vec2 uTexel;

        const float PI = 3.141592653589793;
        float gDepth = 0.0;
        vec2 gFieldCoord = vec2(0.0);

        ${this.field.glsl}

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        // 振動振幅。節線（field = 0）で 0、腹で大きい。
        float amp(vec2 uv) {
          return abs(field(uv * 2.0 - 1.0));
        }

        // 移動度: 板の加速度が重力を超えた場所で砂は跳ね上げられる。
        // 振幅が閾値を下回る節では跳ねないので、そこで動きが止まり砂が溜まる。
        // これが自己捕捉ランダムウォークの捕捉側にあたる。
        float mobility(float a, vec2 uv) {
          float m = smoothstep(uMobFloor, uMobFloor + max(uMobSoft, 0.01), a);
          // モード切替の過渡: 板全体が大きく鳴り、節に溜まっていた砂も跳ね上がる。
          // ここで移動度の下限を外さないと、節にいた砂だけが動かず模様が
          // そのまま次の模様へ変形して見えてしまう。
          m = mix(m, 1.0, uRelease);
          // 粒ごとのばらつき。線を有機的にする決定論的ノイズ。
          float n = hash(floor(uv * 256.0) + floor(uTime * 3.0) * 0.31);
          return m * uAgitation * (1.0 - uNoise * 0.5 + uNoise * n);
        }

        void main() {
          // 物理のセル幅。解像度を板の比率で割り振るため、テクセルは
          // どの画角でも物理的に正方形で、この値は一定になる（D26）。
          float texel = 1.0 / ${SIM_SIZE.toFixed(1)};
          // uv 空間での隣接テクセルへのオフセット（軸ごとに異なる）。
          vec2 tX = vec2(uTexel.x, 0.0);
          vec2 tY = vec2(0.0, uTexel.y);

          // 初期状態: 板に砂をほぼ均一に撒く（わずかな決定論的むら）。
          if (uInitState > 0.5) {
            float d = uTargetMass * (1.0 + (hash(vUv * 7.31) - 0.5) * 0.1);
            gl_FragColor = vec4(d, 0.0, 0.0, 1.0);
            return;
          }

          float dC = texture2D(tState, vUv).r;
          float dL = texture2D(tState, vUv - tX).r;
          float dR = texture2D(tState, vUv + tX).r;
          float dD = texture2D(tState, vUv - tY).r;
          float dU = texture2D(tState, vUv + tY).r;

          float aC = amp(vUv);
          float aL = amp(vUv - tX);
          float aR = amp(vUv + tX);
          float aD = amp(vUv - tY);
          float aU = amp(vUv + tY);

          float mC = mobility(aC, vUv);
          float mL = mobility(aL, vUv - tX);
          float mR = mobility(aR, vUv + tX);
          float mD = mobility(aD, vUv - tY);
          float mU = mobility(aU, vUv + tY);

          // 面ごとの速度: 跳ねている砂は振幅の低い側へ寄る。
          // 速さは移動度だけで決まり、斜面の急さでは決まらない。跳ね上げられた砂は
          // 勾配が緩くても同じように飛ぶため、腹の頂上でも取り残されない。
          // ref を小さく取ることで、わずかな傾きでも全速で寄る。
          // 慣性は持たない。砂は跳ねて着地するだけで、速度を蓄えない。
          float ref = 0.003;
          // 過渡の間は寄る向きを反転させ、節から砂を追い出す。収まるにつれて
          // 通常の向きへ戻り、散った砂が新しい節へ一気に集まる。
          float drift = uDrift * mix(1.0, -uReverse, uRelease);
          float vR = -drift * min(mC, mR) * clamp((aR - aC) / ref, -1.0, 1.0);
          float vL = -drift * min(mL, mC) * clamp((aC - aL) / ref, -1.0, 1.0);
          float vU = -drift * min(mC, mU) * clamp((aU - aC) / ref, -1.0, 1.0);
          float vD = -drift * min(mD, mC) * clamp((aC - aD) / ref, -1.0, 1.0);

          // 高密度からの反発。山が潰れて幅が不均一になる。
          float rep = uDrift * uRepulsion;
          vR += -rep * min(mC, mR) * clamp((dR - dC) * 2.0, -1.0, 1.0);
          vL += -rep * min(mL, mC) * clamp((dC - dL) * 2.0, -1.0, 1.0);
          vU += -rep * min(mC, mU) * clamp((dU - dC) * 2.0, -1.0, 1.0);
          vD += -rep * min(mD, mC) * clamp((dC - dD) * 2.0, -1.0, 1.0);

          // CFL: 1 サブステップで 1 テクセル以上流さない。
          float maxFlow = 0.22 * texel / max(uDelta, 1e-5);
          vR = clamp(vR, -maxFlow, maxFlow);
          vL = clamp(vL, -maxFlow, maxFlow);
          vU = clamp(vU, -maxFlow, maxFlow);
          vD = clamp(vD, -maxFlow, maxFlow);

          // 保存形の風上フラックス。隣接セルで正負同額になり総量が保たれる。
          float fR = (vR > 0.0 ? dC : dR) * vR;
          float fL = (vL > 0.0 ? dL : dC) * vL;
          float fU = (vU > 0.0 ? dC : dU) * vU;
          float fD = (vD > 0.0 ? dD : dC) * vD;

          // 着地位置のばらつきもフラックスとして足す。面ごとに対称な式にしないと
          // 隣接セルで出入りが釣り合わず、総量が漏れる。
          // 過渡の間は等方的に強く散らす（跳ね上げられた砂が板へばらける）。
          // 拡散も移流と同じ CFL 条件に従うため、同じ上限で頭を押さえる。
          float dif = min(uDiffusion * uDrift + uRelease * uScatter, maxFlow);
          fR += -dif * min(mC, mR) * (dR - dC);
          fL += -dif * min(mL, mC) * (dC - dL);
          fU += -dif * min(mC, mU) * (dU - dC);
          fD += -dif * min(mD, mC) * (dC - dD);

          // 板の縁は壁。外へは流れない。
          fR *= step(vUv.x + uTexel.x, 1.0);
          fL *= step(uTexel.x, vUv.x);
          fU *= step(vUv.y + uTexel.y, 1.0);
          fD *= step(uTexel.y, vUv.y);

          float density = dC - uDelta * (fR - fL + fU - fD) / texel;

          // 再正規化: 数値誤差による増減を打ち消し、砂の総量を一定に保つ。
          float measured = texture2D(tMass, vec2(0.5)).r;
          float correction = clamp(uTargetMass / max(measured, 0.02), 0.7, 1.4);
          density *= mix(1.0, correction, 0.05);

          gl_FragColor = vec4(clamp(density, 0.0, 8.0), 0.0, 0.0, 1.0);
        }
      `,
    });

    // ---- 表示（粒子だけを描く） ----
    this.displayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDensity: { value: null },
        uActive: { value: 0 },
        uTime: { value: 0 },
        uZoom: { value: this.zoom },
        uDepthAmount: { value: 0 },
        uGrainSize: { value: TUNING.grainBase },
        uInk: { value: TUNING.inkBase },
        uThemeDark: { value: new THREE.Vector3(...this.theme.dark) },
        uThemeLight: { value: new THREE.Vector3(...this.theme.light) },
        uThemeAccent: { value: new THREE.Vector3(...this.theme.accent) },
        uDebugView: { value: 0 },
        uSandRef: { value: TUNING.sandAmount },
        ...this.field.uniforms,
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
        uniform sampler2D tDensity;
        uniform float uActive;
        uniform float uTime;
        uniform float uZoom;
        uniform float uDepthAmount;
        uniform float uGrainSize;
        uniform float uInk;
        uniform vec3 uThemeDark;
        uniform vec3 uThemeLight;
        uniform vec3 uThemeAccent;
        uniform float uDebugView;
        uniform float uSandRef;

        const float PI = 3.141592653589793;
        float gDepth = 0.0;
        vec2 gFieldCoord = vec2(0.0);

        ${this.field.glsl}

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        void main() {
          // D5: 音が鳴っていなければ何も見せない。
          if (uActive < 0.5) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          // 板は選択中の画角そのもの（D26: 長方形の板）。キャンバスの比率は
          // 板の比率に一致させてあるので、uv がそのまま板の全面になる。
          vec2 p = (vUv * 2.0 - 1.0) / max(uZoom, 0.05);

          // 開発用の可視化（本番では uDebugView = 0 のまま）。
          // 1 = 粒子密度 / 2 = 振動場 / 3 = 節線候補（振幅の谷）
          if (uDebugView > 0.5) {
            if (uDebugView < 1.5) {
              float d = texture2D(tDensity, clamp(p * 0.5 + 0.5, 0.0, 1.0)).r;
              gl_FragColor = vec4(vec3(clamp(d * 0.6, 0.0, 1.0)), 1.0);
            } else if (uDebugView < 2.5) {
              float v = field(p);
              gl_FragColor = vec4(max(v, 0.0), abs(v) * 0.15, max(-v, 0.0), 1.0);
            } else {
              float potential = abs(field(p));
              gl_FragColor = vec4(vec3(1.0 - smoothstep(0.0, 0.35, potential)), 1.0);
            }
            return;
          }

          // 奥行き（D6）: 同じ板を尺度を変えて奥に重ねる。
          float separation = clamp(uDepthAmount, 0.0, 1.0);
          float acc = 0.0;
          for (int i = 2; i >= 0; i--) {
            float fi = float(i);
            float weight = i == 0 ? 1.0 : pow(0.4, fi) * min(separation * 2.0, 1.0);
            if (weight < 0.002) continue;
            vec2 drift = vec2(
              sin(uTime * (0.05 + fi * 0.02) + fi * 2.4),
              cos(uTime * (0.04 + fi * 0.017) - fi * 1.7)
            ) * 0.08 * separation * fi;
            vec2 q = (p * (1.0 + separation * fi * 0.5) + drift) * 0.5 + 0.5;
            // 板の外は黒。端をクランプで引き伸ばすと縁が滲むため。
            if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) continue;
            float density = texture2D(tDensity, q).r;

            // 粒子: 密度を確率として粒を撒く。高密度は明るい面に近づき、
            // 低密度は孤立した粒として見える。粒はゆっくり入れ替わる。
            vec2 cell = floor(gl_FragCoord.xy / max(uGrainSize, 0.35));
            float g = hash(cell + floor(uTime * 2.5) * 0.37 + fi * 3.1);
            // 平均密度を基準にする。砂の総量を変えても見え方の階調が変わらない。
            float rel = density / max(uSandRef, 0.02);
            float probability = clamp(rel * 0.5, 0.0, 1.0);
            float particle = step(1.0 - probability, g) * (0.35 + 0.65 * hash(cell * 1.93 + 7.7));
            float pile = smoothstep(2.5, 7.0, rel) * 0.4;
            float lum = (particle * 0.75 + pile) * weight * (1.0 - fi * 0.18);
            acc = 1.0 - (1.0 - acc) * (1.0 - lum);
          }

          float luma = clamp(acc * clamp(uInk, 0.0, 1.0), 0.0, 1.0);
          vec3 themed = mix(uThemeDark, uThemeLight, luma) + uThemeAccent * pow(luma, 4.0);
          gl_FragColor = vec4(clamp(themed, 0.0, 1.0), 1.0);
        }
      `,
    });

    this.simScene = new THREE.Scene();
    this.simGeometry = new THREE.PlaneGeometry(2, 2);
    this.simScene.add(new THREE.Mesh(this.simGeometry, this.simMaterial));

    this.displayScene = new THREE.Scene();
    this.displayGeometry = new THREE.PlaneGeometry(2, 2);
    this.displayScene.add(new THREE.Mesh(this.displayGeometry, this.displayMaterial));

    this.pipeline = new EffectPipeline(
      context.renderer,
      this.displayScene,
      this.camera,
      this.effects,
    );

    // setup 前に setAspect が呼ばれていても、ここで板の寸法が uniform に揃う。
    this.syncPlateUniforms();
  }

  update(elapsed: number): void {
    if (!this.context || !this.simMaterial || !this.displayMaterial) return;
    const audio = this.context.audioEngine.getParameters();
    const active = audio.active === 1;

    const delta =
      this.previousElapsed < 0
        ? 0
        : Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.05);
    this.previousElapsed = elapsed;

    this.displayMaterial.uniforms.uActive!.value = active ? 1 : 0;
    this.displayMaterial.uniforms.uTime!.value = elapsed;
    this.displayMaterial.uniforms.uGrainSize!.value = TUNING.grainBase;
    this.displayMaterial.uniforms.uSandRef!.value = TUNING.sandAmount;
    this.displayMaterial.uniforms.uInk!.value =
      TUNING.inkBase + clamp01(audio.sustain) * TUNING.inkSustain;

    // 奥行き: 低域が層の分離をわずかに押し広げる。
    this.smoothedBass += (clamp01(audio.bass) - this.smoothedBass) * 0.12;
    this.displayMaterial.uniforms.uDepthAmount!.value =
      this.depthAmount * (0.85 + this.smoothedBass * 0.3);

    if (active) {
      // 音 → 振動場（モード・対称性・構図・うねり）。
      this.field.update(audio, elapsed);

      // 音 → 板の励振。音量とオンセットが「どれだけ砂が跳ねるか」を決める。
      // 図形の種類は決めない（それはモード＝周波数構成の仕事）。
      //
      // 演奏面（D24 案 1）: 帯域の再重み付け。どの帯域が励振に効くかを VJ 中に
      // 変えられる。全ゲイン 1 のとき weight = 1 となり従来の音量駆動と一致する。
      const volume = clamp01(audio.volume);
      const bass = clamp01(audio.bass);
      const mid = clamp01(audio.mid);
      const treble = clamp01(audio.treble);
      const bandTotal = bass + mid + treble;
      const weight =
        bandTotal > 1e-4
          ? (this.response.bass * bass + this.response.mid * mid + this.response.treble * treble) /
            bandTotal
          : 1;
      const drive = clamp01(volume * weight);
      const u = this.simMaterial.uniforms;
      const agitation =
        (TUNING.quietFloor + (1 - TUNING.quietFloor) * drive) *
        (1 + clamp01(audio.onset) * TUNING.onsetBurst);
      u.uAgitation!.value = agitation;
      u.uDrift!.value = TUNING.driftSpeed;
      u.uMobFloor!.value = TUNING.mobilityFloor;
      u.uMobSoft!.value = TUNING.mobilitySoft;
      u.uNoise!.value = TUNING.agitationNoise;
      u.uRepulsion!.value = TUNING.repulsion;
      u.uDiffusion!.value = TUNING.diffusion;
      u.uTargetMass!.value = TUNING.sandAmount;
      u.uTime!.value = elapsed;
      // モード切替直後だけ立つ跳ね上げ。V1 の場は常に 0 を返す。
      const release = this.field.getRelease();
      u.uRelease!.value = release;
      u.uScatter!.value = TUNING.releaseScatter;
      u.uReverse!.value = TUNING.releaseReverse;

      // 平均密度の計測はフレームに 1 回で足りる（再正規化はゆるやかに効くため）。
      this.measureMass();

      // CFL 制限のため 1 フレームを分割して進める。
      // 分割数だけ砂が速く動けるので、再配置が一瞬で終わるようになる。
      // 跳ね上げの間はさらに増やす。1 サブステップで運べる量は texel/dt に
      // 縛られるため、分割数を上げないと散らばりが上限に張り付いて効かない。
      const frame = delta > 0 ? Math.min(delta, 0.033) : 0.016;
      const steps = Math.max(
        1,
        Math.round(TUNING.substeps * (1 + release * TUNING.releaseSubsteps)),
      );
      u.uDelta!.value = frame / steps;
      for (let i = 0; i < steps; i++) this.stepSimulation();
    }

    this.pipeline?.update(audio, elapsed);
  }

  /** 現在の密度場の平均を 1×1 へ落とす。再正規化の基準になる。 */
  private measureMass(): void {
    if (this.needsInit) return;
    if (!this.context || !this.targets || !this.massMaterial || !this.massScene) return;
    if (!this.massTarget || !this.camera) return;
    const renderer = this.context.renderer;
    const previousTarget = renderer.getRenderTarget();
    this.massMaterial.uniforms.tDensity!.value = this.targets[this.current]!.texture;
    renderer.setRenderTarget(this.massTarget);
    renderer.render(this.massScene, this.camera);
    renderer.setRenderTarget(previousTarget);
  }

  /** 板を 1 サブステップ進める（ping-pong）。無音時は呼ばれず、砂は止まったまま。 */
  private stepSimulation(): void {
    if (!this.context || !this.targets || !this.simMaterial || !this.simScene || !this.camera) {
      return;
    }
    const renderer = this.context.renderer;
    const next = 1 - this.current;
    const previousTarget = renderer.getRenderTarget();

    this.simMaterial.uniforms.tState!.value = this.targets[this.current]!.texture;
    this.simMaterial.uniforms.tMass!.value = this.massTarget?.texture ?? null;
    this.simMaterial.uniforms.uInitState!.value = this.needsInit ? 1 : 0;
    renderer.setRenderTarget(this.targets[next]!);
    renderer.render(this.simScene, this.camera);
    renderer.setRenderTarget(previousTarget);
    this.current = next;
    this.needsInit = false;
    this.displayMaterial!.uniforms.tDensity!.value = this.targets[this.current]!.texture;
  }

  render(): void {
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    // キャンバスの比率は板の比率（D26）に main 側で揃えられる。
    this.pipeline?.resize(width, height);
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
    if (!this.displayMaterial) return;
    (this.displayMaterial.uniforms.uThemeDark!.value as THREE.Vector3).set(...theme.dark);
    (this.displayMaterial.uniforms.uThemeLight!.value as THREE.Vector3).set(...theme.light);
    (this.displayMaterial.uniforms.uThemeAccent!.value as THREE.Vector3).set(...theme.accent);
  }

  /** 画角（D26）。板そのものの比率。 */
  getAspectId(): string {
    return this.aspectId;
  }

  getAspectRatio(): number {
    return this.aspectRatio;
  }

  /**
   * 画角を切り替える。板を取り替える操作なので、砂は撒き直しになる
   * （模様は音が鳴っていれば数秒で再形成される）。
   */
  setAspect(id: string, ratio: number): void {
    if (id === this.aspectId) return;
    this.aspectId = id;
    this.aspectRatio = Math.min(Math.max(ratio, 0.25), 4);
    if (this.targets) this.createSimTargets();
    this.syncPlateUniforms();
  }

  /** 板の寸法を場とシムの uniform へ反映する。 */
  private syncPlateUniforms(): void {
    const extents = this.plateExtents();
    (this.field.uniforms.uPlate!.value as THREE.Vector2).set(extents.x, extents.y);
    if (this.simMaterial && this.targets) {
      const size = this.targets[0]!;
      (this.simMaterial.uniforms.uTexel!.value as THREE.Vector2).set(
        1 / size.width,
        1 / size.height,
      );
    }
  }

  /** 演奏面（D24 案 1）: 帯域ごとの励振ゲイン。 */
  getResponse(): { bass: number; mid: number; treble: number } {
    return { ...this.response };
  }

  setResponse(gains: Partial<{ bass: number; mid: number; treble: number }>): void {
    const clamp = (value: number | undefined, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(value, 0), 2)
        : fallback;
    this.response = {
      bass: clamp(gains.bass, this.response.bass),
      mid: clamp(gains.mid, this.response.mid),
      treble: clamp(gains.treble, this.response.treble),
    };
  }

  getDepth(): number {
    return this.depthAmount;
  }

  setDepth(amount: number): void {
    this.depthAmount = Math.min(Math.max(amount, 0), 1);
  }

  /** 開発用: 0=最終 1=粒子密度 2=振動場 3=節線候補。本番 UI からは触れない。 */
  setDebugView(view: number): void {
    if (this.displayMaterial) this.displayMaterial.uniforms.uDebugView!.value = view;
  }

  /** 開発用: 励起の内部状態（デバッグパネルが読む）。 */
  getDebugState(): ReturnType<Cymatics['getExciterState']> {
    return this.field.getExciterState();
  }

  getZoom(): number {
    return this.zoom;
  }

  setZoom(zoom: number): void {
    this.zoom = Math.min(Math.max(zoom, 0.25), 8);
    if (this.displayMaterial) this.displayMaterial.uniforms.uZoom!.value = this.zoom;
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
    this.massTarget?.dispose();
    this.displayGeometry?.dispose();
    this.simGeometry?.dispose();
    this.massGeometry?.dispose();
    this.displayMaterial?.dispose();
    this.simMaterial?.dispose();
    this.massMaterial?.dispose();
    this.field.dispose();
    this.targets = null;
    this.massTarget = null;
    this.massScene = null;
    this.massMaterial = null;
    this.pipeline = null;
    this.displayScene = null;
    this.simScene = null;
    this.camera = null;
    this.displayMaterial = null;
    this.simMaterial = null;
    this.context = null;
  }
}
