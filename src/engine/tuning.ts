/**
 * 開発用チューニング値（PRD D17）。
 *
 * 範囲と感度は作り手が制作時に焼き込む内部定数であり、UI には出さない。
 * この値は ?tune=1 のチューニングパネルからのみ変更される。
 * 良い値が見つかったらここの既定値を書き換えて確定する（= 焼き込み）。
 *
 * プリセットには保存しない。実行時のユーザーには存在しない層である。
 *
 * **質感は版ごとに持つ。** V1 と V2 はモードの体系が違うため、同じ砂の量・
 * 同じ帯の太さでは同じようには見えない。どちらへ収斂するかを決めるまでは
 * それぞれの一番良い状態どうしで見比べる必要がある（PRD D22）。
 * 表現を切り替えると、その版の値が `TUNING` へ読み込まれる。
 */

/**
 * 質感を持つ版の一覧。`expressions` の ExpressionId と対応する。
 * `tuningDefaults` / `applyTuning` はこの型では受けない（下のコメント参照）。
 */
export type TuningVariant = 'cymatics-v1' | 'cymatics-v2';

/** V1（サイマティクス Version 1）の焼き込み値。 */
const V1 = {
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

  // モード切替の跳ね上げ（V2 のみ。V1 は起こさない = 見え方を変えない）
  //
  // 実機構: 駆動周波数が変わると板は過渡的に大きく鳴り、それまで節に溜まって
  // いた砂も跳ね上げられる。節線がいったん崩れて砂が板へ散り、収まると
  // 新しい節へ一気に集まり直す。模様が模様へ変形するのではない。
  releaseTime: 0.25, //    跳ね上げが収まるまでの秒数（短く保つ = 音に追従する）
  releaseScatter: 0.9, //  跳ね上げ中の散らばりの強さ（等方的な拡散）
  releaseReverse: 0.9, //  跳ね上げ中に砂が節から離れる強さ（1 で通常と逆向き）
  releaseSubsteps: 2, //   跳ね上げ中に分割数を何倍まで増やすか。
  //                       1 サブステップで運べる量は CFL で texel/dt に縛られる。
  //                       分割数を上げないと、散らばりも反転も上限に張り付いて効かない。

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

  // V2 の場（CymaticsV2: 自由端の正方形板）。V1 では読まれない。
  scaleBaseV2: 1.0, //    V2 の定義域。1 で板の縁 = 自由端（cos の微分ゼロ）に一致する
  anisotropyV2: 0.012, // 材料の異方性（x と y の剛性差）。板の個体差として固定
  exciteOffsetV2: 0.02, // 励振点の中心からのずれ。節線をわずかに非対称にする
};

export type TuningValues = typeof V1;
export type TuningKey = keyof TuningValues;

/**
 * V2（サイマティクス Version 2）の焼き込み値。V1 との差だけを書く。
 *
 * V2 は節線が曲がり閉領域が多いため、V1 より砂を厚く積み、帯を太く、
 * 濃く出す。切替のしきいと保持を下げて共振の移り変わりを素直に見せ、
 * うねりは切って崩れ側へ寄せている。
 */
const V2_OVERRIDES: Partial<TuningValues> = {
  grainBase: 1.5,
  inkBase: 0.7,
  inkSustain: 0.7,
  sandAmount: 0.8,
  driftSpeed: 0.5,
  mobilitySoft: 0.12,
  agitationNoise: 0.6,
  quietFloor: 0.15,
  repulsion: 1.15,
  modeHysteresis: 1.1,
  modeHoldMin: 0.5,
  fieldFloor: 0.5,
  seedCooldown: 2.5,
  warpAmount: 0,
  breakAmount: 0.2,
  scaleBaseV2: 0.8,
  anisotropyV2: 0.005,
  exciteOffsetV2: 0.012,

  // 跳ね上げは現時点では切っている（`releaseTime: 0` = 起こさない）。
  // 機構は残してあり、長さを戻せばそのまま効く（PRD D23）。
  releaseTime: 0,
  releaseScatter: 0,
  releaseReverse: 0.4,
  releaseSubsteps: 0,
};

const V2: TuningValues = { ...V1, ...V2_OVERRIDES };

/**
 * その版の焼き込み値（読み取り専用のつもりで扱う）。
 *
 * 引数を `TuningVariant` に狭めず `string` で受ける。サイマティクス以外の表現も
 * 生成時にここを通るため、未知の id が来たときに型エラーで止めるのではなく
 * V1 の値へ落とす必要がある（TUNING は表現をまたぐ単一のオブジェクトで、
 * 読まれないキーは単に無視される）。
 */
export function tuningDefaults(variant: string): TuningValues {
  return variant === 'cymatics-v2' ? V2 : V1;
}

/**
 * 実行中に読まれる値。表現の生成・切替のたびに、その版の焼き込み値で上書きされる。
 * チューニングパネルはこのオブジェクトを直接書き換える。
 */
export const TUNING: TuningValues = { ...V1 };

/**
 * 表現に合わせて質感を読み込む。`createExpression` から呼ばれる。
 * 引数を緩めている理由は `tuningDefaults` と同じ。
 */
export function applyTuning(variant: string): void {
  Object.assign(TUNING, tuningDefaults(variant));
}
