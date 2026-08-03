# Light Unified 2 — 表現・発光Controller設計

更新: 2026-08-03

この文書は、設計検討チャットと実装チャットの認識を揃えるための正本とする。
実装前に `HANDOFF.md` とあわせて読むこと。

---

## 1. 目標

Light Unified 2 は、共通する光の素材を使いながら、次の見え方を横断できる「光の楽器」とする。

- すべての見え方は共通の3D空間上に存在し、位置・奥行き・前後関係を持つ
- Spatial: Material Light Layerが空間内で変形・重畳し、白熱を生む
- Reactive: 音の立ち上がりに対して複数の光が瞬発する
- Lab2: 3D空間に常設する光学層の内容が短い周期で更新される
- Drift: 3D空間内でコア・点・ガラス片のようなFragmentが常在し、浮遊・旋回しながら強さを変える

Spatialという名称は「3Dであること」を占有する意味ではなく、素材の空間的な広がりと重畳を表す。
Reactive / Lab2 / Driftを2D平面上だけの表現として設計しない。

ただし、これらを1本のモードスライダーで無理に補間しない。
共通化するのは素材・連続パラメーター・発光強度の入力モデルである。
大元の表現方向はStyle Preset、存在方法はControllerとして分ける。

Style Presetは完成工程を固定するものではない。構造・時間状態・素材の成立方法が本質的に異なる場合だけ分ける。
パーツの有無やスライダー値の組み合わせだけでStyle Presetを増やさない。

### Seamless方針（2026-08-03更新）

Spatial / Reactive / Lab2 / Driftを固定された別Rendererとして選ぶことを最終形にしない。
完成度の高い各状態はPresetとして残すが、Presetは共通構造上の開始値・復帰点として扱う。
その間は少数の意味あるMacro軸で連続的に移動できるようにする。

- Core Presence: 素材の重なりによる白熱 ⇄ 明確な独立コア
- Spatial Spread: 中心への集中 ⇄ 3D空間への分散・重畳
- Persistence: イベントで現れて消える ⇄ 常在して漂う
- Renewal: 同じ光を維持 ⇄ 光学層を短い周期で更新

旧表現を丸ごと1本のMode値で変形しない。各Macro軸は1つの視覚的意味だけを持ち、
0・中間・1を順番に検証する。内部のEvent / Refresh / Persistent Controllerは分離したまま、
共通素材への寄与を連続制御する。

Recoveryは過去表現そのものを表示する比較基準として維持し、Macro軸の影響を受けない。
新しいPresetが崩れた場合に、ドナー本来の完成状態へいつでも戻って比較できるようにする。

`Start point`のSpatial / Reactive / Lab2 / Driftは、別Rendererへの切り替えではなく、
上記4軸を既知の座標へ戻すボタンとする。色、素材、個別レイヤー、Effectの値は変更しない。
4軸を手動で動かして開始座標から離れた状態は`Custom`と表示する。

- Spatial: 素材の重なりを中心に、3D空間へ広く分散する
- Reactive: 素材と独立コアを混ぜ、イベントで発生して消える
- Lab2: 独立コアを強くし、光学内容を短周期で更新する
- Drift: 光を常在させ、3D空間を漂わせる

開始地点は完成形の境界ではない。途中の座標へ動かすことで各性質の混成状態を作れる。
過去表現との厳密比較は引き続き`Development / Recovery`だけが担当する。

実装上の`Spatial Spread`は、イベントの起点に重なる状態を0、各Material Light Layerが
画面内の位置と奥行きを持って分散する状態を1とする。位置と奥行きだけを連続制御し、
Core Presence、光量、寿命、Bloomは変えない。旧`Anchor`の保存値は向きを反転して移行する。

実装上の`Persistence`は、Event Controllerの個体とPersistent Controllerの固定個体を
別々に維持したまま寄与量を混ぜる。0ではイベントごとに発生して消え、1では同じ個体が
ゆっくり漂いながら連続音量で明るさを変える。再生中の静かな隙間には低い光量を残すが、
長い無音または停止時は遅いReleaseで黒へ戻す。Event個体の寿命そのものは変更しない。

実装上の`Renewal`は、Persistent個体の位置・寿命・光量を維持したまま、素材番号、素材内の
切り取り位置、向きだけを更新する。0では同じ光学内容を維持し、1では最大8回/秒で更新する。
中間値は更新頻度だけを変え、Spatial SpreadやPersistenceの状態管理には影響させない。
Event個体はイベントごとに既に新しい素材を持つため、この軸による再更新は行わない。

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
  Spatial系（Reactiveは暫定的にここへ含む） / Lab2 / Drift
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
  Spatial系 / Lab2 / Drift
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

