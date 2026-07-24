import type { AudioParameters } from '../audio/AudioEngine';
import type { FieldUniforms } from './Field';

/**
 * ② 表現レイヤー。Field が出した場を、どう見せるかだけを決める。
 *
 * `glsl` は `vec3 render(vec2 p)` を必ず定義し、その中で `field(p)` を呼ぶ。
 * 場そのものを作らない（それは Field の責務）。
 */
export interface FieldRenderer {
  readonly name: string;
  readonly glsl: string;
  readonly uniforms: FieldUniforms;
  update(audio: AudioParameters, elapsed: number): void;
  dispose(): void;
}
