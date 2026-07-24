import type { AudioParameters } from '../audio/AudioEngine';
import type { Field, FieldUniforms } from '../engine/Field';

/**
 * サイマティクス（クラドニ図形）。
 *
 * 平板の定在波が作る節線。音がこの図形を決める（DESIGN.md「4. 音 → パラメータの写像」）。
 *
 *   L2 量子化  音程   → モード (n, m)。音程が変わると図形が別の形へ「移行」する
 *   L1 連続    明るさ → 場の細かさ
 *   L1 連続    低域   → 場の歪み
 *              ノイズ性 → 節線の崩れ
 *   L3 ハッシュ シード → 対称性の種類・向き・中心のずれ。音の出来事ごとに引き直される
 *
 * 移行はモード A とモード B の場を混ぜながら約 2 秒かける。共振周波数の間では
 * 複数モードが重なるという実際の板の挙動と一致し、砂が移動していくように見える。
 * 瞬時に差し替えない（2026-07-24 の調整記録を参照）。
 */

/**
 * 実際の平板と同じく、固有値 n² + m² の小さい順にモードを並べる。
 * 音程が上がるほど高次のモードになり、図形は複雑になる。
 *
 * n === m のときは場が恒等的に 0 になり画面が潰れるため、m < n に限る。
 */
const MODES: Array<readonly [number, number]> = [];
for (let n = 2; n <= 9; n++) {
  for (let m = 1; m < n; m++) MODES.push([n, m]);
}
MODES.sort((left, right) => left[0] ** 2 + left[1] ** 2 - (right[0] ** 2 + right[1] ** 2));

/** モード候補が確定するまでに音程が留まるべき秒数。音程の震えでの誤発火を防ぐ。 */
const MODE_HOLD = 0.25;
/** モード移行にかける秒数。砂が次の図形へ移動していく時間。 */
const MORPH_DURATION = 2.0;
/** 移行完了から次の移行を受け付けるまでの秒数。 */
const MODE_COOLDOWN = 0.8;
/** 構図（向き・中心・対称性）を引き直す最短間隔。オンセット毎に暴れないための沈静。 */
const SEED_COOLDOWN = 2.4;

/** フレームレートに依存しない指数追従。 */
function approach(current: number, target: number, rate: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * delta));
}

/**
 * 1 つのシードから複数の決定値を引き出す。決定論的で、同じシードなら同じ列になる。
 * 乱数源はシード（= 音）だけ。Math.random() は使わない。
 */
