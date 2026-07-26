import './style.css';
import { FileAudioEngine } from './audio/FileAudioEngine';
import { REFERENCE_AUDIO_NAME, REFERENCE_AUDIO_URL } from './audio/referenceAudio';
import { App } from './core/App';
import { createEffects, transferEffectState } from './effects/catalog';
import { findTheme } from './engine/themes';
import {
  createExpression,
  normalizeExpressionId,
  type ExpressionId,
  type PlateExpression,
} from './expressions/catalog';
import { ComparisonPlate } from './expressions/ComparisonPlate';
import { AudioControls } from './ui/AudioControls';
import { LabControls } from './ui/LabControls';
import { DebugPanel } from './ui/DebugPanel';
import { TuningPanel } from './ui/TuningPanel';
import {
  applyEffectStates,
  createLabPreset,
  loadLabPreset,
  orderEffects,
  parseLabPreset,
  saveLabPreset,
  type LabPreset,
} from './ui/LabPreset';
import { QualityMonitor } from './ui/QualityMonitor';
import { RecordingController } from './ui/RecordingController';
import { StudioShell } from './ui/StudioShell';

// 再構築中（DESIGN.md 実装順序）。
// StudioControls / LayerEditor / RecordingController / QualityMonitor は
// 旧 Generator 前提のため、Field / Renderer 選択の UI ができるまで接続しない。
// LayerEditor は D1 により温存する（削除しない）。

const container = document.querySelector<HTMLDivElement>('#app');

if (!container) {
  throw new Error('App container not found');
}

const audioEngine = new FileAudioEngine();

// 前回の状態から復元して起動する。
const storedPreset = loadLabPreset();
const initialEffects = createEffects();
if (storedPreset) {
  applyEffectStates(initialEffects, storedPreset.effects);
  orderEffects(
    initialEffects,
    storedPreset.effects.map((entry) => entry.name),
  );
}
// 開発用の V1 / V2 比較表示（?compare=1）。同じ音・同じ時刻で並走させる。
const comparison =
  import.meta.env.DEV && new URLSearchParams(location.search).get('compare') === '1'
    ? new ComparisonPlate(initialEffects, findTheme(storedPreset?.themeName ?? ''))
    : null;

let composition: PlateExpression =
  comparison ??
  createExpression(
    normalizeExpressionId(storedPreset?.expressionId),
    initialEffects,
    findTheme(storedPreset?.themeName ?? ''),
  );
// zoom は開発用（PRD D17）のため保存値は適用せず、常に等倍で起動する。
if (storedPreset) composition.setDepth(storedPreset.depth);
const shell = new StudioShell(container);
const app = new App(shell.canvasHost, composition, audioEngine);

const setTheme = (name: string): void => {
  composition.setTheme(findTheme(name));
};

const setDepth = (amount: number): void => {
  composition.setDepth(amount);
};

const notify = (message: string, error = false): void => {
  const notice = document.createElement('div');
  notice.className = `studio-notice${error ? ' is-error' : ''}`;
  notice.textContent = message;
  shell.root.append(notice);
  window.setTimeout(() => notice.remove(), 2200);
};

/**
 * 表現（V1/V2）を切り替える。状態は共有しない: 旧 composition は dispose され、
 * Effect はシェーダーごと破棄されるため、新しいインスタンスへ設定だけ引き継ぐ。
 */
const switchExpression = (id: ExpressionId): void => {
  // 比較表示では両方を同時に走らせているため、切り替えは行わない。
  if (comparison || id === composition.id) return;
  const effects = createEffects();
  transferEffectState(composition.getEffects(), effects);
  const next = createExpression(id, effects, composition.getTheme());
  next.setDepth(composition.getDepth());
  next.setZoom(composition.getZoom());
  app.setComposition(next);
  composition = next;
  labControls.refresh(composition);
  savePresetNow();
};

const applyPreset = (preset: LabPreset): void => {
  switchExpression(normalizeExpressionId(preset.expressionId));
  setTheme(preset.themeName);
  setDepth(preset.depth);
  applyEffectStates(composition.getEffects(), preset.effects);
  composition.setEffectOrder(preset.effects.map((entry) => entry.name));
  labControls.refresh(composition);
};

const exportPreset = (): void => {
  const link = document.createElement('a');
  link.download = `audio-artwork-preset-${Date.now()}.json`;
  link.href = URL.createObjectURL(
    new Blob([JSON.stringify(createLabPreset(composition), null, 2)], {
      type: 'application/json',
    }),
  );
  link.click();
  URL.revokeObjectURL(link.href);
  notify('Preset exported');
};

const importPreset = (json: string): void => {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    /* parseLabPreset が null を返す */
  }
  const preset = parseLabPreset(parsed);
  if (!preset) {
    notify('Invalid preset file', true);
    return;
  }
  applyPreset(preset);
  saveLabPreset(preset);
  notify('Preset imported');
};

// 自動保存。状態が変わったときだけ書く。
let lastSavedPreset = '';
const savePresetNow = (): void => {
  const preset = createLabPreset(composition);
  const json = JSON.stringify(preset);
  if (json === lastSavedPreset) return;
  lastSavedPreset = json;
  saveLabPreset(preset);
};
const autosaveTimer = window.setInterval(savePresetNow, 1500);
const audioControls = new AudioControls(shell.leftTop, audioEngine);
const recordingController = new RecordingController(shell, audioEngine);
const labControls = new LabControls(
  shell,
  composition,
  (id) => switchExpression(id),
  setTheme,
  setDepth,
  () => app.exportPng(),
  () => recordingController.toggle(),
  exportPreset,
  importPreset,
);
const qualityMonitor = new QualityMonitor(shell, app, () => composition.getEffects());

// 開発用チューニングパネル（PRD D17）。?tune=1 のときだけ現れる。
const tuningPanel =
  import.meta.env.DEV && new URLSearchParams(location.search).get('tune') === '1'
    ? new TuningPanel(shell.root, () => composition)
    : null;

// 開発用デバッグパネル（?debug=1）。励起状態と各表示の切り替え。
const debugPanel =
  import.meta.env.DEV && new URLSearchParams(location.search).get('debug') === '1'
    ? new DebugPanel(shell.root, () => composition, audioEngine, comparison)
    : null;
let disposed = false;

// 確認用音源を既定で読み込む。無ければ何もしない（起動は妨げない）。
// 再生はブラウザの制約により利用者の操作が要るため、ここでは読み込みだけ行う。
void audioControls.loadReference(REFERENCE_AUDIO_URL, REFERENCE_AUDIO_NAME);

const dispose = (): void => {
  if (disposed) return;
  disposed = true;
  window.clearInterval(autosaveTimer);
  savePresetNow();
  audioControls.dispose();
  recordingController.dispose();
  qualityMonitor.dispose();
  tuningPanel?.dispose();
  debugPanel?.dispose();
  labControls.dispose();
  app.dispose();
  shell.dispose();
};

// 開発時のみ。音がないと何も描かれない仕様のため、
// 解析値を差し替えて描画を確認できるようにしておく。本番ビルドには含まれない。
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__lab = {
    app,
    audioEngine,
    applyPreset,
    savePresetNow,
    get composition() {
      return composition;
    },
  };
}

window.addEventListener('beforeunload', dispose, { once: true });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener('beforeunload', dispose);
    dispose();
  });
}
