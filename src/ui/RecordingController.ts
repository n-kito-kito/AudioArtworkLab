import type { FileAudioEngine } from '../audio/FileAudioEngine';
import type { StudioShell } from './StudioShell';

export class RecordingController {
  private readonly shell: StudioShell;
  private readonly audioEngine: FileAudioEngine;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  constructor(shell: StudioShell, audioEngine: FileAudioEngine) {
    this.shell = shell;
    this.audioEngine = audioEngine;
  }

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  toggle(): boolean {
    if (this.recording) {
      this.recorder?.stop();
      return false;
    }

    const canvas = this.shell.canvasHost.querySelector('canvas');
    if (!canvas || !('captureStream' in canvas) || typeof MediaRecorder === 'undefined') {
      throw new Error('このブラウザは録画に対応していません。');
    }

    const videoStream = canvas.captureStream(60);
    const output = new MediaStream(videoStream.getVideoTracks());
    const audioStream = this.audioEngine.getRecordingStream();
    audioStream?.getAudioTracks().forEach((track) => output.addTrack(track));
    // MP4（H.264/AAC）を優先する（PRD D25）。SNS やプレイヤーでそのまま扱えるため。
    // 対応していないブラウザだけ WebM へ落とす。
    const mimeType = [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find((type) => MediaRecorder.isTypeSupported(type));
    this.chunks = [];
    this.recorder = new MediaRecorder(output, mimeType ? { mimeType } : undefined);
    this.recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    this.recorder.addEventListener(
      'stop',
      () => {
        const actualType = this.recorder?.mimeType || mimeType || 'video/webm';
        const url = URL.createObjectURL(new Blob(this.chunks, { type: actualType }));
        const link = document.createElement('a');
        link.download = `audio-artwork-${Date.now()}.${actualType.includes('mp4') ? 'mp4' : 'webm'}`;
        link.href = url;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
        output.getVideoTracks().forEach((track) => track.stop());
        this.recorder = null;
      },
      { once: true },
    );
    this.recorder.start(1000);
    return true;
  }

  dispose(): void {
    if (this.recording) this.recorder?.stop();
  }
}
