import type { AudioParameters, SpectrumFrame } from '../audio/AudioEngine';
import { BandLightEventDetector } from '../engine/bandLightEvents';
import {
  ARM_SETS,
  CORE_SHAPES,
  RESPONSE_SECONDS,
  STROBE,
  type FragmentSpawn,
  type OpticsDrive,
} from './lightOpticsMapping';

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
 * - **Step 3（実装済み）** 帯域イベント → 断片の誕生。
 *   1 イベントで 1〜4 枚。枚数は打撃の強さと新奇性で増え、上限で頭打ちになる
 *   （上限時は**新規を抑制**する。最古を突然消すと消えたことが見えてしまう）。
 *   形・位置・縦横比・欠け・傾きは**イベント固有の音シード**だけから決まる。
 *   寿命はティックで数え（1〜4）、生きているあいだ on / off を交互に繰り返して
 *   最後のティックで消える。**フェードはしない。**
 * - **Step 4（実装済み）** 強 onset の閾値 → `fanGate`。放射の扇。
 *   **コアより高い閾値**を越えた強打だけが扇を開く。階層は
 *   **弱打 = 無 / 中打 = コア + アーム / 強打 = コア + アーム + 扇**。
 *   打撃ティックで即出現し、2〜4 ティックの寿命のあいだ on / off を交互に繰り返して、
 *   最後のティックで**フェードせずに**消える。広がり・強さは打撃の強さに追従し、
 *   向きと角度幅には打撃のシード由来の個体差が入る（下向き基本は動かさない）。
 * - **Step 5（未配線）** 音色の持続値 → `huePhase`。**補間せずイベント的に切り替える。**
 *   同じく音由来のシード → `seed`（断片・カーテンの散らばり）。
 *
 * 未配線のものは 0 を返すか、開発つまみの値をそのまま通す。
 * 段階を進めるときはこのファイルだけを触る。
 */

