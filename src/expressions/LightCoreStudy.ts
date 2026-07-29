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
   * 固定閾値の写像（感度 0 / 感度 1）。
   * 局所統計が溜まるまでのウォームアップと、適応を切ったときの閾値に使う。
   */
  onsetThresholdAtZeroSensitivity: 0.55,
  onsetThresholdAtFullSensitivity: 0.08,

  // ---- 局所適応（方式 A）----
  /**
   * 発火判定を、直近数秒のフラックスの分布に対する相対値で決める。
   * 固定閾値は 1 曲での較正でしかなく、曲や区間で音圧・密度が変わると効きがずれる。
   *
   * 閾値 = max(absoluteFloor, 底 + k × (代表的な山の高さ − 底))
   *   底             = 窓の中央値（打撃の合間の水準。実測ではほぼ 0）
   *   代表的な山の高さ = 窓に入った**山（局所最大）の中央値**
   *
   * 散らばりは平均や標準偏差ではなく**順序統計**で測る。打撃そのものが外れ値なので、
   * 平均系だと打撃が自分の閾値を押し上げて自分を埋めてしまう。
   *
   * 「山の中央値」を使うのは、**全フレームの分位点では打撃を捉えられない**ため。
   * 実測ではフラックスの中央値はほぼ 0（打撃の合間は増分が出ない）で、打撃は
   * 全フレームの 3〜7% しかない。0.5 秒に 1 発のような疎な曲だと 3% を切るので、
   * どんな上側分位点を選んでも打撃の下に潜ってしまい、閾値が下限に張り付く。
   * 山だけを別に集めれば、打撃の密度に関係なく「この区間の打撃の大きさ」が取れる。
   */
  adaptive: {
    /** 統計窓（秒）。フレーム数ではなく秒で持つのでフレームレートに依存しない。 */
    windowSeconds: 2.5,
    /** この本数が溜まるまではウォームアップ扱いにして固定閾値へ落とす。 */
    minimumSamples: 40,
    /** 山がこの数だけ溜まるまでもウォームアップ扱いにする。 */
    minimumPeaks: 4,
    /**
     * 閾値の下限。**必須**。無音や微小ノイズの統計に適応して閾値が下がりきると、
     * ノイズで発火してしまう。実測のノイズ側（p90）が 0.02〜0.05 だったので、
     * その 2〜5 倍の余裕を取って 0.10 に置く。D5 は `active !== 1` と二重に守る。
     */
    absoluteFloor: 0.1,
    /** 感度 0 のときの k（厳しい。閾値は上側分位点そのものに近づく）。 */
    kAtZeroSensitivity: 1,
    /** 感度 1 のときの k（緩い。閾値は下限に近づく）。 */
    kAtFullSensitivity: 0.1,
    /**
     * strength を局所正規化するときの参照値の下限。
     * 静かな区間で微小なフラックスが 1.0 に化けるのを防ぐ。
     */
    strengthReferenceFloor: 0.35,
  },

  // ---- 帯域別スペクトルフラックス ----
  /**
   * 帯域の境界（Hz）。engine の Bass / Mid / Treble と同じ切り方に揃えてある。
   * 実際のビン範囲は nyquist から毎回計算するので、サンプルレートが変わっても崩れない。
   */
  bands: {
    bass: [20, 250],
    mid: [250, 4000],
    treble: [4000, 16000],
  },
  /**
   * 合成の仕方。`max` は 3 帯域の最大値で、持続音の上に乗るハイハットを
   * Treble 帯だけで拾えるようにするための既定。`weighted` は重み付き和。
   */
  fluxCombine: 'max' as 'max' | 'weighted',
  /** `weighted` を選んだときの重み。合計で割るので比だけが意味を持つ。 */
  fluxWeights: { bass: 1, mid: 1, treble: 1 },
  /**
   * フラックスを測り直す最短間隔（ミリ秒）。これより短い間隔では差分がほぼ 0 になり、
   * 高リフレッシュ環境ほど値が小さく出てしまうので、一定の窓まで待ってから測る。
   */
  fluxIntervalMs: 10,
  /**
   * 測った増分をこの間隔あたりへ換算する（ミリ秒）。窓幅が 10ms でも 33ms でも
   * 同じ音なら同じ値になり、フレームレートに依存しなくなる。
   */
  fluxReferenceMs: 16.7,
  /**
   * 換算に使う窓幅の上限（ミリ秒）。タブ復帰などで窓が開きすぎたときに
   * 増分を過小評価しないよう頭を止める。
   */
  fluxMaximumIntervalMs: 50,
  /**
   * 横位置の余白（板の幅に対する割合）。centroid の 0..1 をこの内側だけに写すので、
   * 一番低い音でも一番高い音でも Core が画面の端で切れない。
   * 0.15 なら X は板の 15%〜85% に収まり、両端に半径 2 個ぶんの余白が残る。
   */
  horizontalMargin: 0.15,
  /**
   * 帯域の発火をひとつの打撃としてまとめる窓（ミリ秒）。
   *
   * 同じ 1 打でも、帯域ごとにフラックスの山が来るフレームは 1〜2 枚ずれる
   * （実測: reference.wav の 3.01 秒 Bass / 3.02 秒 Mid）。窓を開いて拾い集めないと
   * 1 打が 2 イベントに割れ、Core が二重に出る。30ms ≒ 2 フレームの遅れは
   * 音と光のずれとして知覚できない範囲。時間基準なのでフレームレートに依存しない。
   */
  eventCoalesceMs: 30,
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

