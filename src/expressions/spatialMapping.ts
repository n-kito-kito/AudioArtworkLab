import type { AudioEventSnapshot, BandLightEvent, BandName } from '../engine/bandLightEvents';
import {
  SpatialPositionResolver,
  type SpatialPosition,
  type SpatialPositionConfig,
  type VisibleExtent,
} from './spatialPositions';

/**
 * 音 → 見え方の対応を決める唯一の場所。
 *
 * **描画側にはこの対応を一切書かない。** どの音の値をどの視覚要素へ結びつけるかは
 * これから何度も変わる見込みなので、変えるときに触るファイルを 1 つに保つ。
 * 表現（`LightSpatialStudy`）は `AudioEventSnapshot` を渡して
 * `LightVisualTraits` を受け取るだけで、中で何が起きているかを知らない。
 *
 * 入口は `AudioEventSnapshot`（発光の瞬間に凍らせた音の姿）だけ。
 * ここから位置・明るさ・大きさ・色・速度・寿命・軌跡を作る。
 *
 * **帯域比率に使えるのは素の `bandFlux` だけ。** 適応後の strength は帯域ごとに
 * 別の参照値で割った値なので、帯域どうしを比べると静かな帯域が不当に大きく出る。
 */

/** バーストの中での役割。メインは 1 つ、サブは複数。 */
export type LightRole = 'main' | 'sub';

/**
 * 光の形。**波形をそのまま光の形にはしない**（波を光で描くことになるため）。
 * うねりは「自然界にまっすぐは無い」ぶんの微妙な変形としてだけ使う。
 */
export type LightShapeKind = 'spark' | 'needle' | 'arc';

/** 形の指定。描画側はこれを見て板の張り方と減衰を変える。 */
export interface LightShape {
  readonly kind: LightShapeKind;
  /** 軸方向の伸び（1 で等方の点、大きいほど細長い光条）。 */
  readonly elongation: number;
  /** 軸の向き（ラジアン。画面平面での角度）。 */
  readonly angle: number;
  /** 軸のうねり（0 でまっすぐ、大きいほど曲がる）。**振幅は小さく保つ。** */
  readonly waviness: number;
}

/** 1 つの光が生まれるときに決まる見え方。決まったら寿命の間は変えない。 */
export interface LightVisualTraits {
  readonly role: LightRole;
  readonly position: SpatialPosition;
  /** 明るさの倍率（0..1）。Core ごとの明るさはこれだけで決まる。 */
  readonly intensity: number;
  /** 大きさの倍率（1 が基準サイズ）。 */
  readonly size: number;
  /** 色。明るさとは分けてあり、**比率だけ**を表す（最大成分が 1 に正規化される）。 */
  readonly color: { readonly r: number; readonly g: number; readonly b: number };
  /** 速度（ワールド単位 / 秒）。 */
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
  /** 寿命の 3 段階（秒）。 */
  readonly lifetime: {
    readonly attackSeconds: number;
    readonly holdSeconds: number;
    readonly decaySeconds: number;
  };
  /** 軌跡の長さ（0..1）。0 で軌跡なし。 */
  readonly trail: number;
  readonly shape: LightShape;
}

/**
 * バーストの中の光 1 つぶんの予定。
 * `delaySeconds` だけ遅れて生まれるので、1 つの打撃が連鎖して光る。
 */
export interface PlannedLight {
  readonly delaySeconds: number;
  readonly traits: LightVisualTraits;
}

/** 表現から渡す、その時点の運転設定。 */
export interface LightMappingSettings {
  readonly minimumIntensity: number;
  readonly maximumIntensity: number;
  readonly attackSeconds: number;
  readonly holdSeconds: number;
  readonly decaySeconds: number;
  /** 大きさの効き（0 で音に依らず一定、1 で最大まで効く）。 */
  readonly sizeAmount: number;
  /** 色の効き（0 で白一色、1 で帯域比率をそのまま出す）。 */
  readonly colorAmount: number;
  /** 動きの効き（0 で静止）。 */
  readonly motionAmount: number;
  /** 軌跡の長さ（0..1）。 */
  readonly trailAmount: number;
  /** サブの光の個数の倍率（0〜2）。ユーザーが増減を調整する。 */
  readonly burstDensity: number;
}

