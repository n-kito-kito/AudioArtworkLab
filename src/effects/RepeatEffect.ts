import { BaseShaderEffect } from './BaseShaderEffect';
import { vertexShader } from './shaders';

export class RepeatEffect extends BaseShaderEffect {
  readonly name = 'Repeat';
  constructor() {
    super({
      uniforms: { tDiffuse: { value: null }, uIntensity: { value: 0.45 } },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uIntensity; varying vec2 vUv;
        void main(){ vec4 c=texture2D(tDiffuse,vUv); vec2 uv=fract(vUv*2.); vec4 repeated=texture2D(tDiffuse,uv); gl_FragColor=mix(c,repeated,clamp(uIntensity,0.,1.)); }
      `,
    }, { label: 'Intensity', defaultValue: 0.45, min: 0, max: 1, step: 0.001 });
  }
}
