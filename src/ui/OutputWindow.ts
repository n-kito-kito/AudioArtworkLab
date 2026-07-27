import type { StudioShell } from './StudioShell';

/**
 * VJ 用の出力ウィンドウ。UI を含まない「絵だけ」を別ウィンドウへ出し、
 * プロジェクターや第 2 画面でフルスクリーンにできるようにする。
 *
 * キャンバス自体を移すのではなく captureStream で複製するのは、
 * 本体のプレビューと描画ループを止めずに済ませるため。
 */
export class OutputWindow {
  private readonly shell: StudioShell;
  private readonly notify: (message: string, error?: boolean) => void;
  private popup: Window | null = null;
  private stream: MediaStream | null = null;
  private closeWatcher = 0;

  constructor(shell: StudioShell, notify: (message: string, error?: boolean) => void) {
    this.shell = shell;
    this.notify = notify;
  }

  get isOpen(): boolean {
    return this.popup !== null && !this.popup.closed;
  }

  /** 開いていれば閉じ、閉じていれば開く。戻り値は操作後に開いているか。 */
  toggle(): boolean {
    if (this.isOpen) {
      this.close();
      return false;
    }
    return this.open();
  }

  dispose(): void {
    this.close();
  }

  private open(): boolean {
    const canvas = this.shell.canvasHost.querySelector('canvas');
    if (!canvas || typeof canvas.captureStream !== 'function') {
      this.notify('このブラウザは出力ウィンドウに対応していません。', true);
      return false;
    }

    const popup = window.open('', 'aal-output', 'width=960,height=540');
    // ブロックは想定内の失敗。例外にせず知らせるだけにする。
    if (!popup) {
      this.notify('ポップアップがブロックされました', true);
      return false;
    }

    this.popup = popup;
    this.stream = canvas.captureStream(60);
    this.build(popup, this.stream);

    // 利用者がウィンドウを直接閉じても状態を戻せるようにする。
    popup.addEventListener('unload', () => this.handleExternalClose(popup));
    this.closeWatcher = window.setInterval(() => {
      if (this.popup === popup && popup.closed) this.handleExternalClose(popup);
    }, 1000);
    return true;
  }

  private build(popup: Window, stream: MediaStream): void {
    const doc = popup.document;
    doc.title = 'Audio Artwork Lab — Output';

    const style = doc.createElement('style');
    style.textContent = [
      'html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden;}',
      // 画角は板が決めるので、余りは引き伸ばさず黒のままにする。
      'video{display:block;width:100%;height:100%;object-fit:contain;background:#000;cursor:pointer;}',
      '.output-hint{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);',
      'color:rgba(255,255,255,0.5);font:12px/1.4 system-ui,sans-serif;letter-spacing:0.08em;',
      'pointer-events:none;}',
      '.output-hint[hidden]{display:none;}',
    ].join('');
    doc.head.append(style);

    const video = doc.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    const hint = doc.createElement('p');
    hint.className = 'output-hint';
    hint.textContent = 'クリックでフルスクリーン';

    video.addEventListener('click', () => {
      if (doc.fullscreenElement) {
        void doc.exitFullscreen().catch(() => undefined);
        return;
      }
      // 拒否されても本体の操作は続けられるので、失敗は握りつぶす。
      void doc.documentElement.requestFullscreen().catch(() => undefined);
    });
    doc.addEventListener('fullscreenchange', () => {
      hint.hidden = doc.fullscreenElement !== null;
    });

    doc.body.replaceChildren(video, hint);
    // 自動再生が拒否される環境でも黒画面にならないよう明示的に促す。
    void video.play().catch(() => undefined);
  }

  private handleExternalClose(popup: Window): void {
    if (this.popup !== popup) return;
    this.release();
  }

  private close(): void {
    const popup = this.popup;
    this.release();
    if (popup && !popup.closed) popup.close();
  }

  private release(): void {
    if (this.closeWatcher) {
      window.clearInterval(this.closeWatcher);
      this.closeWatcher = 0;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.popup = null;
  }
}
