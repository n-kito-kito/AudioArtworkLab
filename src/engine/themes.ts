/**
 * 色のテーマ。横断概念（DESIGN.md §6）。
 *
 * Renderer は明暗（モノクロ）だけを作り、色はテーマが一括で決める。
 * どの Field × Renderer の組み合わせにも同じテーマがかかるため、
 * テーマを差し替えるだけで作品全体の色が破綻なく変わる。
 *
 * 写像: color = mix(dark, light, 輝度) + accent × 輝度⁴
 * accent は最も明るい部分にだけ差し込む別色。
 */
export interface Theme {
  readonly name: string;
  readonly dark: readonly [number, number, number];
  readonly light: readonly [number, number, number];
  readonly accent: readonly [number, number, number];
}

export const THEMES: readonly Theme[] = [
  {
    name: 'Monochrome',
    dark: [0, 0, 0],
    light: [0.96, 0.98, 1.0],
    accent: [0, 0, 0],
  },
  {
    name: 'Cyan',
    dark: [0.02, 0.03, 0.07],
    light: [0.3, 0.92, 1.0],
    accent: [0.55, 0.06, 0.42],
  },
  {
    name: 'Amber',
    dark: [0.05, 0.02, 0.0],
    light: [1.0, 0.7, 0.24],
    accent: [0.35, 0.04, 0.0],
  },
  {
    name: 'Violet',
    dark: [0.03, 0.0, 0.06],
    light: [0.72, 0.32, 1.0],
    accent: [0.15, 0.45, 0.28],
  },
] as const;

export function findTheme(name: string): Theme {
  return THEMES.find((theme) => theme.name === name) ?? THEMES[0]!;
}
