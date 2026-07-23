import type { FileAudioEngine } from '../audio/FileAudioEngine';
import type { SineWaveBasic } from '../compositions/SineWaveBasic';
import type { App } from '../core/App';
import type { AudioSource, Effect } from '../effects/Effect';
import type { AudioReactionParameters, SineWaveParameters } from '../generators/SineWave';
import type { StudioShell } from './StudioShell';
import type { LayerEditor } from './LayerEditor';
import {
  applyStudioPreset,
  createStudioPreset,
  type StudioPreset,
} from './StudioPreset';

type NumericKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

const EFFECT_MAX: Record<string, number> = {
  Blur: 0.1,
  'RGB Split': 0.1,
  Glitch: 0.1,
  Warp: 0.1,
  'Scan Drift': 0.1,
};

export class StudioControls {
  private readonly shell: StudioShell;
  private readonly composition: SineWaveBasic;
  private readonly audioEngine: FileAudioEngine;
  private readonly app: App;
  private readonly layerEditor: LayerEditor;
  private readonly exportArtwork: () => void;
  private readonly presetInput = document.createElement('input');
  private readonly toolbarActions = document.createElement('div');
  private readonly chainTrack = document.createElement('div');
  private leftPanelButton: HTMLButtonElement | null = null;
  private rightPanelButton: HTMLButtonElement | null = null;
  private selectedEffect: Effect;
  private seed = Math.floor(Math.random() * 99999);
  private autosaveTimer = 0;
  private static readonly PRESET_KEY = 'audio-artwork-lab:studio-preset';

  constructor(
    shell: StudioShell,
    composition: SineWaveBasic,
    audioEngine: FileAudioEngine,
    app: App,
    layerEditor: LayerEditor,
    exportArtwork?: () => void,
  ) {
    this.shell = shell;
    this.composition = composition;
    this.audioEngine = audioEngine;
    this.app = app;
    this.layerEditor = layerEditor;
    this.exportArtwork = exportArtwork ?? (() => this.app.exportPng());
    this.selectedEffect = composition.getEffects()[0]!;
    this.buildToolbar();
    this.buildLeftPanel();
    this.buildInspector();
    this.buildChain();
    this.shell.root.addEventListener('studio:restore-effect', this.restoreEffect);
    window.addEventListener('resize', this.updatePanelButtons);
    this.presetInput.type = 'file';
    this.presetInput.accept = 'application/json,.json';
    this.presetInput.hidden = true;
    this.presetInput.addEventListener('change', this.importPreset);
    this.shell.root.append(this.presetInput);
    this.restoreAutosave();
    this.autosaveTimer = window.setInterval(() => this.saveAutosave(false), 1200);
  }

  dispose(): void {
    this.toolbarActions.remove();
    this.chainTrack.remove();
    this.shell.root.removeEventListener('studio:restore-effect', this.restoreEffect);
    window.removeEventListener('resize', this.updatePanelButtons);
    window.clearInterval(this.autosaveTimer);
    this.presetInput.removeEventListener('change', this.importPreset);
    this.presetInput.remove();
    this.shell.leftPanel
      .querySelectorAll('.visual-section:not(.layer-panel)')
      .forEach((element) => element.remove());
    this.shell.rightPanel.replaceChildren();
  }

