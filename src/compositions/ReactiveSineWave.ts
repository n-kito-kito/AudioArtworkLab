import { SineWaveBasic } from './SineWaveBasic';

export class ReactiveSineWave extends SineWaveBasic {
  readonly name = 'ReactiveSineWave';

  constructor() {
    super();
    this.selectGenerator('Sine');
    this.sineWave.setParameters({
      amplitude: 0.34,
      frequency: 4.2,
      speed: 0.72,
      color: '#b8ff38',
    });
    this.sineWave.setAudioReaction({
      bassStrength: 1.15,
      midStrength: 1.2,
      trebleStrength: 0.9,
      beatStrength: 0.22,
    });
    for (const effect of this.getEffects()) {
      effect.enabled = ['Grain', 'Bloom'].includes(effect.name);
      if (effect.name === 'Bloom') {
        effect.intensity = 0.48;
        effect.audioSource = 'bass';
      }
    }
  }
}
