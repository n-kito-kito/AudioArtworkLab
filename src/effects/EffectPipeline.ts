import type * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import type { AudioParameters } from '../audio/AudioEngine';
import type { Effect } from './Effect';

export class EffectPipeline {
  private readonly composer: EffectComposer;
  readonly effects: Effect[];

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    effects: Effect[],
  ) {
    this.effects = effects;
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.rebuild();
  }

  update(audio: AudioParameters, elapsed: number): void {
    for (const effect of this.effects) effect.update(audio, elapsed);
  }

  move(effect: Effect, direction: -1 | 1): void {
    const index = this.effects.indexOf(effect);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= this.effects.length) return;
    [this.effects[index], this.effects[target]] = [this.effects[target]!, this.effects[index]!];
    this.rebuild();
  }

  render(): void {
    this.composer.render();
  }
  resize(width: number, height: number): void {
    this.composer.setSize(width, height);
    for (const effect of this.effects) effect.resize(width, height);
  }

  dispose(): void {
    for (const effect of this.effects) effect.dispose();
    this.composer.dispose();
  }

  private rebuild(): void {
    while (this.composer.passes.length > 1) this.composer.removePass(this.composer.passes[1]!);
    for (const effect of this.effects) this.composer.addPass(effect.pass);
  }
}
