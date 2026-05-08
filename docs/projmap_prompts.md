# ProjMap Studio — 実装プロンプト集

> SDD三要素の②。仕様書 (`projmap_spec.md`) を参照しながら、  
> このプロンプトをAIに与えることで各ファイルを再現実装できる。  
> 実行順序: P01 → P02 → P03 → P04 → P05 → P06 → P07 → P08 → P09

---

## P01: 定数ファイル

**対象ファイル**: `shared/constants.js`  
**依存**: なし

```
以下の定数を定義する Node.js モジュール `shared/constants.js` を実装してください。

定数:
- GRID: 32 (Coons patch のメッシュ分割数。33×33=1089頂点になる)
- OUT_W: 1920 (デフォルト出力解像度 横)
- OUT_H: 1080 (デフォルト出力解像度 縦)

'use strict' + module.exports で書いてください。
```

---

## P02: Coons patch テッセレーター

**対象ファイル**: `shared/tessellate.js`  
**依存**: `shared/constants.js`

```
プロジェクションマッピング用の Coons patch テッセレーターを
`shared/tessellate.js` として実装してください。

## 仕様

### 入力
pts: [[u,v] × 8] の正規化[0,1]座標配列
インデックス順: [TL, TM, TR, RM, BR, BM, BL, LM]
(TL=左上, TM=上中, TR=右上, RM=右中, BR=右下, BM=下中, BL=左下, LM=左中)

### 出力
Float32Array: [u_pos, v_pos, u_tex, v_tex] × (GRID+1)²
- u_pos, v_pos: 頂点の正規化座標[0,1]
- u_tex, v_tex: テクスチャ座標[0,1]

### アルゴリズム
1. 8点のうち辺中点(TM, RM, BM, LM)から二次ベジェ制御点を逆算する
   公式: B(0.5) = 0.25A + 0.5C + 0.25B = M → C = 2M − 0.5(A+B)

2. 各格子点で Coons patch 公式を適用:
   - top(u): TL→TR の二次ベジェ (制御点 Ct)
   - bot(u): BL→BR の二次ベジェ (制御点 Cb)
   - lft(v): TL→BL の二次ベジェ (制御点 Cl)
   - rgt(v): TR→BR の二次ベジェ (制御点 Cr)
   
   Coons patch:
   pu = (1-v)*top(u) + v*bot(u) + (1-u)*lft(v) + u*rgt(v)
      − ((1-u)(1-v)TL + u(1-v)TR + (1-u)v*BL + u*v*BR)
   
   (pv も同様)

3. テクスチャ座標は u_tex=i/GRID, v_tex=j/GRID (均等分割)

### makeIndexData 関数
全サーフェス共通のインデックスバッファを返す。
Uint16Array: GRID×GRID×6 要素
各格子セルを2つの三角形に分割:
  頂点 a,b,c,d (左上,右上,左下,右下) → [a,b,c, b,d,c]

### エクスポート
module.exports = { tessellate, makeIndexData }
```

---

## P03: Undo 履歴クラス

**対象ファイル**: `renderer/undo.js`  
**依存**: なし

```
エディタ用の Undo/Redo 管理クラスを `renderer/undo.js` として実装してください。

## 仕様

クラス名: UndoHistory
最大ステップ数: 50

### snapshot(surfs)
surfs 配列の「GLリソース以外」を深コピーしてスタックに積む。
コピーするフィールド: id, name, pts (深コピー), opa, srcType, srcPath, srcName,
                      cameraDeviceId, screenSourceId
コピーしないフィールド: vbo, texObj, vid, objectUrl (GLリソース)

現在位置より後のredoスタックは破棄する。
スタックが MAX_STEPS を超えたら古い方から削除。

### undo() / redo()
それぞれ一つ前/後の状態の深コピーを返す。
できない場合は null を返す。

### canUndo() / canRedo()
可否を Boolean で返す。

module.exports = { UndoHistory }
```

---

## P04: メインプロセス

**対象ファイル**: `main.js`  
**依存**: Electron 42, Node.js 24

