# 設計

## 方針

- **リアルタイム経路はローカルで完結**させる。カメラ映像 → MediaPipe → 座標化 → ソルバー → VRM 描画は
  毎フレーム（30〜60 fps）ブラウザ内で処理し、ネットワークを待たない。
- **Gemini は「遅いが賢い」並列ループ**として使う。表情・ジェスチャー・背景・小道具・外見・声といった
  意味的な判断を担当し、結果はイベントとしてリアルタイム経路に合流させる。Gemini が止まっても
  トラッキングは止まらない。
- 各段は**差し替え可能なインターフェース**で区切り、機能追加はプラグインとして行う。

## リアルタイム経路（ブラウザ）

```
FrameSource ──▶ TrackerHost ──▶ CoordinateSpace ──▶ MotionSolver ──▶ MotionSmoother
(カメラ/動画)    (Pose→Face→Hands)  (座標化・ミラー・      (Body/Face/Hand)    (One Euro・
                                   キャリブレーション)                         アイドル復帰)
                                                                              │
          AvatarRig ◀── Plugin.update ◀── GestureLayer ◀── ExpressionMixer ◀──┘
          (VrmAvatar)    (小道具など)      (頷き・手振り・呼吸) (追跡表情 + AI ヒント + 口パク)
```

| 段 | ファイル | 入力 → 出力 |
| --- | --- | --- |
| 0. 取得 | `src/capture/FrameSource.ts` | カメラ / 動画ファイル → `HTMLVideoElement` |
| 1. 検出 | `src/tracking/*` | 映像 → `TrackingFrame`（顔 478 点＋52 ブレンドシェイプ＋変換行列、姿勢 33 点、手 21 点×2） |
| 2. 座標化 | `src/coords/CoordinateSpace.ts` | カメラ座標 → アバター座標 `AvatarSpaceFrame`（+X=アバターの左、+Y=上、+Z=視聴者側） |
| 3. 解決 | `src/solver/*` | アバター座標 → `MotionFrame`（VRM 正規化ボーンのローカル回転＋表情） |
| 4. 平滑化 | `src/solver/MotionSmoother.ts` | One Euro フィルタ、見失った骨はアイドル姿勢へ戻す |
| 5. 合成 | `src/avatar/ExpressionMixer.ts`, `GestureLayer.ts` | AI ヒント・口パク・ジェスチャーを重ねる |
| 6. 描画 | `src/avatar/VrmAvatar.ts`, `src/render/Stage.ts` | three-vrm の正規化ボーンへ適用し描画 |

### 座標化の要点

- MediaPipe のカメラ座標（x=画像右、y=下、z=奥）からアバター座標へは、非ミラー時は X 軸まわりの
  180° 回転 `(x, -y, -z)`。ミラー時はさらに X を反転し、左右の名前（ボーン・ブレンドシェイプ・手）を
  入れ替える。
- 頭の回転は FaceLandmarker の顔変換行列から取り出し、ミラー時は四元数 `(x, -y, -z, w)` に変換する。
- 「正面キャリブレーション」はカメラの設置角 `C` を記録し、すべてのベクトルと回転に `C⁻¹` を掛ける。
- 上半身や全身が映る構図では顔が小さく、MediaPipe の近距離顔検出が効かない。そのため姿勢ランドマーク
  （鼻・目・耳）から頭部を切り出して拡大し、顔だけを追跡する（`FaceTracker` の ROI 切り出し）。

### 左右の手の識別

`HandIdentityTracker`（`src/tracking/HandIdentity.ts`）が、検出された手のどちらが左右かを毎フレーム決める。
手首だけでなく、親指（CMC・先端）、人差し指の付け根、小指（付け根・先端）を**アンカー**として次の 3 つの手がかりを組み合わせ、最も安い割り当てを選ぶ。

1. 姿勢モデルが推定した、左右それぞれの手首・親指・人差し指・小指の位置との一致
2. 前フレームのアンカー位置との連続性（相手側の手に似ている場合も減点する）
3. MediaPipe の手の見た目による左右判定

確立した左右を入れ替えるのは、反対の割り当てが 6 フレーム続けて勝ったときだけにする。重複検出の判定も全アンカーで比べるので、手首を合わせた両手が 1 つにまとめられることはない。

姿勢モデルが手首を見られない側には高いコストを与える（0 にはしない）。これで、見えている手が隠れている腕に割り当てられることはない。
腕の側でも、手が検出されていても、姿勢がその手首をまったく見ていない腕は動かさない。

### 実カメラで入れた安定化（`src/solver/Stabilizers.ts` ほか）

- 無表情ベースライン: ブレンドシェイプの「その人の無表情時の値」を学習し、そこからの変化だけを表情として扱う
- 回転スパイク除去: 1 フレームだけ大きく飛ぶ頭の回転を捨てる
- ヒステリシス: 胴・腕・脚の追跡の開始と終了に別々の閾値を使い、画面端でのちらつきを防ぐ
- 頭はワールド空間で平滑化し、平滑化済みの胴に対する相対回転として求める。胴の揺れが顔に伝わらない
- 顔を見失っている間は、姿勢の耳・目・口から頭の向きを推定して補う
- 肘が画面外にあり手が見えているときは、肩と手首から 2 ボーン IK で肘を復元する
- カメラ映像自体が左右反転している場合の補正。新しいカメラを初めて使うときは、画面上の案内に従って右手を上げると自動で判定し、カメラごとに保存する

