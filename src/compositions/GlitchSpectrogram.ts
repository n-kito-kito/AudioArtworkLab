import { SineWaveBasic } from './SineWaveBasic';

export class GlitchSpectrogram extends SineWaveBasic {
  readonly name = 'GlitchSpectrogram';

  constructor() {
    super();
    this.selectGenerator('Bitmap');
    for (const effect of this.getEffects()) {
      effect.enabled = ['Glitch', 'Scan Drift', 'Pixel Stretch', 'Grain'].includes(effect.name);
      if (effect.name === 'Glitch') {
        effect.intensity = 0.045;
        effect.audioSource = 'beat';
      }
      if (effect.name === 'Scan Drift') {
        effect.intensity = 0.018;
        effect.audioSource = 'mid';
      }
      if (effect.name === 'Pixel Stretch') {
        effect.intensity = 0.12;
        effect.audioSource = 'bass';
      }
    }
  }
}
