# CLAUDE.md

Audio Artwork Lab — 音楽に反応するジェネラティブアートの制作ツール（Vite + TypeScript + Three.js + Web Audio API）。

このファイルは**セッション開始時に自動で読まれる**前提で書かれている。再調査を避けるための地図であり、規約そのものは `AGENTS.md` と `AI_RULES.md` を参照する（重複させない）。

---

## 0. 要求は `PRD.md` が正

**目的・非目標・品質基準・決定履歴（D1〜D21）は [PRD.md](./PRD.md) が唯一の正。作業前に必ず読むこと。**
`DESIGN.md` は Field × Renderer 期の設計文書で、**現在は歴史的資料**（D16 以降と食い違う）。
以下は PRD の要約と、コードベースの地図。

## 1. 設計方針の要約（2026-07-25 時点）

### 確定していること

- **「何でも作れるツール」にはしない。** 何でもできるようにすると After Effects / TouchDesigner の劣化版になる。作れる範囲を意図的に限定し、その中の質を上げる。
- 目的は「SNS 投稿を速く作る」ではない。**1 つの傑出した作品を生むために、ツールから作る**という位置づけ。
- **恣意性を消す。** 人が「こうしよう」と意図した感じを出さない。作り手も理由が説明できない結果になるのが良い。境界は「生成と閾値」で、像を結ぶのは音だけ（D17）。
- 音楽が起点。
- **フラクタルは実装しない。** After Effects に標準であり、独創性がないと判断済み。
- 単なる ASCII 表現は面白くない。ひねりがある場合のみ検討する。
- **部品は表現から逆算する。Effect の数を増やすこと自体は目的ではない。**
  作りたい表現が先にあり、それを実現するために必要な Effect だけを実装する。
  不要な Effect は作らない。Asana の Effect 一覧（T5-E9〜E23）は、この基準で取捨選択する対象であって、消化すべきリストではない。

### 目指す表現

有機的な幾何学 / サイマティクス / 数式・数学的グラフィック / 粒状のノイズ / グリッチ系ノイズ / 奥行き（平坦な 2D にしない）/ 生成が速いこと

**当面のゴールはサイマティクス 1 表現の完成度を上げること。** 表現を増やすのはその後。

### 操作フロー

```
① 生成      音楽 → 表現ごとの生成（サイマティクスではスペクトル → 固有振動モードの励起）
                ↓
② 表現      1 表現 = 1 見え方。持つ調整機能も表現ごとに宣言する（D25）
                ↓
③ エフェクト  VHS / 色のテーマ / 揺らぎ
```

**砂の物理（D21）が表現の核。** 板の加速度が重力を超えた場所で砂は跳ね上げられ、
節（振幅ゼロ）では跳ねないので止まって溜まる。すなわち **移動度 ∝ 振動振幅** で、
砂は慣性を持たない。**場の補間はしない**（モードは瞬時に切り替わり、
目に見える遷移は砂の再配置そのもの）。

### 主要な決定（全文は `PRD.md` §12）

**D1** デザインレイヤーは温存し UI から撤去 / **D5 音楽なしでは動かさない**（無音＝黒画面が正常）/
**D10** 境界は粒子密度で描く（線を引かない）/ **D13** モノクロ既定 / **D14** 恣意性の排除は
ジェネレーターに適用、Effect は調整可 / **D16 1 表現 = 1 見え方**（見え方の選択肢を出さない）/
**D17 楽器のモデル** — 範囲・感度は焼き込み内部定数、UI に出さない。ズームは開発用 /
**D18** Granular Plate Model / **D19** モードはスペクトル励起で選ぶ（単一支配周波数では選ばない）/
**D20** 表示中の図形は回転・波打ち・伸縮させない / **D21** 砂は移動度ベース・場は補間しない /
**D22** V2 を併置（V1 は完全温存・質感も版ごと）/ **D23** V2 はモード切替で砂が一度散る機構を持つ（模様は変形しない。現在はチューニングで切ってある）/
**D24 目的の再定義** — O/S の活動（イベントの VJ・音楽リリース）で使う映像を音から生み出す**自分たちの楽器**（配布物ではない）。VJ 中に触れるのは表現切替・テーマ・エフェクト+「音のどこにどれだけ反応させるか」。像そのものは音だけが決める /
**D25 共通原則と表現別方針の分離** — 全体を縛るのは非目標と恣意性の排除のみ。サイマティクス固有の方針（境界・状態変化・板・対称性）を全体方針として書かない。表現ごとに持つ機能を宣言（サイマティクスは色テーマのみ・**奥行きなし**）。動画書き出しは MP4 へ移行方針

**勝手に変えないこと。** 変える場合は PRD の決定履歴に追記する。

---

## 2. アーキテクチャ