### ソルバーの要点

- 腕と脚は**ヒンジ平面分解**で解く。上腕のねじれを「上腕と前腕が張る平面の法線＝肘の回転軸」に
  合わせることで、肘・膝が純粋な蝶番になり、捻れの破綻が出ない。伸びきって平面が定まらないときは、
  直前に得た回転軸を使う。
- 胴は肩の線と腰→肩のベクトルから基底を作る。腰が映っていない場合は鉛直方向を上として扱う。
- 手首は手のランドマーク（手首→中指付け根、小指→人差し指）から求める。手が検出できないときは
  姿勢の手首・人差し指・小指から粗く推定する。
- 指は関節ごとの曲げ角を、レスト姿勢の曲げ軸まわりの回転として適用する。

## Gemini 並列ループ

サーバー（`server/`）が API キーを保持し、ロールごとにモデルを割り当てる。割り当ては
`config/models.json` の候補順で決まり、その API キーの `models.list` で最初に見つかったモデルを使う。
環境変数 `VTUBER_MODEL_<ROLE>` で上書きできる。

| ロール | 既定モデル | 用途 | 経路 |
| --- | --- | --- | --- |
| live | gemini-3.1-flash-live-preview | マイク＋カメラ（1 fps）を常時送信。ツール呼び出しで表情・ジェスチャー・背景・テロップを演出し、音声で応答する | `/ws/live` 中継 |
| reactor | gemini-3.5-flash-lite（思考 MINIMAL） | 数秒ごとにフレームを渡し、感情・ジェスチャー・字幕を JSON で受け取る | `/api/react` |
| spatial | gemini-robotics-er-2-preview | 手に持った物体の点・矩形（0〜1000 正規化）と構図を得る → 手に小道具、全身モード自動切替 | `/api/spatial` |
| designer | gemini-3.1-pro-preview | 読み込んだサンプルの**実マテリアル名**を前提に、ペルソナ・色・小物・テクスチャ改変指示を構造化出力 | `/api/design` |
| image | gemini-3-pro-image | テクスチャアトラスを **UV 配置を保ったまま**描き換える。設定画の生成 | `/api/texture`, `/api/concept` |
| imageFast | gemini-3.1-flash-image | 配信背景（Live の `set_scene` にも対応） | `/api/background` |
| tts | gemini-3.8-flash-tts | ペルソナの声で台詞を読み上げる（口パク連動） | `/api/tts` |
| general | gemini-3.8-flash | 汎用（予備） | — |

AI の結果は `AppEvents`（`ai:expression` / `ai:gesture` / `ai:scene` / `ai:caption` / `ai:spatial`）として
EventBus に流れる。Live・リアクター・手動操作のどれが発生源でも、同じ経路でアバターに反映される。

## 3D モデル：サンプルの取り込みと踏襲

- 既定は VRM コンソーシアムのサンプル（`VRM1_Constraint_Twist_Sample`：VRoid 標準構造、
  `Seed-san`）を `npm run setup` で取得し、そのまま読み込む。手持ちの `.vrm` もドラッグ＆ドロップで使える。
- デザイナーは、サンプルが持つマテリアル構造（例 `Hair_00_HAIR`、`Tops_01_CLOTH`）をそのまま Gemini に
  渡す。そのため改変指示は常に実在のマテリアルを対象にする。テクスチャは元のアトラスを編集し、
  元のサイズとアルファを保って差し替えるので、UV やメッシュには手を加えない。
- 小物（猫耳・ヘッドホンなど）は頭ボーンに付ける。大きさと位置はモデルのバウンディングボックスから
  算出する。

## 拡張ポイント

| 追加したいもの | 実装するもの | 登録先 |
| --- | --- | --- |
| 新しい入力（画面共有、WebRTC、仮想カメラ） | `FrameSource` | `App.setSource()` |
| 新しいトラッカー（視線専用モデル、物体検出、外部トラッカー） | `Tracker` | `TrackerHost.add()`（`src/main.ts`） |
| 別形式のアバター（Live2D、独自ボーンマップの glTF） | `AvatarRig` | `App.setAvatar()` |
| 機能・演出（BGM、コメント連携、エフェクト） | `Plugin`（`setup` / `update`） | `app.use()`（`src/main.ts`） |
| 新しい Gemini ロール | `server/gemini/<name>.ts` の `RouteHandler` | `API_ROUTES`（`server/index.ts`）＋ `config/models.json` ＋ `ModelRole` |
| 新しい Live ツール | 宣言と検証（`server/gemini/live.ts`）＋ `LiveToolCall` 型 | クライアント側は `LiveDirectorPlugin.onMessage` |

候補として、`lyria-realtime-exp`（BGM のリアルタイム生成）や `gemini-robotics-er-2-streaming-preview`
（物体の連続追跡）は、同じ手順でロールとプラグインを追加すれば組み込める。

## セキュリティ

- API キーはサーバー側だけで使う。ブラウザには渡らない。
- サーバーは既定で `127.0.0.1` にだけ待ち受ける。さらに Host ヘッダの許可リスト（DNS リバインディング
  対策）と Origin の一致を確認する（CSRF と WebSocket ハイジャック対策）。LAN に公開する場合は
  `HOST` と `ALLOWED_HOSTS` を明示する。この API は利用者の Gemini 課金を代行するので、公開範囲に注意する。
