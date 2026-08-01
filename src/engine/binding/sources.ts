import type { AudioEngine, AudioParameters } from '../../audio/AudioEngine';
import type { AudioSource } from './types';

/**
 * **内部ソースの棚（開発用）。**
 *
 * 音の側が差し出す `AudioSource` の一覧。**新しい解析はしない** —
 * すでに engine が 1 フレーム 1 回計算しているもの（`AudioParameters` と
 * 観察用の `AudioFeatures`）を包んで 0〜1 の形にそろえるだけである。
 *
 * ここに並ぶのは**開発用の内部棚**で、ユーザー向けの聴取語彙は次のフェーズで決める。
 *
 * ---
 * ## 二重に計算しない仕掛け
 *
 * `update()` は **engine が返すパラメーター object の同一性**で「もう進めたか」を見る。
 * `FileAudioEngine.getParameters()` は 1 フレームのあいだ同じ object を返すので、
 * 表現と `?audio=1` の両方が呼んでも**そのフレームで進むのは 1 回だけ**になる。
 *
 * 時間は呼び出し側から渡す（`deltaSeconds`）。`Date.now()` も `Math.random()` も使わない。
 */

/** 棚の定数。時定数と閾値はここに集める。 */
export const SHELF = {
  /**
   * **代表ソースの時定数（秒）。**
   * 「速い / 遅い」を 2 本に分けると、どの音に反応させているのか分からなくなる。
   * 代表は 1 本にして、速い / 遅いの差は変換（envelope）と下流の時間規律で吸収する。
   */
  levelSeconds: 0.25,
  /**
   * **帯域の発火**を作る立ち上がり判定。
   * 既存の帯域値（`bass` / `mid` / `treble`）が 1 フレームでこれだけ跳ねたら発火とみなす。
   * 新しい解析ではなく、既にある値の差分だけを見る。
   */
  bandRise: 0.06,
  /** 発火したパルスが落ちる時定数（秒）。発火時 1 → ここで減衰する。 */
  bandDecaySeconds: 0.22,
  /** 打撃の強さのパルスが落ちる時定数（秒）。 */
  onsetDecaySeconds: 0.18,
  /**
   * **周波数全体（`spectrum`）のピーク追従。**
   *
   * engine の帯域正規化とまったく同じ流儀（天井は超えたら即上がり、下回ると
   * ゆっくり降りる・下限を持つ）にしてある。曲ごとに音圧が違っても
   * 「その曲の中でどれだけ鳴っているか」として読めるようにするため。
   */
  spectrumCeilingDecay: 0.9997,
  spectrumCeilingFloor: 0.06,
  /**
   * **周波数全体を数えるときの帯域の切り方（Hz）。**
   * engine（`FileAudioEngine`）と帯域イベント検出（`bandLightEvents`）と同じ境目に揃える。
   * ビンの範囲は nyquist から毎回計算するので、サンプルレートが変わっても崩れない。
   */
  spectrumBands: [
    [20, 250],
    [250, 4000],
    [4000, 16000],
  ] as readonly (readonly [number, number])[],
} as const;

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/** 発火 → 減衰パルス。**立ち上がりで 1 に張り付き、あとは時定数で落ちる。** */
class Pulse {
  private level = 0;
  private previous = 0;
  private seen = false;

  reset(): void {
    this.level = 0;
    this.previous = 0;
    this.seen = false;
  }

  /** 既存の値の立ち上がりを見て発火し、そうでなければ落ちる。 */
  update(value: number, rise: number, decaySeconds: number, deltaSeconds: number): number {
    const current = clamp01(value);
    const jumped = this.seen && current - this.previous >= rise;
    this.previous = current;
    this.seen = true;
    if (jumped) {
      this.level = 1;
      return this.level;
    }
    if (decaySeconds <= 0) {
      this.level = 0;
      return 0;
    }
    this.level *= Math.exp(-Math.max(deltaSeconds, 0) / decaySeconds);
    if (this.level < 1e-4) this.level = 0;
    return this.level;
  }