/** 帯域別スペクトルフラックス。すべて 0..1（ゲイン適用後）。 */
export interface BandFlux {
  readonly bass: number;
  readonly mid: number;
  readonly treble: number;
  /** 発火判定に使う合成値。 */
  readonly combined: number;
}

export type BandName = 'bass' | 'mid' | 'treble';

/** 帯域 Gate 1 本ぶんの観察結果。 */
export interface BandGateState {
  /** いま効いている適応閾値。 */
  readonly threshold: number;
  readonly warmingUp: boolean;
  /** 直近に発火したときの strength。まだ一度も発火していなければ 0。 */
  readonly lastStrength: number;
  /** 累計発火回数（単調増加）。 */
  readonly fireCount: number;
}

/**
 * 帯域別 Onset の同時発火の集計（観察用）。
 * 「同じ計測フレームで何本立ったか」を数え、複数発光へ進むかどうかの材料にする。
 */
export interface BandCoincidence {
  readonly bassOnly: number;
  readonly midOnly: number;
  readonly trebleOnly: number;
  readonly twoBands: number;
  readonly threeBands: number;
  /** 直近に立った帯域の組み合わせ（例 'Bass + Mid'）。まだ無ければ空文字。 */
  readonly lastEvent: string;
  /** 何かしら立ったフレームの総数（＝上の 5 分類の合計）。 */
  readonly events: number;
}

/** 開発・検証用の表現全体の状態。Inspector と `window.__lab` から読む。 */
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

const NO_FLUX: BandFlux = { bass: 0, mid: 0, treble: 0, combined: 0 };

/** 帯域の並び。表示と集計の順序をここ 1 箇所で決める。 */
const BAND_NAMES: readonly BandName[] = ['bass', 'mid', 'treble'];

/** 集計の表示名。'Bass + Mid' のようなラベルを作るのに使う。 */
const BAND_LABELS: Readonly<Record<BandName, string>> = {
  bass: 'Bass',
  mid: 'Mid',
  treble: 'Treble',
};

const EMPTY_COINCIDENCE: BandCoincidence = {
  bassOnly: 0,
  midOnly: 0,
  trebleOnly: 0,
  twoBands: 0,
  threeBands: 0,
  lastEvent: '',
  events: 0,
};

