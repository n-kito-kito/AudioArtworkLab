/**
 * 帯域別の光イベント検出。**描画には一切依存しない。**
 *
 * Light Traces — Core Study（2D）で組み上げた検出の流れをそのまま切り出したもので、
 * 2D と 3D（Spatial Study）が同じイベント列を受け取れるようにするために分けてある。
 * ここを通ったあとの「いつ・どの帯域が・どれだけの強さで光るか」は表現に依らない。
 *
 * 流れ:
 *   ① `BandFluxAnalyzer` … 帯域ごとに「どれだけ増えたか」だけを測る
 *   ② `OnsetGate` × 3    … 帯域ごとに独立した局所適応閾値で「撃つか」を決める
 *   ③ 結合窓             … 30ms 以内の発火を 1 打にまとめる
 *   ④ 帯域選択           … 素のフラックスが最大の帯域（+ 相対マージン）だけ残す
 *
 * 合成フラックスの Gate も観察用として並走する（Core は生まない）。
 *
 * 挙動は 2D 版から 1 ビットも変えていない。定数・順序・丸めをそのまま持ってきている。
 */

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

/** 数値の丸め。表現側にも同じものがあるが、この層を描画から独立させるため複製する。 */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const clamp01 = (value: number): number => clamp(value, 0, 1);

/**
 * 検出の定数。**見え方の定数（半径・余白・A/H/D など）はここに置かない。**
 * どれも 2D Core Study で実測して決めた値で、値も意味も変えていない。
 */
