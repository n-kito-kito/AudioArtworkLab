import type { AudioEngine, AudioParameters } from './AudioEngine';
import { AudioFeatureAnalyzer, SILENT_FEATURES, type AudioFeatures } from './audioFeatures';

const FFT_SIZE = 2048;
const BASS_RANGE = [20, 250] as const;
const MID_RANGE = [250, 4000] as const;
const TREBLE_RANGE = [4000, 16000] as const;
const PITCH_RANGE = [40, 4000] as const;
const CENTROID_RANGE = [100, 16000] as const;

export class FileAudioEngine implements AudioEngine {
  private readonly audio = new Audio();
  private context: AudioContext | null = null;
  private fileSource: MediaElementAudioSourceNode | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputStream: MediaStream | null = null;
  private recordingDestination: MediaStreamAudioDestinationNode | null = null;
  private analyser: AnalyserNode | null = null;
  private frequencyData: Uint8Array<ArrayBuffer> | null = null;
  private timeData: Uint8Array<ArrayBuffer> | null = null;
  private objectUrl: string | null = null;
  private previousVolume = 0;
  private beat = 0;
  private beatSensitivity = 0.08;
  private waveform = new Float32Array(FFT_SIZE);
  private onset = 0;
  private sustain = 0;
  private seed = 0;
  private wasRising = false;
  private sourceLoaded = false;
  // 自動較正（PRD D17）: 帯域ごとのピークを追従し、曲の音量差を吸収する。
  // 静かな曲でも数十秒で全レンジを使い、写像が成立するようにする。
  private readonly ceilings: Record<'volume' | 'bass' | 'mid' | 'treble', number> = {
    volume: 0.3,
    bass: 0.3,
    mid: 0.3,
    treble: 0.3,
  };
  private lastAnalysisTime = 0;
  private cachedParameters: AudioParameters | null = null;
  /**
   * **観察用の特徴（設計フェーズ①の道具）。**
   * 表現からは読まない別口で、計算は下の解析ブロックと同じ 1 フレーム 1 回。
   * 表示は Inspector と `?audio=1` の 2 か所あるが、**解析はこの 1 つを共有する**。
   */
  private readonly features = new AudioFeatureAnalyzer();
  private cachedFeatures: AudioFeatures = SILENT_FEATURES;
  /** 特徴の窓に使う連続時計（秒）。既存の判定には一切使わない。 */
  private featureClock = 0;

  constructor() {
    this.audio.preload = 'auto';
  }

  async load(file: File): Promise<void> {
    const hasAudioExtension = /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name);
    if (!file.type.startsWith('audio/') && !hasAudioExtension) {
      throw new Error('MP3またはWAVなどの音声ファイルを選択してください。');
    }

    this.stopInput();
    this.pause();
    this.releaseObjectUrl();
    this.objectUrl = URL.createObjectURL(file);
    this.audio.src = this.objectUrl;

