# ProjMap Studio — SDD仕様書

> バージョン: v0.4  
> 対象: 同じ実装を再現するための仕様書  
> 対象環境: Windows 11 / Linux (Electron 42, Node 24)

---

## 1. プロジェクト概要

**ProjMap Studio** は、プロジェクションマッピング用のデスクトップツール。  
動画・ライブカメラ・画面共有を **Coons patch (四辺湾曲ワーピング)** で変形して投影面に合わせる。  
授業・デモ・イベントでの使用を想定。

### 主な機能

- 複数サーフェスの管理（追加・削除・選択）
- ソース: 動画ファイル / ライブカメラ / 画面共有
- 8点制御によるCoons patchワーピング（4コーナー + 4辺中点）
- エディタで変形を確認しながら、プレビューウィンドウに出力
- Undo/Redo（最大50ステップ）
- プロジェクトのExport/Import（JSON v0.4）
- 背景画像オーバーレイ（投影対象の写真を敷いて位置合わせ）
- BLACKOUT（プレビューを即時黒画面に切り替え）

---

## 2. 技術スタック

| 要素 | 選択 | 理由 |
|---|---|---|
| フレームワーク | Electron 42 | Windows/Linux クロスプラットフォーム |
| ランタイム | Node.js 24 | fs/stream 最新 API |
| レンダリング | WebGL 1.0 | Coons patch テッセレーション |
| プロセス間通信 | Electron IPC | メイン↔レンダラー |
| ビルドツール | なし（npm start で直接起動） | 開発段階 |

### package.json

```json
{
  "name": "projmap-studio",
  "version": "0.4.0",
  "main": "main.js",
  "scripts": { "start": "electron ." },
  "devDependencies": { "electron": "^42.0.0" }
}
```

---

## 3. ファイル構成

```
projmap/
├── main.js                  # Electron メインプロセス
├── package.json
├── shared/
│   ├── constants.js         # GRID=32, OUT_W=1920, OUT_H=1080
│   └── tessellate.js        # Coons patch テッセレーション (renderer/preview 共有)
├── renderer/
│   ├── index.html           # エディタ HTML
│   ├── style.css            # エディタ CSS
│   ├── app.js               # エディタ ロジック (~750行)
│   └── undo.js              # UndoHistory クラス
└── preview/
    ├── index.html           # プレビュー HTML (15行程度)
    └── app.js               # プレビュー ロジック (15行程度)
```

---

## 4. 座標系とデータモデル

### 4.1 正規化座標

**全制御点は [0, 1] × [0, 1] の正規化空間で保存・転送する。**

- `[0, 0]` = キャンバス左上、`[1, 1]` = キャンバス右下
- ウィンドウリサイズで崩れない
- 数値表示時のみ出力解像度 (outW × outH) に換算する

```javascript
// 正規化 → ピクセル
const px = Math.round(u * outW);  // outW = 1920 (デフォルト)
const py = Math.round(v * outH);  // outH = 1080

// ピクセル → 正規化
pts[pi] = [x / outW, y / outH];
```

### 4.2 サーフェスオブジェクト

```javascript
{
  id:            Number,    // 一意ID (0から連番)
  name:          String,    // 'Surface 1' 等
  pts:           [[u,v]×8], // 制御点。順序: TL TM TR RM BR BM BL LM
  vbo:           WebGLBuffer,
  texObj:        WebGLTexture | null,
  vid:           HTMLVideoElement | null,
  objectUrl:     String | null,  // blob URL (video用、cleanup時に revokeObjectURL)
  srcType:       'default' | 'video' | 'camera' | 'screen',
  srcPath:       String | null,  // 絶対パス (video時)
  srcName:       String,
  cameraDeviceId: String | null,
  screenSourceId: String | null,
  opa:           Number,    // 0.0〜1.0
  dirty:         Boolean,   // true → 次フレームで再テッセレーション
}
```

### 4.3 制御点インデックス

```
インデックス: 0=TL  1=TM  2=TR
              7=LM        3=RM
              6=BL  5=BM  4=BR

PT_LABELS = ['TL','TM','TR','RM','BR','BM','BL','LM']
```

### 4.4 初期配置

