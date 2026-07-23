import { BaseComposition } from './Composition';
import { SineWave } from '../generators/SineWave';
import { Waveform } from '../generators/Waveform';
import { GrainEffect } from '../effects/GrainEffect';
import { BlurEffect } from '../effects/BlurEffect';
import { PaletteMapEffect } from '../effects/PaletteMapEffect';
import { RgbSplitEffect } from '../effects/RgbSplitEffect';
import { GlitchEffect } from '../effects/GlitchEffect';
import { WarpEffect } from '../effects/WarpEffect';
import { ScanDriftEffect } from '../effects/ScanDriftEffect';
import { RepeatEffect } from '../effects/RepeatEffect';
import { PixelStretchModifier } from '../modifiers/PixelStretchModifier';

export class SineWaveBasic extends BaseComposition {
  readonly name = 'SineWaveBasic';
  readonly animated = true;

  readonly sineWave = new SineWave();
  readonly waveform = new Waveform();

  constructor() {
    super();
    this.generators = [this.sineWave, this.waveform];
    this.effects = [
      new GrainEffect(),
      new BlurEffect(),
      new PaletteMapEffect(),
      new RgbSplitEffect(),
      new GlitchEffect(),
      new WarpEffect(),
      new ScanDriftEffect(),
      new RepeatEffect(),
      new PixelStretchModifier(),
    ];
    this.effects[0]!.enabled = true;
  }
}
