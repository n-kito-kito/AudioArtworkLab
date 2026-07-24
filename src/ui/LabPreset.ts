import type {
  Effect,
  EffectAudioMappings,
  EffectParameterValues,
} from '../effects/Effect';
import type { FieldComposition } from '../engine/FieldComposition';

/**
 * Preset v4。Field × Renderer 構成の保存形式（DESIGN.md D8）。
 *
 * v1〜v3（旧 Generator 構成）との互換は持たない。旧形式を見つけたら
 * 破棄して初期状態に戻す。キーは旧版と同じものを使い、残っている
 * 旧データはここで一掃される。
 */
export const LAB_PRESET_VERSION = 4;
export const LAB_PRESET_KEY = 'audio-artwork-lab:studio-preset';

export interface LabPresetEffect {
  name: string;
  enabled: boolean;
  parameters: EffectParameterValues;
  audioMappings: EffectAudioMappings;
}

export interface LabPreset {
  version: typeof LAB_PRESET_VERSION;
  fieldName: string;
  rendererName: string;
  themeName: string;
  depth: number;
  /** チェーンの並び順どおりに格納する。 */
  effects: LabPresetEffect[];
}

export function createLabPreset(composition: FieldComposition): LabPreset {
  return {
    version: LAB_PRESET_VERSION,
    fieldName: 'Cymatics',
    rendererName: composition.getRenderer().name,
    themeName: composition.getTheme().name,
    depth: composition.getDepth(),
    effects: composition.getEffects().map((effect) => ({
      name: effect.name,
      enabled: effect.enabled,
      parameters: effect.getParameterValues(),
      audioMappings: effect.getAudioMappings(),
    })),
  };
}

/**
 * 形式の検証。v4 以外（旧形式・壊れた JSON）は null を返す。
 * 値の範囲は適用先（setParameterValues / setAudioMappings）が丸めるため、
 * ここでは構造だけを確認する。
 */
export function parseLabPreset(raw: unknown): LabPreset | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const preset = raw as Record<string, unknown>;
  if (preset.version !== LAB_PRESET_VERSION) return null;
  if (typeof preset.rendererName !== 'string') return null;
  if (typeof preset.themeName !== 'string') return null;
  if (typeof preset.depth !== 'number' || !Number.isFinite(preset.depth)) return null;
  if (!Array.isArray(preset.effects)) return null;
  for (const entry of preset.effects) {
    if (typeof entry !== 'object' || entry === null) return null;
    const effect = entry as Record<string, unknown>;
    if (typeof effect.name !== 'string') return null;
    if (typeof effect.enabled !== 'boolean') return null;
    if (typeof effect.parameters !== 'object' || effect.parameters === null) return null;
    if (typeof effect.audioMappings !== 'object' || effect.audioMappings === null) return null;
  }
  return raw as LabPreset;
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
