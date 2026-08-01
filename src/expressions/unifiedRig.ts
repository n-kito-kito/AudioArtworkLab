import { tickRateOf, type UnifiedAxes } from './unifiedAxes';
import { strobePhaseGain } from './unifiedTime';

/**
 * **統合表現の見え方の組み立て（Light Unified）。**
 *
 * 3 表現のコードは持ち込まない。ここは新規に書いた 1 本の数式群で、
 * **すべての軸が連続な混合係数として式の中に入っている**（分岐で見え方を切り替えない）。
 *
 * 要素の語彙は 3 表現の和集合:
 *   核 core … 中心の白熱。**白へ届いてよいのはここだけ**
 *   光条 beam … 針・Ray・アーム・骨格の軸を 1 つの語にまとめたもの
 *   膜 membrane … Sheet・カーテン・マクロ膜
 *   靄 haze … 画面をまとめる最下段
 *   破片 fragment … 4 つの形状族
 *   扇 fan … 強い出来事のときだけ開く放射
 *
 * `Math.random()` は使わない。同じ入力なら必ず同じ絵になる。
 */

/** 描画側のフラグメント分岐と 1 対 1。 */
export type UnifiedKind = 'core' | 'beam' | 'membrane' | 'haze' | 'fragment' | 'fan';

export const UNIFIED_KIND_INDEX: Readonly<Record<UnifiedKind, number>> = {
  core: 0,
  beam: 1,
  membrane: 2,
  haze: 3,
  fragment: 4,
  fan: 5,
};

/** 破片の形状族（4 つ）。 */
export const UNIFIED_FRAGMENT_FAMILIES = ['shard', 'sliver', 'plate', 'chip'] as const;

/**
 * **1 層ぶんの素材の読み方。**
 *
 * アトラスは 10 枚あるのに、これまでは全種別・全インスタンスが
 * **同じ 1 枚を同じ向き・同じ切り口**で使い、灰色にして明るさを ±22% 振るだけだった。
 * ここでタイル・クロップ・回転・反転を要素ごとに散らす。
 */
export interface UnifiedMaterial {
  /** 欲しい素材の役割（manifest の `role`）。番号ではなく希望だけを渡す。 */
  readonly roles: readonly string[];
  /** 役割の重みつき抽選に使う 0〜1。決定論。 */
  readonly pick: number;
  /** UV のクロップ [中心 u, 中心 v, 半径 u, 半径 v]。 */
  readonly crop: readonly [number, number, number, number];
  /** 向き [cos, sin, 反転 X(±1), 反転 Y(±1)]。 */
  readonly orient: readonly [number, number, number, number];
  /** この層に効く素材の量（軸 × 種別の重み）。0 なら 1 画素も素材を読まない。 */
  readonly grain: number;
  /** 多角形マスクの抽選値（0〜1）と効き。`silhouette` 軸 × 種別の重み。 */
  readonly maskPick: number;
  readonly maskAmount: number;
  /** 素材そのものの色みを残す割合（0 で完全に音の色へ置き換える）。 */
  readonly sourceTint: number;
}

/** 1 層ぶんの見え方。描画クラスはこれを描くだけで、音も軸も見ない。 */
export interface UnifiedLayer {
  readonly kind: UnifiedKind;
  readonly position: readonly [number, number, number];
  readonly half: readonly [number, number];
  /** 面内回転（ラジアン）。 */
  readonly spin: number;
  /** 面の傾き（x 軸・y 軸まわり）。`tilt` 軸が 0 なら両方 0 = 正面。 */
  readonly tiltX: number;
  readonly tiltY: number;
  /** 色相（0〜1）。要素ごとの seed 色と全体色の混合はここで済ませてある。 */
  readonly hue: number;
  /** 層の中を走る色の幅。 */
  readonly hueSpan: number;
  /**
   * **1 要素の中の色の旅**（等間隔 4 点）。`hueDepth` 軸 0 では
   * `hue` から `hueSpan` ぶんまっすぐ走るだけ ＝ 従来と同じ並び。
   */
  readonly hues: readonly [number, number, number, number];
  /** 同・彩度。0 で白、`tintDepth` が既定の高さ。 */
  readonly saturations: readonly [number, number, number, number];
  /** 勾配の形式（0 横 / 1 放射 / 2 縦 / 3 角度）。 */
  readonly gradientForm: number;
  readonly intensity: number;
  /**
   * 種別ごとの形の値。
   * core: [形状族, 横フレア, 縦スパイク, 芯の強さ] /
   * beam: [芯の半幅, ハロー, 減衰の始まり, 減衰の終わり] /
   * membrane: [形状族, 襞の周期, 帯の半幅, 折れ] /
   * haze: [減衰, 縁の始まり, 縁の終わり, 分光の深さ] /
   * fragment: [縁, 形状族, 伸び, 欠け] / fan: [基準角, 広がり, 本数, 到達]
   */
  readonly shape: readonly [number, number, number, number];
  /** **縁の柔らかさ。** `blur` 軸が束ねる（0 でシャープ・1 でにじむ）。 */
  readonly edge: number;
  /**
   * **にじみのハロ（散乱）。** `blur` 軸が同じ 1 本で広げる。
   * 0 なら 1 画素も足さないので、シャープ側では従来どおりの縁になる。
   */
  readonly halo: number;
  /**
   * **板の余白**（1 で余白なし）。要素の裾（ハロ・にじみ）が板の縁に届くと
   * **四角い枠が絵に出る**ので、裾が伸びるぶんだけ板を広げて内側へ収める。
   * 描画側はこの値で座標を割り直すので、余白を広げても要素の大きさは変わらない。
   */
  readonly pad: number;
  /**
   * **その種別の性格**（種別ごとに意味が違う 1 本）。
   * 破片: 0 = 角のある破片 ⇄ 1 = 羽毛・筋 /
   * 核: 0 = 等方の点 ⇄ 1 = 横長の平らな面（超ガウス）。他の種別では 0。
   */
  readonly character: number;
  /**
   * **素材（アトラス）の読み方。** `textureGrain` 軸が量を、要素ごとの seed が
   * どのタイルをどこからどの向きで切り出すかを決める。
   * リグはタイルの**番号を知らない**（アトラスは非同期に届くので、
   * 役割の希望と 0〜1 の抽選値だけを渡し、番号は描画クラスが解く）。
   */
  readonly material: UnifiedMaterial;
  /** **白の予算。** true は白へ届いてよい（核だけ）。 */
  readonly whiteAllowed: boolean;
  readonly ceiling: number;
  /** [オフセット倍率, 非相関倍率, オフセット下限, 非相関下限] */
  readonly channel: readonly [number, number, number, number];
}

/** 音が注ぎ込むもの。**これ以外に見え方を変える入力はない。** */
export interface UnifiedDrive {
  /**
   * **種別ごとの場の基礎輝度**（音量の持続）。`Stagger` 軸が 0 なら 6 本とも同じ値で、
   * 1 に近づくほど「後から開いて長く残る層」と「先に閃いて先に消える層」に分かれる。
   */
  readonly fieldLevels: Readonly<Record<UnifiedKind, number>>;
  /** 核の脈動（打撃）。 */
  readonly corePulse: number;
  /** 核の形状族（−1 で素の芯）。 */
  readonly coreShape: number;
  /** 光条の方向ビットと強さ。 */
  readonly beamMask: number;
  readonly beamStrength: number;
  readonly beamSeed: number;
  /** 扇の強さと個体差。 */
  readonly fanPower: number;
  readonly fanSeed: number;
  /** 生きている破片（位置は seed と slot から決まる）。 */
  readonly fragments: readonly {
    readonly seed: number;
    readonly slot: number;
    readonly strength: number;
    readonly band: string;
    readonly aim?: readonly [number, number] | null;
    readonly pull?: number;
    /** 時間軸（Attack / Decay / Strobe）が作った明るさの係数。 */
    readonly gain: number;
  }[];
  /**
   * **打撃ごとに生まれて死ぬ膜。** 位置・形・素材はイベントの seed から決まり、
   * `gain` は誕生からの経過が作った明るさ（遅れて開き、遅れて消える）。
   */
  readonly membranes: readonly {
    readonly seed: number;
    readonly slot: number;
    readonly strength: number;
    readonly band: string;
    readonly gain: number;
  }[];
  /** グローバル色相。 */
  readonly hue: number;
  /** 光学クロックのティック番号（−1 で連続）。 */
  readonly tick: number;
  /** 連続の時計（秒）。漂いに使う。 */
  readonly time: number;
  /** 散らばりのシード。 */
  readonly seed: number;
}

export interface UnifiedViewport {
  readonly aspectRatio: number;
}

