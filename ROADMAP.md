# ROADMAP

Audio Artwork Lab を、音源に反応する Generative Art 制作環境へ育てるためのロードマップ。

実装は `AI_RULES.md` に従い、1 回の変更を 1 つの Generator、Modifier、Effect、Composition、または小さな基盤機能に限定する。詳細な担当・期限・進捗管理は Asana の **Audio Artwork Lab** プロジェクトで行う。

## 現在地

- [x] Core — Canvas, Renderer, Scene, Camera, AnimationLoop, App
- [x] Generator — Line, SineWave
- [x] Composition — SineWaveBasic
- [x] Audio — AudioEngine interface, NullAudioEngine
- [x] Effect — interface
- [ ] Modifier — interface と実装
- [ ] GUI
- [ ] 実音源の再生・解析

## Phase 0 — 基盤整理

- [x] ROADMAP.md を作成する
- [ ] 現在の SineWaveBasic の表示を基準画像として記録する
- [ ] App の終了処理を整備する

## Phase 1 — 音楽ファイル再生

- [x] AudioEngine の型を具体化する
- [x] FileAudioEngine を実装する
- [x] MP3 / WAV のファイル選択 UI を追加する
- [x] ドラッグ＆ドロップに対応する
- [x] 再生、一時停止、シーク、音量操作を追加する

## Phase 2 — 音声解析

- [x] 全体音量を解析する
- [x] Bass / Mid / Treble を解析する
- [ ] 波形データを取得する
- [x] Beat を検出する
- [x] 解析値を確認できるモニターを追加する

## Phase 3 — SineWave 音楽連携

- [ ] SineWave のパラメーター API を追加する
- [x] 音声特徴を SineWave へマッピングする
- [ ] 反応量、範囲、スムージングを調整可能にする
- [x] 無音・停止時の動作を整える

ここまでを最初の MVP とする。

**MVP 完了条件:** MP3 または WAV を読み込み、再生中の Bass / Mid / Treble に応じて SineWave の振幅、周波数、見た目が変化する。

## Phase 4 — GUI

- [ ] 開閉可能な GUI 基盤を追加する
- [ ] Audio パネルを作る
- [ ] Generator パネルを作る
- [ ] Modifier パネルを作る
- [ ] Effect パネルを作る
- [ ] プリセットを保存・復元する

## Phase 5 — 表現ライブラリ

### Generator

- [ ] Waveform
- [ ] Grid
- [ ] Bitmap
- [ ] Mosaic
- [ ] Lissajous
- [ ] ParticleField

### Modifier

- [ ] Warp
- [ ] Repeat
- [ ] PixelStretch
- [ ] GridReveal
- [ ] ScanDrift

### Effect

- [ ] Grain
- [ ] Blur
- [ ] PaletteMap
- [ ] Glitch
- [ ] Halftone
- [ ] Glass
- [ ] RGBSplit
- [ ] Bloom

表現の実装優先度は `Grain → Blur → PaletteMap → Repeat → Warp → ScanDrift → Glitch → PixelStretch → Glass` とする。

## Phase 6 — Effect Pipeline

- [ ] EffectComposer を導入する
- [ ] Effect をリアルタイムに有効・無効化する
- [ ] Effect の適用順序を変更可能にする
- [ ] Effect パラメーターへ音声値を接続する

## Phase 7 — Composition

- [ ] ReactiveSineWave
- [ ] ScanDriftWave
- [ ] NeonGrid
- [ ] MosaicField
- [ ] GlitchSpectrogram
- [ ] 実行中の Composition 切り替え

## Phase 8 — 保存と出力

- [ ] 現在フレームを PNG 保存する
- [ ] 設定を LocalStorage へ自動保存する
- [ ] プリセット JSON を入出力する
- [ ] Canvas と音声を WebM 録画する

## Phase 9 — 外部音源

- [ ] マイク・ライン入力に対応する
- [ ] Spotify 連携の実現可能性を調査する
- [ ] Apple Music 連携の実現可能性を調査する

Spotify と Apple Music は、認証、DRM、音声解析の可否、利用規約を調査してから実装範囲を決める。

## Phase 10 — 品質とパフォーマンス

- [ ] FPS を表示する
- [ ] 描画解像度倍率を設定可能にする
- [ ] Effect ごとの GPU 負荷を計測する
- [ ] リサイズと音源交換の耐久テストを行う
- [ ] モバイルと Safari で動作確認する
- [ ] WebGL Context Lost に対応する

## 共通の完了条件

各実装タスクは、次の条件を満たして完了とする。

- `npm run lint` が成功する
- `npm run build` が成功する
- 既存 Composition の表示を意図せず変更していない
- Audio、Three.js、DOM のリソースを適切に破棄する
- Generator、Modifier、Effect、Composition の責務を混在させない
- 新しい表現部品を単独で有効・無効化できる
