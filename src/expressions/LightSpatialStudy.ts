import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type {
  CompositionContext,
  DesignLayerCanvases,
} from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import {
  BandLightEventDetector,
  type BandFlux,
  type BandGateState,
  type BandLightEvent,
  type BandName,
} from '../engine/bandLightEvents';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { ExpressionParam, LabExpression } from './Expression';
import { createPolygonAtlas, type PolygonAtlas } from './polygonAtlas';
import { loadPrismAtlas, type PrismAtlas } from './prismAtlas';
import {
  LightSpatialMapping,
  bloomDrive,
  trailSeconds,
  type LightGradient,
  type MacroLayerTraits,
  type LightMappingSettings,
  type LightRole,
  type LightShape,
  type LightShapeKind,
  type LightVisualTraits,
} from './spatialMapping';

/**
 * Light Traces — Spatial Study。**3D 空間の検証表現**であり、完成版ではない。
 *
 * 2D の Core Study（`LightCoreStudy`）が「音の出来事と光の因果」を確かめる計測器なら、
 * こちらは「その光を奥行きのある空間に置いたとき、固定カメラで前後関係が読めるか」を
 * 確かめる計測器。音の検出は 2D とまったく同じ `BandLightEventDetector` を通す。
 * 2D は回帰確認用にそのまま残してあり、こちらが置き換えるものではない。
 *
 * 今回入れないもの: Core の移動 / Trail / Beam / Fog / Haze / RGB 分離 /
 * Bloom の焼き込み / 被写界深度 / カメラアニメーション。
 * **静止した Core が違う奥行きに在るだけで遠近が読める状態**までを見る。
 *
 * カメラは固定。原点から −Z を見るだけで、回転も移動もユーザー操作もしない。
 * Core はカメラを向く板ポリを 1 つの InstancedMesh で描く（1 ドロー）。
 * 光源（PointLight）は 1 つも使わない。
 *
 * 距離による減衰は今回は入れない。**遠近法だけで奥行きが読めるか**を見たいので、
 * 手前ほど明るいといった補助は足さず、同じワールドサイズの板が遠いほど小さく写る
 * ことだけで判断する。
 */

/**
 * この表現の定数はすべてここに集める。位置生成に渡すぶんは `position` にまとめてある
 * （`SpatialPositionResolver` はこのオブジェクトを受け取るだけで、自前の定数を持たない）。
 */
const SPATIAL_STUDY = {
  /**
   * 同時に生かす光の上限。
   * 1 イベント = メイン 1 + サブ N のバーストになったので、2D の 32 では足りない。
   * 上限に達したら最も古い光から捨てる（ドローコールは 1 のまま）。
   */
  maximumCores: 260,
  /** 固定カメラの垂直画角（度）。奥行きの見え方はこの値で決まる。 */
  fieldOfView: 50,
  nearPlane: 0.1,
  farPlane: 200,
  /**
   * Core 1 個のワールドサイズ（板の一辺）。**奥でも手前でも同じ大きさ**にしておき、
   * 画面上の大小は遠近法だけから出るようにする。
   */
  coreWorldSize: 0.62,
  /** ガウス減衰の鋭さ。板の端で exp(-3) ≈ 0.05 まで落ちる。 */
  coreFalloff: 3,
  /**
   * 軌跡 1 本ぶんの節の数。**3D の位置履歴**を固定長で持ち、同じ InstancedMesh の
   * 後ろ半分として 1 ドローで描く。増やすほど滑らかになるが描画量も増える。
   */
  trailSegments: 6,
  /** 軌跡の節の明るさ（先端 → 末尾）。0 で完全に消える。 */
  trailIntensityAtTail: 0,
  /** 軌跡の節の大きさ（先端に対する末尾の倍率）。細くなるほど「光跡」に見える。 */
  trailSizeAtTail: 0.35,

  /**
   * 光学的な質感。**1 つずつ切って比べられるように、効きを別々の定数にしてある。**
   * どれも「光がある場所でだけ見える」ものに限る。画面全体へ白をかぶせない。
   */
  optics: {
    /** 中心核の締まり具合。大きいほど芯が小さく硬くなる。 */
    coreSharpness: 3.4,
    /** 中距離の滲み（Bloom 相当）の広がり。核の何倍まで届くか。 */
    haloRadius: 3.2,
    /**
     * 同・強さ。0 で滲みなし。
     * 参照デモ（UnrealBloomPass の公式サンプル）のネオン感に寄せて引き上げてある。
     */
    haloStrength: 0.42,
    /**
     * 広く弱い散乱光の広がり。
     * **板の大きさ＝塗る面積**なので、ここを詰めると描画コストが二乗で効く。
     * バーストで光の数が増えたぶん、以前より小さくして塗り面積を抑えてある。
     */
    scatterRadius: 5,
    /**
     * 同・強さ。0 で散乱なし。**霧ではなく、光の周りにだけ出る。**
     * 内部 Bloom が滲みを担うようになったので、散乱は控えめでよい。
     * ここを強くすると画面全体が薄く光り、Bloom で一気に白飛びする。
     */
    scatterStrength: 0.05,
    /**
     * 板を張る余裕（散乱半径の何倍まで確保するか）。
     *
     * ここを詰めすぎると、散乱がまだ十分明るいところで板の縁に達し、
     * **四角い継ぎ目**として見えてしまう（2D Light Traces の fog で踏んだのと同じ罠）。
     * 余裕を持たせたうえで、縁で必ず 0 になる窓関数も掛けて二重に防ぐ。
     */
    scatterSpanMargin: 1.5,
    /**
     * **1 要素の内部の分光が広がる半径**（核の半径を 1 とした単位）。
     *
     * 板は散乱ぶんまで大きく（`scatterRadius × scatterSpanMargin` = 5.7）張ってあるが、
     * 実際に色が読める明るさが出ているのは核と滲みの範囲だけ。物差しを板いっぱいに
     * 取ると色相の変化がまるごと「暗くて見えない外側」に入ってしまうので、
     * 滲みの半径あたりに合わせる。
     */
    gradientReach: 2.2,
    /**
     * RGB の微小な空間分離。色収差のように、色ごとに滲みの半径をわずかに変える。
     * 0 で分離なし。大きくすると輪郭に色が付く。
     */
    chromaticSeparation: 0.09,
    /**
     * 距離によるごく弱いコントラスト差。奥ほどわずかに沈む。
     * 0 で完全に無効（遠近法だけで見る状態に戻る）。
     */
    distanceContrast: 0.22,
    /** 同・効き始める距離と効ききる距離。 */
    contrastNearDepth: 5,
    contrastFarDepth: 17,
    /**
     * 内部 Bloom（three.js の `UnrealBloomPass`）。
     * 既存の Effect チェーン（外側の Bloom Effect を含む）より**前**に掛かる。
     * 参照デモ（threshold 0 / strength 1 / radius 0.5）は細い線が黒地にあるだけの
     * 画なのでそのままで成立するが、こちらは散乱が画面を薄く覆うため、
     * threshold を上げて**明るい核だけを滲ませる**。実測で色が残る範囲に詰めてある。
     */
    bloomThreshold: 0.22,
    bloomStrength: 0.92,
    bloomRadius: 0.48,
    /**
     * 画面全体の露出。核・滲み・散乱・Bloom をすべて通したあと、最後に掛ける。
     * トーンマップは `1 - exp(-x·exposure)` なので、**黒は必ず黒のまま**。
     */
    exposure: 0.95,
  },
  /**
   * **層の濃度設計。** 狙いは「発光体」ではなく
   * **プリズムを通った光が空間に現れた**状態で、1 枚あたりの寄与を薄くし、
   * 加算で重なったところだけが濃くなるようにする。
   *
   * 値は「その形 1 枚が単独で出せる濃さの倍率」で、Intensity スライダー
   * （既定 2.2）に掛かる。単層で白へ張り付かず、2 枚・3 枚と重なった段が
   * 目で数えられるところに置いてある。
   *
   * 実測（サブのスパーク 1 枚を同じ位置に重ねたときの最大輝度 / 255）:
   *   1 枚 60 → 2 枚 134 → 3 枚 184 → 4 枚 235。
   * この 1 枚ぶんを 2 倍以上に上げると 2 枚目で 246 まで飛び、段が読めなくなる
   * （内部 Bloom の閾値 0.3 より上が超線形に効くため、単純な加算より速く飽和する）。
   */
  layering: {
    /** 点のスパーク。芯があるので、他より少しだけ濃くてよい。 */
    spark: 0.15,
    /** 針状の光条。細長いぶん塗る面積が出るので薄く。 */
    needle: 0.4,
    /** 波打つ弧。いちばん重なりやすいのでさらに薄く。 */
    arc: 0.34,
    /**
     * 画面を貫く針。芯が 1〜2px しかなく塗る面積が小さいので、
     * 濃度は残す（細く強く鋭い印象がここで決まる）。
     */
    ray: 0.8,
    /**
     * 軸平面のフラッシュ。**膜として透ける**のが役目。
     * 多角形になって塗る面積が画面の 2〜3% まで小さくなったぶん、
     * 1 枚の濃さは丸い膜だった頃（0.32）より上げてある。
     *
     * 上げすぎないのは**内部 Bloom の敷居（0.3）に段があるから**。
     * 平らな面が敷居を越えると面ごと滲んで一気に白へ飛ぶので、
     * 1 枚では越えず、2 枚重なってちょうど越えるあたりに置く。
     * 実測（同じ向きに重ねたときの最大輝度）: 1 枚 34 → 2 枚 65 → 3 枚で白熱。
     *
     * プリズム質感レイヤーが入ったあとはさらに引いてある。素材の README では
     * 多角形は**硬い面として見せず、質感レイヤーの外形マスクに使う**役割なので、
     * 面そのものは膜の奥にうっすら残る程度でよい。
     */
    plane: 0.3,
    /**
     * メインの光だけに掛ける追加ゲイン。
     * 「強い打撃の中心は強くてよい」ぶんをここで戻す。
     */
    mainScale: 0.9,
    /** 軌跡の節に掛ける追加の薄さ。残像はさらに引っ込める。 */
    trailScale: 0.55,
  },

  /**
   * **軸平面のフラッシュに使う多角形の帳面。**
   * 起動時に一度だけ決定論で焼き、インスタンス属性で 1 枚を選ぶ（ドローコールは 1 のまま）。
   * 中身は SDF なので 16 倍まで開いても輪郭がぼけない。
   */
  planeAtlas: {
    /** 図形の枚数。**8 種以上**を確保する。 */
    patterns: 12,
    columns: 4,
    /** セル 1 つの辺（テクセル）。SDF なので 128 で十分。 */
    cellPixels: 128,
    /** 頂点数。5〜7 の非対称形にする。 */
    vertexMinimum: 5,
    vertexMaximum: 7,
    /** 中心からの距離の幅。広いほど「折れた紙」寄りの鈍角多角形になる。 */
    radiusMinimum: 0.42,
    radiusMaximum: 0.94,
    /** 頂点の角度の散らし。0 だと正多角形になってしまう。 */
    angleJitter: 0.62,
    /** SDF を 0..1 に写す幅。縁のにじみを載せる余地ぶん確保する。 */
    distanceSpread: 0.7,
    seedSalt: 0.3141592653,
  },
  /**
   * 多角形の縁の出し方。**ガウスぼけではなく鋭い輪郭**にする。
   * SDF の 0.5 が輪郭なので、そのすぐ両側だけで切り替える。
   */
  planeEdge: {
    /**
     * 多角形の板の基準倍率。
     *
     * 板は散乱ぶんまで大きく（`scatterRadius × scatterSpanMargin`）張ってあるので、
     * そのまま 16 倍まで開くと**画面より遥かに大きくなり、多角形の 1 辺しか写らない**。
     * 丸くぼけていた頃は気にならなかったが、輪郭が鋭くなると
     * 「画面を斜めに横切る直線」にしか見えなくなる。
     * 開ききったときにちょうど画面いっぱいへ収まるところまで縮めてある。
     */
    plateScale: 0.062,
    /** 輪郭の切り替え幅。小さいほど鋭い。0 にするとジャギーが出る。 */
    sharpness: 0.012,
    /** 縁の外側へ薄く出るにじみの幅。 */
    bleedWidth: 0.055,
    /** 同・強さ。0 でにじみなし。 */
    bleedStrength: 0.45,
    /**
     * 内側の陰り。縁が少し暗く、奥がわずかに明るい。
     * 完全な平坦だと「紙を切り抜いた白」にしか見えないので、ごく弱く付ける。
     */
    edgeLevel: 0.72,
    interiorSoftness: 0.16,
  },
  /**
   * **画面を貫く針。** 芯の太さは画素で指定する。
   * ワールド単位で持つと、奥行きや画角で太さが変わって「1〜2px の芯」を保てない。
   */
  ray: {
    /** 芯の半幅（画素）。1 で全幅 2px 級。 */
    corePixels: 1.1,
    /** 板を張る倍率（芯の半幅の何倍まで）。淡いグロー側の広がり。 */
    glowSpan: 9,
    /** グローの強さ（芯を 1 としたとき）。 */
    glowStrength: 0.3,
    /** 長さ（画面対角の何倍まで伸ばすか）。1 を超えれば必ず画面外へ出る。 */
    reachScale: 1.3,
    /** 全長に達するまでの時間（秒）。数フレーム以内。 */
    growSeconds: 0.045,
    /** 生まれた瞬間の長さの割合。0 だと 1 フレーム目が見えない。 */
    lengthAtBirth: 0.12,
    /** 端の落ち。1 に近いほど画面外ぎりぎりまで同じ濃さで届く。 */
    tipTaper: 0.22,
  },

  /**
   * **Burst 全体を包むプリズム質感レイヤー（Macro layer）。**
   *
   * 10 枚の素材を 1 枚のアトラスへまとめ、素材番号・UV クロップ・回転・反転・
   * 歪み・色をインスタンス属性で渡す。**Texture layer の Draw Call は 1**。
   * 素材ごとの Material は作らない。
   *
   * 素材は「完成した絵」ではなく**輝度マスク**として読む。色は音から作った
   * グラデーションと混ぜ、板の四角い輪郭は円窓と多角形マスクの二重で消す。
   */
  macro: {
    /** 同時に生かす枚数。Decay が長いので Transient より長く残る。 */
    maximumLayers: 14,
    /** アトラスの組み立て。元は 1024px だが、大きく引き伸ばすので落として持つ。 */
    atlas: {
      // Vite の base に追従させる（既定は '/'）。ページの階層に依らず解決できる。
      manifestUrl: `${import.meta.env.BASE_URL}assets/light-traces/manifest.json`,
      cellPixels: 512,
      columns: 5,
    },
    /**
     * 1 枚あたりの濃度。**膜として透ける**のが役目なので、
     * Transient の芯より薄い。重なったところだけが濃くなる。
     */
    opacity: 0.8,
    /**
     * 板の四角い輪郭を消す円窓。この半径から外へ向けて 0 になる。
     * **ここを 1.0 に近づけると素材の正方形が見えてしまう。**
     */
    edgeFadeStart: 0.55,
    /**
     * 黒浮きを落とす敷居と幅。素材の暗部を加算の前に切る。
     * これが無いと、薄い Haze が画面全体を灰色に持ち上げる。
     *
     * **素材の実測が効いている値。** 10 枚の平均輝度は 0.017〜0.066 しかなく、
     * 見せたい膜そのものが 0.05〜0.3 に居る。敷居を 0.05 に置くと膜まで
     * 一緒に消えてしまったので、ノイズ側（0.01 以下）だけを切る幅にしてある。
     */
    blackFloor: 0.017,
    blackFloorWidth: 0.042,
    /**
     * 素材の輝度の曲げ。1 で素通し。
     * **1 未満で暗部を持ち上げる。** 素材の膜は元が暗いので、
     * 締める（>1）と芯の細い線しか残らず「膜が漂う」感じが出ない。
     */
    luminanceGamma: 0.7,
    /**
     * 多角形マスクの柔らかさ。**硬い面には見せない**ので広くぼかす。
     * 0.5 の前後この幅で切り替わるので、0.2 なら輪郭は完全になだらか。
     */
    maskSoftness: 0.3,
    /** UV をマスの内側へ寄せる余白。隣の素材へ絶対に滲ませない。 */
    cellInset: 0.004,
  },

  /** 1 フレームで進める時間の上限（秒）。タブ復帰時の巨大な delta を切る。 */
  maximumDelta: 0.05,
  /** Decay の曲がり。大きいほど頭で速く落ちる。 */
  decayCurve: 3,

  /** 位置生成の定数（`SpatialPositionResolver` へそのまま渡す）。 */
  position: {
    /** 横方向の広がり。1.0 で「余白を除いた可視範囲いっぱい」まで使う。 */
    horizontalSpread: 0.92,
    /** 縦方向の広がり。 */
    verticalSpread: 0.86,
    /** 奥行き方向の広がり。1.0 で minimumDepth〜maximumDepth を全部使う。 */
    depthSpread: 1,
    /** 画面端に残す余白（可視範囲に対する割合）。どの Aspect でも切れないようにする。 */
    edgeMargin: 0.1,
    /** カメラからの距離の下限（ワールド単位）。 */
    minimumDepth: 4.5,
    /** カメラからの距離の上限。 */
    maximumDepth: 17,
    /** Core どうしを最低これだけ離す（ワールド単位）。同時発光が重ならないように。 */
    minimumCoreDistance: 1.1,
    /** ハッシュの味付け。見え方を変えたいときにここだけ動かす（本番 UI には出さない）。 */
    deterministicSeedSalt: 0.6180339887,
  },

  /** 開発用パラメータの既定値。2D Core Study と同じ意味・同じ既定値。 */
  defaults: {
    // 瞬間的な点滅感にする。Attack はほぼゼロ、Decay は 2D の半分。
    attackMs: 4,
    holdMs: 22,
    decayMs: 175,
    // 暗い光を減らす。ただし上限との差は残して強さの分布は広く保つ。
    minimumIntensity: 0.5,
    maximumIntensity: 1,
    onsetSensitivity: 0.5,
    fluxGain: 2.5,
    cooldownMs: 60,
    relativeStrengthFloor: 1,
    /** 大きさ・色・動き・軌跡の効き。Phase を進めるごとに既定値を上げていく。 */
    sizeAmount: 0.85,
    colorAmount: 0.8,
    motionAmount: 0.7,
    trailAmount: 0.35,
    /** サブの光の個数の倍率。0 でメインだけ、2 で計算値の倍。 */
    burstDensity: 1,
    /**
     * 太さの効き。0 で音に依らず基準の細さ、1 で低音・低 centroid・大音量が
     * そのまま幅になる。**細い斬撃の束にしないための主要つまみ。**
     */
    thicknessAmount: 1,
    /** 質感レイヤーが画面周辺まで広がる度合い。 */
    macroSpreadAmount: 1,
    /** 奥行きの散らばり。0 で中間の段だけ、1 で手前・奥まで使う。 */
    depthAmount: 1,
    /** 横へ走る針の出やすさ。0 で縦横同数、1 で横に強く寄る。 */
    horizontalRayAmount: 1,
    /** 光源そのものの強さ（滲み・露出とは別の役割）。 */
    /** 内部 Bloom。参照デモと同じ操作感で並べる。 */
    bloomThreshold: 0.22,
    bloomStrength: 0.92,
    bloomRadius: 0.48,
    /** 画面全体の露出。 */
    exposure: 0.95,
    /**
     * 発火のしやすさ。**小さいほど発火する**（閾値の倍率）。
     * ある程度の立ち上がりならほぼ光る状態にしたいので、既定で 2D より下げる。
     * クールダウンは据え置きなので連射の暴走はしない。
     */
    thresholdScale: 0.45,
    /**
     * 光源そのものの総合強度。Exposure や Bloom とは分ける。
     * リファレンスの強い白い核を確認できるよう、従来の 1.0 より明るく始める。
     */
    intensity: 2.2,
  },
  ranges: {
    attackMs: { min: 0, max: 200, step: 1 },
    holdMs: { min: 0, max: 500, step: 1 },
    decayMs: { min: 20, max: 2000, step: 10 },
    minimumIntensity: { min: 0, max: 1, step: 0.01 },
    maximumIntensity: { min: 0, max: 1, step: 0.01 },
    onsetSensitivity: { min: 0, max: 1, step: 0.01 },
    fluxGain: { min: 1, max: 40, step: 0.5 },
    cooldownMs: { min: 0, max: 400, step: 5 },
    relativeStrengthFloor: { min: 0.4, max: 1, step: 0.05 },
    sizeAmount: { min: 0, max: 1, step: 0.05 },
    colorAmount: { min: 0, max: 1, step: 0.05 },
    motionAmount: { min: 0, max: 1, step: 0.05 },
    trailAmount: { min: 0, max: 1, step: 0.05 },
    burstDensity: { min: 0, max: 2, step: 0.05 },
    thicknessAmount: { min: 0, max: 1, step: 0.05 },
    macroSpreadAmount: { min: 0, max: 1.5, step: 0.05 },
    depthAmount: { min: 0, max: 1, step: 0.05 },
    horizontalRayAmount: { min: 0, max: 1, step: 0.05 },
    bloomThreshold: { min: 0, max: 1, step: 0.01 },
    bloomStrength: { min: 0, max: 3, step: 0.05 },
    bloomRadius: { min: 0, max: 1.5, step: 0.01 },
    exposure: { min: 0.1, max: 3, step: 0.05 },
    thresholdScale: { min: 0.15, max: 1.5, step: 0.05 },
    intensity: { min: 0, max: 5, step: 0.05 },
  },
} as const;