/**
 * 対応づけの定数。**ここを触れば見え方の意味が変わる。**
 * 描画側の定数（半径・カメラ）とは分けてある。
 */
export const LIGHT_MAPPING = {
  /** 大きさ: 音量 0 → 1 でこの範囲を動く（基準サイズに対する倍率）。 */
  sizeAtSilence: 0.72,
  sizeAtFullVolume: 1.55,
  /**
   * 色は**音の seed が決める個別の色相**で、帯域から直接は作らない。
   *
   * 「中心は必ず白」にはしない。白は**重なりで創発させる** —
   * バーストの光が近くで交わったところが加算合成で自然に白へ寄る、という因果。
   * 単体で白いのは、下の `colorWhiteAtExtreme` を超える極端に強い発光だけ。
   */
  /** 彩度の範囲（seed 由来）。低いほど白っぽい光が混ざる。 */
  colorSaturationMinimum: 0.35,
  colorSaturationMaximum: 0.95,
  /** centroid で彩度をどれだけ動かすか。明るい音ほど色が立つ。 */
  colorSaturationFromCentroid: 0.28,
  /**
   * 単体でも白へ寄り始める強さ。これを超えると彩度が落ちて白熱して見える。
   * リファレンスの「白熱した交差点」は基本的に重なりで作るので、高めに置く。
   */
  colorWhiteAtExtreme: 0.86,
  /**
   * バーストの中で色相をどれだけずらすか（分光の幅）。
   * **ここが狭いと白が生まれない。** 似た色を足しても明るくなるだけで、
   * 白は「違う色が交わったとき」にしか出ないため、色相環をそれなりに使う。
   */
  colorHueSpreadInBurst: 0.44,
  /** 速度: 帯域ごとの基準の速さ（ワールド単位 / 秒）。 */
  speedByBand: { bass: 0.55, mid: 1.15, treble: 2.1 },
  /** 速度: onsetStrength 0 → 1 でこの倍率を掛ける。 */
  speedAtWeakOnset: 0.45,
  speedAtStrongOnset: 1.35,
  /**
   * 向き: Bass は奥行き方向へ重く、Treble は画面と平行に鋭く散る。
   * 0 で完全に画面平行、1 で完全に奥行き方向。
   */
  depthBiasByBand: { bass: 0.78, mid: 0.42, treble: 0.12 },
  /** 向き: centroid が高いほど散らばりの角度が狭く（鋭く）なる。 */
  spreadAtLowCentroid: 1,
  spreadAtHighCentroid: 0.45,
  /** 軌跡: Trail 0 → 1 でこの秒数ぶんの履歴を残す。 */
  trailSecondsAtMinimum: 0,
  trailSecondsAtMaximum: 0.9,

  // ---- バースト（1 つの打撃 = メイン 1 + サブ N の連鎖）----
  /**
   * サブの個数。**周波数の高さでは増やさない**（低音中心の曲で発生が枯れるため）。
   *   N = (base + volume 寄与 + onset 寄与 + 新奇性 寄与) × burstDensity
   */
  subCountBase: 1.6,
  subCountPerVolume: 4.4,
  subCountPerOnset: 2.6,
  subCountPerNovelty: 3.8,
  /** 1 バーストのサブの上限。増やしすぎると画面が埋まる。 */
  subCountMaximum: 16,
  /** サブが遅れて生まれる幅（秒）。この間に連鎖しているように見える。 */
  subDelayMinimum: 0.005,
  subDelayMaximum: 0.15,
  /**
   * サブがメインからどれだけ離れるか（可視範囲の半分に対する割合）。
   * 近いほど交わって白が立ち、遠いほど破片として散る。両方が要るので幅を持たせる。
   */
  subSpreadMinimum: 0.02,
  subSpreadMaximum: 0.13,
  /** サブの奥行きのばらつき（ワールド単位）。 */
  subDepthSpread: 1.8,
  /** サブの大きさ（メインに対する倍率）。**メインが最大**になるよう 1 未満に収める。 */
  subSizeMinimum: 0.18,
  subSizeMaximum: 0.72,
  /** サブの明るさ（メインに対する倍率）。 */
  subIntensityMinimum: 0.3,
  subIntensityMaximum: 0.85,
  /** サブの寿命（メインに対する倍率）。**さらに短命で、ばらつく**。 */
  subLifetimeMinimum: 0.28,
  subLifetimeMaximum: 0.85,
  /** サブの速さ（メインに対する倍率）。 */
  subSpeedMinimum: 0.6,
  subSpeedMaximum: 2.2,

  // ---- 形（針状の光条 / 点のスパーク / 短い波打つ弧）----
  /**
   * 形の出やすさは**帯域比率**で決まる。
   * 低域優勢 → 太めで遅い弧、高域優勢 → 針とスパーク。
   * 各値は「その帯域が主役のときの重み」で、合計が 1 になるよう正規化する。
   */
  shapeWeightsWhenBassLeads: { spark: 0.2, needle: 0.25, arc: 0.55 },
  shapeWeightsWhenMidLeads: { spark: 0.34, needle: 0.36, arc: 0.3 },
  shapeWeightsWhenTrebleLeads: { spark: 0.42, needle: 0.46, arc: 0.12 },
  /** 光条の伸び。centroid が高いほど細く長くなる。 */
  needleElongationAtLowCentroid: 3.4,
  needleElongationAtHighCentroid: 9.5,
  /** 弧の伸び。光条より短くて太い。 */
  arcElongationAtLowCentroid: 2.2,
  arcElongationAtHighCentroid: 4.2,
  /**
   * うねりの量。**flatness（音の濁り）が乱れの量**を決める。
   * まっすぐな光条は不自然なので、澄んだ音でも 0 にはしない。
   */
  wavinessAtPureTone: 0.18,
  wavinessAtNoise: 0.85,
  /** メインの光は等方の点のまま（伸ばさない）。 */
  mainElongation: 1,
} as const;

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

