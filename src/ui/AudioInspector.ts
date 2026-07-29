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
 * Onset だけは連続メーターにしない。onset は瞬間値なので、メーターにすると
 * 人間の目にはほとんど何も映らない。検出した瞬間だけランプを短く点灯させる。
 *
 * **新旧 2 つの Onset を並べて出す。** 上段が engine の onset（広帯域 Volume の
 * 差分。旧方式）で、Core Study を選んでいるときは下段に帯域別スペクトルフラックス
 * （新方式）が並ぶ。どちらが何を拾って何を落としているかを、同じ音で見比べるための
 * 並びなので、旧方式の表示は消さない。
 *
 * Core Study（`LightCoreStudy`）を選んでいる間だけ、同じセクションの中に
 * フラックスの内訳・その表現の開発用スライダー・直近 Core の値を出す。
 * スライダーは表現が宣言した `getExpressionParams` / `setExpressionParam` を
 * そのまま使うので、メイン UI 側の `SHOW_EXPRESSION_PARAMS`（LabControls）とは
 * 独立に描ける。
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
  /** engine の解析値から出すメーターと表示名。 */
  meters: [
    ['volume', 'Volume'],
    ['bass', 'Bass'],
    ['mid', 'Mid'],
    ['treble', 'Treble'],
    ['onset', 'Onset (engine)'],
  ],
  /** 帯域別スペクトルフラックス（新方式）のメーターと表示名。 */
  fluxMeters: [
    ['bass', 'Flux Bass'],
    ['mid', 'Flux Mid'],
    ['treble', 'Flux Treble'],
    ['combined', 'Onset (flux)'],
  ],
  /** 帯域別 Onset（観察モード）の並びと表示名。 */
  bands: [
    ['bass', 'Bass'],
    ['mid', 'Mid'],
    ['treble', 'Treble'],
  ],
} as const;

type MeterKey = (typeof INSPECTOR.meters)[number][0];
type FluxKey = (typeof INSPECTOR.fluxMeters)[number][0];
type BandKey = (typeof INSPECTOR.bands)[number][0];

export class AudioInspector {
  private readonly engine: FileAudioEngine;
  private readonly getComposition: () => LabExpression;
  private readonly root = document.createElement('section');
  private readonly body = document.createElement('div');
  private readonly toggle = document.createElement('button');
  private readonly bars = new Map<MeterKey, HTMLElement>();
  private readonly values = new Map<MeterKey, HTMLElement>();
  private readonly onsetLamp = document.createElement('i');
  private readonly fluxBars = new Map<FluxKey, HTMLElement>();
  private readonly fluxValues = new Map<FluxKey, HTMLElement>();
  private readonly fluxLamp = document.createElement('i');
  private readonly fluxRows = document.createElement('div');
  private readonly fluxLampRow = document.createElement('div');
  /** 合成フラックスのメーター上に立てる、いま効いている閾値の縦線。 */
  private readonly thresholdMarker = document.createElement('b');
  /** 帯域ごとの閾値マーカー。各帯域の Gate は独立した閾値を持つ。 */
  private readonly bandMarkers = new Map<BandKey, HTMLElement>();
  private readonly bandLamps = new Map<BandKey, HTMLElement>();
  private readonly bandReadouts = new Map<BandKey, HTMLElement>();
  private readonly bandBlock = document.createElement('div');
  private readonly bandTally = document.createElement('p');
  private readonly previousBandFireCounts = new Map<BandKey, number>();
  private readonly bandLitUntil = new Map<BandKey, number>();
  private readonly coreBlock = document.createElement('div');
  private readonly coreReadout = document.createElement('p');
  private animationId: number | null = null;
  private collapsed = true;
  private previousOnset = 0;
  private onsetLitUntil = 0;
  private previousFireCount = 0;
  private fluxLitUntil = 0;

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
    this.buildFluxMeters();