/** この光学系の定数。 */
export const UNIFIED = {
  fieldOfView: 45,
  /** 奥行きの手がかりを張る範囲。`depthSpread` 軸がこの幅を使う。 */
  depthNear: 4.6,
  depthFar: 15,
  depthDimFar: 0.32,
  /** 白の予算。核以外はここで頭を押さえる。 */
  nonCoreCeiling: 0.3,
  hazeCeiling: 0.12,
  membraneCeiling: 0.22,
  /**
   * **膜の天井（`membraneScale` が 1 のとき）。**
   * 画面を越える大きさの膜は、天井が低いままだと「薄い灰色の板」にしかならない。
   * それでも**1 枚では白へ届かせない** — 白の予算は核だけのものなので、
   * 3 プリセットと既定値では核の無いフレームの白が 0.000% になる高さに実測で置いた。
   * （加算なので、全軸を最大にして 16 枚以上重ねれば重なりからは白が生まれる。
   * それは 1 枚が白いのとは別のことで、Spatial と同じ「重なりの白」である。）
   */
  membraneCeilingWide: 0.44,
  beamCeiling: 0.62,
  /** 要素の枚数（軸が量を決めるので上限だけ持つ）。 */
  membraneCount: 4,
  fragmentCount: 16,
  beamCount: 4,
  /**
   * **破片の濃さ（旧 `Fragments` 軸の焼き込み）。**
   * 3 プリセット + 既定の 4 つの値（0.5 / 0.6 / 0.6 / 0.55）の中央。
   */
  fragmentAmount: 0.55,
  /**
   * **`Density` が破片の枚数へ掛ける倍率の上限。**
   * 下限は 0（＝ 旧 `Fragments = 0` の「破片を出さない」がここへ移った）。
   * 既定 0.55 で旧 `mix(0.5, 2.2, 0.55) = 1.435` をちょうど通るよう置いてある。
   */
  fragmentDensityAtOne: 2.61,
  /**
   * **奥行きが連れて動かす傾きの量（旧 `Tilt` 軸の吸収）。**
   * 3 プリセットの (`depthSpread`, `tilt`) は (0.9, 0.75) / (0.5, 0.35) / (0.2, 0.05) で、
   * 傾き ≈ 奥行き × 0.8 にほぼ乗っている。
   */
  tiltFromDepth: 0.8,
  /**
   * **ワールド固定側の膜の半径**（ワールド単位）。中間の奥行きで画面をほぼ埋める。
   * 可視範囲で割らないので、手前に置かれた膜は画面を越え、奥のものは小さく写る
   * ＝ 遠近が相殺されない（Spatial の `macroWorldHalfSize` と同じ流儀）。
   */
  membraneWorldHalf: 3.4,
  /**
   * **打撃ごとの膜 1 枚の濃さ**（固定のリグの膜に対する倍率）。
   * 1 つの打撃が数枚を生み、それが重なって残るので、1 枚は薄くしておく。
   */
  eventMembraneScale: 0.42,
  /**
   * **種別ごとに必ず確保する枠。**
   *
   * 層の合計が上限を超えたとき、**先頭から切ると末尾の種別が丸ごと消える**。
   * 組み立て順の末尾は扇と核なので、密度を上げると**白へ届いてよい唯一の層が
   * 落ちる**という壊れ方をしていた。ここに書いた枚数は種別ごとに先取りし、
   * 余りだけを元の並びで配る（`capUnifiedRig`）。
   *
   * 合計は上限より小さくしておくこと（全種別が確実に枠を取れる条件）。
   */
  reserve: {
    core: 4,
    fan: 2,
    beam: 8,
    haze: 2,
    membrane: 8,
    fragment: 20,
  } as Readonly<Record<UnifiedKind, number>>,
  /**
   * **にじみが最大のときの板の余白**（1.4 なら板は 2.4 倍）。
   * ハロは `exp(-r^2 * 1.6)` なので r = 2.4 では 1 万分の 1 になり、
   * 縁に届く前に消える。
   */
  padAtFullBlur: 1.4,
  /** 波長の深さ。1 で純粋な分光、0 で白。 */
  tintDepth: 0.72,
  /**
   * **要素の中の色の旅（`Hue depth` 軸）の定数。**
   * 幅の上限 0.5 は半周ぶん。これを超えると 1 要素の中に補色が同居して濁る。
   */
  hueTravel: {
    spanAtFullDepth: 0.5,
    /** 走った色相が途中で折り返す要素の割合。直線ばかりだと分光が均質に見える。 */
    turnProbability: 0.38,
    /** 彩度が一定のままの要素の割合。残りは白 → 色 と 色 → 白 に半々。 */
    flatProbability: 0.26,
    /** 白い端の彩度（芯が白く抜けるプリズムらしさ）。 */
    whiteEnd: 0.14,
  },
  /**
   * **素材の読み方の定数（`Texture grain` 軸）。**
   * 素材は絵ではなく**輝度マスク**として読む。値は Spatial の実測（10 枚の平均輝度は
   * 0.017〜0.066 しかなく、見せたい膜は 0.05〜0.3 に居る）から持ってきている。
   */
  grain: {
    /**
     * 黒浮きを加算の前に落とす敷居と幅。これが無いと画面全体が灰色に浮く。
     * **実測が効いている値。** アトラス 10 枚の輝度は中央値 0.004・p90 0.103 しかない
     * （＝ほとんどが黒）ので、Spatial の 0.017 では見せたい筋まで落ちる。
     */
    blackFloor: 0.01,
    blackFloorWidth: 0.03,
    /** 素材の輝度の曲げ。1 未満で暗部を持ち上げる（膜は元が暗い）。 */
    gamma: 0.45,
    /**
     * 持ち上げたあとの利得。**マスクの平均がおよそ 1 になる高さ**に実測で置いた
     * （軸 0 の平均輝度 17.2 に対し、この値で軸 1 は 20 前後）。
     * こうすると軸を上げても総量はおよそ保たれ、**明るさが筋へ集まる**だけになる。
     */
    gain: 2.4,
    /** UV をマスの内側へ寄せる余白。隣の素材へ滲ませない。 */
    inset: 0.006,
    /** クロップの半径。小さいほど素材の一部を大きく引き伸ばす。 */
    cropMinimum: 0.22,
    cropMaximum: 0.6,
    /** 役割が合わない素材が選ばれる余地。0 にすると同じ数枚しか出ない。 */
    offRoleWeight: 0.14,
    /** 素材そのものの色みを残す割合の幅。**色を捨てない**ための一手。 */
    tintKeepMinimum: 0.18,
    tintKeepMaximum: 0.52,
  },
  /**
   * **種別ごとの素材の効き。** 核は白へ届いてよい唯一の層なので、
   * 素材で削ると芯が消える。膜と靄は素材そのものが見え方の本体。
   */
  grainByKind: {
    // 核だけは素材を**加算**する（削るのではない）。ここは加算の量。
    core: 1,
    beam: 0.45,
    membrane: 1,
    haze: 1,
    fragment: 0.9,
    fan: 0.7,
  } as Readonly<Record<UnifiedKind, number>>,
  /**
   * **種別ごとに欲しい素材の役割。** manifest の `role` をそのまま書く。
   * アトラスに無い役割は単に選ばれないので、素材が増減しても壊れない。
   */
  rolesByKind: {
    membrane: ['layered-sheets', 'parallel-curtains', 'wide-haze', 'curved-volume'],
    haze: ['wide-haze', 'wide-caustic', 'curved-volume'],
    fragment: ['fine-filaments', 'segmented-rays', 'filament-and-curtain'],
    beam: ['segmented-rays', 'fine-filaments', 'parallel-curtains'],
    fan: ['caustic-fan', 'wide-caustic'],
    core: ['wide-caustic', 'caustic-fan'],
  } as Readonly<Record<UnifiedKind, readonly string[]>>,
  /**
   * **種別ごとの多角形マスクの効き。** 核は削らない — 白へ届いてよい唯一の層で、
   * 芯を欠けさせると「白熱した点」ではなくなる。
   */
  silhouetteByKind: {
    core: 0,
    beam: 0.35,
    membrane: 1,
    haze: 0.75,
    fragment: 0.9,
    fan: 0.85,
  } as Readonly<Record<UnifiedKind, number>>,
  /** 破片だけは**発火した帯域**が素材の系統を決める（Spatial と同じ流儀）。 */
  rolesByBand: {
    bass: ['wide-haze', 'wide-caustic', 'parallel-curtains', 'layered-sheets'],
    mid: ['layered-sheets', 'parallel-curtains', 'caustic-fan'],
    treble: ['segmented-rays', 'fine-filaments', 'filament-and-curtain'],
  } as Readonly<Record<string, readonly string[]>>,
  /** 核の大きさの幅（半径・ワールド）。小さい側は針の先、大きい側は画面を占める塊。 */
  coreSmall: 0.2,
  coreLarge: 2.3,
  /**
   * **`Core size` 軸の実寸。**
   *
   * 軸 0 で「針の先」、軸 1 で「画面を占める塊」。
   * **指数は既定値（0.4）が従来の 0.20 / 2.30 をちょうど通るように決めてある**ので、
   * 既定のままなら 1 画素も変わらない（0.4^2.27 = 0.125 / 0.4^0.62 = 0.567）。
   */
  coreSizeAxis: {
    smallAtZero: 0.1,
    smallAtOne: 0.9,
    smallCurve: 2.27,
    largeAtZero: 0.6,
    largeAtOne: 3.6,
    largeCurve: 0.62,
    /**
     * **薄め方の効き。** これまでは `0.2 / size` がちょうど大きさを打ち消していて、
     * **「広い」と「白い」が両立しなかった**。指数を軸に載せて、大きい側では
     * 薄め方そのものを弱める。既定 0.4 で 1.0（＝従来どおり）になる高さに置いた。
     */
    diluteCurveAtZero: 1.36,
    diluteCurveAtOne: 0.46,
    /** 板の枚数（重なりで面にする）。既定では 1 枚のまま。 */
    plateCountMaximum: 3,
    plateGrowthFrom: 0.4,
    /** 2 枚目以降の大きさと位置のばらつき。 */
    plateSizeFalloff: 0.55,
    plateOffset: 0.28,
  },
  /**
   * **`Core shape` 軸の実寸。** 縦横比はおよそ面積を保つ組にしてあるので、
   * 横へ伸ばしても明るさの総量が跳ねない（1.45 × 0.78 = 1.13）。
   */
  coreShapeAxis: { wide: 1.45, tall: 0.78 },
  /**
   * **`Core bloom` 軸の実寸。**
   *
   * Spatial / Reactive は `UnrealBloomPass` と露出を自前で持っていて、
   * **核がテクスチャ板なので面ごと滲む**。Unified にはそれが無かった。
   * 閾値はここでも 0.22 に置く — 画面の平均輝度はこれよりずっと低いので、
   * **明るい核だけ**が滲む（膜や靄は素通し）。
   */
  bloom: { threshold: 0.22, strengthAtOne: 0.92, radius: 0.48, exposureAtOne: 0.95 },
  /**
   * **核へ足す素材の量。** 他の種別は素材で**削る**（乗算）が、核だけは足す。
   * 削るだけだと芯が痩せるだけで質感が乗らない — Lab 2 は 0.8・Reactive は 1.38 の加算。
   */
  coreMaterialGain: 0.8,
  /**
   * **明るさの中立化。**
   *
   * `Intensity` は全層の共通倍率だが、非核層は `min(colour, ceiling)` で頭打ちになる。
   * `Membrane scale` / `Haze floor` / `Texture grain` が総光量を大きく動かすと、
   * **`Intensity` は表現の軸ではなく帳尻を合わせる補正ノブになる**
   * （実際、核の加算素材とブルームを入れた回にプリセットの `Intensity` を
   * spatial 0.40 → 0.24 / reactive 0.22 → 0.11 と下げて辻褄を合わせていた）。
   *
   * ここは 3 本それぞれに**局所の補償係数**を置いて、
   * 「軸は構造を変え、明るさは `Intensity` だけが決める」へ戻す。
   * `Core shape` の面積保存（1.45 × 0.78 = 1.13）や `grain.gain = 2.4`
   * （マスクの平均をおよそ 1 に置く）と同じ流儀で、**どれも軸 0 では厳密に 1** になる。
   */
  neutral: {
    /**
     * **膜の面積補償の指数。** 1 で「画面上の面積 × 帯の太さ × 明るさ」が保存される。
     * 0 なら補償なし（従来）。途中の値も連続に効く。
     */
    membraneArea: 1,
    /**
     * **補償の基準点。** 軸のどこを「据え置く」かで、平らにしたときの絵が決まる。
     * 端（軸 0）ではなく**既定値**に合わせてあるので、既定のままなら
     * 中立化の前後で膜も靄も明るさが変わらない（動くのは軸の両端の側）。
     */
    membraneReference: 0.45,
    hazeReference: 0.45,
    /**
     * **靄の上側の圧縮。** 靄は画面全体を覆う 1 枚なので、明るさと面積を
     * 取り引きする余地が無い — 完全に中立にすると軸そのものが消える
     * （0 = 無し ⇄ 1 = 厚い という意味が保てなくなる）。
     * そこで**上側だけ**を圧縮し、減らした光量は裾の広がり（`hazeReach`）へ回す。
     * 1 で圧縮なし。**0 での傾きは 1 のまま**なので、軸の根元は従来と変わらない。
     */
    hazeCompression: 3.2,
    /** 圧縮したぶん、軸の上側で靄の裾を広げる（「厚い」が明るさではなく広がりで出る）。 */
    hazeReach: 0.72,
    /**
     * **核へ足す素材の期待値。** `Texture grain` を上げると核だけは素材が
     * **加算**されるので、他の種別（乗算・マスクの平均が 1）と違って総量が増える。
     * 加算のぶんだけ土台を割り戻して核の光量を保つための係数。
     * 実測（軸 0→1 で核の明るさが変わらない高さ）で置く。
     */
    coreGrainMean: 0.62,
  },
  /**
   * **`Intensity` 軸の実寸（全層の共通倍率）。**
   *
   * 中立化で 3 本が持ち去っていた明るさが `Intensity` へ戻ってくるので、
   * 幅もそれに合わせて広げる（旧 0.6〜3.0）。**明るさを決めるのはこの 1 本だけ**
   * という状態にするための幅で、3 プリセットはどれも 0.30〜0.66 に収まる。
   */
  intensityRange: { min: 0.6, max: 3 },
  /** 核の楕円窓（この半径から外へ向けて 0 へ）。板の縁の手前で溶ける。 */
  coreWindow: { start: 0.58, end: 1.03 },
  /** 場の利得。音量の持続をそのまま輝度にすると暗すぎるので 1 本だけ通す。 */
  fieldGain: 1.6,
  /**
   * **場の下限。** 音が止まっても平滑は指数で近づくだけなので、厳密には 0 にならない。
   * ここを下回ったら 0 と見なす（**無音 = 黒**は「ほぼ黒」ではなく 1 枚も出ないこと）。
   */
  fieldFloor: 0.004,
  /**
   * **ハロの上限（種別ごと）。** `blur` 軸に掛けて散乱の量にする。
   * 面が大きい膜と靄は、広げると画面全体が濁るので載せない。
   */
  halo: {
    core: 0.55,
    beam: 0.3,
    fragment: 0.35,
    fan: 0.28,
    membrane: 0,
    haze: 0,
  },
  /**
   * **縁の締まり（`Edge contrast` / `Core focus`）の実寸。**
   *
   * どれも「軸 1 のときに何倍になるか」で、**軸 0 では厳密に 1 倍**（＝現状のまま）。
   * 可動域を片側へ伸ばすだけの足し方なので、既定値もプリセットも動かない。
   *
   * 実測の根拠は `ROADMAP.md` の P9-6。丸いハロ（`base + halo·exp(−r²·w)`）が
   * **核の裾のほぼ全部**を作っていた — 既定（blur 0.5）では半径 0.5 の位置で
   * 核の明るさ 0.106 のうち 0.106 がハロで、形そのものの寄与は 0.0007 しかない。
   */
  definition: {
    /** ハロの量（`Edge contrast` 1 で 15%）。0 にしないのは光り物の柔らかさを残すため。 */
    haloAtOne: 0.15,
    /** ハロの広がりを詰める倍率（指数に掛ける。3.6 倍で半径は 1/1.9）。 */
    haloTightenAtOne: 3.6,
    /** 核だけの追加のハロ削り（`Core focus` 1 で 18%）。 */
    coreHaloAtOne: 0.18,
    /** `softEdge` の窓幅（`Edge contrast` 1 で 1/6.25）。 */
    edgeWidthAtOne: 0.16,
    /** 種別ごとの局所ハロ（膜の帯・光条の芯が使う）の幅。 */
    kindHaloAtOne: 0.18,
    /** 多角形マスク（`Silhouette`）の縁の柔らかさ。 */
    maskSoftnessAtOne: 0.22,
    /** 素材（アトラス）のガンマを 1 へ寄せる倍率。筋と地の差が開く。 */
    grainGammaAtOne: 1.85,
    /**
     * **ガンマを立てたぶんの明るさの戻し。**
     * `pow(x, γ)` の γ を上げると素材が暗くなるので、その中央値ぶんを利得へ返す。
     * 実測で決めた値（`Edge contrast` 1 で平均輝度がほぼ動かない高さ）。
     */
    grainGainAtOne: 1.62,
    /** 核の超ガウス指数の伸び（半値半径は保つ）。 */
    coreSuperGaussAtOne: 1.5,
    /** 核の散乱片（`flakes`）の裾を詰める倍率。 */
    coreFlakeTightenAtOne: 3.2,
    /** ブルームの閾値の持ち上げと半径の詰め。 */
    bloomThresholdRise: 0.55,
    bloomRadiusAtOne: 0.2,
    /**
     * **明るさの中立化（縁を締めたぶんの戻し）。**
     *
     * 縁を締めると裾（こぼれた光）が消えるので、そのままでは軸が
     * **「シャープ」ではなく「暗い」として読める**（実測で 2 本とも 1 にすると
     * 平均輝度 38.4 → 16.4 ＝ 57% の目減り）。**明るさを決めるのは `Intensity` の
     * 1 本だけ**という状態を保つために、消えた裾のぶんを利得へ返す。
     *
     * 裾へこぼれていた光を形へ集め直すだけで、**天井（白の予算）は動かさない**。
     * 核の側が大きいのは、`Core focus` がブルームの寄与ごと畳むためである。
     */
    edgeGainAtOne: 1.75,
    coreFocusGainAtOne: 2.2,
  },
} as const;

