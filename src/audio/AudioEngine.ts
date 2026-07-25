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
  /** 支配的な周波数。40Hz〜4kHz を対数で 0..1 に正規化した音程。 */
  pitch?: number;
  /** スペクトル重心。音の明るさ。0..1。 */
  centroid?: number;
  /** スペクトル平坦度。1 に近いほどノイズ的、0 に近いほど音程的。0..1。 */
  flatness?: number;
  /** 立ち上がり。音量が跳ねた瞬間だけ 1 に近づく。0..1。 */
  onset?: number;
  /** 継続。鳴り続けるほど 1 に近づき、止むと戻る。0..1。 */
  sustain?: number;
  /**
   * 音の出来事のシード。オンセットの瞬間のスペクトル形状をハッシュした値。0..1。
   * 同じ音なら同じ値、違う音なら予測できない値になる。次のオンセットまで変わらない。
   * Math.random() は使わない — 乱数源は音そのもの（DESIGN.md L3）。
   */
  seed?: number;
}

export interface SpectrumFrame {
  /** FFT の振幅（0..255）。getParameters と同じフレームで更新される。 */
  magnitudes: Uint8Array;
  nyquist: number;
}

export interface AudioEngine {
  getParameters(): AudioParameters;
  getWaveform(): Float32Array;
  /** スペクトル全体。固有モードの励起計算に使う。未対応エンジンは省略可。 */
  getSpectrum?(): SpectrumFrame | null;
  dispose(): void;
}
