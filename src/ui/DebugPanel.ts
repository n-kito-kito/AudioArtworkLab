import type { AudioEngine } from '../audio/AudioEngine';
import type { ComparisonPlate } from '../expressions/ComparisonPlate';
import type { PlateExpression } from '../expressions/PlateExpression';

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
  private readonly getComposition: () => PlateExpression;
  private readonly audioEngine: AudioEngine;
  /** 比較表示のとき、左右それぞれの状態とワイプ位置を出す（?compare=1）。 */
  private readonly comparison: ComparisonPlate | null;

  constructor(
    host: HTMLElement,
    getComposition: () => PlateExpression,
    audioEngine: AudioEngine,
    comparison: ComparisonPlate | null = null,
  ) {
    this.getComposition = getComposition;
    this.audioEngine = audioEngine;
    this.comparison = comparison;
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
    this.root.append(header, view);

    // ワイプ比較。0 = V2 のみ / 1 = V1 のみ / 0.5 = 左右分割。
    if (this.comparison) {
      const row = document.createElement('label');
      row.className = 'control-row control-row--range';
      const name = document.createElement('span');
      name.textContent = 'V2 ← ワイプ → V1';
      const output = document.createElement('output');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '1';
      input.step = '0.01';
      input.value = String(this.comparison.getSplit());
      input.setAttribute('aria-label', 'Comparison wipe');
      output.textContent = input.value;
      input.addEventListener('input', () => {
        output.textContent = input.value;
        this.comparison?.setSplit(Number(input.value));
      });
      row.append(name, output, input);
      this.root.append(row);
    }

    this.root.append(this.stats);
    host.append(this.root);

    this.timer = window.setInterval(() => this.refresh(), 200);
  }

  private refresh(): void {
    if (this.collapsed) return;
    const audio = this.audioEngine.getParameters();
    const state = this.getComposition().getDebugState();
    const f = (value: number | undefined, digits = 2): string => (value ?? 0).toFixed(digits);
    const peaks = state.peaks
      .map((peak) => `${peak.hz}Hz(${peak.level.toFixed(2)})`)
      .join(' ');
    const energies = Array.from(state.energies)
      .map((energy, index) => `${index}:${energy.toFixed(1)}`)
      .join(' ');
    // 比較表示では左右の主モードを並べる（同じ音・同じ時刻での差が読める）。
    const sides = this.comparison?.getSideStates();
    const sideLines = sides
      ? [
          `left  V1 #${sides.v1.primary.id} ${sides.v1.primary.label}`,
          `right V2 #${sides.v2.primary.id} ${sides.v2.primary.label}` +
            `${sides.v2.primary.symmetry ? ` sym=${sides.v2.primary.symmetry}` : ''}`,
        ]
      : [];

    this.stats.textContent = [
      `RMS ${f(audio.volume)}  centroid ${f(audio.centroid)}  flatness ${f(audio.flatness)}`,
      `onset ${f(audio.onset)}  sustain ${f(audio.sustain)}`,
      `peaks: ${peaks || '-'}`,
      ...sideLines,
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
