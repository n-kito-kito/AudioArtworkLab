import * as THREE from 'three';
import type { AudioParameters } from '../audio/AudioEngine';
import { PLATE_MODES_V2 } from '../engine/modeBankV2';
import { TUNING } from '../engine/tuning';
import { Cymatics } from './Cymatics';

/**
 * サイマティクス V2 — 自由端の正方形板の固有モード。
 *
 * V1 と同じ砂の物理・励起選択（ModeExciter）の上で、振動場だけを差し替える。
 * V1 の状態とは一切共有しない（インスタンスも uniform も別）。
 *
 * V1 との違い:
 *   - モード形は Waller の実用近似（2 つの梁モードの結合）。節線が直線でなく
 *     曲がり、実機のクラドニ図形と同じ族になる。結合の符号が対称性の族を決める。
 *   - 定義域を板全体に一致させる（scaleBaseV2 = 1）。cos は板の縁で微分ゼロに
 *     なり、自由端の境界条件を近似する。節線が縁までつながる。
 *   - 中央の支持点は固定端として必ず節になる（実機の写真で砂が中央に溜まる理由）。
 *   - 板の個体差: ごく小さな材料異方性と励振点のオフセットを固定値で持つ。
 *     模様は一見対称だが完全ではなくなる。毎フレーム変化はしない。
 */
export class CymaticsV2 extends Cymatics {
  override readonly name: string = 'Cymatics V2';

  override readonly glsl: string = /* glsl */ `
    uniform vec4 uModeB;
    uniform vec4 uModeS;
    uniform float uAsymB;
    uniform float uAsymS;
    uniform float uSecW;
    uniform float uFieldGain;
    uniform float uScale;
    uniform float uWarp;
    uniform float uBreak;
    uniform float uRotB;
    uniform vec2 uPlate;
    uniform float uAniso;
    uniform vec2 uExciteOff;

    // 1 つの固有モードの振動形（modeBankV2.ts の variant と対応）。
    float modeShapeV2(vec2 q, vec4 def, float asym) {
      float n = def.y;
      float m = def.z;
      float value;
      if (def.x < 0.5) {
        // 自由端の正方形板の実用近似（Waller）: 2 つの梁モードの結合。
        // def.w = ±1 が結合の符号で、対称性の族を決める。
        float a = cos(n * PI * q.x) * cos(m * PI * q.y);
        float b = cos(m * PI * q.x) * cos(n * PI * q.y);
        value = (a + def.w * b) * 0.62;
      } else if (def.x < 1.5) {
        // 中央励振の同心円モード。正方形の板では外周がわずかに角張る。
        float r = mix(length(q), max(abs(q.x), abs(q.y)) * 1.2, 0.22);
        value = cos(n * PI * r) * (1.0 - 0.16 * r);
      } else {
        // 縮退した梁モード: 波打つほぼ平行な縞。90° 回転の相方が
        // 同じ共振域に存在し得る（実機で同じ Hz に別の模様が出る現象）。
        value = (cos(n * PI * q.x) + def.w * cos(m * PI * q.y)) * 0.7;
      }
      // 励振の偏りの近似。決定論的で小さく、形の対称性は壊さない。
      value += asym * cos((n + 1.0) * PI * q.x) * cos((m + 2.0) * PI * q.y);
      return value;
    }

    vec2 rotate2(vec2 v, float a) {
      float s = sin(a);
      float c = cos(a);
      return mat2(c, -s, s, c) * v;
    }

    float field(vec2 p) {
      // 長方形の板: uv を物理座標へ（D26）。節線間隔の等方性（図形を伸縮させない）を
      // 優先する。縁と節の厳密な境界一致は、正方形でも scaleBaseV2 の焼き込みで
      // 既に崩してあるため、ここでも同じ扱いとする。
      vec2 q = p * uPlate * uScale;
      gFieldCoord = q;

      // 材料のごく小さな異方性（x と y の剛性差）。板の個体差として固定し、
      // フレームごとには変化しない。
      q *= vec2(1.0 + uAniso, 1.0 - uAniso);

      // 低域のうねりとノイズによる崩れ（V1 と同じ・既定はごく小さい）。
      q += vec2(
        sin(q.y * 2.6 + uTime * 0.7),
        cos(q.x * 2.2 - uTime * 0.6)
      ) * uWarp;
      q += vec2(
        sin(q.x * 9.1 + q.y * 4.7 + uTime * 1.3),
        cos(q.x * 5.3 - q.y * 8.9 - uTime * 1.1)
      ) * uBreak;

      // 向きはモードごとに固定（90° 単位）。正方形の板は 90° 回転で
      // 自分に重なるため、定義域は崩れない。表示中の図形は回転しない。
      vec2 qB = rotate2(q, uRotB);

      // 励振点の中心からの微小オフセット。節線の位置をわずかにずらす。
      vec2 qE = qB + uExciteOff;

      float value = modeShapeV2(qE, uModeB, uAsymB);
      value += modeShapeV2(qE, uModeS, uAsymS) * uSecW;

      // 中央の支持点は固定端: 振幅は必ずゼロになり、砂が溜まる
      // （参考画像すべてで中央のマウント周りに砂が残るのと同じ）。
      value *= smoothstep(0.02, 0.13, length(qB));

      return value * uFieldGain;
    }
  `;

  constructor() {
    super(PLATE_MODES_V2);
    this.uniforms.uAniso = { value: TUNING.anisotropyV2 };
    this.uniforms.uExciteOff = { value: new THREE.Vector2() };
  }

  /** V2 は板全体を定義域にする（縁 = 自由端）。 */
  protected override scaleBase(): number {
    return TUNING.scaleBaseV2;
  }

  /**
   * モードが切り替わった瞬間だけ立つ跳ね上げ。
   *
   * 駆動周波数が変われば板は過渡的に大きく鳴り、節に溜まっていた砂まで
   * 跳ね上げられる。切替の瞬間に 1、`releaseTime` をかけて 0 へ戻す。
   * 立ち上がりを瞬時にし、戻りを S 字にすることで「バッと散って、
   * すっと集まり直す」動きになる。
   */
  protected override computeRelease(): number {
    // 長さ 0 は「跳ね上げない」。切替フレームだけ 1 が立つのを防ぐ。
    const span = TUNING.releaseTime;
    if (span <= 0) return 0;
    const since = this.sinceModeSwitch;
    if (!Number.isFinite(since) || since >= span) return 0;
    const x = 1 - since / span;
    return x * x * (3 - 2 * x);
  }

  override update(audio: AudioParameters, elapsed: number): void {
    super.update(audio, elapsed);
    this.uniforms.uAniso!.value = TUNING.anisotropyV2;
    // 方向は固定（板の個体差）。大きさだけをチューニングで変えられる。
    (this.uniforms.uExciteOff!.value as THREE.Vector2)
      .set(0.7, -0.55)
      .multiplyScalar(TUNING.exciteOffsetV2);
  }
}