const TAU = Math.PI * 2;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);
const clamp01 = (value: number): number => clamp(value, 0, 1);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
/** GLSL の同名関数と同じ形。両端で傾きが 0 になる滑らかな立ち上がり。 */
const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp01((value - edge0) / Math.max(edge1 - edge0, 1e-6));
  return t * t * (3 - 2 * t);
};

/** 決定論ハッシュ。同じ (seed, index) なら必ず同じ値。 */
export const hash01 = (seed: number, index: number): number => {
  let h = (Math.imul(seed | 0, 0x27d4eb2d) ^ Math.imul(index | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
};

/** その奥行きで画面に収まる範囲。 */
const halfExtent = (
  z: number,
  viewport: UnifiedViewport,
): { readonly w: number; readonly h: number } => {
  const h = Math.tan((UNIFIED.fieldOfView * Math.PI) / 360) * Math.abs(z);
  return { h, w: h * Math.max(viewport.aspectRatio, 1e-6) };
};

/**
 * **奥行きの割り当て。** `depthSpread` が 0 なら全部同じ面（平面）、
 * 1 なら Near〜Far に散る。**間の値では散らばりが連続に広がる。**
 */
const depthOf = (axes: UnifiedAxes, t: number): number => {
  const middle = (UNIFIED.depthNear + UNIFIED.depthFar) * 0.5;
  const spread = clamp01(axes.depthSpread);
  const near = mix(middle, UNIFIED.depthNear, spread);
  const far = mix(middle, UNIFIED.depthFar, spread);
  return -mix(near, far, clamp01(t));
};

/** 奥行きの手がかり（遠いほど暗い）。 */
export const depthDim = (z: number): number => {
  const t = clamp01((Math.abs(z) - UNIFIED.depthNear) / (UNIFIED.depthFar - UNIFIED.depthNear));
  return mix(1, UNIFIED.depthDimFar, t);
};

/**
 * **色。** `hueCoherence` が 0 なら要素ごとの seed 色、1 なら全体で 1 色相。
 * 途中は連続に混ざる（＝少しだけ色がばらけた 1 色相）。
 */
const hueOf = (axes: UnifiedAxes, globalHue: number, seed: number, index: number): number => {
  const seedHue = hash01(seed + 5171, index * 3 + 1);
  return (mix(seedHue, globalHue, clamp01(axes.hueCoherence)) + 1) % 1;
};

/**
 * **面内の漂い。** `motion` が 0 なら完全に静止する。
 * 位相は seed から決まるので、同じ音・同じ時刻なら必ず同じ場所にいる。
 */
const drift = (
  axes: UnifiedAxes,
  seed: number,
  index: number,
  time: number,
): { readonly x: number; readonly y: number } => {
  const amount = clamp01(axes.motion);
  if (amount <= 0) return { x: 0, y: 0 };
  const speed = 0.05 + hash01(seed + 811, index * 5 + 1) * 0.09;
  const phase = hash01(seed + 811, index * 5 + 2) * TAU;
  const phaseY = hash01(seed + 811, index * 5 + 3) * TAU;
  return {
    x: Math.sin(time * speed * TAU + phase) * 0.16 * amount,
    y: Math.cos(time * speed * TAU * 0.73 + phaseY) * 0.12 * amount,
  };
};

/**
 * **配置。** `spreadX/Y` が 0 なら中心に集まり、1 なら画面いっぱいに散る。
 * `anchorPull` は中心・骨格の軸へ引き戻す力で、散らばりの上に重ねて効く。
 */
const placeOf = (
  axes: UnifiedAxes,
  seed: number,
  index: number,
): { readonly nx: number; readonly ny: number } => {
  const a = hash01(seed, index * 7 + 1);
  const b = hash01(seed, index * 7 + 2);
  const nx = (a - 0.5) * 2 * clamp01(axes.spreadX);
  const ny = (b - 0.5) * 2 * clamp01(axes.spreadY);
  const pull = clamp01(axes.anchorPull);
  if (pull <= 0) return { nx, ny };
  // 軸へ引き寄せる: 近いほうの軸へ寄る（＝十字に沿う）。
  // **どちらが近いかを分岐で決めない** — 大きさの比で連続に重みを配るので、
  // |nx| と |ny| が入れ替わる境目でも位置は跳ばない。
  const sum = Math.abs(nx) + Math.abs(ny);
  const weight = sum > 1e-6 ? Math.abs(ny) / sum : 0.5;
  return {
    nx: mix(nx, 0, pull * weight),
    ny: mix(ny, 0, pull * (1 - weight)),
  };
};

/**
 * **傾き。** 旧 `Tilt` 軸を `Depth spread` が吸収したもの。
 *
 * 独立した軸として持っていたときの実測は平均輝度 9.14 → 8.84・広がり 0.1569 → 0.1595 で、
 * **画素の上ではほとんど見えなかった**。3 プリセットでも `Depth spread` と
 * 完全に同じ順（0.9 / 0.5 / 0.2 と 0.75 / 0.35 / 0.05）で動いており、
 * 「奥行きを散らす」と「面を傾ける」は 1 つの空間の軸だった。
 * 奥行き 0 なら正面のまま（＝旧 `Tilt` 0 と同じ）。
 */
const tiltOf = (
  axes: UnifiedAxes,
  seed: number,
  index: number,
): { readonly x: number; readonly y: number } => {
  const amount = clamp01(axes.depthSpread) * UNIFIED.tiltFromDepth;
  if (amount <= 0) return { x: 0, y: 0 };
  return {
    x: (hash01(seed + 3301, index * 3 + 1) - 0.5) * 1.1 * amount,
    y: (hash01(seed + 3301, index * 3 + 2) - 0.5) * 1.1 * amount,
  };
};

/**
 * **板の余白。** にじみ（`blur`）が広がるほど板を広げ、
 * 要素の裾が**板の縁に届かない**ようにする。届くと縁が四角い枠として見えてしまう。
 */
const padOf = (axes: UnifiedAxes): number => 1 + clamp01(axes.blur) * UNIFIED.padAtFullBlur;

/**
 * **にじみのハロ。** `blur` 軸が種別ごとの上限まで散乱を広げ、
 * `edgeContrast` がその量を削る（核はさらに `coreFocus` が削る）。
 *
 * どちらの軸も 0 では厳密に 1 倍なので、**現状の見え方は 1 画素も動かない**。
 */
const haloOf = (axes: UnifiedAxes, kind: keyof typeof UNIFIED.halo): number => {
  const d = UNIFIED.definition;
  const trim = mix(1, d.haloAtOne, clamp01(axes.edgeContrast));
  const coreTrim = kind === 'core' ? mix(1, d.coreHaloAtOne, clamp01(axes.coreFocus)) : 1;
  return clamp01(axes.blur) * UNIFIED.halo[kind] * trim * coreTrim;
};

/**
 * **枚数の段を消す。**
 *
 * 「何枚出すか」は整数なので、軸を動かすと必ず段になる。
 * そこで**最後の 1 枚だけを端数の明るさで出す**ことにして、
 * 画素の上では連続に増える（0.5 枚のときは半分の明るさで 1 枚）ようにする。
 */
const countFade = (wanted: number, index: number, count: number): number =>
  index === count - 1 ? clamp01(wanted - (count - 1)) : 1;

/**
 * **明滅の利得。** 層ごとに位相をずらし、off の側を `strobe` の深さだけ暗くする。
 * 0 で 1 倍（連続）・1 で完全に消える。**分岐ではなく係数**なので途中が実在する。
 */
const blinkOf = (
  axes: UnifiedAxes,
  drive: UnifiedDrive,
  kind: UnifiedKind,
  index: number,
): number => strobePhaseGain(axes.strobe, drive.tick, drive.seed, UNIFIED_KIND_INDEX[kind], index);

/**
 * **バーストの原点。** 核・十字（骨格）・閃光・扇はここを中心にする。
 * 画面中央に固定しない — 光が生まれた場所で十字が交差するのが自然だからで、
 * 居場所は**その打撃のシード**から決まるので決定論は保たれる。
 * `spreadX/Y` を 0 にすれば従来どおり真ん中へ戻る。
 */
const burstAnchor = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
  z: number,
): { readonly x: number; readonly y: number } => {
  const seed = Math.round(drive.beamSeed);
  const place = placeOf(axes, seed + 977, 1);
  const d = drift(axes, seed + 977, 1, drive.time);
  const e = halfExtent(z, viewport);
  return { x: (place.nx + d.x) * e.w * 0.7, y: (place.ny + d.y) * e.h * 0.7 };
};

/**
 * 光条の長さ。0 で短い光条、1 で画面の外まで貫通する。
 * **下限は 0 にしない** — 板の幅が 0 になると退化した四角形になる。
 * 「出さない」ことは長さではなく明るさ（`crossGain`）で作る。
 */
const beamReach = (axes: UnifiedAxes): number => mix(0.3, 2.8, clamp01(axes.beamLength));

/**
 * **十字の最小は「短い」ではなく「出ない」。**
 *
 * `Beam length` を絞りきっても、これまでは長さが 0.3 倍で残るだけで
 * **十字そのものは消えなかった**。ここで明るさに掛けることで、
 * 軸の 0 側が「短い十字」ではなく「十字が無い」になる。
 * 0.12 までの立ち上がりなので、プリセット（どれも 0.45 以上）では 1 のまま。
 */
const crossGain = (axes: UnifiedAxes): number => smoothstep(0, 0.12, clamp01(axes.beamLength));

/**
 * **バースト全体の向き。** 旧 `Cross rotation` 軸を `Cross angle` が吸収したもの。
 *
 * 原点を中心にする層（核・骨格・閃光・扇）の面内回転へ**一律に**足す角度なので、
 * どの層も同じだけ回る（十字はほどけない）。
 *
 * 軸として持っていたときは 3 プリセットも既定値も 0 のまま一度も使われず、
 * **作者が画の向きを決めるノブ**でもあった（D17 の恣意性の排除に反する）。
 * ここでは向きを**打撃のシード**に決めさせ、`Cross angle` が
 * 「どれだけ自由に振れてよいか」だけを持つ。軸 0 では厳密に 0 ＝ 従来の向き。
 */
const crossRoll = (axes: UnifiedAxes, seed: number): number =>
  (hash01(Math.round(seed) + 1301, 3) * 2 - 1) * Math.PI * clamp01(axes.crossAngle);

/**
 * **1 本ごとの向きのばらつき。**
 *
 * 0 なら上下左右のまま（十字）、1 なら ±π まで自由に散る。
 * どちらへ散るかは打撃のシードが決めるので、同じ音なら同じ向きになる。
 */
const crossSkew = (axes: UnifiedAxes, seed: number, index: number): number =>
  (hash01(Math.round(seed) + 900, index) * 2 - 1) * Math.PI * clamp01(axes.crossAngle);

/**
 * **閃光の性格（核の形状族ごと）。** [長さ, 太さ, ハローの利得]。
 * Lab 2 の `ARM_STYLE` をそのまま引き継ぐ。族 0 は従来と同じ値なので、
 * 既定の見え方は変わらない。
 */
const ARM_STYLE: readonly (readonly [number, number, number])[] = [
  [1, 1, 0.1], // 十字フレア: 標準
  [1.35, 0.6, 0.06], // 縦スパイク: 細く長い
  [0.9, 1.5, 0.14], // 横フレア: 太く短い
  [0.55, 0.9, 0.18], // コンパクト: 短く芯寄り
];

/**
 * **核が自分で描く貫通線（十字）の明るさ。**
 *
 * 核の中の縦横の線は、これまで `Beam length` にも `Skeleton` にも繋がっておらず、
 * **どちらを 0 にしても核の十字だけが残っていた**。両方に連動させて穴を塞ぐ。
 * `Skeleton` 側も 0.1 までで立ち上がるので、プリセット（最小 0.12）では 1 のまま。
 */
const coreCrossGain = (axes: UnifiedAxes): number =>
  crossGain(axes) * smoothstep(0, 0.1, clamp01(axes.skeleton));

/** 光条の向き（ローカル +x をこの向きへ）。 */
const BEAM_DIRECTIONS: readonly { readonly bit: number; readonly spin: number }[] = [
  { bit: 2, spin: 0 },
  { bit: 1, spin: Math.PI / 2 },
  { bit: 8, spin: Math.PI },
  { bit: 4, spin: -Math.PI / 2 },
];

/**
 * **核の大きさ。**
 *
 * 軸は足さない。**その打撃のシード**が大小を決め、`blur` が分布を寄せる。
 * にじみ側では大きく滲んだ塊が出やすく、シャープ側では小さく強い点が出やすい。
 * ＝ **同じ設定のまま**、あるときは画面を占める光の塊、あるときは針の先の白熱になる。
 */
const coreSize = (axes: UnifiedAxes, seed: number): number => {
  const blur = clamp01(axes.blur);
  const draw = hash01(seed + 4111, 5);
  // 指数で分布を寄せる: シャープ側は 3.4 乗で小さい側へ、にじみ側は 0.75 乗で大きい側へ。
  const t = Math.pow(draw, mix(3.4, 0.75, blur));
  const range = coreSizeRange(axes);
  return mix(range.small, range.large, t);
};

/** `Core size` 軸から大小の幅を出す。既定 0.4 で従来の 0.20 / 2.30 を通る。 */
const coreSizeRange = (axes: UnifiedAxes): { readonly small: number; readonly large: number } => {
  const a = UNIFIED.coreSizeAxis;
  const s = clamp01(axes.coreSize);
  return {
    small: mix(a.smallAtZero, a.smallAtOne, Math.pow(s, a.smallCurve)),
    large: mix(a.largeAtZero, a.largeAtOne, Math.pow(s, a.largeCurve)),
  };
};

/** 核の形状族ごとの [族, 横フレア, 縦スパイク, 芯の強さ]。 */
const CORE_SHAPE_PARAMS: readonly (readonly [number, number, number, number])[] = [
  [0, 0.5, 0.5, 1],
  [1, 0.14, 0.92, 0.92],
  [2, 0.92, 0.14, 0.92],
  [3, 0.1, 0.1, 1.4],
];

/**
 * **靄の明るさの曲げ（明るさの中立化）。**
 *
 * 靄は画面全体を覆う 1 枚なので、明るさがそのまま画面の平均輝度になる
 * （実測で 1 段あたり 8.2 ＝ 全軸で 3 位）。上側だけを圧縮して、
 * `Intensity` と張り合わないようにする。**0 での傾きは 1** なので軸の根元は変わらず、
 * `hazeFloor = 0` はこれまでどおり厳密に「靄なし」のままである。
 */
const hazeGain = (floor: number): number => {
  const f = clamp01(floor);
  const k = UNIFIED.neutral.hazeCompression;
  const reference = clamp01(UNIFIED.neutral.hazeReference);
  // 基準点で 1 に戻す（既定のままなら中立化の前後で靄の濃さが変わらない）。
  const normalise = 1 + (k - 1) * reference;
  return (f / (1 + (k - 1) * f)) * normalise;
};

/**
 * **靄。** 画面をまとめる最下段。`hazeFloor` が量を決める。
 * `blur` が縁の柔らかさを、`depthSpread` が奥行きを決める。
 */
const buildHaze = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
): UnifiedLayer[] => {
  const floor = clamp01(axes.hazeFloor);
  const level = clamp01(drive.fieldLevels.haze) * hazeGain(floor);
  if (level <= 0) return [];
  const z = depthOf(axes, 1);
  const e = halfExtent(z, viewport);
  const d = drift(axes, drive.seed, 91, drive.time);
  return [
    {
      kind: 'haze',
      position: [d.x * e.w, d.y * e.h, z],
      half: [e.w * 1.3, e.h * 1.3],
      spin: 0,
      tiltX: 0,
      tiltY: 0,
      hue: hueOf(axes, drive.hue, drive.seed, 91),
      hueSpan: 0.05,
      ...hueRamp(axes, hueOf(axes, drive.hue, drive.seed, 91), 0.05, drive.seed, 91),
      gradientForm: 1,
      intensity: 0.2 * level * depthDim(z) * blinkOf(axes, drive, 'haze', 0),
      // [減衰, 縁の始まり, 縁の終わり, 分光の深さ]
      // 圧縮したぶんは裾へ回す。**減衰を小さくすると靄が遠くまで届く** ので、
      // 軸の上側は「明るい靄」ではなく「厚く広がった靄」として読める。
      shape: [
        mix(2.6, 1.4, clamp01(axes.blur)) * mix(1, UNIFIED.neutral.hazeReach, floor),
        0.32,
        0.78,
        0.55,
      ],
      edge: clamp01(axes.blur),
      halo: haloOf(axes, 'haze'),
      pad: padOf(axes),
      character: 0,
      material: materialOf(axes, 'haze', drive.seed, 91),
      whiteAllowed: false,
      ceiling: UNIFIED.hazeCeiling,
      channel: [1.2, 1.5, 0.04, 0.35],
    },
  ];
};

