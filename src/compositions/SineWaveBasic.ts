import { BaseComposition } from './Composition';
import { SineWave } from '../generators/SineWave';

export class SineWaveBasic extends BaseComposition {
  readonly name = 'SineWaveBasic';
  readonly animated = true;

  constructor() {
    super();
    this.generators = [new SineWave()];
    this.effects = [];
  }
}
