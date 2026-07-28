import * as THREE from 'three';
import type { AudioParameters } from '../audio/AudioEngine';
import type {
  CompositionContext,
  DesignLayerCanvases,
} from '../compositions/Composition';
import type { Effect } from '../effects/Effect';
import { EffectPipeline } from '../effects/EffectPipeline';
import { THEMES, type Theme } from '../engine/themes';
import type { ExpressionId } from './catalog';
import type { LabExpression } from './Expression';

/**
 * Modular Pattern Field — モジュール式のパターン場（試作）。
 *
 * オフホワイトの紙に黒い幾何学が置かれる。図形は円と角丸四角の 2 つだけで、
 * それらが「重なりの偶奇」と「格子への整列」という 2 つの規則の間を行き来する。
 *
 *   ① Spawn / Expand … 数個の円が育つ。重なった部分は偶奇（XOR）で背景色へ抜ける。
 *                       骨型・四つ葉の抜き形はこの偶奇からしか生まれない
 *   ② GridMorph      … 円がセル中心へ寄り、角丸半径が縮むことで角丸四角になる。
 *                       瞬間切替はしない（円 = 半径がモジュール半幅に等しい状態）
 *   ③ RowCascade     … 上の行から順に 90°回転・縮小・（シードにより）白黒反転が伝わる
 *   ④ Merge          … 隣接セルが触れ合い、rounded union で 1 つの連結形状になる
 *   ⑤ Subdivide      … セル内を 2×2 に分け、欠けを入れて段階的に小さく複雑にする
 *   ⑥ FinalCluster   … 4 セルで中央が抜ける花型・十字のクラスターが立つ
 *   ⑦ Clear          … セル単位でパッと消す。フェードしない。消え終わったら新シードで再開
 *
 * 音との対応（PRD §7 の解釈。表現ごとに定義する = D25）:
 *   volume（帯域ゲインで重み付け） → 拡大速度・黒面積の目標占有率
 *   bass     → モジュールの大きさの階層・Merge の結合半径
 *   mid      → 隣接接続のしきい（どれだけ繋がりやすいか）
 *   treble / centroid → 細分化の進みやすさ・角丸量
 *   onset    → 行の進行・90°回転・フェーズ遷移（不応時間つき）
 *   flatness → 欠損と局所反転の量
 *   sustain  → 整列（モーフ）の進み
 *   seed     → 初期配置・反転ビット・欠損位置・消失順序
 *
 * 乱数は音のシードとセル番号からの決定論的ハッシュのみ。Math.random() は使わない
 * （PRD §3.1）。同じ音なら同じ像になり、違う音なら予測できない像になる。
 *
 * 質感の定数はこのファイルの MODULAR にまとめる。サイマティクスの TUNING とは
 * 混ぜない（表現ごとに持つものを宣言する = D25）。
 */

/** シェーダーの円配列の長さ。MODULAR.circleMax と必ず一致させること。 */
const CIRCLE_SLOTS = 8;

const MODULAR = {
  // ---- グリッド ----
  gridBase: 6, //            1:1 のときのマクログリッドの一辺のセル数
  gridMin: 4, //             セル数の下限（画角が極端でも粗くなりすぎない）
  gridMax: 12, //            同・上限

  // ---- Spawn / Expand ----
  circleMin: 4, //           撒く円の最小個数
  circleMax: CIRCLE_SLOTS, // 同・最大
  spawnStep: 0.18, //        円が 1 つ現れる間隔（秒）
  growSpeed: 0.5, //         円の半径が育つ速さ（セル単位/秒）
  growSpread: 0.8, //        円ごとの育つ速さのばらつき
  coverBase: 0.18, //        黒面積の目標占有率の下限
  coverDrive: 0.3, //        音量が目標占有率を押し上げる量
  expandMax: 8, //           Expand に留まる上限秒数

  // ---- GridMorph ----
  cellScale: 0.86, //        整列直後のモジュールの大きさ（セル幅比）
  alignBase: 0.32, //        整列の進む速さ（毎秒）
  alignSustain: 0.8, //      持続が整列を速める量
  sizeSpread: 0.45, //       低音が広げる「大きさの階層」の幅

  // ---- 角丸（セル単位。モジュール半幅より大きいと真円になる）----
  radiusOpen: 0.7, //        円でいる間の半径。どのモジュール半幅より大きく取る
  radiusBase: 0.09, //       角丸の基準
  radiusTreble: 0.15, //     高域・重心が角丸を増やす量
  radiusBass: 0.6, //        低音が結合半径を広げる割合（Merge）

  // ---- RowCascade ----
  cascadeRowSeconds: 0.55, // 1 行が進むのにかかる時間（オンセットで 1 行進む）
  cascadeColDelay: 0.035, //  行の中で列ごとにずらす秒数（ウェーブ）
  cascadeShrink: 0.84, //     1 行進むごとの縮小率
  cascadeInvert: 0.24, //     行が白黒反転する確率の基準

  // ---- Merge ----
  connectBase: 0.16, //      隣接接続のしきいの基準
  connectMid: 0.55, //       中域が接続しやすさを上げる量
  recruitStep: 0.24, //      新しいセルを呼び込む間隔（秒）
  mergeSeconds: 3.2, //      Merge に留まる秒数
  mergeMinSeconds: 1.2, //   オンセットで抜けられるようになるまでの秒数

  // ---- Subdivide ----
  subdivRounds: 2, //        細分化の反復回数
  subdivRate: 0.28, //       細分化が進む速さ（毎秒）
  subdivTreble: 0.75, //     高域・重心が細分化を速める量
  subdivChance: 0.5, //      1 回で分かれるセルの割合の基準
  subGap: 0.96, //           分かれた小セルの詰まり（1 で隙間なし＝十字・花型が連結する）
  subRadius: 0.5, //         細分化後に角丸半径を詰める割合。小セルが円へ潰れるのを防ぐ
  flatnessDrop: 2.4, //      ノイズ性が小セルを欠けさせる量

  // ---- FinalCluster ----
  flowerChance: 0.5, //      4 セルで中央が抜ける花型ができる割合
  finalMinSeconds: 2.2, //   オンセットで Clear へ行けるようになるまでの秒数
  finalMaxSeconds: 15, //    それを超えたら自然に Clear へ
  clearOnsetLevel: 0.45, //  Clear を促す強いオンセットの音量しきい

  // ---- Clear ----
  quietLevel: 0.05, //       これ以下を「沈んだ」とみなす音量
  quietSeconds: 2.5, //      沈んだまま続くと Clear へ
  clearStep: 0.05, //        消去 1 手の間隔（秒）
  clearGroups: 14, //        何手に分けて消すか（同時に全部は消さない）

  // ---- 共通 ----
  easeSpeed: 7, //           目標値へ寄る速さ（毎秒）
  onsetCooldown: 0.16, //    オンセット判定の不応時間（秒）
};