const mix = (a: number, b: number, t: number): number => a + (b - a) * clamp01(t);

/**
 * 決定論ハッシュ（`Math.random()` は使わない）。
 * 位置生成と同じ作りで、味付けだけ変えて別の流れを取る。
 */
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

export class LightSpatialMapping {
  private readonly positions: SpatialPositionResolver;

  constructor(positionConfig: SpatialPositionConfig, recentLimit: number) {
    this.positions = new SpatialPositionResolver(positionConfig, recentLimit);
  }

  reset(): void {
    this.positions.reset();
  }

  /**
   * イベント 1 個から**バースト**を組み立てる。
   *
   * メインの光 1 つと、5〜150ms 遅れて連鎖するサブの光 N 個を返す。
   * 遅れ・位置・大きさ・寿命はすべて音由来の決定論ハッシュで決まるので、
   * 同じ音源なら同じ連鎖になる（`Math.random()` は使わない）。
   */
  resolveBurst(
    event: BandLightEvent,
    visible: VisibleExtent,
    settings: LightMappingSettings,
  ): PlannedLight[] {
    const snapshot = event.snapshot;
    const origin = this.positions.resolve(event, visible);
    const mainIntensity = this.intensity(snapshot, settings);
    const mainSize = this.size(snapshot, settings);
    const color = this.color(snapshot, settings);
    const mainVelocity = this.velocity(snapshot, settings);
    const trail = clamp01(settings.trailAmount);

    const main: PlannedLight = {
      delaySeconds: 0,
      traits: {
        role: 'main',
        position: origin,
        intensity: mainIntensity,
        size: mainSize,
        color,
        velocity: mainVelocity,
        lifetime: {
          attackSeconds: settings.attackSeconds,
          holdSeconds: settings.holdSeconds,
          decaySeconds: settings.decaySeconds,
        },
        trail,
        // メインは等方の点。形のバリエーションはサブが担う。
        shape: { kind: 'spark', elongation: LIGHT_MAPPING.mainElongation, angle: 0, waviness: 0 },
      },
    };

    const count = this.subCount(snapshot, settings);
    const lights: PlannedLight[] = [main];
    const seed = [snapshot.audioSeed, BAND_INDEX[snapshot.winningBand], snapshot.eventIndex];
    const depth = -origin.z;
    const extent = visible(depth);

    for (let i = 0; i < count; i++) {
      const h = (salt: number): number => hash01(...seed, i, salt);
      const delay = mix(LIGHT_MAPPING.subDelayMinimum, LIGHT_MAPPING.subDelayMaximum, h(3));
      // メインの近くに散らす。近くで交わるほど、加算で白が生まれる。
      const angle = h(5) * Math.PI * 2;
      const radius = mix(LIGHT_MAPPING.subSpreadMinimum, LIGHT_MAPPING.subSpreadMaximum, h(7));
      const dz = (h(9) * 2 - 1) * LIGHT_MAPPING.subDepthSpread;
      const subDepth = Math.max(depth + dz, 1);
      const subExtent = visible(subDepth);
      const usable = 1 - 0.05;
      const position = {
        // 画面外へこぼさないよう、その奥行きの可視範囲で必ず抑える。
        x: clampAbs(origin.x + Math.cos(angle) * radius * extent.halfWidth, subExtent.halfWidth * usable),
        y: clampAbs(origin.y + Math.sin(angle) * radius * extent.halfHeight, subExtent.halfHeight * usable),
        z: -subDepth,
      };
      const sizeScale = mix(LIGHT_MAPPING.subSizeMinimum, LIGHT_MAPPING.subSizeMaximum, h(11));
      const intensityScale = mix(
        LIGHT_MAPPING.subIntensityMinimum,
        LIGHT_MAPPING.subIntensityMaximum,
        h(13),
      );
      const lifeScale = mix(
        LIGHT_MAPPING.subLifetimeMinimum,
        LIGHT_MAPPING.subLifetimeMaximum,
        h(17),
      );
      const speedScale = mix(LIGHT_MAPPING.subSpeedMinimum, LIGHT_MAPPING.subSpeedMaximum, h(19));
      // 分光: サブごとに色相を少しずらす。交わったところで色が混ざって白が立つ。
      const hueOffset = (h(23) * 2 - 1) * LIGHT_MAPPING.colorHueSpreadInBurst;
      lights.push({
        delaySeconds: delay,
        traits: {
          role: 'sub',
          position,
          intensity: mainIntensity * intensityScale,
          size: mainSize * sizeScale,
          color: this.color(snapshot, settings, hueOffset),
          velocity: {
            x: mainVelocity.x * speedScale,
            y: mainVelocity.y * speedScale,
            z: mainVelocity.z * speedScale,
          },
          lifetime: {
            // Attack はほぼゼロ。点いた瞬間に最大で、あとは落ちるだけ。
            attackSeconds: settings.attackSeconds * 0.5,
            holdSeconds: settings.holdSeconds * lifeScale * 0.6,
            decaySeconds: settings.decaySeconds * lifeScale,
          },
          trail,
          shape: this.shape(snapshot, h),
        },
      });
    }
    return lights;
  }

