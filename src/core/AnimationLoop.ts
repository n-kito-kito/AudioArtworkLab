export class AnimationLoop {
  private animationId: number | null = null;
  private startTime = performance.now();
  private readonly onUpdate: (elapsed: number) => void;
  private readonly onRender: () => void;

  constructor(onUpdate: (elapsed: number) => void, onRender: () => void) {
    this.onUpdate = onUpdate;
    this.onRender = onRender;
  }

  start(): void {
    const tick = (): void => {
      this.animationId = requestAnimationFrame(tick);
      const elapsed = (performance.now() - this.startTime) / 1000;
      this.onUpdate(elapsed);
      this.onRender();
    };

    tick();
  }

  stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }
}
