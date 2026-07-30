import type { FileAudioEngine } from '../audio/FileAudioEngine';
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

    this.root.append(heading, this.view.root);
    host.append(this.root);
    this.animationId = requestAnimationFrame(this.update);
  }

  private readonly update = (): void => {
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
