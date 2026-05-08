'use strict';
// ── 新アーキテクチャ: フレーム受信して表示するだけ ──────────────────────────
// 動画・カメラ・画面共有の区別なし。
// エディタのWebGLキャンバスをJPEGとして受け取り <img> に表示する。
// クロスオリジン問題・コーデック問題・WebGL問題すべて解消。

const { ipcRenderer } = require('electron');

const frameEl   = document.getElementById('frame');
const blackoutEl = document.getElementById('blackout');

ipcRenderer.on('preview-frame', (_e, dataURL) => {
  frameEl.src = dataURL;
});

ipcRenderer.on('blackout', (_e, on) => {
  blackoutEl.style.display = on ? 'block' : 'none';
});
