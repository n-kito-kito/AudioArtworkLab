import type { SineWaveBasic } from './SineWaveBasic';
import { GlitchSpectrogram } from './GlitchSpectrogram';
import { MosaicField } from './MosaicField';
import { NeonGrid } from './NeonGrid';
import { ReactiveSineWave } from './ReactiveSineWave';
import { ScanDriftWave } from './ScanDriftWave';
import { SineWaveBasic as BasicComposition } from './SineWaveBasic';

export interface CompositionDefinition {
  name: string;
  create: () => SineWaveBasic;
}

export const COMPOSITIONS: CompositionDefinition[] = [
  { name: 'SineWaveBasic', create: () => new BasicComposition() },
  { name: 'ReactiveSineWave', create: () => new ReactiveSineWave() },
  { name: 'ScanDriftWave', create: () => new ScanDriftWave() },
  { name: 'NeonGrid', create: () => new NeonGrid() },
  { name: 'MosaicField', create: () => new MosaicField() },
  { name: 'GlitchSpectrogram', create: () => new GlitchSpectrogram() },
];

export function createComposition(name: string): SineWaveBasic {
  return (COMPOSITIONS.find((definition) => definition.name === name) ?? COMPOSITIONS[0]!).create();
}
