import { BaseShaderEffect } from './BaseShaderEffect';
import { vertexShader } from './shaders';

export class PaletteMapEffect extends BaseShaderEffect {
  readonly name = 'Palette Map';
  constructor() {
    super({
      uniforms: { tDiffuse: { value: null }, uIntensity: { value: 0.7 } },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uIntensity; varying vec2 vUv;
        void main(){ vec4 c=texture2D(tDiffuse,vUv); float l=dot(c.rgb,vec3(.299,.587,.114)); vec3 a=vec3(.055,.08,.15); vec3 b=vec3(.75,.25,.82); vec3 d=vec3(.65,1.,.28); vec3 mapped=mix(a,b,smoothstep(.05,.55,l)); mapped=mix(mapped,d,smoothstep(.55,1.,l)); gl_FragColor=vec4(mix(c.rgb,mapped,clamp(uIntensity,0.,1.)),c.a); }
      `,
    });
    this.intensity = 0.7;
  }
}