新規サーフェスは中央配置。offset でサーフェスを少しずらす（重なりを避ける）:

```javascript
function makePts(offset = 0) {
  const cx = 0.5 + offset * 0.04;
  const cy = 0.5 + offset * 0.04;
  const hw = 0.2, hh = 0.15;
  return [
    [cx-hw, cy-hh], [cx, cy-hh], [cx+hw, cy-hh],
    [cx+hw, cy],
    [cx+hw, cy+hh], [cx, cy+hh], [cx-hw, cy+hh],
    [cx-hw, cy],
  ];
}
```

---

## 5. アーキテクチャ

### 5.1 プロセス構成

```
┌─────────────────────────────────────┐
│ Main Process (main.js)              │
│  ・BrowserWindow 管理               │
│  ・IPC ルーティング                  │
│  ・projmap:// カスタムプロトコル     │
│  ・desktopCapturer (画面共有用)      │
└──────────┬──────────────────────────┘
           │ IPC
   ┌───────┴──────┐     ┌──────────────────┐
   │ Editor       │     │ Preview Window   │
   │ (renderer/)  │     │ (preview/)       │
   │              │─────│                  │
   │ WebGL描画    │JPEG │ <img>で表示       │
   │ 動画/カメラ  │フレーム│ blackout制御    │
   │ 画面共有     │     │                  │
   └──────────────┘     └──────────────────┘
```

### 5.2 プレビューのアーキテクチャ（重要）

**エディタのWebGLキャンバスをJPEGフレームとしてIPCで送信し、プレビューは受け取った画像を `<img>` に表示するだけ。**

この設計の理由:
- プレビューが独自にビデオを再生しようとすると、`file://` クロスオリジン制約・コーデック問題・WebGL SecurityError が多発する
- エディタが描画済みのキャンバスをそのまま送ればソース種別を問わず確実に映る

```
エディタ loop() → cvs.toDataURL('image/jpeg', 0.85)
                → IPC 'preview-frame'
                → main.js 転送
                → preview <img>.src = dataURL
```

キャプチャは 20fps (50ms間隔)。`preserveDrawingBuffer: true` がWebGLコンテキストに必須。

---

## 6. Coons Patch アルゴリズム

### 6.1 概要

8点制御（4コーナー + 4辺中点）の二次ベジェCoons patchで曲面を生成する。  
`shared/tessellate.js` に実装。renderer と preview の両方から `require()` で使う。

### 6.2 実装

```javascript
// 通過点 → 二次ベジェ制御点変換
// B(0.5) = 0.25A + 0.5C + 0.25B = M  →  C = 2M − 0.5(A+B)
const ctrl = (A, M, B) => [
  2*M[0] - 0.5*(A[0]+B[0]),
  2*M[1] - 0.5*(A[1]+B[1]),
];

// 二次ベジェ
const qbez = (A, C, B, t) => {
  const s = 1 - t;
  return [s*s*A[0]+2*s*t*C[0]+t*t*B[0], s*s*A[1]+2*s*t*C[1]+t*t*B[1]];
};

// Coons patch 公式
pu = (1-v)*top[0] + v*bot[0] + (1-u)*lft[0] + u*rgt[0]
   - ((1-u)*(1-v)*TL[0] + u*(1-v)*TR[0] + (1-u)*v*BL[0] + u*v*BR[0]);
```

### 6.3 テッセレーション

- `GRID = 32` 分割 → `33 × 33 = 1089` 頂点
- 頂点バッファ: `Float32Array [(u_pos, v_pos, u_tex, v_tex) × 1089]`
- インデックスバッファ: `Uint16Array [GRID × GRID × 6]` (全サーフェス共通)
- `s.dirty = true` のとき次フレームで再テッセレーション

---

## 7. WebGL 実装

### 7.1 コンテキスト設定

```javascript
// エディタ
const gl = cvs.getContext('webgl', {
  alpha: true,               // 背景画像を透過させるため
  premultipliedAlpha: false,
  preserveDrawingBuffer: true,  // toDataURL() でキャプチャするために必須
});
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
gl.clearColor(0, 0, 0, 0);  // 透明背景
```

### 7.2 シェーダー

