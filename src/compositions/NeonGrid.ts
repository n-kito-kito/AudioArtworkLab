import { SineWaveBasic } from './SineWaveBasic';

export class NeonGrid extends SineWaveBasic {
  readonly name = 'NeonGrid';

  constructor() {
    super();
    this.selectGenerator('Grid');
    for (const effect of this.getEffects()) {
      effect.enabled = ['Palette Map', 'RGB Split', 'Bloom'].includes(effect.name);
      if (effect.name === 'Palette Map') effect.intensity = 0.78;
      if (effect.name === 'RGB Split') {
        effect.intensity = 0.004;
        effect.audioSource = 'treble';
      }
      if (effect.name === 'Bloom') {
        effect.intensity = 0.72;
        effect.audioSource = 'bass';
      }
    }
  }
}
