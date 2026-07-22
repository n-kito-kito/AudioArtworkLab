import './style.css';
import { App } from './core/App';
import { SineWaveBasic } from './compositions/SineWaveBasic';

const container = document.querySelector<HTMLDivElement>('#app');

if (!container) {
  throw new Error('App container not found');
}

new App(container, new SineWaveBasic());
