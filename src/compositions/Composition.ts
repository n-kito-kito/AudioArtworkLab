import type * as THREE from 'three';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Effect } from '../effects/Effect';
import type { Generator } from '../generators/Generator';

export interface CompositionContext {
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  audioEngine: AudioEngine;
}

export interface Composition {
  readonly name: string;
  readonly animated: boolean;
  setup(context: CompositionContext): void;
  update(elapsed: number): void;
  render(): void;
  dispose(): void;
}

export abstract class BaseComposition implements Composition {
  abstract readonly name: string;
  abstract readonly animated: boolean;

  protected context: CompositionContext | null = null;
  protected generators: Generator[] = [];
  protected effects: Effect[] = [];

  setup(context: CompositionContext): void {
    this.context = context;

    for (const generator of this.generators) {
      generator.create({
        scene: context.scene,
        audioEngine: context.audioEngine,
      });
    }
  }

  update(elapsed: number): void {
    for (const generator of this.generators) {
      generator.update(elapsed);
    }
  }

  render(): void {
    if (!this.context) return;

    const { scene, camera, renderer } = this.context;
    renderer.render(scene, camera);

    for (const effect of this.effects) {
      effect.render();
    }
  }

  dispose(): void {
    for (const generator of this.generators) {
      generator.dispose();
    }

    for (const effect of this.effects) {
      effect.dispose();
    }

    this.generators = [];
    this.effects = [];
    this.context = null;
  }
}
