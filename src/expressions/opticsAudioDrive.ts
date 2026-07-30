import type { AudioParameters, SpectrumFrame } from '../audio/AudioEngine';
import { BandLightEventDetector } from '../engine/bandLightEvents';
import { CORE_SHAPES, RESPONSE_SECONDS, STROBE, type OpticsDrive } from './lightOpticsMapping';

/**
 * **音 → `OpticsDrive` の変換アダプタ（Light Element Lab 2）。**
 *
 * 固定光学リグは「音がエネルギーと波長を注ぎ込む」設計なので、
 * **注ぎ込む量を決めるのはこのファイルだけ**である。
 * リグ（`lightOpticsMapping.ts`）は `OpticsDrive` を受け取って形を組むだけ、
 * 描画（`LightElementLab2.ts`）は traits と uniform を描くだけで、
 * どちらも `AudioParameters` を直接は読まない。
 *
 * ---
 * ## 配線の段階（承認済みの手順）
 *
 * - **Step 1（実装済み）** 音量の持続 → 骨格・カーテン・膜の基礎輝度。
 *   **3 層は同じソース（volume）を、それぞれの時定数で受ける**
 *   （`RESPONSE_SECONDS`: 骨格 0.9s / カーテン 1.4s / 膜 2.6s）。
 *   音が止まれば 3 層とも黒へ沈むが、**膜が最後まで残って消える**。
 * - **Step 2（実装済み）** onset 強度 → `corePulse`。コアの脈動。
 *   `BandLightEventDetector` の発火 1 回につき **1 脈動**。
 *   **光は連続量として動かさない**ので、打撃の瞬間にその強さで現れ、
 *   1 ティック（実フレーム 2〜3 枚）で消える。フェードはしない。
 *   **強い打撃だけがコアを出す**（閾値 + 強い側を強調する曲線）。
 *   形状族は打撃の音のシードが選ぶので「毎回同じコア」にならない。
 * - **Step 3（未配線）** 帯域イベント → `fragmentEnergy`。断片の誕生。
 * - **Step 4（未配線）** 強 onset の閾値 → `fanGate`。放射の扇。
 * - **Step 5（未配線）** 音色の持続値 → `huePhase`。**補間せずイベント的に切り替える。**
 *   同じく音由来のシード → `seed`（断片・カーテンの散らばり）。
 *
 * 未配線のものは 0 を返すか、開発つまみの値をそのまま通す。
 * 段階を進めるときはこのファイルだけを触る。
 */

/** この変換の定数。**対応の数値はすべてここに集める。** */
const DRIVE = {
  /**
   * **コアを出す打撃の閾値。** これ未満の打撃ではコアを出さない。
   * 弱い打撃でも毎回光ると「常に光っている」ように見えて、
   * 強打の頂点が頂点に見えなくなる。
   */
  coreStrengthGate: 0.55,
  /**
   * 閾値を越えたぶんを **強い側へ寄せる曲線**の指数（> 1 で強調）。
   * ぎりぎり越えた打撃は控えめ、満点の打撃だけが白熱の頂点へ届く。
   */
  coreCurveExponent: 1.6,
  /** 閾値をぎりぎり越えた打撃の明るさ。 */
  coreMinimumPulse: 0.28,
  /**
   * コアを出しておく実フレーム数の下限。ティックの終わり際に来た打撃でも
   * 1 フレームで消えないようにするだけの保険。
   */
  coreMinimumFrames: 2,
  /**
   * 検出器の運転設定。Light Reactive Lab と同じ既定値をそのまま使う
   * （イベント列を別物にしないため）。開発つまみには出さない。
   */
  detection: {
    fluxGain: 2.5,
    onsetSensitivity: 0.5,
    cooldownSeconds: 0.06,
    relativeStrengthFloor: 1,
    adaptiveThreshold: true,
    adaptiveStrength: true,
    thresholdScale: 0.5,
  },
} as const;

/** 平滑された各層のドライブ。開発・検証用に外へ見せる。 */
export interface OpticsDriveLevels {
  readonly skeleton: number;
  readonly curtain: number;
  readonly haze: number;
  /** 平滑前のソース（音量の持続）。時定数の効きを見るために出す。 */
  readonly source: number;
  /** コアの脈動（0..1）。閾値を越えた打撃の 1 ティックだけ立つ。 */
  readonly corePulse: number;
  /** 発火した打撃の総数。 */
  readonly strikeCount: number;
  /** そのうちコアを出した（閾値を越えた）打撃の数。 */
  readonly pulseCount: number;
  /** 直近の打撃の強さと帯域。 */
  readonly lastStrength: number;
  readonly lastBand: string | null;
  /** 直近に選ばれたコアの形状族（−1 は素の芯）。 */
  readonly coreShape: number;
  /** 光学クロックのティック番号（−1 は連続表示）。 */
  readonly tick: number;
}

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/**
 * **dt ベースの指数平滑。** `alpha = 1 − exp(−dt/τ)` なので、
 * フレームレートが変わっても同じ時間で同じところへ着く。
 * τ は「目標との差が 1/e（≒ 37%）まで縮む時間」＝ 63% 到達時間である。
 */
