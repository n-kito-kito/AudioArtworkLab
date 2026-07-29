import * as THREE from 'three';
import type {
  CompositionContext,
  DesignLayerCanvases,
} from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { LabExpression } from './Expression';
import {
  loadPrismAtlas,
  type PrismAtlas,
  type PrismTile,
} from './prismAtlas';

/**
 * リファレンスの光を一度に作らず、構成要素ごとに単独で観察するための実験室。
 *
 * 本番の Light Spatial Study とは状態も描画も共有しない。ここで再利用するのは
 * 安定した光学素材（prism atlas）と EffectPipeline だけである。
 *
 * 音への接続も意図的に行わない。まず固定条件で Core / Ray / Sheet / Haze /
 * Prism / Depth / Envelope を個別に評価し、Composite で同じ光としてまとまるかを
 * 確認する。質感が決まった後に Audio 層へ接続するための視覚リファレンスである。
 */

export type LightElementMode =
  | 'core'
  | 'ray'
  | 'sheet'
  | 'haze'
  | 'prism'
  | 'depth'
  | 'envelope'
  | 'composite';

const MODE_LABELS: Readonly<Record<LightElementMode, string>> = {
  core: 'Core',
  ray: 'Ray',
  sheet: 'Sheet',
  haze: 'Haze',
  prism: 'Prism',
  depth: 'Depth',
  envelope: 'Envelope',
  composite: 'Composite',
};

const LAB = {
  atlasManifest: '/assets/light-traces/manifest.json',
  atlasCellPixels: 384,
  atlasColumns: 4,
  cameraFov: 45,
  cameraNear: 0.1,
  cameraFar: 60,
  envelopeSeconds: 5,
} as const;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const OPTICAL_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform vec2 uGrid;
  uniform float uTile;
  uniform vec4 uCrop;
  uniform float uKind;
  uniform float uIntensity;
  uniform float uEnvelope;
  uniform float uHueOffset;
  uniform float uHueSpan;
  varying vec2 vUv;

  const float TAU = 6.28318530718;

  vec3 spectrum(float t) {
    vec3 phase = vec3(0.0, 0.34, 0.67);
    return 0.52 + 0.48 * cos(TAU * (t + phase));
  }

  float labLuminance(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
  }

  vec3 sampleTile(vec2 localUv) {
    float column = mod(uTile, uGrid.x);
    float row = floor(uTile / uGrid.x);
    float textureRow = uGrid.y - 1.0 - row;
    vec2 safeUv = clamp(localUv, vec2(0.025), vec2(0.975));
    return texture2D(uAtlas, (vec2(column, textureRow) + safeUv) / uGrid).rgb;
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    vec2 localUv = vec2(0.5) + uCrop.xy + p * 0.44 * uCrop.zw;
    vec3 source = sampleTile(localUv);
    float sourceLight = pow(max(labLuminance(source) * 3.2, 0.0), 0.55);
    float ellipse = length(p / vec2(1.0, 0.78));
    float softEdge = 1.0 - smoothstep(0.58, 1.03, ellipse);
    float grain = 0.96 + 0.04 * sin(dot(p, vec2(49.3, 81.7)));

    float radial2 = dot(p, p);
    float nucleus = exp(-radial2 * 34.0);
    float localHalo = exp(-radial2 * 4.2);
    float coreShape = softEdge * (
      sourceLight * 1.38 +
      nucleus * 0.34 +
      localHalo * 0.045
    );

    float centralVeil = exp(-p.y * p.y * 4.0) * exp(-p.x * p.x * 0.72);
    float sheetShape = softEdge * (
      sourceLight * 1.08 +
      centralVeil * 0.055
    );

    float shape = mix(coreShape, sheetShape, step(0.5, uKind));
    float hue = uHueOffset + (p.x * 0.5 + 0.5) * uHueSpan + sourceLight * 0.06;
    vec3 spectral = spectrum(hue);
    vec3 sourceTint = source / max(max(source.r, source.g), max(source.b, 0.02));
    vec3 color = mix(spectral, sourceTint, 0.16);

    float whiteCentre = nucleus * (1.0 - step(0.5, uKind)) * 0.42;
    color = mix(color, vec3(0.96, 0.98, 1.0), whiteCentre);
    color *= shape * grain * uIntensity * uEnvelope;

    gl_FragColor = vec4(color, clamp(shape * uEnvelope, 0.0, 1.0));
  }
