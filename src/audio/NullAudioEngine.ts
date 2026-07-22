import type { AudioEngine, AudioParameters } from './AudioEngine';

export class NullAudioEngine implements AudioEngine {
  private readonly waveform = new Float32Array(256);

  getParameters(): AudioParameters {
    return {};
  }

  getWaveform(): Float32Array {
    return this.waveform;
  }

  dispose(): void {}
}
