import * as THREE from 'three';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { THEMES, type Theme } from '../engine/themes';
import { getSourceShelf, type AudioSourceShelf } from '../engine/binding/sources';
import { BindingResolver } from '../engine/binding/resolve';
import { defaultTransformFor, type ParamDecl } from '../engine/binding/types';
import type { CompositionContext, DesignLayerCanvases } from '../compositions/Composition';
import type { ExpressionParam, LabExpression } from './Expression';
import type { ExpressionId } from './catalog';
import { OpticsAudioDrive, hueOfPhase } from './opticsAudioDrive';
import { channelBalanceGain } from './channelBalance';
import type { FragmentSpawn } from './lightOpticsMapping';
import { loadPrismAtlas, type PrismAtlas } from './prismAtlas';
import {
  AXIS_DECLS,
  AXIS_PRESETS,
  DEFAULT_AXES,
  tickRateOf,
  type UnifiedAxes,
} from './unifiedAxes';
import {
  UNIFIED,
  UNIFIED_KIND_INDEX,
  buildUnifiedRig,
  type UnifiedDrive,
  type UnifiedLayer,
} from './unifiedRig';
import { EmissionShape } from './unifiedTime';

/**
 * **Light Unified — 3 つの Light 表現を連続軸で行き来する統合表現。**
 *
 * Spatial Study / Reactive Lab / Element Lab 2 は**無改変で温存**し、
 * ここは新規に書いたレンダラーである。持ち込むのは共有部品だけ
 * （帯域イベント検出・アトラス・結線・痕跡場を抱える `OpticsAudioDrive`）。
 *
 * **どの軸もコードパスの切替ではなく、描画数式の中の連続な混合係数**として効く。
 * だからスライダーの途中に、3 つのどれでもない見え方が現れる。
 *
 * 描画は **1 ドロー**。6 種別（核 / 光条 / 膜 / 靄 / 破片 / 扇）はフラグメントの
 * 分岐で切り替え、チャンネル分離のためにインスタンスは増やさない。
 */

const LIMITS = {
  /** インスタンスの上限。靄 1 + 膜 4 + 光条 7 + 破片 8 + 扇 1 + 核 1 に余裕を持たせる。 */
  maximumLayers: 48,
  /** 尾を引いている破片も保持するので、生きている枚数より少し多く持つ。 */
  maximumFragmentShapes: 40,
  nearPlane: 0.1,
  farPlane: 90,
  atlas: { manifestUrl: 'assets/light-traces/manifest.json', cellPixels: 384, columns: 4 },
} as const;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * **音へ繋げる軸。**
 *
 * 「触る場所」と「繋ぐ場所」を分けない — スライダーのそこにソース選択を直付けする。
 * どれも 0〜1 の連続量なので、基準値 ± 変調という結線の契約にそのまま乗る。
 * 発光そのもの（場・打撃・扇）と色相 H は、下流の時間規律を壊さないために
 * `OpticsAudioDrive` 側の 1 本（発光 All / H の音色）へ繋ぐ。
 */
const UNIFIED_LOOK_PARAMS: readonly ParamDecl[] = [
  { id: 'intensity', label: 'Intensity', min: 0, max: 1, default: 0.5, kind: 'continuous' },
  { id: 'dispersion', label: 'Channel decorrelation', min: 0, max: 1, default: 0.35, kind: 'continuous' },
  { id: 'depthSpread', label: 'Depth', min: 0, max: 1, default: 0.45, kind: 'continuous' },
  { id: 'channelBalance', label: 'Channel balance', min: 0, max: 1, default: 0.5, kind: 'continuous' },
];

const LOOK_KEYS = new Set(UNIFIED_LOOK_PARAMS.map((entry) => entry.id));

/** `Hue stickiness` が伸ばす時間（秒）。 */
const HUE = { confirmMin: 0.2, confirmMax: 1.8, holdMin: 1, holdMax: 10 } as const;

/** `Density` 軸が生成核へ渡す倍率の範囲。 */
const DENSITY = { min: 0.45, max: 2.6 } as const;

/** 散らばりのシード。**固定値**（同じ音なら必ず同じ絵になる）。 */
const UNIFIED_SEED = 7;

/** 無音の駆動。**1 画素も出ない**状態。 */
const SILENT_DRIVE: UnifiedDrive = {
  fieldLevel: 0,
  corePulse: 0,
  coreShape: -1,
  beamMask: 0,
  beamStrength: 0,
  beamSeed: 0,
  fanPower: 0,
  fanSeed: -1,
  fragments: [],
  hue: 0,
  tick: 0,
  time: 0,
  seed: UNIFIED_SEED,
};

export interface LightUnifiedState {
  readonly layers: number;
  readonly whiteAllowedLayers: number;
  readonly axes: UnifiedAxes;
  readonly hue: number;
  readonly kinds: readonly string[];
}

