import type { FileAudioEngine } from '../audio/FileAudioEngine';
import type { LabExpression } from '../expressions/Expression';
import { LightCoreStudy } from '../expressions/LightCoreStudy';

/**
 * Audio Feature Inspector（開発・検証用）。
 *
 * 「音のどの特徴が、どのタイミングで、どれだけ動いているか」を数字と横メーターで見せる。
 * 表現の見え方だけを見ていても因果が確かめられないので、engine の生の解析値を
 * 同じ画面に並べるためのもの。**engine には触らない（読むだけ）。**
 *
 * Onset だけは連続メーターにしない。engine の onset は瞬間値なので、
 * メーターにすると人間の目にはほとんど何も映らない。ここでは
 * 「立ち上がりエッジ + 閾値」で検出した瞬間だけランプを短く点灯させる。
 *
 * Core Study（`LightCoreStudy`）を選んでいる間だけ、同じセクションの中に
 * その表現の開発用スライダーと直近 Core の値を出す。実装は表現が宣言した
 * `getExpressionParams` / `setExpressionParam` をそのまま使うので、
 * メイン UI 側の `SHOW_EXPRESSION_PARAMS`（LabControls）とは独立に描ける。
 */

/** この Inspector の定数。判定条件そのものなので 1 箇所に集める。 */
const INSPECTOR = {
  /** Onset ランプの点灯時間（ミリ秒）。短すぎると目で追えない。 */
  onsetLampMs: 120,
  /**
   * Onset ランプの閾値。表現側の判定とは独立で、
   * 「engine がこの大きさの立ち上がりを報告した」ことだけを示す。
   * 無音のノイズで点きっぱなしにならない程度に上げてある。
   */
  onsetThreshold: 0.3,
  /** この音量を下回るフレームは点灯させない（無音時の連続点灯を止める）。 */
  minimumVolume: 0.06,
  /** メーターに出す特徴量と表示名。 */
  meters: [
    ['volume', 'Volume'],
    ['bass', 'Bass'],
    ['mid', 'Mid'],
    ['treble', 'Treble'],
    ['onset', 'Onset Strength'],
  ],
} as const;

type MeterKey = (typeof INSPECTOR.meters)[number][0];

export class AudioInspector {
  private readonly engine: FileAudioEngine;
  private readonly getComposition: () => LabExpression;
  private readonly root = document.createElement('section');
  private readonly body = document.createElement('div');
  private readonly toggle = document.createElement('button');
  private readonly bars = new Map<MeterKey, HTMLElement>();
  private readonly values = new Map<MeterKey, HTMLElement>();
  private readonly onsetLamp = document.createElement('i');
  private readonly coreBlock = document.createElement('div');
  private readonly coreReadout = document.createElement('p');
  private animationId: number | null = null;
  private collapsed = true;
  private previousOnset = 0;
  private onsetLitUntil = 0;

  constructor(
    host: HTMLElement,
    engine: FileAudioEngine,
    getComposition: () => LabExpression,
  ) {
    this.engine = engine;
    this.getComposition = getComposition;

    this.root.className = 'panel-section audio-inspector is-collapsed';
    this.root.setAttribute('aria-label', 'Audio analysis (development)');
    this.root.append(this.buildHeading(), this.body);

    this.body.className = 'audio-inspector__body';
    this.body.append(this.buildMeters(), this.buildOnsetLamp(), this.coreBlock);
    this.coreBlock.className = 'audio-inspector__core';
    this.coreReadout.className = 'audio-inspector__readout';

    host.append(this.root);
    this.refresh();
    this.animationId = requestAnimationFrame(this.update);
  }

  /** 表現が差し替わったときに Core Study 用のブロックを組み直す。 */
  refresh(): void {
    this.coreBlock.replaceChildren();
    const composition = this.getComposition();
    if (!(composition instanceof LightCoreStudy)) return;

    const title = document.createElement('h3');
    title.className = 'control-subheading';
    title.textContent = 'Core Study (dev)';
    this.coreBlock.append(title);

    for (const parameter of composition.getExpressionParams()) {
      if (parameter.type === 'select' || parameter.type === 'action') continue;
      this.coreBlock.append(
        this.range(parameter.label, parameter.value, parameter.min, parameter.max, parameter.step, (next) =>
          composition.setExpressionParam(parameter.key, next),
        ),
      );
    }
    this.coreReadout.textContent = 'last core —';
    this.coreBlock.append(this.coreReadout);
  }

