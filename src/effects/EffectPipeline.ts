import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { AudioParameters } from '../audio/AudioEngine';
import type { Effect } from './Effect';
import type { DesignLayerCanvases } from '../compositions/Composition';

export class EffectPipeline {
  private readonly composer: EffectComposer;
  readonly effects: Effect[];
  private overlayPass: ShaderPass | null = null;
  private cleanOverlayPass: ShaderPass | null = null;
  private overlayTextures: THREE.CanvasTexture[] = [];

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    effects: Effect[],
  ) {
    this.effects = effects;
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.rebuild();
  }

  update(audio: AudioParameters, elapsed: number): void {
    for (const effect of this.effects) effect.update(audio, elapsed);
  }

  move(effect: Effect, direction: -1 | 1): void {
    const index = this.effects.indexOf(effect);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= this.effects.length) return;
    [this.effects[index], this.effects[target]] = [this.effects[target]!, this.effects[index]!];
    this.rebuild();
  }

  setOrder(names: string[]): void {
    const rank = new Map(names.map((name, index) => [name, index]));
    this.effects.sort(
      (left, right) =>
        (rank.get(left.name) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(right.name) ?? Number.MAX_SAFE_INTEGER),
    );
    this.rebuild();
  }

  render(): void {
    this.composer.render();
  }

  setOverlayCanvases(canvases: DesignLayerCanvases): void {
    this.disposeOverlay();
    this.overlayTextures = canvases.map((canvas) => {
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      return texture;
    });
    this.overlayPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        tBack: { value: this.overlayTextures[0] },
        tFront: { value: this.overlayTextures[1] },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tBack;
        uniform sampler2D tFront;
        varying vec2 vUv;

        vec4 over(vec4 base, vec4 layer) {
          float alpha = layer.a + base.a * (1.0 - layer.a);
          if (alpha <= 0.0001) return vec4(0.0);
          vec3 color = (layer.rgb * layer.a + base.rgb * base.a * (1.0 - layer.a)) / alpha;
          return vec4(color, alpha);
        }

        void main() {
          vec4 source = texture2D(tDiffuse, vUv);
          vec4 back = texture2D(tBack, vUv);
          vec4 front = texture2D(tFront, vUv);
          gl_FragColor = over(over(back, source), front);
        }
      `,
    });
    this.cleanOverlayPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        tClean: { value: this.overlayTextures[2] },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tClean;
        varying vec2 vUv;

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          vec4 clean = texture2D(tClean, vUv);
          float alpha = clean.a + base.a * (1.0 - clean.a);
          if (alpha <= 0.0001) {
            gl_FragColor = vec4(0.0);
            return;
          }
          vec3 color =
            (clean.rgb * clean.a + base.rgb * base.a * (1.0 - clean.a)) / alpha;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });
    this.rebuild();
  }

  updateOverlayCanvases(): void {
    this.overlayTextures.forEach((texture) => (texture.needsUpdate = true));
  }
  resize(width: number, height: number): void {
    this.composer.setSize(width, height);
    for (const effect of this.effects) effect.resize(width, height);
  }

  dispose(): void {
    for (const effect of this.effects) effect.dispose();
    this.disposeOverlay();
    this.composer.dispose();
  }

  private rebuild(): void {
    while (this.composer.passes.length > 1) this.composer.removePass(this.composer.passes[1]!);
    if (this.overlayPass) this.composer.addPass(this.overlayPass);
    for (const effect of this.effects) this.composer.addPass(effect.pass);
    if (this.cleanOverlayPass) this.composer.addPass(this.cleanOverlayPass);
  }

  private disposeOverlay(): void {
    if (this.overlayPass) {
      this.composer.removePass(this.overlayPass);
      this.overlayPass.material.dispose();
      this.overlayPass = null;
    }
    if (this.cleanOverlayPass) {
      this.composer.removePass(this.cleanOverlayPass);
      this.cleanOverlayPass.material.dispose();
      this.cleanOverlayPass = null;
    }
    this.overlayTextures.forEach((texture) => texture.dispose());
    this.overlayTextures = [];
  }
}
