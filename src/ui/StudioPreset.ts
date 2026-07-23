import type {
  AudioSource,
  EffectAudioMappings,
  EffectParameterValues,
} from '../effects/Effect';
import type { SineWaveBasic } from '../compositions/SineWaveBasic';
import type { LayerEditor, LayerEditorSnapshot } from './LayerEditor';

export const STUDIO_PRESET_VERSION = 3;

export interface StudioPreset {
  version: 3;
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
    parameters: EffectParameterValues;
    audioMappings: EffectAudioMappings;
  }>;
  layers: LayerEditorSnapshot;
}

interface LegacyStudioPresetV2 extends Omit<StudioPreset, 'version' | 'effects'> {
  version: 2;
  effects: Array<{
    name: string;
    enabled: boolean;
    audioSource: AudioSource;
    parameters: EffectParameterValues;
  }>;
}

interface LegacyStudioPresetV1 extends Omit<LegacyStudioPresetV2, 'version' | 'effects'> {
  version: 1;
  effects: Array<{
    name: string;
    enabled: boolean;
    intensity: number;
    audioSource: AudioSource;
  }>;
}

export type CompatibleStudioPreset =
  | StudioPreset
  | LegacyStudioPresetV2
  | LegacyStudioPresetV1;

export function migrateStudioPreset(preset: CompatibleStudioPreset): StudioPreset {
  if (preset.version === STUDIO_PRESET_VERSION) return preset;
  if (preset.version === 2) {
    return {
      ...preset,
      version: STUDIO_PRESET_VERSION,
      effects: preset.effects.map(({ name, enabled, audioSource, parameters }) => ({
        name,
        enabled,
        parameters,
        audioMappings:
          audioSource === 'none'
            ? ({} as EffectAudioMappings)
            : {
                intensity: {
                  source: audioSource,
                  amount:
                    typeof parameters.intensity === 'number' ? parameters.intensity : 0.5,
                  min: 0,
                  max: 1,
                  smoothing: 0.7,
                  invert: false,
                },
              },
      })),
    };
  }
  if (preset.version === 1) {
    const version2: LegacyStudioPresetV2 = {
      ...preset,
      version: 2,
      effects: preset.effects.map(({ name, enabled, intensity, audioSource }) => ({
        name,
        enabled,
        audioSource,
        parameters: { intensity },
      })),
    };
    return migrateStudioPreset(version2);
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
      parameters: effect.getParameterValues(),
      audioMappings: effect.getAudioMappings(),
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
    effect.setParameterValues(saved.parameters);
    effect.setAudioMappings(saved.audioMappings);
  }
  layerEditor.restoreSnapshot(preset.layers);
}
