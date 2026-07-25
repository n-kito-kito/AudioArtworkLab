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
- [x] 波形データを取得する
- [x] Beat を検出する
- [x] 解析値を確認できるモニターを追加する

## Phase 3 — SineWave 音楽連携

- [x] SineWave のパラメーター API を追加する
- [x] 音声特徴を SineWave へマッピングする
- [x] 反応量、範囲、スムージングを調整可能にする
- [x] 無音・停止時の動作を整える

ここまでを最初の MVP とする。

**MVP 完了条件:** MP3 または WAV を読み込み、再生中の Bass / Mid / Treble に応じて SineWave の振幅、周波数、見た目が変化する。

## Phase 4 — GUI

- [x] 開閉可能な GUI 基盤を追加する
- [x] 左右の編集パネルを個別に開閉する
- [x] Audio パネルを作る
- [x] Generator パネルを作る
- [x] Modifier パネルを作る
- [x] Effect パネルを作る
- [x] プリセットを保存・復元する

## Phase 5 — 表現ライブラリ

### Generator

- [x] Waveform
- [x] Grid
- [x] Bitmap
- [x] Mosaic
- [x] Lissajous
- [x] ParticleField

### Modifier

- [ ] Warp
- [ ] Repeat
- [x] PixelStretch
- [x] GridReveal
- [ ] ScanDrift

### Effect

- [x] Grain
- [x] Blur
- [x] PaletteMap
- [x] Glitch
- [x] Halftone
- [x] Glass
- [x] RGBSplit
- [x] Bloom
- [x] Warp
- [x] ScanDrift
- [x] Repeat

表現の実装優先度は `Grain → Blur → PaletteMap → Repeat → Warp → ScanDrift → Glitch → PixelStretch → Glass` とする。

## Phase 6 — Effect Pipeline

- [x] EffectComposer を導入する
- [x] Effect をリアルタイムに有効・無効化する
- [x] Effect の適用順序を変更可能にする
- [x] Effect パラメーターへ音声値を接続する
- [x] Effect パラメータースキーマを導入する
- [x] Effect の各パラメーターへ Audio Mapping を設定可能にする
- [x] Effect の Dry/Wet・Blend Mode・Opacity を共通化する
- [ ] Effect チェーンの複製・グループ化・部分バイパスを追加する

## Phase 7 — Composition

- [x] ReactiveSineWave
- [x] ScanDriftWave
- [x] NeonGrid
- [x] MosaicField
- [x] GlitchSpectrogram
- [x] 実行中の Composition 切り替え

## Phase 8 — 保存と出力

- [x] 現在フレームを PNG 保存する
- [x] 設定を LocalStorage へ自動保存する
- [x] プリセット JSON を入出力する
- [x] Canvas と音声を WebM 録画する

## Phase 8.5 — デザインレイヤー

- [x] 画像を背景・素材レイヤーとして読み込む
- [x] 円、波形、テキストをキャンバスへ追加する
- [x] レイヤーを選択、移動、拡大縮小、回転する
- [x] 色、透明度、Blur、Contrastを調整する
- [x] レイヤーの重なり順を変更する
- [x] デフォルトの生成波形をレイヤーとして並べ替え・削除する
- [x] 各レイヤーを音声帯域とBeatへ反応させる
- [x] デザインレイヤーを含めてPNG出力する
- [x] レイヤー設定をLocalStorageへ保存する
- [x] テキストのフォント、ウェイト、行間を選択可能にする
- [x] 矩形、線、ポリゴン、自由描画を追加する
- [x] 複数選択、整列、グループ化を追加する

## Phase 9 — 外部音源

- [x] マイク・ライン入力に対応する
- [x] Spotify 連携の実現可能性を調査する
- [x] Apple Music 連携の実現可能性を調査する

Spotify と Apple Music は、認証、DRM、音声解析の可否、利用規約を調査してから実装範囲を決める。

## Phase 10 — 品質とパフォーマンス

- [x] FPS を表示する
- [x] 描画解像度倍率を設定可能にする
- [x] Effect ごとの GPU 負荷を計測する
- [ ] リサイズと音源交換の耐久テストを行う
- [ ] モバイルと Safari で動作確認する
- [x] WebGL Context Lost に対応する

## Phase 11 — Field × Renderer への再構築

`DESIGN.md` で方針を確定し、生成（① Field）と表現（② Renderer）を分離する構造へ作り直す。
Effect チェーン（③）と Audio、Core は流用する。

- [x] `engine/` — Field × Renderer のシェーダー合成
- [x] 音声解析の追加（dominant frequency / spectral centroid / flatness / onset / sustain）
- [x] Field: Cymatics へ L1・L2 写像を接続する
- [x] Renderer: ミニマルな図形の閾値を音へ接続する
- [x] L3 ハッシュ写像（音のスペクトル形状をシードにする）
- [x] Renderer: 光と波 / グラフ
- [x] 既存 Effect チェーンを接続する（LabControls: Field / Renderer 選択・スキーマ駆動 Effect UI・録画・品質モニター再接続)
- [x] VHS 統合 Effect / 色テーマの横断化
- [x] 奥行き → トランジション（多層の場 + Renderer 間リニアクロスフェード）
- [x] Preset v4（Field / Renderer / テーマ / 奥行き / Effect 状態の保存・復元。旧形式は破棄）

再構築後の UI は LabControls に集約した。旧 StudioControls・LayerEditor は D1 により未接続のまま温存し、
RecordingController・QualityMonitor は再接続済み。

## Phase 12 — サイマティクス表現の完成度

1 表現 = 1 見え方（PRD D16）。まずサイマティクス 1 つをとびきり良くする。
新しい模様より、境界のレンダリング品質を優先する（PRD D10）。

- [x] 構造整理 — Renderer 選択と Design タブを撤去し、表現単位の UI にする
- [ ] G1 静的な質感 — 粒・帯・黒レベルの基準値を決める（チューニングモード）
- [ ] G2 動き — 揺れ・モーフ速度・構図の引き直し頻度を決める
- [ ] G3 実楽曲での音反応 — L1〜L3 の効き方を実際の曲で調整する
- [ ] G4 2 つ目の表現を追加し、表現の切り替え（トランジション）を作る
- [ ] G5 リアルタイム入力（VJ）とパフォーマンス最適化

## 共通の完了条件

各実装タスクは、次の条件を満たして完了とする。

- `npm run lint` が成功する
- `npm run build` が成功する
- 既存 Composition の表示を意図せず変更していない
- Audio、Three.js、DOM のリソースを適切に破棄する
- Generator、Modifier、Effect、Composition の責務を混在させない
- 新しい表現部品を単独で有効・無効化できる