export class LightUnified implements LabExpression {
  readonly animated = true;
  readonly name = 'Light Unified';
  readonly id: ExpressionId;

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  /** 連続軸。**この 20 本が見え方のすべてを決める。** */
  private readonly axes: UnifiedAxes = { ...DEFAULT_AXES };

  /** 音 → 生成核。3 表現と同じ検出・結線・痕跡場をそのまま使う。 */
  private readonly audioDrive = new OpticsAudioDrive();
  /** 見え方の軸を音へ繋ぐ解決器（発光と H は生成核の側に持つ）。 */
  private readonly lookResolver = new BindingResolver();
  private shelf: AudioSourceShelf | null = null;
  private previousElapsed = -1;

  /**
   * 時間軸（Strobe / Attack / Decay）が作る発光の形。
   * `hold` は**尾を引いているあいだも同じ形・同じ向きで消える**ように覚えておく値。
   */
  private readonly fieldShape = new EmissionShape();
  private readonly coreLight = { emission: new EmissionShape(), hold: -1 };
  private readonly fanLight = { emission: new EmissionShape(), hold: -1 };
  private readonly beamShape = new EmissionShape();
  private beamMaskHeld = 0;
  private beamSeedHeld = 0;
  /** 破片 1 枚ごとの時間の形（死んでも尾のあいだは残す）。 */
  private readonly fragmentShapes = new Map<
    number,
    { spawn: FragmentSpawn; emission: EmissionShape; alive: boolean }
  >();

  private drive: UnifiedDrive = SILENT_DRIVE;
  private layers: readonly UnifiedLayer[] = [];
  private context: CompositionContext | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private geometry: THREE.InstancedBufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  private placeholder: THREE.DataTexture | null = null;
  private atlas: PrismAtlas | null = null;
  private pipeline: EffectPipeline | null = null;
  private disposed = false;

  // ---- インスタンス属性 ----
  private readonly offsets = new Float32Array(LIMITS.maximumLayers * 3);
  private readonly sizes = new Float32Array(LIMITS.maximumLayers * 4);
  private readonly spins = new Float32Array(LIMITS.maximumLayers * 3);
  private readonly tones = new Float32Array(LIMITS.maximumLayers * 4);
  private readonly shapes = new Float32Array(LIMITS.maximumLayers * 4);
  private readonly axesAttr = new Float32Array(LIMITS.maximumLayers * 4);
  private readonly channels = new Float32Array(LIMITS.maximumLayers * 4);
  private readonly attributes: Record<string, THREE.InstancedBufferAttribute> = {};

  constructor(id: ExpressionId, effects: Effect[] = [], theme?: Theme) {
    this.id = id;
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
  }

  // ---------------------------------------------------------------- setup

  setup(context: CompositionContext): void {
    this.context = context;
    this.disposed = false;

    this.camera = new THREE.PerspectiveCamera(
      UNIFIED.fieldOfView,
      this.aspectRatio,
      LIMITS.nearPlane,
      LIMITS.farPlane,
    );
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(0, 0, -1);
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();

    this.placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.placeholder.colorSpace = THREE.SRGBColorSpace;
    this.placeholder.needsUpdate = true;

    this.audioDrive.reset();
    this.audioDrive.setStrobe(true, tickRateOf(this.axes));
    this.previousElapsed = -1;
    this.shelf = getSourceShelf(context.audioEngine);
    this.audioDrive.setShelf(this.shelf);
    this.lookResolver.declare(UNIFIED_LOOK_PARAMS);
    this.lookResolver.setSources(this.shelf.list());
    this.lookResolver.reset();
    for (const decl of UNIFIED_LOOK_PARAMS) {
      this.lookResolver.setBase(decl.id, this.axes[decl.id as keyof UnifiedAxes]);
    }

    this.applyStickiness();
    this.applyDensity();
    this.audioDrive.setTraceAmount(this.axes.trace);
    this.resetShapes();
    this.buildMesh();
    this.rebuild();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    if (this.mesh) this.scene.add(this.mesh);
    this.pipeline = new EffectPipeline(context.renderer, this.scene, this.camera, this.effects);

    void loadPrismAtlas(LIMITS.atlas).then((atlas) => {
      if (!atlas) return;
      if (this.disposed) {
        atlas.texture.dispose();
        return;
      }
      this.atlas = atlas;
      if (this.material) {
        this.material.uniforms.uAtlas!.value = atlas.texture;
        this.material.uniforms.uGrid!.value.set(atlas.columns, atlas.rows);
      }
      this.writeLayers();
    });
  }

  /**
   * **音の状態を統合の駆動へ写す。**
   *
   * 生成核（検出・結線・痕跡場）は 3 表現と共有だが、**時間の形はここで作る**。
   * `Attack` / `Decay` は素の held 値を追うエンベロープの時定数、
   * `Strobe` はティックへのラッチ量（ここ）と off ティックの消灯深さ（層ごと・リグ側）
   * という**連続な係数**として掛かる（`unifiedTime.ts`）。門の入り切りではない。
   */
  /**
   * **結線を通した軸の値。** 繋いでいなければ基準値（スライダー）そのもの。
   * 変調は「基準値 ± 深さ」なので、繋いだ瞬間に見え方が飛ばない。
   */
  private lookValue(key: string): number {
    const binding = this.lookResolver.getBinding(key);
    if (!binding || !binding.sourceId) return this.axes[key as keyof UnifiedAxes];
    return clamp(this.lookResolver.valueOf(key), 0, 1);
  }

