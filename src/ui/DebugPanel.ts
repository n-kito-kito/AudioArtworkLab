import type { AudioEngine } from '../audio/AudioEngine';
import type { CymaticsPlate } from '../expressions/CymaticsPlate';

/**
 * 開発用デバッグパネル（`?debug=1`・dev のみ）。
 *
 * 固有モードの励起状態と音声特徴量を表示し、
 * 振動場 / 節線候補 / 粒子密度 / 最終レンダリングを切り替えて確認できる。
 * 本番ビルドには含まれない。
 */
export class DebugPanel {
  private readonly root = document.createElement('aside');
  private readonly stats = document.createElement('pre');
  private readonly timer: number;
  private readonly getComposition: () => CymaticsPlate;
  private readonly audioEngine: AudioEngine;

  constructor(
    host: HTMLElement,
    getComposition: () => CymaticsPlate,
    audioEngine: AudioEngine,
  ) {
    this.getComposition = getComposition;
    this.audioEngine = audioEngine;
    this.root.className = 'tuning-panel debug-panel';
    this.root.setAttribute('aria-label', 'Debug (development)');

    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = 'Debug';
    header.append(title);

    const view = document.createElement('select');
    for (const [value, label] of [
      ['0', 'Final render'],
      ['1', 'Particle density'],
      ['2', 'Vibration field'],
      ['3', 'Node candidates'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      view.append(option);
    }
    view.addEventListener('change', () => this.getComposition().setDebugView(Number(view.value)));

    this.stats.className = 'debug-panel__stats';
    this.root.append(header, view, this.stats);
    host.append(this.root);

    this.timer = window.setInterval(() => this.refresh(), 200);
  }

  private refresh(): void {
    const audio = this.audioEngine.getParameters();
    const state = this.getComposition().getDebugState();
    const f = (value: number | undefined, digits = 2): string => (value ?? 0).toFixed(digits);
    const peaks = state.peaks
      .map((peak) => `${peak.hz}Hz(${peak.level.toFixed(2)})`)
      .join(' ');
    const energies = Array.from(state.energies)
      .map((energy, index) => `${index}:${energy.toFixed(1)}`)
      .join(' ');
    this.stats.textContent = [
      `RMS ${f(audio.volume)}  centroid ${f(audio.centroid)}  flatness ${f(audio.flatness)}`,
      `onset ${f(audio.onset)}  sustain ${f(audio.sustain)}`,
      `peaks: ${peaks || '-'}`,
      `primary  #${state.primary.id} ${state.primary.label} (E=${state.energies[state.primary.id]!.toFixed(2)})`,
      `previous #${state.previous.id} ${state.previous.label}  blend ${f(state.blend)}`,
      `secondary #${state.secondary.id} ${state.secondary.label}  w=${f(state.secondaryWeight)}`,
      `candidate ${state.candidate ? `#${state.candidate.id} ${state.candidate.label}` : '-'}`,
      `excitation ${f(state.excitation)}`,
      `energies ${energies}`,
    ].join('\n');
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.root.remove();
  }
}
