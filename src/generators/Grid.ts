import * as THREE from 'three';
import type { GeneratorContext, VisualGenerator } from './Generator';

const DIVISIONS = 14;

export class Grid implements VisualGenerator {
  readonly name = 'Grid';
  private grid: THREE.LineSegments | null = null;
  private material: THREE.LineBasicMaterial | null = null;
  private audioEngine: GeneratorContext['audioEngine'] | null = null;
  private visible = false;

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.grid) this.grid.visible = visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  create({ scene, audioEngine }: GeneratorContext): void {
    this.audioEngine = audioEngine;
    const positions: number[] = [];
    for (let index = 0; index <= DIVISIONS; index++) {
      const position = -1 + (index / DIVISIONS) * 2;
      positions.push(-1, position, 0, 1, position, 0);
      positions.push(position, -1, 0, position, 1, 0);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.material = new THREE.LineBasicMaterial({
      color: 0x9cff57,
      transparent: true,
      opacity: 0.52,
    });
    this.grid = new THREE.LineSegments(geometry, this.material);
    this.grid.visible = this.visible;
    scene.add(this.grid);
  }

  update(elapsed: number): void {
    if (!this.grid || !this.material) return;
    const audio = this.audioEngine?.getParameters();
    const volume = audio?.volume ?? 0;
    const bass = audio?.bass ?? 0;
    this.grid.rotation.z = Math.sin(elapsed * 0.18) * 0.08 + bass * 0.12;
    const scale = 1 + volume * 0.12;
    this.grid.scale.setScalar(scale);
    this.material.opacity = 0.42 + volume * 0.45;
  }

  dispose(): void {
    if (!this.grid) return;
    this.grid.geometry.dispose();
    this.material?.dispose();
    this.grid.removeFromParent();
    this.grid = null;
    this.material = null;
    this.audioEngine = null;
  }
}
