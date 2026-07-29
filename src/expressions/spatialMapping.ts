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
export type LightShapeKind = 'spark' | 'needle' | 'arc' | 'plane';

/** 形の指定。描画側はこれを見て板の張り方と減衰を変える。 */
export interface LightShape {
  readonly kind: LightShapeKind;
  /** 軸方向の伸び（1 で等方の点、大きいほど細長い光条）。 */
  readonly elongation: number;
  /** 軸の向き（ラジアン。画面平面での角度）。 */
  readonly angle: number;
  /** 軸のうねり（0 でまっすぐ、大きいほど曲がる）。**振幅は小さく保つ。** */
  readonly waviness: number;
  /**
   * `plane` のときだけ使う面の法線（ワールド空間）。
   * X/Y/Z 軸平面を基本に、seed で少し傾ける。他の形では null。
   */
  readonly normal: { readonly x: number; readonly y: number; readonly z: number } | null;
}

/**
 * **1 つの光の中の色の移り変わり。**
 *
 * 狙いは「発光体が一色で光る」ことではなく、**プリズムを通った光**が空間に現れた状態。
 * 1 要素の内部でスペクトル上を少し進む色相の並びを持ち、白 → 一色にはならない。
 *
 * 色相は**ラップさせずに連続値のまま**持つ（0.95 → 1.05 のような並びをそのまま補間し、
 * 描画側の `fract` で環に戻す）。0.95 → 0.05 に折り返すと補間が色相環を逆走する。
 */
export interface LightGradient {
  /**
   * 形式。`GRADIENT_FORM` の番号で、seed が選ぶ。
   * 0 放射状 / 1 放射状（反転）/ 2 軸方向 / 3 軸直交 / 4 角度方向。
   */
  readonly form: number;
  /** 等間隔 4 点へリサンプルした色相。元のストップ数は 2〜4。 */
  readonly hues: readonly [number, number, number, number];
  /** 同・彩度。0 で白。 */
  readonly saturations: readonly [number, number, number, number];
}

/** グラデーションの形式。描画側の分岐と 1 対 1 に対応する。 */
export const GRADIENT_FORM = {
  radial: 0,
  radialInverted: 1,
  axial: 2,
  transverse: 3,
  angular: 4,
} as const;

/** 1 つの光が生まれるときに決まる見え方。決まったら寿命の間は変えない。 */
export interface LightVisualTraits {
  readonly role: LightRole;
  readonly position: SpatialPosition;
  /** 明るさの倍率（0..1）。Core ごとの明るさはこれだけで決まる。 */
  readonly intensity: number;
  /** 大きさの倍率（1 が基準サイズ）。 */
  readonly size: number;
  /**
   * 代表色。明るさとは分けてあり、**比率だけ**を表す（最大成分が 1 に正規化される）。
   * 実際に描かれるのは `gradient` のほうで、これは検証・状態表示のための 1 点サンプル。
   */
  readonly color: { readonly r: number; readonly g: number; readonly b: number };
  /** 1 要素の内部で色相が動く並び。描画はこれを補間する。 */
  readonly gradient: LightGradient;
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
  /**
   * 大きさの時間変化（発生時 → 寿命の終わり）。
   * 平面のフラッシュは中心から外へ一気に開くので、ここが大きく動く。
   * 点や光条は 1 → 1 で、発生時のまま変わらない。
   */
  readonly expansion: { readonly from: number; readonly to: number };
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
  /**
   * 配置の流儀。
   * `center` は原点付近へ集めて**光の層を重ねる**（既定）。
   * `scatter` は音由来の決定論配置で空間へ散らす（従来）。
   */
  readonly placementMode: 'center' | 'scatter';
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
  // ---- 1 要素の内部の分光（グラデーション）----
  /**
   * **1 つの発光の中で色相が連続的に変わる**ようにするための並び。
   * 単体では「白 → 一色」で終わらせず、プリズムの分光のように
   * スペクトル上を少し進んだ色が 1 要素の中に同居する。
   */
  /** 形式の種類数。0..この数−1 を seed が選ぶ（`GRADIENT_FORM` と対応）。 */
  gradientFormCount: 5,
  /**
   * 色相の走る幅（狭い側 = 隣接色、広い側 = やや離れた色）。1.0 で色相環一周。
   * 狭い側でも 0.1（36°）は動かす。これ以下だと単色にしか見えない。
   * 広い側は 0.5（180°）まで。ここを超えると 1 要素の中で補色が同居して濁る。
   */
  gradientSpanNarrow: 0.1,
  gradientSpanWide: 0.5,
  /** ストップの数（2〜4）。少ないほど単純な移り、多いほど虹寄りになる。 */
  gradientStopsMinimum: 2,
  gradientStopsMaximum: 4,
  /**
   * 走りの途中で色相が折り返す確率（ストップ 3 個以上のとき）。
   * 直線の走りばかりだと分光が均質に見えるので、山形も混ぜる。
   */
  gradientTurnProbability: 0.38,
  /**
   * 彩度の端の落ち具合。白い端（芯が白く抜けるプリズムらしさ）を作る側の倍率。
   * 0 で完全な白、1 で落とさない。
   */
  gradientWhiteEndScale: 0.14,
  /** 彩度が一定の並びを選ぶ確率。残りは白 → 色 と 色 → 白 に半々で割れる。 */
  gradientFlatSaturationProbability: 0.26,

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
  subCountBase: 3,
  subCountPerVolume: 8,
  subCountPerOnset: 5,
  subCountPerNovelty: 6,
  /**
   * 1 バーストのサブの上限。
   * 原点へ集めて層を重ねる狙いなので、以前より厚くしてある。
   * 上限は 60fps とドローコール 1 を保てる範囲で実測して決めた。
   */
  subCountMaximum: 30,
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
  /**
   * 光条の向きの偏り。**横に伸びるもの・縦に伸びるものを主にする。**
   * 完全な自由方向だと放射状の花火に見えてしまい、リファレンスの
   * 「層が重なる」感じから離れる。0 で完全に水平／垂直、1 で自由。
   */
  needleAxisDeviation: 0.22,

