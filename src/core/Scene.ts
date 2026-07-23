import { Scene as ThreeScene } from 'three';

export class Scene {
  readonly three: ThreeScene;

  constructor() {
    this.three = new ThreeScene();
    this.three.background = null;
  }
}