  /** 描画が実際に使う軸。結線した 4 本だけが基準値から動く。 */
  private effectiveAxes(): UnifiedAxes {
    const out = { ...this.axes };
    for (const decl of UNIFIED_LOOK_PARAMS) {
      out[decl.id as keyof UnifiedAxes] = this.lookValue(decl.id);
    }
    return out;
  }

  private advanceDrive(elapsed: number, delta: number): void {
    const raw = this.audioDrive.sustained();
    const { attack, decay, strobe } = this.axes;
    const tick = raw.tick;

    // ---- 場 ----
    this.fieldShape.advance(raw.field, delta, tick, attack, decay);
    const field = Math.min(this.fieldShape.read(strobe) * UNIFIED.fieldGain, 1);

    // ---- 核: 生きているあいだの形状族を覚えておき、尾のあいだも同じ形で消える ----
    if (raw.coreAlive) this.coreLight.hold = raw.coreShape;
    this.coreLight.emission.advance(
      raw.coreAlive ? raw.corePulse : 0,
      delta,
      tick,
      attack,
      decay,
    );
    const corePulse = this.coreLight.emission.read(strobe);

    // ---- 扇 ----
    if (raw.fanAlive) this.fanLight.hold = raw.fanSeed;
    this.fanLight.emission.advance(raw.fanAlive ? raw.fanPower : 0, delta, tick, attack, decay);
    const fanPower = this.fanLight.emission.read(strobe);

    // ---- 光条の閃光 ----
    if (raw.armAlive) {
      this.beamMaskHeld = raw.armMask;
      this.beamSeedHeld = raw.armSeed;
    }
    this.beamShape.advance(raw.armAlive ? raw.armStrength : 0, delta, tick, attack, decay);
    const beamStrength = this.beamShape.read(strobe);

    // ---- 破片: 1 枚ずつが自分のエンベロープを持つ。**死んでも尾のあいだは残す** ----
    for (const entry of this.fragmentShapes.values()) entry.alive = false;
    for (const live of raw.fragments) {
      const key = Math.round(live.spawn.seed) * 32 + Math.round(live.spawn.slot);
      let entry = this.fragmentShapes.get(key);
      if (!entry) {
        if (this.fragmentShapes.size >= LIMITS.maximumFragmentShapes) continue;
        entry = { spawn: live.spawn, emission: new EmissionShape(), alive: true };
        this.fragmentShapes.set(key, entry);
      }
      entry.spawn = live.spawn;
      entry.alive = true;
      entry.emission.advance(1, delta, tick, attack, decay);
    }
    // 生きているものを先に置く。**尾を引いている破片が枠を占めて新しい破片を
    // 締め出さない**ようにするためで、どちらの並びも誕生順（決定論）のまま。
    const fragments: UnifiedDrive['fragments'][number][] = [];
    const tails: UnifiedDrive['fragments'][number][] = [];
    for (const [key, entry] of this.fragmentShapes) {
      if (!entry.alive) {
        entry.emission.advance(0, delta, tick, attack, decay);
        if (entry.emission.level <= 0) {
          this.fragmentShapes.delete(key);
          continue;
        }
      }
      const gain = entry.emission.read(strobe);
      if (gain <= 0) continue;
      (entry.alive ? fragments : tails).push({ ...entry.spawn, gain });
    }
    for (const tail of tails) fragments.push(tail);

    this.drive = {
      fieldLevel: field,
      corePulse,
      coreShape: corePulse > 0 ? this.coreLight.hold : -1,
      beamMask: beamStrength > 0 ? this.beamMaskHeld : 0,
      beamStrength,
      beamSeed: this.beamSeedHeld,
      fanPower,
      fanSeed: fanPower > 0 ? this.fanLight.hold : -1,
      fragments,
      hue: this.hueOf(),
      tick,
      time: elapsed,
      seed: UNIFIED_SEED,
    };
  }

  /**
   * **色相。** `hueStickiness` が 0 なら音色をそのまま滑らかに追い、
   * 1 なら 8 つの離散状態に留まる。**同じ道の上を混ぜる**ので、
   * 途中は「少しだけ段のある滑らかさ」になる（切替ではない）。
   * 円周上の最短路で混ぜるので、0 と 1 の境目でも跳ばない。
   */
  /** `Density` 軸を生成核へ渡す（1 バーストの枚数・同時数・打撃の間隔）。 */
  private applyDensity(): void {
    this.audioDrive.setDensity(DENSITY.min + clamp(this.axes.density, 0, 1) * (DENSITY.max - DENSITY.min));
  }

