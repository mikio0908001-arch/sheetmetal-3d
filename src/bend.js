// src/bend.js
// 平行な曲げ線で平板を「短冊（パネル）」に分割し、ヒンジ連鎖として折り畳む（概形・シャープ曲げ）。
// 依存なし・DOM/three.js 非依存（Node で単体テスト可能）。three.js 側は返り値の matrix を使うだけ。
//
// planFolds({outline, holes}, bends, opts) -> {
//   panels: [{ poly:[[x,y]...], holes:[[[x,y]...]...], matrix:number[16] }],  // matrix は row-major 4x4
//   axis: [dx,dy],            // 曲げ線方向（単位ベクトル）
//   warnings: string[]
// }
//   - outline/holes は mm・平面座標。bends は [{p1:[x,y], p2:[x,y], angleDeg, dir}]（dir: 1=山 / -1=谷）。
//   - matrix は 平面点 (x,y,0) を折り畳み後の 3D 位置へ写す変換。
//   - v1 は「平行な曲げ」のみ。非平行は先頭の曲げ方向へ射影して近似（警告）。

const EPS = 1e-7;

// ---- 4x4 行列（row-major, 長さ16） ----
function ident(){ return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function mul(A, B){
  const C = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++){
    let s = 0; for (let k = 0; k < 4; k++) s += A[r*4+k] * B[k*4+c];
    C[r*4+c] = s;
  }
  return C;
}
function translate(x, y, z){ const m = ident(); m[3] = x; m[7] = y; m[11] = z; return m; }
// 単位ベクトル u まわり theta 回転（Rodrigues）
function rotAxis(u, theta){
  const [x, y, z] = u, c = Math.cos(theta), s = Math.sin(theta), t = 1 - c;
  return [
    t*x*x + c,   t*x*y - s*z, t*x*z + s*y, 0,
    t*x*y + s*z, t*y*y + c,   t*y*z - s*x, 0,
    t*x*z - s*y, t*y*z + s*x, t*z*z + c,   0,
    0, 0, 0, 1,
  ];
}
// 点 a を通り方向 u の軸まわり theta 回転（T(a)·R·T(-a)）
function rotateAboutLine(a, u, theta){
  return mul(translate(a[0], a[1], a[2]), mul(rotAxis(u, theta), translate(-a[0], -a[1], -a[2])));
}
// 点 [x,y,z] に行列を適用（テスト・確認用）
export function applyMatrix(M, p){
  const x = p[0], y = p[1], z = p[2] || 0;
  return [
    M[0]*x + M[1]*y + M[2]*z + M[3],
    M[4]*x + M[5]*y + M[6]*z + M[7],
    M[8]*x + M[9]*y + M[10]*z + M[11],
  ];
}

// ---- 幾何 ----
function dot(a, b){ return a[0]*b[0] + a[1]*b[1]; }
function norm(v){ const L = Math.hypot(v[0], v[1]) || 1; return [v[0]/L, v[1]/L]; }
function centroid(loop){ let x = 0, y = 0; for (const p of loop){ x += p[0]; y += p[1]; } return [x/loop.length, y/loop.length]; }

// 半平面クリップ（n·p <= c を残す / keepLess=false なら >=）。凸帯のクリップに使用。
function clipHalfPlane(poly, n, c, keepLess){
  const inside = p => keepLess ? (dot(n, p) <= c + EPS) : (dot(n, p) >= c - EPS);
  const out = [];
  for (let i = 0; i < poly.length; i++){
    const A = poly[i], B = poly[(i + 1) % poly.length];
    const Ain = inside(A), Bin = inside(B);
    if (Ain) out.push(A);
    if (Ain !== Bin){
      const dA = dot(n, A) - c, dB = dot(n, B) - c;
      const tt = dA / (dA - dB);
      out.push([A[0] + tt*(B[0]-A[0]), A[1] + tt*(B[1]-A[1])]);
    }
  }
  return out;
}
// 帯 [lo, hi]（n方向の座標範囲）でクリップ。lo/hi は null 可（片側無限）。
function clipBand(poly, n, lo, hi){
  let p = poly;
  if (hi !== null) p = clipHalfPlane(p, n, hi, true);
  if (lo !== null) p = clipHalfPlane(p, n, lo, false);
  return p;
}

export function planFolds(flat, bends, opts = {}){
  const warnings = [];
  const outline = flat.outline.map(p => [p[0], p[1]]);
  const holes = (flat.holes || []).map(h => h.map(p => [p[0], p[1]]));

  if (!bends || bends.length === 0){
    return { panels: [{ poly: outline, holes, matrix: ident() }], axis: [1, 0], warnings };
  }

  // 曲げ線方向（先頭基準）。n = 方向の法線（短冊を並べる軸）。
  const toXY = p => Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y];
  const b0p1 = toXY(bends[0].p1), b0p2 = toXY(bends[0].p2);
  const d = norm([b0p2[0] - b0p1[0], b0p2[1] - b0p1[1]]);
  const n = [-d[1], d[0]];

  // 各曲げ → {offset(n方向), a(線上の点), theta(符号付き角)}
  const lines = bends.map(b => {
    const p1 = toXY(b.p1), p2 = toXY(b.p2);
    const bd = norm([p2[0] - p1[0], p2[1] - p1[1]]);
    const par = Math.abs(bd[0]*d[0] + bd[1]*d[1]);     // 1 に近いほど平行
    if (par < 0.985) warnings.push('非平行な曲げ線を平行近似で処理しました');
    const theta = (b.dir < 0 ? -1 : 1) * (b.angleDeg || 90) * Math.PI / 180;
    return { off: dot(p1, n), a: [p1[0], p1[1], 0], theta };
  }).sort((A, B) => A.off - B.off);

  // 短冊（パネル）= 連続する曲げオフセットの間。m本の曲げ → m+1パネル。
  const offs = lines.map(l => l.off);
  const panelsRaw = [];
  for (let i = 0; i <= lines.length; i++){
    const lo = i === 0 ? null : offs[i - 1];
    const hi = i === lines.length ? null : offs[i];
    const poly = clipBand(outline, n, lo, hi);
    panelsRaw.push({ poly: poly.length >= 3 ? poly : null, lo, hi });
  }

  // 累積変換: M_0 = I, M_i = M_{i-1} · R_{i-1}（R_k = 曲げkの軸まわり回転）
  const mats = [ident()];
  for (let k = 0; k < lines.length; k++){
    const Rk = rotateAboutLine(lines[k].a, [d[0], d[1], 0], lines[k].theta);
    mats.push(mul(mats[k], Rk));
  }

  // 穴を所属パネルへ（中心の n 座標で判定）
  const holeOf = [];
  for (const h of holes){
    const t = dot(centroid(h), n);
    let idx = lines.length;                             // 最後のパネル
    for (let i = 0; i < offs.length; i++){ if (t <= offs[i]){ idx = i; break; } }
    holeOf.push(idx);
  }

  // パネル組み立て
  const panels = [];
  let dropped = 0;
  for (let i = 0; i <= lines.length; i++){
    const pr = panelsRaw[i];
    if (!pr.poly){ dropped++; continue; }
    const ph = [];
    for (let hi = 0; hi < holes.length; hi++) if (holeOf[hi] === i) ph.push(holes[hi]);
    panels.push({ poly: pr.poly, holes: ph, matrix: mats[i] });
  }
  if (dropped) warnings.push(`曲げ線が外形を横切らない区画が ${dropped} 箇所あり無視しました`);

  return { panels, axis: d, warnings };
}

export default planFolds;
