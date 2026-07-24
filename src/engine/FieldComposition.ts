import * as THREE from 'three';
import type { Composition, CompositionContext, DesignLayerCanvases } from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import type { Field } from './Field';
import type { FieldRenderer } from './FieldRenderer';
import { composeFragmentShader, vertexShader } from './composeShader';

/**
 * ① Field × ② Renderer を 1 枚の全画面クアッドへ描き、③ Effect チェーンへ渡す。
 *
 * 既存の Composition インターフェースを実装しているため App から従来どおり駆動できる。
 * Composition 層を作り直すまでの橋渡しとして、この形を採っている。
 */
export class FieldComposition implements Composition {
  readonly animated = true;

  private readonly field: Field;
  private readonly renderer: FieldRenderer;
  private readonly effects: Effect[];

  private context: CompositionContext | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private geometry: THREE.PlaneGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private pipeline: EffectPipeline | null = null;

  constructor(field: Field, renderer: FieldRenderer, effects: Effect[] = []) {
    this.field = field;
    this.renderer = renderer;
    this.effects = effects;
  }

  get name(): string {
    return `${this.field.name} / ${this.renderer.name}`;
  }

  setup(context: CompositionContext): void {
    this.context = context;

    // App のシーンとカメラは使わない。クアッドを画面いっぱいに置くため
    // 専用の正射影カメラを持ち、フレーミングを完全に制御する。
    this.scene = new THREE.Scene();
    // クアッドは z = 0 に置く。far をちょうど 1 にするとクアッドが遠クリップ面と
    // 重なって描画が消えるため、前後に余裕を持たせる。
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uActive: { value: 0 },
        ...this.field.uniforms,
        ...this.renderer.uniforms,
      },
      vertexShader,
      fragmentShader: composeFragmentShader(this.field, this.renderer),
    });

    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.scene.add(new THREE.Mesh(this.geometry, this.material));

    this.pipeline = new EffectPipeline(
      context.renderer,
      this.scene,
      this.camera,
      this.effects,
    );
  }

  update(elapsed: number): void {
    if (!this.material || !this.context) return;

    const audio = this.context.audioEngine.getParameters();

    // D5: 音が鳴っていなければ何も生成しない。黒画面が正しい挙動。
    this.material.uniforms.uActive!.value = audio.active === 1 ? 1 : 0;
    this.material.uniforms.uTime!.value = elapsed;

    this.field.update(audio, elapsed);
    this.renderer.update(audio, elapsed);
    this.pipeline?.update(audio, elapsed);
  }

  render(): void {
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    const resolution = this.material?.uniforms.uResolution?.value as THREE.Vector2 | undefined;
    resolution?.set(width, height);
    this.pipeline?.resize(width, height);
  }

  getEffects(): readonly Effect[] {
    return this.effects;
  }

  moveEffect(effect: Effect, direction: -1 | 1): void {
    this.pipeline?.move(effect, direction);
  }

  setGeneratorsVisible(): void {
    // 生成レイヤーの表示切り替えは Field / Renderer の選択に置き換わるため何もしない。
  }

  setDesignLayerCanvases(canvases: DesignLayerCanvases): void {
    this.pipeline?.setOverlayCanvases(canvases);
  }

  updateDesignLayerCanvases(): void {
    this.pipeline?.updateOverlayCanvases();
  }

  dispose(): void {
    this.pipeline?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.field.dispose();
    this.renderer.dispose();

    this.pipeline = null;
    this.geometry = null;
    this.material = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
  }
}
