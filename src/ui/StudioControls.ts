import type { FileAudioEngine } from '../audio/FileAudioEngine';
import type { SineWaveBasic } from '../compositions/SineWaveBasic';
import type { AudioSource, Effect } from '../effects/Effect';
import type { AudioReactionParameters, SineWaveParameters } from '../generators/SineWave';

type NumericKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

export class StudioControls {
  private readonly root = document.createElement('aside');
  private readonly revealButton = document.createElement('button');
  private readonly composition: SineWaveBasic;
  private readonly audioEngine: FileAudioEngine;
  private readonly onVisibilityChange: (visible: boolean) => void;
  private guiVisible = true;

  constructor(
    container: HTMLElement,
    composition: SineWaveBasic,
    audioEngine: FileAudioEngine,
    onVisibilityChange: (visible: boolean) => void,
  ) {
    this.composition = composition;
    this.audioEngine = audioEngine;
    this.onVisibilityChange = onVisibilityChange;
    this.root.className = 'studio-panel';
    this.root.setAttribute('aria-label', 'Visual controls');
    this.revealButton.className = 'studio-reveal';
    this.revealButton.type = 'button';
    this.revealButton.textContent = 'GUI';
    this.revealButton.hidden = true;
    this.revealButton.addEventListener('click', this.toggleGui);
    this.build();
    container.append(this.root, this.revealButton);
  }

  dispose(): void {
    this.root.remove();
    this.revealButton.remove();
  }

  private build(): void {
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = 'VISUAL LAB';
    const collapse = this.button(
      '−',
      () => this.root.classList.toggle('is-collapsed'),
      'Toggle side panel',
    );
    const hide = this.button('HIDE', this.toggleGui, 'Hide GUI');
    const fullscreen = this.button('FULL', () => void this.toggleFullscreen(), 'Toggle fullscreen');
    header.append(title, collapse, hide, fullscreen);

    const body = document.createElement('div');
    body.className = 'studio-panel__body';
    body.append(
      this.buildGeneratorSection(),
      this.buildReactionSection(),
      this.buildEffectSection(),
    );
    this.root.append(header, body);
  }

  private buildGeneratorSection(): HTMLElement {
    const section = this.section('GENERATOR');
    const settings = this.composition.sineWave.getParameters();
    section.append(
      this.range('Amplitude', settings.amplitude, 0.02, 1, 0.01, (value) =>
        this.setSine('amplitude', value),
      ),
      this.range('Frequency', settings.frequency, 0.5, 16, 0.1, (value) =>
        this.setSine('frequency', value),
      ),
      this.range('Speed', settings.speed, 0, 4, 0.01, (value) => this.setSine('speed', value)),
      this.range('Opacity', settings.opacity, 0.05, 1, 0.01, (value) =>
        this.setSine('opacity', value),
      ),
    );

    const color = document.createElement('label');
    color.textContent = 'Color';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = settings.color;
    input.addEventListener('input', () =>
      this.composition.sineWave.setParameters({ color: input.value }),
    );
    color.append(input);
    section.append(
      color,
      this.toggle('Waveform', false, (value) => this.composition.waveform.setVisible(value)),
    );
    return section;
  }

  private buildReactionSection(): HTMLElement {
    const section = this.section('AUDIO REACTION');
    const reaction = this.composition.sineWave.getAudioReaction();
    section.append(
      this.range('Bass → Amp', reaction.bassStrength, 0, 2, 0.01, (value) =>
        this.setReaction('bassStrength', value),
      ),
      this.range('Mid → Freq', reaction.midStrength, 0, 2, 0.01, (value) =>
        this.setReaction('midStrength', value),
      ),
      this.range('Treble → Color', reaction.trebleStrength, 0, 2, 0.01, (value) =>
        this.setReaction('trebleStrength', value),
      ),
      this.range('Beat sensitivity', 0.08, 0.01, 0.3, 0.01, (value) =>
        this.audioEngine.setBeatSensitivity(value),
      ),
      this.range('Amp min', reaction.amplitudeMin, 0, 0.8, 0.01, (value) =>
        this.setReaction('amplitudeMin', value),
      ),
      this.range('Amp max', reaction.amplitudeMax, 0.1, 1.2, 0.01, (value) =>
        this.setReaction('amplitudeMax', value),
      ),
      this.range('Freq min', reaction.frequencyMin, 0.5, 10, 0.1, (value) =>
        this.setReaction('frequencyMin', value),
      ),
      this.range('Freq max', reaction.frequencyMax, 2, 20, 0.1, (value) =>
        this.setReaction('frequencyMax', value),
      ),
      this.range('Smoothing', reaction.smoothing, 0, 0.98, 0.01, (value) => {
        this.setReaction('smoothing', value);
        this.audioEngine.setAnalysisSmoothing(value);
      }),
    );
    return section;
  }

