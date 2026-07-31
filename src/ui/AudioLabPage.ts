import type { FileAudioEngine } from '../audio/FileAudioEngine';
import { getSourceShelf, type AudioSourceShelf } from '../engine/binding/sources';
import { AudioFeatureView } from './AudioFeatureView';

/**
 * **解析専用の開発ページ（`?audio=1`）。**
 *
 * 表現は描かず、音から取れる特徴だけを大きく並べる。
 * 実曲を流しながら**値と聴感の対応を観察する**ためだけの画面で、
 * ここから見え方へ繋がっているものは 1 本もない（接続は次のフェーズ）。
 *
 * `?tune=1` と同じく `import.meta.env.DEV` の下でしか組み立てないので、
 * **本番ビルドには入らない**（`main.ts` 側でガードする）。
 *
 * 解析は engine が 1 フレーム 1 回やった結果を読むだけで、
 * 表示の組み立ても Inspector と同じ `AudioFeatureView` を共有する（二重に計算しない）。
 */
export class AudioLabPage {
  private readonly root = document.createElement('section');
  private readonly view = new AudioFeatureView('large');
  private readonly clock = document.createElement('output');
  private readonly engine: FileAudioEngine;
  private animationId: number | null = null;
  /**
   * **結線に使える内部ソースの棚。** ここでは表示するだけ。
   * 棚は engine ごとに 1 つなので、表現が同時に読んでも解析は二重にならない。
   */
  private readonly shelf: AudioSourceShelf;
  private readonly sourceBars = new Map<string, HTMLElement>();
  private readonly sourceValues = new Map<string, HTMLElement>();
  private previousTime = -1;

  constructor(host: HTMLElement, engine: FileAudioEngine) {
    this.engine = engine;
    this.root.className = 'audio-lab';
    this.root.setAttribute('aria-label', 'Audio analysis page (development)');

    const heading = document.createElement('header');
    heading.className = 'audio-lab__heading';
    const title = document.createElement('h1');
    title.textContent = 'Audio Analysis';
    const note = document.createElement('p');
    note.textContent =
      '観察専用（?audio=1）。表現は描画していない。ここから見え方へ繋がっている接続は 1 本もない。';
    this.clock.className = 'audio-lab__clock';
    this.clock.textContent = '0:00';
    heading.append(title, note, this.clock);

    this.shelf = getSourceShelf(engine);
    this.root.append(heading, this.buildSources(), this.view.root);
    host.append(this.root);
    this.animationId = requestAnimationFrame(this.update);
  }

  /**
   * 既存の Audio コントロール(読み込み・再生・シーク)をこのページの中へ移設する。
   * このページは画面全体を覆うため、左パネルのコントロールには届かない。
   * 新しいインスタンスを作らないのは、ドラッグ&ドロップの window リスナーが
   * 二重になるのを避けるため。dispose 時は何もしない(元のオーナーが面倒を見る)。
   */
  adoptControls(element: HTMLElement): void {
    element.classList.add('audio-lab__controls');
    this.root.insertBefore(element, this.view.root);
  }

  /** 結線できるソースの棚。**特徴の表示とは別枠**で「繋げるもの」だけを並べる。 */
  private buildSources(): HTMLElement {
    const group = document.createElement('div');
    group.className = 'audio-features audio-features--large audio-lab__sources';
    const block = document.createElement('div');
    block.className = 'audio-features__bands';
    const heading = document.createElement('h3');
    heading.className = 'control-subheading';
    heading.textContent = 'Binding sources (結線できる音)';
    block.append(heading);
    for (const source of this.shelf.visible()) {
      const row = document.createElement('div');
      row.className = 'audio-features__row';
      const name = document.createElement('span');
      name.textContent = `${source.label} · ${source.kind}`;
      const bar = document.createElement('i');
      const value = document.createElement('output');
      value.textContent = '0.00';
      row.append(name, bar, value);
      block.append(row);
      this.sourceBars.set(source.id, bar);
      this.sourceValues.set(source.id, value);
    }
    group.append(block);
    return group;
  }

  private readonly update = (): void => {
    // 表現が回っていないページなので、ここが棚を進める。
    // 同じフレームで表現が先に進めていれば、棚の側が二重更新を弾く。
    const now = performance.now() / 1000;
    const delta = this.previousTime < 0 ? 0 : Math.min(Math.max(now - this.previousTime, 0), 0.25);
    this.previousTime = now;
    this.shelf.update(delta);
    for (const source of this.shelf.visible()) {
      const amount = Math.min(Math.max(source.value(), 0), 1);
      this.sourceBars.get(source.id)?.style.setProperty('--fill', `${(amount * 100).toFixed(1)}%`);
      const value = this.sourceValues.get(source.id);
      if (value) value.textContent = amount.toFixed(2);
    }
    this.view.update(this.engine.getFeatures());
    const audio = this.engine.currentTime;
    const minutes = Math.floor(audio / 60);
    const seconds = Math.floor(audio % 60);
    this.clock.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
    this.animationId = requestAnimationFrame(this.update);
  };

  dispose(): void {
    if (this.animationId !== null) cancelAnimationFrame(this.animationId);
    this.animationId = null;
    this.root.remove();
  }
}
