/**
 * **統合表現の連続軸（Light Unified）。**
 *
 * Spatial Study / Reactive Lab / Element Lab 2 の 3 つの見え方を、
 * **行き来できる 1 本の連続軸の集合**として置き直したもの。
 *
 * ---
 * ## 原則
 *
 * - **どの軸も「コードパスの切替」ではなく、描画数式の中の連続な混合係数**である。
 *   スライダーの途中の値が常に意味を持ち、**軸の中間に新しい見え方が現れる**ことが価値。
 *   `if (axis > 0.5)` のような分岐で見え方を切り替えてはいけない。
 * - 3 つの既存表現は**比較用に無改変で温存**する。ここは新規のコードで、
 *   共有部品（帯域イベント検出・アトラス・結線・痕跡場）だけを再利用する。
 * - 3 つの見え方は絶対解ではない。プリセットは**参考座標**であって、
 *   厳密な再現ではなく「だいたいの雰囲気」が置ければよい。
 *
 * ## 不変条件（どの軸設定でも壊れない）
 *
 * - **無音 = 黒**（音が無ければ 1 画素も出ない）
 * - **白の予算**: 白へ届いてよいのは核だけ
 * - **決定論**: `Math.random()` も `Date.now()` も使わない
 */

/** 軸 1 本の定義。すべて 0〜1 に正規化して持つ（`tickRate` だけ実寸を別に持つ）。 */
export interface AxisDecl {
  readonly id: keyof UnifiedAxes;
  readonly label: string;
  readonly group: string;
  /** 0 側 / 1 側が何を意味するか。UI の補足に出す。 */
  readonly low: string;
  readonly high: string;
}

export interface UnifiedAxes {
  // ---- 配置 ----
  /** 0 = 中心に集まる ⇄ 1 = 画面いっぱいにばらける。 */
  spreadX: number;
  spreadY: number;
  /** 中心・骨格軸への引力。1 で軸に吸い寄せられる。 */
  anchorPull: number;

  // ---- 時間 ----
  /**
   * 0 = 連続エンベロープ ⇄ 1 = フルティック明滅。
   * **ラッチ量と off ティックの減衰深さを同時に補間する**ので、途中は
   * 「少しコマ送りっぽい連続」になる（切替ではない）。
   */
  strobe: number;
  /** 光学クロックの速さ（12〜48 の実寸を 0〜1 で持つ）。 */
  tickRate: number;
  /** 0 = 即時 ⇄ 1 = ゆっくり立ち上がる。 */
  attack: number;
  /** 0 = 一瞬で消える ⇄ 1 = 長い尾を引く。 */
  decay: number;
  /**
   * **二重の時間軸。**
   *
   * 0 = すべての層が同時に開き、同じ長さで消える ⇄
   * 1 = 種別ごとに 0〜0.22 秒ずれて開き、**尾の長さも 10 倍の幅で分かれる**
   * （光条は 0.42 倍で瞬く / 膜は 2.1 倍 / 靄は 3.2 倍で残る）。
   *
   * 速い光が先に散り、遅い膜が後から開いて長く残る、という構造そのもの。
   * `Decay` 軸は全体の係数のまま、この軸が種別ごとの倍率を掛ける。
   */
  stagger: number;

  // ---- 光学 ----
  /**
   * 0 = シャープな縁・弱いブルーム ⇄ 1 = にじんだ縁・強いブルーム・広いハロ。
   * 縁の `smoothstep` 幅・ハロの利得・散乱の広がりを**1 本の軸で束ねる**。
   */
  blur: number;

  // ---- 空間 ----
  /** 0 = 平面（全部同じ奥行き）⇄ 1 = Near/Far に散る。 */
  depthSpread: number;
  /** 0 = 正面 ⇄ 1 = 3D の傾き。 */
  tilt: number;