  // ---- 原点集中の配置（`placementMode: 'center'`）----
  /** 中心からのゆらぎ（ワールド単位）。同一点に重ねず、わずかにずらして層にする。 */
  centerJitter: 0.55,
  /** 中心配置で使う奥行きの幅（ワールド単位）。狭いほど層が密に重なる。 */
  centerDepthJitter: 2.6,
  /** 中心配置の基準の奥行き。 */
  centerDepth: 9,
  /** 中心から少し離して散らすサブの割合（0..1）。「周辺の細かい散り」。 */
  outerFraction: 0.26,
  /** 同・離す距離（可視範囲の半分に対する割合）。 */
  outerSpreadMinimum: 0.25,
  outerSpreadMaximum: 0.72,
  /** 同・大きさの倍率。周辺は小さく細かく。 */
  outerSizeScale: 0.42,

  // ---- 軸平面のフラッシュ ----
  /** 1 バーストで開く平面の枚数（下限・上限）。onset の強さで増える。 */
  planeCountMinimum: 1,
  planeCountMaximum: 6,
  /** 平面の法線を軸からどれだけ傾けるか（0 で完全な軸平面、1 で自由）。 */
  planeAxisDeviation: 0.3,
  /** 平面の開き始めと開ききりの大きさ（Core の基準サイズに対する倍率）。 */
  planeScaleFrom: 0.5,
  planeScaleTo: 16,
  /** 平面の明るさ（メインに対する倍率）。**透けるように淡く。** */
  planeIntensityMinimum: 0.1,
  planeIntensityMaximum: 0.26,
  /** 平面の寿命（メインに対する倍率）。瞬間的に開いて消える。 */
  planeLifetimeMinimum: 0.5,
  planeLifetimeMaximum: 1.1,
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
    const origin =
      settings.placementMode === 'center'
        ? this.centerOrigin(snapshot, visible)
        : this.positions.resolve(event, visible);
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
        gradient: this.gradient(snapshot, settings, 0, 0),
        velocity: mainVelocity,
        lifetime: {
          attackSeconds: settings.attackSeconds,
          holdSeconds: settings.holdSeconds,
          decaySeconds: settings.decaySeconds,
        },
        trail,
        // メインは等方の点。形のバリエーションはサブが担う。
        shape: {
          kind: 'spark',
          elongation: LIGHT_MAPPING.mainElongation,
          angle: 0,
          waviness: 0,
          normal: null,
        },
        expansion: { from: 1, to: 1 },
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
      // 一部だけは遠くへ小さく飛ばして「周辺の細かい散り」を作る。
      const outer = h(41) < LIGHT_MAPPING.outerFraction;
      const angle = h(5) * Math.PI * 2;
      const radius = outer
        ? mix(LIGHT_MAPPING.outerSpreadMinimum, LIGHT_MAPPING.outerSpreadMaximum, h(7))
        : mix(LIGHT_MAPPING.subSpreadMinimum, LIGHT_MAPPING.subSpreadMaximum, h(7));
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
      const sizeScale =
        mix(LIGHT_MAPPING.subSizeMinimum, LIGHT_MAPPING.subSizeMaximum, h(11)) *
        (outer ? LIGHT_MAPPING.outerSizeScale : 1);
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
          gradient: this.gradient(snapshot, settings, hueOffset, 1 + i),
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
          // 遠くへ飛ぶものは細かいスパークに寄せる。
          shape: outer
            ? { kind: 'spark', elongation: 1, angle: 0, waviness: 0, normal: null }
            : this.shape(snapshot, h),
          expansion: { from: 1, to: 1 },
        },
      });
    }

    // 軸平面のフラッシュ。原点から XY / XZ / YZ 平面に沿って一気に開く。
    const planes = Math.round(
      mix(
        LIGHT_MAPPING.planeCountMinimum,
        LIGHT_MAPPING.planeCountMaximum,
        clamp01(snapshot.onsetStrength),
      ),
    );
    for (let i = 0; i < planes; i++) {
      const h = (salt: number): number => hash01(...seed, 900 + i, salt);
      // 3 軸平面のどれかを基本にして、seed で少し傾ける（完全な軸固定にしない）。
      const axis = Math.floor(h(2) * 3) % 3;
      const base = [
        { x: 0, y: 0, z: 1 }, // XY 平面
        { x: 0, y: 1, z: 0 }, // XZ 平面
        { x: 1, y: 0, z: 0 }, // YZ 平面
      ][axis]!;
      const tilt = LIGHT_MAPPING.planeAxisDeviation;
      const normal = normalise({
        x: base.x + (h(4) * 2 - 1) * tilt,
        y: base.y + (h(6) * 2 - 1) * tilt,
        z: base.z + (h(8) * 2 - 1) * tilt,
      });
      const lifeScale = mix(
        LIGHT_MAPPING.planeLifetimeMinimum,
        LIGHT_MAPPING.planeLifetimeMaximum,
        h(10),
      );
      const planeHueOffset = (h(16) * 2 - 1) * LIGHT_MAPPING.colorHueSpreadInBurst;
      lights.push({
        delaySeconds: mix(0, LIGHT_MAPPING.subDelayMaximum * 0.5, h(12)),
        traits: {
          role: 'sub',
          position: origin,
          intensity:
            mainIntensity *
            mix(LIGHT_MAPPING.planeIntensityMinimum, LIGHT_MAPPING.planeIntensityMaximum, h(14)),
          size: mainSize,
          color: this.color(snapshot, settings, planeHueOffset),
          gradient: this.gradient(snapshot, settings, planeHueOffset, 900 + i),
          // 平面は動かない。開くことそのものが動き。
          velocity: { x: 0, y: 0, z: 0 },
          lifetime: {
            attackSeconds: settings.attackSeconds * 0.5,
            holdSeconds: settings.holdSeconds * lifeScale * 0.4,
            decaySeconds: settings.decaySeconds * lifeScale,
          },
          trail: 0,
          shape: { kind: 'plane', elongation: 1, angle: 0, waviness: 0, normal },
          expansion: { from: LIGHT_MAPPING.planeScaleFrom, to: LIGHT_MAPPING.planeScaleTo },
        },
      });
    }
    return lights;
  }

  /**
   * 原点付近の位置。**同一点には置かず、決定論の微小ジッターでわずかにずらす。**
   * こうすると光が「ほぼ中心・少しずつずれて層になる」状態になり、
   * 加算で重なった中心が複雑に見える。
   */
  private centerOrigin(snapshot: AudioEventSnapshot, visible: VisibleExtent): SpatialPosition {
    const seed = [snapshot.audioSeed, snapshot.eventIndex, BAND_INDEX[snapshot.winningBand]];
    const depth =
      LIGHT_MAPPING.centerDepth +
      (hash01(...seed, 61) * 2 - 1) * LIGHT_MAPPING.centerDepthJitter;
    const extent = visible(Math.max(depth, 1));
    const jitter = LIGHT_MAPPING.centerJitter;
    return {
      x: clampAbs((hash01(...seed, 63) * 2 - 1) * jitter, extent.halfWidth * 0.9),
      y: clampAbs((hash01(...seed, 65) * 2 - 1) * jitter, extent.halfHeight * 0.9),
      z: -Math.max(depth, 1),
    };
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

    // 向きは水平か垂直を基本にして、seed で少しだけ逸らす。
    // 自由方向のままだと放射状の花火に見えて、層の重なりが読めなくなる。
    const vertical = h(39) < 0.5;
    const angle =
      (vertical ? Math.PI / 2 : 0) +
      (h(37) * 2 - 1) * LIGHT_MAPPING.needleAxisDeviation * Math.PI;

    return { kind, elongation, angle, waviness, normal: null };
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
    const { hue, saturation } = this.tone(snapshot, settings, hueOffset);
    return hueToRgb(hue, saturation);
  }

  /**
   * 色の素（色相と彩度）。`color` と `gradient` はどちらもここから作るので、
   * 代表色とグラデーションが別々の色相を持つことはない。
   *
   * **色相はラップさせずに返す**（0.98 + 0.1 = 1.08 のまま）。
   * グラデーションの補間は連続値でないと色相環を逆走してしまう。
   */
  private tone(
    snapshot: AudioEventSnapshot,
    settings: LightMappingSettings,
    hueOffset: number,
  ): { hue: number; saturation: number } {
    const seed = [snapshot.audioSeed, snapshot.eventIndex, snapshot.spectralCentroid];
    const hue = hash01(...seed, 101) + hueOffset;
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
    return { hue, saturation: mix(0, saturation, clamp01(settings.colorAmount)) };
  }

  /**
   * **1 要素の内部の分光。** 形式・色相の走る幅・向き・ストップ数・彩度の並びを
   * すべて音由来の決定論ハッシュで決める（`Math.random()` は使わない）。
   *
   * `variant` は同じイベントの中で光ごとに別の流れを取るための番号。
   * これがないとバースト中の全部が同じグラデーションになる。
   */
  private gradient(
    snapshot: AudioEventSnapshot,
    settings: LightMappingSettings,
    hueOffset: number,
    variant: number,
  ): LightGradient {
    const { hue, saturation } = this.tone(snapshot, settings, hueOffset);
    const seed = [snapshot.audioSeed, snapshot.eventIndex, variant];
    const h = (salt: number): number => hash01(...seed, salt);

    const form = Math.min(
      Math.floor(h(211) * LIGHT_MAPPING.gradientFormCount),
      LIGHT_MAPPING.gradientFormCount - 1,
    );
    const range = LIGHT_MAPPING.gradientStopsMaximum - LIGHT_MAPPING.gradientStopsMinimum;
    const stops = Math.min(
      LIGHT_MAPPING.gradientStopsMinimum + Math.floor(h(213) * (range + 1)),
      LIGHT_MAPPING.gradientStopsMaximum,
    );
    const span =
      mix(LIGHT_MAPPING.gradientSpanNarrow, LIGHT_MAPPING.gradientSpanWide, h(215)) *
      (h(217) < 0.5 ? -1 : 1);
    // 3 ストップ以上のときだけ、走った色相が途中で折り返す並びを混ぜる。
    const turns = stops >= 3 && h(219) < LIGHT_MAPPING.gradientTurnProbability;
    // 彩度の並び: 0 = 白 → 色 / 1 = 色 → 白 / 2 = 一定。
    const saturationMode =
      h(221) < LIGHT_MAPPING.gradientFlatSaturationProbability ? 2 : h(223) < 0.5 ? 0 : 1;

    const hueStops: number[] = [];
    const saturationStops: number[] = [];
    for (let i = 0; i < stops; i++) {
      const u = i / (stops - 1);
      // 折り返す並びは山形（0 → 1 → 0）にして、同じ幅の中を往復させる。
      const travel = turns ? 1 - Math.abs(u * 2 - 1) : u;
      hueStops.push(hue + span * travel);
      const white = LIGHT_MAPPING.gradientWhiteEndScale;
      const ramp = saturationMode === 2 ? 1 : saturationMode === 0 ? mix(white, 1, u) : mix(1, white, u);
      saturationStops.push(saturation * ramp);
    }
    return { form, hues: resample4(hueStops), saturations: resample4(saturationStops) };
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
 * 2〜4 個のストップからなる折れ線を、等間隔 4 点へリサンプルする。
 * 描画側は常に 4 点を受け取るので、ストップ数が変わっても属性の形は変わらない
 * （インスタンス属性は固定長でないと 1 ドローを保てない）。
 */
const resample4 = (values: number[]): [number, number, number, number] => {
  const last = Math.max(values.length - 1, 1);
  const at = (t: number): number => {
    const u = clamp01(t) * last;
    const index = Math.min(Math.floor(u), last - 1);
    const a = values[index] ?? 0;
    const b = values[index + 1] ?? a;
    return a + (b - a) * (u - index);
  };
  return [at(0), at(1 / 3), at(2 / 3), at(1)];
};

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

/** 単位ベクトルへ。長さが 0 のときは Z 軸へ倒す。 */
const normalise = (v: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!(length > 1e-6)) return { x: 0, y: 0, z: 1 };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
};
