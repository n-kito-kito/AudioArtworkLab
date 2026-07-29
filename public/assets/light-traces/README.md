# Light Traces — Prismatic texture pack

Light Traces の光学的な膜・霧・回折線を、リアルタイム描画で音から合成するための素材。
すべて 1024 × 1024 px、sRGB、黒背景の PNG。リファレンスの画素は使わず、新規生成した。

## Core intent

この 10 枚は「完成した光を 10 パターンからランダム表示する」ための画像ではない。
Shader が無数に近い光イベントを組み立てるための**基礎質感**として使う。

- 素材 1 枚を未加工のまま全面表示しない
- 1 イベントを、独立した変形と時間特性を持つ 1〜3 レイヤーで構成する
- 素材選択・変形・色・寿命は、`Math.random()` ではなく発光時の音響 Snapshot と
  音由来の決定論的 seed から決める
- 同じ音と seed なら同じ光を再現できる一方、イベントごとの連続パラメーターによって
  10 枚の見た目へ固定されない構造にする

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
- レイヤーごとに UV クロップ、回転、縦横比、スケール、反転、開始時刻を seed から決定する
- Shader のノイズで UV と表示マスクをわずかに歪ませ、同じ素材でも輪郭と濃淡を変える
- 素材の輝度をマスクとして読み、音から作ったグラデーションで再着色する
- 元の分光色は固定色として使わず、音由来の色と混ぜる割合を調整可能にする
- 黒浮きが見える場合は、加算前にごく低い輝度を `smoothstep` で落とす
- Bloom は素材の形を作るためではなく、明るい部分の最後の滲みとして使う

強い光でも常時表示せず、短い Attack、短い Hold、層ごとに異なる Decay で暗闇へ戻す。

## Audio-driven variation

発光時に音響値を Snapshot として固定し、その光が消えるまでは個性を保つ。
生の音響値を毎フレーム直接入れて、色や形を細かくちらつかせない。

| Audio feature | Texture / Shader mapping |
| --- | --- |
| Onset | 新しい光イベントの発現 |
| Onset strength | 明るさ、スケール、レイヤー数 |
| Bass | `wide-haze` / `wide-caustic` / `parallel-curtains`、広さ、長い Decay |
| Mid | `curved-volume` / `layered-sheets`、曲がり、膜の重なり |
| Treble | `fine-filaments` / `segmented-rays`、細さ、短い Decay |
| Spectral centroid | グラデーションの基準色、RGB 分離幅 |
| Spectral flatness | UV 歪み、欠け、粒状性 |
| Volume / sustain | Haze の濃度、余韻 |
| Audio seed + event index | 素材、位置、回転、反転、UV 範囲 |

基本の Shader 合成順は
`texture sample → luminance mask → audio gradient → procedural mask / UV warp → envelope → additive blend`
とする。