  /**
   * サブの形。種類の出やすさは帯域比率、細さと長さは centroid、
   * うねりの乱れ量は flatness が決める。
   *
   * **波形をそのまま形にはしない。** うねりは「まっすぐな光条は不自然だから
   * わずかに曲げる」ためだけの微小な変形で、波を描くものではない。
   */
  private shape(snapshot: AudioEventSnapshot, h: (salt: number) => number): LightShape {
    const { bass, mid, treble } = snapshot.bandFlux;
    const total = Math.max(bass + mid + treble, 1e-6);
    const weights = {
      spark:
        (bass / total) * LIGHT_MAPPING.shapeWeightsWhenBassLeads.spark +
        (mid / total) * LIGHT_MAPPING.shapeWeightsWhenMidLeads.spark +
        (treble / total) * LIGHT_MAPPING.shapeWeightsWhenTrebleLeads.spark,
      needle:
        (bass / total) * LIGHT_MAPPING.shapeWeightsWhenBassLeads.needle +
        (mid / total) * LIGHT_MAPPING.shapeWeightsWhenMidLeads.needle +
        (treble / total) * LIGHT_MAPPING.shapeWeightsWhenTrebleLeads.needle,
      arc:
        (bass / total) * LIGHT_MAPPING.shapeWeightsWhenBassLeads.arc +
        (mid / total) * LIGHT_MAPPING.shapeWeightsWhenMidLeads.arc +
        (treble / total) * LIGHT_MAPPING.shapeWeightsWhenTrebleLeads.arc,
    };
    const sum = weights.spark + weights.needle + weights.arc;
    const pick = h(29) * sum;
    const kind: LightShapeKind =
      pick < weights.spark ? 'spark' : pick < weights.spark + weights.needle ? 'needle' : 'arc';

    const centroid = clamp01(snapshot.spectralCentroid);
    const elongation =
      kind === 'spark'
        ? 1
        : kind === 'needle'
          ? mix(
              LIGHT_MAPPING.needleElongationAtLowCentroid,
              LIGHT_MAPPING.needleElongationAtHighCentroid,
              centroid,
            )
          : mix(
              LIGHT_MAPPING.arcElongationAtLowCentroid,
              LIGHT_MAPPING.arcElongationAtHighCentroid,
              centroid,
            );
    const waviness =
      kind === 'spark'
        ? 0
        : mix(
            LIGHT_MAPPING.wavinessAtPureTone,
            LIGHT_MAPPING.wavinessAtNoise,
            clamp01(snapshot.spectralFlatness),
          ) * (kind === 'arc' ? 1.6 : 1) * (0.6 + h(31) * 0.8);

    return { kind, elongation, angle: h(37) * Math.PI, waviness };
  }

