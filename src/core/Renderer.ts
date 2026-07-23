import * as THREE from 'three';
import type { Canvas } from './Canvas';

export class Renderer {
  readonly three: THREE.WebGLRenderer;
  private readonly canvas: Canvas;

  constructor(canvas: Canvas) {
    this.canvas = canvas;
    this.three = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.three.setClearColor(0x000000, 0);
    this.three.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.three.setSize(canvas.width, canvas.height, false);
    canvas.element.appendChild(this.three.domElement);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.three.render(scene, camera);
  }

  resize(): void {
    this.three.setSize(this.canvas.width, this.canvas.height, false);
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
