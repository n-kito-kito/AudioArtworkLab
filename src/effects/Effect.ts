import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { AudioParameters } from '../audio/AudioEngine';

export type AudioSource = 'none' | 'volume' | 'bass' | 'mid' | 'treble' | 'beat';

export interface Effect {
  readonly name: string;
  readonly pass: ShaderPass;
  enabled: boolean;
  intensity: number;
  audioSource: AudioSource;
  update(audio: AudioParameters, elapsed: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
