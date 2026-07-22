import './style.css';
import { FileAudioEngine } from './audio/FileAudioEngine';
import { App } from './core/App';
import { SineWaveBasic } from './compositions/SineWaveBasic';
import { AudioControls } from './ui/AudioControls';

const container = document.querySelector<HTMLDivElement>('#app');

if (!container) {
  throw new Error('App container not found');
}

const audioEngine = new FileAudioEngine();
const app = new App(container, new SineWaveBasic(), audioEngine);
const audioControls = new AudioControls(container, audioEngine);
let disposed = false;

const dispose = (): void => {
  if (disposed) return;
  disposed = true;
  audioControls.dispose();
  app.dispose();
};

window.addEventListener('beforeunload', dispose, { once: true });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener('beforeunload', dispose);
    dispose();
  });
}
