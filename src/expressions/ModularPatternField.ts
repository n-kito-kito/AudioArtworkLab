import * as THREE from 'three';
import type { AudioParameters } from '../audio/AudioEngine';
import type {
  CompositionContext,
  DesignLayerCanvases,
} from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { LabExpression } from './Expression';

/**
 * Modular Pattern Field — モジュール式のパターン場（試作）。
 *
 * オフホワイトの紙に黒い幾何学が置かれる。図形は円と角丸四角の 2 つだけで、
 * それらが「重なりの偶奇」と「格子への整列」という 2 つの規則の間を行き来する。
 *
 * ■ 弧（arc）が全体を貫く
 *
 * サイクルは 1 本の長い弧である。進行度 `arc: 0 → 1` は**一方向にしか進まない**。
 * フェーズは arc 上の区間として定義され、逆行も再訪もしない（1 サイクル ≒ 25 秒）。
 * 音は arc の**進行速度**を変えるだけで、順序は変えない。音が沈むと弧は停滞する。
 * 無音（active = 0）では何も動かない（PRD D5）。
 *
 *   arc         フェーズ        見え方
 *   0.00–0.05   spawn         起点クラスタから大きな円が現れる。重なりは XOR で抜ける
 *   0.05–0.13   expand        円が育つ。三日月・リング形。大中小のサイズ階層
 *   0.13–0.22   gridMorph     小さい円から順に格子へ落ちる。円と角丸セルが混在する
 *   0.22–0.34   rowCascade    2×2 結合ブロックの市松モザイク（黒面積のピーク）
 *   0.34–0.56   merge         角丸が最大化し、セルがほぼ円になって隣と首で繋がる（ブロブ）
 *   0.56–0.76   subdivide     セル内 2×2 → さらに 4×4 相当へ。花型・45°ダイヤのパッチ
 *   0.76–0.90   finalCluster  微細な点・小花のクラスタが島状に残る
 *   0.90–1.00   clear         残った島がパッと消え、次の弧まで空白
 *
 * ■ スケールは一方向に降りる
 *
 * 巨大な円（セル跨ぎ）→ 粗いブロック（2×2 結合）→ ブロブ（セル単位）→
 * 細分化（セル内 2×2）→ 微細（セル内 4×4 相当）。後のステージほど有効グリッドが細かい。
 *
 * ■ 空間的な連続性
 *
 * 出現は起点セルからの**成長前線**（一様散布はしない）。消滅は**島の縁からの浸食**で、
 * 縁のセルから順に落ちる。最後の残り火だけが短時間でパッと消える。
 *
 * ■ 黒面積は目標値に追従させる
 *
 * arc に対する目標占有率（0 → 弧の 1/4 で ~0.58 → 緩やかに 0.08 → 最後に 0）を置き、
 * 現在の占有率との差で成長前線と浸食の速さを決める。密度カーブが弧の骨格になる。
 *
 * ■ 変化の語彙は 3 種類しかない
 *
 * 「音に対して急にサイズが変わる」「変なタイミングで消える」を避けるため、
 * 起こしてよい変化を次の 3 種に分け、それぞれの規則を厳密に守る。
 *
 *   A. 連続量（毎フレーム・必ず慣性を通す）
 *      弧の進行速度・角丸量・大きさの全体アーチ・目標黒面積。
 *      音は必ずならしてから使う（driveSmooth / fineSmooth / bassSmooth）。
 *      **生きているセルの大きさを後から音で変えない。** 大きさは
 *      「誕生時に決まる偏り sizeBias × arc だけの関数である全体アーチ」で決まる。
 *
 *   B. 離散イベント（出来事にだけ反応・必ず上限つき）
 *      セルの誕生・浸食・回転／ダイヤのウェーブ進行。
 *      トリガはオンセット（不応時間つき）と arc の前進だけ。
 *      1 手で動かせるのは誕生 1〜2 セル・浸食 1 セルで、浸食は最短 0.15 秒間隔。
 *      目標面積とのずれがどれだけ大きくても一気に間引かない。
 *
 *   C. 構造（サイクル内で不変）
 *      配置・大きさの偏り・浸食順序・ダイヤの位置。すべてシードで決まり途中で変わらない。
 *
 * 消え方は縮み消え（fadeSeconds）で、ポップ消しは最終 clear のバーストだけに許す。
 * 誕生は 0 → 定寸へ birthSeconds かける。どちらも尺は時間で決め打ちで、音に揺れない。
 *
 * 音との対応（PRD §7 の解釈。表現ごとに定義する = D25）:
 *   volume（帯域ゲイン・2 秒ならし） → **弧の進行速度のみ**。
 *              見た目の量や大きさを直接動かさない。静かにしても何も消えない
 *   bass     → 新しく生まれるモジュールの大きさの階層・結合半径（ならして使う）
 *   mid      → 新規接続の起きやすさ（前線がどれだけ既存のかたまりに寄るか）
 *   treble / centroid → 新規セルの角丸傾向・細分化の進みやすさ
 *   onset    → 誕生／ウェーブの「一押し」（上限内・不応時間つき）
 *   flatness → 欠損と局所反転の量
 *   sustain  → 整列（モーフ）の進み
 *   seed     → 起点位置・ダイヤ化・欠損位置・浸食順序
 *
 * 乱数は音のシードとセル番号からの決定論的ハッシュのみ。Math.random() は使わない
 * （PRD §3.1）。同じ音なら同じ像になり、違う音なら予測できない像になる。
 *
 * 質感の定数はこのファイルの MODULAR にまとめる。サイマティクスの TUNING とは
 * 混ぜない（表現ごとに持つものを宣言する = D25）。
 */

/** シェーダーの円配列の長さ。MODULAR.circleCount と必ず一致させること。 */
const CIRCLE_SLOTS = 16;

const MODULAR = {
  // ---- グリッド ----
  gridBase: 6, //            1:1 のときのマクログリッドの一辺のセル数
  gridMin: 4, //             セル数の下限（画角が極端でも粗くなりすぎない）
  gridMax: 12, //            同・上限

  // ---- 弧（サイクル全体を 1 本で通す）----
  cycleSeconds: 25, //       素の速さで弧を通り切るのにかかる秒数
  arcQuiet: 0.12, //         音が沈んだときの進行速度の下限。ほぼ停まる（＝何も消えない）
  arcRef: 0.32, //           これを「素の音量」とみなす。ここで進行速度がちょうど 1 倍
  arcCurve: 0.7, //          音量→速度の圧縮（1 未満で小さい音でも進む）
  arcRateMax: 1.6, //        進行速度の上限（飛ばしすぎない）
  arcSmooth: 2, //           音量をならす時定数（秒）。曲の谷で止まらないようにする
  // オンセット 1 回が弧を進める量。1 発 = サイクルの 0.2%。
  // onsetCooldown で 1 秒あたり約 6 発までなので、連打でも速さは 3 割増しに収まる。
  arcOnsetPush: 0.002,
  toneSmooth: 1.5, //        角丸・細分化に使う音（高域・低音）をならす時定数（秒）

  // ---- 円（spawn / expand。重なりは XOR で抜ける）----
  circleCount: CIRCLE_SLOTS, // 撒く円の総数。CIRCLE_SLOTS と一致させる
  circleLarge: 2, //         大きい円の個数
  circleMedium: 5, //        中くらいの円の個数（残りが小）
  largeMinR: 1.15, //        大の半径（セル単位）
  largeSpanR: 0.6,
  mediumMinR: 0.62, //       中の半径
  mediumSpanR: 0.42,
  smallMinR: 0.26, //        小の半径
  smallSpanR: 0.3,
  clusterSpread: 2.4, //     起点クラスタの広がり（セル）。増殖は 1 点から始まる
  spawnSpanArc: 0.1, //      すべての円が出そろうまでの弧の長さ
  growSpeed: 1.1, //         円の半径が育つ速さ（セル単位/秒）
  growSpread: 0.8, //        円ごとの育つ速さのばらつき

  // ---- 黒面積の目標（弧だけで決まる密度カーブ）----
  // 音量をここに混ぜない。混ぜると「音が小さくなった＝目標が下がった＝消す」になり、
  // 静かにしただけで図形が消える（発注者の指摘）。音量は弧の速さだけを変える。
  coverPeak: 0.58, //        ピークの目標占有率
  coverPeakArc: 0.26, //     ピークが来る弧の位置
  coverEnd: 0.08, //         漸減の終着点
  coverEndArc: 0.9, //       そこに着く弧の位置
  coverZeroArc: 0.96, //     完全に空になる弧の位置
  coverFall: 1.6, //         漸減の曲がり（1 より大きいと前半はゆっくり落ちる）
  densitySlack: 0.02, //     これ以下のずれでは動かさない（ばたつき防止）
  growUntilArc: 0.36, //     これを超えると誕生は止まり、浸食だけになる
  frontJitter: 1.3, //       成長前線の縁のゆらぎ（セル）

  // ---- 離散イベントの上限（B）----
  // 誕生・浸食・ウェーブは「出来事」であって連続量ではない。
  // 目標とのずれがどれだけ大きくても、1 回の出来事で動かせる数を必ず抑える。
  birthInterval: 0.12, //    誕生 1 手の最短間隔（秒）
  birthPerEvent: 1, //       1 手で生まれるセル数
  birthPerEventWide: 2, //   ずれが大きいときの上限（これ以上は増やさない）
  birthWideDeficit: 0.12, // 「ずれが大きい」とみなす境目
  birthOnset: 2, //          オンセット 1 発が押す誕生の数（上限）
  erodeInterval: 0.15, //    浸食 1 手の最短間隔（秒）。連打でもこれ以上は速くならない
  birthSeconds: 0.2, //      誕生に 0 → 定寸までかける時間
  fadeSeconds: 0.1, //       浸食で縮んで消えるまでの時間（ポップ消しにしない）
  connectLookahead: 3, //    中域が広げる「前線の選択肢」の幅（接続しやすさ）

  // ---- 角丸のアーチ（セル単位。モジュール半幅より大きいと真円になる）----
  radiusOpen: 0.7, //        円でいる間の半径。どのモジュール半幅より大きく取る
  radiusGrid: 0.1, //        格子化直後（角丸ひかえめの矩形）
  radiusBlock: 0.07, //      粗いブロック期（ほぼ直角）
  radiusBlob: 0.46, //       ブロブ期の最大値。セルがほぼ円になり隣と首で融合する
  radiusSub: 0.12, //        細分化期
  radiusFinal: 0.145, //     終盤。小セル半幅を上回らせて「小さな円」にする
  radiusTreble: 0.05, //     高域・重心が角丸を増やす量
  radiusBass: 0.25, //       低音が結合半径を広げる割合（ブロブ期）
  radiusEase: 4, //          角丸が目標へ寄る速さ（毎秒）

  // ---- gridMorph ----
  cellScale: 0.86, //        整列直後のモジュールの大きさ（セル幅比）
  morphLead: 0.16, //        円がセルへ吸い寄せられる助走の長さ（ステージ内比）
  sizeSpread: 0.35, //       低音が広げる「大きさの階層」の幅（誕生時にのみ効く）
  sizeTreble: 0.12, //       高域が誕生するモジュールを小さめに寄せる量
  alignSustain: 0.35, //     持続が助走を速める量

  // ---- rowCascade（粗い 2×2 結合ブロックの市松）----
  blockScale: 1.06, //       ブロック期のアーチ値。わずかに接して 2×2 が 1 枚になる
  blockOnEven: 0.88, //      市松の「置く」側のブロックが立つ割合
  blockOnOdd: 0.32, //       同・「抜く」側（例外を混ぜて機械的にしない）
  singleTileChance: 0.45, // 落ちたブロックが単独タイルを 1 枚だけ残す割合
  tiltAmount: 0.11, //       単独タイルのわずかな傾き（ラジアン）
  cascadeRowSeconds: 0.55, // 回転ウェーブが 1 行進むのにかかる時間
  cascadeColDelay: 0.035, //  行の中で列ごとにずらす秒数

  // ---- merge（ブロブ）----
  blobScale: 1.1, //         セルがわずかに重なり、隣と首で繋がる大きさ

  // ---- subdivide / finalCluster ----
  subScale: 1.0, //          細分化期のモジュールの大きさ
  fineScale: 0.92, //        微細期のモジュールの大きさ
  subGap: 0.96, //           小セルの詰まり（1 で隙間なし＝十字・花型が連結する）
  subFineChance: 0.75, //    細分化期の終わりまでに 4×4 相当へ落ちるセルの割合
  finalFineChance: 0.85, //  微細期に 4×4 相当でいるセルの割合
  fineKeep: 0.72, //         4×4 の小点が残る割合（ノイズ性が欠けさせる）
  fineKeepFlatness: 0.25, // ノイズ性が小点を欠けさせる量
  flatnessDrop: 2.4, //      ノイズ性が 2×2 の小セルを欠けさせる量
  flowerChance: 0.5, //      4 セルで中央が抜ける花型ができる割合
  diamondPatches: 2, //      45°ダイヤ市松のパッチ数（一部のクラスタだけを回す）
  diamondRadius: 1.5, //     パッチの広がり（セル）
  cascadeInvert: 0.18, //    行が白黒反転する確率の基準

  // ---- clear ----
  clearStep: 0.045, //       消去 1 手の間隔（秒）
  clearGroups: 14, //        何手に分けて消すか（同時に全部は消さない）

  // ---- 共通 ----
  easeSpeed: 7, //           目標値へ寄る速さ（毎秒）
  onsetCooldown: 0.16, //    オンセット判定の不応時間（秒）
};