/**
 * 帯域別スペクトルフラックス（測る側）。
 *
 *   flux = Σ max(0, mag[i] − prev[i])   … 増えたぶんだけを足す（減った音は無視する）
 *
 * を Bass / Mid / Treble ごとに求め、**帯域のビン数で割って規模を揃える**。
 * 帯域幅がまるで違う（Bass は十数ビン、Treble は数百ビン）ので、割らないと
 * 高域だけが常に大きく出てしまう。
 *
 * 測るのは「どれだけ増えたか」だけで、撃つかどうかは決めない（それは `OnsetGate`）。
 * 天井追従のような長期状態も持たない（それは方式 A の領分）。
 *
 * フレームレート非依存: 差分はスペクトルを取り直す間隔に比例するので、
 * `fluxIntervalMs` 以上開いたときだけ測り直し、測った値を
 * `fluxReferenceMs` あたりの増分へ換算する。間隔が開かないフレームでは
 * 直前の値をそのまま返す（ラッチ）。
 */
export class BandFluxAnalyzer {
  private previous: Float32Array | null = null;
  private latched: BandFlux = NO_FLUX;
  /** 直前にフラックスを測った時刻（秒）。負なら未計測。 */
  private lastMeasured = -1;
  /** ラッチ中か（＝このフレームでは測り直していない）。エッジ検出の抑止に使う。 */
  private refreshed = false;

  get value(): BandFlux {
    return this.latched;
  }

  /** このフレームで測り直したか。ラッチ中のフレームでは false。 */
  get updatedThisFrame(): boolean {
    return this.refreshed;
  }

  reset(): void {
    this.previous = null;
    this.latched = NO_FLUX;
    this.lastMeasured = -1;
    this.refreshed = false;
  }

  /**
   * スペクトル 1 枚を取り込む。`magnitudes` は engine が使い回すバッファなので、
   * 必ず自前の配列へ写してから次フレームの比較に使う。
   */
  update(
    magnitudes: Uint8Array,
    nyquist: number,
    elapsed: number,
    gain: number,
  ): BandFlux {
    this.refreshed = false;
    const bins = magnitudes.length;
    if (bins === 0 || !(nyquist > 0)) return this.latched;

    if (!this.previous || this.previous.length !== bins) {
      this.previous = new Float32Array(bins);
      for (let i = 0; i < bins; i++) this.previous[i] = magnitudes[i]! / 255;
      this.lastMeasured = elapsed;
      this.latched = NO_FLUX;
      return this.latched;
    }

    const elapsedMs = this.lastMeasured < 0 ? 0 : (elapsed - this.lastMeasured) * 1000;
    if (elapsedMs < CORE_STUDY.fluxIntervalMs) return this.latched;

    // 窓幅で割ってから基準間隔ぶんに直す。10ms でも 33ms でも同じ値になる。
    const window = clamp(
      elapsedMs,
      CORE_STUDY.fluxIntervalMs,
      CORE_STUDY.fluxMaximumIntervalMs,
    );
    const scale = (CORE_STUDY.fluxReferenceMs / window) * gain;

    const bass = this.bandFlux(magnitudes, nyquist, bins, CORE_STUDY.bands.bass);
    const mid = this.bandFlux(magnitudes, nyquist, bins, CORE_STUDY.bands.mid);
    const treble = this.bandFlux(magnitudes, nyquist, bins, CORE_STUDY.bands.treble);

    for (let i = 0; i < bins; i++) this.previous[i] = magnitudes[i]! / 255;
    this.lastMeasured = elapsed;
    this.refreshed = true;

    const raw =
      CORE_STUDY.fluxCombine === 'max'
        ? Math.max(bass, mid, treble)
        : (CORE_STUDY.fluxWeights.bass * bass +
            CORE_STUDY.fluxWeights.mid * mid +
            CORE_STUDY.fluxWeights.treble * treble) /
          (CORE_STUDY.fluxWeights.bass +
            CORE_STUDY.fluxWeights.mid +
            CORE_STUDY.fluxWeights.treble);

    this.latched = {
      bass: clamp01(bass * scale),
      mid: clamp01(mid * scale),
      treble: clamp01(treble * scale),
      combined: clamp01(raw * scale),
    };
    return this.latched;
  }

