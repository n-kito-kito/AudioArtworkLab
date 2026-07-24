import type { AudioParameters } from '../audio/AudioEngine';
import type { FieldUniforms } from '../engine/Field';
import type { FieldRenderer } from '../engine/FieldRenderer';

/**
 * ミニマルな図形。場のゼロ交差（節線）だけを細い線で描く。
 *
 * 場の傾きで距離を正規化するため、どこでも線幅が一定になる。
 * これにより CPU でジオメトリを作らずに細く均一な線が引ける。
 *
 * 音との対応（DESIGN.md「4. 音 → パラメータの写像」）:
 *   L1  音量 → 線の太さ（閾値）。大きな音ほど砂が太く溜まる
 *       持続 → 線の濃さ。鳴り続けるほど濃くなり、止むと褪せる
 */

/** フレームレートに依存しない指数追従。 */
function approach(current: number, target: number, rate: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * delta));
}

export class MinimalShape implements FieldRenderer {
  readonly name = 'Minimal shape';

  readonly uniforms: FieldUniforms = {
    uLineWidth: { value: 1.2 },
    uThreshold: { value: 0 },
    uInk: { value: 0.85 },
  };

  readonly glsl = /* glsl */ `
    uniform float uLineWidth;
    uniform float uThreshold;
    uniform float uInk;

    float sandHash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    vec3 render(vec2 p) {
      float v = field(p) - uThreshold;

      // 場の勾配で割ることでゼロ集合までの近似距離になる。
      // 勾配が消える点で発散しないよう下限を設ける。
      vec2 gradient = vec2(dFdx(v), dFdy(v));
      float distance = abs(v) / max(length(gradient), 1e-5);

      float width = max(uLineWidth, 0.01);

      // 実物の板の砂と同じ積もり方にする:
      // 節線の芯に密に積もり、周辺に粒がまばらに散る。
      float core = 1.0 - smoothstep(0.0, width, distance);
      float halo = 1.0 - smoothstep(0.0, width * 7.0, distance);
      float density = core * 0.92 + halo * 0.16;

      // 画素ごとの確率で粒を落とす。板は振動しているので、粒はゆっくり入れ替わる。
      vec2 cell = floor(gl_FragCoord.xy / 1.5);
      float grain = sandHash(cell + floor(uTime * 2.5) * 0.37);
      float sand = step(1.0 - density, grain);

      // 粒だけだと芯が痩せるため、節線そのものの淡い連続光を下に敷く。
      float bed = core * core * 0.30;

      return vec3((sand * 0.78 + bed) * clamp(uInk, 0.0, 1.0));
    }
  `;

  private previousElapsed = 0;

  update(audio: AudioParameters, elapsed: number): void {
    const delta = Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.1);
    this.previousElapsed = elapsed;

    // L1: 音量が線の太さを決める。無音に近いほど糸のように細くなる。
    const volume = Math.min(Math.max(audio.volume ?? 0, 0), 1);
    this.uniforms.uLineWidth!.value = approach(
      this.uniforms.uLineWidth!.value as number,
      0.5 + volume * 2.6,
      7,
      delta,
    );

    // 持続: 鳴り続けるほど濃く、止むと褪せる。
    const sustain = Math.min(Math.max(audio.sustain ?? 0, 0), 1);
    this.uniforms.uInk!.value = approach(
      this.uniforms.uInk!.value as number,
      0.45 + sustain * 0.55,
      3,
      delta,
    );
  }

  dispose(): void {
    // 保持している GPU リソースはない。
  }
}
