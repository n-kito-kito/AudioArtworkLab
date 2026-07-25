/**
 * 開発用チューニング値（PRD D17）。
 *
 * 範囲と感度は作り手が制作時に焼き込む内部定数であり、UI には出さない。
 * この値は ?tune=1 のチューニングパネルからのみ変更される。
 * 良い値が見つかったらここの既定値を書き換えて確定する（= 焼き込み）。
 *
 * プリセットには保存しない。実行時のユーザーには存在しない層である。
 */
export const TUNING = {
  // 質感（MinimalShape）
  bandBase: 0.7, //       境界の帯の太さの基準
  bandBass: 1.5, //       低域が帯を太らせる量
  edgeNoise: 0.85, //     縁の崩れの強さ
  detailBase: 2.6, //     模様の細かさの基準
  detailTreble: 7.5, //   高域が細かさを増やす量
  grainBase: 1.0, //      粒の大きさの基準（小さいほど細かい）
  grainTreble: 0.45, //   高域が粒を細かくする量
  densityBase: 0.88, //   粒の密度の基準
  densityBeat: 0.12, //   ビートが密度を上げる量
  fringe: 0.5, //         帯の外へ散る裾の量
  spreadBase: 0.7, //     裾の広がりの基準
  spreadVolume: 1.5, //   音量が裾を広げる量
  inkBase: 0.5, //        濃さの下限
  inkSustain: 0.5, //     持続が濃さを上げる量

  // 動き・生成（Cymatics）
  morphDuration: 2.0, //  モードが次の形へ移行する時間（秒）
  seedCooldown: 2.4, //   構図（向き・対称性）を引き直す最短間隔（秒）
  warpAmount: 0.22, //    低域による場のうねりの量
  breakAmount: 0.12, //   ノイズ的な音による節線の崩れの量
  scaleBase: 0.7, //      場の粗さの基準
  scaleCentroid: 1.1, //  音の明るさが場を細かくする量
};

export const TUNING_DEFAULTS = { ...TUNING };

export type TuningKey = keyof typeof TUNING;