```
src/
├── core/         Canvas, Renderer, Scene, Camera, AnimationLoop, App
├── expressions/  表現（CymaticsPlate: GPU 密度場シミュレーション。①場×②描画×③Effect を内包）
├── generators/   旧素材（未接続・温存）
├── modifiers/    PixelStretch, GridReveal ※実体は Effect（後述）
├── effects/      質感（ポストプロセス）
├── compositions/ 組み合わせ
├── audio/        AudioEngine / FileAudioEngine / NullAudioEngine
└── ui/           Studio UI
```

### 押さえておくべき事実

- **表現の本体は `src/expressions/CymaticsPlate.ts`。** 場（`fields/Cymatics.ts`）×
  砂の密度場シミュレーション × Effect チェーンを内包する。`compositions/` の旧クラス群は未接続。
- **V1 / V2 は `src/expressions/catalog.ts` で生成する（D22）。** V2（`fields/CymaticsV2.ts` +
  `engine/modeBankV2.ts`）は場だけを差し替えた表現で、V1 とは状態を共有しない。
  V1 の出力を変えないこと。収斂の判断が出るまで両方を温存する。
- **モード選択は `src/engine/modeBank.ts`。** FFT 全体からモード表（V1: 16 種 / V2: 18 種）の
  励起量を計算し、ヒステリシス + 確認時間 + 最短保持で主・副モードを決める。
  単一の支配周波数では選ばない。
- **質感の定数はすべて `src/engine/tuning.ts` の `TUNING`。** 直接値を書かない（4.5 節）。
- **Effect レイヤーは「増やせる」設計。** `BaseShaderEffect` + `parameterSchema` により、
  新規 Effect は 1 ファイルで UI・Audio Mapping・Preset 保存が自動で付く。
- **`generators/` `renderers/` `compositions/` は旧構成の残骸**（未接続・温存）。新コードから参照しない。
- 音声解析は 10 種（`volume/bass/mid/treble/beat/pitch/centroid/flatness/onset/sustain`）+
  帯域ごとのピーク追従自動較正。**BPM・曲構造の検出はまだない。**
- **開発ツール**: `?tune=1` チューニングパネル / `?debug=1` モード励起の可視化。本番ビルドには含まれない。

### 触るときに注意するファイル

| ファイル | 行数 | 注意 |
|---|---|---|
| `src/ui/LayerEditor.ts` | 1729 | 全体の約 3 割。動いているので不用意に触らない。全読みしない |
| `src/ui/StudioControls.ts` | 958 | 旧 UI。未接続で温存中。新コードから参照しない |
| `src/effects/BaseShaderEffect.ts` | 307 | Effect 共通基盤。変更は全 Effect に波及 |

---

## 3. 新しい Effect を 1 つ追加する手順

これが最も頻度の高い作業。**既存ファイルを読み直さずにこの手順だけで書ける。**

1. `src/effects/XxxEffect.ts` を作る。`BaseShaderEffect` を継承し、`readonly name` を定義。
2. `super({ uniforms, vertexShader, fragmentShader }, { label:'Intensity', defaultValue, min, max, step })` を呼ぶ。`vertexShader` は `./shaders` の `vertexShader` を使う。
3. `src/effects/catalog.ts` の `createEffects()` に 1 行追加する。
4. `ROADMAP.md` を更新する。

### シェーダーの規約（違反するとビルド時か実行時に壊れる）

- WebGL1 / GLSL ES 1.0。
- **`void main()` を必ず宣言する。** `BaseShaderEffect` が `effectMain()` に書き換えて Dry/Wet・Blend・Opacity のラッパーを被せる。宣言がないと例外を投げる。
- uniform 名は **`u` + パラメータ名の先頭大文字**（`intensity` → `uIntensity`）。この命名でスキーマと自動で紐づく。
- 必須: `uniform sampler2D tDiffuse;` と `varying vec2 vUv;`。
- `uTime` を宣言すれば毎フレーム経過秒が入る。`uResolution`（`THREE.Vector2`）を宣言すればリサイズが自動で反映される。
- 出力は `gl_FragColor`。極端な入力でも NaN・黒画面にしないよう `clamp` / `max` でガードする。

### 追加パラメータを GUI に出す

`parameterSchema` に `number` / `boolean` / `color` / `select` を追加するだけ。**`StudioControls` に Effect 固有のコードを書かないこと**（スキーマ駆動で自動生成される）。`number` には Audio Mapping（source / amount / min / max / smoothing / invert）も自動で付く。

---

## 4. Preset

