import type { AudioEngine, AudioParameters } from '../audio/AudioEngine';
import type { StudioShell } from './StudioShell';

type LayerKind = 'generator' | 'image' | 'circle' | 'text' | 'wave';
type ReactSource = 'none' | 'volume' | 'bass' | 'mid' | 'treble' | 'beat';

interface DesignLayer {
  id: string;
  kind: LayerKind;
  name: string;
  element: HTMLElement;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  color: string;
  blur: number;
  contrast: number;
  reactTo: ReactSource;
  reactAmount: number;
  baseWidth: number;
  text?: string;
  objectUrl?: string;
}

export interface LayerSnapshot {
  kind: LayerKind;
  name: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  color: string;
  blur: number;
  contrast: number;
  reactTo: ReactSource;
  reactAmount: number;
  baseWidth: number;
  text?: string;
  imageData?: string;
}

export interface LayerEditorSnapshot {
  layers: LayerSnapshot[];
}

export class LayerEditor {
  private readonly shell: StudioShell;
  private readonly audioEngine: AudioEngine;
  private readonly surface = document.createElement('div');
  private readonly section = document.createElement('section');
  private readonly list = document.createElement('div');
  private readonly fileInput = document.createElement('input');
  private readonly layers: DesignLayer[] = [];
  private selected: DesignLayer | null = null;
  private frame = 0;
  private drag: { layer: DesignLayer; startX: number; startY: number; x: number; y: number } | null =
    null;

  constructor(shell: StudioShell, audioEngine: AudioEngine) {
    this.shell = shell;
    this.audioEngine = audioEngine;
    this.surface.className = 'layer-surface';
    this.section.className = 'panel-section visual-section layer-panel';
    this.list.className = 'layer-list';
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.hidden = true;
    this.buildPanel();
    this.shell.canvasHost.append(this.surface);
    this.registerDefaultGenerator();
    this.shell.leftPanel.prepend(this.section);
    this.bindDrag();
    this.fileInput.addEventListener('change', this.onFile);
    this.shell.root.addEventListener('studio:effect-selected', this.clearSelection);
    document.addEventListener('keydown', this.onKeyDown);
    this.frame = requestAnimationFrame(this.update);
  }

  private registerDefaultGenerator(): void {
    const canvas = this.shell.canvasHost.querySelector('canvas');
    if (!canvas) return;
    const layer: DesignLayer = {
      id: crypto.randomUUID(),
      kind: 'generator',
      name: 'Sine Wave',
      element: canvas,
      x: 50,
      y: 50,
      scale: 1,
      rotation: 0,
      opacity: 1,
      color: '#ffffff',
      blur: 0,
      contrast: 1,
      reactTo: 'none',
      reactAmount: 0,
      baseWidth: 100,
    };
    this.layers.push(layer);
    this.syncStack();
    this.renderList();
  }

  private buildPanel(): void {
    const title = document.createElement('h2');
    title.innerHTML = '<i class="ph ph-stack"></i><span>LAYERS</span>';
    const addGrid = document.createElement('div');
    addGrid.className = 'layer-add-grid';
    addGrid.append(
      this.addButton('ph-image', 'Image', () => this.fileInput.click()),
      this.addButton('ph-circle', 'Circle', () => this.addLayer('circle')),
      this.addButton('ph-wave-sine', 'Wave', () => this.addLayer('wave')),
      this.addButton('ph-text-t', 'Text', () => this.addLayer('text')),
    );
    this.section.append(title, addGrid, this.fileInput, this.list);
    this.renderList();
  }

  private addButton(iconName: string, label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'layer-add-button';
    button.innerHTML = `<i class="ph ${iconName}"></i><span>${label}</span>`;
    button.addEventListener('click', action);
    return button;
  }

