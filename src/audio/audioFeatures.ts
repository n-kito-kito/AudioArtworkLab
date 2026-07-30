/**
 * **観察用の音響特徴（設計フェーズ①の道具）。**
 *
 * ここにあるのは **見るためだけ**の特徴である。表現・描画・`TUNING` からは
 * 一切参照しない。実曲を流して「値と聴感がどう対応するか」を目で確かめ、
 * どの特徴を何に繋ぐかを**次のフェーズで決める**ための材料にする。
 *
 * ---
 * ## 方針
 *
 * - **既存の 10 特徴（`AudioParameters`）は 1 ビットも変えない。**
 *   そのため `AudioParameters` を拡張せず、`getSpectrum()` と同じ流儀で
 *   **別口の読み出し**（`AudioEngine.getFeatures()`）として足す。
 *   既存の写像はどれもこの型を知らないので、値が混ざる余地がない。
 * - **計算は既存の解析と同じ 1 フレーム 1 回**（`FileAudioEngine` の解析ブロック）。
 *   表示は 2 か所（Inspector と `?audio=1`）あるが、**解析は 1 つを共有する**。
 * - 既にある FFT（`frequencyData`）と波形（`timeData`）から**派生するだけ**の安い量に限る。
 *   BPM・chroma・MFCC のような中コスト / 遅延のあるものは持たない。
 * - `Math.random()` は使わない。
 *
 * ## 値の形式
 *
 * 既存の 10 特徴に合わせて**すべて 0〜1** に収める。
 * 符号のある量（傾き・包絡の差）は **0.5 を中立**とする 0〜1 に写し、
 * 生の値が要るものだけ別フィールドで併記する。
 */

/** 対数分割した 7 帯域。低いほうから順に並ぶ。 */
export const FEATURE_BANDS = [
  { key: 'sub', label: 'Sub', range: [20, 60] },
  { key: 'bass', label: 'Bass', range: [60, 250] },
  { key: 'lowMid', label: 'Low-mid', range: [250, 500] },
  { key: 'mid', label: 'Mid', range: [500, 2000] },
  { key: 'highMid', label: 'High-mid', range: [2000, 4000] },
  { key: 'presence', label: 'Presence', range: [4000, 6000] },
  { key: 'air', label: 'Air', range: [6000, 16000] },
] as const satisfies readonly {
  readonly key: string;
  readonly label: string;
  readonly range: readonly [number, number];
}[];

export type FeatureBandKey = (typeof FEATURE_BANDS)[number]['key'];

/** 観察用の特徴 1 フレームぶん。**表現からは読まない。** */
export interface AudioFeatures {
  /**
   * **ロールオフ。** エネルギーの 85% が収まる上限周波数。
   * 100Hz〜16kHz を対数で 0〜1 に写した値（生の Hz は `rolloffHz`）。
   * 明るさと違って「どこまで上が詰まっているか」を見る。
   */
  readonly rolloff: number;
  readonly rolloffHz: number;
  /**
   * **スペクトルの広がり。** 重心まわりの標準偏差（Hz）を 0〜6kHz で 0〜1 に写す。
   * 小さいと単音的、大きいと帯域全体に散っている（ノイズ・厚い和音）。
   */
  readonly spread: number;
  readonly spreadHz: number;
  /**
   * **傾き。** 低域寄り（0）⇄ 高域寄り（1）。**0.5 が中立。**
   * 500Hz 以下と 2kHz 以上のエネルギー比から作る。
   */
  readonly tilt: number;
  /**
   * **クレストファクタ。** 波形のピーク ÷ RMS。パンチ感。
   * 1（完全に潰れている）〜 6 以上（尖った打撃）を 0〜1 に写す。生の比は `crestRaw`。
   */
  readonly crest: number;
  readonly crestRaw: number;
  /**
   * **オンセット密度。** 直近 1 秒に立ち上がったイベントの数。
   * 0〜12 を 0〜1 に写した値（生の個数は `onsetCount`）。
   */
  readonly onsetRate: number;
  readonly onsetCount: number;
  /** **速い包絡**（時定数 50ms）。打撃の形が見える。 */
  readonly envelopeFast: number;
  /** **遅い包絡**（時定数 2s）。区間の平均的な勢い。 */
  readonly envelopeSlow: number;
  /**
   * **包絡の差**（速い − 遅い）。**0.5 が中立**で、
   * 0.5 より上が「盛り上がり」、下が「引き」。生の差は `envelopeDeltaRaw`。
   */
  readonly envelopeDelta: number;
  readonly envelopeDeltaRaw: number;
  /** **7 帯域の対数分割エネルギー**（`FEATURE_BANDS` と同じ並び）。各 0〜1。 */
  readonly bands: readonly number[];
}

const EMPTY_BANDS = FEATURE_BANDS.map(() => 0);

