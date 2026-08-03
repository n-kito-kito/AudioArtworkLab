import type { Composition } from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import type { ModeExciterState } from '../engine/modeBank';
import type { Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';

/**
 * 表現（Expression）の共通面。
 *
 * UI 層（LabControls / LabPreset / TuningPanel / DebugPanel / main）は
 * サイマティクスの実装クラスではなくこの面に対して書く。サイマティクス以外の
 * 表現ファミリーを足すときに UI を書き換えずに済ませるためである。
 *
 * ここに載せるのは「UI が触る面」だけで、表現の内部（場・シミュレーション）は含めない。
 * 表現ごとに持つ調整機能は異なる（PRD D25）ため、全表現が持てないものは
 * オプショナルにするか、値を持たないことを表せる戻り値型にする。
 */
/**
 * 表現ごとの調整つまみ 1 本ぶんの宣言（PRD D25）。
 * どのつまみを持つかは表現が決め、UI は宣言されたものだけを並べる。
 *
 * 種別は `type` で分かれる。**`type` を省略した宣言は number として扱う**ため、
 * 既存表現（Light Traces）の宣言はそのまま同じスライダーとして描かれる。
 */
export interface ExpressionParamBase {
  readonly key: string;
  readonly label: string;
  /**
   * **UI のまとまり（アコーディオンの見出し）。**
   * 省略した宣言は今までどおり並び順のまま平らに描かれる。
   */
  readonly group?: string;
  /**
   * **詳細か。** true は既定で折りたたまれた中に入る。
   * 「常に見えるのは代表だけ、細かいものは開いたときだけ」を UI へ伝えるための印で、
   * **つまみ自体が消えるわけではない**（到達できる見え方は減らない）。
   */
  readonly detail?: boolean;
}

/**
 * **スライダーに添える音のソース。**
 *
 * 行を増やさずに「このつまみを音へ繋ぐ」ためのもの。未選択なら見た目はほぼ変わらず、
 * 選んだときだけ深さ（−1〜1）が現れる。解決式と変換の自動挿入は結線の機構をそのまま使う。
 */
export interface ExpressionParamSource {
  readonly paramId: string;
  readonly sourceId: string | null;
  readonly depth: number;
  readonly sources: readonly { readonly id: string; readonly label: string; readonly kind: string }[];
  /** 動作中の実効値。基準の周りで揺れているのを見せる。 */
  readonly liveValue: number;
}

/** 連続値のつまみ。省略時の既定であり、UI はスライダーを出す。 */
export interface ExpressionNumberParam extends ExpressionParamBase {
  readonly type?: 'number';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  /** 音へ繋げるつまみだけが持つ。持たないものは今までどおりのスライダー。 */
  readonly bind?: ExpressionParamSource;
}

export interface ExpressionSelectOption {
  readonly value: string;
  readonly label: string;
}

/** 排他の選択肢。UI は select を出し、選ばれた value を文字列で返す。 */
export interface ExpressionSelectParam extends ExpressionParamBase {
  readonly type: 'select';
  /** 選択肢が少なく、頻繁に切り替える場合はボタン群として表示する。 */
  readonly presentation?: 'select' | 'buttons';
  readonly options: readonly ExpressionSelectOption[];
  readonly value: string;
}

/**
 * 押した瞬間だけ意味を持つ操作。UI はボタンを出し、
 * 押されたら `setExpressionParam(key, 1)` を呼ぶ（値に意味はない）。
 */
export interface ExpressionActionParam extends ExpressionParamBase {
  readonly type: 'action';
}

/**
 * **音 × パラメーターの結線（1 本ぶん）。**
 *
 * 「触る場所」と「繋ぐ場所」を分けないための型。UI は基準値スライダーの**そこに**
 * ソース選択・深さ・変換を直付けし、動作中の実効値も同じスライダーの上で見せる。
 */
export interface ExpressionBindingParam extends ExpressionParamBase {
  readonly type: 'binding';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** 基準値（ユーザーのスライダー位置）。結線していても生きている。 */
  readonly value: number;
  /** 繋いでいるソース（`null` で「なし」）。 */
  readonly sourceId: string | null;
  readonly depth: number;
  /** 選べるソース。`kind` は表示に使う。 */
  readonly sources: readonly { readonly id: string; readonly label: string; readonly kind: string }[];
  /** 変換の表示名（自動挿入されたものも含む）と選択肢。 */
  readonly transform: string;
  readonly transformOptions: readonly ExpressionSelectOption[];
  /** 動作中の実効値と、変換後の信号（0〜1）。スライダーの上に重ねて見せる。 */
  readonly liveValue: number;
  readonly liveSignal: number;
}

export type ExpressionParam =
  | ExpressionNumberParam
  | ExpressionSelectParam
  | ExpressionActionParam
  | ExpressionBindingParam;

export interface LabExpression extends Composition {
  /** 表現の安定 id（保存データに入る）。 */
  readonly id: ExpressionId;

  // ---- Effect チェーン（③）----
  getEffects(): readonly Effect[];
  moveEffect(effect: Effect, direction: -1 | 1): void;
  setEffectOrder(names: string[]): void;

  // ---- 色のテーマ ----
  getTheme(): Theme;
  setTheme(theme: Theme): void;

  /**
   * テーマ色を実際に使うか（PRD D25: 持つ調整機能は表現ごとに宣言する）。
   *
   * 黒背景固定などでテーマを無視する表現は false を返す。UI は効かないセレクトを
   * 並べないためだけにこれを見る。**未実装は true 扱い**なので、既存表現の
   * 挙動は変わらない。テーマの保持そのもの（get/setTheme）は全表現が持ち続ける。
   */
  usesTheme?(): boolean;

  /** ズームは開発用（PRD D17）。本番 UI には出さず、プリセットにも効かせない。 */
  getZoom(): number;
  setZoom(zoom: number): void;

  /** 反応の調整（PRD D24 / D26）: 帯域ごとの励振ゲイン。 */
  getResponse(): { bass: number; mid: number; treble: number };
  setResponse(gains: Partial<{ bass: number; mid: number; treble: number }>): void;

  /** 画角（PRD D26）。切り取りではなく、描画される板そのものの比率。 */
  getAspectId(): string;
  getAspectRatio(): number;
  setAspect(id: string, ratio: number): void;

  /** 開発用の可視化切り替え（?debug=1）。表現ごとに意味は異なってよい。 */
  setDebugView(view: number): void;

  /**
   * 開発用の内部状態。モード励起はサイマティクス固有の機構なので、
   * それを持たない表現は null を返す。読む側は null を前提に書くこと。
   */
  getDebugState(): ModeExciterState | null;

  /** 奥行き（D6）。サイマティクスは UI に出していないが機能は温存している。 */
  getDepth(): number;
  setDepth(amount: number): void;

  /** 開発用: 表現が周期や段階を持つ場合の現在フェーズ名。持たない表現は実装しない。 */
  getPhase?(): string;

  /** 開発用: 周期を最初からやり直す。周期を持たない表現は実装しない。 */
  restartCycle?(): void;

  /**
   * 表現ごとの調整つまみ（PRD D25）。持たない表現は実装しない。
   * 「像そのものを決める値」ではなく、見え方の幅を運転するつまみだけを載せる。
   */
  getExpressionParams?(): ExpressionParam[];

  /**
   * 上で宣言したつまみの更新。実行中に効き、シミュレーションは再起動しない。
   * number は数値、select は選択肢の value（文字列）、action は 1 が渡る。
   */
  setExpressionParam?(key: string, value: number | string): void;
}
