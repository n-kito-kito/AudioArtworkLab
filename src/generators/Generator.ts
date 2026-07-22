import type * as THREE from 'three';
import type { AudioEngine } from '../audio/AudioEngine';

export interface GeneratorContext {
  scene: THREE.Scene;
  audioEngine: AudioEngine;
}

export interface Generator {
  create(context: GeneratorContext): void;
  update(elapsed: number): void;
  dispose(): void;
}
