import * as THREE from 'three';
import type {
  CompositionContext,
  DesignLayerCanvases,
} from '../compositions/Composition';
import type { AudioParameters } from '../audio/AudioEngine';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import {
  BandLightEventDetector,
  type BandCoincidence,
  type BandFlux,
  type BandGateState,
  type BandLightEvent,
  type BandName,
} from '../engine/bandLightEvents';
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
 *   - Core は生まれた場所から動かない。サイズも固定。**時間で動くのは明るさだけ**。
 *   - 余韻は Decay のみ。残像バッファ（フィードバック）を持たない。
 *
 * 既存の Light Traces（`LightTraces.ts`）とはコードを一切共有しない。あちらは
 * 完成へ向かう表現で、こちらは因果関係の計測器なので、片方の都合がもう片方へ
 * 漏れないよう独立させている。
 *
 * 構造:
 *   ① Onset 検出（帯域別スペクトルフラックス）
 *        engine の onset（広帯域 Volume の差分 × 8）は使わない。実測で 3 つ壊れていた:
 *          - 正規化 Volume が 1 に張り付く盛り上がりでは差分が出ず、発火がゼロになる
 *          - ピーク追従の天井が 30〜40 秒降りないため、直後の静かな区間で感度が落ちる
 *          - 持続音の上に乗るハイハットのように、音量が増えない出来事を拾えない
 *        代わりに `getSpectrum()` の生 FFT から自前でフラックスを取る。
 *        engine は読むだけで、値も副作用も変えない（FileAudioEngine は無変更）。
 *
 *        責務は 2 つに割ってある。**測る側と決める側を混ぜない。**
 *          `BandFluxAnalyzer` … 帯域ごとに「どれだけ増えたか」を測るだけ
 *          `OnsetGate`        … その値から「撃つかどうか」を決めるだけ
 *        局所適応閾値（方式 A）を入れるときは `OnsetGate` だけを差し替える。
 *   ② Core の一生（Attack → Hold → Decay）
 *        すべて秒で管理し、経過時間 delta から進めるのでフレームレートに依存しない。
 *        Decay が終わった Core は配列から取り除き、参照を残さない。
 *   ③ 配置（スペクトル重心 → 横位置）
 *        発生の瞬間の centroid だけで X が決まり、その Core が消えるまで動かない。
 *        音が明るくなっても、既に生まれた光は追従しない。
 *   ④ 描画
 *        フルスクリーンクアッド 1 枚のシェーダーで、uniform 配列の Core を
 *        柔らかい円形スプラットとして加算する。Bloom なしで見える明るさにする。
 *
 * 音との対応（役割を 1 対 1 に保つ。1 つの特徴量が 2 つの見え方を動かさない）:
 *   フラックスの立ち上がり → 発生するかどうか（鳴り続けても増えない）
 *   フラックスの大きさ     → その Core 自身の明るさ（Exposure や Bloom には触らない）
 *   centroid               → その Core の横位置（明るさ・サイズ・寿命には触らない）
 *   縦位置は常に中央。無音（active !== 1）は黒・発生ゼロ（PRD D5）。
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
  /**
   * 横位置の余白（板の幅に対する割合）。centroid の 0..1 をこの内側だけに写すので、
   * 一番低い音でも一番高い音でも Core が画面の端で切れない。
   * 0.15 なら X は板の 15%〜85% に収まり、両端に半径 2 個ぶんの余白が残る。
   */
  horizontalMargin: 0.15,
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
    /**
     * フラックスを 0..1 へ写す倍率。reference.wav の実測（拍の山は素の値で
     * 0.15〜0.49、無音側は 0.02 以下）から、拍が 0.38〜1.0 に載るよう 2.5 にした。
     * 天井追従のような長期状態は持たない（曲全体を見て動かすのは方式 A の領分）。
     */
    fluxGain: 2.5,
    /** 発火後のクールダウン。1 つの立ち上がりで何度も撃たないための最短間隔。 */
    cooldownMs: 60,
    /**
     * 1 つの打撃から何本の帯域を光らせるか。最強帯域の strength に対する比で、
     * これを**超えた**帯域だけを追加で光らせる。
     *
     * 既定 1.0 は「最強帯域のみ」（比が 1 を超えることはないので追加は起きない）。
     * reference.wav の実測では帯域イベントの 81% が複数帯域だったが、その多くは
     * 打撃の漏れ込み（キック 8.02 秒は 3 帯域が立つのに treble の strength は 0.16）で、
     * 全部光らせると Core が 60 → 152 個へ 2.5 倍に増えてしまう。
     * 下げると同時 Core が増える（0.6 で 1 打あたり平均 1.94 個）。
     */
    relativeStrengthFloor: 1,
  },
  /** 同パラメータの可動域（Inspector のスライダーがそのまま使う）。 */
  ranges: {
    attackMs: { min: 1, max: 200, step: 1 },
    holdMs: { min: 0, max: 500, step: 1 },
    decayMs: { min: 20, max: 2000, step: 10 },
    minimumIntensity: { min: 0, max: 1, step: 0.01 },
    maximumIntensity: { min: 0, max: 1, step: 0.01 },
    onsetSensitivity: { min: 0, max: 1, step: 0.01 },
    fluxGain: { min: 1, max: 40, step: 0.5 },
    cooldownMs: { min: 0, max: 400, step: 5 },
    relativeStrengthFloor: { min: 0.4, max: 1, step: 0.05 },
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
  /**
   * この Core を生んだ帯域。**描画には使わない**（白・サイズ固定は変えない）。
   * どの帯域が光を出したのかを Inspector で追うためだけに持つ。
   */
  readonly band: BandName;
  /** トリガした瞬間の centroid（0..1。engine が対数で正規化済み）。 */
  readonly spectralCentroid: number;
  /**
   * 横位置。板の幅に対する割合（0 = 左端 / 0.5 = 中央 / 1 = 右端）で持つ。
   * 板の実寸ではなく割合なので、画角を変えても余白の見え方が保たれる。
   * 発生時に決まり、寿命の間ずっと動かない。
   */
  readonly x: number;
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
  readonly band: BandName;
  readonly spectralCentroid: number;
  /** 板の幅に対する割合（0..1）。 */
  readonly x: number;
  readonly peakIntensity: number;
  readonly currentIntensity: number;
  readonly phase: CorePhase;
}

