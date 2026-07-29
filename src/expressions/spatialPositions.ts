import type { BandLightEvent, BandName } from '../engine/bandLightEvents';

/**
 * 音から 3D の位置を決める（描画からは独立）。
 *
 * **`Math.random()` は使わない。** 位置は「その音のシード・帯域・イベントの通し番号・
 * スペクトル重心」だけから決まる決定論的なハッシュで、同じ音源を同じ条件で流せば
 * 同じイベントはだいたい同じ場所に出る。それでいて規則性は目に見えない。
 *
 * 置き方の約束:
 *   - 左右・上下に十分散らばる（中央に寄せない）
 *   - 手前から奥まで分布させ、同じ奥行きに揃えない
 *   - 画面外へ出さない。**カメラのフラスタムから逆算する**ので、
 *     どの画角（Aspect）でも自動的に収まる
 *   - 同時に出る Core は完全な同位置にしない（最低距離を持たせる）
 *   - 帯域を固定領域に閉じ込めない。Bass = 左のような強い規則は作らない
 *     （帯域はハッシュの材料の 1 つに留める）
 */

/** 位置生成の設定。定数は表現側（`SPATIAL_STUDY.position`）が 1 箇所で持つ。 */
export interface SpatialPositionConfig {
  readonly horizontalSpread: number;
  readonly verticalSpread: number;
  readonly depthSpread: number;
  readonly edgeMargin: number;
  readonly minimumDepth: number;
  readonly maximumDepth: number;
  readonly minimumCoreDistance: number;
  readonly deterministicSeedSalt: number;
}

export interface SpatialPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 距離 `depth` において画面に収まる範囲（半分の幅と高さ）。 */
export type VisibleExtent = (depth: number) => {
  readonly halfWidth: number;
  readonly halfHeight: number;
};

/** 帯域を数値へ。ハッシュの材料の 1 つで、位置を決め打ちするものではない。 */
const BAND_INDEX: Readonly<Record<BandName, number>> = { bass: 0, mid: 1, treble: 2 };

/** 同時発光がぶつかったときに引き直す回数の上限。超えたらそのまま置く。 */
const MAXIMUM_RETRIES = 6;

/**
 * FNV-1a を土台にした 0..1 のハッシュ。
 * 入力を粗く量子化してから畳むので、わずかな揺らぎでは値が動かず、
 * 別の音では予測できない値になる。
 */
const hash01 = (...values: number[]): number => {
  let hash = 0x811c9dc5;
  for (const value of values) {
    // 量子化してから 32bit へ。負値や小数もそのまま扱えるようにする。
    const quantized = Math.round(value * 4096) | 0;
    for (let shift = 0; shift < 32; shift += 8) {
      hash ^= (quantized >>> shift) & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash / 0x100000000;
};

export class SpatialPositionResolver {
  private readonly config: SpatialPositionConfig;
  /** 直近に置いた位置。最低距離の確保にだけ使う。 */
  private readonly recent: SpatialPosition[] = [];
  /** 参照を溜めすぎないよう、比較に使うのは直近この数だけ。 */
  private readonly recentLimit: number;

  constructor(config: SpatialPositionConfig, recentLimit = 32) {
    this.config = config;
    this.recentLimit = recentLimit;
  }

  reset(): void {
    this.recent.length = 0;
  }

  /**
   * イベント 1 個の置き場所を決める。
   *
   * 同時発光（同じイベントから出た兄弟）は `siblingIndex` がハッシュに入るので
   * 必ず別の値になり、さらに最低距離を満たすまで引き直す。
   */
  resolve(event: BandLightEvent, visible: VisibleExtent): SpatialPosition {
    let candidate = this.sample(event, visible, 0);
    for (let attempt = 1; attempt <= MAXIMUM_RETRIES; attempt++) {
      if (this.isFarEnough(candidate)) break;
      candidate = this.sample(event, visible, attempt);
    }
    this.remember(candidate);
    return candidate;
  }

  /** `attempt` を混ぜて引き直せるようにした 1 回ぶんの抽選。 */
  private sample(
    event: BandLightEvent,
    visible: VisibleExtent,
    attempt: number,
  ): SpatialPosition {
    const {
      horizontalSpread,
      verticalSpread,
      depthSpread,
      edgeMargin,
      minimumDepth,
      maximumDepth,
      deterministicSeedSalt,
    } = this.config;

    // ハッシュの材料。音のシードと帯域と通し番号を混ぜるので、
    // 同じ曲の同じ場所なら同じ値になり、別の音では予測できない値になる。
    const base = [
      event.audioSeed,
      BAND_INDEX[event.band],
      event.eventIndex,
      event.siblingIndex,
      event.spectralCentroid,
      attempt,
      deterministicSeedSalt,
    ];

    // 奥行き。centroid を弱く混ぜて「明るい音ほどわずかに手前」の傾きを与えるが、
    // 支配的にはしない（帯域や音程で奥行きが固定されないように）。
    const depthNoise = hash01(...base, 11);
    const depthMix = depthNoise * 0.75 + (1 - event.spectralCentroid) * 0.25;
    const depthRange = (maximumDepth - minimumDepth) * clamp01(depthSpread);
    const depth = minimumDepth + clamp01(depthMix) * depthRange;

    // その奥行きで見える範囲から逆算する。画角が変わっても外へ出ない。
    const extent = visible(depth);
    const usable = Math.max(1 - edgeMargin, 0);
    const x =
      signed(hash01(...base, 23)) * extent.halfWidth * usable * clamp01(horizontalSpread);
    const y =
      signed(hash01(...base, 37)) * extent.halfHeight * usable * clamp01(verticalSpread);

    return { x, y, z: -depth };
  }

  private isFarEnough(candidate: SpatialPosition): boolean {
    const minimum = this.config.minimumCoreDistance;
    if (!(minimum > 0)) return true;
    const squared = minimum * minimum;
    for (const other of this.recent) {
      const dx = other.x - candidate.x;
      const dy = other.y - candidate.y;
      const dz = other.z - candidate.z;
      if (dx * dx + dy * dy + dz * dz < squared) return false;
    }
    return true;
  }

  private remember(position: SpatialPosition): void {
    this.recent.push(position);
    if (this.recent.length > this.recentLimit) this.recent.shift();
  }
}

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/**
 * 0..1 を -1..1 へ。中央に寄らないよう、両端をわずかに持ち上げる。
 * 一様のままだと画面中央付近の密度が高く見えるため、緩い S 字で外へ寄せる。
 */
const signed = (value: number): number => {
  const centered = value * 2 - 1;
  return Math.sign(centered) * Math.pow(Math.abs(centered), 0.78);
};