| Style Preset | 大元の方向性 | 主な組み立て | Controller | 状態 |
|---|---|---|---|---|
| Spatial系 | 空間的・素材重畳 | 3D空間内でMaterial Light Layerを変形・重畳し、重なりから白熱を創発させる。独立Coreは必須ではない | Event | 候補 |
| Lab2 | 光学層・高速更新 | 3D空間内にcurtain / beam / veilなどの光学層を常設する | Refresh | 候補 |
| Drift | 宇宙的・常在浮遊 | 3D空間内で常在する中心光とPoint / Fragment Fieldを浮遊させる | Persistent | 候補 |

Style PresetはControllerだけでなく、基盤となる組み立て方も選ぶ。
異なるStyle Presetを無理に同じ描画構造へ押し込まない。

#### Styleを分ける基準

次のいずれかが本質的に異なり、共通パラメーターだけでは安全に行き来できない場合にだけ、
別のStyle Presetとして追加する。

1. 光の存在・更新を管理する状態機械（生成して消える / 層を更新する / 同じ個体が常在する）
2. 光が成立する構造（素材の重畳 / 常設光学層 / 個体群の空間配置）
3. 同じ素材と近いパラメーターを与えても、明確に異なる見え方になること

CoreやFragmentを使うか、色・滲み・密度・寿命の値が違うだけなら、別Styleにしない。
それらは共通パラメーター、Elementの有効化、またはUser Presetとして扱う。

#### Reactiveの扱い

ReactiveはAAL内の重要な参照表現として残すが、現時点では独立Style Presetと確定しない。
Spatialと同じEvent Controllerを使い、見え方も連続しているため、まずはSpatial系の
Material Light Layer構成と反応設定の一バリエーションとして再現する。
今後、共通パラメーターでは再現できない固有の構造が確認できた場合だけ独立Styleへ昇格する。

2026-08-03のドナー比較では、SpatialとReactiveはいずれもEvent Controllerに属する一方、
Reactiveには`PrismaticBurstPlanner`がCore / Sheet / Haze / Rayをイベントごとに構成する固有処理が
確認された。これは独立Styleの確定理由にはせず、まずSpatial系で再現可能かを比較する対象とする。
Light Unified 2には旧Reactive Compositeを描き直さずRecoveryとして接続し、Spatial / Lab2と
排他的に見比べられる状態を残す。Recoveryの選択肢は開発用の比較機能であり、Style Presetではない。

#### Style PresetとUser Preset

- Style Preset: 数を絞った構造上の大分類。無闇に増やさない
- User Preset: Style、Element、Controller、各スライダー、Audio Mappingの調整結果。必要なだけ保存できる

表現の探索可能性は、Style Presetを無限に増やすのではなく、少数のStyleと多数のUser Preset、
自由なAudio Mappingの組み合わせによって確保する。

### Controllerの責務

Controllerとはユーザーが毎回選ぶ視覚素材ではなく、**光をいつ生成し、いつ更新し、いつ消すかを
管理する内部の時間構造**である。CoreやFragmentの描画方法ではなく、それらの存在時間を扱う。
当面はStyle Presetが適切なControllerを選ぶため、Controller名を通常UIへ直接並べない。

| Controller | 対応する見え方 | 光の存在方法 |
|---|---|---|
| Event | Spatial系（Reactiveを含む） | 音の出来事ごとに生成し、Attack / Hold / Decayで消す |
| Refresh | Lab2 | 光学層は維持し、素材・構成・フレームを短い周期で更新する |
| Persistent | Drift | 光を常在させ、漂流・旋回させながら強さを連続変化させる |

SpatialとReactiveの差は、まず同じEvent ControllerとMaterial Light Layerの範囲で検証する。
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

UIはアプリ全体の`DESIGN.md`に定める段階開示へ従う。Light固有では次の分類を使う。

- Common: 色、全体光量など、複数Styleで同じ意味と挙動を確認できた値
- Active Style: 選択中のStyleだけが持つ主要調整
- Elements / Advanced: Core、Fragment、Haze、Rayなどの詳細。既定では閉じる
- Development / Recovery: ドナー回収と分離確認用。製品UIから隔離し、既定では閉じる

共通らしい名前を持つだけではCommonへ昇格させない。複数Styleで同じ値を動かし、同じ意味で
破綻なく利用できることを確認してからCommonにする。

