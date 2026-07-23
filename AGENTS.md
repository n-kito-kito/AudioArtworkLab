# AGENTS.md

このリポジトリで作業するエージェント向けの実務ガイド。
プロジェクト固有の設計原則は、作業前に `AI_RULES.md` と `PROJECT.md` を確認すること。

## Project

- Audio Artwork Lab は、Generator・Modifier・Effect を蓄積し、Composition で作品を構成する Generative Art Framework。
- 技術構成は Vite、TypeScript、Three.js。TypeScript の strict 設定を維持する。
- 責務の境界を守る。Generator は素材、Modifier は変形、Effect は質感、Composition は組み合わせ、Audio はパラメータ供給を担当する。
- 既存の表示や動作を意図せず変えず、必要な範囲に絞って実装する。

## Structure

- `src/core/`: 描画基盤
- `src/generators/`: 表現の素材
- `src/modifiers/`: 素材の変形
- `src/effects/`: ポストプロセスと質感
- `src/compositions/`: Generator・Modifier・Effect の構成
- `src/audio/`: 音声解析とパラメータ供給
- `src/ui/`: Studio UI

既存の命名と配置に従い、クラスは PascalCase、変数とメソッドは camelCase を使う。

## Workflow

1. `README.md`、`PROJECT.md`、`ROADMAP.md`、`AI_RULES.md` から変更の文脈を確認する。
2. 既存実装を調べ、変更範囲を最小限にする。
3. 新しい Generator・Modifier・Effect・Composition を追加した場合は、必要に応じて `ROADMAP.md` を更新する。
4. コミット前に次を実行する。

```bash
npm run lint
npm run build
```

UI や描画を変更した場合は、`npm run dev` で起動し、ブラウザで表示、主要操作、エラーオーバーレイの有無を確認する。
作業完了時は、ユーザーが明示的に不要と指定しない限り、変更を機能単位でコミットして現在のリモートブランチへ push する。
Vercel 連携後は、push 後に本番環境へデプロイし、デプロイ状態と公開 URL を確認する。

## Git

- ユーザーの未コミット変更を保持し、無関係な変更を勝手に含めたり破棄したりしない。
- `.env`、認証情報、生成物をコミットしない。
- force push、破壊的な Git 操作、Git 設定の変更を行わない。
- 1 つの実験・機能を 1 コミットにまとめ、変更内容が伝わる短いコミットメッセージを使う。
- 検証に失敗した変更は commit・push・deploy せず、原因を修正してから再検証する。