```glsl
// 頂点シェーダー: [0,1] 正規化 → クリップ空間 (Y 反転)
attribute vec2 aPos; attribute vec2 aUV; varying vec2 vUV;
void main(){
  vUV = aUV;
  gl_Position = vec4(aPos.x*2.0-1.0, -(aPos.y*2.0-1.0), 0.0, 1.0);
}

// フラグメントシェーダー
precision highp float;
uniform sampler2D uTex; uniform float uAlpha; varying vec2 vUV;
void main(){ gl_FragColor = vec4(texture2D(uTex, vUV).rgb, uAlpha); }
```

### 7.3 レンダーループ

```javascript
function loop() {
  syncSize();                            // キャンバスを #main に合わせる
  gl.viewport(0, 0, cvs.width, cvs.height);
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);

  for (const s of surfs) {
    // 動画フレームをテクスチャにアップロード
    if (s.vid && s.vid.readyState >= 2) {
      gl.bindTexture(gl.TEXTURE_2D, s.texObj);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.vid);
    }
    // 制御点変更時にメッシュを再テッセレーション
    if (s.dirty) {
      const verts = tessellate(s.pts);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      s.dirty = false;
    }
    // 描画
    gl.bindBuffer(gl.ARRAY_BUFFER, s.vbo);
    gl.vertexAttribPointer(LOC_POS, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(LOC_UV,  2, gl.FLOAT, false, 16, 8);
    gl.bindTexture(gl.TEXTURE_2D, s.texObj || defTex);
    gl.uniform1i(LOC_TEX, 0); gl.uniform1f(LOC_ALPHA, s.opa);
    gl.drawElements(gl.TRIANGLES, IDX_COUNT, gl.UNSIGNED_SHORT, 0);
  }

  if (edit) drawOverlay();   // SVGハンドル描画
  syncPreview();             // プレビューへのフレーム転送（後述）
  requestAnimationFrame(loop);
}
```

---

## 8. ソース読み込み

### 8.1 動画ファイル

```javascript
// エディタ: blob URL (URL.createObjectURL)
const blobUrl = URL.createObjectURL(file);
vid.src = blobUrl;  // canplay リスナー登録後に設定

// ファイルパス取得: Electron 32+ 公式 API
const filePath = webUtils.getPathForFile(file) || file.path || '';

// 再生: canplay イベントを待ってから play()
// src直後の play() はデータ未ロードで失敗する
vid.addEventListener('canplay', () => {
  vid.play().catch(e => console.warn(e));
}, { once: true });
```

**注意**: `file.path` は Electron 42 では空になる場合がある → `webUtils.getPathForFile()` を使う。

### 8.2 ライブカメラ

```javascript
const stream = await navigator.mediaDevices.getUserMedia({
  video: deviceId ? { deviceId: { exact: deviceId } } : true,
  audio: false,
});
vid.srcObject = stream;
vid.autoplay = true; vid.muted = true;
vid.play().catch(() => {});
```

### 8.3 画面共有

`desktopCapturer` はメインプロセス専用。フロー:

```
1. ipcRenderer.invoke('get-desktop-sources')
   → main: desktopCapturer.getSources() → サムネイル付きリスト返却

2. ユーザーがピッカーUIでソースを選択

3. ipcRenderer.invoke('prepare-capture', sourceId)
   → main: session.setDisplayMediaRequestHandler() で次の getDisplayMedia に sourceId を登録

4. navigator.mediaDevices.getDisplayMedia({ video: true })
   → Electronが登録済みソースを返す
```

---

## 9. IPC 通信仕様

### 9.1 エディタ → メイン

| チャンネル | ペイロード | タイミング |
|---|---|---|
| `open-preview` | `displayIndex: Number` | PREVIEWボタン ON |
| `close-preview` | なし | PREVIEWボタン OFF |
| `blackout` | `on: Boolean` | BLACKOUTボタン |
| `preview-frame` | `dataURL: String` (JPEG) | 20fps でキャプチャ |
| `get-displays` (invoke) | なし | 起動時・ドロップダウン |
| `get-desktop-sources` (invoke) | なし | 画面共有ピッカー表示 |
| `prepare-capture` (invoke) | `sourceId: String` | ソース選択後 |

### 9.2 メイン → エディタ