/** 何も鳴っていないときの値。中立の量は 0.5 に置く。 */
export const SILENT_FEATURES: AudioFeatures = {
  rolloff: 0,
  rolloffHz: 0,
  spread: 0,
  spreadHz: 0,
  tilt: 0.5,
  crest: 0,
  crestRaw: 0,
  onsetRate: 0,
  onsetCount: 0,
  envelopeFast: 0,
  envelopeSlow: 0,
  envelopeDelta: 0.5,
  envelopeDeltaRaw: 0,
  bands: EMPTY_BANDS,
};

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/** 周波数を対数で 0..1 へ写す（既存の `normalizeLog` と同じ考え方）。 */
const logScale = (frequency: number, min: number, max: number): number => {
  if (!(frequency > 0)) return 0;
  return clamp01(Math.log2(frequency / min) / Math.log2(max / min));
};

/** ロールオフを写す範囲。 */
const ROLLOFF_RANGE = [100, 16000] as const;
/** 広がりを写す上限（Hz）。 */
const SPREAD_CEILING = 6000;
/** クレストを写す範囲（ピーク ÷ RMS）。 */
const CREST_RANGE = [1, 6] as const;
/** オンセット密度を写す上限（毎秒）。 */
const ONSET_RATE_CEILING = 12;
/** 傾きを測る 2 つの帯（この間は数えない）。 */
const TILT_LOW_HZ = 500;
const TILT_HIGH_HZ = 2000;
/** 包絡の時定数（秒）。 */
const ENVELOPE_FAST_SECONDS = 0.05;
const ENVELOPE_SLOW_SECONDS = 2;
/** オンセットの時刻を覚えておく本数。1 秒ぶん数えられれば足りる。 */
const ONSET_HISTORY = 32;

/**
 * **観察用の特徴をまとめて出す。**
 *
 * 1 フレームに 1 回だけ `update` を呼ぶ。中で走るのは
 * FFT ビン 1 周（重心・広がり・ロールオフ・傾き・7 帯域を**同じループで**）と
 * 波形 1 周（ピーク）だけなので、既存の解析に対して誤差の範囲でしか増えない。
 */
export class AudioFeatureAnalyzer {
  private envelopeFast = 0;
  private envelopeSlow = 0;
  /** 直近のオンセット時刻（秒）。リングバッファ。 */
  private readonly onsetTimes = new Float64Array(ONSET_HISTORY);
  private onsetWrite = 0;
  private onsetSeen = 0;
  private latest: AudioFeatures = SILENT_FEATURES;
  private readonly bandTotals = new Float64Array(FEATURE_BANDS.length);
  private readonly bandCounts = new Float64Array(FEATURE_BANDS.length);

  /** 直近の結果。表示側はここを読むので、**二重に計算しない。** */
  get value(): AudioFeatures {
    return this.latest;
  }

  reset(): void {
    this.envelopeFast = 0;
    this.envelopeSlow = 0;
    this.onsetTimes.fill(0);
    this.onsetWrite = 0;
    this.onsetSeen = 0;
    this.latest = SILENT_FEATURES;
  }