  dispose(): void {
    if (this.animationId !== null) cancelAnimationFrame(this.animationId);
    this.animationId = null;
    this.root.remove();
  }

  private buildHeading(): HTMLElement {
    const heading = document.createElement('h2');
    const icon = document.createElement('i');
    icon.className = 'ph ph-waveform';
    const title = document.createElement('span');
    title.textContent = 'Audio Analysis (dev)';
    this.toggle.type = 'button';
    this.toggle.className = 'ui-button section-collapse';
    this.toggle.setAttribute('aria-label', 'Toggle audio analysis');
    this.toggle.setAttribute('aria-expanded', 'false');
    const chevron = document.createElement('i');
    chevron.className = 'ph ph-caret-down';
    const chevronLabel = document.createElement('span');
    chevronLabel.textContent = 'Toggle';
    this.toggle.append(chevron, chevronLabel);
    this.toggle.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    heading.append(icon, title, this.toggle);
    return heading;
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.root.classList.toggle('is-collapsed', collapsed);
    this.toggle.classList.toggle('is-rotated', !collapsed);
    this.toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  private buildMeters(): HTMLElement {
    const group = document.createElement('div');
    group.className = 'audio-inspector__rows';
    for (const [key, label] of INSPECTOR.meters) {
      const row = document.createElement('div');
      row.className = 'audio-inspector__row';
      const name = document.createElement('span');
      name.textContent = label;
      const bar = document.createElement('i');
      const value = document.createElement('output');
      value.textContent = '0.00';
      row.append(name, bar, value);
      group.append(row);
      this.bars.set(key, bar);
      this.values.set(key, value);
    }
    return group;
  }

  private buildOnsetLamp(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'audio-inspector__lamp';
    this.onsetLamp.className = 'audio-inspector__lamp-dot';
    const label = document.createElement('span');
    label.textContent = 'Onset detected';
    row.append(this.onsetLamp, label);
    return row;
  }

  /** LabControls と同じ見た目のスライダー 1 本。 */
  private range(
    labelText: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onInput: (value: number) => void,
  ): HTMLElement {
    const label = document.createElement('label');
    label.className = 'control-row control-row--range';
    const name = document.createElement('span');
    name.textContent = labelText;
    const output = document.createElement('output');
    output.textContent = String(Number(value.toFixed(3)));
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute('aria-label', labelText);
    input.addEventListener('input', () => {
      const next = Number(input.value);
      output.textContent = String(Number(next.toFixed(3)));
      onInput(next);
    });
    label.append(name, output, input);
    return label;
  }

  /**
   * 毎フレーム。Onset のエッジ検出は畳んでいても続ける
   * （開いた瞬間に古い値と比べて誤って点灯しないようにするため）。
   * DOM の書き換えは開いているときだけ行う。
   */
  private readonly update = (): void => {
    const parameters = this.engine.getParameters();
    const active = parameters.active === 1;
    const onset = Math.min(Math.max(parameters.onset ?? 0, 0), 1);
    const volume = Math.min(Math.max(parameters.volume ?? 0, 0), 1);
    const now = performance.now();
    const rising = onset > this.previousOnset;
    this.previousOnset = onset;
    if (
      active &&
      rising &&
      onset >= INSPECTOR.onsetThreshold &&
      volume >= INSPECTOR.minimumVolume
    ) {
      this.onsetLitUntil = now + INSPECTOR.onsetLampMs;
    }

    if (!this.collapsed) {
      for (const [key, bar] of this.bars) {
        const level = Math.min(Math.max(parameters[key] ?? 0, 0), 1);
        bar.style.setProperty('--level', String(level));
        this.values.get(key)!.textContent = level.toFixed(2);
      }
      this.onsetLamp.classList.toggle('is-lit', now < this.onsetLitUntil);

      const composition = this.getComposition();
      if (composition instanceof LightCoreStudy) {
        const state = composition.getCoreStudyState();
        this.coreReadout.textContent =
          `cores ${state.count}  ` +
          `last onsetStrength ${state.lastOnsetStrength.toFixed(2)}  ` +
          `peakIntensity ${state.lastPeakIntensity.toFixed(2)}`;
      }
    }

    this.animationId = requestAnimationFrame(this.update);
  };
}