  private buildToolbar(): void {
    this.toolbarActions.className = 'topbar__actions';
    const seed = document.createElement('span');
    seed.className = 'seed-label';
    seed.textContent = `SEED ${this.seed.toString().padStart(5, '0')}`;
    this.leftPanelButton = this.iconButton('ph-sidebar-simple', 'Controls', () =>
      this.togglePanel('left'),
    );
    this.rightPanelButton = this.iconButton('ph-sliders-horizontal', 'Inspector', () =>
      this.togglePanel('right'),
    );
    this.toolbarActions.append(
      seed,
      this.iconButton('ph-shuffle', 'Randomize', () => {
        this.seed = Math.floor(Math.random() * 99999);
        seed.textContent = `SEED ${this.seed.toString().padStart(5, '0')}`;
        this.randomize();
      }),
      this.iconButton('ph-grid-four', 'Grid', () => this.shell.root.classList.toggle('show-grid')),
      this.leftPanelButton,
      this.rightPanelButton,
      this.iconButton('ph-corners-out', 'Fullscreen', () => void this.toggleFullscreen()),
      this.iconButton('ph-floppy-disk', 'Save preset', () => this.saveAutosave(true)),
      this.iconButton('ph-download-simple', 'Export preset', () => this.exportPreset()),
      this.iconButton('ph-upload-simple', 'Import preset', () => this.presetInput.click()),
      this.iconButton('ph-export', 'Export PNG', this.exportArtwork, true),
    );
    this.shell.toolbar.append(this.toolbarActions);
    this.updatePanelButtons();
  }

  private togglePanel(side: 'left' | 'right'): void {
    const mobile = window.matchMedia('(width <= 820px)').matches;
    if (mobile) {
      const openClass = side === 'left' ? 'left-open' : 'right-open';
      const otherClass = side === 'left' ? 'right-open' : 'left-open';
      const shouldOpen = !this.shell.root.classList.contains(openClass);
      this.shell.root.classList.remove(otherClass);
      this.shell.root.classList.toggle(openClass, shouldOpen);
    } else {
      const collapsedClass = side === 'left' ? 'left-collapsed' : 'right-collapsed';
      this.shell.root.classList.toggle(collapsedClass);
    }
    this.updatePanelButtons();
  }

  private updatePanelButtons = (): void => {
    const mobile = window.matchMedia('(width <= 820px)').matches;
    const leftVisible = mobile
      ? this.shell.root.classList.contains('left-open')
      : !this.shell.root.classList.contains('left-collapsed');
    const rightVisible = mobile
      ? this.shell.root.classList.contains('right-open')
      : !this.shell.root.classList.contains('right-collapsed');
    this.setPanelButtonState(this.leftPanelButton, leftVisible);
    this.setPanelButtonState(this.rightPanelButton, rightVisible);
  };

  private setPanelButtonState(button: HTMLButtonElement | null, visible: boolean): void {
    if (!button) return;
    button.classList.toggle('is-active', visible);
    button.setAttribute('aria-pressed', String(visible));
  }

  private buildLeftPanel(): void {
    this.shell.leftPanel
      .querySelectorAll('.visual-section:not(.layer-panel)')
      .forEach((element) => element.remove());
    const motion = this.section('MOTION', 'ph-wave-sine');
    const sine = this.composition.sineWave.getParameters();
    motion.append(
      this.range('Speed', sine.speed, 0, 4, 0.01, (value) => this.setSine('speed', value), 'x'),
    );

    const generator = this.section('GENERATOR', 'ph-bezier-curve');
    generator.append(
      this.segmented('Source', ['Sine', 'Waveform'], 'Sine', (value) =>
        this.composition.waveform.setVisible(value === 'Waveform'),
      ),
      this.range('Amplitude', sine.amplitude, 0.02, 1, 0.01, (value) =>
        this.setSine('amplitude', value),
      ),
      this.range('Frequency', sine.frequency, 0.5, 16, 0.1, (value) =>
        this.setSine('frequency', value),
      ),
      this.range('Opacity', sine.opacity, 0.05, 1, 0.01, (value) => this.setSine('opacity', value)),
      this.colorControl('Line color', sine.color),
    );

    const reaction = this.section('AUDIO MAPPING', 'ph-equalizer');
    const values = this.composition.sineWave.getAudioReaction();
    reaction.append(
      this.range('Bass → amplitude', values.bassStrength, 0, 2, 0.01, (value) =>
        this.setReaction('bassStrength', value),
      ),
      this.range('Mid → frequency', values.midStrength, 0, 2, 0.01, (value) =>
        this.setReaction('midStrength', value),
      ),
      this.range('Treble → color', values.trebleStrength, 0, 2, 0.01, (value) =>
        this.setReaction('trebleStrength', value),
      ),
      this.range('Beat sensitivity', 0.08, 0.01, 0.3, 0.01, (value) =>
        this.audioEngine.setBeatSensitivity(value),
      ),
      this.range('Smoothing', values.smoothing, 0, 0.98, 0.01, (value) => {
        this.setReaction('smoothing', value);
        this.audioEngine.setAnalysisSmoothing(value);
      }),
    );

    const range = this.section('OUTPUT RANGE', 'ph-arrows-out-line-vertical');
    range.append(
      this.range('Amplitude min', values.amplitudeMin, 0, 0.8, 0.01, (value) =>
        this.setReaction('amplitudeMin', value),
      ),
      this.range('Amplitude max', values.amplitudeMax, 0.1, 1.2, 0.01, (value) =>
        this.setReaction('amplitudeMax', value),
      ),
      this.range('Frequency min', values.frequencyMin, 0.5, 10, 0.1, (value) =>
        this.setReaction('frequencyMin', value),
      ),
      this.range('Frequency max', values.frequencyMax, 2, 20, 0.1, (value) =>
        this.setReaction('frequencyMax', value),
      ),
    );
    this.shell.leftPanel.prepend(motion);
    this.shell.leftPanel.append(generator, reaction, range);
  }

