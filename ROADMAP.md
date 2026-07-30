# ROADMAP

Audio Artwork Lab を、音源に反応する Generative Art 制作環境へ育てるためのロードマップ。

実装は `AI_RULES.md` に従い、1 回の変更を 1 つの部品または小さな基盤機能に限定する。

**現在地: Phase 12（サイマティクス表現の完成度）。** Phase 0〜11 は完了、または
Phase 12 の構造整理で置き換え済み。以下の Phase 0〜11 は履歴として残している。
要求は `PRD.md`、実装の地図は `CLAUDE.md` を参照する。

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

1 表現 = 1 見え方（PRD D16）。まずサイマティクス 1 つの完成度を極める。
新しい模様より、境界のレンダリング品質を優先する（PRD D10）。
**サイマティクス単体の完成度は 2026-07-27 に一区切り（PRD §1 当面のゴール参照）。
ここからは表現の追加・VJ 実践・UI の主従合わせが並行ゴールになる。**

- [x] 構造整理 — Renderer 選択と Design タブを撤去し、表現単位の UI にする
- [x] 生成方式を Granular Plate Model（GPU 密度場シミュレーション）へ刷新（PRD D18）
- [x] 固有振動モードバンク（16 種）とスペクトル励起によるモード選択（PRD D19。?debug=1 で確認）
- [x] G1 チューニングモード — `?tune=1` で内部定数を調整し、確定値を `engine/tuning.ts` へ焼き込む
- [x] 砂の物理を実機構へ（移動度ベース・場の補間廃止・保存形フラックス。PRD D21）
- [x] V2 の分離基盤 — 表現カタログ（cymatics-v1 / v2）・Expression セレクト・Preset v6（旧データは V1）
- [x] V2 モードライブラリ — 自由端の正方形板の固有モード 18 種（Waller 近似・中央固定端・個体差。PRD D22）
- [x] V2 の質感を焼き込み（TUNING を版ごとに分離。V1 の値は据え置き）
- [x] V2 モード切替の跳ね上げ — 散ってから新しい節へ集まり直す（PRD D23。現在は切ってある）
- [ ] V2 の質感調整と V1 との比較評価 → どちらかへ収斂（D16 へ戻す）
- [ ] G1b 質感の確定 — 帯の太さ・粒・集積の速さを `?tune=1` で追い込み焼き込む
- [ ] G2 動き — 揺れ・モーフ速度・構図の引き直し頻度を決める
- [ ] G3 実楽曲での音反応 — L1〜L3 の効き方を実際の曲で調整する（移動窓の自動較正を含む。PRD D17）
- [x] 表現ごとの機能宣言に UI を合わせる — サイマティクスから奥行きスライダーを外す（PRD D25。Preset v7）
- [x] UI を理解できるところまで削る — フッター表記・FPS/解像度・Effect の Dry/Wet・Blend・Opacity・Audio Mapping を非表示（機能は温存。MTG 2026-07-27）
- [x] 動画書き出しを WebM から MP4 へ移行する（MediaRecorder の MP4/H.264 を優先し、非対応環境のみ WebM へフォールバック。PRD D25）
- [x] 表現セレクトの 2 段化 — ファミリー（Cymatics）を選び、版（V1/V2）はボタンで切替
- [x] ツールバーの整理 — 主 CTA を Record MP4 に。Export PNG はその左に控えめに配置
- [x] 画角 — 長方形の板として 7 比率に対応（1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3。PRD D26。Preset v9）
- [x] 反応マッピングの演奏 UI — Bass/Mid/Treble の励振ゲイン 3 本（PRD D24 案 1。Preset v8）
- [x] フルスクリーン出力 — Output ボタンで絵だけのポップアップを開き、第 2 画面でクリック → フルスクリーン
- [ ] UI の本設計 — **ユーザーが UI デザインを作成し、それをもとに実装へ反映する**フローで進める（2026-07-28 決定）。試作 3 案のうち案 1（Effect を引き出しに）が「曲の入れ方が分かりやすい」と評価。試作は `?ui=1|2|3` に温存
- [x] 左パネルの仕切り（旧レイヤーパネル用スプリッター）を撤去
- [ ] キーボードショートカット — 表現・テーマ・Effect の切替や反応の調整をキーで直感的に操作する。制約のあるツールだからこそ割当を固定できる（UI 本設計と合わせて設計。2026-07-28）
- Effect は絞り込まない（2026-07-27 決定）。現状の 14 個は全て残す。今後はむしろ各 Effect の詰め・細かい調整の方向
- [ ] G4 2 つ目の表現を追加し、表現の切り替え（トランジション）を作る
  - [x] 試作: Modular Pattern Field（`modular-v1`）— 円の重なりを偶奇で抜く段と、角丸セルのグリッド段を
        1 枚のフラグメントシェーダーで繋いだ表現。Spawn → Expand → GridMorph → RowCascade → Merge →
        Subdivide → FinalCluster → Clear の周期を CPU 側のフェーズ機械が音で進める。
        質感の定数は表現内の `MODULAR`（`TUNING` には混ぜない）。持つ機能は色のテーマと Restart cycle のみ
  - [ ] Modular の詰め — 周期の長さ（現状 1 周 10 秒前後）・90°回転の見え方・花型の抜きの読みやすさ
  - [x] 試作: Light Traces（`light-traces-v1`）— 黒い空間にオンセットで光源が生まれ、短い曲線移動が
        軌跡を残す表現。光源は CPU 側（最大 24 個・決定論ハッシュのみ）、軌跡は GPU の
        ping-pong Feedback Buffer（HalfFloat）で `feedback = previous * decay + emission`。
        表示は 1 - exp(-x) のトーンマッピング。Trail スライダーが decay だけを差し替えるので、
        点 → 線 → 帯 → 雲 をシミュレーションを止めずに行き来できる。
        表現ごとの調整つまみの仕組み（`LabExpression.getExpressionParams`。PRD D25）をここで追加した
  - [ ] Light Traces の詰め — テーマ非対応（黒背景固定）・表現つまみが Preset 未保存・軌跡の曲がり方
  - [x] 試作: Reactive Geometry（`reactive-geometry-v1`）— 黒い空間に線と幾何学図形が生まれ、育ち、消える表現。
        内部は 2 系統で、Line System は持続音・音程に反応する固定点数のリボン（Wave / Straight / Orbit /
        Freeform を CPU のパラメトリック関数で毎フレーム更新・最大 20 本）、Shape System はオンセットに反応する
        InstancedMesh 1 枚（Dot / Circle / Capsule / Bar / Ring をフラグメントの SDF で描き分け・最大 200 個）。
        目標密度はエネルギー履歴の蓄積（buildup）の単調増加関数で、満ちるとクライマックスとして
        一部または全部が消える。固定周期を持たない。
        表現つまみの仕組みを select（Mode / Line Type / Shape Type）と action（Clear / New Variation）へ拡張した
  - [ ] Reactive Geometry の詰め — Preset 未保存・消滅遷移中の線のにじみ・線種ごとの密度バランス
  - [x] 検証: Light Traces — Core Study（`light-core-study-v1`）— 音と光の因果関係だけを見るための
        実験表現。黒背景 + 白い Core のみで、位置は常に中央・サイズ固定・動くのは明るさだけ。
        onset の立ち上がりエッジ + 閾値 + クールダウンで発火し、Attack / Hold / Decay を
        秒で管理する（フレームレート非依存）。定数は `CORE_STUDY` に集約。
        既存の Light Traces とはコードも状態も共有しない
  - [x] 検証: Audio Feature Inspector（`src/ui/AudioInspector.ts`）— 左パネルの開閉セクション（既定は閉）。
        Volume / Bass / Mid / Treble / Onset Strength のメーターと、検出の瞬間だけ点く Onset ランプ。
        Core Study 選択中は開発用スライダーと直近 Core の値も出す
  - [x] 検証: Core Study の Onset を帯域別スペクトルフラックスへ置き換え（`BandFluxAnalyzer` / `OnsetGate`）。
        engine の onset（広帯域 Volume の差分）は、正規化 Volume が飽和する盛り上がりで発火が消え、
        持続音の上のハイハットも拾えなかった。`getSpectrum()` の生 FFT から帯域別に
        `Σ max(0, mag − prev)` を取り、ビン数で割って `max(bass, mid, treble)` で合成する。
        測る側（`BandFluxAnalyzer`）と決める側（`OnsetGate`）を分けてあり、
        局所適応閾値（方式 A）は `OnsetGate` の差し替えだけで入る。
        reference.wav の 15〜18 秒（旧方式は発火 0）で 6 発火を確認。FileAudioEngine は無変更
  - [x] 検証: 発火判定の局所適応（方式 A）。`OnsetGate` の差し替えだけで完結させ、
        `BandFluxAnalyzer` と表現本体は触っていない。閾値は直近 2.5 秒の窓から
        `max(absoluteFloor, 中央値 + k × (山の中央値 − 中央値))` で毎回作る。
        山（局所最大）だけを別に集めるのは、打撃が全フレームの数 % しかなく、
        どんな上側分位点でも疎な曲では打撃の下に潜ってしまうため。
        strength の局所正規化は別トグル。スペクトルを 0.3 倍に縮めた入力でも
        発火位置がフル音量と 57/60 一致（固定閾値は 60 → 8 に崩れる）
  - [x] 検証: Bass / Mid / Treble の独立 Onset 検出（**観察モード**）。合成 Gate から Core が
        生まれる仕組みは 1 行も変えず、`OnsetGate` を 3 本並走させて数えるだけ。
        同時発火の 5 分類（単独 3 種 / 2 帯域 / 3 帯域）と直近イベントを集計する。
        reference.wav 実測: 66 イベント中 3 帯域 48% / 2 帯域 33% / 単独 18% で、
        **81% が複数帯域**。ただしキックの 8.02 秒は bass+mid+treble でも
        treble の strength が 0.16 しかなく、同時発火の多くは打撃の漏れ込み。
        帯域ごとに Core を出すなら「最強帯域のみ」か「相対マージンで間引き」が妥当
  - [x] Core の発生源を帯域イベントへ切替。帯域 Gate の発火を 30ms の結合窓でまとめて
        1 打 = 1 イベントにし、**素のフラックスが最大の帯域**を選んで Core を出す
        （strength は帯域ごとに別々の参照値で正規化されるため帯域間で比較できない。
        明るさには従来どおり正規化後の strength を使う）。`relativeStrengthFloor`
        （既定 1.0 = 最強のみ）を下げると同時 Core が増える。合成 Gate は観察専用に反転。
        reference.wav は Core 60 個（結合前の帯域イベント 63 → 60）で、区間分布も従来どおり
  - [x] 検出処理を描画から分離（`src/engine/bandLightEvents.ts` の `BandLightEventDetector`）。
        帯域別フラックス → 帯域別 Gate → 結合窓 → 帯域選択までを 2D と 3D で共有する。
        抽出前後で 2D のイベント列は完全一致（合成シナリオのハッシュが一致）
  - [x] 試作: Light Traces — Spatial Study（`light-spatial-study-v1`）— 固定 PerspectiveCamera の
        3D 空間へ光を置く検証表現。**2D Core Study は回帰確認用に完全温存**。
        Core はカメラを向く板を InstancedMesh 1 ドローで描き、PointLight は使わない。
        位置は `SpatialPositionResolver` が音（シード・帯域・通し番号・重心）から
        決定論的に決め、カメラのフラスタムから逆算するのでどの画角でも画面外へ出ない。
        同時発光は最低距離を満たすまで引き直す。距離減衰は入れず遠近法だけで奥行きを見る
  - [x] Spatial Study を Mapping 層で組み直す（`src/expressions/spatialMapping.ts`）。
        発光の瞬間の音を `AudioEventSnapshot`（volume / 3 帯域 / 素の bandFlux /
        winningBand / centroid / onsetStrength / flatness / seed / eventIndex）で凍らせ、
        位置・明るさ・大きさ・色・速度・寿命・軌跡をここだけで決める。
        **RGB の比率は素の bandFlux から作る**（適応後の strength は帯域ごとに
        参照値が違うので比較できない）。明るさは onsetStrength だけが決めるので、
        音量が大きくても色が白へ飽和しない
  - [x] Spatial Study に大きさ・RGB・3D 移動・3D 軌跡・光学的質感を追加。
        軌跡は 3D の位置履歴（節 12 個）から作り、Core 本体と同じ InstancedMesh の
        後ろ半分として **1 ドロー**で描く。質感は核 / 中距離の滲み / 広く弱い散乱 /
        RGB の微小分離 / 距離のごく弱いコントラスト差を別々の定数で持ち、1 つずつ切れる
  - [x] Spatial Study の生成単位と色構造を作り替え（プリズム / レンズフレアのリファレンスに寄せる）。
        1 イベント = 1 Core → **Light Burst**（メイン 1 + サブ N が 5〜150ms ずれて連鎖）。
        発火閾値は表現ごとに倍率で緩められるようにし（2D は 1.0 のまま据え置き）、
        時間特性は Attack ほぼゼロ・Decay 175ms の瞬間的な点滅へ。
        色は **band→RGB を廃止し seed 由来の個別色**にして、白は加算の重なりで創発させる。
        サブは針 / スパーク / 短い弧の 3 形状（出やすさは帯域比率、細さは centroid、
        うねりの乱れは flatness）。**波形をそのまま光の形にはしない** — うねりは
        「まっすぐな光条は不自然」ぶんの微小な変形としてだけ使う
  - [x] Spatial Study の質感を「プリズムを通った光」へ寄せる（4 点）。
        ① **層の濃度** — 形ごとに 1 枚あたりの寄与を定数化（`SPATIAL_STUDY.layering`）。
        単層で白へ張り付かず、重なった段が読める濃さに落とした
        （実測: 同じスパークを重ねて 1 枚 60 → 2 枚 134 → 3 枚 184 → 4 枚 235）。
        ② **1 要素の内部の分光** — 色を RGB ではなく**色相 4 ストップ + 彩度 4 ストップ**で送り、
        フラグメントで補間する（`LightGradient`）。形式は放射状 / 放射状反転 / 軸方向 /
        軸直交 / 角度方向の 5 種を seed が選ぶ。ストップ数 2〜4・走る幅・折り返し・
        彩度の並び（白→色 / 色→白 / 一定）もすべて音由来の決定論ハッシュ。
        ③ **軸平面フラッシュを不均一な多角形へ** — 起動時に 5〜7 頂点の非対称多角形を
        12 種、**符号つき距離場**としてアトラスへ焼く（`src/expressions/polygonAtlas.ts`）。
        SDF なので 16 倍まで開いても輪郭が鋭いまま。縁のわずかなにじみは 0.5 の外側を薄く拾う。
        ④ **画面を貫く針（ray）** — 中心から垂直・水平（seed でわずかに傾く）へ、
        画面対角の 1.15 倍まで一気に伸びる極細の光。芯の太さは**画素で指定**するので
        奥行きや画角が変わっても 1〜2px を保つ。3 フレームで全長に達し、短い減衰で消える。
        強い打撃（onset ≥ 0.6）のときだけ 1〜3 本。
        いずれもインスタンス属性の追加だけで済ませ、**ドローコールは 1 のまま**
        （ピーク 38 インスタンス / バーストフレームの render は p95 0.3ms）。
        2D Core Study・`LightTraces`・`FileAudioEngine`・Effect は 1 バイトも触っていない
  - [x] Spatial Study に**プリズム質感素材（Macro layer）**を実装
        （素材は `public/assets/light-traces/`。実装指示は同梱の README / manifest）。
        1 バーストにつき**質感レイヤーを 1〜3 枚だけ**、Burst 全体を包む大きな板として置く
        （中の Spark / Needle / Ray へ個別に画像を貼らない）。
        **アトラス 1 枚（5×2 / 512px セル）+ Instancing で Draw Call は +1**。
        素材ごとの Material は作らず、素材番号・UV クロップ・回転・反転・比率・歪み・色を
        インスタンス属性で渡す（`src/expressions/prismAtlas.ts`）。
        素材は完成画像ではなく**輝度マスク**として読み、音から作った分光で再着色する。
        板の四角い輪郭は**円窓 + 多角形 SDF マスク**の二重で消し、多角形フラッシュは
        「硬い面」から質感レイヤーの外形マスクへ役割を移した。
        時間軸は Transient と分離 — Macro は 20〜160ms 遅れて開き、
        Attack 10〜80ms / Hold 40〜250ms / Decay 350〜1800ms（Bass・Sustain で長く、
        Treble 優勢で短く）。**黒へ戻る時間と細い光の芯・発光タイミングは維持。**
        発火は既存の `BandLightEventDetector` のまま（`AudioEngine.onset` は使わない）。
        `sustain` は検出層と共有する `AudioEventSnapshot` を汚さないよう
        `LightMappingSettings` 経由で渡す（2D Core Study のバイト不変を守るため）。
        実測: reference.wav 全編で 10 素材すべてが登場 / 同じ音・同じ seed で
        Macro layer のパラメーターが完全一致 / 帯域で素材の役割が偏る
        （Bass → parallel-curtains・wide-haze、Mid → curved-volume・caustic-fan、
        Treble → segmented-rays・fine-filaments）/ flatness 0.2→0.8 で歪み量が約 2.7 倍 /
        Bass+Sustain 高で Decay 1.31〜1.80s、Treble+Sustain 低で 0.25〜0.43s /
        画面の点灯率 p50 0.20・最大 0.78、最も明るい瞬間でも 12% 以上が純黒 /
        無音は完全な黒 / 60fps・Draw Call 16（うち質感レイヤーは 1）
  - [x] Spatial Study の「光の斬撃」からの脱却 — **主役を広い半透明の膜・Haze・回折線へ**。
        ① **太さ（thickness）を新設** — `LightShape.thickness` をインスタンス属性で渡し、
        頂点シェーダーが**軸と直交する方向へ実際に板を広げる**（長さを縮めるのではない）。
        `低 centroid 55% + Bass 比率 30% + Volume 15%` から作る。
        実測: Bass+低 centroid で Needle 2.20 / Arc 2.76 / Ray 芯 2.9px、
        Treble+高 centroid で 0.78 / 1.15 / 1.0px（約 2.8 倍の幅）。
        光条の伸びも 3.4→2.6 / 9.5→7.0 へ短くして斬撃感を弱めた
        ② **Macro layer を画面全体へ** — 大きさ 0.55〜1.25、1 バースト最大 4 枚、
        `macroOffsetSpread` は固定値をやめ `Volume + Sustain + Novelty` で 0.25〜0.80 を動かす。
        中心に主役を残しつつ 38% を周辺へ飛ばす Hybrid 配置
        ③ **中心と周辺の明るさ再配分** — mainScale 1.2→0.9、散乱 3.8→5.0 / 0.028→0.05、
        Bloom を threshold 0.22 / strength 0.92 / radius 0.48 へ。
        **Bloom で広げるのではなく Macro layer 自体に広い輝度分布**を持たせた
        ④ **横へ画面外まで抜ける Ray** — 発火敷居 0.6→0.45、最大 4 本、
        横に走る確率 0.68、長さ 1.15→1.30 倍。芯の太さは thickness と連動
        ⑤ **2D 感の解消（構造修正）** — Macro layer のカメラ正面固定をやめ、seed から
        決定論の法線を作って**接線・従法線から実 3D 平面として配置**。
        板のワールドサイズを深度で割るのもやめた（割ると遠近が相殺されて平面に見える）。
        Near 3〜6 / Middle 7〜12 / Far 13〜22 の 3 段へ分散し、手前ほど大きく明るい。
        実測: 画面に占める幅が 手前 1.21 / 中間 0.75 / 奥 0.50（半画面比）、
        傾き 13.8°〜64.4°、Bass・Sustain 由来の Z ドリフト 0.11〜0.48 単位/秒
        ⑥ **素材選択** — 帯域外の重み 0.28→0.12、**必ず 1 枚は Haze / Sheet 系**を確保。
        回転にも役割傾向（Curtain = 縦 / Segmented ray = 水平垂直 / Curved volume = 3D 傾斜強め）
        つまみを 4 本追加（Thickness / Macro spread / Depth / Horizontal rays）。
        **`disposed` を `setup` で戻す修正**も入れた — 表現を作り直すと素材が結び直らず
        Macro layer が黙って真っ黒になっていた。
        検証: 構成比は Macro 中央値 約 70%（実音源）、明るい画素（≥60/255）は中央値 6.6%・
        最大 26% で灰色の背景にはならない / 白飽和は最大でも画面の 0.6〜2.9% /
        無音は完全な黒 / Draw Call 16（増えていない）/ 60Hz 駆動で 1 フレーム p50 1.6ms・p90 3.6ms /
        画角 3 種・他表現の切替・2D Core Study のバイト不変を確認
  - [x] Spatial Study の中心・周囲を**ひとつのプリズム光**に統一（動画確認からの 4 点）。
        ① **中心も同じ質感レイヤーにする** — Burst ごとに原点へ
        **Prismatic Anchor** を 1 枚生成（`MacroLayerTraits.anchor`）。周囲の膜と
        まったく同じ Instanced draw・アトラス・分光・クロップ・多角形マスクを通り、
        大きさ 0.42 倍 / Attack 6ms / Hold 28ms / Decay 0.42 倍で先に消える。
        丸い Main Spark は主役から降ろし、size 0.3 倍・layering 1.2 → 0.55 の
        **ごく小さな白い芯**として残した（実測: main 0.32〜0.39 に対しサブは 0.09〜1.31）
        ② **斬撃感の除去** — 頂点シェーダーの sway を削除（フラグメントの bend
        0.22 → 0.08 だけ残す）。waviness 0.18/0.85 → **0.03/0.15**（旧比 17%）、
        弧の追加うねり倍率 1.6 を廃止、`needleAxisDeviation` 0.22 → 0.04
        （水平・垂直から **±7 度**）、Macro の UV 歪み 0.015/0.11 → 0.005/0.028。
        素材も curved 系から **layered-sheets / parallel-curtains / wide-haze /
        segmented-rays** 優先へ。実測: waviness 0〜0.146（平均 0.055）、
        軸のずれ 0〜7.17°（平均 3.36°）
        ③ **前後移動の廃止** — Transient の `velocity.z` を常に 0、Macro の drift を 0 にして
        `driftZ` の加算も削除。発生時の Near/Mid/Far 分布と 3D 法線・傾いた平面配置は温存。
        実測: 追跡した 58 層すべてで z が 1 フレームも動かない
        ④ **白飛びの抑制** — Macro の 1 枚ごとに**ソフトニー**
        `x / (1 + x/0.8)` を掛け、広い面が単独で内部 Bloom の敷居（0.22）を
        一斉に越えられないようにした。色相は変えないので、
        **違う色の層が狭い範囲で重なった場所だけ**が白へ寄る。
        実測（動画 5 秒相当の強打を含む区間）: 白飽和画素 **0**（16:9 / 9:16）、
        1:1 でも 1110px（0.08%）、最大輝度 246〜254、黒は 17〜51% 残る
  - [x] Spatial Study の膜に**面内のゆっくりした漂い**と**配置の偏り崩し**を入れた。
        ① **Membrane motion** — 発光の瞬間に Snapshot + seed で
        スクロール u/v・せん断・面内回転の速さを確定し、以後は**経過秒の純関数**として動かす
        （毎フレームの生の音響値は入れないので、音が揺れても軌道は変わらない）。
        動きは**面内だけ** — 面法線は変えず、Z 方向にもカメラ方向にも動かない。
        Sustain が長いほど大きく、Treble 優勢の短命な層はほぼ静止（×0.25）。
        実測（1 層の寿命あたり）: UV 変位 中央値 0.015 / 最大 0.150（クロップ座標）、
        面内回転 中央値 0.9° / 最大 6.8°。
        つまみ `Membrane motion`（0〜1）を追加し、**0 で完全静止**（画素差 0.00 で従来と一致）
        ② **anti-clustering** — 生きている層の画面正規化位置を直近 14 個まで覚え、
        近すぎる候補は**ハッシュ列の次の値**で最大 5 回引き直す（`Math.random()` は使わない）。
        中心の Anchor は対象外。
        実測（同一シナリオ 600 フレーム）: 重心が中央から 0.35 を超えたフレームの割合
        **21.2% → 11.6%**、3×3 象限の occupancy 変動係数 **1.73 → 0.90**、
        中央セルの占有率 **63.8% → 36.2%**。
        重心を中央へ引き戻す項も試したが、片寄りは改善せず散らばりだけ悪化したので入れていない
        検証: 決定論一致 / 発光後に音を大きく振っても軌道不変 / z は 1 フレームも動かない /
        無音 = 黒 / 白飽和 0（画角 3 種）/ Draw Call 16（増えていない）/
        1 フレーム p50 1.2ms・p90 2.0ms / 2D Core Study バイト不変
  - [x] 検証: Light Element Lab — リファレンスの光を一度に調整せず、
        **Core / Ray / Sheet / Haze / Prism / Depth / Envelope / Composite** の
        8 モードへ分解して固定条件で比較する独立表現。Expression の Version ボタンで
        即座に切り替えられる。Spatial Study の実装・状態は共有せず、安定している
        `prismAtlas` と 10 枚の素材、EffectPipeline だけを再利用した。
        Core / Sheet / Depth / Composite は同じアトラス・同じ分光シェーダーを通すため、
        中心だけ別の光に見える問題を起こさない。Ray は直線のみ、Depth は Near / Mid / Far の
        位置を固定して Z 方向へ移動させない。Envelope だけが 5 秒で
        Attack → Hold → Decay → Off を繰り返し、時間形状を単独評価できる。
        この段階では音へ接続しない。Composite の見た目を基準として採用した後に、
        各要素へ音響パラメーターを 1 関係ずつ接続する
  - [x] Light Reactive Lab — 静的な Light Element Lab の光学を**音イベント反応**へ進めた表現。
        Version ボタンで Trigger / Texture / Variation / Composite の 4 段を切り替える。
        データの流れは AudioEngine → `BandLightEventDetector` → `AudioEventSnapshot`
        → **`PrismaticBurstPlanner`（`reactiveBurst.ts`。音 → 見え方はここだけ）**
        → 各層 Envelope → 共通プリズム Shader（**1 ドロー**）→ 内部 Bloom → Effect。
        `LightReactiveLab` は Planner が返した値を描くだけで、AudioEngine を形や色へ直接入れない。
        **発生時にすべて固定する**のが芯 — 素材・色・クロップ・大きさ・太さ・位置・奥行き・
        傾き・寿命・構図タイプは発光の瞬間に確定し、以後変わるのは A/H/D の明るさ・
        発生時に決めた拡大・ごく弱い面内移動・素材内のスクロール / せん断 / 回転だけ。
        **Z 方向とカメラ方向へは動かさない**（実測: 追跡 149 層すべてで z が不動）。
        Stage 1 Trigger … Core のみ。立ち上がりで 1 回だけ発生し A/H/D で消える
        Stage 2 Texture … Core + Sheet を同じ seed・同じ基準色・同じ発生位置で。
          Core が先、Sheet は約 100ms 遅れて開き 1.68 倍長く残る。Ray はまだ出さない
        Stage 3 Variation … 構図タイプ 6 種（Vertical Veil / Diagonal Fan / Prismatic Cross /
          Depth Corridor / Wide Haze / Layered Membrane）と、素材・クロップ・比率・回転・反転・
          色相・グラデーション形式・Near-Mid-Far・傾き・A/H/D をイベントごとに変える。
          直近履歴で連続を防ぐ（実測: 構図・素材・角度・クロップ・色相帯の連続 0、
          同じ位置への集中 46% → 0%、左右比 22:7 → 17:12）
        Stage 4 Composite … Haze / Ray / Depth を追加。Wide Sheet は毎回必須、
          Haze は余韻と空気感、**Ray は強い onset（≥0.78）か Treble 優勢（≥0.62）かつ
          打撃が強い時だけ**・水平垂直基本・傾き ±0.07rad・同時 2 本まで（斬撃にしない）。
          白は異色の層の重なりだけで作り、1 枚では超えられない soft-knee を再利用。
          Bloom と Exposure は音量で直接動かさない
        検証: 4 モードすべて無音 = 完全な黒 / 決定論一致 / 白飽和 0（画角 3 種すべて）/
        Draw Call 15（層の数と素材の枚数に依らず 1 ドロー）/ 1 フレーム p50 0.2ms /
        表現を切り替えて戻しても Atlas が黒くならない / 既存の Light Element Lab と
        Light Spatial Study は比較用にそのまま残してある
  - [x] 検証: Light Element Lab 2 — **色を「1 つの光の R/G/B をわずかにずらして重ねる」
        （CRT 的構造）だけから作れるか**を見る 2 台目の実験室。V1（発光ごとに色相
        グラデーションを割り当てる方式）は無改変で温存し、比較対象として残す。
        Version ボタンで Core / Sheet / Haze / Ray / All を切り替える。**音へは繋がない**
        （静止画・要素分解で見え方だけを見る段階）。素材は作り直さず、V1 と同じ
        `prismAtlas` の 10 枚をそのまま輝度マスクとして使う。
        方式: 各要素の輝度マスクを**チャンネルごとに微小オフセットしたローカル座標で
        3 回評価**し（`elementMask(p ± dir·offset)`）、R/G/B 強度で合成する。
        オフセットは素材の UV だけでなく**窓と芯も含めた光ごと**動かすので、
        大きくすると 3 枚に分離する。インスタンスは増やさず **Draw Call 1**。
        分離方向は ① バースト中心から放射状 ② 要素自身の軸沿い（面は長辺、
        Ray だけは芯を横切る向き — 芯沿いは直線が自分に重なるだけで色が出ない）。
        色相グラデーションは既定 OFF で、比較用トグルでだけ V1 方式を被せられる。
        つまみ（開発ブロック）: R / G / B 強度・Channel offset（0〜0.5）・
        Offset direction・Channel decorrelation（0 で 3 チャンネル同一歪み）・Intensity・
        Hue gradient。
        実測（画素計測。彩度 ≥ 0.15 を「色付き」、3 チャンネル中 1 つだけが立つ画素を
        「分離」とした。全モード共通で **offset 0・decorrelation 0 は彩度ちょうど 0**）:
        色が出始める（色付き 10%）… Core 0.002 / Sheet 0.004 / Haze 0.004 /
        Ray 0.004（軸沿い）・0.011（放射状）
        内部まで色が回る（色付き 50%）… Core 0.010 / Sheet 0.013 / Haze 0.015 / Ray 0.017
        **目で明らかに色と見えるのは 0.03〜0.06**（平均彩度 0.36〜0.57）。
        画素計測はその 10 倍手前から色を検出するので、数値の立ち上がりを
        「見える境界」と読まないこと。
        3 分離が見え始める… Core 0.12 / Sheet・Haze 0.25 / Ray 0.3 以上
        白い芯は offset 0.05 くらいまで残り（Core: 白画素 13.9% → 6.6%）、0.25 でほぼ消える
        放射状は R が外・B が内を読むため**大きくすると全体が青芯・赤縁へ寄る**
        （Core 平均 RGB 102/102/102 → offset 0.5 で 1/42/167）。
        軸沿いは対称な平行移動なので**全体の色バランスは無彩色のまま**（59/61/60）局所だけ色が出る
        強度を偏らせるだけでも色は乗る（1/1/0.5 → 平均 91/91/47・彩度 0.49。
        光の広がりは不変で色だけが変わる）
        非相関だけでも色は出る（**幾何的なずれ 0 のまま**膜の内部に色の流れが出る。
        Sheet: 非相関 0.05 で色付き 15.6% / 0.2 で 56% / 1.0 で 90%。
        平均 RGB は 79/86/84 のままなので全体が染まるのではなく筋ごとに分かれる）
        V1 方式との比較（All・9:16）: グラデーション ON は平均彩度 0.66・白画素 0.7% で
        **芯まで染まる**。OFF（チャンネルのみ）は平均彩度 0.34・白画素 9.0% で
        **芯は白く残り、色はチャンネルが食い違う場所（縁と内部の筋）にだけ出る**
        検証: 決定論一致（同一設定で画素ハッシュ一致・表現を往復しても一致）/
        Draw Call 1（All の 5 層でも 1・三角 10）/ 1 フレーム p50 0.0ms・p90 0.2ms・
        最大 1.1ms（1342×754）/ rAF 間隔 17.3ms（≒60fps）/ 画角 3 種（1:1・16:9・9:16）
        すべて Draw Call 1・同じ色挙動 / コンソールエラー 0 /
        表現を往復しても geometries 1・textures 3 で増えない（dispose 完備）/
        極端な値（intensity 0・全 gain 0・offset 0.5 + 非相関 1）で NaN・黒画面なし /
        既存表現は無影響（Element Lab V1 Core / Composite・Reactive Lab Trigger /
        Composite・Spatial Study・Cymatics V1 をすべて再確認。音なしの表現は黒のまま）
  - [x] Light Element Lab 2 — **リファレンスの頂点フレーム 1 枚へ寄せる静止画修正**。
        連番フレーム分析で確定した「4 層の時間構造」をそのまま構造にした。
        ① **不動の骨格**（縦の細い線 + 横の帯 + 中央の十字。中央軸に固定で回転・移動・
        うねりなし）② **コアのエネルギー脈動**（膨らんで引く。**白へ到達してよい唯一の層**）
        ③ **周縁の一時的断片**（三角のヴェール片。**不規則さを担うのはこの層だけ**で、
        位置・大きさ・向きは決定論ハッシュ）④ **放射の扇**（高エネルギー時のみの閾値ゲート）。
        Version ボタンをこの 4 層 + All に再編した。
        設計思想は「多数の光を個別に動かす」のではなく
        **「固定された光学系に、音がエネルギーと波長を注ぎ込む」**。
        修正 4 点:
        1 **白の予算制** — 非コア層は天井（0.30）とチャンネル分離の**下限**
          （オフセット 0.02〜0.05 / 非相関 0.12〜0.30）を持ち、つまみを 0 にしても
          3 チャンネルが重なりきらない。実測: Skeleton / Fragment / Fan を単独表示すると
          **白画素 0・準白（min ≥ 235）も 0**。Intensity を最大 4.0 にしても 0 のまま。
          All の白 1074px は正規化 [0.473, 0.472]–[0.535, 0.524]（画面の 6.2% × 5.3%）に収まり、
          Core 単独の白の箱と一致する（白は全部コア由来）
        2 **奥行きの手がかり** — `depthCue(z)` の**1 本の式**だけで「遠いほど暗く・鈍く」。
          層ごとの個別調整はしない。鈍りはアトラスを 5 タップの平均で読む半径になる。
          実測（Depth probe で見かけの大きさと位置を保ったまま z だけ動かす）:
          z −5.07 → −14 で平均輝度 27.30 → 8.23（dim 0.965 → 0.30 と一致）、
          平均勾配 3.71 → 0.72。**どちらも単調減少**（勾配は減光ぶんの 1.15 より下なので、
          ぼけが独立に効いている）
        3 **構図** — 骨格と扇は中央軸に固定。断片だけが決定論ハッシュで散る。
          実測: 同 seed で画素ハッシュ完全一致（3 回）、seed 0 / 7 / 23 で別配置、
          **骨格は seed を変えても画素ハッシュ不変**
        4 **グローバル位相 H（1 変数）** — 各層は `spectrum(H + 層の小オフセット + 勾配)` で
          発色し、独立の色を持たない。分光は白へ 0.72 だけ寄せてある（光は「染まった白」で
          絵の具ではない。ここを浅くするとチャンネル分離の縁の色が波長の下から見える）。
          実測（円周平均色相）: H 0 → 0.875 で All 325° → 32° を**単調に一周**し、
          同じ H での 4 層の食い違いは **13〜35°**（層ごとの独立色は出ない）。
          画面内の色相の広がりは 0.025〜0.33（大半 0.13 未満）＝ 1 枚が 1 つの波長状態
        **音 → 見え方の対応は `lightOpticsMapping.ts` の 1 ファイルに集約**
        （`spatialMapping.ts` と同じ方式）。描画側は traits と uniform を受け取るだけで、
        シェーダーに音の前提も時間アニメーションも入らない（静止画なので時計を持たない）。
        次フェーズの配線口は `OpticsDrive` の 6 入力:
        音量（持続）→ skeletonLevel（0 で骨格ごと消えて黒 = D5）/ onset 強度 → corePulse /
        帯域イベント → fragmentEnergy / 強 onset 閾値 → fanGate /
        音色の持続値 → huePhase（補間せずイベント的に切替）/ 音由来のシード → seed
        検証: 頂点フレーム（All・9:16）は黒 78.1%・白はコアだけ・平均彩度 0.60・
        色相ヒストグラムは 1 山（緑〜シアン）/ 画角 3 種すべて **Draw Call 1**（三角 22。
        層 11 枚でも 1 ドロー）・白は 3 種とも中央の箱に収まる（黒 78〜89%）/
        決定論一致（同一設定 2 回 + 表現往復で画素ハッシュ一致）/ 1 フレーム p50 0.0ms・
        p90 0.1ms・最大 0.3ms / rAF p50 8.8ms（120Hz 表示で追随。60fps 以上）/
        コンソールエラー 0 / 表現往復で geometries 1・textures 2 のまま（dispose 完備）/
        極端値（intensity 0・全 gain 0・intensity 4 + offset 0.5 + 非相関 1）で NaN・黒画面なし /
        **全ドライブ 0 + 扇ゲート閉で層 0 枚・黒 100%**（無音 = 黒の経路が通っている）/
        既存表現は無影響（Element Lab V1 Core / Composite・Reactive Lab Composite・
        Spatial Study・Cymatics V1・Modular V1 を再確認。数値は修正前と一致）
  - [ ] Light Element Lab 2 の次段階 — `OpticsDrive` の 6 入力へ実際の音を配線する。
        Bass / Mid / Treble → R / G / B の発色駆動、オフセット量と非相関量を
        どの特徴に結ぶか、H のイベント的切替をどの持続値で撃つかは未決
  - [ ] Spatial Study の次段階 — 空間の手掛かり（グリッドや床）/ カメラのゆっくりした動き /
        軌跡の太さを音へ結ぶか / バーストの自己励起（クラスター化）を入れるか
  - [ ] 同時発光時の位置設計（2D 側）— floor を下げると複数 Core が同じ centroid に重なる（未決）
  - [ ] band-demo.wav のハイハットを帯域制限する — 現状 `hatAt()` が無フィルタの白色雑音で、
        6〜12 秒の「Treble 単独」区間でも 3 帯域のフラックスがほぼ同値（0.325/0.307/0.309）。
        帯域の切り分け検証には高域だけに絞った音が要る
  - [ ] Light Traces — Core Study の段階的な音写像を検証する。
        発生 → 明るさ → 横位置 → 帯域別 Onset → 縦位置 → サイズ → 色 → 移動と軌跡、の順に
        1 関係ずつ追加する。帯域別 Onset 以降は Bass / Mid / Treble の独立した発光イベントを
        同時に生存可能にし、1 画面・1 発光へ制限しない。位置は純粋な `Math.random()` ではなく、
        音響特徴または音由来の決定論的シードを使い、同じ音で再現できる散らばりを目指す
- [ ] G5 リアルタイム入力（VJ）とパフォーマンス最適化

## 共通の完了条件

各実装タスクは、次の条件を満たして完了とする。

- `npm run lint` が成功する
- `npm run build` が成功する
- 既存の表示を意図せず変更していない
- Audio、Three.js、DOM のリソースを適切に破棄する（RenderTarget を含む）
- 表現・Effect の責務を混在させない
- 新しい Effect を単独で有効・無効化でき、無効時は元の表示を維持する
- 質感の数値は `TUNING` を経由させ、コード中に直接書かない
