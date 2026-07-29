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
 * Light Traces — Core Study。**検証用の実験表現**であり、完成イメージへ寄せる表現ではない。
 *
 * 目的はただ 1 つ、「音の立ち上がり（Onset）と、画面に現れる光の因果関係」を
 * 目と数値の両方で確かめること。そのため構成を可能な限り削ってある:
 *
 *   - 黒背景 + 白い Core だけ。RGB 分離・Beam・Trail・Fog・Haze・破片は持たない。
 *   - Core の位置は常に画面中央。サイズは固定。**動くのは明るさだけ**。
 *   - 余韻は Decay のみ。残像バッファ（フィードバック）を持たない。
 *
 * 既存の Light Traces（`LightTraces.ts`）とはコードを一切共有しない。あちらは
 * 完成へ向かう表現で、こちらは因果関係の計測器なので、片方の都合がもう片方へ
 * 漏れないよう独立させている。
 *
 * 構造:
 *   ① Onset 検出
 *        engine の onset（広帯域音量の上昇分 × 8 を 0..1 にクランプした瞬間値）を土台に、
 *        表現側で「立ち上がりエッジ + 閾値 + 短いクールダウン」を掛ける。
 *        engine 側は読むだけで、値も副作用も変えない。
 *   ② Core の一生（Attack → Hold → Decay）
 *        すべて秒で管理し、経過時間 delta から進めるのでフレームレートに依存しない。
 *        Decay が終わった Core は配列から取り除き、参照を残さない。
 *   ③ 描画
 *        フルスクリーンクアッド 1 枚のシェーダーで、uniform 配列の Core を
 *        柔らかい円形スプラットとして加算する。Bloom なしで見える明るさにする。
 *
 * 音との対応:
 *   onset  → 発生するかどうか（立ち上がりエッジのみ。鳴り続けても増えない）
 *   onset の大きさ → その Core 自身の明るさ（Exposure や Bloom には触らない）
 *   無音（active !== 1）は黒・発生ゼロ（PRD D5）。
 *
 * 乱数は使わない（Math.random() 禁止。そもそも恣意的な要素を置いていない）。
 */

/**
 * この表現の定数はすべてここに集める。
 * 質感の調整ではなく検証条件そのものなので、`TUNING`（サイマティクス用）には載せない。
 */
const CORE_STUDY = {
  /** 同時に生かす Core の上限。シェーダーの uniform 配列長と必ず一致させる。 */
  maximumCores: 32,
  /** Core の半径（板座標。板の短辺は 2 なので 0.11 は短辺の約 5.5%）。音では変えない。 */
  coreRadius: 0.11,
  /** ガウス減衰の鋭さ。半径の位置で exp(-3) ≈ 0.05 まで落ちる。 */
  coreFalloff: 3,
  /** 感度 0 のときの Onset 閾値。大きな立ち上がりしか採らない。 */
  onsetThresholdAtZeroSensitivity: 0.6,
  /** 感度 1 のときの Onset 閾値。無音のノイズを拾わないよう 0 にはしない。 */
  onsetThresholdAtFullSensitivity: 0.12,
  /** この音量を下回るフレームでは発火させない。ピーク追従で増幅された無音への保険。 */
  minimumVolume: 0.06,
  /** 発火後のクールダウン（秒）。1 つの立ち上がりで何度も撃たないための最短間隔。 */
  cooldownSeconds: 0.06,
  /** 1 フレームで進める時間の上限（秒）。タブ復帰時の巨大な delta を切る。 */
  maximumDelta: 0.05,
  /** Decay の曲がり。大きいほど頭で速く落ちる。0 に近づくほど直線に近い。 */
  decayCurve: 3,
  /** 開発用パラメータの既定値。方向性は Attack 極短 / Hold 短 / Decay 長め。 */
  defaults: {
    attackMs: 15,
    holdMs: 60,
    decayMs: 350,
    minimumIntensity: 0.35,
    maximumIntensity: 1,
    onsetSensitivity: 0.5,
  },
  /** 同パラメータの可動域（Inspector のスライダーがそのまま使う）。 */
  ranges: {
    attackMs: { min: 1, max: 200, step: 1 },
    holdMs: { min: 0, max: 500, step: 1 },
    decayMs: { min: 20, max: 2000, step: 10 },
    minimumIntensity: { min: 0, max: 1, step: 0.01 },
    maximumIntensity: { min: 0, max: 1, step: 0.01 },
    onsetSensitivity: { min: 0, max: 1, step: 0.01 },
  },
} as const;

