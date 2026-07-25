import type { CymaticsPlate } from '../expressions/CymaticsPlate';
import { TUNING, TUNING_DEFAULTS, type TuningKey } from '../engine/tuning';

interface TuningControl {
  key: TuningKey;
  label: string;
  min: number;
  max: number;
  step: number;
}

interface TuningGroup {
  title: string;
  controls: TuningControl[];
}

/**
 * 開発用チューニングパネル（`?tune=1`）。
 *
 * 範囲と感度は作り手が焼き込む内部定数であり、本番 UI には出さない（PRD D17）。
 * ここで良い値を見つけ、`Copy values` で書き出し、`engine/tuning.ts` の
 * 既定値へ転記して確定する。
 *
 * 値はプリセットに保存しない。実行時のユーザーには存在しない層である。
 */
const GROUPS: TuningGroup[] = [
  {
    title: '板と粒子',
    controls: [
      { key: 'excite', label: '励振の強さ', min: 0, max: 4, step: 0.01 },
      { key: 'simSpeed', label: '粒子の最高速度', min: 0.02, max: 1, step: 0.01 },
      { key: 'jitterBase', label: '震え', min: 0, max: 1.5, step: 0.01 },
      { key: 'scatter', label: 'ノイズ → 散乱', min: 0, max: 2, step: 0.01 },
      { key: 'lift', label: 'オンセット → 浮遊', min: 0, max: 5, step: 0.01 },
      { key: 'settleBase', label: '摩擦', min: 0, max: 6, step: 0.01 },
      { key: 'settleSustain', label: '持続 → 定着', min: 0, max: 10, step: 0.01 },
      { key: 'repulsion', label: '高密度の反発', min: 0, max: 5, step: 0.01 },
      { key: 'diffusion', label: 'にじみ', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: '見た目',
    controls: [
      { key: 'grainBase', label: '粒の大きさ', min: 0.35, max: 3, step: 0.01 },
      { key: 'inkBase', label: '濃さ', min: 0, max: 1, step: 0.01 },
      { key: 'inkSustain', label: '持続 → 濃さ', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: '場（振動モード）',
    controls: [
      { key: 'scaleBase', label: '場の粗さ', min: 0.2, max: 2.5, step: 0.01 },
      { key: 'scaleCentroid', label: '明るさ → 粗さ', min: 0, max: 3, step: 0.01 },
      { key: 'warpAmount', label: '低域 → うねり', min: 0, max: 1, step: 0.01 },
      { key: 'breakAmount', label: 'ノイズ → 崩れ', min: 0, max: 0.6, step: 0.01 },
    ],
  },
  {
    title: '動き',
    controls: [
      { key: 'morphDuration', label: '移行の時間 (秒)', min: 0.2, max: 10, step: 0.1 },
      { key: 'seedCooldown', label: '構図の間隔 (秒)', min: 0.2, max: 15, step: 0.1 },
    ],
  },
];

export class TuningPanel {
  private readonly root = document.createElement('aside');
  private readonly getComposition: () => CymaticsPlate;

  constructor(host: HTMLElement, getComposition: () => CymaticsPlate) {
    this.getComposition = getComposition;

    this.root.className = 'tuning-panel';
    this.root.setAttribute('aria-label', 'Tuning (development)');

    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = 'Tuning';
    const note = document.createElement('span');
    note.textContent = '開発用。値は保存されない';
    header.append(title, note);
    this.root.append(header);

    // ズームは開発用（PRD D17）。良い見え感を探すためここに置く。
    this.root.append(
      this.slider('ズーム', this.getComposition().getZoom(), 0.5, 6, 0.01, (value) =>
        this.getComposition().setZoom(value),
      ),
    );

    for (const group of GROUPS) {
      const heading = document.createElement('h3');
      heading.textContent = group.title;
      this.root.append(heading);
      for (const control of group.controls) {
        this.root.append(
          this.slider(
            control.label,
            TUNING[control.key],
            control.min,
            control.max,
            control.step,
            (value) => {
              TUNING[control.key] = value;
            },
            control.key,
          ),
        );
      }
    }

    const actions = document.createElement('div');
    actions.className = 'tuning-panel__actions';
    actions.append(
      this.button('Copy values', () => void this.copyValues()),
      this.button('Reset', () => this.reset()),
    );
    this.root.append(actions);

    host.append(this.root);
  }

  dispose(): void {
    this.root.remove();
  }

  /** tuning.ts へ貼り戻せる形で書き出す。 */
  private async copyValues(): Promise<void> {
    const body = (Object.keys(TUNING) as TuningKey[])
      .map((key) => `  ${key}: ${Number(TUNING[key].toFixed(4))},`)
      .join('\n');
    const text = `export const TUNING = {\n${body}\n};`;
    // クリップボードは環境によって拒否されるため、常にコンソールへも残す。
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      this.flash('コピーしました（コンソールにも出力）');
    } catch {
      this.flash('コンソールへ出力しました');
    }
  }

  private reset(): void {
    for (const key of Object.keys(TUNING_DEFAULTS) as TuningKey[]) {
      TUNING[key] = TUNING_DEFAULTS[key];
    }
    this.root.querySelectorAll('input[type="range"]').forEach((element) => {
      const input = element as HTMLInputElement;
      const key = input.dataset.key as TuningKey | undefined;
      if (!key) return;
      input.value = String(TUNING_DEFAULTS[key]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    this.flash('既定値へ戻しました');
  }

  private flash(message: string): void {
    const notice = document.createElement('div');
    notice.className = 'studio-notice';
    notice.textContent = message;
    document.body.append(notice);
    window.setTimeout(() => notice.remove(), 1800);
  }

  private slider(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onInput: (value: number) => void,
    key?: TuningKey,
  ): HTMLElement {
    const row = document.createElement('label');
    row.className = 'control-row control-row--range';
    const name = document.createElement('span');
    name.textContent = label;
    const output = document.createElement('output');
    output.textContent = String(Number(value.toFixed(3)));
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute('aria-label', label);
    if (key) input.dataset.key = key;
    input.addEventListener('input', () => {
      const next = Number(input.value);
      output.textContent = String(Number(next.toFixed(3)));
      onInput(next);
    });
    row.append(name, output, input);
    return row;
  }

  private button(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ui-button';
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }
}