function derive(seed: number, index: number): number {
  const value = Math.sin(seed * 127.1 + index * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

export class Cymatics implements Field {
  readonly name = 'Cymatics';

  readonly uniforms: FieldUniforms = {
    uOrderN: { value: MODES[0]![0] },
    uOrderM: { value: MODES[0]![1] },
    uOrderN2: { value: MODES[0]![0] },
    uOrderM2: { value: MODES[0]![1] },
    uMorph: { value: 0 },
    uScale: { value: 0.9 },
    uWarp: { value: 0 },
    uBreak: { value: 0 },
    uRotate: { value: 0 },
    uVariant: { value: 0 },
    uOffsetX: { value: 0 },
    uOffsetY: { value: 0 },
    uSymmetry: { value: 1 },
  };

  readonly glsl = /* glsl */ `
    uniform float uOrderN;
    uniform float uOrderM;
    uniform float uOrderN2;
    uniform float uOrderM2;
    uniform float uMorph;
    uniform float uScale;
    uniform float uWarp;
    uniform float uBreak;
    uniform float uRotate;
    uniform float uVariant;
    uniform float uOffsetX;
    uniform float uOffsetY;
    uniform float uSymmetry;

    // 座標を折り返して対称性を作る。折り返し後の場は必ず左右・上下対称になる。
    //   0 = 鏡映（左右のみ）  1 = 4 回対称  2 = 8 回対称  3 = 放射対称
    vec2 foldSymmetry(vec2 q) {
      if (uSymmetry < 0.5) {
        return vec2(abs(q.x), q.y);
      }
      if (uSymmetry < 1.5) {
        return abs(q);
      }
      if (uSymmetry < 2.5) {
        q = abs(q);
        return q.y > q.x ? q.yx : q;
      }
      // 放射対称: 極座標で角度を 6 分割し、扇形を折り返す。
      float radius = length(q);
      float sector = 3.14159265 / 6.0;
      // 鏡映軸を x 軸に合わせる。π が扇の周期の整数倍なので y 軸にも対称になる。
      float angle = abs(mod(atan(q.y, q.x) + sector, sector * 2.0) - sector);
      return vec2(cos(angle), sin(angle)) * radius;
    }

    float chladni(vec2 q, float n, float m) {
      float a = cos(n * PI * q.x) * cos(m * PI * q.y);
      float b = cos(m * PI * q.x) * cos(n * PI * q.y);
      // 対称性の異なる 2 つのクラドニ形。シードがどちらの世界かを決める。
      return mix(a - b, a + b, uVariant);
    }

    float field(vec2 p) {
      // L3: 音の出来事が向きと中心を決める。
      float s = sin(uRotate);
      float c = cos(uRotate);
      // 折り返しを最初に行うことで、画面に対して厳密に対称になる。
      // 折り返し後の回転・ずらしは全ての鏡像に等しく効くため対称性を壊さない。
      vec2 q = foldSymmetry(p);
      q = mat2(c, -s, s, c) * q + vec2(uOffsetX, uOffsetY);
      gFieldCoord = q;
      q *= uScale;

      // 低域が場そのものを押し曲げる。
      q += vec2(
        sin(q.y * 2.6 + uTime * 0.7),
        cos(q.x * 2.2 - uTime * 0.6)
      ) * uWarp;

      // ノイズ的な音ほど節線を崩す。勾配が飛ばないよう滑らかな変位にする。
      q += vec2(
        sin(q.x * 9.1 + q.y * 4.7 + uTime * 1.3),
        cos(q.x * 5.3 - q.y * 8.9 - uTime * 1.1)
      ) * uBreak;

      // L2: 前のモードから次のモードへ、場を混ぜながら移行する。
      float from = chladni(q, uOrderN, uOrderM);
      float to = chladni(q, uOrderN2, uOrderM2);
      return mix(from, to, smoothstep(0.0, 1.0, uMorph));
    }
  `;

  private fromIndex = 0;
  private toIndex = 0;
  private morph = 0;
  private morphing = false;
  private lastMorphEnd = -Infinity;
  private pendingIndex = 0;
  private pendingSince = 0;
  private previousElapsed = 0;
  private appliedSeed = -1;
  private lastSeedTime = -Infinity;
  private targetRotate = 0;
  private targetVariant = 0;
  private targetOffsetX = 0;
  private targetOffsetY = 0;

  update(audio: AudioParameters, elapsed: number): void {
    const delta = Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.1);
    this.previousElapsed = elapsed;

    // L2: 音程をモード番号へ量子化する。候補が少し留まってから、移行を開始する。
    const pitch = Math.min(Math.max(audio.pitch ?? 0, 0), 1);
    const candidate = Math.round(pitch * (MODES.length - 1));
    if (candidate !== this.pendingIndex) {
      this.pendingIndex = candidate;
      this.pendingSince = elapsed;
    } else if (
      !this.morphing &&
      candidate !== this.toIndex &&
      elapsed - this.pendingSince >= MODE_HOLD &&
      elapsed - this.lastMorphEnd >= MODE_COOLDOWN
    ) {
      this.fromIndex = this.toIndex;
      this.toIndex = candidate;
      this.morph = 0;
      this.morphing = true;
    }

    if (this.morphing) {
      this.morph = Math.min(this.morph + delta / MORPH_DURATION, 1);
      if (this.morph >= 1) {
        this.morphing = false;
        this.fromIndex = this.toIndex;
        this.morph = 0;
        this.lastMorphEnd = elapsed;
      }
    }

    const from = MODES[this.fromIndex] ?? MODES[0]!;
    const to = MODES[this.toIndex] ?? MODES[0]!;
    this.uniforms.uOrderN!.value = from[0];
    this.uniforms.uOrderM!.value = from[1];
    this.uniforms.uOrderN2!.value = to[0];
    this.uniforms.uOrderM2!.value = to[1];
    this.uniforms.uMorph!.value = this.morphing ? this.morph : 0;

    // L3: 音の出来事が構図（対称性・向き・中心）を引き直す。
    // ただしクールダウンを設け、値へは数秒かけて滑らかに追従する。
    // 同じ音なら同じ構図に、違う音なら予測できない構図になる。
    const seed = audio.seed ?? 0;
    if (seed !== this.appliedSeed && elapsed - this.lastSeedTime >= SEED_COOLDOWN) {
      this.appliedSeed = seed;
      this.lastSeedTime = elapsed;
      this.targetVariant = derive(seed, 0) < 0.5 ? 0 : 1;
      this.targetRotate = Math.floor(derive(seed, 1) * 4) * (Math.PI / 4)
        + (derive(seed, 2) - 0.5) * 0.12;
      this.targetOffsetX = (derive(seed, 3) - 0.5) * 0.3;
      this.targetOffsetY = (derive(seed, 4) - 0.5) * 0.3;
      // 対称性の種類も音の出来事が決める。鏡映 / 4 回 / 8 回 / 放射。
      this.uniforms.uSymmetry!.value = Math.floor(derive(seed, 5) * 4);
    }
    this.uniforms.uRotate!.value = approach(
      this.uniforms.uRotate!.value as number, this.targetRotate, 0.9, delta,
    );
    this.uniforms.uVariant!.value = approach(
      this.uniforms.uVariant!.value as number, this.targetVariant, 0.7, delta,
    );
    this.uniforms.uOffsetX!.value = approach(
      this.uniforms.uOffsetX!.value as number, this.targetOffsetX, 0.9, delta,
    );
    this.uniforms.uOffsetY!.value = approach(
      this.uniforms.uOffsetY!.value as number, this.targetOffsetY, 0.9, delta,
    );

    // L1: 明るさが場の細かさ、低域が歪み、ノイズ性が崩れを決める。
    this.uniforms.uScale!.value = approach(
      this.uniforms.uScale!.value as number,
      0.7 + Math.min(Math.max(audio.centroid ?? 0, 0), 1) * 1.1,
      6,
      delta,
    );
    this.uniforms.uWarp!.value = approach(
      this.uniforms.uWarp!.value as number,
      Math.min(Math.max(audio.bass ?? 0, 0), 1) * 0.22,
      8,
      delta,
    );
    this.uniforms.uBreak!.value = approach(
      this.uniforms.uBreak!.value as number,
      Math.min(Math.max(audio.flatness ?? 0, 0), 1) * 0.12,
      5,
      delta,
    );
  }

  dispose(): void {
    // 保持している GPU リソースはない。uniform は Material 側で破棄される。
  }
}
