import type { AudioEventSnapshot, BandLightEvent, BandName } from '../engine/bandLightEvents';

/**
 * **音 → プリズム光の見え方を決める唯一の場所（Light Reactive Lab）。**
 *
 * 描画クラス（`LightReactiveLab`）はここが返した値をそのまま描くだけで、
 * `AudioEngine` も `AudioEventSnapshot` も直接は読まない。
 *
 * 設計の芯は **「発生時にすべて固定する」**。
 * 素材・色・クロップ・大きさ・太さ・位置・奥行き・傾き・寿命・構図タイプは
 * 発光の瞬間に確定し、以後は変えない。発生後に動いてよいのは
 *   ① A/H/D の明るさ
 *   ② 発生時に決めた拡大
 *   ③ ごく弱い面内移動と、素材の中の弱いスクロール / せん断 / 回転
 * だけで、**Z 方向・カメラ方向へは決して動かさない**。
 *
 * `Math.random()` は使わない。同じ音・同じ seed・同じ event index なら同じ光になる。
 */

/** 層の種類。描画側のフラグメント分岐と 1 対 1 で対応する。 */
export type ReactiveLayerKind = 'core' | 'sheet' | 'haze' | 'ray';

/**
 * 構図タイプ。**同じプリズム光の設計言語のまま**、置き方だけを変える。
 * イベントごとに 1 つ選ばれ、その中で層の配置・角度・比率が決まる。
 */
export type CompositionType =
  | 'vertical-veil'
  | 'diagonal-fan'
  | 'prismatic-cross'
  | 'depth-corridor'
  | 'wide-haze'
  | 'layered-membrane';

export const COMPOSITION_TYPES: readonly CompositionType[] = [
  'vertical-veil',
  'diagonal-fan',
  'prismatic-cross',
  'depth-corridor',
  'wide-haze',
  'layered-membrane',
];

/** どの段階まで組み立てるか。Version ボタンと 1 対 1。 */
export type ReactiveStage = 1 | 2 | 3 | 4;

/** 1 層ぶんの見え方。**発生時に確定し、寿命の間ずっと変わらない。** */
export interface ReactiveLayerTraits {
  readonly kind: ReactiveLayerKind;
  /** ワールド座標。z は発生時の奥行きで、以後動かさない。 */
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  /** 板の半幅・半高（ワールド単位）。奥行きで割らないので遠近が成立する。 */
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** 面の法線（ワールド）。ビルボード固定にせず、seed の向きへ倒す。 */
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
  /** 面内の回転（ラジアン）。 */
  readonly spin: number;
  /** アトラスの素材番号。 */
  readonly tile: number;
  /** UV クロップ（中心 u,v と半径 su,sv）。 */
  readonly crop: { readonly u: number; readonly v: number; readonly su: number; readonly sv: number };
  /** UV の回転と反転。 */
  readonly uvAngle: number;
  readonly flipX: number;
  readonly flipY: number;
  /** 色相の起点と、1 層の中で走る幅。 */
  readonly hueOffset: number;
  readonly hueSpan: number;
  /** 分光の形式（0 横 / 1 放射 / 2 縦 / 3 角度）。 */
  readonly gradientForm: number;
  /** 素材そのものの色を残す割合。 */
  readonly sourceTint: number;
  /** 明るさの倍率。 */
  readonly intensity: number;
  /** 光条の太さ（ray のみ。芯の半幅を画面比で持つ）。 */
  readonly rayWidth: number;
  /** 大きさの時間変化（発生時 → 寿命の終わり）。 */
  readonly expansion: { readonly from: number; readonly to: number };
  /** A/H/D（秒）。 */
  readonly lifetime: {
    readonly attackSeconds: number;
    readonly holdSeconds: number;
    readonly decaySeconds: number;
  };
  /** 面内だけのゆっくりした動き（1 秒あたり）。Z へは動かない。 */
  readonly motion: {
    readonly scrollU: number;
    readonly scrollV: number;
    readonly shear: number;
    readonly spin: number;
    /** 面内のごく弱い平行移動（ワールド単位 / 秒）。 */
    readonly slideX: number;
    readonly slideY: number;
  };
}

/** 1 層ぶんの予定。`delaySeconds` だけ遅れて開く。 */
export interface PlannedReactiveLayer {
  readonly delaySeconds: number;
  readonly traits: ReactiveLayerTraits;
}

/** 1 イベントぶんの計画。検証で構図が読めるよう、種類も返す。 */
export interface BurstPlan {
  readonly composition: CompositionType;
  readonly layers: readonly PlannedReactiveLayer[];
}

/** 可視範囲（その奥行きで画面に収まる半分の幅と高さ）。 */
export type VisibleExtent = (depth: number) => {
  readonly halfWidth: number;
  readonly halfHeight: number;
};

