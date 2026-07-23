import * as THREE from 'three';
import { BaseShaderEffect } from './BaseShaderEffect';
import { vertexShader } from './shaders';

export class HalftoneEffect extends BaseShaderEffect {
  readonly name = 'Halftone';

  constructor() {
    super({
      uniforms: {
        tDiffuse: { value: null },
        uIntensity: { value: 0.65 },
        uResolution: { value: new THREE.Vector2(innerWidth, innerHeight) },
      },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uIntensity;
        uniform vec2 uResolution;
        varying vec2 vUv;

        void main() {
          float amount = clamp(uIntensity, 0.0, 1.0);
          float cellSize = mix(12.0, 6.0, amount);
          vec2 pixel = vUv * uResolution;
          vec2 cell = floor(pixel / cellSize);
          vec2 sampleUv = (cell * cellSize + cellSize * 0.5) / uResolution;
          vec4 source = texture2D(tDiffuse, sampleUv);
          float luminance = dot(source.rgb, vec3(0.299, 0.587, 0.114));
          vec2 local = mod(pixel, cellSize) - cellSize * 0.5;
          float radius = sqrt(1.0 - luminance) * cellSize * 0.48;
          float edge = 1.0 - smoothstep(radius - 0.75, radius + 0.75, length(local));
          vec3 paper = vec3(0.96);
          vec3 ink = source.rgb * 0.35;
          vec3 halftone = mix(paper, ink, edge);
          vec4 original = texture2D(tDiffuse, vUv);
          gl_FragColor = vec4(mix(original.rgb, halftone, amount), original.a);
        }
      `,
    }, { label: 'Intensity', defaultValue: 0.65, min: 0, max: 1, step: 0.001 });
  }
}
