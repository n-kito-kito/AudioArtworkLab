import type { Field } from './Field';
import type { FieldRenderer } from './FieldRenderer';

/** エンジンが必ず供給する uniform。Field と Renderer は同名を宣言できない。 */
export const RESERVED_UNIFORMS = [
  'uResolution',
  'uTime',
  'uActive',
  'uThemeDark',
  'uThemeLight',
  'uThemeAccent',
  'uDepthAmount',
] as const;

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
    uniform vec3 uThemeDark;
    uniform vec3 uThemeLight;
    uniform vec3 uThemeAccent;
    uniform float uDepthAmount;

    const float PI = 3.141592653589793;

    // 現在描いている層の深さ。0 = 手前、1 = 最奥。
    // Renderer はこれを読んで奥の層をぼかす・沈めるなど焦点の表現に使える。
    float gDepth = 0.0;

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

      // 奥行き（D6: 場の側で作る）。同じ場を尺度と漂いを変えて奥に重ねる。
      // 奥の層ほど細かく・暗く・遅く漂い、多層の視差が奥行きになる。
      // uDepthAmount = 0 では奥の層は消え、従来と同じ 1 層になる。
      float separation = clamp(uDepthAmount, 0.0, 1.0);
      vec3 shape = vec3(0.0);
      for (int i = 2; i >= 0; i--) {
        float fi = float(i);
        float weight = i == 0 ? 1.0 : pow(0.4, fi) * min(separation * 2.0, 1.0);
        if (weight < 0.002) continue;
        gDepth = fi * 0.5;
        vec2 drift = vec2(
          sin(uTime * (0.05 + fi * 0.02) + fi * 2.4),
          cos(uTime * (0.04 + fi * 0.017) - fi * 1.7)
        ) * 0.1 * separation * fi;
        vec2 q = p * (1.0 + separation * fi * 0.5) + drift;
        vec3 layer = sanitize(render(q)) * weight;
        // スクリーン合成。手前の光が奥を飛ばさず、重なりが自然に明るくなる。
        shape = 1.0 - (1.0 - shape) * (1.0 - layer);
      }

      // 色のテーマ（横断概念）。Renderer は明暗だけを作り、色はここで決まる。
      float luma = dot(shape, vec3(0.299, 0.587, 0.114));
      vec3 themed = mix(uThemeDark, uThemeLight, luma)
        + uThemeAccent * pow(luma, 4.0);

      gl_FragColor = vec4(clamp(themed, 0.0, 1.0), 1.0);
    }
  `;
}
