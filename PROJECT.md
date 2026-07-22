# PROJECT

## このプロジェクトの目的

Audio Artwork Lab は、**Generative Art の研究・実験・制作を行うための Framework** である。

Three.js の学習用アプリではない。
1 つの作品を作って終わりでもない。

**表現の部品（Generator · Modifier · Effect）を蓄積し、組み合わせて作品（Composition）を生む** — そのための長期的な研究基盤を育てることが目的である。

---

## 完成形

Framework が mature したとき、こういう状態を目指す。

```
┌─────────────────────────────────────────────────┐
│                  Composition                     │
│  「LissajousRetro」「FlowFieldDream」…          │
│                                                  │
│  Generator → Modifier → Effect を束ねた作品      │
└─────────────────────────────────────────────────┘
         ↑              ↑              ↑
    ┌────────┐    ┌──────────┐   ┌─────────┐
    │Generator│    │ Modifier │   │ Effect  │
    │ 素材    │    │ 形を変える│   │ 質感    │
    └────────┘    └──────────┘   └─────────┘
         ↑              ↑              ↑
    ┌─────────────────────────────────────────┐
    │              Audio Engine                │
    │  FFT · Beat Detection · Parameter Map   │
    └─────────────────────────────────────────┘
```

- 新しい Generator を 1 つ追加すれば、使える素材が 1 つ増える
- 新しい Modifier を 1 つ追加すれば、変形の選択肢が 1 つ増える
- 新しい Effect を 1 つ追加すれば、質感の選択肢が 1 つ増える
- Composition を切り替えるだけで、別の作品が立ち上がる
- Audio がすべてのパラメータをリアルタイムに動かす

**表現ライブラリ** として、研究と制作の両方に使える状態。

---

## 設計思想

### 1. 表現の分離

各レイヤーは 1 つの責務だけを持つ。

| レイヤー | 責務 | やらないこと |
|---|---|---|
| Generator | 素材を作る | 変形しない、質感を付けない |
| Modifier | 形を変える | 素材を作らない、質感を付けない |
| Effect | 質感を与える | 素材を作らない、形を変えない |
| Composition | 組み合わせる | 描画ロジックを持たない |
| Audio | パラメータを供給する | 描画しない |

### 2. 組み合わせによる創発

単体では素材、変形、質感。
組み合わせると **作品** になる。

```
SineWave 単体     → 数学的な波
SineWave + CRT    → レトロモニターの波形
SineWave + Distort + Bloom → 歪んだ光
```

創発は Composition レイヤーで起きる。個々の部品はシンプルに保つ。

### 3. Audio は最後

まず **静止画でも成立する表現** を作る。
動きはパラメータ（amplitude, frequency, speed）で与え、
Audio 統合は表現が十分に蓄積されてから行う。

### 4. 小さく、実験的に

大きな設計を先に作らない。
1 Generator、1 Modifier、1 Effect ずつ追加し、
Composition で試し、RESEARCH.md に記録する。

### 5. 過剰な抽象化をしない

必要になるまで複雑にしない。
Three.js の標準 API を尊重し、Framework は薄い層に留める。

---

## なぜ Framework として開発するのか

### 作品単位では限界がある

1 作品を作るたびにコードを書き直すアプローチでは、
過去の表現を再利用できず、研究の蓄積が起きない。

### 部品化により研究が加速する

| アプローチ | 1 作品目 | 5 作品目 | 20 作品目 |
|---|---|---|---|
| 作品ごとに作る | 100% 新規 | 100% 新規 | 100% 新規 |
| Framework | 100% 新規 | 60% 再利用 | 20% 新規 |

Generator · Modifier · Effect が増えるほど、
新しい Composition の制作コストは下がる。

### 表現研究との相性

Generative Art は **参考作品の分析 → 技術の特定 → 実装 → 組み合わせ** のサイクルが核心である。

Framework はこのサイクルを RESEARCH.md → 実装 → Composition という流れで受け止める器である。

---

## 各レイヤーの役割

### Generator — 素材

画面に現れる最初の要素。
線、波形、粒子、パターン — 数学と幾何から生まれる。

- 例: `Line`, `SineWave`, `Lissajous`, `FlowField`
- インターフェース: `create()` `update()` `dispose()`

### Modifier — 形を変える

Generator の出力に対する変形操作。
素材の構造を変えるが、新しい素材は作らない。

- 例: `Distort`, `Mirror`, `Twist`, `Warp`
- インターフェース: `apply()` `update()` `dispose()`（将来定義）

### Effect — 質感

描画結果への後処理。
形は変えず、見え方 — 光、粒子、色、フィルムルック — だけを変える。

- 例: `CRT`, `Bloom`, `Grain`, `RGBSplit`
- インターフェース: `enable()` `disable()` `render()` `dispose()`

### Composition — 作品

Generator · Modifier · Effect を選び、順序を決め、1 つの Artwork を構成する。

- 例: `SineWaveBasic`, `LissajousRetro`
- 切り替えるだけで別作品になる

### Audio — 動き

音楽・音声からパラメータを生成し、すべてのレイヤーに配線する。

- FFT → 周波数帯ごとのエネルギー
- Beat Detection → リズム・パルス
- 将来: Composition ごとのマッピング定義

---

## 長期的なビジョン

### 短期（現在〜）

Framework の骨格を確立し、最初の表現（SineWave）で動作を確認する。
RESEARCH.md に参考作品を蓄積し始める。

### 中期

Generator · Modifier · Effect を順次追加。
Composition カタログが増え、表現の組み合わせ実験が活発になる。
Audio 統合を開始する。

### 長期

- Live Performance — 音楽とリアルタイムに連動する VJ / インスタレーション
- 表現カタログ — 数十の Composition からなる作品群
- 外部連携 — MIDI、OSC、Shader エディタ
- コミュニティ — Generator / Effect の外部贡献（将来）

---

## 関連ドキュメント

| ファイル | 内容 |
|---|---|
| [ROADMAP.md](./ROADMAP.md) | 表現ライブラリの育成計画 |
| [RESEARCH.md](./RESEARCH.md) | 表現研究ノート |
| [AI_RULES.md](./AI_RULES.md) | AI 開発ルール |
| [README.md](./README.md) | プロジェクト概要 |
