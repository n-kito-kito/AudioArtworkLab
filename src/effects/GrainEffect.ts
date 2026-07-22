import { BaseShaderEffect } from './BaseShaderEffect';
import { vertexShader } from './shaders';

export class GrainEffect extends BaseShaderEffect {
  readonly name = 'Grain';
  constructor() {
    super({
      uniforms: { tDiffuse: { value: null }, uIntensity: { value: 0.18 }, uTime: { value: 0 } },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uIntensity; uniform float uTime; varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)) + uTime * 17.0) * 43758.5453); }
        void main(){ vec4 c=texture2D(tDiffuse,vUv); float n=(hash(vUv)-.5)*uIntensity; gl_FragColor=vec4(c.rgb+n,c.a); }
      `,
    });
    this.intensity = 0.18;
  }
}