  // ---- 色 ----
  /** 0 = 要素ごとに seed の色 ⇄ 1 = 全体が 1 つの色相。 */
  hueCoherence: number;
  /** 0 = 滑らかに追従 ⇄ 1 = 離散状態 + 長い保持。 */
  hueStickiness: number;
  /**
   * **要素の中の色の旅。**
   *
   * 0 = 要素 1 つはほぼ単色（色相幅 0.13 まで・彩度は一定）⇄
   * 1 = 4 つの停留点を渡り歩き、途中で**折り返し**、彩度も白 → 色 / 色 → 白 に振れる。
   *
   * `Hue coherence`（要素**どうし**が同じ色相へ寄るか）とは直交する軸で、
   * こちらは 1 枚の中で色相環をどれだけ歩くか。プリズムを通った光の分光そのもの。
   */
  hueDepth: number;
  /** RGB のオフセットと非相関の量。 */
  dispersion: number;
  /**
   * **チャンネルの偏り 1 本。** 0 = R 優勢 / 0.5 = G 優勢 / 1 = B 優勢の**非循環**な経路。
   * 利得の最大は常に 1 なので、**白の予算は動かない**（`channelBalance.ts`）。
   */
  channelBalance: number;

  // ---- 構成 ----
  /** 0 = 膜が優勢 ⇄ 1 = 光条が優勢。性格の軸。 */
  membraneBeam: number;
  /**
   * **膜の大きさの決め方。**
   *
   * 0 = その奥行きの可視範囲から逆算（画面に対して常に同じ割合を占める）。
   * 1 = ワールド固定（手前は大きく・奥は小さく写り、画面を越えて広がる）。
   *
   * **可視範囲で割ると遠近が相殺され、板の集合が 1 枚の平面に見える。**
   * 空間に散る見え方の本体はここで、明るさの天井と帯の厚みも同じ 1 本で広がる。
   */
  membraneScale: number;
  /**
   * **膜の生まれ方。**
   *
   * 0 = 固定のリグの膜（曲に関係なく常に同じ場所・同じ形）⇄
   * 1 = **打撃ごとに生まれて 0.3〜2.1 秒生きて死ぬ膜**。
   *
   * 中間は**両方を出して明るさを配分する**ので、途中は「動かない膜の上に
   * 打撃の膜が重なる」見え方になる（切替ではない）。
   */
  eventMembrane: number;
  /**
   * **質感の量。**
   *
   * 0 = 手続きで描いた形だけ ⇄ 1 = アトラスの素材が濃淡を支配する。
   * 素材は「完成した絵」ではなく輝度マスクとして読み、タイル・クロップ・
   * 回転・反転は**要素ごとに**決まる（10 枚を切り替えているようには見えない）。
   */
  textureGrain: number;
  /**
   * **板の四角さを削る。**
   *
   * 0 = 手続きで描いた形の縁そのまま ⇄ 1 = 非対称な多角形で外形を削る。
   * 板の輪郭が読めてしまうのを隠しつつ、要素ごとに違う不揃いな縁を作る。
   */
  silhouette: number;
  /**
   * **核の大きさ。**
   *
   * 0 = 針の先の白熱（0.10〜0.60）⇄ 1 = 画面を占める光の塊（0.90〜3.60）。
   * **薄め方の効きも同じ 1 本に載せてある** — これまでは大きさを上げるとちょうど
   * 打ち消す量だけ薄まり、「広い」と「白い」が両立しなかった。
   * 大きい側では板の枚数も 1 → 3 枚へ増え、重なりで面になる。
   *
   * 既定 0.4 が従来の 0.20 / 2.30 をちょうど通るよう曲げてあるので、
   * 既定のままなら 1 画素も変わらない。
   */
  coreSize: number;
  /**
   * **核の形。**
   *
   * 0 = 等方の点（真円・ガウス）⇄ 1 = **横長の面**（縦横比 1.45 : 0.78）で
   * **頂が平ら**（超ガウス）。平頂 + 急な縁は「点が光る」ではなく「面が光る」見えになる。
   * 芯の白い点（spark）はそのまま残るので、面の中に白熱した芯がある形になる。
   */
  coreShape: number;
  /**
   * **核のブルームと露出。**
   *
   * 0 = 現状（内部ブルーム無し・トーンマップ無し）⇄ 1 = Spatial 相当
   * （閾値 0.22 を超えた画素だけが滲み、最後に `1 - exp(-x·0.95)` を掛ける）。
   *
   * Unified にはこれまで**ブルームも露出も無かった**。核が「白い点」から
   * 「光っている面」へ変わるのは、実はここがいちばん効く。
   * 軸 0 では滲みの寄与も掛け合わせも 0 なので、現状と厳密に一致する。
   */
  coreBloom: number;
  /** 破片の量。 */
  fragments: number;
  /**
   * **破片の性格。** 0 = 角のある破片 ⇄ 1 = 引っ掻き傷のような羽毛・筋。
   * `Blur`（光学のにじみ）とは別軸にしてある — 鋭い筋と滲んだ破片を
   * それぞれ独立に出せるようにするため。
   */
  fragmentCharacter: number;
  /** 靄の床（画面をまとめる最下段の明るさ）。 */
  hazeFloor: number;
  /** 常設の十字（骨格）の存在感。**バーストの原点で交差する。** */
  skeleton: number;
  /** 0 = 短い光条 ⇄ 1 = 画面の外まで貫通する極細線。 */
  beamLength: number;
  /**
   * **十字ごと回す。** 0 = 現状の向き ⇄ 1 = π（180°）回転。
   * バーストの原点を中心にする層（核・骨格・閃光・扇）の面内回転へ一律に足す。
   * 十字の形は変えず、**画の向きだけ**を連続に振る。
   */
  crossRotation: number;
  /**
   * **光の数。** 1 バーストあたりの要素数・同時バースト数・
   * コアの再発火の速さを同時にスケールする。
   */
  density: number;

