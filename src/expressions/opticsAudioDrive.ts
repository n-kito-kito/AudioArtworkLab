import type { AudioParameters, SpectrumFrame } from '../audio/AudioEngine';
import { BandLightEventDetector } from '../engine/bandLightEvents';
import { RESPONSE_SECONDS, type OpticsDrive } from './lightOpticsMapping';

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
 *   立ち上がりは**そのフレームで即座**（滑らかに上げると打撃が消える）、
 *   短い Hold のあと `RESPONSE_SECONDS.core` で戻る。
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
   * **脈動の Hold（秒）。** 打撃の頂点を数フレームだけ保つ。
   * 0 にすると 1 フレームで落ち始めるので、点滅が目で追えなくなる。
   */
  corePulseHold: 0.035,
  /**
   * 脈動の下限。検出器が拾った以上は必ず目に見える明るさにする。
   * これより弱い strength でも「1 打あった」ことは分かる。
   */
  corePulseFloor: 0.22,
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
  /** コアの脈動（0..1）。打撃で跳ね、短い Hold のあと落ちる。 */
  readonly corePulse: number;
  /** 発火した打撃の総数。1 打 = 1 脈動であることを数で確かめるために出す。 */
  readonly pulseCount: number;
  /** 直近の打撃の強さと帯域。 */
  readonly lastStrength: number;
  readonly lastBand: string | null;
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
  private corePulse = 0;
  private holdRemaining = 0;
  private pulseCount = 0;
  private lastStrength = 0;
  private lastBand: string | null = null;

  /** 表現を開き直したときに呼ぶ。前の曲の余韻も統計も持ち越さない。 */
  reset(): void {
    this.skeleton = 0;
    this.curtain = 0;
    this.haze = 0;
    this.source = 0;
    this.detector.reset();
    this.corePulse = 0;
    this.holdRemaining = 0;
    this.pulseCount = 0;
    this.lastStrength = 0;
    this.lastBand = null;
  }

  /**
   * 1 フレーム進める。
   *
   * `active !== 1`（停止・音源なし）ではソースを 0 にするので、
   * 3 層はそれぞれの時定数で黒へ沈む。**カット時に瞬時に消えるのではなく、
   * 膜が最後まで残って消える**のが正しい見え方である（無音 = 黒・PRD D5）。
   * 脈動は止まった瞬間にゼロへ落とす（余韻の残った打撃は無いため）。
   */
  update(
    audio: AudioParameters,
    spectrum: SpectrumFrame | null,
    elapsed: number,
    deltaSeconds: number,
  ): void {
    const playing = audio.active === 1;

    // ---- 持続（Step 1）: 音量を 3 つの時定数で受ける ----
    this.source = playing ? clamp01(audio.volume ?? 0) : 0;
    this.skeleton = smooth(this.skeleton, this.source, deltaSeconds, RESPONSE_SECONDS.skeleton);
    this.curtain = smooth(this.curtain, this.source, deltaSeconds, RESPONSE_SECONDS.curtain);
    this.haze = smooth(this.haze, this.source, deltaSeconds, RESPONSE_SECONDS.haze);

    // ---- 脈動（Step 2）: 打撃の瞬間だけ跳ねる ----
    if (!playing) {
      this.corePulse = 0;
      this.holdRemaining = 0;
      return;
    }

    // 先に古い脈動を進める。こうすると同じフレームで来た新しい打撃が
    // **減衰に食われずそのまま頂点になる**（立ち上がりが 1 フレーム）。
    if (this.holdRemaining > 0) {
      this.holdRemaining = Math.max(this.holdRemaining - deltaSeconds, 0);
    } else {
      this.corePulse = smooth(this.corePulse, 0, deltaSeconds, RESPONSE_SECONDS.core);
    }

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
      // 同じフレームに複数帯域が来たら、いちばん強い打撃が頂点になる。
      const strength = Math.max(clamp01(event.strength), DRIVE.corePulseFloor);
      this.corePulse = Math.max(this.corePulse, strength);
      this.holdRemaining = DRIVE.corePulseHold;
      this.pulseCount += 1;
      this.lastStrength = strength;
      this.lastBand = event.band;
    }
  }

  /** 開発・検証用。時定数の効きと打撃を時系列で測るために読む。 */
  levels(): OpticsDriveLevels {
    return {
      skeleton: this.skeleton,
      curtain: this.curtain,
      haze: this.haze,
      source: this.source,
      corePulse: this.corePulse,
      pulseCount: this.pulseCount,
      lastStrength: this.lastStrength,
      lastBand: this.lastBand,
    };
  }

  /**
   * いまの状態から `OpticsDrive` を作る。
   *
   * `manual` は開発つまみが作ったドライブで、**まだ配線していない入力は
   * そこからそのまま通す**（`huePhase` と `seed` は開発つまみの値を維持する）。
   */
  toDrive(manual: OpticsDrive): OpticsDrive {
    return {
      skeletonLevel: this.skeleton,
      curtainLevel: this.curtain,
      hazeLevel: this.haze,
      corePulse: this.corePulse,
      // Step 3〜4 で配線する。それまでは 0（＝その層は出ない）。
      fragmentEnergy: 0,
      fanGate: 0,
      // Step 5 で配線する。それまでは開発つまみの値をそのまま使う。
      huePhase: manual.huePhase,
      seed: manual.seed,
      // 奥行き計測つまみは音とは無関係の開発用なので、常に開発つまみの値。
      depthProbe: manual.depthProbe,
    };
  }
}
