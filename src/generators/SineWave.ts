import * as THREE from 'three';
import type { Generator, GeneratorContext } from './Generator';

const SEGMENT_COUNT = 256;
const X_MIN = -1;
const X_MAX = 1;

export class SineWave implements Generator {
  private line: THREE.Line | null = null;
  private material: THREE.LineBasicMaterial | null = null;
  private positions: Float32Array | null = null;
  private audioEngine: GeneratorContext['audioEngine'] | null = null;

  private amplitude = 0.25;
  private frequency = 3;
  private speed = 0.4;

  create({ scene, audioEngine }: GeneratorContext): void {
    this.audioEngine = audioEngine;

    const geometry = new THREE.BufferGeometry().setFromPoints(this.buildPoints(0));
    this.positions = geometry.attributes.position.array as Float32Array;

    this.material = new THREE.LineBasicMaterial({ color: 0xffffff });

    this.line = new THREE.Line(geometry, this.material);
    scene.add(this.line);
  }

  update(elapsed: number): void {
    if (!this.positions || !this.line) return;

    const audio = this.audioEngine?.getParameters();
    const isAudioReactive = audio?.active === 1;
    const amplitude = isAudioReactive
      ? 0.18 + (audio.bass ?? 0) * 0.6 + (audio.beat ?? 0) * 0.12
      : (audio?.amplitude ?? this.amplitude);
    const frequency = isAudioReactive
      ? 2 + (audio.mid ?? 0) * 8
      : (audio?.frequency ?? this.frequency);
    const speed = isAudioReactive ? 0.35 + (audio.volume ?? 0) * 2.5 : (audio?.speed ?? this.speed);

    if (this.material) {
      const hue = 0.55 + (audio?.treble ?? 0) * 0.28;
      const lightness = isAudioReactive ? 0.62 + (audio.volume ?? 0) * 0.3 : 1;
      this.material.color.setHSL(hue, isAudioReactive ? 0.85 : 0, lightness);
    }

    const phase = elapsed * speed;
    const pointCount = SEGMENT_COUNT + 1;

    for (let i = 0; i < pointCount; i++) {
      const t = i / SEGMENT_COUNT;
      const x = X_MIN + t * (X_MAX - X_MIN);
      const y = amplitude * Math.sin(frequency * Math.PI * x + phase);

      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = y;
    }

    this.line.geometry.attributes.position.needsUpdate = true;
  }

  private buildPoints(phase: number): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];

    for (let i = 0; i <= SEGMENT_COUNT; i++) {
      const t = i / SEGMENT_COUNT;
      const x = X_MIN + t * (X_MAX - X_MIN);
      const y = this.amplitude * Math.sin(this.frequency * Math.PI * x + phase);

      points.push(new THREE.Vector3(x, y, 0));
    }

    return points;
  }

  dispose(): void {
    if (!this.line) return;

    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
    this.line.removeFromParent();
    this.line = null;
    this.positions = null;
    this.audioEngine = null;
    this.material = null;
  }
}
