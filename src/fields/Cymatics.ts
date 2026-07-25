import * as THREE from 'three';
import type { AudioParameters, SpectrumFrame } from '../audio/AudioEngine';
import type { Field, FieldUniforms } from '../engine/Field';
import {
  ModeExciter,
  PLATE_MODES,
  type ModeExciterState,
  type PlateMode,
} from '../engine/modeBank';
import { TUNING } from '../engine/tuning';

/**
 * サイマティクス — 固有振動モードの振動場。
 *
 * 入力音のスペクトルが金属板の複数の固有モードを励起し、最も強く共振する
 * モードが節線の構造を決める（modeBank.ts）。音量は模様の種類を決めない。
 *
 * 振動場は 3 つのスロットの合成:
 *   A = 移行元モード、B = 主モード（uBlend で A→B）、S = 副モード（限定混合）
 * 画面に見えるのはこの場に反応して移動する粒子だけで、
 * 補間された線そのものは描かれない（CymaticsPlate）。
 *
 * 共振域の外では場の利得が下がり（uFieldGain）、模様は弱く不安定になる。
 * 周波数スイープでは共振域ごとに特定のモードが強く現れる。
 */

/** フレームレートに依存しない指数追従。 */
function approach(current: number, target: number, rate: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * delta));
}

/** シードから決定値を引く。乱数源は音だけ（Math.random() は使わない）。 */
function derive(seed: number, index: number): number {
  const value = Math.sin(seed * 127.1 + index * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function packMode(target: THREE.Vector4, mode: PlateMode): void {
  target.set(mode.variant, mode.n, mode.m, mode.extra);
}

export class Cymatics implements Field {
  readonly name = 'Cymatics';

  readonly uniforms: FieldUniforms = {
    uModeA: { value: new THREE.Vector4() },
    uModeB: { value: new THREE.Vector4() },
    uModeS: { value: new THREE.Vector4() },
    uAsymA: { value: 0 },
    uAsymB: { value: 0 },
    uAsymS: { value: 0 },
    uBlend: { value: 1 },
    uSecW: { value: 0 },
    uFieldGain: { value: 1 },
    uScale: { value: TUNING.scaleBase },
    uWarp: { value: 0 },
    uBreak: { value: 0 },
    uRotate: { value: 0 },
  };

  readonly glsl = /* glsl */ `
    uniform vec4 uModeA;
    uniform vec4 uModeB;
    uniform vec4 uModeS;
    uniform float uAsymA;
    uniform float uAsymB;
    uniform float uAsymS;
    uniform float uBlend;
    uniform float uSecW;
    uniform float uFieldGain;
    uniform float uScale;
    uniform float uWarp;
    uniform float uBreak;
    uniform float uRotate;

    // 1 つの固有モードの振動形。variant がトポロジーの族を選ぶ。
    //   0=格子 1=X 2=菱形 3=円環(楕円) 4=花弁 5=中央と外周で異なる混成
    // すべて画面中心に対して対称な族だけを使う。
    float modeShape(vec2 q, vec4 def, float asym) {
      float n = def.y;
      float m = def.z;
      vec2 s = q * 0.5 + 0.5;
      float value;
      if (def.x < 0.5) {
        value = sin(n * PI * s.x) * sin(m * PI * s.y);
      } else if (def.x < 1.5) {
        value = (cos(n * PI * q.x) * cos(m * PI * q.y)
               - cos(m * PI * q.x) * cos(n * PI * q.y)) * 0.6;
      } else if (def.x < 2.5) {
        value = (cos(n * PI * q.x) * cos(m * PI * q.y)
               + cos(m * PI * q.x) * cos(n * PI * q.y)) * 0.6;
      } else if (def.x < 3.5) {
        float r = length(q * vec2(1.0, max(def.w, 1.0)));
        value = cos(n * PI * r) * (1.0 - 0.18 * r);
      } else if (def.x < 4.5) {
        float r = length(q);
        float theta = atan(q.y, q.x);
        value = cos(n * theta) * sin(m * PI * r);
      } else {
        float r = length(q);
        float rings = cos(n * PI * r);
        float grid = sin(m * PI * s.x) * sin(m * PI * s.y);
        value = mix(rings, grid, smoothstep(0.32, 0.72, r));
      }
      // 励振点の偏りを近似する、わずかな非対称項。
      value += asym * sin((n + 2.0) * PI * s.x) * sin((m + 1.0) * PI * s.y);
      return value;
    }

    float field(vec2 p) {
      // L3: 音の出来事が向きを決める（90° 単位なので対称性は保たれる）。
      float sr = sin(uRotate);
      float cr = cos(uRotate);
      vec2 q = mat2(cr, -sr, sr, cr) * p;
      q *= uScale;
      gFieldCoord = q;

      // 低域が場をわずかに押し曲げ、ノイズ的な音が節線を崩す。
      q += vec2(
        sin(q.y * 2.6 + uTime * 0.7),
        cos(q.x * 2.2 - uTime * 0.6)
      ) * uWarp;
      q += vec2(
        sin(q.x * 9.1 + q.y * 4.7 + uTime * 1.3),
        cos(q.x * 5.3 - q.y * 8.9 - uTime * 1.1)
      ) * uBreak;

      // 移行元 → 主モードの補間 + 副モードの限定混合。
      float from = modeShape(q, uModeA, uAsymA);
      float to = modeShape(q, uModeB, uAsymB);
      float value = mix(from, to, smoothstep(0.0, 1.0, uBlend));
      value += modeShape(q, uModeS, uAsymS) * uSecW;

      // 共振の強さ。共振域の間では場が弱まり、模様は不安定になる。
      return value * uFieldGain;
    }
  `;

  private readonly exciter = new ModeExciter();
  private spectrumSource: (() => SpectrumFrame | null) | null = null;
  private previousElapsed = -1;
  private appliedSeed = -1;
  private lastSeedTime = -Infinity;
  private targetRotate = 0;

  setSpectrumSource(source: () => SpectrumFrame | null): void {
    this.spectrumSource = source;
  }

  getExciterState(): ModeExciterState {
    return this.exciter.getState();
  }

  update(audio: AudioParameters, elapsed: number): void {
    const delta =
      this.previousElapsed < 0
        ? 0
        : Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.1);
    this.previousElapsed = elapsed;

    // スペクトルによるモード励起（Phase 1 の核）。
    this.exciter.update(this.spectrumSource?.() ?? null, audio, elapsed, delta);
    const state = this.exciter.getState();

    packMode(this.uniforms.uModeA!.value as THREE.Vector4, state.previous);
    packMode(this.uniforms.uModeB!.value as THREE.Vector4, state.primary);
    packMode(this.uniforms.uModeS!.value as THREE.Vector4, state.secondary);
    this.uniforms.uAsymA!.value = state.previous.asym;
    this.uniforms.uAsymB!.value = state.primary.asym;
    this.uniforms.uAsymS!.value = state.secondary.asym;
    this.uniforms.uBlend!.value = state.blend;
    this.uniforms.uSecW!.value = state.secondaryWeight;
    this.uniforms.uFieldGain!.value =
      TUNING.fieldFloor + (1 - TUNING.fieldFloor) * state.excitation;

    // L3: 音の出来事が向きを引き直す。90° 単位なので対称性は壊れない。
    const seed = audio.seed ?? 0;
    if (seed !== this.appliedSeed && elapsed - this.lastSeedTime >= TUNING.seedCooldown) {
      this.appliedSeed = seed;
      this.lastSeedTime = elapsed;
      this.targetRotate = Math.floor(derive(seed, 1) * 4) * (Math.PI / 2);
    }
    this.uniforms.uRotate!.value = approach(
      this.uniforms.uRotate!.value as number,
      this.targetRotate,
      0.9,
      delta,
    );

    // 場の粗さは焼き込み定数。音量や明るさで連続ズームさせない
    // （音量だけで揺れて見える原因になるため）。
    this.uniforms.uScale!.value = TUNING.scaleBase;
    this.uniforms.uWarp!.value = approach(
      this.uniforms.uWarp!.value as number,
      Math.min(Math.max(audio.bass ?? 0, 0), 1) * TUNING.warpAmount,
      8,
      delta,
    );
    this.uniforms.uBreak!.value = approach(
      this.uniforms.uBreak!.value as number,
      Math.min(Math.max(audio.flatness ?? 0, 0), 1) * TUNING.breakAmount,
      5,
      delta,
    );
  }

  dispose(): void {
    // 保持している GPU リソースはない。uniform は Material 側で破棄される。
  }
}

export { PLATE_MODES };