export interface CoreStudyState {
  readonly count: number;
  readonly lastOnsetStrength: number;
  readonly lastSpectralCentroid: number;
  readonly lastX: number;
  readonly lastPeakIntensity: number;
  /** いま測れている帯域別フラックス（新方式の生の観測値）。 */
  readonly flux: BandFlux;
  /** いま効いている発火閾値。局所適応の結果がそのまま入る。 */
  readonly onsetThreshold: number;
  /** 統計が溜まりきっておらず、固定閾値で動いているか。 */
  readonly thresholdWarmingUp: boolean;
  /** 統計窓に入っている本数。 */
  readonly thresholdSamples: number;
  /** strength を割る参照値（局所正規化が切れているときは 0）。 */
  readonly strengthReference: number;
  readonly adaptiveThreshold: boolean;
  readonly adaptiveStrength: boolean;
  /** 発火した回数（単調増加）。Inspector のランプはこれの増分で点く。 */
  readonly fireCount: number;
  /** 帯域別 Onset（Bass / Mid / Treble を独立に判定したもの）。ここから Core が生まれる。 */
  readonly bands: Readonly<Record<BandName, BandGateState>>;
  readonly coincidence: BandCoincidence;
  /** 直近に Core を生んだ帯域。まだ無ければ null。 */
  readonly lastBand: BandName | null;
  /** 直近のイベントで同時に出した Core の数。 */
  readonly lastEventCores: number;
  /** 結合窓が開いている（次の Core を待っている）か。 */
  readonly eventPending: boolean;
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
  /** シェーダーへ渡す (x, y, 明るさ)。縦は常に板の中央なので y は 0。 */
  private readonly coreData = new Float32Array(CORE_STUDY.maximumCores * 3);

