import * as THREE from 'three';
import type { GeneratorContext, VisualGenerator } from './Generator';

const SIZE = 13;
const TILE_COUNT = SIZE * SIZE;

export class Mosaic implements VisualGenerator {
  readonly name = 'Mosaic';
  private mesh: THREE.InstancedMesh | null = null;
  private audioEngine: GeneratorContext['audioEngine'] | null = null;
  private visible = false;
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.mesh) this.mesh.visible = visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  create({ scene, audioEngine }: GeneratorContext): void {
    this.audioEngine = audioEngine;
    const geometry = new THREE.PlaneGeometry(0.13, 0.13);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(geometry, material, TILE_COUNT);
    this.mesh.visible = this.visible;
    this.updateTiles(0, 0, 0);
    scene.add(this.mesh);
  }

  update(elapsed: number): void {
    if (!this.mesh) return;
    const audio = this.audioEngine?.getParameters();
    this.updateTiles(elapsed, audio?.bass ?? 0, audio?.treble ?? 0);
    this.mesh.rotation.z = Math.sin(elapsed * 0.12) * 0.04;
  }

  private updateTiles(elapsed: number, bass: number, treble: number): void {
    if (!this.mesh) return;
    let instance = 0;
    for (let row = 0; row < SIZE; row++) {
      for (let column = 0; column < SIZE; column++) {
        const x = -0.9 + (column / (SIZE - 1)) * 1.8;
        const y = -0.9 + (row / (SIZE - 1)) * 1.8;
        const wave = Math.sin(column * 0.72 + row * 0.48 + elapsed * 0.8);
        const scale = 0.62 + (wave * 0.5 + 0.5) * 0.28 + bass * 0.38;
        this.matrix.makeScale(scale, scale, 1);
        this.matrix.setPosition(x, y, 0);
        this.mesh.setMatrixAt(instance, this.matrix);
        this.color.setHSL((0.72 + row * 0.018 + treble * 0.18) % 1, 0.78, 0.58);
        this.mesh.setColorAt(instance, this.color);
        instance++;
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
    this.mesh = null;
    this.audioEngine = null;
  }
}
