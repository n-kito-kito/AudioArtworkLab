import type { AudioEngine, AudioParameters } from './AudioEngine';
import type { AudioFeatures } from './audioFeatures';

export class NullAudioEngine implements AudioEngine {
  private readonly waveform = new Float32Array(256);

  getParameters(): AudioParameters {
    return {};
  }

  getWaveform(): Float32Array {
    return this.waveform;
  }

  /** 音源を持たないので観察用の特徴も無い。 */
  getFeatures(): AudioFeatures | null {
    return null;
  }

  dispose(): void {}
}
