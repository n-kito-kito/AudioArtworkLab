import * as THREE from 'three';

/**
 * **プリズム質感素材（Macro layer）のテクスチャアトラス。**
 *
 * `public/assets/light-traces/` の 10 枚を 1 枚のアトラスへまとめる。
 * 素材ごとに Material を作らないための土台で、描画側は素材番号を
 * インスタンス属性で渡すだけになる（**Texture layer の Draw Call は 1**）。
 *
 * 読み込みは非同期。**間に合わなくても表現は壊れない**（アトラスが無い間は
 * Macro layer を 1 枚も出さないだけで、既存の Procedural な光はそのまま動く）。
 * 無音＝黒（PRD D5）もアトラスの有無に依らず保たれる。
 *
 * 素材の並び順は manifest の順そのままで、番号は保存データに入らない。
 */

/** アトラスの 1 マス。役割と重みは manifest から来る（描画側は使わない）。 */
export interface PrismTile {
  readonly id: string;
  /** 役割（`wide-haze` など）。**どの帯域でどれを選ぶかは対応づけ層が決める。** */
  readonly role: string;
  /** 選ばれやすさ。manifest が持つ相対値。 */
  readonly weight: number;
}

export interface PrismAtlas {
  readonly texture: THREE.Texture;
  readonly columns: number;
  readonly rows: number;
  readonly tiles: readonly PrismTile[];
}

/** 読み込みの設定。質感の数値は持たない（ここは配線だけ）。 */
export interface PrismAtlasConfig {
  /** manifest の場所。 */
  readonly manifestUrl: string;
  /** 1 マスの辺（画素）。元は 1024 だが、Macro layer は大きく引き伸ばして使うので落とす。 */
  readonly cellPixels: number;
  /** 列数。行数は枚数から決まる。 */
  readonly columns: number;
}

interface ManifestEntry {
  readonly id?: unknown;
  readonly file?: unknown;
  readonly role?: unknown;
  readonly weight?: unknown;
}

interface Manifest {
  readonly basePath?: unknown;
  readonly textures?: unknown;
}

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`failed to load ${url}`));
    image.src = url;
  });

/**
 * アトラスを組み立てる。失敗したら `null` を返すだけで、例外は投げない
 * （素材が無くても表現が止まらないようにするため）。
 */
export const loadPrismAtlas = async (
  config: PrismAtlasConfig,
): Promise<PrismAtlas | null> => {
  try {
    const response = await fetch(config.manifestUrl);
    if (!response.ok) return null;
    const manifest = (await response.json()) as Manifest;
    const base = typeof manifest.basePath === 'string' ? manifest.basePath : '';
    const entries = Array.isArray(manifest.textures) ? (manifest.textures as ManifestEntry[]) : [];
    if (entries.length === 0) return null;

    const images = await Promise.all(
      entries.map((entry) => loadImage(`${base}${String(entry.file ?? '')}`)),
    );

    const columns = Math.max(config.columns, 1);
    const rows = Math.max(Math.ceil(images.length / columns), 1);
    const canvas = document.createElement('canvas');
    canvas.width = columns * config.cellPixels;
    canvas.height = rows * config.cellPixels;
    const context = canvas.getContext('2d');
    if (!context) return null;
    // 素材は黒背景。マスの隙間も黒でないと、縁のフェードが効いても継ぎ目が光る。
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    images.forEach((image, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      context.drawImage(
        image,
        column * config.cellPixels,
        row * config.cellPixels,
        config.cellPixels,
        config.cellPixels,
      );
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    // マスをまたいで滲まないよう、繰り返さずに端で止める（UV 側でも内側へ寄せる）。
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    const tiles: PrismTile[] = entries.map((entry, index) => ({
      id: typeof entry.id === 'string' ? entry.id : `tile-${index}`,
      role: typeof entry.role === 'string' ? entry.role : 'unknown',
      weight: typeof entry.weight === 'number' && entry.weight > 0 ? entry.weight : 1,
    }));
    return { texture, columns, rows, tiles };
  } catch {
    return null;
  }
};
