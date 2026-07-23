export class StudioShell {
  readonly root = document.createElement('div');
  readonly toolbar = document.createElement('header');
  readonly leftPanel = document.createElement('aside');
  readonly stage = document.createElement('main');
  readonly canvasHost = document.createElement('div');
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
    this.stage.className = 'stage';
    this.canvasHost.className = 'artboard';
    this.canvasHost.setAttribute('aria-label', 'Artwork preview');
    this.rightSidebar.className = 'control-panel control-panel--right';
    this.rightSidebar.setAttribute('aria-label', 'Design and effect inspector');
    this.designPanel.className = 'inspector-panel inspector-panel--design';
    this.effectsPanel.className = 'inspector-panel inspector-panel--effects';
    const designEmpty = document.createElement('div');
    designEmpty.className = 'inspector-empty';
    designEmpty.innerHTML =
      '<i class="ph ph-cursor-click"></i><strong>Select a layer</strong><span>Choose an object from the canvas or Layers panel.</span>';
    this.designPanel.append(designEmpty);
    const inspectorTabs = document.createElement('div');
    inspectorTabs.className = 'inspector-tabs';
    this.designTab.type = 'button';
    this.designTab.textContent = 'Design';
    this.effectsTab.type = 'button';
    this.effectsTab.textContent = 'Effects';
    this.designTab.addEventListener('click', () => this.setInspectorTab('design'));
    this.effectsTab.addEventListener('click', () => this.setInspectorTab('effects'));
    inspectorTabs.append(this.designTab, this.effectsTab);
    this.rightSidebar.append(inspectorTabs, this.designPanel, this.effectsPanel);
    this.setInspectorTab('effects');
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

    const stageLabel = document.createElement('div');
    stageLabel.className = 'stage-label';
    stageLabel.innerHTML = '<span>LIVE COMPOSITION</span><strong>MULTI-LAYER CANVAS</strong>';
    this.stage.append(this.gridOverlay, this.canvasHost, stageLabel);
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