type SpatialParamKey = keyof typeof SPATIAL_STUDY.defaults;

export type SpatialCorePhase = 'attack' | 'hold' | 'decay' | 'done';

/**
 * 3D 空間の Core 1 個。
 * 大きさ・色・速度は発生時に確定して変えない。位置だけが速度ぶん進む。
 */
interface SpatialCore {
  /** 現在位置。速度がゼロなら発生時のまま動かない。 */
  position: { x: number; y: number; z: number };
  /** 発生時の位置。軌跡や検証で「どこから出たか」を見るために残す。 */
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  /** 速度（ワールド単位 / 秒）。発生時に音から決まり、以後変わらない。 */
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
  /** バーストの中での役割。メインは 1 つ、サブは複数。 */
  readonly role: LightRole;
  readonly onsetStrength: number;
  readonly peakIntensity: number;
  /** 基準サイズに対する倍率。発生時に確定してちらつかせない。 */
  readonly size: number;
  /** 代表色（明るさは含まない）。検証・状態表示のための 1 点サンプル。 */
  readonly color: { readonly r: number; readonly g: number; readonly b: number };
  /** 1 要素の内部の分光。実際に描かれる色はこれを補間して作る。 */
  readonly gradient: LightGradient;
  /** 形（種類・伸び・向き・うねり・面の法線）。発生時に確定する。 */
  readonly shape: LightShape;
  /** 大きさの時間変化。平面のフラッシュだけが大きく開く。 */
  readonly expansion: { readonly from: number; readonly to: number };
  currentIntensity: number;
  readonly attackSeconds: number;
  readonly holdSeconds: number;
  readonly decaySeconds: number;
  age: number;
  phase: SpatialCorePhase;
  completed: boolean;
  /**
   * 位置の履歴（新しい順に x,y,z の並び）。固定長のリングではなく、
   * 節の数ぶんだけ確保した配列を先頭から詰め直す（節が少ないので十分速い）。
   */
  readonly history: Float32Array;
  /** 履歴に入っている節の数。 */
  historyCount: number;
  /** 次に履歴へ 1 点足すまでの残り秒。 */
  sampleCountdown: number;
  /** この Core の軌跡の長さ（0..1）。発生時に確定する。 */
  readonly trail: number;
}

/**
 * 生きている Macro layer 1 枚。
 * 見え方は発生時に確定していて、動くのは明るさ（Envelope）だけ。
 */
interface MacroLayer {
  readonly traits: MacroLayerTraits;
  currentIntensity: number;
  age: number;
  completed: boolean;
  /** 発生時からの奥行き方向のドリフト量（ワールド単位）。 */
  driftZ: number;
}

/** 開発・検証用に外へ見せる Core 1 個ぶんの状態。 */
export interface SpatialCoreSnapshot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly speed: number;
  readonly role: LightRole;
  readonly shape: string;
  readonly size: number;
  readonly color: { readonly r: number; readonly g: number; readonly b: number };
  /** 分光の形式と色相の並び（検証用）。 */
  readonly gradient: {
    readonly form: number;
    readonly hues: readonly number[];
    readonly saturations: readonly number[];
  };
  readonly onsetStrength: number;
  readonly peakIntensity: number;
  readonly currentIntensity: number;
  readonly age: number;
  readonly phase: SpatialCorePhase;
}

