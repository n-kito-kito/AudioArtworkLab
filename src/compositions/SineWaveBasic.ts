import { BaseComposition } from './Composition';
import { SineWave } from '../generators/SineWave';
import { Waveform } from '../generators/Waveform';
import { Grid } from '../generators/Grid';
import { Bitmap } from '../generators/Bitmap';
import { Mosaic } from '../generators/Mosaic';
import { Lissajous } from '../generators/Lissajous';
import { ParticleField } from '../generators/ParticleField';
import type { VisualGenerator } from '../generators/Generator';
import { GrainEffect } from '../effects/GrainEffect';
import { BlurEffect } from '../effects/BlurEffect';
import { PaletteMapEffect } from '../effects/PaletteMapEffect';
import { RgbSplitEffect } from '../effects/RgbSplitEffect';
import { GlitchEffect } from '../effects/GlitchEffect';
import { WarpEffect } from '../effects/WarpEffect';
import { ScanDriftEffect } from '../effects/ScanDriftEffect';
import { RepeatEffect } from '../effects/RepeatEffect';
import { PixelStretchModifier } from '../modifiers/PixelStretchModifier';
import { GridRevealModifier } from '../modifiers/GridRevealModifier';
import { HalftoneEffect } from '../effects/HalftoneEffect';
import { GlassEffect } from '../effects/GlassEffect';
import { BloomEffect } from '../effects/BloomEffect';

export class SineWaveBasic extends BaseComposition {
  readonly name = 'SineWaveBasic';
  readonly animated = true;

  readonly sineWave = new SineWave();
  readonly waveform = new Waveform();
  readonly grid = new Grid();
  readonly bitmap = new Bitmap();
  readonly mosaic = new Mosaic();
  readonly lissajous = new Lissajous();
  readonly particleField = new ParticleField();
  readonly visualGenerators: VisualGenerator[] = [
    this.sineWave,
    this.waveform,
    this.grid,
    this.bitmap,
    this.mosaic,
    this.lissajous,
    this.particleField,
  ];

  constructor() {
    super();
    this.generators = this.visualGenerators;
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
      new GridRevealModifier(),
      new HalftoneEffect(),
      new GlassEffect(),
      new BloomEffect(),
    ];
    this.effects[0]!.enabled = true;
  }

  selectGenerator(name: string): void {
    for (const generator of this.visualGenerators) {
      generator.setVisible(generator.name === name);
    }
  }

  getSelectedGeneratorName(): string {
    return this.visualGenerators.find((generator) => generator.isVisible())?.name ?? 'Sine';
  }
}
