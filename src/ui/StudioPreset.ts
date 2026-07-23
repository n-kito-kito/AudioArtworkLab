import type { AudioSource, EffectParameterValues } from '../effects/Effect';
import type { SineWaveBasic } from '../compositions/SineWaveBasic';
import type { LayerEditor, LayerEditorSnapshot } from './LayerEditor';

export const STUDIO_PRESET_VERSION = 2;

export interface StudioPreset {
  version: 2;
  savedAt: string;
  compositionName?: string;
  artworkName?: string;
  sine: ReturnType<SineWaveBasic['sineWave']['getParameters']>;
  reaction: ReturnType<SineWaveBasic['sineWave']['getAudioReaction']>;
  generatorName?: string;
  waveformVisible: boolean;
  effects: Array<{
    name: string;
    enabled: boolean;
    audioSource: AudioSource;
    parameters: EffectParameterValues;
  }>;
  layers: LayerEditorSnapshot;
}

interface LegacyStudioPresetV1 extends Omit<StudioPreset, 'version' | 'effects'> {
  version: 1;
  effects: Array<{
    name: string;
    enabled: boolean;
    intensity: number;
    audioSource: AudioSource;
  }>;
}

export type CompatibleStudioPreset = StudioPreset | LegacyStudioPresetV1;

export function migrateStudioPreset(preset: CompatibleStudioPreset): StudioPreset {
  if (preset.version === STUDIO_PRESET_VERSION) return preset;
  if (preset.version === 1) {
    return {
      ...preset,
      version: STUDIO_PRESET_VERSION,
      effects: preset.effects.map(({ name, enabled, intensity, audioSource }) => ({
        name,
        enabled,
        audioSource,
        parameters: { intensity },
      })),
    };
  }
  throw new Error(`Unsupported preset version: ${(preset as { version?: unknown }).version}`);
}

export function createStudioPreset(
  composition: SineWaveBasic,
  layerEditor: LayerEditor,
  artworkName?: string,
): StudioPreset {
  return {
    version: STUDIO_PRESET_VERSION,
    savedAt: new Date().toISOString(),
    compositionName: composition.name,
    artworkName,
    sine: composition.sineWave.getParameters(),
    reaction: composition.sineWave.getAudioReaction(),
    generatorName: composition.getSelectedGeneratorName(),
    waveformVisible: composition.waveform.isVisible(),
    effects: composition.getEffects().map((effect) => ({
      name: effect.name,
      enabled: effect.enabled,
      audioSource: effect.audioSource,
      parameters: effect.getParameterValues(),
    })),
    layers: layerEditor.getSnapshot(),
  };
}

export function applyStudioPreset(
  compatiblePreset: CompatibleStudioPreset,
  composition: SineWaveBasic,
  layerEditor: LayerEditor,
): void {
  const preset = migrateStudioPreset(compatiblePreset);
  composition.sineWave.setParameters(preset.sine);
  composition.sineWave.setAudioReaction(preset.reaction);
  composition.selectGenerator(
    preset.generatorName ?? (preset.waveformVisible ? 'Waveform' : 'Sine'),
  );
  composition.setEffectOrder(preset.effects.map((effect) => effect.name));
  for (const saved of preset.effects) {
    const effect = composition.getEffects().find((candidate) => candidate.name === saved.name);
    if (!effect) continue;
    effect.enabled = saved.enabled;
    effect.audioSource = saved.audioSource;
    effect.setParameterValues(saved.parameters);
  }
  layerEditor.restoreSnapshot(preset.layers);
}
