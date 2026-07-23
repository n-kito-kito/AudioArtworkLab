import * as THREE from 'three';
import type { Generator, GeneratorContext } from './Generator';

const POINT_COUNT = 512;

export class Waveform implements Generator {
  private line: THREE.Line | null = null;
  private positions: Float32Array | null = null;
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
    const material = new THREE.LineBasicMaterial({
      color: 0x8fdcff,
      transparent: true,
      opacity: 0.9,
    });
    this.line = new THREE.Line(geometry, material);
    this.line.visible = this.visible;
    scene.add(this.line);
  }

  update(): void {
    if (!this.positions || !this.line || !this.audioEngine) return;
    const waveform = this.audioEngine.getWaveform();

    for (let index = 0; index < POINT_COUNT; index++) {
      const sourceIndex = Math.floor((index / (POINT_COUNT - 1)) * (waveform.length - 1));
      this.positions[index * 3] = -1 + (index / (POINT_COUNT - 1)) * 2;
      this.positions[index * 3 + 1] = (waveform[sourceIndex] ?? 0) * 0.72;
      this.positions[index * 3 + 2] = 0;
    }

    this.line.geometry.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    if (!this.line) return;
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
    this.line.removeFromParent();
    this.line = null;
    this.positions = null;
    this.audioEngine = null;
  }
}
