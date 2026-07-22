# AI RULES

AI（Cursor Agent 等）が Audio Artwork Lab で作業する際に守るべきルール。

このプロジェクトは Three.js の学習用ではなく、**Generative Art Framework** である。
すべての変更は「表現ライブラリを育てる」という目的に沿うこと。

---

## 基本方針

### 既存コードを壊さない

- 動いている Composition の表示を意図せず変えない
- リファクタリング時は現在の表示が維持されることを確認する
- 破壊的変更はユーザーの明示的な指示がある場合のみ

### 小さく実装する

- 1 回の変更で 1 Generator、1 Modifier、1 Effect、または 1 Composition
- 大きな設計変更を一度に行わない
- 動く最小単位を作り、次のステップに進む

### 実験単位でコミットする

- 1 実験 = 1 コミット（ユーザーがコミットを依頼した場合）
- コミットメッセージは「何の表現を追加/変更したか」がわかるように

---

## レイヤーの責務

### Generator は素材だけ作る

- 線、波形、粒子、パターン — **画面に現れる最初の要素** を生成する
- 変形（歪み、反復、スケール）を Generator 内で行わない → Modifier に委ねる
- ポストプロセス（Bloom, CRT, Grain）を Generator 内で行わない → Effect に委ねる
- 1 Generator = 1 種類の素材

### Modifier は形を変えるだけ

- Generator の出力に対する変形操作（Distort, Mirror, Twist, Warp 等）
- 新しい素材を作らない
- 質感（光、粒子、色）を変えない → Effect に委ねる

### Effect は質感だけ担当する

- ポストプロセス、シェーダー、フィルムルック
- 形を変えない
- enable / disable で切り替え可能にする

### Composition は組み合わせるだけ

- Generator · Modifier · Effect を選び、順序を決める
- 描画ロジックを Composition 内に書かない
- 1 Composition = 1 作品のレシピ

### Audio は最後に統合する

- まず Audio なしで表現が成立することを確認する
- パラメータは Audio から上書き **可能** な設計にしておく
- AudioEngine の本実装は、表現が十分に蓄積されてから

---

## コード品質

### 過剰な抽象化をしない

- 必要になるまで抽象化しない
- 1〜2 行のヘルパー関数を作らない
- 将来の拡張を理由にした premature abstraction を避ける

### Three.js 標準を尊重する

- Three.js の API をそのまま使う（BufferGeometry, LineBasicMaterial 等）
- Three.js のラッパーを厚く作らない
- 既存の Core レイヤー（Canvas, Renderer, Scene, Camera）を尊重する

### 既存の規約に従う

- ファイル配置: `src/generators/`, `src/effects/`, `src/compositions/` 等
- インターフェース: Generator（create/update/dispose）, Effect（enable/disable/render/dispose）
- TypeScript strict モード、ESLint / Prettier 設定に従う
- 命名: PascalCase（クラス）、camelCase（変数・メソッド）

---

## ドキュメント

### ドキュメントを更新する場面

- 新しい Generator / Modifier / Effect / Composition を追加した → ROADMAP.md の該当セクションを更新
- 参考作品を分析した → RESEARCH.md にテンプレートに沿って追加
- 設計思想が変わった → PROJECT.md を更新
- ユーザーが明示的にドキュメント更新を依頼した場合

### ドキュメントを更新しない場面

- 内部リファクタリングで外部から見えない変更
- バグ修正
- ユーザーが「コードだけ」と指定した場合

---

## 禁止事項

- Three.js 学習用のデモコードやチュートリアル的な実装
- 1 ファイルに Generator + Effect + Composition を全部書く
- ユーザーの指示なく README / ROADMAP 以外のドキュメントを大量生成する
- `.env` や認証情報をコミットに含める
- git config の変更、force push、破壊的 git 操作

---

## 作業の進め方

1. ユーザーの意図を RESEARCH.md / ROADMAP.md / PROJECT.md の文脈で理解する
2. 変更範囲を最小限に絞る
3. 既存の表示・動作を壊さないことを確認する
4. `npm run lint && npm run build` で検証する
5. 必要に応じてドキュメントを更新する
