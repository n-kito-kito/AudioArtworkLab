export type AudioParameters = Record<string, number>;

export interface AudioEngine {
  getParameters(): AudioParameters;
}
