import { BaseShaderEffect } from '../effects/BaseShaderEffect';
import { vertexShader } from '../effects/shaders';

export class GridRevealModifier extends BaseShaderEffect {
  readonly name = 'Grid Reveal';

  constructor() {
    super({
      uniforms: {
        tDiffuse: { value: null },
        uIntensity: { value: 0.55 },
      },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uIntensity;
        varying vec2 vUv;

        void main() {
          float amount = clamp(uIntensity, 0.0, 1.0);
          float cells = mix(6.0, 28.0, amount);
          vec2 gridUv = vUv * cells;
          vec2 cellUv = (floor(gridUv) + 0.5) / cells;
          vec2 edge = min(fract(gridUv), 1.0 - fract(gridUv));
          float gridLine = 1.0 - smoothstep(0.0, 0.08, min(edge.x, edge.y));
          vec4 original = texture2D(tDiffuse, vUv);
          vec4 blocked = texture2D(tDiffuse, cellUv);
          blocked.rgb *= 1.0 - gridLine * amount * 0.32;
          gl_FragColor = mix(original, blocked, amount);
        }
      `,
    }, { label: 'Intensity', defaultValue: 0.55, min: 0, max: 1, step: 0.001 });
  }
}
