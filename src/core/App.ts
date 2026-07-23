import type { Composition } from '../compositions/Composition';
import type { AudioEngine } from '../audio/AudioEngine';
import * as THREE from 'three';
import { NullAudioEngine } from '../audio/NullAudioEngine';
import { AnimationLoop } from './AnimationLoop';
import { Camera } from './Camera';
import { Canvas } from './Canvas';
import { Renderer } from './Renderer';
import { Scene } from './Scene';

export class App {
  private readonly canvas: Canvas;
  private readonly renderer: Renderer;
  private readonly scene: Scene;
  private readonly camera: Camera;
  private composition: Composition;
  private readonly audioEngine: AudioEngine;
  private readonly resizeObserver: ResizeObserver;
  private loop: AnimationLoop | null = null;
  private contextLost = false;
  private generatorLayerVisible = true;
  private readonly designLayerPlanes: THREE.Mesh[] = [];
  private readonly designLayerTextures: THREE.CanvasTexture[] = [];

  constructor(container: HTMLElement, composition: Composition, audioEngine?: AudioEngine) {
    this.canvas = new Canvas(container);
    this.renderer = new Renderer(this.canvas);
    this.scene = new Scene();
    this.camera = new Camera(this.canvas.aspect);
    this.composition = composition;
    this.audioEngine = audioEngine ?? new NullAudioEngine();

    this.composition.setup({
      scene: this.scene.three,
      camera: this.camera.three,
      renderer: this.renderer.three,
      audioEngine: this.audioEngine,
    });
    this.composition.setGeneratorsVisible(this.generatorLayerVisible);

    this.startComposition();

    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(container);
    this.renderer.three.domElement.addEventListener('webglcontextlost', this.onContextLost);
    this.renderer.three.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
    this.onResize();
  }

  exportPng(): void {
    this.composition.render();
    this.renderer.exportPng(`audio-artwork-${Date.now()}.png`);
  }

  setComposition(composition: Composition): void {
    this.loop?.stop();
    this.loop = null;
    this.composition.dispose();
    this.composition = composition;
    this.composition.setup({
      scene: this.scene.three,
      camera: this.camera.three,
      renderer: this.renderer.three,
      audioEngine: this.audioEngine,
    });
    this.composition.setGeneratorsVisible(this.generatorLayerVisible);
    this.composition.resize(this.canvas.width, this.canvas.height);
    this.startComposition();
  }

  setResolutionScale(scale: number): void {
    this.renderer.setResolutionScale(scale);
    this.composition.resize(this.canvas.width, this.canvas.height);
  }

  setDesignLayerCanvases(canvases: [HTMLCanvasElement, HTMLCanvasElement]): void {
    this.disposeDesignLayerPlanes();
    canvases.forEach((canvas, index) => {
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      plane.position.z = index === 0 ? -0.01 : 0.01;
      plane.renderOrder = index === 0 ? -1000 : 1000;
      this.designLayerTextures.push(texture);
      this.designLayerPlanes.push(plane);
      this.scene.three.add(plane);
    });
    this.resizeDesignLayerPlanes();
  }

  updateDesignLayerCanvases(): void {
    this.designLayerTextures.forEach((texture) => (texture.needsUpdate = true));
  }

  setGeneratorLayerVisible(visible: boolean): void {
    this.generatorLayerVisible = visible;
    this.composition.setGeneratorsVisible(visible);
    this.renderer.three.domElement.style.display = '';
  }

  private startComposition(): void {
    if (this.contextLost) return;
    if (!this.composition.animated) {
      this.composition.render();
      return;
    }
    this.loop = new AnimationLoop(
      (elapsed) => this.composition.update(elapsed),
      () => this.composition.render(),
    );
    this.loop.start();
  }

  private onResize = (): void => {
    this.camera.resize(this.canvas.aspect);
    this.renderer.resize();
    this.composition.resize(this.canvas.width, this.canvas.height);
    this.resizeDesignLayerPlanes();

    if (!this.composition.animated) {
      this.composition.render();
    }
  };

  private resizeDesignLayerPlanes(): void {
    const width = this.canvas.aspect * 2;
    this.designLayerPlanes.forEach((plane) => plane.scale.set(width, 2, 1));
  }

  private disposeDesignLayerPlanes(): void {
    this.designLayerPlanes.forEach((plane) => {
      plane.removeFromParent();
      plane.geometry.dispose();
      (plane.material as THREE.Material).dispose();
    });
    this.designLayerTextures.forEach((texture) => texture.dispose());
    this.designLayerPlanes.splice(0);
    this.designLayerTextures.splice(0);
  }

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.loop?.stop();
    this.loop = null;
    window.dispatchEvent(new CustomEvent('studio:webgl-status', { detail: 'lost' }));
  };

  private onContextRestored = (): void => {
    this.contextLost = false;
    this.composition.resize(this.canvas.width, this.canvas.height);
    this.startComposition();
    window.dispatchEvent(new CustomEvent('studio:webgl-status', { detail: 'restored' }));
  };

  dispose(): void {
    this.loop?.stop();
    this.resizeObserver.disconnect();
    this.renderer.three.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.three.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.composition.dispose();
    this.disposeDesignLayerPlanes();
    this.audioEngine.dispose();
    this.renderer.dispose();
  }
}
