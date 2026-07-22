import { BaseShaderEffect } from './BaseShaderEffect';
import { vertexShader } from './shaders';

export class GlitchEffect extends BaseShaderEffect {
  readonly name = 'Glitch';
  constructor() {
    super({
      uniforms: { tDiffuse: { value: null }, uIntensity: { value: 0.025 }, uTime: { value: 0 } },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uIntensity; uniform float uTime; varying vec2 vUv;
        float hash(float n){ return fract(sin(n)*43758.5453); }
        void main(){ float row=floor(vUv.y*45.); float gate=step(.82,hash(row+floor(uTime*8.))); vec2 uv=vUv; uv.x+=(hash(row*3.1)-.5)*uIntensity*gate; vec4 c=texture2D(tDiffuse,uv); if(gate>.5){c.r=texture2D(tDiffuse,uv+vec2(uIntensity*.4,0.)).r;} gl_FragColor=c; }
      `,
    });
    this.intensity = 0.025;
  }
}