/**
 * **1 要素の中の色の旅。**
 *
 * `hueDepth` が 0 なら `hue` から `hueSpan` ぶんまっすぐ走るだけで、彩度も一定
 * ＝ 従来とまったく同じ並び（4 点の線形補間は 1 本の直線に戻る）。
 * 1 では幅が半周まで広がり、途中で折り返し、彩度が白 → 色 / 色 → 白 に振れる。
 * どちらの端も同じ 1 本の式の中の係数なので、途中の値も実在する。
 */
const hueRamp = (
  axes: UnifiedAxes,
  baseHue: number,
  baseSpan: number,
  seed: number,
  index: number,
): {
  readonly hues: [number, number, number, number];
  readonly saturations: [number, number, number, number];
} => {
  const depth = clamp01(axes.hueDepth);
  const travel = UNIFIED.hueTravel;
  const h = (salt: number): number => hash01(Math.round(seed) + 6151, index * 19 + salt);
  const direction = h(1) < 0.5 ? -1 : 1;
  const span = mix(baseSpan, travel.spanAtFullDepth * direction, depth);
  // 折り返す要素だけが山形になる。どれが折り返すかは seed、どれだけ折り返すかは軸。
  const turn = h(2) < travel.turnProbability ? depth : 0;
  const mode = h(3);
  const hues: number[] = [];
  const saturations: number[] = [];
  for (let i = 0; i < 4; i++) {
    const u = i / 3;
    const walk = mix(u, 1 - Math.abs(u * 2 - 1), turn);
    hues.push(baseHue + span * walk);
    const white = travel.whiteEnd;
    const ramp =
      mode < travel.flatProbability
        ? 1
        : mode < travel.flatProbability + (1 - travel.flatProbability) * 0.5
          ? mix(white, 1, u)
          : mix(1, white, u);
    saturations.push(UNIFIED.tintDepth * mix(1, ramp, depth));
  }
  return {
    hues: [hues[0]!, hues[1]!, hues[2]!, hues[3]!],
    saturations: [saturations[0]!, saturations[1]!, saturations[2]!, saturations[3]!],
  };
};

