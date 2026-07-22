import type { AudioParameters } from '../audio/AudioEngine';
import { FileAudioEngine } from '../audio/FileAudioEngine';

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`;
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
    this.root.className = 'panel-section audio-panel';
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
    const heading = document.createElement('h2');
    const icon = document.createElement('i');
    icon.className = 'ph ph-speaker-high';
    const title = document.createElement('span');
    title.textContent = 'AUDIO';
    this.status.className = 'audio-panel__status';
    this.status.textContent = 'DROP MP3 / WAV';
    heading.append(icon, title, this.status);

    const fileLabel = document.createElement('label');
    fileLabel.className = 'audio-dropzone';
    const uploadIcon = document.createElement('i');
    uploadIcon.className = 'ph ph-upload-simple';
    const uploadText = document.createElement('span');
    uploadText.textContent = 'LOAD AUDIO FILE';
    this.fileInput.type = 'file';
    this.fileInput.accept = 'audio/*,.mp3,.wav';
    this.fileInput.addEventListener('change', this.onFileChange);
    fileLabel.append(uploadIcon, uploadText, this.fileInput);

    this.trackName.className = 'audio-panel__track';
    this.trackName.textContent = 'NO TRACK LOADED';
    const transport = document.createElement('div');
    transport.className = 'audio-transport';
    this.playButton.type = 'button';
    this.playButton.className = 'transport-button';
    this.playButton.setAttribute('aria-label', 'Play audio');
    this.playButton.innerHTML = '<i class="ph ph-play"></i><span>PLAY</span>';
    this.playButton.disabled = true;
    this.playButton.addEventListener('click', this.onPlayToggle);
    this.time.textContent = '0:00 / 0:00';
    transport.append(this.playButton, this.time);

    this.seekInput.type = 'range';
    this.seekInput.min = '0';
    this.seekInput.max = '1';
    this.seekInput.step = '0.01';
    this.seekInput.value = '0';
    this.seekInput.disabled = true;
    this.seekInput.setAttribute('aria-label', 'Playback position');
    this.seekInput.addEventListener('input', () => this.engine.seek(Number(this.seekInput.value)));

    const volume = document.createElement('label');
    volume.className = 'control-row control-row--range';
    volume.innerHTML = '<span>Volume</span><output>80%</output>';
    const volumeInput = document.createElement('input');
    volumeInput.type = 'range';
    volumeInput.min = '0';
    volumeInput.max = '1';
    volumeInput.step = '0.01';
    volumeInput.value = '0.8';
    volumeInput.setAttribute('aria-label', 'Volume');
    volumeInput.addEventListener('input', () => {
      this.engine.setVolume(Number(volumeInput.value));
      volume.querySelector('output')!.textContent =
        `${Math.round(Number(volumeInput.value) * 100)}%`;
    });
    this.engine.setVolume(0.8);
    volume.append(volumeInput);
    this.root.append(
      heading,
      fileLabel,
      this.trackName,
      transport,
      this.seekInput,
      volume,
      this.buildMeters(),
    );
  }

  private buildMeters(): HTMLElement {
    const group = document.createElement('div');
    group.className = 'audio-meters';
    for (const key of ['bass', 'mid', 'treble'] as const) {
      const meter = document.createElement('div');
      const label = document.createElement('span');
      label.textContent = key.toUpperCase();
      const track = document.createElement('i');
      meter.append(label, track);
      group.append(meter);
      this.meters.set(key, track);
    }
    return group;
  }

  private readonly onFileChange = (): void => {
    const file = this.fileInput.files?.[0];
    if (file) void this.load(file);
  };

  private readonly onPlayToggle = (): void => {
    if (this.engine.isPlaying) this.engine.pause();
    else void this.engine.play().catch((error: unknown) => this.setError(error));
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

  private readonly onDragOver = (event: DragEvent): void => event.preventDefault();

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
    const playing = this.engine.isPlaying;
    this.playButton.innerHTML = playing
      ? '<i class="ph ph-pause"></i><span>PAUSE</span>'
      : '<i class="ph ph-play"></i><span>PLAY</span>';
    this.seekInput.value = String(this.engine.currentTime);
    this.time.textContent = `${formatTime(this.engine.currentTime)} / ${formatTime(this.engine.duration)}`;
    const parameters = this.engine.getParameters();
    for (const [key, element] of this.meters) {
      element.style.setProperty('--level', String(parameters[key] ?? 0));
    }
    this.animationId = requestAnimationFrame(this.update);
  };
}