`;

const RAY_FRAGMENT_SHADER = /* glsl */ `
  uniform float uAspect;
  uniform float uVariant;
  uniform float uIntensity;
  uniform float uEnvelope;
  varying vec2 vUv;

  float lineSegment(
    vec2 p,
    vec2 origin,
    vec2 direction,
    float startAt,
    float endAt,
    float width
  ) {
    vec2 delta = p - origin;
    float along = dot(delta, direction);
    float across = abs(delta.x * direction.y - delta.y * direction.x);
    float head = smoothstep(startAt - 0.04, startAt + 0.02, along);
    float tail = 1.0 - smoothstep(endAt - 0.2, endAt, along);
    return exp(-pow(across / width, 2.0)) * head * tail;
  }

  vec3 spectralRay(
    vec2 p,
    vec2 origin,
    float angle,
    float hue,
    float width,
    float strength
  ) {
    vec2 direction = vec2(cos(angle), sin(angle));
    float core = lineSegment(p, origin, direction, 0.0, 3.2, width);
    float halo = lineSegment(p, origin, direction, 0.0, 3.2, width * 5.0);
    vec3 color = 0.52 + 0.48 * cos(6.2831853 * (hue + vec3(0.0, 0.34, 0.67)));
    return color * strength * (core + halo * 0.12);
  }

  void main() {
    vec2 p = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);
    vec3 color = vec3(0.0);

    if (uVariant < 0.5) {
      vec2 origin = vec2(-0.1 * uAspect, 0.02);
      float horizontal = lineSegment(p, origin, vec2(1.0, 0.0), -3.0, 3.0, 0.007);
      float horizontalHalo =
        lineSegment(p, origin, vec2(1.0, 0.0), -3.0, 3.0, 0.055);
      float vertical = lineSegment(p, origin, vec2(0.0, 1.0), -2.0, 2.0, 0.004);
      float verticalHalo =
        lineSegment(p, origin, vec2(0.0, 1.0), -2.0, 2.0, 0.038);
      color =
        vec3(0.62, 0.74, 1.0) * (horizontal * 0.68 + horizontalHalo * 0.055) +
        vec3(0.94, 0.68, 1.0) * (vertical * 0.34 + verticalHalo * 0.03);
    } else if (uVariant < 1.5) {
      vec2 origin = vec2(-0.28 * uAspect, 0.05);
      float inputCore =
        lineSegment(p, origin, vec2(1.0, 0.0), -3.0, 0.0, 0.006);
      float inputHalo =
        lineSegment(p, origin, vec2(1.0, 0.0), -3.0, 0.0, 0.045);
      color += vec3(0.84, 0.91, 1.0) * (inputCore * 0.8 + inputHalo * 0.055);
      color += spectralRay(p, origin, -0.17, 0.00, 0.006, 0.52);
      color += spectralRay(p, origin, -0.10, 0.10, 0.006, 0.58);
      color += spectralRay(p, origin, -0.035, 0.20, 0.006, 0.62);
      color += spectralRay(p, origin, 0.035, 0.36, 0.006, 0.62);
      color += spectralRay(p, origin, 0.10, 0.55, 0.006, 0.58);
      color += spectralRay(p, origin, 0.17, 0.73, 0.006, 0.52);
      float meeting = exp(-dot(p - origin, p - origin) * 115.0);
      color += vec3(0.92, 0.95, 1.0) * meeting * 0.48;
    } else {
      vec2 origin = vec2(-0.18 * uAspect, 0.01);
      float horizontal =
        lineSegment(p, origin, vec2(1.0, 0.0), -2.8, 3.0, 0.005);
      float horizontalHalo =
        lineSegment(p, origin, vec2(1.0, 0.0), -2.8, 3.0, 0.052);
      float vertical =
        lineSegment(p, origin, normalize(vec2(0.04, 1.0)), -2.0, 2.0, 0.004);
      float diagonal =
        lineSegment(p, origin, normalize(vec2(1.0, 0.44)), -0.1, 2.6, 0.005);
      color += vec3(0.6, 0.76, 1.0) * (horizontal * 0.45 + horizontalHalo * 0.04);
      color += vec3(0.92, 0.6, 1.0) * vertical * 0.19;
      color += vec3(0.52, 0.98, 0.82) * diagonal * 0.2;
    }

    color *= uIntensity * uEnvelope;
    gl_FragColor = vec4(color, clamp(max(color.r, max(color.g, color.b)), 0.0, 1.0));
  }