  /**
   * サブの個数。**音量が基礎、onset と新奇性が上乗せ、スライダーが倍率。**
   * 周波数の高さ（centroid）は使わない — 低音中心の曲で発生が枯れてしまうため。
   */
  private subCount(snapshot: AudioEventSnapshot, settings: LightMappingSettings): number {
    const raw =
      LIGHT_MAPPING.subCountBase +
      LIGHT_MAPPING.subCountPerVolume * clamp01(snapshot.volume) +
      LIGHT_MAPPING.subCountPerOnset * clamp01(snapshot.onsetStrength) +
      LIGHT_MAPPING.subCountPerNovelty * clamp01(snapshot.novelty);
    const scaled = raw * Math.max(settings.burstDensity, 0);
    return Math.min(Math.round(scaled), LIGHT_MAPPING.subCountMaximum);
  }

  /**
   * 明るさ。**onsetStrength だけで決める。**
   * 帯域比率（色）とは完全に分けてあるので、色が濃い＝明るい にはならない。
   */
  private intensity(snapshot: AudioEventSnapshot, settings: LightMappingSettings): number {
    const minimum = clamp01(settings.minimumIntensity);
    const maximum = Math.max(clamp01(settings.maximumIntensity), minimum);
    return minimum + clamp01(snapshot.onsetStrength) * (maximum - minimum);
  }

  /** 大きさ。音量（RMS）で決める。明るさとは別の軸にしておく。 */
  private size(snapshot: AudioEventSnapshot, settings: LightMappingSettings): number {
    const scaled = mix(
      LIGHT_MAPPING.sizeAtSilence,
      LIGHT_MAPPING.sizeAtFullVolume,
      clamp01(snapshot.volume),
    );
    // 効きが 0 のときはぴたりと 1.0（基準サイズ）に戻す。
    return mix(1, scaled, clamp01(settings.sizeAmount));
  }

  /**
   * 色。**音の seed から決まる個別の色**で、帯域から直接は作らない。
   *
   * 白は 1 つの光の中では作らない。バーストの光が近くで交わったところが
   * 加算合成で白へ寄る、という**重なりの結果として創発**させる。
   * 例外は極端に強い発光だけで、そのときは彩度が落ちて白熱して見える。
   *
   * `hueOffset` はバーストの中での分光。同じ打撃から出た光を少しずつ違う色相に
   * ずらすので、交差したところで色が混ざって白が立ちやすくなる。
   */
  private color(
    snapshot: AudioEventSnapshot,
    settings: LightMappingSettings,
    hueOffset = 0,
  ): { r: number; g: number; b: number } {
    const seed = [snapshot.audioSeed, snapshot.eventIndex, snapshot.spectralCentroid];
    const hue = (hash01(...seed, 101) + hueOffset + 1) % 1;
    const saturationSeed = mix(
      LIGHT_MAPPING.colorSaturationMinimum,
      LIGHT_MAPPING.colorSaturationMaximum,
      hash01(...seed, 103),
    );
    // 明るい音ほど色が立つ。ただし色相そのものは centroid で決めない。
    const withCentroid = clamp01(
      saturationSeed +
        (clamp01(snapshot.spectralCentroid) - 0.5) * LIGHT_MAPPING.colorSaturationFromCentroid,
    );
    // 極端に強い発光だけは単体でも白へ寄る。
    const extreme = clamp01(
      (clamp01(snapshot.onsetStrength) - LIGHT_MAPPING.colorWhiteAtExtreme) /
        Math.max(1 - LIGHT_MAPPING.colorWhiteAtExtreme, 0.01),
    );
    const saturation = withCentroid * (1 - extreme);
    const rgb = hueToRgb(hue, mix(0, saturation, clamp01(settings.colorAmount)));
    return rgb;
  }

