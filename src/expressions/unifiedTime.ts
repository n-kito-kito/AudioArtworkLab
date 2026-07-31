import { STROBE, hash01 } from './lightOpticsMapping';

/**
 * **統合表現の時間の形（Light Unified の時間軸）。**
 *
 * `Strobe` / `Attack` / `Decay` の 3 本を、**1 本の式**の中の連続な係数として持つ。
 * どこにも「この軸が 0.5 を超えたら別の絵」という分岐は無い。
 *
 * ---
 * ## Strobe の作り方（切替ではない理由）
 *
 * 明滅は 2 つの独立した効果でできている。
 *
 * 1. **ラッチ**（`EmissionShape.read`）: ティックの頭で値を確定し、
 *    そのティックのあいだ動かさない（＝コマ送り）。
 * 2. **off ティックの消灯**（`strobePhaseGain`）: 層ごとの位相が off のティックで暗くする。
 *
 * `strobe = 0` は「ラッチ 0・消灯 0」＝ 連続のエンベロープそのもの、
 * `strobe = 1` は「完全ラッチ・完全消灯」＝ フルティックの明滅。
 * **2 つを同じ 1 本で同時に補間する**ので、0.5 では
 * 「連続に近い値が、off ティックで半分まで落ちる」＝ **半分明滅**が実在する。
 *
 * ## Attack / Decay
 *
 * 素の値（打撃の held）は階段状の矩形である。それを時定数で追うのが
 * `Attack`（登り）と `Decay`（降り）で、降りの時定数が長いほど**尾を引く**。
 * 軸 0 側の時定数はフレーム 1 枚分より短いので、0 では階段のまま出る。
 */

/** 時間軸の実寸。**数値はここにしか書かない。** */
export const TIME = {
  /** 立ち上がりの時定数（秒）。0 側は 1 フレームより短いので即時に見える。 */
  attackSeconds: { min: 0.004, max: 0.34 },
  /** 減衰の時定数（秒）。1 側で長い尾になる。 */
  decaySeconds: { min: 0.028, max: 1.9 },
  /** これを下回ったら消えたとみなす（尾を無限に引きずらない）。 */
  epsilon: 0.0015,
} as const;

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 立ち上がりの時定数（秒）。軸 0〜1 を実寸へ。 */
export const attackTauOf = (attack: number): number =>
  mix(TIME.attackSeconds.min, TIME.attackSeconds.max, clamp01(attack));

/** 減衰の時定数（秒）。軸 0〜1 を実寸へ。 */
export const decayTauOf = (decay: number): number =>
  mix(TIME.decaySeconds.min, TIME.decaySeconds.max, clamp01(decay));

/**
 * **明滅の位相の利得。**
 *
 * 層ごとに位相をずらして on / off を交互にする（同じ群の 2 枚以上は必ずどれかが点く）。
 * off の側で暗くする深さが `strobe` そのものなので、
 * 0 で 1 倍（消えない）・0.5 で半分・1 で完全に消える ＝ **半分明滅が実在する**。
 * オフセットは seed 由来で決定論。
 */
export const strobePhaseGain = (
  strobe: number,
  tick: number,
  seed: number,
  groupKey: number,
  index: number,
): number => {
  const amount = clamp01(strobe);
  if (amount <= 0 || tick < 0) return 1;
  const offset = Math.floor(hash01(Math.round(seed) + groupKey, 7717) * STROBE.period);
  const phase =
    (((Math.round(tick) + index + offset) % STROBE.period) + STROBE.period) % STROBE.period;
  return phase < STROBE.onTicks ? 1 : 1 - amount;
};

/**
 * **1 つの発光の時間の形。**
 * 素の目標値を Attack / Decay の時定数で追い、ティックの頭の値も覚えておく。
 * 明滅（off ティックの消灯）は層ごとなので、ここは**ラッチだけ**を持つ。
 */
export class EmissionShape {
  private value = 0;
  private latched = 0;
  private tick = -1;

  reset(): void {
    this.value = 0;
    this.latched = 0;
    this.tick = -1;
  }

  /** 素の目標値へ 1 フレーム進める。登りと降りで時定数が違う。 */
  advance(
    target: number,
    deltaSeconds: number,
    tick: number,
    attack: number,
    decay: number,
  ): void {
    const tau = target > this.value ? attackTauOf(attack) : decayTauOf(decay);
    const alpha = 1 - Math.exp(-Math.max(deltaSeconds, 0) / Math.max(tau, 1e-4));
    this.value += (target - this.value) * alpha;
    if (target <= 0 && this.value < TIME.epsilon) this.value = 0;
    if (tick !== this.tick) {
      this.tick = tick;
      this.latched = this.value;
    }
  }

  /** **ラッチ量を `strobe` が決める。** 0 で連続、1 でティックの階段。 */
  read(strobe: number): number {
    return mix(this.value, this.latched, clamp01(strobe));
  }

  /** 連続側の値（検証用）。 */
  get level(): number {
    return this.value;
  }
}
