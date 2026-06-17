// src/dxf.js
// 最小・自己完結の ASCII DXF パーサ（板金フラットパターン向け）。
// 依存なし・DOM 非依存（ブラウザでも Node でもそのまま import できる＝テスト可能）。
//
// parseDxf(text) -> {
//   units, scaleToMm,                 // 単位情報（$INSUNITS）
//   outline: [[x,y], ...],            // 外形（mm・CCW）
//   holes:   [ [[x,y], ...], ... ],   // 穴（mm・CW）
//   loops:   number,                  // 検出した閉ループ総数
//   warnings: string[]                // 未対応・無視した点
// }
//
// 対応エンティティ: LINE / LWPOLYLINE / POLYLINE+VERTEX / CIRCLE / ARC。
//   - LWPOLYLINE・POLYLINE の bulge（円弧セグメント）に対応。
//   - バラバラの LINE/ARC は端点で連結して閉ループ化。
//   - 最大面積のループ＝外形、その内側のループ＝穴。
// 非対応（警告して無視）: SPLINE / ELLIPSE / INSERT(ブロック展開) / バイナリDXF。

const ARC_SEG = 64; // 円・円弧の分割数（概形用）

// ---- 単位コード（$INSUNITS）→ mm 係数 ----
const UNIT = {
  0: ['unknown', 1],   // 無指定 → mm 想定
  1: ['inch', 25.4],
  2: ['feet', 304.8],
  4: ['mm', 1],
  5: ['cm', 10],
  6: ['m', 1000],
};

function hypot(ax, ay, bx, by){ return Math.hypot(ax - bx, ay - by); }

// ---- code/value ペアへ分解（ASCII DXF は code 行・value 行の交互） ----
function tokenize(text){
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  let i = 0;
  while (i < lines.length){
    const codeLine = lines[i].trim(); i++;
    if (codeLine === '') continue;            // 迷子の空行を吸収
    const code = parseInt(codeLine, 10);
    if (Number.isNaN(code)) continue;          // コードでない行は読み飛ばす
    const value = (i < lines.length) ? lines[i] : ''; i++;
    pairs.push([code, value.trim()]);
  }
  return pairs;
}

// ---- HEADER から $INSUNITS を取得 ----
function readUnits(pairs){
  for (let k = 0; k < pairs.length - 2; k++){
    if (pairs[k][0] === 9 && pairs[k][1] === '$INSUNITS'){
      // 直後の code 70 が値
      for (let j = k + 1; j < Math.min(k + 4, pairs.length); j++){
        if (pairs[j][0] === 70){
          const u = parseInt(pairs[j][1], 10);
          return UNIT[u] || ['unknown', 1];
        }
      }
    }
  }
  return ['unknown', 1];
}

// ---- ENTITIES セクションのエンティティを抽出（type と code 列） ----
function readEntities(pairs){
  const ents = [];
  let section = null, pendingSection = false, cur = null;
  const flush = () => { if (cur) { ents.push(cur); cur = null; } };

  for (let k = 0; k < pairs.length; k++){
    const [code, val] = pairs[k];
    if (code === 0){
      if (val === 'SECTION'){ flush(); pendingSection = true; section = null; continue; }
      if (val === 'ENDSEC'){ flush(); section = null; continue; }
      if (val === 'EOF'){ flush(); break; }
      // それ以外の code 0 はエンティティ開始
      flush();
      if (section === 'ENTITIES') cur = { type: val, codes: [] };
      else cur = null;
      continue;
    }
    if (pendingSection && code === 2){ section = val; pendingSection = false; continue; }
    if (cur) cur.codes.push([code, val]);
  }
  return ents;
}

// code 列から最初に一致した値を数値で取得
function num(codes, code){
  for (const [c, v] of codes) if (c === code) return parseFloat(v);
  return undefined;
}
function int(codes, code){
  for (const [c, v] of codes) if (c === code) return parseInt(v, 10);
  return undefined;
}

