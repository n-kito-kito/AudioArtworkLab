import * as THREE from 'three';
import type {
  Composition,
  CompositionContext,
  DesignLayerCanvases,
} from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { Cymatics } from '../fields/Cymatics';
import { THEMES, type Theme } from '../engine/themes';
import { TUNING } from '../engine/tuning';

/**
 * サイマティクス表現 — Granular Plate Model。
 *
 * 画面全体を上から見た一枚の板として扱う。完成した節線や図形は描かない。
 * 不可視の振動場 A(x,y)（クラドニのモード形状）を作り、粒子（密度場）が
 * 振動の大きい場所から小さい場所へ移動して節線に集積することで、
 * 像が「自発的に現れる」ようにする。
 *
 *   - 振動場は Cymatics（場）が担う。音 → モード・対称性・構図は従来どおり
 *   - 粒子は GPU の密度場（ping-pong RenderTarget）で運ぶ。
 *     R = 密度, GB = 速度。総量は移流 + 拡散でほぼ保存される（厳密ではない）
 *   - 表示するのは粒子だけ。節線そのものは描画しない
 *   - モードが変わると振動場が移り、旧配置は崩れてから新しい節線へ再集積する
 *
 * 音との対応（PRD §7。この表現での解釈）:
 *   pitch    → 主振動モードの選択（Cymatics の L2）
 *   volume   → 励振の強さ = 粒子の移動速度
 *   sustain  → 定着。鳴り続けるほど粒子は節線に落ち着く
 *   onset    → 粒子が一瞬浮き、再配置が促される
 *   centroid → 場の細かさ（副モード的な高次化。Cymatics の uScale）
 *   flatness → モードの崩れと粒子の散乱
 *
 * 乱数源は座標と時間と音のシードによる決定論的ハッシュ。Math.random() は使わない。
 */

const SIM_SIZE = 512;

const clamp01 = (value: number | undefined): number => Math.min(Math.max(value ?? 0, 0), 1);

export class CymaticsPlate implements Composition {
  readonly animated = true;
  readonly name = 'Cymatics';

  private readonly field = new Cymatics();
  private readonly effects: Effect[];
  private theme: Theme;
  private depthAmount = 0;
  private smoothedBass = 0;
  private zoom = 1;

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

  constructor(effects: Effect[] = [], theme?: Theme) {
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
  }