type Phase =
  | 'spawn'
  | 'expand'
  | 'gridMorph'
  | 'rowCascade'
  | 'merge'
  | 'subdivide'
  | 'finalCluster'
  | 'clear';

interface Cell {
  alive: boolean;
  /** セル幅に対するモジュールの大きさ。1 で隣と接する。 */
  scale: number;
  targetScale: number;
  /** 回転（ラジアン）。90°単位でしか目標を置かない。 */
  rotation: number;
  targetRotation: number;
  /** 2×2 に分けた小セルの詰まり具合（1 で隙間なし）。 */
  sub: number;
  targetSub: number;
  /** 局所反転。このセルの矩形内だけ白黒が入れ替わる。 */
  invert: boolean;
  /** 2×2 のどれが残っているか（下位 4 ビット）。 */
  mask: number;
  subdivided: boolean;
  /** 目標へ寄り始めるまでの待ち時間（秒）。行ごとのウェーブを作る。 */
  delay: number;
}

interface Circle {
  x: number;
  y: number;
  r: number;
  fromX: number;
  fromY: number;
  fromR: number;
  maxR: number;
  rate: number;
  cell: number;
  on: boolean;
}

const clamp01 = (value: number | undefined): number => Math.min(Math.max(value ?? 0, 0), 1);
const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 32bit 整数の決定論的ハッシュ。Math.random() は使わない（PRD §3.1）。 */
function hashInt(value: number): number {
  let h = value | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** シード（0..1）とキー列から 0..1 を作る。同じ入力なら必ず同じ値になる。 */
function hashKeys(seed: number, ...keys: number[]): number {
  let h = Math.round(seed * 0xffffff) | 0;
  for (let i = 0; i < keys.length; i++) {
    h = Math.imul(h ^ ((keys[i]! | 0) + 0x9e37), 0x85ebca6b) | 0;
    h = (h ^ (h >>> 13)) | 0;
  }
  return hashInt(h);
}

/** シード由来の並べ替え（Fisher–Yates）。消去順序などに使う。 */
function seededOrder(count: number, seed: number, salt: number): number[] {
  const items: number[] = [];
  for (let i = 0; i < count; i++) items.push(i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(hashKeys(seed, salt, i) * (i + 1));
    const swap = items[i]!;
    items[i] = items[j]!;
    items[j] = swap;
  }
  return items;
}

/**
 * 画角からマクログリッドの列数・行数を決める（D26）。
 * セルが物理的に正方形へ近づく組み合わせを選ぶ。切り取りや余白は作らない。
 */
function gridForRatio(ratio: number): { cols: number; rows: number } {
  let best = { cols: MODULAR.gridBase, rows: MODULAR.gridBase };
  let bestScore = Number.POSITIVE_INFINITY;
  const wanted = MODULAR.gridBase * MODULAR.gridBase;
  for (let rows = MODULAR.gridMin; rows <= MODULAR.gridMax; rows++) {
    const cols = clamp(Math.round(rows * ratio), MODULAR.gridMin, MODULAR.gridMax);
    // セルの縦横比のずれ（対数）と、セル総数のずれ（対数）の重み付き和。
    const shape = Math.abs(Math.log((ratio * rows) / cols));
    const size = Math.abs(Math.log((rows * cols) / wanted));
    const score = shape + size * 0.2;
    if (score < bestScore) {
      bestScore = score;
      best = { cols, rows };
    }
  }
  return best;
}

export class ModularPatternField implements LabExpression {
  readonly animated = true;
  readonly name = 'Modular Pattern Field';
  readonly id: ExpressionId = 'modular-v1';

  private readonly effects: Effect[];
  private theme: Theme;
  private zoom = 1;
  private response = { bass: 1, mid: 1, treble: 1 };
  private aspectId = '1:1';
  private aspectRatio = 1;

  private context: CompositionContext | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private geometry: THREE.PlaneGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private cellTexture: THREE.DataTexture | null = null;
  private cellData: Uint8Array = new Uint8Array(4);
  private pipeline: EffectPipeline | null = null;
  private previousElapsed = -1;
  private viewWidth = 1;
  private viewHeight = 1;

  // ---- 場の状態 ----
  private cols = MODULAR.gridBase;
  private rows = MODULAR.gridBase;
  private cells: Cell[] = [];
  private circles: Circle[] = [];
  private readonly circleUniform: THREE.Vector4[] = [];

  // ---- フェーズ機械の状態 ----
  private phase: Phase = 'spawn';
  private phaseTime = 0;
  private cycleIndex = 0;
  private cycleSeed = 0;
  private latestSeed = 0;
  private quietTime = 0;
  private onsetCooldown = 0;
  private spawnTime = 0;
  private align = 0;
  private cascadeAdvance = 0;
  private cascadeRow = 0;
  private subdivProgress = 0;
  private subdivRound = 0;
  private recruitTime = 0;
  private clearTime = 0;
  private clearOrder: number[] = [];
  private clearCursor = 0;
  /** 角丸・結合の半径（セル単位）。モジュール半幅より大きいと真円になる。 */
  private radius = MODULAR.radiusOpen;
  private radiusTarget = MODULAR.radiusOpen;
  /** 1 = 重なりを偶奇で抜く / 0 = 和を取る。連続に行き来する。 */
  private xor = 1;
  /** 低音由来の「大きさの階層」の幅。 */
  private sizeTier = 0;
  /** FinalCluster の花型・十字を組んだか。 */
  private clusterBuilt = false;
  private debugView = 0;

  constructor(effects: Effect[] = [], theme?: Theme) {
    this.effects = effects;
    this.theme = theme ?? THEMES[0]!;
    for (let i = 0; i < CIRCLE_SLOTS; i++) this.circleUniform.push(new THREE.Vector4());
    this.rebuildGrid();
  }

  // ------------------------------------------------------------------
  // セットアップ
  // ------------------------------------------------------------------

  setup(context: CompositionContext): void {
    this.context = context;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tCells: { value: this.cellTexture },
        uGrid: { value: new THREE.Vector2(this.cols, this.rows) },
        uPixel: { value: new THREE.Vector2(1 / 64, 1 / 64) },
        uActive: { value: 0 },
        uZoom: { value: this.zoom },
        uRadius: { value: this.radius },
        uXor: { value: 1 },
        uCircles: { value: this.circleUniform },
        uThemeDark: { value: new THREE.Vector3(...this.theme.dark) },
        uThemeLight: { value: new THREE.Vector3(...this.theme.light) },
        uThemeAccent: { value: new THREE.Vector3(...this.theme.accent) },
        uDebugView: { value: this.debugView },
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
        uniform sampler2D tCells;
        uniform vec2 uGrid;
        uniform vec2 uPixel;
        uniform float uActive;
        uniform float uZoom;
        uniform float uRadius;
        uniform float uXor;
        uniform vec4 uCircles[${CIRCLE_SLOTS}];
        uniform vec3 uThemeDark;
        uniform vec3 uThemeLight;
        uniform vec3 uThemeAccent;
        uniform float uDebugView;

        float sdBox(vec2 p, vec2 b) {
          vec2 d = abs(p) - b;
          return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
        }

        // 回転は 0..1 に詰めてある（RGBA8 の 1 チャンネル）。角度へ戻す。
        float unpackAngle(float packed) {
          return packed * 6.283185307179586;
        }

        // 被覆の排他的論理和。0/1 では厳密に XOR、途中では滑らかに繋がる。
        // 重なった部分だけを背景色へ抜く（even-odd）ための演算。
        float softXor(float a, float b) {
          return a + b - 2.0 * a * b;
        }

        vec2 rotate(vec2 p, float a) {
          float c = cos(a);
          float s = sin(a);
          return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
        }

        /**
         * セル 1 つを評価する。
         * 角丸半径より大きい部品は「角丸ぶん縮めた芯」として dCore へ入れ、
         * 最後に一度だけ半径を引く（rounded union）。隣接セルの間に継ぎ目も隙間も出ない。
         * 半径より小さい部品はそのまま円として dRound へ入れる。こうすると
         * 生まれたてのセルが半径ぶん膨らまず、大きさ 0 から連続に現れる。
         */
        void evalCell(vec2 g, vec2 cell, inout float dCore, inout float dRound, inout float invertCov) {
          if (cell.x < 0.0 || cell.y < 0.0 || cell.x > uGrid.x - 1.0 || cell.y > uGrid.y - 1.0) return;
          vec4 t = texture2D(tCells, (cell + 0.5) / uGrid);
          float flags = floor(t.a * 255.0 + 0.5);
          float alive = floor(flags / 64.0);
          flags -= alive * 64.0;
          float subdivided = floor(flags / 32.0);
          flags -= subdivided * 32.0;
          float invert = floor(flags / 16.0);
          float mask = flags - invert * 16.0;

          vec2 local = g - (cell + 0.5);
          if (invert > 0.5) {
            // 局所反転はセルの矩形そのもの。境界は硬い（パッと入れ替わって見える）。
            vec2 q = abs(local) - 0.5;
            invertCov = max(invertCov, 1.0 - step(0.0, max(q.x, q.y)));
          }
          if (alive < 0.5) return;

          float scale = t.r * 1.5;
          vec2 lp = rotate(local, -unpackAngle(t.g));
          float sub = t.b;

          if (subdivided < 0.5) {
            float h = 0.5 * scale;
            if (h > uRadius) {
              dCore = min(dCore, sdBox(lp, vec2(h - uRadius)));
            } else {
              dRound = min(dRound, length(lp) - h);
            }
            return;
          }

          float h = 0.25 * scale * sub;
          for (int k = 0; k < 4; k++) {
            float bit = floor(mod(mask / pow(2.0, float(k)), 2.0));
            if (bit < 0.5) continue;
            vec2 idx = vec2(mod(float(k), 2.0), floor(float(k) / 2.0));
            vec2 off = (idx - 0.5) * 0.5 * scale;
            vec2 q = lp - off;
            if (h > uRadius) {
              dCore = min(dCore, sdBox(q, vec2(h - uRadius)));
            } else {
              dRound = min(dRound, length(q) - h);
            }
          }
        }

        void main() {
          // D5: 音が鳴っていなければ何も見せない。
          if (uActive < 0.5) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          // ズームは開発用（D17）。板そのものを拡大縮小するだけ。
          vec2 uvz = (vUv - 0.5) / max(uZoom, 0.05) + 0.5;
          // g 空間ではセルが 1×1 になる。列数・行数は画角で割り振ってあるので
          // セルは物理的に正方形を保つ。
          vec2 g = uvz * uGrid;
          float aa = max(uPixel.x, uPixel.y) * 0.8;

          float dCore = 1e5;
          float dRound = 1e5;
          float invertCov = 0.0;
          vec2 base = floor(g);
          for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
              evalCell(g, base + vec2(float(i), float(j)), dCore, dRound, invertCov);
            }
          }
          float dGrid = min(dCore - uRadius, dRound);
          float gridCov = 1.0 - smoothstep(-aa, aa, dGrid);

          // 円（Spawn / Expand）。重なりは偶奇で背景色へ抜ける。
          float unionCov = 0.0;
          float parity = 0.0;
          for (int i = 0; i < ${CIRCLE_SLOTS}; i++) {
            vec4 c = uCircles[i];
            if (c.w < 0.5) continue;
            float cov = 1.0 - smoothstep(-aa, aa, length(g - c.xy) - c.z);
            unionCov = max(unionCov, cov);
            parity = softXor(parity, cov);
          }
          unionCov = max(unionCov, gridCov);
          parity = softXor(parity, gridCov);

          // uXor は 1（偶奇）から 0（和）へ連続に落ちる。重なりが無くなった時点では
          // 両者は厳密に一致するので、切り替わりは見えない。
          float ink = clamp(mix(unionCov, parity, uXor), 0.0, 1.0);
          ink = softXor(ink, invertCov);

          if (uDebugView > 0.5) {
            vec2 f = abs(fract(g) - 0.5);
            float border = step(0.47, max(f.x, f.y));
            gl_FragColor = vec4(vec3(1.0 - ink) * (1.0 - border * 0.6) + vec3(0.0, border * 0.35, 0.0), 1.0);
            return;
          }

          // 背景がテーマの明色（Monochrome ではオフホワイト）、図形が暗色。
          vec3 col = mix(uThemeLight, uThemeDark, ink) + uThemeAccent * pow(ink, 4.0);
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `,
    });

    this.scene = new THREE.Scene();
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.scene.add(new THREE.Mesh(this.geometry, this.material));

    this.pipeline = new EffectPipeline(context.renderer, this.scene, this.camera, this.effects);
    this.syncGridUniforms();
  }

  // ------------------------------------------------------------------
  // 毎フレーム
  // ------------------------------------------------------------------

  update(elapsed: number): void {
    if (!this.context || !this.material) return;
    const audio = this.context.audioEngine.getParameters();
    const active = audio.active === 1;

    const delta =
      this.previousElapsed < 0 ? 0 : Math.min(Math.max(elapsed - this.previousElapsed, 0), 0.05);
    this.previousElapsed = elapsed;

    this.material.uniforms.uActive!.value = active ? 1 : 0;

    // D5: 音がないときは進めない。無音は黒画面のまま、状態も凍る。
    if (active && delta > 0) {
      this.advance(audio, delta);
      this.writeCells();
      this.writeCircles();
      this.material.uniforms.uRadius!.value = this.radius;
      this.material.uniforms.uXor!.value = this.xor;
    }

    this.pipeline?.update(audio, elapsed);
  }

  render(): void {
    this.pipeline?.render();
  }

  resize(width: number, height: number): void {
    this.viewWidth = Math.max(width, 1);
    this.viewHeight = Math.max(height, 1);
    this.syncGridUniforms();
    this.pipeline?.resize(width, height);
  }

  // ------------------------------------------------------------------
  // フェーズ機械（CPU 側）
  // ------------------------------------------------------------------

  private advance(audio: AudioParameters, dt: number): void {
    const volume = clamp01(audio.volume);
    const bass = clamp01(audio.bass);
    const mid = clamp01(audio.mid);
    const treble = clamp01(audio.treble);
    const centroid = clamp01(audio.centroid);
    const flatness = clamp01(audio.flatness);
    const sustain = clamp01(audio.sustain);
    const onset = clamp01(audio.onset);
    if (typeof audio.seed === 'number') this.latestSeed = audio.seed;

    // 反応の調整（D24）: 帯域ゲインで音量を重み付けする。全部 1 なら素の音量。
    const bandTotal = bass + mid + treble;
    const weight =
      bandTotal > 1e-4
        ? (this.response.bass * bass + this.response.mid * mid + this.response.treble * treble) /
          bandTotal
        : 1;
    const drive = clamp01(volume * weight);

    // 高域側の「細かさ」。角丸量と細分化の進みを決める。
    const fine = clamp01(treble * 0.6 + centroid * 0.4);

    this.onsetCooldown = Math.max(0, this.onsetCooldown - dt);
    const hit = onset > 0.4 && this.onsetCooldown <= 0;
    if (hit) this.onsetCooldown = MODULAR.onsetCooldown;

    this.quietTime = volume < MODULAR.quietLevel ? this.quietTime + dt : 0;
    this.phaseTime += dt;

    // 音が数秒沈んだら、どのフェーズからでも片付けに入る。
    if (this.phase !== 'clear' && this.quietTime > MODULAR.quietSeconds) {
      this.beginClear();
    }

    switch (this.phase) {
      case 'spawn':
        this.stepSpawn(dt, drive);
        break;
      case 'expand':
        this.stepExpand(dt, drive, bass);
        break;
      case 'gridMorph':
        this.stepGridMorph(dt, sustain, bass, mid, fine);
        break;
      case 'rowCascade':
        this.stepRowCascade(dt, hit, flatness, fine);
        break;
      case 'merge':
        this.stepMerge(dt, hit, bass, mid, fine);
        break;
      case 'subdivide':
        this.stepSubdivide(dt, hit, fine, flatness, bass);
        break;
      case 'finalCluster':
        this.stepFinalCluster(hit, volume, flatness, fine, bass);
        break;
      case 'clear':
        this.stepClear(dt);
        break;
    }

    // 半径は目標へゆっくり寄せる。低音や高域が動いても図形が跳ねない。
    this.radius += (this.radiusTarget - this.radius) * (1 - Math.exp(-4 * dt));
    this.easeCells(dt);
  }

  /** 円が 1 つずつ現れる。順序と位置はシードから決まる。 */
  private stepSpawn(dt: number, drive: number): void {
    this.spawnTime += dt * (0.4 + drive * 1.8);
    let pending = false;
    for (let i = 0; i < this.circles.length; i++) {
      const circle = this.circles[i]!;
      if (!circle.on && this.spawnTime >= i * MODULAR.spawnStep) circle.on = true;
      if (!circle.on) pending = true;
    }
    this.growCircles(dt, drive);
    if (!pending) this.setPhase('expand');
  }

  /** 円が育つ。黒面積が目標の占有率に達したら整列へ。 */
  private stepExpand(dt: number, drive: number, bass: number): void {
    this.growCircles(dt, drive);
    const target = MODULAR.coverBase + MODULAR.coverDrive * drive;
    let area = 0;
    for (const circle of this.circles) {
      if (circle.on) area += Math.PI * circle.r * circle.r;
    }
    const coverage = area / (this.cols * this.rows);
    if (coverage >= target || this.phaseTime > MODULAR.expandMax) {
      this.beginGridMorph(bass);
    }
  }

  private growCircles(dt: number, drive: number): void {
    const speed = MODULAR.growSpeed * (0.25 + drive);
    for (const circle of this.circles) {
      if (!circle.on) continue;
      circle.r = Math.min(circle.r + dt * speed * circle.rate, circle.maxR);
    }
  }

  /**
   * 円 → 角丸四角。円はセル中心へ寄りながら同じ大きさへ揃い、
   * 半径がモジュール半幅を下回った時点から角丸四角になる（瞬間切替はしない）。
   */
  private beginGridMorph(bass: number): void {
    // 行き先のセルを決める。重なった場合は空いている最も近いセルへ押し出す。
    const taken = new Set<number>();
    for (const circle of this.circles) {
      if (!circle.on) continue;
      const cx = clamp(Math.floor(circle.x), 0, this.cols - 1);
      const cy = clamp(Math.floor(circle.y), 0, this.rows - 1);
      let index = cy * this.cols + cx;
      if (taken.has(index)) {
        let best = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < this.cols * this.rows; i++) {
          if (taken.has(i)) continue;
          const x = (i % this.cols) + 0.5;
          const y = Math.floor(i / this.cols) + 0.5;
          const distance = (x - circle.x) ** 2 + (y - circle.y) ** 2;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
          }
        }
        if (best < 0) continue;
        index = best;
      }
      taken.add(index);
      circle.cell = index;
      circle.fromX = circle.x;
      circle.fromY = circle.y;
      circle.fromR = circle.r;
    }
    // 低音が「大きさの階層」を決める。整列の瞬間はすべて同じ大きさで、
    // 階層はその後に開いていく（円との入れ替わりを見えなくするため）。
    this.sizeTier = clamp(MODULAR.sizeSpread * bass, 0, 0.6);
    this.align = 0;
    this.radius = MODULAR.radiusOpen;
    this.radiusTarget = MODULAR.radiusOpen;
    this.setPhase('gridMorph');
  }

  private stepGridMorph(
    dt: number,
    sustain: number,
    bass: number,
    mid: number,
    fine: number,
  ): void {
    this.align += dt * (MODULAR.alignBase + MODULAR.alignSustain * sustain);
    const t = clamp(this.align / 0.5, 0, 1);
    const ease = smoothstep(0, 1, t);
    const targetRadius = 0.5 * MODULAR.cellScale;

    if (this.align < 0.5) {
      // 円が寄って揃う。重なりが消えるにつれて偶奇から和へ移る。
      for (const circle of this.circles) {
        if (!circle.on || circle.cell < 0) continue;
        const cx = (circle.cell % this.cols) + 0.5;
        const cy = Math.floor(circle.cell / this.cols) + 0.5;
        circle.x = circle.fromX + (cx - circle.fromX) * ease;
        circle.y = circle.fromY + (cy - circle.fromY) * ease;
        circle.r = circle.fromR + (targetRadius - circle.fromR) * ease;
      }
      // 重なりが消えるにつれて偶奇から和へ。重なりが無いとき両者は厳密に一致する。
      this.xor = 1 - smoothstep(0.12, 0.5, this.align);
      this.radius = MODULAR.radiusOpen;
      this.radiusTarget = MODULAR.radiusOpen;
      return;
    }

    // 入れ替え: 円は消え、まったく同じ大きさ・位置のセルが立つ。
    // 半径が半幅より大きい間、セルは真円として描かれるので見た目は変わらない。
    if (this.circles.some((circle) => circle.on)) {
      for (const circle of this.circles) {
        if (!circle.on || circle.cell < 0) continue;
        const cell = this.cells[circle.cell]!;
        cell.alive = true;
        cell.scale = MODULAR.cellScale;
        cell.targetScale = this.tierScale(circle.cell);
        cell.rotation = 0;
        cell.targetRotation = 0;
        cell.sub = 1;
        cell.targetSub = 1;
        cell.mask = 15;
        cell.subdivided = false;
        cell.invert = false;
        cell.delay = 0;
        circle.on = false;
      }
      this.xor = 0;
    }

    // 角丸半径が下がると円は角丸四角になる。高域・重心が最終的な角丸量を決める。
    const roundTarget = MODULAR.radiusBase + MODULAR.radiusTreble * fine;
    const morph = smoothstep(0.5, 1, this.align);
    this.radius = MODULAR.radiusOpen + (roundTarget - MODULAR.radiusOpen) * morph;
    this.radiusTarget = this.radius;

    // 隣接セルを呼び込む。中域が「どれだけ繋がりやすいか」を決める。
    this.recruitTime += dt;
    if (this.recruitTime >= MODULAR.recruitStep) {
      this.recruitTime = 0;
      this.recruitNeighbours(mid, bass);
    }

    if (this.align >= 1) this.beginRowCascade();
  }

  /** 低音由来の大きさの階層。セルごとにシードで散らす。 */
  private tierScale(index: number): number {
    const h = hashKeys(this.cycleSeed, 11, index);
    return clamp(MODULAR.cellScale * (1 - this.sizeTier + 2 * this.sizeTier * h), 0.3, 1.35);
  }

  /** 生きているセルの隣に、シードとしきいで決まるセルを足す。大きさ 0 から育つ。 */
  private recruitNeighbours(mid: number, bass: number): void {
    const threshold = MODULAR.connectBase + MODULAR.connectMid * mid;
    const added: number[] = [];
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const index = y * this.cols + x;
        if (this.cells[index]!.alive) continue;
        if (!this.hasAliveNeighbour(x, y)) continue;
        if (hashKeys(this.cycleSeed, 40, index) >= threshold) continue;
        added.push(index);
      }
    }
    for (const index of added) {
      const cell = this.cells[index]!;
      cell.alive = true;
      cell.scale = 0;
      cell.targetScale = this.tierScale(index) * (0.85 + 0.3 * bass);
      cell.rotation = 0;
      cell.targetRotation = 0;
      cell.sub = 1;
      cell.targetSub = 1;
      cell.mask = 15;
      cell.subdivided = false;
      cell.invert = false;
      cell.delay = 0;
    }
  }

  private hasAliveNeighbour(x: number, y: number): boolean {
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        if (i === 0 && j === 0) continue;
        const nx = x + i;
        const ny = y + j;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        if (this.cells[ny * this.cols + nx]!.alive) return true;
      }
    }
    return false;
  }

  private beginRowCascade(): void {
    this.cascadeAdvance = 0;
    this.cascadeRow = 0;
    this.setPhase('rowCascade');
  }

  /** 上の行から順に 90°回転・縮小・（シードにより）白黒反転が伝わる。 */
  private stepRowCascade(dt: number, hit: boolean, flatness: number, fine: number): void {
    this.cascadeAdvance += dt / MODULAR.cascadeRowSeconds;
    if (hit) this.cascadeAdvance += 1;
    const reached = Math.floor(this.cascadeAdvance);
    while (this.cascadeRow < reached && this.cascadeRow < this.rows) {
      this.applyCascadeRow(this.cascadeRow, flatness);
      this.cascadeRow++;
    }
    // 縮小が進むほど角丸の比率が上がる（半幅が半径へ近づくため）。
    // 半径そのものは高域・重心が決める。
    this.radiusTarget = MODULAR.radiusBase + MODULAR.radiusTreble * fine;
    if (this.cascadeRow >= this.rows) {
      this.recruitTime = 0;
      this.setPhase('merge');
    }
  }

  private applyCascadeRow(row: number, flatness: number): void {
    // row 0 が画面の上。DataTexture は下から並ぶので行番号を反転する。
    const y = this.rows - 1 - row;
    const flip = hashKeys(this.cycleSeed, 30, row) < MODULAR.cascadeInvert + flatness * 0.3;
    const spin = hashKeys(this.cycleSeed, 31, row) < 0.5 ? 1 : -1;
    for (let x = 0; x < this.cols; x++) {
      const cell = this.cells[y * this.cols + x]!;
      if (!cell.alive) continue;
      cell.targetRotation += (spin * Math.PI) / 2;
      cell.targetScale = clamp(cell.targetScale * MODULAR.cascadeShrink, 0.18, 1.35);
      // 局所反転。行ごとの反転に、ノイズ性がセル単位のばらつきを足す。
      const local = hashKeys(this.cycleSeed, 32, y * this.cols + x) < flatness * 0.35;
      cell.invert = flip !== local;
      cell.delay = x * MODULAR.cascadeColDelay;
    }
  }

  /** 隣接セルが触れ合い、rounded union で 1 つの連結形状になる。 */
  private stepMerge(dt: number, hit: boolean, bass: number, mid: number, fine: number): void {
    const threshold = MODULAR.connectBase + MODULAR.connectMid * mid;
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i]!;
      if (!cell.alive) continue;
      // しきいを下回るセルはセル幅いっぱいまで育ち、隣と接して 1 つの形になる。
      if (hashKeys(this.cycleSeed, 41, i) < threshold) {
        cell.targetScale = Math.max(cell.targetScale, 1.0);
      }
    }
    this.recruitTime += dt;
    if (this.recruitTime >= MODULAR.recruitStep) {
      this.recruitTime = 0;
      this.recruitNeighbours(mid, bass);
    }
    // 低音が結合半径を広げる。半径が大きいほど離れたセルまで橋が架かる。
    this.radiusTarget =
      (MODULAR.radiusBase + MODULAR.radiusTreble * fine) * (1 + MODULAR.radiusBass * bass);
    const ripe = this.phaseTime > MODULAR.mergeMinSeconds;
    if ((ripe && hit) || this.phaseTime > MODULAR.mergeSeconds) {
      this.subdivProgress = 0;
      this.subdivRound = 0;
      this.setPhase('subdivide');
    }
  }

  /** セル内を 2×2 に分け、欠けを入れて段階的に小さく複雑にする。 */
  private stepSubdivide(
    dt: number,
    hit: boolean,
    fine: number,
    flatness: number,
    bass: number,
  ): void {
    this.subdivProgress += dt * (MODULAR.subdivRate + MODULAR.subdivTreble * fine);
    if (hit) this.subdivProgress += 0.5;
    // 細分化が進んだら半径を詰める。小セルの半幅を下回らせないと、
    // 十字や花型が 4 つの独立した円に潰れて連結しなくなる。
    const tighten = this.subdivRound > 0 ? MODULAR.subRadius : 1;
    this.radiusTarget =
      (MODULAR.radiusBase + MODULAR.radiusTreble * fine) *
      (1 + MODULAR.radiusBass * bass * 0.5) *
      tighten;
    if (this.subdivProgress < 1) return;
    this.subdivProgress = 0;
    this.applySubdivision(this.subdivRound, fine, flatness);
    this.subdivRound++;
    if (this.subdivRound >= MODULAR.subdivRounds) this.setPhase('finalCluster');
  }

  private applySubdivision(round: number, fine: number, flatness: number): void {
    const chance = MODULAR.subdivChance + fine * 0.4;
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i]!;
      if (!cell.alive) continue;
      if (hashKeys(this.cycleSeed, 50 + round, i) >= chance) continue;
      // 前の状態を引き継ぐ: 既に分かれているセルは今のマスクから欠けを増やす。
      let mask = cell.subdivided ? cell.mask : 15;
      const drops = Math.floor(hashKeys(this.cycleSeed, 55 + round, i) * (1 + flatness * MODULAR.flatnessDrop));
      for (let d = 0; d < drops; d++) {
        const bit = Math.floor(hashKeys(this.cycleSeed, 60 + round, i, d) * 4);
        const next = mask & ~(1 << bit);
        if (next !== 0) mask = next;
      }
      cell.subdivided = true;
      cell.mask = mask;
      cell.targetSub = MODULAR.subGap;
      // 分割で軽くなるぶん、モジュールはわずかに広がって密度を保つ。
      cell.targetScale = clamp(cell.targetScale * 1.08, 0.2, 1.35);
      cell.delay = hashKeys(this.cycleSeed, 65 + round, i) * 0.25;
    }
  }

  /**
   * 4 セルで中央が抜ける花型・十字のクラスターを立てる。
   * 抜けは共有する角に接する小セルを落とすことで作る。
   */
  private stepFinalCluster(
    hit: boolean,
    volume: number,
    flatness: number,
    fine: number,
    bass: number,
  ): void {
    if (!this.clusterBuilt) {
      this.buildClusters(flatness);
      this.clusterBuilt = true;
    }
    this.radiusTarget =
      (MODULAR.radiusBase + MODULAR.radiusTreble * fine) *
      (1 + MODULAR.radiusBass * bass * 0.5) *
      MODULAR.subRadius;
    const ripe = this.phaseTime > MODULAR.finalMinSeconds;
    const strong = hit && volume > MODULAR.clearOnsetLevel;
    if ((ripe && strong) || this.phaseTime > MODULAR.finalMaxSeconds) this.beginClear();
  }

  private buildClusters(flatness: number): void {
    const used = new Set<number>();
    const drop = [3, 2, 1, 0];
    for (let y = 0; y < this.rows - 1; y++) {
      for (let x = 0; x < this.cols - 1; x++) {
        const corner = [
          y * this.cols + x, //             左下 → 抜けるのは右上（ビット 3）
          y * this.cols + x + 1, //         右下 → 左上（ビット 2）
          (y + 1) * this.cols + x, //       左上 → 右下（ビット 1）
          (y + 1) * this.cols + x + 1, //   右上 → 左下（ビット 0）
        ];
        if (corner.some((index) => !this.cells[index]!.alive || used.has(index))) continue;
        if (hashKeys(this.cycleSeed, 70, x, y) >= MODULAR.flowerChance) continue;
        for (const index of corner) used.add(index);
        for (let k = 0; k < 4; k++) {
          const cell = this.cells[corner[k]!]!;
          cell.subdivided = true;
          cell.mask = 15 & ~(1 << drop[k]!);
          cell.targetSub = MODULAR.subGap;
          cell.targetScale = 1.0;
          // 抜きの向きを揃えるため、回転はいちばん近い一周へ戻す。
          cell.targetRotation = Math.round(cell.rotation / (Math.PI * 2)) * Math.PI * 2;
          cell.invert = hashKeys(this.cycleSeed, 71, corner[k]!) < flatness * 0.25;
          cell.delay = hashKeys(this.cycleSeed, 72, corner[k]!) * 0.3;
        }
      }
    }
    // 十字: 四方が生きているセルは、その周りを接するまで育てて 1 つの形にする。
    for (let y = 1; y < this.rows - 1; y++) {
      for (let x = 1; x < this.cols - 1; x++) {
        const index = y * this.cols + x;
        const arms = [index - 1, index + 1, index - this.cols, index + this.cols];
        if (!this.cells[index]!.alive || used.has(index)) continue;
        if (arms.some((arm) => !this.cells[arm]!.alive || used.has(arm))) continue;
        if (hashKeys(this.cycleSeed, 73, x, y) >= 0.35) continue;
        for (const arm of [index, ...arms]) {
          used.add(arm);
          const cell = this.cells[arm]!;
          cell.subdivided = false;
          cell.mask = 15;
          cell.targetScale = 1.0;
        }
      }
    }
  }

  private beginClear(): void {
    for (const circle of this.circles) circle.on = false;
    this.clearOrder = seededOrder(this.cells.length, this.cycleSeed, 80);
    this.clearCursor = 0;
    this.clearTime = 0;
    this.setPhase('clear');
  }

  /** セル単位でパッと消す。フェードはしない。順序はシード由来。 */
  private stepClear(dt: number): void {
    this.clearTime += dt;
    const perStep = Math.max(1, Math.ceil(this.cells.length / MODULAR.clearGroups));
    while (this.clearTime >= MODULAR.clearStep && this.clearCursor < this.clearOrder.length) {
      this.clearTime -= MODULAR.clearStep;
      for (let n = 0; n < perStep && this.clearCursor < this.clearOrder.length; n++) {
        const cell = this.cells[this.clearOrder[this.clearCursor++]!]!;
        cell.alive = false;
        cell.scale = 0;
        cell.targetScale = 0;
        cell.invert = false;
      }
    }
    if (this.clearCursor >= this.clearOrder.length) this.beginCycle();
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseTime = 0;
  }

  /** 目標へ寄せる。行ごとの待ち時間がウェーブを作る。 */
  private easeCells(dt: number): void {
    const k = 1 - Math.exp(-MODULAR.easeSpeed * dt);
    for (const cell of this.cells) {
      if (cell.delay > 0) {
        cell.delay -= dt;
        continue;
      }
      cell.scale += (cell.targetScale - cell.scale) * k;
      cell.rotation += (cell.targetRotation - cell.rotation) * k;
      cell.sub += (cell.targetSub - cell.sub) * k;
    }
  }

  // ------------------------------------------------------------------
  // サイクル
  // ------------------------------------------------------------------

  /**
   * 新しいシードでサイクルを最初から始める。
   *
   * シードは音のシード（オンセット時のスペクトル形状のハッシュ）だけから作る。
   * 何周目かは混ぜない。混ぜると同じ音から違う像が出て再現性が壊れる（PRD §3.1）。
   * 実際の曲ではオンセットごとにシードが引き直されるので、周ごとの像は自然に変わる。
   */
  private beginCycle(): void {
    this.cycleIndex++;
    this.cycleSeed = hashKeys(this.latestSeed, 99);
    for (const cell of this.cells) {
      cell.alive = false;
      cell.scale = 0;
      cell.targetScale = 0;
      cell.rotation = 0;
      cell.targetRotation = 0;
      cell.sub = 1;
      cell.targetSub = 1;
      cell.invert = false;
      cell.mask = 15;
      cell.subdivided = false;
      cell.delay = 0;
    }
    this.circles = this.createCircles();
    this.clusterBuilt = false;
    this.align = 0;
    this.spawnTime = 0;
    this.recruitTime = 0;
    this.quietTime = 0;
    this.sizeTier = 0;
    this.radius = MODULAR.radiusOpen;
    this.radiusTarget = MODULAR.radiusOpen;
    this.xor = 1;
    this.setPhase('spawn');
  }

  /** 円の個数・位置・育ち方をシードから決める。毎フレームの再抽選はしない。 */
  private createCircles(): Circle[] {
    const seed = this.cycleSeed;
    const count = Math.min(
      MODULAR.circleMax,
      MODULAR.circleMin +
        Math.floor(hashKeys(seed, 1) * (MODULAR.circleMax - MODULAR.circleMin + 1)),
    );
    const order = seededOrder(this.cols * this.rows, seed, 2);
    const circles: Circle[] = [];
    for (let i = 0; i < count; i++) {
      const index = order[i % order.length]!;
      const cx = (index % this.cols) + 0.5;
      const cy = Math.floor(index / this.cols) + 0.5;
      // セル中心からのずれは規則的（±0.35 セル）。完全な自由配置にはしない。
      const ox = (hashKeys(seed, 3, i) - 0.5) * 0.7;
      const oy = (hashKeys(seed, 4, i) - 0.5) * 0.7;
      circles.push({
        x: cx + ox,
        y: cy + oy,
        r: 0,
        fromX: cx + ox,
        fromY: cy + oy,
        fromR: 0,
        maxR: 0.8 + hashKeys(seed, 5, i) * 1.4,
        rate: 1 - MODULAR.growSpread * 0.5 + hashKeys(seed, 6, i) * MODULAR.growSpread,
        cell: -1,
        on: false,
      });
    }
    return circles;
  }

  // ------------------------------------------------------------------
  // GPU への書き出し
  // ------------------------------------------------------------------

  private rebuildGrid(): void {
    const grid = gridForRatio(this.aspectRatio);
    this.cols = grid.cols;
    this.rows = grid.rows;
    this.cells = [];
    for (let i = 0; i < this.cols * this.rows; i++) {
      this.cells.push({
        alive: false,
        scale: 0,
        targetScale: 0,
        rotation: 0,
        targetRotation: 0,
        sub: 1,
        targetSub: 1,
        invert: false,
        mask: 15,
        subdivided: false,
        delay: 0,
      });
    }
    this.cellData = new Uint8Array(this.cols * this.rows * 4);
    this.cellTexture?.dispose();
    this.cellTexture = new THREE.DataTexture(this.cellData, this.cols, this.rows);
    this.cellTexture.minFilter = THREE.NearestFilter;
    this.cellTexture.magFilter = THREE.NearestFilter;
    this.cellTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.cellTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.cellTexture.needsUpdate = true;
    this.cycleIndex = 0;
    this.cycleSeed = hashKeys(this.latestSeed, 99);
    this.circles = this.createCircles();
    this.clusterBuilt = false;
    this.phase = 'spawn';
    this.phaseTime = 0;
    this.align = 0;
    this.spawnTime = 0;
    this.radius = MODULAR.radiusOpen;
    this.radiusTarget = MODULAR.radiusOpen;
    this.xor = 1;
    this.writeCells();
    this.syncGridUniforms();
  }

  private syncGridUniforms(): void {
    if (!this.material) return;
    (this.material.uniforms.uGrid!.value as THREE.Vector2).set(this.cols, this.rows);
    // 1 ピクセルが g 空間でどれだけかを渡す（アンチエイリアスの幅）。
    // fwidth は WebGL1 では拡張が要るため使わない。
    (this.material.uniforms.uPixel!.value as THREE.Vector2).set(
      this.cols / this.viewWidth,
      this.rows / this.viewHeight,
    );
    this.material.uniforms.tCells!.value = this.cellTexture;
    this.material.uniforms.uRadius!.value = this.radius;
    this.material.uniforms.uXor!.value = this.xor;
  }

  /** セル状態を RGBA8 へ詰める。R=大きさ / G=回転 / B=小セルの詰まり / A=旗とマスク。 */
  private writeCells(): void {
    const data = this.cellData;
    const twoPi = Math.PI * 2;
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i]!;
      const offset = i * 4;
      data[offset] = Math.round(clamp(cell.scale / 1.5, 0, 1) * 255);
      const rotation = ((cell.rotation % twoPi) + twoPi) % twoPi;
      data[offset + 1] = Math.round((rotation / twoPi) * 255);
      data[offset + 2] = Math.round(clamp(cell.sub, 0, 1) * 255);
      data[offset + 3] =
        (cell.mask & 15) +
        (cell.invert ? 16 : 0) +
        (cell.subdivided ? 32 : 0) +
        (cell.alive ? 64 : 0);
    }
    if (this.cellTexture) this.cellTexture.needsUpdate = true;
  }

  private writeCircles(): void {
    for (let i = 0; i < CIRCLE_SLOTS; i++) {
      const circle = this.circles[i];
      const uniform = this.circleUniform[i]!;
      if (!circle || !circle.on) {
        uniform.set(0, 0, 0, 0);
        continue;
      }
      uniform.set(circle.x, circle.y, circle.r, 1);
    }
  }

  // ------------------------------------------------------------------
  // LabExpression
  // ------------------------------------------------------------------

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
    if (!this.material) return;
    (this.material.uniforms.uThemeDark!.value as THREE.Vector3).set(...theme.dark);
    (this.material.uniforms.uThemeLight!.value as THREE.Vector3).set(...theme.light);
    (this.material.uniforms.uThemeAccent!.value as THREE.Vector3).set(...theme.accent);
  }

  getZoom(): number {
    return this.zoom;
  }

  /** ズームは開発用（D17）。板そのものを拡大縮小するだけ。 */
  setZoom(zoom: number): void {
    this.zoom = clamp(zoom, 0.25, 8);
    if (this.material) this.material.uniforms.uZoom!.value = this.zoom;
  }

  getResponse(): { bass: number; mid: number; treble: number } {
    return { ...this.response };
  }

  setResponse(gains: Partial<{ bass: number; mid: number; treble: number }>): void {
    const pick = (value: number | undefined, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 2) : fallback;
    this.response = {
      bass: pick(gains.bass, this.response.bass),
      mid: pick(gains.mid, this.response.mid),
      treble: pick(gains.treble, this.response.treble),
    };
  }

  getAspectId(): string {
    return this.aspectId;
  }

  getAspectRatio(): number {
    return this.aspectRatio;
  }

  /** 画角（D26）。列数・行数を比率で割り振り、セルは正方形を保つ。 */
  setAspect(id: string, ratio: number): void {
    if (id === this.aspectId) return;
    this.aspectId = id;
    this.aspectRatio = clamp(ratio, 0.25, 4);
    this.rebuildGrid();
  }

  /** 開発用: 0=最終 1=セル境界と図形の反転表示。 */
  setDebugView(view: number): void {
    this.debugView = view;
    if (this.material) this.material.uniforms.uDebugView!.value = view;
  }

  /** モード励起はサイマティクス固有の機構。この表現は持たない。 */
  getDebugState(): null {
    return null;
  }

  /** 奥行きは持たない（D25）。機能面だけ満たす。 */
  getDepth(): number {
    return 0;
  }

  setDepth(): void {
    // 奥行きなし。
  }

  /** 開発用: 現在のフェーズ（DebugPanel が表示する）。 */
  getPhase(): string {
    const alive = this.cells.reduce((count, cell) => count + (cell.alive ? 1 : 0), 0);
    return `${this.phase} cells=${alive}/${this.cells.length} r=${this.radius.toFixed(2)}`;
  }

  /** 新しいシードでサイクルを再開する。 */
  restartCycle(): void {
    this.latestSeed = this.context?.audioEngine.getParameters().seed ?? this.latestSeed;
    this.beginCycle();
  }

  setGeneratorsVisible(): void {
    // 表現の表示切り替えは存在しない。
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
    this.cellTexture?.dispose();
    this.pipeline = null;
    this.geometry = null;
    this.material = null;
    this.cellTexture = null;
    this.scene = null;
    this.camera = null;
    this.context = null;
  }
}
