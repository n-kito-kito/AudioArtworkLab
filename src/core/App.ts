import type { Composition } from '../compositions/Composition';
import type { AudioEngine } from '../audio/AudioEngine';
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
  private readonly composition: Composition;
  private readonly audioEngine: AudioEngine;
  private readonly resizeObserver: ResizeObserver;
  private loop: AnimationLoop | null = null;

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

    if (this.composition.animated) {
      this.loop = new AnimationLoop(
        (elapsed) => this.composition.update(elapsed),
        () => this.composition.render(),
      );
      this.loop.start();
    } else {
      this.composition.render();
    }

    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(container);
    this.onResize();
  }

  exportPng(): void {
    this.composition.render();
    this.renderer.exportPng(`audio-artwork-${Date.now()}.png`);
  }

  private onResize = (): void => {
    this.camera.resize(this.canvas.aspect);
    this.renderer.resize();
    this.composition.resize(this.canvas.width, this.canvas.height);

    if (!this.composition.animated) {
      this.composition.render();
    }
  };

  dispose(): void {
    this.loop?.stop();
    this.resizeObserver.disconnect();
    this.composition.dispose();
    this.audioEngine.dispose();
    this.renderer.dispose();
  }
}