// ---- bulge（円弧）セグメントを点列に展開（始点は含めず、終点までの中間+終点を返す） ----
// bulge = tan(含み角/4)。正=CCW, 負=CW。
function expandBulge(p1, p2, bulge, segs = 24){
  const out = [];
  const a = 4 * Math.atan(bulge);                 // 含み角（符号付き）
  const chord = hypot(p1[0], p1[1], p2[0], p2[1]);
  if (chord < 1e-12 || Math.abs(bulge) < 1e-9){ out.push(p2); return out; }
  const t = Math.tan(a / 2);
  // 中心の閉形式
  const cx = (p1[0] + p2[0]) / 2 - ((p2[1] - p1[1]) / 2) / t;
  const cy = (p1[1] + p2[1]) / 2 + ((p2[0] - p1[0]) / 2) / t;
  const r = hypot(p1[0], p1[1], cx, cy);
  let a1 = Math.atan2(p1[1] - cy, p1[0] - cx);
  const n = Math.max(2, Math.ceil(Math.abs(a) / (2 * Math.PI) * segs));
  for (let i = 1; i <= n; i++){
    const ang = a1 + a * (i / n);
    out.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
  }
  // 数値誤差で終点がずれないよう最後を厳密化
  out[out.length - 1] = [p2[0], p2[1]];
  return out;
}

// ---- 各エンティティ → ポリライン {pts, closed} へ ----
function entityToPolyline(ent, warnings){
  const c = ent.codes;
  switch (ent.type){
    case 'LINE': {
      const a = [num(c, 10), num(c, 20)], b = [num(c, 11), num(c, 21)];
      if (a.some(Number.isNaN) || b.some(Number.isNaN)) return null;
      return [{ pts: [a, b], closed: false }];
    }
    case 'CIRCLE': {
      const cx = num(c, 10), cy = num(c, 20), r = num(c, 40);
      if ([cx, cy, r].some(v => v === undefined || Number.isNaN(v))) return null;
      const pts = [];
      for (let i = 0; i < ARC_SEG; i++){
        const ang = (i / ARC_SEG) * 2 * Math.PI;
        pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
      }
      return [{ pts, closed: true }];
    }
    case 'ARC': {
      const cx = num(c, 10), cy = num(c, 20), r = num(c, 40);
      let a0 = num(c, 50), a1 = num(c, 51);            // 度・CCW
      if ([cx, cy, r, a0, a1].some(v => v === undefined || Number.isNaN(v))) return null;
      a0 = a0 * Math.PI / 180; a1 = a1 * Math.PI / 180;
      let sweep = a1 - a0; while (sweep <= 0) sweep += 2 * Math.PI;
      const n = Math.max(2, Math.ceil(sweep / (2 * Math.PI) * ARC_SEG));
      const pts = [];
      for (let i = 0; i <= n; i++){
        const ang = a0 + sweep * (i / n);
        pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
      }
      return [{ pts, closed: false }];
    }
    case 'LWPOLYLINE': {
      const flag = int(c, 70) || 0;
      const closed = (flag & 1) === 1;
      // 頂点を順に: code 10 が出るたびに新頂点。直後の 20=y、任意の 42=bulge。
      const verts = [];
      for (let i = 0; i < c.length; i++){
        if (c[i][0] === 10){
          const x = parseFloat(c[i][1]);
          let y = NaN, bulge = 0;
          for (let j = i + 1; j < c.length && c[j][0] !== 10; j++){
            if (c[j][0] === 20) y = parseFloat(c[j][1]);
            if (c[j][0] === 42) bulge = parseFloat(c[j][1]);
          }
          if (!Number.isNaN(x) && !Number.isNaN(y)) verts.push({ x, y, bulge });
        }
      }
      return [polyFromVerts(verts, closed)];
    }
    case 'POLYLINE': {
      const flag = int(c, 70) || 0;
      const closed = (flag & 1) === 1;
      // VERTEX は ent.vertices に集約済み（readEntities 後段でまとめる）
      const verts = (ent.vertices || []).map(v => ({
        x: num(v.codes, 10), y: num(v.codes, 20), bulge: num(v.codes, 42) || 0,
      })).filter(v => !Number.isNaN(v.x) && !Number.isNaN(v.y));
      if (verts.length < 2) return null;
      return [polyFromVerts(verts, closed)];
    }
    case 'SPLINE': case 'ELLIPSE': case 'INSERT':
      warnings.add(`${ent.type} は未対応のため無視しました`);
      return null;
    default:
      return null;
  }
}