  private applyStickiness(): void {
    const sticky = clamp(this.axes.hueStickiness, 0, 1);
    // 粘りが強いほど「色の回」が長くなる。確認時間も一緒に伸びる。
    this.audioDrive.setHueConfirm(HUE.confirmMin + sticky * (HUE.confirmMax - HUE.confirmMin));
    this.audioDrive.setHueHold(HUE.holdMin + sticky * (HUE.holdMax - HUE.holdMin));
  }

  private hueOf(): number {
    const sticky = clamp(this.axes.hueStickiness, 0, 1);
    const smooth = hueOfPhase(this.audioDrive.levels().timbre);
    const state = this.audioDrive.huePhase();
    let delta = state - smooth;
    delta -= Math.round(delta);
    return ((smooth + delta * sticky) % 1 + 1) % 1;
  }

  /** 時間の形を初期化する。前の曲の尾を持ち越さない。 */
  private resetShapes(): void {
    this.fieldShape.reset();
    this.coreLight.emission.reset();
    this.coreLight.hold = -1;
    this.fanLight.emission.reset();
    this.fanLight.hold = -1;
    this.beamShape.reset();
    this.fragmentShapes.clear();
    this.beamMaskHeld = 0;
    this.beamSeedHeld = 0;
    this.drive = SILENT_DRIVE;
  }

  private rebuild(): void {
    const rig = buildUnifiedRig(this.drive, this.effectiveAxes(), {
      aspectRatio: this.aspectRatio,
    });
    this.layers = rig.slice(0, LIMITS.maximumLayers);
    this.writeLayers();
  }

  /** **1 ドローで全層を描く板。** */
  private buildMesh(): void {
    const plane = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = plane.index;
    geometry.setAttribute('position', plane.getAttribute('position'));
    geometry.setAttribute('uv', plane.getAttribute('uv'));
    plane.dispose();

    const add = (name: string, data: Float32Array, size: number): void => {
      const attribute = new THREE.InstancedBufferAttribute(data, size);
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
      this.attributes[name] = attribute;
    };
    add('aOffset', this.offsets, 3);
    add('aSize', this.sizes, 4);
    add('aSpin', this.spins, 3);
    add('aTone', this.tones, 4);
    add('aShape', this.shapes, 4);
    add('aAxis', this.axesAttr, 4);
    add('aChannel', this.channels, 4);
    geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.placeholder },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uIntensity: { value: 1.6 },
        uOffset: { value: 0.03 },
        uDecorrelation: { value: 0.25 },
        uTint: { value: UNIFIED.tintDepth },
        uChannelGain: { value: new THREE.Vector3(1, 1, 1) },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec4 aSize;
        attribute vec3 aSpin;
        attribute vec4 aTone;
        attribute vec4 aShape;
        attribute vec4 aAxis;
        attribute vec4 aChannel;
        varying vec2 vUv;
        varying vec4 vTone;
        varying vec4 vShape;
        varying vec4 vAxis;
        varying vec4 vChannel;
        varying float vEdge;
        varying float vHalo;
        varying float vPad;