| チャンネル | ペイロード | タイミング |
|---|---|---|
| `preview-closed` | なし | プレビューウィンドウが閉じられた |

### 9.3 メイン → プレビュー

| チャンネル | ペイロード | タイミング |
|---|---|---|
| `preview-frame` | `dataURL: String` | エディタから転送 |
| `blackout` | `on: Boolean` | エディタから転送 |

### 9.4 フレームキャプチャの実装

```javascript
// renderer/app.js
let captureActive = false;
function startCapture() {
  if (captureActive) return;
  captureActive = true;
  const step = () => {
    if (!previewOpen || !captureActive) { captureActive = false; return; }
    ipcRenderer.send('preview-frame', cvs.toDataURL('image/jpeg', 0.85));
    setTimeout(step, 50); // 20fps
  };
  step();
}
```

**重要**: `setBackgroundThrottling(false)` をエディタウィンドウに設定する。  
これがないとエディタが背面になったとき `requestAnimationFrame` が止まりキャプチャが途切れる。

```javascript
editorWin.webContents.setBackgroundThrottling(false);
```

---

## 10. メインプロセス (main.js)

### 10.1 エディタウィンドウ

```javascript
new BrowserWindow({
  width: 1280, height: 800, minWidth: 900, minHeight: 600,
  backgroundColor: '#07070e', title: 'ProjMap Studio',
  webPreferences: { nodeIntegration: true, contextIsolation: false },
})
// setBackgroundThrottling(false) を必ず呼ぶ
```

### 10.2 プレビューウィンドウ

```javascript
// ディスプレイの70%サイズで中央配置。通常ウィンドウとして開く。
// 投影用フルスクリーンは手動でウィンドウを最大化する
new BrowserWindow({
  x: winX, y: winY, width: winW, height: winH,
  title: 'ProjMap Preview',
  frame: true,        // タイトルバーあり → ドラッグ移動可能
  movable: true,
  resizable: true,
  fullscreenable: true,
  backgroundColor: '#000000',
  webPreferences: { nodeIntegration: true, contextIsolation: false },
})
```

### 10.3 projmap:// カスタムプロトコル

エディタが動画ファイルへのパスをキャプチャフレームに含めて送ることはないが、将来的な直接再生に備えて登録している。  
Node.js `fs.createReadStream` + Range request 対応 + CORS ヘッダー付き。

```javascript
protocol.handle('projmap', async (request) => {
  const filePath = decodeURIComponent(request.url.slice('projmap:///'.length));
  // Windows: / → \
  // Range request 対応 (動画シーク用)
  // Access-Control-Allow-Origin: * (crossOrigin:'anonymous' と対になる)
});
```

---

## 11. エディタ UI 仕様

### 11.1 レイアウト

```
┌─ ヘッダー (ツールバー) ─────────────────────────────────────────┐
│ PROJMAP  ▶PREVIEW  ■BLACKOUT  OUTPUT[1920×1080▾]  DISPLAY[▾]  EXPORT IMPORT │
└────────────────────────────────────────────────────────────────┘
┌─ サイドバー (220px) ─┬─ メインキャンバス (#main) ─────────────────┐
│ Surfaces            │                                              │
│  [サーフェスリスト] │  WebGL canvas (#glc)  ← SVG overlay (#svg) │
│  [+ Add Surface]    │  背景画像 (#bgImg)                          │
│                     │  チェッカー柄 (#checker)                    │
│ Source              │                                              │
│  [Load Video]       │                                              │
│  [Live Camera]      │                                              │
│  [Screen Share]     │                                              │
│  再生制御 ▶ ⏸ ⏮    │                                              │
│ Opacity [スライダー]│                                              │
│ [Reset] [Delete]    │                                              │
│ 座標 · TL           │                                              │
│  X [____] Y [____]  │                                              │
│ 背景画像            │                                              │
│  [投影対象の写真]   │                                              │
│ View                │                                              │
│  [Preview Mode]     │                                              │
│ Project             │                                              │
│  [Export] [Import]  │                                              │
└─────────────────────┴──────────────────────────────────────────┘
┌─ ステータスバー ──────────────────────────────────────────────────┐
│ EDIT/PREVIEW  サーフェス情報          ヘルプ     x, y px          │
└────────────────────────────────────────────────────────────────┘
```