  /**
   * 1 フレーム進める。
   *
   * @param magnitudes FFT の振幅（0..255）。**読むだけで書き換えない。**
   * @param timeData 時間波形（0..255・128 が無音）。同じく読むだけ。
   * @param nyquist ナイキスト周波数（Hz）。
   * @param volume 既存の音量（0..1）。包絡はこれを追う。
   * @param onsetEdge このフレームがオンセットの立ち上がりか（既存の判定をそのまま渡す）。
   * @param elapsedSeconds 連続する時計（秒）。オンセット密度の窓に使う。
   * @param deltaSeconds 前フレームからの経過（秒）。包絡の時定数に使う。
   */
  update(
    magnitudes: Uint8Array,
    timeData: Uint8Array,
    nyquist: number,
    volume: number,
    onsetEdge: boolean,
    elapsedSeconds: number,
    deltaSeconds: number,
  ): AudioFeatures {
    const bins = magnitudes.length;
    if (bins === 0 || !(nyquist > 0)) {
      this.latest = SILENT_FEATURES;
      return this.latest;
    }

    const binHz = nyquist / bins;
    this.bandTotals.fill(0);
    this.bandCounts.fill(0);

    // ---- FFT を 1 周。重心・総和・帯域・傾きをここで全部作る ----
    let total = 0;
    let weighted = 0;
    let lowEnergy = 0;
    let highEnergy = 0;
    for (let index = 0; index < bins; index++) {
      const value = (magnitudes[index] ?? 0) / 255;
      if (value <= 0) continue;
      const frequency = (index + 0.5) * binHz;
      total += value;
      weighted += value * frequency;
      if (frequency <= TILT_LOW_HZ) lowEnergy += value;
      else if (frequency >= TILT_HIGH_HZ) highEnergy += value;
      for (let band = 0; band < FEATURE_BANDS.length; band++) {
        const range = FEATURE_BANDS[band]!.range;
        if (frequency >= range[0] && frequency < range[1]) {
          this.bandTotals[band]! += value;
          this.bandCounts[band]! += 1;
          break;
        }
      }
    }

    if (total <= 0) {
      // 無音でも包絡だけは沈めていく（そこが「引き」に見える）。
      this.envelopeFast = this.follow(this.envelopeFast, 0, deltaSeconds, ENVELOPE_FAST_SECONDS);
      this.envelopeSlow = this.follow(this.envelopeSlow, 0, deltaSeconds, ENVELOPE_SLOW_SECONDS);
      this.latest = {
        ...SILENT_FEATURES,
        envelopeFast: this.envelopeFast,
        envelopeSlow: this.envelopeSlow,
        envelopeDeltaRaw: this.envelopeFast - this.envelopeSlow,
        envelopeDelta: clamp01(0.5 + (this.envelopeFast - this.envelopeSlow) * 0.5),
        onsetCount: this.countOnsets(elapsedSeconds),
        onsetRate: clamp01(this.countOnsets(elapsedSeconds) / ONSET_RATE_CEILING),
      };
      return this.latest;
    }

    const centroidHz = weighted / total;

    // ---- 広がりとロールオフ（重心が要るので 2 周目。分岐は最小限）----
    let variance = 0;
    let cumulative = 0;
    let rolloffHz = 0;
    const rolloffTarget = total * 0.85;
    for (let index = 0; index < bins; index++) {
      const value = (magnitudes[index] ?? 0) / 255;
      if (value <= 0) continue;
      const frequency = (index + 0.5) * binHz;
      const gap = frequency - centroidHz;
      variance += value * gap * gap;
      if (rolloffHz === 0) {
        cumulative += value;
        if (cumulative >= rolloffTarget) rolloffHz = frequency;
      }
    }
    const spreadHz = Math.sqrt(variance / total);

    // ---- 波形 1 周: ピーク（クレストファクタ）----
    let peak = 0;
    let squares = 0;
    for (let index = 0; index < timeData.length; index++) {
      const sample = ((timeData[index] ?? 128) - 128) / 128;
      const magnitude = sample < 0 ? -sample : sample;
      if (magnitude > peak) peak = magnitude;
      squares += sample * sample;
    }
    const rms = Math.sqrt(squares / Math.max(timeData.length, 1));
    const crestRaw = rms > 1e-5 ? peak / rms : 0;

    // ---- 包絡（速い・遅い）とその差 ----
    const level = clamp01(volume);
    this.envelopeFast = this.follow(this.envelopeFast, level, deltaSeconds, ENVELOPE_FAST_SECONDS);
    this.envelopeSlow = this.follow(this.envelopeSlow, level, deltaSeconds, ENVELOPE_SLOW_SECONDS);
    const envelopeDeltaRaw = this.envelopeFast - this.envelopeSlow;

    // ---- オンセット密度 ----
    if (onsetEdge) {
      this.onsetTimes[this.onsetWrite] = elapsedSeconds;
      this.onsetWrite = (this.onsetWrite + 1) % ONSET_HISTORY;
      if (this.onsetSeen < ONSET_HISTORY) this.onsetSeen += 1;
    }
    const onsetCount = this.countOnsets(elapsedSeconds);

    const bands: number[] = [];
    for (let band = 0; band < FEATURE_BANDS.length; band++) {
      const count = this.bandCounts[band]!;
      bands.push(count > 0 ? clamp01(this.bandTotals[band]! / count) : 0);
    }

    const tiltSum = lowEnergy + highEnergy;
    const tilt = tiltSum > 0 ? clamp01(0.5 + ((highEnergy - lowEnergy) / tiltSum) * 0.5) : 0.5;

    this.latest = {
      rolloff: logScale(rolloffHz, ROLLOFF_RANGE[0], ROLLOFF_RANGE[1]),
      rolloffHz,
      spread: clamp01(spreadHz / SPREAD_CEILING),
      spreadHz,
      tilt,
      crest: clamp01((crestRaw - CREST_RANGE[0]) / (CREST_RANGE[1] - CREST_RANGE[0])),
      crestRaw,
      onsetRate: clamp01(onsetCount / ONSET_RATE_CEILING),
      onsetCount,
      envelopeFast: this.envelopeFast,
      envelopeSlow: this.envelopeSlow,
      envelopeDelta: clamp01(0.5 + envelopeDeltaRaw * 0.5),
      envelopeDeltaRaw,
      bands,
    };
    return this.latest;
  }

  /** 直近 1 秒に立ち上がった数。 */
  private countOnsets(elapsedSeconds: number): number {
    let count = 0;
    for (let index = 0; index < this.onsetSeen; index++) {
      if (elapsedSeconds - this.onsetTimes[index]! <= 1) count += 1;
    }
    return count;
  }

  /** dt ベースの指数追従。フレームレートが変わっても同じ時間で同じところへ着く。 */
  private follow(current: number, target: number, deltaSeconds: number, tau: number): number {
    if (tau <= 0) return target;
    const alpha = 1 - Math.exp(-Math.max(deltaSeconds, 0) / tau);
    return current + (target - current) * alpha;
  }
}
