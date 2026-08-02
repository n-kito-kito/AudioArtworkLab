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
| Light Element | 固有の形状を持つ素材 | Fragment、Ray、手続きCore |
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

---

## 6. 現在地: Haze Study

`src/expressions/LightUnified2.ts` に、未コミットのHaze Studyが追加されている。

- `Static`: 音なしで形を見る
- `Audio volume`: 形・位置・色を固定し、Volumeで強度だけを追従させる
- `Off`: Hazeを除外する

これは正しい段階的検証である。ただし製品のController選択でも、全Style Preset共通の必須パーツでもなく、
D29の要素分離確認用UIである。
現時点でHazeへ漂流、色変化、Onset、Fragment、Bloomを追加してはいけない。

### Hazeの完了条件

- Staticで、膜・コアから独立した靄の形が確認できる
- Audio volumeで、靄の形を変えずに強度だけが追従する
- Offで既存の膜・コアが変化しない
- 再生停止後に黒へ戻る
- 実音ピークで白飛びせず、黒い余白を維持する
- ユーザーがStatic / Audio / Offの比較を目で確認する

---

## 7. Haze承認後の順序

1. Spatial構造の確認として、独立Coreを消し、Material Light Layerの重なりだけで白熱が成立するか検証する
2. この検証でHaze / Membraneを固定部品ではなくMaterial Light Layerの役割違いとして扱えるか判断する
3. Fragment / ParticleをDrift用の**静止部品だけ**として追加する
4. Fragmentへ**低速のFloat / Orbitだけ**を追加し、音にはまだ接続しない
5. VolumeまたはSustainを強度へ1本だけ接続し、Persistent Controllerの最小形を確認する
6. Spatial / DriftのStyle Presetをボタンで切り替える
7. 切り替えが安定してからクロスフェードを追加する
8. その後にReactive / Refresh / Ray / Twist / Cymatics連携へ進む

「すべての部品を完成してから動きを付ける」のではなく、1部品ごとに静止→最小の動き→音の順で完結させる。

---

## 8. 直近の実装指示

```text
Light Unified 2の未コミットHaze Studyから継続してください。

今回はHazeの検証だけを行い、新しい部品やControllerは追加しないでください。

1. Haze = Staticで音を止め、Haze単体の形が分かるスクリーンショットを撮る。
2. Haze = Audio volumeでpublic/audio/reference.wavを再生し、最も明るい場面のスクリーンショットを撮る。
3. Haze = Offで、既存のCoreとMembraneが変更前と同じであることを確認する。
4. 再生停止後に完全な黒へ戻ることを確認する。
5. lint / build、コンソールエラー、白飛び、黒割合を確認する。

見た目を独断で調整せず、Static / Audio volume / Offの比較と数値を報告して停止してください。
ユーザーの承認前にFragment、Ray、漂流、色変化、Bloom、Controller抽象化へ進まないでください。

既存の未コミット変更を保持し、LightUnified2.ts以外の無関係な変更を含めないでください。
public/dev-ref*.gifやユーザー音源はコミットしないでください。
```
