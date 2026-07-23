import * as THREE from 'three';
import type { GeneratorContext, VisualGenerator } from './Generator';

const COLUMNS = 42;
const ROWS = 42;

export class Bitmap implements VisualGenerator {
  readonly name = 'Bitmap';
  private points: THREE.Points | null = null;
  private material: THREE.PointsMaterial | null = null;
  private audioEngine: GeneratorContext['audioEngine'] | null = null;
  private visible = false;

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.points) this.points.visible = visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  create({ scene, audioEngine }: GeneratorContext): void {
    this.audioEngine = audioEngine;
    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();
    for (let row = 0; row < ROWS; row++) {
      for (let column = 0; column < COLUMNS; column++) {
        const x = -0.95 + (column / (COLUMNS - 1)) * 1.9;
        const y = -0.95 + (row / (ROWS - 1)) * 1.9;
        const field = Math.sin(x * 8) * Math.cos(y * 9) + Math.sin((x + y) * 13) * 0.45;
        if (field < 0.12) continue;
        positions.push(x, y, 0);
        color.setHSL(0.18 + field * 0.08, 0.9, 0.58);
        colors.push(color.r, color.g, color.b);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.material = new THREE.PointsMaterial({
      size: 2.4,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.9,
      vertexColors: true,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.visible = this.visible;
    scene.add(this.points);
  }

  update(elapsed: number): void {
    if (!this.points || !this.material) return;
    const audio = this.audioEngine?.getParameters();
    const treble = audio?.treble ?? 0;
    const beat = audio?.beat ?? 0;
    this.points.rotation.z = elapsed * 0.035 + treble * 0.08;
    this.material.size = 2.2 + treble * 3.2 + beat * 2;
    this.material.opacity = 0.72 + (audio?.volume ?? 0) * 0.28;
  }

  dispose(): void {
    if (!this.points) return;
    this.points.geometry.dispose();
    this.material?.dispose();
    this.points.removeFromParent();
    this.points = null;
    this.material = null;
    this.audioEngine = null;
  }
}
