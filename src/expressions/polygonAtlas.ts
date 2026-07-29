import * as THREE from 'three';

/**
 * **不均一な多角形のマスク帳（テクスチャアトラス）。**
 *
 * 軸平面のフラッシュを「丸が広がるだけ」にしないための下地。起動時に一度だけ、
 * 頂点数も形も違う多角形を決定論的に生成して 1 枚のテクスチャへ焼く。
 * 描画側はインスタンス属性でセル番号を選ぶだけなので、**ドローコールは 1 のまま**。
 *
 * 中身は**符号つき距離場（SDF）**で、0.5 がちょうど輪郭、内側が大きい値。
 * ビットマップの塗りつぶしを焼くと 16 倍まで拡大したときに輪郭がぼけるが、
 * SDF なら補間しても輪郭の位置が動かないので、**どこまで拡大しても縁が鋭い**。
 * 「わずかな縁のにじみ」もフラグメント側で 0.5 の外側を薄く拾うだけで作れる。
 *
 * `Math.random()` は使わない。同じ設定なら毎回まったく同じ帳面ができる。
 */

/** 多角形の作り方。質感の数値は表現側（`SPATIAL_STUDY`）が持ち、ここへ渡す。 */
export interface PolygonAtlasConfig {
  /** 図形の枚数。セルは columns 列に並ぶ。 */
  readonly patterns: number;
  readonly columns: number;
  /** セル 1 つの辺の長さ（テクセル）。SDF なので低解像度でも縁は鋭いまま。 */
  readonly cellPixels: number;
  /** 頂点数の下限・上限。 */
  readonly vertexMinimum: number;
  readonly vertexMaximum: number;
  /**
   * 中心からの距離の下限・上限（セルの半分を 1 とした割合）。
   * 幅を持たせるほど「折れた紙」のような非対称な形になる。
   */
  readonly radiusMinimum: number;
  readonly radiusMaximum: number;
  /**
   * 頂点の角度の散らし（0 で正多角形の角度、1 で隣と重なりうるまで）。
   * ここが小さいと整った多角形になってしまう。
   */
  readonly angleJitter: number;
  /**
   * SDF を 0..1 へ写すときの幅（セルの半分を 1 とした距離）。
   * 狭いほど縁の外側がすぐ 0 になる。にじみの余地を残す程度に取る。
   */
  readonly distanceSpread: number;
  /** ハッシュの味付け。ここだけ動かすと 12 枚まるごと別の形になる。 */
  readonly seedSalt: number;
}

export interface PolygonAtlas {
  readonly texture: THREE.DataTexture;
  readonly columns: number;
  readonly rows: number;
  /** 実際に焼いた枚数（columns × rows に満たない余りは空セル）。 */
  readonly patterns: number;
}

/** FNV-1a を土台にした 0..1 のハッシュ。位置生成・対応づけと同じ作り。 */
const hash01 = (...values: number[]): number => {
  let hash = 0x811c9dc5;
  for (const value of values) {
    const quantized = Math.round(value * 4096) | 0;
    for (let shift = 0; shift < 32; shift += 8) {
      hash ^= (quantized >>> shift) & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash / 0x100000000;
};

const mix = (a: number, b: number, t: number): number => a + (b - a) * Math.min(Math.max(t, 0), 1);

/**
 * 点から多角形までの符号つき距離。**内側が負**。
 * 距離は全辺への最短距離、内外は水平レイの交差数で決める。
 */
const signedDistance = (px: number, py: number, points: readonly number[]): number => {
  const count = points.length / 2;
  let squared = Number.POSITIVE_INFINITY;
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = points[i * 2]!;
    const yi = points[i * 2 + 1]!;
    const xj = points[j * 2]!;
    const yj = points[j * 2 + 1]!;
    const ex = xj - xi;
    const ey = yj - yi;
    const wx = px - xi;
    const wy = py - yi;
    const t = Math.min(Math.max((wx * ex + wy * ey) / Math.max(ex * ex + ey * ey, 1e-9), 0), 1);
    const bx = wx - ex * t;
    const by = wy - ey * t;
    squared = Math.min(squared, bx * bx + by * by);
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return Math.sqrt(squared) * (inside ? -1 : 1);
};

/**
 * 多角形 1 枚ぶんの頂点。角度は等分から散らし、半径は毎回引き直す。
 *
 * **星形にはしない。** 半径を 1 つおきに大小させると星になってしまうので、
 * 隣り合う頂点の半径は独立に引き、鈍角の折れが残る形に寄せる。
 */
const buildPolygon = (config: PolygonAtlasConfig, pattern: number): number[] => {
  const h = (salt: number): number => hash01(config.seedSalt, pattern, salt);
  const range = config.vertexMaximum - config.vertexMinimum;
  const count = Math.min(
    config.vertexMinimum + Math.floor(h(1) * (range + 1)),
    config.vertexMaximum,
  );
  // 回転の起点も figure ごとに変える。全部が同じ向きで揃わないように。
  const phase = h(2) * Math.PI * 2;
  const points: number[] = [];
  for (let i = 0; i < count; i++) {
    const step = (Math.PI * 2) / count;
    const jitter = (h(10 + i * 3) * 2 - 1) * config.angleJitter * step * 0.5;
    const angle = phase + step * i + jitter;
    const radius = mix(config.radiusMinimum, config.radiusMaximum, h(11 + i * 3));
    points.push(Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
  return points;
};

/**
 * アトラスを焼く。返すテクスチャは R に SDF（0.5 が輪郭）を持つ。
 * 呼び出し側は `dispose()` を忘れないこと。
 */
export const createPolygonAtlas = (config: PolygonAtlasConfig): PolygonAtlas => {
  const columns = Math.max(config.columns, 1);
  const rows = Math.max(Math.ceil(config.patterns / columns), 1);
  const width = columns * config.cellPixels;
  const height = rows * config.cellPixels;
  const data = new Uint8Array(width * height * 4);

  for (let pattern = 0; pattern < config.patterns; pattern++) {
    const points = buildPolygon(config, pattern);
    const column = pattern % columns;
    const row = Math.floor(pattern / columns);
    for (let y = 0; y < config.cellPixels; y++) {
      // セル内を −1..1 に取る。多角形の半径もこの単位。
      const py = ((y + 0.5) / config.cellPixels) * 2 - 1;
      for (let x = 0; x < config.cellPixels; x++) {
        const px = ((x + 0.5) / config.cellPixels) * 2 - 1;
        const distance = signedDistance(px, py, points);
        // 内側ほど大きい値。0.5 がちょうど輪郭になるよう写す。
        const encoded = Math.min(Math.max(0.5 - distance / config.distanceSpread, 0), 1);
        const value = Math.round(encoded * 255);
        const index = ((row * config.cellPixels + y) * width + column * config.cellPixels + x) * 4;
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
        data[index + 3] = 255;
      }
    }
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  // 拡大しても縁が鋭いのは SDF のおかげなので、補間は線形でよい。
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, columns, rows, patterns: config.patterns };
};