```
Electron プロジェクションマッピングツール「ProjMap Studio」の
メインプロセス `main.js` を実装してください。

## ウィンドウ構成

### エディタウィンドウ (createEditorWindow)
- サイズ: 1280×800, 最小 900×600
- backgroundColor: '#07070e', title: 'ProjMap Studio'
- webPreferences: { nodeIntegration: true, contextIsolation: false }
- 重要: webContents.setBackgroundThrottling(false) を必ず呼ぶ
  (これがないとウィンドウが背面になったとき requestAnimationFrame が止まり
   プレビューへのフレームキャプチャが途切れる)
- エディタを閉じたらプレビューウィンドウも閉じる

### プレビューウィンドウ (createPreviewWindow(displayIndex))
- 対象ディスプレイの 70% サイズ・中央配置
- frame: true, movable: true, resizable: true, fullscreenable: true
- backgroundColor: '#000000', title: 'ProjMap Preview'
- webPreferences: { nodeIntegration: true, contextIsolation: false }
- 閉じたらエディタに 'preview-closed' を送信

## IPC ハンドラ

### ipcMain.on
| チャンネル | 処理 |
|---|---|
| open-preview | 既存プレビューを閉じて新規作成 |
| close-preview | プレビューを閉じる |
| blackout | プレビューに転送 |
| preview-frame | dataURL をプレビューに転送 |

### ipcMain.handle (invoke)
| チャンネル | 処理 |
|---|---|
| get-displays | 全ディスプレイの情報 (index, label, bounds, primary) を返す |
| get-desktop-sources | desktopCapturer で画面・ウィンドウ一覧を取得 (サムネ 320×180) |
| prepare-capture | session.setDisplayMediaRequestHandler で次の getDisplayMedia に sourceId を登録 |

## projmap:// カスタムプロトコル

registerProtocol() 関数で protocol.handle('projmap', ...) を登録。

動画ファイルを fs.createReadStream で配信。
- URL形式: projmap:///encodedPath
- Windows: デコード後に / を \ に変換して fs に渡す
- HTTP Range request 対応 (動画シーク用)
- 全レスポンスに Access-Control-Allow-Origin: * を付与
- MIME: .mp4→video/mp4, .mkv→video/x-matroska, .webm→video/webm,
        .mov→video/quicktime, .avi→video/x-msvideo
- Node.js: Readable.toWeb(fs.createReadStream(...)) でストリーム変換

app.whenReady() で registerProtocol() → createEditorWindow() の順で呼ぶ。
```

---

## P05: プレビューウィンドウ HTML

**対象ファイル**: `preview/index.html`  
**依存**: なし

```
プレビューウィンドウ用の最小限の HTML `preview/index.html` を実装してください。

## 仕様
- 背景は黒 (#000)
- <img id="frame"> が画面全体を埋める (width:100%, height:100%, object-fit:fill)
  object-fit:fill は縦横比を保たずストレッチ (正規化座標なので歪みは発生しない)
- <div id="blackout"> position:fixed, inset:0, background:#000, z-index:999, display:none
- <script src="app.js"> を末尾に読み込む

余分な要素は不要。シンプルに。
```

---

## P06: プレビューウィンドウ ロジック

**対象ファイル**: `preview/app.js`  
**依存**: Electron IPC

```
プレビューウィンドウ用の最小 JavaScript `preview/app.js` を実装してください。

## 仕様
このファイルはエディタから送られてくる JPEG フレームを表示するだけ。
動画再生・WebGL・カメラアクセスは一切不要。

### IPC 受信
- 'preview-frame': dataURL (JPEG文字列) → #frame の src にセット
- 'blackout': on (Boolean) → #blackout の display を block/none 切り替え

'use strict' + require('electron').ipcRenderer のみ使用。
10行程度で書けるはず。
```

---

## P07: エディタ HTML

**対象ファイル**: `renderer/index.html`  
**依存**: `renderer/style.css`, `renderer/app.js`