  /** 既に「強さ」が来ているとき（engine の onset）は、その値で持ち上げて落とす。 */
  hold(strength: number, decaySeconds: number, deltaSeconds: number): number {
    const value = clamp01(strength);
    if (value > this.level) {
      this.level = value;
      return this.level;
    }
    if (decaySeconds <= 0) return (this.level = 0);
    this.level *= Math.exp(-Math.max(deltaSeconds, 0) / decaySeconds);
    if (this.level < 1e-4) this.level = 0;
    return this.level;
  }
}

/** engine が観察用の特徴を出せるかどうか（出せないエンジンでも棚は動く）。 */
interface FeatureCapable {
  getFeatures?(): {
    readonly envelopeFast: number;
    readonly envelopeSlow: number;
    /** 盛り上がり ⇄ 引き（0.5 が中立）。 */
    readonly envelopeDelta: number;
  } | null;
}

export class AudioSourceShelf {
  private readonly engine: AudioEngine & FeatureCapable;
  /** 直近に読んだパラメーター。**object の同一性で二重更新を弾く。** */
  private lastParameters: AudioParameters | null = null;

  private volumeFast = 0;
  private volumeSlow = 0;
  private onsetLevel = 0;
  private bandLow = 0;
  private bandMid = 0;
  private bandHigh = 0;

  private readonly onsetPulse = new Pulse();
  private readonly lowPulse = new Pulse();
  private readonly midPulse = new Pulse();
  private readonly highPulse = new Pulse();

  private readonly shelf: readonly AudioSource[];

  // ---- 代表ソースの平滑値（level は 1 本の時定数で素直に追う）----
  private levelVolume = 0;
  private levelBass = 0;
  private levelMid = 0;
  private levelTreble = 0;
  private levelBrightness = 0;
  private levelRise = 0.5;
  /**
   * **周波数全体（`Bass` / `Mid` / `Treble` をまとめた 1 本）。**
   *
   * 3 帯域の平均を取り、**そのあとで 1 本だけ正規化する**。
   *
   * - **帯域ごとに平均してから足す**のは、単純に全ビンを平均すると
   *   ビン数の多い高域が答えを決めてしまうため。実測（reference.wav・25 秒）で
   *   全ビン平均は `Treble` と **r = 0.973** ＝ ほぼ同じ動きになり、棚に置く意味がなかった。
   *   帯域ごとに揃えると最大でも `Bass` と 0.69 で、既存のどれとも重ならない。
   * - **正規化を 1 本にまとめる**のが `Bass` / `Mid` / `Treble` を 3 本並べるのとの違い。
   *   棚の 3 本は engine が**帯域ごとの天井**で割った値なので、高域しか無い区間でも
   *   `Treble` は 1 に張り付く。こちらは 3 帯域の素の高さを足してから 1 つの天井で割るので、
   *   **帯域どうしの釣り合いがそのまま残る**（＝「全体としてどれだけ鳴っているか」）。
   * - `Volume` との違いも実測で出ている（**r = 0.42**）。`Volume` は**時間波形**の
   *   実効値なので低音の振幅が支配し（`Bass` と r = 0.63）、こちらは**周波数軸**の
   *   dB 目盛りなので、細い高音やノイズが増えただけでも上がる。
   *
   * 「新しい解析はしない」の原則は守っている — engine が 1 フレーム 1 回
   * 取り直している `getSpectrum()` のバッファを読むだけで、FFT は 1 回のままである。
   */
  private levelSpectrum = 0;
  /** 周波数全体のピーク追従の天井。 */
  private spectrumCeiling: number = SHELF.spectrumCeilingFloor;