const smooth = (current: number, target: number, deltaSeconds: number, tau: number): number => {
  if (tau <= 0) return target;
  const alpha = 1 - Math.exp(-Math.max(deltaSeconds, 0) / tau);
  return current + (target - current) * alpha;
};

/**
 * 音を受けて `OpticsDrive` を作る。**状態は各層のドライブだけ**で、
 * 形や色の判断はいっさい持たない（それはリグの仕事）。
 */
export class OpticsAudioDrive {
  private skeleton = 0;
  private curtain = 0;
  private haze = 0;
  private source = 0;

  /** 打撃の検出。**この表現は検出器を持つだけで、中身は一切変えない。** */
  private readonly detector = new BandLightEventDetector();
  private strikeCount = 0;
  private pulseCount = 0;
  private lastStrength = 0;
  private lastBand: string | null = null;

  // ---- 光学クロック（ストロボ）----
  /**
   * **光は連続量として動かさない。** 実フレームではなくこのティック単位で
   * 表示状態を再サンプルし、ティックの間は値を保持する（コマ送り）。
   */
  private strobeEnabled = true;
  private strobeRate: number = STROBE.defaultRate;
  private tickIndex = 0;
  private tickAccumulator = 0;
  /** ティックの頭で確定した「その表示期間ぶんの値」。表示中は動かない。 */
  private heldSkeleton = 0;
  private heldCurtain = 0;
  private heldHaze = 0;
  /** コアは打撃の 1 ティックだけ出る。値は打撃の瞬間に確定する。 */
  private heldCorePulse = 0;
  private heldCoreShape = -1;
  private coreTicksLeft = 0;
  private coreFramesLeft = 0;

  /** ストロボの入り切りと速度（開発つまみ）。A/B 比較のために外から触れる。 */
  setStrobe(enabled: boolean, rate: number): void {
    this.strobeEnabled = enabled;
    this.strobeRate = Math.max(rate, 1);
  }

  /** 表現を開き直したときに呼ぶ。前の曲の余韻も統計も持ち越さない。 */
  reset(): void {
    this.skeleton = 0;
    this.curtain = 0;
    this.haze = 0;
    this.source = 0;
    this.detector.reset();
    this.strikeCount = 0;
    this.pulseCount = 0;
    this.lastStrength = 0;
    this.lastBand = null;
    this.tickIndex = 0;
    this.tickAccumulator = 0;
    this.heldSkeleton = 0;
    this.heldCurtain = 0;
    this.heldHaze = 0;
    this.heldCorePulse = 0;
    this.heldCoreShape = -1;
    this.coreTicksLeft = 0;
    this.coreFramesLeft = 0;
  }

