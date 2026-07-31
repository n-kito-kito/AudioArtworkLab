/**
 * **チャンネルの偏り（Channel balance）。**
 *
 * R / G / B を 3 本のつまみで別々に触ると、「どの音に反応しているのか」以前に
 * **何を触っているのか**が分からなくなる。3 本を **1 本の連続な経路**へ畳んだのがこれで、
 *
 * ```
 *   0 ── R が優勢 ── 0.5 ── G が優勢 ── 1 ── B が優勢
 * ```
 *
 * という**非循環**の道になる（両端がつながらないので、端は端として意味を持つ）。
 *
 * ## 白の予算を壊さない作り
 *
 * 利得の最大は**常にちょうど 1** で、動くのは「他の 2 本をどれだけ落とすか」だけ。
 * つまりこの軸は明るさを足さない。**白へ届いてよいのは核だけ**という予算は、
 * この軸をどこに置いても変わらない。
 *
 * ## なぜバンプなのか
 *
 * 段で切り替えると途中が無意味になる。3 つの山（R:0 / G:0.5 / B:1）を
 * 裾が重なる幅で置き、**同じ 1 本の式**で連続に配る。0.25 では R と G が
 * 同じくらい立つので、経路の途中にも固有の色がある。
 */

/** この軸の定数。**数値はここにしか書かない。** */
export const CHANNEL_BALANCE = {
  /** 山の裾の広さ。0.5 より広いと隣の山と重なり、途中の色が生まれる。 */
  span: 0.62,
  /**
   * 谷の深さの下限。0 にすると端で 1 チャンネルだけになって色が割れるので、
   * **落としきらない**。深すぎると**核が白へ届かなくなる** — 実測で 0.55 では
   * 既定の 0.5 で白が 0% に落ちた。0.72 は色が付きつつ核の白熱が残る深さ。
   */
  floor: 0.72,
} as const;

/** R / G / B の山の位置。**循環させない**ので両端は 0 と 1。 */
const CENTRES: readonly [number, number, number] = [0, 0.5, 1];

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/** 山 1 つぶん。裾の外はぴたりと 0 になる（尾を引かない）。 */
const bump = (distance: number): number => {
  const t = Math.abs(distance) / CHANNEL_BALANCE.span;
  return t >= 1 ? 0 : 1 - t * t;
};

/**
 * 軸の値（0〜1）から R / G / B の利得を作る。
 * **最大は常に 1**、他の 2 本が `floor` まで滑らかに落ちる。
 */
export const channelBalanceGain = (balance: number): readonly [number, number, number] => {
  const t = clamp01(balance);
  const floor = CHANNEL_BALANCE.floor;
  return [
    floor + (1 - floor) * bump(t - CENTRES[0]),
    floor + (1 - floor) * bump(t - CENTRES[1]),
    floor + (1 - floor) * bump(t - CENTRES[2]),
  ];
};
