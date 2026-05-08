'use strict';
const { app, BrowserWindow, ipcMain, screen,
        desktopCapturer, session, protocol, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let editorWin  = null;
let previewWin = null;

// ── projmap:// カスタムプロトコル ──────────────────────────────────────────
// file:// は Windows のレンダラー間で挙動が不安定なため独自プロトコルで配信
// pathToFileURL を使うことでスペース・日本語等の特殊文字を正しくエンコード
function registerProtocol() {
  const fs = require('node:fs');
  const MIME = {
    '.mp4':'video/mp4', '.mkv':'video/x-matroska',
    '.webm':'video/webm', '.mov':'video/quicktime',
    '.avi':'video/x-msvideo', '.m4v':'video/mp4',
  };

  protocol.handle('projmap', async (request) => {
    const encoded  = request.url.slice('projmap:///'.length);
    // デコード後にプラットフォーム別のパス区切りに戻す
    let filePath = decodeURIComponent(encoded);
    if (process.platform === 'win32') filePath = filePath.replace(/\//g, '\\');

    let stat;
    try { stat = fs.statSync(filePath); }
    catch { return new Response('File not found: ' + filePath, { status: 404 }); }

    const ext = require('node:path').extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'video/mp4';
    const rangeHeader = request.headers.get('Range');

    // CORS ヘッダー: file://ページからprojmap://を crossOrigin:'anonymous' で読むために必須
    const CORS = { 'Access-Control-Allow-Origin': '*' };

    if (rangeHeader) {
      const [s, e] = rangeHeader.replace('bytes=', '').split('-');
      const start = parseInt(s, 10);
      const end   = e ? parseInt(e, 10) : stat.size - 1;
      const { Readable } = require('node:stream');
      const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
      return new Response(stream, {
        status: 206,
        headers: {
          ...CORS,
          'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges':  'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type':   contentType,
        },
      });
    }

    const { Readable } = require('node:stream');
    const stream = Readable.toWeb(fs.createReadStream(filePath));
    return new Response(stream, {
      headers: {
        ...CORS,
        'Content-Length': String(stat.size),
        'Content-Type':   contentType,
        'Accept-Ranges':  'bytes',
      },
    });
  });
}

function createEditorWindow() {
  editorWin = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#07070e', title: 'ProjMap Studio',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  editorWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // エディタが最小化・隠れても requestAnimationFrame を止めない
  // これがないとプレビューウィンドウ単独表示時にキャプチャが止まる
  editorWin.webContents.setBackgroundThrottling(false);
  editorWin.on('closed', () => {
    editorWin = null;
    if (previewWin) { previewWin.close(); previewWin = null; }
  });
}

function createPreviewWindow(displayIndex) {
  const displays = screen.getAllDisplays();
  const target   = displays[displayIndex] || displays[0];
  const { x, y, width, height } = target.bounds;

  const winW = Math.round(width  * 0.7);
  const winH = Math.round(height * 0.7);
  const winX = x + Math.round((width  - winW) / 2);
  const winY = y + Math.round((height - winH) / 2);

  previewWin = new BrowserWindow({
    x: winX, y: winY, width: winW, height: winH,
    title:          'ProjMap Preview',
    frame:          true,
    movable:        true,
    resizable:      true,
    fullscreenable: true,
    backgroundColor: '#000000',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  previewWin.loadFile(path.join(__dirname, 'preview', 'index.html'));



  previewWin.on('closed', () => {
    previewWin = null;
    if (editorWin) editorWin.webContents.send('preview-closed');
  });
}

// IPC
ipcMain.on('open-preview', (_e, idx) => {
  if (previewWin) { previewWin.close(); previewWin = null; }
  createPreviewWindow(Number(idx) || 0);
});
ipcMain.on('close-preview', () => {
  if (previewWin) { previewWin.close(); previewWin = null; }
});
ipcMain.on('blackout', (_e, on) => {
  if (previewWin) previewWin.webContents.send('blackout', on);
});

// エディタキャンバスのJPEGフレームをプレビューに転送
ipcMain.on('preview-frame', (_e, dataURL) => {
  if (previewWin) previewWin.webContents.send('preview-frame', dataURL);
});

ipcMain.handle('get-displays', () =>
  screen.getAllDisplays().map((d, i) => ({
    index: i,
    label: `Display ${i+1} (${d.bounds.width}x${d.bounds.height})`,
    bounds: d.bounds,
    primary: d.id === screen.getPrimaryDisplay().id,
  }))
);
ipcMain.handle('get-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  return sources.map(s => ({
    id: s.id, name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    isScreen: s.id.startsWith('screen:'),
  }));
});
ipcMain.handle('prepare-capture', async (event, sourceId) => {
  const sess = event.sender.session;
  sess.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const source  = sources.find(s => s.id === sourceId);
    callback(source ? { video: source } : {});
    sess.setDisplayMediaRequestHandler(null);
  });
});

app.whenReady().then(() => {
  registerProtocol();
  createEditorWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!editorWin) createEditorWindow(); });
