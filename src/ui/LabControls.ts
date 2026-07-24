import type { FieldComposition } from '../engine/FieldComposition';
import type {
  AudioSource,
  Effect,
  EffectAudioMapping,
  EffectParameterSchema,
  EffectParameterValue,
  NumberEffectParameter,
} from '../effects/Effect';
import { THEMES } from '../engine/themes';
import { RENDERERS } from '../renderers/catalog';
import type { StudioShell } from './StudioShell';

const AUDIO_SOURCES: AudioSource[] = ['none', 'volume', 'bass', 'mid', 'treble', 'beat'];

/**
 * Field × Renderer 構成の操作パネル。
 *
 * 左: Field / Renderer の選択（DESIGN.md §2 の ① と ②）
 * 右: Effect stack（③)。パラメータはスキーマから動的に生成し、
 *     Effect ごとの専用コードは書かない。
 *
 * 次数 n・m など「音が決める値」のスライダーは出さない（DESIGN.md §4 UI 原則）。
 */
export class LabControls {
  private readonly shell: StudioShell;
  private composition: FieldComposition;
  private readonly onRendererChange: (name: string) => FieldComposition;
  private readonly onThemeChange: (name: string) => void;
  private readonly onDepthChange: (amount: number) => void;
  private readonly exportPng: () => void;
  private readonly recordToggle: () => boolean;
  private readonly onExportPreset: () => void;
  private readonly onImportPreset: (json: string) => void;
  private readonly presetInput = document.createElement('input');
  private readonly toolbarActions = document.createElement('div');
  private readonly compositionSection: HTMLElement;
  private readonly compositionBody = document.createElement('div');
  private readonly effectSection: HTMLElement;
  private readonly effectStack = document.createElement('div');
  private readonly effectSettings = document.createElement('div');
  private selectedEffectName: string;

  constructor(
    shell: StudioShell,
    composition: FieldComposition,
    onRendererChange: (name: string) => FieldComposition,
    onThemeChange: (name: string) => void,
    onDepthChange: (amount: number) => void,
    exportPng: () => void,
    recordToggle: () => boolean,
    onExportPreset: () => void,
    onImportPreset: (json: string) => void,
  ) {
    this.shell = shell;
    this.composition = composition;
    this.onRendererChange = onRendererChange;
    this.onThemeChange = onThemeChange;
    this.onDepthChange = onDepthChange;
    this.onExportPreset = onExportPreset;
    this.onImportPreset = onImportPreset;
    this.exportPng = exportPng;
    this.recordToggle = recordToggle;
    this.selectedEffectName = composition.getEffects()[0]?.name ?? '';

    this.presetInput.type = 'file';
    this.presetInput.accept = 'application/json,.json';
    this.presetInput.hidden = true;
    this.presetInput.addEventListener('change', () => {
      const file = this.presetInput.files?.[0];
      this.presetInput.value = '';
      if (!file) return;
      void file.text().then((json) => this.onImportPreset(json));
    });
    this.shell.root.append(this.presetInput);

    this.buildToolbar();
    this.compositionSection = this.section('Composition', 'ph-bezier-curve');
    this.compositionSection.append(this.compositionBody);
    this.buildCompositionSection();
    this.shell.leftTop.append(this.compositionSection);

    this.effectSection = this.section('Effect stack', 'ph-stack');
    this.effectStack.className = 'effect-stack';
    this.effectSettings.className = 'effect-inline-settings';
    this.effectSection.append(this.effectStack, this.effectSettings);
    this.shell.effectsPanel.append(this.effectSection);
    this.renderEffectStack();
  }

  dispose(): void {
    this.toolbarActions.remove();
    this.compositionSection.remove();
    this.effectSection.remove();
    this.presetInput.remove();
  }

  /** Preset 適用など、外部で composition が差し替わったときに UI を追従させる。 */
  refresh(composition: FieldComposition): void {
    this.composition = composition;
    this.buildCompositionSection();
    this.renderEffectStack();
  }

  private buildToolbar(): void {
    this.toolbarActions.className = 'topbar__actions';
    const record = this.button('ph-record', 'Record WebM', () => {
      const recording = this.recordToggle();
      record.classList.toggle('is-recording', recording);
      record.querySelector('span')!.textContent = recording ? 'Stop recording' : 'Record WebM';
    });
    this.toolbarActions.append(
      this.button('ph-download-simple', 'Export preset', () => this.onExportPreset()),
      this.button('ph-upload-simple', 'Import preset', () => this.presetInput.click()),
      record,
      this.button('ph-export', 'Export PNG', this.exportPng, true),
    );
    this.shell.toolbar.append(this.toolbarActions);
  }

