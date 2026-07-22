import * as THREE from 'three';
import { BaseShaderEffect } from './BaseShaderEffect';
import { vertexShader } from './shaders';

export class RgbSplitEffect extends BaseShaderEffect {
  readonly name = 'RGB Split';
  constructor() {
    super({
      uniforms: {
        tDiffuse: { value: null },
        uIntensity: { value: 0.006 },
        uDirection: { value: new THREE.Vector2(1, 0.25) },
      },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uIntensity; uniform vec2 uDirection; varying vec2 vUv;
        void main(){ vec2 o=uDirection*uIntensity; vec4 c=texture2D(tDiffuse,vUv); gl_FragColor=vec4(texture2D(tDiffuse,vUv+o).r,c.g,texture2D(tDiffuse,vUv-o).b,c.a); }
      `,
    });
    this.intensity = 0.006;
  }
}