/** 表現から渡す運転設定。開発つまみをそのまま束ねる。 */
export interface BurstSettings {
  readonly stage: ReactiveStage;
  /** 明るさの下限・上限。 */
  readonly minimumIntensity: number;
  readonly maximumIntensity: number;
  /** A/H/D の基準（秒）。sustain がここから伸ばす。 */
  readonly attackSeconds: number;
  readonly holdSeconds: number;
  readonly decaySeconds: number;
  /** 層の数の倍率。 */
  readonly layerDensity: number;
  /** 面内の漂いの量（0 で完全静止）。 */
  readonly membraneMotion: number;
  /** 奥行きの散らばり（0 で中間だけ）。 */
  readonly depthAmount: number;
  /** 発光の瞬間の sustain。検出層と共有する Snapshot は汚さずここで渡す。 */
  readonly sustain: number;
}

/**
 * 対応づけの定数。**ここを触ると音と光の意味が変わる。**
 * 描画側の定数（カメラ・シェーダー）とは分けてある。
 */
export const BURST_MAPPING = {
  // ---- 明るさ・大きさ・太さ ----
  /** 大きさ: volume 0 → 1 でこの範囲（ワールド基準サイズに対する倍率）。 */
  sizeAtSilence: 0.62,
  sizeAtFullVolume: 1.5,
  /**
   * 板の基準の半サイズ（ワールド単位）。**可視範囲では割らない** —
   * 割ると奥ほど板も大きくなって遠近が相殺され、層の集合が 1 枚の平面に見える。
   * いちばん狭い画角（9:16）でも黒が残るところに置いてある。
   */
  coreWorldHalfSize: 0.95,
  sheetWorldHalfSize: 1.7,
  /**
   * 太さ: **centroid が低いほど太い。** Bass 比率と volume も少し足す。
   * 細い線が大量に飛ぶ状態を避けるための軸。
   */
  thicknessFromLowCentroid: 0.6,
  thicknessFromBassShare: 0.25,
  thicknessFromVolume: 0.15,
  thicknessMinimum: 0.7,
  thicknessMaximum: 2.1,

  // ---- 時間 ----
  /** sustain 0 → 1 で Hold / Decay に掛かる倍率。 */
  holdScaleAtDry: 0.55,
  holdScaleAtSustained: 2.2,
  decayScaleAtDry: 0.6,
  decayScaleAtSustained: 2.4,
  /** Sheet は Core より遅れて開き、長く残る。 */
  sheetDelayMinimum: 0.02,
  sheetDelayMaximum: 0.12,
  sheetDecayScale: 2.1,
  sheetHoldScale: 1.6,
  /** Haze はさらに遅れて、いちばん長く残る。 */
  hazeDelayMinimum: 0.05,
  hazeDelayMaximum: 0.22,
  hazeDecayScale: 3.2,
  /** Ray は瞬間だけ。 */
  rayDecayScale: 0.42,

  // ---- 奥行き（Near / Mid / Far）----
  /** 発生時に固定する 3 段。Z 方向へは動かさない。 */
  depthBands: [
    { near: 4, far: 6.5, size: 0.85, intensity: 1.12 },
    { near: 7, far: 11, size: 1, intensity: 1 },
    { near: 12.5, far: 19, size: 1.25, intensity: 0.7 },
  ],
  depthWeights: [0.3, 0.42, 0.28],

  // ---- 素材 ----
  /** 広い膜の役割。**毎回必ず 1 枚はここから選ぶ。** */
  wideRoles: ['wide-haze', 'wide-caustic', 'layered-sheets', 'parallel-curtains'],
  /** 帯域ごとに寄せる役割。 */
  rolesByBand: {
    bass: ['wide-haze', 'wide-caustic', 'parallel-curtains', 'layered-sheets'],
    mid: ['layered-sheets', 'parallel-curtains', 'caustic-fan', 'wide-haze'],
    treble: ['segmented-rays', 'fine-filaments', 'filament-and-curtain'],
  } as Readonly<Record<BandName, readonly string[]>>,
  /** 帯域に合わない素材が選ばれる余地。 */
  offBandWeight: 0.14,

  // ---- 色 ----
  /** 1 層の中で色相が走る幅（狭い / 広い）。 */
  hueSpanNarrow: 0.12,
  hueSpanWide: 0.5,
  /** 素材そのものの色を残す割合。 */
  sourceTintMinimum: 0.12,
  sourceTintMaximum: 0.34,
  /** 分光の形式の数。 */
  gradientFormCount: 4,

  // ---- 構図 ----
  /** 層の数（Sheet + Haze）。novelty と onset で増える。 */
  layerCountMinimum: 2,
  layerCountMaximum: 5,

  // ---- Ray ----
  /**
   * Ray は**強い onset か Treble 優勢のときだけ**。
   * 水平垂直が基本で、傾きは小さく、本数も絞る（斬撃にしない）。
   */
  rayOnsetThreshold: 0.78,
  rayTrebleThreshold: 0.62,
  /** Treble 優勢で出すときも、この強さの打撃であることを要る（常時表示にしない）。 */
  rayTrebleOnsetFloor: 0.55,
  rayCountMaximum: 2,
  rayTiltRadians: 0.07,
  rayHorizontalProbability: 0.7,
  rayWidthMinimum: 0.0035,
  rayWidthMaximum: 0.011,
  rayIntensityScale: 0.55,

  // ---- 面内の漂い ----
  motionScrollMaximum: 0.09,
  motionShearMaximum: 0.07,
  motionSpinMaximum: 0.09,
  motionSlideMaximum: 0.12,

  // ---- 履歴（連続の防止）----
  /** 覚えておく直近イベントの数。 */
  historyLimit: 6,
  /** 引き直しの回数。ハッシュ列の次の値を使うので決定論は崩れない。 */
  retries: 6,
  /** 同じ位置への集中を避ける最低距離（画面正規化）。 */
  minimumSeparation: 0.6,
  /** 混雑度がこの値以下なら合格として引き直しを止める。 */
  crowdingTolerance: 0.45,
  /** 直近の重心と同じ側を避ける重み。左右の寄りはここで崩す。 */
  balanceWeight: 1.6,
} as const;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);
const clamp01 = (value: number): number => clamp(value, 0, 1);
const mix = (a: number, b: number, t: number): number => a + (b - a) * clamp01(t);

