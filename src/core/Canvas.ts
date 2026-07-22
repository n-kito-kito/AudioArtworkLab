export class Canvas {
  readonly element: HTMLElement;

  constructor(container: HTMLElement) {
    this.element = container;
  }

  get width(): number {
    return Math.max(Math.round(this.element.getBoundingClientRect().width), 1);
  }

  get height(): number {
    return Math.max(Math.round(this.element.getBoundingClientRect().height), 1);
  }

  get aspect(): number {
    return this.width / this.height;
  }
}