`;

const HAZE_FRAGMENT_SHADER = /* glsl */ `
  uniform float uAspect;
  uniform float uIntensity;
  uniform float uEnvelope;
  varying vec2 vUv;

  float ellipse(vec2 p, vec2 centre, vec2 radius) {
    vec2 q = (p - centre) / radius;
    return exp(-dot(q, q) * 1.5);
  }

  void main() {
    vec2 p = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);
    float violet = ellipse(p, vec2(-0.38 * uAspect, 0.04), vec2(1.15, 0.74));
    float blue = ellipse(p, vec2(0.18 * uAspect, 0.0), vec2(1.45, 0.6));
    float green = ellipse(p, vec2(0.46 * uAspect, -0.16), vec2(1.15, 0.82));
    float quietNoise = 0.96 + 0.04 * sin(dot(p, vec2(19.7, 43.1)));
    vec3 color =
      vec3(0.23, 0.1, 0.42) * violet * 0.32 +
      vec3(0.1, 0.24, 0.52) * blue * 0.26 +
      vec3(0.08, 0.36, 0.24) * green * 0.22;
    color *= quietNoise * uIntensity * uEnvelope;
    gl_FragColor = vec4(color, clamp(max(color.r, max(color.g, color.b)), 0.0, 1.0));
  }
