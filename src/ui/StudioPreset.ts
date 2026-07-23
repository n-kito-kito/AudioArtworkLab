import type { AudioSource } from '../effects/Effect';
import type { SineWaveBasic } from '../compositions/SineWaveBasic';
import type { LayerEditor, LayerEditorSnapshot } from './LayerEditor';

export const STUDIO_PRESET_VERSION = 1;

export interface StudioPreset {
  version: number;
  savedAt: string;
  sine: ReturnType<SineWaveBasic['sineWave']['getParameters']>;
  reaction: ReturnType<SineWaveBasic['sineWave']['getAudioReaction']>;
  waveformVisible: boolean;
  effects: Array<{
    name: string;
    enabled: boolean;
    intensity: number;
    audioSource: AudioSource;
  }>;
  layers: LayerEditorSnapshot;
}

export function createStudioPreset(
  composition: SineWaveBasic,
  layerEditor: LayerEditor,
): StudioPreset {
  return {
    version: STUDIO_PRESET_VERSION,
    savedAt: new Date().toISOString(),
    sine: composition.sineWave.getParameters(),
    reaction: composition.sineWave.getAudioReaction(),
    waveformVisible: composition.waveform.isVisible(),
    effects: composition.getEffects().map((effect) => ({
      name: effect.name,
      enabled: effect.enabled,
      intensity: effect.intensity,
      audioSource: effect.audioSource,
    })),
    layers: layerEditor.getSnapshot(),
  };
}

export function applyStudioPreset(
  preset: StudioPreset,
  composition: SineWaveBasic,
  layerEditor: LayerEditor,
): void {
  if (preset.version !== STUDIO_PRESET_VERSION) {
    throw new Error(`Unsupported preset version: ${preset.version}`);
  }
  composition.sineWave.setParameters(preset.sine);
  composition.sineWave.setAudioReaction(preset.reaction);
  composition.waveform.setVisible(preset.waveformVisible);
  composition.setEffectOrder(preset.effects.map((effect) => effect.name));
  for (const saved of preset.effects) {
    const effect = composition.getEffects().find((candidate) => candidate.name === saved.name);
    if (!effect) continue;
    effect.enabled = saved.enabled;
    effect.intensity = saved.intensity;
    effect.audioSource = saved.audioSource;
  }
  layerEditor.restoreSnapshot(preset.layers);
}
