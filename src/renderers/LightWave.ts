import type { AudioParameters } from '../audio/AudioEngine';
import type { FieldUniforms } from '../engine/Field';
import type { FieldRenderer } from '../engine/FieldRenderer';

/**
 * 光と波。場を光の濃淡として描く。
 *
 * 節線の近くに光が溜まり、場の等高線に沿って干渉縞のような光の波が走る。
 * 線ではなく面の表現なので、同じ場でもミニマルな図形とは全く別の絵になる。
 *
 * 音との対応（DESIGN.md「4. 音 → パラメータの写像」）:
 *   L1  音量 → 光の広がり。大きな音ほど光が節線から溢れる
 *       高域 → 縞の細かさ。明るい音ほど細かく波打つ
 *       持続 → 全体の輝度。鳴り続けるほど明るく、止むと沈む
 */

/** フレームレートに依存しない指数追従。 */
function approach(current: number, target: number, rate: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * delta));
}

export class LightWave implements FieldRenderer {
  readonly name = 'Light wave';

  readonly uniforms: FieldUniforms = {
    uGlow: { value: 5 },
    uBand: { value: 4 },
    uLuminance: { value: 0.7 },
  };

  readonly glsl = /* glsl */ `
    uniform float uGlow;
    uniform float uBand;
    uniform float uLuminance;

    vec3 render(vec2 p) {
      float v = field(p);

      // 節線（v = 0）の近くに光が溜まる。
      float glow = exp(-abs(v) * uGlow);

      // 場の等高線に沿って光の波がゆっくり流れる。
      float bands = 0.5 + 0.5 * cos(v * uBand * PI - uTime * 1.2);

      float light = glow * (0.55 + 0.45 * bands);
      light = pow(light, 1.4);

      return vec3(light * clamp(uLuminance, 0.0, 1.0));
    }
  `;

  private previousElapsed = 0;

  update(audio: AudioParameters, elapsed: number): void {
    const delta = Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.1);
    this.previousElapsed = elapsed;

    // L1: 音量が光の広がりを決める。値が小さいほど光は遠くまで届く。
    const volume = Math.min(Math.max(audio.volume ?? 0, 0), 1);
    this.uniforms.uGlow!.value = approach(
      this.uniforms.uGlow!.value as number,
      6.5 - volume * 4,
      7,
      delta,
    );

    // 高域が縞の細かさを決める。
    const treble = Math.min(Math.max(audio.treble ?? 0, 0), 1);
    this.uniforms.uBand!.value = approach(
      this.uniforms.uBand!.value as number,
      2 + treble * 8,
      5,
      delta,
    );

    // 持続が全体の輝度を決める。
    const sustain = Math.min(Math.max(audio.sustain ?? 0, 0), 1);
    this.uniforms.uLuminance!.value = approach(
      this.uniforms.uLuminance!.value as number,
      0.45 + sustain * 0.55,
      3,
      delta,
    );
  }

  dispose(): void {
    // 保持している GPU リソースはない。
  }
}