- 現行 **v6**（`src/ui/LabPreset.ts` の `LAB_PRESET_VERSION`）。保存対象は表現 id（`expressionId`）/ テーマ / 奥行き / Effect 状態（有効・パラメータ・Audio Mapping・順序）。`TUNING` と zoom は保存しない。
- **v1〜v3（旧 Generator 構成）との互換はない（D8）。** 旧形式は読み込み時に破棄して初期状態に戻す。migration は書かない。キーは旧版と同じ `audio-artwork-lab:studio-preset`。
- 自動保存は `main.ts`（1.5 秒間隔・変化時のみ書込）。Export / Import はツールバーから JSON ファイル。
- **Effect を `name` で同定している。** 複製機能を入れると同名が複数存在して破綻するため、その際は id 導入 + 版上げが必須。
- 形式を変えたら必ずバージョンを上げ、直前版からの migration を書く（v4 → v5 → v6 は実装済み。v5 以前は `expressionId: 'cymatics-v1'` として読む）。
- 旧 `src/ui/StudioPreset.ts` は D1 で温存中の旧 UI 用。新コードから参照しない。

---

## 4.5 チューニング（質感の調整）

範囲・感度・質感の定数は `src/engine/tuning.ts` の `TUNING` に集約している。
`http://localhost:5173/?tune=1`（dev のみ）でパネルが出るので、音を鳴らしながら調整し、
`Copy values` で書き出して `tuning.ts` の**その版の**既定値へ転記して確定する。

**質感は版ごとに持つ（D22）。** V1 は `V1`、V2 は `V2_OVERRIDES`（V1 との差分だけ）に書く。
表現を切り替えると `applyTuning()` がその版の値を `TUNING` へ読み込む。
V2 の調整で V1 の見え方を変えないこと。

**質感の数値をコード中に直接書かないこと。** 必ず `TUNING` を経由させる。
本番 UI には出さない（PRD D17）。プリセットにも保存しない。

## 5. 検証とワークフロー

```bash
npm run lint
npm run build
```

- dev サーバーは `http://localhost:5173`（すでに起動していることが多い。**重複起動しない**）。
- **本番確認 URL: https://audio-artwork-lab.vercel.app/** — Production は **`main`** を追う。
  **作業ブランチへの push だけでは Preview しか作られず本番は変わらない。**
  本番へ出すときは `git push origin HEAD:main`（早送り）も行うこと。
  デプロイ状況は `gh api repos/n-kito-kito/AudioArtworkLab/deployments` の `environment` で確認できる。
- 作業ブランチ `agent/audio-reactive-mvp` / リモート `origin`（GitHub: n-kito-kito/AudioArtworkLab）。
- Asana プロジェクト「Audio Artwork Lab」でタスク管理。

`AGENTS.md` の完了条件（lint / build / 表示を壊さない / dispose / 責務を混在させない / 単独で有効無効化できる）に従う。未コミット変更は保持。force push・`git reset --hard`・既存変更の破棄は禁止。

---

## 6. トークンを節約するための運用ルール

コストの中心は生成量ではなく**毎ターン再送される文脈**。以下を守る。

- **セッションは短く切る。** 目安は 1 セッション = 1〜3 コミット。
- **スクリーンショットを検証の既定手段にしない。** 画像は非常に高コスト。`read_console_messages` と `javascript_tool` によるテキスト検証を基本とし、スクショは最終確認に絞る。
- **大きいファイルを全読みしない。** `grep` と `offset/limit` を使う。特に `LayerEditor.ts` と `StudioControls.ts`（どちらも未接続の旧 UI）。
- **検証をまとめる。** 複数の Effect を書いてから lint / build を 1 回。コミットは機能単位で分ける。
- 既に確認済みの事実をこのファイルから読み、再調査しない。

### 外部（ChatGPT）へ切り出せる作業

リポジトリの文脈が不要なものは切り出してよい。**GLSL シェーダー本体の草案**、パラメータ設計案、要件文書の推敲など。渡す際は上記「シェーダーの規約」を制約として必ず添える。ファイル編集・git 操作・型の整合は Claude Code 側で行う。

---

## 7. ドキュメントの役割

| ファイル | 内容 |
|---|---|
| `PRD.md` | 何を・なぜ作るか（要求・非目標・品質基準・決定履歴） |
| `DESIGN.md` | 旧 Field × Renderer 期の設計文書。**歴史的資料**（D16 以降と食い違う） |
| `AGENTS.md` | 実務ガイド・Git 規約・完了条件 |
| `AI_RULES.md` | 設計原則・レイヤー責務・禁止事項 |
| `PROJECT.md` | 目的・設計思想・ビジョン |
| `ROADMAP.md` | 実装計画と進捗（新しい部品を追加したら更新する） |
| `RESEARCH.md` | 表現研究ノート |
| `docs/other-spectrum-healthy-psychedelia-dossier.pdf` | O/S / Healthy Psychedelia 思想ドシエ（一次情報）。目的・体験設計はこの思想と接続する。確定語彙は置き換えない |
