import type { FileAudioEngine } from '../audio/FileAudioEngine';
import type { SineWaveBasic } from '../compositions/SineWaveBasic';
import type { App } from '../core/App';
import type {
  AudioSource,
  Effect,
  EffectAudioMapping,
  EffectParameterSchema,
  EffectParameterValue,
  NumberEffectParameter,
} from '../effects/Effect';
import type { AudioReactionParameters, SineWaveParameters } from '../generators/SineWave';
import type { StudioShell } from './StudioShell';
import type { LayerEditor } from './LayerEditor';
import type { CompositionDefinition } from '../compositions/catalog';
import {
  applyStudioPreset,
  createStudioPreset,
  migrateStudioPreset,
  type CompatibleStudioPreset,
} from './StudioPreset';

type NumericKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

const AUDIO_SOURCES: AudioSource[] = ['none', 'volume', 'bass', 'mid', 'treble', 'beat'];

export class StudioControls {
  private readonly shell: StudioShell;
  private composition: SineWaveBasic;
  private readonly audioEngine: FileAudioEngine;
  private readonly app: App;
  private readonly layerEditor: LayerEditor;
  private readonly compositionDefinitions: CompositionDefinition[];
  private readonly onCompositionChange: ((name: string) => SineWaveBasic) | null;
  private readonly exportArtwork: () => void;
  private readonly recordArtwork: (() => boolean) | null;
  private readonly presetInput = document.createElement('input');
  private readonly toolbarActions = document.createElement('div');
  private readonly effectStack = document.createElement('div');
  private readonly effectPopover = document.createElement('div');
  private effectPopoverAnchor: HTMLElement | null = null;
  private leftPanelButton: HTMLButtonElement | null = null;
  private rightPanelButton: HTMLButtonElement | null = null;
  private selectedEffect: Effect;
  private artworkSelection = 'None';
  private seed = Math.floor(Math.random() * 99999);
  private autosaveTimer = 0;
  private historyTimer = 0;
  private readonly history: string[] = [];
  private readonly redoHistory: string[] = [];
  private pendingHistory = '';
  private pendingHistorySince = 0;
  private applyingHistory = false;
  private static readonly PRESET_KEY = 'audio-artwork-lab:studio-preset';
  private static readonly HISTORY_LIMIT = 25;

  constructor(
    shell: StudioShell,
    composition: SineWaveBasic,
    audioEngine: FileAudioEngine,
    app: App,
    layerEditor: LayerEditor,
    exportArtwork?: () => void,
    recordArtwork?: () => boolean,
    compositionDefinitions: CompositionDefinition[] = [],
    onCompositionChange?: (name: string) => SineWaveBasic,
  ) {
    this.shell = shell;
    this.composition = composition;
    this.audioEngine = audioEngine;
    this.app = app;
    this.layerEditor = layerEditor;
    this.compositionDefinitions = compositionDefinitions;
    this.onCompositionChange = onCompositionChange ?? null;
    this.exportArtwork = exportArtwork ?? (() => this.app.exportPng());
    this.recordArtwork = recordArtwork ?? null;
    this.selectedEffect = composition.getEffects()[0]!;
    this.buildToolbar();
    this.buildLeftPanel();
    this.buildInspector();
    this.buildChain();
    this.effectPopover.className = 'effect-popover';
    this.effectPopover.hidden = true;
    this.effectPopover.setAttribute('role', 'dialog');
    this.effectPopover.setAttribute('aria-modal', 'false');
    this.shell.root.append(this.effectPopover);
    this.shell.root.addEventListener('studio:restore-effect', this.restoreEffect);
    window.addEventListener('resize', this.updatePanelButtons);
    document.addEventListener('pointerdown', this.dismissEffectPopover);
    document.addEventListener('keydown', this.closeEffectPopoverOnEscape);
    document.addEventListener('keydown', this.onHistoryShortcut);
    this.presetInput.type = 'file';
    this.presetInput.accept = 'application/json,.json';
    this.presetInput.hidden = true;
    this.presetInput.addEventListener('change', this.importPreset);
    this.shell.root.append(this.presetInput);
    this.restoreAutosave();
    this.history.push(this.createHistoryState());
    this.autosaveTimer = window.setInterval(() => this.saveAutosave(false), 1200);
    this.historyTimer = window.setInterval(this.trackHistory, 150);
  }