最初の共通候補として`Global Intensity`を接続する。値1では各ドナー本来の光量を維持し、
0..2をLab2 / Spatial / Reactive / Light Unified 2へ同じ相対倍率として渡す。
ドナー固有のExposure・Bloom・Element比率は変えない。手動操作で確認した後にのみAudio Mappingへ進む。

### ボタン／Presetにするもの

- 構造差が検証されたStyle Preset（現時点の候補はSpatial系 / Lab2 / Drift）

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

Style Presetは画像付きの選択肢を基本とし、名前を読む前に方向性を比較できるようにする。
Style同士の同時合成はLight Unified 2の初期完成範囲に含めない。まず1 Styleを選び、切替時の
短いクロスフェードだけを扱う。複数Styleの重ね合わせは、完成後にCompositionの機能として検討する。

---

## 4. 部品・動き・質感の境界

| 層 | 担当 | 例 |
|---|---|---|
| Material Light Layer | 画像素材を形として描く共有プリミティブ | Spatialのmacro、Reactiveのsheet / haze / anchor |
| Light Element | 固有の形状を持つ素材 | Fragment、通常Ray、手続きCore、Lab2 Cross Ray |
| Style Preset | 表現の大元の方向性と基盤構成 | Spatial系、Lab2、Drift |
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

### Reuse First — 過去の完成度を失わない

Spatial / Reactive / Lab2 / Light Tracesは、完成形としてそのまま復活させるPreset候補ではなく、
Light Unified 2へ素材・光学処理・動き・音反応を回収するための**ドナー**である。
既存コードで成立している光を同等の新規シェーダーで描き直さない。

回収では次の順を守る。

1. 過去表現の見た目と動きを比較基準として固定する
2. 既存の描画・素材選択・RGB分離・配置・時間処理を、見た目を変えずに再利用する
3. 新構造上で合成結果を再現する
4. 合成結果を常に確認できる状態を残したまま、責務ごとにElement / Controller / Modifierへ分離する
5. 複数のドナーで実際に重複した処理だけを共通化する
6. 既存資産で実現できない部分だけを新規実装する

コードの書き換えは許容するが、書き換え前より表現の完成度を下げた状態を新しい基準にしない。
Study単体の完成を積み上げることより、**全体の合成結果を失わずに責務を分けること**を優先する。

### 回収後の検証順

再利用した素材・Element・Style候補は次の順番で検証する。

1. 音なしの静止合成で、ドナーの特徴と光量を取り戻せているか確認する
2. Element表示を1つずつ切り、各責務だけが消えることを確認する
3. 手動値で安全範囲の最小・中央・最大を確認する
4. ドナーから回収した既存の動きを接続する
5. 既存のAudio Mappingを接続し、必要な部分だけ調整する
6. 実音のピーク、無音、別画角を確認する
7. スクリーンショットまたは短い動画を提示し、視覚的承認を得る

実装は戻せる単位でコミットする。ただし確認単位はCoreなどの孤立した部品だけでなく、
必要に応じて「Lab2由来の光学系を回収する」のような視覚的マイルストーンにまとめる。
Controllerの抽象化は、EventとPersistentの両方が単独で成立してから行う。

各マイルストーンの開始時には「今回行うこと / 今回行わないこと / 完了すると何ができるか」を示す。
完了時には「今回できたこと / 未接続のもの / 次の工程」を明示する。内部の細かなコミットごとに
ユーザー確認を要求せず、視覚的なまとまりで確認する。

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

## 6. 現在地: 共通空間の開始地点を確定する段階

2026-08-03時点で、過去資産のRecovery表示を保持したまま、共通描画構造へ
Core Presence / Spatial Spread / Persistence / Renewalの4軸を実装済みである。
Spatial / Reactive / Lab2 / DriftをRenderer切り替えではなく、4軸上の開始地点として置く工程、
Spatial / Lab2から回収した共通カラー構造、共通の光量と素材面積まで実装済みである。
現在フェーズは光素材の基盤を確定する段階、次フェーズは共通パラメーターへの
Audio Mapping接続である。旧Spatial固有のBloom / Exposureは素材へ焼き込まず、Effect側で扱う。

### 共通の光量と素材面積

旧Spatialの既定Intensity 2.2、旧Lab2の1.6に対してLight Unified 2が1.0だったため、
共通既定値を1.45へ引き上げる。Scaleは0.50から0.62、Core Sizeは0.40から0.48へ広げ、
色を過剰に濃くせず、素材が重なる面積と加算結果によって白熱を強くする。
Intensityの上限は2から3へ広げるが、新しいスライダーは追加しない。
Recoveryのドナー描画値とSeamless 4軸の意味は変更しない。