  // ---- 動き ----
  /** 0 = 静止 ⇄ 1 = 面内をゆっくり漂う。 */
  motion: number;
  /** 痕跡場の効き（消えた場所へ次が引き寄せられる）。 */
  trace: number;

  // ---- 明るさ ----
  intensity: number;
}

/** 軸の並び（UI の順序でもある）。 */
export const AXIS_DECLS: readonly AxisDecl[] = [
  { id: 'spreadX', label: 'Spread X', group: '配置', low: '中心', high: 'ばらける' },
  { id: 'spreadY', label: 'Spread Y', group: '配置', low: '中心', high: 'ばらける' },
  { id: 'anchorPull', label: 'Anchor pull', group: '配置', low: '自由', high: '軸へ吸着' },
  { id: 'strobe', label: 'Strobe', group: '時間', low: '連続', high: 'コマ送り' },
  { id: 'tickRate', label: 'Tick rate', group: '時間', low: '12fps', high: '48fps' },
  { id: 'attack', label: 'Attack', group: '時間', low: '即時', high: 'ゆっくり' },
  { id: 'decay', label: 'Decay', group: '時間', low: '一瞬', high: '長い尾' },
  { id: 'stagger', label: 'Stagger', group: '時間', low: '全層同時', high: '種別ごとにずれる' },
  { id: 'blur', label: 'Blur', group: '光学', low: 'シャープ', high: 'にじみ' },
  { id: 'depthSpread', label: 'Depth spread', group: '空間', low: '平面', high: '前後に散る' },
  { id: 'tilt', label: 'Tilt', group: '空間', low: '正面', high: '傾き' },
  { id: 'hueCoherence', label: 'Hue coherence', group: '色', low: '要素ごと', high: '全体 1 色' },
  { id: 'hueStickiness', label: 'Hue stickiness', group: '色', low: '滑らか', high: '離散・保持' },
  { id: 'hueDepth', label: 'Hue depth', group: '色', low: 'ほぼ単色', high: '4 点 + 往復' },
  { id: 'dispersion', label: 'Dispersion', group: '色', low: '重なる', high: 'ずれる' },
  { id: 'channelBalance', label: 'Channel balance', group: '色', low: 'R 優勢', high: 'B 優勢' },
  { id: 'membraneBeam', label: 'Membrane–Beam', group: '構成', low: '膜', high: '光条' },
  { id: 'membraneScale', label: 'Membrane scale', group: '構成', low: '画面基準', high: 'ワールド固定' },
  { id: 'eventMembrane', label: 'Event membrane', group: '構成', low: '固定の膜', high: '打撃ごとに生死' },
  { id: 'textureGrain', label: 'Texture grain', group: '構成', low: '手続き形状', high: '素材が支配' },
  { id: 'silhouette', label: 'Silhouette', group: '構成', low: '素の縁', high: '多角形で削る' },
  { id: 'coreSize', label: 'Core size', group: '構成', low: '針の先', high: '画面を占める' },
  { id: 'coreShape', label: 'Core shape', group: '構成', low: '等方の点', high: '横長の平らな面' },
  { id: 'coreBloom', label: 'Core bloom', group: '光学', low: '無し', high: 'Spatial 相当' },
  { id: 'fragments', label: 'Fragments', group: '構成', low: '無し', high: '多い' },
  { id: 'fragmentCharacter', label: 'Fragment character', group: '構成', low: '破片', high: '羽毛・筋' },
  { id: 'hazeFloor', label: 'Haze floor', group: '構成', low: '無し', high: '厚い' },
  { id: 'skeleton', label: 'Skeleton', group: '構成', low: '無し', high: 'はっきり' },
  { id: 'beamLength', label: 'Beam length', group: '構成', low: '短い', high: '貫通' },
  { id: 'crossRotation', label: 'Cross rotation', group: '構成', low: '現状の向き', high: 'π 回転' },
  { id: 'density', label: 'Density', group: '構成', low: '少ない', high: '多い' },
  { id: 'motion', label: 'Motion', group: '動き', low: '静止', high: '漂う' },
  { id: 'trace', label: 'Trace', group: '動き', low: '無し', high: '強い' },
  { id: 'intensity', label: 'Intensity', group: '明るさ', low: '暗い', high: '明るい' },
];

