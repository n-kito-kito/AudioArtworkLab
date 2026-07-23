import * as THREE from 'three';
import { BaseShaderEffect } from './BaseShaderEffect';
import { vertexShader } from './shaders';

export class BlurEffect extends BaseShaderEffect {
  readonly name = 'Blur';
  constructor() {
    super({
      uniforms: {
        tDiffuse: { value: null },
        uIntensity: { value: 0.002 },
        uResolution: { value: new THREE.Vector2(innerWidth, innerHeight) },
      },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uIntensity; uniform vec2 uResolution; varying vec2 vUv;
        void main(){ vec2 d=vec2(uIntensity*uResolution.y/uResolution.x,uIntensity); vec4 c=texture2D(tDiffuse,vUv)*.36; c+=texture2D(tDiffuse,vUv+d)*.16; c+=texture2D(tDiffuse,vUv-d)*.16; c+=texture2D(tDiffuse,vUv+vec2(d.x,-d.y))*.16; c+=texture2D(tDiffuse,vUv+vec2(-d.x,d.y))*.16; gl_FragColor=c; }
      `,
    }, { label: 'Intensity', defaultValue: 0.002, min: 0, max: 0.1, step: 0.001 });
  }
}
