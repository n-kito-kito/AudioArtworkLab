export class StudioShell {
  readonly root = document.createElement('div');
  readonly toolbar = document.createElement('header');
  readonly leftPanel = document.createElement('aside');
  readonly stage = document.createElement('main');
  readonly canvasHost = document.createElement('div');
  readonly rightPanel = document.createElement('aside');
  readonly chain = document.createElement('nav');
  readonly gridOverlay = document.createElement('div');

  constructor(container: HTMLElement) {
    this.root.className = 'studio-shell';
    this.toolbar.className = 'topbar';
    this.toolbar.setAttribute('aria-label', 'Studio toolbar');
    this.leftPanel.className = 'control-panel control-panel--left';
    this.leftPanel.setAttribute('aria-label', 'Source controls');
    this.stage.className = 'stage';
    this.canvasHost.className = 'artboard';
    this.canvasHost.setAttribute('aria-label', 'Artwork preview');
    this.rightPanel.className = 'control-panel control-panel--right';
    this.rightPanel.setAttribute('aria-label', 'Effect inspector');
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
    this.root.append(this.toolbar, this.leftPanel, this.stage, this.rightPanel, this.chain);
    container.replaceChildren(this.root);
  }

  dispose(): void {
    this.root.remove();
  }
}
