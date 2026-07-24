import type { Field } from './Field';
import type { FieldRenderer } from './FieldRenderer';

/** エンジンが必ず供給する uniform。Field と Renderer は同名を宣言できない。 */
export const RESERVED_UNIFORMS = ['uResolution', 'uTime', 'uActive'] as const;

const FIELD_SIGNATURE = /float\s+field\s*\(/;
const RENDER_SIGNATURE = /vec3\s+render\s*\(/;

export const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Field の GLSL と Renderer の GLSL を 1 本のフラグメントシェーダーへ合成する。
 *
 * 音が鳴っていないとき（uActive < 0.5）は何も生成しない。黒画面が正しい挙動。
 */
export function composeFragmentShader(field: Field, renderer: FieldRenderer): string {
  if (!FIELD_SIGNATURE.test(field.glsl)) {
    throw new Error(`Field "${field.name}" must define float field(vec2 p)`);
  }
  if (!RENDER_SIGNATURE.test(renderer.glsl)) {
    throw new Error(`Renderer "${renderer.name}" must define vec3 render(vec2 p)`);
  }

  for (const name of RESERVED_UNIFORMS) {
    if (name in field.uniforms) {
      throw new Error(`Field "${field.name}" must not declare the reserved uniform ${name}`);
    }
    if (name in renderer.uniforms) {
      throw new Error(`Renderer "${renderer.name}" must not declare the reserved uniform ${name}`);
    }
  }

  for (const name of Object.keys(field.uniforms)) {
    if (name in renderer.uniforms) {
      throw new Error(
        `Uniform ${name} is declared by both field "${field.name}" and renderer "${renderer.name}"`,
      );
    }
  }

  return /* glsl */ `
    precision highp float;

    varying vec2 vUv;

    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uActive;

    const float PI = 3.141592653589793;

    // NaN は比較が常に false になる性質を使って落とす。
    // isnan / isinf は GLSL ES 3.0 の関数なのでここでは使えない。
    vec3 sanitize(vec3 c) {
      c = clamp(c, 0.0, 1.0);
      if (!(c.r >= 0.0)) c.r = 0.0;
      if (!(c.g >= 0.0)) c.g = 0.0;
      if (!(c.b >= 0.0)) c.b = 0.0;
      return c;
    }

    ${field.glsl}

    ${renderer.glsl}

    void main() {
      if (uActive < 0.5) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      vec2 p = vUv * 2.0 - 1.0;
      p.x *= max(uResolution.x, 1.0) / max(uResolution.y, 1.0);

      gl_FragColor = vec4(sanitize(render(p)), 1.0);
    }
  `;
}
