import type { AudioEngine, AudioParameters } from './AudioEngine';

export class NullAudioEngine implements AudioEngine {
  getParameters(): AudioParameters {
    return {};
  }

  dispose(): void {}
}