  dispose(): void {
    this.toolbarActions.remove();
    this.shell.root.removeEventListener('studio:restore-effect', this.restoreEffect);
    window.removeEventListener('resize', this.updatePanelButtons);
    document.removeEventListener('pointerdown', this.dismissEffectPopover);
    document.removeEventListener('keydown', this.closeEffectPopoverOnEscape);
    document.removeEventListener('keydown', this.onHistoryShortcut);
    window.clearInterval(this.autosaveTimer);
    window.clearInterval(this.historyTimer);
    this.presetInput.removeEventListener('change', this.importPreset);
    this.presetInput.remove();
    this.effectPopover.remove();
    this.shell.leftTop
      .querySelectorAll('.visual-section:not(.layer-panel):not(.quality-panel)')
      .forEach((element) => element.remove());
    this.shell.effectsPanel.replaceChildren();
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
    const recordButton = this.iconButton('ph-record', 'Record WebM', () => {
      if (!this.recordArtwork) return;
      try {
        const recording = this.recordArtwork();
        recordButton.classList.toggle('is-recording', recording);
        recordButton.querySelector('span')!.textContent = recording ? 'Stop recording' : 'Record WebM';
      } catch (error) {
        this.showNotice(error instanceof Error ? error.message : 'Recording unavailable', true);
      }
    });
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
      recordButton,
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
    if (!this.effectPopover.hidden) this.positionEffectPopover();
  };

  private setPanelButtonState(button: HTMLButtonElement | null, visible: boolean): void {
    if (!button) return;
    button.classList.toggle('is-active', visible);
    button.setAttribute('aria-pressed', String(visible));
  }