/**
 * **既定値。** 3 つのプリセット座標のだいたい中間から始める。
 * ここが「まだ誰も見ていない中間の見え方」の出発点になる。
 */
export const DEFAULT_AXES: UnifiedAxes = {
  spreadX: 0.5,
  spreadY: 0.5,
  anchorPull: 0.35,
  strobe: 0.45,
  tickRate: 0.45,
  attack: 0.3,
  decay: 0.45,
  stagger: 0.4,
  blur: 0.5,
  depthSpread: 0.45,
  tilt: 0.3,
  hueCoherence: 0.6,
  hueStickiness: 0.5,
  hueDepth: 0.45,
  dispersion: 0.35,
  channelBalance: 0.5,
  membraneBeam: 0.5,
  membraneScale: 0.45,
  eventMembrane: 0.4,
  textureGrain: 0.4,
  silhouette: 0.35,
  coreSize: 0.4,
  coreShape: 0,
  coreBloom: 0,
  fragments: 0.5,
  fragmentCharacter: 0.4,
  hazeFloor: 0.45,
  skeleton: 0.4,
  beamLength: 0.55,
  crossRotation: 0,
  density: 0.55,
  motion: 0.35,
  trace: 0.4,
  intensity: 0.5,
};

/**
 * **参考座標（プリセット）。**
 * ボタンで表現を切り替えるのではなく、**スライダー値を一括代入するだけ**の入口。
 * 代入したあとはどの軸も自由に動かせる。
 */
