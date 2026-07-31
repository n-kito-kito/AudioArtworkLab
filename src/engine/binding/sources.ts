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
   * **帯域の発火**を作る立ち上がり判定。
   * 既存の帯域値（`bass` / `mid` / `treble`）が 1 フレームでこれだけ跳ねたら発火とみなす。
   * 新しい解析ではなく、既にある値の差分だけを見る。
   */
  bandRise: 0.06,
  /** 発火したパルスが落ちる時定数（秒）。発火時 1 → ここで減衰する。 */
  bandDecaySeconds: 0.22,
  /** 打撃の強さのパルスが落ちる時定数（秒）。 */
  onsetDecaySeconds: 0.18,
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
  getFeatures?(): { readonly envelopeFast: number; readonly envelopeSlow: number } | null;
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

  constructor(engine: AudioEngine & FeatureCapable) {
    this.engine = engine;
    this.shelf = [
      { id: 'volume-fast', label: 'Volume (fast)', kind: 'level', value: () => this.volumeFast },
      { id: 'volume-slow', label: 'Volume (slow)', kind: 'level', value: () => this.volumeSlow },
      { id: 'onset-strength', label: 'Onset strength', kind: 'event', value: () => this.onsetLevel },
      { id: 'band-bass', label: 'Band bass', kind: 'event', value: () => this.bandLow },
      { id: 'band-mid', label: 'Band mid', kind: 'event', value: () => this.bandMid },
      { id: 'band-treble', label: 'Band treble', kind: 'event', value: () => this.bandHigh },
    ];
  }

  /** 棚に並んでいるソース。 */
  list(): readonly AudioSource[] {
    return this.shelf;
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
