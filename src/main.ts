import './style.css';
import { FileAudioEngine } from './audio/FileAudioEngine';
import { REFERENCE_AUDIO_NAME, REFERENCE_AUDIO_URL } from './audio/referenceAudio';
import { App } from './core/App';
import { Cymatics } from './fields/Cymatics';
import { FieldComposition } from './engine/FieldComposition';
import { RENDERERS, createRenderer } from './renderers/catalog';
import { AudioControls } from './ui/AudioControls';
import { StudioShell } from './ui/StudioShell';

// 再構築中（DESIGN.md 実装順序）。
// StudioControls / LayerEditor / RecordingController / QualityMonitor は
// 旧 Generator 前提のため、Field / Renderer 選択の UI ができるまで接続しない。
// LayerEditor は D1 により温存する（削除しない）。

const container = document.querySelector<HTMLDivElement>('#app');

if (!container) {
  throw new Error('App container not found');
}

const audioEngine = new FileAudioEngine();

// Renderer の選択 UI ができるまでは、URL の ?renderer= で表現を切り替えられる。
// 例: http://localhost:5173/?renderer=Light%20wave
const rendererParam = new URLSearchParams(location.search).get('renderer');
let composition = new FieldComposition(
  new Cymatics(),
  createRenderer(rendererParam ?? RENDERERS[0]!.name),
);
const shell = new StudioShell(container);
const app = new App(shell.canvasHost, composition, audioEngine);

const setRenderer = (name: string): FieldComposition => {
  composition = new FieldComposition(new Cymatics(), createRenderer(name));
  app.setComposition(composition);
  return composition;
};
const audioControls = new AudioControls(shell.leftTop, audioEngine);
let disposed = false;

// 確認用音源を既定で読み込む。無ければ何もしない（起動は妨げない）。
// 再生はブラウザの制約により利用者の操作が要るため、ここでは読み込みだけ行う。
void audioControls.loadReference(REFERENCE_AUDIO_URL, REFERENCE_AUDIO_NAME);

const dispose = (): void => {
  if (disposed) return;
  disposed = true;
  audioControls.dispose();
  app.dispose();
  shell.dispose();
};

// 開発時のみ。音がないと何も描かれない仕様のため、
// 解析値を差し替えて描画を確認できるようにしておく。本番ビルドには含まれない。
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__lab = {
    app,
    audioEngine,
    setRenderer,
    get composition() {
      return composition;
    },
  };
}

window.addEventListener('beforeunload', dispose, { once: true });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener('beforeunload', dispose);
    dispose();
  });
}
