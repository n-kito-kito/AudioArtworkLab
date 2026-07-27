import type {
  Effect,
  EffectAudioMappings,
  EffectParameterValues,
} from '../effects/Effect';
import type { CymaticsPlate } from '../expressions/CymaticsPlate';
import { normalizeExpressionId, type ExpressionId } from '../expressions/catalog';

/**
 * Preset v7。表現（V1/V2）・テーマ・Effect 状態の保存形式。
 *
 * v1〜v3（旧 Generator 構成）との互換は持たない。旧形式を見つけたら
 * 破棄して初期状態に戻す。キーは旧版と同じものを使い、残っている
 * 旧データはここで一掃される。
 *
 * 表現ごとに持つ調整機能は異なる（PRD D25）。サイマティクスは奥行きを
 * 持たないため、v7 で depth の保存をやめた。
 */
export const LAB_PRESET_VERSION = 7;
export const LAB_PRESET_KEY = 'audio-artwork-lab:studio-preset';

export interface LabPresetEffect {
  name: string;
  enabled: boolean;
  parameters: EffectParameterValues;
  audioMappings: EffectAudioMappings;
}

export interface LabPreset {
  version: typeof LAB_PRESET_VERSION;
  /** 表現の安定 id。旧データ（v5 以前）は cymatics-v1 として読む。 */
  expressionId: ExpressionId;
  fieldName: string;
  rendererName: string;
  themeName: string;
  zoom: number;
  /** チェーンの並び順どおりに格納する。 */
  effects: LabPresetEffect[];
}

export function createLabPreset(composition: CymaticsPlate): LabPreset {
  return {
    version: LAB_PRESET_VERSION,
    expressionId: composition.id,
    fieldName: 'Cymatics',
    // 1 表現 = 1 見え方（D16）。互換のため形だけ残している固定値。
    rendererName: 'Minimal shape',
    themeName: composition.getTheme().name,
    zoom: composition.getZoom(),
    effects: composition.getEffects().map((effect) => ({
      name: effect.name,
      enabled: effect.enabled,
      parameters: effect.getParameterValues(),
      audioMappings: effect.getAudioMappings(),
    })),
  };
}

/**
 * 旧バージョンを現行形式へ引き上げる。扱えない形式は null。
 * v1〜v3（旧 Generator 構成）は D8 により破棄する。
 */
function migrate(raw: Record<string, unknown>): Record<string, unknown> | null {
  let preset = raw;
  // v4 → v5: ズームが増えた。既存のプリセットは等倍とみなす。
  if (preset.version === 4) preset = { ...preset, version: 5, zoom: 1 };
  // v5 → v6: 表現の選択が増えた。旧 Cymatics は V1 として扱う。
  if (preset.version === 5) preset = { ...preset, version: 6, expressionId: 'cymatics-v1' };
  // v6 → v7: 奥行きの保存をやめた（サイマティクスは奥行きを持たない。PRD D25）。
  if (preset.version === 6) {
    const next: Record<string, unknown> = { ...preset, version: 7 };
    delete next.depth;
    preset = next;
  }
  if (preset.version === LAB_PRESET_VERSION) return preset;
  return null;
}

/**
 * 形式の検証。現行版へ移行できない形式（旧形式・壊れた JSON）は null を返す。
 * 値の範囲は適用先（setParameterValues / setAudioMappings）が丸めるため、
 * ここでは構造だけを確認する。
 */
export function parseLabPreset(raw: unknown): LabPreset | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const preset = migrate(raw as Record<string, unknown>);
  if (preset === null) return null;
  if (typeof preset.rendererName !== 'string') return null;
  if (typeof preset.themeName !== 'string') return null;
  if (typeof preset.zoom !== 'number' || !Number.isFinite(preset.zoom)) return null;
  if (!Array.isArray(preset.effects)) return null;
  for (const entry of preset.effects) {
    if (typeof entry !== 'object' || entry === null) return null;
    const effect = entry as Record<string, unknown>;
    if (typeof effect.name !== 'string') return null;
    if (typeof effect.enabled !== 'boolean') return null;
    if (typeof effect.parameters !== 'object' || effect.parameters === null) return null;
    if (typeof effect.audioMappings !== 'object' || effect.audioMappings === null) return null;
  }
  // 不明な表現 id は V1 に寄せる（旧データ・手編集された JSON への防御）。
  preset.expressionId = normalizeExpressionId(preset.expressionId);
  // 移行後のオブジェクトを返す。元データを返すと移行で補った値が失われる。
  return preset as unknown as LabPreset;
}

/** LocalStorage から読む。旧形式が入っていた場合は削除して null を返す。 */
export function loadLabPreset(): LabPreset | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LAB_PRESET_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const preset = parseLabPreset(parsed);
  if (!preset) {
    try {
      localStorage.removeItem(LAB_PRESET_KEY);
    } catch {
      /* 破棄できなくても起動は続ける */
    }
  }
  return preset;
}

export function saveLabPreset(preset: LabPreset): void {
  try {
    localStorage.setItem(LAB_PRESET_KEY, JSON.stringify(preset));
  } catch {
    /* ストレージ不可でもアプリは動かし続ける */
  }
}

/** 保存されていた Effect 状態を、名前で対応するインスタンスへ適用する。 */
export function applyEffectStates(
  effects: readonly Effect[],
  saved: readonly LabPresetEffect[],
): void {
  for (const entry of saved) {
    const effect = effects.find((candidate) => candidate.name === entry.name);
    if (!effect) continue;
    effect.enabled = entry.enabled;
    effect.setParameterValues(entry.parameters);
    effect.setAudioMappings(entry.audioMappings);
  }
}

/** Effect 配列を保存された並び順に入れ替える（未知の Effect は末尾に残す）。 */
export function orderEffects(effects: Effect[], names: readonly string[]): void {
  const rank = new Map(names.map((name, index) => [name, index]));
  effects.sort(
    (left, right) =>
      (rank.get(left.name) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(right.name) ?? Number.MAX_SAFE_INTEGER),
  );
}