  /**
   * 速度。帯域が「重さ」を、onsetStrength が初速を、centroid が散らばりの鋭さを決める。
   * 向きは決定論ハッシュなので、同じ帯域でも上下左右前後どこへでも出る
   * （帯域を固定の方向に縛らない）。
   */
  private velocity(
    snapshot: AudioEventSnapshot,
    settings: LightMappingSettings,
  ): { x: number; y: number; z: number } {
    const amount = clamp01(settings.motionAmount);
    if (amount <= 0) return { x: 0, y: 0, z: 0 };

    const band = snapshot.winningBand;
    const base = LIGHT_MAPPING.speedByBand[band];
    const speed =
      base *
      mix(
        LIGHT_MAPPING.speedAtWeakOnset,
        LIGHT_MAPPING.speedAtStrongOnset,
        clamp01(snapshot.onsetStrength),
      );

    const seed = [
      snapshot.audioSeed,
      BAND_INDEX[band],
      snapshot.eventIndex,
      snapshot.spectralCentroid,
    ];
    // 球面上の一様な向き。どの帯域でも全方向へ出られる。
    const azimuth = hash01(...seed, 71) * Math.PI * 2;
    const cosine = hash01(...seed, 89) * 2 - 1;
    const sine = Math.sqrt(Math.max(1 - cosine * cosine, 0));

    // 散らばりの鋭さ。centroid が高いほど画面平行成分が絞られる。
    const spread = mix(
      LIGHT_MAPPING.spreadAtLowCentroid,
      LIGHT_MAPPING.spreadAtHighCentroid,
      clamp01(snapshot.spectralCentroid),
    );
    // 帯域ごとの奥行き寄り。0 で画面平行、1 で奥行き方向。
    const depthBias = LIGHT_MAPPING.depthBiasByBand[band];
    const planar = (1 - depthBias) * spread;

    return {
      x: Math.cos(azimuth) * sine * speed * planar * amount,
      y: Math.sin(azimuth) * sine * speed * planar * amount,
      z: cosine * speed * (0.25 + depthBias) * amount,
    };
  }
}

/** Trail のスライダー値（0..1）を履歴の秒数へ写す。 */
export const trailSeconds = (trail: number): number =>
  mix(LIGHT_MAPPING.trailSecondsAtMinimum, LIGHT_MAPPING.trailSecondsAtMaximum, trail);

const clampAbs = (value: number, limit: number): number =>
  Math.min(Math.max(value, -limit), limit);

/**
 * 色相（0..1）と彩度から RGB を作る。**最大成分は必ず 1**（明るさは含めない）。
 * 彩度 0 で白、1 で純色。加算合成で重なったときに白へ寄るのはこの外側で起きる。
 */
const hueToRgb = (hue: number, saturation: number): { r: number; g: number; b: number } => {
  const h = ((hue % 1) + 1) % 1;
  const channel = (offset: number): number => {
    const position = ((h + offset) % 1) * 6;
    const value = Math.max(0, Math.min(1, Math.min(position, 4 - position, 1)));
    // 彩度 0 で 1（白）、1 でその成分そのもの。
    return 1 - clamp01(saturation) * (1 - value);
  };
  return { r: channel(0), g: channel(2 / 3), b: channel(1 / 3) };
};

/**
 * **Bloom を音で駆動するための差し込み口。**
 *
 * いまは何もせず素通しする（スライダーの値がそのまま効く）。
 * 音に紐づけるときはここだけを書き換えれば、表現側は 1 行も変わらない。
 * 例: 盛り上がりで滲みを強くするなら `strengthScale` に sustain や
 * 直近のバースト密度を、静かな区間で敷居を上げるなら `thresholdOffset` に
 * volume の逆数を返す、といった形になる。
 *
 * 音のどの値を使うかはまだ決めていないので、引数もあえて取っていない。
 * 駆動を入れるときに `AudioEventSnapshot` を受け取る形へ広げる。
 */
export const bloomDrive = (): { strengthScale: number; thresholdOffset: number } => ({
  strengthScale: 1,
  thresholdOffset: 0,
});
