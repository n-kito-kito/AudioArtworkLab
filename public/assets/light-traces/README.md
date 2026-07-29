# Light Traces — Prismatic texture pack

Light Traces の光学的な膜・霧・回折線を、リアルタイム描画でランダム合成するための素材。
すべて 1024 × 1024 px、sRGB、黒背景の PNG。リファレンスの画素は使わず、新規生成した。

## Textures

| ID | Preview | Primary role |
| --- | --- | --- |
| `vertical-veil` | ![](./textures/prism-01-vertical-veil.png) | 細い縦光と膜 |
| `diagonal-fan` | ![](./textures/prism-02-diagonal-fan.png) | 斜めに開く分光 |
| `folded-ribbon` | ![](./textures/prism-03-folded-ribbon.png) | 曲線状のボリューム |
| `intersecting-membranes` | ![](./textures/prism-04-intersecting-membranes.png) | 奥行きの異なる交差膜 |
| `diffuse-haze` | ![](./textures/prism-05-diffuse-haze.png) | 広く薄い Haze |
| `filament-web` | ![](./textures/prism-06-filament-web.png) | 細い回折線の網 |
| `wide-wedge` | ![](./textures/prism-07-wide-wedge.png) | 広いプリズム扇 |
| `vertical-curtains` | ![](./textures/prism-08-vertical-curtains.png) | 複数の縦膜 |
| `broken-beams` | ![](./textures/prism-09-broken-beams.png) | 途切れた斜光 |
| `diffraction-wavefront` | ![](./textures/prism-10-diffraction-wavefront.png) | 曲線的な回折波 |

ランタイム用の一覧は [`manifest.json`](./manifest.json) を使う。

## Intended rendering

- `Texture.colorSpace = THREE.SRGBColorSpace`
- `THREE.AdditiveBlending`
- 1 イベントにつき 1〜3 枚を選び、全素材を同時に表示しない
- 回転、縦横比、スケール、反転、開始時刻を seed から決定する
- 色の素材なので通常は白で乗算し、音は opacity・露出・寿命を中心に動かす
- 黒浮きが見える場合は、加算前にごく低い輝度を `smoothstep` で落とす
- Bloom は素材の形を作るためではなく、明るい部分の最後の滲みとして使う

強い光でも常時表示せず、短い Attack、短い Hold、層ごとに異なる Decay で暗闇へ戻す。
