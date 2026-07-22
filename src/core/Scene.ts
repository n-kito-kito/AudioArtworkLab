import * as THREE from 'three';

export class Scene {
  readonly three: THREE.Scene;

  constructor() {
    this.three = new THREE.Scene();
    this.three.background = new THREE.Color(0x000000);
  }
}
