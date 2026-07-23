import * as THREE from 'three';
import type { GeneratorContext, VisualGenerator } from './Generator';

const PARTICLE_COUNT = 900;

export class ParticleField implements VisualGenerator {
  readonly name = 'ParticleField';
  private points: THREE.Points | null = null;
  private material: THREE.PointsMaterial | null = null;
  private positions: Float32Array | null = null;
  private basePositions: Float32Array | null = null;
  private phases: Float32Array | null = null;
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
    this.positions = new Float32Array(PARTICLE_COUNT * 3);
    this.basePositions = new Float32Array(PARTICLE_COUNT * 2);
    this.phases = new Float32Array(PARTICLE_COUNT);

    for (let index = 0; index < PARTICLE_COUNT; index++) {
      const radiusNoise = this.noise(index * 2.17);
      const angleNoise = this.noise(index * 5.31);
      const radius = Math.sqrt(radiusNoise) * 0.92;
      const angle = angleNoise * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      this.basePositions[index * 2] = x;
      this.basePositions[index * 2 + 1] = y;
      this.phases[index] = this.noise(index * 9.73) * Math.PI * 2;
      this.positions[index * 3] = x;
      this.positions[index * 3 + 1] = y;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.material = new THREE.PointsMaterial({
      color: 0x7ee8ff,
      size: 2.2,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.visible = this.visible;
    scene.add(this.points);
  }

  update(elapsed: number): void {
    if (!this.points || !this.positions || !this.basePositions || !this.phases || !this.material) {
      return;
    }
    const audio = this.audioEngine?.getParameters();
    const volume = audio?.volume ?? 0;
    const bass = audio?.bass ?? 0;
    const treble = audio?.treble ?? 0;
    const beat = audio?.beat ?? 0;
    const expansion = 1 + volume * 0.12 + bass * 0.28;

    for (let index = 0; index < PARTICLE_COUNT; index++) {
      const baseX = this.basePositions[index * 2] ?? 0;
      const baseY = this.basePositions[index * 2 + 1] ?? 0;
      const phase = this.phases[index] ?? 0;
      const drift = 0.018 + treble * 0.025 + beat * 0.04;
      this.positions[index * 3] =
        baseX * expansion + Math.sin(elapsed * 0.55 + phase) * drift;
      this.positions[index * 3 + 1] =
        baseY * expansion + Math.cos(elapsed * 0.48 + phase * 1.37) * drift;
      this.positions[index * 3 + 2] = 0;
    }

    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.rotation.z = elapsed * (0.025 + volume * 0.05);
    this.material.size = 1.8 + treble * 3.5 + beat * 1.8;
    this.material.opacity = 0.58 + volume * 0.36;
    this.material.color.setHSL((0.53 + treble * 0.25) % 1, 0.9, 0.68);
  }

  private noise(value: number): number {
    const result = Math.sin(value * 12.9898) * 43758.5453;
    return result - Math.floor(result);
  }

  dispose(): void {
    if (!this.points) return;
    this.points.geometry.dispose();
    this.material?.dispose();
    this.points.removeFromParent();
    this.points = null;
    this.material = null;
    this.positions = null;
    this.basePositions = null;
    this.phases = null;
    this.audioEngine = null;
  }
}