  /** 1 帯域ぶんの平均正増分（0..1）。ビン数で割るので帯域幅に依らない。 */
  private bandFlux(
    magnitudes: Uint8Array,
    nyquist: number,
    bins: number,
    range: readonly [number, number] | readonly number[],
  ): number {
    const previous = this.previous!;
    const start = Math.max(Math.floor((range[0]! / nyquist) * bins), 0);
    const end = Math.min(Math.ceil((range[1]! / nyquist) * bins), bins);
    if (end <= start) return 0;

    let total = 0;
    for (let i = start; i < end; i++) {
      const rise = magnitudes[i]! / 255 - previous[i]!;
      if (rise > 0) total += rise;
    }
    return total / (end - start);
  }
}

/** 昇順に並んだ配列から分位点を取る。順序統計なので外れ値に引きずられない。 */
const quantileOf = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const index = clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[index]!;
};

/** `OnsetGate.update` への入力。呼び出し側は「素のフラックス」と設定だけを渡す。 */
export interface OnsetGateInput {
  /** いま測れた合成フラックス（0..1）。 */
  readonly value: number;
  readonly delta: number;
  /** このフレームでフラックスを測り直したか。false なら判定を見送る。 */
  readonly measured: boolean;
  /** ウォームアップ中と、適応を切ったときに使う固定閾値。 */
  readonly fallbackThreshold: number;
  /** 0..1。k の写像に使う（高いほど k が小さく、緩くなる）。 */
  readonly sensitivity: number;
  readonly cooldownSeconds: number;
  /** 閾値の局所適応（方式 A）を使うか。 */
  readonly adaptiveThreshold: boolean;
  /** strength の局所正規化を使うか。閾値の適応とは独立に切れる。 */
  readonly adaptiveStrength: boolean;
}

/**
 * 発火判定（決める側）— 方式 A。
 *
 * 立ち上がりエッジ + 閾値 + クールダウンを見る。フラックスの作り方は知らない。
 *
 * 閾値は固定値ではなく、**直近 `windowSeconds` 秒のフラックスの分布**から毎回作る。
 *
 *   k    = kAtZero − 感度 × (kAtZero − kAtFull)
 *   閾値 = max(absoluteFloor, 窓の中央値 + k × (窓の山の中央値 − 窓の中央値))
 *
 * これで「静かな区間の小さな打撃」も「密度の高い区間の打撃」も、その区間の文脈で
 * 判定される。固定閾値が 1 曲での較正でしかない問題（fluxGain 2.5）を吸収する。
 *
 * 窓は**秒で管理**し、測り直したフレームだけを入れる。フレームレートが変わっても
 * 窓に入る「時間の長さ」は同じなので、判定はフレームレートに依存しない。
 * 山（局所最大）は値が上がって下がった折り返しで 1 つ記録する。
 *
 * strength の局所正規化は別のスイッチで、発火時のフラックスを窓の最大値
 * （下限つき）で割る。閾値の適応と切り分けて検証できるようにしてある。
 */
export class OnsetGate {
  private previousValue = 0;
  private cooldown = 0;
  /** 統計窓。時刻と値を並行配列で持つ（常に時刻の昇順）。 */
  private readonly times: number[] = [];
  private readonly values: number[] = [];
  /** 山（局所最大）だけを集めた窓。打撃の密度に左右されない代表値を取るため。 */
  private readonly peakTimes: number[] = [];
  private readonly peakValues: number[] = [];
  /** 直前のフレームで値が上がっていたか。折り返しの検出に使う。 */
  private wasRising = false;
  /** 窓の中だけで進む時計（秒）。delta を積むのでフレームレートに依存しない。 */
  private clock = 0;
  private currentThreshold = 0;
  private currentReference = 0;
  private warming = true;

