import * as THREE from 'three';

const FRUSTUM_SIZE = 2;

export class Camera {
  readonly three: THREE.OrthographicCamera;

  constructor(aspect = 1) {
    this.three = new THREE.OrthographicCamera(
      (-FRUSTUM_SIZE * aspect) / 2,
      (FRUSTUM_SIZE * aspect) / 2,
      FRUSTUM_SIZE / 2,
      -FRUSTUM_SIZE / 2,
      0.1,
      100,
    );
    this.three.position.z = 1;
  }

  resize(aspect: number): void {
    this.three.left = (-FRUSTUM_SIZE * aspect) / 2;
    this.three.right = (FRUSTUM_SIZE * aspect) / 2;
    this.three.top = FRUSTUM_SIZE / 2;
    this.three.bottom = -FRUSTUM_SIZE / 2;
    this.three.updateProjectionMatrix();
  }
}
