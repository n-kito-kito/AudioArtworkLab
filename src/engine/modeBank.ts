import type { AudioParameters } from '../audio/AudioEngine';
import { TUNING } from './tuning';

/**
 * 金属板の固有振動モードバンクと、スペクトルによる励起計算。
 *
 * 単一の支配周波数でモードを選ばない。FFT の各ビンが、各モードの共振周波数
 * まわりの帯域応答（対数周波数のガウス）へどれだけ入るかを積分し、
 * モードごとの励起量を求める。音楽は複数の周波数を同時に含むため、
 * 最も強いモードに加えて 2 番目のモードを副モードとして限定的に混合する。
 *
 * 低域偏重の楽曲でも高次モードが選ばれるよう、
 *   - 対数周波数スケールの応答
 *   - 高域プリエンファシス
 *   - モードごとの移動平均に対する相対エネルギー（数秒スケール）
 * を用いる。「最大 FFT ビンを選ぶ」実装はしない。
 */

export interface PlateMode {
  readonly id: number;
  /** 共振周波数 (Hz)。 */
  readonly frequency: number;
  /** 帯域幅（オクターブ）。 */
  readonly bandwidth: number;
  /** 形状の種類: 0=格子 1=X 2=菱形 3=円環(楕円) 4=花弁 5=中央と外周で異なる混成 */
  readonly variant: number;
  readonly n: number;
  readonly m: number;
  /** variant 依存の追加値（円環の楕円率など）。 */
  readonly extra: number;
  /** わずかな非対称性（励振点の偏りの近似）。 */
  readonly asym: number;
  readonly label: string;
}

/** 低次→高次へ対数間隔で並ぶ 16 モード。トポロジーが十分に異なるよう族を交互に置く。 */
export const PLATE_MODES: readonly PlateMode[] = [
  { id: 0, frequency: 55, bandwidth: 0.8, variant: 3, n: 1, m: 0, extra: 1.0, asym: 0.0, label: 'ring1' },
  { id: 1, frequency: 76, bandwidth: 0.75, variant: 1, n: 2, m: 1, extra: 0, asym: 0.06, label: 'X-2.1' },
  { id: 2, frequency: 105, bandwidth: 0.75, variant: 0, n: 2, m: 2, extra: 0, asym: 0.05, label: 'grid2' },
  { id: 3, frequency: 144, bandwidth: 0.7, variant: 2, n: 3, m: 1, extra: 0, asym: 0.05, label: 'diamond3.1' },
  { id: 4, frequency: 199, bandwidth: 0.7, variant: 3, n: 2, m: 0, extra: 1.0, asym: 0.04, label: 'ring2' },
  { id: 5, frequency: 274, bandwidth: 0.7, variant: 1, n: 3, m: 2, extra: 0, asym: 0.06, label: 'X-3.2' },
  { id: 6, frequency: 378, bandwidth: 0.65, variant: 0, n: 3, m: 3, extra: 0, asym: 0.05, label: 'grid3' },
  { id: 7, frequency: 521, bandwidth: 0.65, variant: 4, n: 4, m: 2, extra: 0, asym: 0.04, label: 'petal4' },
  { id: 8, frequency: 719, bandwidth: 0.6, variant: 2, n: 4, m: 2, extra: 0, asym: 0.06, label: 'diamond4.2' },
  { id: 9, frequency: 991, bandwidth: 0.6, variant: 3, n: 2, m: 0, extra: 1.45, asym: 0.04, label: 'ellipse2' },
  { id: 10, frequency: 1367, bandwidth: 0.6, variant: 1, n: 5, m: 2, extra: 0, asym: 0.05, label: 'X-5.2' },
  { id: 11, frequency: 1885, bandwidth: 0.6, variant: 0, n: 5, m: 4, extra: 0, asym: 0.05, label: 'grid5.4' },
  { id: 12, frequency: 2600, bandwidth: 0.55, variant: 4, n: 6, m: 3, extra: 0, asym: 0.04, label: 'petal6' },
  { id: 13, frequency: 3585, bandwidth: 0.55, variant: 5, n: 3, m: 6, extra: 0, asym: 0.05, label: 'hybrid3.6' },
  { id: 14, frequency: 4944, bandwidth: 0.55, variant: 2, n: 6, m: 4, extra: 0, asym: 0.05, label: 'diamond6.4' },
  { id: 15, frequency: 6818, bandwidth: 0.5, variant: 5, n: 4, m: 8, extra: 0, asym: 0.05, label: 'hybrid4.8' },
] as const;

