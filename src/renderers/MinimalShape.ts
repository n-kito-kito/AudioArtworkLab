import type { AudioParameters } from '../audio/AudioEngine';
import type { FieldUniforms } from '../engine/Field';
import type { FieldRenderer } from '../engine/FieldRenderer';

/**
 * ミニマルな図形。境界を「線」ではなく「粒子の密度」で描く。
 *
 * 美しさは模様ではなく境界に宿る、という観察に沿った実装。
 * 場のゼロ交差までの符号付き距離（SDF）を求め、それをノイズで歪めてから
 * 密度分布に変換する。粒子はその密度を確率として撒かれるため、
 * 輪郭は一本線ではなく、密度の高い帯として浮かび上がる。
 *
 *   一本線     ────────        ではなく
 *   密度の帯   ░░░██████░░░    になる
 *
 * 守っている制約:
 *   - 画面の 9 割は黒。明るいのは 1 割程度
 *   - 境界はくっきりさせない。必ずぼそぼそ・ざらざらさせる
 *   - 粒子は完全停止しない。常に微細に揺れる
 *   - 強い発光や飛び散る粒子を作らない
 *
 * 音は形ではなく状態を変える（DESIGN.md「4. 音 → パラメータの写像」）:
 *   低域   → 境界が太くなる
 *   ビート → 粒子密度が上がる（一瞬だけ）
 *   高域   → 細かな模様が増える
 *   音量   → 全体が膨張する
 *   持続   → 濃さ
 */

/** フレームレートに依存しない指数追従。 */
function approach(current: number, target: number, rate: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * delta));
}

export class MinimalShape implements FieldRenderer {
  readonly name = 'Minimal shape';

  readonly uniforms: FieldUniforms = {
    uBand: { value: 1.6 },
    uEdgeNoise: { value: 0.85 },
    uDetail: { value: 4 },
    uDensity: { value: 0.8 },
    uSpread: { value: 1 },
    uGrainSize: { value: 0.8 },
    uInk: { value: 0.85 },
  };

  readonly glsl = /* glsl */ `
    uniform float uBand;
    uniform float uEdgeNoise;
    uniform float uDetail;
    uniform float uDensity;
    uniform float uSpread;
    uniform float uGrainSize;
    uniform float uInk;

    float shapeHash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(shapeHash(i), shapeHash(i + vec2(1.0, 0.0)), f.x),
        mix(shapeHash(i + vec2(0.0, 1.0)), shapeHash(i + vec2(1.0, 1.0)), f.x),
        f.y
      );
    }

    float fbm(vec2 p) {
      float sum = 0.0;
      float amplitude = 0.58;
      for (int i = 0; i < 3; i++) {
        sum += amplitude * valueNoise(p);
        p *= 2.07;
        amplitude *= 0.5;
      }
      return sum;
    }

    vec3 render(vec2 p) {
      float v = field(p);

      // 場の勾配で割ると、節線までの近似距離（画素単位）になる。
      vec2 gradient = vec2(dFdx(v), dFdy(v));
      float signedDistance = abs(v) / max(length(gradient), 1e-5);

      float band = max(uBand, 0.6) * (1.0 + gDepth * 2.0);

      // 境界をノイズで歪める。ここが要。
      // くっきりした縁をやめ、ぼそぼそと崩れた輪郭にする。
      float edge = fbm(p * uDetail + vec2(0.0, uTime * 0.025));
      float ragged = max(signedDistance + (edge - 0.5) * uEdgeNoise * band * 2.2, 0.0);

      // 密度分布。芯はほぼ埋まった帯にし、その外側をざらついた裾にする。
      //   ░░░██████░░░   芯が密、外周が粒
      float core = 1.0 - smoothstep(band * 0.3, band * 1.15, ragged);
      float fringe = exp(-max(ragged - band, 0.0) / (band * 2.4 * max(uSpread, 0.2))) * 0.5;
      float density = (core * 0.98 + fringe) * uDensity;

      // 帯に沿った密度のむら。均一な帯にせず、濃淡を作る。
      density *= 0.62 + 0.62 * fbm(p * uDetail * 2.3 + 17.0);
      density = clamp(density, 0.0, 1.0);

      // 粒子。常に微細に揺れ、完全には停止しない。
      vec2 cell = gl_FragCoord.xy / max(uGrainSize, 0.35);
      vec2 tremor = vec2(sin(uTime * 0.9), cos(uTime * 1.13)) * 0.4;
      float grain = shapeHash(floor(cell + tremor) + floor(uTime * 3.0) * 0.13);
      float shade = shapeHash(floor(cell) * 1.7 + 3.3);

      // 密度を確率として粒を撒く。粒ごとに明るさが違い、半透明に見える。
      float particle = step(1.0 - density, grain) * (0.28 + 0.72 * shade);

      // 粒だけだと遠目に消えるため、芯にごく淡い連続成分を敷く。
      float bed = core * core * 0.09;

      // 密度の起伏から弱い陰影をつける。発光ではなく、ざらつきの立体感。
      float relief = 14.0 * (1.0 - gDepth * 0.5);
      vec3 normal = normalize(vec3(-dFdx(core) * relief, -dFdy(core) * relief, 1.0));
      float lit = 0.58 + 0.42 * max(dot(normal, normalize(vec3(-0.4, 0.55, 0.73))), 0.0);

      float focus = 1.0 - gDepth * 0.3;
      return vec3(clamp((particle + bed) * lit * clamp(uInk, 0.0, 1.0) * focus, 0.0, 1.0));
    }
  `;

  private previousElapsed = 0;

  update(audio: AudioParameters, elapsed: number): void {
    const delta = Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.1);
    this.previousElapsed = elapsed;

    const clamp01 = (value: number | undefined): number =>
      Math.min(Math.max(value ?? 0, 0), 1);

    // 低域: 境界が太くなる。
    this.uniforms.uBand!.value = approach(
      this.uniforms.uBand!.value as number,
      0.7 + clamp01(audio.bass) * 1.5,
      5,
      delta,
    );

    // ビート: 粒子密度が一瞬だけ上がる。beat 自体が減衰するので追従は速くてよい。
    this.uniforms.uDensity!.value = approach(
      this.uniforms.uDensity!.value as number,
      0.88 + clamp01(audio.beat) * 0.12,
      12,
      delta,
    );

    // 高域: 細かな模様が増える。
    const treble = clamp01(audio.treble);
    this.uniforms.uDetail!.value = approach(
      this.uniforms.uDetail!.value as number,
      2.6 + treble * 7.5,
      3,
      delta,
    );
    this.uniforms.uGrainSize!.value = approach(
      this.uniforms.uGrainSize!.value as number,
      1.0 - treble * 0.45,
      4,
      delta,
    );

    // 音量: 全体が膨張する。
    this.uniforms.uSpread!.value = approach(
      this.uniforms.uSpread!.value as number,
      0.7 + clamp01(audio.volume) * 1.5,
      5,
      delta,
    );

    // 持続: 鳴り続けるほど濃く、止むと褪せる。
    this.uniforms.uInk!.value = approach(
      this.uniforms.uInk!.value as number,
      0.5 + clamp01(audio.sustain) * 0.5,
      3,
      delta,
    );
  }

  dispose(): void {
    // 保持している GPU リソースはない。
  }
}