type Phase =
  | 'spawn'
  | 'expand'
  | 'gridMorph'
  | 'rowCascade'
  | 'merge'
  | 'subdivide'
  | 'finalCluster'
  | 'clear';

/**
 * 弧の区間としてのフェーズ。順序は固定で、arc は一方向にしか進まないので
 * 逆行・再訪は起きない。区間の幅がそのままステージの尺になる。
 */
const STAGES: readonly { readonly phase: Phase; readonly from: number; readonly to: number }[] = [
  { phase: 'spawn', from: 0.0, to: 0.05 },
  { phase: 'expand', from: 0.05, to: 0.13 },
  { phase: 'gridMorph', from: 0.13, to: 0.22 },
  { phase: 'rowCascade', from: 0.22, to: 0.34 },
  { phase: 'merge', from: 0.34, to: 0.56 },
  { phase: 'subdivide', from: 0.56, to: 0.76 },
  { phase: 'finalCluster', from: 0.76, to: 0.9 },
  { phase: 'clear', from: 0.9, to: 1.0 },
];

interface Cell {
  alive: boolean;
  /** セル幅に対するモジュールの大きさ。1 で隣と接する。 */
  scale: number;
  targetScale: number;
  /**
   * 誕生時に決まる大きさの偏り（1 が標準）。以後この値は変わらない。
   * 実際の大きさは「この偏り × arc の全体アーチ」だけで決まるので、
   * 音の瞬間値で生きているセルの大きさが跳ねることはない。
   */
  sizeBias: number;
  /** 誕生からの経過秒。birthSeconds かけて 0 → 定寸へ育つ。 */
  birthTime: number;
  /** 消えかけの経過秒。-1 なら消えかけではない。 */
  fadeTime: number;
  /** 縮み始めたときの大きさ。 */
  fadeFrom: number;
  /** 構造上いずれ落ちると決まったセル（市松の抜き側など）。順番に縮んで消える。 */
  doomed: boolean;
  /** 回転（ラジアン）。90°単位、またはダイヤ化の 45°。 */
  rotation: number;
  targetRotation: number;
  /** 2×2 に分けた小セルの詰まり具合（1 で隙間なし）。 */
  sub: number;
  targetSub: number;
  /** 局所反転。このセルの矩形内だけ白黒が入れ替わる。 */
  invert: boolean;
  /** 2×2 のどれが残っているか（下位 4 ビット）。 */
  mask: number;
  subdivided: boolean;
  /** さらに 1 段細かい（各象限を 2×2 = セル内 4×4 相当に割る）。 */
  fine: boolean;
  /** 目標へ寄り始めるまでの待ち時間（秒）。行ごとのウェーブを作る。 */
  delay: number;
}

interface Circle {
  x: number;
  y: number;
  r: number;
  fromX: number;
  fromY: number;
  fromR: number;
  maxR: number;
  rate: number;
  /** この弧の位置に達したら現れる。 */
  startArc: number;
  /** gridMorph の中でこの進行度に達したらセルへ入れ替わる（小さい円ほど早い）。 */
  convertAt: number;
  /** 行き先のセルが持つ大きさの偏り。円はこの寸法へ寄るので入れ替わりが見えない。 */
  bias: number;
  cell: number;
  on: boolean;
  done: boolean;
}