  private buildEffectSection(): HTMLElement {
    const section = this.section('EFFECT PIPELINE');
    for (const effect of this.composition.getEffects()) section.append(this.effectRow(effect));
    return section;
  }

  private effectRow(effect: Effect): HTMLElement {
    const row = document.createElement('div');
    row.className = 'effect-row';
    const top = document.createElement('div');
    top.append(
      this.toggle(effect.name, effect.enabled, (value) => {
        effect.enabled = value;
      }),
      this.button('↑', () => this.moveEffect(effect, row, -1), `Move ${effect.name} up`),
      this.button('↓', () => this.moveEffect(effect, row, 1), `Move ${effect.name} down`),
    );
    const intensityMax = ['Blur', 'RGB Split', 'Glitch', 'Warp', 'Scan Drift'].includes(effect.name)
      ? 0.1
      : 1;
    top.className = 'effect-row__top';
    row.append(
      top,
      this.range('Amount', effect.intensity, 0, intensityMax, 0.001, (value) => {
        effect.intensity = value;
      }),
    );

    const audio = document.createElement('label');
    audio.textContent = 'React to';
    const select = document.createElement('select');
    for (const source of ['none', 'volume', 'bass', 'mid', 'treble', 'beat'] as AudioSource[]) {
      const option = document.createElement('option');
      option.value = source;
      option.textContent = source.toUpperCase();
      select.append(option);
    }
    select.addEventListener('change', () => {
      effect.audioSource = select.value as AudioSource;
    });
    audio.append(select);
    row.append(audio);
    return row;
  }

  private section(title: string): HTMLElement {
    const section = document.createElement('section');
    const heading = document.createElement('h2');
    heading.textContent = title;
    section.append(heading);
    return section;
  }

  private range(
    labelText: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onInput: (value: number) => void,
  ): HTMLElement {
    const label = document.createElement('label');
    const name = document.createElement('span');
    const output = document.createElement('output');
    name.textContent = labelText;
    output.textContent = String(value);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => {
      const next = Number(input.value);
      output.textContent = String(next);
      onInput(next);
    });
    label.append(name, output, input);
    return label;
  }

  private toggle(
    labelText: string,
    checked: boolean,
    onChange: (value: boolean) => void,
  ): HTMLElement {
    const label = document.createElement('label');
    label.className = 'toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const text = document.createElement('span');
    text.textContent = labelText;
    label.append(input, text);
    return label;
  }

  private button(text: string, action: () => void, ariaLabel: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', ariaLabel);
    button.addEventListener('click', action);
    return button;
  }

  private setSine(key: NumericKey<SineWaveParameters>, value: number): void {
    this.composition.sineWave.setParameters({ [key]: value });
  }

  private setReaction(key: NumericKey<AudioReactionParameters>, value: number): void {
    this.composition.sineWave.setAudioReaction({ [key]: value });
  }

  private moveEffect(effect: Effect, row: HTMLElement, direction: -1 | 1): void {
    const sibling = direction === -1 ? row.previousElementSibling : row.nextElementSibling;
    if (!(sibling instanceof HTMLElement)) return;
    this.composition.moveEffect(effect, direction);
    if (direction === -1) sibling.before(row);
    else sibling.after(row);
  }

  private readonly toggleGui = (): void => {
    this.guiVisible = !this.guiVisible;
    this.root.hidden = !this.guiVisible;
    this.revealButton.hidden = this.guiVisible;
    this.onVisibilityChange(this.guiVisible);
  };

  private async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  }
}
