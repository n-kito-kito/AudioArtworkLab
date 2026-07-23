# RESEARCH

Generative Art の **表現研究ノート**。

実装コードではなく、参考作品の分析と実装アイデアを記録するファイル。
新しい参考作品を見つけたら、テンプレートに沿って 1 セクション追加していく。

---

## テンプレート

以下をコピーして、新しい表現の研究セクションを追加する。

---

### 表現名

（例: リサジュー曲線 / CRT グリッチ / フローフィールド）

#### 参考作品

- 作者名 — 作品名（URL があればリンク）
- 作者名 — 作品名

#### 印象

- この表現から受ける視覚的・感情的な印象
- キーワード（例: レトロ、有機的、数学的、グリッチ）

#### 使われていると思われる技術

- 技術・手法の推定（例: リサジュー曲線、ポストプロセス、シェーダー）
- 使用されていそうなライブラリや手法

#### 実装アイデア

- Framework 内でどう実現するかのメモ
- パラメータ設計の案

#### Generator

- 必要な Generator（新規 or 既存）
- 素材として何を作るか

#### Modifier

- 必要な Modifier（新規 or 既存）
- どんな変形を加えるか

#### Effect

- 必要な Effect（新規 or 既存）
- どんな質感を与えるか

#### Audio との関係

- 音のどの要素（低音、高音、Beat 等）をどのパラメータにマッピングするか
- Audio なしでも成立するか

#### 今後の発展

- この表現から派生できそうなバリエーション
- 他の Generator / Effect との組み合わせ案

---

## 研究ログ

<!-- 以下、参考作品ごとにテンプレートを使って追加していく -->

---

### SineWave — 正弦波

> Framework の出発点。最初に実装した表現。

#### 参考作品

- （蓄積予定）

#### 印象

- 数学的、静謐、リズミカル
- oscilloscope（オシロスコープ）的な美学

#### 使われていると思われる技術

- 正弦関数による座標計算
- BufferGeometry の頂点更新
- LineBasicMaterial

#### 実装アイデア

- x 軸上の等間隔点に対し `y = amplitude × sin(frequency × π × x + phase)` を適用
- phase を時間で進めてアニメーション
- 256 セグメントで滑らかな曲線

#### Generator

- `SineWave` — 実装済み
- パラメータ: amplitude, frequency, speed

#### Modifier

- なし（単体で成立）

#### Effect

- なし（単体で成立）
- 将来: CRT を加えると oscilloscope 感が出る

#### Audio との関係

- amplitude ← 音量 / 特定周波数帯のエネルギー
- frequency ← ピッチ / 倍音構造
- speed ← テンポ / BPM

#### 今後の発展

- Lissajous への拡張（2 軸の sin 合成）
- Distort Modifier で波形を歪ます
- CRT Effect でモニター表示風に

---

<!-- 新しい研究はここに追加 -->

### 外部ストリーミング音源 — Spotify / Apple Music

#### 調査結果（2026-07-23）

- Spotify Web Playback SDK はブラウザ内再生と再生状態・メタデータ取得に対応するが、Premium アカウントと OAuth が必要。
- Spotify の公式ポリシーは、Spotify 音源とビジュアルの同期、および音源の改変を禁止している。このプロジェクトの音声解析・映像同期用途には適合しないため、Spotify 音源の直接解析は実装しない。
- Apple Music は MusicKit on the Web でカタログ検索とブラウザ再生に対応するが、Developer Token、Media ID、ユーザー認証が必要。
- Apple の公開 MusicKit API は再生制御とメタデータを提供する一方、Web Audio API に解析用 PCM を渡す公式 API は確認できない。DRM 音源の直接 FFT 解析は実装対象外とする。
- 外部サービス連携は、将来、利用規約に適合するメタデータ（曲名、再生位置、BPM 等）のみをパラメーターへ利用する方式を再検討する。

#### 公式資料

- https://developer.spotify.com/documentation/web-playback-sdk/
- https://developer.spotify.com/documentation/web-playback-sdk/reference
- https://developer.spotify.com/compliance-tips
- https://developer.apple.com/musickit/
- https://developer.apple.com/documentation/musickit
