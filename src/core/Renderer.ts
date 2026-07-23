import * as THREE from 'three';
import type { Canvas } from './Canvas';

export class Renderer {
  readonly three: THREE.WebGLRenderer;
  private readonly canvas: Canvas;
  private resolutionScale = 1;

  constructor(canvas: Canvas) {
    this.canvas = canvas;
    this.three = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.three.setClearColor(0x000000, 0);
    this.updatePixelRatio();
    this.three.setSize(canvas.width, canvas.height, false);
    canvas.element.appendChild(this.three.domElement);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.three.render(scene, camera);
  }

  resize(): void {
    this.updatePixelRatio();
    this.three.setSize(this.canvas.width, this.canvas.height, false);
  }

  setResolutionScale(scale: number): void {
    this.resolutionScale = Math.min(Math.max(scale, 0.5), 2);
    this.resize();
  }

  private updatePixelRatio(): void {
    this.three.setPixelRatio(Math.min(window.devicePixelRatio * this.resolutionScale, 3));
  }

  exportPng(filename: string): void {
    const link = document.createElement('a');
    link.download = filename;
    link.href = this.three.domElement.toDataURL('image/png');
    link.click();
  }

  dispose(): void {
    this.three.dispose();
  }
}
