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
  /** 破片の性格（0 = 破片 ⇄ 1 = 羽毛・筋）。他の種別では 0。 */
  readonly character: number;
  /** **白の予算。** true は白へ届いてよい（核だけ）。 */
  readonly whiteAllowed: boolean;
  readonly ceiling: number;
  /** [オフセット倍率, 非相関倍率, オフセット下限, 非相関下限] */
  readonly channel: readonly [number, number, number, number];
}

/** 音が注ぎ込むもの。**これ以外に見え方を変える入力はない。** */
export interface UnifiedDrive {
  /** 場の基礎輝度（音量の持続）。 */
  readonly fieldLevel: number;
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
  beamCeiling: 0.62,
  /** 要素の枚数（軸が量を決めるので上限だけ持つ）。 */
  membraneCount: 4,
  fragmentCount: 16,
  beamCount: 4,
  /**
   * **にじみが最大のときの板の余白**（1.4 なら板は 2.4 倍）。
   * ハロは `exp(-r^2 * 1.6)` なので r = 2.4 では 1 万分の 1 になり、
   * 縁に届く前に消える。
   */
  padAtFullBlur: 1.4,
  /** 波長の深さ。1 で純粋な分光、0 で白。 */
  tintDepth: 0.72,
  /** 場の利得。音量の持続をそのまま輝度にすると暗すぎるので 1 本だけ通す。 */
  fieldGain: 1.6,
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
} as const;

const TAU = Math.PI * 2;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);
const clamp01 = (value: number): number => clamp(value, 0, 1);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

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
  const t = clamp01(
    (Math.abs(z) - UNIFIED.depthNear) / (UNIFIED.depthFar - UNIFIED.depthNear),
  );
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

/** 傾き。`tilt` が 0 なら正面。 */
const tiltOf = (
  axes: UnifiedAxes,
  seed: number,
  index: number,
): { readonly x: number; readonly y: number } => {
  const amount = clamp01(axes.tilt);
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

/** **にじみのハロ。** `blur` 軸が種別ごとの上限まで散乱を広げる。 */
const haloOf = (axes: UnifiedAxes, kind: keyof typeof UNIFIED.halo): number =>
  clamp01(axes.blur) * UNIFIED.halo[kind];

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
): number =>
  strobePhaseGain(axes.strobe, drive.tick, drive.seed, UNIFIED_KIND_INDEX[kind], index);

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

/** 光条の長さ。0 で短い光条、1 で画面の外まで貫通する。 */
const beamReach = (axes: UnifiedAxes): number => mix(0.3, 2.8, clamp01(axes.beamLength));

/** 光条の向き（ローカル +x をこの向きへ）。 */
const BEAM_DIRECTIONS: readonly { readonly bit: number; readonly spin: number }[] = [
  { bit: 2, spin: 0 },
  { bit: 1, spin: Math.PI / 2 },
  { bit: 8, spin: Math.PI },
  { bit: 4, spin: -Math.PI / 2 },
];

/** 核の形状族ごとの [族, 横フレア, 縦スパイク, 芯の強さ]。 */
const CORE_SHAPE_PARAMS: readonly (readonly [number, number, number, number])[] = [
  [0, 0.5, 0.5, 1],
  [1, 0.14, 0.92, 0.92],
  [2, 0.92, 0.14, 0.92],
  [3, 0.1, 0.1, 1.4],
];

/**
 * **靄。** 画面をまとめる最下段。`hazeFloor` が量を決める。
 * `blur` が縁の柔らかさを、`depthSpread` が奥行きを決める。
 */
const buildHaze = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
): UnifiedLayer[] => {
  const level = clamp01(drive.fieldLevel) * clamp01(axes.hazeFloor);
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
      gradientForm: 1,
      intensity: 0.2 * level * depthDim(z) * blinkOf(axes, drive, 'haze', 0),
      // [減衰, 縁の始まり, 縁の終わり, 分光の深さ]
      shape: [mix(2.6, 1.4, clamp01(axes.blur)), 0.32, 0.78, 0.55],
      edge: clamp01(axes.blur),
      halo: haloOf(axes, 'haze'),
      pad: padOf(axes),
      character: 0,
      whiteAllowed: false,
      ceiling: UNIFIED.hazeCeiling,
      channel: [1.2, 1.5, 0.04, 0.35],
    },
  ];
};

