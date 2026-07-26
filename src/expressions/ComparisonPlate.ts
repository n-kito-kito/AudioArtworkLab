import * as THREE from 'three';
import type {
  CompositionContext,
  DesignLayerCanvases,
} from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import type { ModeExciterState } from '../engine/modeBank';
import type { Theme } from '../engine/themes';
import { createExpression } from './catalog';
import type { CymaticsPlate } from './CymaticsPlate';
import type { ExpressionId, PlateExpression } from './PlateExpression';

/**
 * 開発用の V1 / V2 比較表示（`?compare=1`・dev のみ）。
 *
 * 同じ音声解析フレーム・同じ再生時刻・同じキャンバスサイズ・同じ Effect 設定で
 * 2 枚の板を並走させ、ワイプで境目を動かして見比べる。本番ビルドには含まれない。
 *
 * **状態は共有しない。** V1 と V2 は別インスタンスで、密度場・モード履歴・
 * 場の uniform をそれぞれ独自に持つ。共有するのは Effect インスタンスだけで、
 * これは「同じ質感で比べる」ために意図的にそうしている（EffectPipeline の
 * ownsEffects により、更新と破棄は V1 側だけが行う）。
 *
 * ワイプ位置 `split` は「左から V1 が占める割合」。
 *   0 = V2 のみ / 1 = V1 のみ / 0.5 = 左右分割
 * 2 枚は同じ幾何で描かれるため、境目の前後で板の同じ場所を比べられる。
 */
export class ComparisonPlate implements PlateExpression {
  readonly animated = true;
  readonly name = 'Cymatics comparison';
  /**
   * 保存上は開発中の V2 として扱う。比較は開発用の見方であり、
   * 表現そのものではないため独自の id を作らない。
   */
  readonly id: ExpressionId = 'cymatics-v2';

  private readonly v1: CymaticsPlate;
  private readonly v2: CymaticsPlate;
  private split = 0.5;

  private scene: THREE.Scene | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private geometry: THREE.PlaneGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private context: CompositionContext | null = null;

  constructor(effects: Effect[], theme?: Theme) {
    // Effect は V1 が所有し、V2 は同じインスタンスを描画にだけ使う。
    this.v1 = createExpression('cymatics-v1', effects, theme, true);
    this.v2 = createExpression('cymatics-v2', effects, theme, false);
  }

  setup(context: CompositionContext): void {
    this.context = context;
    this.v1.setup(context);
    this.v2.setup(context);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tV1: { value: null },
        tV2: { value: null },
        uSplit: { value: this.split },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tV1;
        uniform sampler2D tV2;
        uniform float uSplit;

        void main() {
          vec3 color = vUv.x < uSplit
            ? texture2D(tV1, vUv).rgb
            : texture2D(tV2, vUv).rgb;
          // 境目の細い線。どちらを見ているか分かるようにするためだけのもの。
          if (uSplit > 0.001 && uSplit < 0.999) {
            float edge = 1.0 - smoothstep(0.0, 0.0015, abs(vUv.x - uSplit));
            color = mix(color, vec3(0.35), edge * 0.8);
          }
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    this.scene = new THREE.Scene();
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.scene.add(new THREE.Mesh(this.geometry, this.material));
  }

  update(elapsed: number): void {
    // 同じ経過時刻で進める。音声解析はフレーム内でキャッシュされるため、
    // 2 枚は必ず同一の解析フレームを見る。
    this.v1.update(elapsed);
    this.v2.update(elapsed);
  }

  render(): void {
    if (!this.context || !this.material || !this.scene || !this.camera) return;
    const v1Texture = this.v1.renderToTexture();
    const v2Texture = this.v2.renderToTexture();
    this.material.uniforms.tV1!.value = v1Texture;
    this.material.uniforms.tV2!.value = v2Texture;
    this.material.uniforms.uSplit!.value = this.split;

    const renderer = this.context.renderer;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  /** ワイプ位置。0 = V2 のみ / 1 = V1 のみ / 0.5 = 左右分割。 */
  getSplit(): number {
    return this.split;
  }

  setSplit(value: number): void {
    this.split = Math.min(Math.max(value, 0), 1);
  }

  /** 開発用: 左右それぞれの励起状態（デバッグパネルが両方を表示する）。 */
  getSideStates(): { v1: ModeExciterState; v2: ModeExciterState } {
    return { v1: this.v1.getDebugState(), v2: this.v2.getDebugState() };
  }

  resize(width: number, height: number): void {
    this.v1.resize(width, height);
    this.v2.resize(width, height);
  }

  getEffects(): readonly Effect[] {
    return this.v1.getEffects();
  }

  moveEffect(effect: Effect, direction: -1 | 1): void {
    this.v1.moveEffect(effect, direction);
    this.v2.setEffectOrder(this.v1.getEffects().map((entry) => entry.name));
  }

  setEffectOrder(names: string[]): void {
    this.v1.setEffectOrder(names);
    this.v2.setEffectOrder(names);
  }

  getTheme(): Theme {
    return this.v2.getTheme();
  }

  setTheme(theme: Theme): void {
    this.v1.setTheme(theme);
    this.v2.setTheme(theme);
  }

  getDepth(): number {
    return this.v2.getDepth();
  }

  setDepth(amount: number): void {
    this.v1.setDepth(amount);
    this.v2.setDepth(amount);
  }

  getZoom(): number {
    return this.v2.getZoom();
  }

  setZoom(zoom: number): void {
    this.v1.setZoom(zoom);
    this.v2.setZoom(zoom);
  }

  setDebugView(view: number): void {
    this.v1.setDebugView(view);
    this.v2.setDebugView(view);
  }

  /** デバッグパネルの既定表示は開発中の V2 側。 */
  getDebugState(): ModeExciterState {
    return this.v2.getDebugState();
  }

  setGeneratorsVisible(): void {
    // 表現の表示切り替えは存在しない。
  }

  setDesignLayerCanvases(canvases: DesignLayerCanvases): void {
    this.v1.setDesignLayerCanvases(canvases);
    this.v2.setDesignLayerCanvases(canvases);
  }

  updateDesignLayerCanvases(): void {
    this.v1.updateDesignLayerCanvases();
    this.v2.updateDesignLayerCanvases();
  }

  dispose(): void {
    // V2 を先に破棄する。Effect を所有するのは V1 側で、
    // 先に Effect が捨てられると V2 のパイプラインが壊れたパスを触るため。
    this.v2.dispose();
    this.v1.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.geometry = null;
    this.material = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
  }
}
