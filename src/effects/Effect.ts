import type * as THREE from 'three';

export interface EffectContext {
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
}

export interface Effect {
  enable(): void;
  disable(): void;
  render(): void;
  dispose(): void;
}

export abstract class BaseEffect implements Effect {
  protected enabled = false;

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  abstract render(): void;
  abstract dispose(): void;
}
