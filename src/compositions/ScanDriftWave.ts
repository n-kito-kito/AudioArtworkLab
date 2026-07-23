import { SineWaveBasic } from './SineWaveBasic';

export class ScanDriftWave extends SineWaveBasic {
  readonly name = 'ScanDriftWave';

  constructor() {
    super();
    this.selectGenerator('Waveform');
    for (const effect of this.getEffects()) {
      effect.enabled = ['Grain', 'Scan Drift', 'RGB Split'].includes(effect.name);
      if (effect.name === 'Scan Drift') {
        effect.intensity = 0.028;
        effect.audioSource = 'mid';
      }
      if (effect.name === 'RGB Split') {
        effect.intensity = 0.008;
        effect.audioSource = 'beat';
      }
    }
  }
}
