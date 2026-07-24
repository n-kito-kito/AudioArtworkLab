import type { FieldRenderer } from '../engine/FieldRenderer';
import { Graph } from './Graph';
import { LightWave } from './LightWave';
import { MinimalShape } from './MinimalShape';

/**
 * ② 表現レイヤーの一覧。新しい Renderer は 1 行追加するだけで選択可能になる。
 * 同じ Field でも Renderer を差し替えるだけで別のグラフィックになる（DESIGN.md §3）。
 */
export interface RendererDefinition {
  name: string;
  create: () => FieldRenderer;
}

export const RENDERERS: RendererDefinition[] = [
  { name: 'Minimal shape', create: () => new MinimalShape() },
  { name: 'Light wave', create: () => new LightWave() },
  { name: 'Graph', create: () => new Graph() },
];

export function createRenderer(name: string): FieldRenderer {
  return (RENDERERS.find((definition) => definition.name === name) ?? RENDERERS[0]!).create();
}