/** この変換の定数。**対応の数値はすべてここに集める。** */
const DRIVE = {
  /**
   * **コアを出す打撃の閾値（既定）。** これ未満の打撃ではコアを出さない。
   * 弱い打撃でも毎回光ると「常に光っている」ように見えて、
   * 強打の頂点が頂点に見えなくなる。
   *
   * 0.55 では落ちる打撃が多すぎて閃きが疎になったので **0.38 まで下げた**。
   * 強い側を強調する曲線（`coreCurveExponent`）はそのままなので、
   * 「弱い打撃も光るが、頂点は強打だけ」という階層は保たれる。
   * 開発つまみ `Core threshold` から動かせる（本番 UI には出さない）。
   */
  coreStrengthGate: 0.38,
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
   * **扇を開く打撃の閾値（既定）。コアよりはっきり高い。**
   * 階層は 弱打 = 無 / 中打 = コア + アーム / **強打 = コア + アーム + 扇**。
   * 扇が開きっぱなしになると「常に開いている」ように見えて頂点が消えるので、
   * ここは下げないこと。開発つまみ `Fan threshold` から動かせる。
   */
  fanStrengthGate: 0.75,
  /** 閾値を越えたぶんを強い側へ寄せる曲線の指数（> 1 で強調）。 */
  fanCurveExponent: 1.3,
  /** 閾値をぎりぎり越えた強打での扇の強さ。 */
  fanMinimumPower: 0.55,
  /**
   * 扇の寿命（ティック）。強打ほど長い。
   * 生きているあいだは on / off を交互に繰り返すので、**表示は寿命の半分**である。
   */
  fanLifeBase: 2,
  fanLifeFromStrength: 2,
  /**
   * **誕生直後の on を保つ実フレーム数の下限。**
   * ティックの終わり際に来た打撃でも 1 フレームで消えないようにする保険だが、
   * ここを満たすまで**歳を取らせない**（＝消灯を次のティック境界まで延ばす）ので、
   * 扇の出入りは必ずティック境界だけで起きる。
   */
  fanMinimumFrames: 2,

  /**
   * **断片の誕生（Step 3）。** 1 イベントで何枚生まれるか。
   * 打撃の強さと新奇性で増え、上限で頭打ちになる。
   */
  fragmentPerEventBase: 1,
  fragmentPerEventFromStrength: 1.6,
  fragmentPerEventFromNovelty: 1.4,
  fragmentPerEventMaximum: 4,
  /**
   * 断片の寿命（ティック）。強い打撃ほど長く残る。
   * **フェードはしない** — 生きているあいだ on/off を交互に繰り返し、最後のティックで消える。
   */
  fragmentLifeBase: 1,
  fragmentLifeFromStrength: 3,
  fragmentLifeMaximum: 4,
  /**
   * 同時に生きていられる断片の上限。**上限に達したら新規を抑制する**
   * （最古を突然消すと「消えた」ことが見えてしまうため）。
   */
  fragmentLiveMaximum: 12,
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

/**
 * **発光の閾値の既定値。** 開発つまみの初期値はここから取る（二重定義しない）。
 * `core < fan` の階層が、弱打 = 無 / 中打 = コア + アーム / 強打 = + 扇 を作る。
 */
export const OPTICS_THRESHOLDS = {
  core: DRIVE.coreStrengthGate,
  fan: DRIVE.fanStrengthGate,
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
  /** 打撃に同期したアームの方向ビット（0 は出ていない）。 */
  readonly armMask: number;
  /** 生きている断片の数と、このティックで点いている数。 */
  readonly liveFragments: number;
  readonly visibleFragments: number;
  /** 誕生した断片の総数と、上限で抑制された数。 */
  readonly fragmentBirths: number;
  readonly fragmentSuppressed: number;
  /** 扇の強さ（0..1）。閾値を越えた強打の数ティックだけ立つ。 */
  readonly fanPower: number;
  /** 扇が開いた回数（＝閾値を越えた強打の数）。 */
  readonly fanCount: number;
  /** 扇を表示していたフレーム数と、総フレーム数。**表示時間割合の実測用。** */
  readonly fanVisibleFrames: number;
  readonly frameCount: number;
  /** 直近の扇の個体差シード（−1 は出ていない）。 */
  readonly fanSeed: number;
  /** いま効いている閾値（開発つまみの確認用）。 */
  readonly coreThreshold: number;
  readonly fanThreshold: number;
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
  /**
   * 打撃に同期したアーム。**コアと一緒に閃き、コアと同じか 1 ティック長く残る。**
   * 方向の組み合わせは打撃のシードが選ぶので、毎回同じ十字にならない。
   */
  private heldArmMask = 0;
  private heldArmStrength = 0;
  private heldArmSeed = 0;
  private armTicksLeft = 0;
  private armFramesLeft = 0;

  /**
   * 生きている断片。**寿命はティックで数える**（秒ではない）。
   * 誕生ティックで点き、以後 on / off を交互に繰り返して最後のティックで消える。
   */
  private readonly liveFragments: {
    readonly spawn: FragmentSpawn;
    /** 誕生してから経過したティック数。 */
    age: number;
    /** 生きられるティック数。 */
    readonly life: number;
  }[] = [];
  /**
   * 打撃で予約され、**次のティックの頭で生まれる**断片。
   * こうしておくと出入りがティック境界だけで起き、コマ送りの規律が崩れない。
   */
  private readonly pendingFragments: {
    readonly spawn: FragmentSpawn;
    readonly life: number;
  }[] = [];
  private fragmentBirths = 0;
  private fragmentSuppressed = 0;

  /**
   * **④ 扇。** コアより高い閾値を越えた強打だけで開く。
   * コア・アームと同じ規律で、打撃のティックで即出現し、数ティックで消える。
   * 生きているあいだは on / off を交互に繰り返すので、開きっぱなしにはならない。
   */
  private heldFanPower = 0;
  private heldFanSeed = 0;
  private fanTicksLeft = 0;
  /** 誕生直後の on を保つ残りフレーム数（0 になるまで歳を取らない）。 */
  private fanHoldFrames = 0;
  private fanAge = 0;
  private fanCount = 0;
  private fanVisibleFrames = 0;
  private frameCount = 0;

  /** 閾値（開発つまみ）。既定は `DRIVE` の値で、本番 UI には出さない。 */
  private coreGate: number = DRIVE.coreStrengthGate;
  private fanGate: number = DRIVE.fanStrengthGate;

  /** ストロボの入り切りと速度（開発つまみ）。A/B 比較のために外から触れる。 */
  setStrobe(enabled: boolean, rate: number): void {
    this.strobeEnabled = enabled;
    this.strobeRate = Math.max(rate, 1);
  }

  /** コアを出す打撃の閾値（開発つまみ）。 */
  setCoreThreshold(value: number): void {
    this.coreGate = clamp01(value);
  }

  /** 扇を開く打撃の閾値（開発つまみ）。**コアより高く保つのが本来の階層。** */
  setFanThreshold(value: number): void {
    this.fanGate = clamp01(value);
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
    this.heldArmMask = 0;
    this.heldArmStrength = 0;
    this.heldArmSeed = 0;
    this.armTicksLeft = 0;
    this.armFramesLeft = 0;
    this.liveFragments.length = 0;
    this.pendingFragments.length = 0;
    this.fragmentBirths = 0;
    this.fragmentSuppressed = 0;
    this.heldFanPower = 0;
    this.heldFanSeed = 0;
    this.fanTicksLeft = 0;
    this.fanHoldFrames = 0;
    this.fanAge = 0;
    this.fanCount = 0;
    this.fanVisibleFrames = 0;
    this.frameCount = 0;
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
    this.frameCount += 1;

    // ---- 持続（Step 1）: 音量を 3 つの時定数で受ける（状態の量。連続で回す）----
    this.source = playing ? clamp01(audio.volume ?? 0) : 0;
    this.skeleton = smooth(this.skeleton, this.source, deltaSeconds, RESPONSE_SECONDS.skeleton);
    this.curtain = smooth(this.curtain, this.source, deltaSeconds, RESPONSE_SECONDS.curtain);
    this.haze = smooth(this.haze, this.source, deltaSeconds, RESPONSE_SECONDS.haze);

    if (this.coreFramesLeft > 0) this.coreFramesLeft -= 1;
    if (this.armFramesLeft > 0) this.armFramesLeft -= 1;
    if (this.fanHoldFrames > 0) this.fanHoldFrames -= 1;

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
      this.heldArmMask = 0;
      this.armTicksLeft = 0;
      this.armFramesLeft = 0;
      // 無音では扇も閉じる（無音 = 黒）。
      this.heldFanPower = 0;
      this.fanTicksLeft = 0;
      this.fanHoldFrames = 0;
      // 無音では断片も生まれず、生きているものも消える（無音 = 黒）。
      this.liveFragments.length = 0;
      this.pendingFragments.length = 0;
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

      // ---- 断片の誕生（Step 3）: **どの打撃も断片を生む**（コアの閾値とは独立）----
      this.spawnFragments(event.snapshot.audioSeed, event.eventIndex, strength,
        clamp01(event.snapshot.novelty), event.band);

      // **強い音のときだけ光る。** 閾値未満はコアを出さない。
      if (strength < this.coreGate) continue;
      const above = (strength - this.coreGate) / Math.max(1 - this.coreGate, 1e-6);
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

      // ---- 打撃に同期したアーム ----
      // 方向の組み合わせは重み表から層化して引く（歩幅が表長と互いに素なので
      // 同じ組が続けて出ない）。位相だけを音のシードがずらす。
      const armOffset = Math.floor(clamp01(event.snapshot.audioSeed) * ARM_SETS.length);
      this.heldArmMask =
        ARM_SETS[(event.eventIndex * 7 + armOffset) % ARM_SETS.length] ?? 0;
      this.heldArmStrength = Math.max(this.heldArmStrength, pulse);
      this.heldArmSeed = (Math.round(clamp01(event.snapshot.audioSeed) * 65537) + event.eventIndex * 31) | 0;
      // 強い打撃だけ 1 ティック長く残す。
      this.armTicksLeft = pulse > 0.75 ? 2 : 1;
      this.armFramesLeft = DRIVE.coreMinimumFrames;

      // ---- 扇（Step 4）: **コアより高い閾値を越えた強打だけ** ----
      // 階層は 弱打 = 無 / 中打 = コア + アーム / 強打 = コア + アーム + 扇。
      if (strength < this.fanGate) continue;
      const fanAbove = clamp01((strength - this.fanGate) / Math.max(1 - this.fanGate, 1e-6));
      const power =
        DRIVE.fanMinimumPower +
        (1 - DRIVE.fanMinimumPower) * Math.pow(fanAbove, DRIVE.fanCurveExponent);
      // **打撃ティックで即出現する。** 値はこの瞬間に確定し、以後は動かない。
      this.heldFanPower = Math.max(this.heldFanPower, power);
      // 向き・角度幅の個体差の元。打撃の音のシードと通し番号だけから決まる（決定論）。
      this.heldFanSeed =
        (Math.round(clamp01(event.snapshot.audioSeed) * 60013) + event.eventIndex * 4099) &
        0x7fffffff;
      // 寿命は 2〜4 ティック（強打ほど長い）。on/off を交互に繰り返すので表示はその半分。
      this.fanTicksLeft = Math.min(
        Math.max(Math.round(DRIVE.fanLifeBase + fanAbove * DRIVE.fanLifeFromStrength), 2),
        DRIVE.fanLifeBase + DRIVE.fanLifeFromStrength,
      );
      this.fanAge = 0;
      this.fanHoldFrames = DRIVE.fanMinimumFrames;
      this.fanCount += 1;
    }

    if (this.publishedFanPower() > 0) this.fanVisibleFrames += 1;
  }

  /**
   * **1 イベントから断片を生む。**
   *
   * 枚数は打撃の強さと新奇性で増え、上限で頭打ちになる。
   * 上限に達しているときは**新規を抑制する**（最古を突然消すと、消えたことが見えてしまう）。
   * 形も位置もイベント固有の音シードだけから決まるので、同じ音なら同じ断片になる。
   */
  private spawnFragments(
    audioSeed: number,
    eventIndex: number,
    strength: number,
    novelty: number,
    band: string,
  ): void {
    const count = Math.min(
      Math.max(
        Math.round(
          DRIVE.fragmentPerEventBase +
            strength * DRIVE.fragmentPerEventFromStrength +
            novelty * DRIVE.fragmentPerEventFromNovelty,
        ),
        1,
      ),
      DRIVE.fragmentPerEventMaximum,
    );
    const life = Math.min(
      Math.max(Math.round(DRIVE.fragmentLifeBase + strength * DRIVE.fragmentLifeFromStrength), 1),
      DRIVE.fragmentLifeMaximum,
    );
    // イベント固有の整数シード。同じ音・同じ通し番号なら必ず同じ形になる。
    const seed = (Math.round(clamp01(audioSeed) * 100003) + eventIndex * 7919) | 0;
    for (let slot = 0; slot < count; slot++) {
      if (this.liveFragments.length + this.pendingFragments.length >= DRIVE.fragmentLiveMaximum) {
        this.fragmentSuppressed += 1;
        continue;
      }
      // **生まれるのは次のティックの頭。** 出入りをティック境界だけに揃える。
      this.pendingFragments.push({ spawn: { seed, slot, strength, band }, life });
    }
  }

  /**
   * ティックの頭。**ここでだけ表示状態が変わる。**
   * 遅い層はいまの状態の量を写し取り、コアは 1 ティックで消え、断片は 1 つ歳を取る。
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
    if (this.armTicksLeft > 0) {
      this.armTicksLeft -= 1;
      if (this.armTicksLeft <= 0 && this.armFramesLeft <= 0) this.heldArmMask = 0;
    } else {
      this.heldArmMask = 0;
    }
    // 扇も寿命をティックで数える。**生きているあいだ on / off を交互に繰り返し、
    // 最後のティックでフェードせずに消える。**
    // 誕生直後の on が実フレーム下限に届いていないあいだは歳を取らせない。
    // これで扇の出入りは必ずティック境界だけで起きる（打撃での出現だけが例外）。
    if (this.fanTicksLeft > 0) {
      if (this.fanHoldFrames <= 0) {
        this.fanAge += 1;
        this.fanTicksLeft -= 1;
        if (this.fanTicksLeft <= 0) this.heldFanPower = 0;
      }
    } else {
      this.heldFanPower = 0;
    }
    // 断片の寿命はティックで数える。**寿命が尽きたらフェードせずに消える。**
    let write = 0;
    for (let read = 0; read < this.liveFragments.length; read++) {
      const entry = this.liveFragments[read]!;
      entry.age += 1;
      if (entry.age >= entry.life) continue;
      this.liveFragments[write] = entry;
      write += 1;
    }
    this.liveFragments.length = write;
    // 予約されていた断片はここで生まれる（＝出入りはティック境界だけ）。
    for (const pending of this.pendingFragments) {
      this.liveFragments.push({ spawn: pending.spawn, age: 0, life: pending.life });
      this.fragmentBirths += 1;
    }
    this.pendingFragments.length = 0;
  }

  /**
   * このティックで点いている断片。
   * 誕生ティックで点き、以後は on / off を交互に繰り返す
   * （全部が同時に消えないよう、位相は誕生からの経過ティックで決まる）。
   */
  private visibleFragments(): FragmentSpawn[] {
    if (!this.strobeEnabled) return this.liveFragments.map((entry) => entry.spawn);
    return this.liveFragments
      .filter((entry) => entry.age % STROBE.period < STROBE.onTicks)
      .map((entry) => entry.spawn);
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
      armMask: this.publishedArmMask(),
      liveFragments: this.liveFragments.length,
      visibleFragments: this.visibleFragments().length,
      fragmentBirths: this.fragmentBirths,
      fragmentSuppressed: this.fragmentSuppressed,
      fanPower: this.publishedFanPower(),
      fanCount: this.fanCount,
      fanVisibleFrames: this.fanVisibleFrames,
      frameCount: this.frameCount,
      fanSeed: this.publishedFanPower() > 0 ? this.heldFanSeed : -1,
      coreThreshold: this.coreGate,
      fanThreshold: this.fanGate,
    };
  }

  /** コアが出ているのは、打撃のティックのあいだだけ。 */
  private publishedCorePulse(): number {
    return this.coreTicksLeft > 0 || this.coreFramesLeft > 0 ? this.heldCorePulse : 0;
  }

  /** アームもコアと同じ規律で、打撃のティックのあいだだけ出る。 */
  private publishedArmMask(): number {
    return this.armTicksLeft > 0 || this.armFramesLeft > 0 ? this.heldArmMask : 0;
  }

  /**
   * 扇が開いているのは、寿命の中の **on のティックだけ**。
   * 誕生ティック（`fanAge = 0`）で点き、次のティックで消え、また点く。
   * 誕生直後の on は `fanHoldFrames` が尽きるまで歳を取らないので、
   * 実フレーム下限は満たしつつ、消灯はティック境界に揃う。
   */
  private publishedFanPower(): number {
    if (this.fanTicksLeft <= 0) return 0;
    if (!this.strobeEnabled) return this.heldFanPower;
    return this.fanAge % STROBE.period < STROBE.onTicks ? this.heldFanPower : 0;
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
      // 断片は spawn 側で作るので、つまみ由来の energy は使わない。
      fragmentEnergy: 0,
      fragments: this.visibleFragments(),
      // 強打だけが開く扇（Step 4）。強さも個体差も打撃の瞬間に確定する。
      fanGate: this.publishedFanPower(),
      fanSeed: this.heldFanSeed,
      // Step 5 で配線する。それまでは開発つまみの値をそのまま使う。
      huePhase: manual.huePhase,
      seed: manual.seed,
      tick: this.strobeEnabled ? this.tickIndex : -1,
      coreShape: pulse > 0 ? this.heldCoreShape : -1,
      armMask: this.publishedArmMask(),
      armStrength: this.heldArmStrength,
      armSeed: this.heldArmSeed,
      // 奥行き計測つまみは音とは無関係の開発用なので、常に開発つまみの値。
      depthProbe: manual.depthProbe,
    };
  }
}