type CoreStudyParamKey = keyof typeof CORE_STUDY.defaults;

/** Core の一生の段階。`done` は当該フレームで寿命を終えたことを表す。 */
export type CorePhase = 'attack' | 'hold' | 'decay' | 'done';

interface Core {
  /** 発生からの経過秒。delta を積むだけなのでフレーム数には依存しない。 */
  age: number;
  /** トリガした瞬間の onset 値（0..1）。 */
  readonly onsetStrength: number;
  /** この Core が Hold で到達する明るさ。 */
  readonly peakIntensity: number;
  /** 現在の明るさ。シェーダーへ渡るのはこれだけ。 */
  currentIntensity: number;
  phase: CorePhase;
  completed: boolean;
  /** 段階の長さ（秒）。発生時のパラメータで固定し、途中で伸び縮みさせない。 */
  readonly attackSeconds: number;
  readonly holdSeconds: number;
  readonly decaySeconds: number;
}

/** 開発・検証用に外へ見せる Core 1 個ぶんの状態。 */
export interface CoreStudySnapshot {
  readonly age: number;
  readonly onsetStrength: number;
  readonly peakIntensity: number;
  readonly currentIntensity: number;
  readonly phase: CorePhase;
}

/** 開発・検証用の表現全体の状態。Inspector と `window.__lab` から読む。 */
export interface CoreStudyState {
  readonly count: number;
  readonly lastOnsetStrength: number;
  readonly lastPeakIntensity: number;
  readonly cores: readonly CoreStudySnapshot[];
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const clamp01 = (value: number): number => clamp(value, 0, 1);

/**
 * Decay の形。t = 0 で 1、t = 1 でちょうど 0 になる指数曲線。
 * 単調減少なので、時系列を見れば Attack → Hold → Decay の順序が読み取れる。
 */
const decayShape = (t: number): number => {
  const k = CORE_STUDY.decayCurve;
  const floor = Math.exp(-k);
  return (Math.exp(-k * t) - floor) / (1 - floor);
};

export class LightCoreStudy implements LabExpression {
  readonly animated = true;
  readonly name = 'Light Traces — Core Study';
  readonly id: ExpressionId = 'light-core-study-v1';

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  private readonly params: Record<CoreStudyParamKey, number> = {
    ...CORE_STUDY.defaults,
  };

  private context: CompositionContext | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private scene: THREE.Scene | null = null;
  private geometry: THREE.PlaneGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private pipeline: EffectPipeline | null = null;

  private readonly cores: Core[] = [];
  /** シェーダーへ渡す (x, y, 明るさ)。位置は常に板の中央なので xy は 0。 */
  private readonly coreData = new Float32Array(CORE_STUDY.maximumCores * 3);

  private previousElapsed = -1;
  private previousOnset = 0;
  private cooldown = 0;
  private lastOnsetStrength = 0;
  private lastPeakIntensity = 0;

  constructor(effects: Effect[] = [], theme?: Theme) {
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
  }

  // ---------------------------------------------------------------- 板の寸法

  /** 板そのものが画角の長方形になる（PRD D26）。距離を等方に測るための係数。 */
  private plateExtents(): { x: number; y: number } {
    const s = Math.sqrt(Math.max(this.aspectRatio, 1e-6));
    return { x: s, y: 1 / s };
  }

  private syncPlateUniform(): void {
    if (!this.material) return;
    const extents = this.plateExtents();
    (this.material.uniforms.uPlate!.value as THREE.Vector2).set(extents.x, extents.y);
  }

  // ---------------------------------------------------------------- setup

  setup(context: CompositionContext): void {
    this.context = context;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCores: { value: this.coreData },
        uCoreCount: { value: 0 },
        uPlate: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: CORE_STUDY.coreRadius },
        uFalloff: { value: CORE_STUDY.coreFalloff },
        uZoom: { value: this.zoom },
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
        uniform vec3 uCores[${CORE_STUDY.maximumCores}];
        uniform float uCoreCount;
        uniform vec2 uPlate;
        uniform float uRadius;
        uniform float uFalloff;
        uniform float uZoom;

