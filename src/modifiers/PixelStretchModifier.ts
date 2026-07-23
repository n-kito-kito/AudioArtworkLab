import { BaseShaderEffect } from '../effects/BaseShaderEffect';
import { vertexShader } from '../effects/shaders';

export class PixelStretchModifier extends BaseShaderEffect {
  readonly name = 'Pixel Stretch';

  constructor() {
    super({
      uniforms: {
        tDiffuse: { value: null },
        uIntensity: { value: 0.16 },
        uTime: { value: 0 },
      },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uIntensity;
        uniform float uTime;
        varying vec2 vUv;

        float hash(float value) {
          return fract(sin(value) * 43758.5453);
        }

        void main() {
          float band = floor(vUv.y * 28.0);
          float phase = floor(uTime * 5.0);
          float active = step(0.68, hash(band + phase * 17.0));
          float anchor = hash(band * 7.3 + phase) * 0.8 + 0.1;
          float reach = uIntensity * active;
          float distanceToAnchor = abs(vUv.x - anchor);
          float weight = (1.0 - smoothstep(0.0, max(reach, 0.0001), distanceToAnchor)) * active;
          float stretchedX = mix(vUv.x, anchor, weight);
          gl_FragColor = texture2D(tDiffuse, vec2(stretchedX, vUv.y));
        }
      `,
    });
    this.intensity = 0.16;
  }
}
