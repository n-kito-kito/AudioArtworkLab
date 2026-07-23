import './style.css';
import { FileAudioEngine } from './audio/FileAudioEngine';
import { App } from './core/App';
import { COMPOSITIONS, createComposition } from './compositions/catalog';
import { AudioControls } from './ui/AudioControls';
import { StudioControls } from './ui/StudioControls';
import { StudioShell } from './ui/StudioShell';
import { LayerEditor } from './ui/LayerEditor';
import { RecordingController } from './ui/RecordingController';
import { QualityMonitor } from './ui/QualityMonitor';

const container = document.querySelector<HTMLDivElement>('#app');

if (!container) {
  throw new Error('App container not found');
}

const audioEngine = new FileAudioEngine();
let composition = createComposition('SineWaveBasic');
const shell = new StudioShell(container);
const app = new App(shell.canvasHost, composition, audioEngine);
const audioControls = new AudioControls(shell.leftPanel, audioEngine);
const layerEditor = new LayerEditor(shell, audioEngine);
const recordingController = new RecordingController(shell, audioEngine);
const studioControls = new StudioControls(shell, composition, audioEngine, app, layerEditor, () =>
  layerEditor.exportPng(),
  () => recordingController.toggle(),
  COMPOSITIONS,
  (name) => {
    composition = createComposition(name);
    app.setComposition(composition);
    return composition;
  },
);
const qualityMonitor = new QualityMonitor(shell, app, () => composition.getEffects());
let disposed = false;

const dispose = (): void => {
  if (disposed) return;
  disposed = true;
  audioControls.dispose();
  recordingController.dispose();
  qualityMonitor.dispose();
  layerEditor.dispose();
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
