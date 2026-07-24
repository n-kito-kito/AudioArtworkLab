import type { AudioParameters } from '../audio/AudioEngine';
import type { FieldUniforms } from '../engine/Field';
import type { FieldRenderer } from '../engine/FieldRenderer';

/**
 * グラフ。場の水平断面を等間隔の折れ線として描く。
 *
 * 各走査線の高さで場をサンプリングし、その値を縦方向の振れとして重ねる。
 * オシロスコープや稜線図（ridgeline plot)の美学。同じ場でも
 * 線の集合というまったく別の見え方になる。
 *
 * 音との対応（DESIGN.md「4. 音 → パラメータの写像」)::
 *   L1  音量 → 振幅。大きな音ほど断面が大きく振れる
 *       明るさ → 走査線の本数。明るい音ほど密になる
 *       持続 → 線の濃さ
 */

/** フレームレートに依存しない指数追従。 */
function approach(current: number, target: number, rate: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * delta));
}

export class Graph implements FieldRenderer {
  readonly name = 'Graph';

  readonly uniforms: FieldUniforms = {
    uRows: { value: 22 },
    uAmp: { value: 0.05 },
    uGraphInk: { value: 0.8 },
  };

  readonly glsl = /* glsl */ `
    uniform float uRows;
    uniform float uAmp;
    uniform float uGraphInk;

    vec3 render(vec2 p) {
      float rows = max(uRows, 2.0);
      float spacing = 2.0 / rows;
      // 振幅が走査線の間隔を大きく超えると、探索範囲外の線を取りこぼす。
      float amp = min(uAmp, spacing * 1.8);
      float px = 2.0 / max(uResolution.y, 1.0);

      // 近傍の走査線について、断面曲線までの距離を測って線を描く。
      float base = floor((p.y + 1.0) / spacing);
      float acc = 0.0;
      for (int k = -2; k <= 2; k++) {
        float row = (base + float(k) + 0.5) * spacing - 1.0;
        if (abs(row) > 1.0 + spacing) continue;
        float curveY = row + field(vec2(p.x, row)) * amp;
        float d = abs(p.y - curveY);
        acc += 1.0 - smoothstep(px * 0.6, px * 1.8, d);
      }

      return vec3(min(acc, 1.0) * clamp(uGraphInk, 0.0, 1.0));
    }
  `;

  private previousElapsed = 0;

  update(audio: AudioParameters, elapsed: number): void {
    const delta = Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.1);
    this.previousElapsed = elapsed;

    // L1: 音量が断面の振幅を決める。
    const volume = Math.min(Math.max(audio.volume ?? 0, 0), 1);
    this.uniforms.uAmp!.value = approach(
      this.uniforms.uAmp!.value as number,
      0.015 + volume * 0.11,
      7,
      delta,
    );

    // 明るさが走査線の密度を決める。
    const centroid = Math.min(Math.max(audio.centroid ?? 0, 0), 1);
    this.uniforms.uRows!.value = approach(
      this.uniforms.uRows!.value as number,
      12 + centroid * 34,
      4,
      delta,
    );

    // 持続が線の濃さを決める。
    const sustain = Math.min(Math.max(audio.sustain ?? 0, 0), 1);
    this.uniforms.uGraphInk!.value = approach(
      this.uniforms.uGraphInk!.value as number,
      0.5 + sustain * 0.5,
      3,
      delta,
    );
  }

  dispose(): void {
    // 保持している GPU リソースはない。
  }
}
