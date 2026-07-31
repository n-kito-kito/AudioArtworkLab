import type { AudioParameters, SpectrumFrame } from '../audio/AudioEngine';
import { BandLightEventDetector } from '../engine/bandLightEvents';
import { BindingResolver } from '../engine/binding/resolve';
import type { AudioSourceShelf } from '../engine/binding/sources';
import {
  ENVELOPE_PRESETS,
  defaultTransformFor,
  envelopeTransform,
  gateTransform,
  type AudioSource,
  type Binding,
  type EnvelopePresetName,
  type ParamDecl,
} from '../engine/binding/types';
import {
  ARM_SETS,
  CORE_SHAPES,
  RESPONSE_SECONDS,
  STROBE,
  fragmentBandBias,
  fragmentPlacement,
  hash01,
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
 * - **Step 5（実装済み）** 音色の持続値 → `huePhase`。**補間せずイベント的に切り替える。**
 *   H は連続では動かさない。**8 個の離散状態**のどれかに留まり、
 *   音色（帯域の傾き + centroid の持続値）が別の区画へはっきり移り、
 *   さらに**確認時間**と**最短保持**を満たしたときだけ、ティック境界で瞬時に跳ぶ。
 *   微小な揺らぎでは同じ H に留まる（ヒステリシス）。
 *   音由来のシード → `seed`（断片・カーテンの散らばり）は未配線のまま。
 *
 * 未配線のものは 0 を返すか、開発つまみの値をそのまま通す。
 * 段階を進めるときはこのファイルだけを触る。
 */

/** この変換の定数。**対応の数値はすべてここに集める。** */
const DRIVE = {
  /**
   * **持続の濃さ（ガンマ）。** 音量をそのまま基礎輝度にすると画面が暗すぎた。
   *
   * 実楽曲での実測（通し計測 2026-07-30）では、正規化後の音量の中央値は
   * 0.17〜0.55 にしかならない。静止画スタディ（つまみ 1.0）を目標にしている場に
   * 0.2 を入れれば、当然そこまで届かない。実際に黒が 94〜96% で張り付き、
   * 膜（天井 0.11）はほとんど立ち上がらなかった。
   *
   * そこで**音量を持ち上げる曲線**を 1 本だけ通す。1 未満で暗い側が持ち上がり、
   * 大きい側は 1 で頭打ちのまま（＝天井は変えない）。
   * 0.25 で音量 0.2 → 0.67 / 0.5 → 0.84 になり、**無音は 0 のまま**である。
   * 開発つまみ `Sustain gamma` から動かせる（本番 UI には出さない）。
   */
  sustainGamma: 0.25,
  /**
   * **場の利得（Audio 専用）。** ガンマで音量を持ち上げても、実楽曲の 1 フレームは
   * 静止画スタディ（黒 0.71）に遠く及ばず黒 0.93 で止まった。原因は構造的で、
   * **ストロボが毎ティック各グループの層を半分しか見せない**こと、そして
   * コア・扇・断片が設計どおり瞬間的にしか出ないことである。
   *
   * そこで持続の場（膜・カーテン・骨格）だけ 1 を超えて注げるようにした。
   * **天井は変えていない**ので白が増えるのではなく、天井に届く**面積**が広がる。
   * Manual はつまみが 0〜1 なのでここを通らず、静止画スタディは 1 画素も変わらない。
   * 実測（実楽曲 2 曲・利得 1.0 / 1.6 / 2.2 / 2.8）では黒の中央値が
   * 0.93 / 0.90 / 0.88 / **0.86** と下がり、平均輝度は 1.2 → 3.1 まで上がる。
   * それでも静止画スタディの平均輝度 10.9 の 1/3 以下で、白画素の面積も
   * 0.5% 未満のまま中央に留まる（＝濁らない）。**2.8 を既定とする。**
   * 開発つまみ `Field gain` から動かせる。
   */
  fieldGain: 2.8,
  /**
   * **コアを出す打撃の閾値（既定）。** これ未満の打撃ではコアを出さない。
   * 弱い打撃でも毎回光ると「常に光っている」ように見えて、
   * 強打の頂点が頂点に見えなくなる。
   *
   * 0.55 では落ちる打撃が多すぎたので 0.38 へ、さらに実楽曲の通し計測で
   * **0.30 まで下げた**（実楽曲の打撃の強さの中央値は 0.24〜0.40 しかなく、
   * 0.38 では静かな曲でコアが 12% しか出なかった）。
   * 強い側を強調する曲線（`coreCurveExponent`）はそのままなので、
   * 「弱い打撃も光るが、頂点は強打だけ」という階層は保たれる。
   * 開発つまみ `Core threshold` から動かせる（本番 UI には出さない）。
   */
  coreStrengthGate: 0.3,
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

  // ---- 帯域 → R/G/B チャンネル（色調のチルト）----
  /**
   * **帯域の持続値の時定数（秒）。** 打撃 1 発では動かず、
   * 「いまどの帯域が鳴っているか」の持続だけがチルトを決める。
   */
  channelSeconds: 1.2,
  /**
   * **チルトの深さ。** 0 で無彩（従来どおり）、1 で「鳴っていない帯域は真っ暗」。
   *
   * 山になっている帯域を持ち上げるのではなく、**鳴っていない帯域を落とす**。
   * こうすると利得は必ず 1 以下に収まるので、**白の予算を 1 mm も超えない**
   * （持ち上げる作りにすると、コア以外の層が白へ届いてしまう）。
   */
  channelTilt: 0.45,

  // ---- 断片の痕跡場（蓄積）----
  /**
   * **痕跡場の解像度。** 粗くてよい。ここは「どこで断片が消えたか」の記憶であって
   * 描く絵ではないので、細かくすると筋にならず点の集まりになる。
   */
  traceColumns: 32,
  traceRows: 18,
  /** 場が覆う正規化座標の半径（断片の散らばりは ±1 前後に収まる）。 */
  traceExtent: 1.25,
  /**
   * **半減期（秒）。** 痕跡はゆっくり消える。短いと蓄積にならず、
   * 長すぎると前の区間の筋がいつまでも残る。
   */
  traceHalfLife: 18,
  /** 断片 1 枚が死ぬときに置く量（強さと大きさに比例する係数）。 */
  traceDeposit: 1,
  /** 1 セルが持てる量の上限。**長時間再生でも場が飽和しない**ための頭打ち。 */
  traceCeiling: 6,
  /**
   * 引き寄せの最大の強さ（`Trace amount` が 1・その痕跡が場の最大のとき）。
   * 1 にすると全部が同じ点へ重なるので、いちばん強くても 8 割までにしておく。
   */
  tracePullMaximum: 0.8,

  // ---- 音色 → グローバル波長 H（Step 5）----
  /**
   * **H の候補状態の数。** H は 0〜1 の連続量として動かさず、
   * この数だけの離散状態のどれかに留まる（連続ドリフト禁止）。
   */
  hueStates: 8,
  /** 状態 0 の H。**静止画スタディの既定値と同じ**にしてある。 */
  hueBase: 0.62,
  /**
   * 状態番号 → 色相環の歩幅。状態数 8 と互いに素なので 8 状態すべてが別の色になり、
   * **隣り合う音色でも色は大きく変わる**（「緑の回・赤の回」が丸ごと入れ替わる）。
   */
  hueStride: 3,
  /**
   * **音色の持続値の時定数（秒）。** 膜（2.6s）と同じくらい遅い。
   * 打撃 1 発では動かず、曲の区間くらいの速さでしか動かない。
   */
  hueTimbreSeconds: 1.6,
  /**
   * 音色の測り方。**帯域の傾き**（treble 寄りか bass 寄りか）と **centroid** を混ぜる。
   * どちらも「高域寄りか」を測る量なので、混ぜると片方の癖に振り回されない。
   */
  hueTiltWeight: 0.62,
  /**
   * 傾きの利得。生の傾きは 0.5 のまわりに固まりやすいので、区画を跨げるだけ広げる。
   * 広げすぎると端に張り付くので 1 を少し超える程度に留める。
   */
  hueToneGain: 1.5,
  /**
   * **ヒステリシス。** いまの区画から**この割合ぶん外へ出る**まで候補を変えない
   * （区画幅に対する比）。境界上の揺らぎでフリップフロップしないための余白。
   */
  hueHysteresis: 0.35,
  /**
   * **落ち着き**の判定（音色の変化率・毎秒）。
   * 音色が大きく動いている最中は確認を数えない。こうしないと、音色が区画を
   * 横断していく途中の区画で**寄り道の色**が出てしまう（切替そのものは瞬時でも、
   * 行き先でない色が数秒出るのは「明確な変化でだけ切り替わる」に反する）。
   *
   * 揺らぎと横断を見分けるため、測るのは**符号つきのずれ**（`raw − timbre`）である。
   * 揺らぎは正負に散って 0 の周りに均されるが、横断は符号が揃うので残る。
   */
  hueSettleRate: 0.05,
  /** そのずれを均す時定数（秒）。 */
  hueDriftSeconds: 0.6,
  /** **確認時間**（秒）。候補がこれだけ続かないと切り替えない。開発つまみ `Hue confirm`。 */
  hueConfirmSeconds: 1,
  /** **最短保持**（秒）。いまの H をこれだけ保つまで次へ移らない。開発つまみ `Hue hold`。 */
  hueHoldSeconds: 9,

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
   *
   * 実楽曲の通し計測で、同時に生きている断片の中央値が **0 枚**（＝半分の時間は
   * 周縁に何もない）だったので、下限を 1 → 2 ティックへ上げた。
   * 上限は 4 ティックのままなので、強打の断片が長くなったわけではない。
   */
  fragmentLifeBase: 2,
  fragmentLifeFromStrength: 2,
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
 * **この表現が宣言するパラメーター（結線の受け口）。**
 *
 * 6 入力すべてを出すのではなく、**結線が意味を持つものだけ**を宣言する。
 * `fragmentEnergy` は Audio では使っていない（断片は spawn 機構が作る）、
 * `seed` は 0〜1 の変調対象ではないので、どちらも宣言しない。
 *
 * **時間の規律はここには入らない。** 宣言された値は「いまどれだけ駆動が来ているか」
 * だけを表し、それを**いつ・どう見せるか**（ティック量子化・1 ティック保持・
 * on/off の交互・H の 8 状態機械）はこのアダプタが従来どおり引き受ける。
 * どのソースへ繋ぎ替えても、フェード禁止と離散切替の恒久方針は壊れない。
 */
export const OPTICS_PARAMS: readonly ParamDecl[] = [
  {
    id: 'fieldDrive',
    label: 'Field drive',
    min: 0,
    max: 1,
    default: 0,
    kind: 'continuous',
  },
  { id: 'coreStrike', label: 'Core strike', min: 0, max: 1, default: 0, kind: 'trigger' },
  { id: 'fanStrike', label: 'Fan strike', min: 0, max: 1, default: 0, kind: 'trigger' },
  { id: 'hueTimbre', label: 'Hue timbre', min: 0, max: 1, default: 0, kind: 'continuous' },
];

/**
 * **既定の接続束。** アダプタ自身が作っている加工済み信号へ繋いであるので、
 * **現行の見え方をそのまま再現する**（基準値 0・深さ 1・変換なしの素通し）。
 * ここから内部棚（volume-fast / volume-slow / onset-strength / band-*）へ
 * UI で繋ぎ替えられる。
 */
const DEFAULT_BINDINGS: readonly Binding[] = [
  { paramId: 'fieldDrive', sourceId: 'optics-field', depth: 1, transform: null },
  { paramId: 'coreStrike', sourceId: 'optics-strike', depth: 1, transform: null },
  { paramId: 'fanStrike', sourceId: 'optics-strike', depth: 1, transform: null },
  { paramId: 'hueTimbre', sourceId: 'optics-timbre', depth: 1, transform: null },
];

/**
 * **発光の閾値の既定値。** 開発つまみの初期値はここから取る（二重定義しない）。
 * `core < fan` の階層が、弱打 = 無 / 中打 = コア + アーム / 強打 = + 扇 を作る。
 */
export const OPTICS_THRESHOLDS = {
  core: DRIVE.coreStrengthGate,
  fan: DRIVE.fanStrengthGate,
  /** 持続の濃さと場の利得。開発つまみ `Sustain gamma` / `Field gain` の初期値。 */
  sustainGamma: DRIVE.sustainGamma,
  fieldGain: DRIVE.fieldGain,
  /** 痕跡場の効き。開発つまみ `Trace amount` の初期値。 */
  traceAmount: 0.5,
  /** 帯域 → R/G/B の効き。開発つまみ `Channel drive` の初期値。 */
  channelDrive: 0.5,
  /** H の切替の粘り（Step 5）。開発つまみ `Hue confirm` / `Hue hold` の初期値。 */
  hueConfirm: DRIVE.hueConfirmSeconds,
  hueHold: DRIVE.hueHoldSeconds,
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
  /** **音色の持続値**（0..1・高域寄りほど大きい）。H の状態を選ぶ元。 */
  readonly timbre: number;
  /** いま留まっている H の状態番号と、その H。 */
  readonly hueState: number;
  readonly huePhase: number;
  /** 確認中の候補（現状と同じなら候補なし）と、その確認が続いた秒数。 */
  readonly hueCandidate: number;
  readonly hueConfirmed: number;
  /** いまの状態を保っている秒数。 */
  readonly hueHeld: number;
  /** H が切り替わった回数。 */
  readonly hueSwitches: number;
  /** 痕跡場の最大値・総量・0 でないセルの数。堆積と減衰を見るために出す。 */
  readonly tracePeak: number;
  readonly traceTotal: number;
  readonly traceCells: number;
  /** 置いた総量と、引き寄せが効いた断片の数。 */
  readonly traceDeposits: number;
  readonly traceAimed: number;
  /** 帯域の持続値と、そこから作ったチャンネル利得（Bass = R / Mid = G / Treble = B）。 */
  readonly bands: readonly [number, number, number];
  readonly channel: readonly [number, number, number];
}

/**
 * **ストロボの門を通す前の素の値**（統合表現のための読み取り口）。
 *
 * `levels()` と `toDrive()` が返すのは「ティックの門を通した後」の値なので、
 * 連続のエンベロープと明滅のあいだを**連続に混ぜたい**側からは使えない。
 * ここは held の値と、ティック内の経過（`age`）をそのまま渡すだけで、
 * **状態は 1 つも変えない**。読まない表現の見え方は 1 画素も変わらない。
 */
export interface OpticsSustained {
  /** 連続の場（平滑値そのもの）。 */
  readonly field: number;
  /** ティックの頭で確定した場。 */
  readonly fieldHeld: number;
  /** 場の利得（`skeletonLevel` に掛かっているのと同じ倍率）。 */
  readonly fieldGain: number;
  readonly corePulse: number;
  readonly coreShape: number;
  readonly coreAge: number;
  readonly coreAlive: boolean;
  readonly fanPower: number;
  readonly fanSeed: number;
  readonly fanAge: number;
  readonly fanAlive: boolean;
  readonly armMask: number;
  readonly armStrength: number;
  readonly armSeed: number;
  readonly armAlive: boolean;
  /** 光学クロックのティック番号。 */
  readonly tick: number;
  /** 生きている断片（門を通していないので off ティックのものも含む）。 */
  readonly fragments: readonly { readonly spawn: FragmentSpawn; readonly age: number }[];
}

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/**
 * **dt ベースの指数平滑。** `alpha = 1 − exp(−dt/τ)` なので、
 * フレームレートが変わっても同じ時間で同じところへ着く。
 * τ は「目標との差が 1/e（≒ 37%）まで縮む時間」＝ 63% 到達時間である。
 */
/**
 * **状態番号 → グローバル波長 H。**
 * 色相環を状態数で等分し、状態数と互いに素な歩幅で歩く。
 * 歩幅のおかげで、音色が隣の区画へ移っただけでも色は大きく変わる。
 */
export const hueOfState = (state: number): number => {
  const index = ((Math.round(state) % DRIVE.hueStates) + DRIVE.hueStates) % DRIVE.hueStates;
  return (DRIVE.hueBase + (index * DRIVE.hueStride) / DRIVE.hueStates) % 1;
};

/**
 * **連続版の H。** 状態番号を丸めずに同じ式へ通したもの。
 * 離散の 8 状態と**同じ道**の上を滑らかに動くので、統合表現の `Hue stickiness` は
 * この 2 つを混ぜるだけで「滑らかな追従 ⇄ 離散 + 長い保持」を連続に行き来できる。
 * 既存の表現はこれを読まない（`hueOfState` の値は 1 ビットも変わらない）。
 */
export const hueOfPhase = (phase: number): number => {
  const t = ((phase % 1) + 1) % 1;
  return (DRIVE.hueBase + t * DRIVE.hueStride) % 1;
};

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

  // ---- 断片の痕跡場（蓄積）----
  /**
   * **痕跡場。** 断片が消えた場所に量が積もり、ゆっくり減衰する。
   * 次の断片はここへ引き寄せられるので、**過去が次の絵に効く**（写像だけでは出ない筋）。
   *
   * **場はイベント履歴の純関数**である（`Math.random()` を使わず、置く位置も引く候補も
   * すべて音のシードから決まる）ので、同じ音源・同じ操作なら同じ場になる ＝ 決定論は保つ。
   */
  private readonly trace = new Float32Array(DRIVE.traceColumns * DRIVE.traceRows);
  /** 場の最大値。引き寄せの強さを正規化するために持つ（これも減衰する）。 */
  private tracePeak = 0;
  /** 置いた総量と、引き寄せが効いた断片の数。検証で読む。 */
  private traceDeposits = 0;
  private traceAimed = 0;
  /** 引き寄せの強さ（開発つまみ `Trace amount`）。**0 で完全に従来どおり。** */
  private traceAmount = 0.5;

  // ---- 帯域 → R/G/B チャンネル（色調のチルト）----
  /** 帯域の持続値。打撃では動かず、区間の色合いだけを表す。 */
  private bandLow = 0;
  private bandMid = 0;
  private bandHigh = 0;
  /**
   * ティックの頭で確定したチャンネル利得。**光と同じ規律で latch する**ので、
   * 色調も連続では動かず、ティック単位で切り替わる。
   */
  private heldChannel: [number, number, number] = [1, 1, 1];

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
  /** 持続の濃さ（開発つまみ）。小さいほど暗い側が持ち上がる。 */
  private sustainGamma: number = DRIVE.sustainGamma;
  /** 場の利得（開発つまみ）。ストロボで半分になる面積を補う。 */
  private fieldGain: number = DRIVE.fieldGain;

  // ---- 結線（音 × パラメーター）----
  /**
   * **結線の解決器。** 宣言したパラメーターの値はすべてここを通る。
   * 通るのは「値」だけで、時間の規律はこのアダプタが持ったままである。
   */
  private readonly resolver = new BindingResolver();
  /**
   * **アダプタ自身が作っている加工済み信号**（既定の接続先）。
   * これがあるおかげで、既定の束で**現行の見え方をビット単位で再現**できる。
   */
  private opticsField = 0;
  /** 打撃の強さ。**発火したフレームだけ値が入り、それ以外は 0 の衝撃**。 */
  private opticsStrike = 0;
  private opticsTimbre = 0;
  private readonly opticsSources: readonly AudioSource[] = [
    { id: 'optics-field', label: 'Optics field drive', kind: 'level', value: () => this.opticsField },
    { id: 'optics-strike', label: 'Optics strike', kind: 'event', value: () => this.opticsStrike },
    { id: 'optics-timbre', label: 'Optics timbre', kind: 'level', value: () => this.opticsTimbre },
  ];
  /**
   * 駆動が閾値を越えていたか（前フレーム）。
   * **立ち上がりでだけ位相を戻す**ので、連続したソースへ繋ぎ替えても
   * 「点きっぱなし」にならず、ティックの上で明滅する。
   */
  /** 「発光 (All)」で選んでいるソース（`null` は内部の既定ドライブ）。 */
  private emissionSource: string | null = null;
  private emissionDepth = 1;
  /** 色の駆動元（`null` は内部の既定＝音色）。 */
  private hueSource: string | null = null;
  private hueDepth = 1;
  private coreWasArmed = false;
  private fanWasArmed = false;
  /** 立ち上がり直後の 1 ティックは歳を取らせない印。 */
  private coreFresh = false;
  /** コアが点いてから経過したティック数。on/off の交互はこれで決まる。 */
  private coreAge = 0;
  /** 直近の打撃のシード（形状族とアームの向きの元）。繋ぎ替えても音のシードを使う。 */
  private strikeSeed = 0;
  private strikeIndex = 0;

  // ---- 音色 → グローバル波長 H（Step 5）----
  /**
   * **音色の持続値**（0..1）。帯域の傾きと centroid をゆっくり平滑した値で、
   * 打撃では動かない。**H を連続で動かす量ではなく、状態を選ぶための量**である。
   */
  private timbre = 0;
  /** 音色を一度でも測ったか。最初のフレームは平滑を待たずに値を入れる。 */
  private timbreSeen = false;
  /**
   * **符号つきの流れ**（`raw − timbre` を均したもの）。
   * 揺らぎは 0 の周りに均されるが、音色が横断しているあいだは符号が揃って残る。
   * これが小さいときだけ「落ち着いた」と見なして確認を数える。
   */
  private timbreDrift = 0;
  /** いま留まっている H の状態番号。 */
  private hueState = 0;
  /** 確認中の候補と、その確認が続いた秒数。 */
  private hueCandidate = 0;
  private hueConfirmed = 0;
  /** いまの状態を保っている秒数。最短保持の判定に使う。 */
  private hueHeld = 0;
  /**
   * 確認と最短保持を満たして**次のティック境界で移る**状態（−1 は予約なし）。
   * 切り替えをティック境界に揃えると、光の出し入れと同じ規律になる。
   */
  private huePending = -1;
  private hueSwitches = 0;
  /** 確認時間と最短保持（開発つまみ）。 */
  private hueConfirmSeconds: number = DRIVE.hueConfirmSeconds;
  private hueHoldSeconds: number = DRIVE.hueHoldSeconds;

  constructor() {
    this.resolver.declare(OPTICS_PARAMS);
    this.resolver.setSources(this.opticsSources);
    for (const binding of DEFAULT_BINDINGS) this.resolver.bind(binding);
  }

  /**
   * 内部ソースの棚を繋ぐ。**アダプタ由来の信号と合わせて 1 つの棚**にして
   * 解決器へ渡すので、UI からはどちらへも繋ぎ替えられる。
   */
  setShelf(shelf: AudioSourceShelf): void {
    this.resolver.setSources([...this.opticsSources, ...shelf.list()]);
  }

  /** 結線の読み書き（UI 用）。 */
  bindings(): BindingResolver {
    return this.resolver;
  }

  /**
   * **発光をまとめて 1 つのソースへ繋ぐ。**
   *
   * パーツごとに分けても判断できないという指摘を受け、UI は「発光 (All)」1 本にした。
   * 選んだ音が**リグ全体の発光**（場・コア・扇）を駆動する。
   * 下流の時間規律（場の時定数・打撃の閾値と 1 ティック保持・扇の寿命・ストロボ）は
   * すべて従来どおり表現側に残るので、どのソースでも規律は壊れない。
   *
   * `null` で**内部の既定ドライブへ戻る**（＝現行挙動の再現）。
   */
  setEmission(sourceId: string | null, depth: number): void {
    this.emissionSource = sourceId;
    this.emissionDepth = depth;
    if (sourceId === null) {
      for (const binding of DEFAULT_BINDINGS) {
        if (binding.paramId === 'hueTimbre') continue;
        this.resolver.bind(binding);
      }
      return;
    }
    for (const paramId of ['fieldDrive', 'coreStrike', 'fanStrike']) {
      this.connect(paramId, sourceId, depth);
    }
  }

  /** いま発光に繋いでいるソース（`null` は内部の既定ドライブ）。 */
  emission(): { readonly sourceId: string | null; readonly depth: number } {
    return { sourceId: this.emissionSource, depth: this.emissionDepth };
  }

  /**
   * **色（H）の駆動元。** 状態機械の入力（音色）を差し替えるだけなので、
   * H は**8 状態の離散切替のまま**である（連続ドリフトにはならない）。
   */
  setHueSource(sourceId: string | null, depth: number): void {
    this.hueSource = sourceId;
    this.hueDepth = depth;
    if (sourceId === null) {
      this.resolver.bind({ paramId: 'hueTimbre', sourceId: 'optics-timbre', depth: 1, transform: null });
      return;
    }
    this.connect('hueTimbre', sourceId, depth);
  }

  hueBinding(): { readonly sourceId: string | null; readonly depth: number } {
    return { sourceId: this.hueSource, depth: this.hueDepth };
  }

  /** 変換の語（UI の表示・切替に使う）。`auto` は種類から自動で決める。 */
  transformName(paramId: string): string {
    const binding = this.resolver.getBinding(paramId);
    if (!binding || !binding.transform) return 'none';
    if (binding.transform.type === 'gate') return 'gate';
    const { attack, decay } = binding.transform;
    for (const [name, preset] of Object.entries(ENVELOPE_PRESETS)) {
      if (preset.attack === attack && preset.decay === decay) return `envelope-${name}`;
    }
    return 'envelope-default';
  }

  /** 語から変換を作って張り替える。`auto` は種類不一致の既定挿入に戻す。 */
  setTransform(paramId: string, name: string): void {
    const binding = this.resolver.getBinding(paramId);
    if (!binding || !binding.sourceId) return;
    if (name === 'auto') {
      this.connect(paramId, binding.sourceId, binding.depth);
      return;
    }
    const transform =
      name === 'none'
        ? null
        : name === 'gate'
          ? gateTransform()
          : envelopeTransform(
              (name.replace('envelope-', '') as EnvelopePresetName) in ENVELOPE_PRESETS
                ? (name.replace('envelope-', '') as EnvelopePresetName)
                : 'default',
            );
    this.connect(paramId, binding.sourceId, binding.depth, transform);
  }

  /**
   * ソースを繋ぎ替える。**種類が合わなければ既定変換を自動で挿入する。**
   * `transform` を明示すればそれを使う。
   */
  connect(paramId: string, sourceId: string | null, depth: number, transform?: Binding['transform']): void {
    if (sourceId === null) {
      this.resolver.bind({ paramId, sourceId: null, depth, transform: null });
      return;
    }
    const decl = OPTICS_PARAMS.find((entry) => entry.id === paramId);
    const source = this.resolver.listSources().find((entry) => entry.id === sourceId);
    const auto = decl && source ? defaultTransformFor(source.kind, decl.kind) : null;
    this.resolver.bind({
      paramId,
      sourceId,
      depth,
      transform: transform === undefined ? auto : transform,
    });
  }

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

  /** 持続の濃さ（開発つまみ）。1 で音量そのまま、小さいほど場が濃くなる。 */
  setSustainGamma(value: number): void {
    this.sustainGamma = Math.min(Math.max(value, 0.1), 1);
  }

  /** 場の利得（開発つまみ）。天井は変わらないので、増えるのは面積だけ。 */
  setFieldGain(value: number): void {
    this.fieldGain = Math.min(Math.max(value, 0.5), 3);
  }

  /** 痕跡場の効き（開発つまみ）。**0 で蓄積を切る**（従来と 1 画素も変わらない）。 */
  setTraceAmount(value: number): void {
    this.traceAmount = clamp01(value);
  }

  /**
   * **帯域バランスが決めたチャンネル利得**（Bass = R / Mid = G / Treble = B）。
   *
   * 鳴っている帯域を 1 に置き、**鳴っていない帯域を落とす**ので、
   * 帯域が均等なら (1, 1, 1) ＝ 無彩（チルトなし）になる。
   * 値はティックで latch 済みで、連続では動かない。
   */
  channelGain(): readonly [number, number, number] {
    return this.heldChannel;
  }

  /** いまの帯域の持続値から利得を作る。**利得は必ず 1 以下**（白の予算を超えない）。 */
  private channelFromBands(): [number, number, number] {
    const peak = Math.max(this.bandLow, this.bandMid, this.bandHigh);
    if (peak <= 1e-4) return [1, 1, 1];
    const tilt = DRIVE.channelTilt;
    const at = (value: number): number => 1 - tilt * (1 - clamp01(value / peak));
    return [at(this.bandLow), at(this.bandMid), at(this.bandHigh)];
  }

  /** H の確認時間（秒・開発つまみ）。短くすると音色の揺れで色が動きやすくなる。 */
  setHueConfirm(seconds: number): void {
    this.hueConfirmSeconds = Math.max(seconds, 0);
  }

  /** H の最短保持（秒・開発つまみ）。長くすると「色の回」が長くなる。 */
  setHueHold(seconds: number): void {
    this.hueHoldSeconds = Math.max(seconds, 0);
  }

  /** いま効いているグローバル波長 H。**状態番号からしか作らない**（連続量ではない）。 */
  huePhase(): number {
    return hueOfState(this.hueState);
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
    this.bandLow = 0;
    this.bandMid = 0;
    this.bandHigh = 0;
    this.heldChannel = [1, 1, 1];
    this.trace.fill(0);
    this.tracePeak = 0;
    this.traceDeposits = 0;
    this.traceAimed = 0;
    this.resolver.reset();
    this.opticsField = 0;
    this.opticsStrike = 0;
    this.opticsTimbre = 0;
    this.emissionSource = null;
    this.emissionDepth = 1;
    this.hueSource = null;
    this.hueDepth = 1;
    for (const binding of DEFAULT_BINDINGS) this.resolver.bind(binding);
    this.coreWasArmed = false;
    this.fanWasArmed = false;
    this.coreFresh = false;
    this.coreAge = 0;
    this.strikeSeed = 0;
    this.strikeIndex = 0;
    this.heldFanPower = 0;
    this.heldFanSeed = 0;
    this.fanTicksLeft = 0;
    this.fanHoldFrames = 0;
    this.fanAge = 0;
    this.fanCount = 0;
    this.fanVisibleFrames = 0;
    this.frameCount = 0;
    this.timbre = 0;
    this.timbreSeen = false;
    this.timbreDrift = 0;
    this.hueState = 0;
    this.hueCandidate = 0;
    this.hueConfirmed = 0;
    this.hueHeld = 0;
    this.huePending = -1;
    this.hueSwitches = 0;
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
    // **持続の濃さ。** 正規化後の音量はそのままでは低すぎて場が立ち上がらないので、
    // 曲線 1 本で暗い側を持ち上げる（無音は 0 のまま・天井は 1 のまま）。
    const loudness = playing ? clamp01(audio.volume ?? 0) : 0;
    // アダプタ自身の加工済み信号（＝既定の接続先）。
    this.opticsField = loudness > 0 ? Math.pow(loudness, this.sustainGamma) : 0;
    // **結線を通した値**が平滑の入力になる。3 つの時定数も利得もこの下流のまま。
    this.resolver.updateParam('fieldDrive', deltaSeconds);
    this.source = this.resolver.valueOf('fieldDrive');
    this.skeleton = smooth(this.skeleton, this.source, deltaSeconds, RESPONSE_SECONDS.skeleton);
    this.curtain = smooth(this.curtain, this.source, deltaSeconds, RESPONSE_SECONDS.curtain);
    this.haze = smooth(this.haze, this.source, deltaSeconds, RESPONSE_SECONDS.haze);

    // ---- 音色 → H（Step 5）: 状態機械を回す。切替の適用はティック境界 ----
    this.updateHue(audio, playing, deltaSeconds);
    // 痕跡場はゆっくり減衰する。無音でも回すので、止まれば筋も薄れていく。
    this.decayTrace(deltaSeconds);

    // ---- 帯域の持続値（色調のチルトの元）----
    // 無音では 3 本とも 0 へ沈むので、チルトは自然に無彩へ戻る。
    const lowTarget = playing ? clamp01(audio.bass ?? 0) : 0;
    const midTarget = playing ? clamp01(audio.mid ?? 0) : 0;
    const highTarget = playing ? clamp01(audio.treble ?? 0) : 0;
    this.bandLow = smooth(this.bandLow, lowTarget, deltaSeconds, DRIVE.channelSeconds);
    this.bandMid = smooth(this.bandMid, midTarget, deltaSeconds, DRIVE.channelSeconds);
    this.bandHigh = smooth(this.bandHigh, highTarget, deltaSeconds, DRIVE.channelSeconds);
    if (!this.strobeEnabled) this.heldChannel = this.channelFromBands();

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
      // 結線の側も 0 に落とす（棚のソースも無音では全部 0）。
      this.opticsStrike = 0;
      this.coreWasArmed = false;
      this.fanWasArmed = false;
      this.coreAge = 0;
      this.resolver.updateParam('coreStrike', deltaSeconds);
      this.resolver.updateParam('fanStrike', deltaSeconds);
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

    // 検出器は**繋ぎ替えても回し続ける** — 断片の誕生と、形状族・アームの向きの
    // シードはここから来るからである。打撃の強さは「アダプタ由来のソース」へ置き、
    // 実際にコア・扇を動かす値は**結線を通したもの**を使う。
    this.opticsStrike = 0;
    for (const event of events) {
      const strength = clamp01(event.strength);
      this.strikeCount += 1;
      this.lastStrength = strength;
      this.lastBand = event.band;
      this.strikeSeed = clamp01(event.snapshot.audioSeed);
      this.strikeIndex = event.eventIndex;
      // **発火したフレームだけ値が入る衝撃**（減衰させない）。
      // 減衰させると既定の接続で「1 ティックだけ光る」現行挙動が再現できない。
      this.opticsStrike = Math.max(this.opticsStrike, strength);

      // ---- 断片の誕生（Step 3）: **どの打撃も断片を生む**（コアの閾値とは独立）----
      this.spawnFragments(event.snapshot.audioSeed, event.eventIndex, strength,
        clamp01(event.snapshot.novelty), event.band);
    }

    // ---- コア: 結線を通した駆動を、従来どおりの時間の規律で見せる ----
    this.resolver.updateParam('coreStrike', deltaSeconds);
    const coreDrive = this.resolver.valueOf('coreStrike');
    const coreArmed = coreDrive >= this.coreGate;
    if (coreArmed) {
      const above = (coreDrive - this.coreGate) / Math.max(1 - this.coreGate, 1e-6);
      const pulse =
        DRIVE.coreMinimumPulse +
        (1 - DRIVE.coreMinimumPulse) * Math.pow(clamp01(above), DRIVE.coreCurveExponent);
      // **表示のたびに確定する。** この表示期間のあいだ、値は動かない。
      this.heldCorePulse = Math.max(this.heldCorePulse, pulse);
      // 形状族は打撃の音のシードで選ぶ。層化して引くので「毎回同じコア」にならない。
      const offset = Math.floor(this.strikeSeed * CORE_SHAPES.length);
      this.heldCoreShape = (this.strikeIndex + offset) % CORE_SHAPES.length;
      // **立ち上がりでだけ位相を戻す。** 連続したソースへ繋ぎ替えても点きっぱなしにならず、
      // ティックの上で on / off を繰り返す（フェード禁止の恒久方針はここで守られる）。
      if (!this.coreWasArmed) {
        // 立ち上がり。位相を戻し、**最初の 1 ティックは歳を取らせない**
        // （打撃 1 発のときは従来どおり「1 ティックだけ光る」になる）。
        this.coreAge = 0;
        this.coreFresh = true;
        this.pulseCount += 1;
      }
      this.coreTicksLeft = 1;
      this.coreFramesLeft = DRIVE.coreMinimumFrames;

      // ---- 打撃に同期したアーム ----
      // 方向の組み合わせは重み表から層化して引く（歩幅が表長と互いに素なので
      // 同じ組が続けて出ない）。位相だけを音のシードがずらす。
      const armOffset = Math.floor(this.strikeSeed * ARM_SETS.length);
      this.heldArmMask = ARM_SETS[(this.strikeIndex * 7 + armOffset) % ARM_SETS.length] ?? 0;
      this.heldArmStrength = Math.max(this.heldArmStrength, pulse);
      this.heldArmSeed = (Math.round(this.strikeSeed * 65537) + this.strikeIndex * 31) | 0;
      // 強い打撃だけ 1 ティック長く残す。
      this.armTicksLeft = pulse > 0.75 ? 2 : 1;
      this.armFramesLeft = DRIVE.coreMinimumFrames;
    }
    this.coreWasArmed = coreArmed;

    // ---- 扇: コアより高い閾値。階層は 弱 = 無 / 中 = コア + アーム / 強 = + 扇 ----
    this.resolver.updateParam('fanStrike', deltaSeconds);
    const fanDrive = this.resolver.valueOf('fanStrike');
    const fanArmed = fanDrive >= this.fanGate;
    if (fanArmed) {
      const fanAbove = clamp01((fanDrive - this.fanGate) / Math.max(1 - this.fanGate, 1e-6));
      const power =
        DRIVE.fanMinimumPower +
        (1 - DRIVE.fanMinimumPower) * Math.pow(fanAbove, DRIVE.fanCurveExponent);
      // **打撃ティックで即出現する。** 値はこの瞬間に確定し、以後は動かない。
      this.heldFanPower = Math.max(this.heldFanPower, power);
      // 向き・角度幅の個体差の元。打撃の音のシードと通し番号だけから決まる（決定論）。
      this.heldFanSeed =
        (Math.round(this.strikeSeed * 60013) + this.strikeIndex * 4099) & 0x7fffffff;
      // 寿命は 2〜4 ティック（強打ほど長い）。on/off を交互に繰り返すので表示はその半分。
      this.fanTicksLeft = Math.min(
        Math.max(Math.round(DRIVE.fanLifeBase + fanAbove * DRIVE.fanLifeFromStrength), 2),
        DRIVE.fanLifeBase + DRIVE.fanLifeFromStrength,
      );
      if (!this.fanWasArmed) {
        this.fanAge = 0;
        this.fanCount += 1;
      }
      this.fanHoldFrames = DRIVE.fanMinimumFrames;
    }
    this.fanWasArmed = fanArmed;

    if (this.publishedFanPower() > 0) this.fanVisibleFrames += 1;
  }

  // ---------------------------------------------------------------- 痕跡場

  /** 正規化座標 → セル番号（範囲外は端へ丸める）。 */
  private traceCell(nx: number, ny: number): number {
    const e = DRIVE.traceExtent;
    const cx = Math.min(
      Math.max(Math.floor(((nx + e) / (2 * e)) * DRIVE.traceColumns), 0),
      DRIVE.traceColumns - 1,
    );
    const cy = Math.min(
      Math.max(Math.floor(((ny + e) / (2 * e)) * DRIVE.traceRows), 0),
      DRIVE.traceRows - 1,
    );
    return cy * DRIVE.traceColumns + cx;
  }

  /** セル番号 → そのセルの中心（正規化座標）。引き寄せ先はここになる。 */
  private traceCentre(cell: number): [number, number] {
    const e = DRIVE.traceExtent;
    const cx = cell % DRIVE.traceColumns;
    const cy = Math.floor(cell / DRIVE.traceColumns);
    return [
      ((cx + 0.5) / DRIVE.traceColumns) * 2 * e - e,
      ((cy + 0.5) / DRIVE.traceRows) * 2 * e - e,
    ];
  }

  /**
   * **場をゆっくり減衰させる。** 半減期は定数で、フレームレートには依らない。
   * 置く量に上限があり、減衰が指数なので**いくら長く再生しても飽和しない**
   * （平衡値は「毎秒置く量 × 半減期 / ln2」で頭打ちになる）。
   */
  private decayTrace(deltaSeconds: number): void {
    if (deltaSeconds <= 0) return;
    const keep = Math.pow(0.5, deltaSeconds / DRIVE.traceHalfLife);
    for (let i = 0; i < this.trace.length; i++) this.trace[i]! *= keep;
    this.tracePeak *= keep;
  }

  /**
   * **断片が消えた場所に痕跡を置く。** 量は打撃の強さと断片の大きさに比例する。
   * 上限で頭打ちにするので、同じ場所へ何度置いても際限なく濃くはならない。
   */
  private depositTrace(spawn: FragmentSpawn): void {
    const bias = fragmentBandBias(spawn.band);
    const place = fragmentPlacement(spawn.seed, spawn.slot, bias.lift, spawn.aim, spawn.pull ?? 0);
    const cell = this.traceCell(place.nx, place.ny);
    const amount = DRIVE.traceDeposit * (0.35 + clamp01(spawn.strength)) * bias.size;
    const next = Math.min(this.trace[cell]! + amount, DRIVE.traceCeiling);
    this.trace[cell] = next;
    if (next > this.tracePeak) this.tracePeak = next;
    this.traceDeposits += amount;
  }

  /**
   * **次の断片を引き寄せる先。**
   *
   * 候補をいくつか**音のシードから**引き（`Math.random()` は使わない）、
   * そのうち痕跡がいちばん濃いセルを選ぶ。場が空なら濃さ 0 なので
   * 引き寄せも 0 になり、**自然に従来の散らばりへ落ちる**。
   */
  private traceAim(
    seed: number,
    slot: number,
  ): { readonly aim: [number, number] | null; readonly pull: number } {
    if (this.traceAmount <= 0 || this.tracePeak <= 0) return { aim: null, pull: 0 };
    // 場の量に**比例して**セルを引く。空のセルは重み 0 なので決して選ばれない。
    // 一様に候補を撒くやり方だと、薄い場では候補がほぼ空セルに落ちて引き寄せが効かない。
    let total = 0;
    for (let i = 0; i < this.trace.length; i++) total += this.trace[i]!;
    if (total <= 0) return { aim: null, pull: 0 };
    const target = hash01(seed + 4441, slot * 31 + 1) * total;
    let running = 0;
    let cell = -1;
    for (let i = 0; i < this.trace.length; i++) {
      running += this.trace[i]!;
      if (running >= target) {
        cell = i;
        break;
      }
    }
    if (cell < 0) cell = this.trace.length - 1;
    const weight = this.trace[cell]!;
    if (weight <= 0) return { aim: null, pull: 0 };
    // 濃さは場の最大値で正規化する。薄い痕跡には弱くしか引かれない。
    // 平方根で中くらいの濃さを持ち上げる（線形だと薄い場でほとんど効かなかった）。
    const pull =
      this.traceAmount * DRIVE.tracePullMaximum * Math.sqrt(clamp01(weight / this.tracePeak));
    if (pull <= 0) return { aim: null, pull: 0 };
    this.traceAimed += 1;
    return { aim: this.traceCentre(cell), pull };
  }

  /**
   * **音色の持続値 → グローバル波長 H の状態（Step 5）。**
   *
   * H は連続量として動かさない。音色をゆっくり平滑した値がどの区画に入るかで
   * 状態が決まり、**区画を余白ぶん外れ**（ヒステリシス）、**確認時間**続き、
   * いまの状態を**最短保持**したときにだけ、次のティック境界で瞬時に跳ぶ。
   * 目に見えるのは「緑の回」「赤の回」が丸ごと入れ替わることだけで、
   * 途中の中間色は 1 フレームも出ない。
   *
   * **無音では最後の H を保つ**（どうせ黒）。確認だけ捨てるので、
   * 再開時はそのときの音色から数え直しになる。
   */
  private updateHue(audio: AudioParameters, playing: boolean, deltaSeconds: number): void {
    const dt = Math.max(deltaSeconds, 0);
    if (!playing) {
      // 音色も H も凍らせる。**確認だけ捨てる**ので、再開は現在の音色からやり直し。
      this.hueCandidate = this.hueState;
      this.hueConfirmed = 0;
      this.hueHeld += dt;
      return;
    }

    // 音色 = 帯域の傾き（高域寄りか低域寄りか）と centroid の混合。
    const bass = clamp01(audio.bass ?? 0);
    const mid = clamp01(audio.mid ?? 0);
    const treble = clamp01(audio.treble ?? 0);
    const centroid = clamp01(audio.centroid ?? 0);
    const total = bass + mid + treble;
    // 傾きは −1（低域だけ）〜 +1（高域だけ）。無音に近いときは中立に置く。
    const tilt = total > 1e-4 ? (treble - bass) / total : 0;
    const tone = clamp01(0.5 + 0.5 * tilt * DRIVE.hueToneGain);
    // アダプタ自身の音色（＝既定の接続先）。**状態機械はこの下流のまま。**
    this.opticsTimbre = clamp01(DRIVE.hueTiltWeight * tone + (1 - DRIVE.hueTiltWeight) * centroid);
    this.resolver.updateParam('hueTimbre', dt);
    const raw = this.resolver.valueOf('hueTimbre');
    // **持続値**。1 発の打撃では動かず、区間くらいの速さでしか動かない。
    const previous = this.timbre;
    this.timbre = this.timbreSeen
      ? smooth(this.timbre, raw, dt, DRIVE.hueTimbreSeconds)
      : raw;
    this.timbreDrift = this.timbreSeen
      ? smooth(this.timbreDrift, raw - previous, dt, DRIVE.hueDriftSeconds)
      : 0;
    this.timbreSeen = true;
    // 音色がまだ横断している最中は確認を数えない（寄り道の色を出さない）。
    const settled = Math.abs(this.timbreDrift) / DRIVE.hueTimbreSeconds <= DRIVE.hueSettleRate;

    const candidate = this.hueCandidateFor(this.timbre);
    if (candidate === this.hueState) {
      // 区画へ戻ってきた。確認は捨てる（往復で切り替わらない）。
      this.hueCandidate = candidate;
      this.hueConfirmed = 0;
      this.huePending = -1;
    } else {
      if (candidate !== this.hueCandidate) {
        this.hueCandidate = candidate;
        this.hueConfirmed = 0;
      }
      this.hueConfirmed = settled ? this.hueConfirmed + dt : 0;
      if (this.hueConfirmed >= this.hueConfirmSeconds && this.hueHeld >= this.hueHoldSeconds) {
        // 適用はティック境界。光の出し入れと同じ規律に揃える。
        this.huePending = candidate;
      }
    }
    this.hueHeld += dt;
    // ストロボを切っているあいだはティックが来ないので、その場で適用する。
    if (!this.strobeEnabled) this.commitHue();
  }

  /**
   * いまの音色が指す状態。**いまの区画から余白ぶん外へ出るまでは現状に留まる**
   * ので、境界の上で揺れてもフリップフロップしない。
   */
  private hueCandidateFor(timbre: number): number {
    const states = DRIVE.hueStates;
    const bare = Math.min(Math.max(Math.floor(timbre * states), 0), states - 1);
    if (bare === this.hueState) return bare;
    const low = (this.hueState - DRIVE.hueHysteresis) / states;
    const high = (this.hueState + 1 + DRIVE.hueHysteresis) / states;
    return timbre > low && timbre < high ? this.hueState : bare;
  }

  /** 予約されていた H の切替を確定する。**補間はしない**（1 フレームで切り替わる）。 */
  private commitHue(): void {
    if (this.huePending < 0 || this.huePending === this.hueState) {
      this.huePending = -1;
      return;
    }
    this.hueState = this.huePending;
    this.huePending = -1;
    this.hueCandidate = this.hueState;
    this.hueConfirmed = 0;
    this.hueHeld = 0;
    this.hueSwitches += 1;
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
      // **痕跡場が次の位置を引き寄せる。** 場が空なら引き寄せ 0 ＝ 従来の散らばり。
      const aimed = this.traceAim(seed, slot);
      this.pendingFragments.push({
        spawn: { seed, slot, strength, band, aim: aimed.aim, pull: aimed.pull },
        life,
      });
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
    // **H の切替もティック境界でだけ起きる。** 中間色は 1 フレームも出ない。
    this.commitHue();
    // 色調のチルトも同じ規律で latch する（連続では動かさない）。
    this.heldChannel = this.channelFromBands();
    // **歳は「駆動が続いているあいだ」だけ進む。**
    // 打撃 1 発では 0 のままなので従来どおり 1 ティックだけ光り、
    // 連続したソースへ繋ぎ替えたときだけ位相が回って on / off が交互になる。
    if (this.coreFresh) this.coreFresh = false;
    else if (this.coreWasArmed) this.coreAge += 1;
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
      if (entry.age >= entry.life) {
        // **消える場所に痕跡を置く。** ここが蓄積の書き込み口。
        this.depositTrace(entry.spawn);
        continue;
      }
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
      timbre: this.timbre,
      hueState: this.hueState,
      huePhase: this.huePhase(),
      hueCandidate: this.hueCandidate,
      hueConfirmed: this.hueConfirmed,
      hueHeld: this.hueHeld,
      hueSwitches: this.hueSwitches,
      tracePeak: this.tracePeak,
      traceTotal: this.traceTotal(),
      traceCells: this.traceLiveCells(),
      traceDeposits: this.traceDeposits,
      traceAimed: this.traceAimed,
      bands: [this.bandLow, this.bandMid, this.bandHigh],
      channel: this.heldChannel,
    };
  }

  /**
   * **ストロボの門を通す前の素の値**（統合表現が読む）。
   * 何も書き換えないので、これを読まない表現の見え方は 1 画素も変わらない。
   */
  sustained(): OpticsSustained {
    return {
      field: this.skeleton,
      fieldHeld: this.heldSkeleton,
      fieldGain: this.fieldGain,
      corePulse: this.heldCorePulse,
      coreShape: this.heldCoreShape,
      coreAge: this.coreAge,
      coreAlive: this.coreTicksLeft > 0 || this.coreFramesLeft > 0,
      fanPower: this.heldFanPower,
      fanSeed: this.heldFanSeed,
      fanAge: this.fanAge,
      fanAlive: this.fanTicksLeft > 0,
      armMask: this.heldArmMask,
      armStrength: this.heldArmStrength,
      armSeed: this.heldArmSeed,
      armAlive: this.armTicksLeft > 0 || this.armFramesLeft > 0,
      tick: this.tickIndex,
      fragments: this.liveFragments.map((entry) => ({ spawn: entry.spawn, age: entry.age })),
    };
  }

  /** 場の総量。飽和していないかを見るために読む。 */
  private traceTotal(): number {
    let total = 0;
    for (let i = 0; i < this.trace.length; i++) total += this.trace[i]!;
    return total;
  }

  /** 痕跡が残っているセルの数。筋がどれだけ広がっているか。 */
  private traceLiveCells(): number {
    let n = 0;
    for (let i = 0; i < this.trace.length; i++) if (this.trace[i]! > 0.01) n += 1;
    return n;
  }

  /** 場の中身を読み出す（開発・検証用）。**書き換えないこと。** */
  traceField(): { readonly columns: number; readonly rows: number; readonly cells: Float32Array } {
    return { columns: DRIVE.traceColumns, rows: DRIVE.traceRows, cells: this.trace };
  }

  /** コアが出ているのは、打撃のティックのあいだだけ。 */
  private publishedCorePulse(): number {
    if (this.coreTicksLeft <= 0 && this.coreFramesLeft <= 0) return 0;
    if (!this.strobeEnabled) return this.heldCorePulse;
    // 打撃 1 発なら歳は 0 のまま ＝ 従来どおり 1 ティックだけ光る。
    // 駆動が続くときだけ位相が進み、ティックの上で明滅する。
    return this.coreAge % STROBE.period < STROBE.onTicks ? this.heldCorePulse : 0;
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
      // 場は利得を掛けて 1 を超えることがある（ストロボで半分になる面積の補償）。
      skeletonLevel: this.heldSkeleton * this.fieldGain,
      curtainLevel: this.heldCurtain * this.fieldGain,
      hazeLevel: this.heldHaze * this.fieldGain,
      corePulse: pulse,
      // 断片は spawn 側で作るので、つまみ由来の energy は使わない。
      fragmentEnergy: 0,
      fragments: this.visibleFragments(),
      // 強打だけが開く扇（Step 4）。強さも個体差も打撃の瞬間に確定する。
      fanGate: this.publishedFanPower(),
      fanSeed: this.heldFanSeed,
      // 音色の持続値が選んだ離散状態の H（Step 5）。**つまみは Manual だけに効く。**
      huePhase: this.huePhase(),
      // 音由来の seed は未配線。それまでは開発つまみの値をそのまま使う。
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
