import type * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { AudioParameters } from '../audio/AudioEngine';
import type { AudioSource, Effect } from './Effect';

export interface EffectShader {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

export abstract class BaseShaderEffect implements Effect {
  abstract readonly name: string;
  readonly pass: ShaderPass;
  intensity = 0.5;
  audioSource: AudioSource = 'none';

  constructor(shader: EffectShader) {
    this.pass = new ShaderPass(shader);
    this.pass.enabled = false;
  }

  get enabled(): boolean {
    return this.pass.enabled;
  }

  set enabled(value: boolean) {
    this.pass.enabled = value;
  }

  update(audio: AudioParameters, elapsed: number): void {
    const audioAmount = this.audioSource === 'none' ? 0 : (audio[this.audioSource] ?? 0);
    const uniforms = this.pass.uniforms;
    if (uniforms.uIntensity) uniforms.uIntensity.value = this.intensity * (1 + audioAmount);
    if (uniforms.uTime) uniforms.uTime.value = elapsed;
  }

  dispose(): void {
    this.pass.material.dispose();
  }
}