/** FNV-1a を土台にした 0..1 のハッシュ。既存の表現と同じ作り。 */
const hash01 = (...values: number[]): number => {
  let hash = 0x811c9dc5;
  for (const value of values) {
    const quantized = Math.round(value * 4096) | 0;
    for (let shift = 0; shift < 32; shift += 8) {
      hash ^= (quantized >>> shift) & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash / 0x100000000;
};

const BAND_INDEX: Readonly<Record<BandName, number>> = { bass: 0, mid: 1, treble: 2 };

const normalise = (v: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!(length > 1e-6)) return { x: 0, y: 0, z: 1 };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
};

/** 直近イベントの記録。連続で同じ見え方にならないよう避けるために使う。 */
interface BurstMemory {
  composition: CompositionType;
  tile: number;
  cropKey: number;
  hue: number;
  angle: number;
  x: number;
  y: number;
}

export class PrismaticBurstPlanner {
  private tiles: readonly { readonly role: string; readonly weight: number }[] = [];
  private readonly history: BurstMemory[] = [];

  /** アトラスが読めたら教えてもらう。並び順が素材番号になる。 */
  setTextures(tiles: readonly { readonly role: string; readonly weight: number }[]): void {
    this.tiles = tiles;
  }

  reset(): void {
    this.history.length = 0;
  }

  /** 検証用。直近の構図の並びを見る。 */
  recentCompositions(): readonly CompositionType[] {
    return this.history.map((entry) => entry.composition);
  }

  /**
   * イベント 1 個から Burst を組み立てる。
   * Stage が上がるほど層の種類と変化の幅が増えるが、**時間設計と決定論は共通**。
   */
  plan(event: BandLightEvent, visible: VisibleExtent, settings: BurstSettings): BurstPlan {
    const snapshot = event.snapshot;
    const seed = [snapshot.audioSeed, snapshot.eventIndex, BAND_INDEX[snapshot.winningBand]];
    const h = (salt: number): number => hash01(...seed, salt);

    const strength = clamp01(snapshot.onsetStrength);
    const volume = clamp01(snapshot.volume);
    const composition = this.pickComposition(h, settings);
    const layers: PlannedReactiveLayer[] = [];

    // Core は必ず 1 枚。Stage 1 はこれだけ。
    const core = this.core(snapshot, settings, h, visible, composition, strength, volume);
    layers.push(core);

    if (settings.stage >= 2) {
      for (const sheet of this.sheets(snapshot, settings, visible, composition, core.traits)) {
        layers.push(sheet);
      }
    }
    if (settings.stage >= 4) {
      for (const extra of this.atmosphere(snapshot, settings, h, visible, core.traits)) {
        layers.push(extra);
      }
    }

    this.remember(composition, core.traits, visible);
    return { composition, layers };
  }

  // ------------------------------------------------------------------ 構図

  /**
   * 構図タイプ。**直近と同じものが続かない**よう、履歴を見て引き直す。
   * Stage 3 未満では変化を見せないので固定の 1 種に留める。
   */
  private pickComposition(h: (salt: number) => number, settings: BurstSettings): CompositionType {
    if (settings.stage < 3) return 'layered-membrane';
    const recent = this.history.slice(-2).map((entry) => entry.composition);
    for (let attempt = 0; attempt <= BURST_MAPPING.retries; attempt++) {
      const index = Math.floor(h(201 + attempt) * COMPOSITION_TYPES.length);
      const candidate = COMPOSITION_TYPES[Math.min(index, COMPOSITION_TYPES.length - 1)]!;
      if (!recent.includes(candidate)) return candidate;
    }
    return COMPOSITION_TYPES[Math.floor(h(299) * COMPOSITION_TYPES.length) % COMPOSITION_TYPES.length]!;
  }

  // ------------------------------------------------------------------ 各層

  /** 中心の Core。**静的な Light Element Lab と同じプリズム素材・同じ光学**を通す。 */
  private core(
    snapshot: AudioEventSnapshot,
    settings: BurstSettings,
    h: (salt: number) => number,
    visible: VisibleExtent,
    composition: CompositionType,
    strength: number,
    volume: number,
  ): PlannedReactiveLayer {
    const varied = settings.stage >= 3;
    const band = this.pickDepthBand(varied ? h(11) : 0.5, settings.depthAmount);
    const depth = varied ? mix(band.near, band.far, h(13)) : 8.5;
    const extent = visible(depth);
    const size = mix(BURST_MAPPING.sizeAtSilence, BURST_MAPPING.sizeAtFullVolume, volume);
    const thickness = this.thickness(snapshot);
    // 構図ごとの置き方。Stage 3 未満は中央固定。
    const layout = varied ? this.layout(composition, h, 0) : { x: 0, y: 0, aspect: 1, tilt: 0.2, spin: 0 };
    // **同じ場所への集中と左右の偏りを崩す。** 候補が混んでいたら
    // ハッシュ列の次の値で引き直す（`Math.random()` は使わない）。
    const placed = varied ? this.place(layout.x, layout.y, h) : { x: layout.x, y: layout.y };
    const half = BURST_MAPPING.coreWorldHalfSize * size * (varied ? band.size : 1);

    return {
      delaySeconds: 0,
      traits: {
        kind: 'core',
        position: {
          x: placed.x * extent.halfWidth,
          y: placed.y * extent.halfHeight,
          z: -depth,
        },
        halfWidth: half * layout.aspect * mix(1, thickness, 0.3),
        halfHeight: (half / layout.aspect) * mix(1, thickness, 0.3),
        normal: this.normalFor(layout.tilt, h, 21, settings),
        spin: layout.spin,
        tile: this.pickTile(snapshot, h, 31, true),
        crop: this.crop(h, 41, varied),
        uvAngle: varied ? h(51) * Math.PI * 2 : 0,
        flipX: varied && h(53) < 0.5 ? -1 : 1,
        flipY: varied && h(55) < 0.5 ? -1 : 1,
        hueOffset: varied ? this.hue(h) : 0.12,
        hueSpan: varied ? mix(BURST_MAPPING.hueSpanNarrow, BURST_MAPPING.hueSpanWide, h(63)) : 0.38,
        gradientForm: varied ? Math.floor(h(65) * BURST_MAPPING.gradientFormCount) : 0,
        sourceTint: mix(BURST_MAPPING.sourceTintMinimum, BURST_MAPPING.sourceTintMaximum, h(67)),
        intensity:
          mix(settings.minimumIntensity, settings.maximumIntensity, strength) *
          (varied ? band.intensity : 1),
        rayWidth: 0,
        expansion: { from: 0.86, to: varied ? mix(1, 1.35, h(71)) : 1.1 },
        lifetime: this.lifetime(settings, 1, 1),
        motion: this.motion(settings, h, 81, varied ? 1 : 0.35),
      },
    };
  }

  /**
   * Core と同じ光として広がる Sheet。
   * **同じ seed・同じ基準色・同じ発生位置**から作り、遅れて開いて長く残る。
   */
  private sheets(
    snapshot: AudioEventSnapshot,
    settings: BurstSettings,
    visible: VisibleExtent,
    composition: CompositionType,
    core: ReactiveLayerTraits,
  ): PlannedReactiveLayer[] {
    const varied = settings.stage >= 3;
    const count = this.sheetCount(snapshot, settings);
    const layers: PlannedReactiveLayer[] = [];
    for (let i = 0; i < count; i++) {
      const s = (salt: number): number => hash01(salt, i, core.hueOffset * 1000, snapshot.eventIndex);
      const band = this.pickDepthBand(varied ? s(101) : 0.5, settings.depthAmount);
      const depth = varied ? mix(band.near, band.far, s(103)) : 9.2;
      const extent = visible(depth);
      const layout = varied
        ? this.layout(composition, s, i + 1)
        : { x: 0.05 * (i % 2 ? 1 : -1), y: 0, aspect: 1.5, tilt: 0.3, spin: 0.1 };
      // 1 枚目は必ず広い膜系。細線だけで構成されると斬撃に見える。
      const wide = i === 0;
      // 基準はワールド単位のまま（可視範囲で割ると遠近が相殺される）。
      // いちばん狭い画角（9:16）でも黒が残る大きさに揃えてある。
      const half =
        BURST_MAPPING.sheetWorldHalfSize *
        mix(BURST_MAPPING.sizeAtSilence, BURST_MAPPING.sizeAtFullVolume, clamp01(snapshot.volume)) *
        (varied ? band.size : 1);
      layers.push({
        delaySeconds: mix(BURST_MAPPING.sheetDelayMinimum, BURST_MAPPING.sheetDelayMaximum, s(105)),
        traits: {
          kind: 'sheet',
          position: {
            x: core.position.x + layout.x * extent.halfWidth,
            y: core.position.y + layout.y * extent.halfHeight,
            z: -depth,
          },
          halfWidth: half * layout.aspect,
          halfHeight: half / layout.aspect,
          normal: this.normalFor(layout.tilt, s, 107, settings),
          spin: layout.spin,
          tile: this.pickTile(snapshot, s, 109, wide),
          crop: this.crop(s, 111, varied),
          uvAngle: varied ? s(113) * Math.PI * 2 : 0,
          flipX: varied && s(115) < 0.5 ? -1 : 1,
          flipY: varied && s(117) < 0.5 ? -1 : 1,
          // **基準色は Core と共有する。** 中心と周囲が別の光に見えないための要。
          hueOffset: core.hueOffset + (varied ? (s(119) * 2 - 1) * 0.1 : 0.03),
          hueSpan: core.hueSpan * (varied ? mix(0.8, 1.5, s(121)) : 1.2),
          gradientForm: core.gradientForm,
          sourceTint: core.sourceTint,
          intensity: core.intensity * mix(0.42, 0.78, s(123)) * (varied ? band.intensity : 1),
          rayWidth: 0,
          expansion: { from: 0.92, to: varied ? mix(1.05, 1.5, s(125)) : 1.2 },
          lifetime: this.lifetime(
            settings,
            BURST_MAPPING.sheetHoldScale,
            BURST_MAPPING.sheetDecayScale * mix(0.8, 1.25, s(127)),
          ),
          motion: this.motion(settings, s, 131, 1),
        },
      });
    }
    return layers;
  }

  /** Stage 4 の Haze と Ray。空気感と、ごく少数の直線。 */
  private atmosphere(
    snapshot: AudioEventSnapshot,
    settings: BurstSettings,
    h: (salt: number) => number,
    visible: VisibleExtent,
    core: ReactiveLayerTraits,
  ): PlannedReactiveLayer[] {
    const layers: PlannedReactiveLayer[] = [];
    const { bass, mid, treble } = snapshot.bandFlux;
    const total = Math.max(bass + mid + treble, 1e-6);

    // Haze — 余韻と空気感。いちばん広く、いちばん長く残り、いちばん淡い。
    const hazeDepth = 13.5;
    const hazeExtent = visible(hazeDepth);
    layers.push({
      delaySeconds: mix(BURST_MAPPING.hazeDelayMinimum, BURST_MAPPING.hazeDelayMaximum, h(151)),
      traits: {
        kind: 'haze',
        position: {
          x: core.position.x * 0.4 + (h(153) * 2 - 1) * hazeExtent.halfWidth * 0.25,
          y: core.position.y * 0.4 + (h(155) * 2 - 1) * hazeExtent.halfHeight * 0.2,
          z: -hazeDepth,
        },
        halfWidth: hazeExtent.halfWidth * mix(0.8, 1.15, clamp01(snapshot.volume)),
        halfHeight: hazeExtent.halfHeight * mix(0.8, 1.1, clamp01(snapshot.volume)),
        normal: { x: 0, y: 0, z: 1 },
        spin: h(157) * Math.PI,
        tile: this.pickTile(snapshot, h, 159, true),
        crop: this.crop(h, 161, true),
        uvAngle: h(163) * Math.PI * 2,
        flipX: h(165) < 0.5 ? -1 : 1,
        flipY: h(167) < 0.5 ? -1 : 1,
        hueOffset: core.hueOffset + (h(169) * 2 - 1) * 0.14,
        hueSpan: core.hueSpan * 1.3,
        gradientForm: core.gradientForm,
        sourceTint: core.sourceTint * 1.3,
        intensity: core.intensity * mix(0.14, 0.3, clamp01(settings.sustain)),
        rayWidth: 0,
        expansion: { from: 1, to: mix(1.05, 1.25, h(171)) },
        lifetime: this.lifetime(settings, 2.2, BURST_MAPPING.hazeDecayScale),
        motion: this.motion(settings, h, 173, 0.7),
      },
    });

    // Ray — **強い onset か Treble 優勢のときだけ。** 水平垂直が基本で本数も絞る。
    const strength = clamp01(snapshot.onsetStrength);
    const trebleShare = treble / total;
    // **強い onset か、Treble 優勢かつそれなりの打撃のときだけ。**
    // 常時出すと細い直線が並んで斬撃に戻る。
    const wants =
      strength >= BURST_MAPPING.rayOnsetThreshold ||
      (trebleShare >= BURST_MAPPING.rayTrebleThreshold &&
        strength >= BURST_MAPPING.rayTrebleOnsetFloor);
    if (!wants) return layers;
    // 2 本目はよほど強い打撃のときだけ。
    const count = 1 + (strength > 0.94 ? 1 : 0);
    for (let i = 0; i < Math.min(count, BURST_MAPPING.rayCountMaximum); i++) {
      const r = (salt: number): number => hash01(snapshot.audioSeed, snapshot.eventIndex, 700 + i, salt);
      const horizontal = r(3) < BURST_MAPPING.rayHorizontalProbability;
      const depth = 8;
      const extent = visible(depth);
      const angle = (horizontal ? 0 : Math.PI / 2) + (r(5) * 2 - 1) * BURST_MAPPING.rayTiltRadians;
      const thickness = this.thickness(snapshot);
      layers.push({
        delaySeconds: mix(0, 0.03, r(7)),
        traits: {
          kind: 'ray',
          position: { x: core.position.x, y: core.position.y, z: -depth },
          // 画面の対角より長く張り、必ず外まで抜ける。
          halfWidth: Math.hypot(extent.halfWidth, extent.halfHeight) * 1.3,
          halfHeight: Math.hypot(extent.halfWidth, extent.halfHeight) * 1.3,
          normal: { x: 0, y: 0, z: 1 },
          spin: angle,
          tile: 0,
          crop: { u: 0.5, v: 0.5, su: 0.5, sv: 0.5 },
          uvAngle: 0,
          flipX: 1,
          flipY: 1,
          hueOffset: core.hueOffset + (r(9) * 2 - 1) * 0.08,
          hueSpan: core.hueSpan * 0.6,
          gradientForm: 0,
          sourceTint: 0,
          intensity: core.intensity * BURST_MAPPING.rayIntensityScale * mix(0.8, 1.2, r(11)),
          rayWidth:
            mix(BURST_MAPPING.rayWidthMinimum, BURST_MAPPING.rayWidthMaximum, r(13)) * thickness,
          expansion: { from: 0.35, to: 1 },
          lifetime: this.lifetime(settings, 0.35, BURST_MAPPING.rayDecayScale),
          motion: { scrollU: 0, scrollV: 0, shear: 0, spin: 0, slideX: 0, slideY: 0 },
        },
      });
    }
    return layers;
  }

  // ------------------------------------------------------------------ 部品

  /**
   * **配置の偏りを崩す。**
   *
   * 直近の Core と近すぎる候補、および左右どちらかへ寄り続ける候補は、
   * ハッシュ列の次の値で引き直す。何度引いても駄目なら、その中で最も良い候補を採る。
   * 引き直しはハッシュ列を進めるだけなので、決定論は崩れない。
   */
  private place(
    baseX: number,
    baseY: number,
    h: (salt: number) => number,
  ): { x: number; y: number } {
    if (this.history.length === 0) return { x: baseX, y: baseY };
    // 直近の重心。ここと反対側を選びやすくして左右の寄りを崩す。
    const meanX =
      this.history.reduce((sum, entry) => sum + entry.x, 0) / Math.max(this.history.length, 1);
    let best: { x: number; y: number; score: number } | null = null;
    for (let attempt = 0; attempt <= BURST_MAPPING.retries; attempt++) {
      // 1 回目はそのまま。以降は候補をずらして引き直す。
      const shift = attempt === 0 ? 0 : (h(401 + attempt * 2) * 2 - 1) * 0.9;
      const lift = attempt === 0 ? 0 : (h(402 + attempt * 2) * 2 - 1) * 0.6;
      const x = clamp(baseX + shift, -0.85, 0.85);
      const y = clamp(baseY + lift, -0.8, 0.8);
      let score = 0;
      for (const entry of this.history) {
        const distance = Math.hypot(entry.x - x, entry.y - y);
        if (distance < BURST_MAPPING.minimumSeparation) {
          score += 1 - distance / BURST_MAPPING.minimumSeparation;
        }
      }
      // 直近の重心と同じ側なら悪い。反対側へ寄せる。
      score += Math.max(meanX * x, 0) * BURST_MAPPING.balanceWeight;
      if (best === null || score < best.score) best = { x, y, score };
      if (score <= BURST_MAPPING.crowdingTolerance) break;
    }
    return best ?? { x: baseX, y: baseY };
  }

  /** 色相。**同じ色相帯が続かない**よう、履歴を見て引き直す。 */
  private hue(h: (salt: number) => number): number {
    const bandOf = (value: number): number => Math.floor((((value % 1) + 1) % 1) * 6);
    const recent = this.history.slice(-1).map((entry) => bandOf(entry.hue));
    let fallback = h(61);
    for (let attempt = 0; attempt <= BURST_MAPPING.retries; attempt++) {
      const candidate = h(61 + attempt * 3);
      if (attempt === 0) fallback = candidate;
      if (!recent.includes(bandOf(candidate))) return candidate;
    }
    return fallback;
  }

  /** 構図タイプごとの置き方。同じ設計言語のまま、配置と比率だけを変える。 */
  private layout(
    composition: CompositionType,
    h: (salt: number) => number,
    index: number,
  ): { x: number; y: number; aspect: number; tilt: number; spin: number } {
    const jitter = (salt: number): number => h(salt) * 2 - 1;
    const step = index * 0.34;
    switch (composition) {
      case 'vertical-veil':
        return { x: jitter(301) * 0.6, y: jitter(303) * 0.3, aspect: 0.55, tilt: 0.25, spin: jitter(305) * 0.12 };
      case 'diagonal-fan':
        return {
          x: (-0.5 + step) * 0.9 + jitter(306) * 0.3,
          y: (-0.35 + step * 0.7) * 0.8 + jitter(308) * 0.25,
          aspect: 1.7,
          tilt: 0.55,
          spin: 0.5 + jitter(307) * 0.2,
        };
      case 'prismatic-cross':
        return {
          x: (index % 2 === 0 ? jitter(309) * 0.2 : jitter(311) * 0.6) + jitter(310) * 0.3,
          y: (index % 2 === 0 ? jitter(313) * 0.6 : jitter(315) * 0.2) + jitter(312) * 0.25,
          aspect: index % 2 === 0 ? 0.5 : 2,
          tilt: 0.2,
          spin: index % 2 === 0 ? Math.PI / 2 : 0,
        };
      case 'depth-corridor':
        return {
          x: (index - 1) * 0.42 + jitter(316) * 0.32,
          y: jitter(317) * 0.3,
          aspect: 1.2,
          tilt: 0.7,
          spin: jitter(319) * 0.3,
        };
      case 'wide-haze':
        return { x: jitter(321) * 0.5, y: jitter(323) * 0.35, aspect: 1.9, tilt: 0.35, spin: jitter(325) * 0.5 };
      case 'layered-membrane':
      default:
        return {
          x: jitter(327) * 0.45,
          y: jitter(329) * 0.3,
          aspect: mix(0.8, 1.6, h(331)),
          tilt: 0.45,
          spin: h(333) * Math.PI,
        };
    }
  }

  /** 面の法線。カメラ正面固定にせず、seed の向きへ倒す（Z へは動かさない）。 */
  private normalFor(
    tilt: number,
    h: (salt: number) => number,
    salt: number,
    settings: BurstSettings,
  ): { x: number; y: number; z: number } {
    const amount = clamp01(settings.depthAmount);
    const lean = tilt * Math.max(amount, 0.2) * (Math.PI / 2) * 0.55;
    const azimuth = h(salt) * Math.PI * 2;
    const sine = Math.sin(lean);
    return normalise({ x: Math.cos(azimuth) * sine, y: Math.sin(azimuth) * sine, z: Math.cos(lean) });
  }

  /** 太さ。**centroid が低いほど太い。** */
  private thickness(snapshot: AudioEventSnapshot): number {
    const { bass, mid, treble } = snapshot.bandFlux;
    const total = Math.max(bass + mid + treble, 1e-6);
    const raw = clamp01(
      BURST_MAPPING.thicknessFromLowCentroid * (1 - clamp01(snapshot.spectralCentroid)) +
        BURST_MAPPING.thicknessFromBassShare * (bass / total) +
        BURST_MAPPING.thicknessFromVolume * clamp01(snapshot.volume),
    );
    return mix(BURST_MAPPING.thicknessMinimum, BURST_MAPPING.thicknessMaximum, raw);
  }

  /** A/H/D。**sustain が Hold と Decay を伸ばす。** */
  private lifetime(
    settings: BurstSettings,
    holdScale: number,
    decayScale: number,
  ): { attackSeconds: number; holdSeconds: number; decaySeconds: number } {
    const sustain = clamp01(settings.sustain);
    return {
      attackSeconds: settings.attackSeconds,
      holdSeconds:
        settings.holdSeconds *
        holdScale *
        mix(BURST_MAPPING.holdScaleAtDry, BURST_MAPPING.holdScaleAtSustained, sustain),
      decaySeconds:
        settings.decaySeconds *
        decayScale *
        mix(BURST_MAPPING.decayScaleAtDry, BURST_MAPPING.decayScaleAtSustained, sustain),
    };
  }

  /** UV のクロップ。イベントごとに切り出す場所と広さを変える。 */
  private crop(
    h: (salt: number) => number,
    salt: number,
    varied: boolean,
  ): { u: number; v: number; su: number; sv: number } {
    if (!varied) return { u: 0.5, v: 0.5, su: 0.4, sv: 0.4 };
    const su = mix(0.26, 0.46, h(salt));
    const sv = mix(0.26, 0.46, h(salt + 1));
    const margin = 0.08;
    const centre = (value: number, half: number): number =>
      half + margin + value * Math.max(1 - half * 2 - margin * 2, 0);
    return { u: centre(h(salt + 2), su), v: centre(h(salt + 3), sv), su, sv };
  }

  /** 面内だけのゆっくりした漂い。Z へは動かない。 */
  private motion(
    settings: BurstSettings,
    h: (salt: number) => number,
    salt: number,
    scale: number,
  ): ReactiveLayerTraits['motion'] {
    const amount = clamp01(settings.membraneMotion) * scale;
    if (amount <= 0) {
      return { scrollU: 0, scrollV: 0, shear: 0, spin: 0, slideX: 0, slideY: 0 };
    }
    const heading = h(salt) * Math.PI * 2;
    const speed = BURST_MAPPING.motionScrollMaximum * h(salt + 1) * amount;
    const slide = BURST_MAPPING.motionSlideMaximum * h(salt + 4) * amount;
    return {
      scrollU: Math.cos(heading) * speed,
      scrollV: Math.sin(heading) * speed,
      shear: (h(salt + 2) * 2 - 1) * BURST_MAPPING.motionShearMaximum * amount,
      spin: (h(salt + 3) * 2 - 1) * BURST_MAPPING.motionSpinMaximum * amount,
      slideX: Math.cos(heading + 1.2) * slide,
      slideY: Math.sin(heading + 1.2) * slide,
    };
  }

  /** Sheet の枚数。novelty と onset で増える。 */
  private sheetCount(snapshot: AudioEventSnapshot, settings: BurstSettings): number {
    if (settings.stage < 3) return 1;
    const raw = mix(
      BURST_MAPPING.layerCountMinimum,
      BURST_MAPPING.layerCountMaximum,
      clamp01(clamp01(snapshot.onsetStrength) * 0.5 + clamp01(snapshot.novelty) * 0.6),
    );
    return Math.max(1, Math.round(raw * clamp(settings.layerDensity, 0, 2)));
  }

  /** 奥行きの段。発生時に固定し、以後動かさない。 */
  private pickDepthBand(
    value: number,
    amount: number,
  ): { near: number; far: number; size: number; intensity: number } {
    const bands = BURST_MAPPING.depthBands;
    const middle = bands[1]!;
    const weights = BURST_MAPPING.depthWeights.map((weight, index) =>
      index === 1 ? weight + (1 - clamp01(amount)) * (1 - weight) : weight * clamp01(amount),
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let pick = value * total;
    for (let i = 0; i < weights.length; i++) {
      pick -= weights[i]!;
      if (pick <= 0) return bands[i] ?? middle;
    }
    return middle;
  }

  /**
   * 素材を 1 枚選ぶ。帯域の役割を優先し、`wide` 指定なら広い膜系から選ぶ。
   * 直近と同じ素材が続かないよう、履歴を見て引き直す。
   */
  private pickTile(
    snapshot: AudioEventSnapshot,
    h: (salt: number) => number,
    salt: number,
    wide: boolean,
  ): number {
    if (this.tiles.length === 0) return 0;
    const preferred = wide
      ? BURST_MAPPING.wideRoles
      : BURST_MAPPING.rolesByBand[snapshot.winningBand];
    const weights = this.tiles.map((tile) => {
      const match = preferred.includes(tile.role);
      if (wide) return match ? tile.weight : 0;
      return tile.weight * (match ? 1 : BURST_MAPPING.offBandWeight);
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) return 0;
    const recent = this.history.slice(-2).map((entry) => entry.tile);
    let fallback = 0;
    for (let attempt = 0; attempt <= BURST_MAPPING.retries; attempt++) {
      let pick = h(salt + attempt) * total;
      let chosen = weights.length - 1;
      for (let i = 0; i < weights.length; i++) {
        pick -= weights[i]!;
        if (pick <= 0) {
          chosen = i;
          break;
        }
      }
      if (attempt === 0) fallback = chosen;
      if (!recent.includes(chosen)) return chosen;
    }
    return fallback;
  }

  /** 直近のイベントを覚える。連続で同じ見え方にならないようにするためだけに使う。 */
  private remember(
    composition: CompositionType,
    core: ReactiveLayerTraits,
    visible: VisibleExtent,
  ): void {
    const extent = visible(Math.max(-core.position.z, 1));
    this.history.push({
      composition,
      tile: core.tile,
      cropKey: Math.round((core.crop.u + core.crop.v) * 100),
      hue: core.hueOffset,
      angle: core.spin,
      x: core.position.x / Math.max(extent.halfWidth, 1e-6),
      y: core.position.y / Math.max(extent.halfHeight, 1e-6),
    });
    if (this.history.length > BURST_MAPPING.historyLimit) this.history.shift();
  }
}
