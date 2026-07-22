import { BaseShaderEffect } from './BaseShaderEffect';
import { vertexShader } from './shaders';

export class ScanDriftEffect extends BaseShaderEffect {
  readonly name = 'Scan Drift';
  constructor() {
    super({
      uniforms: { tDiffuse: { value: null }, uIntensity: { value: 0.02 }, uTime: { value: 0 } },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uIntensity; uniform float uTime; varying vec2 vUv;
        void main(){ float band=smoothstep(.03,0.,abs(fract(vUv.y*5.-uTime*.12)-.5)); vec2 uv=vUv+vec2(band*uIntensity,0.); vec4 c=texture2D(tDiffuse,uv); c.rgb*=.92+.08*sin(vUv.y*900.); gl_FragColor=c; }
      `,
    });
    this.intensity = 0.02;
  }
}
