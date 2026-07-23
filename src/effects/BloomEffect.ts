import * as THREE from 'three';
import { BaseShaderEffect } from './BaseShaderEffect';
import { vertexShader } from './shaders';

export class BloomEffect extends BaseShaderEffect {
  readonly name = 'Bloom';

  constructor() {
    super({
      uniforms: {
        tDiffuse: { value: null },
        uIntensity: { value: 0.62 },
        uResolution: { value: new THREE.Vector2(innerWidth, innerHeight) },
      },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uIntensity;
        uniform vec2 uResolution;
        varying vec2 vUv;

        vec3 brightSample(vec2 uv) {
          vec3 color = texture2D(tDiffuse, uv).rgb;
          float brightness = max(max(color.r, color.g), color.b);
          return color * smoothstep(0.42, 0.82, brightness);
        }

        void main() {
          float amount = clamp(uIntensity, 0.0, 1.0);
          vec2 pixel = 1.0 / max(uResolution, vec2(1.0));
          vec2 radius = pixel * mix(2.0, 7.0, amount);
          vec3 glow = brightSample(vUv) * 0.2;
          glow += brightSample(vUv + vec2(radius.x, 0.0)) * 0.11;
          glow += brightSample(vUv - vec2(radius.x, 0.0)) * 0.11;
          glow += brightSample(vUv + vec2(0.0, radius.y)) * 0.11;
          glow += brightSample(vUv - vec2(0.0, radius.y)) * 0.11;
          glow += brightSample(vUv + radius) * 0.09;
          glow += brightSample(vUv - radius) * 0.09;
          glow += brightSample(vUv + vec2(radius.x, -radius.y)) * 0.09;
          glow += brightSample(vUv + vec2(-radius.x, radius.y)) * 0.09;
          vec4 source = texture2D(tDiffuse, vUv);
          gl_FragColor = vec4(source.rgb + glow * amount * 1.45, source.a);
        }
      `,
    }, { label: 'Intensity', defaultValue: 0.62, min: 0, max: 1, step: 0.001 });
  }
}