/** 開発・検証用の表現全体の状態。 */
export interface SpatialStudyState {
  readonly count: number;
  readonly lastBand: BandName | null;
  readonly lastOnsetStrength: number;
  readonly lastPeakIntensity: number;
  readonly lastPosition: { x: number; y: number; z: number } | null;
  readonly lastColor: { r: number; g: number; b: number };
  readonly lastSize: number;
  readonly lastPhase: SpatialCorePhase | null;
  readonly lastEventCores: number;
  /** 直近のバーストが持っていた光の数（メイン + サブ）。 */
  readonly lastBurstLights: number;
  /** この曲で起きたバーストの回数。 */
  readonly burstCount: number;
  /** 生まれるのを待っている光の数。 */
  readonly scheduledLights: number;
  /** いま開いている質感レイヤーの数と、その内訳（検証用）。 */
  readonly macroLayers: readonly {
    readonly tile: number;
    readonly intensity: number;
    readonly age: number;
    readonly halfWidth: number;
    readonly halfHeight: number;
    readonly rotation: number;
    readonly crop: { readonly u: number; readonly v: number; readonly su: number };
    readonly decaySeconds: number;
    readonly warp: number;
    readonly maskAmount: number;
    readonly hues: readonly number[];
  }[];
  /** 素材が読み込めているか（枚数。0 なら Macro layer は出ない）。 */
  readonly prismTiles: number;
  readonly flux: BandFlux;
  readonly bands: Readonly<Record<BandName, BandGateState>>;
  readonly cores: readonly SpatialCoreSnapshot[];
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const clamp01 = (value: number): number => clamp(value, 0, 1);

/** 形の種類 → シェーダーへ渡す番号。分岐の敷居（2.5 / 3.5）と対応している。 */
const SHAPE_KIND_INDEX: Readonly<Record<LightShapeKind, number>> = {
  spark: 0,
  needle: 1,
  arc: 2,
  plane: 3,
  ray: 4,
};

/**
 * 大きさの時間変化。平面のフラッシュは寿命の頭で一気に開き、
 * 終わりに向かって緩む（外へ広がりながら消える）。
 */
const expansionAt = (core: {
  age: number;
  attackSeconds: number;
  holdSeconds: number;
  decaySeconds: number;
  expansion: { from: number; to: number };
}): number => {
  const { from, to } = core.expansion;
  if (from === to) return from;
  const life = Math.max(core.attackSeconds + core.holdSeconds + core.decaySeconds, 1e-4);
  const t = clamp01(core.age / life);
  // 頭が速く、あとは緩やかに広がる。
  return from + (to - from) * (1 - (1 - t) * (1 - t));
};

/**
 * 1 枚あたりの濃度。形と役割だけで決まり、時間では変わらない。
 * ここを通した明るさが加算されるので、**重なった段が層として読める**。
 */
const layerOpacity = (kind: LightShapeKind, role: LightRole): number => {
  const layering = SPATIAL_STUDY.layering;
  const base =
    kind === 'needle'
      ? layering.needle
      : kind === 'arc'
        ? layering.arc
        : kind === 'plane'
          ? layering.plane
          : kind === 'ray'
            ? layering.ray
            : layering.spark;
  return base * (role === 'main' ? layering.mainScale : 1);
};

/**
 * 画面を貫く針が全長へ伸びるまでの割合。
 * **数フレーム以内に伸びきる**必要があるので、寿命全体を使う `expansionAt` とは別に持つ。
 */
const rayGrowth = (age: number): number => {
  const { growSeconds, lengthAtBirth } = SPATIAL_STUDY.ray;
  const t = clamp01(age / Math.max(growSeconds, 1e-4));
  // 頭がいちばん速い。1 フレーム目で既に半分以上まで走る。
  return lengthAtBirth + (1 - lengthAtBirth) * (1 - (1 - t) * (1 - t));
};

/** t = 0 で 1、t = 1 でちょうど 0 になる指数曲線（2D と同じ形）。 */
const decayShape = (t: number): number => {
  const k = SPATIAL_STUDY.decayCurve;
  const floor = Math.exp(-k);
  return (Math.exp(-k * t) - floor) / (1 - floor);
};

export class LightSpatialStudy implements LabExpression {
  readonly animated = true;
  readonly name = 'Light Traces — Spatial Study';
  readonly id: ExpressionId = 'light-spatial-study-v1';

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  private readonly params: Record<SpatialParamKey, number> = { ...SPATIAL_STUDY.defaults };

  private context: CompositionContext | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private scene: THREE.Scene | null = null;
  private geometry: THREE.InstancedBufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  /** 軸平面が使う多角形の帳面。起動時に一度だけ焼く。 */
  private atlas: PolygonAtlas | null = null;
  /**
   * プリズム質感のアトラス（10 枚）。**非同期で届く。**
   * 届くまでは Macro layer が 1 枚も出ないだけで、既存の光はそのまま動く。
   */
  private prism: PrismAtlas | null = null;
  /** 読み込み後に dispose された場合へ備える印。 */
  private disposed = false;
  private macroGeometry: THREE.InstancedBufferGeometry | null = null;
  private macroMaterial: THREE.ShaderMaterial | null = null;
  private macroMesh: THREE.Mesh | null = null;
  /** 描画バッファの高さ（画素）。針の芯を「1〜2px」に保つのに要る。 */
  private viewportHeight = 1;
  /** 上を毎フレーム測り直すための使い回しの入れ物（確保し直さない）。 */
  private readonly bufferSize = new THREE.Vector2();
  private pipeline: EffectPipeline | null = null;
  /**
   * 内部 Bloom。**既存の Effect チェーンより前**に掛かる自前の合成器で、
   * 3D の光を滲ませてから表示用の板へ渡す。外側の Effect は一切変えない。
   */
  private bloomComposer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  /** Bloom の結果を貼るだけの板。この板が Effect チェーンの入口になる。 */
  private displayScene: THREE.Scene | null = null;
  private displayCamera: THREE.OrthographicCamera | null = null;
  private displayGeometry: THREE.PlaneGeometry | null = null;
  private displayMaterial: THREE.ShaderMaterial | null = null;

