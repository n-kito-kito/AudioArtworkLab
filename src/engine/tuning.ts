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

  // 板のシミュレーション（CymaticsPlate: 砂の密度場）
  //
  // 実機構: 板の加速度が重力を超えた場所で砂粒が跳ね上げられ、着地位置が動く。
  // 腹では跳ね続け、節（振幅ゼロ）では跳ねないので動きが止まり、そこに溜まる。
  // 「移動度 ∝ 振動振幅」の自己捕捉ランダムウォークであり、慣性は持たない。
  sandAmount: 0.22, //         板の上の砂の総量。再正規化でこの量に保たれ続ける
  driftSpeed: 0.42, //        跳ねている砂が節へ寄る速さ（uv/秒）。大きいほど再配置が速い
  substeps: 8, //             1 フレームの分割数。多いほど速く動かせる（CFL 制限のため）
  mobilityFloor: 0.03, //     この振幅以下では砂が跳ねない（＝節で静止する閾値）
  mobilitySoft: 0.08, //      跳ね始めの滑らかさ。小さいほど節の縁が鋭い
  agitationNoise: 0.45, //    跳ね方の粒ごとのばらつき（線を有機的にする）
  onsetBurst: 1.6, //         オンセットで一斉に跳ねる量
  quietFloor: 0.25, //        小音量でも最低限は跳ねる割合
  diffusion: 0.12, //         着地位置のばらつき（局所的なにじみ）
  repulsion: 1.4, //          高密度からの反発（山が潰れて幅が不均一になる）

  // 固有モードの励起と切り替え（modeBank）
  modeHysteresis: 1.15, // 候補が現在のモードを上回るべき倍率
  modeConfirm: 0.2, //     候補が優位を保つべき秒数
  modeHoldMin: 0.8, //    一度選んだモードの最短保持秒数（強いオンセットで短縮）
  secondaryMax: 0.4, //   副モードの最大混合率
  fieldFloor: 0.35, //    共振域の外での振動場の下限（模様が弱く不安定になる）

  // 動き・生成（Cymatics）
  seedCooldown: 2.4, //   構図（向き・対称性）を引き直す最短間隔（秒）
  warpAmount: 0.03, //    低域による場のうねりの量
  breakAmount: 0.05, //   ノイズ的な音による節線の崩れの量
  scaleBase: 0.7, //      場の粗さの基準
  scaleCentroid: 1.1, //  音の明るさが場を細かくする量
};

export const TUNING_DEFAULTS = { ...TUNING };

export type TuningKey = keyof typeof TUNING;
