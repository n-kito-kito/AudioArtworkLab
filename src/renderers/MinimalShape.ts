import type { FieldUniforms } from '../engine/Field';
import type { FieldRenderer } from '../engine/FieldRenderer';

/**
 * ミニマルな図形。場のゼロ交差（節線）だけを細い線で描く。
 *
 * 場の傾きで距離を正規化するため、どこでも線幅が一定になる。
 * これにより CPU でジオメトリを作らずに細く均一な線が引ける。
 */
export class MinimalShape implements FieldRenderer {
  readonly name = 'Minimal shape';

  readonly uniforms: FieldUniforms = {
    uLineWidth: { value: 1.6 },
    uThreshold: { value: 0 },
  };

  readonly glsl = /* glsl */ `
    uniform float uLineWidth;
    uniform float uThreshold;

    vec3 render(vec2 p) {
      float v = field(p) - uThreshold;

      // 場の勾配で割ることでゼロ集合までの近似距離になる。
      // 勾配が消える点で発散しないよう下限を設ける。
      vec2 gradient = vec2(dFdx(v), dFdy(v));
      float distance = abs(v) / max(length(gradient), 1e-5);

      float line = 1.0 - smoothstep(0.0, max(uLineWidth, 0.01), distance);
      return vec3(line);
    }
  `;

  update(): void {
    // 音量 → 閾値の L1 写像は実装順序 3 で接続する。
  }

  dispose(): void {
    // 保持している GPU リソースはない。
  }
}
