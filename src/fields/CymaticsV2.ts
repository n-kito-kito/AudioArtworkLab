import { Cymatics } from './Cymatics';

/**
 * サイマティクス V2 — モードライブラリの刷新（開発中）。
 *
 * V1 と同じ砂の物理・励起選択（ModeExciter）の上で、振動場だけを
 * 自由端の正方形板の固有モードへ置き換える。V1 の状態とは一切共有しない。
 *
 * Phase 1（分離）の時点では V1 と同じ場。Phase 2 でモード表と GLSL を差し替える。
 */
export class CymaticsV2 extends Cymatics {
  override readonly name: string = 'Cymatics V2';
}
