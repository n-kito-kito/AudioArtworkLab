# Audio Artwork Lab

**Generative Art の研究・実験・制作を行う Framework。**

音楽からアートワークを生成する表現ライブラリを、長期的に育てるプロジェクト。

---

## 何を目指しているか

1 つの作品を作って終わりではない。

**Generator · Modifier · Effect という表現の部品を蓄積し、Composition で組み合わせて作品を生む** — そのための Framework を構築している。

```
Generator（素材）→ Modifier（形を変える）→ Effect（質感）→ Composition（作品）
                                                          ↑
                                                       Audio
```

新しい Generator を 1 つ追加すれば、使える素材が 1 つ増える。
Modifier を 1 つ追加すれば、変形の選択肢が 1 つ増える。
Effect を 1 つ追加すれば、質感の選択肢が 1 つ増える。

**表現ライブラリ** として、研究と制作の両方に使える状態を目指す。

---

## 現在の状態

Framework の骨格と最初の表現が動いている。

| レイヤー | 内容 |
|---|---|
| **Core** | Canvas, Renderer, Scene, Camera, AnimationLoop, App |
| **Generator** | `Line`, `SineWave` |
| **Modifier** | 設計済み（未実装） |
| **Effect** | インターフェース定義済み |
| **Composition** | `SineWaveBasic` — ゆっくり動く正弦波 |
| **Audio** | スタブ（NullAudioEngine） |

---

## 設計思想

| 原則 | 内容 |
|---|---|
| **分離** | Generator は素材、Modifier は形、Effect は質感 — 各レイヤーは 1 つの責務 |
| **組み合わせ** | 部品を増やし、Composition で創発させる |
| **Audio-ready** | すべてのパラメータは Audio から上書き可能（統合は後から） |
| **小さく実験** | 1 部品ずつ追加し、RESEARCH.md に記録する |
| **数学的美しさ** | 意図的な波形・パターンを優先する |

詳細は [PROJECT.md](./PROJECT.md) を参照。

---

## ドキュメント

| ファイル | 内容 |
|---|---|
| [PROJECT.md](./PROJECT.md) | プロジェクトの目的・設計思想・ビジョン |
| [ROADMAP.md](./ROADMAP.md) | 表現ライブラリの育成計画 |
| [RESEARCH.md](./RESEARCH.md) | 表現研究ノート（参考作品の分析） |
| [AI_RULES.md](./AI_RULES.md) | AI 開発ルール |

---

## 開発環境

```bash
npm install
npm run dev      # 開発サーバー起動
npm run build    # 本番ビルド
npm run lint     # ESLint
npm run format   # Prettier
```

Vite + TypeScript + Three.js

---

## プロジェクト構造

```
src/
├── core/           # Canvas, Renderer, Scene, Camera, AnimationLoop, App
├── generators/     # 素材（Line, SineWave, …）
├── modifiers/      # 形を変える（将来）
├── effects/        # 質感（CRT, Bloom, …）
├── compositions/   # 作品の組み合わせ
├── audio/          # Audio エンジン
└── main.ts
```

---

## License

Private