  setup(context: CompositionContext): void {
    this.context = context;
    // 固有モードの励起はスペクトル全体から計算する（modeBank.ts）。
    this.field.setSpectrumSource(() => context.audioEngine.getSpectrum?.() ?? null);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;

    const makeTarget = (): THREE.WebGLRenderTarget =>
      new THREE.WebGLRenderTarget(SIM_SIZE, SIM_SIZE, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
    this.targets = [makeTarget(), makeTarget()];
    this.needsInit = true;

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
        uDelta: { value: 0.016 },
        uTime: { value: 0 },
        uExcite: { value: 0 },
        uJitter: { value: 0 },
        uOnsetLift: { value: 0 },
        uSettleRate: { value: 1 },
        uRepulsion: { value: TUNING.repulsion },
        uDiffusion: { value: TUNING.diffusion },
        uNodeGrip: { value: TUNING.nodeGrip },
        uMaxSpeed: { value: TUNING.simSpeed },
        uSeedJitter: { value: 0 },
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
        uniform float uExcite;
        uniform float uJitter;
        uniform float uOnsetLift;
        uniform float uSettleRate;
        uniform float uRepulsion;
        uniform float uDiffusion;
        uniform float uNodeGrip;
        uniform float uMaxSpeed;
        uniform float uSeedJitter;

        const float PI = 3.141592653589793;
        float gDepth = 0.0;
        vec2 gFieldCoord = vec2(0.0);

        ${this.field.glsl}

        // 振動振幅。節線（field = 0）で 0、腹で大きい。
        float amp(vec2 uv) {
          vec2 p = uv * 2.0 - 1.0;
          return clamp(abs(field(p)) * 0.5, 0.0, 1.0);
        }

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        void main() {
          float texel = 1.0 / ${SIM_SIZE.toFixed(1)};

          // 初期状態: 板に砂をほぼ均一に撒く（わずかな決定論的むら）。
          if (uInitState > 0.5) {
            float d = uTargetMass * (1.0 + (hash(vUv * 7.31) - 0.5) * 0.1);
            gl_FragColor = vec4(d, 0.0, 0.0, 1.0);
            return;
          }

          vec4 state = texture2D(tState, vUv);

          // 振動場の勾配。粒子は振動の大きい方から小さい方へ押される。
          float aC = amp(vUv);
          vec2 gradA = vec2(
            amp(vUv + vec2(texel, 0.0)) - amp(vUv - vec2(texel, 0.0)),
            amp(vUv + vec2(0.0, texel)) - amp(vUv - vec2(0.0, texel))
          ) / (2.0 * texel);
          float gradLen = length(gradA);
          vec2 slope = gradLen > 1e-5 ? gradA / gradLen : vec2(0.0);
          vec2 force = -slope * min(gradLen, 1.0) * uExcite;

          // 高密度からの反発。山が潰れ、線幅が不均一になる。
          vec4 sL = texture2D(tState, vUv - vec2(texel, 0.0));
          vec4 sR = texture2D(tState, vUv + vec2(texel, 0.0));
          vec4 sD = texture2D(tState, vUv - vec2(0.0, texel));
          vec4 sU = texture2D(tState, vUv + vec2(0.0, texel));
          float dL = sL.r; float dR = sR.r; float dD = sD.r; float dU = sU.r;
          force -= vec2(dR - dL, dU - dD) * 0.5 * uRepulsion;

          // 振動による跳躍。振動の大きい場所ほど強く跳ね、
          // オンセットで一瞬浮く。乱数源は座標・時間・音のシード。
          float h = hash(floor(vUv * ${SIM_SIZE.toFixed(1)}) + floor(uTime * 7.0) * 0.173 + uSeedJitter);
          float angle = h * 6.2831853;
          force += vec2(cos(angle), sin(angle)) * (uJitter * (0.25 + aC) + uOnsetLift);

          // 速度更新: 力 + 摩擦（sustain で定着が強まる）。
          // 節線の近くでは静止度が徐々に増し、粒子は節に留まる。
          float grip = 1.0 - smoothstep(0.0, 0.2, aC);
          vec2 vel = (state.gb + force * uDelta)
            * exp(-(uSettleRate + uNodeGrip * grip) * uDelta);
          float speed = length(vel);
          if (speed > uMaxSpeed) vel *= uMaxSpeed / speed;

          // 密度の輸送: 保存形のフラックス（有限体積・風上差分）。
          // 面ごとの流出入は隣接セルで正負同額になるため、粒子総量は保存される。
          // CFL 制限: 1 ステップで 1 テクセル以上流れないよう速度を局所的に抑える。
          // 4 面が同時に流出しても総量がセルの質量を超えないよう 0.2 に抑える。
          float maxFlow = 0.2 * texel / max(uDelta, 1e-4);
          vec2 vC = state.gb; float sC = length(vC); if (sC > maxFlow) vC *= maxFlow / sC;
          vec2 vL = sL.gb;    float sLn = length(vL); if (sLn > maxFlow) vL *= maxFlow / sLn;
          vec2 vR = sR.gb;    float sRn = length(vR); if (sRn > maxFlow) vR *= maxFlow / sRn;
          vec2 vD = sD.gb;    float sDn = length(vD); if (sDn > maxFlow) vD *= maxFlow / sDn;
          vec2 vU = sU.gb;    float sUn = length(vU); if (sUn > maxFlow) vU *= maxFlow / sUn;

          float faceR = 0.5 * (vC.x + vR.x);
          float faceL = 0.5 * (vL.x + vC.x);
          float faceU = 0.5 * (vC.y + vU.y);
          float faceD = 0.5 * (vD.y + vC.y);
          float fluxR = (faceR > 0.0 ? state.r : dR) * faceR;
          float fluxL = (faceL > 0.0 ? dL : state.r) * faceL;
          float fluxU = (faceU > 0.0 ? state.r : dU) * faceU;
          float fluxD = (faceD > 0.0 ? dD : state.r) * faceD;

          // 板の縁は壁。外へは流れない（質量保存）。
          fluxR *= step(vUv.x + texel, 1.0);
          fluxL *= step(texel, vUv.x);
          fluxU *= step(vUv.y + texel, 1.0);
          fluxD *= step(texel, vUv.y);
          float density = state.r - uDelta * (fluxR - fluxL + fluxU - fluxD) / texel;

          // 拡散: わずかなにじみ。孤立粒が残るよう弱く。
          float average = (dL + dR + dD + dU) * 0.25;
          density = mix(density, average, clamp(uDiffusion * uDelta * 15.0, 0.0, 0.5));

          // 再正規化: 総量を目標へゆるやかに引き戻す。
          // 数値誤差による漏れを打ち消し、板の砂を常に一定量に保つ。
          float measured = texture2D(tMass, vec2(0.5)).r;
          float correction = clamp(uTargetMass / max(measured, 0.02), 0.8, 1.25);
          density *= mix(1.0, correction, 0.06);

          // 上限は安全弁。低すぎると山が飽和して流入分が消え、質量が漏れる。
          gl_FragColor = vec4(clamp(density, 0.0, 16.0), vel, 1.0);
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
            float density = texture2D(tDensity, clamp(q, 0.0, 1.0)).r;

            // 粒子: 密度を確率として粒を撒く。高密度は明るい面に近づき、
            // 低密度は孤立した粒として見える。粒はゆっくり入れ替わる。
            vec2 cell = floor(gl_FragCoord.xy / max(uGrainSize, 0.35));
            float g = hash(cell + floor(uTime * 2.5) * 0.37 + fi * 3.1);
            float probability = clamp(density * 0.8, 0.0, 1.0);
            float particle = step(1.0 - probability, g) * (0.35 + 0.65 * hash(cell * 1.93 + 7.7));
            float pile = smoothstep(0.65, 1.8, density) * 0.55;
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
    this.displayMaterial.uniforms.uInk!.value =
      TUNING.inkBase + clamp01(audio.sustain) * TUNING.inkSustain;

    // 奥行き: 低域が層の分離をわずかに押し広げる。
    this.smoothedBass += (clamp01(audio.bass) - this.smoothedBass) * 0.12;
    this.displayMaterial.uniforms.uDepthAmount!.value =
      this.depthAmount * (0.85 + this.smoothedBass * 0.3);

    if (active) {
      // 音 → 振動場（モード・対称性・構図・うねり）。
      this.field.update(audio, elapsed);

      // 音 → 板の状態。
      const volume = clamp01(audio.volume);
      const u = this.simMaterial.uniforms;
      u.uExcite!.value = TUNING.excite * (0.25 + volume * 1.5);
      u.uJitter!.value =
        TUNING.jitterBase * (0.2 + volume) + clamp01(audio.flatness) * TUNING.scatter;
      u.uOnsetLift!.value = clamp01(audio.onset) * TUNING.lift;
      u.uSettleRate!.value = TUNING.settleBase + clamp01(audio.sustain) * TUNING.settleSustain;
      u.uRepulsion!.value = TUNING.repulsion;
      u.uDiffusion!.value = TUNING.diffusion;
      u.uNodeGrip!.value = TUNING.nodeGrip * (0.4 + 0.6 * clamp01(audio.sustain));
      u.uMaxSpeed!.value = TUNING.simSpeed;
      u.uSeedJitter!.value = (audio.seed ?? 0) * 13.7;
      u.uTargetMass!.value = TUNING.sandAmount;
      u.uDelta!.value = delta > 0 ? delta : 0.016;
      u.uTime!.value = elapsed;

      this.stepSimulation();
    }

    this.pipeline?.update(audio, elapsed);
  }

  /** 板を 1 ステップ進める（ping-pong）。無音時は呼ばれず、砂は止まったまま。 */
  private stepSimulation(): void {
    if (!this.context || !this.targets || !this.simMaterial || !this.simScene || !this.camera) {
      return;
    }
    const renderer = this.context.renderer;
    const next = 1 - this.current;
    const previousTarget = renderer.getRenderTarget();

    // 現在の状態から平均密度を測り、このステップの再正規化に使う。
    if (!this.needsInit && this.massMaterial && this.massScene && this.massTarget) {
      this.massMaterial.uniforms.tDensity!.value = this.targets[this.current]!.texture;
      renderer.setRenderTarget(this.massTarget);
      renderer.render(this.massScene, this.camera);
    }

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
