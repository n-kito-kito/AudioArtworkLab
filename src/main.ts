import './style.css';
import { FileAudioEngine } from './audio/FileAudioEngine';
import { REFERENCE_AUDIO_NAME, REFERENCE_AUDIO_URL } from './audio/referenceAudio';
import { App } from './core/App';
import { createEffects, transferEffectState } from './effects/catalog';
import { findTheme } from './engine/themes';
import {
  ASPECT_RATIOS,
  createExpression,
  normalizeAspectId,
  normalizeExpressionId,
  type ExpressionId,
} from './expressions/catalog';
import type { LabExpression } from './expressions/Expression';
import { AudioControls } from './ui/AudioControls';
import { AudioInspector } from './ui/AudioInspector';
import { LabControls } from './ui/LabControls';
import { AudioLabPage } from './ui/AudioLabPage';
import { DebugPanel } from './ui/DebugPanel';
import { applyUiVariant, parseUiVariant } from './ui/devUiVariants';
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
import { OutputWindow } from './ui/OutputWindow';
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
// UI 層は表現の共通面（LabExpression）に対して書く。実体がサイマティクスでも
// ここで面を固定しておくと、別の表現ファミリーを足すときに main を書き換えずに済む。
let composition: LabExpression = createExpression(
  normalizeExpressionId(storedPreset?.expressionId),
  initialEffects,
  findTheme(storedPreset?.themeName ?? ''),
);
// zoom は開発用（PRD D17）のため保存値は適用せず、常に等倍で起動する。
// 奥行きはサイマティクスでは持たない（PRD D25）。
if (storedPreset) composition.setResponse(storedPreset.response);
const shell = new StudioShell(container);
const app = new App(shell.canvasHost, composition, audioEngine);

const setTheme = (name: string): void => {
  composition.setTheme(findTheme(name));
};

const setResponse = (gains: Partial<{ bass: number; mid: number; treble: number }>): void => {
  composition.setResponse(gains);
};

/**
 * 画角（D26）。板そのものを取り替える操作。キャンバスの比率を板に合わせ、
 * ResizeObserver 経由でレンダラーが追従する。砂は撒き直しになる。
 */
const setAspect = (rawId: string): void => {
  const id = normalizeAspectId(rawId);
  const definition = ASPECT_RATIOS.find((entry) => entry.id === id)!;
  composition.setAspect(definition.id, definition.ratio);
  shell.canvasHost.style.aspectRatio = `${definition.ratio}`;
  if (definition.ratio < 1) {
    // 縦長は高さ基準にしないと画面からはみ出す。幅は aspect-ratio が決める。
    shell.canvasHost.style.width = 'auto';
    shell.canvasHost.style.height = 'min(72vmin, 760px)';
  } else {
    shell.canvasHost.style.width = '';
    shell.canvasHost.style.height = '';
  }
  app.resizeNow();
};

// 前回の画角を復元する（キャンバスの比率も揃える）。
if (storedPreset) setAspect(storedPreset.aspect);

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
  if (id === composition.id) return;
  const effects = createEffects();
  transferEffectState(composition.getEffects(), effects);
  const next = createExpression(id, effects, composition.getTheme());
  next.setZoom(composition.getZoom());
  next.setResponse(composition.getResponse());
  next.setAspect(composition.getAspectId(), composition.getAspectRatio());
  app.setComposition(next);
  composition = next;
  labControls.refresh(composition);
  audioInspector.refresh();
  // 質感は版ごとに焼き込まれている。切替で TUNING が入れ替わるため追従させる。
  tuningPanel?.refresh();
  savePresetNow();
};

const applyPreset = (preset: LabPreset): void => {
  switchExpression(normalizeExpressionId(preset.expressionId));
  setTheme(preset.themeName);
  setResponse(preset.response);
  setAspect(preset.aspect);
  applyEffectStates(composition.getEffects(), preset.effects);
  composition.setEffectOrder(preset.effects.map((entry) => entry.name));
  labControls.refresh(composition);
  audioInspector.refresh();
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
const outputWindow = new OutputWindow(shell, notify);
const labControls = new LabControls(
  shell,
  composition,
  (id) => switchExpression(id),
  setTheme,
  setResponse,
  (id) => {
    setAspect(id);
    savePresetNow();
  },
  () => app.exportPng(),
  () => recordingController.toggle(),
  () => outputWindow.toggle(),
  exportPreset,
  importPreset,
);
// QualityMonitor（FPS・解像度セレクト）は説明できるまで載せない（MTG 2026-07-27。温存）。

// 音の解析値を確かめるための開発用セクション（既定は閉じている）。
// 左パネルの末尾に置くため、LabControls が Composition 節を append した後に作る。
const audioInspector = new AudioInspector(shell.leftTop, audioEngine, () => composition);

// 開発用の UI レイアウト試作（?ui=1|2|3）。Expression / 反応の調整 / Effect の
// 主従を画面に出せるか見比べるための仮組み。パラメータなしでは何もしない。
// LabControls の DOM を移動させるため、必ずその生成後に呼ぶこと。
const uiVariant = import.meta.env.DEV
  ? parseUiVariant(new URLSearchParams(location.search).get('ui'))
  : null;
const disposeUiVariant = uiVariant ? applyUiVariant(uiVariant, shell) : null;

// 開発用チューニングパネル（PRD D17）。?tune=1 のときだけ現れる。
const tuningPanel =
  import.meta.env.DEV && new URLSearchParams(location.search).get('tune') === '1'
    ? new TuningPanel(shell.root, () => composition)
    : null;

// 開発用デバッグパネル（?debug=1）。励起状態と各表示の切り替え。
const debugPanel =
  import.meta.env.DEV && new URLSearchParams(location.search).get('debug') === '1'
    ? new DebugPanel(shell.root, () => composition, audioEngine)
    : null;

// 解析専用の開発ページ（?audio=1）。**表現は描かず**、音の特徴だけを大きく出す。
// ?tune=1 と同じ扱いで DEV 限定なので、本番ビルドには入らない。
const audioLabPage =
  import.meta.env.DEV && new URLSearchParams(location.search).get('audio') === '1'
    ? new AudioLabPage(shell.root, audioEngine)
    : null;
// 観察のための画面なので、表現は描かせない（1 ドローも出さない）。
if (audioLabPage) {
  shell.root.classList.add('is-audio-lab');
  composition.setGeneratorsVisible(false);
}
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
  audioInspector.dispose();
  recordingController.dispose();
  outputWindow.dispose();
  tuningPanel?.dispose();
  audioLabPage?.dispose();
  debugPanel?.dispose();
  disposeUiVariant?.();
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