/**
 * **素材の読み方を 1 層ぶん作る。**
 *
 * タイル・クロップ・回転・反転をすべて要素ごとの seed から引くので、
 * 同じ素材でも別の切り口・別の向きで出る（10 枚を切り替えているようには見えない）。
 * 量は `textureGrain` 軸 × 種別の重みで、0 なら素材を 1 画素も読まない。
 */
const materialOf = (
  axes: UnifiedAxes,
  kind: UnifiedKind,
  seed: number,
  index: number,
  band?: string,
): UnifiedMaterial => {
  const g = UNIFIED.grain;
  const h = (salt: number): number => hash01(Math.round(seed) + 2213, index * 13 + salt);
  const halfCrop = mix(g.cropMinimum, g.cropMaximum, h(1));
  const margin = 0.02;
  const centre = (value: number): number =>
    halfCrop + margin + value * Math.max(1 - halfCrop * 2 - margin * 2, 0);
  const angle = h(4) * TAU;
  const roles =
    band && UNIFIED.rolesByBand[band] ? UNIFIED.rolesByBand[band]! : UNIFIED.rolesByKind[kind];
  return {
    roles,
    pick: h(7),
    crop: [centre(h(2)), centre(h(3)), halfCrop, halfCrop],
    orient: [Math.cos(angle), Math.sin(angle), h(5) < 0.5 ? -1 : 1, h(6) < 0.5 ? -1 : 1],
    grain: clamp01(axes.textureGrain) * UNIFIED.grainByKind[kind],
    maskPick: h(9),
    maskAmount: clamp01(axes.silhouette) * UNIFIED.silhouetteByKind[kind],
    sourceTint: mix(g.tintKeepMinimum, g.tintKeepMaximum, h(8)),
  };
};