### 11.2 SVGオーバーレイ

エディタモード時のみ表示。WebGLキャンバスの上に `position: absolute` で重ねる。

- サーフェス輪郭: 二次ベジェパス（選択時: 実線+塗りつぶし / 非選択: 破線）
- コーナーハンドル (pi % 2 === 0): 円 (●)
- 辺中点ハンドル (pi % 2 !== 0): 菱形 (◆)
- ラベル: PT_LABELS[pi] をハンドル横に表示
- サーフェス名: 中央に薄く表示

### 11.3 座標入力

- サーフェス選択時、selPt が null でも TL(0) を初期表示
- ハンドルクリックで対応する点に切り替え
- 数値変更後 `Enter` で `setPtCoord()` 呼び出し
- 単位: 出力解像度 px (1920×1080等)

### 11.4 背景画像

- エディタ専用（プレビューウィンドウには出力しない）
- WebGL canvas が `alpha: true` なので、canvas の下に `<img>` を配置すると透けて見える
- 不透明度スライダーあり
- [×クリア] で削除

---

## 12. Undo / Redo

### 12.1 スタック管理

```javascript
class UndoHistory {
  // GL リソース (vbo, texObj, vid) を除いたデータのみ深コピー
  snapshot(surfs) { ... }  // 変更前に必ず呼ぶ
  undo() { ... }  // 一つ前の状態を返す
  redo() { ... }  // 一つ後の状態を返す
}
```

最大 50 ステップ。

### 12.2 スナップショットを取るタイミング

- `addSurface()` の先頭
- `deleteSurf()` の先頭
- `resetPoints()` の先頭
- `startDragPt()` の開始時 (mousedown)
- `startMove()` の開始時
- `opaEl` の mousedown
- `importProj()` の実行前

### 12.3 Undo 適用時の注意

Undo で削除されたサーフェスが復活する場合、GL リソース (vbo) は新しく作り直す。  
テクスチャ・動画は復活しない → `srcName + '（要再読込）'` と表示。

---

## 13. キーボードショートカット

| キー | 動作 |
|---|---|
| `N` | 新規サーフェス追加 |
| `P` | プレビュー開閉 |
| `B` | BLACKOUT 切り替え |
| `Delete` / `Backspace` | 選択サーフェス削除 |
| `Escape` | 選択解除 |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |

テキスト入力中 (INPUT, SELECT にフォーカス) はすべて無効。

---

## 14. Export / Import 仕様

### 14.1 JSON フォーマット v0.4

```json
{
  "version": "0.4",
  "created": "2025-05-08T12:00:00.000Z",
  "outW": 1920,
  "outH": 1080,
  "surfaces": [
    {
      "id": 0,
      "name": "Surface 1",
      "pts": [[0.3,0.35],[0.5,0.35],[0.7,0.35],[0.7,0.5],
               [0.7,0.65],[0.5,0.65],[0.3,0.65],[0.3,0.5]],
      "srcType": "video",
      "srcPath": "C:\\Users\\...\\video.mp4",
      "srcName": "video.mp4",
      "opa": 1.0
    }
  ]
}
```

**Import 後にソースは再接続されない**。`srcName + '（要再読込）'` と表示し、ユーザーが手動で再設定する。

---

## 15. 設計上の決定と注意事項

### 15.1 Windows 固有の問題

| 問題 | 対処 |
|---|---|
| `file.path` が空 | `webUtils.getPathForFile(file)` を使用 |
| `file://` クロスオリジン制約 | `projmap://` カスタムプロトコル + `Access-Control-Allow-Origin: *` |
| MKV が再生できない | Chromium は MKV 非対応のため MP4 を推奨 |
| フルスクリーン最適化 | `alwaysOnTop: false`, `fullscreenable: false` で回避 |
| バックスラッシュ | `encodeURIComponent(path.replace(/\\/g, '/'))` で正規化 |

### 15.2 WebGL 上の注意

| 項目 | 値 | 理由 |
|---|---|---|
| `alpha` | `true` | 背景画像透過のため |
| `premultipliedAlpha` | `false` | アルファ合成が正確になる |
| `preserveDrawingBuffer` | `true` | `toDataURL()` でキャプチャするため必須 |
| `clearColor` | `(0,0,0,0)` | サーフェス外を透明にする |

