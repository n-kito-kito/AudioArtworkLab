import * as THREE from 'three';
import type { Generator, GeneratorContext } from './Generator';

const SEGMENT_COUNT = 256;
const X_MIN = -1;
const X_MAX = 1;

export interface SineWaveParameters {
  amplitude: number;
  frequency: number;
  speed: number;
  color: string;
  opacity: number;
}

export interface AudioReactionParameters {
  bassStrength: number;
  midStrength: number;
  trebleStrength: number;
  beatStrength: number;
  amplitudeMin: number;
  amplitudeMax: number;
  frequencyMin: number;
  frequencyMax: number;
  smoothing: number;
}

const DEFAULT_PARAMETERS: SineWaveParameters = {
  amplitude: 0.25,
  frequency: 3,
  speed: 0.4,
  color: '#ffffff',
  opacity: 1,
};

const DEFAULT_REACTION: AudioReactionParameters = {
  bassStrength: 0.72,
  midStrength: 1,
  trebleStrength: 0.75,
  beatStrength: 0.12,
  amplitudeMin: 0.12,
  amplitudeMax: 0.9,
  frequencyMin: 2,
  frequencyMax: 10,
  smoothing: 0.82,
};

export class SineWave implements Generator {
  private line: THREE.Line | null = null;
  private material: THREE.LineBasicMaterial | null = null;
  private positions: Float32Array | null = null;
  private audioEngine: GeneratorContext['audioEngine'] | null = null;

  private parameters: SineWaveParameters = { ...DEFAULT_PARAMETERS };
  private reaction: AudioReactionParameters = { ...DEFAULT_REACTION };
  private smoothedAmplitude = this.parameters.amplitude;
  private smoothedFrequency = this.parameters.frequency;

  setParameters(parameters: Partial<SineWaveParameters>): void {
    this.parameters = { ...this.parameters, ...parameters };
    if (this.material) {
      this.material.color.set(this.parameters.color);
      this.material.opacity = this.parameters.opacity;
      this.material.transparent = this.parameters.opacity < 1;
    }
  }

  getParameters(): Readonly<SineWaveParameters> {
    return this.parameters;
  }

  setAudioReaction(parameters: Partial<AudioReactionParameters>): void {
    this.reaction = { ...this.reaction, ...parameters };
  }

  getAudioReaction(): Readonly<AudioReactionParameters> {
    return this.reaction;
  }

  create({ scene, audioEngine }: GeneratorContext): void {
    this.audioEngine = audioEngine;

    const geometry = new THREE.BufferGeometry().setFromPoints(this.buildPoints(0));
    this.positions = geometry.attributes.position.array as Float32Array;

    this.material = new THREE.LineBasicMaterial({
      color: this.parameters.color,
      opacity: this.parameters.opacity,
      transparent: this.parameters.opacity < 1,
    });

    this.line = new THREE.Line(geometry, this.material);
    scene.add(this.line);
  }

  update(elapsed: number): void {
    if (!this.positions || !this.line) return;

    const audio = this.audioEngine?.getParameters();
    const isAudioReactive = audio?.active === 1;
    const targetAmplitude = isAudioReactive
      ? THREE.MathUtils.clamp(
          this.reaction.amplitudeMin +
            (audio.bass ?? 0) * this.reaction.bassStrength +
            (audio.beat ?? 0) * this.reaction.beatStrength,
          this.reaction.amplitudeMin,
          this.reaction.amplitudeMax,
        )
      : (audio?.amplitude ?? this.parameters.amplitude);
    const targetFrequency = isAudioReactive
      ? THREE.MathUtils.clamp(
          this.reaction.frequencyMin +
            (audio.mid ?? 0) *
              (this.reaction.frequencyMax - this.reaction.frequencyMin) *
              this.reaction.midStrength,
          this.reaction.frequencyMin,
          this.reaction.frequencyMax,
        )
      : (audio?.frequency ?? this.parameters.frequency);
    const smoothing = THREE.MathUtils.clamp(this.reaction.smoothing, 0, 0.98);
    this.smoothedAmplitude = THREE.MathUtils.lerp(
      targetAmplitude,
      this.smoothedAmplitude,
      smoothing,
    );
    this.smoothedFrequency = THREE.MathUtils.lerp(
      targetFrequency,
      this.smoothedFrequency,
      smoothing,
    );
    const speed = isAudioReactive
      ? this.parameters.speed + (audio.volume ?? 0) * 2.5
      : (audio?.speed ?? this.parameters.speed);

    if (this.material) {
      if (isAudioReactive) {
        const baseColor = new THREE.Color(this.parameters.color);
        const hsl = { h: 0, s: 0, l: 0 };
        baseColor.getHSL(hsl);
        const hue = (hsl.h + (audio?.treble ?? 0) * 0.28 * this.reaction.trebleStrength) % 1;
        this.material.color.setHSL(hue, Math.max(hsl.s, 0.8), Math.min(hsl.l + 0.18, 0.9));
      } else {
        this.material.color.set(this.parameters.color);
      }
    }

    const phase = elapsed * speed;
    const pointCount = SEGMENT_COUNT + 1;

    for (let i = 0; i < pointCount; i++) {
      const t = i / SEGMENT_COUNT;
      const x = X_MIN + t * (X_MAX - X_MIN);
      const y = this.smoothedAmplitude * Math.sin(this.smoothedFrequency * Math.PI * x + phase);

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
      const y =
        this.parameters.amplitude * Math.sin(this.parameters.frequency * Math.PI * x + phase);

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