const BAND_DETECTION = {
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
   * 帯域の発火をひとつの打撃としてまとめる窓（ミリ秒）。
   *
   * 同じ 1 打でも、帯域ごとにフラックスの山が来るフレームは 1〜2 枚ずれる
   * （実測: reference.wav の 3.01 秒 Bass / 3.02 秒 Mid）。窓を開いて拾い集めないと
   * 1 打が 2 イベントに割れ、Core が二重に出る。30ms ≒ 2 フレームの遅れは
   * 音と光のずれとして知覚できない範囲。時間基準なのでフレームレートに依存しない。
   */
  eventCoalesceMs: 30,
} as const;

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
    if (elapsedMs < BAND_DETECTION.fluxIntervalMs) return this.latched;

    // 窓幅で割ってから基準間隔ぶんに直す。10ms でも 33ms でも同じ値になる。
    const window = clamp(
      elapsedMs,
      BAND_DETECTION.fluxIntervalMs,
      BAND_DETECTION.fluxMaximumIntervalMs,
    );
    const scale = (BAND_DETECTION.fluxReferenceMs / window) * gain;

    const bass = this.bandFlux(magnitudes, nyquist, bins, BAND_DETECTION.bands.bass);
    const mid = this.bandFlux(magnitudes, nyquist, bins, BAND_DETECTION.bands.mid);
    const treble = this.bandFlux(magnitudes, nyquist, bins, BAND_DETECTION.bands.treble);

    for (let i = 0; i < bins; i++) this.previous[i] = magnitudes[i]! / 255;
    this.lastMeasured = elapsed;
    this.refreshed = true;

    const raw =
      BAND_DETECTION.fluxCombine === 'max'
        ? Math.max(bass, mid, treble)
        : (BAND_DETECTION.fluxWeights.bass * bass +
            BAND_DETECTION.fluxWeights.mid * mid +
            BAND_DETECTION.fluxWeights.treble * treble) /
          (BAND_DETECTION.fluxWeights.bass +
            BAND_DETECTION.fluxWeights.mid +
            BAND_DETECTION.fluxWeights.treble);

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
  /** 閾値の倍率。1.0 で従来どおり、小さいほど発火しやすい。 */
  readonly thresholdScale: number;
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
  private currentTypicalPeak = 0;
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
    this.currentTypicalPeak = 0;
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
   * その区間の「代表的な山の高さ」（窓に入った局所最大の中央値）。
   * いまの打撃がいつもより大きいか（新奇性）を測る物差しに使う。
   */
  get typicalPeak(): number {
    return this.currentTypicalPeak;
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
      sorted.length < BAND_DETECTION.adaptive.minimumSamples ||
      sortedPeaks.length < BAND_DETECTION.adaptive.minimumPeaks;
    const base =
      input.adaptiveThreshold && !this.warming
        ? this.adaptiveThreshold(sorted, sortedPeaks, input.sensitivity)
        : input.fallbackThreshold;
    this.currentThreshold = base * Math.max(input.thresholdScale, 0.01);
    this.currentReference =
      input.adaptiveStrength && !this.warming
        ? Math.max(
            BAND_DETECTION.adaptive.strengthReferenceFloor,
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
    const { kAtZeroSensitivity, kAtFullSensitivity, absoluteFloor } = BAND_DETECTION.adaptive;
    const k =
      kAtZeroSensitivity - clamp01(sensitivity) * (kAtZeroSensitivity - kAtFullSensitivity);
    const baseline = quantileOf(sorted, 0.5);
    const typicalPeak = quantileOf(sortedPeaks, 0.5);
    this.currentTypicalPeak = typicalPeak;
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
  const oldest = now - BAND_DETECTION.adaptive.windowSeconds;
  let drop = 0;
  while (drop < times.length && times[drop]! < oldest) drop += 1;
  if (drop > 0) {
    times.splice(0, drop);
    values.splice(0, drop);
  }
}

/**
 * 発光の瞬間に凍らせた音の姿。**見え方の解釈はここに入れない。**
 *
 * RGB や大きさをここから作るので、**帯域どうしを同じ基準で比べられる値**だけを
 * 帯域比率に使うこと。適応後の strength は帯域ごとに別の参照値で割った値なので、
 * 帯域間の比較には使えない（静かな帯域ほど小さな増分が 1.0 に化ける）。
 * 比率用には素の `bandFlux` を持たせてある。
 */
export interface AudioEventSnapshot {
  /** engine の RMS 音量（0..1、ピーク追従で正規化済み）。 */
  readonly volume: number;
  readonly bass: number;
  readonly mid: number;
  readonly treble: number;
  /**
   * 素の帯域フラックス（結合窓のあいだの最大値）。3 本とも同じ作り方・同じ
   * ゲインなので、**帯域比率を出せるのはこの値だけ**。
   */
  readonly bandFlux: Readonly<Record<BandName, number>>;
  /** その打撃の主役になった帯域。 */
  readonly winningBand: BandName;
  readonly spectralCentroid: number;
  /** この Core の強さ（局所正規化後）。明るさに使う。帯域間の比較には使わない。 */
  readonly onsetStrength: number;
  readonly spectralFlatness: number;
  readonly audioSeed: number;
  /**
   * 新奇性（0..1）。**直近数秒の文脈と比べて、この打撃がどれだけ突出しているか。**
   * `OnsetGate` の統計窓が持つ「代表的な山の高さ」を物差しに使う。
   * いつもどおりの打撃なら 0 付近、久しぶりの大きな一撃なら 1 に近づく。
   */
  readonly novelty: number;
  /** イベント通し番号（＝ sequence）。決定論のシードに使える。 */
  readonly eventIndex: number;
}

/** 検出された光イベント 1 個。**描画の都合は一切含まない。** */
export interface BandLightEvent {
  /** イベントが確定した時刻（表現へ渡された elapsed。秒）。 */
  readonly time: number;
  readonly band: BandName;
  /** 局所正規化された強さ（0..1）。明るさに使う。 */
  readonly strength: number;
  /** 帯域の選択に使った素のフラックス。帯域どうしを比べられるのはこちら。 */
  readonly rawFlux: number;
  /** イベント発生の瞬間の centroid（0..1）。 */
  readonly spectralCentroid: number;
  /** 同じ瞬間の音のシード（engine のスペクトルハッシュ。0..1）。 */
  readonly audioSeed: number;
  /** 同じ音響イベントから出たイベントの総数（兄弟の数を含む）。 */
  readonly eventCores: number;
  /** イベント通し番号。位置生成のシードなどに使える。リセットで 0 に戻る。 */
  readonly eventIndex: number;
  /** 同じ音響イベントの中での並び（0 始まり）。同時発生を散らすのに使える。 */
  readonly siblingIndex: number;
  /** 発光の瞬間の音の姿。Mapping 層はこれだけを読む。 */
  readonly snapshot: AudioEventSnapshot;
}

/** 呼び出し側（表現）が毎フレーム渡す設定。すべて開発用パラメータから来る。 */
export interface BandDetectionSettings {
  readonly fluxGain: number;
  readonly onsetSensitivity: number;
  readonly cooldownSeconds: number;
  /** 最強帯域に対する相対マージン。1 なら最強 1 本だけ。 */
  readonly relativeStrengthFloor: number;
  /**
   * 閾値の倍率。**1.0 が従来の効き**で、小さいほど発火しやすくなる。
   * 2D Core Study は 1.0 のまま（イベント列を変えないため）、
   * 3D の Spatial Study だけが下げてバーストを増やす。
   */
  readonly thresholdScale: number;
  readonly adaptiveThreshold: boolean;
  readonly adaptiveStrength: boolean;
}

/** 音のうち検出が読む部分だけ。engine への依存をここで断つ。 */
export interface BandDetectionAudio {
  readonly volume: number;
  readonly bass: number;
  readonly mid: number;
  readonly treble: number;
  readonly spectralCentroid: number;
  readonly spectralFlatness: number;
  readonly audioSeed: number;
}

/**
 * 帯域別の光イベント検出器。
 *
 * 1 フレーム 1 回 `update` を呼ぶと、その時点で確定したイベントの配列が返る
 * （ほとんどのフレームでは空）。表現はそれを受け取って、自分の流儀で光を作る。
 *
 * **順序を変えないこと。** 期限切れの窓を閉じる → 合成 Gate（観察）→ 帯域 Gate
 * の順で回すことで、2D Core Study と同じイベント列が出る。
 */
export class BandLightEventDetector {
  private readonly flux = new BandFluxAnalyzer();
  /** 合成フラックスの Gate。**観察専用**でイベントは生まない。 */
  private readonly combinedGate = new OnsetGate();
  private readonly bandGates: Record<BandName, OnsetGate> = {
    bass: new OnsetGate(),
    mid: new OnsetGate(),
    treble: new OnsetGate(),
  };
  private readonly bandFireCounts: Record<BandName, number> = { bass: 0, mid: 0, treble: 0 };
  private readonly bandLastStrength: Record<BandName, number> = { bass: 0, mid: 0, treble: 0 };
  private coincidenceState = { ...EMPTY_COINCIDENCE };
  private combinedFireCount = 0;
  private eventCounter = 0;
  /** 結合窓の中身。最初の帯域が立った瞬間に開き、満了で閉じてイベントを出す。 */
  private pending: {
    openedAt: number;
    entries: Partial<Record<BandName, { flux: number; strength: number }>>;
    /** 窓のあいだに見えた帯域フラックスの最大値。**発火しなかった帯域も含める。** */
    peakFlux: Record<BandName, number>;
    audio: BandDetectionAudio;
  } | null = null;

  // ---- 観察用の読み出し ----

  get bandFlux(): BandFlux {
    return this.flux.value;
  }

  get combined(): {
    threshold: number;
    warmingUp: boolean;
    samples: number;
    strengthReference: number;
    fireCount: number;
  } {
    return {
      threshold: this.combinedGate.threshold,
      warmingUp: this.combinedGate.warmingUp,
      samples: this.combinedGate.sampleCount,
      strengthReference: this.combinedGate.strengthReference,
      fireCount: this.combinedFireCount,
    };
  }

  bandState(band: BandName): BandGateState {
    const gate = this.bandGates[band];
    return {
      threshold: gate.threshold,
      warmingUp: gate.warmingUp,
      lastStrength: this.bandLastStrength[band],
      fireCount: this.bandFireCounts[band],
    };
  }

  get coincidence(): BandCoincidence {
    return { ...this.coincidenceState };
  }

  get eventPending(): boolean {
    return this.pending !== null;
  }

  /** 統計・窓・集計をすべて捨てる。無音・音源切替・dispose で呼ぶ。 */
  reset(): void {
    this.flux.reset();
    this.combinedGate.reset();
    this.combinedFireCount = 0;
    for (const band of BAND_NAMES) {
      this.bandGates[band].reset();
      this.bandFireCounts[band] = 0;
      this.bandLastStrength[band] = 0;
    }
    this.coincidenceState = { ...EMPTY_COINCIDENCE };
    this.pending = null;
    this.eventCounter = 0;
  }

  /**
   * 1 フレーム進める。確定したイベントを返す（無ければ空配列）。
   * `spectrum` が null のフレームでもクールダウンは進める。
   */
  update(
    spectrum: { magnitudes: Uint8Array; nyquist: number } | null,
    audio: BandDetectionAudio,
    elapsed: number,
    delta: number,
    settings: BandDetectionSettings,
  ): readonly BandLightEvent[] {
    if (spectrum) {
      this.flux.update(spectrum.magnitudes, spectrum.nyquist, elapsed, settings.fluxGain);
    }
    const measured = spectrum !== null && this.flux.updatedThisFrame;
    const gateInput = {
      delta,
      measured,
      fallbackThreshold: this.fixedThreshold(settings.onsetSensitivity),
      sensitivity: settings.onsetSensitivity,
      cooldownSeconds: settings.cooldownSeconds,
      adaptiveThreshold: settings.adaptiveThreshold,
      adaptiveStrength: settings.adaptiveStrength,
      thresholdScale: settings.thresholdScale,
    };

    // 先に期限の切れた窓を閉じる。閉じてから新しい発火を受けるので、
    // 窓の境目にきた発火は次のイベントとして扱われる。
    const events = this.closeIfDue(elapsed, settings.relativeStrengthFloor);

    // 観察用の合成 Gate。数えるだけでイベントは生まない。
    if (this.combinedGate.update({ value: this.flux.value.combined, ...gateInput }) !== null) {
      this.combinedFireCount += 1;
    }

    this.collect(gateInput, elapsed, audio);
    return events;
  }

  /** 感度 0..1 を固定閾値へ写す。ウォームアップと適応 OFF のときに使う。 */
  private fixedThreshold(sensitivity: number): number {
    const high = BAND_DETECTION.onsetThresholdAtZeroSensitivity;
    const low = BAND_DETECTION.onsetThresholdAtFullSensitivity;
    return high - clamp01(sensitivity) * (high - low);
  }

  /** 帯域ごとに判定し、立った帯域を結合窓へ集める。ここではイベントを出さない。 */
  private collect(
    gateInput: Omit<OnsetGateInput, 'value'>,
    elapsed: number,
    audio: BandDetectionAudio,
  ): void {
    // 窓が開いているあいだは、発火していない帯域のフラックスも記録しておく。
    // RGB の比率は「3 帯域が同時にどれだけ出たか」で決まるので、主役以外も要る。
    if (this.pending && gateInput.measured) {
      for (const band of BAND_NAMES) {
        const value = this.flux.value[band];
        if (value > this.pending.peakFlux[band]) this.pending.peakFlux[band] = value;
      }
    }

    const fired: BandName[] = [];
    for (const band of BAND_NAMES) {
      const strength = this.bandGates[band].update({
        value: this.flux.value[band],
        ...gateInput,
      });
      if (strength === null) continue;
      this.bandFireCounts[band] += 1;
      this.bandLastStrength[band] = strength;
      fired.push(band);

      if (!this.pending) {
        // 最初の帯域が立った瞬間に窓を開く。音の姿はこの瞬間の値で確定する。
        this.pending = {
          openedAt: elapsed,
          entries: {},
          peakFlux: { bass: 0, mid: 0, treble: 0 },
          audio,
        };
      }
      const flux = this.flux.value[band];
      if (flux > this.pending.peakFlux[band]) this.pending.peakFlux[band] = flux;
      const previous = this.pending.entries[band];
      // 同じ帯域が窓内で 2 度立ったら、フラックスの大きいほうを代表にする。
      if (previous === undefined || flux > previous.flux) {
        this.pending.entries[band] = { flux, strength };
      }
    }
    if (fired.length === 0) return;

    const single =
      fired.length === 1
        ? ({ bass: 'bassOnly', mid: 'midOnly', treble: 'trebleOnly' } as const)[fired[0]!]
        : null;
    this.coincidenceState = {
      ...this.coincidenceState,
      bassOnly: this.coincidenceState.bassOnly + (single === 'bassOnly' ? 1 : 0),
      midOnly: this.coincidenceState.midOnly + (single === 'midOnly' ? 1 : 0),
      trebleOnly: this.coincidenceState.trebleOnly + (single === 'trebleOnly' ? 1 : 0),
      twoBands: this.coincidenceState.twoBands + (fired.length === 2 ? 1 : 0),
      threeBands: this.coincidenceState.threeBands + (fired.length === 3 ? 1 : 0),
      lastEvent: fired.map((band) => BAND_LABELS[band]).join(' + '),
      events: this.coincidenceState.events + 1,
    };
  }

  /**
   * 結合窓が満了していたら閉じて、選ばれた帯域ぶんのイベントを返す。
   *
   * 帯域の選び方: **素のフラックス**が最大の 1 本は必ず出し、それ以外は
   * 「フラックスが最大 × floor を**超えている**」ものだけ足す。
   * 既定の 1.0 では比が 1 を超えることはないので、必ず 1 打 = 1 個になる
   * （同値の帯域も切り捨てる）。並びは `BAND_NAMES` の順なので決定論。
   */
  private closeIfDue(elapsed: number, relativeStrengthFloor: number): readonly BandLightEvent[] {
    const event = this.pending;
    if (!event) return EMPTY_EVENTS;
    if ((elapsed - event.openedAt) * 1000 < BAND_DETECTION.eventCoalesceMs) return EMPTY_EVENTS;
    this.pending = null;

    const entries = BAND_NAMES.filter((band) => event.entries[band] !== undefined).map(
      (band) => ({ band, ...event.entries[band]! }),
    );
    if (entries.length === 0) return EMPTY_EVENTS;

    let top = entries[0]!;
    for (const entry of entries) if (entry.flux > top.flux) top = entry;
    const floor = clamp(relativeStrengthFloor, 0, 1);
    const chosen = entries.filter(
      (entry) => entry === top || entry.flux > top.flux * floor,
    );

    const index = this.eventCounter;
    this.eventCounter += 1;
    const bandFlux = { ...event.peakFlux };
    // 新奇性: 主役帯域のフラックスが、その区間の代表的な山をどれだけ超えたか。
    const typical = this.bandGates[top.band].typicalPeak;
    const novelty = clamp01((top.flux - typical) / Math.max(typical, 0.12));
    return chosen.map((entry, siblingIndex) => ({
      time: elapsed,
      band: entry.band,
      strength: entry.strength,
      rawFlux: entry.flux,
      spectralCentroid: event.audio.spectralCentroid,
      audioSeed: event.audio.audioSeed,
      eventCores: chosen.length,
      eventIndex: index,
      siblingIndex,
      snapshot: {
        volume: event.audio.volume,
        bass: event.audio.bass,
        mid: event.audio.mid,
        treble: event.audio.treble,
        bandFlux,
        winningBand: top.band,
        spectralCentroid: event.audio.spectralCentroid,
        onsetStrength: entry.strength,
        spectralFlatness: event.audio.spectralFlatness,
        audioSeed: event.audio.audioSeed,
        novelty,
        eventIndex: index,
      },
    }));
  }
}

const EMPTY_EVENTS: readonly BandLightEvent[] = [];
