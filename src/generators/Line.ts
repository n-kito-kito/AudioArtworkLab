import * as THREE from 'three';
import type { Generator, GeneratorContext } from './Generator';

export class Line implements Generator {
  private line: THREE.Line | null = null;

  create({ scene }: GeneratorContext): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(1, 0, 0),
    ]);

    const material = new THREE.LineBasicMaterial({ color: 0xffffff });

    this.line = new THREE.Line(geometry, material);
    scene.add(this.line);
  }

  update(): void {}

  dispose(): void {
    if (!this.line) return;

    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
    this.line.removeFromParent();
    this.line = null;
  }
}