```
プロジェクションマッピングエディタの HTML `renderer/index.html` を実装してください。

## レイアウト構造

```
<body>
  ヘッダー (#hdr)
  <div id="wrap">
    サイドバー (#side)
    メインエリア (#main)  ← WebGL canvas + SVG overlay + 背景画像
  </div>
  ステータスバー (#sbar)
  画面共有ピッカーモーダル (#screenPicker) ← 初期display:none
</body>
```

## ヘッダー (#hdr) の要素

左側:
- ロゴ: `<span class="logo">PROJMAP</span>`
- ▶ PREVIEW ボタン: `id="pvBtn"` onclick="togglePreview()"
- ■ BLACKOUT ボタン: `id="boBtn" class="tbtn red"` onclick="toggleBlackout()"
- OUTPUT セレクト: `id="outRes"` onchange="changeRes(value)"
  オプション: 1920,1080 / 1280,720 / 3840,2160
- DISPLAY ラベル + `<select id="dispSel">`

右側:
- EXPORT ボタン onclick="exportProj()"
- IMPORT ボタン → `<label>` で `<input type="file" id="importFile" accept=".json">`

右上 (メインエリア内):
- `<div id="pill" class="pill">EDIT MODE</div>` (EDIT/PREVIEWモード表示)

## サイドバー (#side) の要素

### Surfaces セクション
- `<div id="list">` (サーフェスリスト、JS で生成)
- [+ Add Surface] ボタン onclick="addSurface()"

### Source セクション
- Load Video: `<label>` で `<input type="file" id="vidFile" accept="video/*">`
- Live Camera ボタン: onclick="useCamera()"
- Screen Share ボタン: onclick="useScreenShare()"
- `<div id="vname">` (ソース名表示)

### props (#props, 初期display:none)
- 再生制御 (#videoControls, 初期display:none):
  ▶ ⏸ ⏮ ボタン onclick="vidCmd('play'/'pause'/'restart')"
- Opacity: `<input type="range" id="opa" min="0" max="100" value="100">`
- [Reset] onclick="resetPoints()" / [Delete] onclick="delSel()"
- 座標入力 (#ptEditor, 初期display:none):
  `<span id="ptLabel">`, X入力 `id="ptX"`, Y入力 `id="ptY"` onchange="setPtCoord()"
  単位ラベル: 出力解像度 px

### 背景画像セクション
- [投影対象の写真を読み込む]: `<label>` で `<input type="file" id="bgFile" accept="image/*">`
- bgControls (#bgControls, 初期display:none):
  透明度スライダー + [×クリア] onclick="clearBgImage()"

### View セクション
- [Preview Mode] ボタン onclick="togglePreview()"

### Project セクション
- [Export] [Import] ボタン

## メインエリア (#main)

```html
<div id="main">
  <div id="checker"></div>  <!-- チェッカー柄背景 -->
  <img id="bgImg" style="display:none">  <!-- 背景写真 -->
  <canvas id="glc"></canvas>  <!-- WebGL描画 -->
  <svg id="svg" class="ed" xmlns="http://www.w3.org/2000/svg"></svg>  <!-- ハンドルSVG -->
</div>
```

## ステータスバー (#sbar)
- `<span id="sm">EDIT</span>` (EDIT/PREVIEW)
- ヘルプテキスト (Corner: 四隅ワーピング / Edge: 辺の湾曲 / Drag center: 移動 / キーボードショートカット)
- `<span id="st">` (サーフェス情報)
- `<span id="sc">` (マウス座標 px)

## 画面共有ピッカー (#screenPicker)

```html
<div id="screenPicker" style="display:none; position:fixed; ...モーダル...">
  <div class="picker-inner">
    <div class="picker-title">SCREEN SHARE</div>
    <div id="pickerLoading"></div>
    <div id="pickerGrid"></div>  <!-- JS でサムネイルカードを生成 -->
    <button onclick="closeScreenPicker()">Cancel</button>
  </div>
</div>
```

スクリプトは `<script src="app.js">` を body 末尾に。
```

---

## P08: エディタ CSS

**対象ファイル**: `renderer/style.css`  
**依存**: なし

```
プロジェクションマッピングエディタのCSSを `renderer/style.css` として実装してください。

## デザインテーマ
- 暗色テーマ (宇宙・テック系)
- フォント: 'JetBrains Mono', monospace
- カラー変数:
  --bg: #07070e        (ページ背景)
  --panel: #0d0d1a     (サイドバー背景)
  --border: #1a1a30    (ボーダー)
  --accent: #00e5ff    (シアン、強調)
  --red: #ff1a5e       (警告・削除)
  --dim: #4a4a6a       (薄いテキスト)
  --text: #c8d0e8      (通常テキスト)

## レイアウト
- body: flex column, height:100vh, overflow:hidden
- #hdr: 高さ40px, flex, align-items:center, gap:8px
- #wrap: flex, flex:1, overflow:hidden
- #side: 幅220px, overflow-y:auto, padding:10px, border-right:1px solid var(--border)
- #main: flex:1, position:relative (canvasとSVGを重ねるため)
- #sbar: 高さ22px, flex, font-size:9px

## 主要コンポーネント

### ツールバーボタン (.tbtn)
- border: 1px solid var(--accent)
- color: var(--accent)
- background: transparent
- padding: 3px 10px, font-size: 9px, letter-spacing: 1px
- .on クラス: background: var(--accent), color: #000
- .red クラス: border-color / color が var(--red)
- .red.on: background: var(--red), color: #fff

### サーフェスカード (.sc)
- padding:8px, border: 1px solid transparent
- cursor: pointer, hover/selected で border-color: var(--accent)
- .sc-h: flex, align-items:center
- .dot: 8px丸, 色はJS側で設定
- .sc-del: 右端のxボタン, 小さく

### セクションラベル (.sec)
- font-size: 8px, letter-spacing: 1.5px, color: var(--dim), text-transform: uppercase

### メインキャンバス (#main)
- #checker: 100%×100%, チェッカーボード柄 (CSS backgroundで実現)
  background-image: linear-gradient で 暗い市松模様
- #bgImg: position:absolute, inset:0, width:100%, height:100%, object-fit:contain
- canvas#glc: position:absolute, inset:0, width:100%, height:100%
- svg#svg: position:absolute, inset:0, width:100%, height:100%, overflow:visible
  .ed クラス時のみ pointer-events:all (editモード)

### モードピル (#pill)
- position:absolute, top:8px, right:8px
- border: 1px solid var(--accent), color: var(--accent)
- font-size: 9px, padding: 3px 10px
- .pv クラス: background: var(--accent), color: #000 (プレビューモード)

### スライダー (range)
- -webkit-appearance:none, width:100%
- track: 高さ3px, background: var(--border)
- thumb: 12px丸, background: var(--accent)

### 画面共有ピッカー (#screenPicker)
- position:fixed, inset:0, background: rgba(0,0,0,0.85), z-index:200
- .picker-inner: 中央配置, 最大幅800px, max-height:80vh, overflow-y:auto
- #pickerGrid: display:flex, flex-wrap:wrap, gap:8px
- .source-card: 幅160px, cursor:pointer, border:1px solid var(--border)
  hover: border-color: var(--accent)
- .source-thumb: 幅100%, aspect-ratio:16/9, object-fit:cover
- .source-name: font-size:9px, text-align:center, padding:4px
```

---

## P09: エディタ メインロジック

**対象ファイル**: `renderer/app.js`  
**依存**: `shared/constants.js`, `shared/tessellate.js`, `renderer/undo.js`, Electron IPC

```
プロジェクションマッピングエディタのメインロジック `renderer/app.js` を実装してください。
仕様書 (projmap_spec.md) の内容に従って実装すること。

## インポート
- require('electron'): ipcRenderer, webUtils
- require('node:url'): pathToFileURL
- require('../shared/tessellate.js'): tessellate, makeIndexData
- require('./undo.js'): UndoHistory
- require('../shared/constants.js'): GRID, OUT_W, OUT_H

## グローバル状態
- surfs[]: サーフェス配列
- selId, selPt: 選択中ID・ポイントインデックス
- edit, blackout, previewOpen: Boolean
- nid: 次のサーフェスID
- outW, outH: 現在の出力解像度 (初期値 OUT_W, OUT_H)
- history: UndoHistory インスタンス
- captureActive: Boolean (フレームキャプチャ状態)
- bgObjectUrl: 背景画像のblob URL

## WebGL 初期化
context: { alpha:true, premultipliedAlpha:false, preserveDrawingBuffer:true }
※ preserveDrawingBuffer:true は toDataURL() のために必須

シェーダー:
- 頂点: [0,1]正規化座標 → クリップ空間 (Y反転: gl_Position.y = -(aPos.y*2-1))
- フラグメント: texture2D(uTex,vUV).rgb をアルファ uAlpha で出力

テストパターンテクスチャ (defTex): 起動時に生成。
512×512のcanvasに暗い格子+中心線+"TEST PATTERN"文字を描いてアップロード。

共有インデックスバッファ (idxBuf): makeIndexData() でIIFE生成。

## レンダーループ (loop)
1. syncSize(): キャンバスを #main のサイズに合わせる
2. clearColor(0,0,0,0) / clear
3. 各サーフェスをループ:
   a. vid.readyState >= 2 なら texImage2D でテクスチャ更新
   b. dirty なら tessellate して vbo に再アップロード
   c. drawElements で描画
4. edit なら drawOverlay() (SVGハンドル描画)
5. syncPreview() (フレームキャプチャ処理)
6. requestAnimationFrame(loop)

## SVGオーバーレイ (drawOverlay)
各サーフェスの8点制御点を可視化する:
- 輪郭: 4辺をそれぞれ二次ベジェパス (QコマンドのSVGパス)
  - 選択サーフェス: 実線 + 薄い塗りつぶし
  - 非選択: 破線
- コーナーハンドル (pi偶数): 円●、選択済みは白枠
- 辺中点ハンドル (pi奇数): 菱形◆
- ラベル: PT_LABELS[pi] をハンドル横に表示
- サーフェス名: 重心に薄く表示
- 各ハンドルに mousedown → startDragPt(e, surf.id, pi)
- 輪郭パスに mousedown → startMove(e, surf.id)

ポイント → キャンバスピクセル変換: [u,v] → [u*cvs.width, v*cvs.height]

## ドラッグ操作

### startDragPt(e, sid, pi)
- mousedown でスナップショット
- mousemove で pts[pi] = evToNorm(ev) に更新 + dirty=true
- updatePtDisplay() で数値入力を更新

### startMove(e, sid)
- mousedown でスナップショット
- 全制御点を平行移動

### evToNorm(e)
getBoundingClientRect で正規化座標を計算

## ソース読み込み

### loadVideo(ev)
- URL.createObjectURL(file) でblob URL作成 (エディタ内表示用)
- webUtils.getPathForFile(file) でファイルパス取得
  (file.path は Electron 42 で空になる場合があるため webUtils を使う)
- canplay イベント後に play() (src直後の play() は失敗する)
- s.objectUrl に blob URL を保存 (cleanup用に revokeObjectURL が必要)

### useCamera()
- enumerateDevices で videoinput を取得
- getUserMedia で映像ストリーム取得
- video.srcObject = stream

### useScreenShare()
- desktopCapturer はメインプロセス専用
- ipcRenderer.invoke('get-desktop-sources') でソース一覧取得
- buildPickerUI() でモーダルUI構築
- 選択後 startScreenCapture(surf, src):
  1. ipcRenderer.invoke('prepare-capture', src.id)
  2. navigator.mediaDevices.getDisplayMedia()

### vidCmd(cmd)
play/pause/restart を s.vid に対して実行。
canplay リスナーで再試行するパターンも実装 (未ロード時の play() 失敗対策)。

## フレームキャプチャ (プレビューへの送信)

### startCapture()
captureActive フラグで二重起動防止。
setTimeout 50ms ループで cvs.toDataURL('image/jpeg', 0.85) を取得し
ipcRenderer.send('preview-frame', dataURL) で送信。

### stopCapture()
captureActive = false でループを停止。

### togglePreview()
- previewOpen を反転
- edit = !previewOpen
- SVGオーバーレイとチェッカー柄の表示を切り替え
- PREVIEW ON: open-preview IPC + 300ms後に startCapture()
- PREVIEW OFF: close-preview IPC + stopCapture()

preview-closed IPC受信時も stopCapture() 呼び出し。

## 数値座標入力
- updatePtDisplay(pt): [u,v] → outW,outH ピクセルに換算して #ptX #ptY に表示
- setPtCoord(): #ptX #ptY の値を正規化して pts[selPt ?? 0] に設定
- changeRes(val): "1920,1080" → outW, outH を更新

## refreshUI()
サーフェスリストを再描画。選択中サーフェスの props パネルを更新。
ptEditor の表示: selPt ?? 0 を使ってサーフェス選択時はデフォルトで TL を表示。

## Undo / Redo
applyHistory(data): 
- 履歴にないサーフェスのGL資源を解放して削除
- 残ったサーフェスの pts, opa を更新
- 履歴にあるが配列にないサーフェスを vbo 新規作成で復元
  (texObj/vid は復元不可 → srcName に '（要再読込）' を付加)

## Export / Import
### exportProj()
version:'0.4', outW, outH, surfaces[] を JSON でダウンロード
surfaces の各要素: id, name, pts, srcType, srcPath, srcName, opa

### importProj(ev)
FileReader で読み込み → JSON.parse → history.snapshot → surfs を再構築。
outW/outH も復元。

## キーボードショートカット
INPUT/SELECT フォーカス中は無効。
N=addSurface, P=togglePreview, B=toggleBlackout,
Delete/Backspace=delSel, Escape=選択解除,
Ctrl+Z=undo, Ctrl+Shift+Z=redo

## 背景画像
- WebGL canvas が alpha:true のため、canvas の下に <img> を置くと透けて見える
- bgObjectUrl 管理: 読込時 createObjectURL / クリア時 revokeObjectURL
- bgControls の表示切り替え + チェッカー柄の非表示

## 起動処理 (最終行)
populateDisplays() でディスプレイ一覧を非同期取得。
loop() でレンダーループ開始。
```

---

## プロンプト利用ガイド

### 実行手順

```
1. P01 を実行 → shared/constants.js を生成・検証
2. P02 を実行 → shared/tessellate.js を生成・検証
3. P03 を実行 → renderer/undo.js を生成・検証
4. P04 を実行 → main.js を生成・検証
5. P05 を実行 → preview/index.html を生成・検証
6. P06 を実行 → preview/app.js を生成・検証
7. P07 を実行 → renderer/index.html を生成・検証
8. P08 を実行 → renderer/style.css を生成・検証
9. P09 を実行 → renderer/app.js を生成・検証 (最大難度)
```

### 検証方法

```bash
# 起動確認
npm install
npm start

# 動作確認項目
□ エディタが起動する
□ + Add Surface でサーフェスが追加される
□ ハンドルをドラッグでワーピングできる
□ Load Video で動画が再生される
□ ▶ PREVIEW でプレビューウィンドウが開く
□ プレビューウィンドウに動画が映る
□ エディタを最小化してもプレビューが止まらない
□ ■ BLACKOUT でプレビューが黒画面になる
□ Ctrl+Z でアンドゥできる
□ Export → Import でプロジェクトが復元される
```

### P09 補足 (app.js の難易度について)

app.js は約750行と最大難度。一度に生成せずに分割が推奨:

```
P09-A: WebGL初期化 + レンダーループ + Coons patchワーピング部分
P09-B: SVGオーバーレイ + ドラッグ操作
P09-C: ソース読み込み (動画/カメラ/画面共有)
P09-D: フレームキャプチャ + プレビュー制御
P09-E: UI管理 (refreshUI, Undo/Redo, Export/Import, キーボード)
```
