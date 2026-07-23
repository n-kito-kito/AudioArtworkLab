import './style.css';
import { FileAudioEngine } from './audio/FileAudioEngine';
import { App } from './core/App';
import { SineWaveBasic } from './compositions/SineWaveBasic';
import { AudioControls } from './ui/AudioControls';
import { StudioControls } from './ui/StudioControls';
import { StudioShell } from './ui/StudioShell';
import { LayerEditor } from './ui/LayerEditor';

const container = document.querySelector<HTMLDivElement>('#app');

if (!container) {
  throw new Error('App container not found');
}

const audioEngine = new FileAudioEngine();
const composition = new SineWaveBasic();
const shell = new StudioShell(container);
const app = new App(shell.canvasHost, composition, audioEngine);
const audioControls = new AudioControls(shell.leftPanel, audioEngine);
let layerEditor: LayerEditor | null = null;
const studioControls = new StudioControls(shell, composition, audioEngine, app, () =>
  layerEditor ? layerEditor.exportPng() : app.exportPng(),
);
layerEditor = new LayerEditor(shell, audioEngine);
let disposed = false;

const dispose = (): void => {
  if (disposed) return;
  disposed = true;
  audioControls.dispose();
  layerEditor?.dispose();
  studioControls.dispose();
  app.dispose();
  shell.dispose();
};

window.addEventListener('beforeunload', dispose, { once: true });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener('beforeunload', dispose);
    dispose();
  });
}
