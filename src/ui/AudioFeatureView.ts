import { FEATURE_BANDS, SILENT_FEATURES, type AudioFeatures } from '../audio/audioFeatures';

/**
 * **観察用の特徴の表示（Inspector と `?audio=1` で共有）。**
 *
 * 表示は 2 か所あるが、**解析も表示の組み立ても 1 つ**にしてある。
 * 値は engine が 1 フレーム 1 回計算した結果を読むだけで、ここでは何も計算しない
 * （`Hz` などの単位変換だけ）。
 *
 * `variant` は見せ方の違いだけ:
 * - `compact` … Inspector の折りたたみの中（既存のメーターと同じ幅・同じ CSS）
 * - `large`  … `?audio=1` の専用ページ（大きく、7 帯域を主役に）
 */

/** 出す特徴と表示名。**定義の並びがそのまま画面の並びになる。** */
const FEATURE_ROWS = [
  ['rolloff', 'Rolloff', 'エネルギー 85% の上限周波数'],
  ['spread', 'Spread', 'スペクトルの広がり'],
  ['tilt', 'Tilt', '低域寄り ⇄ 高域寄り（0.5 が中立）'],
  ['crest', 'Crest', 'ピーク ÷ RMS（パンチ感）'],
  ['onsetRate', 'Onset rate', '直近 1 秒のイベント数'],
  ['envelopeFast', 'Envelope fast', '時定数 50ms'],
  ['envelopeSlow', 'Envelope slow', '時定数 2s'],
  ['envelopeDelta', 'Envelope delta', '盛り上がり ⇄ 引き（0.5 が中立）'],
] as const satisfies readonly (readonly [keyof AudioFeatures, string, string])[];

type FeatureRowKey = (typeof FEATURE_ROWS)[number][0];

/** 生の値も併記する特徴（写した 0〜1 だけだと聴感と結びつけにくいもの）。 */
const RAW_SUFFIX: Partial<Record<FeatureRowKey, (features: AudioFeatures) => string>> = {
  rolloff: (f) => `${Math.round(f.rolloffHz)}Hz`,
  spread: (f) => `${Math.round(f.spreadHz)}Hz`,
  crest: (f) => `×${f.crestRaw.toFixed(1)}`,
  onsetRate: (f) => `${f.onsetCount}/s`,
  envelopeDelta: (f) => (f.envelopeDeltaRaw >= 0 ? '+' : '') + f.envelopeDeltaRaw.toFixed(2),
};

export type AudioFeatureVariant = 'compact' | 'large';

export class AudioFeatureView {
  readonly root = document.createElement('div');
  private readonly bars = new Map<FeatureRowKey, HTMLElement>();
  private readonly values = new Map<FeatureRowKey, HTMLElement>();
  private readonly bandBars: HTMLElement[] = [];
  private readonly bandValues: HTMLElement[] = [];

  constructor(variant: AudioFeatureVariant = 'compact') {
    this.root.className = `audio-features audio-features--${variant}`;
    this.root.append(this.buildBands(variant), this.buildRows());
  }

  /** 値を書き込む。**engine が計算済みの結果を読むだけ**で、ここでは何も計算しない。 */
  update(features: AudioFeatures | null): void {
    const f = features ?? SILENT_FEATURES;
    for (const [key] of FEATURE_ROWS) {
      const amount = Math.min(Math.max(Number(f[key]) || 0, 0), 1);
      const bar = this.bars.get(key);
      const value = this.values.get(key);
      if (bar) bar.style.setProperty('--fill', `${(amount * 100).toFixed(1)}%`);
      if (!value) continue;
      const raw = RAW_SUFFIX[key];
      value.textContent = raw ? `${amount.toFixed(2)}  ${raw(f)}` : amount.toFixed(2);
    }
    for (let index = 0; index < this.bandBars.length; index++) {
      const amount = Math.min(Math.max(f.bands[index] ?? 0, 0), 1);
      this.bandBars[index]!.style.setProperty('--fill', `${(amount * 100).toFixed(1)}%`);
      this.bandValues[index]!.textContent = amount.toFixed(2);
    }
  }

  /** **7 帯域の対数分割エネルギー。** 画面の主役なので先に置く。 */
  private buildBands(variant: AudioFeatureVariant): HTMLElement {
    const group = document.createElement('div');
    group.className = 'audio-features__bands';
    const heading = document.createElement('h3');
    heading.className = 'control-subheading';
    heading.textContent = '7 bands (log)';
    group.append(heading);
    for (const band of FEATURE_BANDS) {
      const row = document.createElement('div');
      row.className = 'audio-features__row';
      const name = document.createElement('span');
      name.textContent =
        variant === 'large' ? `${band.label} (${band.range[0]}–${band.range[1]}Hz)` : band.label;
      const bar = document.createElement('i');
      const value = document.createElement('output');
      value.textContent = '0.00';
      row.append(name, bar, value);
      group.append(row);
      this.bandBars.push(bar);
      this.bandValues.push(value);
    }
    return group;
  }

  private buildRows(): HTMLElement {
    const group = document.createElement('div');
    group.className = 'audio-features__rows';
    const heading = document.createElement('h3');
    heading.className = 'control-subheading';
    heading.textContent = 'Derived features';
    group.append(heading);
    for (const [key, label, note] of FEATURE_ROWS) {
      const row = document.createElement('div');
      row.className = 'audio-features__row';
      const name = document.createElement('span');
      name.textContent = label;
      name.title = note;
      const bar = document.createElement('i');
      const value = document.createElement('output');
      value.textContent = '0.00';
      row.append(name, bar, value);
      group.append(row);
      this.bars.set(key, bar);
      this.values.set(key, value);
    }
    return group;
  }
}