    host.append(this.root);
    this.refresh();
    this.animationId = requestAnimationFrame(this.update);
  }

  /** 表現が差し替わったときに Core Study 用のブロックを組み直す。 */
  refresh(): void {
    this.coreBlock.replaceChildren();
    const composition = this.getComposition();
    if (!(composition instanceof LightCoreStudy)) return;

    // 新方式のフラックスは、上に並んだ engine の onset とすぐ見比べられる位置に置く。
    const fluxTitle = document.createElement('h3');
    fluxTitle.className = 'control-subheading';
    fluxTitle.textContent = 'Spectral flux (new)';
    this.coreBlock.append(fluxTitle, this.fluxRows, this.fluxLampRow);

    // 帯域別 Onset は観察だけ。Core を生む合成 Gate と混同しないよう見出しで断る。
    const bandTitle = document.createElement('h3');
    bandTitle.className = 'control-subheading';
    bandTitle.textContent = 'Band onsets (observe only)';
    this.coreBlock.append(bandTitle, this.bandBlock);

    const title = document.createElement('h3');
    title.className = 'control-subheading';
    title.textContent = 'Core Study (dev)';
    this.coreBlock.append(title);

    for (const parameter of composition.getExpressionParams()) {
      if (parameter.type === 'action') continue;
      if (parameter.type === 'select') {
        // 適応の on/off のような排他の切り替え。切り分け検証のために出す。
        this.coreBlock.append(
          this.select(parameter.label, parameter.options, parameter.value, (next) =>
            composition.setExpressionParam(parameter.key, next),
          ),
        );
        continue;
      }
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
    label.textContent = 'Onset detected (engine, old)';
    row.append(this.onsetLamp, label);
    return row;
  }

  /**
   * 帯域別フラックスのメーターとランプ。Core Study のときだけ表示するので、
   * 要素は 1 度だけ作り、`refresh()` で付け外しする。
   */
  private buildFluxMeters(): void {
    this.fluxRows.className = 'audio-inspector__rows';
    for (const [key, label] of INSPECTOR.fluxMeters) {
      const row = document.createElement('div');
      row.className = 'audio-inspector__row';
      const name = document.createElement('span');
      name.textContent = label;
      const bar = document.createElement('i');
      const value = document.createElement('output');
      value.textContent = '0.00';
      row.append(name, bar, value);
      this.fluxRows.append(row);
      this.fluxBars.set(key, bar);
      this.fluxValues.set(key, value);
      // 閾値マーカーは合成フラックスの行だけに立てる。値と閾値の位置関係が
      // ひと目で分かるので、適応がどう動いているかを目で追える。
      if (key === 'combined') {
        this.thresholdMarker.className = 'audio-inspector__threshold';
        bar.classList.add('has-threshold');
        bar.append(this.thresholdMarker);
      } else {
        // 帯域の行にも、その帯域の Gate が持つ独立した閾値を立てる。
        const marker = document.createElement('b');
        marker.className = 'audio-inspector__threshold';
        bar.classList.add('has-threshold');
        bar.append(marker);
        this.bandMarkers.set(key, marker);
      }
    }
    this.fluxLampRow.className = 'audio-inspector__lamp';
    this.fluxLamp.className = 'audio-inspector__lamp-dot';
    const label = document.createElement('span');
    label.textContent = 'Core fired (flux, new)';
    this.fluxLampRow.append(this.fluxLamp, label);
    this.buildBandBlock();
  }

  /**
   * 帯域別 Onset（観察モード）の表示。
   * ここは Core を生まない計測なので、合成 Gate の行とは節を分けて置く。
   */
  private buildBandBlock(): void {
    this.bandBlock.className = 'audio-inspector__bands';
    for (const [key, label] of INSPECTOR.bands) {
      const row = document.createElement('div');
      row.className = 'audio-inspector__band-row';
      const lamp = document.createElement('i');
      lamp.className = 'audio-inspector__lamp-dot';
      const name = document.createElement('span');
      name.textContent = label;
      const readout = document.createElement('output');
      readout.textContent = '—';
      row.append(lamp, name, readout);
      this.bandBlock.append(row);
      this.bandLamps.set(key, lamp);
      this.bandReadouts.set(key, readout);
      this.previousBandFireCounts.set(key, 0);
      this.bandLitUntil.set(key, 0);
    }
    this.bandTally.className = 'audio-inspector__readout';
    this.bandTally.textContent = 'no band events yet';
    this.bandBlock.append(this.bandTally);
  }

  /** 排他の選択肢 1 つ（適応の on/off など）。 */
  private select(
    labelText: string,
    options: readonly { readonly value: string; readonly label: string }[],
    current: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const label = document.createElement('label');
    label.className = 'control-row control-row--inline';
    const name = document.createElement('span');
    name.textContent = labelText;
    const select = document.createElement('select');
    select.setAttribute('aria-label', labelText);
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      node.selected = option.value === current;
      select.append(node);
    }
    select.addEventListener('change', () => onChange(select.value));
    label.append(name, select);
    return label;
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

    // 新方式のランプは自前判定ではなく、表現が実際に撃った回数の増分で点ける。
    // 見えている光と同じ出来事を指していないと、比較の意味がなくなるため。
    const composition = this.getComposition();
    const study = composition instanceof LightCoreStudy ? composition : null;
    const state = study?.getCoreStudyState() ?? null;
    if (state) {
      // 回数は曲ごとに 0 へ戻る（無音でリセットされる）ので、増分だけを見る。
      // 減ったフレームはリセットとみなし、点灯させずに追従する。
      if (state.fireCount > this.previousFireCount) {
        this.fluxLitUntil = now + INSPECTOR.onsetLampMs;
      }
      this.previousFireCount = state.fireCount;
      // 帯域ランプも、その帯域の Gate が実際に撃った回数の増分で点ける。
      for (const [key] of INSPECTOR.bands) {
        const count = state.bands[key].fireCount;
        if (count > (this.previousBandFireCounts.get(key) ?? 0)) {
          this.bandLitUntil.set(key, now + INSPECTOR.onsetLampMs);
        }
        this.previousBandFireCounts.set(key, count);
      }
    }

    if (!this.collapsed) {
      for (const [key, bar] of this.bars) {
        const level = Math.min(Math.max(parameters[key] ?? 0, 0), 1);
        bar.style.setProperty('--level', String(level));
        this.values.get(key)!.textContent = level.toFixed(2);
      }
      this.onsetLamp.classList.toggle('is-lit', now < this.onsetLitUntil);

      if (state) {
        for (const [key, bar] of this.fluxBars) {
          const level = Math.min(Math.max(state.flux[key], 0), 1);
          bar.style.setProperty('--level', String(level));
          this.fluxValues.get(key)!.textContent = level.toFixed(2);
        }
        this.fluxLamp.classList.toggle('is-lit', now < this.fluxLitUntil);
        // 閾値の縦線。ウォームアップ中は固定閾値で動いていることが分かる見た目にする。
        this.thresholdMarker.style.setProperty(
          '--at',
          String(Math.min(Math.max(state.onsetThreshold, 0), 1)),
        );
        this.thresholdMarker.classList.toggle('is-warming', state.thresholdWarmingUp);
        this.thresholdMarker.classList.toggle('is-fixed', !state.adaptiveThreshold);

        // 帯域別 Onset（観察）。閾値・ランプ・直近 strength・累計をそれぞれ出す。
        for (const [key] of INSPECTOR.bands) {
          const band = state.bands[key];
          const marker = this.bandMarkers.get(key)!;
          marker.style.setProperty('--at', String(Math.min(Math.max(band.threshold, 0), 1)));
          marker.classList.toggle('is-warming', band.warmingUp);
          marker.classList.toggle('is-fixed', !state.adaptiveThreshold);
          this.bandLamps
            .get(key)!
            .classList.toggle('is-lit', now < (this.bandLitUntil.get(key) ?? 0));
          this.bandReadouts.get(key)!.textContent = band.warmingUp
            ? `warming  ×${band.fireCount}`
            : `str ${band.lastStrength.toFixed(2)}  ×${band.fireCount}`;
        }
        const c = state.coincidence;
        this.bandTally.textContent =
          `last event ${c.lastEvent || '—'}\n` +
          `bass only ${c.bassOnly}  mid only ${c.midOnly}  treble only ${c.trebleOnly}\n` +
          `two bands ${c.twoBands}  three bands ${c.threeBands}  total ${c.events}`;
        // 直近 Core と適応の状態。どの特徴量がどの見え方を決めたかを追えるようにする。
        const mode = state.adaptiveThreshold
          ? state.thresholdWarmingUp
            ? `warming up ${state.thresholdSamples}`
            : 'adaptive'
          : 'fixed';
        this.coreReadout.textContent =
          `cores ${state.count}  fired ${state.fireCount}\n` +
          `flux threshold ${state.onsetThreshold.toFixed(3)} (${mode})\n` +
          `strength reference ${state.adaptiveStrength ? state.strengthReference.toFixed(3) : 'off'}\n` +
          `spectral centroid ${state.lastSpectralCentroid.toFixed(2)}\n` +
          `x position ${state.lastX.toFixed(2)}\n` +
          `onset strength ${state.lastOnsetStrength.toFixed(2)}\n` +
          `peak intensity ${state.lastPeakIntensity.toFixed(2)}`;
      }
    }

    this.animationId = requestAnimationFrame(this.update);
  };
}