export interface SpectrumFrame {
  magnitudes: Uint8Array;
  nyquist: number;
}

export interface SpectrumPeak {
  hz: number;
  level: number;
}

export interface ModeExciterState {
  /** 画面が向かっている主モード。 */
  primary: PlateMode;
  /** 移行元のモード。blend=1 で primary に到達済み。 */
  previous: PlateMode;
  /** 移行の進み（0..1）。粒子はこの補間された振動場に反応して再配置される。 */
  blend: number;
  secondary: PlateMode;
  secondaryWeight: number;
  candidate: PlateMode | null;
  /** 共振の強さ 0..1。共振域の間では弱くなり、模様も不安定になる。 */
  excitation: number;
  energies: Float32Array;
  holdRemaining: number;
  peaks: SpectrumPeak[];
}

export class ModeExciter {
  private weights: Float32Array[] | null = null;
  private weightBins = 0;
  private readonly raw = new Float32Array(PLATE_MODES.length);
  private readonly ema = new Float32Array(PLATE_MODES.length).fill(0.03);
  private readonly env = new Float32Array(PLATE_MODES.length);
  private primaryIdx = 2;
  private previousIdx = 2;
  private blend = 1;
  private secondaryIdx = 1;
  private secondaryW = 0;
  private candidateIdx = -1;
  private candidateSince = 0;
  private holdUntil = 0;
  private excitationValue = 0;
  private peaks: SpectrumPeak[] = [];
  private lastPeaksAt = 0;

  /** ビンごとの帯域応答（対数ガウス × 高域プリエンファシス）を作る。 */
  private buildWeights(bins: number, nyquist: number): void {
    this.weights = PLATE_MODES.map((mode) => {
      const w = new Float32Array(bins);
      let sum = 0;
      for (let b = 1; b < bins; b++) {
        const f = (b / bins) * nyquist;
        const x = Math.log2(f / mode.frequency) / mode.bandwidth;
        const gauss = Math.exp(-x * x * 4);
        const emphasis = Math.min(Math.max(Math.pow(f / 700, 0.3), 0.5), 2.2);
        const value = gauss * emphasis;
        w[b] = value;
        sum += value;
      }
      if (sum > 0) for (let b = 0; b < bins; b++) w[b]! /= sum;
      return w;
    });
    this.weightBins = bins;
  }

