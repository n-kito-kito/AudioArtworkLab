import type { AudioEngine } from '../audio/AudioEngine';
import type { LabExpression } from '../expressions/Expression';

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
  private collapsed = false;
  private readonly getComposition: () => LabExpression;
  private readonly audioEngine: AudioEngine;

  constructor(
    host: HTMLElement,
    getComposition: () => LabExpression,
    audioEngine: AudioEngine,
  ) {
    this.getComposition = getComposition;
    this.audioEngine = audioEngine;
    this.root.className = 'tuning-panel debug-panel';
    this.root.setAttribute('aria-label', 'Debug (development)');

    // 折りたたみ可能にする。開いたままだと Audio パネルの操作を塞ぐため。
    const header = document.createElement('header');
    header.className = 'debug-panel__header';
    const title = document.createElement('strong');
    title.textContent = 'Debug';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ui-button debug-panel__toggle';
    toggle.textContent = '−';
    toggle.setAttribute('aria-label', 'Toggle debug panel');
    toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.root.classList.toggle('is-collapsed', this.collapsed);
      toggle.textContent = this.collapsed ? '+' : '−';
    });
    header.append(title, toggle);

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
    if (this.collapsed) return;
    const audio = this.audioEngine.getParameters();
    const composition = this.getComposition();
    const state = composition.getDebugState();
    const f = (value: number | undefined, digits = 2): string => (value ?? 0).toFixed(digits);
    const head = [
      `RMS ${f(audio.volume)}  centroid ${f(audio.centroid)}  flatness ${f(audio.flatness)}`,
      `onset ${f(audio.onset)}  sustain ${f(audio.sustain)}`,
    ];
    // モード励起はサイマティクス固有の機構。持たない表現は state が null になる。
    // その場合でも音声特徴量は見たいので、モード欄だけを差し替える。
    if (!state) {
      const phase = composition.getPhase?.();
      this.stats.textContent = [
        ...head,
        phase ? `phase ${phase}` : 'no mode info for this expression',
      ].join('\n');
      return;
    }
    const peaks = state.peaks
      .map((peak) => `${peak.hz}Hz(${peak.level.toFixed(2)})`)
      .join(' ');
    const energies = Array.from(state.energies)
      .map((energy, index) => `${index}:${energy.toFixed(1)}`)
      .join(' ');
    this.stats.textContent = [
      ...head,
      `peaks: ${peaks || '-'}`,
      `primary  #${state.primary.id} ${state.primary.label}` +
        `${state.primary.symmetry ? ` sym=${state.primary.symmetry}` : ''}` +
        ` (E=${state.energies[state.primary.id]!.toFixed(2)})`,
      `previous #${state.previous.id} ${state.previous.label}  since ${f(state.sinceSwitch, 1)}s`,
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
