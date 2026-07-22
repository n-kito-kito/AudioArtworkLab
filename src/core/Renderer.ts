import * as THREE from 'three';
import type { Canvas } from './Canvas';

export class Renderer {
  readonly three: THREE.WebGLRenderer;

  constructor(canvas: Canvas) {
    this.three = new THREE.WebGLRenderer({ antialias: true });
    this.three.setPixelRatio(window.devicePixelRatio);
    this.three.setSize(window.innerWidth, window.innerHeight);
    canvas.element.appendChild(this.three.domElement);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.three.render(scene, camera);
  }

  resize(): void {
    this.three.setSize(window.innerWidth, window.innerHeight);
  }

  dispose(): void {
    this.three.dispose();
  }
}