// 頂点列（bulge 付き）→ {pts, closed}
function polyFromVerts(verts, closed){
  const pts = [];
  if (verts.length === 0) return { pts, closed };
  pts.push([verts[0].x, verts[0].y]);
  const last = verts.length - (closed ? 0 : 1);
  for (let i = 0; i < last; i++){
    const v = verts[i];
    const w = verts[(i + 1) % verts.length];
    const p1 = [v.x, v.y], p2 = [w.x, w.y];
    if (Math.abs(v.bulge) > 1e-9){
      for (const p of expandBulge(p1, p2, v.bulge, ARC_SEG)) pts.push(p);
    } else {
      pts.push(p2);
    }
  }
  return { pts, closed };
}

// ---- 幾何ユーティリティ ----
function signedArea(loop){
  let s = 0;
  for (let i = 0; i < loop.length; i++){
    const a = loop[i], b = loop[(i + 1) % loop.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
function area(loop){ return Math.abs(signedArea(loop)); }
function centroid(loop){
  let x = 0, y = 0;
  for (const p of loop){ x += p[0]; y += p[1]; }
  return [x / loop.length, y / loop.length];
}
function pointInPoly(pt, loop){
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++){
    const xi = loop[i][0], yi = loop[i][1], xj = loop[j][0], yj = loop[j][1];
    const hit = ((yi > pt[1]) !== (yj > pt[1])) &&
      (pt[0] < (xj - xi) * (pt[1] - yi) / ((yj - yi) || 1e-12) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}
function dedupe(loop, tol){
  const out = [];
  for (const p of loop){
    const q = out[out.length - 1];
    if (!q || hypot(p[0], p[1], q[0], q[1]) > tol) out.push(p);
  }
  // 先頭=末尾の重複を除去
  if (out.length > 1 && hypot(out[0][0], out[0][1], out[out.length - 1][0], out[out.length - 1][1]) <= tol) out.pop();
  return out;
}

// ---- バラバラのポリラインを端点連結して閉ループ化 ----
function buildLoops(polys, tol){
  const loops = [];
  const open = [];
  for (const p of polys){
    const pts = p.pts;
    if (!pts || pts.length < 2) continue;
    if (p.closed) loops.push(pts.slice());
    else open.push(pts.slice());
  }
  const near = (a, b) => hypot(a[0], a[1], b[0], b[1]) <= tol;
  const used = new Array(open.length).fill(false);
  let leftover = 0;

  for (let i = 0; i < open.length; i++){
    if (used[i]) continue;
    used[i] = true;
    let chain = open[i].slice();
    let extended = true;
    while (extended){
      extended = false;
      if (chain.length >= 3 && near(chain[0], chain[chain.length - 1])) break;
      const tail = chain[chain.length - 1];
      for (let j = 0; j < open.length; j++){
        if (used[j]) continue;
        const seg = open[j];
        if (near(tail, seg[0])) { chain = chain.concat(seg.slice(1)); used[j] = true; extended = true; break; }
        if (near(tail, seg[seg.length - 1])) { chain = chain.concat(seg.slice(0, -1).reverse()); used[j] = true; extended = true; break; }
      }
      if (extended) continue;
      const head = chain[0];                  // 先頭側にも伸ばす
      for (let j = 0; j < open.length; j++){
        if (used[j]) continue;
        const seg = open[j];
        if (near(head, seg[seg.length - 1])) { chain = seg.slice(0, -1).concat(chain); used[j] = true; extended = true; break; }
        if (near(head, seg[0])) { chain = seg.slice(1).reverse().concat(chain); used[j] = true; extended = true; break; }
      }
    }
    if (chain.length >= 3 && near(chain[0], chain[chain.length - 1])){
      chain.pop();
      loops.push(chain);
    } else {
      leftover++;
    }
  }
  return { loops, leftover };
}

// ---- メイン ----
export function parseDxf(text){
  const warnings = new Set();
  if (typeof text !== 'string') throw new Error('DXFテキストを渡してください');
  if (/^AutoCAD Binary DXF/.test(text)) throw new Error('バイナリDXFは未対応です（ASCII DXFで保存してください）');

  const pairs = tokenize(text);
  if (pairs.length === 0) throw new Error('DXFを解釈できませんでした');

  const [units, scaleToMm] = readUnits(pairs);
  if (units === 'unknown') warnings.add('単位($INSUNITS)が無いため mm と仮定しました');

  // エンティティ抽出（POLYLINE は後続 VERTEX をまとめる）
  const raw = readEntities(pairs);
  const ents = [];
  for (let i = 0; i < raw.length; i++){
    const e = raw[i];
    if (e.type === 'POLYLINE'){
      e.vertices = [];
      let j = i + 1;
      for (; j < raw.length && raw[j].type === 'VERTEX'; j++) e.vertices.push(raw[j]);
      if (j < raw.length && raw[j].type === 'SEQEND') j++;
      ents.push(e);
      i = j - 1;
    } else if (e.type === 'VERTEX' || e.type === 'SEQEND'){
      // POLYLINE 直下で消費済み
    } else {
      ents.push(e);
    }
  }

  // ポリライン化
  const polys = [];
  for (const e of ents){
    const r = entityToPolyline(e, warnings);
    if (r) for (const p of r) if (p && p.pts && p.pts.length >= 2) polys.push(p);
  }
  if (polys.length === 0) throw new Error('対応する図形(線/ポリライン/円/円弧)が見つかりませんでした');

  // 全点の bbox から許容誤差を決める
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const q of p.pts){
    if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0];
    if (q[1] < minY) minY = q[1]; if (q[1] > maxY) maxY = q[1];
  }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const tol = Math.max(diag * 1e-4, 1e-6);

  // 閉ループ化
  let { loops, leftover } = buildLoops(polys, tol);
  if (leftover > 0) warnings.add(`閉じない線分が ${leftover} 本あり無視しました`);
  loops = loops.map(l => dedupe(l, tol)).filter(l => l.length >= 3);
  if (loops.length === 0) throw new Error('閉じた輪郭を構成できませんでした');

  // 単位を mm へ
  if (scaleToMm !== 1){
    for (const l of loops) for (const p of l){ p[0] *= scaleToMm; p[1] *= scaleToMm; }
  }

  // 最大面積＝外形、その内側＝穴
  loops.sort((a, b) => area(b) - area(a));
  const outline = loops[0];
  const holes = [];
  for (let i = 1; i < loops.length; i++){
    const rep = centroid(loops[i]);
    if (pointInPoly(rep, outline)) holes.push(loops[i]);
    else warnings.add('外形の外側にある閉ループを無視しました（複数部品は未対応）');
  }

  // 巻き方向を正規化（外形 CCW=正、穴 CW=負）
  if (signedArea(outline) < 0) outline.reverse();
  for (const h of holes) if (signedArea(h) > 0) h.reverse();

  return {
    units, scaleToMm,
    outline, holes,
    loops: loops.length,
    warnings: [...warnings],
  };
}

export default parseDxf;