  /**
   * 音イベントの検出。**描画から独立した層**（`src/engine/bandLightEvents.ts`）で、
   * 帯域別フラックス → 帯域別 Gate → 結合窓 → 帯域選択までを担う。
   * 3D の Spatial Study も同じ検出器から同じイベント列を受け取る。
   */
  private readonly detector = new BandLightEventDetector();
  private lastBand: BandName | null = null;
  private lastEventCores = 0;
  /** 閾値の局所適応。切ると固定閾値（方式 B）に戻る。 */
  private adaptiveThreshold = true;
  /** strength の局所正規化。閾値の適応とは独立に切れる。 */
  private adaptiveStrength = true;

  private previousElapsed = -1;
  private lastOnsetStrength = 0;
  private lastSpectralCentroid = 0;
  private lastX = 0.5;
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

  /**
   * 測る → 決める → まとめる → 生む。
   *
   * 検出は `BandLightEventDetector` に任せ、ここは返ってきたイベントから
   * 2D の Core を作るだけ。engine は読むだけで何も変えない。
   */
  private detectOnset(audio: AudioParameters, elapsed: number, delta: number): void {
    const spectrum = this.context?.audioEngine.getSpectrum?.() ?? null;
    const events = this.detector.update(
      spectrum,
      {
        volume: clamp01(audio.volume ?? 0),
        bass: clamp01(audio.bass ?? 0),
        mid: clamp01(audio.mid ?? 0),
        treble: clamp01(audio.treble ?? 0),
        // centroid は engine が対数で 0..1 に正規化済み。Hz の生値は使わない。
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
        relativeStrengthFloor: this.params.relativeStrengthFloor,
        adaptiveThreshold: this.adaptiveThreshold,
        adaptiveStrength: this.adaptiveStrength,
      },
    );
    if (events.length === 0) return;
    this.lastEventCores = events.length;
    for (const event of events) this.spawnFromEvent(event);
  }

  /** イベント 1 個から Core を 1 個作る。見え方の解釈はここだけが持つ。 */
  private spawnFromEvent(event: BandLightEvent): void {
    this.spawn(event.strength, event.spectralCentroid, event.band);
  }

  /**
   * 検出器の状態をまとめて捨てる。
   *
   * 呼ばれるのは音が止まったとき（`active !== 1`）と dispose。音源の差し替えは
   * `FileAudioEngine` の `load` / `loadUrl` / `startInput` / `stopInput` がいずれも
   * 先に `pause()`・`stopInput()` を通るため、必ず `active = 0` のフレームを挟む。
   * つまり 0↔1 の遷移だけ見ていれば、古い曲の統計が次の曲へ残ることはない。
   */
  private resetDetection(): void {
    this.detector.reset();
    this.lastBand = null;
    this.lastEventCores = 0;
  }

  /**
   * スペクトル重心 0..1 を横位置（板の幅に対する割合）へ写す。
   * 低い（暗い）音ほど左、高い（明るい）音ほど右。両端には余白を残す。
   */
  private centroidToX(centroid: number): number {
    const margin = clamp(CORE_STUDY.horizontalMargin, 0, 0.49);
    return margin + clamp01(centroid) * (1 - 2 * margin);
  }