  private buildInspector(): void {
    this.shell.rightPanel.replaceChildren();
    const header = document.createElement('div');
    header.className = 'inspector-header';
    const eyebrow = document.createElement('span');
    eyebrow.textContent = 'SELECTED EFFECT';
    const title = document.createElement('strong');
    title.textContent = this.selectedEffect.name;
    header.append(eyebrow, title);

    const controls = this.section('PARAMETERS', 'ph-sliders');
    controls.append(
      this.toggle('Enabled', this.selectedEffect.enabled, (value) => {
        this.selectedEffect.enabled = value;
        this.buildChain();
      }),
      this.range(
        'Intensity',
        this.selectedEffect.intensity,
        0,
        EFFECT_MAX[this.selectedEffect.name] ?? 1,
        0.001,
        (value) => {
          this.selectedEffect.intensity = value;
        },
      ),
      this.selectControl(
        'React to',
        ['none', 'volume', 'bass', 'mid', 'treble', 'beat'],
        this.selectedEffect.audioSource,
        (value) => {
          this.selectedEffect.audioSource = value as AudioSource;
        },
      ),
    );

    const order = this.section('CHAIN POSITION', 'ph-path');
    const orderActions = document.createElement('div');
    orderActions.className = 'button-row';
    orderActions.append(
      this.iconButton('ph-arrow-left', 'Move earlier', () => this.moveSelected(-1)),
      this.iconButton('ph-arrow-right', 'Move later', () => this.moveSelected(1)),
    );
    order.append(orderActions);

    const looks = this.section('QUICK LOOKS', 'ph-sparkle');
    const lookGrid = document.createElement('div');
    lookGrid.className = 'look-grid';
    for (const [name, amount, source] of [
      ['SUBTLE', 0.18, 'none'],
      ['BASS HIT', 0.5, 'bass'],
      ['AIR', 0.35, 'treble'],
      ['BROKEN', 0.8, 'beat'],
    ] as const) {
      const button = this.textButton(name, () => {
        const max = EFFECT_MAX[this.selectedEffect.name] ?? 1;
        this.selectedEffect.intensity = amount * max;
        this.selectedEffect.audioSource = source;
        this.selectedEffect.enabled = true;
        this.buildInspector();
        this.buildChain();
      });
      lookGrid.append(button);
    }
    looks.append(lookGrid);
    this.shell.rightPanel.append(header, controls, order, looks);
  }

