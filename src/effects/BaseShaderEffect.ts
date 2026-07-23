import type * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { AudioParameters } from '../audio/AudioEngine';
import type {
  AudioSource,
  Effect,
  EffectAudioMapping,
  EffectAudioMappings,
  EffectBlendMode,
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
  dryWet = 1;
  effectOpacity = 1;
  blendMode: EffectBlendMode = 'normal';
  private readonly audioMappings: EffectAudioMappings = {};
  private readonly smoothedAudioValues = new Map<string, number>();

  constructor(shader: EffectShader, intensity: Omit<NumberEffectParameter, 'key' | 'type'>) {
    this.pass = new ShaderPass({
      ...shader,
      uniforms: {
        ...shader.uniforms,
        uDryWet: { value: 1 },
        uEffectOpacity: { value: 1 },
        uBlendMode: { value: 0 },
      },
      fragmentShader: this.wrapFragmentShader(shader.fragmentShader),
    });
    this.pass.enabled = false;
    this.intensity = intensity.defaultValue;
    this.parameterSchema = [
      { key: 'intensity', type: 'number', ...intensity },
      {
        key: 'dryWet',
        type: 'number',
        label: 'Dry / Wet',
        defaultValue: 1,
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        key: 'effectOpacity',
        type: 'number',
        label: 'Effect opacity',
        defaultValue: 1,
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        key: 'blendMode',
        type: 'select',
        label: 'Blend mode',
        defaultValue: 'normal',
        options: [
          { label: 'Normal', value: 'normal' },
          { label: 'Add', value: 'add' },
          { label: 'Screen', value: 'screen' },
          { label: 'Multiply', value: 'multiply' },
          { label: 'Difference', value: 'difference' },
        ],
      },
    ];
  }

  get enabled(): boolean {
    return this.pass.enabled;
  }

  set enabled(value: boolean) {
    this.pass.enabled = value;
  }

  get audioSource(): AudioSource {
    return this.audioMappings.intensity?.source ?? 'none';
  }

  set audioSource(source: AudioSource) {
    if (source === 'none') {
      delete this.audioMappings.intensity;
      this.smoothedAudioValues.delete('intensity');
      return;
    }
    const parameter = this.parameterSchema.find(
      (item): item is NumberEffectParameter =>
        item.key === 'intensity' && item.type === 'number',
    );
    if (!parameter) return;
    this.audioMappings.intensity = {
      source,
      amount: this.intensity,
      min: parameter.min,
      max: parameter.max,
      smoothing: 0.7,
      invert: false,
    };
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

  getAudioMappings(): EffectAudioMappings {
    return Object.fromEntries(
      Object.entries(this.audioMappings).map(([key, mapping]) => [key, { ...mapping }]),
    );
  }

  setAudioMappings(mappings: EffectAudioMappings): void {
    for (const key of Object.keys(this.audioMappings)) delete this.audioMappings[key];
    this.smoothedAudioValues.clear();
    for (const [key, mapping] of Object.entries(mappings)) {
      const parameter = this.parameterSchema.find(
        (item): item is NumberEffectParameter => item.key === key && item.type === 'number',
      );
      if (!parameter) continue;
      this.audioMappings[key] = this.normalizeAudioMapping(mapping, parameter);
    }
  }

  update(audio: AudioParameters, elapsed: number): void {
    for (const parameter of this.parameterSchema) {
      if (parameter.type !== 'number') continue;
      const baseValue = this.readParameter(parameter.key);
      if (typeof baseValue !== 'number') continue;
      const mapping = this.audioMappings[parameter.key];
      const mappedValue = mapping
        ? this.mapAudioValue(parameter.key, baseValue, mapping, audio)
        : baseValue;
      this.writeUniform(parameter.key, mappedValue);
    }
    if (this.pass.uniforms.uTime) this.pass.uniforms.uTime.value = elapsed;
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
    if (key === 'dryWet') return this.dryWet;
    if (key === 'effectOpacity') return this.effectOpacity;
    if (key === 'blendMode') return this.blendMode;
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
    if (parameter.key === 'dryWet') {
      this.dryWet = safeValue as number;
      return;
    }
    if (parameter.key === 'effectOpacity') {
      this.effectOpacity = safeValue as number;
      return;
    }
    if (parameter.key === 'blendMode') {
      this.blendMode = safeValue as EffectBlendMode;
      this.pass.uniforms.uBlendMode!.value = this.blendModeIndex(this.blendMode);
      return;
    }
    const uniform = this.pass.uniforms[
      `u${parameter.key.charAt(0).toUpperCase()}${parameter.key.slice(1)}`
    ];
    if (uniform) uniform.value = safeValue;
  }

  private mapAudioValue(
    key: string,
    baseValue: number,
    mapping: EffectAudioMapping,
    audio: AudioParameters,
  ): number {
    const sourceValue = mapping.source === 'none' ? 0 : (audio[mapping.source] ?? 0);
    const input = mapping.invert ? 1 - sourceValue : sourceValue;
    const target = Math.min(Math.max(baseValue + input * mapping.amount, mapping.min), mapping.max);
    const previous = this.smoothedAudioValues.get(key) ?? target;
    const value = previous * mapping.smoothing + target * (1 - mapping.smoothing);
    const safeValue = Number.isFinite(value) ? value : baseValue;
    this.smoothedAudioValues.set(key, safeValue);
    return safeValue;
  }

  private normalizeAudioMapping(
    mapping: EffectAudioMapping,
    parameter: NumberEffectParameter,
  ): EffectAudioMapping {
    const min = Number.isFinite(mapping.min)
      ? Math.min(Math.max(mapping.min, parameter.min), parameter.max)
      : parameter.min;
    const max = Number.isFinite(mapping.max)
      ? Math.min(Math.max(mapping.max, min), parameter.max)
      : parameter.max;
    return {
      source: ['none', 'volume', 'bass', 'mid', 'treble', 'beat'].includes(mapping.source)
        ? mapping.source
        : 'none',
      amount: Number.isFinite(mapping.amount) ? mapping.amount : 0,
      min,
      max,
      smoothing: Number.isFinite(mapping.smoothing)
        ? Math.min(Math.max(mapping.smoothing, 0), 0.99)
        : 0.7,
      invert: Boolean(mapping.invert),
    };
  }

  private writeUniform(key: string, value: number): void {
    const uniform = this.pass.uniforms[`u${key.charAt(0).toUpperCase()}${key.slice(1)}`];
    if (uniform) uniform.value = value;
  }

  private blendModeIndex(mode: EffectBlendMode): number {
    return ['normal', 'add', 'screen', 'multiply', 'difference'].indexOf(mode);
  }

  private wrapFragmentShader(fragmentShader: string): string {
    const effectShader = fragmentShader.replace(
      /void\s+main\s*\(\s*\)/,
      'void effectMain()',
    );
    if (effectShader === fragmentShader) {
      throw new Error('Effect shader must declare void main()');
    }
    return /* glsl */ `
      ${effectShader}

      uniform float uDryWet;
      uniform float uEffectOpacity;
      uniform int uBlendMode;

      vec3 blendEffect(vec3 source, vec3 effectColor) {
        if (uBlendMode == 1) return source + effectColor;
        if (uBlendMode == 2) return 1.0 - (1.0 - source) * (1.0 - effectColor);
        if (uBlendMode == 3) return source * effectColor;
        if (uBlendMode == 4) return abs(source - effectColor);
        return effectColor;
      }

      void main() {
        vec4 source = texture2D(tDiffuse, vUv);
        effectMain();
        vec4 effectColor = gl_FragColor;
        float mixAmount = clamp(uDryWet, 0.0, 1.0) * clamp(uEffectOpacity, 0.0, 1.0);
        vec3 blended = blendEffect(source.rgb, effectColor.rgb);
        gl_FragColor = vec4(
          mix(source.rgb, blended, mixAmount),
          mix(source.a, effectColor.a, mixAmount)
        );
      }
    `;
  }
}
