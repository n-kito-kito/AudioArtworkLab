# Light Unified 2 — 表現・発光Controller設計

更新: 2026-08-03

この文書は、設計検討チャットと実装チャットの認識を揃えるための正本とする。
実装前に `HANDOFF.md` とあわせて読むこと。

---

## 1. 目標

Light Unified 2 は、共通する光の素材を使いながら、次の見え方を横断できる「光の楽器」とする。

- Spatial: 光が3D空間に発生し、奥行きを持って消える
- Reactive: 音の立ち上がりに対して複数の光が瞬発する
- Lab2: 常設する光学層の内容が短い周期で更新される
- Drift: コア・点・ガラス片のようなFragmentが常在し、浮遊・旋回しながら強さを変える

ただし、これらを1本のモードスライダーで無理に補間しない。
共通化するのは素材・連続パラメーター・発光強度の入力モデルである。
大元の表現方向はStyle Preset、存在方法はControllerとして分ける。

用語の考え方は次のとおり。

- Expression（Light / Cymatics）: それぞれ別の料理
- Style Preset（Spatial / Reactive / Lab2 / Drift）: イタリアン・フレンチ・和食のような大元の方向性
- Controller / Modifier: 煮る・焼く・流す・捩るなどの調理法
- 共通スライダー / Effect: 味付け・火加減・仕上げ

Style Presetは完成工程を固定するレシピではない。方向性を決めた後も、別系統の調理法や味付けを混ぜられる。
それでも基盤となるStyle Presetの性格は維持する。

### Origin Referenceと派生表現の関係

Light Unified 2の最上位リファレンスは、開発初期に共有されたKLSRの光表現動画群である。
Spatial / Reactive / Lab2は最上位の完成見本ではなく、Origin Referenceに含まれる性質を
AAL上で分解・探索する過程で生まれた派生表現として扱う。

```text
Origin Light References
  線 / 膜 / 帯 / ガラス片 / 屈折 / プリズム / 黒い余白
                    ↓
Light Unified 2の素材語彙
  Material Light Layer / Core / Cross Ray / Fragment / Haze / Ray
                    ↓
Style Preset
  Spatial / Reactive / Lab2 / Drift
```

評価は「SpatialやLab2をそのまま再現できたか」だけではなく、Origin Referenceの光学的な
素材感を保ちながら、異なるStyleへ展開できるかで行う。

---

## 2. 確定した構造

```text
共有する素材と表現語彙
  Material Light Layer / Fragment / Ray
                    ↓
Style Preset（ボタンで選択）
  Spatial / Reactive / Lab2 / Drift
                    ↓
発光Controller
  Event / Refresh / Persistent
                    ↓
共通スライダーとAudio Mapping
  位置 / 広がり / 滲み / 色 / 明るさ / 密度 / サイズ / 奥行き / 寿命 / 速度
                    ↓
Modifier・Effect
  Float / Orbit / Flow / Twist / Glow / Prism / Trail
                    ↓
Light Unified 2 Composition
```

Core / Membrane / Haze は、全Style Presetに必須の固定パーツではない。
同じMaterial Light Layerを、大きさ・切り取り・配置・寿命・重ね方によって異なる役割に使う場合がある。
Fragment / Rayのように形状自体が違うものだけを独立Elementとして扱う。

### Style Presetの責務

| Style Preset | 大元の方向性 | 主な組み立て | Controller |
|---|---|---|---|
| Spatial | 空間的・素材重畳 | Material Light Layerを変形・重畳し、重なりから白熱を創発させる。独立Coreは必須ではない | Event |
| Reactive | 瞬発的・音因果 | 素材由来のcore / sheet / hazeと、必要最小限の白い芯を組み合わせる | Event |
| Lab2 | 光学層・高速更新 | curtain / beam / veilなどの常設する手続き層を組み合わせる | Refresh |
| Drift | 宇宙的・常在浮遊 | 常在する中心光とPoint / Fragment Fieldを空間内で浮遊させる | Persistent |

Style PresetはControllerだけでなく、基盤となる組み立て方も選ぶ。
異なるStyle Presetを無理に同じ描画構造へ押し込まない。

### Controllerの責務

| Controller | 対応する見え方 | 光の存在方法 |
|---|---|---|
| Event | Spatial / Reactive | 音の出来事ごとに生成し、Attack / Hold / Decayで消す |
| Refresh | Lab2 | 光学層は維持し、素材・構成・フレームを短い周期で更新する |
| Persistent | Drift | 光を常在させ、漂流・旋回させながら強さを連続変化させる |