`;

interface OpticalLayer {
  readonly material: THREE.ShaderMaterial;
  readonly preferredRoles: readonly string[];
  readonly fallbackTile: number;
}

interface ScreenLayer {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  readonly distance: number;
  readonly overscan: number;
}

interface OpticalLayerOptions {
  readonly kind: 'core' | 'sheet';
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number];
  readonly rotation?: readonly [number, number, number];
  readonly intensity: number;
  readonly hueOffset: number;
  readonly hueSpan: number;
  readonly crop: readonly [number, number, number, number];
  readonly preferredRoles: readonly string[];
  readonly fallbackTile: number;
  readonly renderOrder: number;
}

const makeBlackTexture = (): THREE.DataTexture => {
  const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

const envelopeAt = (time: number): number => {
  const local = ((time % LAB.envelopeSeconds) + LAB.envelopeSeconds) % LAB.envelopeSeconds;
  if (local < 0.16) return THREE.MathUtils.smoothstep(local, 0, 0.16);
  if (local < 0.78) return 1;
  if (local < 3.7) {
    const t = (local - 0.78) / (3.7 - 0.78);
    return Math.max((Math.exp(-2.8 * t) - Math.exp(-2.8)) / (1 - Math.exp(-2.8)), 0);
  }
  return 0;
};

const envelopePhaseAt = (time: number): string => {
  const local = ((time % LAB.envelopeSeconds) + LAB.envelopeSeconds) % LAB.envelopeSeconds;
  if (local < 0.16) return 'Attack';
  if (local < 0.78) return 'Hold';
  if (local < 3.7) return 'Decay';
  return 'Off';
};

export class LightElementLab implements LabExpression {
  readonly animated = true;
  readonly name: string;
  readonly id: ExpressionId;
  readonly mode: LightElementMode;

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;
  private context: CompositionContext | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private geometry: THREE.PlaneGeometry | null = null;
  private placeholderTexture: THREE.DataTexture | null = null;
  private atlas: PrismAtlas | null = null;
  private pipeline: EffectPipeline | null = null;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly opticalLayers: OpticalLayer[] = [];
  private readonly screenLayers: ScreenLayer[] = [];
  private elapsed = 0;
  private cycleOffset = 0;
  private disposed = false;

  constructor(
    id: ExpressionId,
    mode: LightElementMode,
    effects: Effect[],
    theme: Theme = THEMES[0]!,
  ) {
    this.id = id;
    this.mode = mode;
    this.effects = effects;
    this.theme = theme;
    this.name = `Light Element Lab — ${MODE_LABELS[mode]}`;
  }

  setup(context: CompositionContext): void {
    this.context = context;
    this.disposed = false;
    this.elapsed = 0;
    this.cycleOffset = 0;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(
      LAB.cameraFov,
      this.aspectRatio,
      LAB.cameraNear,
      LAB.cameraFar,
    );
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(0, 0, -1);
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.placeholderTexture = makeBlackTexture();

    this.buildStudy();
    this.pipeline = new EffectPipeline(
      context.renderer,
      this.scene,
      this.camera,
      this.effects,
    );
    this.loadAtlas();
  }

  update(elapsed: number): void {
    // AnimationLoop の elapsed は Expression を開いた瞬間からの秒数。
    // フレーム数を積まず、この時計を直接使うことで 60Hz / 120Hz でも同じ周期になる。
    this.elapsed = Math.max(elapsed, 0);
    const studyTime = Math.max(this.elapsed - this.cycleOffset, 0);
    const envelope = this.mode === 'envelope' ? envelopeAt(studyTime) : 1;

    for (const material of this.materials) {
      const uniform = material.uniforms.uEnvelope;
      if (uniform) uniform.value = envelope;
    }

    const audio = this.context?.audioEngine.getParameters() ?? {};
    this.pipeline?.update(audio, elapsed);
  }

  render(): void {
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    const ratio = Math.max(width / Math.max(height, 1), 0.01);
    if (this.camera) {
      this.camera.aspect = ratio;
      this.camera.updateProjectionMatrix();
    }
    for (const material of this.materials) {
      const uniform = material.uniforms.uAspect;
      if (uniform) uniform.value = ratio;
    }
    this.syncScreenLayers(ratio);
    this.pipeline?.resize(width, height);
  }

  setGeneratorsVisible(visible: boolean): void {
    if (this.scene) this.scene.visible = visible;
  }

  setDesignLayerCanvases(canvases: DesignLayerCanvases): void {
    this.pipeline?.setOverlayCanvases(canvases);
  }

  updateDesignLayerCanvases(): void {
    this.pipeline?.updateOverlayCanvases();
  }

  getEffects(): readonly Effect[] {
    return this.effects;
  }

  moveEffect(effect: Effect, direction: -1 | 1): void {
    this.pipeline?.move(effect, direction);
  }

  setEffectOrder(names: string[]): void {
    this.pipeline?.setOrder(names);
  }

  getTheme(): Theme {
    return this.theme;
  }

  setTheme(theme: Theme): void {
    // 黒背景と素材固有色を比較する検証なので、値だけ保持して描画には使わない。
    this.theme = theme;
  }

  usesTheme(): boolean {
    return false;
  }

  getZoom(): number {
    return this.zoom;
  }

  setZoom(zoom: number): void {
    this.zoom = THREE.MathUtils.clamp(zoom, 0.5, 2);
    if (this.camera) {
      this.camera.zoom = this.zoom;
      this.camera.updateProjectionMatrix();
    }
  }

  getResponse(): { bass: number; mid: number; treble: number } {
    return { ...this.response };
  }

  setResponse(gains: Partial<{ bass: number; mid: number; treble: number }>): void {
    this.response = {
      bass: gains.bass ?? this.response.bass,
      mid: gains.mid ?? this.response.mid,
      treble: gains.treble ?? this.response.treble,
    };
  }

  getAspectId(): string {
    return this.aspectId;
  }

  getAspectRatio(): number {
    return this.aspectRatio;
  }

  setAspect(id: string, ratio: number): void {
    this.aspectId = id;
    this.aspectRatio = ratio;
  }

  setDebugView(view: number): void {
    void view;
  }

  getDebugState(): null {
    return null;
  }

  getDepth(): number {
    return 0;
  }

  setDepth(amount: number): void {
    void amount;
  }

  getPhase(): string {
    if (this.mode === 'envelope') {
      return `Envelope: ${envelopePhaseAt(Math.max(this.elapsed - this.cycleOffset, 0))}`;
    }
    return `Study: ${MODE_LABELS[this.mode]}`;
  }

  restartCycle(): void {
    this.cycleOffset = this.elapsed;
  }

  dispose(): void {
    this.disposed = true;
    this.pipeline?.dispose();
    this.pipeline = null;
    this.materials.forEach((material) => material.dispose());
    this.materials.length = 0;
    this.opticalLayers.length = 0;
    this.screenLayers.length = 0;
    this.geometry?.dispose();
    this.geometry = null;
    this.placeholderTexture?.dispose();
    this.placeholderTexture = null;
    this.atlas?.texture.dispose();
    this.atlas = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
  }

  private buildStudy(): void {
    if (this.mode === 'core') {
      this.addOpticalLayer({
        kind: 'core',
        position: [-0.12, 0.02, -6],
        scale: [1.05, 1.05],
        intensity: 1.28,
        hueOffset: 0.12,
        hueSpan: 0.38,
        crop: [0.02, -0.03, 0.88, 0.88],
        preferredRoles: ['layered-sheets', 'curved-volume'],
        fallbackTile: 3,
        renderOrder: 3,
      });
      return;
    }

    if (this.mode === 'ray') {
      this.addRayLayer(0, 0.9);
      return;
    }

    if (this.mode === 'sheet') {
      this.addOpticalLayer({
        kind: 'sheet',
        position: [0.02, -0.05, -7],
        scale: [3.45, 2.45],
        rotation: [-0.08, 0.28, 0.045],
        intensity: 1.2,
        hueOffset: 0.08,
        hueSpan: 0.65,
        crop: [-0.01, 0.03, 0.95, 0.72],
        preferredRoles: ['wide-caustic', 'layered-sheets'],
        fallbackTile: 6,
        renderOrder: 2,
      });
      return;
    }

    if (this.mode === 'haze') {
      this.addHazeLayer(1);
      return;
    }

    if (this.mode === 'prism') {
      this.addRayLayer(1, 0.92);
      return;
    }

    if (this.mode === 'depth') {
      this.addDepthLayers(0.93);
      return;
    }

    if (this.mode === 'envelope') {
      this.addOpticalLayer({
        kind: 'core',
        position: [-0.08, 0.02, -6],
        scale: [1.05, 1.05],
        intensity: 1.34,
        hueOffset: 0.12,
        hueSpan: 0.38,
        crop: [0.02, -0.03, 0.88, 0.88],
        preferredRoles: ['layered-sheets', 'curved-volume'],
        fallbackTile: 3,
        renderOrder: 3,
      });
      return;
    }

    this.addHazeLayer(0.72);
    this.addRayLayer(2, 0.9);
    this.addDepthLayers(0.9);
    this.addOpticalLayer({
      kind: 'core',
      position: [-0.48, 0.02, -6],
      scale: [0.92, 0.92],
      intensity: 1.18,
      hueOffset: 0.14,
      hueSpan: 0.42,
      crop: [0.02, -0.03, 0.88, 0.88],
      preferredRoles: ['layered-sheets', 'curved-volume'],
      fallbackTile: 3,
      renderOrder: 4,
    });
  }

  private addDepthLayers(intensity: number): void {
    this.addOpticalLayer({
      kind: 'sheet',
      position: [-1.35, 0.12, -4.6],
      scale: [1.55, 2.5],
      rotation: [-0.08, 0.58, -0.04],
      intensity: intensity * 0.58,
      hueOffset: 0.32,
      hueSpan: 0.32,
      crop: [0.02, 0, 0.82, 0.72],
      preferredRoles: ['parallel-curtains', 'filament-and-curtain'],
      fallbackTile: 7,
      renderOrder: 3,
    });
    this.addOpticalLayer({
      kind: 'sheet',
      position: [0.2, -0.08, -7.4],
      scale: [3.05, 2.7],
      rotation: [0.05, -0.33, 0.06],
      intensity: intensity * 0.75,
      hueOffset: 0.08,
      hueSpan: 0.68,
      crop: [-0.03, 0.04, 0.92, 0.75],
      preferredRoles: ['wide-caustic', 'layered-sheets'],
      fallbackTile: 6,
      renderOrder: 2,
    });
    this.addOpticalLayer({
      kind: 'sheet',
      position: [1.65, 0.26, -11.2],
      scale: [4.2, 3.8],
      rotation: [0.02, 0.42, -0.03],
      intensity: intensity * 0.52,
      hueOffset: 0.66,
      hueSpan: 0.28,
      crop: [0.02, -0.02, 0.88, 0.78],
      preferredRoles: ['wide-haze', 'curved-volume'],
      fallbackTile: 4,
      renderOrder: 1,
    });
  }

  private addOpticalLayer(options: OpticalLayerOptions): void {
    if (!this.scene || !this.geometry || !this.placeholderTexture) return;
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: OPTICAL_FRAGMENT_SHADER,
      uniforms: {
        uAtlas: { value: this.placeholderTexture },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uTile: { value: 0 },
        uCrop: { value: new THREE.Vector4(...options.crop) },
        uKind: { value: options.kind === 'core' ? 0 : 1 },
        uIntensity: { value: options.intensity },
        uEnvelope: { value: 1 },
        uHueOffset: { value: options.hueOffset },
        uHueSpan: { value: options.hueSpan },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.position.set(...options.position);
    mesh.scale.set(options.scale[0], options.scale[1], 1);
    if (options.rotation) mesh.rotation.set(...options.rotation);
    mesh.renderOrder = options.renderOrder;
    this.scene.add(mesh);
    this.materials.push(material);
    this.opticalLayers.push({
      material,
      preferredRoles: options.preferredRoles,
      fallbackTile: options.fallbackTile,
    });
  }

  private addRayLayer(variant: 0 | 1 | 2, intensity: number): void {
    if (!this.placeholderTexture) return;
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: RAY_FRAGMENT_SHADER,
      uniforms: {
        uAspect: { value: this.aspectRatio },
        uVariant: { value: variant },
        uIntensity: { value: intensity },
        uEnvelope: { value: 1 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    this.addScreenLayer(material, 12, 1.02, 5);
  }

  private addHazeLayer(intensity: number): void {
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: HAZE_FRAGMENT_SHADER,
      uniforms: {
        uAspect: { value: this.aspectRatio },
        uIntensity: { value: intensity },
        uEnvelope: { value: 1 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    this.addScreenLayer(material, 14, 1.03, 0);
  }

  private addScreenLayer(
    material: THREE.ShaderMaterial,
    distance: number,
    overscan: number,
    renderOrder: number,
  ): void {
    if (!this.scene || !this.geometry) return;
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.position.z = -distance;
    mesh.renderOrder = renderOrder;
    this.scene.add(mesh);
    this.materials.push(material);
    this.screenLayers.push({ mesh, distance, overscan });
    this.syncScreenLayers(this.aspectRatio);
  }

  private syncScreenLayers(aspect: number): void {
    const halfFov = THREE.MathUtils.degToRad(LAB.cameraFov * 0.5);
    for (const layer of this.screenLayers) {
      const halfHeight = Math.tan(halfFov) * layer.distance * layer.overscan;
      layer.mesh.scale.set(halfHeight * aspect, halfHeight, 1);
    }
  }

  private async loadAtlas(): Promise<void> {
    const atlas = await loadPrismAtlas({
      manifestUrl: LAB.atlasManifest,
      cellPixels: LAB.atlasCellPixels,
      columns: LAB.atlasColumns,
    });
    if (!atlas) return;
    if (this.disposed) {
      atlas.texture.dispose();
      return;
    }

    this.atlas = atlas;
    for (const layer of this.opticalLayers) {
      const tile = this.findPreferredTile(atlas.tiles, layer.preferredRoles, layer.fallbackTile);
      layer.material.uniforms.uAtlas!.value = atlas.texture;
      layer.material.uniforms.uGrid!.value.set(atlas.columns, atlas.rows);
      layer.material.uniforms.uTile!.value = tile;
    }
  }

  private findPreferredTile(
    tiles: readonly PrismTile[],
    preferredRoles: readonly string[],
    fallbackTile: number,
  ): number {
    for (const role of preferredRoles) {
      const index = tiles.findIndex((tile) => tile.role === role);
      if (index >= 0) return index;
    }
    return THREE.MathUtils.clamp(fallbackTile, 0, Math.max(tiles.length - 1, 0));
  }
}