  private buildChain(): void {
    this.chainTrack.replaceChildren();
    this.chainTrack.className = 'effect-chain__track';
    const label = document.createElement('span');
    label.className = 'effect-chain__label';
    label.textContent = 'CHAIN';
    const source = document.createElement('button');
    source.type = 'button';
    source.className = 'chain-node chain-node--source';
    source.textContent = 'SOURCE';
    this.chainTrack.append(label, source);

    for (const effect of this.composition.getEffects()) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'chain-node';
      node.classList.toggle('is-active', effect.enabled);
      node.classList.toggle('is-selected', effect === this.selectedEffect);
      const state = document.createElement('i');
      state.className = 'chain-node__state';
      const name = document.createElement('span');
      name.textContent = effect.name;
      node.append(state, name);
      node.addEventListener('click', () => {
        this.shell.root.dispatchEvent(new CustomEvent('studio:effect-selected'));
        this.selectedEffect = effect;
        this.buildInspector();
        this.buildChain();
        this.shell.root.classList.add('right-open');
      });
      this.chainTrack.append(node);
    }
    this.shell.chain.replaceChildren(this.chainTrack);
  }

  private restoreEffect = (): void => {
    this.buildInspector();
  };

  private section(titleText: string, iconClass: string): HTMLElement {
    const section = document.createElement('section');
    section.className = 'panel-section visual-section';
    const title = document.createElement('h2');
    const icon = document.createElement('i');
    icon.className = `ph ${iconClass}`;
    const text = document.createElement('span');
    text.textContent = titleText;
    const collapse = this.iconButton('ph-caret-up', `Collapse ${titleText}`, () => {
      section.classList.toggle('is-collapsed');
      collapse.classList.toggle('is-rotated');
    });
    collapse.classList.add('section-collapse');
    title.append(icon, text, collapse);
    section.append(title);
    return section;
  }

  private range(
    labelText: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onInput: (value: number) => void,
    suffix = '',
  ): HTMLElement {
    const label = document.createElement('label');
    label.className = 'control-row control-row--range';
    const name = document.createElement('span');
    const output = document.createElement('output');
    name.textContent = labelText;
    output.textContent = `${Number(value.toFixed(3))}${suffix}`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute('aria-label', labelText);
    input.addEventListener('input', () => {
      const next = Number(input.value);
      output.textContent = `${Number(next.toFixed(3))}${suffix}`;
      onInput(next);
    });
    label.append(name, output, input);
    return label;
  }

  private colorControl(labelText: string, value: string): HTMLElement {
    const label = document.createElement('label');
    label.className = 'control-row control-row--inline';
    const text = document.createElement('span');
    text.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = value;
    input.setAttribute('aria-label', labelText);
    input.addEventListener('input', () =>
      this.composition.sineWave.setParameters({ color: input.value }),
    );
    label.append(text, input);
    return label;
  }

  private toggle(
    labelText: string,
    checked: boolean,
    onChange: (value: boolean) => void,
  ): HTMLElement {
    const label = document.createElement('label');
    label.className = 'control-row control-row--inline switch-row';
    const text = document.createElement('span');
    text.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.setAttribute('aria-label', labelText);
    input.addEventListener('change', () => onChange(input.checked));
    label.append(text, input);
    return label;
  }

  private selectControl(
    labelText: string,
    options: string[],
    selected: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const label = document.createElement('label');
    label.className = 'control-row control-row--inline';
    const text = document.createElement('span');
    text.textContent = labelText;
    const select = document.createElement('select');
    select.setAttribute('aria-label', labelText);
    for (const value of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value.toUpperCase();
      option.selected = value === selected;
      select.append(option);
    }
    select.addEventListener('change', () => onChange(select.value));
    label.append(text, select);
    return label;
  }

  private segmented(
    labelText: string,
    options: string[],
    selected: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'segmented-control';
    const legend = document.createElement('legend');
    legend.textContent = labelText;
    fieldset.append(legend);
    for (const value of options) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'generator-source';
      input.value = value;
      input.checked = value === selected;
      input.addEventListener('change', () => onChange(value));
      const text = document.createElement('span');
      text.textContent = value;
      label.append(input, text);
      fieldset.append(label);
    }
    return fieldset;
  }

  private iconButton(
    iconClass: string,
    label: string,
    action: () => void,
    primary = false,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = primary ? 'ui-button is-primary' : 'ui-button';
    button.setAttribute('aria-label', label);
    const icon = document.createElement('i');
    icon.className = `ph ${iconClass}`;
    const text = document.createElement('span');
    text.textContent = label;
    button.append(icon, text);
    button.addEventListener('click', action);
    return button;
  }

  private textButton(text: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'look-button';
    button.textContent = text;
    button.addEventListener('click', action);
    return button;
  }

  private setSine(key: NumericKey<SineWaveParameters>, value: number): void {
    this.composition.sineWave.setParameters({ [key]: value });
  }

  private setReaction(key: NumericKey<AudioReactionParameters>, value: number): void {
    this.composition.sineWave.setAudioReaction({ [key]: value });
  }

  private moveSelected(direction: -1 | 1): void {
    this.composition.moveEffect(this.selectedEffect, direction);
    this.buildChain();
  }

  private randomize(): void {
    const color = `#${Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}`;
    this.composition.sineWave.setParameters({
      amplitude: 0.12 + Math.random() * 0.48,
      frequency: 1.5 + Math.random() * 8,
      speed: 0.18 + Math.random() * 1.8,
      color,
      opacity: 0.68 + Math.random() * 0.32,
    });
    for (const effect of this.composition.getEffects()) {
      effect.enabled = Math.random() > 0.52;
      effect.audioSource = ['none', 'bass', 'mid', 'treble', 'beat'][
        Math.floor(Math.random() * 5)
      ] as AudioSource;
    }
    this.buildLeftPanel();
    this.buildInspector();
    this.buildChain();
  }

  private async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  }

  private saveAutosave(notify: boolean): void {
    try {
      localStorage.setItem(
        StudioControls.PRESET_KEY,
        JSON.stringify(createStudioPreset(this.composition, this.layerEditor)),
      );
      if (notify) this.showNotice('Preset saved');
    } catch {
      if (notify) this.showNotice('Preset could not be saved', true);
    }
  }

  private restoreAutosave(): void {
    const saved = localStorage.getItem(StudioControls.PRESET_KEY);
    if (!saved) return;
    try {
      this.applyPreset(JSON.parse(saved) as StudioPreset);
    } catch {
      localStorage.removeItem(StudioControls.PRESET_KEY);
    }
  }

  private exportPreset(): void {
    const preset = createStudioPreset(this.composition, this.layerEditor);
    const link = document.createElement('a');
    link.download = `audio-artwork-preset-${Date.now()}.json`;
    link.href = URL.createObjectURL(
      new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }),
    );
    link.click();
    URL.revokeObjectURL(link.href);
    this.showNotice('Preset exported');
  }

  private importPreset = async (): Promise<void> => {
    const file = this.presetInput.files?.[0];
    this.presetInput.value = '';
    if (!file) return;
    try {
      this.applyPreset(JSON.parse(await file.text()) as StudioPreset);
      this.saveAutosave(false);
      this.showNotice('Preset imported');
    } catch {
      this.showNotice('Invalid preset file', true);
    }
  };

  private applyPreset(preset: StudioPreset): void {
    applyStudioPreset(preset, this.composition, this.layerEditor);
    this.selectedEffect = this.composition.getEffects()[0]!;
    this.buildLeftPanel();
    this.buildInspector();
    this.buildChain();
  }

  private showNotice(message: string, error = false): void {
    const notice = document.createElement('div');
    notice.className = `studio-notice${error ? ' is-error' : ''}`;
    notice.textContent = message;
    this.shell.root.append(notice);
    window.setTimeout(() => notice.remove(), 2200);
  }
}
