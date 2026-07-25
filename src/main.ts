import './style.css';
import { FileAudioEngine } from './audio/FileAudioEngine';
import { REFERENCE_AUDIO_NAME, REFERENCE_AUDIO_URL } from './audio/referenceAudio';
import { App } from './core/App';
import { Cymatics } from './fields/Cymatics';
import { FieldComposition } from './engine/FieldComposition';
import { createEffects, transferEffectState } from './effects/catalog';
import { findTheme } from './engine/themes';
import { RENDERERS, createRenderer } from './renderers/catalog';
import { AudioControls } from './ui/AudioControls';
import { LabControls } from './ui/LabControls';
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
let composition = new FieldComposition(
  new Cymatics(),
  createRenderer(storedPreset?.rendererName ?? RENDERERS[0]!.name),
  initialEffects,
  findTheme(storedPreset?.themeName ?? ''),
);
if (storedPreset) {
  composition.setDepth(storedPreset.depth);
  composition.setZoom(storedPreset.zoom);
}
const shell = new StudioShell(container);
const app = new App(shell.canvasHost, composition, audioEngine);

const setRenderer = (name: string): FieldComposition => {
  const from = composition.getRenderer();
  // 名前は catalog で解決してから比較する。未知の名前（旧プリセット等）が
  // 既定へフォールバックしたとき、同じ見え方同士のトランジションを組まないため。
  const next = createRenderer(name);
  if (from.name === next.name) return composition;

  // Effect の設定とテーマ・奥行きは表現をまたいで保つ。
  // 前の Renderer を渡すことで、切り替えはリニアトランジションになる。
  const effects = createEffects();
  transferEffectState(composition.getEffects(), effects);
  const depth = composition.getDepth();
  const zoom = composition.getZoom();
  composition = new FieldComposition(
    new Cymatics(),
    next,
    effects,
    composition.getTheme(),
    from,
  );
  composition.setDepth(depth);
  composition.setZoom(zoom);
  app.setComposition(composition);
  return composition;
};

const setTheme = (name: string): void => {
  composition.setTheme(findTheme(name));
};

const setDepth = (amount: number): void => {
  composition.setDepth(amount);
};

const setZoom = (zoom: number): void => {
  composition.setZoom(zoom);
};

const notify = (message: string, error = false): void => {
  const notice = document.createElement('div');
  notice.className = `studio-notice${error ? ' is-error' : ''}`;
  notice.textContent = message;
  shell.root.append(notice);
  window.setTimeout(() => notice.remove(), 2200);
};

const applyPreset = (preset: LabPreset): void => {
  setTheme(preset.themeName);
  setDepth(preset.depth);
  setZoom(preset.zoom);
  const target = setRenderer(preset.rendererName);
  applyEffectStates(target.getEffects(), preset.effects);
  target.setEffectOrder(preset.effects.map((entry) => entry.name));
  labControls.refresh(target);
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
  setTheme,
  setDepth,
  setZoom,
  () => app.exportPng(),
  () => recordingController.toggle(),
  exportPreset,
  importPreset,
);
const qualityMonitor = new QualityMonitor(shell, app, () => composition.getEffects());
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
    setRenderer,
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