  update(
    spectrum: SpectrumFrame | null,
    audio: AudioParameters,
    elapsed: number,
    delta: number,
  ): void {
    if (!spectrum || spectrum.magnitudes.length === 0) return;
    const { magnitudes, nyquist } = spectrum;
    if (!this.weights || this.weightBins !== magnitudes.length) {
      this.buildWeights(magnitudes.length, nyquist);
    }

    // 無音・ほぼ無音では励起を落とし、モードは保持する。
    // 純音はビン数が少ないため、平均だけでなく最大値も見る。
    let mean = 0;
    let peak = 0;
    for (let b = 1; b < magnitudes.length; b++) {
      const value = magnitudes[b]!;
      mean += value;
      if (value > peak) peak = value;
    }
    mean /= magnitudes.length * 255;
    peak /= 255;
    const silent = audio.active !== 1 || (mean < 0.0015 && peak < 0.05);

    // 各モードの生エネルギーと、新規性（数秒平均との比・有界）。
    let sumRaw = 0;
    for (let i = 0; i < PLATE_MODES.length; i++) {
      const w = this.weights![i]!;
      let energy = 0;
      for (let b = 1; b < magnitudes.length; b++) energy += (magnitudes[b]! / 255) * w[b]!;
      this.raw[i] = silent ? 0 : energy;
      sumRaw += this.raw[i]!;
      this.ema[i] = this.ema[i]! + (this.raw[i]! - this.ema[i]!) * Math.min(delta / 8, 1);
    }

    // 分布ベースの正規化: 全帯域の平均に対するシェア。
    // 音量・入力ゲインに依存せず、持続音でも共振が立ち続ける。
    // 新規性は有界の重み付けに留め、持続で共振が消えないようにする。
    const globalMean = sumRaw / PLATE_MODES.length + 1e-4;
    for (let i = 0; i < PLATE_MODES.length; i++) {
      const share = this.raw[i]! / globalMean;
      const novelty = Math.min(Math.max(this.raw[i]! / (this.ema[i]! + 0.015), 0.7), 1.6);
      const relative = share * (novelty / 1.15);

      // アタック速く・リリース遅い包絡。毎フレームの揺れで模様が震えないように。
      const tau = relative > this.env[i]! ? 0.18 : 0.9;
      this.env[i] = this.env[i]! + (relative - this.env[i]!) * Math.min(delta / tau, 1);
    }

    // 主モードの選択: ヒステリシス + 継続時間 + 最短保持。
    let bestIdx = 0;
    let secondIdx = 1;
    for (let i = 1; i < PLATE_MODES.length; i++) {
      if (this.env[i]! > this.env[bestIdx]!) {
        secondIdx = bestIdx;
        bestIdx = i;
      } else if (this.env[i]! > this.env[secondIdx]! || secondIdx === bestIdx) {
        secondIdx = i;
      }
    }

    const currentE = this.env[this.primaryIdx]!;
    const excitationTarget = silent
      ? 0
      : Math.min(Math.max((currentE - 0.9) / 2.2, 0), 1);
    this.excitationValue +=
      (excitationTarget - this.excitationValue) * Math.min(delta / 0.35, 1);

    // オンセットが強いときは保持時間を短縮し、明確な音楽的変化には速く応じる。
    const effectiveHoldUntil =
      (audio.onset ?? 0) > 0.6 ? this.holdUntil - TUNING.modeHoldMin * 0.6 : this.holdUntil;

    if (
      !silent &&
      bestIdx !== this.primaryIdx &&
      this.env[bestIdx]! > currentE * TUNING.modeHysteresis
    ) {
      if (this.candidateIdx !== bestIdx) {
        this.candidateIdx = bestIdx;
        this.candidateSince = elapsed;
      } else if (
        elapsed - this.candidateSince >= TUNING.modeConfirm &&
        elapsed >= effectiveHoldUntil
      ) {
        this.previousIdx = this.primaryIdx;
        this.primaryIdx = bestIdx;
        this.blend = 0;
        this.holdUntil = elapsed + TUNING.modeHoldMin;
        this.candidateIdx = -1;
      }
    } else {
      this.candidateIdx = -1;
    }

    // 移行は励振が強いほど速い（0.5〜4 秒）。画面はクロスフェードではなく、
    // この補間された振動場に粒子が反応して再配置される。
    if (this.blend < 1) {
      const duration =
        TUNING.transitionMax +
        (TUNING.transitionMin - TUNING.transitionMax) * this.excitationValue;
      this.blend = Math.min(this.blend + delta / Math.max(duration, 0.1), 1);
    }

    // 副モード: 2 位のエネルギー比に応じて限定的に混合。常時は混ぜない。
    const ratio = this.env[secondIdx]! / Math.max(currentE, 0.05);
    const secTarget =
      silent || secondIdx === this.primaryIdx
        ? 0
        : Math.min(Math.max((ratio - 0.5) * 1.6, 0), 1) * TUNING.secondaryMax;
    this.secondaryW += (secTarget - this.secondaryW) * Math.min(delta / 0.5, 1);
    if (secondIdx !== this.primaryIdx) this.secondaryIdx = secondIdx;

    // デバッグ用のスペクトルピーク検出（約 150ms ごと）。
    if (elapsed - this.lastPeaksAt > 0.15) {
      this.lastPeaksAt = elapsed;
      const found: SpectrumPeak[] = [];
      const step = Math.max(1, Math.floor(magnitudes.length / 512));
      for (let b = 2 * step; b < magnitudes.length - 2 * step; b += step) {
        const v = magnitudes[b]!;
        if (v > 40 && v >= magnitudes[b - step]! && v >= magnitudes[b + step]!) {
          found.push({ hz: Math.round((b / magnitudes.length) * nyquist), level: v / 255 });
        }
      }
      found.sort((a, b) => b.level - a.level);
      this.peaks = found.slice(0, 5);
    }
  }

  getState(): ModeExciterState {
    return {
      primary: PLATE_MODES[this.primaryIdx]!,
      previous: PLATE_MODES[this.previousIdx]!,
      blend: this.blend,
      secondary: PLATE_MODES[this.secondaryIdx]!,
      secondaryWeight: this.secondaryW,
      candidate: this.candidateIdx >= 0 ? PLATE_MODES[this.candidateIdx]! : null,
      excitation: this.excitationValue,
      energies: this.env,
      holdRemaining: Math.max(this.holdUntil, 0),
      peaks: this.peaks,
    };
  }
}