Spatial と Reactive は同じ Event Controllerを共有できる可能性が高いが、描画構造まで同じとは限らない。
Lab2 と Drift は寿命・状態管理が異なるため、Eventへ無理に統合しない。

### 発光強度は共通化する

Controllerが異なっても、明るさの入力モデルは共通にできる。

```text
最終強度 = Base + Continuous × 連続音量 + Event × 瞬発エンベロープ
```

- Event: Base ≈ 0、Eventを強くする
- Refresh: Baseは低〜中、更新時のEventを加える
- Persistent: Baseを持ち、Continuousで呼吸させ、Eventは任意で加える

無音時の扱いは既存のD5を維持する。Persistentは「再生中の音の隙間でも残る」という意味であり、
停止・無音が続けば緩やかに黒へ戻す。常時無条件に点灯させる意味ではない。

---

## 3. UIの原則

### ボタン／Presetにするもの

- Spatial / Reactive / Lab2 / Drift のStyle Preset

ボタンは映像を瞬時に差し替えるためではない。切り替え時は旧Styleと新Styleを短時間だけ
併存させ、明るさの総量を制限しながらクロスフェードする。

### スライダーにするもの

- 位置、Scatter、Anchor、広がり、奥行き
- 滲み、Softness、色、彩度、明るさ
- 密度、サイズ、寿命、速度、Fragment量
- Attack、Decay、Strobeなど、連続的に意味が保たれる時間値

### スライダーにしないもの

- 「生成して消える」と「同じ個体が存在し続ける」の補間
- 「毎イベント生成」と「毎フレーム素材を更新」の補間
- 複数の状態機械を1本のMode値で切り替える処理

これらは値の大小ではなく、状態管理そのものが異なるため。

---

## 4. 部品・動き・質感の境界

| 層 | 担当 | 例 |
|---|---|---|
| Material Light Layer | 画像素材を形として描く共有プリミティブ | Spatialのmacro、Reactiveのsheet / haze / anchor |
| Light Element | 固有の形状を持つ素材 | Fragment、通常Ray、手続きCore、Lab2 Cross Ray |
| Style Preset | 表現の大元の方向性と基盤構成 | Spatial、Reactive、Lab2、Drift |
| Controller | 存在時間と更新方法 | Event、Refresh、Persistent |
| Modifier | 形や位置の変化 | Float、Orbit、Flow、Twist |
| Effect | 最終的な質感 | Glow、Prism、Trail、Blur、Grain |
| Composition | 上記の組み合わせ | Light Unified 2 |

ねじれた光を作る場合、光やFragmentの位置そのものを曲げる処理は Twist Modifier、
完成画像だけを歪ませる処理は画面Effectとする。

Cymaticsと組み合わせる場合は、単純な重ね合わせだけでなく、節や線をFragmentの配置・光の流路として
利用できる。Cymaticsが構造を作り、Lightが発光として可視化する関係を優先する。

---

## 5. 安全な実装手順

各素材・Element・Style Presetは必ず次の順番で進める。

1. 音なしの静止状態で、単体の形を確認する
2. 手動値で安全範囲の最小・中央・最大を確認する
3. 最小限の動きだけを接続する（瞬発・持続・漂流のいずれか1つ）
4. Audio Mappingを1つだけ接続する
5. 実音のピーク、無音、別画角を確認する
6. スクリーンショットまたは短い動画をユーザーへ提示し、承認後に次へ進む

一度に複数のLight Element、Style Preset、Controller、Modifierを追加しない。
Controllerの抽象化は、EventとPersistentの両方が単独で成立してから行う。

パーツ分解は見た目と責務を理解するためのStudyであり、全Style Presetを同じパーツ構成に固定するためではない。
特にSpatialは、独立Coreを使わずMaterial Light Layerの重なりだけで白熱が成立する状態を必ず残す。

### Lab2 CoreとCross Rayの責務

Lab2の中心に見える白い焦点と、そこから水平・垂直へ伸びる十字光は、別Elementとして扱う。

