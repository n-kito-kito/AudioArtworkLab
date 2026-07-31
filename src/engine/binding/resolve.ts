import type { AudioSource, Binding, ParamDecl, Transform } from './types';

/**
 * **結線の解決器。**
 *
 * 契約どおり `value = clamp(base + depth × signal × (max − min), min, max)` を計算する。
 * 変換のうち `envelope` だけは状態（いまどこまで減衰したか）を持つので、
 * パラメーターごとに 1 つずつここで抱える。
 *
 * **時間は呼び出し側から渡す**（`deltaSeconds`）。`Date.now()` も `performance.now()` も
 * 読まないので、同じ入力列なら必ず同じ出力列になる（決定論）。
 */

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const clamp01 = (value: number): number => clamp(value, 0, 1);

/** 変換を通したあとの信号（0〜1）。envelope の状態は `states` が持つ。 */
const applyTransform = (
  transform: Transform | null,
  raw: number,
  state: { value: number },
  deltaSeconds: number,
): number => {
  const input = clamp01(raw);
  if (!transform) return input;
  if (transform.type === 'gate') {
    return input >= transform.threshold ? input : 0;
  }
  // 立ち上がりは attack、落ちるときは decay。どちらも dt ベースなので
  // フレームレートが変わっても同じ時間で同じところへ着く。
  const tau = input > state.value ? transform.attack : transform.decay;
  if (tau <= 0) {
    state.value = input;
    return state.value;
  }
  const alpha = 1 - Math.exp(-Math.max(deltaSeconds, 0) / tau);
  state.value = state.value + (input - state.value) * alpha;
  return clamp01(state.value);
};

export interface ResolvedParam {
  /** 解決式が出した最終値。 */
  readonly value: number;
  /** 変換を通したあとの信号（0〜1）。UI で「いま音がどれだけ来ているか」を見せる。 */
  readonly signal: number;
  /** 使った基準値。UI がスライダーの位置に使う。 */
  readonly base: number;
}

/**
 * 宣言・結線・ソースを束ねて値を出す。
 * **表現はこの器を 1 つ持つだけ**で、結線の作法を知らなくてよい。
 */
export class BindingResolver {
  private readonly decls = new Map<string, ParamDecl>();
  private readonly bases = new Map<string, number>();
  private readonly bindings = new Map<string, Binding>();
  private readonly sources = new Map<string, AudioSource>();
  /** envelope の状態。パラメーターごとに 1 つ。 */
  private readonly envelopes = new Map<string, { value: number }>();
  private readonly resolved = new Map<string, ResolvedParam>();

  /** 宣言を差し替える。基準値は宣言の `default` から始まる。 */
  declare(decls: readonly ParamDecl[]): void {
    this.decls.clear();
    for (const decl of decls) {
      this.decls.set(decl.id, decl);
      if (!this.bases.has(decl.id)) this.bases.set(decl.id, decl.default);
    }
  }

  /** 選べるソースの棚を差し替える。 */
  setSources(sources: readonly AudioSource[]): void {
    this.sources.clear();
    for (const source of sources) this.sources.set(source.id, source);
  }

  listDecls(): readonly ParamDecl[] {
    return [...this.decls.values()];
  }

  listSources(): readonly AudioSource[] {
    return [...this.sources.values()];
  }

  getBinding(paramId: string): Binding | null {
    return this.bindings.get(paramId) ?? null;
  }

  /** 結線を張る / 張り替える。`sourceId` が `null` なら外す。 */
  bind(binding: Binding): void {
    if (binding.sourceId === null) {
      this.bindings.delete(binding.paramId);
      this.envelopes.delete(binding.paramId);
      return;
    }
    this.bindings.set(binding.paramId, binding);
    if (!this.envelopes.has(binding.paramId)) {
      this.envelopes.set(binding.paramId, { value: 0 });
    }
  }

  getBase(paramId: string): number {
    const decl = this.decls.get(paramId);
    return this.bases.get(paramId) ?? decl?.default ?? 0;
  }

  /** 基準値スライダー。**結線していても生きている。** */
  setBase(paramId: string, base: number): void {
    const decl = this.decls.get(paramId);
    if (!decl) return;
    this.bases.set(paramId, clamp(base, decl.min, decl.max));
  }

  /** 全部の envelope 状態を捨てる。表現を開き直すときに呼ぶ。 */
  reset(): void {
    for (const state of this.envelopes.values()) state.value = 0;
    this.resolved.clear();
  }

  /** 1 フレーム進めて全パラメーターを解決する。 */
  update(deltaSeconds: number): void {
    for (const decl of this.decls.values()) this.updateParam(decl.id, deltaSeconds);
  }

  /**
   * **1 つのパラメーターだけ解決する。**
   *
   * 表現によっては「この値はこの順番で要る」という時間の都合があるので
   * （例: 場は平滑の前、打撃は検出のあと）、1 本ずつ好きな位置で回せるようにしておく。
   */
  updateParam(paramId: string, deltaSeconds: number): void {
    const decl = this.decls.get(paramId);
    if (decl) {
      const base = this.getBase(decl.id);
      const binding = this.bindings.get(decl.id);
      const source = binding?.sourceId ? this.sources.get(binding.sourceId) : undefined;
      if (!binding || !source) {
        this.resolved.set(decl.id, { value: clamp(base, decl.min, decl.max), signal: 0, base });
        return;
      }
      const state = this.envelopes.get(decl.id) ?? { value: 0 };
      this.envelopes.set(decl.id, state);
      const signal = applyTransform(binding.transform, source.value(), state, deltaSeconds);
      const span = decl.max - decl.min;
      const value = clamp(base + binding.depth * signal * span, decl.min, decl.max);
      this.resolved.set(decl.id, { value, signal, base });
    }
  }

  /** 解決済みの値。`update` を呼んだあとに読む。 */
  resolve(paramId: string): ResolvedParam {
    const decl = this.decls.get(paramId);
    const fallback = decl ? clamp(this.getBase(paramId), decl.min, decl.max) : 0;
    return this.resolved.get(paramId) ?? { value: fallback, signal: 0, base: fallback };
  }

  /** 解決済みの値だけ。よく使うので短く読めるようにしておく。 */
  valueOf(paramId: string): number {
    return this.resolve(paramId).value;
  }
}
