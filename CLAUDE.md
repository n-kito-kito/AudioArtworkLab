# CLAUDE.md

Audio Artwork Lab — 音楽に反応するジェネラティブアートの制作ツール（Vite + TypeScript + Three.js + Web Audio API）。

このファイルは**セッション開始時に自動で読まれる**前提で書かれている。再調査を避けるための地図であり、規約そのものは `AGENTS.md` と `AI_RULES.md` を参照する（重複させない）。

---

## 0. 設計は `DESIGN.md` が正

**方針・アーキテクチャ・音の写像・実装順序は [DESIGN.md](./DESIGN.md) に確定済み。作業前に必ず読むこと。**
以下はその要約と、コードベースの地図。

## 1. 設計方針の現状（2026-07-24 時点）

### 確定していること

- **「何でも作れるツール」にはしない。** 何でもできるようにすると After Effects / TouchDesigner の劣化版になる。作れる範囲を意図的に限定し、その中の質を上げる。
- 目的は「SNS 投稿を速く作る」ではない。**1 個のとびきり良いものを作るために、ツールから作る**という位置づけ。
- **恣意性を消す。** 人が「こうしよう」と意図した感じを出さない。作り手も理由が説明できない結果になるのが良い。音楽 → 数値 → 数式 → パターン という変換で生成する。
- 音楽が起点。
- **フラクタルは実装しない。** After Effects に標準であり、独創性がないと判断済み。
- 単なる ASCII 表現は面白くない。ひねりがある場合のみ検討する。
- **部品は表現から逆算する。Effect の数を増やすこと自体は目的ではない。**
  作りたい表現が先にあり、それを実現するために必要な Effect だけを実装する。
  不要な Effect は作らない。Asana の Effect 一覧（T5-E9〜E23）は、この基準で取捨選択する対象であって、消化すべきリストではない。

### 目指す表現

有機的な幾何学 / サイマティクス / 数式・数学的グラフィック / グラフ / 粒状のノイズ / グリッチ系ノイズ / 複雑なライティング・光 / 奥行き（平坦な 2D にしない）/ 生成が速いこと

### 操作フロー（3 段パイプライン・確定）

```
① 生成      音楽 → 数学的な幾何学パターン（サイマティクス）
                ↓
② 表現      閾値を調整 → 表現方法を選ぶ（ミニマルな図形 / 光と波 / グラフ）
                ↓
③ エフェクト  VHS ノイズ / 色のテーマ / 揺らぎ / 空間性・奥行き / トランジション
```

**①と②を分離することがこのプロダクトの核。** ①は図形ではなく**場（スカラー場）**を出力し、②が閾値で切って描画方法を選ぶ。同じ生成結果が、表現を差し替えるだけで別のグラフィックになる。

```
サイマティクス v(x,y) = cos(nπx)cos(mπy) − cos(mπx)cos(nπy)
  → ミニマルな図形 : |v| < 閾値 の節線を細線で描く
  → 光と波         : v を輝度にして光らせる
  → グラフ         : v の断面を折れ線で描く
```

**現状の Generator は生成と表現が一体**（`SineWave` は正弦波を計算してそのまま線で描く）なので、表現を差し替えられない。ここが最大の設計変更点。

### ③に必要な Effect（逆算結果）

| 要求 | 状況 |
|---|---|
| 色ズレ / 色ノイズ / スキャンライン / ピンボケ | RGB Split・Grain・Scan Drift・Blur で既存流用可 |
| トラッキングノイズ帯 / 下部ジッター / テープ劣化 | 不足。上記と統合し **VHS 1 個**にまとめる |
| 色のテーマ | Palette Map はあるが**横断概念への昇格**が必要 |
| 揺らぎ | Warp で充足 |
| 空間性・奥行き | 不足（①②側の課題でもある） |
| トランジション | 不足（最も重い。2 つの描画結果を合成する仕組みが要る） |

**新規に必要な Effect は実質 2〜3 個。** 本丸は①②の分離であって Effect の量産ではない。

### 主要な決定（詳細は `DESIGN.md` 5 節）

D1 デザインレイヤーはコメントアウトして温存 / D2 シェーダー合成を採用 / D3 Field 1 × Renderer 3 から / D4 音→パラメータは 3 層写像 / **D5 音楽なしでは動かさない** / D6 奥行きは場の側で作る / D7 トランジションは後回し / D8 Preset は v4 で後方互換を捨てる / D9 ブランチは継続

D4 と D6 は見え方を見ながら調整する前提。**それ以外を勝手に変えないこと。**

---

## 2. アーキテクチャ

```
src/
├── core/         Canvas, Renderer, Scene, Camera, AnimationLoop, App
├── generators/   素材（Line, SineWave, Waveform, Grid, Bitmap, Mosaic, Lissajous, ParticleField）
├── modifiers/    PixelStretch, GridReveal ※実体は Effect（後述）
├── effects/      質感（ポストプロセス）
├── compositions/ 組み合わせ
├── audio/        AudioEngine / FileAudioEngine / NullAudioEngine
└── ui/           Studio UI
```

### 押さえておくべき事実

