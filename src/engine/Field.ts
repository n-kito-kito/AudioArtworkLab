import type * as THREE from 'three';
import type { AudioParameters } from '../audio/AudioEngine';

export type FieldUniforms = Record<string, THREE.IUniform>;

/**
 * ① 生成レイヤー。図形ではなくスカラー場を出力する。
 *
 * `glsl` は `float field(vec2 p)` を必ず定義する。p は中心が原点、
 * 縦が -1..1、横はアスペクト比で伸びた座標。
 */
export interface Field {
  readonly name: string;
  readonly glsl: string;
  readonly uniforms: FieldUniforms;
  update(audio: AudioParameters, elapsed: number): void;
  dispose(): void;
}