/**
 * **膜。** Sheet・カーテン・マクロ膜をまとめた語。
 * `membraneBeam` が 0 に近いほど枚数と厚みが増える（膜が優勢）。
 */
const buildMembranes = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
): UnifiedLayer[] => {
  const level = clamp01(drive.fieldLevel);
  if (level <= 0) return [];
  // 性格の軸。膜側（0）で多く厚く、光条側（1）で少なく薄くなる。
  const share = 1 - clamp01(axes.membraneBeam);
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
    out.push({
      kind: 'membrane',
      position: [(place.nx + d.x) * e.w * 0.8, (place.ny + d.y) * e.h * 0.6, z],
      half: [e.w * wide * mix(0.5, 1.05, share), e.h * mix(0.28, 0.7, share)],
      spin: (hash01(seed + 613, index * 11 + 7) - 0.5) * 1.4,
      tiltX: tilt.x,
      tiltY: tilt.y,
      hue: hueOf(axes, drive.hue, seed, index * 3 + 2),
      hueSpan: 0.11,
      gradientForm: 2,
      intensity:
        (0.1 + 0.13 * share) *
        level *
        depthDim(z) *
        blinkOf(axes, drive, 'membrane', index) *
        countFade(wanted, index, count),
      // [形状族, 襞の周期, 帯の半幅, 折れ]
      shape: [
        Math.floor(family * 3),
        3 + hash01(seed + 613, index * 11 + 8) * 8,
        0.24 + hash01(seed + 613, index * 11 + 9) * 0.26,
        (hash01(seed + 613, index * 11 + 10) - 0.5) * 0.9,
      ],
      edge: clamp01(axes.blur),
      halo: haloOf(axes, 'membrane'),
      pad: padOf(axes),
      character: 0,
      whiteAllowed: false,
      ceiling: UNIFIED.membraneCeiling,
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
  const level = clamp01(drive.fieldLevel);
  const share = clamp01(axes.membraneBeam);
  const skeleton = clamp01(axes.skeleton);
  const z = depthOf(axes, 0.32);
  const e = halfExtent(z, viewport);
  const anchor = burstAnchor(drive, axes, viewport, z);
  // 貫通させるときは、原点が端に寄っていても画面を突き抜ける長さが要る。
  const reach = (Math.max(e.w, e.h) + Math.max(Math.abs(anchor.x), Math.abs(anchor.y))) * beamReach(axes);

  // ---- 常設の軸（骨格）。`skeleton` が 0 なら 1 枚も出ない ----
  if (level > 0 && skeleton > 0) {
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
        spin: index === 0 ? Math.PI / 2 : 0,
        tiltX: 0,
        tiltY: 0,
        hue: hueOf(axes, drive.hue, drive.seed, 40 + index),
        hueSpan: 0.05 + index * 0.02,
        gradientForm: 2,
        intensity:
          w[2] * level * skeleton * mix(0.7, 1.15, share) * blinkOf(axes, drive, 'beam', index),
        shape: [w[0], w[1], 0, 0],
        edge: clamp01(axes.blur),
        halo: haloOf(axes, 'beam'),
        pad: padOf(axes),
        character: 0,
        whiteAllowed: false,
        ceiling: UNIFIED.nonCoreCeiling,
        channel: [1, 1, 0.02, 0.12],
      });
    }
  }

  // ---- 出来事に同期した閃光 ----
  const power = clamp01(drive.beamStrength);
  const mask = Math.round(drive.beamMask);
  if (mask !== 0 && power > 0) {
    const seed = Math.round(drive.beamSeed);
    for (let index = 0; index < BEAM_DIRECTIONS.length; index++) {
      const direction = BEAM_DIRECTIONS[index]!;
      if ((mask & direction.bit) === 0) continue;
      const a = hash01(seed, index * 3 + 1);
      const b = hash01(seed, index * 3 + 2);
      const length =
        1.55 * (0.78 + 0.44 * a) * (0.62 + 0.6 * power) * mix(0.7, 1.5, share) * beamReach(axes);
      const thickness = 0.06 * (0.85 + 0.3 * b) * mix(1.4, 0.7, share);
      out.push({
        kind: 'beam',
        position: [anchor.x, anchor.y, z - 0.02],
        half: [length, thickness],
        spin: direction.spin,
        tiltX: 0,
        tiltY: 0,
        hue: hueOf(axes, drive.hue, seed, index),
        hueSpan: 0.07,
        gradientForm: 0,
        intensity:
          (0.5 + 0.85 * power) * (0.82 + 0.3 * a) * blinkOf(axes, drive, 'beam', index + 3),
        shape: [0.22, 0.1, 0.2 + 0.25 * b, 1],
        edge: clamp01(axes.blur),
        halo: haloOf(axes, 'beam'),
        pad: padOf(axes),
        character: 0,
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
  const z = depthOf(axes, 0.25);
  const anchor = burstAnchor(drive, axes, viewport, z);
  return [
    {
      kind: 'core',
      position: [anchor.x, anchor.y, z],
      half: [mix(0.34, 0.5, pulse), mix(0.34, 0.5, pulse)],
      spin: 0,
      tiltX: 0,
      tiltY: 0,
      hue: drive.hue,
      hueSpan: 0.08,
      gradientForm: 1,
      intensity: mix(0.4, 1.55, pulse) * blinkOf(axes, drive, 'core', 0),
      shape: [shape[0], shape[1], shape[2], shape[3]],
      edge: clamp01(axes.blur),
      halo: haloOf(axes, 'core'),
      pad: padOf(axes),
      character: 0,
      whiteAllowed: true,
      ceiling: 1,
      channel: [1, 1, 0, 0],
    },
  ];
};

/** **破片。** 4 つの形状族。`fragments` 軸が量を決める。 */
const buildFragments = (
  drive: UnifiedDrive,
  axes: UnifiedAxes,
  viewport: UnifiedViewport,
): UnifiedLayer[] => {
  const amount = clamp01(axes.fragments);
  if (amount <= 0 || drive.fragments.length === 0) return [];
  const wanted = UNIFIED.fragmentCount * amount * mix(0.5, 2.2, clamp01(axes.density));
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
    const stretch = family === 1 ? 2.1 + h * 1.5 : family === 2 ? 1.1 + h * 0.7 : 0.85 + h * 0.5;
    out.push({
      kind: 'fragment',
      position: [(nx + d.x) * e.w, (ny + d.y) * e.h, z],
      half: [size * stretch, size / Math.sqrt(stretch)],
      spin: hash01(seed, slot * 7 + 5) * TAU,
      tiltX: tilt.x,
      tiltY: tilt.y,
      hue: hueOf(axes, drive.hue, seed, slot),
      hueSpan: 0.1,
      gradientForm: 3,
      intensity:
        (0.14 + c * 0.13) *
        (0.62 + 0.5 * clamp01(spawn.strength)) *
        clamp01(spawn.gain) *
        amount *
        depthDim(z) *
        blinkOf(axes, drive, 'fragment', slot) *
        countFade(wanted, placed, limit),
      // [縁, 形状族, 伸び, 欠け]
      shape: [0.34, family, 0.75 + h * 0.6, 0.04 + dd * 0.2],
      edge: clamp01(axes.blur),
      halo: haloOf(axes, 'fragment'),
      pad: padOf(axes),
      character: 0,
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
      spin: 0,
      tiltX: 0,
      tiltY: 0,
      hue: hueOf(axes, drive.hue, seed, 3),
      hueSpan: 0.13,
      gradientForm: 3,
      intensity: 0.44 * gate * blinkOf(axes, drive, 'fan', 0),
      // [基準角, 広がり, 本数, 到達]
      shape: [
        -1.42 + (a - 0.5) * 0.5,
        0.82 + (b - 0.5) * 0.4,
        3.2 + (c - 0.5) * 1.2,
        mix(0.46, 0.66, gate),
      ],
      edge: clamp01(axes.blur),
      halo: haloOf(axes, 'fan'),
      pad: padOf(axes),
      character: 0,
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

/** ティック速度（fps）。軸から実寸へ。 */
export const unifiedTickRate = tickRateOf;