  reset(): void {
    this.previousValue = 0;
    this.cooldown = 0;
    this.times.length = 0;
    this.values.length = 0;
    this.peakTimes.length = 0;
    this.peakValues.length = 0;
    this.wasRising = false;
    this.clock = 0;
    this.currentThreshold = 0;
    this.currentReference = 0;
    this.warming = true;
  }

  /** 残りクールダウン（秒）。開発用の表示に使う。 */
  get remainingCooldown(): number {
    return this.cooldown;
  }

  /** いま効いている閾値。Inspector がメーター上のマーカーに使う。 */
  get threshold(): number {
    return this.currentThreshold;
  }

  /** 統計が溜まりきっていない（＝固定閾値で動いている）か。 */
  get warmingUp(): boolean {
    return this.warming;
  }

  /** strength を割る参照値。適応を切っているときは 0。 */
  get strengthReference(): number {
    return this.currentReference;
  }

  /** 窓に入っている本数。開発用の表示に使う。 */
  get sampleCount(): number {
    return this.values.length;
  }

  /**
   * 発火したら strength（0..1）を返す。しなければ null。
   *
   * `measured` が false のフレームはフラックスがラッチ値のままなので、
   * 統計にも入れず、前回値との比較もせずに見送る。こうしないと
   * 同じ値で何度もエッジが立ち、窓が同じ値で埋まってしまう。
   */
  update(input: OnsetGateInput): number | null {
    this.cooldown = Math.max(this.cooldown - input.delta, 0);
    this.clock += input.delta;
    if (!input.measured) return null;

    const rising = input.value > this.previousValue;
    // 上がって下がった折り返し。直前の値がその区間の山だった。
    if (this.wasRising && !rising) this.pushPeak(this.previousValue);
    this.wasRising = rising;

    this.push(input.value);
    const sorted = [...this.values].sort((left, right) => left - right);
    const sortedPeaks = [...this.peakValues].sort((left, right) => left - right);
    this.warming =
      sorted.length < CORE_STUDY.adaptive.minimumSamples ||
      sortedPeaks.length < CORE_STUDY.adaptive.minimumPeaks;
    this.currentThreshold =
      input.adaptiveThreshold && !this.warming
        ? this.adaptiveThreshold(sorted, sortedPeaks, input.sensitivity)
        : input.fallbackThreshold;
    this.currentReference =
      input.adaptiveStrength && !this.warming
        ? Math.max(
            CORE_STUDY.adaptive.strengthReferenceFloor,
            sorted[sorted.length - 1] ?? 0,
          )
        : 0;

    this.previousValue = input.value;
    if (!rising) return null;
    if (input.value < this.currentThreshold) return null;
    if (this.cooldown > 0) return null;

    this.cooldown = input.cooldownSeconds;
    // 局所正規化を切っているときは素のフラックスがそのまま明るさになる（方式 B と同じ）。
    return this.currentReference > 0
      ? clamp01(input.value / this.currentReference)
      : clamp01(input.value);
  }

  /** 窓の中央値 + k × （山の中央値 − 窓の中央値）。下限は必ず効かせる。 */
  private adaptiveThreshold(
    sorted: readonly number[],
    sortedPeaks: readonly number[],
    sensitivity: number,
  ): number {
    const { kAtZeroSensitivity, kAtFullSensitivity, absoluteFloor } = CORE_STUDY.adaptive;
    const k =
      kAtZeroSensitivity - clamp01(sensitivity) * (kAtZeroSensitivity - kAtFullSensitivity);
    const baseline = quantileOf(sorted, 0.5);
    const typicalPeak = quantileOf(sortedPeaks, 0.5);
    const spread = Math.max(typicalPeak - baseline, 0);
    return Math.max(absoluteFloor, baseline + k * spread);
  }

  /** 窓へ 1 本入れ、`windowSeconds` より古いものを落とす。 */
  private push(value: number): void {
    this.times.push(this.clock);
    this.values.push(value);
    trimWindow(this.times, this.values, this.clock);
  }

