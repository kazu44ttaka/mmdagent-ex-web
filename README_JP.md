[English](README.md) | [日本語](README_JP.md)

# MMDAgent-EX Web

[MMDAgent-EX](https://github.com/mmdagent-ex/MMDAgent-EX) のコンテンツ（`.mdf`・`.fst`・`.pmd` / `.pmx`・`.vmd`）を
Web ブラウザーで動かし、MMDAgent-EX と同じやり方で Plugin_Remote の WebSocket サーバーにつなぎます。
[MaAI-SDS](https://github.com/MaAI-Kyoto/MaAI-SDS) のように Plugin_Remote で MMDAgent-EX のアバターを動かすアプリから、
アバターをブラウザーに表示できます。

中身は MMDAgent-EX のソースから移したものです。FST の実行（Plugin_VIManager）、モーションの仕組み
（MotionManager / MotionController と VMD の補間の表）、ボーンの更新の順番、結び付け、口パクのモーション、カメラ、
モデルの移動、Plugin_Remote の通信が対象です。処理はすべてブラウザーの中で行い、選んだフォルダーはどこにも送りません。

## 導入

必要なもの：Chrome か Edge、Git、ページを配る HTTP サーバー（下では Python の `http.server`。ほかのものでも構いません）。
MMDAgent-EX 本体は要りません。

```sh
# 1. このリポジトリ
git clone https://github.com/kazu44ttaka/mmdagent-ex-web.git

# 2. 表示するコンテンツ。公式のサンプル集（アバターのジェネ・ウカはサブモジュールなので --recursive を付ける。約 470 MB）
git clone --recursive https://github.com/mmdagent-ex/example
```

ES モジュールを使うので、ページは `file://` ではなく HTTP で開きます。

```sh
cd mmdagent-ex-web
python -m http.server 8000
```

## 使い方

Chrome か Edge で <http://localhost:8000> を開き、次の順に操作します。

1. **コンテンツ**：MMDAgent-EX のコンテンツのフォルダー（上で clone した `example`）を選ぶか画面にドロップし、`.mdf` を選んで
   「開始」を押します。`.mdf` から `../gene/...` のようにたどるファイルも読むので、`.mdf` の入ったフォルダーではなく、その上の
   コンテンツ全体のフォルダーを選びます。MMDAgent-EX と同じく、`.mdf` と同じ名前の
   FST とサブ FST が動き始めます。
2. **接続**：「接続」を押します。接続先は `.mdf` の `Plugin_Remote_Websocket_Host`・`_Port`・`_Directory` から作り
   （`example_websocket.mdf` なら `ws://localhost:9001/chat`）、書き換えることもできます。Plugin_Remote と同じく、サーバーが
   立ち上がるまでつなぎ直し続けます。

ブラウザーが音の再生を止めているときは、3D 表示を一度クリックしてください。MMDAgent-EX と同じく、ドラッグで視点を回し、
右ドラッグ（または Shift）で動かし、ホイールで距離を変えます。

### URL でシーンを開く

ほかのプログラムから、フォルダーを選ばずに 1 つのリンクでシーンを開けます。

```text
http://localhost:8000/?content=<フォルダーの URL>&mdf=<フォルダーの中の .mdf>&ws=<WebSocket の URL>&connect=1
```

- `content`：HTTP で配っているコンテンツのフォルダー（相対 URL はページから解決します）。その中の `files.json` にファイルの一覧を
  置きます：`{"files": ["gene/Gene.pmd", "maai_sds/maai_sds_web.mdf", ...]}`（パスはフォルダーから）。ファイルは読むときに取得します。
- `mdf`：始める `.mdf`（フォルダーから）。`ws`：接続先（`.mdf` の設定より優先）。`connect=1`：シーンを始めたらすぐ接続します。

ブラウザーはページをクリックするまで音を出さないので、それまで画面の下に「クリックすると声が出ます」のボタンが出ます。

### MaAI-SDS とつなぐ

1. MaAI-SDS の `assets/mmdagent/maai_sds` フォルダーを、サンプル集の中（`example/maai_sds`）にコピーします。
2. MaAI-SDS の「MMDAgent-EX起動設定」で「アバターの表示先」を「ブラウザ（MMDAgent-EX Web）」にします。MaAI-SDS は
   MMDAgent-EX を起動せず、`ws://localhost:9001/chat` で待ち受けます（ポートは同じ画面で変えられます）。
3. MaAI-SDS で「MMDAgent-EX起動」を押します。MaAI-SDS がこのページとサンプル集を配り、シーンと接続先を指定してページを開きます
   （上の「URL でシーンを開く」）。このフォルダーは `C:\mmdagent-ex-web`（Windows 以外は `~/mmdagent-ex-web`）を探します。
   別の場所は同じ画面で指定できます。手で開くときは、このページで `example` を選び、`example/maai_sds/maai_sds_web.mdf` を
   「開始」して「接続」を押します。
4. MaAI-SDS で音声対話を始めると、ジェネが話し（口パクは Julius）、頷き・まばたきをします。

## 動くもの

| 分類 | 対応しているもの |
|---|---|
| コンテンツ | `.mdf` の設定（カメラ・照明・トゥーン描画・輪郭線の太さと `light_edge`・投影の影 / 影マップ・物理演算・舞台の大きさ・`max_num_model`・`lipsync_priority`・`show_fps`）、同じ名前の FST とサブ FST、`%INCLUDE`、変数、`$a==b` の判定、`@正規表現@` の入力 |
| モデル | `MODEL_ADD`（複数モデル、位置・回転、トゥーンのオン/オフ、ほかのモデルのボーンへの取り付け）、`MODEL_CHANGE`・`MODEL_CHANGE_ASYNC`・`MODEL_DELETE`（フェードアウト、取り付けたモデルも）、`<モデル>.shapemap` またはシステムの `default.shapemap`、`<モデル>.lip`、`<モデル>.csv`（材質の輪郭線・不透明度・両面描画と影の設定・テクスチャ、頂点ごとの輪郭線の太さ）、`<モデル>.loadmessage` / `.deletemessage`、PMD のボーンの種類（IK・回転影響下・回転連動） |
| モーション | `MOTION_ADD`（優先度、`FULL` / `PART`、`ONCE` / `LOOP`、開始・ループ・終了のなめらかなつなぎ、位置合わせ）、`MOTION_CHANGE`・`MOTION_RESET`・`MOTION_ACCELERATE`・`MOTION_CONFIGURE`（置き換え・加算・乗算、ブレンド率）・`MOTION_DELETE`、VMD の IK・表示の切り替え、`LIPSYNC_START` / `LIPSYNC_STOP`（lip.txt） |
| 位置 | `MOVE_START` / `MOVE_STOP`・`TURN_START` / `TURN_STOP`・`ROTATE_START` / `ROTATE_STOP`（ローカル / グローバル、速さ） |
| 舞台 | `STAGE`（床と背景の画像、または 3D の舞台モデル）、`CAMERA`（視点、時間をかけた移動、ボーンへの追従、カメラモーション）、`LIGHTCOLOR`・`LIGHTDIRECTION` |
| 制御 | `KEYVALUE_SET`、`MODEL_BINDBONE`・`MODEL_BINDFACE`・`MODEL_UNBINDBONE`・`MODEL_UNBINDFACE`、`OPEN_CONTENT`、`HOME_SET` / `HOME_CLEAR`、`MOTIONCAPTURE_START` / `STOP`（VMD をダウンロード）、`REMOTEKEY_CHAR`、`PLUGIN_ENABLE` / `PLUGIN_DISABLE` |
| 画面の部品 | `MENU`・`PROMPT_SHOW`・`INFOTEXT_STRING` / `INFOTEXT_FILE`・`CAPTION_SETSTYLE` / `CAPTION_START` / `CAPTION_STOP`・`BUTTON_ADD` / `BUTTON_DELETE`・`WINDOWFRAME*`・`WINDOWOVERLAY*` |
| プラグイン | VIManager、Remote、Variables（`VALUE_*`・`TIMER_*`）、Audio（`SOUND_START` / `SOUND_STOP`、`.lab` からの口パク）、TextArea（`TEXTAREA_*`）、LookAt（`l` キー） |
| Plugin_Remote | 文字のメッセージ、`__AV_MESSAGE`・`__AV_START`・`__AV_END`・`__AV_SETMODEL`・`__AV_EXMORPH`・`__AV_ACTION`・`__AVCONF_DISABLEAUTOLIP`、音声（`SND` ＋ 4 桁の長さ、16 kHz・16 ビット・モノラル。`SNDSTRM`・`SNDFILE`・`SNDBRKS`）、`SPEAK_START` / `SPEAK_STOP`、`AVATAR_CONTROL`、`AVATAR_EVENT_IDLE` |
| 音声 | `SYNTH_START` / `SYNTH_STOP` と `RECOG_EVENT_START` / `RECOG_EVENT_STOP` を、ブラウザーの Web Speech API で（マイクは操作欄でオンにします） |
| イベント | 上のすべてのイベント、`KEY`、`MODEL_EVENT_SELECT`（モデルをダブルクリック）、`REMOTE_EVENT_CONNECTED` / `DISCONNECTED` |
| キー | `f` 全画面、`s` 情報表示、`+` / `-` 距離、矢印で回転（Shift で移動）、`S` 影、`x` 影マップ、`k` / `K` 輪郭線、`p` 物理演算、`w` ワイヤーフレーム、`/` メニュー、`R` 読み直し、`l` LookAt |

ページの中のメッセージ（命令・イベント・受け取ったもの）は、Plugin_Remote と同じく、すべて WebSocket サーバーにも送り返します。

### MMDAgent-EX との違い

- **受け取った音声からの口パク**は MMDAgent-EX と同じです。MMDAgent-EX 同梱の Julius を WebAssembly にしたものが、同じ
  モデルと設定で音素を認識し、同じ表となめらかさで口を動かします。Julius を起動できないとき（`file://` で開いたときなど）
  だけ、音の大きさから口の形を見積もります。
- **音声合成と音声認識**：Open_JTalk・Flite と Julius の代わりに、ブラウザーの声と認識を使います。ブラウザーは音素の
  時刻を返さないので、`SYNTH_START` の口は一定の調子で動き、Julius 固有のイベント（`RECOG_EVENT_MODIFY`・`_GMM`・`_AWAY`・
  `_OVERFLOW`・`_RAPID`）は出ません。
- **描画**：MMDAgent-EX の固定機能の照明・トゥーン・スフィアマップ・輪郭線と同じ計算をするシェーダーで three.js が
  描くので、色は同じになります。アンチエイリアスと影マップの範囲はわずかに違います。PMX のボーン・材質・UV モーフ、
  PMX の階層ごとのボーン更新とローカル付与、`doppel_shadow`、ぼかしの後処理、`cartoon_edge_selected_color` は
  反映しません。画面の部品は MMDAgent-EX の配色の HTML で、`BUTTON_ADD` の座標はおおよそです。
- **ブラウザーではできないもの**：`TRANSPARENT_*`、`REMOTEKEY_DOWN` / `UP`、`RECOG_RECORD_*`、`LOG_UPLOAD`、
  `AVATAR_LOGSAVE_*`、動くテクスチャ（`TEXTURE_SETANIMATIONRATE`）、内蔵の HTTP サーバー、AnyScript・Network・Kafka・
  RabbitMQ・WindowController の各プラグイン。これらのメッセージも FST とサーバーには届きます。

## 開発

```sh
npm test   # node --test（Node.js 20 以降）。入れるパッケージはありません
```

| ファイル | 役割 |
|---|---|
| `src/app.js` | 画面、メッセージの順番待ち、プラグインのつなぎ |
| `src/core.js` | MMDAgent-EX 本体の命令と、ステップごとの更新 |
| `src/model.js` | モデル 1 体：姿勢、ボーンの更新の順番、位置、物理演算 |
| `src/motion.js`・`src/vmd.js` | MotionManager / MotionController、VMD の読み込み |
| `src/camera.js` | カメラ（Render / CameraController） |
| `src/fst.js` | FST の読み込みと実行（Plugin_VIManager） |
| `src/protocol.js`・`src/avatar.js`・`src/julius-lip.js`・`src/julius-worker.js` | Plugin_Remote のデータ、アバター制御、Julius の口パク |
| `julius/` | `jw.c`（Julius の音声入力と結果の受け口）と `build.sh`。`dist/` にビルドした `julius.js` / `julius.wasm` |
| `src/bindings.js`・`src/lipsync-motion.js` | KeyValue と結び付け、LIPSYNC のモーション |
| `src/plugins.js`・`src/speech.js`・`src/ui.js`・`src/system.js` | プラグイン、Web Speech、画面の部品、そのほかの命令 |
| `src/viewer.js` | three.js の描画、舞台、影、共有の物理演算 |
| `src/look.js`、`src/material-looks.js` | MMDAgent-EX のモデルの見た目：材質の設定、照明、トゥーン、輪郭線 |

three.js r160 と Ammo.js は `vendor/` に、MMDAgent-EX の `lip.txt`・`default.shapemap`・トゥーンのテクスチャ・Julius の音素モデルは `appdata/` に
同梱しているので、オフラインでも動きます。Julius を作り直すときは [emsdk](https://emscripten.org/) を入れて
`julius/build.sh <MMDAgent-EX のソースのフォルダー>` を実行します。

## ライセンス

[Apache License 2.0](LICENSE) です。コードの多くは MMDAgent-EX（Copyright 2022-2023 Nagoya Institute of
Technology、Apache License 2.0）を JavaScript に移したもので、その中の MMDAgent 由来の部分から移したファイルには、MMDAgent の
表示（Copyright (c) 2009-2016 Nagoya Institute of Technology、BSD 3-Clause、
[LICENSES/MMDAgent-BSD-3-Clause.txt](LICENSES/MMDAgent-BSD-3-Clause.txt)）も付けています。移したファイルにはそれぞれ移植元を
書いています。[NOTICE](NOTICE) を見てください。同梱のライブラリーとファイルはそれぞれのライセンスです：
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

MMDAgent-EX の開発者の許可を得て公開しています。MMDAgent-EX のコンテンツのアバターやモーションには、それぞれの利用条件が
あります（たとえばジェネは CC BY 4.0 で、商標と意匠は名古屋工業大学が持っています）。使うコンテンツの条件に従ってください。