- **Effect レイヤーだけが「増やせる」設計として完成している。** `BaseShaderEffect` + `parameterSchema` により、新規 Effect は 1 ファイルで UI・Audio Mapping・Preset 保存が自動で付く。
- **Generator にはパラメータ API がない。** `getParameters` / `setParameters` を持つのは `SineWave` のみ。他は `update()` 内に即値。左パネルの Generator セクションは Source を切り替えても常に `sineWave` を書き換える（＝ Lissajous 等は GUI で調整できない）。
- **`SineWaveBasic` が全 Generator・全 Effect をインスタンス化する神クラス**になっており、他の Composition はこれを継承して可視/有効フラグを変えているだけ。部品を増やすと全 Composition の起動コストが増える。
- **`modifiers/` の 2 つは `BaseShaderEffect` を継承した実質 Effect。** 「形を変える」Modifier レイヤーは実在しない。ROADMAP の Modifier 記述は実態と異なる。
- **カメラは `OrthographicCamera`**（`core/Camera.ts`）。現状このツールは完全に 2D。奥行き表現の手段は今はない。
- 音声解析は `volume / bass / mid / treble / beat` のみ。**BPM・曲構造の検出はない**（beat は音量の急増で代用）。

### 触るときに注意するファイル

| ファイル | 行数 | 注意 |
|---|---|---|
| `src/ui/LayerEditor.ts` | 1729 | 全体の約 3 割。動いているので不用意に触らない。全読みしない |
| `src/ui/StudioControls.ts` | 958 | 必要な範囲だけ `offset/limit` で読む |
| `src/effects/BaseShaderEffect.ts` | 307 | Effect 共通基盤。変更は全 Effect に波及 |

---

## 3. 新しい Effect を 1 つ追加する手順

これが最も頻度の高い作業。**既存ファイルを読み直さずにこの手順だけで書ける。**

1. `src/effects/XxxEffect.ts` を作る。`BaseShaderEffect` を継承し、`readonly name` を定義。
2. `super({ uniforms, vertexShader, fragmentShader }, { label:'Intensity', defaultValue, min, max, step })` を呼ぶ。`vertexShader` は `./shaders` の `vertexShader` を使う。
3. `src/compositions/SineWaveBasic.ts` の `this.effects` 配列に追加する。
4. `ROADMAP.md` の Phase 5 Effect セクションを更新する。

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

- 現行 **v4**（`src/ui/LabPreset.ts` の `LAB_PRESET_VERSION`）。保存対象は Field / Renderer / テーマ / 奥行き / Effect 状態（有効・パラメータ・Audio Mapping・順序）。
- **v1〜v3（旧 Generator 構成）との互換はない（D8）。** 旧形式は読み込み時に破棄して初期状態に戻す。migration は書かない。キーは旧版と同じ `audio-artwork-lab:studio-preset`。
- 自動保存は `main.ts`（1.5 秒間隔・変化時のみ書込）。Export / Import はツールバーから JSON ファイル。
- **Effect を `name` で同定している。** 複製機能を入れると同名が複数存在して破綻するため、その際は id 導入 + v5 が必須。
- 形式を変えたら必ずバージョンを上げる。v5 以降は v4 からの migration を追加する。
- 旧 `src/ui/StudioPreset.ts` は D1 で温存中の旧 UI 用。新コードから参照しない。

---

## 5. 検証とワークフロー

```bash
npm run lint
npm run build
```

- dev サーバーは `http://localhost:5173`（すでに起動していることが多い。**重複起動しない**）。
- **本番確認 URL: https://audio-artwork-lab.vercel.app/** — Production Branch は `agent/audio-reactive-mvp`。push すると自動デプロイされる。
- 作業ブランチ `agent/audio-reactive-mvp` / リモート `origin`（GitHub: n-kito-kito/AudioArtworkLab）。
- Asana プロジェクト「Audio Artwork Lab」でタスク管理。

`AGENTS.md` の完了条件（lint / build / 表示を壊さない / dispose / 責務を混在させない / 単独で有効無効化できる）に従う。未コミット変更は保持。force push・`git reset --hard`・既存変更の破棄は禁止。

---

## 6. トークンを節約するための運用ルール

コストの中心は生成量ではなく**毎ターン再送される文脈**。以下を守る。

- **セッションは短く切る。** 目安は 1 セッション = 1〜3 コミット。
- **スクリーンショットを検証の既定手段にしない。** 画像は非常に高コスト。`read_console_messages` と `javascript_tool` によるテキスト検証を基本とし、スクショは最終確認に絞る。
- **大きいファイルを全読みしない。** `grep` と `offset/limit` を使う。特に `LayerEditor.ts` と `StudioControls.ts`。
- **検証をまとめる。** 複数の Effect を書いてから lint / build を 1 回。コミットは機能単位で分ける。
- 既に確認済みの事実をこのファイルから読み、再調査しない。

### 外部（ChatGPT）へ切り出せる作業

リポジトリの文脈が不要なものは切り出してよい。**GLSL シェーダー本体の草案**、パラメータ設計案、要件文書の推敲など。渡す際は上記「シェーダーの規約」を制約として必ず添える。ファイル編集・git 操作・型の整合は Claude Code 側で行う。

---

## 7. ドキュメントの役割

| ファイル | 内容 |
|---|---|
| `PRD.md` | 何を・なぜ作るか（要求・非目標・品質基準・決定履歴） |
| `DESIGN.md` | どう作るか（設計・アーキテクチャ・音の写像） |
| `AGENTS.md` | 実務ガイド・Git 規約・完了条件 |
| `AI_RULES.md` | 設計原則・レイヤー責務・禁止事項 |
| `PROJECT.md` | 目的・設計思想・ビジョン |
| `ROADMAP.md` | 実装計画と進捗（新しい部品を追加したら更新する） |
| `RESEARCH.md` | 表現研究ノート |