### 15.3 動画再生の注意

```javascript
// NG: src直後に play() → NotAllowedError / AbortError
vid.src = url;
vid.play();  // ← 失敗する

// OK: canplay イベントを待つ
vid.addEventListener('canplay', () => vid.play(), { once: true });
vid.src = url;  // src は canplay リスナー登録後
```

### 15.4 プレビューウィンドウがフルスクリーンに見える問題

Windows 11 では `frame: false` + `alwaysOnTop: true` の組み合わせが フルスクリーン最適化を誘発する。  
**対策**: `frame: true`, `alwaysOnTop: false` にしてタイトルバー付き通常ウィンドウにする。

### 15.5 プレビューが止まる問題

Chrome は非アクティブウィンドウの `requestAnimationFrame` をスロットリングする。  
エディタウィンドウが背面になるとキャプチャが止まる。  
**対策**: `editorWin.webContents.setBackgroundThrottling(false)`

---

## 16. 定数

```javascript
// shared/constants.js
GRID  = 32     // メッシュ分割数 (33×33=1089 頂点)
OUT_W = 1920   // デフォルト出力解像度
OUT_H = 1080

// renderer/app.js
IDX_COUNT = GRID * GRID * 6  // = 6144 インデックス
MAX_UNDO  = 50
CAPTURE_FPS = 20  // = 50ms間隔
CAPTURE_QUALITY = 0.85  // JPEG品質
COLS = ['#00e5ff','#ff1a5e','#7eff00','#ffaa00','#cc44ff','#ff8c00']  // サーフェス色
```

---

## 17. プレビューウィンドウ (preview/)

### 17.1 index.html

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin:0; padding:0; }
    html,body { width:100%; height:100vh; background:#000; }
    #frame { display:block; width:100%; height:100%; object-fit:fill; }
    #blackout { display:none; position:fixed; inset:0; background:#000; z-index:999; }
  </style>
</head>
<body>
  <img id="frame" src="">
  <div id="blackout"></div>
  <script src="app.js"></script>
</body>
</html>
```

**`object-fit: fill`**: 正規化座標の縦横比はプレビューウィンドウの縦横比に合わせてストレッチする。  
サーフェスの位置関係は正規化空間で保たれるので歪みは発生しない。

### 17.2 app.js

```javascript
'use strict';
const { ipcRenderer } = require('electron');

ipcRenderer.on('preview-frame', (_e, dataURL) => {
  document.getElementById('frame').src = dataURL;
});

ipcRenderer.on('blackout', (_e, on) => {
  document.getElementById('blackout').style.display = on ? 'block' : 'none';
});
```

---

## 18. 画面共有ピッカーUI

エディタの `#screenPicker` に表示。スクリーンとウィンドウをセクション分けしてサムネイルを表示。

```
┌─ SCREEN PICKER ──────────────────────────────────┐
│  SCREENS                                         │
│  [サムネ][サムネ]                                │
│  WINDOWS                                         │
│  [サムネ][サムネ][サムネ]...                     │
│                               [Cancel]           │
└──────────────────────────────────────────────────┘
```

クリックで `startScreenCapture(surf, src)` を呼び出す。

---

## 19. 再現実装時のチェックリスト

- [ ] `preserveDrawingBuffer: true` を WebGL コンテキストに設定
- [ ] `setBackgroundThrottling(false)` をエディタウィンドウに設定
- [ ] `webUtils.getPathForFile(file)` でファイルパスを取得（`file.path` は使わない）
- [ ] 動画再生は `canplay` イベント後に `play()`（src設定直後に呼ばない）
- [ ] プレビューウィンドウは `frame: true, movable: true, resizable: true`
- [ ] `projmap://` プロトコルに `Access-Control-Allow-Origin: *` を付与
- [ ] IPC の `preview-frame` は `main.js` を中継して転送（直接は不可）
- [ ] Undo スナップショットは必ず操作の**前**に取る
- [ ] 制御点はすべて正規化 [0,1] 座標で保存・転送する
- [ ] Export JSON には `outW`, `outH` を含める（v0.4）