  /**
   * 1 フレーム進める。
   *
   * `active !== 1`（停止・音源なし）ではソースを 0 にするので、
   * 3 層はそれぞれの時定数で黒へ沈む。**カット時に瞬時に消えるのではなく、
   * 膜が最後まで残って消える**のが正しい見え方である（無音 = 黒・PRD D5）。
   *
   * **状態の量（遅い時定数）は連続で回し続けるが、見え方はティック単位で離散化する。**
   * 膜がゆっくり満ちて最後まで残る階層は保ったまま、表示は出し入れだけになる。
   */
  update(
    audio: AudioParameters,
    spectrum: SpectrumFrame | null,
    elapsed: number,
    deltaSeconds: number,
  ): void {
    const playing = audio.active === 1;

    // ---- 持続（Step 1）: 音量を 3 つの時定数で受ける（状態の量。連続で回す）----
    this.source = playing ? clamp01(audio.volume ?? 0) : 0;
    this.skeleton = smooth(this.skeleton, this.source, deltaSeconds, RESPONSE_SECONDS.skeleton);
    this.curtain = smooth(this.curtain, this.source, deltaSeconds, RESPONSE_SECONDS.curtain);
    this.haze = smooth(this.haze, this.source, deltaSeconds, RESPONSE_SECONDS.haze);

    if (this.coreFramesLeft > 0) this.coreFramesLeft -= 1;

    // ---- 光学クロック: ティックを跨いだら表示状態を再サンプルする ----
    if (this.strobeEnabled) {
      this.tickAccumulator += Math.max(deltaSeconds, 0);
      const tickSeconds = 1 / this.strobeRate;
      // 巨大な delta でティックを無限に回さないよう、進める数に上限を置く。
      let steps = 0;
      while (this.tickAccumulator >= tickSeconds && steps < 8) {
        this.tickAccumulator -= tickSeconds;
        this.tickIndex += 1;
        steps += 1;
        this.onTick();
      }
      if (steps >= 8) this.tickAccumulator = 0;
    } else {
      // ストロボを切っているあいだは、そのまま連続の値を見せる。
      this.heldSkeleton = this.skeleton;
      this.heldCurtain = this.curtain;
      this.heldHaze = this.haze;
    }

    if (!playing) {
      this.heldCorePulse = 0;
      this.coreTicksLeft = 0;
      this.coreFramesLeft = 0;
      return;
    }

    // ---- 打撃（Step 2）: 閾値を越えたものだけがコアを出す ----
    const events = this.detector.update(
      spectrum,
      {
        volume: clamp01(audio.volume ?? 0),
        bass: clamp01(audio.bass ?? 0),
        mid: clamp01(audio.mid ?? 0),
        treble: clamp01(audio.treble ?? 0),
        spectralCentroid: clamp01(audio.centroid ?? 0),
        spectralFlatness: clamp01(audio.flatness ?? 0),
        audioSeed: clamp01(audio.seed ?? 0),
      },
      elapsed,
      deltaSeconds,
      DRIVE.detection,
    );

    for (const event of events) {
      const strength = clamp01(event.strength);
      this.strikeCount += 1;
      this.lastStrength = strength;
      this.lastBand = event.band;
      // **強い音のときだけ光る。** 閾値未満はコアを出さない。
      if (strength < DRIVE.coreStrengthGate) continue;
      const above = (strength - DRIVE.coreStrengthGate) / (1 - DRIVE.coreStrengthGate);
      const pulse =
        DRIVE.coreMinimumPulse +
        (1 - DRIVE.coreMinimumPulse) * Math.pow(clamp01(above), DRIVE.coreCurveExponent);
      // **表示のたびに確定する。** この表示期間のあいだ、値は動かない。
      this.heldCorePulse = Math.max(this.heldCorePulse, pulse);
      // 形状族は打撃の音のシードで選ぶ。層化して引くので「毎回同じコア」にならない。
      const offset = Math.floor(clamp01(event.snapshot.audioSeed) * CORE_SHAPES.length);
      this.heldCoreShape = (event.eventIndex + offset) % CORE_SHAPES.length;
      this.coreTicksLeft = 1;
      this.coreFramesLeft = DRIVE.coreMinimumFrames;
      this.pulseCount += 1;
    }
  }

  /**
   * ティックの頭。**ここでだけ表示状態が変わる。**
   * 遅い層はいまの状態の量を写し取り、コアは 1 ティックで消える。
   */
  private onTick(): void {
    this.heldSkeleton = this.skeleton;
    this.heldCurtain = this.curtain;
    this.heldHaze = this.haze;
    if (this.coreTicksLeft > 0) {
      this.coreTicksLeft -= 1;
      if (this.coreTicksLeft <= 0 && this.coreFramesLeft <= 0) this.heldCorePulse = 0;
    } else {
      this.heldCorePulse = 0;
    }
  }

  /** 開発・検証用。時定数の効きと打撃を時系列で測るために読む。 */
  levels(): OpticsDriveLevels {
    return {
      skeleton: this.skeleton,
      curtain: this.curtain,
      haze: this.haze,
      source: this.source,
      corePulse: this.publishedCorePulse(),
      strikeCount: this.strikeCount,
      pulseCount: this.pulseCount,
      lastStrength: this.lastStrength,
      lastBand: this.lastBand,
      coreShape: this.publishedCorePulse() > 0 ? this.heldCoreShape : -1,
      tick: this.strobeEnabled ? this.tickIndex : -1,
    };
  }

  /** コアが出ているのは、打撃のティックのあいだだけ。 */
  private publishedCorePulse(): number {
    return this.coreTicksLeft > 0 || this.coreFramesLeft > 0 ? this.heldCorePulse : 0;
  }

  /**
   * いまの状態から `OpticsDrive` を作る。
   *
   * **公開するのはティックの頭で確定した値**（`held*`）で、連続の平滑値ではない。
   * 光は連続量として動かさず、ティックの間は同じ状態を保つ。
   *
   * `manual` は開発つまみが作ったドライブで、**まだ配線していない入力は
   * そこからそのまま通す**（`huePhase` と `seed` は開発つまみの値を維持する）。
   */
  toDrive(manual: OpticsDrive): OpticsDrive {
    const pulse = this.publishedCorePulse();
    return {
      skeletonLevel: this.heldSkeleton,
      curtainLevel: this.heldCurtain,
      hazeLevel: this.heldHaze,
      corePulse: pulse,
      // Step 3〜4 で配線する。それまでは 0（＝その層は出ない）。
      fragmentEnergy: 0,
      fanGate: 0,
      // Step 5 で配線する。それまでは開発つまみの値をそのまま使う。
      huePhase: manual.huePhase,
      seed: manual.seed,
      tick: this.strobeEnabled ? this.tickIndex : -1,
      coreShape: pulse > 0 ? this.heldCoreShape : -1,
      // 奥行き計測つまみは音とは無関係の開発用なので、常に開発つまみの値。
      depthProbe: manual.depthProbe,
    };
  }
}
