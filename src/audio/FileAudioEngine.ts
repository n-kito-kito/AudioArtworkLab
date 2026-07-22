import type { AudioEngine, AudioParameters } from './AudioEngine';

const FFT_SIZE = 2048;
const BASS_RANGE = [20, 250] as const;
const MID_RANGE = [250, 4000] as const;
const TREBLE_RANGE = [4000, 16000] as const;

export class FileAudioEngine implements AudioEngine {
  private readonly audio = new Audio();
  private context: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private frequencyData: Uint8Array<ArrayBuffer> | null = null;
  private timeData: Uint8Array<ArrayBuffer> | null = null;
  private objectUrl: string | null = null;
  private previousVolume = 0;
  private beat = 0;

  constructor() {
    this.audio.preload = 'metadata';
  }

  async load(file: File): Promise<void> {
    const hasAudioExtension = /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name);
    if (!file.type.startsWith('audio/') && !hasAudioExtension) {
      throw new Error('MP3またはWAVなどの音声ファイルを選択してください。');
    }

    this.pause();
    this.releaseObjectUrl();
    this.objectUrl = URL.createObjectURL(file);
    this.audio.src = this.objectUrl;
    this.audio.load();

    await new Promise<void>((resolve, reject) => {
      const onLoaded = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error('音声ファイルを読み込めませんでした。'));
      };
      const cleanup = (): void => {
        this.audio.removeEventListener('loadedmetadata', onLoaded);
        this.audio.removeEventListener('error', onError);
      };

      this.audio.addEventListener('loadedmetadata', onLoaded);
      this.audio.addEventListener('error', onError);
    });
  }

  async play(): Promise<void> {
    if (!this.objectUrl) return;

    this.ensureAudioGraph();
    await this.context?.resume();
    await this.audio.play();
  }

  pause(): void {
    this.audio.pause();
  }

  seek(time: number): void {
    if (!Number.isFinite(this.audio.duration)) return;
    this.audio.currentTime = Math.min(Math.max(time, 0), this.audio.duration);
  }

  setVolume(volume: number): void {
    this.audio.volume = Math.min(Math.max(volume, 0), 1);
  }

  get isLoaded(): boolean {
    return this.objectUrl !== null;
  }

  get isPlaying(): boolean {
    return this.isLoaded && !this.audio.paused;
  }

  get currentTime(): number {
    return this.audio.currentTime;
  }

  get duration(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  getParameters(): AudioParameters {
    if (!this.objectUrl) return {};
    if (!this.analyser || !this.frequencyData || !this.timeData || !this.context) {
      return { active: 0, volume: 0, bass: 0, mid: 0, treble: 0, beat: 0 };
    }

    this.analyser.getByteFrequencyData(this.frequencyData);
    this.analyser.getByteTimeDomainData(this.timeData);

    let sumSquares = 0;
    for (const value of this.timeData) {
      const normalized = (value - 128) / 128;
      sumSquares += normalized * normalized;
    }

    const volume = Math.min(Math.sqrt(sumSquares / this.timeData.length) * 2.5, 1);
    const onset = volume - this.previousVolume;
    this.beat = onset > 0.08 && volume > 0.12 ? 1 : this.beat * 0.88;
    this.previousVolume = volume;

    return {
      active: this.audio.paused ? 0 : 1,
      volume,
      bass: this.getBandEnergy(...BASS_RANGE),
      mid: this.getBandEnergy(...MID_RANGE),
      treble: this.getBandEnergy(...TREBLE_RANGE),
      beat: this.beat,
    };
  }

  dispose(): void {
    this.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.source?.disconnect();
    this.analyser?.disconnect();
    void this.context?.close();
    this.source = null;
    this.analyser = null;
    this.context = null;
    this.frequencyData = null;
    this.timeData = null;
    this.releaseObjectUrl();
  }

  private ensureAudioGraph(): void {
    if (this.context && this.analyser) return;

    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.82;
    this.source = this.context.createMediaElementSource(this.audio);
    this.source.connect(this.analyser);
    this.analyser.connect(this.context.destination);
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeData = new Uint8Array(this.analyser.fftSize);
  }

  private getBandEnergy(minFrequency: number, maxFrequency: number): number {
    if (!this.frequencyData || !this.context) return 0;

    const nyquist = this.context.sampleRate / 2;
    const start = Math.max(Math.floor((minFrequency / nyquist) * this.frequencyData.length), 0);
    const end = Math.min(
      Math.ceil((maxFrequency / nyquist) * this.frequencyData.length),
      this.frequencyData.length,
    );

    if (end <= start) return 0;

    let total = 0;
    for (let index = start; index < end; index++) {
      total += this.frequencyData[index] ?? 0;
    }

    return total / (end - start) / 255;
  }

  private releaseObjectUrl(): void {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}
