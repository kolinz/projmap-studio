'use strict';

// ── Imports ───────────────────────────────────────────────────────────────────
const { ipcRenderer, webUtils }    = require('electron');
const { pathToFileURL }            = require('node:url');
const { tessellate, makeIndexData } = require('../shared/tessellate.js');
const { UndoHistory }              = require('./undo.js');
const { GRID, OUT_W, OUT_H }       = require('../shared/constants.js');

// ── State ─────────────────────────────────────────────────────────────────────
const COLS      = ['#00e5ff','#ff1a5e','#7eff00','#ffaa00','#cc44ff','#ff8c00'];
const PT_LABELS = ['TL','TM','TR','RM','BR','BM','BL','LM'];
const IDX_COUNT = GRID * GRID * 6;

let surfs       = [];
let selId       = null;   // 選択中サーフェス ID
let selPt       = null;   // 選択中ポイントインデックス (0–7)
let edit        = true;
let blackout    = false;
let previewOpen = false;
let snapOn      = false;  // グリッドスナップ
const SNAP_DIV  = 16;     // 16分割 = 1920/16=120px, 1080/16=67.5px 間隔
let nid         = 0;
let outW        = OUT_W;  // 数値表示用の出力解像度 (レンダリングは [0,1] 正規化)
let outH        = OUT_H;

const history = new UndoHistory();

// ── WebGL ─────────────────────────────────────────────────────────────────────
const cvs = document.getElementById('glc');
const gl  = cvs.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