  private pushPeak(value: number): void {
    this.peakTimes.push(this.clock);
    this.peakValues.push(value);
    trimWindow(this.peakTimes, this.peakValues, this.clock);
  }
}

/** 時刻の昇順に並んだ 2 本の配列から、窓より古い先頭を落とす。 */
function trimWindow(times: number[], values: number[], now: number): void {
  const oldest = now - CORE_STUDY.adaptive.windowSeconds;
  let drop = 0;
  while (drop < times.length && times[drop]! < oldest) drop += 1;
  if (drop > 0) {
    times.splice(0, drop);
    values.splice(0, drop);
  }
}

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

  /** 測る側と決める側。適応（方式 A）は決める側だけが持つ。 */
  private readonly flux = new BandFluxAnalyzer();
  /**
   * 合成フラックスの Gate。**役割が反転して観察専用になった。**
   * Core を生むのは帯域 Gate 側で、こちらは新旧を Inspector で見比べるために残す。
   */
  private readonly gate = new OnsetGate();
  /**
   * 帯域ごとの Onset を独立に判定する Gate。**ここが Core の発生源。**
   *
   * 統計窓・山の履歴・閾値・クールダウン・累計はそれぞれが独立に持ち、
   * 設定（窓・下限・感度・クールダウン）は 3 帯域とも合成 Gate と同じものを使う。
   */
  private readonly bandGates: Record<BandName, OnsetGate> = {
    bass: new OnsetGate(),
    mid: new OnsetGate(),
    treble: new OnsetGate(),
  };
  private readonly bandFireCounts: Record<BandName, number> = { bass: 0, mid: 0, treble: 0 };
  private readonly bandLastStrength: Record<BandName, number> = { bass: 0, mid: 0, treble: 0 };
  private coincidence = { ...EMPTY_COINCIDENCE };
  /**
   * 結合窓の中身。最初の帯域が立った瞬間に開き、`eventCoalesceMs` が経つと閉じて
   * Core を出す。閉じるまで Core は出ないので、1 打が複数フレームに割れても 1 回で済む。
   */
  private pendingEvent: {
    openedAt: number;
    /**
     * 帯域ごとの「素のフラックス」と「局所正規化した strength」。
     *
     * **どの帯域が主役かは素のフラックスで決める。** strength は帯域ごとに
     * 別々の参照値（その帯域の窓の最大値）で割った値なので、帯域をまたいで
     * 比べると意味を成さない（静かな帯域ほど小さな増分が 1.0 に化ける）。
     * 明るさには従来どおり strength を使う。
     * 同じ帯域が窓内で 2 度立ったら、フラックスの大きいほうを採る。
     */
    entries: Partial<Record<BandName, { flux: number; strength: number }>>;
    /** 窓を開いた瞬間の centroid。X はこの値だけで決まる。 */
    centroid: number;
  } | null = null;
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
  private fireCount = 0;

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
   * 感度 0..1 を発火閾値へ写す。感度が高いほど小さなフラックスも採る。
   *
   * 方式 A へ進むときは、この固定の写像を `OnsetGate` 側の
   * 局所統計（直近数百 ms の中央値 + 係数 × 散らばり）へ置き換える。
   */
  private onsetThreshold(): number {
    const high = CORE_STUDY.onsetThresholdAtZeroSensitivity;
    const low = CORE_STUDY.onsetThresholdAtFullSensitivity;
    return high - clamp01(this.params.onsetSensitivity) * (high - low);
  }

  /**
   * 測る → 決める → まとめる → 生む。
   *
   * スペクトルは engine の生 FFT をそのまま読むだけで、engine 側は何も変えない。
   * 発火の強さも横位置も「その瞬間に測れた値」だけで決まり、後から追従させない。
   *
   * Core を生むのは**帯域 Gate → 結合窓**の経路だけ。合成 Gate は観察用に並走する。
   */
  private detectOnset(audio: AudioParameters, elapsed: number, delta: number): void {
    const spectrum = this.context?.audioEngine.getSpectrum?.() ?? null;
    if (spectrum) {
      this.flux.update(
        spectrum.magnitudes,
        spectrum.nyquist,
        elapsed,
        this.params.fluxGain,
      );
    }
    const measured = spectrum !== null && this.flux.updatedThisFrame;
    const settings = {
      delta,
      measured,
      fallbackThreshold: this.onsetThreshold(),
      sensitivity: this.params.onsetSensitivity,
      cooldownSeconds: this.params.cooldownMs / 1000,
      adaptiveThreshold: this.adaptiveThreshold,
      adaptiveStrength: this.adaptiveStrength,
    };

    // 先に期限の切れた窓を閉じる。閉じてから新しい発火を受けるので、
    // 窓の境目にきた発火は次のイベントとして扱われる。
    this.closeEventIfDue(elapsed);

    // 観察用の合成 Gate。数えるだけで Core は生まない。
    if (this.gate.update({ value: this.flux.value.combined, ...settings }) !== null) {
      this.fireCount += 1;
    }

    // centroid は engine が対数で 0..1 に正規化済み。Hz の生値は使わない。
    this.collectBands(settings, elapsed, clamp01(audio.centroid ?? 0));
  }

  /**
   * 帯域ごとの Onset を判定し、立った帯域を結合窓へ集める。
   * ここでは Core を出さない（窓が閉じるときに出す）。
   */
  private collectBands(
    settings: Omit<OnsetGateInput, 'value'>,
    elapsed: number,
    centroid: number,
  ): void {
    const fired: BandName[] = [];
    for (const band of BAND_NAMES) {
      const strength = this.bandGates[band].update({
        value: this.flux.value[band],
        ...settings,
      });
      if (strength === null) continue;
      this.bandFireCounts[band] += 1;
      this.bandLastStrength[band] = strength;
      fired.push(band);

      if (!this.pendingEvent) {
        // 最初の帯域が立った瞬間に窓を開く。X はこの瞬間の centroid で確定する。
        this.pendingEvent = { openedAt: elapsed, entries: {}, centroid };
      }
      const flux = this.flux.value[band];
      const previous = this.pendingEvent.entries[band];
      // 同じ帯域が窓内で 2 度立ったら、フラックスの大きいほうを代表にする。
      if (previous === undefined || flux > previous.flux) {
        this.pendingEvent.entries[band] = { flux, strength };
      }
    }
    if (fired.length === 0) return;

    const single =
      fired.length === 1
        ? ({ bass: 'bassOnly', mid: 'midOnly', treble: 'trebleOnly' } as const)[fired[0]!]
        : null;
    this.coincidence = {
      ...this.coincidence,
      bassOnly: this.coincidence.bassOnly + (single === 'bassOnly' ? 1 : 0),
      midOnly: this.coincidence.midOnly + (single === 'midOnly' ? 1 : 0),
      trebleOnly: this.coincidence.trebleOnly + (single === 'trebleOnly' ? 1 : 0),
      twoBands: this.coincidence.twoBands + (fired.length === 2 ? 1 : 0),
      threeBands: this.coincidence.threeBands + (fired.length === 3 ? 1 : 0),
      lastEvent: fired.map((band) => BAND_LABELS[band]).join(' + '),
      events: this.coincidence.events + 1,
    };
  }

  /**
   * 結合窓が満了していたら閉じて、選ばれた帯域ぶんの Core を生む。
   *
   * 帯域の選び方: **素のフラックス**が最大の 1 本は必ず出し、それ以外は
   * 「フラックスが最大 × `relativeStrengthFloor` を**超えている**」ものだけ足す。
   * 既定の 1.0 では比が 1 を超えることはないので、必ず 1 打 = 1 個になる
   * （同値の帯域も切り捨てる）。同点の並びは `BAND_NAMES` の順で決まるので決定論。
   *
   * 明るさに使うのは局所正規化した strength のまま。役割は
   * 「フラックスの大小 = どの帯域の出来事か」「strength = その光の明るさ」で分けてある。
   */
  private closeEventIfDue(elapsed: number): void {
    const event = this.pendingEvent;
    if (!event) return;
    if ((elapsed - event.openedAt) * 1000 < CORE_STUDY.eventCoalesceMs) return;
    this.pendingEvent = null;

    const entries = BAND_NAMES.filter((band) => event.entries[band] !== undefined).map(
      (band) => ({ band, ...event.entries[band]! }),
    );
    if (entries.length === 0) return;

    let top = entries[0]!;
    for (const entry of entries) if (entry.flux > top.flux) top = entry;
    const floor = clamp(this.params.relativeStrengthFloor, 0, 1);
    const chosen = entries.filter(
      (entry) => entry === top || entry.flux > top.flux * floor,
    );

    this.lastEventCores = chosen.length;
    for (const entry of chosen) this.spawn(entry.strength, event.centroid, entry.band);
  }

  /**
   * 合成 Gate・帯域 Gate・集計をまとめて捨てる。
   *
   * 呼ばれるのは音が止まったとき（`active !== 1`）と dispose。音源の差し替えは
   * `FileAudioEngine` の `load` / `loadUrl` / `startInput` / `stopInput` がいずれも
   * 先に `pause()`・`stopInput()` を通るため、必ず `active = 0` のフレームを挟む。
   * つまり 0↔1 の遷移だけ見ていれば、古い曲の統計が次の曲へ残ることはない。
   */
  private resetDetection(): void {
    this.flux.reset();
    this.gate.reset();
    // 発火回数も 0 に戻す。集計とセットで「この曲での回数」を表すため、
    // 片方だけ持ち越すと帯域ごとの回数と 5 分類の合計が合わなくなる。
    this.fireCount = 0;
    for (const band of BAND_NAMES) {
      this.bandGates[band].reset();
      this.bandFireCounts[band] = 0;
      this.bandLastStrength[band] = 0;
    }
    this.coincidence = { ...EMPTY_COINCIDENCE };
    // 開きかけの窓も捨てる。無音をまたいで Core が漏れ出さないようにする。
    this.pendingEvent = null;
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
    const f = this.flux.value;
    return (
      `cores ${this.cores.length} / last ${this.lastBand ?? '-'} ${this.lastOnsetStrength.toFixed(2)} / ` +
      `flux b${f.bass.toFixed(2)} m${f.mid.toFixed(2)} t${f.treble.toFixed(2)} / ` +
      `th ${this.bandGates.bass.threshold.toFixed(2)}/${this.bandGates.mid.threshold.toFixed(2)}/${this.bandGates.treble.threshold.toFixed(2)}`
    );
  }

  private bandState(band: BandName): BandGateState {
    const gate = this.bandGates[band];
    return {
      threshold: gate.threshold,
      warmingUp: gate.warmingUp,
      lastStrength: this.bandLastStrength[band],
      fireCount: this.bandFireCounts[band],
    };
  }

  /** 開発・検証用。Inspector と `window.__lab` から Core の内部状態を読む。 */
  getCoreStudyState(): CoreStudyState {
    return {
      count: this.cores.length,
      lastOnsetStrength: this.lastOnsetStrength,
      lastSpectralCentroid: this.lastSpectralCentroid,
      lastX: this.lastX,
      lastPeakIntensity: this.lastPeakIntensity,
      flux: this.flux.value,
      onsetThreshold: this.gate.threshold,
      thresholdWarmingUp: this.gate.warmingUp,
      thresholdSamples: this.gate.sampleCount,
      strengthReference: this.gate.strengthReference,
      adaptiveThreshold: this.adaptiveThreshold,
      adaptiveStrength: this.adaptiveStrength,
      fireCount: this.fireCount,
      bands: {
        bass: this.bandState('bass'),
        mid: this.bandState('mid'),
        treble: this.bandState('treble'),
      },
      coincidence: { ...this.coincidence },
      lastBand: this.lastBand,
      lastEventCores: this.lastEventCores,
      eventPending: this.pendingEvent !== null,
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