  constructor(engine: AudioEngine & FeatureCapable) {
    this.engine = engine;
    this.shelf = [
      // ---- 棚に出る代表 7 本。**ひと目で「どの音か」が分かるものだけ。** ----
      { id: 'volume', label: 'Volume (音量)', kind: 'level', value: () => this.levelVolume },
      { id: 'bass', label: 'Bass (低域)', kind: 'level', value: () => this.levelBass },
      { id: 'mid', label: 'Mid (中域)', kind: 'level', value: () => this.levelMid },
      { id: 'treble', label: 'Treble (高域)', kind: 'level', value: () => this.levelTreble },
      {
        id: 'spectrum',
        label: 'Spectrum (周波数全体)',
        kind: 'level',
        value: () => this.levelSpectrum,
      },
      { id: 'onset', label: 'Onset (打撃)', kind: 'event', value: () => this.onsetLevel },
      {
        id: 'brightness',
        label: 'Brightness (音色の明るさ)',
        kind: 'level',
        value: () => this.levelBrightness,
      },
      { id: 'rise', label: 'Rise (盛り上がり)', kind: 'level', value: () => this.levelRise },

      // ---- ここから下は棚に出さない（内部の既定ドライブ用に温存）----
      { id: 'volume-fast', label: 'Volume (fast)', kind: 'level', hidden: true, value: () => this.volumeFast },
      { id: 'volume-slow', label: 'Volume (slow)', kind: 'level', hidden: true, value: () => this.volumeSlow },
      { id: 'onset-strength', label: 'Onset strength', kind: 'event', hidden: true, value: () => this.onsetLevel },
      { id: 'band-bass', label: 'Band bass', kind: 'event', hidden: true, value: () => this.bandLow },
      { id: 'band-mid', label: 'Band mid', kind: 'event', hidden: true, value: () => this.bandMid },
      { id: 'band-treble', label: 'Band treble', kind: 'event', hidden: true, value: () => this.bandHigh },
    ];
  }

  /** 棚に並んでいるソース（内部用。hidden も含む）。 */
  list(): readonly AudioSource[] {
    return this.shelf;
  }

  /** **UI に出す代表だけ。** 選択肢を増やしすぎないための絞り込み。 */
  visible(): readonly AudioSource[] {
    return this.shelf.filter((source) => !source.hidden);
  }

  find(id: string): AudioSource | null {
    return this.shelf.find((source) => source.id === id) ?? null;
  }

  reset(): void {
    this.lastParameters = null;
    this.volumeFast = 0;
    this.volumeSlow = 0;
    this.onsetLevel = 0;
    this.bandLow = 0;
    this.bandMid = 0;
    this.bandHigh = 0;
    this.onsetPulse.reset();
    this.lowPulse.reset();
    this.midPulse.reset();
    this.highPulse.reset();
    this.levelVolume = 0;
    this.levelBass = 0;
    this.levelMid = 0;
    this.levelTreble = 0;
    this.levelBrightness = 0;
    this.levelRise = 0.5;
    this.levelSpectrum = 0;
    this.spectrumCeiling = SHELF.spectrumCeilingFloor;
  }

  /**
   * **3 帯域の平均（0〜1）。** 各帯域はそのビン範囲の平均で、帯域幅の違いを
   * ここで消してから 3 本を足す。スペクトルを出せないエンジンでは 0
   *（棚は空にならず、繋いでも黒いまま = 無音扱いになる）。
   */
  private rawSpectrum(): number {
    const frame = this.engine.getSpectrum?.();
    if (!frame || frame.magnitudes.length === 0 || !(frame.nyquist > 0)) return 0;
    const bins = frame.magnitudes.length;
    const band = (low: number, high: number): number => {
      const from = Math.max(Math.floor((low / frame.nyquist) * bins), 0);
      const to = Math.min(Math.ceil((high / frame.nyquist) * bins), bins);
      if (to <= from) return 0;
      let total = 0;
      for (let index = from; index < to; index++) total += frame.magnitudes[index]!;
      return total / ((to - from) * 255);
    };
    const [bass, mid, treble] = SHELF.spectrumBands;
    return clamp01((band(bass[0], bass[1]) + band(mid[0], mid[1]) + band(treble[0], treble[1])) / 3);
  }

