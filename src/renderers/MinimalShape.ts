import type { AudioParameters } from '../audio/AudioEngine';
import type { FieldUniforms } from '../engine/Field';
import type { FieldRenderer } from '../engine/FieldRenderer';

/**
 * ミニマルな図形。場のゼロ交差（節線）に砂が積もった様子を描く。
 *
 * 場の傾きで距離を正規化するため、どこでも線幅が一定になる。
 * これにより CPU でジオメトリを作らずに細く均一な線が引ける。
 *
 * 砂は「撒く」のではなく高さのある堆積として扱う。高さ場から法線を作り
 * 斜めからの光で陰影をつけるため、カメラを動かさずに立体として見える。
 * 粒は 1 画素以下まで細かく、粒ごとに明るさがばらつき、一部が強く光る。
 *
 * 音との対応（DESIGN.md「4. 音 → パラメータの写像」）:
 *   L1  音量 → 堆積の幅。大きな音ほど砂が太く溜まる
 *       持続 → 濃さ。鳴り続けるほど濃くなり、止むと褪せる
 *       高域 → 粒の細かさと輝き
 */

/** フレームレートに依存しない指数追従。 */
function approach(current: number, target: number, rate: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * delta));
}

export class MinimalShape implements FieldRenderer {
  readonly name = 'Minimal shape';

  readonly uniforms: FieldUniforms = {
    uLineWidth: { value: 1.2 },
    uThreshold: { value: 0 },
    uInk: { value: 0.85 },
    uGrainSize: { value: 0.8 },
    uRelief: { value: 26 },
    uSheen: { value: 1.6 },
  };

  readonly glsl = /* glsl */ `
    uniform float uLineWidth;
    uniform float uThreshold;
    uniform float uInk;
    uniform float uGrainSize;
    uniform float uRelief;
    uniform float uSheen;

    float sandHash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    vec3 render(vec2 p) {
      float v = field(p) - uThreshold;

      // 場の勾配で割ることでゼロ集合までの近似距離になる。
      // 勾配が消える点で発散しないよう下限を設ける。
      vec2 gradient = vec2(dFdx(v), dFdy(v));
      float distance = abs(v) / max(length(gradient), 1e-5);

      // 奥の層ほど堆積が広がって滲む（焦点が外れる）。
      float width = max(uLineWidth, 0.01) * (1.0 + gDepth * 2.2);

      // 砂山の高さ。節線で最も高く、裾を引いて外へ落ちる。
      float ridge = exp(-distance / max(width, 0.35));
      float skirt = exp(-distance / max(width * 6.0, 1.5)) * 0.28;
      float height = clamp(ridge + skirt, 0.0, 1.0);

      // 高さ場から法線を作り、斜めからの光で陰影をつける。
      // これがカメラを固定したまま立体に見せている部分。
      float relief = uRelief * (1.0 - gDepth * 0.45);
      vec3 normal = normalize(vec3(-dFdx(height) * relief, -dFdy(height) * relief, 1.0));
      vec3 lightDir = normalize(vec3(-0.42, 0.55, 0.72));
      float diffuse = max(dot(normal, lightDir), 0.0);
      float specular = pow(max(dot(reflect(-lightDir, normal), vec3(0.0, 0.0, 1.0)), 0.0), 30.0);

      // 粒。セルを 1 画素以下まで小さくして細かい砂にする。
      // 板は振動しているので、粒はゆっくり入れ替わる。
      vec2 cell = floor(gl_FragCoord.xy / max(uGrainSize, 0.35));
      float shuffle = floor(uTime * 2.0) * 0.37;
      float g1 = sandHash(cell + shuffle);
      float g2 = sandHash(cell * 1.93 + shuffle + 11.7);

      // 高いところほど粒が密に載る。
      float coverage = smoothstep(0.015, 0.8, height);
      float sand = step(1.0 - coverage, g1);

      // 粒ごとの明るさのばらつきと、一部の粒が強く光る反射。
      float facet = 0.5 + 0.5 * g2;
      float sparkle = step(0.94, g2) * specular * uSheen;

      float lit = 0.16 + diffuse * 0.98;
      float grains = sand * facet * lit + sparkle;

      // 粒だけだと芯が痩せるため、堆積そのものの陰影を下に敷く。
      float bed = ridge * ridge * 0.24 * lit;

      float focus = 1.0 - gDepth * 0.35;
      return vec3(clamp((grains + bed) * clamp(uInk, 0.0, 1.0) * focus, 0.0, 1.0));
    }
  `;

  private previousElapsed = 0;

  update(audio: AudioParameters, elapsed: number): void {
    const delta = Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.1);
    this.previousElapsed = elapsed;

    // L1: 音量が線の太さを決める。無音に近いほど糸のように細くなる。
    const volume = Math.min(Math.max(audio.volume ?? 0, 0), 1);
    this.uniforms.uLineWidth!.value = approach(
      this.uniforms.uLineWidth!.value as number,
      0.5 + volume * 2.6,
      7,
      delta,
    );

    // 持続: 鳴り続けるほど濃く、止むと褪せる。
    const sustain = Math.min(Math.max(audio.sustain ?? 0, 0), 1);
    this.uniforms.uInk!.value = approach(
      this.uniforms.uInk!.value as number,
      0.45 + sustain * 0.55,
      3,
      delta,
    );

    // 高域: 明るい音ほど粒が細かくなり、反射が強くなる。
    const treble = Math.min(Math.max(audio.treble ?? 0, 0), 1);
    this.uniforms.uGrainSize!.value = approach(
      this.uniforms.uGrainSize!.value as number,
      1.0 - treble * 0.45,
      4,
      delta,
    );
    this.uniforms.uSheen!.value = approach(
      this.uniforms.uSheen!.value as number,
      1.1 + treble * 1.6,
      4,
      delta,
    );

    // 起伏の強さは音量に従う。静かなときは平坦に、大きな音で立ち上がる。
    this.uniforms.uRelief!.value = approach(
      this.uniforms.uRelief!.value as number,
      16 + volume * 26,
      5,
      delta,
    );
  }

  dispose(): void {
    // 保持している GPU リソースはない。
  }
}
