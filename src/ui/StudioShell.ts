export class StudioShell {
  readonly root = document.createElement('div');
  readonly toolbar = document.createElement('header');
  readonly leftPanel = document.createElement('aside');
  readonly leftTop = document.createElement('div');
  readonly leftBottom = document.createElement('div');
  readonly stage = document.createElement('main');
  readonly canvasHost = document.createElement('div');
  readonly objectToolbar = document.createElement('div');
  readonly rightSidebar = document.createElement('aside');
  readonly designPanel = document.createElement('div');
  readonly effectsPanel = document.createElement('div');
  readonly chain = document.createElement('nav');
  readonly gridOverlay = document.createElement('div');
  private readonly designTab = document.createElement('button');
  private readonly effectsTab = document.createElement('button');

  constructor(container: HTMLElement) {
    this.root.className = 'studio-shell';
    this.toolbar.className = 'topbar';
    this.toolbar.setAttribute('aria-label', 'Studio toolbar');
    this.leftPanel.className = 'control-panel control-panel--left';
    this.leftPanel.setAttribute('aria-label', 'Source controls');
    this.leftTop.className = 'left-panel__top';
    this.leftBottom.className = 'left-panel__bottom';
    // レイヤーパネルを UI から外した（PRD D1）ため、上下を分ける仕切りは役目を終えた。
    // leftBottom は温存中の旧 UI（LayerEditor）が append 先として参照するので
    // メンバーごと DOM に残す。中身が空なら高さ 0 になり、見た目には出ない。
    this.leftPanel.append(this.leftTop, this.leftBottom);
    this.stage.className = 'stage';
    this.canvasHost.className = 'artboard';
    this.canvasHost.setAttribute('aria-label', 'Artwork preview');
    this.objectToolbar.className = 'object-toolbar';
    this.objectToolbar.setAttribute('aria-label', 'Add object');
    this.rightSidebar.className = 'control-panel control-panel--right';
    this.rightSidebar.setAttribute('aria-label', 'Design and effect inspector');
    this.designPanel.className = 'inspector-panel inspector-panel--design';
    this.effectsPanel.className = 'inspector-panel inspector-panel--effects';
    const designEmpty = document.createElement('div');
    designEmpty.className = 'inspector-empty';
    designEmpty.innerHTML =
      '<i class="ph ph-cursor-click"></i><strong>Select a layer</strong><span>Choose an object from the canvas or Layers panel.</span>';
    this.designPanel.append(designEmpty);
    // デザインレイヤーは主導線から外した（PRD D15）。タブは出さず、
    // 右パネルは Effect のみとする。designPanel などのメンバーは
    // 温存中の旧 UI（LayerEditor / StudioControls）が参照するため残す。
    this.effectsPanel.hidden = false;
    this.rightSidebar.append(this.effectsPanel);
    this.chain.className = 'effect-chain';
    this.chain.setAttribute('aria-label', 'Effect chain');
    this.gridOverlay.className = 'stage-grid';
    this.gridOverlay.setAttribute('aria-hidden', 'true');

    const brand = document.createElement('div');
    brand.className = 'brand';
    const mark = document.createElement('strong');
    mark.textContent = 'AAL';
    const descriptor = document.createElement('span');
    descriptor.textContent = 'audio-reactive design engine';
    brand.append(mark, descriptor);
    this.toolbar.append(brand);

    // ステージ下のラベル（"Multi-layer canvas" 等）は意味を説明できないため出さない
    // （MTG 2026-07-27）。objectToolbar はデザインレイヤー用のため DOM に載せない（温存）。
    this.stage.append(this.gridOverlay, this.canvasHost);
    this.root.append(this.toolbar, this.leftPanel, this.stage, this.rightSidebar, this.chain);
    container.replaceChildren(this.root);
  }

  setInspectorTab(tab: 'design' | 'effects'): void {
    const designActive = tab === 'design';
    this.designTab.classList.toggle('is-active', designActive);
    this.effectsTab.classList.toggle('is-active', !designActive);
    this.designTab.setAttribute('aria-selected', String(designActive));
    this.effectsTab.setAttribute('aria-selected', String(!designActive));
    this.designPanel.hidden = !designActive;
    this.effectsPanel.hidden = designActive;
  }

  dispose(): void {
    this.root.remove();
  }
}
