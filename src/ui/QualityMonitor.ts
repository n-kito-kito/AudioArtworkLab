import type { Effect } from '../effects/Effect';
import type { App } from '../core/App';
import type { StudioShell } from './StudioShell';

export class QualityMonitor {
  private readonly shell: StudioShell;
  private readonly app: App;
  private readonly getEffects: () => readonly Effect[];
  private readonly badge = document.createElement('div');
  private readonly panel = document.createElement('section');
  private frame = 0;
  private previous = performance.now();
  private samples: number[] = [];

  constructor(shell: StudioShell, app: App, getEffects: () => readonly Effect[]) {
    this.shell = shell;
    this.app = app;
    this.getEffects = getEffects;
    this.badge.className = 'fps-badge';
    this.badge.textContent = 'FPS --';
    this.panel.className = 'panel-section visual-section quality-panel';
    this.buildPanel();
    this.shell.toolbar.append(this.badge);
    this.shell.leftPanel.append(this.panel);
    window.addEventListener('studio:webgl-status', this.onWebGlStatus);
    this.frame = requestAnimationFrame(this.update);
  }

  private buildPanel(): void {
    const title = document.createElement('h2');
    title.innerHTML = '<i class="ph ph-gauge"></i><span>QUALITY</span>';
    const resolution = document.createElement('label');
    resolution.className = 'control-row control-row--inline';
    resolution.innerHTML = '<span>Resolution</span>';
    const select = document.createElement('select');
    for (const [label, value] of [
      ['50%', '0.5'],
      ['75%', '0.75'],
      ['100%', '1'],
      ['150%', '1.5'],
      ['200%', '2'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = value === '1';
      select.append(option);
    }
    select.addEventListener('change', () => this.app.setResolutionScale(Number(select.value)));
    resolution.append(select);
    const benchmark = document.createElement('button');
    benchmark.type = 'button';
    benchmark.className = 'ui-button';
    benchmark.innerHTML = '<i class="ph ph-timer"></i><span>Benchmark effects</span>';
    benchmark.addEventListener('click', () => void this.benchmarkEffects(benchmark));
    this.panel.append(title, resolution, benchmark);
  }

  private update = (now: number): void => {
    const delta = now - this.previous;
    this.previous = now;
    this.samples.push(delta);
    if (this.samples.length >= 30) {
      const average = this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length;
      this.badge.textContent = `FPS ${Math.round(1000 / average)}`;
      this.samples = [];
    }
    this.frame = requestAnimationFrame(this.update);
  };

  private async benchmarkEffects(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    const effects = [...this.getEffects()];
    const states = effects.map((effect) => effect.enabled);
    const results: string[] = [];
    try {
      for (const effect of effects) effect.enabled = false;
      for (const effect of effects) {
        effect.enabled = true;
        const frameTimes = await this.measureFrames(18);
        const average = frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length;
        results.push(`${effect.name}: ${average.toFixed(1)}ms`);
        effect.enabled = false;
      }
      window.alert(`Effect frame cost\n\n${results.join('\n')}`);
    } finally {
      effects.forEach((effect, index) => {
        effect.enabled = states[index] ?? false;
      });
      button.disabled = false;
    }
  }

  private measureFrames(count: number): Promise<number[]> {
    return new Promise((resolve) => {
      const values: number[] = [];
      let previous = performance.now();
      const measure = (now: number): void => {
        values.push(now - previous);
        previous = now;
        if (values.length >= count) resolve(values.slice(3));
        else requestAnimationFrame(measure);
      };
      requestAnimationFrame(measure);
    });
  }

  private onWebGlStatus = (event: Event): void => {
    const status = (event as CustomEvent<string>).detail;
    this.badge.textContent = status === 'lost' ? 'WEBGL LOST' : 'WEBGL RESTORED';
    this.badge.classList.toggle('is-error', status === 'lost');
  };

  dispose(): void {
    cancelAnimationFrame(this.frame);
    window.removeEventListener('studio:webgl-status', this.onWebGlStatus);
    this.badge.remove();
    this.panel.remove();
  }
}
