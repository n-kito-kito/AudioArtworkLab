import type * as THREE from 'three';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
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
  resize(): void;
  dispose(): void;
}

export abstract class BaseComposition implements Composition {
  abstract readonly name: string;
  abstract readonly animated: boolean;

  protected context: CompositionContext | null = null;
  protected generators: Generator[] = [];
  protected effects: Effect[] = [];
  private pipeline: EffectPipeline | null = null;

  setup(context: CompositionContext): void {
    this.context = context;

    for (const generator of this.generators) {
      generator.create({
        scene: context.scene,
        audioEngine: context.audioEngine,
      });
    }

    this.pipeline = new EffectPipeline(
      context.renderer,
      context.scene,
      context.camera,
      this.effects,
    );
  }

  update(elapsed: number): void {
    for (const generator of this.generators) {
      generator.update(elapsed);
    }

    this.pipeline?.update(this.context?.audioEngine.getParameters() ?? {}, elapsed);
  }

  render(): void {
    if (!this.context) return;

    this.pipeline?.render();
  }

  resize(): void {
    this.pipeline?.resize();
  }

  getEffects(): readonly Effect[] {
    return this.effects;
  }

  moveEffect(effect: Effect, direction: -1 | 1): void {
    this.pipeline?.move(effect, direction);
  }

  dispose(): void {
    for (const generator of this.generators) {
      generator.dispose();
    }

    this.pipeline?.dispose();

    this.generators = [];
    this.effects = [];
    this.pipeline = null;
    this.context = null;
  }
}