### 共通のRGB分光

光全体へ単色Tintを一度だけ掛ける方式を完成形にしない。Spatial donorと同様に、prismAtlasの
素材固有色と、光の面内を連続して移動する波長勾配を割合で混ぜる。RGBごとの読み取り位置の差は
素材の線・縁へ細かな色収差を足す補助に留め、明確な赤・緑・青の三重線を主表現にしない。
Lab2 donorと同様に色を白へ少し戻し、独立Coreの焦点と複数層が重なる場所だけが白熱する。
音色から得るTintは分光の比率を浅く偏らせ、全面を同じ色へ置き換えない。
Saturation 0では白へ戻り、値を上げるほど素材色と連続分光が現れる。専用スライダーは増やさない。

### 回収・Studyの履歴

2026-08-03時点で、以下のStudyが個別に表示できる状態まで実装済みである。

- Haze Study
- Drift候補のFragment Study（Volumeで明るさだけを動かす段階を含む）
- Lab2 Core Study
- Lab2 Cross Ray Study（Coreから分離して検証する対象）
- Lab2 Fragment Study
- Spatial Material Anchor Study
- Spatial Fragment Study

ただし、コードが存在することを素材の完成とは扱わない。現在のStudyは新しい完成基準ではなく、
既存資産との比較・分離に使う開発用表示として扱う。今後は次の3状態を明確に区別する。

| 状態 | 意味 |
|---|---|
| Implemented | コードとして存在し、単独表示できる |
| Structurally Valid | Styleの構造原則と責務に合っている |
| Visually Approved | Referenceと比較し、ユーザーが見た目を承認した |

### 素材ごとの評価

| 素材 | 実装 | 構造 | 見た目 |
|---|---|---|---|
| Lab2 Core | Implemented | 独立Coreとして概ね妥当 | 現行の新規Coreを磨き続けず、旧Lab2の光学処理から回収して再評価する |
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

1. Origin ReferenceとSpatial / Reactive / Lab2 / Light Tracesを、光全体のドナー一覧として固定する
2. 旧Lab2の既存`lightOpticsMapping`と描画処理を使い、新構造上で旧Lab2相当の静止合成を取り戻す
3. 合成を保ったままCore / Cross Ray / Refraction・Veil / Fan・Spill / Haze・Curtainを表示分離する
4. 旧Spatialの素材重畳・3D配置・Burst・軌跡を同じ方法で回収する
5. ReactiveはSpatial系と比較し、共通パラメーターで再現できない処理だけを回収する
6. Light TracesからTrail / Feedbackの再利用可能部分を回収する
7. Driftは回収済みのCore / FragmentとPersistent Controllerを組み合わせ、不足する浮遊処理だけを新規実装する
8. 複数のドナーで重複が確認できた描画だけをMaterial Light Layer / Light Elementへ共通化する
9. 最後に、構造と状態機械が明確に異なる方向だけをStyle Presetとして確定する
10. 共通スライダーとAudio Mappingを接続し、User Presetで組み替えを保存できるようにする

Lab2は最初の回収対象であって、最終目的やPreset設計の中心ではない。
各ドナー名をそのままStyle Preset名にすることも前提にしない。
SpatialとReactiveのように構造が近いものは統合し、見た目や値が違うだけのPresetを増やさない。

---

## 8. 直近の実装指示

次は現行のLab2 Core Studyの微調整を停止し、旧Lab2の光学系を最初のドナーとして回収する。
旧`LightElementLab2`と`lightOpticsMapping`を完成基準にし、既存のプリズム素材、レイヤー生成、
RGB分離、3D配置、加算合成を再利用して、Light Unified 2内で旧Lab2相当の静止合成を表示する。

この段階では新しいCoreシェーダーを描き直さず、まず全体の光量・画面占有率・屈折感を取り戻す。
同時に、Core / Cross Ray / Refraction・Veil / Fan・Spill / Haze・Curtainを個別に表示切替できる
開発用のAssembly表示を用意する。CoreとCross Rayは別Elementのまま維持する。

既存のSpatial / Reactive / Drift候補、音反応、公開中の旧Lab2は変更しない。
1:1 / 16:9 / 9:16でAssembly全体と各Elementの確認画像を残し、旧Lab2との比較結果を報告する。
見た目の回収が確認できるまでは、Style Preset、Controllerの共通化、新しい動きの追加へ進まない。
