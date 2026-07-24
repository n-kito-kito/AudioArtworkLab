import * as THREE from 'three';
import type { Composition, CompositionContext, DesignLayerCanvases } from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import type { Field } from './Field';
import type { FieldRenderer } from './FieldRenderer';
import { composeFragmentShader, vertexShader } from './composeShader';
import { THEMES, type Theme } from './themes';

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

  private theme: Theme;
  private depthAmount = 0;
  private smoothedBass = 0;
  private readonly transitionFrom: FieldRenderer | null;
  private transitionMix = 0;
  private previousElapsed = -1;

  /** リニアトランジションの長さ（秒）。前の表現から新しい表現へ混ざりきるまで。 */
  private static readonly TRANSITION_DURATION = 1.6;

  constructor(
    field: Field,
    renderer: FieldRenderer,
    effects: Effect[] = [],
    theme?: Theme,
    transitionFrom?: FieldRenderer,
  ) {
    this.field = field;
    this.renderer = renderer;
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
    this.transitionFrom = transitionFrom ?? null;
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
        uThemeDark: { value: new THREE.Vector3(...this.theme.dark) },
        uThemeLight: { value: new THREE.Vector3(...this.theme.light) },
        uThemeAccent: { value: new THREE.Vector3(...this.theme.accent) },
        uDepthAmount: { value: 0 },
        uRendererMix: { value: this.transitionFrom ? 0 : 1 },
        ...this.field.uniforms,
        ...this.renderer.uniforms,
        ...(this.transitionFrom?.uniforms ?? {}),
      },
      vertexShader,
      fragmentShader: composeFragmentShader(this.field, this.renderer, this.transitionFrom ?? undefined),
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

    // L1: 低域が層の分離をわずかに押し広げる。基準量はユーザーが決めた範囲。
    const bass = Math.min(Math.max(audio.bass ?? 0, 0), 1);
    this.smoothedBass += (bass - this.smoothedBass) * 0.12;
    this.material.uniforms.uDepthAmount!.value =
      this.depthAmount * (0.85 + this.smoothedBass * 0.3);

    // リニアトランジション: 前の表現から新しい表現へ一定速度で混ざる。
    // 初回フレームは基準時刻がないため進めない。
    const delta =
      this.previousElapsed < 0
        ? 0
        : Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.1);
    this.previousElapsed = elapsed;
    if (this.transitionFrom && this.transitionMix < 1) {
      this.transitionMix = Math.min(
        this.transitionMix + delta / FieldComposition.TRANSITION_DURATION,
        1,
      );
      this.material.uniforms.uRendererMix!.value = this.transitionMix;
      this.transitionFrom.update(audio, elapsed);
    }

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

  getRenderer(): FieldRenderer {
    return this.renderer;
  }

  getTheme(): Theme {
    return this.theme;
  }

  getDepth(): number {
    return this.depthAmount;
  }

  /** 奥行きの量。0 で従来どおりの 1 層になる。実際の分離量は低域が揺らす。 */
  setDepth(amount: number): void {
    this.depthAmount = Math.min(Math.max(amount, 0), 1);
  }

  /** テーマは uniform の差し替えだけで反映される（再コンパイル不要）。 */
  setTheme(theme: Theme): void {
    this.theme = theme;
    if (!this.material) return;
    (this.material.uniforms.uThemeDark!.value as THREE.Vector3).set(...theme.dark);
    (this.material.uniforms.uThemeLight!.value as THREE.Vector3).set(...theme.light);
    (this.material.uniforms.uThemeAccent!.value as THREE.Vector3).set(...theme.accent);
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
    this.transitionFrom?.dispose();

    this.pipeline = null;
    this.geometry = null;
    this.material = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
  }
}