  private buildLeftPanel(): void {
    this.shell.leftTop
      .querySelectorAll('.visual-section:not(.layer-panel):not(.quality-panel)')
      .forEach((element) => element.remove());
    const motion = this.section('Motion', 'ph-wave-sine');
    const sine = this.composition.sineWave.getParameters();
    motion.append(
      this.range('Speed', sine.speed, 0, 4, 0.01, (value) => this.setSine('speed', value), 'x'),
    );

    const generator = this.section('Generator', 'ph-bezier-curve');
    generator.append(
      this.segmented(
        'Source',
        this.composition.visualGenerators.map((item) => item.name),
        this.composition.getSelectedGeneratorName(),
        (value) => this.composition.selectGenerator(value),
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

    const reaction = this.section('Audio mapping', 'ph-equalizer');
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

    const range = this.section('Output range', 'ph-arrows-out-line-vertical');
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
    this.shell.leftTop.prepend(motion);
    this.shell.leftTop.append(generator, reaction, range);
  }

  private buildInspector(): void {
    this.shell.effectsPanel.replaceChildren();
    const artwork = this.section('Artwork', 'ph-sparkle');
    artwork.classList.add('artwork-section');
    artwork.append(
      this.selectControl(
        'Look',
        ['None', ...this.compositionDefinitions.map((definition) => definition.name)],
        this.artworkSelection,
        (value) => this.switchArtwork(value),
      ),
    );
    const stack = this.section('Effect stack', 'ph-stack');
    this.effectStack.className = 'effect-stack';
    stack.append(this.effectStack);
    this.renderEffectStack();
    const hint = document.createElement('p');
    hint.className = 'effect-stack__hint';
    hint.textContent = 'Select an effect to adjust its settings.';
    stack.append(hint);
    this.shell.effectsPanel.append(artwork, stack);
  }

  private buildChain(): void {
    this.shell.chain.replaceChildren();
    this.renderEffectStack();
  }

  private renderEffectStack(): void {
    this.effectStack.replaceChildren();
    for (const [index, effect] of this.composition.getEffects().entries()) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'effect-stack__item';
      node.classList.toggle('is-active', effect.enabled);
      node.classList.toggle('is-selected', effect === this.selectedEffect);
      const state = document.createElement('i');
      state.className = 'effect-stack__state';
      const name = document.createElement('span');
      name.textContent = effect.name;
      const status = document.createElement('small');
      status.textContent = effect.enabled ? 'On' : 'Off';
      node.append(state, name);
      node.append(status);
      node.addEventListener('click', () => {
        this.shell.root.dispatchEvent(new CustomEvent('studio:effect-selected'));
        this.selectedEffect = effect;
        this.renderEffectStack();
        this.shell.setInspectorTab('effects');
        this.shell.root.classList.add('right-open');
        const selectedNode = this.effectStack.children.item(index);
        if (selectedNode instanceof HTMLElement) this.openEffectPopover(selectedNode);
      });
      this.effectStack.append(node);
    }
  }

  private restoreEffect = (): void => {
    this.closeEffectPopover();
    this.buildInspector();
  };

  private openEffectPopover(anchor: HTMLElement): void {
    this.effectPopoverAnchor = anchor;
    this.effectPopover.replaceChildren();
    this.effectPopover.setAttribute('aria-label', `${this.selectedEffect.name} settings`);

    const header = document.createElement('div');
    header.className = 'effect-popover__header';
    const heading = document.createElement('div');
    const eyebrow = document.createElement('span');
    eyebrow.textContent = 'Effect';
    const title = document.createElement('strong');
    title.textContent = this.selectedEffect.name;
    heading.append(eyebrow, title);
    const close = this.iconButton('ph-x', 'Close effect settings', () =>
      this.closeEffectPopover(),
    );
    close.classList.add('effect-popover__close');
    header.append(heading, close);

    const parameters = document.createElement('div');
    parameters.className = 'effect-popover__section';
    const parameterTitle = document.createElement('h3');
    parameterTitle.textContent = 'Parameters';
    parameters.append(
      parameterTitle,
      this.toggle('Enabled', this.selectedEffect.enabled, (value) => {
        this.selectedEffect.enabled = value;
        anchor.classList.toggle('is-active', value);
        const status = anchor.querySelector('small');
        if (status) status.textContent = value ? 'On' : 'Off';
      }),
    );
    for (const parameter of this.selectedEffect.parameterSchema) {
      const block = document.createElement('div');
      block.className = 'effect-parameter-block';
      block.append(this.effectParameterControl(this.selectedEffect, parameter));
      if (parameter.type === 'number') {
        block.append(this.effectAudioMappingControl(this.selectedEffect, parameter));
      }
      parameters.append(block);
    }

    const order = document.createElement('div');
    order.className = 'effect-popover__section';
    const orderTitle = document.createElement('h3');
    orderTitle.textContent = 'Effect order';
    const orderActions = document.createElement('div');
    orderActions.className = 'button-row';
    orderActions.append(
      this.iconButton('ph-arrow-up', 'Move earlier', () => {
        this.moveSelected(-1);
        this.closeEffectPopover();
      }),
      this.iconButton('ph-arrow-down', 'Move later', () => {
        this.moveSelected(1);
        this.closeEffectPopover();
      }),
    );
    order.append(orderTitle, orderActions);

    const looks = document.createElement('div');
    looks.className = 'effect-popover__section';
    const looksTitle = document.createElement('h3');
    looksTitle.textContent = 'Quick looks';
    const lookGrid = document.createElement('div');
    lookGrid.className = 'look-grid';
    for (const [name, amount, source] of [
      ['Subtle', 0.18, 'none'],
      ['Bass hit', 0.5, 'bass'],
      ['Air', 0.35, 'treble'],
      ['Broken', 0.8, 'beat'],
    ] as const) {
      lookGrid.append(
        this.textButton(name, () => {
          const intensity = this.selectedEffect.parameterSchema.find(
            (parameter): parameter is NumberEffectParameter =>
              parameter.key === 'intensity' && parameter.type === 'number',
          );
          this.selectedEffect.setParameterValues({
            intensity: amount * (intensity?.max ?? 1),
          });
          this.selectedEffect.audioSource = source;
          this.selectedEffect.enabled = true;
          anchor.classList.add('is-active');
          const status = anchor.querySelector('small');
          if (status) status.textContent = 'On';
          this.openEffectPopover(anchor);
        }),
      );
    }
    looks.append(looksTitle, lookGrid);

    this.effectPopover.append(header, parameters, order, looks);
    this.effectPopover.hidden = false;
    this.positionEffectPopover();
    close.focus();
  }

  private positionEffectPopover(): void {
    if (!this.effectPopoverAnchor) return;
    const anchor = this.effectPopoverAnchor.getBoundingClientRect();
    const width = this.effectPopover.offsetWidth || 300;
    const height = this.effectPopover.offsetHeight || 460;
    const gap = 10;
    const left =
      anchor.left - width - gap >= 8
        ? anchor.left - width - gap
        : Math.min(anchor.right + gap, window.innerWidth - width - 8);
    const top = Math.min(
      Math.max(anchor.top - 8, 8),
      Math.max(window.innerHeight - height - 8, 8),
    );
    this.effectPopover.style.left = `${left}px`;
    this.effectPopover.style.top = `${top}px`;
  }

  private closeEffectPopover(): void {
    this.effectPopover.hidden = true;
    this.effectPopoverAnchor = null;
  }

  private dismissEffectPopover = (event: PointerEvent): void => {
    if (this.effectPopover.hidden) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.effectPopover.contains(target) || this.effectStack.contains(target)) return;
    this.closeEffectPopover();
  };

