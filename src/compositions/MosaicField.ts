import { SineWaveBasic } from './SineWaveBasic';

export class MosaicField extends SineWaveBasic {
  readonly name = 'MosaicField';

  constructor() {
    super();
    this.selectGenerator('Mosaic');
    for (const effect of this.getEffects()) {
      effect.enabled = ['Grid Reveal', 'Repeat', 'Glass'].includes(effect.name);
      if (effect.name === 'Grid Reveal') {
        effect.intensity = 0.42;
        effect.audioSource = 'mid';
      }
      if (effect.name === 'Repeat') effect.intensity = 0.18;
      if (effect.name === 'Glass') {
        effect.intensity = 0.012;
        effect.audioSource = 'treble';
      }
    }
  }
}
