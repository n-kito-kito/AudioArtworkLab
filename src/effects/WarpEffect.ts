import { BaseShaderEffect } from './BaseShaderEffect';
import { vertexShader } from './shaders';

export class WarpEffect extends BaseShaderEffect {
  readonly name = 'Warp';
  constructor() {
    super({
      uniforms: { tDiffuse: { value: null }, uIntensity: { value: 0.018 }, uTime: { value: 0 } },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uIntensity; uniform float uTime; varying vec2 vUv;
        void main(){ vec2 uv=vUv; uv.x+=sin(uv.y*12.+uTime*.7)*uIntensity; uv.y+=sin(uv.x*9.-uTime*.5)*uIntensity*.7; gl_FragColor=texture2D(tDiffuse,uv); }
      `,
    });
    this.intensity = 0.018;
  }
}