  private addLayer(kind: LayerKind, url?: string): void {
    const element = document.createElement(kind === 'image' ? 'img' : 'div');
    element.className = `design-layer design-layer--${kind}`;
    element.tabIndex = 0;
    let name = kind === 'circle' ? 'Reactive Orb' : kind === 'wave' ? 'Wave Line' : 'Text Layer';
    let width = kind === 'text' ? 58 : kind === 'wave' ? 76 : 42;
    const color = kind === 'wave' ? '#b8ff38' : '#f2e9ff';
    if (kind === 'image' && element instanceof HTMLImageElement && url) {
      element.src = url;
      element.alt = 'Imported visual layer';
      name = 'Imported Image';
      width = 100;
    } else if (kind === 'text') {
      element.textContent = 'AUDIO / FORM';
    }
    const layer: DesignLayer = {
      id: crypto.randomUUID(),
      kind,
      name,
      element,
      x: 50,
      y: 50,
      scale: 1,
      rotation: 0,
      opacity: 1,
      color,
      blur: 0,
      contrast: 1,
      reactTo: kind === 'circle' ? 'bass' : kind === 'wave' ? 'mid' : 'none',
      reactAmount: kind === 'text' ? 0.15 : 0.45,
      baseWidth: width,
      text: kind === 'text' ? 'AUDIO / FORM' : undefined,
      objectUrl: kind === 'image' ? url : undefined,
    };
    element.dataset.layerId = layer.id;
    element.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      this.select(layer);
    });
    this.layers.push(layer);
    this.surface.append(element);
    this.syncStack();
    this.applyLayer(layer, 0);
    this.select(layer);
    this.renderList();
  }

  private onFile = async (): Promise<void> => {
    const file = this.fileInput.files?.[0];
    if (!file) return;
    const dataUrl = await this.readAsDataUrl(file);
    this.addLayer('image', dataUrl);
    this.fileInput.value = '';
  };

  private readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result)));
      reader.addEventListener('error', () => reject(reader.error ?? new Error('Image read failed')));
      reader.readAsDataURL(file);
    });
  }

  private select(layer: DesignLayer): void {
    this.selected = layer;
    this.layers.forEach((item) => item.element.classList.toggle('is-selected', item === layer));
    this.renderList();
    this.buildInspector(layer);
    if (window.innerWidth <= 820) this.shell.root.classList.add('right-open');
  }

  private clearSelection = (): void => {
    this.selected = null;
    this.layers.forEach((item) => item.element.classList.remove('is-selected'));
    this.renderList();
  };

  private renderList(): void {
    this.list.replaceChildren();
    if (this.layers.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'layer-empty';
      empty.textContent = 'Add an image, shape or text';
      this.list.append(empty);
      return;
    }
    [...this.layers].reverse().forEach((layer) => {
      const row = document.createElement('div');
      row.className = 'layer-row';
      row.classList.toggle('is-selected', layer === this.selected);
      const icon = {
        generator: 'ph-wave-sine',
        image: 'ph-image',
        circle: 'ph-circle',
        wave: 'ph-wave-sine',
        text: 'ph-text-t',
      }[layer.kind];
      const selectButton = document.createElement('button');
      selectButton.type = 'button';
      selectButton.className = 'layer-row__select';
      selectButton.setAttribute('aria-label', `Select ${layer.name}`);
      selectButton.innerHTML = `<i class="ph ${icon}"></i><span>${layer.name}</span><i class="ph ph-dots-six-vertical layer-row__handle"></i>`;
      selectButton.addEventListener('click', () => this.select(layer));
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'layer-row__delete';
      deleteButton.setAttribute('aria-label', `Delete ${layer.name}`);
      deleteButton.title = 'Delete layer';
      deleteButton.innerHTML = '<i class="ph ph-trash"></i>';
      deleteButton.addEventListener('click', () => this.remove(layer));
      row.append(selectButton, deleteButton);
      this.list.append(row);
    });
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.selected || (event.key !== 'Delete' && event.key !== 'Backspace')) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    this.remove(this.selected);
  };

  private buildInspector(layer: DesignLayer): void {
    const panel = this.shell.rightPanel;
    panel.replaceChildren();
    const header = document.createElement('div');
    header.className = 'inspector-header';
    header.innerHTML = `<span>SELECTED LAYER</span><strong>${layer.name}</strong>`;
    if (layer.kind === 'generator') {
      const source = this.inspectorSection('GENERATOR SOURCE', 'ph-wave-sine');
      const note = document.createElement('p');
      note.className = 'inspector-note';
      note.textContent = 'Shape and audio response are controlled in the Generator panel.';
      source.append(note);
      const actions = this.inspectorSection('ARRANGE', 'ph-stack');
      const row = document.createElement('div');
      row.className = 'button-row layer-actions';
      row.append(
        this.actionButton('ph-arrow-up', 'Forward', () => this.move(layer, 1)),
        this.actionButton('ph-arrow-down', 'Backward', () => this.move(layer, -1)),
        this.actionButton('ph-trash', 'Delete', () => this.remove(layer)),
      );
      actions.append(row);
      panel.append(header, source, actions);
      return;
    }
    const transform = this.inspectorSection('TRANSFORM', 'ph-arrows-out-cardinal');
    transform.append(
      this.range('Position X', layer.x, 0, 100, 1, (v) => (layer.x = v), '%'),
      this.range('Position Y', layer.y, 0, 100, 1, (v) => (layer.y = v), '%'),
      this.range('Scale', layer.scale, 0.1, 3, 0.01, (v) => (layer.scale = v), 'x'),
      this.range('Rotation', layer.rotation, -180, 180, 1, (v) => (layer.rotation = v), '°'),
      this.range('Opacity', layer.opacity, 0, 1, 0.01, (v) => (layer.opacity = v)),
    );
    if (layer.kind === 'text') transform.prepend(this.textInput(layer));
    const style = this.inspectorSection('STYLE & AUDIO', 'ph-sparkle');
    style.append(
      this.color('Color', layer.color, (v) => (layer.color = v)),
      this.range('Blur', layer.blur, 0, 30, 0.5, (v) => (layer.blur = v), 'px'),
      this.range('Contrast', layer.contrast, 0.2, 2.5, 0.05, (v) => (layer.contrast = v), 'x'),
      this.selectControl('React to', ['none', 'volume', 'bass', 'mid', 'treble', 'beat'], layer.reactTo, (v) =>
        (layer.reactTo = v as ReactSource),
      ),
      this.range('Reaction', layer.reactAmount, 0, 1.5, 0.01, (v) => (layer.reactAmount = v)),
    );
    const actions = this.inspectorSection('ARRANGE', 'ph-stack');
    const row = document.createElement('div');
    row.className = 'button-row layer-actions';
    row.append(
      this.actionButton('ph-arrow-up', 'Forward', () => this.move(layer, 1)),
      this.actionButton('ph-arrow-down', 'Backward', () => this.move(layer, -1)),
      this.actionButton('ph-copy', 'Duplicate', () => this.duplicate(layer)),
      this.actionButton('ph-trash', 'Delete', () => this.remove(layer)),
    );
    actions.append(row);
    panel.append(header, transform, style, actions);
  }

  private inspectorSection(titleText: string, iconName: string): HTMLElement {
    const section = document.createElement('section');
    section.className = 'panel-section visual-section';
    section.innerHTML = `<h2><i class="ph ${iconName}"></i><span>${titleText}</span></h2>`;
    return section;
  }

  private range(labelText: string, value: number, min: number, max: number, step: number, change: (v: number) => void, suffix = ''): HTMLElement {
    const label = document.createElement('label');
    label.className = 'control-row control-row--range';
    const name = document.createElement('span');
    name.textContent = labelText;
    const output = document.createElement('output');
    output.textContent = `${Number(value.toFixed(2))}${suffix}`;
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
    input.addEventListener('input', () => { const v = Number(input.value); output.textContent = `${Number(v.toFixed(2))}${suffix}`; change(v); });
    label.append(name, output, input);
    return label;
  }

  private color(labelText: string, value: string, change: (v: string) => void): HTMLElement {
    const label = document.createElement('label'); label.className = 'control-row control-row--inline';
    const name = document.createElement('span'); name.textContent = labelText;
    const input = document.createElement('input'); input.type = 'color'; input.value = value;
    input.addEventListener('input', () => change(input.value)); label.append(name, input); return label;
  }

  private selectControl(labelText: string, values: string[], selected: string, change: (v: string) => void): HTMLElement {
    const label = document.createElement('label'); label.className = 'control-row control-row--inline';
    const name = document.createElement('span'); name.textContent = labelText;
    const select = document.createElement('select');
    values.forEach((value) => { const option = document.createElement('option'); option.value = value; option.textContent = value.toUpperCase(); option.selected = value === selected; select.append(option); });
    select.addEventListener('change', () => change(select.value)); label.append(name, select); return label;
  }

  private textInput(layer: DesignLayer): HTMLElement {
    const label = document.createElement('label'); label.className = 'control-row layer-text-control';
    const name = document.createElement('span'); name.textContent = 'Content';
    const input = document.createElement('input'); input.type = 'text'; input.value = layer.text ?? '';
    input.addEventListener('input', () => { layer.text = input.value; layer.element.textContent = input.value; });
    label.append(name, input); return label;
  }

  private actionButton(icon: string, label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ui-button';
    button.innerHTML = `<i class="ph ${icon}"></i><span>${label}</span>`; button.addEventListener('click', action); return button;
  }

  private move(layer: DesignLayer, direction: -1 | 1): void {
    const index = this.layers.indexOf(layer); const next = Math.max(0, Math.min(this.layers.length - 1, index + direction));
    if (index === next) return; this.layers.splice(index, 1); this.layers.splice(next, 0, layer);
    this.syncStack(); this.renderList();
  }

  private duplicate(layer: DesignLayer): void {
    if (layer.kind === 'generator') return;
    if (layer.kind === 'image' && layer.objectUrl) this.addLayer('image', layer.objectUrl); else this.addLayer(layer.kind);
    const copy = this.layers.at(-1)!; Object.assign(copy, { x: layer.x + 4, y: layer.y + 4, scale: layer.scale, rotation: layer.rotation, opacity: layer.opacity, color: layer.color, blur: layer.blur, contrast: layer.contrast, reactTo: layer.reactTo, reactAmount: layer.reactAmount, text: layer.text });
    if (copy.kind === 'text') copy.element.textContent = copy.text ?? '';
  }

  private remove(layer: DesignLayer): void {
    const index = this.layers.indexOf(layer); if (index < 0) return;
    if (layer.kind === 'generator') layer.element.style.display = 'none';
    else layer.element.remove();
    if (layer.objectUrl?.startsWith('blob:')) URL.revokeObjectURL(layer.objectUrl);
    this.layers.splice(index, 1);
    this.syncStack();
    this.selected = null; this.renderList(); this.shell.root.dispatchEvent(new CustomEvent('studio:restore-effect'));
  }

  private syncStack(): void {
    this.layers.forEach((layer, index) => {
      layer.element.style.zIndex = String(index + 1);
    });
  }

  getSnapshot(): LayerEditorSnapshot {
    return {
      layers: this.layers.map((layer) => ({
        kind: layer.kind,
        name: layer.name,
        x: layer.x,
        y: layer.y,
        scale: layer.scale,
        rotation: layer.rotation,
        opacity: layer.opacity,
        color: layer.color,
        blur: layer.blur,
        contrast: layer.contrast,
        reactTo: layer.reactTo,
        reactAmount: layer.reactAmount,
        baseWidth: layer.baseWidth,
        text: layer.text,
        imageData: layer.kind === 'image' ? layer.objectUrl : undefined,
      })),
    };
  }

  restoreSnapshot(snapshot: LayerEditorSnapshot): void {
    for (const layer of [...this.layers]) {
      if (layer.kind !== 'generator') layer.element.remove();
      if (layer.objectUrl?.startsWith('blob:')) URL.revokeObjectURL(layer.objectUrl);
    }
    this.layers.splice(0);
    const generator = snapshot.layers.find((layer) => layer.kind === 'generator');
    if (generator) {
      this.registerDefaultGenerator();
      Object.assign(this.layers[0]!, generator);
      this.layers[0]!.element.style.display = '';
    } else {
      const canvas = this.shell.canvasHost.querySelector('canvas');
      if (canvas) canvas.style.display = 'none';
    }
    for (const saved of snapshot.layers) {
      if (saved.kind === 'generator') continue;
      if (saved.kind === 'image' && !saved.imageData) continue;
      this.addLayer(saved.kind, saved.imageData);
      const layer = this.layers.at(-1)!;
      Object.assign(layer, saved, { objectUrl: saved.imageData });
      if (layer.kind === 'text') layer.element.textContent = layer.text ?? '';
      this.applyLayer(layer, 0);
    }
    this.selected = null;
    this.syncStack();
    this.renderList();
    this.shell.root.dispatchEvent(new CustomEvent('studio:restore-effect'));
  }

  private bindDrag(): void {
    this.surface.addEventListener('pointerdown', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('.design-layer');
      const layer = this.layers.find((item) => item.element === target); if (!layer) return;
      this.drag = { layer, startX: event.clientX, startY: event.clientY, x: layer.x, y: layer.y };
      this.surface.setPointerCapture(event.pointerId); event.preventDefault();
    });
    this.surface.addEventListener('pointermove', (event) => {
      if (!this.drag) return; const box = this.surface.getBoundingClientRect();
      this.drag.layer.x = Math.max(0, Math.min(100, this.drag.x + ((event.clientX - this.drag.startX) / box.width) * 100));
      this.drag.layer.y = Math.max(0, Math.min(100, this.drag.y + ((event.clientY - this.drag.startY) / box.height) * 100));
    });
    this.surface.addEventListener('pointerup', () => { if (this.drag && this.selected) this.buildInspector(this.selected); this.drag = null; });
  }

  private update = (): void => {
    const audio = this.audioEngine.getParameters();
    this.layers.forEach((layer) => this.applyLayer(layer, this.audioValue(audio, layer.reactTo)));
    this.frame = requestAnimationFrame(this.update);
  };

  private audioValue(audio: AudioParameters, source: ReactSource): number {
    if (source === 'none') return 0; return audio[source] ?? 0;
  }

  private applyLayer(layer: DesignLayer, audioValue: number): void {
    if (layer.kind === 'generator') return;
    const pulse = 1 + audioValue * layer.reactAmount;
    const wobble = Math.sin(performance.now() * 0.004 + this.layers.indexOf(layer)) * audioValue * layer.reactAmount * 7;
    const element = layer.element;
    element.style.left = `${layer.x}%`; element.style.top = `${layer.y}%`; element.style.width = `${layer.baseWidth}%`;
    element.style.opacity = String(layer.opacity); element.style.color = layer.color;
    element.style.transform = `translate(-50%, -50%) rotate(${layer.rotation + wobble}deg) scale(${layer.scale * pulse})`;
    element.style.filter = `blur(${layer.blur + audioValue * layer.reactAmount * 5}px) contrast(${layer.contrast})`;
    if (layer.kind === 'circle') element.style.setProperty('--layer-color', layer.color);
    if (layer.kind === 'wave') element.style.setProperty('--wave-energy', String(1 + audioValue * layer.reactAmount * 2));
  }

  exportPng(): void {
    const source = this.shell.canvasHost.querySelector('canvas');
    if (!source) return;
    const size = 1600;
    const output = document.createElement('canvas');
    output.width = size;
    output.height = size;
    const context = output.getContext('2d');
    if (!context) return;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, size, size);
    for (const layer of this.layers) {
      if (layer.kind === 'generator') context.drawImage(source, 0, 0, size, size);
      else this.drawLayer(context, layer, size);
    }
    const link = document.createElement('a');
    link.download = `audio-artwork-${Date.now()}.png`;
    link.href = output.toDataURL('image/png');
    link.click();
  }

  private drawLayer(context: CanvasRenderingContext2D, layer: DesignLayer, size: number): void {
    const x = (layer.x / 100) * size;
    const y = (layer.y / 100) * size;
    const width = (layer.baseWidth / 100) * size;
    context.save();
    context.translate(x, y);
    context.rotate((layer.rotation * Math.PI) / 180);
    context.scale(layer.scale, layer.scale);
    context.globalAlpha = layer.opacity;
    context.filter = `blur(${layer.blur}px) contrast(${layer.contrast})`;
    if (layer.kind === 'image' && layer.element instanceof HTMLImageElement) {
      const image = layer.element;
      const sourceRatio = image.naturalWidth / Math.max(image.naturalHeight, 1);
      const targetRatio = width / size;
      let sourceWidth = image.naturalWidth;
      let sourceHeight = image.naturalHeight;
      let sourceX = 0;
      let sourceY = 0;
      if (sourceRatio > targetRatio) {
        sourceWidth = image.naturalHeight * targetRatio;
        sourceX = (image.naturalWidth - sourceWidth) / 2;
      } else {
        sourceHeight = image.naturalWidth / targetRatio;
        sourceY = (image.naturalHeight - sourceHeight) / 2;
      }
      context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, -width / 2, -size / 2, width, size);
    } else if (layer.kind === 'circle') {
      context.strokeStyle = layer.color;
      context.fillStyle = `${layer.color}22`;
      context.lineWidth = Math.max(size * 0.008, 3);
      context.beginPath(); context.arc(0, 0, width / 2, 0, Math.PI * 2); context.fill(); context.stroke();
    } else if (layer.kind === 'wave') {
      context.strokeStyle = layer.color; context.lineWidth = Math.max(size * 0.003, 2); context.beginPath();
      for (let index = 0; index <= 100; index++) {
        const px = -width / 2 + (index / 100) * width;
        const py = Math.sin((index / 100) * Math.PI * 6) * size * 0.055;
        if (index === 0) context.moveTo(px, py); else context.lineTo(px, py);
      }
      context.stroke();
    } else if (layer.kind === 'text') {
      context.fillStyle = layer.color; context.textAlign = 'center'; context.textBaseline = 'middle';
      context.font = `800 ${size * 0.075}px Inter, sans-serif`; context.fillText(layer.text ?? '', 0, 0);
    }
    context.restore();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame); this.fileInput.removeEventListener('change', this.onFile);
    this.shell.root.removeEventListener('studio:effect-selected', this.clearSelection);
    document.removeEventListener('keydown', this.onKeyDown);
    this.layers.forEach((layer) => {
      if (layer.objectUrl?.startsWith('blob:')) URL.revokeObjectURL(layer.objectUrl);
    });
    this.section.remove(); this.surface.remove();
  }
}