    await this.waitForCanPlay();
    this.sourceLoaded = true;
    this.ensureAudioGraph();
  }

  /**
   * 固定パスの音源を読み込む。確認用音源（DESIGN.md「8. 確認用音源」）に使う。
   * ファイルが無い場合は例外を投げるので、呼び出し側で握りつぶしてよい。
   */
  async loadUrl(url: string): Promise<void> {
    this.stopInput();
    this.pause();
    this.releaseObjectUrl();
    this.audio.src = url;

    await this.waitForCanPlay();
    this.sourceLoaded = true;
    this.ensureAudioGraph();
  }

  private waitForCanPlay(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error('音声ファイルを読み込めませんでした。'));
      };
      const cleanup = (): void => {
        this.audio.removeEventListener('canplay', onReady);
        this.audio.removeEventListener('error', onError);
      };

      this.audio.addEventListener('canplay', onReady);
      this.audio.addEventListener('error', onError);
      this.audio.load();
    });
  }

  async play(): Promise<void> {
    if (!this.sourceLoaded) return;

    this.ensureAudioGraph();
    const resume = this.context?.state === 'suspended' ? this.context.resume() : Promise.resolve();
    await Promise.all([resume, this.audio.play()]);
  }

  async startInput(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('このブラウザはマイク入力に対応していません。');
    }
    this.pause();
    this.stopInput();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.ensureAudioGraph();
    this.inputStream = stream;
    this.inputSource = this.context!.createMediaStreamSource(stream);
    this.inputSource.connect(this.analyser!);
    await this.context?.resume();
  }

  stopInput(): void {
    this.inputSource?.disconnect();
    this.inputSource = null;
    this.inputStream?.getTracks().forEach((track) => track.stop());
    this.inputStream = null;
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

  setBeatSensitivity(value: number): void {
    this.beatSensitivity = Math.min(Math.max(value, 0.01), 0.3);
  }

  setAnalysisSmoothing(value: number): void {
    if (this.analyser) this.analyser.smoothingTimeConstant = Math.min(Math.max(value, 0), 0.99);
  }

  get isLoaded(): boolean {
    return this.sourceLoaded;
  }

  get isPlaying(): boolean {
    return this.isInputActive || (this.isLoaded && !this.audio.paused);
  }

  get isInputActive(): boolean {
    return this.inputStream?.active ?? false;
  }

  get currentTime(): number {
    return this.audio.currentTime;
  }

  get duration(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  getParameters(): AudioParameters {
    if (!this.sourceLoaded && !this.isInputActive) return {};
    if (!this.analyser || !this.frequencyData || !this.timeData || !this.context) {
      return { active: 0, volume: 0, bass: 0, mid: 0, treble: 0, beat: 0 };
    }

    // 解析は 1 フレームに 1 回で足りる。同じフレーム内の再呼び出しでは
    // 経過時間が二重に積まれないよう、直前の結果を返す。
    const now = performance.now();
    if (this.cachedParameters && now - this.lastAnalysisTime < 8) {
      return this.cachedParameters;
    }
    const delta = this.lastAnalysisTime === 0 ? 0 : Math.min((now - this.lastAnalysisTime) / 1000, 0.1);
    this.lastAnalysisTime = now;

    this.analyser.getByteFrequencyData(this.frequencyData);
    this.analyser.getByteTimeDomainData(this.timeData);

    let sumSquares = 0;
    for (const value of this.timeData) {
      const normalized = (value - 128) / 128;
      sumSquares += normalized * normalized;
    }

    const rawVolume = Math.min(Math.sqrt(sumSquares / this.timeData.length) * 2.5, 1);
    // 以降の判定はすべて正規化後の値で行う。静かな曲でもビート・オンセット・
    // 持続が立ち、写像が成立する。
    const volume = this.normalize('volume', rawVolume);
    const rise = volume - this.previousVolume;
    this.beat = rise > this.beatSensitivity && volume > 0.12 ? 1 : this.beat * 0.88;

    // 立ち上がりは瞬間値。beat と違って減衰させず、跳ねた frame だけ立てる。
    this.onset = Math.min(Math.max(rise, 0) * 8, 1);

    // L3: オンセットの立ち上がりエッジで、その瞬間のスペクトル形状をハッシュする。
    // エッジ検出により、音が立ち上がり続けている間に何度も引き直さない。
    const rising = rise > this.beatSensitivity && volume > 0.12;
    // 観察用の特徴が使う立ち上がりエッジ。**判定そのものは変えず、結果を読むだけ。**
    const onsetEdge = rising && !this.wasRising;
    if (onsetEdge) this.seed = this.hashSpectrum();
    this.wasRising = rising;
    this.previousVolume = volume;

    // 鳴っている間は伸び、止むと戻る。4 秒鳴り続けると 1 に達する。
    this.sustain = Math.min(
      Math.max(this.sustain + (volume > 0.06 ? delta / 4 : -delta / 1.5), 0),
      1,
    );

    this.cachedParameters = {
      active: this.isInputActive || !this.audio.paused ? 1 : 0,
      volume,
      bass: this.normalize('bass', this.getBandEnergy(...BASS_RANGE)),
      mid: this.normalize('mid', this.getBandEnergy(...MID_RANGE)),
      treble: this.normalize('treble', this.getBandEnergy(...TREBLE_RANGE)),
      beat: this.beat,
      pitch: this.getPitch(rawVolume),
      centroid: this.getCentroid(),
      flatness: this.getFlatness(),
      onset: this.onset,
      sustain: this.sustain,
      seed: this.seed,
    };

    // ---- 観察用の特徴（**ここから下は既存の 10 特徴に一切触れない**）----
    // 上で作った値と、既にあるオンセットの立ち上がりエッジを読むだけ。
    // `rising && !wasRising` は上で消費済みなので、同じ判定をここで作り直す代わりに
    // 直前の値を使う（`this.wasRising` は上で更新されている）。
    this.featureClock += delta;
    this.cachedFeatures = this.features.update(
      this.frequencyData,
      this.timeData,
      this.context.sampleRate / 2,
      volume,
      onsetEdge,
      this.featureClock,
      delta,
    );

    return this.cachedParameters;
  }

  /**
   * スペクトル形状を 0..1 のシードへハッシュする（FNV-1a）。
   * 粗い帯域とレベルに量子化してから畳むので、同じ音は微小な揺らぎがあっても
   * 同じシードに落ち、違う音は予測できない値になる。
   */
  private hashSpectrum(): number {
    if (!this.frequencyData) return 0;

    const bands = 24;
    const bins = this.frequencyData.length;
    let hash = 0x811c9dc5;
    for (let band = 0; band < bands; band++) {
      const start = Math.floor((band / bands) * bins);
      const end = Math.floor(((band + 1) / bands) * bins);
      let total = 0;
      for (let index = start; index < end; index++) total += this.frequencyData[index] ?? 0;
      const level = Math.min(Math.floor(total / Math.max(end - start, 1) / 32), 7);
      hash ^= level;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash / 0x100000000;
  }

  getSpectrum(): { magnitudes: Uint8Array; nyquist: number } | null {
    if (!this.frequencyData || !this.context) return null;
    return { magnitudes: this.frequencyData, nyquist: this.context.sampleRate / 2 };
  }

  /**
   * **観察用の特徴。** 表現・描画・`TUNING` からは読まない。
   * 解析は `getParameters()` と同じフレームで 1 回だけ走り、ここはその結果を返すだけ。
   */
  getFeatures(): AudioFeatures {
    return this.cachedFeatures;
  }

  getWaveform(): Float32Array {
    if (!this.timeData) return this.waveform;

    for (let index = 0; index < this.timeData.length; index++) {
      this.waveform[index] = ((this.timeData[index] ?? 128) - 128) / 128;
    }

    return this.waveform;
  }

  getRecordingStream(): MediaStream | null {
    if (!this.context || !this.analyser) return null;
    if (!this.recordingDestination) {
      this.recordingDestination = this.context.createMediaStreamDestination();
      this.analyser.connect(this.recordingDestination);
    }
    return this.recordingDestination.stream;
  }

  dispose(): void {
    this.pause();
    this.stopInput();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.fileSource?.disconnect();
    this.analyser?.disconnect();
    void this.context?.close();
    this.fileSource = null;
    this.analyser = null;
    this.context = null;
    this.frequencyData = null;
    this.timeData = null;
    this.recordingDestination = null;
    this.waveform = new Float32Array(FFT_SIZE);
    this.sourceLoaded = false;
    this.cachedParameters = null;
    this.lastAnalysisTime = 0;
    this.features.reset();
    this.cachedFeatures = SILENT_FEATURES;
    this.featureClock = 0;
    this.onset = 0;
    this.sustain = 0;
    this.seed = 0;
    this.wasRising = false;
    this.releaseObjectUrl();
  }

  private ensureAudioGraph(): void {
    if (this.context && this.analyser) return;

    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.82;
    this.fileSource = this.context.createMediaElementSource(this.audio);
    this.fileSource.connect(this.analyser);
    this.fileSource.connect(this.context.destination);
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeData = new Uint8Array(this.analyser.fftSize);
  }

  /**
   * ピーク追従の正規化。天井は音が超えれば即座に上がり、
   * 下回ると 30〜40 秒かけてゆっくり降りる。無音を増幅しないよう下限を持つ。
   */
  private normalize(key: 'volume' | 'bass' | 'mid' | 'treble', value: number): number {
    const decayed = Math.max(value, this.ceilings[key] * 0.9997);
    this.ceilings[key] = Math.min(Math.max(decayed, 0.12), 1);
    return Math.min(value / this.ceilings[key], 1);
  }

  /** 周波数を対数で 0..1 へ写す。音程や明るさは対数のほうが感覚に近い。 */
  private normalizeLog(frequency: number, min: number, max: number): number {
    if (!(frequency > 0)) return 0;
    return Math.min(Math.max(Math.log2(frequency / min) / Math.log2(max / min), 0), 1);
  }

  private getPitch(volume: number): number {
    if (!this.frequencyData || !this.context || volume < 0.04) return 0;

    const nyquist = this.context.sampleRate / 2;
    const bins = this.frequencyData.length;
    const start = Math.max(Math.floor((PITCH_RANGE[0] / nyquist) * bins), 1);
    const end = Math.min(Math.ceil((PITCH_RANGE[1] / nyquist) * bins), bins - 1);

    let peak = start;
    let peakValue = 0;
    for (let index = start; index < end; index++) {
      const value = this.frequencyData[index] ?? 0;
      if (value > peakValue) {
        peakValue = value;
        peak = index;
      }
    }
    if (peakValue < 24) return 0;

    // 放物線補間でピークのビン間位置を求め、音程が階段状に震えるのを抑える。
    const previous = this.frequencyData[peak - 1] ?? 0;
    const next = this.frequencyData[peak + 1] ?? 0;
    const denominator = previous - 2 * peakValue + next;
    const offset = denominator === 0 ? 0 : (0.5 * (previous - next)) / denominator;
    const frequency = ((peak + Math.min(Math.max(offset, -1), 1)) / bins) * nyquist;

    return this.normalizeLog(frequency, PITCH_RANGE[0], PITCH_RANGE[1]);
  }

  private getCentroid(): number {
    if (!this.frequencyData || !this.context) return 0;

    const nyquist = this.context.sampleRate / 2;
    const bins = this.frequencyData.length;
    let weighted = 0;
    let total = 0;
    for (let index = 1; index < bins; index++) {
      const magnitude = (this.frequencyData[index] ?? 0) / 255;
      weighted += ((index / bins) * nyquist) * magnitude;
      total += magnitude;
    }
    if (total <= 0) return 0;

    return this.normalizeLog(weighted / total, CENTROID_RANGE[0], CENTROID_RANGE[1]);
  }

  /** 幾何平均 / 算術平均。1 に近いほどノイズ、0 に近いほど音程のある音。 */
  private getFlatness(): number {
    if (!this.frequencyData) return 0;

    const bins = this.frequencyData.length;
    let logSum = 0;
    let sum = 0;
    let energy = 0;
    let count = 0;
    for (let index = 1; index < bins; index++) {
      const raw = (this.frequencyData[index] ?? 0) / 255;
      const magnitude = raw + 1e-6;
      energy += raw;
      logSum += Math.log(magnitude);
      sum += magnitude;
      count++;
    }
    // 無音では全ビンが下駄の値で揃い、幾何平均と算術平均が一致してしまう。
    // そのままだと「最もノイズ的」と報告されるため、エネルギーがなければ 0 を返す。
    if (count === 0 || sum <= 0 || energy / count < 1e-4) return 0;

    const arithmetic = sum / count;
    if (arithmetic <= 0) return 0;

    return Math.min(Math.max(Math.exp(logSum / count) / arithmetic, 0), 1);
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