  /**
   * 1 フレーム進める。**同じフレームで 2 回呼んでも 1 回しか進まない。**
   * `force` は表示だけのページ（`?audio=1`）が、表現が回っていないときに
   * 自分で進めるための逃げ道。
   */
  update(deltaSeconds: number, force = false): void {
    const parameters = this.engine.getParameters();
    if (!force && parameters === this.lastParameters) return;
    this.lastParameters = parameters;

    const active = parameters.active === 1;
    if (!active) {
      // 無音では**全ソースが 0**。ここが「無音 = 黒」を守る土台になる。
      this.volumeFast = 0;
      this.volumeSlow = 0;
      this.onsetLevel = 0;
      this.bandLow = 0;
      this.bandMid = 0;
      this.bandHigh = 0;
      this.onsetPulse.reset();
      this.lowPulse.reset();
      this.midPulse.reset();
      this.highPulse.reset();
      this.levelVolume = 0;
      this.levelBass = 0;
      this.levelMid = 0;
      this.levelTreble = 0;
      this.levelBrightness = 0;
      this.levelSpectrum = 0;
      // 盛り上がりは 0.5 が中立なので、無音では中立へ戻す。
      this.levelRise = 0.5;
      return;
    }

    // ---- 連続値: 観察用の特徴が既に持っている 2 つの包絡をそのまま使う ----
    const features = this.engine.getFeatures?.() ?? null;
    if (features) {
      this.volumeFast = clamp01(features.envelopeFast);
      this.volumeSlow = clamp01(features.envelopeSlow);
    } else {
      // 特徴を持たないエンジンでは音量そのままで代用する（棚は空にしない）。
      const volume = clamp01(parameters.volume ?? 0);
      this.volumeFast = volume;
      this.volumeSlow = volume;
    }

    // ---- 発火: 既存の値から作る（新しい解析はしない）----
    this.onsetLevel = this.onsetPulse.hold(
      parameters.onset ?? 0,
      SHELF.onsetDecaySeconds,
      deltaSeconds,
    );
    this.bandLow = this.lowPulse.update(
      parameters.bass ?? 0,
      SHELF.bandRise,
      SHELF.bandDecaySeconds,
      deltaSeconds,
    );
    this.bandMid = this.midPulse.update(
      parameters.mid ?? 0,
      SHELF.bandRise,
      SHELF.bandDecaySeconds,
      deltaSeconds,
    );
    this.bandHigh = this.highPulse.update(
      parameters.treble ?? 0,
      SHELF.bandRise,
      SHELF.bandDecaySeconds,
      deltaSeconds,
    );

    // ---- 代表 7 本。**どれも既存の解析値を 1 本の時定数で追うだけ。** ----
    const follow = (current: number, target: number): number => {
      const alpha = 1 - Math.exp(-Math.max(deltaSeconds, 0) / SHELF.levelSeconds);
      return current + (clamp01(target) - current) * alpha;
    };
    this.levelVolume = follow(this.levelVolume, parameters.volume ?? 0);
    this.levelBass = follow(this.levelBass, parameters.bass ?? 0);
    this.levelMid = follow(this.levelMid, parameters.mid ?? 0);
    this.levelTreble = follow(this.levelTreble, parameters.treble ?? 0);
    // 音色の明るさは重心。観察用の特徴と同じ値を使う（新しい解析はしない）。
    this.levelBrightness = follow(this.levelBrightness, parameters.centroid ?? 0);
    // 周波数全体。engine の帯域と同じピーク追従で「その曲の中での鳴り具合」にする。
    const spectrum = this.rawSpectrum();
    this.spectrumCeiling = Math.min(
      Math.max(
        Math.max(spectrum, this.spectrumCeiling * SHELF.spectrumCeilingDecay),
        SHELF.spectrumCeilingFloor,
      ),
      1,
    );
    this.levelSpectrum = follow(this.levelSpectrum, spectrum / this.spectrumCeiling);
    // 盛り上がり = 速い包絡 − 遅い包絡（0.5 が中立）。観察用の特徴をそのまま使う。
    this.levelRise = features
      ? follow(this.levelRise, features.envelopeDelta)
      : follow(this.levelRise, 0.5);
  }
}

/**
 * **engine ごとに 1 つだけ棚を持つ。**
 *
 * 表現と `?audio=1` が別々に棚を作ると解析が二重になるので、
 * engine を鍵にして同じものを配る。
 */
const shelves = new WeakMap<AudioEngine, AudioSourceShelf>();

export const getSourceShelf = (engine: AudioEngine): AudioSourceShelf => {
  const existing = shelves.get(engine);
  if (existing) return existing;
  const created = new AudioSourceShelf(engine);
  shelves.set(engine, created);
  return created;
};
