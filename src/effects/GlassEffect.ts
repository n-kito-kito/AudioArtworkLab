import { BaseShaderEffect } from './BaseShaderEffect';
import { vertexShader } from './shaders';

export class GlassEffect extends BaseShaderEffect {
  readonly name = 'Glass';

  constructor() {
    super({
      uniforms: {
        tDiffuse: { value: null },
        uIntensity: { value: 0.024 },
        uTime: { value: 0 },
      },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uIntensity;
        uniform float uTime;
        varying vec2 vUv;

        void main() {
          float amount = clamp(uIntensity, 0.0, 0.08);
          vec2 wave = vec2(
            sin(vUv.y * 18.0 + uTime * 0.45) + sin(vUv.x * 31.0 - uTime * 0.28),
            cos(vUv.x * 16.0 - uTime * 0.38) + cos(vUv.y * 27.0 + uTime * 0.32)
          ) * 0.5;
          vec2 offset = wave * amount;
          vec4 center = texture2D(tDiffuse, vUv + offset);
          float red = texture2D(tDiffuse, vUv + offset * 1.18).r;
          float blue = texture2D(tDiffuse, vUv + offset * 0.82).b;
          float highlight = pow(max(dot(normalize(vec3(wave, 1.0)), normalize(vec3(-0.4, 0.5, 1.0))), 0.0), 12.0);
          vec3 glass = vec3(red, center.g, blue) + highlight * amount * 2.4;
          gl_FragColor = vec4(glass, center.a);
        }
      `,
    });
    this.intensity = 0.024;
  }
}