| Element | 責務 | 単独で調整する値 |
|---|---|---|
| Lab2 Core | 中心の強い白い焦点と、その直近のごく小さなプリズム色 | サイズ、焦点の硬さ、輝度、色収差 |
| Lab2 Cross Ray | Coreに付随して見える水平・垂直の細い光 | 水平長、垂直長、太さ、輝度、減衰 |

CoreはCross Rayが無くても単独の光源として成立させる。Cross RayはCoreの形状へ焼き込まず、
表示・強度・伸びを独立して制御できる状態にする。これにより、Coreだけを残す、Cross Rayだけを
音へ接続する、Style PresetによってCross Rayを使わない、といった組み替えを可能にする。

---

## 6. 現在地: 静止素材の構造確認

2026-08-03時点で、以下のStudyが個別に表示できる状態まで実装済みである。

- Haze Study
- Drift候補のFragment Study（Volumeで明るさだけを動かす段階を含む）
- Lab2 Core Study
- Lab2 Cross Ray Study（Coreから分離して検証する対象）
- Lab2 Fragment Study
- Spatial Material Anchor Study
- Spatial Fragment Study

ただし、コードが存在することを素材の完成とは扱わない。今後は次の3状態を明確に区別する。

| 状態 | 意味 |
|---|---|
| Implemented | コードとして存在し、単独表示できる |
| Structurally Valid | Styleの構造原則と責務に合っている |
| Visually Approved | Referenceと比較し、ユーザーが見た目を承認した |

### 素材ごとの評価

| 素材 | 実装 | 構造 | 見た目 |
|---|---|---|---|
| Lab2 Core | Implemented | 独立Coreとして概ね妥当 | 十字光を含めず、白い焦点と画角別サイズを要調整 |
| Lab2 Cross Ray | Core内の描画から分離が必要 | Coreに付随する独立Element | 水平・垂直光を単独で調整・承認する |
| Lab2 Fragment | Implemented | prismAtlas由来で妥当 | Core調整後に合成を再評価 |
| Spatial Material Anchor | Implemented | 独立Coreなしで素材の重なりから白熱しており妥当 | 中央へ集中しており、空間的な広がりを要調整 |
| Spatial Fragment | Implemented | Anchorと同じ素材を使用しており妥当 | Anchor調整後に合成を再評価 |
| Drift Fragment | Study実装済み | Drift候補 | 素材・構造ともに未確定 |
| Haze | Study実装済み | 独立要素として確認可能 | 最終的なStyle内の役割は未確定 |

Spatialは独立Coreを持たず、Material Light Layerの重なりだけで白熱する構造を維持できている。
Lab2とSpatialのFragmentも万能の1種類へ統合せず、役割別に分けられている。

---

## 7. 次の実装順序

1. Lab2 Coreだけを静止状態で再調整する
   - 明確な白い焦点
   - 焦点の直近にだけ残る小さなプリズム色
   - 1:1 / 16:9 / 9:16で存在感が崩れないサイズ
   - 水平・垂直の十字光はCoreから除外する
2. Lab2 Core承認後、Lab2 Cross Rayを独立Elementとして静止状態で実装・調整する
   - 水平長、垂直長、太さ、輝度、減衰を独立して扱う
   - Coreの形状や輝度を変更しない
3. CoreとCross Rayの合成を確認する
4. 合成承認後、Lab2 Fragmentとの合成を再確認する
5. Spatial Anchor / Fragmentの空間的な広がりだけを再調整する
6. Lab2 / Spatialの静止素材が承認された後、重複するMaterial Light Layer描画を見た目を変えずに整理する
7. その後にDriftの静止素材を確定する
8. 各素材の承認後、1部品ずつ最小の動き、Audio Mappingの順で接続する

現時点ではFloat / Orbit / Style Preset / Controller / クロスフェード / 通常Ray / Twist / Bloomの
本格調整へ進まない。Lab2 Cross Rayは通常Rayとは別のLab2固有Elementとして段階的に扱う。
Lab2とSpatialを同時に調整しない。

---

## 8. 直近の実装指示

次はLab2 Core Studyだけを対象にする。既存のLab2 Fragment、Spatial、Haze、Drift候補、
音反応には触れず、静止Coreの白い焦点・焦点直近のプリズム色・画角別サイズだけをReferenceと比較する。
水平・垂直の十字光はCoreの完成条件に含めず、Coreから分離する。Cross Rayの見た目調整は
Core承認後の別コミットで行う。
変更前後を同じ画角で提示し、1コミットで停止する。
