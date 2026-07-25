import type { FieldRenderer } from '../engine/FieldRenderer';
import { MinimalShape } from './MinimalShape';

/**
 * 表現の見え方。**1 つの表現は 1 つの見え方だけを持つ**（PRD D16）。
 *
 * Renderer はユーザーが選ぶものではなく、表現を構成する内部部品。
 * サイマティクスの見え方は「粒子が集まって境界が浮かぶ」MinimalShape で固定する。
 * 過去のプリセットが別の名前を持っていても、先頭の見え方へ安全に落ちる。
 */
export interface RendererDefinition {
  name: string;
  create: () => FieldRenderer;
}

export const RENDERERS: RendererDefinition[] = [
  { name: 'Minimal shape', create: () => new MinimalShape() },
];

export function createRenderer(name: string): FieldRenderer {
  return (RENDERERS.find((definition) => definition.name === name) ?? RENDERERS[0]!).create();
}
