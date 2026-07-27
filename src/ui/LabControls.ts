import type { CymaticsPlate } from '../expressions/CymaticsPlate';
import type {
  Effect,
  EffectParameterSchema,
  EffectParameterValue,
} from '../effects/Effect';
import { THEMES } from '../engine/themes';
import { ASPECT_RATIOS, EXPRESSION_FAMILIES, type ExpressionId } from '../expressions/catalog';
import type { StudioShell } from './StudioShell';

/**
 * 使い方を説明できるまで UI から隠す共通パラメータ（MTG 2026-07-27）。
 * 機能・状態・プリセット互換は温存し、表示だけしない。
 * Audio Mapping の UI も同じ理由で出していない（D24 の演奏 UI 設計と合流予定）。
 */
const HIDDEN_COMMON_PARAMS = new Set(['dryWet', 'effectOpacity', 'blendMode']);

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
  private composition: CymaticsPlate;
  private readonly onExpressionChange: (id: ExpressionId) => void;
  private readonly onThemeChange: (name: string) => void;
  private readonly onResponseChange: (gains: Partial<{ bass: number; mid: number; treble: number }>) => void;
  private readonly onAspectChange: (id: string) => void;
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
    composition: CymaticsPlate,
    onExpressionChange: (id: ExpressionId) => void,
    onThemeChange: (name: string) => void,
    onResponseChange: (gains: Partial<{ bass: number; mid: number; treble: number }>) => void,
    onAspectChange: (id: string) => void,
    exportPng: () => void,
    recordToggle: () => boolean,
    onExportPreset: () => void,
    onImportPreset: (json: string) => void,
  ) {
    this.shell = shell;
    this.composition = composition;
    this.onExpressionChange = onExpressionChange;
    this.onThemeChange = onThemeChange;
    this.onResponseChange = onResponseChange;
    this.onAspectChange = onAspectChange;
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
  refresh(composition: CymaticsPlate): void {
    this.composition = composition;
    this.buildCompositionSection();
    this.renderEffectStack();
  }

  private buildToolbar(): void {
    this.toolbarActions.className = 'topbar__actions';
    // 主 CTA は動画の書き出し（Record MP4）。PNG はその左に控えめに置く。
    const record = this.button(
      'ph-record',
      'Record MP4',
      () => {
        const recording = this.recordToggle();
        record.classList.toggle('is-recording', recording);
        record.querySelector('span')!.textContent = recording ? 'Stop recording' : 'Record MP4';
      },
      true,
    );
    this.toolbarActions.append(
      this.button('ph-download-simple', 'Export preset', () => this.onExportPreset()),
      this.button('ph-upload-simple', 'Import preset', () => this.presetInput.click()),
      this.button('ph-export', 'Export PNG', this.exportPng),
      record,
    );
    this.shell.toolbar.append(this.toolbarActions);
  }

  private buildCompositionSection(): void {
    this.compositionBody.replaceChildren();
    // 表現は「ファミリー（サイマティクス等）」→「版（V1/V2）」の 2 段で選ぶ。
    // 今後の表現はファミリーとして増え、版の比較は D22 の収斂判断が出るまで残す。
    const currentFamily =
      EXPRESSION_FAMILIES.find((family) =>
        family.versions.some((version) => version.id === this.composition.id),
      ) ?? EXPRESSION_FAMILIES[0]!;

    const field = document.createElement('label');
    field.className = 'control-row control-row--inline';
    const fieldName = document.createElement('span');
    fieldName.textContent = 'Expression';
    const fieldSelect = document.createElement('select');
    fieldSelect.setAttribute('aria-label', 'Expression');
    for (const family of EXPRESSION_FAMILIES) {
      const option = document.createElement('option');
      option.value = family.id;
      option.textContent = family.label;
      option.selected = family.id === currentFamily.id;
      fieldSelect.append(option);
    }
    fieldSelect.addEventListener('change', () => {
      const family = EXPRESSION_FAMILIES.find((entry) => entry.id === fieldSelect.value);
      if (family && family.id !== currentFamily.id) {
        this.onExpressionChange(family.versions[0]!.id);
      }
    });
    field.append(fieldName, fieldSelect);

    // 版の切り替え。選択中のファミリーが複数の版を持つときだけ出す。
    const versionRow = document.createElement('div');
    versionRow.className = 'control-row control-row--inline';
    if (currentFamily.versions.length > 1) {
      const versionName = document.createElement('span');
      versionName.textContent = 'Version';
      const versionButtons = document.createElement('div');
      versionButtons.className = 'button-row';
      for (const version of currentFamily.versions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className =
          version.id === this.composition.id ? 'ui-button is-primary' : 'ui-button';
        button.textContent = version.label;
        button.setAttribute('aria-label', `${currentFamily.label} ${version.label}`);
        button.setAttribute(
          'aria-pressed',
          String(version.id === this.composition.id),
        );
        button.addEventListener('click', () => this.onExpressionChange(version.id));
        versionButtons.append(button);
      }
      versionRow.append(versionName, versionButtons);
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

    // 画角（PRD D26）。板そのものがこの比率の長方形になる。
    const aspect = document.createElement('label');
    aspect.className = 'control-row control-row--inline';
    const aspectName = document.createElement('span');
    aspectName.textContent = 'Aspect';
    const aspectSelect = document.createElement('select');
    aspectSelect.setAttribute('aria-label', 'Aspect ratio');
    for (const definition of ASPECT_RATIOS) {
      const option = document.createElement('option');
      option.value = definition.id;
      option.textContent = definition.label;
      option.selected = definition.id === this.composition.getAspectId();
      aspectSelect.append(option);
    }
    aspectSelect.addEventListener('change', () => this.onAspectChange(aspectSelect.value));
    aspect.append(aspectName, aspectSelect);

    // 演奏面（PRD D24 案 1）: 各帯域が砂の励振へどれだけ効くか。
    // 像を結ぶ値（モード選択）ではないので、実行時に触って良い。
    const response = this.composition.getResponse();
    const responseTitle = document.createElement('h3');
    responseTitle.className = 'control-subheading';
    responseTitle.textContent = 'Response';
    const responseRows = (['bass', 'mid', 'treble'] as const).map((band) =>
      this.range(
        band.charAt(0).toUpperCase() + band.slice(1),
        response[band],
        0,
        2,
        0.01,
        (value) => this.onResponseChange({ [band]: value }),
      ),
    );

    // 持つ調整機能は表現ごとに宣言する（PRD D25）。サイマティクスは色のテーマのみで、
    // 奥行きは持たない。ズームは開発用（PRD D17）。
    this.compositionBody.append(field, versionRow, theme, aspect, responseTitle, ...responseRows);
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
      // 説明できるまで隠す（MTG 2026-07-27）。状態は温存し、表示だけしない。
      if (HIDDEN_COMMON_PARAMS.has(parameter.key)) continue;
      const block = document.createElement('div');
      block.className = 'effect-parameter-block';
      block.append(this.parameterControl(effect, parameter));
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
