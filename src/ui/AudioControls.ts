import type { AudioParameters } from '../audio/AudioEngine';
import { FileAudioEngine } from '../audio/FileAudioEngine';

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

export class AudioControls {
  private readonly engine: FileAudioEngine;
  private readonly root = document.createElement('section');
  private readonly fileInput = document.createElement('input');
  private readonly playButton = document.createElement('button');
  private readonly trackName = document.createElement('span');
  private readonly status = document.createElement('span');
  private readonly time = document.createElement('span');
  private readonly seekInput = document.createElement('input');
  private readonly meters = new Map<keyof AudioParameters, HTMLElement>();
  private animationId: number | null = null;
  private dragDepth = 0;

  constructor(container: HTMLElement, engine: FileAudioEngine) {
    this.engine = engine;
    this.root.className = 'audio-panel';
    this.root.setAttribute('aria-label', 'Audio controls');
    this.build();
    container.appendChild(this.root);
    window.addEventListener('dragenter', this.onDragEnter);
    window.addEventListener('dragleave', this.onDragLeave);
    window.addEventListener('dragover', this.onDragOver);
    window.addEventListener('drop', this.onDrop);
    this.update();
  }

  dispose(): void {
    if (this.animationId !== null) cancelAnimationFrame(this.animationId);
    window.removeEventListener('dragenter', this.onDragEnter);
    window.removeEventListener('dragleave', this.onDragLeave);
    window.removeEventListener('dragover', this.onDragOver);
    window.removeEventListener('drop', this.onDrop);
    this.root.remove();
  }

  private build(): void {
    const header = document.createElement('div');
    header.className = 'audio-panel__header';

    const title = document.createElement('strong');
    title.textContent = 'AUDIO ARTWORK LAB';
    this.status.className = 'audio-panel__status';
    this.status.textContent = 'DROP MP3 / WAV';
    header.append(title, this.status);

    const transport = document.createElement('div');
    transport.className = 'audio-panel__transport';

    const fileLabel = document.createElement('label');
    fileLabel.className = 'audio-panel__file';
    fileLabel.textContent = 'LOAD';
    this.fileInput.type = 'file';
    this.fileInput.accept = 'audio/*,.mp3,.wav';
    this.fileInput.addEventListener('change', this.onFileChange);
    fileLabel.appendChild(this.fileInput);

    this.playButton.type = 'button';
    this.playButton.textContent = 'PLAY';
    this.playButton.disabled = true;
    this.playButton.addEventListener('click', this.onPlayToggle);

    this.trackName.className = 'audio-panel__track';
    this.trackName.textContent = 'NO TRACK';

    this.time.className = 'audio-panel__time';
    this.time.textContent = '0:00 / 0:00';

    transport.append(fileLabel, this.playButton, this.trackName, this.time);

    this.seekInput.className = 'audio-panel__seek';
    this.seekInput.type = 'range';
    this.seekInput.min = '0';
    this.seekInput.max = '1';
    this.seekInput.step = '0.01';
    this.seekInput.value = '0';
    this.seekInput.disabled = true;
    this.seekInput.setAttribute('aria-label', 'Playback position');
    this.seekInput.addEventListener('input', this.onSeek);

    const lower = document.createElement('div');
    lower.className = 'audio-panel__lower';
    lower.appendChild(this.buildVolume());
    lower.appendChild(this.buildMeters());

    this.root.append(header, transport, this.seekInput, lower);
  }

  private buildVolume(): HTMLElement {
    const label = document.createElement('label');
    label.className = 'audio-panel__volume';
    label.textContent = 'VOL';

    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = '0.8';
    input.setAttribute('aria-label', 'Volume');
    input.addEventListener('input', () => this.engine.setVolume(Number(input.value)));
    this.engine.setVolume(Number(input.value));
    label.appendChild(input);
    return label;
  }

  private buildMeters(): HTMLElement {
    const group = document.createElement('div');
    group.className = 'audio-panel__meters';

    for (const key of ['volume', 'bass', 'mid', 'treble'] as const) {
      const meter = document.createElement('span');
      const value = document.createElement('i');
      meter.textContent = key === 'volume' ? 'LEVEL' : key.toUpperCase();
      meter.appendChild(value);
      group.appendChild(meter);
      this.meters.set(key, value);
    }

    return group;
  }

  private readonly onFileChange = (): void => {
    const file = this.fileInput.files?.[0];
    if (file) void this.load(file);
  };

  private readonly onPlayToggle = (): void => {
    if (this.engine.isPlaying) {
      this.engine.pause();
      return;
    }

    void this.engine.play().catch((error: unknown) => {
      this.setError(error);
    });
  };

  private readonly onSeek = (): void => {
    this.engine.seek(Number(this.seekInput.value));
  };

  private readonly onDragEnter = (event: DragEvent): void => {
    event.preventDefault();
    this.dragDepth += 1;
    this.root.classList.add('is-dragging');
    this.status.textContent = 'DROP TO LOAD';
  };

  private readonly onDragLeave = (event: DragEvent): void => {
    event.preventDefault();
    this.dragDepth = Math.max(this.dragDepth - 1, 0);
    if (this.dragDepth === 0) {
      this.root.classList.remove('is-dragging');
      this.status.textContent = this.engine.isLoaded ? 'READY' : 'DROP MP3 / WAV';
    }
  };

  private readonly onDragOver = (event: DragEvent): void => {
    event.preventDefault();
  };

  private readonly onDrop = (event: DragEvent): void => {
    event.preventDefault();
    this.dragDepth = 0;
    this.root.classList.remove('is-dragging');
    const file = event.dataTransfer?.files[0];
    if (file) void this.load(file);
  };

  private async load(file: File): Promise<void> {
    this.status.textContent = 'LOADING';
    this.status.classList.remove('is-error');
    try {
      await this.engine.load(file);
      this.trackName.textContent = file.name;
      this.status.textContent = 'READY';
      this.playButton.disabled = false;
      this.seekInput.disabled = false;
      this.seekInput.max = String(this.engine.duration);
    } catch (error) {
      this.setError(error);
    }
  }

  private setError(error: unknown): void {
    this.status.textContent = error instanceof Error ? error.message : 'ERROR';
    this.status.classList.add('is-error');
  }

  private readonly update = (): void => {
    this.playButton.textContent = this.engine.isPlaying ? 'PAUSE' : 'PLAY';
    this.seekInput.value = String(this.engine.currentTime);
    this.time.textContent = `${formatTime(this.engine.currentTime)} / ${formatTime(this.engine.duration)}`;

    const parameters = this.engine.getParameters();
    for (const [key, element] of this.meters) {
      element.style.setProperty('--level', String(parameters[key] ?? 0));
    }

    this.animationId = requestAnimationFrame(this.update);
  };
}
