export interface AudioParameters {
  active?: number;
  amplitude?: number;
  frequency?: number;
  speed?: number;
  volume?: number;
  bass?: number;
  mid?: number;
  treble?: number;
  beat?: number;
}

export interface AudioEngine {
  getParameters(): AudioParameters;
  getWaveform(): Float32Array;
  dispose(): void;
}
