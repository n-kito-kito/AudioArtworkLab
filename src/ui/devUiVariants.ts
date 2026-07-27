import type { StudioShell } from './StudioShell';

/**
 * 開発用の UI レイアウト試作（?ui=1|2|3）。
 *
 * 思想上の主従は Expression > 反応の調整 > Effect（PRD §3.2）だが、現行 UI は
 * 右パネル全体を占める Effect stack が最も目立ち、画面が語る順序が逆になっている。
 * どのレイアウトなら主従が伝わるかを実機で見比べるための仮組みで、選定用の使い捨て。
 *
 * 設計上の制約：
 * - パラメータなしのときは既定 UI を 1 ピクセルも変えない。よって既定では何も呼ばれず、
 *   見え方の変更はすべて `body[data-ui-variant]` にスコープした CSS 側で行う。
 * - 部品は**新規に作らず既存 DOM を移動**する。`append` / `prepend` はノードを
 *   複製せず移すため、select や slider に付いたイベントリスナーはそのまま生きる。
 * - パネルの開閉も DOM の削除ではなく CSS の `display` で行う。閉じている間も
 *   ノードが残るので、Effect の設定や再生位置などの状態が失われない。
 */
export type UiVariantId = 1 | 2 | 3;

/** `?ui=` の値を試作 ID に読む。想定外の値は「試作なし」として無視する。 */
export function parseUiVariant(raw: string | null): UiVariantId | null {
  if (raw === '1') return 1;
  if (raw === '2') return 2;
  if (raw === '3') return 3;
  return null;
}

/** 開閉状態を持たせる body 属性。CSS 側のセレクタと対になっている。 */
type PanelKey = 'uiAudio' | 'uiEffects';

/**
 * 左パネル内の Composition セクション（Expression / Version / Theme / Aspect / Response）。
 *
 * LabControls は中身（compositionBody）を毎回作り直すが、セクション要素自体は使い回す。
 * したがって**個々の行ではなくセクションごと移す**こと。行だけを抜き出すと、
 * 表現の切替で refresh が走った瞬間に元の位置へ作り直されて試作が壊れる。
 */
function findCompositionSection(shell: StudioShell): HTMLElement | null {
  return shell.leftTop.querySelector<HTMLElement>('.visual-section');
}

/**
 * 試作レイアウトを適用する。戻り値は後始末（HMR と dispose 用）。
 */
export function applyUiVariant(variant: UiVariantId, shell: StudioShell): () => void {
  const body = document.body;
  body.dataset.uiVariant = String(variant);

  const setPanel = (key: PanelKey, open: boolean): void => {
    body.dataset[key] = open ? 'on' : 'off';
  };

  // 3 案とも Effect は既定で畳む。「Effect は主役ではない」を画面で試すのが目的のため。
  setPanel('uiEffects', false);

  const created: HTMLElement[] = [];

  const toggleButton = (label: string, key: PanelKey, extraClass = ''): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ui-button dev-ui-toggle${extraClass ? ` ${extraClass}` : ''}`;
    button.textContent = label;
    const sync = (): void => {
      const open = body.dataset[key] === 'on';
      button.classList.toggle('is-active', open);
      button.setAttribute('aria-pressed', String(open));
    };
    button.addEventListener('click', () => {
      setPanel(key, body.dataset[key] !== 'on');
      sync();
    });
    sync();
    return button;
  };

  // 案 1・2: Effect stack を引き出しにする。右上に浮かせたトグルで出し入れする。
  if (variant === 1 || variant === 2) {
    const drawerToggle = toggleButton('Effects', 'uiEffects', 'dev-ui-toggle--drawer');
    shell.root.append(drawerToggle);
    created.push(drawerToggle);
  }

  // 案 2: 左パネルの並びを Composition → Audio に入れ替え、Expression を最上位に置く。
  // Response の強調は CSS 側（見出しと ~ 結合子）で行う。中身が作り直されても効く。
  if (variant === 2) {
    const composition = findCompositionSection(shell);
    if (composition) shell.leftTop.prepend(composition);
  }

  // 案 3: ステージを主役にし、操作は下部の HUD バーへ。左右パネルはオーバーレイ。
  if (variant === 3) {
    setPanel('uiAudio', false);

    const hud = document.createElement('div');
    hud.className = 'dev-hud';
    const hudMain = document.createElement('div');
    hudMain.className = 'dev-hud__main';
    const composition = findCompositionSection(shell);
    if (composition) hudMain.append(composition);
    const hudToggles = document.createElement('div');
    hudToggles.className = 'dev-hud__toggles';
    hudToggles.append(toggleButton('Audio', 'uiAudio'), toggleButton('Effects', 'uiEffects'));
    hud.append(hudMain, hudToggles);
    // stage の子にすることで、画角を変えてもキャンバスと一緒に動く。
    shell.stage.append(hud);
    created.push(hud);
  }

  return () => {
    // Composition セクションは LabControls が所有している。HUD ごと消すと
    // 二重管理になるため、元の左パネルへ戻してから試作の器だけを畳む。
    const composition = document.querySelector<HTMLElement>('.dev-hud .visual-section');
    if (composition) shell.leftTop.append(composition);
    for (const node of created) node.remove();
    delete body.dataset.uiVariant;
    delete body.dataset.uiAudio;
    delete body.dataset.uiEffects;
  };
}