// 頂点シェーダー: [0,1] 正規化座標 → クリップ空間 (Y 反転)
const VERT = `
attribute vec2 aPos;
attribute vec2 aUV;
varying vec2 vUV;
void main(){
  vUV = aUV;
  gl_Position = vec4(aPos.x*2.0-1.0, -(aPos.y*2.0-1.0), 0.0, 1.0);
}`;
const FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform float uAlpha;
varying vec2 vUV;
void main(){
  gl_FragColor = vec4(texture2D(uTex, vUV).rgb, uAlpha);
}`;

function mkShader(t, s) {
  const sh = gl.createShader(t);
  gl.shaderSource(sh, s); gl.compileShader(sh); return sh;
}
const prog = gl.createProgram();
gl.attachShader(prog, mkShader(gl.VERTEX_SHADER,   VERT));
gl.attachShader(prog, mkShader(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(prog); gl.useProgram(prog);

const LOC_POS   = gl.getAttribLocation (prog, 'aPos');
const LOC_UV    = gl.getAttribLocation (prog, 'aUV');
const LOC_TEX   = gl.getUniformLocation(prog, 'uTex');
const LOC_ALPHA = gl.getUniformLocation(prog, 'uAlpha');

// 共有インデックスバッファ (全サーフェス共通)
const idxBuf = (() => {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, makeIndexData(), gl.STATIC_DRAW);
  return buf;
})();

// ── Texture helpers ───────────────────────────────────────────────────────────
function paramTex() {
  [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER].forEach(p =>
    gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR));
  [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T].forEach(p =>
    gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE));
}
function uploadCanvas(c) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  paramTex(); return t;
}
function mkVideoTex() {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
  paramTex(); return t;
}

// テストパターンテクスチャ
const defTex = (() => {
  const sz=512, c=document.createElement('canvas'); c.width=c.height=sz;
  const ctx=c.getContext('2d');
  ctx.fillStyle='#080820'; ctx.fillRect(0,0,sz,sz);
  ctx.strokeStyle='rgba(0,229,255,0.22)'; ctx.lineWidth=1;
  for(let i=0;i<=8;i++){const p=i*sz/8;['moveTo','lineTo'].forEach((_,j)=>{ctx.beginPath();if(!j)ctx.moveTo(p,0);ctx.lineTo(p,sz);ctx.stroke();ctx.beginPath();ctx.moveTo(0,p);ctx.lineTo(sz,p);ctx.stroke();});}
  ctx.strokeStyle='rgba(255,26,94,0.55)'; ctx.lineWidth=1.5;
  ctx.beginPath();ctx.moveTo(sz/2,0);ctx.lineTo(sz/2,sz);ctx.stroke();
  ctx.beginPath();ctx.moveTo(0,sz/2);ctx.lineTo(sz,sz/2);ctx.stroke();
  [[0,0],[sz-20,0],[sz-20,sz-20],[0,sz-20]].forEach(([x,y])=>{ctx.fillStyle='rgba(0,229,255,0.65)';ctx.fillRect(x,y,20,20);});
  ctx.fillStyle='rgba(255,255,255,0.75)';ctx.font='bold 34px monospace';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText('TEST PATTERN',sz/2,sz/2-16);
  ctx.font='13px monospace';ctx.fillStyle='rgba(0,229,255,0.8)';ctx.fillText('PROJMAP STUDIO',sz/2,sz/2+16);
  return uploadCanvas(c);
})();



// ── サーフェスファクトリ ──────────────────────────────────────────────────────
// 座標は [0,1] 正規化空間
function makePts(offset = 0) {
  const cx = 0.5 + offset * 0.04, cy = 0.5 + offset * 0.04;
  const hw = 0.2, hh = 0.15;
  return [
    [cx-hw, cy-hh], [cx, cy-hh], [cx+hw, cy-hh], // TL TM TR
    [cx+hw, cy],                                   // RM
    [cx+hw, cy+hh], [cx, cy+hh], [cx-hw, cy+hh], // BR BM BL
    [cx-hw, cy],                                   // LM
  ];
}

// ── レンダーループ ────────────────────────────────────────────────────────────
function syncSize() {
  const m = document.getElementById('main');
  if (cvs.width !== m.clientWidth || cvs.height !== m.clientHeight) {
    cvs.width = m.clientWidth; cvs.height = m.clientHeight;
  }
}

function loop() {
  syncSize();
  gl.viewport(0, 0, cvs.width, cvs.height);
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);

  for (const s of surfs) {
    // 全ソース（動画・カメラ・画面共有）のフレームをリアルタイムでアップロード
    if (s.vid && s.vid.readyState >= 2) {
      gl.bindTexture(gl.TEXTURE_2D, s.texObj);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.vid);
    }
    if (s.dirty) {
      const verts = tessellate(s.pts);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      s.dirty = false;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, s.vbo);
    gl.enableVertexAttribArray(LOC_POS); gl.vertexAttribPointer(LOC_POS, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(LOC_UV);  gl.vertexAttribPointer(LOC_UV,  2, gl.FLOAT, false, 16, 8);
    gl.bindTexture(gl.TEXTURE_2D, s.texObj || defTex);
    gl.uniform1i(LOC_TEX, 0); gl.uniform1f(LOC_ALPHA, s.opa);
    gl.drawElements(gl.TRIANGLES, IDX_COUNT, gl.UNSIGNED_SHORT, 0);
  }

  if (edit) drawOverlay();
  syncPreview();
  requestAnimationFrame(loop);
}

// ── SVG オーバーレイ ──────────────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k,v]) => e.setAttribute(k,v)); return e;
}
// [0,1] → canvas pixel
const toS = ([u,v]) => [u * cvs.width, v * cvs.height];

function drawOverlay() {
  const svg = document.getElementById('svg'); svg.innerHTML = '';
  const W = cvs.width, H = cvs.height;

  // グリッド線（スナップON時のみ表示）
  if (snapOn) {
    const ns = 'http://www.w3.org/2000/svg';
    for (let i = 0; i <= SNAP_DIV; i++) {
      const x = (i / SNAP_DIV) * W;
      const y = (i / SNAP_DIV) * H;
      const vl = document.createElementNS(ns, 'line');
      vl.setAttribute('x1', x); vl.setAttribute('y1', 0);
      vl.setAttribute('x2', x); vl.setAttribute('y2', H);
      vl.setAttribute('stroke', 'rgba(0,229,255,0.15)');
      vl.setAttribute('stroke-width', i % 4 === 0 ? '1' : '0.5');
      svg.appendChild(vl);
      const hl = document.createElementNS(ns, 'line');
      hl.setAttribute('x1', 0);   hl.setAttribute('y1', y);
      hl.setAttribute('x2', W);   hl.setAttribute('y2', y);
      hl.setAttribute('stroke', 'rgba(0,229,255,0.15)');
      hl.setAttribute('stroke-width', i % 4 === 0 ? '1' : '0.5');
      svg.appendChild(hl);
    }
  }
  for (const surf of surfs) {
    const col = COLS[surf.id % COLS.length], sel = surf.id === selId;
    const SP  = surf.pts.map(toS);
    const ctrl = (A,M,B) => [2*M[0]-0.5*(A[0]+B[0]), 2*M[1]-0.5*(A[1]+B[1])];
    const Ct = ctrl(SP[0],SP[1],SP[2]), Cr = ctrl(SP[2],SP[3],SP[4]);
    const Cb = ctrl(SP[4],SP[5],SP[6]), Cl = ctrl(SP[6],SP[7],SP[0]);

    const d = [`M ${SP[0]}`,`Q ${Ct} ${SP[2]}`,`Q ${Cr} ${SP[4]}`,
               `Q ${Cb} ${SP[6]}`,`Q ${Cl} ${SP[0]}`, 'Z'].join(' ');
    const path = svgEl('path', { d, fill: sel?col+'14':'none', stroke: col,
      'stroke-width': sel?'1.5':'1', 'stroke-dasharray': sel?'none':'6,4',
      opacity:'0.9', cursor:'move' });
    path.addEventListener('mousedown', e => startMove(e, surf.id));
    svg.appendChild(path);

    const cx = SP.reduce((a,p)=>a+p[0],0)/8, cy = SP.reduce((a,p)=>a+p[1],0)/8;
    const t = svgEl('text',{x:cx,y:cy+1,'text-anchor':'middle','dominant-baseline':'middle',
      'font-family':'monospace','font-size':'10','letter-spacing':'1',fill:col,opacity:'0.6','pointer-events':'none'});
    t.textContent = surf.name.toUpperCase(); svg.appendChild(t);

    if (sel) {
      SP.forEach(([sx,sy], pi) => {
        const isCorner = pi % 2 === 0, isSel = pi === selPt;
        const g = svgEl('g', { cursor: 'crosshair' });
        if (isCorner) {
          g.appendChild(svgEl('circle',{cx:sx,cy:sy,r:'13',fill:'none',stroke:col,'stroke-width':'1',opacity:'0.25'}));
          g.appendChild(svgEl('circle',{cx:sx,cy:sy,r:isSel?'8':'6',fill:col,stroke:isSel?'#fff':'#ccc','stroke-width':'2'}));
        } else {
          const s = isSel ? 7 : 5;
          g.appendChild(svgEl('polygon',{
            points:`${sx},${sy-s} ${sx+s},${sy} ${sx},${sy+s} ${sx-s},${sy}`,
            fill:col,stroke:isSel?'#fff':'#ccc','stroke-width':'1.5'}));
        }
        const lbl = svgEl('text',{x:sx+13,y:sy-7,'font-family':'monospace','font-size':'8',
          fill:col,opacity:isSel?'0.9':'0.5','pointer-events':'none'});
        lbl.textContent = PT_LABELS[pi]; g.appendChild(lbl);
        g.addEventListener('mousedown', e => { e.stopPropagation(); startDragPt(e, surf.id, pi); });
        svg.appendChild(g);
      });
    }
  }
}

// ── ドラッグ ──────────────────────────────────────────────────────────────────
function evToNorm(e) {
  const r = cvs.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
}

// グリッドスナップ: SNAP_DIV分割のグリッドに吸着
function snapPt([u, v]) {
  if (!snapOn) return [u, v];
  return [
    Math.round(u * SNAP_DIV) / SNAP_DIV,
    Math.round(v * SNAP_DIV) / SNAP_DIV,
  ];
}

// スナップ ON/OFF 切り替え
function toggleSnap() {
  snapOn = !snapOn;
  document.getElementById('snapBtn').classList.toggle('on', snapOn);
}

function startDragPt(e, sid, pi) {
  e.preventDefault();
  if (selId !== sid) selPt = null;
  selId = sid; selPt = pi;
  history.snapshot(surfs); // ドラッグ開始前にスナップショット

  const mv = ev => {
    const s = surfs.find(x => x.id === sid); if (!s) return;
    s.pts[pi] = snapPt(evToNorm(ev)); s.dirty = true;
    updatePtDisplay(s.pts[pi]);
  };
  const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  refreshUI();
}

function startMove(e, sid) {
  e.preventDefault();
  if (selId !== sid) selPt = null;
  selId = sid; refreshUI();
  history.snapshot(surfs);

  const p0 = evToNorm(e), s = surfs.find(x => x.id === sid);
  const orig = s.pts.map(p => [...p]);
  const mv = ev => {
    const [u,v] = evToNorm(ev);
    s.pts = orig.map(([pu,pv]) => [pu + u - p0[0], pv + v - p0[1]]);
    s.dirty = true;
  };
  const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
}

document.getElementById('main').addEventListener('mousemove', e => {
  const [u,v] = evToNorm(e);
  document.getElementById('sc').textContent = `${Math.round(u*outW)}, ${Math.round(v*outH)} px`;
});

// ── サーフェス管理 ────────────────────────────────────────────────────────────
function addSurface() {
  history.snapshot(surfs);
  const vbo = gl.createBuffer();
  surfs.push({
    id: nid++, name: `Surface ${surfs.length + 1}`,
    pts: makePts(surfs.length), vbo,
    texObj: null, vid: null,
    srcType: 'default', srcPath: null, srcName: 'Test Pattern',
    cameraDeviceId: null, opa: 1.0, dirty: true,
  });
  selId = surfs[surfs.length-1].id; selPt = null; refreshUI();
}

function deleteSurf(id) {
  history.snapshot(surfs);
  const s = surfs.find(x => x.id === id);
  if (s) {
    if (s.vbo)    gl.deleteBuffer(s.vbo);
    if (s.texObj) gl.deleteTexture(s.texObj);
    if (s.vid)       { s.vid.pause(); s.vid.srcObject = null; s.vid.src = ''; }
    if (s.objectUrl) { URL.revokeObjectURL(s.objectUrl); }
  }
  surfs = surfs.filter(x => x.id !== id);
  if (selId === id) { selId = surfs.length ? surfs[surfs.length-1].id : null; selPt = null; }
  refreshUI();
}
function delSel() { if (selId !== null) deleteSurf(selId); }

function resetPoints() {
  const s = surfs.find(x => x.id === selId); if (!s) return;
  history.snapshot(surfs);
  s.pts = makePts(surfs.indexOf(s)); s.dirty = true; selPt = null;
}
function setOpa(v) { const s = surfs.find(x => x.id === selId); if (s) s.opa = v / 100; }

// ── ソース読み込み ────────────────────────────────────────────────────────────
// エディタ: blob URL (URL.createObjectURL) を使用 — file:// より確実
// プレビュー: projmap:// カスタムプロトコル経由 (main.js で提供、Windows も安定)
function loadVideo(ev) {
  const file = ev.target.files[0]; if (!file) return;
  const s = surfs.find(x => x.id === selId); if (!s) return;
  history.snapshot(surfs);

  // 古いリソースを解放
  if (s.vid)       { s.vid.pause(); s.vid.srcObject = null; s.vid.src = ''; s.vid = null; }
  if (s.texObj)    { gl.deleteTexture(s.texObj); s.texObj = null; }
  if (s.objectUrl) { URL.revokeObjectURL(s.objectUrl); s.objectUrl = null; }

  const vid = document.createElement('video');
  const blobUrl = URL.createObjectURL(file);  // エディタはblob URL
  vid.loop = true; vid.muted = true;
  // canplay イベントを待ってから play() — src直後の play() はデータ未ロードで失敗する
  vid.addEventListener('canplay', () => {
    vid.play().catch(e => console.warn('video play:', e));
  }, { once: true });
  vid.addEventListener('error', () => {
    document.getElementById('vname').textContent = '❌ 再生エラー: ' + (vid.error?.message || '不明');
  });
  vid.src = blobUrl;  // src は canplay リスナー登録後に設定

  // webUtils.getPathForFile() は Electron 32+ の公式 API
  // file.path は Electron 42 で空になる場合がある
  const filePath = (typeof webUtils !== 'undefined'
    ? webUtils.getPathForFile(file)
    : file.path) || '';

  s.texObj    = mkVideoTex();
  s.vid       = vid;
  s.objectUrl = blobUrl;
  s.srcType   = 'video';
  s.srcPath   = filePath;          // プレビューへの IPC 用 (確実なパス)
  s.srcName   = file.name;
  document.getElementById('vname').textContent = '📹 ' + file.name;
  ev.target.value = ''; refreshUI(); pushSourceUpdate(s);
}

async function useCamera() {
  const s = surfs.find(x => x.id === selId);
  if (!s) { alert('サーフェスを選択してください'); return; }
  history.snapshot(surfs);
  try {
    const devices  = await navigator.mediaDevices.enumerateDevices();
    const deviceId = devices.find(d => d.kind === 'videoinput')?.deviceId ?? null;
    const stream   = await navigator.mediaDevices.getUserMedia(
      { video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false });

    if (s.vid)    { s.vid.pause(); s.vid.srcObject = null; s.vid.src = ''; }
    if (s.texObj) gl.deleteTexture(s.texObj);

    const vid = document.createElement('video');
    vid.srcObject = stream; vid.autoplay = true; vid.muted = true; vid.play().catch(()=>{});
    s.texObj = mkVideoTex(); s.vid = vid;
    s.srcType = 'camera'; s.srcPath = null; s.srcName = 'Live Camera';
    s.cameraDeviceId = deviceId;
    document.getElementById('vname').textContent = '📷 Live Camera';
    refreshUI(); pushSourceUpdate(s);
  } catch(err) { alert('カメラエラー: ' + err.message); }
}

// ── 画面共有 ──────────────────────────────────────────────────────────────────
async function useScreenShare() {
  const s = surfs.find(x => x.id === selId);
  if (!s) { alert('サーフェスを選択してください'); return; }

  document.getElementById('screenPicker').style.display = 'flex';
  document.getElementById('pickerLoading').textContent = '読み込み中...';
  document.getElementById('pickerGrid').innerHTML = '';

  try {
    // desktopCapturer はメインプロセス専用 → IPC で取得
    const sources = await ipcRenderer.invoke('get-desktop-sources');
    buildPickerUI(sources, s);
  } catch(err) {
    alert('ソース取得エラー: ' + err.message);
    closeScreenPicker();
  }
}

function buildPickerUI(sources, surf) {
  document.getElementById('pickerLoading').textContent = '';
  const grid = document.getElementById('pickerGrid');
  grid.innerHTML = '';

  // 画面とウィンドウをセクション分け
  const screens = sources.filter(s =>  s.isScreen);
  const windows = sources.filter(s => !s.isScreen);

  function addSection(label, items) {
    if (!items.length) return;
    const sec = document.createElement('div');
    sec.className = 'picker-section';
    sec.textContent = label;
    grid.appendChild(sec);

    items.forEach(src => {
      const card = document.createElement('div');
      card.className = 'source-card';
      card.innerHTML = `
        <img class="source-thumb" src="${src.thumbnail}" alt="${src.name}">
        <div class="source-name">${src.name}</div>`;
      card.addEventListener('click', () => {
        closeScreenPicker();
        startScreenCapture(surf, src);
      });
      grid.appendChild(card);
    });
  }

  addSection('SCREENS', screens);
  addSection('WINDOWS', windows);
}

function closeScreenPicker() {
  document.getElementById('screenPicker').style.display = 'none';
}

async function startScreenCapture(s, src) {
  history.snapshot(surfs);
  if (s.vid)    { s.vid.pause(); s.vid.srcObject = null; s.vid.src = ''; s.vid = null; }
  if (s.texObj) { gl.deleteTexture(s.texObj); s.texObj = null; }

  try {
    // 選択したソースID をメインプロセスに登録
    // → 次の getDisplayMedia() 呼び出しがそのソースを返すように setDisplayMediaRequestHandler を設定
    await ipcRenderer.invoke('prepare-capture', src.id);
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });

    const vid = document.createElement('video');
    vid.srcObject = stream; vid.autoplay = true; vid.muted = true;
    vid.play().catch(() => {});

    s.texObj = mkVideoTex(); s.vid = vid;
    s.srcType = 'screen'; s.srcPath = null;
    s.srcName = '🖥 ' + src.name;
    s.screenSourceId = src.id;
    s.cameraDeviceId = null;

    document.getElementById('vname').textContent = '🖥 ' + src.name;
    refreshUI(); pushSourceUpdate(s);
  } catch(err) {
    alert('画面キャプチャエラー: ' + err.message);
  }
}


// 動画再生: エディタのローカル <video> を制御し、preview にも転送
function vidCmd(cmd, value = null) {
  const s = surfs.find(x => x.id === selId);
  if (s && s.vid && s.srcType === 'video') {
    if (cmd === 'play') {
      s.vid.play().catch(() => {
        // 未ロードなら canplay 後に再試行
        s.vid.addEventListener('canplay', () => s.vid.play().catch(()=>{}), { once: true });
      });
    }
    if (cmd === 'pause')   s.vid.pause();
    if (cmd === 'restart') {
      s.vid.currentTime = 0;
      s.vid.play().catch(() => {
        s.vid.addEventListener('canplay', () => s.vid.play().catch(()=>{}), { once: true });
      });
    }
  }
  ipcRenderer.send('video-command', { command: cmd, value });
}

// ループ再生オンオフ
function setLoop(on) {
  const s = surfs.find(x => x.id === selId);
  if (s && s.vid) s.vid.loop = on;
}

// ── Audio (BGM) ───────────────────────────────────────────────────────────────
let audioEl        = null;
let audioObjectUrl = null;

function loadAudio(ev) {
  const file = ev.target.files[0]; if (!file) return;

  // 既存を解放
  if (audioEl) { audioEl.pause(); audioEl = null; }
  if (audioObjectUrl) { URL.revokeObjectURL(audioObjectUrl); audioObjectUrl = null; }

  audioObjectUrl = URL.createObjectURL(file);
  audioEl = new Audio(audioObjectUrl);
  audioEl.loop   = document.getElementById('audioLoop').checked;
  audioEl.volume = document.getElementById('audioVol').value / 100;

  document.getElementById('audioName').textContent = '🎵 ' + file.name;
  document.getElementById('audioControls').style.display = 'block';
  ev.target.value = '';
}

function audioCmd(cmd) {
  if (!audioEl) return;
  if (cmd === 'play')  audioEl.play().catch(e => console.warn('audio:', e));
  if (cmd === 'pause') audioEl.pause();
  if (cmd === 'stop')  { audioEl.pause(); audioEl.currentTime = 0; }
}

function setAudioLoop(on)  { if (audioEl) audioEl.loop = on; }
function setAudioVol(val)  { if (audioEl) audioEl.volume = val / 100; }

// ── 数値座標入力 ──────────────────────────────────────────────────────────────
function updatePtDisplay(pt) {
  if (!pt) return;
  document.getElementById('ptX').value = Math.round(pt[0] * outW);
  document.getElementById('ptY').value = Math.round(pt[1] * outH);
}
function setPtCoord() {
  const s = surfs.find(x => x.id === selId); if (!s) return;
  const pi = selPt ?? 0;
  const x = parseFloat(document.getElementById('ptX').value);
  const y = parseFloat(document.getElementById('ptY').value);
  if (isNaN(x) || isNaN(y)) return;
  history.snapshot(surfs);
  s.pts[pi] = [x / outW, y / outH]; s.dirty = true;
}
function changeRes(val) {
  const [w,h] = val.split(',').map(Number); outW = w; outH = h;
  const s = surfs.find(x => x.id === selId);
  if (s && selPt !== null) updatePtDisplay(s.pts[selPt]);
}

// ── Opacity スライダー ────────────────────────────────────────────────────────
// mousedown でスナップショット → input で更新 (Undo が1ステップで収まる)
const opaEl = document.getElementById('opa');
opaEl.addEventListener('mousedown', () => history.snapshot(surfs));
opaEl.addEventListener('input', e => setOpa(e.target.value));

// ── IPC ───────────────────────────────────────────────────────────────────────
let syncTimer = 0;
// ── フレームキャプチャ（新アーキテクチャ） ────────────────────────────────────
// エディタのWebGLキャンバスをJPEGとして送るだけ。
// 動画/カメラ/画面共有を問わず、エディタが描画したものがそのままプレビューに出る。
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
function stopCapture() { captureActive = false; }

function syncPreview() { /* フレームキャプチャ方式では不要 */ }
function pushSourceUpdate(s) { /* フレームキャプチャ方式では不要 */ }

// ── Preview / Blackout ────────────────────────────────────────────────────────
function togglePreview() {
  previewOpen = !previewOpen; edit = !previewOpen;
  document.getElementById('pvBtn').classList.toggle('on', previewOpen);
  const pill = document.getElementById('pill'), svg = document.getElementById('svg');
  const checker = document.getElementById('checker');
  pill.textContent = edit ? 'EDIT MODE' : 'PREVIEW MODE';
  pill.classList.toggle('pv', !edit);
  svg.classList.toggle('ed', edit);
  if (!edit) { svg.innerHTML = ''; checker.classList.add('hidden'); }
  else if (!bgObjectUrl) checker.classList.remove('hidden'); // 背景画像がある場合は非表示のまま
  document.getElementById('sm').textContent = edit ? 'EDIT' : 'PREVIEW';

  if (previewOpen) {
    const idx = parseInt(document.getElementById('dispSel').value) || 0;
    ipcRenderer.send('open-preview', idx);
    // プレビューウィンドウのロード後にキャプチャ開始
    setTimeout(startCapture, 300);
  } else {
    ipcRenderer.send('close-preview');
    stopCapture();
  }
  updateStatus();
}

function toggleBlackout() {
  blackout = !blackout;
  document.getElementById('boBtn').classList.toggle('on', blackout);
  ipcRenderer.send('blackout', blackout);
}

ipcRenderer.on('preview-closed', () => {
  previewOpen = false; edit = true; stopCapture();
  document.getElementById('pvBtn').classList.remove('on');
  document.getElementById('pill').textContent = 'EDIT MODE';
  document.getElementById('pill').classList.remove('pv');
  document.getElementById('svg').classList.add('ed');
  if (!bgObjectUrl) document.getElementById('checker').classList.remove('hidden');
  document.getElementById('sm').textContent = 'EDIT';
  updateStatus();
});

async function populateDisplays() {
  const displays = await ipcRenderer.invoke('get-displays');
  const sel = document.getElementById('dispSel'); sel.innerHTML = '';
  displays.forEach(d => {
    const o = document.createElement('option');
    o.value = d.index; o.textContent = d.label + (d.primary ? ' (Primary)' : '');
    sel.appendChild(o);
  });
  if (displays.length > 1) sel.value = 1;
}
populateDisplays();

// ── Undo / Redo ───────────────────────────────────────────────────────────────
function applyHistory(data) {
  const hIds = data.map(d => d.id);
  // 履歴にないサーフェスを削除
  surfs.filter(s => !hIds.includes(s.id)).forEach(s => {
    if (s.vbo)    gl.deleteBuffer(s.vbo);
    if (s.texObj) gl.deleteTexture(s.texObj);
    if (s.vid)    { s.vid.pause(); s.vid.src = ''; }
  });
  surfs = surfs.filter(s => hIds.includes(s.id));

  // 更新 or 再生成
  data.forEach(d => {
    let s = surfs.find(x => x.id === d.id);
    if (s) {
      s.pts = d.pts.map(p => [...p]); s.opa = d.opa; s.dirty = true;
    } else {
      // 削除されたサーフェスを再生成 (テクスチャは要再読込)
      surfs.push({
        id: d.id, name: d.name, pts: d.pts.map(p => [...p]), opa: d.opa,
        srcType: 'default', srcPath: d.srcPath,
        srcName: d.srcName + '（要再読込）',
        cameraDeviceId: null,
        texObj: null, vid: null, vbo: gl.createBuffer(), dirty: true,
      });
    }
  });
  surfs.sort((a,b) => hIds.indexOf(a.id) - hIds.indexOf(b.id));
  nid = Math.max(nid, ...hIds, -1) + 1;
  selId = (selId && hIds.includes(selId)) ? selId : (hIds[0] ?? null);
  selPt = null; refreshUI();
}

function undo() { const s = history.undo(); if (s) applyHistory(s); }
function redo() { const s = history.redo(); if (s) applyHistory(s); }

// ── Export / Import ───────────────────────────────────────────────────────────
function exportProj() {
  const data = {
    version: '0.4', created: new Date().toISOString(), outW, outH,
    surfaces: surfs.map(s => ({
      id: s.id, name: s.name, pts: s.pts, srcType: s.srcType,
      srcPath: s.srcPath, srcName: s.srcName, opa: s.opa,
    })),
  };
  const a = document.createElement('a');
  a.href = 'data:application/json,' + encodeURIComponent(JSON.stringify(data, null, 2));
  a.download = 'projmap_project.json'; a.click();
}

function importProj(ev) {
  const f = ev.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = e => {
    try {
      const d = JSON.parse(e.target.result);
      history.snapshot(surfs); // import もアンドゥ可能に

      if (d.outW && d.outH) {
        outW = d.outW; outH = d.outH;
        const sel = document.getElementById('outRes');
        const opt = `${outW},${outH}`;
        if ([...sel.options].some(o => o.value === opt)) sel.value = opt;
      }
      surfs.forEach(s => {
        if (s.vbo)    gl.deleteBuffer(s.vbo);
        if (s.texObj) gl.deleteTexture(s.texObj);
        if (s.vid)    { s.vid.pause(); s.vid.src = ''; }
      });
      surfs = []; selId = null; selPt = null; nid = 0;
      d.surfaces.forEach(s => {
        const vbo = gl.createBuffer();
        surfs.push({ ...s, pts: s.pts.map(p=>[...p]), vbo, texObj:null, vid:null, dirty:true });
        if (s.id >= nid) nid = s.id + 1;
      });
      refreshUI();
    } catch(err) { alert('Import error: ' + err.message); }
  };
  rd.readAsText(f); ev.target.value = '';
}

// ── UI ────────────────────────────────────────────────────────────────────────
function refreshUI() {
  const list = document.getElementById('list'); list.innerHTML = '';
  surfs.forEach(s => {
    const col = COLS[s.id % COLS.length];
    const div = document.createElement('div');
    div.className = 'sc' + (s.id === selId ? ' sel' : '');
    div.innerHTML = `
      <div class="sc-h">
        <span class="dot" style="background:${col}"></span>
        <span class="sc-name">${s.name}</span>
        <button class="sc-del" onclick="event.stopPropagation();deleteSurf(${s.id})">×</button>
      </div>
      <div class="sc-src">${s.srcName}</div>`;
    div.addEventListener('click', () => { if (selId !== s.id) selPt = null; selId = s.id; refreshUI(); });
    list.appendChild(div);
  });

  const sel = surfs.find(s => s.id === selId);
  document.getElementById('props').style.display = sel ? 'block' : 'none';
  if (sel) {
    document.getElementById('opa').value = Math.round(sel.opa * 100);
    const vn = sel.srcName !== 'Test Pattern' ? sel.srcName : '';
    if (!document.getElementById('vname').textContent.includes('⏳'))
      document.getElementById('vname').textContent = vn;
    document.getElementById('videoControls').style.display =
      sel.srcType === 'video' ? 'block' : 'none';
    if (sel.srcType === 'video' && sel.vid) {
      document.getElementById('loopCheck').checked = sel.vid.loop;
    }
  }

  const ptEditor = document.getElementById('ptEditor');
  // サーフェス選択時は selPt が null でも TL(0) をデフォルト表示
  const showPt = selPt ?? (sel ? 0 : null);
  if (sel && showPt !== null) {
    ptEditor.style.display = 'block';
    document.getElementById('ptLabel').textContent = PT_LABELS[showPt];
    updatePtDisplay(sel.pts[showPt]);
  } else {
    ptEditor.style.display = 'none';
  }
  updateStatus();
}

function updateStatus() {
  const n = surfs.length, sel = surfs.find(s => s.id === selId);
  document.getElementById('st').textContent =
    n === 0 ? 'サーフェスを追加してください' :
    sel ? `${n}枚 · ${sel.name} 選択中` : `${n}枚 · クリックで選択`;
}

// ── キーボード ────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault(); e.shiftKey ? redo() : undo(); return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') delSel();
  if (e.key === 'p' || e.key === 'P') togglePreview();
  if (e.key === 'b' || e.key === 'B') toggleBlackout();
  if (e.key === 'n' || e.key === 'N') addSurface();
  if (e.key === 'Escape') { selId = null; selPt = null; refreshUI(); }
});

// ── 背景画像 (エディタ限定・プレビューには出力しない) ──────────────────────
// WebGL キャンバスが alpha:true なので、下に敷いた <img> が透けて見える仕組み
let bgObjectUrl = null;

function loadBgImage(ev) {
  const file = ev.target.files[0]; if (!file) return;
  if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
  bgObjectUrl = URL.createObjectURL(file);

  const img = document.getElementById('bgImg');
  img.src = bgObjectUrl;
  img.style.display = 'block';
  img.style.opacity = document.getElementById('bgOpa').value / 100;

  // チェッカー柄を非表示にして背景写真を前面に
  document.getElementById('checker').style.display = 'none';
  document.getElementById('bgControls').style.display = 'block';
  ev.target.value = '';
}

function clearBgImage() {
  if (bgObjectUrl) { URL.revokeObjectURL(bgObjectUrl); bgObjectUrl = null; }
  document.getElementById('bgImg').src = '';
  document.getElementById('bgImg').style.display = 'none';
  document.getElementById('bgControls').style.display = 'none';
  // edit モードならチェッカー柄を戻す
  if (edit) document.getElementById('checker').style.display = '';
}

function setBgOpacity(v) {
  document.getElementById('bgImg').style.opacity = v / 100;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loop();
