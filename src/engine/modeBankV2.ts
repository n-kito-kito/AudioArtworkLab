import type { PlateMode } from './modeBank';

/**
 * V2 のモード表 — 自由端の正方形板の固有モード（Waller の実用近似）。
 *
 * variant の意味（CymaticsV2 の GLSL と対応）:
 *   0 = 結合モード cos(nπx)cos(mπy) + extra·cos(mπx)cos(nπy)。extra=±1 が結合の符号。
 *       +1 は 90° 回転で自分に重なる族、−1 は 90° 回転で符号が反転する族。
 *       節線は直線ではなく曲がり、実機のクラドニ図形と同じ族になる。
 *   1 = 中央励振の同心円モード（外周は正方形の影響でわずかに角張る）
 *   2 = 縮退した梁モード（波打つ縞）。90° 回転の相方が同じ周波数に存在し得る。
 *
 * 周波数は板の実測値ではない。参考画像の Hz を対応表として固定せず、
 * 「低次→高次で空間的複雑度が上がる」階段として対数間隔で置く。
 * n=m かつ extra=−1 は恒等的にゼロになるため置かない。
 */
export const PLATE_MODES_V2: readonly PlateMode[] = [
  { id: 0, frequency: 55, bandwidth: 0.8, variant: 1, n: 1, m: 0, extra: 0, asym: 0.0, label: 'ring1', symmetry: '回転対称' },
  { id: 1, frequency: 76, bandwidth: 0.75, variant: 0, n: 1, m: 0, extra: -1, asym: 0.05, label: 'X (1,0−)', symmetry: '反対称' },
  { id: 2, frequency: 105, bandwidth: 0.75, variant: 0, n: 1, m: 0, extra: 1, asym: 0.04, label: 'diamond (1,0+)', symmetry: '四回対称' },
  { id: 3, frequency: 144, bandwidth: 0.7, variant: 0, n: 1, m: 1, extra: 1, asym: 0.05, label: 'grid (1,1+)', symmetry: '四回対称' },
  { id: 4, frequency: 199, bandwidth: 0.7, variant: 0, n: 2, m: 0, extra: -1, asym: 0.05, label: 'lattice (2,0−)', symmetry: '反対称' },
  { id: 5, frequency: 274, bandwidth: 0.7, variant: 1, n: 2, m: 0, extra: 0, asym: 0.04, label: 'ring2', symmetry: '回転対称' },
  { id: 6, frequency: 378, bandwidth: 0.65, variant: 0, n: 2, m: 0, extra: 1, asym: 0.05, label: 'rings (2,0+)', symmetry: '四回対称' },
  { id: 7, frequency: 521, bandwidth: 0.65, variant: 0, n: 2, m: 1, extra: -1, asym: 0.06, label: 'curl (2,1−)', symmetry: '反対称' },
  { id: 8, frequency: 719, bandwidth: 0.6, variant: 0, n: 2, m: 1, extra: 1, asym: 0.05, label: 'curl (2,1+)', symmetry: '二回対称' },
  { id: 9, frequency: 991, bandwidth: 0.6, variant: 0, n: 2, m: 2, extra: 1, asym: 0.04, label: 'grid (2,2+)', symmetry: '四回対称' },
  { id: 10, frequency: 1367, bandwidth: 0.6, variant: 0, n: 3, m: 1, extra: -1, asym: 0.05, label: 'web (3,1−)', symmetry: '反対称' },
  { id: 11, frequency: 1885, bandwidth: 0.6, variant: 0, n: 3, m: 1, extra: 1, asym: 0.05, label: 'quatre (3,1+)', symmetry: '四回対称' },
  { id: 12, frequency: 2600, bandwidth: 0.55, variant: 0, n: 3, m: 2, extra: -1, asym: 0.05, label: 'web (3,2−)', symmetry: '反対称' },
  { id: 13, frequency: 3585, bandwidth: 0.55, variant: 0, n: 3, m: 2, extra: 1, asym: 0.05, label: 'web (3,2+)', symmetry: '二回対称' },
  { id: 14, frequency: 4300, bandwidth: 0.55, variant: 2, n: 4, m: 1, extra: 0.25, asym: 0.05, label: 'stripes4', symmetry: '軸対称' },
  { id: 15, frequency: 4944, bandwidth: 0.55, variant: 0, n: 4, m: 2, extra: 1, asym: 0.05, label: 'cells (4,2+)', symmetry: '四回対称' },
  { id: 16, frequency: 5800, bandwidth: 0.5, variant: 0, n: 4, m: 3, extra: -1, asym: 0.05, label: 'web (4,3−)', symmetry: '反対称' },
  { id: 17, frequency: 6818, bandwidth: 0.5, variant: 0, n: 4, m: 4, extra: 1, asym: 0.04, label: 'grid (4,4+)', symmetry: '四回対称' },
] as const;