  private buildCompositionSection(): void {
    this.compositionBody.replaceChildren();
    const field = document.createElement('label');
    field.className = 'control-row control-row--inline';
    const fieldName = document.createElement('span');
    fieldName.textContent = 'Field';
    const fieldSelect = document.createElement('select');
    fieldSelect.setAttribute('aria-label', 'Field');
    const cymatics = document.createElement('option');
    cymatics.value = 'Cymatics';
    cymatics.textContent = 'Cymatics';
    fieldSelect.append(cymatics);
    fieldSelect.disabled = true;
    field.append(fieldName, fieldSelect);

    const renderer = document.createElement('fieldset');
    renderer.className = 'segmented-control';
    const legend = document.createElement('legend');
    legend.textContent = 'Renderer';
    renderer.append(legend);
    const currentName = this.composition.name;
    for (const definition of RENDERERS) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'field-renderer';
      input.value = definition.name;
      input.checked = currentName.endsWith(definition.name);
      input.addEventListener('change', () => {
        this.composition = this.onRendererChange(definition.name);
        this.renderEffectStack();
      });
      const text = document.createElement('span');
      text.textContent = definition.name;
      label.append(input, text);
      renderer.append(label);
    }

    const theme = document.createElement('label');
    theme.className = 'control-row control-row--inline';
    const themeName = document.createElement('span');
    themeName.textContent = 'Theme';
    const themeSelect = document.createElement('select');
    themeSelect.setAttribute('aria-label', 'Color theme');
    for (const definition of THEMES) {
      const option = document.createElement('option');
      option.value = definition.name;
      option.textContent = definition.name;
      option.selected = definition.name === this.composition.getTheme().name;
      themeSelect.append(option);
    }
    themeSelect.addEventListener('change', () => this.onThemeChange(themeSelect.value));
    theme.append(themeName, themeSelect);

    const depth = this.range('Depth', this.composition.getDepth(), 0, 1, 0.01, (value) =>
      this.onDepthChange(value),
    );

    this.compositionBody.append(field, renderer, theme, depth);
  }

  private renderEffectStack(): void {
    this.effectStack.replaceChildren();
    for (const effect of this.composition.getEffects()) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'effect-stack__item';
      node.classList.toggle('is-active', effect.enabled);
      node.classList.toggle('is-selected', effect.name === this.selectedEffectName);
      const state = document.createElement('i');
      state.className = 'effect-stack__state';
      const name = document.createElement('span');
      name.textContent = effect.name;
      const status = document.createElement('small');
      status.textContent = effect.enabled ? 'On' : 'Off';
      node.append(state, name, status);
      node.addEventListener('click', () => {
        this.selectedEffectName = effect.name;
        this.renderEffectStack();
      });
      this.effectStack.append(node);
    }
    this.renderEffectSettings();
  }

  private renderEffectSettings(): void {
    this.effectSettings.replaceChildren();
    const effect = this.composition
      .getEffects()
      .find((candidate) => candidate.name === this.selectedEffectName);
    if (!effect) return;

    const title = document.createElement('h3');
    title.textContent = effect.name;
    this.effectSettings.append(
      title,
      this.toggle('Enabled', effect.enabled, (value) => {
        effect.enabled = value;
        this.renderEffectStack();
      }),
    );

    for (const parameter of effect.parameterSchema) {
      const block = document.createElement('div');
      block.className = 'effect-parameter-block';
      block.append(this.parameterControl(effect, parameter));
      if (parameter.type === 'number') {
        block.append(this.audioMappingControl(effect, parameter));
      }
      this.effectSettings.append(block);
    }

    const order = document.createElement('div');
    order.className = 'button-row';
    order.append(
      this.button('ph-arrow-up', 'Move earlier', () => {
        this.composition.moveEffect(effect, -1);
        this.renderEffectStack();
      }),
      this.button('ph-arrow-down', 'Move later', () => {
        this.composition.moveEffect(effect, 1);
        this.renderEffectStack();
      }),
    );
    this.effectSettings.append(order);
  }

  private parameterControl(effect: Effect, parameter: EffectParameterSchema): HTMLElement {
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

  private audioMappingControl(effect: Effect, parameter: NumberEffectParameter): HTMLElement {
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
    const source = document.createElement('label');
    source.className = 'control-row control-row--inline';
    const sourceText = document.createElement('span');
    sourceText.textContent = 'Source';
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${parameter.label} audio source`);
    for (const item of AUDIO_SOURCES) {
      const option = document.createElement('option');
      option.value = item;
      option.textContent = item.charAt(0).toUpperCase() + item.slice(1);
      option.selected = item === mapping.source;
      select.append(option);
    }
    select.addEventListener('change', () => update({ source: select.value as AudioSource }));
    source.append(sourceText, select);
    root.append(
      title,
      source,
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

  private section(titleText: string, iconClass: string): HTMLElement {
    const section = document.createElement('section');
    section.className = 'panel-section visual-section';
    const title = document.createElement('h2');
    const icon = document.createElement('i');
    icon.className = `ph ${iconClass}`;
    const text = document.createElement('span');
    text.textContent = titleText;
    title.append(icon, text);
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

  private button(iconClass: string, label: string, action: () => void, primary = false): HTMLButtonElement {
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
}