  /**
   * Core を 1 個生む。サイズは固定・縦位置は中央で、音が決めるのは
   * 「発生するか」（フラックスの立ち上がり）・「その Core 自身の明るさ」
   * （フラックスの大きさ）・「横位置」（centroid）の 3 つだけ。互いに混ぜない。
   */
  private spawn(strength: number, centroid: number, band: BandName): void {
    if (this.cores.length >= CORE_STUDY.maximumCores) this.cores.shift();
    const minimum = clamp01(this.params.minimumIntensity);
    const maximum = Math.max(clamp01(this.params.maximumIntensity), minimum);
    const peakIntensity = minimum + strength * (maximum - minimum);
    const x = this.centroidToX(centroid);
    this.cores.push({
      age: 0,
      onsetStrength: strength,
      band,
      spectralCentroid: centroid,
      x,
      peakIntensity,
      currentIntensity: 0,
      phase: 'attack',
      completed: false,
      attackSeconds: this.params.attackMs / 1000,
      holdSeconds: this.params.holdMs / 1000,
      decaySeconds: this.params.decayMs / 1000,
    });
    this.lastOnsetStrength = strength;
    this.lastSpectralCentroid = centroid;
    this.lastX = x;
    this.lastPeakIntensity = peakIntensity;
    this.lastBand = band;
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
    // 割合で持っている X を板座標へ直す。板の実寸は画角で変わるので毎フレーム掛け直し、
    // 画角を切り替えても余白の見え方が変わらないようにする。
    const halfWidth = this.plateExtents().x;
    for (let i = 0; i < this.cores.length; i++) {
      const core = this.cores[i]!;
      // 横は centroid が決めた位置に固定。縦は常に中央。時間で動くのは明るさだけ。
      this.coreData[i * 3] = (core.x - 0.5) * 2 * halfWidth;
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
      // フラックスの比較元も捨てる。再開時に「止まる前との差」で誤爆させないため。
      this.cores.length = 0;
      this.resetDetection();
      this.syncCoreUniforms();
      this.pipeline?.update(audio, elapsed);
      return;
    }

    // 発生 → 進行の順。立ち上がったフレームのぶんだけ Core も進み、
    // 発生直後の 1 フレームが真っ暗になるのを避ける。
    this.detectOnset(audio, elapsed, delta);
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
    const f = this.detector.bandFlux;
    const th = (band: BandName): string => this.detector.bandState(band).threshold.toFixed(2);
    return (
      `cores ${this.cores.length} / last ${this.lastBand ?? '-'} ${this.lastOnsetStrength.toFixed(2)} / ` +
      `flux b${f.bass.toFixed(2)} m${f.mid.toFixed(2)} t${f.treble.toFixed(2)} / ` +
      `th ${th('bass')}/${th('mid')}/${th('treble')}`
    );
  }

  /** 開発・検証用。Inspector と `window.__lab` から Core の内部状態を読む。 */
  getCoreStudyState(): CoreStudyState {
    const combined = this.detector.combined;
    return {
      count: this.cores.length,
      lastOnsetStrength: this.lastOnsetStrength,
      lastSpectralCentroid: this.lastSpectralCentroid,
      lastX: this.lastX,
      lastPeakIntensity: this.lastPeakIntensity,
      flux: this.detector.bandFlux,
      onsetThreshold: combined.threshold,
      thresholdWarmingUp: combined.warmingUp,
      thresholdSamples: combined.samples,
      strengthReference: combined.strengthReference,
      adaptiveThreshold: this.adaptiveThreshold,
      adaptiveStrength: this.adaptiveStrength,
      fireCount: combined.fireCount,
      bands: {
        bass: this.detector.bandState('bass'),
        mid: this.detector.bandState('mid'),
        treble: this.detector.bandState('treble'),
      },
      coincidence: this.detector.coincidence,
      lastBand: this.lastBand,
      lastEventCores: this.lastEventCores,
      eventPending: this.detector.eventPending,
      cores: this.cores.map((core) => ({
        age: core.age,
        onsetStrength: core.onsetStrength,
        band: core.band,
        spectralCentroid: core.spectralCentroid,
        x: core.x,
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
    const onOff = (key: string, label: string, enabled: boolean): ExpressionParam => ({
      key,
      label,
      type: 'select',
      options: [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
      value: enabled ? 'on' : 'off',
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
      row('relativeStrengthFloor', 'Band floor'),
      // 適応は 2 つを独立に切れるようにしておく。切り分けができないと、
      // 見え方が変わったときにどちらが効いたのか分からなくなる。
      onOff('adaptiveThreshold', 'Adaptive threshold', this.adaptiveThreshold),
      onOff('adaptiveStrength', 'Adaptive strength', this.adaptiveStrength),
    ];
  }

  setExpressionParam(key: string, value: number | string): void {
    if (key === 'adaptiveThreshold' || key === 'adaptiveStrength') {
      const enabled = value === 'on' || value === 1;
      if (key === 'adaptiveThreshold') this.adaptiveThreshold = enabled;
      else this.adaptiveStrength = enabled;
      return;
    }
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
    // 統計も捨てる。表現を作り直したときに古い曲の窓が残らないようにする。
    this.resetDetection();
    this.pipeline = null;
    this.scene = null;
    this.geometry = null;
    this.material = null;
    this.camera = null;
    this.context = null;
  }
}