/**
 * **膜の半径。** `membraneScale` が 0 なら可視範囲から逆算、1 ならワールド固定。
 *
 * 可視範囲で割ると、**奥の膜も手前の膜も画面の同じ割合を占める** ＝ 遠近が相殺され、
 * 板の集合が 1 枚の平面に見えてしまう。ワールド固定側では手前は画面を越え、
 * 奥は小さく写るので、同じ枚数でも空間の層として読める。
 * 両端は連続に混ざるので、途中は「少しだけ遠近が生き始めた膜」になる。
 */
const membraneHalf = (
  axes: UnifiedAxes,
  extent: { readonly w: number; readonly h: number },
  wide: number,
  share: number,
): { readonly w: number; readonly h: number; readonly lightRatio: number } => {
  const scale = clamp01(axes.membraneScale);
  const world = UNIFIED.membraneWorldHalf;
  const reference = clamp01(UNIFIED.neutral.membraneReference);
  const sizeAt = (s: number): { readonly w: number; readonly h: number } => ({
    w: mix(extent.w, world, s) * wide * mix(0.5, 1.05, share),
    h: mix(extent.h * mix(0.28, 0.7, share), world * mix(0.4, 0.95, share), s),
  });
  const here = sizeAt(scale);
  const base = sizeAt(reference);
  // 光る面積の比 = 板の面積 × 帯の太さ。**基準点で 1** になるよう割る。
  const area = (here.w * here.h) / Math.max(base.w * base.h, 1e-9);
  const band = membraneBand(scale) / membraneBand(reference);
  return { w: here.w, h: here.h, lightRatio: Math.max(area * band, 1e-6) };
};

/**
 * **帯の太さの期待値。** 1 枚ごとの半幅は `mix(0.24,0.5,s) + h × mix(0.26,0.5,s)` で、
 * `h` は 0〜1 の一様な決定論ハッシュなので期待値は下の式になる。
 * 光る面積の比を出すためだけに使う（形そのものは各 build が決める）。
 */
const membraneBand = (scale: number): number => mix(0.24, 0.5, scale) + 0.5 * mix(0.26, 0.5, scale);

/**
 * **膜の明るさの補償（明るさの中立化）。**
 *
 * `Membrane scale` は板の面積と帯の太さを同時に広げるので、
 * 補償しないと総光量が跳ね上がる（実測で 1 段あたり 13.2 ＝ 全 35 軸で最大）。
 * 広がったぶんだけ割り戻して、**軸は遠近の効き方だけを変える**ようにする。
 * 指数 0 で従来どおり、1 で「面積 × 明るさ」が保存される。
 * 比は基準点で 1 になるよう作ってあり、そこへ従来の濃さ（基準点での `mix(1, 2.1, s)`）
 * を掛け戻すので、**既定のままなら中立化の前後で 1 画素も変わらない**。
 */
const membraneLightGain = (lightRatio: number): number =>
  mix(1, 2.1, clamp01(UNIFIED.neutral.membraneReference)) *
  Math.pow(Math.max(lightRatio, 1e-6), -UNIFIED.neutral.membraneArea);

/**
 * **膜。** Sheet・カーテン・マクロ膜をまとめた語。
 * `membraneBeam` が 0 に近いほど枚数と厚みが増える（膜が優勢）。
 */
const buildMembranes = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
): UnifiedLayer[] => {
  const level = clamp01(drive.fieldLevels.membrane);
  // 性格の軸。膜側（0）で多く厚く、光条側（1）で少なく薄くなる。
  const share = 1 - clamp01(axes.membraneBeam);
  const scale = clamp01(axes.membraneScale);
  // **明るさの配分。** 0 で固定のリグだけ、1 で打撃の膜だけ。途中は両方が出る。
  const eventShare = clamp01(axes.eventMembrane);
  const out: UnifiedLayer[] = [];
  const fixedShare = 1 - eventShare;
  if (level > 0 && fixedShare > 0) {
    out.push(...buildFixedMembranes(drive, axes, viewport, share, scale, fixedShare, level));
  }
  if (eventShare > 0) {
    out.push(...buildEventMembranes(drive, axes, viewport, share, scale, eventShare));
  }
  return out;
};

/**
 * **打撃ごとに生まれて死ぬ膜。**
 *
 * 固定のリグの膜は曲に関係なく同じ場所に居続けるので、音が変わっても絵が変わらない。
 * ここは 1 つの打撃が 2〜5 枚の膜を生み、遅れて開いて、寿命が尽きたら消える
 * （寿命と枚数は表現側のプールが決め、この関数は**その時点の姿を組み立てるだけ**）。
 */
const buildEventMembranes = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
  share: number,
  scale: number,
  eventShare: number,
): UnifiedLayer[] => {
  const out: UnifiedLayer[] = [];
  for (const born of drive.membranes) {
    const gain = clamp01(born.gain);
    if (gain <= 0) continue;
    const seed = Math.round(born.seed);
    const slot = born.slot;
    const h = (salt: number): number => hash01(seed + 4409, slot * 17 + salt);
    const z = depthOf(axes, mix(0.05, 0.95, h(1)));
    const e = halfExtent(z, viewport);
    const place = placeOf(axes, seed, slot * 3 + 1);
    const d = drift(axes, seed, slot, drive.time);
    const tilt = tiltOf(axes, seed + 4409, slot);
    const wide = 0.5 + h(2) * 0.7;
    const size = membraneHalf(axes, e, wide, share);
    out.push({
      kind: 'membrane',
      position: [(place.nx + d.x) * e.w * 0.85, (place.ny + d.y) * e.h * 0.7, z],
      half: [size.w, size.h],
      spin: (h(3) - 0.5) * TAU * 0.5,
      tiltX: tilt.x,
      tiltY: tilt.y,
      hue: hueOf(axes, drive.hue, seed, slot * 3 + 2),
      hueSpan: 0.13,
      ...hueRamp(axes, hueOf(axes, drive.hue, seed, slot * 3 + 2), 0.13, seed + 4409, slot),
      gradientForm: Math.floor(h(4) * 4),
      intensity:
        // **1 枚は固定の膜より淡い。** 打撃ごとに何枚も重なるので、
        // 同じ濃さで出すと画面が塗りになる。濃いのは重なった場所だけ。
        (0.1 + 0.13 * share) *
        UNIFIED.eventMembraneScale *
        // **明るさの中立化。** 広がったぶんだけ割り戻す（軸 0 では 1）。
        membraneLightGain(size.lightRatio) *
        mix(0.55, 1.25, clamp01(born.strength)) *
        gain *
        eventShare *
        depthDim(z) *
        blinkOf(axes, drive, 'membrane', slot),
      // [形状族, 襞の周期, 帯の半幅, 折れ]
      shape: [
        Math.floor(h(5) * 3),
        3 + h(6) * 8,
        mix(0.24, 0.5, scale) + h(7) * mix(0.26, 0.5, scale),
        (h(8) - 0.5) * 0.9,
      ],
      edge: clamp01(axes.blur),
      halo: haloOf(axes, 'membrane'),
      pad: padOf(axes),
      character: 0,
      material: materialOf(axes, 'membrane', seed, slot, born.band),
      whiteAllowed: false,
      ceiling: mix(UNIFIED.membraneCeiling, UNIFIED.membraneCeilingWide, scale),
      channel: [1.3, 1.5, 0.045, 0.28],
    });
  }
  return out;
};

/** 固定のリグの膜（従来の作り）。`eventMembrane` が 1 なら 1 枚も出ない。 */
const buildFixedMembranes = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
  share: number,
  scale: number,
  fixedShare: number,
  level: number,
): UnifiedLayer[] => {
  const wanted = mix(1, UNIFIED.membraneCount, share);
  const count = Math.max(Math.ceil(wanted), 1);
  const out: UnifiedLayer[] = [];
  const seed = Math.round(drive.seed);
  for (let index = 0; index < count; index++) {
    const t = count > 1 ? index / (count - 1) : 0.5;
    const z = depthOf(axes, mix(0.35, 0.9, t));
    const e = halfExtent(z, viewport);
    const place = placeOf(axes, seed + 613, index);
    const d = drift(axes, seed + 613, index, drive.time);
    const tilt = tiltOf(axes, seed + 613, index);
    const family = hash01(seed + 613, index * 11 + 5);
    const wide = 0.5 + hash01(seed + 613, index * 11 + 6) * 0.7;
    const size = membraneHalf(axes, e, wide, share);
    out.push({
      kind: 'membrane',
      position: [(place.nx + d.x) * e.w * 0.8, (place.ny + d.y) * e.h * 0.6, z],
      half: [size.w, size.h],
      spin: (hash01(seed + 613, index * 11 + 7) - 0.5) * 1.4,
      tiltX: tilt.x,
      tiltY: tilt.y,
      hue: hueOf(axes, drive.hue, seed, index * 3 + 2),
      hueSpan: 0.11,
      ...hueRamp(axes, hueOf(axes, drive.hue, seed, index * 3 + 2), 0.11, seed + 613, index),
      gradientForm: 2,
      intensity:
        (0.1 + 0.13 * share) *
        // **明るさの中立化。** 広がったぶんだけ割り戻す（軸 0 では 1）。
        membraneLightGain(size.lightRatio) *
        fixedShare *
        level *
        depthDim(z) *
        blinkOf(axes, drive, 'membrane', index) *
        countFade(wanted, index, count),
      // [形状族, 襞の周期, 帯の半幅, 折れ]
      shape: [
        Math.floor(family * 3),
        3 + hash01(seed + 613, index * 11 + 8) * 8,
        // 帯の厚みも軸に連動。大きい板を細い帯で切ると線にしか見えない。
        mix(0.24, 0.5, scale) + hash01(seed + 613, index * 11 + 9) * mix(0.26, 0.5, scale),
        (hash01(seed + 613, index * 11 + 10) - 0.5) * 0.9,
      ],
      edge: clamp01(axes.blur),
      halo: haloOf(axes, 'membrane'),
      pad: padOf(axes),
      character: 0,
      material: materialOf(axes, 'membrane', seed + 613, index),
      whiteAllowed: false,
      ceiling: mix(UNIFIED.membraneCeiling, UNIFIED.membraneCeilingWide, scale),
      channel: [1.3, 1.5, 0.045, 0.28],
    });
  }
  return out;
};

