import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { AudioParameters } from '../audio/AudioEngine';

export type AudioSource = 'none' | 'volume' | 'bass' | 'mid' | 'treble' | 'beat';
export type EffectBlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'difference';

export type EffectParameterValue = number | boolean | string;
export type EffectParameterValues = Record<string, EffectParameterValue>;

export interface EffectAudioMapping {
  source: AudioSource;
  amount: number;
  min: number;
  max: number;
  smoothing: number;
  invert: boolean;
}

export type EffectAudioMappings = Record<string, EffectAudioMapping>;

interface EffectParameterBase {
  key: string;
  label: string;
  defaultValue: EffectParameterValue;
}

export interface NumberEffectParameter extends EffectParameterBase {
  type: 'number';
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
}

export interface BooleanEffectParameter extends EffectParameterBase {
  type: 'boolean';
  defaultValue: boolean;
}

export interface ColorEffectParameter extends EffectParameterBase {
  type: 'color';
  defaultValue: string;
}

export interface SelectEffectParameter extends EffectParameterBase {
  type: 'select';
  defaultValue: string;
  options: Array<{ label: string; value: string }>;
}

export type EffectParameterSchema =
  | NumberEffectParameter
  | BooleanEffectParameter
  | ColorEffectParameter
  | SelectEffectParameter;

export interface Effect {
  readonly name: string;
  readonly pass: ShaderPass;
  readonly parameterSchema: readonly EffectParameterSchema[];
  enabled: boolean;
  intensity: number;
  dryWet: number;
  effectOpacity: number;
  blendMode: EffectBlendMode;
  audioSource: AudioSource;
  getParameterValues(): EffectParameterValues;
  setParameterValues(values: EffectParameterValues): void;
  getAudioMappings(): EffectAudioMappings;
  setAudioMappings(mappings: EffectAudioMappings): void;
  update(audio: AudioParameters, elapsed: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