export const AXIS_PRESETS: Readonly<Record<string, Partial<UnifiedAxes>>> = {
  /** Spatial Study 風: 空間に散る・連続・にじむ。 */
  spatial: {
    spreadX: 0.85,
    spreadY: 0.85,
    anchorPull: 0.1,
    strobe: 0,
    tickRate: 0.45,
    attack: 0.35,
    decay: 0.55,
    stagger: 0.85,
    // にじみは強くしすぎない。0.9 を超えると層の縁が消えて 1 枚の靄になる。
    blur: 0.6,
    depthSpread: 0.9,
    tilt: 0.75,
    hueCoherence: 0.35,
    hueStickiness: 0.2,
    hueDepth: 0.72,
    dispersion: 0.4,
    channelBalance: 0.42,
    membraneBeam: 0.4,
    membraneScale: 0.9,
    eventMembrane: 0.9,
    textureGrain: 0.82,
    silhouette: 0.7,
    coreSize: 0.4,
    coreShape: 0,
    coreBloom: 0,
    fragments: 0.6,
    fragmentCharacter: 0.85,
    hazeFloor: 0.3,
    // 十字は空間の見え方では脇役。長い光条が画面を貫くと図形が主役になる。
    skeleton: 0.12,
    beamLength: 0.6,
    crossRotation: 0,
    density: 0.85,
    motion: 0.5,
    trace: 0.35,
    intensity: 0.4,
  },
  /** Reactive Lab 風: 膜が優勢・長い尾・にじむ。 */
  reactive: {
    spreadX: 0.8,
    spreadY: 0.8,
    anchorPull: 0.15,
    strobe: 0,
    tickRate: 0.45,
    attack: 0.25,
    decay: 0.9,
    stagger: 0.8,
    blur: 0.66,
    depthSpread: 0.5,
    tilt: 0.35,
    hueCoherence: 0.45,
    hueStickiness: 0.3,
    hueDepth: 0.7,
    dispersion: 0.5,
    channelBalance: 0.62,
    membraneBeam: 0.15,
    membraneScale: 0.6,
    eventMembrane: 0.65,
    textureGrain: 0.6,
    silhouette: 0.5,
    coreSize: 0.4,
    coreShape: 0,
    coreBloom: 0,
    fragments: 0.6,
    fragmentCharacter: 0.7,
    hazeFloor: 0.5,
    skeleton: 0.15,
    beamLength: 0.45,
    crossRotation: 0,
    density: 0.8,
    motion: 0.3,
    trace: 0.5,
    intensity: 0.22,
  },
  /** Element Lab 2 風: 中心に固定・フルコマ送り・シャープ・1 色相。 */
  optics: {
    spreadX: 0.08,
    spreadY: 0.08,
    anchorPull: 0.85,
    strobe: 1,
    tickRate: 0.5,
    attack: 0,
    decay: 0.15,
    stagger: 0.06,
    blur: 0.2,
    depthSpread: 0.2,
    tilt: 0.05,
    hueCoherence: 1,
    hueStickiness: 1,
    hueDepth: 0.15,
    dispersion: 0.3,
    channelBalance: 0.5,
    membraneBeam: 0.5,
    membraneScale: 0.06,
    eventMembrane: 0.05,
    textureGrain: 0.12,
    silhouette: 0.08,
    coreSize: 0.4,
    coreShape: 0,
    coreBloom: 0,
    fragments: 0.55,
    fragmentCharacter: 0.15,
    hazeFloor: 0.4,
    skeleton: 1,
    beamLength: 1,
    crossRotation: 0,
    density: 0.5,
    motion: 0.05,
    trace: 0.2,
    intensity: 0.56,
  },
};

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/** 保存や UI から来た値を安全な軸へ整える。 */
export const normalizeAxes = (raw: Partial<UnifiedAxes> | null | undefined): UnifiedAxes => {
  const out = { ...DEFAULT_AXES };
  if (!raw) return out;
  for (const decl of AXIS_DECLS) {
    const value = raw[decl.id];
    if (typeof value === 'number' && Number.isFinite(value)) out[decl.id] = clamp01(value);
  }
  return out;
};

/** ティック速度の実寸（fps）。軸 0〜1 を 12〜48 へ写す。 */
export const tickRateOf = (axes: UnifiedAxes): number => 12 + clamp01(axes.tickRate) * 36;