const clamp01 = (value: number | undefined): number => Math.min(Math.max(value ?? 0, 0), 1);
const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 32bit 整数の決定論的ハッシュ。Math.random() は使わない（PRD §3.1）。 */
function hashInt(value: number): number {
  let h = value | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** シード（0..1）とキー列から 0..1 を作る。同じ入力なら必ず同じ値になる。 */
function hashKeys(seed: number, ...keys: number[]): number {
  let h = Math.round(seed * 0xffffff) | 0;
  for (let i = 0; i < keys.length; i++) {
    h = Math.imul(h ^ ((keys[i]! | 0) + 0x9e37), 0x85ebca6b) | 0;
    h = (h ^ (h >>> 13)) | 0;
  }
  return hashInt(h);
}

/** シード由来の並べ替え（Fisher–Yates）。消去順序などに使う。 */
function seededOrder(count: number, seed: number, salt: number): number[] {
  const items: number[] = [];
  for (let i = 0; i < count; i++) items.push(i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(hashKeys(seed, salt, i) * (i + 1));
    const swap = items[i]!;
    items[i] = items[j]!;
    items[j] = swap;
  }
  return items;
}

/**
 * 画角からマクログリッドの列数・行数を決める（D26）。
 * セルが物理的に正方形へ近づく組み合わせを選ぶ。切り取りや余白は作らない。
 */
function gridForRatio(ratio: number): { cols: number; rows: number } {
  let best = { cols: MODULAR.gridBase, rows: MODULAR.gridBase };
  let bestScore = Number.POSITIVE_INFINITY;
  const wanted = MODULAR.gridBase * MODULAR.gridBase;
  for (let rows = MODULAR.gridMin; rows <= MODULAR.gridMax; rows++) {
    const cols = clamp(Math.round(rows * ratio), MODULAR.gridMin, MODULAR.gridMax);
    // セルの縦横比のずれ（対数）と、セル総数のずれ（対数）の重み付き和。
    const shape = Math.abs(Math.log((ratio * rows) / cols));
    const size = Math.abs(Math.log((rows * cols) / wanted));
    const score = shape + size * 0.2;
    if (score < bestScore) {
      bestScore = score;
      best = { cols, rows };
    }
  }
  return best;
}

export class ModularPatternField implements LabExpression {
  readonly animated = true;
  readonly name = 'Modular Pattern Field';
  readonly id: ExpressionId = 'modular-v1';

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  private context: CompositionContext | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private geometry: THREE.PlaneGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private cellTexture: THREE.DataTexture | null = null;
  private cellData: Uint8Array = new Uint8Array(4);
  private pipeline: EffectPipeline | null = null;
  private previousElapsed = -1;
  private viewWidth = 1;
  private viewHeight = 1;

  // ---- 場の状態 ----
  private cols = MODULAR.gridBase;
  private rows = MODULAR.gridBase;
  private cells: Cell[] = [];
  private circles: Circle[] = [];
  private readonly circleUniform: THREE.Vector4[] = [];

  // ---- 弧とステージ ----
  /** サイクルの進行度 0→1。一方向にしか進まない。 */
  private arc = 0;
  private stageIndex = 0;
  private phase: Phase = 'spawn';
  private cycleSeed = 0;
  private latestSeed = 0;
  private onsetCooldown = 0;
  /** 数秒ならした音量。弧の進行速度はこれで決まる。 */
  private driveSmooth = 0;

  // ---- 成長前線と浸食 ----
  /** 起点セルの中心（セル座標）。円も成長前線もここから広がる。 */
  private originX = 0;
  private originY = 0;
  /** 起点からの距離順（ゆらぎ入り）。成長はこの順に前線が進む。 */
  private growOrder: number[] = [];
  private growCursor = 0;
  /** 離散イベントの間隔タイマー。1 手ごとに必ずリセットされ、上限を超えられない。 */
  private birthTimer = 0;
  private erodeTimer = 0;
  private coverage = 0;
  private coverTarget = 0;

  // ---- ステージ内の細かい状態 ----
  private cascadeAdvance = 0;
  private cascadeRow = 0;
  private clearTime = 0;
  private clearOrder: number[] = [];
  private clearCursor = 0;
  private readonly singleTiles = new Set<number>();
  /** 円が行き先として押さえているセル。成長前線はここを取らない。 */
  private readonly reserved = new Set<number>();
  /** 構造上これから生まれると決まったセル。誕生スケジューラが 1 手ずつ通す。 */
  private pendingBirths: number[] = [];
  private fineChance = 0;

  /** 角丸・結合の半径（セル単位）。モジュール半幅より大きいと真円になる。 */
  private radius = MODULAR.radiusOpen;
  private radiusTarget = MODULAR.radiusOpen;
  /** 1 = 重なりを偶奇で抜く / 0 = 和を取る。円が残っている間だけ偶奇。 */
  private xor = 1;
  /** 4×4 の小点が残る割合（シェーダーへ渡す）。 */
  private fineKeep = MODULAR.fineKeep;

  // ---- 直近の音 ----
  // snap* は「離散イベントが起きた瞬間」にだけ読む（誕生するセルの性質を決める）。
  // *Smooth は連続量（角丸・細分化の進み）に使う。どちらも生きているセルの
  // 大きさには触れない。
  private snapFine = 0;
  private snapFlatness = 0;
  private snapMid = 0;
  private snapBass = 0;
  private fineSmooth = 0;
  private bassSmooth = 0;

  private debugView = 0;

  constructor(effects: Effect[] = [], theme?: Theme) {
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
    for (let i = 0; i < CIRCLE_SLOTS; i++) this.circleUniform.push(new THREE.Vector4());
    this.rebuildGrid();
  }

  // ------------------------------------------------------------------
  // セットアップ
  // ------------------------------------------------------------------

  setup(context: CompositionContext): void {
    this.context = context;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tCells: { value: this.cellTexture },
        uGrid: { value: new THREE.Vector2(this.cols, this.rows) },
        uPixel: { value: new THREE.Vector2(1 / 64, 1 / 64) },
        uActive: { value: 0 },
        uZoom: { value: this.zoom },
        uRadius: { value: this.radius },
        uXor: { value: 1 },
        uSeed: { value: this.cycleSeed },
        uFineKeep: { value: this.fineKeep },
        uCircles: { value: this.circleUniform },
        uThemeDark: { value: new THREE.Vector3(...this.theme.dark) },
        uThemeLight: { value: new THREE.Vector3(...this.theme.light) },
        uThemeAccent: { value: new THREE.Vector3(...this.theme.accent) },
        uDebugView: { value: this.debugView },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tCells;
        uniform vec2 uGrid;
        uniform vec2 uPixel;
        uniform float uActive;
        uniform float uZoom;
        uniform float uRadius;
        uniform float uXor;
        uniform float uSeed;
        uniform float uFineKeep;
        uniform vec4 uCircles[${CIRCLE_SLOTS}];
        uniform vec3 uThemeDark;
        uniform vec3 uThemeLight;
        uniform vec3 uThemeAccent;
        uniform float uDebugView;

        float sdBox(vec2 p, vec2 b) {
          vec2 d = abs(p) - b;
          return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
        }

        // 回転は 0..1 に詰めてある（RGBA8 の 1 チャンネル）。角度へ戻す。
        float unpackAngle(float packed) {
          return packed * 6.283185307179586;
        }

        // 被覆の排他的論理和。0/1 では厳密に XOR、途中では滑らかに繋がる。
        // 重なった部分だけを背景色へ抜く（even-odd）ための演算。
        float softXor(float a, float b) {
          return a + b - 2.0 * a * b;
        }

        vec2 rotate(vec2 p, float a) {
          float c = cos(a);
          float s = sin(a);
          return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
        }

        // セル座標・小点番号・シードから決まる 0..1。CPU 側と同じく決定論的。
        float hash13(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        /**
         * セル 1 つを評価する。
         * 角丸半径より大きい部品は「角丸ぶん縮めた芯」として dCore へ入れ、
         * 最後に一度だけ半径を引く（rounded union）。隣接セルの間に継ぎ目も隙間も出ない。
         * 半径より小さい部品はそのまま円として dRound へ入れる。こうすると
         * 生まれたてのセルが半径ぶん膨らまず、大きさ 0 から連続に現れる。
         */
        void evalCell(vec2 g, vec2 cell, inout float dCore, inout float dRound, inout float invertCov) {
          if (cell.x < 0.0 || cell.y < 0.0 || cell.x > uGrid.x - 1.0 || cell.y > uGrid.y - 1.0) return;
          vec4 t = texture2D(tCells, (cell + 0.5) / uGrid);
          float flags = floor(t.a * 255.0 + 0.5);
          float fine = floor(flags / 128.0);
          flags -= fine * 128.0;
          float alive = floor(flags / 64.0);
          flags -= alive * 64.0;
          float subdivided = floor(flags / 32.0);
          flags -= subdivided * 32.0;
          float invert = floor(flags / 16.0);
          float mask = flags - invert * 16.0;

          vec2 local = g - (cell + 0.5);
          if (invert > 0.5) {
            // 局所反転はセルの矩形そのもの。境界は硬い（パッと入れ替わって見える）。
            vec2 q = abs(local) - 0.5;
            invertCov = max(invertCov, 1.0 - step(0.0, max(q.x, q.y)));
          }
          if (alive < 0.5) return;

          float scale = t.r * 1.5;
          vec2 lp = rotate(local, -unpackAngle(t.g));
          float sub = t.b;

          if (subdivided < 0.5) {
            float h = 0.5 * scale;
            if (h > uRadius) {
              dCore = min(dCore, sdBox(lp, vec2(h - uRadius)));
            } else {
              dRound = min(dRound, length(lp) - h);
            }
            return;
          }

          float h = 0.25 * scale * sub;
          for (int k = 0; k < 4; k++) {
            float bit = floor(mod(mask / pow(2.0, float(k)), 2.0));
            if (bit < 0.5) continue;
            vec2 idx = vec2(mod(float(k), 2.0), floor(float(k) / 2.0));
            vec2 off = (idx - 0.5) * 0.5 * scale;
            if (fine < 0.5) {
              vec2 q = lp - off;
              if (h > uRadius) {
                dCore = min(dCore, sdBox(q, vec2(h - uRadius)));
              } else {
                dRound = min(dRound, length(q) - h);
              }
              continue;
            }
            // さらに 1 段細かい（象限を 2×2 = セル内 4×4 相当へ）。
            // 一部の小点はシード由来のハッシュで落とし、微細クラスタにする。
            float h2 = 0.5 * h;
            for (int m = 0; m < 4; m++) {
              vec2 jdx = vec2(mod(float(m), 2.0), floor(float(m) / 2.0));
              vec2 off2 = (jdx - 0.5) * 0.25 * scale;
              float keep = hash13(vec3(
                cell.x + uSeed * 31.7,
                cell.y + uSeed * 57.3,
                float(k) * 4.0 + float(m) + 1.0 + uSeed * 13.0
              ));
              if (keep > uFineKeep) continue;
              vec2 q = lp - off - off2;
              if (h2 > uRadius) {
                dCore = min(dCore, sdBox(q, vec2(h2 - uRadius)));
              } else {
                dRound = min(dRound, length(q) - h2);
              }
            }
          }
        }

        void main() {
          // D5: 音が鳴っていなければ何も見せない。
          if (uActive < 0.5) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          // ズームは開発用（D17）。板そのものを拡大縮小するだけ。
          vec2 uvz = (vUv - 0.5) / max(uZoom, 0.05) + 0.5;
          // g 空間ではセルが 1×1 になる。列数・行数は画角で割り振ってあるので
          // セルは物理的に正方形を保つ。
          vec2 g = uvz * uGrid;
          float aa = max(uPixel.x, uPixel.y) * 0.8;

          float dCore = 1e5;
          float dRound = 1e5;
          float invertCov = 0.0;
          vec2 base = floor(g);
          for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
              evalCell(g, base + vec2(float(i), float(j)), dCore, dRound, invertCov);
            }
          }
          float dGrid = min(dCore - uRadius, dRound);
          float gridCov = 1.0 - smoothstep(-aa, aa, dGrid);

          // 円（spawn / expand）。重なりは偶奇で背景色へ抜ける。
          float unionCov = 0.0;
          float parity = 0.0;
          for (int i = 0; i < ${CIRCLE_SLOTS}; i++) {
            vec4 c = uCircles[i];
            if (c.w < 0.5) continue;
            float cov = 1.0 - smoothstep(-aa, aa, length(g - c.xy) - c.z);
            unionCov = max(unionCov, cov);
            parity = softXor(parity, cov);
          }
          unionCov = max(unionCov, gridCov);
          parity = softXor(parity, gridCov);

          // uXor は円が残っている間だけ 1。円が無いとき両者は厳密に一致するので、
          // 切り替わりは見えない。
          float ink = clamp(mix(unionCov, parity, uXor), 0.0, 1.0);
          ink = softXor(ink, invertCov);

          if (uDebugView > 0.5) {
            vec2 f = abs(fract(g) - 0.5);
            float border = step(0.47, max(f.x, f.y));
            gl_FragColor = vec4(vec3(1.0 - ink) * (1.0 - border * 0.6) + vec3(0.0, border * 0.35, 0.0), 1.0);
            return;
          }

          // 背景がテーマの明色（Monochrome ではオフホワイト）、図形が暗色。
          vec3 col = mix(uThemeLight, uThemeDark, ink) + uThemeAccent * pow(ink, 4.0);
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `,
    });

    this.scene = new THREE.Scene();
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.scene.add(new THREE.Mesh(this.geometry, this.material));

    this.pipeline = new EffectPipeline(context.renderer, this.scene, this.camera, this.effects);
    this.syncGridUniforms();
  }

  // ------------------------------------------------------------------
  // 毎フレーム
  // ------------------------------------------------------------------

  update(elapsed: number): void {
    if (!this.context || !this.material) return;
    const audio = this.context.audioEngine.getParameters();
    const active = audio.active === 1;

    const delta =
      this.previousElapsed < 0 ? 0 : Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.05);
    this.previousElapsed = elapsed;

    this.material.uniforms.uActive!.value = active ? 1 : 0;

    // D5: 音がないときは進めない。無音は黒画面のまま、状態も凍る。
    if (active && delta > 0) {
      this.advance(audio, delta);
      this.writeCells();
      this.writeCircles();
      this.material.uniforms.uRadius!.value = this.radius;
      this.material.uniforms.uXor!.value = this.xor;
      this.material.uniforms.uSeed!.value = this.cycleSeed;
      this.material.uniforms.uFineKeep!.value = this.fineKeep;
    }

    this.pipeline?.update(audio, elapsed);
  }

  render(): void {
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    this.viewWidth = Math.max(width, 1);
    this.viewHeight = Math.max(height, 1);
    this.syncGridUniforms();
    this.pipeline?.resize(width, height);
  }

  // ------------------------------------------------------------------
  // 弧の進行
  // ------------------------------------------------------------------

  private advance(audio: AudioParameters, dt: number): void {
    const volume = clamp01(audio.volume);
    const bass = clamp01(audio.bass);
    const mid = clamp01(audio.mid);
    const treble = clamp01(audio.treble);
    const centroid = clamp01(audio.centroid);
    const flatness = clamp01(audio.flatness);
    const sustain = clamp01(audio.sustain);
    const onset = clamp01(audio.onset);
    if (typeof audio.seed === 'number') this.latestSeed = audio.seed;

    // 反応の調整（D24）: 帯域ゲインで音量を重み付けする。全部 1 なら素の音量。
    const bandTotal = bass + mid + treble;
    const weight =
      bandTotal > 1e-4
        ? (this.response.bass * bass + this.response.mid * mid + this.response.treble * treble) /
          bandTotal
        : 1;
    const drive = clamp01(volume * weight);

    // 高域側の「細かさ」。角丸量と細分化の進みを決める。
    const fine = clamp01(treble * 0.6 + centroid * 0.4);
    this.snapFine = fine;
    this.snapFlatness = flatness;
    this.snapMid = mid;
    this.snapBass = bass;
    // 連続量に使う分はならす（A: 必ず慣性を通す）。
    const toneK = 1 - Math.exp(-dt / MODULAR.toneSmooth);
    this.fineSmooth += (fine - this.fineSmooth) * toneK;
    this.bassSmooth += (bass - this.bassSmooth) * toneK;
    this.fineKeep = clamp(MODULAR.fineKeep - flatness * MODULAR.fineKeepFlatness, 0.35, 0.92);

    this.onsetCooldown = Math.max(0, this.onsetCooldown - dt);
    const hit = onset > 0.4 && this.onsetCooldown <= 0;
    if (hit) this.onsetCooldown = MODULAR.onsetCooldown;

    // 弧を進める。音は速さだけを変える（順序は変えない）。
    // 瞬間の音量ではなく数秒ならした値で決める。曲の谷ごとに止まると弧が読めなくなる。
    // 音が沈むと arcQuiet 倍まで落ちて停滞し、無音では advance 自体が呼ばれない（D5）。
    this.driveSmooth += (drive - this.driveSmooth) * (1 - Math.exp(-dt / MODULAR.arcSmooth));
    const loud = Math.pow(Math.max(this.driveSmooth / MODULAR.arcRef, 0), MODULAR.arcCurve);
    const rate = clamp(
      MODULAR.arcQuiet + (1 - MODULAR.arcQuiet) * loud,
      MODULAR.arcQuiet,
      MODULAR.arcRateMax,
    );
    this.arc += (dt * rate) / MODULAR.cycleSeconds;
    if (hit) this.arc += MODULAR.arcOnsetPush;
    if (this.arc >= 1) {
      this.beginCycle();
      return;
    }

    // ステージ境界を跨いだら順に入場する（飛ばさない）。
    let target = this.stageIndex;
    while (target < STAGES.length - 1 && this.arc >= STAGES[target]!.to) target++;
    while (this.stageIndex < target) this.enterStage(this.stageIndex + 1);

    // 黒面積の目標は arc だけで決まる。音量は一切混ぜない。
    // したがって音量を下げても目標は下がらず、浸食は起きない。
    this.coverTarget = this.targetCoverage(this.arc);
    this.coverage = this.estimateCoverage();
    const deficit = this.coverTarget - this.coverage;

    switch (this.phase) {
      case 'spawn':
        this.stepSpawn(dt, deficit);
        break;
      case 'expand':
        this.stepExpand(dt, deficit);
        break;
      case 'gridMorph':
        this.stepGridMorph(dt, deficit, sustain);
        break;
      case 'rowCascade':
        this.stepRowCascade(dt, hit);
        break;
      case 'merge':
        // ブロブ期に毎フレームやることはない。大きさは全体アーチが決める。
        break;
      case 'subdivide':
        this.stepSubdivide(dt, hit);
        break;
      case 'finalCluster':
        this.stepFinalCluster(dt, hit);
        break;
      case 'clear':
        this.stepClear(dt);
        break;
    }

    if (this.phase !== 'clear') this.stepDensity(dt, hit, deficit);

    // 角丸は arc の全体アーチ（連続量）。音はならした値でしか効かない。
    this.radiusTarget = this.radiusForArc(this.arc, this.fineSmooth, this.bassSmooth);
    this.radius += (this.radiusTarget - this.radius) * (1 - Math.exp(-MODULAR.radiusEase * dt));
    this.xor = this.circles.some((circle) => circle.on) ? 1 : 0;
    this.applyArchScale();
    this.easeCells(dt);
  }

  /** 現在ステージ内の進行度 0..1。 */
  private stageProgress(): number {
    const stage = STAGES[this.stageIndex]!;
    return clamp((this.arc - stage.from) / Math.max(stage.to - stage.from, 1e-6), 0, 1);
  }

  /**
   * 黒面積の目標。0 → 弧の 1/4 でピーク → 緩やかに漸減 → 最後の数 % で 0。
   * 参照の実測（ピーク 0.59 付近、以後ほぼ単調減少）に合わせてある。
   */
  private targetCoverage(arc: number): number {
    if (arc >= MODULAR.coverZeroArc) return 0;
    if (arc <= MODULAR.coverPeakArc) {
      return MODULAR.coverPeak * smoothstep(0, MODULAR.coverPeakArc, arc);
    }
    if (arc <= MODULAR.coverEndArc) {
      const t = (arc - MODULAR.coverPeakArc) / (MODULAR.coverEndArc - MODULAR.coverPeakArc);
      return (
        MODULAR.coverPeak + (MODULAR.coverEnd - MODULAR.coverPeak) * Math.pow(t, MODULAR.coverFall)
      );
    }
    const t = (arc - MODULAR.coverEndArc) / (MODULAR.coverZeroArc - MODULAR.coverEndArc);
    return MODULAR.coverEnd * (1 - t);
  }

  /**
   * 角丸量のアーチ。
   * 序盤は円（半径がモジュール半幅より大きい）→ 格子化で角丸ひかえめの矩形 →
   * 粗いブロックでほぼ直角 → ブロブ期に最大（セルがほぼ円・隣と首で融合）→
   * 細分化で締まり → 終盤は小セル半幅を上回らせて「小さな円」に戻す。
   */
  private radiusForArc(arc: number, fine: number, bass: number): number {
    const treble = MODULAR.radiusTreble * fine;
    const grid = MODULAR.radiusGrid + treble;
    const block = MODULAR.radiusBlock + treble;
    const blob = MODULAR.radiusBlob * (1 + MODULAR.radiusBass * bass * 0.15);
    const sub = MODULAR.radiusSub + treble;
    const final = MODULAR.radiusFinal + treble;
    if (arc < 0.14) return MODULAR.radiusOpen;
    if (arc < 0.22) return MODULAR.radiusOpen + (grid - MODULAR.radiusOpen) * smoothstep(0.14, 0.21, arc);
    if (arc < 0.34) return grid + (block - grid) * smoothstep(0.22, 0.3, arc);
    if (arc < 0.56) return block + (blob - block) * smoothstep(0.34, 0.44, arc);
    if (arc < 0.76) return blob + (sub - blob) * smoothstep(0.56, 0.63, arc);
    return sub + (final - sub) * smoothstep(0.76, 0.82, arc);
  }

  /**
   * 大きさの全体アーチ。生きているセルの大きさを動かしてよい唯一のもの（A）。
   * 弧だけの関数なので、音が急に変わっても大きさは跳ねない。
   */
  private scaleForArc(arc: number): number {
    if (arc < 0.22) return MODULAR.cellScale;
    if (arc < 0.34) {
      return MODULAR.cellScale + (MODULAR.blockScale - MODULAR.cellScale) * smoothstep(0.22, 0.3, arc);
    }
    if (arc < 0.56) {
      return MODULAR.blockScale + (MODULAR.blobScale - MODULAR.blockScale) * smoothstep(0.34, 0.44, arc);
    }
    if (arc < 0.76) {
      return MODULAR.blobScale + (MODULAR.subScale - MODULAR.blobScale) * smoothstep(0.56, 0.64, arc);
    }
    return MODULAR.subScale + (MODULAR.fineScale - MODULAR.subScale) * smoothstep(0.76, 0.84, arc);
  }

  /**
   * 誕生時に決まった大きさの偏りを、どれだけ効かせるか。
   * 格子化のころ階層がいちばんはっきりし、粗いブロック期は揃って 1 枚に繋がる。
   */
  private hierarchyForArc(arc: number): number {
    if (arc < 0.22) return 1;
    if (arc < 0.34) return 1 - 0.75 * smoothstep(0.22, 0.3, arc);
    if (arc < 0.56) return 0.25 + 0.35 * smoothstep(0.34, 0.46, arc);
    return 0.6;
  }

  /**
   * 生きているセルの目標寸法を「誕生時の偏り × 全体アーチ」で置き直す。
   * ここ以外で targetScale を書き換えないこと（消えかけの 0 を除く）。
   */
  private applyArchScale(): void {
    const arch = this.scaleForArc(this.arc);
    const weight = this.hierarchyForArc(this.arc);
    for (const cell of this.cells) {
      if (!cell.alive || cell.fadeTime >= 0) continue;
      cell.targetScale = clamp(arch * (1 + (cell.sizeBias - 1) * weight), 0.2, 1.4);
    }
  }

  // ------------------------------------------------------------------
  // ステージ入場
  // ------------------------------------------------------------------

  private enterStage(index: number): void {
    this.stageIndex = index;
    this.phase = STAGES[index]!.phase;
    switch (this.phase) {
      case 'gridMorph':
        this.prepareGridMorph();
        break;
      case 'rowCascade':
        this.buildCoarseBlocks();
        this.cascadeAdvance = 0;
        this.cascadeRow = 0;
        break;
      case 'merge':
        this.reformAll();
        break;
      case 'subdivide':
        this.fineChance = 0;
        this.reformAll();
        this.buildFlowers();
        this.cascadeAdvance = 0;
        this.cascadeRow = 0;
        break;
      case 'finalCluster':
        this.fineChance = MODULAR.finalFineChance;
        this.reformAll();
        this.buildFlowers();
        this.cascadeAdvance = 0;
        this.cascadeRow = 0;
        break;
      case 'clear':
        this.beginClear();
        break;
      default:
        break;
    }
  }

  /** 生きているセルすべてを、いまのステージの形へ組み直す。 */
  private reformAll(): void {
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i]!.alive) this.applyForm(i, false);
    }
  }

  /**
   * セル 1 つを、いまのステージの「形」にする。
   *
   * ここで扱うのは構造（細分化の段・マスク・回転の基準）だけで、大きさには触れない。
   * 大きさは誕生時に決まる偏り（sizeBias）と arc の全体アーチだけで決まる。
   */
  private applyForm(index: number, fresh: boolean): void {
    const cell = this.cells[index]!;
    const seed = this.cycleSeed;
    if (fresh) {
      cell.alive = true;
      cell.scale = 0;
      cell.invert = false;
      cell.doomed = false;
      cell.fadeTime = -1;
      cell.birthTime = 0;
      // 大きさの階層は「生まれる瞬間の低音」で決まり、以後この値は変わらない。
      cell.sizeBias = this.birthSizeBias(index);
    }
    cell.fine = false;
    cell.subdivided = false;
    cell.mask = 15;
    cell.targetSub = 1;
    const spin = Math.round(cell.rotation / (Math.PI * 2)) * Math.PI * 2;

    switch (this.phase) {
      case 'spawn':
      case 'expand':
      case 'gridMorph':
      case 'rowCascade':
      case 'merge':
        cell.targetRotation = spin;
        break;

      case 'subdivide':
      case 'finalCluster':
        cell.subdivided = true;
        cell.fine = hashKeys(seed, 52, index) < this.fineChance;
        cell.mask = this.subMask(index, this.phase === 'finalCluster' ? 58 : 50);
        cell.targetSub = MODULAR.subGap;
        cell.targetRotation = spin;
        cell.delay = hashKeys(seed, 65, index) * 0.22;
        break;

      case 'clear':
        break;
    }
  }

  /**
   * 誕生するセルの大きさの偏り（1 が標準）。低音が階層の幅を、
   * 高域が角丸寄り（＝やや小さめ）の傾向を決める。誕生時に 1 度だけ読む。
   */
  private birthSizeBias(index: number): number {
    const spread = MODULAR.sizeSpread * this.snapBass;
    const h = hashKeys(this.cycleSeed, 11, index);
    const tone = 1 - MODULAR.sizeTreble * this.snapFine;
    return clamp((1 - spread + 2 * spread * h) * tone, 0.55, 1.45);
  }

  /** 2×2 の欠け。ノイズ性が強いほど落ちるビットが増える。 */
  private subMask(index: number, salt: number): number {
    let mask = 15;
    const drops = Math.floor(
      hashKeys(this.cycleSeed, salt, index) * (1 + this.snapFlatness * MODULAR.flatnessDrop),
    );
    for (let d = 0; d < drops; d++) {
      const bit = Math.floor(hashKeys(this.cycleSeed, salt + 5, index, d) * 4);
      const next = mask & ~(1 << bit);
      if (next !== 0) mask = next;
    }
    return mask;
  }

  // ------------------------------------------------------------------
  // ステージごとの毎フレーム処理
  // ------------------------------------------------------------------

  /** 起点クラスタから円が 1 つずつ現れる。大きいものが先に出る。 */
  private stepSpawn(dt: number, deficit: number): void {
    for (const circle of this.circles) {
      if (!circle.done && !circle.on && this.arc >= circle.startArc) circle.on = true;
    }
    this.growCircles(dt, deficit);
  }

  /** 円が育つ。育つ速さは目標占有率との差で決まる（届いたら止まる）。 */
  private stepExpand(dt: number, deficit: number): void {
    this.stepSpawn(dt, deficit);
  }

  private growCircles(dt: number, deficit: number): void {
    if (deficit <= 0) return;
    // 円の育ちも連続量（A）。瞬間の音量ではなくならした値で決めるので、
    // 音が急に変わっても半径は跳ねない。
    const push = clamp(deficit * 8, 0, 1.5);
    const speed = MODULAR.growSpeed * (0.3 + this.driveSmooth) * push;
    for (const circle of this.circles) {
      if (!circle.on || circle.cell >= 0) continue;
      circle.r = Math.min(circle.r + dt * speed * circle.rate, circle.maxR);
    }
  }

  /**
   * 円 → 角丸四角。小さい円から順にセルへ落ち、大きい円はしばらく残って混在する
   * （参照の 3.4〜5.1s の状態）。落ちる直前だけセル中心へ吸い寄せられる。
   */
  private prepareGridMorph(): void {
    const taken = new Set<number>();
    for (const circle of this.circles) {
      if (!circle.on) continue;
      const cx = clamp(Math.floor(circle.x), 0, this.cols - 1);
      const cy = clamp(Math.floor(circle.y), 0, this.rows - 1);
      let index = cy * this.cols + cx;
      if (taken.has(index)) {
        let best = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < this.cols * this.rows; i++) {
          if (taken.has(i)) continue;
          const x = (i % this.cols) + 0.5;
          const y = Math.floor(i / this.cols) + 0.5;
          const distance = (x - circle.x) ** 2 + (y - circle.y) ** 2;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
          }
        }
        if (best < 0) continue;
        index = best;
      }
      taken.add(index);
      circle.cell = index;
      circle.fromX = circle.x;
      circle.fromY = circle.y;
      circle.fromR = circle.r;
      // 偏りはここで 1 度だけ決める（以後この値は変わらない = C）。
      circle.bias = this.birthSizeBias(index);
      this.reserved.add(index);
    }
  }

  private stepGridMorph(dt: number, deficit: number, sustain: number): void {
    // 持続が助走をわずかに速める。順序は変えない。
    const p = clamp(this.stageProgress() * (1 + MODULAR.alignSustain * sustain), 0, 1);
    for (const circle of this.circles) {
      if (!circle.on) continue;
      if (circle.cell < 0) {
        // 行き先が取れなかった円はそのまま消える（新しい像を汚さない）。
        if (p >= circle.convertAt) {
          circle.on = false;
          circle.done = true;
        }
        continue;
      }
      const lead = MODULAR.morphLead;
      const t = smoothstep(circle.convertAt - lead, circle.convertAt, p);
      const targetRadius = 0.5 * MODULAR.cellScale * circle.bias;
      const cx = (circle.cell % this.cols) + 0.5;
      const cy = Math.floor(circle.cell / this.cols) + 0.5;
      circle.x = circle.fromX + (cx - circle.fromX) * t;
      circle.y = circle.fromY + (cy - circle.fromY) * t;
      circle.r = circle.fromR + (targetRadius - circle.fromR) * t;
      if (p < circle.convertAt) continue;
      // 入れ替え: 円は消え、まったく同じ大きさ・位置のセルが立つ。
      // 半径が半幅より大きい間、セルは真円として描かれるので見た目は変わらない。
      const cell = this.cells[circle.cell]!;
      this.reserved.delete(circle.cell);
      if (!cell.alive) {
        this.applyForm(circle.cell, true);
        cell.sizeBias = circle.bias;
        // 円とまったく同じ寸法から始める。育つ演出は挟まない（既に育ち切っている）。
        cell.scale = MODULAR.cellScale * circle.bias;
        cell.birthTime = MODULAR.birthSeconds;
        cell.rotation = 0;
        cell.sub = 1;
        cell.delay = 0;
      }
      circle.on = false;
      circle.done = true;
    }
    // まだ落ちていない円は育ち続ける（円と格子の混在期）。
    this.growCircles(dt, deficit);
  }

  /**
   * 粗い 2×2 結合ブロックの市松モザイク。
   * 生きているセルが 2 枚以上あるブロックだけを立てるので、空間的に飛ばない。
   */
  private buildCoarseBlocks(): void {
    const seed = this.cycleSeed;
    this.singleTiles.clear();
    const bCols = Math.ceil(this.cols / 2);
    const bRows = Math.ceil(this.rows / 2);
    for (let by = 0; by < bRows; by++) {
      for (let bx = 0; bx < bCols; bx++) {
        const members: number[] = [];
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const x = bx * 2 + i;
            const y = by * 2 + j;
            if (x < this.cols && y < this.rows) members.push(y * this.cols + x);
          }
        }
        let aliveCount = 0;
        for (const index of members) if (this.cells[index]!.alive) aliveCount++;
        const parity = (bx + by) % 2;
        const h = hashKeys(seed, 20, bx, by);
        // 市松。例外を少し混ぜて機械的にしない。
        const wanted = parity === 0 ? h < MODULAR.blockOnEven : h < MODULAR.blockOnOdd;
        if (wanted && aliveCount >= 2) {
          for (const index of members) {
            if (this.cells[index]!.alive) this.applyForm(index, false);
            else if (!this.pendingBirths.includes(index)) this.pendingBirths.push(index);
          }
          continue;
        }
        // 落ちるブロック。密なところだけ 1 枚を単独タイルとして残す。
        // ここでは「いずれ落ちる」と印を付けるだけで、その場では消さない。
        // 実際に落ちるのは浸食スケジューラが 1 手ずつ縮めて消す（B の上限内）。
        const keepSingle =
          aliveCount >= 3 && hashKeys(seed, 21, bx, by) < MODULAR.singleTileChance;
        const keepAt = Math.floor(hashKeys(seed, 22, bx, by) * members.length);
        for (let k = 0; k < members.length; k++) {
          const index = members[k]!;
          if (!this.cells[index]!.alive) continue;
          if (keepSingle && k === keepAt) {
            this.singleTiles.add(index);
            this.applyForm(index, false);
            continue;
          }
          this.cells[index]!.doomed = true;
        }
      }
    }
  }

  /** 単独タイルにわずかな傾きを与えるウェーブ。オンセットで 1 行進む。 */
  private stepRowCascade(dt: number, hit: boolean): void {
    this.cascadeAdvance += dt / MODULAR.cascadeRowSeconds;
    if (hit) this.cascadeAdvance += 1;
    const reached = Math.floor(this.cascadeAdvance);
    while (this.cascadeRow < reached && this.cascadeRow < this.rows) {
      this.applyTiltRow(this.cascadeRow);
      this.cascadeRow++;
    }
  }

  private applyTiltRow(row: number): void {
    // row 0 が画面の上。DataTexture は下から並ぶので行番号を反転する。
    const y = this.rows - 1 - row;
    const flip = hashKeys(this.cycleSeed, 30, row) < MODULAR.cascadeInvert + this.snapFlatness * 0.25;
    for (let x = 0; x < this.cols; x++) {
      const index = y * this.cols + x;
      const cell = this.cells[index]!;
      if (!cell.alive) continue;
      if (this.singleTiles.has(index)) {
        const spin = hashKeys(this.cycleSeed, 31, index) < 0.5 ? 1 : -1;
        cell.targetRotation = spin * MODULAR.tiltAmount;
      }
      const local = hashKeys(this.cycleSeed, 32, index) < this.snapFlatness * 0.3;
      cell.invert = flip !== local;
      cell.delay = x * MODULAR.cascadeColDelay;
    }
  }

  /**
   * 細分化。ステージが進むほど 4×4 相当へ落ちるセルが増える。
   * 45°ダイヤ市松のパッチは、オンセットが押す回転ウェーブが行ごとに開いていく。
   */
  private stepSubdivide(dt: number, hit: boolean): void {
    const p = this.stageProgress();
    // 高域・重心が細分化を速める。しきいは上がるだけなので逆行しない。
    const advance = smoothstep(0.25, 0.95, p * (0.7 + 0.6 * this.snapFine));
    const wanted = advance * MODULAR.subFineChance;
    if (wanted > this.fineChance) {
      this.fineChance = wanted;
      for (let i = 0; i < this.cells.length; i++) {
        const cell = this.cells[i]!;
        if (!cell.alive || cell.fine || !cell.subdivided) continue;
        if (hashKeys(this.cycleSeed, 52, i) >= this.fineChance) continue;
        cell.fine = true;
      }
    }
    this.stepDiamondWave(dt, hit);
  }

  /** 微細クラスタ。島の縁から浸食されて縮む（浸食は密度制御が担う）。 */
  private stepFinalCluster(dt: number, hit: boolean): void {
    this.stepDiamondWave(dt, hit);
  }

  /** 45°ダイヤ化のウェーブ。行ごとに開き、オンセットで 1 行進む。 */
  private stepDiamondWave(dt: number, hit: boolean): void {
    this.cascadeAdvance += dt / MODULAR.cascadeRowSeconds;
    if (hit) this.cascadeAdvance += 1;
    const reached = Math.floor(this.cascadeAdvance);
    while (this.cascadeRow < reached && this.cascadeRow < this.rows) {
      this.applyDiamondRow(this.cascadeRow);
      this.cascadeRow++;
    }
  }

  private applyDiamondRow(row: number): void {
    const y = this.rows - 1 - row;
    for (let x = 0; x < this.cols; x++) {
      const index = y * this.cols + x;
      const cell = this.cells[index]!;
      if (!cell.alive || !cell.subdivided) continue;
      if (!this.inDiamondPatch(x, y)) continue;
      const spin = hashKeys(this.cycleSeed, 77, index) < 0.5 ? 1 : -1;
      const base = Math.round(cell.rotation / (Math.PI * 2)) * Math.PI * 2;
      cell.targetRotation = base + (spin * Math.PI) / 4;
      cell.delay = x * MODULAR.cascadeColDelay;
    }
  }

  /** シードで選ばれたパッチの内側か。内部市松が 45°回った「ダイヤ」になる。 */
  private inDiamondPatch(x: number, y: number): boolean {
    const px = x + 0.5;
    const py = y + 0.5;
    for (let p = 0; p < MODULAR.diamondPatches; p++) {
      const cx = hashKeys(this.cycleSeed, 74, p) * this.cols;
      const cy = hashKeys(this.cycleSeed, 75, p) * this.rows;
      const r = MODULAR.diamondRadius * (0.6 + hashKeys(this.cycleSeed, 76, p) * 0.9);
      if ((px - cx) ** 2 + (py - cy) ** 2 < r * r) return true;
    }
    return false;
  }

  /**
   * 4 セルで中央が抜ける花型を立てる。
   * 抜けは共有する角に接する小セルを落とすことで作る。
   */
  private buildFlowers(): void {
    const used = new Set<number>();
    const drop = [3, 2, 1, 0];
    for (let y = 0; y < this.rows - 1; y++) {
      for (let x = 0; x < this.cols - 1; x++) {
        const corner = [
          y * this.cols + x, //             左下 → 抜けるのは右上（ビット 3）
          y * this.cols + x + 1, //         右下 → 左上（ビット 2）
          (y + 1) * this.cols + x, //       左上 → 右下（ビット 1）
          (y + 1) * this.cols + x + 1, //   右上 → 左下（ビット 0）
        ];
        if (corner.some((index) => !this.cells[index]!.alive || used.has(index))) continue;
        if (hashKeys(this.cycleSeed, 70, x, y) >= MODULAR.flowerChance) continue;
        for (const index of corner) used.add(index);
        for (let k = 0; k < 4; k++) {
          const cell = this.cells[corner[k]!]!;
          cell.subdivided = true;
          cell.fine = false;
          cell.mask = 15 & ~(1 << drop[k]!);
          cell.targetSub = MODULAR.subGap;
          // 抜きの向きを揃えるため、回転はいちばん近い一周へ戻す。
          cell.targetRotation = Math.round(cell.rotation / (Math.PI * 2)) * Math.PI * 2;
          cell.invert = hashKeys(this.cycleSeed, 71, corner[k]!) < this.snapFlatness * 0.2;
          cell.delay = hashKeys(this.cycleSeed, 72, corner[k]!) * 0.3;
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 密度（成長前線と浸食）
  // ------------------------------------------------------------------

  /**
   * 黒面積を目標へ追従させる。ここが唯一の離散イベント発生源（B）。
   *
   * 目標は arc だけの関数なので、音量が下がっても目標は下がらない。
   * すなわち**静けさでは決して消えない**。浸食が起きるのは
   *   ・弧が前へ進んで目標面積そのものが下がったとき
   *   ・構造として落ちると決まったセル（doomed）が残っているとき
   * の 2 つだけで、どちらも 1 手ごとに最短間隔を守る。
   * 目標とのずれがどれだけ大きくても一気に間引かない。
   */
  private stepDensity(dt: number, hit: boolean, deficit: number): void {
    this.birthTimer = Math.max(0, this.birthTimer - dt);
    this.erodeTimer = Math.max(0, this.erodeTimer - dt);

    // ---- 誕生 ----
    const canGrow =
      this.stageIndex >= 2 && this.arc < MODULAR.growUntilArc && deficit > MODULAR.densitySlack;
    if (canGrow) {
      let quota = 0;
      if (hit) {
        quota = MODULAR.birthOnset;
      } else if (this.birthTimer <= 0) {
        quota =
          deficit > MODULAR.birthWideDeficit ? MODULAR.birthPerEventWide : MODULAR.birthPerEvent;
      }
      if (quota > 0) {
        for (let n = 0; n < quota; n++) if (!this.growOne()) break;
        this.birthTimer = MODULAR.birthInterval;
      }
    }

    // ---- 浸食 ----
    if (this.erodeTimer > 0) return;
    // 構造上落ちると決まったセルが先。次に、弧が進んで目標を超えた分。
    const shrink = deficit < -MODULAR.densitySlack && this.arc >= MODULAR.coverPeakArc;
    if (!this.hasDoomed() && !shrink) return;
    if (this.erodeOne()) this.erodeTimer = MODULAR.erodeInterval;
  }

  private hasDoomed(): boolean {
    for (const cell of this.cells) {
      if (cell.alive && cell.doomed && cell.fadeTime < 0) return true;
    }
    return false;
  }

  /**
   * 成長前線を 1 セル進める。起点からの距離順（ゆらぎ入り）に広がる。
   * 中域が高いほど先を数手ぶん見て、既にあるかたまりと接する位置を選ぶ（接続しやすさ）。
   */
  private growOne(): boolean {
    // 構造上生まれると決まったセルが先。ここも 1 手 1 セルで通す。
    while (this.pendingBirths.length > 0) {
      const index = this.pendingBirths.shift()!;
      const cell = this.cells[index]!;
      if (cell.alive) continue;
      this.applyForm(index, true);
      cell.delay = 0;
      return true;
    }
    const look = 1 + Math.round(MODULAR.connectLookahead * this.snapMid);
    let bestIndex = -1;
    let bestCursor = -1;
    let bestContact = -1;
    let cursor = this.growCursor;
    let seen = 0;
    while (cursor < this.growOrder.length && seen < look) {
      const index = this.growOrder[cursor]!;
      const cell = this.cells[index]!;
      if (cell.alive || this.reserved.has(index)) {
        cursor++;
        continue;
      }
      seen++;
      const contact = 4 - this.deadNeighbourCount(index % this.cols, Math.floor(index / this.cols));
      if (contact > bestContact) {
        bestContact = contact;
        bestIndex = index;
        bestCursor = cursor;
      }
      cursor++;
    }
    if (bestIndex < 0) {
      this.growCursor = this.growOrder.length;
      return false;
    }
    // 選ばなかった前の候補は次の手に回す（前線の順序そのものは崩さない）。
    if (bestCursor === this.growCursor) this.growCursor++;
    else this.growOrder.splice(bestCursor, 1);
    this.applyForm(bestIndex, true);
    this.cells[bestIndex]!.delay = 0;
    return true;
  }

  /** 島の縁を 1 セル削る。落ちると決まったセルが先、次に露出の大きいセル。 */
  private erodeOne(): boolean {
    let best = -1;
    let bestKey = Number.POSITIVE_INFINITY;
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const index = y * this.cols + x;
        const cell = this.cells[index]!;
        if (!cell.alive || cell.fadeTime >= 0) continue;
        const exposed = this.deadNeighbourCount(x, y);
        if (exposed === 0 && !cell.doomed) continue;
        // 露出が大きいほど小さいキーになり、先に落ちる。順序はシード由来。
        const key =
          hashKeys(this.cycleSeed, 85, index) - exposed * 0.22 - (cell.doomed ? 10 : 0);
        if (key < bestKey) {
          bestKey = key;
          best = index;
        }
      }
    }
    if (best < 0) return false;
    this.beginFade(best);
    return true;
  }

  /** 上下左右のうち、死んでいる（または場の外の）隣の数。 */
  private deadNeighbourCount(x: number, y: number): number {
    let count = 0;
    const offsets = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const [dx, dy] of offsets) {
      const nx = x + dx!;
      const ny = y + dy!;
      if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) {
        count++;
        continue;
      }
      if (!this.cells[ny * this.cols + nx]!.alive) count++;
    }
    return count;
  }

  /** 浸食で消す。ポップ消しにはせず fadeSeconds かけて縮んで消える。 */
  private beginFade(index: number): void {
    const cell = this.cells[index]!;
    if (cell.fadeTime >= 0) return;
    cell.fadeTime = 0;
    cell.fadeFrom = cell.scale;
    cell.targetScale = 0;
    cell.delay = 0;
  }

  /** 即座に消す。最終 clear のバーストだけがこれを使ってよい。 */
  private killCell(index: number): void {
    const cell = this.cells[index]!;
    cell.alive = false;
    cell.scale = 0;
    cell.targetScale = 0;
    cell.invert = false;
    cell.delay = 0;
    cell.doomed = false;
    cell.fadeTime = -1;
    this.singleTiles.delete(index);
  }

  /**
   * 黒面積の見積もり。制御のための概算なので厳密でなくてよい。
   * 円は重なりがあるので Boolean モデル（1 - exp(-面積)）で飽和させる。
   */
  private estimateCoverage(): number {
    const area = this.cols * this.rows;
    let circleArea = 0;
    for (const circle of this.circles) {
      if (circle.on) circleArea += Math.PI * circle.r * circle.r;
    }
    let cellArea = 0;
    for (const cell of this.cells) {
      if (cell.alive) cellArea += this.cellArea(cell);
    }
    const circleCov = 1 - Math.exp(-circleArea / area);
    const cellCov = clamp(cellArea / area, 0, 1);
    return clamp(1 - (1 - circleCov) * (1 - cellCov), 0, 1);
  }

  /** セル 1 つが塗る面積（セル面積 = 1 の単位）。角丸ぶんは差し引く。 */
  private cellArea(cell: Cell): number {
    const s = clamp(cell.scale, 0, 1.2);
    if (s <= 0) return 0;
    const r = this.radius;
    const partArea = (half: number): number => {
      if (half <= 0) return 0;
      if (half <= r) return Math.PI * half * half;
      return 4 * half * half - (4 - Math.PI) * r * r;
    };
    if (!cell.subdivided) return partArea(0.5 * s);
    let bits = 0;
    for (let k = 0; k < 4; k++) if (cell.mask & (1 << k)) bits++;
    const sub = clamp(cell.sub, 0, 1);
    if (!cell.fine) return partArea(0.25 * s * sub) * bits;
    return partArea(0.125 * s * sub) * bits * 4 * this.fineKeep;
  }

  // ------------------------------------------------------------------
  // 片付けとサイクル
  // ------------------------------------------------------------------

  private beginClear(): void {
    for (const circle of this.circles) {
      circle.on = false;
      circle.done = true;
    }
    this.clearOrder = seededOrder(this.cells.length, this.cycleSeed, 80);
    this.clearCursor = 0;
    this.clearTime = 0;
  }

  /** 残った島をセル単位でパッと消す。フェードはしない。順序はシード由来。 */
  private stepClear(dt: number): void {
    this.clearTime += dt;
    const perStep = Math.max(1, Math.ceil(this.cells.length / MODULAR.clearGroups));
    while (this.clearTime >= MODULAR.clearStep && this.clearCursor < this.clearOrder.length) {
      this.clearTime -= MODULAR.clearStep;
      for (let n = 0; n < perStep && this.clearCursor < this.clearOrder.length; n++) {
        this.killCell(this.clearOrder[this.clearCursor++]!);
      }
    }
  }

  /**
   * 目標へ寄せる。行ごとの待ち時間がウェーブを作る。
   * 誕生は 0 → 定寸へ birthSeconds、浸食は縮んで消えるのに fadeSeconds をかける。
   * どちらも時間で決め打ちなので、音が何をしてもこの尺は変わらない。
   */
  private easeCells(dt: number): void {
    const k = 1 - Math.exp(-MODULAR.easeSpeed * dt);
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i]!;
      if (!cell.alive) continue;

      if (cell.fadeTime >= 0) {
        cell.fadeTime += dt;
        const t = clamp(cell.fadeTime / MODULAR.fadeSeconds, 0, 1);
        cell.scale = cell.fadeFrom * (1 - smoothstep(0, 1, t));
        if (t >= 1) this.killCell(i);
        continue;
      }

      if (cell.delay > 0) {
        cell.delay -= dt;
        continue;
      }

      if (cell.birthTime < MODULAR.birthSeconds) {
        cell.birthTime += dt;
        const t = clamp(cell.birthTime / MODULAR.birthSeconds, 0, 1);
        cell.scale = cell.targetScale * smoothstep(0, 1, t);
      } else {
        cell.scale += (cell.targetScale - cell.scale) * k;
      }
      cell.rotation += (cell.targetRotation - cell.rotation) * k;
      cell.sub += (cell.targetSub - cell.sub) * k;
    }
  }

  /**
   * 新しいシードで弧を最初から始める。
   *
   * シードは音のシード（オンセット時のスペクトル形状のハッシュ）だけから作る。
   * 何周目かは混ぜない。混ぜると同じ音から違う像が出て再現性が壊れる（PRD §3.1）。
   * 実際の曲ではオンセットごとにシードが引き直されるので、周ごとの像は自然に変わる。
   */
  private beginCycle(): void {
    this.cycleSeed = hashKeys(this.latestSeed, 99);
    for (const cell of this.cells) {
      cell.alive = false;
      cell.scale = 0;
      cell.targetScale = 0;
      cell.sizeBias = 1;
      cell.birthTime = 0;
      cell.fadeTime = -1;
      cell.fadeFrom = 0;
      cell.doomed = false;
      cell.rotation = 0;
      cell.targetRotation = 0;
      cell.sub = 1;
      cell.targetSub = 1;
      cell.invert = false;
      cell.mask = 15;
      cell.subdivided = false;
      cell.fine = false;
      cell.delay = 0;
    }
    this.singleTiles.clear();
    this.reserved.clear();
    this.pendingBirths = [];
    // 起点は 1 点。円も成長前線もここから広がる（一様散布はしない）。
    this.originX = 0.5 + hashKeys(this.cycleSeed, 7) * (this.cols - 1);
    this.originY = 0.5 + hashKeys(this.cycleSeed, 8) * (this.rows - 1);
    this.buildGrowOrder();
    this.circles = this.createCircles();
    this.arc = 0;
    this.stageIndex = 0;
    this.phase = 'spawn';
    this.growCursor = 0;
    this.birthTimer = 0;
    this.erodeTimer = 0;
    this.cascadeAdvance = 0;
    this.cascadeRow = 0;
    this.fineChance = 0;
    this.coverage = 0;
    this.coverTarget = 0;
    this.radius = MODULAR.radiusOpen;
    this.radiusTarget = MODULAR.radiusOpen;
    this.xor = 1;
  }

  /**
   * 成長前線の順序。起点からの距離にシード由来のゆらぎを足して並べる。
   * 距離順に前線が進むので、出現は必ず既にあるかたまりの縁から続く。
   */
  private buildGrowOrder(): void {
    const scored: { index: number; cost: number }[] = [];
    for (let i = 0; i < this.cells.length; i++) {
      const x = (i % this.cols) + 0.5;
      const y = Math.floor(i / this.cols) + 0.5;
      const distance = Math.hypot(x - this.originX, y - this.originY);
      const jitter = (hashKeys(this.cycleSeed, 90, i) - 0.5) * MODULAR.frontJitter;
      scored.push({ index: i, cost: distance + jitter });
    }
    scored.sort((a, b) => a.cost - b.cost);
    this.growOrder = scored.map((entry) => entry.index);
  }

  /**
   * 円の個数・位置・大きさをシードから決める。毎フレームの再抽選はしない。
   * サイズは大 2 / 中 5 / 小 残り の階層を持ち、すべて起点クラスタから広がる。
   */
  private createCircles(): Circle[] {
    const seed = this.cycleSeed;
    const circles: Circle[] = [];
    const total = MODULAR.circleCount;
    for (let i = 0; i < total; i++) {
      const tier =
        i < MODULAR.circleLarge ? 0 : i < MODULAR.circleLarge + MODULAR.circleMedium ? 1 : 2;
      const minR =
        tier === 0 ? MODULAR.largeMinR : tier === 1 ? MODULAR.mediumMinR : MODULAR.smallMinR;
      const spanR =
        tier === 0 ? MODULAR.largeSpanR : tier === 1 ? MODULAR.mediumSpanR : MODULAR.smallSpanR;
      // 起点からの広がり。後から出る円ほど外側に置く（1 点からの増殖に見える）。
      const angle = hashKeys(seed, 3, i) * Math.PI * 2;
      const spread =
        MODULAR.clusterSpread *
        Math.sqrt((i + 0.6) / total) *
        (0.55 + hashKeys(seed, 4, i) * 0.9);
      const x = clamp(this.originX + Math.cos(angle) * spread, 0.3, this.cols - 0.3);
      const y = clamp(this.originY + Math.sin(angle) * spread, 0.3, this.rows - 0.3);
      circles.push({
        x,
        y,
        r: 0,
        fromX: x,
        fromY: y,
        fromR: 0,
        maxR: minR + hashKeys(seed, 5, i) * spanR,
        rate: 1 - MODULAR.growSpread * 0.5 + hashKeys(seed, 6, i) * MODULAR.growSpread,
        // 大きいものから先に現れる。
        startArc:
          MODULAR.spawnSpanArc * clamp(tier * 0.28 + hashKeys(seed, 9, i) * 0.38, 0, 1),
        // 小さいものから先に格子へ落ちる（大きい円は混在期に残る）。
        convertAt: clamp(0.12 + (2 - tier) * 0.28 + hashKeys(seed, 10, i) * 0.18, 0.05, 0.96),
        bias: 1,
        cell: -1,
        on: false,
        done: false,
      });
    }
    return circles;
  }

  // ------------------------------------------------------------------
  // GPU への書き出し
  // ------------------------------------------------------------------

  private rebuildGrid(): void {
    const grid = gridForRatio(this.aspectRatio);
    this.cols = grid.cols;
    this.rows = grid.rows;
    this.cells = [];
    for (let i = 0; i < this.cols * this.rows; i++) {
      this.cells.push({
        alive: false,
        scale: 0,
        targetScale: 0,
        sizeBias: 1,
        birthTime: 0,
        fadeTime: -1,
        fadeFrom: 0,
        doomed: false,
        rotation: 0,
        targetRotation: 0,
        sub: 1,
        targetSub: 1,
        invert: false,
        mask: 15,
        subdivided: false,
        fine: false,
        delay: 0,
      });
    }
    this.cellData = new Uint8Array(this.cols * this.rows * 4);
    this.cellTexture?.dispose();
    this.cellTexture = new THREE.DataTexture(this.cellData, this.cols, this.rows);
    this.cellTexture.minFilter = THREE.NearestFilter;
    this.cellTexture.magFilter = THREE.NearestFilter;
    this.cellTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.cellTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.cellTexture.needsUpdate = true;
    this.beginCycle();
    this.writeCells();
    this.syncGridUniforms();
  }

  private syncGridUniforms(): void {
    if (!this.material) return;
    (this.material.uniforms.uGrid!.value as THREE.Vector2).set(this.cols, this.rows);
    // 1 ピクセルが g 空間でどれだけかを渡す（アンチエイリアスの幅）。
    // fwidth は WebGL1 では拡張が要るため使わない。
    (this.material.uniforms.uPixel!.value as THREE.Vector2).set(
      this.cols / this.viewWidth,
      this.rows / this.viewHeight,
    );
    this.material.uniforms.tCells!.value = this.cellTexture;
    this.material.uniforms.uRadius!.value = this.radius;
    this.material.uniforms.uXor!.value = this.xor;
    this.material.uniforms.uSeed!.value = this.cycleSeed;
    this.material.uniforms.uFineKeep!.value = this.fineKeep;
  }

  /** セル状態を RGBA8 へ詰める。R=大きさ / G=回転 / B=小セルの詰まり / A=旗とマスク。 */
  private writeCells(): void {
    const data = this.cellData;
    const twoPi = Math.PI * 2;
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i]!;
      const offset = i * 4;
      data[offset] = Math.round(clamp(cell.scale / 1.5, 0, 1) * 255);
      const rotation = ((cell.rotation % twoPi) + twoPi) % twoPi;
      data[offset + 1] = Math.round((rotation / twoPi) * 255);
      data[offset + 2] = Math.round(clamp(cell.sub, 0, 1) * 255);
      data[offset + 3] =
        (cell.mask & 15) +
        (cell.invert ? 16 : 0) +
        (cell.subdivided ? 32 : 0) +
        (cell.alive ? 64 : 0) +
        (cell.fine ? 128 : 0);
    }
    if (this.cellTexture) this.cellTexture.needsUpdate = true;
  }

  private writeCircles(): void {
    for (let i = 0; i < CIRCLE_SLOTS; i++) {
      const circle = this.circles[i];
      const uniform = this.circleUniform[i]!;
      if (!circle || !circle.on) {
        uniform.set(0, 0, 0, 0);
        continue;
      }
      uniform.set(circle.x, circle.y, circle.r, 1);
    }
  }

  // ------------------------------------------------------------------
  // LabExpression
  // ------------------------------------------------------------------

  getEffects(): readonly Effect[] {
    return this.effects;
  }

  moveEffect(effect: Effect, direction: -1 | 1): void {
    this.pipeline?.move(effect, direction);
  }

  setEffectOrder(names: string[]): void {
    this.pipeline?.setOrder(names);
  }

  getTheme(): Theme {
    return this.theme;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    if (!this.material) return;
    (this.material.uniforms.uThemeDark!.value as THREE.Vector3).set(...theme.dark);
    (this.material.uniforms.uThemeLight!.value as THREE.Vector3).set(...theme.light);
    (this.material.uniforms.uThemeAccent!.value as THREE.Vector3).set(...theme.accent);
  }

  getZoom(): number {
    return this.zoom;
  }

  /** ズームは開発用（D17）。板そのものを拡大縮小するだけ。 */
  setZoom(zoom: number): void {
    this.zoom = clamp(zoom, 0.25, 8);
    if (this.material) this.material.uniforms.uZoom!.value = this.zoom;
  }

  getResponse(): { bass: number; mid: number; treble: number } {
    return { ...this.response };
  }

  setResponse(gains: Partial<{ bass: number; mid: number; treble: number }>): void {
    const pick = (value: number | undefined, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 2) : fallback;
    this.response = {
      bass: pick(gains.bass, this.response.bass),
      mid: pick(gains.mid, this.response.mid),
      treble: pick(gains.treble, this.response.treble),
    };
  }

  getAspectId(): string {
    return this.aspectId;
  }

  getAspectRatio(): number {
    return this.aspectRatio;
  }

  /** 画角（D26）。列数・行数を比率で割り振り、セルは正方形を保つ。 */
  setAspect(id: string, ratio: number): void {
    if (id === this.aspectId) return;
    this.aspectId = id;
    this.aspectRatio = clamp(ratio, 0.25, 4);
    this.rebuildGrid();
  }

  /** 開発用: 0=最終 1=セル境界と図形の反転表示。 */
  setDebugView(view: number): void {
    this.debugView = view;
    if (this.material) this.material.uniforms.uDebugView!.value = view;
  }

  /** モード励起はサイマティクス固有の機構。この表現は持たない。 */
  getDebugState(): null {
    return null;
  }

  /** 奥行きは持たない（D25）。機能面だけ満たす。 */
  getDepth(): number {
    return 0;
  }

  setDepth(): void {
    // 奥行きなし。
  }

  /** 開発用: フェーズ名と弧の進行度（DebugPanel が表示する）。 */
  getPhase(): string {
    const alive = this.cells.reduce((count, cell) => count + (cell.alive ? 1 : 0), 0);
    return (
      `${this.phase} arc=${this.arc.toFixed(3)} ` +
      `cov=${this.coverage.toFixed(2)}/${this.coverTarget.toFixed(2)} ` +
      `cells=${alive}/${this.cells.length} r=${this.radius.toFixed(2)}`
    );
  }

  /** 開発用: 弧の進行度そのもの（実時間との対応を見るため）。 */
  getArc(): number {
    return this.arc;
  }

  /** 新しいシードで弧を最初からやり直す。 */
  restartCycle(): void {
    this.latestSeed = this.context?.audioEngine.getParameters().seed ?? this.latestSeed;
    this.beginCycle();
  }

  setGeneratorsVisible(): void {
    // 表現の表示切り替えは存在しない。
  }

  setDesignLayerCanvases(canvases: DesignLayerCanvases): void {
    this.pipeline?.setOverlayCanvases(canvases);
  }

  updateDesignLayerCanvases(): void {
    this.pipeline?.updateOverlayCanvases();
  }

  dispose(): void {
    this.pipeline?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.cellTexture?.dispose();
    this.pipeline = null;
    this.geometry = null;
    this.material = null;
    this.cellTexture = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
  }
}