  /** インスタンス属性。毎フレーム中身だけ書き換え、確保し直さない。 */
  /**
   * Core 本体 + 軌跡の節を 1 本の配列にまとめて持つ。
   * こうしておけば軌跡が増えても**ドローコールは 1 のまま**。
   */
  private static readonly INSTANCE_CAPACITY =
    SPATIAL_STUDY.maximumCores * (1 + SPATIAL_STUDY.trailSegments);
  private readonly offsets = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY * 3);
  private readonly intensities = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY);
  private readonly sizes = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY);
  /**
   * 分光。**RGB ではなく色相と彩度で送る。**
   * 4 ストップぶんを vec4 2 本に収めれば済むので、RGB を 4 本送るより属性が減り、
   * かつフラグメントで色相を直接補間できる（RGB 補間では色相環を通らない）。
   */
  private readonly hues = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY * 4);
  private readonly saturations = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY * 4);
  /** グラデーションの形式（`GRADIENT_FORM`）。 */
  private readonly forms = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY);
  /** 軸平面が使う多角形の番号（アトラスのセル）。他の形では 0。 */
  private readonly patterns = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY);
  /**
   * 軸と直交する方向の太さ（1 が基準）。
   * **板を実際に横へ広げる**ので、長さを縮めるのとは別物。
   */
  private readonly thicknesses = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY);

  /**
   * Macro layer のインスタンス属性。**素材ごとに Material を作らないための束。**
   * 素材番号・UV クロップ・向き・歪み・色・マスクをすべてここで渡す。
   */
  private readonly macroOffsets = new Float32Array(SPATIAL_STUDY.macro.maximumLayers * 3);
  /** 半幅 / 半高 / 素材番号。 */
  private readonly macroSizes = new Float32Array(SPATIAL_STUDY.macro.maximumLayers * 3);
  private readonly macroIntensities = new Float32Array(SPATIAL_STUDY.macro.maximumLayers);
  /** クロップの中心 (u, v) と半径 (su, sv)。 */
  private readonly macroCrops = new Float32Array(SPATIAL_STUDY.macro.maximumLayers * 4);
  /** cos / sin / 左右反転 / 上下反転。 */
  private readonly macroOrients = new Float32Array(SPATIAL_STUDY.macro.maximumLayers * 4);
  /** 歪みの量 / 周波数 / 位相 / グラデーションの形式。 */
  private readonly macroWarps = new Float32Array(SPATIAL_STUDY.macro.maximumLayers * 4);
  /** 多角形マスクの番号 / 効き / 素材の色を残す割合。 */
  private readonly macroStyles = new Float32Array(SPATIAL_STUDY.macro.maximumLayers * 3);
  /**
   * 面の法線（xyz）と面内回転（w）。
   * **ビルボードにしないための向き。** これが無いと板の集合が 1 枚の平面に見える。
   */
  private readonly macroNormals = new Float32Array(SPATIAL_STUDY.macro.maximumLayers * 4);
  private readonly macroHues = new Float32Array(SPATIAL_STUDY.macro.maximumLayers * 4);
  private readonly macroSaturations = new Float32Array(SPATIAL_STUDY.macro.maximumLayers * 4);
  private readonly macroAttributes: Record<string, THREE.InstancedBufferAttribute> = {};
  /** 形: x = 伸び / y = 向き(rad) / z = うねり / w = 種類(0 点 / 1 針 / 2 弧 / 3 平面)。 */
  private readonly shapes = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY * 4);
  /** 平面の法線（ワールド空間）。他の形では使わない。 */
  private readonly normals = new Float32Array(LightSpatialStudy.INSTANCE_CAPACITY * 3);
  private offsetAttribute: THREE.InstancedBufferAttribute | null = null;
  private intensityAttribute: THREE.InstancedBufferAttribute | null = null;
  private sizeAttribute: THREE.InstancedBufferAttribute | null = null;
  private hueAttribute: THREE.InstancedBufferAttribute | null = null;
  private saturationAttribute: THREE.InstancedBufferAttribute | null = null;
  private formAttribute: THREE.InstancedBufferAttribute | null = null;
  private patternAttribute: THREE.InstancedBufferAttribute | null = null;
  private thicknessAttribute: THREE.InstancedBufferAttribute | null = null;
  private shapeAttribute: THREE.InstancedBufferAttribute | null = null;
  private normalAttribute: THREE.InstancedBufferAttribute | null = null;

  /** 音イベントの検出。2D Core Study とまったく同じ検出器を使う。 */
  private readonly detector = new BandLightEventDetector();
  /**
   * 音 → 見え方の対応を決める唯一の層（`spatialMapping.ts`）。
   * 位置・明るさ・大きさ・色・速度・寿命・軌跡はすべてここが決め、
   * この表現は受け取った値をそのまま描くだけにする。
   */
  private readonly mapping = new LightSpatialMapping(
    SPATIAL_STUDY.position,
    SPATIAL_STUDY.maximumCores,
  );
  private readonly cores: SpatialCore[] = [];
  /** 生きている質感レイヤー。Transient とは別の時間軸で動く。 */
  private readonly macros: MacroLayer[] = [];
  /** 遅れて生まれる予定の光（バーストの連鎖）。 */
  private readonly scheduled: { at: number; traits: LightVisualTraits }[] = [];
  /** 遅れて開く予定の質感レイヤー。 */
  private readonly scheduledMacros: { at: number; traits: MacroLayerTraits }[] = [];
  /**
   * 発光の瞬間の sustain。検出のために音を読むついでに拾っておき、
   * 対応づけ層へ渡す（`AudioEventSnapshot` は 2D と共有なので触らない）。
   */
  private lastSustain = 0;
  /** 直近のバーストが持っていた光の数（メイン + サブ）。 */
  private lastBurstLights = 0;
  /** この曲で起きたバーストの回数（単調増加。無音でリセット）。 */
  private burstCount = 0;

  private previousElapsed = -1;
  private lastBand: BandName | null = null;
  private lastOnsetStrength = 0;
  private lastPeakIntensity = 0;
  private lastPosition: { x: number; y: number; z: number } | null = null;
  private lastColor: { r: number; g: number; b: number } = { r: 1, g: 1, b: 1 };
  private lastSize = 1;
  private lastEventCores = 0;
  private adaptiveThreshold = true;
  private adaptiveStrength = true;
  /**
   * 配置の流儀。既定は `center`（原点付近へ集めて光の層を重ねる）。
   * `scatter` にすると従来の決定論配置に戻り、見比べられる。
   */
  private placementMode: 'center' | 'scatter' = 'center';

  constructor(effects: Effect[] = [], theme?: Theme) {
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
  }

  // ---------------------------------------------------------------- setup

  setup(context: CompositionContext): void {
    this.context = context;
    // 同じインスタンスが setup をやり直すことがある（App.setComposition / 表現の再適用）。
    // dispose の印を残したままだと、素材の読み込みが「もう捨てられた」と判断して
    // アトラスを結び直さず、Macro layer が黙って真っ黒になる。
    this.disposed = false;
    // 多角形の帳面は起動時に一度だけ焼く（決定論。毎フレームの費用はゼロ）。
    this.atlas = createPolygonAtlas(SPATIAL_STUDY.planeAtlas);
    this.camera = new THREE.PerspectiveCamera(
      SPATIAL_STUDY.fieldOfView,
      this.aspectRatio,
      SPATIAL_STUDY.nearPlane,
      SPATIAL_STUDY.farPlane,
    );
    // 固定カメラ。原点から −Z を見るだけで、以降まったく動かさない。
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(0, 0, -1);

    // 1 枚の板を InstancedBufferGeometry にして、1 ドローで全 Core を描く。
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = plane.index;
    this.geometry.setAttribute('position', plane.getAttribute('position'));
    this.geometry.setAttribute('uv', plane.getAttribute('uv'));
    plane.dispose();

    this.offsetAttribute = new THREE.InstancedBufferAttribute(this.offsets, 3);
    this.offsetAttribute.setUsage(THREE.DynamicDrawUsage);
    this.intensityAttribute = new THREE.InstancedBufferAttribute(this.intensities, 1);
    this.intensityAttribute.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttribute = new THREE.InstancedBufferAttribute(this.sizes, 1);
    this.sizeAttribute.setUsage(THREE.DynamicDrawUsage);
    this.hueAttribute = new THREE.InstancedBufferAttribute(this.hues, 4);
    this.hueAttribute.setUsage(THREE.DynamicDrawUsage);
    this.saturationAttribute = new THREE.InstancedBufferAttribute(this.saturations, 4);
    this.saturationAttribute.setUsage(THREE.DynamicDrawUsage);
    this.formAttribute = new THREE.InstancedBufferAttribute(this.forms, 1);
    this.formAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aOffset', this.offsetAttribute);
    this.geometry.setAttribute('aIntensity', this.intensityAttribute);
    this.shapeAttribute = new THREE.InstancedBufferAttribute(this.shapes, 4);
    this.shapeAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aSize', this.sizeAttribute);
    this.geometry.setAttribute('aHues', this.hueAttribute);
    this.geometry.setAttribute('aSaturations', this.saturationAttribute);
    this.geometry.setAttribute('aForm', this.formAttribute);
    this.patternAttribute = new THREE.InstancedBufferAttribute(this.patterns, 1);
    this.patternAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aPattern', this.patternAttribute);
    this.thicknessAttribute = new THREE.InstancedBufferAttribute(this.thicknesses, 1);
    this.thicknessAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aThickness', this.thicknessAttribute);
    this.normalAttribute = new THREE.InstancedBufferAttribute(this.normals, 3);
    this.normalAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aShape', this.shapeAttribute);
    this.geometry.setAttribute('aNormal', this.normalAttribute);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: SPATIAL_STUDY.coreWorldSize },
        uFalloff: { value: SPATIAL_STUDY.coreFalloff },
        uCoreSharpness: { value: SPATIAL_STUDY.optics.coreSharpness },
        uHalo: { value: new THREE.Vector2(SPATIAL_STUDY.optics.haloRadius, SPATIAL_STUDY.optics.haloStrength) },
        uScatter: { value: new THREE.Vector2(SPATIAL_STUDY.optics.scatterRadius, SPATIAL_STUDY.optics.scatterStrength) },
        uChromatic: { value: SPATIAL_STUDY.optics.chromaticSeparation },
        uGradientReach: { value: SPATIAL_STUDY.optics.gradientReach },
        // 多角形の帳面と、その並び（列・行）。
        uAtlas: { value: this.atlas.texture },
        uAtlasGrid: { value: new THREE.Vector2(this.atlas.columns, this.atlas.rows) },
        uPlaneEdge: {
          value: new THREE.Vector4(
            SPATIAL_STUDY.planeEdge.sharpness,
            SPATIAL_STUDY.planeEdge.bleedWidth,
            SPATIAL_STUDY.planeEdge.bleedStrength,
            SPATIAL_STUDY.planeEdge.interiorSoftness,
          ),
        },
        uPlaneEdgeLevel: { value: SPATIAL_STUDY.planeEdge.edgeLevel },
        uPlateScale: { value: SPATIAL_STUDY.planeEdge.plateScale },
        // 画面の見え方（tan(画角/2) / Aspect / 描画高さ[px]）。針の長さと太さに使う。
        uView: { value: new THREE.Vector3(1, 1, 1) },
        // 針の芯[px] / 板の倍率 / 長さ（画面対角比）/ グローの強さ。
        uRay: {
          value: new THREE.Vector4(
            SPATIAL_STUDY.ray.corePixels,
            SPATIAL_STUDY.ray.glowSpan,
            SPATIAL_STUDY.ray.reachScale,
            SPATIAL_STUDY.ray.glowStrength,
          ),
        },
        uRayTaper: { value: SPATIAL_STUDY.ray.tipTaper },
        // 光源そのものの強さ。滲み（Bloom）や露出とは別の役割。
        uIntensity: { value: SPATIAL_STUDY.defaults.intensity },
        // 板を張る倍率。散乱がいちばん外まで届くので、その半径 × 余裕で決める。
        uSpan: {
          value: Math.max(
            SPATIAL_STUDY.optics.scatterRadius * SPATIAL_STUDY.optics.scatterSpanMargin,
            1,
          ),
        },
        uContrast: {
          value: new THREE.Vector3(
            SPATIAL_STUDY.optics.distanceContrast,
            SPATIAL_STUDY.optics.contrastNearDepth,
            SPATIAL_STUDY.optics.contrastFarDepth,
          ),
        },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      // 加算合成なので前後の描画順に依存しない。深度は書かず、テストもしない。
      depthWrite: false,
      depthTest: false,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute float aIntensity;
        attribute float aSize;
        attribute vec4 aHues;
        attribute vec4 aSaturations;
        attribute float aForm;
        attribute float aPattern;
        attribute float aThickness;
        attribute vec4 aShape;
        attribute vec3 aNormal;
        uniform float uSize;
        uniform float uSpan;
        uniform vec3 uContrast;
        uniform vec3 uView;
        uniform vec4 uRay;
        uniform float uPlateScale;
        varying vec2 vLocal;
        varying float vIntensity;
        varying vec4 vHues;
        varying vec4 vSaturations;
        varying float vForm;
        varying float vPattern;
        varying float vDistanceFade;
        varying vec3 vShape;
        varying float vThickness;

        void main() {
          // 板は「核 + 滲み + 散乱」を全部含む大きさで張る。
          // vLocal は核の半径を 1 とした座標なので、散乱の広がりぶん外側まで伸びる。
          // 光条は軸方向にだけ引き伸ばすので、その伸びぶんも板に含める。
          float elongation = max(aShape.x, 1.0);
          float thickness = max(aThickness, 0.05);
          // **軸と直交する方向へ実際に広げる。** 長さを縮めるのではなく幅が増えるので、
          // 低音・低い centroid では太い光条、高い centroid では細い回折線になる。
          vec2 stretched = position.xy * vec2(elongation, thickness);
          vLocal = stretched * 2.0 * uSpan;
          vIntensity = aIntensity;
          vHues = aHues;
          vSaturations = aSaturations;
          vForm = aForm;
          vPattern = aPattern;
          vShape = vec3(elongation, aShape.z, aShape.w);
          vThickness = thickness;
          // ビュー空間で板を広げるので、板は常にカメラを向く（ビルボード）。
          // 大きさはワールド単位のまま置くだけで、遠近は投影行列が付ける。
          // 軸方向へ伸ばしてから、向きのぶんだけ回す。
          // うねりは「まっすぐな光条は不自然」ぶんの微小な曲がりで、
          // 波形をそのまま形にしているわけではない。
          float sway = sin(stretched.x * 2.6) * aShape.z * 0.16;
          vec2 shaped = vec2(stretched.x, stretched.y + sway);
          float ca = cos(aShape.y);
          float sa = sin(aShape.y);
          vec2 rotated = vec2(shaped.x * ca - shaped.y * sa, shaped.x * sa + shaped.y * ca);

          vec4 viewPosition;
          if (aShape.w > 3.5) {
            // 画面を貫く針: **板の長さを画面の対角より長く取る**。
            // その奥行きで画面に収まる範囲を画角から逆算するので、
            // どの Aspect でも・どの奥行きでも必ず画面外まで届く。
            viewPosition = modelViewMatrix * vec4(aOffset, 1.0);
            float depth = max(-viewPosition.z, 0.001);
            float halfHeight = uView.x * depth;
            float halfWidth = halfHeight * uView.y;
            // aSize には伸びの割合（0..1）が入っている。
            float reach = length(vec2(halfWidth, halfHeight)) * uRay.z * aSize;
            // 芯の太さは画素で決める。ワールド単位だと奥行きで太さが変わってしまう。
            float pixel = 2.0 * halfHeight / max(uView.z, 1.0);
            // 芯の画素幅も太さに連動する（Bass 寄り = 淡く太い / Treble = 細く鋭い）。
            float halfThickness = uRay.x * thickness * pixel * uRay.y;
            vec2 local = vec2(position.x * 2.0 * reach, position.y * 2.0 * halfThickness);
            float rc = cos(aShape.y);
            float rs = sin(aShape.y);
            viewPosition.xy += vec2(local.x * rc - local.y * rs, local.x * rs + local.y * rc);
            // 芯を 1 とした横断座標と、−1..1 の長手座標。
            vLocal = vec2(position.x * 2.0, position.y * 2.0 * uRay.y);
          } else if (aShape.w > 2.5) {
            // 平面のフラッシュ: ビルボードではなく**ワールド空間で寝かせた面**。
            // 法線から接線・従法線を組み、面に沿って広げる。
            vec3 n = normalize(aNormal);
            vec3 helper = abs(n.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
            vec3 tangent = normalize(cross(helper, n));
            vec3 bitangent = cross(n, tangent);
            vec3 world =
              aOffset + (tangent * shaped.x + bitangent * shaped.y) * uSize * aSize * uSpan * uPlateScale;
            viewPosition = modelViewMatrix * vec4(world, 1.0);
          } else {
            viewPosition = modelViewMatrix * vec4(aOffset, 1.0);
            viewPosition.xy += rotated * uSize * aSize * uSpan;
          }
          // 奥ほどわずかに沈ませる（距離のコントラスト差）。強くはしない。
          float depth = -viewPosition.z;
          float t = clamp((depth - uContrast.y) / max(uContrast.z - uContrast.y, 0.001), 0.0, 1.0);
          vDistanceFade = 1.0 - uContrast.x * t;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uFalloff;
        uniform float uSpan;
        uniform float uCoreSharpness;
        uniform vec2 uHalo;
        uniform vec2 uScatter;
        uniform float uChromatic;
        uniform float uIntensity;
        uniform float uGradientReach;
        uniform sampler2D uAtlas;
        uniform vec2 uAtlasGrid;
        uniform vec4 uPlaneEdge;
        uniform float uPlaneEdgeLevel;
        uniform vec4 uRay;
        uniform float uRayTaper;
        varying vec2 vLocal;
        varying float vIntensity;
        varying vec4 vHues;
        varying vec4 vSaturations;
        varying float vForm;
        varying float vPattern;
        varying float vDistanceFade;
        varying vec3 vShape;
        varying float vThickness;

        // 半径 r のガウス。radius を変えるだけで核・滲み・散乱を作り分ける。
        float glow(float d2, float radius) {
          return exp(-d2 / max(radius * radius, 0.0001));
        }

        // 色相（0..1 へ折り返す）と彩度から RGB。CPU 側の hueToRgb と同じ式。
        vec3 spectralRgb(float hue, float saturation) {
          vec3 p = fract(vec3(hue) + vec3(0.0, 0.6666667, 0.3333333)) * 6.0;
          vec3 v = clamp(min(p, 4.0 - p), 0.0, 1.0);
          return 1.0 - clamp(saturation, 0.0, 1.0) * (1.0 - v);
        }

        /**
         * 4 ストップの折れ線を t で読む。
         * GLSL ES 1.0 では vec4 を変数で添字できないので、
         * 区間ごとの割合を clamp して mix を重ねる形にしてある。
         */
        float ramp4(vec4 stops, float t) {
          float u = clamp(t, 0.0, 1.0) * 3.0;
          float f0 = clamp(u, 0.0, 1.0);
          float f1 = clamp(u - 1.0, 0.0, 1.0);
          float f2 = clamp(u - 2.0, 0.0, 1.0);
          return mix(mix(mix(stops.x, stops.y, f0), stops.z, f1), stops.w, f2);
        }

        /**
         * **1 要素の内部で色相が動く位置（0..1）。** 形式は seed が選ぶ。
         * axis は軸方向の伸びを戻した等方座標、radius は板の中心からの正規化距離。
         */
        float gradientPosition(vec2 axis, float reach) {
          float radius = clamp(length(axis) / max(reach, 0.0001), 0.0, 1.0);
          if (vForm < 0.5) return radius;                       // 放射状
          if (vForm < 1.5) return 1.0 - radius;                 // 放射状（反転）
          if (vForm < 2.5) return 0.5 + axis.x / (2.0 * reach); // 軸方向
          if (vForm < 3.5) return 0.5 + axis.y / (2.0 * reach); // 軸直交
          return atan(axis.y, axis.x) * 0.1591549 + 0.5;        // 角度方向
        }

        void main() {
          // 光条は軸方向に伸びた座標で来るので、軸方向を縮めて等方に戻してから測る。
          // こうすると同じガウスのまま「細長い光」になる。
          float elongation = max(vShape.x, 1.0);
          // うねりを距離にも効かせる。芯がわずかに蛇行して見える。
          float bend = sin(vLocal.x * 1.7) * vShape.y * 0.22;
          // 伸びと太さを戻して等方に測る。太いほどガウスが横へ広がる。
          vec2 axis = vec2(vLocal.x / elongation, (vLocal.y + bend) / max(vThickness, 0.05));
          float d2 = dot(axis, axis);

          // 画面を貫く針。芯は画素で太さが決まっているので、ここでは
          // 横断方向の落ちと、端のごく弱い落ちだけを作る。
          if (vShape.z > 3.5) {
            float across = vLocal.y;
            // 芯。|across| = 1 が指定した芯の半幅。
            float spine = exp(-across * across * 2.2);
            // 淡いグロー。芯の外へ薄く広がる。
            float bloom = exp(-across * across / max(uRay.y * uRay.y * 0.09, 0.0001)) * uRay.w;
            // 端で 0 になる窓。画面外まで届いた先で切れても継ぎ目が見えない。
            float along = clamp(1.0 - abs(vLocal.x), 0.0, 1.0);
            float taper = pow(along, uRayTaper);
            float rt = gradientPosition(vec2(vLocal.x * uGradientReach, across), uGradientReach);
            vec3 rayTint = spectralRgb(ramp4(vHues, rt), ramp4(vSaturations, rt));
            vec3 rayColor =
              rayTint * (spine + bloom) * taper * max(vIntensity, 0.0) * vDistanceFade * uIntensity;
            gl_FragColor = vec4(max(rayColor, 0.0), 1.0);
            return;
          }

          // 軸平面のフラッシュ。**丸が広がるのではなく、不均一な多角形が開く。**
          // 帳面（アトラス）は符号つき距離場なので、0.5 のすぐ両側で切り替えれば
          // 16 倍まで開いても輪郭が鋭いまま保たれる。
          if (vShape.z > 2.5) {
            vec2 cell = clamp(vLocal / (2.0 * uSpan) + 0.5, 0.0, 1.0);
            // セルの縁 1 テクセルぶんを避けて、隣の図形が滲み込まないようにする。
            vec2 inset = mix(vec2(0.004), vec2(0.996), cell);
            float column = mod(vPattern, uAtlasGrid.x);
            float row = floor(vPattern / uAtlasGrid.x);
            vec2 uv = (vec2(column, row) + inset) / uAtlasGrid;
            float sdf = texture2D(uAtlas, uv).r;
            // 鋭い輪郭と、その外側へ出るわずかなにじみ。
            float body = smoothstep(0.5 - uPlaneEdge.x, 0.5 + uPlaneEdge.x, sdf);
            float bleed = smoothstep(0.5 - uPlaneEdge.y, 0.5, sdf) * uPlaneEdge.z;
            float mask = body + max(bleed - body * uPlaneEdge.z, 0.0);
            // 内側のごく弱い陰り。縁が少し暗く、奥がわずかに明るい。
            float inner = clamp((sdf - 0.5) / max(uPlaneEdge.w, 0.0001), 0.0, 1.0);
            float fill = mix(uPlaneEdgeLevel, 1.0, inner);
            // 平面は板いっぱいまで見えるので、分光の物差しも板の半径そのもの。
            float st = gradientPosition(vLocal, uSpan);
            vec3 tint = spectralRgb(ramp4(vHues, st), ramp4(vSaturations, st));
            // flat は GLSL ES 3.00 の予約語なので変数名には使えない。
            vec3 sheetColor = tint * mask * fill * max(vIntensity, 0.0) * vDistanceFade * uIntensity;
            gl_FragColor = vec4(max(sheetColor, 0.0), 1.0);
            return;
          }

          // **1 要素の内部の分光。** 位置ごとに色相が動くので、
          // 「白 → 一色」ではなくプリズムを通った光のように色が連続して変わる。
          // 物差しは板の半径ではなく**目に見える明るさが届く範囲**。
          // 板は散乱ぶんまで大きく張ってあるので、板いっぱいで測ると
          // 色相の変化が全部「暗くて見えない外側」に入ってしまう。
          float t = gradientPosition(axis, uGradientReach);
          vec3 tint = spectralRgb(ramp4(vHues, t), ramp4(vSaturations, t));

          // ① 明るい中心核。締まった芯。
          float core = glow(d2 * uCoreSharpness, 1.0 / max(uFalloff, 0.0001));
          // ② 中距離の滲み。核の周りにだけ出る（画面全体には広げない）。
          float halo = glow(d2, uHalo.x) * uHalo.y;
          // ③ 広く弱い散乱光。**光がある場所でだけ**見えるので、
          //    白いオーバーレイのように画面へかぶせることはない。
          float scatter = glow(d2, uScatter.x) * uScatter.y;

          // ④ RGB の微小な空間分離。色ごとに滲みの半径をわずかにずらす。
          vec3 spread = vec3(1.0 + uChromatic, 1.0, 1.0 - uChromatic);
          vec3 chroma = vec3(
            glow(d2, uHalo.x * spread.r),
            glow(d2, uHalo.x * spread.g),
            glow(d2, uHalo.x * spread.b)
          ) * uHalo.y * uChromatic;

          // 明るさ（vIntensity）と色の比率（tint）は最後まで別々に持つ。
          // 音量が大きいだけで色が白へ飽和しないようにするための分離。
          vec3 level = tint * (core + halo + scatter) + chroma * tint;
          // 露出は最後の表示パスで 1 回だけ掛ける。ここでは光源の強さだけ。
          level *= max(vIntensity, 0.0) * vDistanceFade * uIntensity;
          // 板の縁で必ず 0 にする窓。これがないと散乱が四角く切れて継ぎ目が見える。
          vec2 window = vec2(vLocal.x / elongation, vLocal.y / max(vThickness, 0.05)) / uSpan;
          float edge = clamp(1.0 - dot(window, window), 0.0, 1.0);
          gl_FragColor = vec4(max(level * edge * edge, 0.0), 1.0);
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // 板はシェーダーで広げるので、three の境界球では正しく判定できない。
    this.mesh.frustumCulled = false;

    this.scene = new THREE.Scene();
    // 無音は黒（PRD D5）。背景を明示しておかないと透明のまま抜ける。
    this.scene.background = new THREE.Color(0x000000);
    // 質感レイヤーは Transient の後ろ。加算なので順序は見た目に影響しないが、
    // **同じ Scene に置く**ことで内部 Bloom が両方を拾う（Bloom は増設しない）。
    this.createMacroMesh();
    if (this.macroMesh) this.scene.add(this.macroMesh);
    this.scene.add(this.mesh);

    // プリズム素材は非同期。届いたら対応づけ層へ渡し、そこから選ばれるようになる。
    void loadPrismAtlas(SPATIAL_STUDY.macro.atlas).then((prism) => {
      if (!prism) return;
      if (this.disposed) {
        prism.texture.dispose();
        return;
      }
      this.prism = prism;
      if (this.macroMaterial) {
        this.macroMaterial.uniforms.uAtlas!.value = prism.texture;
        this.macroMaterial.uniforms.uAtlasGrid!.value = new THREE.Vector2(
          prism.columns,
          prism.rows,
        );
      }
      this.mapping.setTextures(prism.tiles);
    });

    // ---- 内部 Bloom（参照デモの UnrealBloomPass と同じ構成）----
    const size = new THREE.Vector2();
    context.renderer.getSize(size);
    this.bloomComposer = new EffectComposer(context.renderer);
    // 画面には出さない。結果は readBuffer に残し、表示用の板が読み取る。
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(size.x, 1), Math.max(size.y, 1)),
      SPATIAL_STUDY.optics.bloomStrength,
      SPATIAL_STUDY.optics.bloomRadius,
      SPATIAL_STUDY.optics.bloomThreshold,
    );
    this.bloomComposer.addPass(this.bloomPass);

    // ---- 表示用の板（露出とトーンマップだけを掛ける）----
    this.displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.displayCamera.position.z = 1;
    this.displayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: SPATIAL_STUDY.optics.exposure },
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform float uExposure;
        varying vec2 vUv;

        void main() {
          vec3 color = texture2D(tDiffuse, vUv).rgb;
          // 露出つきの指数トーンマップ。x = 0 なら必ず 0 なので、
          // 無音の黒が浮くことはない（PRD D5）。
          vec3 mapped = vec3(1.0) - exp(-max(color, 0.0) * uExposure);
          gl_FragColor = vec4(mapped, 1.0);
        }
      `,
    });
    this.displayGeometry = new THREE.PlaneGeometry(2, 2);
    this.displayScene = new THREE.Scene();
    this.displayScene.background = new THREE.Color(0x000000);
    this.displayScene.add(new THREE.Mesh(this.displayGeometry, this.displayMaterial));

    // Effect チェーンは「Bloom 済みの板」を入口にする。外側の構成は変えない。
    this.pipeline = new EffectPipeline(
      context.renderer,
      this.displayScene,
      this.displayCamera,
      this.effects,
    );
  }

  /**
   * **プリズム質感レイヤーの描画体（1 ドロー）。**
   *
   * 10 枚ぶんの Material は作らない。素材番号も UV も色もインスタンス属性で渡し、
   * アトラスから 1 マスを読むだけにする。素材は「完成した絵」ではなく
   * **輝度マスク**として扱い、色は音から作る。
   */
  private createMacroMesh(): void {
    if (!this.atlas) return;
    const plane = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = plane.index;
    geometry.setAttribute('position', plane.getAttribute('position'));
    geometry.setAttribute('uv', plane.getAttribute('uv'));
    plane.dispose();

    const add = (name: string, data: Float32Array, size: number): void => {
      const attribute = new THREE.InstancedBufferAttribute(data, size);
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
      this.macroAttributes[name] = attribute;
    };
    add('aOffset', this.macroOffsets, 3);
    add('aSize', this.macroSizes, 3);
    add('aIntensity', this.macroIntensities, 1);
    add('aCrop', this.macroCrops, 4);
    add('aOrient', this.macroOrients, 4);
    add('aWarp', this.macroWarps, 4);
    add('aStyle', this.macroStyles, 3);
    add('aNormal', this.macroNormals, 4);
    add('aHues', this.macroHues, 4);
    add('aSaturations', this.macroSaturations, 4);
    geometry.instanceCount = 0;

    // アトラスが届くまでの仮の 1×1 黒。無音＝黒を素材の到着に依らず守る。
    const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    placeholder.needsUpdate = true;

    const macro = SPATIAL_STUDY.macro;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: placeholder },
        uAtlasGrid: { value: new THREE.Vector2(1, 1) },
        uMaskAtlas: { value: this.atlas.texture },
        uMaskGrid: { value: new THREE.Vector2(this.atlas.columns, this.atlas.rows) },
        // 円窓の始まり / 黒浮きの敷居 / 同・幅 / 輝度の締め。
        uMacro: {
          value: new THREE.Vector4(
            macro.edgeFadeStart,
            macro.blackFloor,
            macro.blackFloorWidth,
            macro.luminanceGamma,
          ),
        },
        // 多角形マスクの柔らかさ / マスの内側へ寄せる余白。
        uMacroEdge: { value: new THREE.Vector2(macro.maskSoftness, macro.cellInset) },
        uIntensity: { value: SPATIAL_STUDY.defaults.intensity },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec3 aSize;
        attribute float aIntensity;
        attribute vec4 aCrop;
        attribute vec4 aOrient;
        attribute vec4 aWarp;
        attribute vec3 aStyle;
        attribute vec4 aNormal;
        attribute vec4 aHues;
        attribute vec4 aSaturations;
        varying vec2 vLocal;
        varying float vIntensity;
        varying float vTile;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying vec4 vWarp;
        varying vec3 vStyle;
        varying vec4 vHues;
        varying vec4 vSaturations;

        void main() {
          // 板の中を −1..1 で持つ。円窓も UV も全部この座標で作る。
          vLocal = position.xy * 2.0;
          vIntensity = aIntensity;
          vTile = aSize.z;
          vCrop = aCrop;
          vOrient = aOrient;
          vWarp = aWarp;
          vStyle = aStyle;
          vHues = aHues;
          vSaturations = aSaturations;
          // **ビルボードにしない。** 法線から接線・従法線を組み、ワールド空間で
          // 傾いた平面として広げる。カメラ正面固定だと、板を何枚重ねても
          // 集合が 1 枚の平面にしか見えず奥行きが出ない。
          vec3 n = normalize(aNormal.xyz);
          vec3 helper = abs(n.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
          vec3 tangent = normalize(cross(helper, n));
          vec3 bitangent = cross(n, tangent);
          // 面内回転。素材の役割で寄せる向きが違う（縦膜は縦のまま等）。
          float cs = cos(aNormal.w);
          float sn = sin(aNormal.w);
          vec3 axisU = tangent * cs + bitangent * sn;
          vec3 axisV = bitangent * cs - tangent * sn;
          // 大きさはワールド単位のまま。遠近は投影行列だけが付ける。
          vec3 world = aOffset + axisU * (vLocal.x * aSize.x) + axisV * (vLocal.y * aSize.y);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec2 uAtlasGrid;
        uniform sampler2D uMaskAtlas;
        uniform vec2 uMaskGrid;
        uniform vec4 uMacro;
        uniform vec2 uMacroEdge;
        uniform float uIntensity;
        varying vec2 vLocal;
        varying float vIntensity;
        varying float vTile;
        varying vec4 vCrop;
        varying vec4 vOrient;
        varying vec4 vWarp;
        varying vec3 vStyle;
        varying vec4 vHues;
        varying vec4 vSaturations;

        vec3 spectralRgb(float hue, float saturation) {
          vec3 p = fract(vec3(hue) + vec3(0.0, 0.6666667, 0.3333333)) * 6.0;
          vec3 v = clamp(min(p, 4.0 - p), 0.0, 1.0);
          return 1.0 - clamp(saturation, 0.0, 1.0) * (1.0 - v);
        }

        float ramp4(vec4 stops, float t) {
          float u = clamp(t, 0.0, 1.0) * 3.0;
          float f0 = clamp(u, 0.0, 1.0);
          float f1 = clamp(u - 1.0, 0.0, 1.0);
          float f2 = clamp(u - 2.0, 0.0, 1.0);
          return mix(mix(mix(stops.x, stops.y, f0), stops.z, f1), stops.w, f2);
        }

        /** 分光の位置。Transient と同じ 5 形式を使う。 */
        float gradientPosition(vec2 p, float form) {
          float radius = clamp(length(p), 0.0, 1.0);
          if (form < 0.5) return radius;
          if (form < 1.5) return 1.0 - radius;
          if (form < 2.5) return 0.5 + p.x * 0.5;
          if (form < 3.5) return 0.5 + p.y * 0.5;
          return atan(p.y, p.x) * 0.1591549 + 0.5;
        }

        void main() {
          vec2 p = vLocal;
          // ① 円窓。**板の四角い輪郭を絶対に見せない**ための一段目。
          float window = 1.0 - smoothstep(uMacro.x, 1.0, length(p));
          if (window <= 0.0) discard;

          // ② 回転・反転・歪みを掛けた UV。歪みの位相は発生時に固定してあるので、
          //    発光中に形がちらつくことはない。
          vec2 q = vec2(p.x * vOrient.x - p.y * vOrient.y, p.x * vOrient.y + p.y * vOrient.x);
          q *= vec2(vOrient.z, vOrient.w);
          q += vec2(
            sin(q.y * vWarp.y + vWarp.z),
            cos(q.x * vWarp.y * 0.87 + vWarp.z * 1.31)
          ) * vWarp.x;

          // ③ クロップ。素材のどこを切り出すかが毎回変わるので、同じ素材でも別の絵になる。
          vec2 cell = clamp(vCrop.xy + q * vCrop.zw, uMacroEdge.y, 1.0 - uMacroEdge.y);
          float column = mod(vTile, uAtlasGrid.x);
          float row = floor(vTile / uAtlasGrid.x);
          vec2 atlasUv = (vec2(column, row) + cell) / uAtlasGrid;
          vec3 source = texture2D(uAtlas, atlasUv).rgb;

          // ④ 輝度マスク。素材は絵ではなく濃淡として読む。
          float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
          // 黒浮きを加算の前に落とす。これが無いと Haze で画面全体が灰色になる。
          luminance *= smoothstep(uMacro.y, uMacro.y + uMacro.z, luminance);
          luminance = pow(max(luminance, 0.0), uMacro.w);

          // ⑤ 音から作った色。素材そのものの色みは割合で混ぜるだけ。
          float t = gradientPosition(p, vWarp.w);
          vec3 tint = spectralRgb(ramp4(vHues, t), ramp4(vSaturations, t));
          vec3 sourceHue = source / max(max(source.r, max(source.g, source.b)), 1e-4);
          vec3 tone = mix(tint, sourceHue, clamp(vStyle.z, 0.0, 1.0));

          // ⑥ 多角形マスク。**硬い面としては見せず**、膜の外形を不揃いにするだけ。
          vec2 maskCell = clamp(p * 0.5 + 0.5, 0.0, 1.0);
          vec2 maskInset = mix(vec2(0.004), vec2(0.996), maskCell);
          float maskColumn = mod(vStyle.x, uMaskGrid.x);
          float maskRow = floor(vStyle.x / uMaskGrid.x);
          vec2 maskUv = (vec2(maskColumn, maskRow) + maskInset) / uMaskGrid;
          float sdf = texture2D(uMaskAtlas, maskUv).r;
          float polygon = smoothstep(0.5 - uMacroEdge.x, 0.5 + uMacroEdge.x, sdf);
          float silhouette = mix(1.0, polygon, clamp(vStyle.y, 0.0, 1.0));

          vec3 color = tone * luminance * window * silhouette * max(vIntensity, 0.0) * uIntensity;
          gl_FragColor = vec4(max(color, 0.0), 1.0);
        }
      `,
    });

    this.macroGeometry = geometry;
    this.macroMaterial = material;
    this.macroMesh = new THREE.Mesh(geometry, material);
    // 板はシェーダーで広げるので、three の境界球では判定できない。
    this.macroMesh.frustumCulled = false;
    // 加算なので順序は絵に影響しないが、Transient より先に描いておく。
    this.macroMesh.renderOrder = -1;
  }

  /** 開発スライダーの値を内部 Bloom と露出へ流す。毎フレーム呼んで即座に効かせる。 */
  private syncOptics(): void {
    if (this.material && this.camera) {
      // 針の長さと太さは画角・Aspect・描画高さから逆算する。
      // **毎フレーム測り直す。** 描画高さを持ち回すと、リサイズと update の順番次第で
      // 古い値のまま描いてしまい、針が桁違いに太くなる（4px のときに実際に踏んだ）。
      if (this.context) {
        this.viewportHeight = Math.max(
          this.context.renderer.getDrawingBufferSize(this.bufferSize).y,
          1,
        );
      }
      const view = this.material.uniforms.uView!.value as THREE.Vector3;
      view.set(
        Math.tan((SPATIAL_STUDY.fieldOfView * Math.PI) / 360),
        Math.max(this.camera.aspect, 1e-6),
        this.viewportHeight,
      );
    }
    if (this.bloomPass) {
      // 将来ここへ音を差し込む（`bloomDrive` の戻り値を掛ける）。
      const drive = bloomDrive();
      this.bloomPass.threshold = this.params.bloomThreshold + drive.thresholdOffset;
      this.bloomPass.strength = this.params.bloomStrength * drive.strengthScale;
      this.bloomPass.radius = this.params.bloomRadius;
    }
    if (this.displayMaterial) {
      this.displayMaterial.uniforms.uExposure!.value = this.params.exposure;
    }
    if (this.macroMaterial) {
      this.macroMaterial.uniforms.uIntensity!.value = this.params.intensity;
    }
  }

  // ---------------------------------------------------------------- 可視範囲

  /**
   * カメラからの距離 `depth` において画面に収まる範囲（半分の幅と高さ）。
   * 画角と Aspect から逆算するので、どの画角・どのウィンドウ幅でも
   * 「画面外へ出さない」条件を自動的に満たせる。
   */
  private visibleHalfExtent(depth: number): { halfWidth: number; halfHeight: number } {
    const halfHeight = Math.tan((SPATIAL_STUDY.fieldOfView * Math.PI) / 360) * depth;
    return { halfHeight, halfWidth: halfHeight * Math.max(this.aspectRatio, 1e-6) };
  }

  // ---------------------------------------------------------------- 検出

  private detectEvents(elapsed: number, delta: number): void {
    const audio = this.context?.audioEngine.getParameters() ?? {};
    const spectrum = this.context?.audioEngine.getSpectrum?.() ?? null;
    // 発光の瞬間の余韻。対応づけ層へ渡すだけで、ここでは見え方を決めない。
    this.lastSustain = clamp01(audio.sustain ?? 0);
    const events = this.detector.update(
      spectrum,
      {
        volume: clamp01(audio.volume ?? 0),
        bass: clamp01(audio.bass ?? 0),
        mid: clamp01(audio.mid ?? 0),
        treble: clamp01(audio.treble ?? 0),
        // centroid は engine が対数で 0..1 に正規化済み。Hz の生値は使わない。
        spectralCentroid: clamp01(audio.centroid ?? 0),
        spectralFlatness: clamp01(audio.flatness ?? 0),
        audioSeed: clamp01(audio.seed ?? 0),
      },
      elapsed,
      delta,
      {
        fluxGain: this.params.fluxGain,
        onsetSensitivity: this.params.onsetSensitivity,
        cooldownSeconds: this.params.cooldownMs / 1000,
        relativeStrengthFloor: this.params.relativeStrengthFloor,
        adaptiveThreshold: this.adaptiveThreshold,
        adaptiveStrength: this.adaptiveStrength,
        thresholdScale: this.params.thresholdScale,
      },
    );
    if (events.length === 0) return;
    this.lastEventCores = events.length;
    for (const event of events) this.scheduleBurst(event, elapsed);
  }

  /**
   * イベント 1 個から**バースト**を予約する。
   *
   * メインはその場で生まれ、サブは 5〜150ms 遅れて連鎖する。
   * 遅れも位置も音由来の決定論ハッシュなので、同じ音源なら同じ連鎖になる。
   */
  private scheduleBurst(event: BandLightEvent, elapsed: number): void {
    const visible = (depth: number): { halfWidth: number; halfHeight: number } =>
      this.visibleHalfExtent(depth);
    const settings = this.mappingSettings();
    const plan = this.mapping.resolveBurst(event, visible, settings);

    // Burst 全体を包む質感レイヤー。**遅れて開き、Transient より長く残る。**
    for (const layer of this.mapping.resolveMacroLayers(event, visible, settings)) {
      this.scheduledMacros.push({ at: elapsed + layer.delaySeconds, traits: layer.traits });
    }
    this.lastBurstLights = plan.length;
    this.burstCount += 1;
    this.lastBand = event.band;
    for (const light of plan) {
      if (light.delaySeconds <= 0) {
        this.spawn(light.traits);
        continue;
      }
      this.scheduled.push({ at: elapsed + light.delaySeconds, traits: light.traits });
    }
  }

  /** 予約した光のうち、時刻が来たものを生む。 */
  private releaseScheduled(elapsed: number): void {
    if (this.scheduled.length > 0) {
      let write = 0;
      for (let read = 0; read < this.scheduled.length; read++) {
        const entry = this.scheduled[read]!;
        if (entry.at <= elapsed) {
          this.spawn(entry.traits);
          continue;
        }
        this.scheduled[write] = entry;
        write += 1;
      }
      this.scheduled.length = write;
    }
    if (this.scheduledMacros.length === 0) return;
    let write = 0;
    for (let read = 0; read < this.scheduledMacros.length; read++) {
      const entry = this.scheduledMacros[read]!;
      if (entry.at <= elapsed) {
        this.spawnMacro(entry.traits);
        continue;
      }
      this.scheduledMacros[write] = entry;
      write += 1;
    }
    this.scheduledMacros.length = write;
  }

  /** 質感レイヤーを 1 枚開く。上限に達したら最も古いものから捨てる。 */
  private spawnMacro(traits: MacroLayerTraits): void {
    if (this.macros.length >= SPATIAL_STUDY.macro.maximumLayers) this.macros.shift();
    this.macros.push({ traits, currentIntensity: 0, age: 0, completed: false, driftZ: 0 });
  }

  /** 予定 1 つから光を 1 つ生む。見え方はすでに Mapping 層が決めている。 */
  private spawn(traits: LightVisualTraits): void {
    if (this.cores.length >= SPATIAL_STUDY.maximumCores) this.cores.shift();

    this.cores.push({
      position: { ...traits.position },
      origin: { ...traits.position },
      velocity: traits.velocity,
      role: traits.role,
      onsetStrength: traits.intensity,
      peakIntensity: traits.intensity,
      size: traits.size,
      color: traits.color,
      gradient: traits.gradient,
      shape: traits.shape,
      expansion: traits.expansion,
      currentIntensity: 0,
      attackSeconds: traits.lifetime.attackSeconds,
      holdSeconds: traits.lifetime.holdSeconds,
      decaySeconds: traits.lifetime.decaySeconds,
      age: 0,
      phase: 'attack',
      completed: false,
      history: new Float32Array(SPATIAL_STUDY.trailSegments * 3),
      historyCount: 0,
      sampleCountdown: 0,
      trail: traits.trail,
    });
    if (traits.role === 'main') {
      this.lastOnsetStrength = traits.intensity;
      this.lastPeakIntensity = traits.intensity;
      this.lastPosition = { ...traits.position };
      this.lastColor = { ...traits.color };
      this.lastSize = traits.size;
    }
  }

  /** Mapping 層へ渡す運転設定。開発用パラメータをそのまま束ねるだけ。 */
  private mappingSettings(): LightMappingSettings {
    return {
      minimumIntensity: this.params.minimumIntensity,
      maximumIntensity: this.params.maximumIntensity,
      attackSeconds: this.params.attackMs / 1000,
      holdSeconds: this.params.holdMs / 1000,
      decaySeconds: this.params.decayMs / 1000,
      sizeAmount: this.params.sizeAmount,
      colorAmount: this.params.colorAmount,
      motionAmount: this.params.motionAmount,
      trailAmount: this.params.trailAmount,
      burstDensity: this.params.burstDensity,
      thicknessAmount: this.params.thicknessAmount,
      macroSpreadAmount: this.params.macroSpreadAmount,
      depthAmount: this.params.depthAmount,
      horizontalRayAmount: this.params.horizontalRayAmount,
      sustain: this.lastSustain,
      placementMode: this.placementMode,
    };
  }

  // ---------------------------------------------------------------- 一生

  /**
   * 経過秒だけ進める。明るさは age の純粋な関数。
   * 位置は速度ぶんだけ進む（速度は発生時に確定しているので、経路も決定論）。
   */
  private advance(core: SpatialCore, delta: number): void {
    core.age += delta;
    core.position.x += core.velocity.x * delta;
    core.position.y += core.velocity.y * delta;
    core.position.z += core.velocity.z * delta;
    this.sampleHistory(core, delta);
    const { attackSeconds: attack, holdSeconds: hold, decaySeconds: decay } = core;

    if (core.age < attack) {
      core.phase = 'attack';
      core.currentIntensity = core.peakIntensity * (attack <= 0 ? 1 : core.age / attack);
      return;
    }
    if (core.age < attack + hold) {
      core.phase = 'hold';
      core.currentIntensity = core.peakIntensity;
      return;
    }
    const t = decay <= 0 ? 1 : (core.age - attack - hold) / decay;
    if (t >= 1) {
      core.phase = 'done';
      core.currentIntensity = 0;
      core.completed = true;
      return;
    }
    core.phase = 'decay';
    core.currentIntensity = core.peakIntensity * decayShape(t);
  }

  /**
   * 位置の履歴を一定間隔で 1 点ずつ足す。
   * 間隔は「軌跡の長さ ÷ 節の数」なので、Trail を動かすと履歴の張る時間だけが変わる。
   */
  private sampleHistory(core: SpatialCore, delta: number): void {
    if (core.trail <= 0) {
      core.historyCount = 0;
      return;
    }
    core.sampleCountdown -= delta;
    if (core.sampleCountdown > 0) return;
    const interval = Math.max(
      trailSeconds(core.trail) / SPATIAL_STUDY.trailSegments,
      1 / 240,
    );
    core.sampleCountdown = interval;

    // 先頭へ新しい点を差し込み、古い点を 1 つ後ろへずらす。
    const history = core.history;
    const last = Math.min(core.historyCount, SPATIAL_STUDY.trailSegments - 1);
    for (let i = last; i > 0; i--) {
      history[i * 3] = history[(i - 1) * 3]!;
      history[i * 3 + 1] = history[(i - 1) * 3 + 1]!;
      history[i * 3 + 2] = history[(i - 1) * 3 + 2]!;
    }
    history[0] = core.position.x;
    history[1] = core.position.y;
    history[2] = core.position.z;
    core.historyCount = Math.min(core.historyCount + 1, SPATIAL_STUDY.trailSegments);
  }

  /**
   * 質感レイヤーを進める。**Transient とは別の時間軸。**
   * 明るさは age の純粋な関数で、形も色も発生時から変わらない。
   */
  private advanceMacros(delta: number): void {
    let write = 0;
    for (let read = 0; read < this.macros.length; read++) {
      const layer = this.macros[read]!;
      layer.age += delta;
      layer.driftZ += layer.traits.drift * delta;
      const { attackSeconds: attack, holdSeconds: hold, decaySeconds: decay } = layer.traits.lifetime;
      const peak = layer.traits.intensity;
      if (layer.age < attack) {
        layer.currentIntensity = peak * (attack <= 0 ? 1 : layer.age / attack);
      } else if (layer.age < attack + hold) {
        layer.currentIntensity = peak;
      } else {
        const t = decay <= 0 ? 1 : (layer.age - attack - hold) / decay;
        if (t >= 1) {
          layer.completed = true;
          layer.currentIntensity = 0;
        } else {
          layer.currentIntensity = peak * decayShape(t);
        }
      }
      if (layer.completed) continue;
      this.macros[write] = layer;
      write += 1;
    }
    this.macros.length = write;
  }

  /** 質感レイヤーのインスタンス属性を書き戻す。確保はしない。 */
  private syncMacroInstances(): void {
    if (!this.macroGeometry) return;
    const maskCount = Math.max(this.atlas?.patterns ?? 1, 1);
    const opacity = SPATIAL_STUDY.macro.opacity;
    let slot = 0;
    for (const layer of this.macros) {
      const t = layer.traits;
      this.macroOffsets[slot * 3] = t.position.x;
      this.macroOffsets[slot * 3 + 1] = t.position.y;
      // Bass と Sustain でごくゆっくり前後へ流れる（発生時に決まった速度）。
      this.macroOffsets[slot * 3 + 2] = t.position.z + layer.driftZ;
      this.macroSizes[slot * 3] = t.halfWidth;
      this.macroSizes[slot * 3 + 1] = t.halfHeight;
      this.macroSizes[slot * 3 + 2] = t.tile;
      this.macroIntensities[slot] = layer.currentIntensity * opacity;
      this.macroCrops[slot * 4] = t.crop.u;
      this.macroCrops[slot * 4 + 1] = t.crop.v;
      this.macroCrops[slot * 4 + 2] = t.crop.su;
      this.macroCrops[slot * 4 + 3] = t.crop.sv;
      this.macroOrients[slot * 4] = Math.cos(t.rotation);
      this.macroOrients[slot * 4 + 1] = Math.sin(t.rotation);
      this.macroOrients[slot * 4 + 2] = t.flipX;
      this.macroOrients[slot * 4 + 3] = t.flipY;
      this.macroWarps[slot * 4] = t.warp.amount;
      this.macroWarps[slot * 4 + 1] = t.warp.frequency;
      this.macroWarps[slot * 4 + 2] = t.warp.phase;
      this.macroWarps[slot * 4 + 3] = t.gradient.form;
      // 0..1 の割合を多角形の番号へ。枚数は描画側だけが知っている。
      this.macroStyles[slot * 3] = Math.min(Math.floor(t.maskPattern * maskCount), maskCount - 1);
      this.macroStyles[slot * 3 + 1] = t.maskAmount;
      this.macroStyles[slot * 3 + 2] = t.sourceTint;
      this.macroNormals[slot * 4] = t.normal.x;
      this.macroNormals[slot * 4 + 1] = t.normal.y;
      this.macroNormals[slot * 4 + 2] = t.normal.z;
      this.macroNormals[slot * 4 + 3] = t.spin;
      for (let c = 0; c < 4; c++) {
        this.macroHues[slot * 4 + c] = t.gradient.hues[c]!;
        this.macroSaturations[slot * 4 + c] = t.gradient.saturations[c]!;
      }
      slot += 1;
    }
    this.macroGeometry.instanceCount = slot;
    for (const attribute of Object.values(this.macroAttributes)) attribute.needsUpdate = true;
  }

  /** 進めながら、終わった Core を詰めて捨てる（参照を残さない）。 */
  private advanceCores(delta: number): void {
    let write = 0;
    for (let read = 0; read < this.cores.length; read++) {
      const core = this.cores[read]!;
      this.advance(core, delta);
      if (core.completed) continue;
      this.cores[write] = core;
      write += 1;
    }
    this.cores.length = write;
  }

  /** インスタンス属性へ書き戻す。確保はせず、中身と instanceCount だけ更新する。 */
  private syncInstances(): void {
    if (!this.geometry || !this.offsetAttribute || !this.intensityAttribute) return;
    if (!this.sizeAttribute || !this.hueAttribute || !this.shapeAttribute) return;
    if (!this.saturationAttribute || !this.formAttribute || !this.patternAttribute) return;
    if (!this.thicknessAttribute) return;
    const patternCount = Math.max(this.atlas?.patterns ?? 1, 1);
    let slot = 0;
    const write = (
      x: number,
      y: number,
      z: number,
      intensity: number,
      size: number,
      gradient: LightGradient,
      shape: LightShape,
    ): void => {
      this.offsets[slot * 3] = x;
      this.offsets[slot * 3 + 1] = y;
      this.offsets[slot * 3 + 2] = z;
      this.intensities[slot] = intensity;
      this.sizes[slot] = size;
      for (let c = 0; c < 4; c++) {
        this.hues[slot * 4 + c] = gradient.hues[c]!;
        this.saturations[slot * 4 + c] = gradient.saturations[c]!;
      }
      this.forms[slot] = gradient.form;
      // 0..1 の割合を帳面のセル番号へ。枚数は描画側だけが知っている。
      this.patterns[slot] = Math.min(Math.floor(shape.pattern * patternCount), patternCount - 1);
      this.thicknesses[slot] = Math.max(shape.thickness, 0.05);
      this.shapes[slot * 4] = shape.elongation;
      this.shapes[slot * 4 + 1] = shape.angle;
      this.shapes[slot * 4 + 2] = shape.waviness;
      this.shapes[slot * 4 + 3] = SHAPE_KIND_INDEX[shape.kind];
      this.normals[slot * 3] = shape.normal?.x ?? 0;
      this.normals[slot * 3 + 1] = shape.normal?.y ?? 0;
      this.normals[slot * 3 + 2] = shape.normal?.z ?? 1;
      slot += 1;
    };

    for (const core of this.cores) {
      // 大きさと色は発生時に確定した値。毎フレーム作り直さないのでちらつかない。
      // 針だけは大きさではなく**伸びの割合**を送る（太さは画素で決まっている）。
      const scale =
        core.shape.kind === 'ray' ? rayGrowth(core.age) : core.size * expansionAt(core);
      write(core.position.x, core.position.y, core.position.z,
        core.currentIntensity * layerOpacity(core.shape.kind, core.role),
        scale, core.gradient, core.shape);
    }
    // 軌跡は 3D の位置履歴そのもの（2D の残像合成ではない）。
    // 先端ほど明るく太く、末尾へ向かって細く暗くなる。
    for (const core of this.cores) {
      if (core.trail <= 0) continue;
      const opacity = layerOpacity(core.shape.kind, core.role) * SPATIAL_STUDY.layering.trailScale;
      for (let k = 0; k < core.historyCount; k++) {
        const fade = (k + 1) / SPATIAL_STUDY.trailSegments;
        const intensity =
          core.currentIntensity * opacity * (1 - fade) * (1 - fade) *
          (1 - SPATIAL_STUDY.trailIntensityAtTail);
        if (intensity <= 0.002) continue;
        const size = core.size * (1 - fade * (1 - SPATIAL_STUDY.trailSizeAtTail));
        write(core.history[k * 3]!, core.history[k * 3 + 1]!, core.history[k * 3 + 2]!, intensity, size, core.gradient, core.shape);
      }
    }

    this.geometry.instanceCount = slot;
    this.offsetAttribute.needsUpdate = true;
    this.intensityAttribute.needsUpdate = true;
    this.sizeAttribute.needsUpdate = true;
    this.hueAttribute.needsUpdate = true;
    this.saturationAttribute.needsUpdate = true;
    this.formAttribute.needsUpdate = true;
    this.patternAttribute.needsUpdate = true;
    this.thicknessAttribute!.needsUpdate = true;
    this.shapeAttribute.needsUpdate = true;
    this.normalAttribute!.needsUpdate = true;
  }

  // ---------------------------------------------------------------- update

  update(elapsed: number): void {
    if (!this.context || !this.material) return;
    const audio = this.context.audioEngine.getParameters();
    this.material.uniforms.uIntensity!.value = this.params.intensity;
    const active = audio.active === 1;

    const delta =
      this.previousElapsed < 0
        ? 0
        : clamp(elapsed - this.previousElapsed, 0, SPATIAL_STUDY.maximumDelta);
    this.previousElapsed = elapsed;

    if (!active) {
      // PRD D5: 音がなければ発生も余韻もない（無音＝黒画面が正常）。
      // 質感レイヤーは Decay が長いぶん、ここで確実に落とす。
      this.syncOptics();
      this.cores.length = 0;
      this.scheduled.length = 0;
      this.macros.length = 0;
      this.scheduledMacros.length = 0;
      this.resetDetection();
      this.syncInstances();
      this.syncMacroInstances();
      this.pipeline?.update(audio, elapsed);
      return;
    }

    this.syncOptics();
    this.detectEvents(elapsed, delta);
    this.releaseScheduled(elapsed);
    this.advanceCores(delta);
    this.advanceMacros(delta);
    this.syncInstances();
    this.syncMacroInstances();
    this.pipeline?.update(audio, elapsed);
  }

  private resetDetection(): void {
    this.detector.reset();
    this.lastBand = null;
    this.lastEventCores = 0;
    this.lastPosition = null;
    this.lastBurstLights = 0;
    this.burstCount = 0;
    this.mapping.reset();
  }

  render(): void {
    if (this.bloomComposer && this.displayMaterial) {
      this.bloomComposer.render();
      // 合成器は毎フレーム読み書きバッファを入れ替えるので、
      // 結果が入っているほうを都度つなぎ直す。
      this.displayMaterial.uniforms.tDiffuse!.value = this.bloomComposer.readBuffer.texture;
    }
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    if (this.camera && height > 0) {
      // キャンバスは画角（Aspect）に合わせて main 側がリサイズする。
      // カメラの比率もそれに揃えないと、Core が縦横に潰れて見える。
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);
    this.bloomComposer?.setSize(w, h);
    this.bloomPass?.setSize(w, h);
    this.pipeline?.resize(width, height);
  }

  // ---------------------------------------------------------------- LabExpression

  getEffects(): readonly Effect[] {
    return this.effects;
  }

  moveEffect(effect: Effect, direction: -1 | 1): void {
    this.pipeline?.move(effect, direction);
  }

  setEffectOrder(names: string[]): void {
    this.pipeline?.setOrder(names);
  }

  getTheme(): Theme {
    return this.theme;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  /** 色のテーマは持たない（黒背景と白い Core だけ）。 */
  usesTheme(): boolean {
    return false;
  }

  getZoom(): number {
    return this.zoom;
  }

  setZoom(zoom: number): void {
    this.zoom = clamp(zoom, 0.25, 8);
  }

  getResponse(): { bass: number; mid: number; treble: number } {
    return { ...this.response };
  }

  /** 帯域ゲインは状態として持つだけ。検証中は像に効かせない（2D と同じ扱い）。 */
  setResponse(gains: Partial<{ bass: number; mid: number; treble: number }>): void {
    const pick = (value: number | undefined, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 2) : fallback;
    this.response = {
      bass: pick(gains.bass, this.response.bass),
      mid: pick(gains.mid, this.response.mid),
      treble: pick(gains.treble, this.response.treble),
    };
  }

  getAspectId(): string {
    return this.aspectId;
  }

  getAspectRatio(): number {
    return this.aspectRatio;
  }

  setAspect(id: string, ratio: number): void {
    if (id === this.aspectId) return;
    this.aspectId = id;
    this.aspectRatio = clamp(ratio, 0.25, 4);
    if (this.camera) {
      this.camera.aspect = this.aspectRatio;
      this.camera.updateProjectionMatrix();
    }
  }

  setDebugView(): void {
    // 切り替える中間表現を持たない。
  }

  getDebugState(): null {
    return null;
  }

  getDepth(): number {
    return 0;
  }

  setDepth(): void {
    // 奥行きスライダーは持たない（空間そのものが奥行きを持つ）。
  }

  getPhase(): string {
    const f = this.detector.bandFlux;
    const p = this.lastPosition;
    return (
      `cores ${this.cores.length} / last ${this.lastBand ?? '-'} ` +
      `${p ? `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})` : '-'} / ` +
      `flux b${f.bass.toFixed(2)} m${f.mid.toFixed(2)} t${f.treble.toFixed(2)}`
    );
  }

  /** 開発・検証用。Inspector と `window.__lab` から読む。 */
  getSpatialStudyState(): SpatialStudyState {
    return {
      count: this.cores.length,
      lastBand: this.lastBand,
      lastOnsetStrength: this.lastOnsetStrength,
      lastPeakIntensity: this.lastPeakIntensity,
      lastPosition: this.lastPosition ? { ...this.lastPosition } : null,
      lastColor: { ...this.lastColor },
      lastSize: this.lastSize,
      lastPhase: this.cores.length > 0 ? this.cores[this.cores.length - 1]!.phase : null,
      lastEventCores: this.lastEventCores,
      lastBurstLights: this.lastBurstLights,
      burstCount: this.burstCount,
      scheduledLights: this.scheduled.length,
      prismTiles: this.prism?.tiles.length ?? 0,
      macroLayers: this.macros.map((layer) => ({
        tile: layer.traits.tile,
        intensity: layer.currentIntensity,
        age: layer.age,
        halfWidth: layer.traits.halfWidth,
        halfHeight: layer.traits.halfHeight,
        rotation: layer.traits.rotation,
        crop: { u: layer.traits.crop.u, v: layer.traits.crop.v, su: layer.traits.crop.su },
        decaySeconds: layer.traits.lifetime.decaySeconds,
        warp: layer.traits.warp.amount,
        maskAmount: layer.traits.maskAmount,
        hues: [...layer.traits.gradient.hues],
      })),
      flux: this.detector.bandFlux,
      bands: {
        bass: this.detector.bandState('bass'),
        mid: this.detector.bandState('mid'),
        treble: this.detector.bandState('treble'),
      },
      cores: this.cores.map((core) => ({
        x: core.position.x,
        y: core.position.y,
        z: core.position.z,
        speed: Math.hypot(core.velocity.x, core.velocity.y, core.velocity.z),
        role: core.role,
        shape: core.shape.normal
          ? `${core.shape.kind}:${core.shape.normal.x.toFixed(2)},${core.shape.normal.y.toFixed(2)},${core.shape.normal.z.toFixed(2)}`
          : `${core.shape.kind}:${core.shape.elongation.toFixed(1)}`,
        size: core.size,
        color: { ...core.color },
        gradient: {
          form: core.gradient.form,
          hues: [...core.gradient.hues],
          saturations: [...core.gradient.saturations],
        },
        onsetStrength: core.onsetStrength,
        peakIntensity: core.peakIntensity,
        currentIntensity: core.currentIntensity,
        age: core.age,
        phase: core.phase,
      })),
    };
  }

  // ---------------------------------------------------------------- 開発用パラメータ

  getExpressionParams(): ExpressionParam[] {
    const row = (key: SpatialParamKey, label: string): ExpressionParam => ({
      key,
      label,
      ...SPATIAL_STUDY.ranges[key],
      value: this.params[key],
    });
    const onOff = (key: string, label: string, enabled: boolean): ExpressionParam => ({
      key,
      label,
      type: 'select',
      options: [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
      value: enabled ? 'on' : 'off',
    });
    return [
      row('attackMs', 'Attack (ms)'),
      row('holdMs', 'Hold (ms)'),
      row('decayMs', 'Decay (ms)'),
      row('minimumIntensity', 'Min intensity'),
      row('maximumIntensity', 'Max intensity'),
      row('onsetSensitivity', 'Onset sensitivity'),
      row('fluxGain', 'Flux gain'),
      row('cooldownMs', 'Cooldown (ms)'),
      row('relativeStrengthFloor', 'Band floor'),
      row('sizeAmount', 'Size amount'),
      row('colorAmount', 'Color amount'),
      row('motionAmount', 'Motion amount'),
      row('trailAmount', 'Trail'),
      row('burstDensity', 'Burst density'),
      row('thicknessAmount', 'Thickness'),
      row('macroSpreadAmount', 'Macro spread'),
      row('depthAmount', 'Depth'),
      row('horizontalRayAmount', 'Horizontal rays'),
      row('thresholdScale', 'Onset reach'),
      row('bloomThreshold', 'Bloom threshold'),
      row('bloomStrength', 'Bloom strength'),
      row('bloomRadius', 'Bloom radius'),
      row('exposure', 'Exposure'),
      row('intensity', 'Intensity'),
      {
        key: 'placementMode',
        label: 'Placement',
        type: 'select',
        options: [
          { value: 'center', label: 'Center' },
          { value: 'scatter', label: 'Scatter' },
        ],
        value: this.placementMode,
      },
      onOff('adaptiveThreshold', 'Adaptive threshold', this.adaptiveThreshold),
      onOff('adaptiveStrength', 'Adaptive strength', this.adaptiveStrength),
    ];
  }

  setExpressionParam(key: string, value: number | string): void {
    if (key === 'placementMode') {
      this.placementMode = value === 'scatter' ? 'scatter' : 'center';
      return;
    }
    if (key === 'adaptiveThreshold' || key === 'adaptiveStrength') {
      const enabled = value === 'on' || value === 1;
      if (key === 'adaptiveThreshold') this.adaptiveThreshold = enabled;
      else this.adaptiveStrength = enabled;
      return;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return;
    if (!(key in this.params)) return;
    const range = SPATIAL_STUDY.ranges[key as SpatialParamKey];
    this.params[key as SpatialParamKey] = clamp(numeric, range.min, range.max);
  }

  setGeneratorsVisible(): void {
    // 表示の切り替えは存在しない。
  }

  setDesignLayerCanvases(canvases: DesignLayerCanvases): void {
    this.pipeline?.setOverlayCanvases(canvases);
  }

  updateDesignLayerCanvases(): void {
    this.pipeline?.updateOverlayCanvases();
  }

  dispose(): void {
    this.disposed = true;
    this.macroGeometry?.dispose();
    this.macroMaterial?.dispose();
    this.prism?.texture.dispose();
    if (this.macroMesh && this.scene) this.scene.remove(this.macroMesh);
    this.macroGeometry = null;
    this.macroMaterial = null;
    this.macroMesh = null;
    this.prism = null;
    this.macros.length = 0;
    this.scheduledMacros.length = 0;
    this.pipeline?.dispose();
    this.bloomPass?.dispose();
    this.bloomComposer?.dispose();
    this.displayGeometry?.dispose();
    this.displayMaterial?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.atlas?.texture.dispose();
    this.atlas = null;
    this.cores.length = 0;
    this.scheduled.length = 0;
    this.resetDetection();
    if (this.mesh && this.scene) this.scene.remove(this.mesh);
    this.pipeline = null;
    this.bloomPass = null;
    this.bloomComposer = null;
    this.displayScene = null;
    this.displayCamera = null;
    this.displayGeometry = null;
    this.displayMaterial = null;
    this.mesh = null;
    this.scene = null;
    this.geometry = null;
    this.material = null;
    this.offsetAttribute = null;
    this.intensityAttribute = null;
    this.sizeAttribute = null;
    this.hueAttribute = null;
    this.saturationAttribute = null;
    this.formAttribute = null;
    this.patternAttribute = null;
    this.thicknessAttribute = null;
    this.shapeAttribute = null;
    this.normalAttribute = null;
    this.camera = null;
    this.context = null;
  }
}