        void main() {
          // 板座標。短辺が 2 になるよう uPlate で伸ばすので、円は円のまま残る。
          vec2 p = (vUv - 0.5) * 2.0 * uPlate / max(uZoom, 0.0001);
          float sum = 0.0;
          for (int i = 0; i < ${CORE_STUDY.maximumCores}; i++) {
            if (float(i) >= uCoreCount) break;
            vec3 core = uCores[i];
            float k = distance(p, core.xy) / max(uRadius, 0.0001);
            sum += core.z * exp(-k * k * uFalloff);
          }
          // 白飛びし続けないよう頭を止める。NaN は clamp の前に落とす。
          float level = clamp(max(sum, 0.0), 0.0, 1.0);
          gl_FragColor = vec4(vec3(level), 1.0);
        }
      `,
    });

    this.scene = new THREE.Scene();
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.scene.add(new THREE.Mesh(this.geometry, this.material));

    this.pipeline = new EffectPipeline(context.renderer, this.scene, this.camera, this.effects);
    this.syncPlateUniform();
  }

  // ---------------------------------------------------------------- Onset

  /** 感度 0..1 を Onset の閾値へ写す。感度が高いほど小さな立ち上がりも採る。 */
  private onsetThreshold(): number {
    const high = CORE_STUDY.onsetThresholdAtZeroSensitivity;
    const low = CORE_STUDY.onsetThresholdAtFullSensitivity;
    return high - clamp01(this.params.onsetSensitivity) * (high - low);
  }

  /**
   * 立ち上がりエッジ + 閾値 + クールダウン。
   * engine の onset は瞬間値なので、鳴り続けている間はエッジが立たず発火しない。
   */
  private detectOnset(audio: AudioParameters, delta: number): void {
    this.cooldown = Math.max(this.cooldown - delta, 0);
    const onset = clamp01(audio.onset ?? 0);
    const volume = clamp01(audio.volume ?? 0);
    const rising = onset > this.previousOnset;
    this.previousOnset = onset;
    if (!rising) return;
    if (onset < this.onsetThreshold()) return;
    if (volume < CORE_STUDY.minimumVolume) return;
    if (this.cooldown > 0) return;
    this.cooldown = CORE_STUDY.cooldownSeconds;
    this.spawn(onset);
  }

  /**
   * Core を 1 個生む。位置は常に中央、サイズは固定で、
   * 音が決めるのは「発生するか」と「その Core 自身の明るさ」だけ。
   */
  private spawn(strength: number): void {
    if (this.cores.length >= CORE_STUDY.maximumCores) this.cores.shift();
    const minimum = clamp01(this.params.minimumIntensity);
    const maximum = Math.max(clamp01(this.params.maximumIntensity), minimum);
    const peakIntensity = minimum + strength * (maximum - minimum);
    this.cores.push({
      age: 0,
      onsetStrength: strength,
      peakIntensity,
      currentIntensity: 0,
      phase: 'attack',
      completed: false,
      attackSeconds: this.params.attackMs / 1000,
      holdSeconds: this.params.holdMs / 1000,
      decaySeconds: this.params.decayMs / 1000,
    });
    this.lastOnsetStrength = strength;
    this.lastPeakIntensity = peakIntensity;
  }

  // ---------------------------------------------------------------- 一生

  /** 経過秒だけ進める。明るさは age の純粋な関数なので、フレームレートに依存しない。 */
  private advance(core: Core, delta: number): void {
    core.age += delta;
    const attack = core.attackSeconds;
    const hold = core.holdSeconds;
    const decay = core.decaySeconds;

    if (core.age < attack) {
      core.phase = 'attack';
      core.currentIntensity = core.peakIntensity * (attack <= 0 ? 1 : core.age / attack);
      return;
    }
    if (core.age < attack + hold) {
      core.phase = 'hold';
      core.currentIntensity = core.peakIntensity;
      return;
    }
    const t = decay <= 0 ? 1 : (core.age - attack - hold) / decay;
    if (t >= 1) {
      core.phase = 'done';
      core.currentIntensity = 0;
      core.completed = true;
      return;
    }
    core.phase = 'decay';
    core.currentIntensity = core.peakIntensity * decayShape(t);
  }

  /** 進めながら、終わった Core を詰めて捨てる（参照を残さない）。 */
  private advanceCores(delta: number): void {
    let write = 0;
    for (let read = 0; read < this.cores.length; read++) {
      const core = this.cores[read]!;
      this.advance(core, delta);
      if (core.completed) continue;
      this.cores[write] = core;
      write += 1;
    }
    this.cores.length = write;
  }

  private syncCoreUniforms(): void {
    if (!this.material) return;
    for (let i = 0; i < this.cores.length; i++) {
      const core = this.cores[i]!;
      // 位置は常に板の中央。動かすのは明るさだけ。
      this.coreData[i * 3] = 0;
      this.coreData[i * 3 + 1] = 0;
      this.coreData[i * 3 + 2] = core.currentIntensity;
    }
    this.material.uniforms.uCoreCount!.value = this.cores.length;
    this.material.uniformsNeedUpdate = true;
  }

  // ---------------------------------------------------------------- update

  update(elapsed: number): void {
    if (!this.context || !this.material) return;
    const audio = this.context.audioEngine.getParameters();
    const active = audio.active === 1;

    const delta =
      this.previousElapsed < 0
        ? 0
        : clamp(elapsed - this.previousElapsed, 0, CORE_STUDY.maximumDelta);
    this.previousElapsed = elapsed;

    if (!active) {
      // PRD D5: 音がなければ発生も余韻もない（無音＝黒画面が正常）。
      this.cores.length = 0;
      this.previousOnset = 0;
      this.cooldown = 0;
      this.syncCoreUniforms();
      this.pipeline?.update(audio, elapsed);
      return;
    }

    // 発生 → 進行の順。立ち上がったフレームのぶんだけ Core も進み、
    // 発生直後の 1 フレームが真っ暗になるのを避ける。
    this.detectOnset(audio, delta);
    this.advanceCores(delta);
    this.syncCoreUniforms();
    this.pipeline?.update(audio, elapsed);
  }

  render(): void {
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
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

  /** 状態としては持つが描画には使わない（黒背景 + 白い Core だけ）。 */
  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  /** 色のテーマは持たない表現（PRD D25）。UI は効かないセレクトを出さない。 */
  usesTheme(): boolean {
    return false;
  }

  getZoom(): number {
    return this.zoom;
  }

  setZoom(zoom: number): void {
    this.zoom = clamp(zoom, 0.25, 8);
    if (this.material) this.material.uniforms.uZoom!.value = this.zoom;
  }

  getResponse(): { bass: number; mid: number; treble: number } {
    return { ...this.response };
  }

  /**
   * 帯域ゲインは状態として保持するだけで、この表現では像に効かせない。
   * 検証したいのは onset と光の因果だけなので、途中に別の変数を挟まない。
   */
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
    this.syncPlateUniform();
  }

  setDebugView(): void {
    // 切り替える中間表現を持たない（Core の明るさがすべて）。
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
    return `cores ${this.cores.length} / last strength ${this.lastOnsetStrength.toFixed(2)}`;
  }

  /** 開発・検証用。Inspector と `window.__lab` から Core の内部状態を読む。 */
  getCoreStudyState(): CoreStudyState {
    return {
      count: this.cores.length,
      lastOnsetStrength: this.lastOnsetStrength,
      lastPeakIntensity: this.lastPeakIntensity,
      cores: this.cores.map((core) => ({
        age: core.age,
        onsetStrength: core.onsetStrength,
        peakIntensity: core.peakIntensity,
        currentIntensity: core.currentIntensity,
        phase: core.phase,
      })),
    };
  }

  // ---------------------------------------------------------------- 開発用パラメータ

  getExpressionParams(): ExpressionParam[] {
    const row = (key: CoreStudyParamKey, label: string): ExpressionParam => ({
      key,
      label,
      ...CORE_STUDY.ranges[key],
      value: this.params[key],
    });
    return [
      row('attackMs', 'Attack (ms)'),
      row('holdMs', 'Hold (ms)'),
      row('decayMs', 'Decay (ms)'),
      row('minimumIntensity', 'Min intensity'),
      row('maximumIntensity', 'Max intensity'),
      row('onsetSensitivity', 'Onset sensitivity'),
    ];
  }

  setExpressionParam(key: string, value: number | string): void {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return;
    if (!(key in this.params)) return;
    const range = CORE_STUDY.ranges[key as CoreStudyParamKey];
    this.params[key as CoreStudyParamKey] = clamp(numeric, range.min, range.max);
  }

  setGeneratorsVisible(): void {
    // 表示の切り替えは存在しない。
  }

  setDesignLayerCanvases(canvases: DesignLayerCanvases): void {
    this.pipeline?.setOverlayCanvases(canvases);
  }

  updateDesignLayerCanvases(): void {
    this.pipeline?.updateOverlayCanvases();
  }

  dispose(): void {
    this.pipeline?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.cores.length = 0;
    this.pipeline = null;
    this.scene = null;
    this.geometry = null;
    this.material = null;
    this.camera = null;
    this.context = null;
  }
}