/**
 * **光条。** 針・Ray・アーム・骨格の軸を 1 つの語にまとめたもの。
 *
 * 2 種類が連続に混ざる:
 *   常設の軸（`skeleton` 軸が存在感を決める。音量で光る）
 *   出来事に同期した閃光（`beamMask` の向きへ伸びる）
 */
const buildBeams = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
): UnifiedLayer[] => {
  const out: UnifiedLayer[] = [];
  const level = clamp01(drive.fieldLevels.beam);
  const share = clamp01(axes.membraneBeam);
  const skeleton = clamp01(axes.skeleton);
  const z = depthOf(axes, 0.32);
  const e = halfExtent(z, viewport);
  const anchor = burstAnchor(drive, axes, viewport, z);
  // 貫通させるときは、原点が端に寄っていても画面を突き抜ける長さが要る。
  const reach =
    (Math.max(e.w, e.h) + Math.max(Math.abs(anchor.x), Math.abs(anchor.y))) * beamReach(axes);

  // ---- 常設の軸（骨格）。`skeleton` か `Beam length` が 0 なら 1 枚も出ない ----
  const cross = crossGain(axes);
  const roll = crossRoll(axes, drive.beamSeed);
  if (level > 0 && skeleton > 0 && cross > 0) {
    const widths: readonly [number, number, number][] = [
      [0.012, 0.05, 0.36],
      [0.02, 0.06, 0.3],
      [0.1, 0.006, 0.1],
    ];
    for (let index = 0; index < widths.length; index++) {
      const w = widths[index]!;
      out.push({
        kind: 'beam',
        position: [anchor.x, anchor.y, z],
        half: [reach, index === 0 ? 0.34 : index === 1 ? 0.3 : 0.9],
        spin: (index === 0 ? Math.PI / 2 : 0) + roll + crossSkew(axes, drive.beamSeed, index),
        tiltX: 0,
        tiltY: 0,
        hue: hueOf(axes, drive.hue, drive.seed, 40 + index),
        hueSpan: 0.05 + index * 0.02,
        ...hueRamp(
          axes,
          hueOf(axes, drive.hue, drive.seed, 40 + index),
          0.05 + index * 0.02,
          drive.seed,
          40 + index,
        ),
        gradientForm: 2,
        intensity:
          w[2] *
          level *
          skeleton *
          cross *
          mix(0.7, 1.15, share) *
          blinkOf(axes, drive, 'beam', index),
        shape: [w[0], w[1], 0, 0],
        edge: clamp01(axes.blur),
        halo: haloOf(axes, 'beam'),
        pad: padOf(axes),
        character: 0,
        material: materialOf(axes, 'beam', drive.seed, 40 + index),
        whiteAllowed: false,
        ceiling: UNIFIED.nonCoreCeiling,
        channel: [1, 1, 0.02, 0.12],
      });
    }
  }

  // ---- 出来事に同期した閃光 ----
  const power = clamp01(drive.beamStrength);
  const mask = Math.round(drive.beamMask);
  if (mask !== 0 && power > 0 && cross > 0) {
    const seed = Math.round(drive.beamSeed);
    for (let index = 0; index < BEAM_DIRECTIONS.length; index++) {
      const direction = BEAM_DIRECTIONS[index]!;
      if ((mask & direction.bit) === 0) continue;
      const a = hash01(seed, index * 3 + 1);
      const b = hash01(seed, index * 3 + 2);
      // 閃光の質は**核の形状族**が決める（役割が重複しない）。族 0 は従来と同じ値。
      const family = Math.round(drive.coreShape);
      const style = ARM_STYLE[family >= 0 && family < ARM_STYLE.length ? family : 0]!;
      const length =
        1.55 *
        style[0] *
        (0.78 + 0.44 * a) *
        (0.62 + 0.6 * power) *
        mix(0.7, 1.5, share) *
        beamReach(axes);
      const thickness = 0.06 * style[1] * (0.85 + 0.3 * b) * mix(1.4, 0.7, share);
      out.push({
        kind: 'beam',
        position: [anchor.x, anchor.y, z - 0.02],
        half: [length, thickness],
        spin: direction.spin + roll + crossSkew(axes, seed, index + 4),
        tiltX: 0,
        tiltY: 0,
        hue: hueOf(axes, drive.hue, seed, index),
        hueSpan: 0.07,
        ...hueRamp(axes, hueOf(axes, drive.hue, seed, index), 0.07, seed, index),
        gradientForm: 0,
        intensity:
          (0.5 + 0.85 * power) * (0.82 + 0.3 * a) * cross * blinkOf(axes, drive, 'beam', index + 3),
        shape: [0.22, style[2], 0.2 + 0.25 * b, 1],
        edge: clamp01(axes.blur),
        halo: haloOf(axes, 'beam'),
        pad: padOf(axes),
        // 光条では「性格」は片側かどうかを表す。閃光は**片側だけ**へ伸びる
        // （両側で描くと 4 本が中心で重なり、点が 4 重に強調される）。
        character: 1,
        material: materialOf(axes, 'beam', seed, index),
        whiteAllowed: false,
        ceiling: UNIFIED.beamCeiling,
        channel: [1, 1, 0.02, 0.1],
      });
    }
  }
  return out;
};

/**
 * **核。** 白へ届いてよい唯一の層。
 *
 * 位置も `spreadX/Y` と `anchorPull` に従う。**中心に固定しない**のは、
 * 空間に散る側の見え方では白熱もあちこちで起きるからで、
 * 軸を 0 にすれば従来どおり画面の真ん中に戻る（打撃ごとの居場所は
 * その打撃のシードから決まるので決定論）。
 */
const buildCore = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
): UnifiedLayer[] => {
  const pulse = clamp01(drive.corePulse);
  if (pulse <= 0) return [];
  const index = Math.round(drive.coreShape);
  const shape =
    index >= 0 && index < CORE_SHAPE_PARAMS.length
      ? CORE_SHAPE_PARAMS[index]!
      : ([-1, 0, 0, 1] as const);
  const a = UNIFIED.coreSizeAxis;
  const grow = clamp01(axes.coreSize);
  const z = depthOf(axes, 0.25);
  const anchor = burstAnchor(drive, axes, viewport, z);
  const seed = Math.round(drive.beamSeed);
  const base = coreSize(axes, seed) * mix(0.8, 1.15, pulse);
  const cross = coreCrossGain(axes);
  const roll = crossRoll(axes, drive.beamSeed);
  const form = clamp01(axes.coreShape);
  /**
   * **板の枚数。** 中心を 1 枚の点で描くと、どれだけ広げても「大きな点」にしかならない。
   * 大きい側では 1 → 3 枚を少しずつずらして重ね、**面として**光らせる。
   * 既定（0.4）では 1 枚のままなので、従来と 1 画素も変わらない。
   */
  const wanted = 1 + (a.plateCountMaximum - 1) * smoothstep(a.plateGrowthFrom, 1, grow);
  const count = Math.max(Math.ceil(wanted), 1);
  const out: UnifiedLayer[] = [];
  for (let index = 0; index < count; index++) {
    const h = (salt: number): number => hash01(seed + 5303, index * 7 + salt);
    // 2 枚目以降は少し小さく、少しずれる。1 枚目は従来とまったく同じ位置と大きさ。
    const shrink = index === 0 ? 1 : mix(1, a.plateSizeFalloff, h(1));
    const size = base * shrink;
    const spread = index === 0 ? 0 : a.plateOffset * size;
    /**
     * **薄め方。** `0.2 / size` は大きさをちょうど打ち消すので、これまでは
     * 広げても白くならなかった。指数を `Core size` に載せ、大きい側では薄め方を弱める。
     */
    const dilute = Math.pow(
      Math.min(UNIFIED.coreSmall / Math.max(size, 1e-3) + 0.1, 1),
      mix(a.diluteCurveAtZero, a.diluteCurveAtOne, grow),
    );
    out.push({
      kind: 'core',
      position: [
        anchor.x + (h(2) - 0.5) * 2 * spread,
        anchor.y + (h(3) - 0.5) * 2 * spread,
        z - index * 0.01,
      ],
      half: [size * mix(1, UNIFIED.coreShapeAxis.wide, form), size * mix(1, UNIFIED.coreShapeAxis.tall, form)],
      // 核の中の十字は板ごと回す（斜めの十字が作れる）。
      spin: roll + crossSkew(axes, seed, 20 + index),
      tiltX: 0,
      tiltY: 0,
      hue: drive.hue,
      hueSpan: 0.08,
      ...hueRamp(axes, drive.hue, 0.08, drive.beamSeed, 5 + index),
      gradientForm: 1,
      intensity:
        mix(0.4, 1.55, pulse) *
        dilute *
        blinkOf(axes, drive, 'core', index) *
        countFade(wanted, index, count),
      // [形状族, 横フレア, 縦スパイク, 芯の強さ]。フレアは十字なので軸に連動させる。
      shape: [shape[0], shape[1] * cross, shape[2] * cross, shape[3]],
      edge: clamp01(axes.blur),
      // 大きい塊にさらに広いハロを足すと画面が白く埋まる。半径で割り戻す。
      halo: haloOf(axes, 'core') * Math.min((UNIFIED.coreSmall * 2.4) / Math.max(size, 1e-3), 1),
      pad: padOf(axes),
      // 核では「性格」は点 ⇄ 面（頂の平らさ）を表す。
      character: form,
      material: materialOf(axes, 'core', drive.beamSeed, 5 + index),
      whiteAllowed: true,
      ceiling: 1,
      channel: [1, 1, 0, 0],
    });
  }
  return out;
};