  private closeEffectPopoverOnEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !this.effectPopover.hidden) this.closeEffectPopover();
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

  private effectParameterControl(
    effect: Effect,
    parameter: EffectParameterSchema,
  ): HTMLElement {
    const value = effect.getParameterValues()[parameter.key] ?? parameter.defaultValue;
    const update = (next: EffectParameterValue): void => {
      effect.setParameterValues({ [parameter.key]: next });
    };
    if (parameter.type === 'number') {
      return this.range(
        parameter.label,
        typeof value === 'number' ? value : parameter.defaultValue,
        parameter.min,
        parameter.max,
        parameter.step,
        update,
        parameter.suffix,
      );
    }
    if (parameter.type === 'boolean') {
      return this.toggle(
        parameter.label,
        typeof value === 'boolean' ? value : parameter.defaultValue,
        update,
      );
    }
    if (parameter.type === 'select') {
      const label = document.createElement('label');
      label.className = 'control-row control-row--inline';
      const text = document.createElement('span');
      text.textContent = parameter.label;
      const select = document.createElement('select');
      select.setAttribute('aria-label', parameter.label);
      for (const item of parameter.options) {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        option.selected = item.value === value;
        select.append(option);
      }
      select.addEventListener('change', () => update(select.value));
      label.append(text, select);
      return label;
    }
    const label = document.createElement('label');
    label.className = 'control-row control-row--inline';
    const text = document.createElement('span');
    text.textContent = parameter.label;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = typeof value === 'string' ? value : parameter.defaultValue;
    input.setAttribute('aria-label', parameter.label);
    input.addEventListener('input', () => update(input.value));
    label.append(text, input);
    return label;
  }

  private effectAudioMappingControl(
    effect: Effect,
    parameter: NumberEffectParameter,
  ): HTMLElement {
    const root = document.createElement('div');
    root.className = 'effect-audio-mapping';
    const title = document.createElement('h4');
    title.textContent = `${parameter.label} audio mapping`;
    const span = Math.max(parameter.max - parameter.min, parameter.step);
    const fallback: EffectAudioMapping = {
      source: 'none',
      amount: 0,
      min: parameter.min,
      max: parameter.max,
      smoothing: 0.7,
      invert: false,
    };
    const mapping = effect.getAudioMappings()[parameter.key] ?? fallback;
    const update = (change: Partial<EffectAudioMapping>): void => {
      const current = effect.getAudioMappings()[parameter.key] ?? mapping;
      effect.setAudioMappings({
        ...effect.getAudioMappings(),
        [parameter.key]: { ...current, ...change },
      });
    };
    root.append(
      title,
      this.selectControl('Source', AUDIO_SOURCES, mapping.source, (value) =>
        update({ source: value as AudioSource }),
      ),
      this.range('Amount', mapping.amount, -span, span, parameter.step, (value) =>
        update({ amount: value }),
      ),
      this.range('Minimum', mapping.min, parameter.min, parameter.max, parameter.step, (value) =>
        update({ min: value }),
      ),
      this.range('Maximum', mapping.max, parameter.min, parameter.max, parameter.step, (value) =>
        update({ max: value }),
      ),
      this.range('Smoothing', mapping.smoothing, 0, 0.99, 0.01, (value) =>
        update({ smoothing: value }),
      ),
      this.toggle('Invert', mapping.invert, (value) => update({ invert: value })),
    );
    return root;
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
      option.textContent = value.charAt(0).toUpperCase() + value.slice(1);
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
    this.buildLeftPanel();
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
        JSON.stringify(
          createStudioPreset(this.composition, this.layerEditor, this.artworkSelection),
        ),
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
      this.applyPreset(JSON.parse(saved) as CompatibleStudioPreset);
    } catch {
      localStorage.removeItem(StudioControls.PRESET_KEY);
    }
  }

  private createHistoryState(): string {
    const preset = createStudioPreset(
      this.composition,
      this.layerEditor,
      this.artworkSelection,
    );
    preset.savedAt = '';
    return JSON.stringify(preset);
  }

  private trackHistory = (): void => {
    if (this.applyingHistory) return;
    const current = this.createHistoryState();
    if (current === this.history.at(-1)) {
      this.pendingHistory = '';
      this.pendingHistorySince = 0;
      return;
    }
    if (current !== this.pendingHistory) {
      this.pendingHistory = current;
      this.pendingHistorySince = performance.now();
      return;
    }
    if (performance.now() - this.pendingHistorySince < 400) return;
    this.pushHistory(current);
  };

  private pushHistory(state: string): void {
    if (state === this.history.at(-1)) return;
    this.history.push(state);
    if (this.history.length > StudioControls.HISTORY_LIMIT) this.history.shift();
    this.redoHistory.splice(0);
    this.pendingHistory = '';
    this.pendingHistorySince = 0;
  }

  private commitPendingHistory(): void {
    const current = this.createHistoryState();
    if (current !== this.history.at(-1)) this.pushHistory(current);
  }

  private onHistoryShortcut = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
    const target = event.target;
    if (
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement &&
        ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(target.type)) ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    if (event.shiftKey) this.redo();
    else this.undo();
  };

  private undo(): void {
    this.commitPendingHistory();
    if (this.history.length < 2) {
      this.showNotice('Nothing to undo');
      return;
    }
    const current = this.history.pop()!;
    this.redoHistory.push(current);
    this.restoreHistoryState(this.history.at(-1)!);
    this.showNotice('Undid last change');
  }

  private redo(): void {
    const state = this.redoHistory.pop();
    if (!state) {
      this.showNotice('Nothing to redo');
      return;
    }
    this.history.push(state);
    this.restoreHistoryState(state);
    this.showNotice('Redid last change');
  }

  private restoreHistoryState(state: string): void {
    this.applyingHistory = true;
    try {
      this.applyPreset(JSON.parse(state) as CompatibleStudioPreset);
      this.saveAutosave(false);
      this.pendingHistory = '';
      this.pendingHistorySince = 0;
    } finally {
      this.applyingHistory = false;
    }
  }

  private exportPreset(): void {
    const preset = createStudioPreset(
      this.composition,
      this.layerEditor,
      this.artworkSelection,
    );
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
      this.applyPreset(JSON.parse(await file.text()) as CompatibleStudioPreset);
      this.saveAutosave(false);
      this.showNotice('Preset imported');
    } catch {
      this.showNotice('Invalid preset file', true);
    }
  };

  private applyPreset(compatiblePreset: CompatibleStudioPreset): void {
    const preset = migrateStudioPreset(compatiblePreset);
    if (preset.compositionName && preset.compositionName !== this.composition.name) {
      this.switchComposition(preset.compositionName);
    }
    this.artworkSelection =
      preset.artworkName ??
      (preset.layers.layers.some((layer) => layer.kind === 'generator')
        ? (preset.compositionName ?? this.composition.name)
        : 'None');
    applyStudioPreset(preset, this.composition, this.layerEditor);
    this.selectedEffect = this.composition.getEffects()[0]!;
    this.buildLeftPanel();
    this.buildInspector();
    this.buildChain();
  }

  private switchComposition(name: string): void {
    if (!this.onCompositionChange) return;
    this.composition = this.onCompositionChange(name);
    this.selectedEffect = this.composition.getEffects()[0]!;
    this.buildLeftPanel();
    this.buildInspector();
    this.buildChain();
  }

  private switchArtwork(name: string): void {
    this.artworkSelection = name;
    if (name === 'None') {
      this.layerEditor.clearGeneratorLayer();
      for (const effect of this.composition.getEffects()) effect.enabled = false;
      this.buildInspector();
      this.buildChain();
      return;
    }
    this.layerEditor.ensureGeneratorLayer();
    this.switchComposition(name);
  }

  private showNotice(message: string, error = false): void {
    const notice = document.createElement('div');
    notice.className = `studio-notice${error ? ' is-error' : ''}`;
    notice.textContent = message;
    this.shell.root.append(notice);
    window.setTimeout(() => notice.remove(), 2200);
  }
}
