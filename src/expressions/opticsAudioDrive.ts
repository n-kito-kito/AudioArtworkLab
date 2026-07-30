import type { AudioParameters } from '../audio/AudioEngine';
import type { OpticsDrive } from './lightOpticsMapping';

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
 * - **Step 0（このファイルの現状）** 骨組みだけ。**層を出すドライブをすべて 0 で返す**ので、
 *   Audio モードは常に黒になる。見た目を変えずに切替の器だけを用意する段。
 * - **Step 1** 音量の持続 → 骨格・カーテン・膜の基礎輝度。
 *   3 層は同じソースを、それぞれの時定数（`RESPONSE_SECONDS`）で受ける。
 * - **Step 2** onset 強度 → `corePulse`。コアの脈動。
 * - **Step 3** 帯域イベント → `fragmentEnergy`。断片の誕生。
 * - **Step 4** 強 onset の閾値 → `fanGate`。放射の扇。
 * - **Step 5** 音色の持続値 → `huePhase`（補間せずイベント的に切替）と、
 *   音由来のシード → `seed`。
 *
 * 未配線のものは 0 を返すか、開発つまみの値をそのまま通す。
 * 段階を進めるときはこのファイルだけを触る。
 */

/** 平滑された 3 層の基礎輝度。開発・検証用に外へ見せる。 */
export interface OpticsDriveLevels {
  readonly skeleton: number;
  readonly curtain: number;
  readonly haze: number;
  /** 平滑前のソース（音量の持続）。時定数の効きを見るために出す。 */
  readonly source: number;
}

/**
 * 音を受けて `OpticsDrive` を作る。**状態は平滑された 3 層の輝度だけ**で、
 * 形や色の判断はいっさい持たない（それはリグの仕事）。
 */
export class OpticsAudioDrive {
  private skeleton = 0;
  private curtain = 0;
  private haze = 0;
  private source = 0;

  /** 表現を開き直したときに呼ぶ。前の曲の余韻を持ち越さない。 */
  reset(): void {
    this.skeleton = 0;
    this.curtain = 0;
    this.haze = 0;
    this.source = 0;
  }

  /**
   * 1 フレーム進める。
   * **Step 0 ではまだ音を読まない**（配線は Step 1 から）。
   */
  update(audio: AudioParameters, deltaSeconds: number): void {
    void audio;
    void deltaSeconds;
  }

  /** 開発・検証用。時定数の効きを時系列で測るために読む。 */
  levels(): OpticsDriveLevels {
    return {
      skeleton: this.skeleton,
      curtain: this.curtain,
      haze: this.haze,
      source: this.source,
    };
  }

  /**
   * いまの状態から `OpticsDrive` を作る。
   *
   * `manual` は開発つまみが作ったドライブで、**まだ配線していない入力は
   * そこからそのまま通す**（`huePhase` と `seed` は開発つまみの値を維持する）。
   * **Step 0 では層を出すドライブがすべて 0** なので、Audio モードは常に黒になる。
   */
  toDrive(manual: OpticsDrive): OpticsDrive {
    return {
      // Step 1 で配線する。
      skeletonLevel: 0,
      curtainLevel: 0,
      hazeLevel: 0,
      // Step 2〜4 で配線する。それまでは 0（＝その層は出ない）。
      corePulse: 0,
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
