import * as THREE from 'three';
import type { GeneratorContext, VisualGenerator } from './Generator';

const POINT_COUNT = 480;

export class Lissajous implements VisualGenerator {
  readonly name = 'Lissajous';
  private line: THREE.Line | null = null;
  private positions: Float32Array | null = null;
  private material: THREE.LineBasicMaterial | null = null;
  private audioEngine: GeneratorContext['audioEngine'] | null = null;
  private visible = false;

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.line) this.line.visible = visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  create({ scene, audioEngine }: GeneratorContext): void {
    this.audioEngine = audioEngine;
    this.positions = new Float32Array(POINT_COUNT * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.material = new THREE.LineBasicMaterial({
      color: 0xff65d8,
      transparent: true,
      opacity: 0.92,
    });
    this.line = new THREE.Line(geometry, this.material);
    this.line.visible = this.visible;
    scene.add(this.line);
  }

  update(elapsed: number): void {
    if (!this.line || !this.positions || !this.material) return;
    const audio = this.audioEngine?.getParameters();
    const bass = audio?.bass ?? 0;
    const mid = audio?.mid ?? 0;
    const treble = audio?.treble ?? 0;
    const a = 3 + bass * 2;
    const b = 2 + mid * 3;
    const phase = elapsed * (0.28 + (audio?.volume ?? 0) * 0.8);
    for (let index = 0; index < POINT_COUNT; index++) {
      const t = (index / (POINT_COUNT - 1)) * Math.PI * 2;
      this.positions[index * 3] = Math.sin(a * t + phase) * (0.72 + bass * 0.18);
      this.positions[index * 3 + 1] = Math.sin(b * t) * (0.72 + mid * 0.18);
      this.positions[index * 3 + 2] = 0;
    }
    this.line.geometry.attributes.position.needsUpdate = true;
    this.material.color.setHSL((0.9 + treble * 0.24) % 1, 0.86, 0.68);
  }

  dispose(): void {
    if (!this.line) return;
    this.line.geometry.dispose();
    this.material?.dispose();
    this.line.removeFromParent();
    this.line = null;
    this.positions = null;
    this.material = null;
    this.audioEngine = null;
  }
}