/**
 * **破片。** 4 つの形状族。量は `Density` 1 本が決める。
 *
 * 旧 `Fragments` 軸は `Density` と**数式が完全な積**だった
 *（`fragmentCount × fragments × mix(0.5, 2.2, density)`）ので、
 * 同じ量を 2 本のつまみで別々に触っている状態だった。
 * 3 プリセットでも 0.55〜0.60 とほとんど動いていない（レンジ 0.05）。
 * ここでは濃さを定数へ焼き込み、**枚数は `Density` の下限を 0 まで下げて**
 * 「破片を出さない」（旧 `Fragments = 0`）も引き続き出せるようにする。
 */
const buildFragments = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
): UnifiedLayer[] => {
  const amount = UNIFIED.fragmentAmount;
  if (drive.fragments.length === 0) return [];
  const wanted =
    UNIFIED.fragmentCount * amount * mix(0, UNIFIED.fragmentDensityAtOne, clamp01(axes.density));
  if (wanted <= 0) return [];
  const limit = Math.max(Math.ceil(wanted), 1);
  const out: UnifiedLayer[] = [];
  let placed = -1;
  for (const spawn of drive.fragments.slice(0, limit)) {
    placed += 1;
    // 時間軸が完全に落とした破片は 1 画素も置かない（off ティックの消灯もここを通る）。
    if (clamp01(spawn.gain) <= 0) continue;
    const seed = spawn.seed;
    const slot = spawn.slot;
    const b = hash01(seed, slot * 7 + 2);
    const z = depthOf(axes, mix(0.1, 0.85, b));
    const e = halfExtent(z, viewport);
    const place = placeOf(axes, seed, slot);
    const d = drift(axes, seed, slot, drive.time);
    const tilt = tiltOf(axes, seed, slot);
    const aim = spawn.aim;
    const pull = clamp01(spawn.pull ?? 0);
    const nx = aim ? mix(place.nx, aim[0], pull) : place.nx;
    const ny = aim ? mix(place.ny, aim[1], pull) : place.ny;
    const c = hash01(seed, slot * 7 + 3);
    const dd = hash01(seed, slot * 7 + 4);
    const h = hash01(seed, slot * 7 + 7);
    const g = hash01(seed, slot * 7 + 6);
    const family = (slot + (g > 0.72 ? 1 : 0)) % UNIFIED_FRAGMENT_FAMILIES.length;
    const size = (0.2 + dd * 0.4) * (Math.abs(z) / 6);
    // 羽毛・筋の側では板そのものが長く伸びる（引っ掻き傷の形になる）。
    const character = clamp01(axes.fragmentCharacter);
    const stretch =
      (family === 1 ? 2.1 + h * 1.5 : family === 2 ? 1.1 + h * 0.7 : 0.85 + h * 0.5) *
      mix(1, 3.6, character);
    out.push({
      kind: 'fragment',
      position: [(nx + d.x) * e.w, (ny + d.y) * e.h, z],
      half: [size * stretch, size / Math.sqrt(stretch)],
      spin: hash01(seed, slot * 7 + 5) * TAU,
      tiltX: tilt.x,
      tiltY: tilt.y,
      hue: hueOf(axes, drive.hue, seed, slot),
      hueSpan: 0.1,
      ...hueRamp(axes, hueOf(axes, drive.hue, seed, slot), 0.1, seed, slot),
      gradientForm: 3,
      intensity:
        (0.14 + c * 0.13) *
        (0.62 + 0.5 * clamp01(spawn.strength)) *
        clamp01(spawn.gain) *
        amount *
        depthDim(z) *
        blinkOf(axes, drive, 'fragment', slot) *
        countFade(wanted, placed, limit) *
        // 筋は面積が広がるぶん薄い。塗りにならないように。
        mix(1, 0.78, clamp01(axes.fragmentCharacter)),
      // [縁, 形状族, 伸び, 欠け]
      shape: [0.34, family, 0.75 + h * 0.6, 0.04 + dd * 0.2],
      edge: clamp01(axes.blur),
      halo: haloOf(axes, 'fragment'),
      pad: padOf(axes),
      character,
      material: materialOf(axes, 'fragment', seed, slot, spawn.band),
      whiteAllowed: false,
      ceiling: UNIFIED.nonCoreCeiling,
      channel: [1.4, 1.6, 0.05, 0.3],
    });
  }
  return out;
};

/** **扇。** 強い出来事のときだけ開く放射。 */
const buildFan = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
): UnifiedLayer[] => {
  const gate = clamp01(drive.fanPower);
  if (gate <= 0) return [];
  const seed = Math.round(drive.fanSeed);
  const a = seed >= 0 ? hash01(seed, 101) : 0.5;
  const b = seed >= 0 ? hash01(seed, 102) : 0.5;
  const c = seed >= 0 ? hash01(seed, 103) : 0.5;
  const z = depthOf(axes, 0.3);
  const anchor = burstAnchor(drive, axes, viewport, z);
  return [
    {
      kind: 'fan',
      position: [anchor.x, anchor.y, z],
      half: [2.5 * mix(0.82, 1, gate), 2.5 * mix(0.82, 1, gate)],
      spin: crossRoll(axes, drive.beamSeed),
      tiltX: 0,
      tiltY: 0,
      hue: hueOf(axes, drive.hue, seed, 3),
      hueSpan: 0.13,
      ...hueRamp(axes, hueOf(axes, drive.hue, seed, 3), 0.13, seed, 3),
      gradientForm: 3,
      intensity: 0.44 * gate * blinkOf(axes, drive, 'fan', 0),
      // [基準角, 広がり, 本数, 到達]。基準角は板ローカルなので、板ごと回すぶんを打ち消さない
      // よう**ここにも足す**（扇の開く向きが `Cross rotation` に付いてくる）。
      shape: [
        -1.42 + (a - 0.5) * 0.5 + crossRoll(axes, drive.beamSeed),
        0.82 + (b - 0.5) * 0.4,
        3.2 + (c - 0.5) * 1.2,
        mix(0.46, 0.66, gate),
      ],
      edge: clamp01(axes.blur),
      halo: haloOf(axes, 'fan'),
      pad: padOf(axes),
      character: 0,
      material: materialOf(axes, 'fan', seed, 3),
      whiteAllowed: false,
      ceiling: UNIFIED.nonCoreCeiling,
      channel: [1.3, 1.4, 0.04, 0.22],
    },
  ];
};

/**
 * 統合の光学系を組み立てる。**軸はすべて式の中の係数**として効いており、
 * どこにも「この軸が 0.5 を超えたら別の絵」という分岐は無い。
 */
export const buildUnifiedRig = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
): UnifiedLayer[] => [
  ...buildHaze(drive, axes, viewport),
  ...buildMembranes(drive, axes, viewport),
  ...buildBeams(drive, axes, viewport),
  ...buildFragments(drive, axes, viewport),
  ...buildFan(drive, axes, viewport),
  ...buildCore(drive, axes, viewport),
];

/**
 * **層の上限を種別ごとの枠で切る。**
 *
 * 単純な `slice(0, limit)` だと、**組み立て順の末尾（扇と核）から落ちる**。
 * 破片は密度で 36 枚まで増えるので、上限 48 では核と扇が枠に届かず、
 * **白へ届いてよい唯一の層が消える**という壊れ方をしていた。
 *
 * ここでは 2 周する。1 周目は種別ごとに `UNIFIED.reserve` の枚数までを先取りし、
 * 2 周目で残りの枠を元の並びのまま埋める。枠の合計が上限より小さいので、
 * **どの密度でも核と扇は必ず残る**。並びは元の順序を保つので絵は変わらない
 * （加算合成なので順序自体は見え方に影響しない）。
 */
export const capUnifiedRig = (layers: readonly UnifiedLayer[], limit: number): UnifiedLayer[] => {
  if (layers.length <= limit) return [...layers];
  const taken = new Array<boolean>(layers.length).fill(false);
  const used: Partial<Record<UnifiedKind, number>> = {};
  let count = 0;
  for (let index = 0; index < layers.length && count < limit; index++) {
    const kind = layers[index]!.kind;
    const already = used[kind] ?? 0;
    if (already >= UNIFIED.reserve[kind]) continue;
    used[kind] = already + 1;
    taken[index] = true;
    count += 1;
  }
  for (let index = 0; index < layers.length && count < limit; index++) {
    if (taken[index]) continue;
    taken[index] = true;
    count += 1;
  }
  return layers.filter((_, index) => taken[index]!);
};

/** ティック速度（fps）。軸から実寸へ。 */
export const unifiedTickRate = tickRateOf;
