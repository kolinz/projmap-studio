'use strict';
// クーンズパッチ テッセレーション
// 両プロセス (renderer / preview) から require() で使用
const { GRID } = require('./constants.js');

// pts: [[u,v]×8] — 正規化 [0,1] 座標
// [TL, TM, TR, RM, BR, BM, BL, LM]
// 返り値: Float32Array [u_pos, v_pos, u_tex, v_tex] × (GRID+1)²
function tessellate(pts) {
  const [TL, TM, TR, RM, BR, BM, BL, LM] = pts;

  // 通過点 → 二次ベジェ制御点変換
  // B(0.5) = 0.25A + 0.5C + 0.25B = M  →  C = 2M − 0.5(A+B)
  const ctrl = (A, M, B) => [
    2*M[0] - 0.5*(A[0]+B[0]),
    2*M[1] - 0.5*(A[1]+B[1]),
  ];
  const Ct = ctrl(TL, TM, TR);
  const Cr = ctrl(TR, RM, BR);
  const Cb = ctrl(BL, BM, BR);
  const Cl = ctrl(TL, LM, BL);

  const qbez = (A, C, B, t) => {
    const s = 1 - t;
    return [s*s*A[0]+2*s*t*C[0]+t*t*B[0], s*s*A[1]+2*s*t*C[1]+t*t*B[1]];
  };

  const N   = GRID;
  const buf = new Float32Array((N+1) * (N+1) * 4);

  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const u = i/N, v = j/N;
      const top = qbez(TL, Ct, TR, u);
      const bot = qbez(BL, Cb, BR, u);
      const lft = qbez(TL, Cl, BL, v);
      const rgt = qbez(TR, Cr, BR, v);

      // クーンズパッチ公式
      const pu = (1-v)*top[0] + v*bot[0] + (1-u)*lft[0] + u*rgt[0]
               - ((1-u)*(1-v)*TL[0] + u*(1-v)*TR[0] + (1-u)*v*BL[0] + u*v*BR[0]);
      const pv = (1-v)*top[1] + v*bot[1] + (1-u)*lft[1] + u*rgt[1]
               - ((1-u)*(1-v)*TL[1] + u*(1-v)*TR[1] + (1-u)*v*BL[1] + u*v*BR[1]);

      const k = (j*(N+1)+i) * 4;
      buf[k]=pu; buf[k+1]=pv; buf[k+2]=u; buf[k+3]=v;
    }
  }
  return buf;
}

// インデックスバッファデータ (全サーフェス共通のトポロジー)
function makeIndexData() {
  const N   = GRID;
  const idx = new Uint16Array(N * N * 6);
  let k = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a=j*(N+1)+i, b=a+1, c=a+(N+1), d=c+1;
      idx[k++]=a; idx[k++]=b; idx[k++]=c;
      idx[k++]=b; idx[k++]=d; idx[k++]=c;
    }
  }
  return idx;
}

module.exports = { tessellate, makeIndexData };
