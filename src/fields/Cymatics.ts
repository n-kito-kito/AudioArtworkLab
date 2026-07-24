import type { Field, FieldUniforms } from '../engine/Field';

/**
 * サイマティクス（クラドニ図形）。
 *
 * 平板の定在波が作る節線。次数 n, m が上がるほど図形は複雑になる。
 * 音程が次数を決める L2 量子化写像は実装順序 3 で接続する。
 */
export class Cymatics implements Field {
  readonly name = 'Cymatics';

  readonly uniforms: FieldUniforms = {
    uOrderN: { value: 4 },
    uOrderM: { value: 3 },
    uScale: { value: 0.9 },
  };

  readonly glsl = /* glsl */ `
    uniform float uOrderN;
    uniform float uOrderM;
    uniform float uScale;

    float field(vec2 p) {
      vec2 q = p * uScale;
      float n = uOrderN;
      float m = uOrderM;
      return cos(n * PI * q.x) * cos(m * PI * q.y)
           - cos(m * PI * q.x) * cos(n * PI * q.y);
    }
  `;

  update(): void {
    // 音 → 次数の写像は実装順序 3 で接続する。
  }

  dispose(): void {
    // 保持している GPU リソースはない。uniform は Material 側で破棄される。
  }
}