        void main() {
          vUv = uv;
          vTone = aTone;
          vShape = aShape;
          vAxis = aAxis;
          vChannel = aChannel;
          vEdge = aSize.z;
          vHalo = aSize.w;
          vPad = max(aAxis.z, 1.0);

          vec3 local = vec3(position.xy * aSize.xy, 0.0);
          // 面内回転
          float c = cos(aSpin.x);
          float s = sin(aSpin.x);
          local.xy = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
          // 傾き（Tilt 軸が 0 なら両方 0 = 正面のまま）
          float cx = cos(aSpin.y);
          float sx = sin(aSpin.y);
          local.yz = vec2(local.y * cx - local.z * sx, local.y * sx + local.z * cx);
          float cy = cos(aSpin.z);
          float sy = sin(aSpin.z);
          local.xz = vec2(local.x * cy + local.z * sy, -local.x * sy + local.z * cy);

          gl_Position = projectionMatrix * modelViewMatrix * vec4(local + aOffset, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec2 uGrid;
        uniform float uIntensity;
        uniform float uOffset;
        uniform float uDecorrelation;
        uniform float uTint;
        uniform vec3 uChannelGain;
        varying vec2 vUv;
        varying vec4 vTone;
        varying vec4 vShape;
        varying vec4 vAxis;
        varying vec4 vChannel;
        varying float vEdge;
        varying float vHalo;
        varying float vPad;

        /**
         * **板の縁が絵に出ないための余白。** ここから外側は必ず 0 へ落とす。
         * 0.86 は「余白の内側 14% を使って落とす」という意味で、
         * 落とし方が滑らかなので直線の段にはならない。
         */
        const float FRAME_START = 0.86;

        const float TAU = 6.28318530718;

        vec3 spectrum(float h) {
          vec3 phase = vec3(0.0, 2.0943951, 4.1887902);
          return clamp(0.5 + 0.5 * cos(TAU * h + phase), 0.0, 1.0);
        }

        float gradientAt(vec2 p, float form) {
          if (form < 0.5) return p.x * 0.5 + 0.5;
          if (form < 1.5) return clamp(length(p), 0.0, 1.0);
          if (form < 2.5) return p.y * 0.5 + 0.5;
          return atan(p.y, p.x) / TAU + 0.5;
        }

        /** **縁の柔らかさ。** Blur 軸が 0 なら鋭く、1 なら広くにじむ。 */
        float softEdge(float d, float width) {
          float w = mix(0.008, 0.16, clamp(vEdge, 0.0, 1.0)) + width;
          return 1.0 - smoothstep(-w, w, d);
        }

        /** 要素ごとの形。**分岐は種別だけで、軸は係数として入っている。** */
        float baseMask(vec2 p) {
          float kind = vTone.z;
          float halo = mix(0.04, 0.4, clamp(vEdge, 0.0, 1.0));

          // ---- 扇 ----
          if (kind > 4.5) {
            float r = length(p);
            if (r < 1e-4) return 0.0;
            float delta = atan(p.y, p.x) - vShape.x;
            delta = atan(sin(delta), cos(delta));
            float sector = exp(-pow(delta / max(vShape.y, 1e-3), 4.0));
            if (sector <= 0.002) return 0.0;
            float blades = pow(abs(cos(delta * vShape.z)), mix(15.0, 5.0, vEdge));
            float radial = smoothstep(0.05, 0.3, r) * exp(-pow(r / max(vShape.w, 1e-3), 2.0));
            return sector * blades * radial;
          }

          // ---- 破片 ----
          if (kind > 3.5) {
            float family = vShape.y;
            vec2 q = vec2(p.x / max(vShape.z, 0.15), p.y * max(vShape.z, 0.15));
            float d;
            if (family < 0.5) {
              d = max(max(dot(q, vec2(0.0, -1.0)), dot(q, vec2(0.8660254, 0.5))),
                      dot(q, vec2(-0.8660254, 0.5))) - 0.55;
            } else if (family < 1.5) {
              d = max(abs(q.x) - 0.72, abs(q.y) - 0.34);
            } else if (family < 2.5) {
              d = max(max(dot(q, vec2(0.9487, 0.3162)), dot(q, vec2(-0.8575, 0.5145))),
                      dot(q, vec2(0.0, -0.95))) - 0.5;
            } else {
              d = max(max(dot(q, vec2(0.0, -1.0)), dot(q, vec2(0.8660254, 0.5))),
                      dot(q, vec2(-0.8660254, 0.5))) - 0.55 + vShape.w;
            }
            return softEdge(d, vShape.x * 0.1);
          }

          // ---- 靄 ----
          if (kind > 2.5) {
            float r = length(p);
            float body = exp(-vShape.x * r * r);
            float window = 1.0 - smoothstep(vShape.y, vShape.z, r);
            return window * body;
          }

          // ---- 膜 ----
          if (kind > 1.5) {
            float folds = 0.5 + 0.5 * sin(p.x * vShape.y + p.y * vShape.w * 2.0);
            float band = 1.0 - smoothstep(vShape.z * 0.6, vShape.z * 1.6 + halo, abs(p.y));
            float ends = 1.0 - smoothstep(0.72, 1.0, abs(p.x));
            return band * ends * mix(0.55, 1.0, folds);
          }

          // ---- 光条 ----
          if (kind > 0.5) {
            float core = 1.0 - smoothstep(vShape.x * 0.4, vShape.x + halo, abs(p.y));
            float glow = exp(-abs(p.y) / max(vShape.y + halo, 1e-3)) * 0.5;
            float along = 1.0 - smoothstep(vShape.z, vShape.w, abs(p.x));
            return (core + glow) * along;
          }

          // ---- 核 ----
          float r = length(p);
          float centre = exp(-r * r * mix(26.0, 10.0, vEdge)) * vShape.w;
          float flareH = exp(-abs(p.y) * mix(30.0, 12.0, vEdge)) *
                         (1.0 - smoothstep(0.2, 1.0, abs(p.x))) * vShape.y;
          float flareV = exp(-abs(p.x) * mix(30.0, 12.0, vEdge)) *
                         (1.0 - smoothstep(0.2, 1.0, abs(p.y))) * vShape.z;
          float wide = exp(-r * mix(7.0, 3.0, vEdge)) * 0.35;
          return centre + flareH + flareV + wide;
        }

        /**
         * **Blur 軸の 1 本が縁とハロを同時に動かす。**
         * ハロ量は 0 でぴったり 0 なので、シャープ側では散乱が 1 画素も足されない。
         */
        float elementMask(vec2 p) {
          float base = baseMask(p);
          if (vHalo <= 0.0) return base;
          return base + vHalo * exp(-dot(p, p) * mix(6.0, 1.6, clamp(vEdge, 0.0, 1.0)));
        }

        void main() {
          // **板の座標**（−1〜1。縁がどこかを知っているのはこれだけ）。
          vec2 q = vUv * 2.0 - 1.0;
          // **要素の座標**。板を余白ぶん広げてあるので、要素はその内側に収まる。
          vec2 p = q * vPad;
          /**
           * **四角い枠を出さないガード。**
           * どの種別・どの軸設定でも、板の縁より内側で必ず 0 になる。
           * 円形の裾（ハロ）を四角い板で切ると縁が直線に見えるので、
           * 切るのではなく**縁へ向かって滑らかに 0 へ寄せる**。
           */
          float frame = 1.0 - smoothstep(FRAME_START, 1.0, max(abs(q.x), abs(q.y)));
          if (frame <= 0.0) discard;
          // チャンネル分離。中心からの放射方向へ 3 チャンネルをずらす。
          vec2 dir = length(p) > 1e-4 ? normalize(p) : vec2(1.0, 0.0);
          float offsetAmount = max(uOffset * vChannel.x, vChannel.z);
          float decorrelation = max(uDecorrelation * vChannel.y, vChannel.w) * 0.05;
          vec2 shift = dir * offsetAmount;
          vec3 channels = max(vec3(
            elementMask(p + shift + vec2(decorrelation, 0.0)),
            elementMask(p),
            elementMask(p - shift - vec2(decorrelation, 0.0))
          ), 0.0) * frame;
          if (channels.r + channels.g + channels.b <= 0.0) discard;

          // 素材を薄く混ぜる（無ければ 1 のまま）。
          vec2 cell = fract(vUv);
          vec3 tex = texture2D(uAtlas, (cell + vec2(0.0)) / max(uGrid, vec2(1.0))).rgb;
          float material = 0.55 + 0.45 * dot(tex, vec3(0.333));

          // 色。層ごとの色相はリグが決めてある（要素ごと ⇄ 全体 1 色の混合済み）。
          float gradient = gradientAt(q, vTone.w);
          vec3 tint = spectrum(vTone.x + gradient * vTone.y);
          tint = mix(vec3(1.0), tint, uTint);

          // **チャンネルの偏り。** 最大は常に 1 なので、白の予算は動かない。
          vec3 colour = channels * uChannelGain * tint;
          colour *= uIntensity * vAxis.x * material;
          // **白の予算。** 核以外はここで頭を押さえる。
          colour = min(colour, vec3(vAxis.y));
          gl_FragColor = vec4(colour, 1.0);
        }
      `,
    });

    this.geometry = geometry;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  private writeLayers(): void {
    const count = Math.min(this.layers.length, LIMITS.maximumLayers);
    for (let index = 0; index < count; index++) {
      const layer = this.layers[index]!;
      this.offsets[index * 3 + 0] = layer.position[0];
      this.offsets[index * 3 + 1] = layer.position[1];
      this.offsets[index * 3 + 2] = layer.position[2];
      // 板は余白ぶん広げる（要素の大きさはシェーダー側で割り直すので変わらない）。
      this.sizes[index * 4 + 0] = layer.half[0] * 2 * layer.pad;
      this.sizes[index * 4 + 1] = layer.half[1] * 2 * layer.pad;
      this.sizes[index * 4 + 2] = layer.edge;
      this.sizes[index * 4 + 3] = layer.halo;
      this.spins[index * 3 + 0] = layer.spin;
      this.spins[index * 3 + 1] = layer.tiltX;
      this.spins[index * 3 + 2] = layer.tiltY;
      this.tones[index * 4 + 0] = layer.hue;
      this.tones[index * 4 + 1] = layer.hueSpan;
      this.tones[index * 4 + 2] = UNIFIED_KIND_INDEX[layer.kind];
      this.tones[index * 4 + 3] = layer.gradientForm;
      this.shapes[index * 4 + 0] = layer.shape[0];
      this.shapes[index * 4 + 1] = layer.shape[1];
      this.shapes[index * 4 + 2] = layer.shape[2];
      this.shapes[index * 4 + 3] = layer.shape[3];
      this.axesAttr[index * 4 + 0] = layer.intensity;
      this.axesAttr[index * 4 + 1] = layer.ceiling;
      this.axesAttr[index * 4 + 2] = layer.pad;
      this.axesAttr[index * 4 + 3] = layer.character;
      this.channels[index * 4 + 0] = layer.channel[0];
      this.channels[index * 4 + 1] = layer.channel[1];
      this.channels[index * 4 + 2] = layer.channel[2];
      this.channels[index * 4 + 3] = layer.channel[3];
    }
    if (this.geometry) this.geometry.instanceCount = count;
    for (const attribute of Object.values(this.attributes)) attribute.needsUpdate = true;
  }

  // ---------------------------------------------------------------- 毎フレーム

  update(elapsed: number): void {
    const delta =
      this.previousElapsed < 0 ? 0 : Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.25);
    const engine = this.context?.audioEngine;
    const audio = engine?.getParameters() ?? {};
    const spectrum = engine?.getSpectrum?.() ?? null;
    this.shelf?.update(delta);
    for (const decl of UNIFIED_LOOK_PARAMS) this.lookResolver.updateParam(decl.id, delta);
    this.audioDrive.update(audio, spectrum, elapsed, delta);
    this.previousElapsed = elapsed;
    this.advanceDrive(elapsed, delta);
    this.rebuild();

    const material = this.material;
    if (material) {
      const look = this.effectiveAxes();
      material.uniforms.uIntensity!.value = 0.6 + look.intensity * 2.4;
      material.uniforms.uOffset!.value = 0.01 + look.dispersion * 0.09;
      material.uniforms.uDecorrelation!.value = look.dispersion;
      const gain = channelBalanceGain(look.channelBalance);
      (material.uniforms.uChannelGain!.value as THREE.Vector3).set(gain[0], gain[1], gain[2]);
    }
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
    this.pipeline?.resize(width, height);
  }

  // ---------------------------------------------------------------- UI の面

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
    this.theme = theme;
  }

  usesTheme(): boolean {
    return false;
  }

  getZoom(): number {
    return this.zoom;
  }

  setZoom(zoom: number): void {
    this.zoom = clamp(zoom, 0.5, 2);
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
    if (this.camera) {
      this.camera.aspect = ratio;
      this.camera.updateProjectionMatrix();
    }
    this.rebuild();
  }

  setDebugView(view: number): void {
    void view;
  }

  getDebugState(): null {
    return null;
  }

  getDepth(): number {
    return this.axes.depthSpread;
  }

  setDepth(amount: number): void {
    this.axes.depthSpread = clamp(amount, 0, 1);
  }

  getPhase(): string {
    const levels = this.audioDrive.levels();
    return `Unified: field ${levels.skeleton.toFixed(2)} / core ${levels.corePulse.toFixed(2)} / H ${levels.huePhase.toFixed(2)} / layers ${this.layers.length}`;
  }

  /** 開発・検証用。 */
  getUnifiedState(): LightUnifiedState {
    return {
      layers: this.layers.length,
      whiteAllowedLayers: this.layers.filter((entry) => entry.whiteAllowed).length,
      axes: { ...this.axes },
      hue: this.drive.hue,
      kinds: this.layers.map((entry) => entry.kind),
    };
  }

  /** 棚（UI に出す代表 7 本）。 */
  private sourceList(): { id: string; label: string; kind: string }[] {
    return (this.shelf?.visible() ?? []).map((source) => ({
      id: source.id,
      label: source.label,
      kind: source.kind,
    }));
  }

  /**
   * **発光 All 1 行。** 選んだ音がリグ全体の発光を駆動する。
   * 下流の時間規律（場の時定数・打撃検出・扇の閾値・ストロボ・H の状態機械）は
   * 表現の側に残るので、繋ぎ替えても明滅の規律は壊れない。
   */
  private emissionParam(): ExpressionParam {
    const emission = this.audioDrive.emission();
    return {
      key: 'emission',
      label: '発光 All',
      type: 'binding' as const,
      min: 0,
      max: 1,
      step: 0.01,
      value: this.audioDrive.bindings().getBase('fieldDrive'),
      sourceId: emission.sourceId,
      depth: emission.depth,
      sources: this.sourceList(),
      transform: this.audioDrive.transformName('fieldDrive'),
      transformOptions: [
        { value: 'auto', label: 'Auto' },
        { value: 'none', label: 'None' },
        { value: 'gate', label: 'Gate' },
        { value: 'envelope-sharp', label: 'Envelope · Sharp' },
        { value: 'envelope-default', label: 'Envelope · Default' },
        { value: 'envelope-soft', label: 'Envelope · Soft' },
      ],
      liveValue: this.audioDrive.bindings().resolve('fieldDrive').value,
      liveSignal: this.audioDrive.bindings().resolve('fieldDrive').signal,
    };
  }

  /** 軸のスライダーに音のソースを添える（行は増やさない）。 */
  private axisRow(decl: (typeof AXIS_DECLS)[number]): ExpressionParam {
    const row = {
      key: decl.id,
      label: `${decl.label} (${decl.low} ⇄ ${decl.high})`,
      min: 0,
      max: 1,
      step: 0.01,
      value: this.axes[decl.id],
    };
    const isHue = decl.id === 'hueCoherence';
    if (!LOOK_KEYS.has(decl.id) && !isHue) return row;
    const hue = this.audioDrive.hueBinding();
    const binding = isHue ? null : this.lookResolver.getBinding(decl.id);
    return {
      ...row,
      bind: {
        paramId: decl.id,
        sourceId: isHue ? hue.sourceId : (binding?.sourceId ?? null),
        depth: isHue ? hue.depth : (binding?.depth ?? 1),
        sources: this.sourceList(),
        liveValue: isHue ? this.drive.hue : this.lookValue(decl.id),
      },
    };
  }

  getExpressionParams(): ExpressionParam[] {
    return [
      {
        key: 'preset',
        label: 'Preset (座標を代入)',
        type: 'select',
        options: [
          { value: 'keep', label: '— (現在の値)' },
          { value: 'spatial', label: 'Spatial 風' },
          { value: 'reactive', label: 'Reactive 風' },
          { value: 'optics', label: 'Lab2 風' },
          { value: 'default', label: '中間（既定）' },
        ],
        value: 'keep',
      },
      this.emissionParam(),
      ...AXIS_DECLS.map((decl) => this.axisRow(decl)),
    ];
  }

  setExpressionParam(key: string, value: number | string): void {
    // ---- 発光 All の結線 ----
    if (key.startsWith('emission')) {
      const what = key.split(':')[1];
      const current = this.audioDrive.emission();
      if (what === 'source') {
        const next = String(value);
        this.audioDrive.setEmission(next === 'none' ? null : next, current.depth);
        return;
      }
      if (what === 'depth') {
        const depth = Number(value);
        if (Number.isFinite(depth)) this.audioDrive.setEmission(current.sourceId, clamp(depth, -1, 1));
        return;
      }
      if (what === 'transform') {
        for (const paramId of ['fieldDrive', 'coreStrike', 'fanStrike']) {
          this.audioDrive.setTransform(paramId, String(value));
        }
        return;
      }
      const base = Number(value);
      if (!Number.isFinite(base)) return;
      for (const paramId of ['fieldDrive', 'coreStrike', 'fanStrike']) {
        this.audioDrive.bindings().setBase(paramId, base);
      }
      return;
    }
    // ---- 軸に添えたソース（`bind:<axis>:source|depth`）----
    if (key.startsWith('bind:')) {
      const [, paramId, what] = key.split(':');
      if (!paramId) return;
      const isHue = paramId === 'hueCoherence';
      const hue = this.audioDrive.hueBinding();
      const binding = isHue ? null : this.lookResolver.getBinding(paramId);
      if (what === 'source') {
        const next = String(value);
        const sourceId = next === 'none' ? null : next;
        if (isHue) {
          this.audioDrive.setHueSource(sourceId, hue.depth);
          return;
        }
        const decl = UNIFIED_LOOK_PARAMS.find((entry) => entry.id === paramId);
        const source = this.lookResolver.listSources().find((entry) => entry.id === sourceId);
        this.lookResolver.bind({
          paramId,
          sourceId,
          depth: binding?.depth ?? 1,
          transform: decl && source ? defaultTransformFor(source.kind, decl.kind) : null,
        });
        return;
      }
      if (what === 'depth') {
        const depth = Number(value);
        if (!Number.isFinite(depth)) return;
        if (isHue) {
          this.audioDrive.setHueSource(hue.sourceId, clamp(depth, -1, 1));
          return;
        }
        this.lookResolver.bind({
          paramId,
          sourceId: binding?.sourceId ?? null,
          depth: clamp(depth, -1, 1),
          transform: binding?.transform ?? null,
        });
      }
      return;
    }
    if (key === 'preset') {
      const name = String(value);
      if (name === 'keep') return;
      const preset = name === 'default' ? DEFAULT_AXES : AXIS_PRESETS[name];
      if (!preset) return;
      // **スライダー値を一括代入するだけ。** 表現を切り替えるのではない。
      for (const decl of AXIS_DECLS) {
        const next = preset[decl.id];
        if (typeof next === 'number') this.axes[decl.id] = clamp(next, 0, 1);
        if (LOOK_KEYS.has(decl.id)) this.lookResolver.setBase(decl.id, this.axes[decl.id]);
      }
      this.audioDrive.setStrobe(true, tickRateOf(this.axes));
      this.audioDrive.setTraceAmount(this.axes.trace);
      this.applyStickiness();
      this.applyDensity();
      this.rebuild();
      return;
    }
    const decl = AXIS_DECLS.find((entry) => entry.id === key);
    if (!decl) return;
    const next = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(next)) return;
    this.axes[decl.id] = clamp(next, 0, 1);
    if (LOOK_KEYS.has(decl.id)) this.lookResolver.setBase(decl.id, this.axes[decl.id]);
    if (decl.id === 'tickRate') this.audioDrive.setStrobe(true, tickRateOf(this.axes));
    if (decl.id === 'trace') this.audioDrive.setTraceAmount(this.axes.trace);
    if (decl.id === 'hueStickiness') this.applyStickiness();
    if (decl.id === 'density') this.applyDensity();
    this.rebuild();
  }

  dispose(): void {
    this.disposed = true;
    this.pipeline?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.placeholder?.dispose();
    this.atlas?.texture.dispose();
    if (this.mesh && this.scene) this.scene.remove(this.mesh);
    this.layers = [];
    this.fragmentShapes.clear();
    this.pipeline = null;
    this.geometry = null;
    this.material = null;
    this.placeholder = null;
    this.atlas = null;
    this.mesh = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
    this.shelf = null;
  }
}
