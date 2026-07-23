import type * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { AudioParameters } from '../audio/AudioEngine';
import type {
  AudioSource,
  Effect,
  EffectParameterSchema,
  EffectParameterValue,
  EffectParameterValues,
  NumberEffectParameter,
} from './Effect';

export interface EffectShader {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

export abstract class BaseShaderEffect implements Effect {
  abstract readonly name: string;
  readonly pass: ShaderPass;
  readonly parameterSchema: readonly EffectParameterSchema[];
  intensity: number;
  audioSource: AudioSource = 'none';

  constructor(shader: EffectShader, intensity: Omit<NumberEffectParameter, 'key' | 'type'>) {
    this.pass = new ShaderPass(shader);
    this.pass.enabled = false;
    this.intensity = intensity.defaultValue;
    this.parameterSchema = [{ key: 'intensity', type: 'number', ...intensity }];
  }

  get enabled(): boolean {
    return this.pass.enabled;
  }

  set enabled(value: boolean) {
    this.pass.enabled = value;
  }

  getParameterValues(): EffectParameterValues {
    return Object.fromEntries(
      this.parameterSchema.map((parameter) => [
        parameter.key,
        this.readParameter(parameter.key) ?? parameter.defaultValue,
      ]),
    );
  }

  setParameterValues(values: EffectParameterValues): void {
    for (const parameter of this.parameterSchema) {
      if (!(parameter.key in values)) continue;
      this.writeParameter(parameter, values[parameter.key]!);
    }
  }

  update(audio: AudioParameters, elapsed: number): void {
    const audioAmount = this.audioSource === 'none' ? 0 : (audio[this.audioSource] ?? 0);
    const uniforms = this.pass.uniforms;
    if (uniforms.uIntensity) uniforms.uIntensity.value = this.intensity * (1 + audioAmount);
    if (uniforms.uTime) uniforms.uTime.value = elapsed;
  }

  resize(width: number, height: number): void {
    const resolution = this.pass.uniforms.uResolution;
    if (resolution?.value?.set) resolution.value.set(width, height);
  }

  dispose(): void {
    this.pass.material.dispose();
  }

  protected readParameter(key: string): EffectParameterValue | undefined {
    if (key === 'intensity') return this.intensity;
    const uniform = this.pass.uniforms[`u${key.charAt(0).toUpperCase()}${key.slice(1)}`];
    const value = uniform?.value;
    return typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string'
      ? value
      : undefined;
  }

  private writeParameter(parameter: EffectParameterSchema, value: EffectParameterValue): void {
    let safeValue: EffectParameterValue = parameter.defaultValue;
    if (parameter.type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      safeValue = Math.min(Math.max(value, parameter.min), parameter.max);
    } else if (parameter.type === 'boolean' && typeof value === 'boolean') {
      safeValue = value;
    } else if (parameter.type === 'color' && typeof value === 'string') {
      safeValue = /^#[0-9a-f]{6}$/i.test(value) ? value : parameter.defaultValue;
    } else if (
      parameter.type === 'select' &&
      typeof value === 'string' &&
      parameter.options.some((option) => option.value === value)
    ) {
      safeValue = value;
    }
    if (parameter.key === 'intensity') {
      this.intensity = safeValue as number;
      return;
    }
    const uniform = this.pass.uniforms[
      `u${parameter.key.charAt(0).toUpperCase()}${parameter.key.slice(1)}`
    ];
    if (uniform) uniform.value = safeValue;
  }
}
