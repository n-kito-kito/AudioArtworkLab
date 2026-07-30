import type { AudioParameters } from '../audio/AudioEngine';
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
 * - **Step 2（未配線）** onset 強度 → `corePulse`。コアの脈動。
 * - **Step 3（未配線）** 帯域イベント → `fragmentEnergy`。断片の誕生。
 * - **Step 4（未配線）** 強 onset の閾値 → `fanGate`。放射の扇。
 * - **Step 5（未配線）** 音色の持続値 → `huePhase`。**補間せずイベント的に切り替える。**
 *   同じく音由来のシード → `seed`（断片・カーテンの散らばり）。
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
   *
   * `active !== 1`（停止・音源なし）ではソースを 0 にするので、
   * 3 層はそれぞれの時定数で黒へ沈む。**カット時に瞬時に消えるのではなく、
   * 膜が最後まで残って消える**のが正しい見え方である（無音 = 黒・PRD D5）。
   */
  update(audio: AudioParameters, deltaSeconds: number): void {
    const playing = audio.active === 1;
    // Step 1 のソースは音量の持続だけ。onset も帯域もまだ見ない。
    this.source = playing ? clamp01(audio.volume ?? 0) : 0;
    this.skeleton = smooth(this.skeleton, this.source, deltaSeconds, RESPONSE_SECONDS.skeleton);
    this.curtain = smooth(this.curtain, this.source, deltaSeconds, RESPONSE_SECONDS.curtain);
    this.haze = smooth(this.haze, this.source, deltaSeconds, RESPONSE_SECONDS.haze);
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
   * 逆に Step 2〜4 の入力（コア脈動・断片・扇）は配線するまで 0 のままなので、
   * Audio モードでは骨格・カーテン・膜の 3 層だけが出る。
   */
  toDrive(manual: OpticsDrive): OpticsDrive {
    return {
      skeletonLevel: this.skeleton,
      curtainLevel: this.curtain,
      hazeLevel: this.haze,
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
