// node test/bend.test.mjs — src/bend.js（折り畳み）単体テスト
import { planFolds, applyMatrix } from '../src/bend.js';

let pass = 0, fail = 0;
const approx = (a, b, tol) => Math.abs(a - b) <= tol;
function check(name, cond, extra = ''){
  if (cond){ pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}
// パネル群の全頂点(平面x,y → 折り畳み3D)の bbox
function foldedBBox(panels){
  let mnx=Infinity,mny=Infinity,mnz=Infinity,mxx=-Infinity,mxy=-Infinity,mxz=-Infinity, nan=false;
  for (const p of panels) for (const v of p.poly){
    const w = applyMatrix(p.matrix, [v[0], v[1], 0]);
    if (w.some(Number.isNaN)) nan = true;
    mnx=Math.min(mnx,w[0]); mxx=Math.max(mxx,w[0]);
    mny=Math.min(mny,w[1]); mxy=Math.max(mxy,w[1]);
    mnz=Math.min(mnz,w[2]); mxz=Math.max(mxz,w[2]);
  }
  return { nan, dx: mxx-mnx, dy: mxy-mny, dz: mxz-mnz, maxAbsZ: Math.max(Math.abs(mnz), Math.abs(mxz)) };
}
const rect = (w, h) => [[0,0],[w,0],[w,h],[0,h]];

// 1) 曲げ無し → 1パネル・恒等変換
(() => {
  console.log('1) no bends -> passthrough');
  const r = planFolds({ outline: rect(100,50), holes: [] }, []);
  check('1パネル', r.panels.length === 1, r.panels.length);
  check('恒等行列', r.panels[0].matrix[0]===1 && r.panels[0].matrix[11]===0, JSON.stringify(r.panels[0].matrix.slice(0,4)));
})();

// 2) 100x50 を x=50 で 90°上曲げ → 2パネル・折り後の足が z=±50 立ち、x幅は50に縮む
(() => {
  console.log('2) single 90deg bend at x=50');
  const bends = [{ p1:[50,0], p2:[50,50], angleDeg:90, dir:1 }];
  const r = planFolds({ outline: rect(100,50), holes: [] }, bends);
  check('2パネル', r.panels.length === 2, r.panels.length);
  const bb = foldedBBox(r.panels);
  check('NaNなし', !bb.nan);
  check('立ち上がり |z|~50', approx(bb.maxAbsZ, 50, 0.5), bb.maxAbsZ);
  check('x幅が50に縮む', approx(bb.dx, 50, 0.5), bb.dx);
  check('y幅は50のまま', approx(bb.dy, 50, 0.5), bb.dy);
})();

// 3) U字（コの字）: x=25, x=75 で両方90°上曲げ → 3パネル・中央が立つ(|z|~50)
(() => {
  console.log('3) U-channel: bends at x=25 & x=75');
  const bends = [
    { p1:[25,0], p2:[25,50], angleDeg:90, dir:1 },
    { p1:[75,0], p2:[75,50], angleDeg:90, dir:1 },
  ];
  const r = planFolds({ outline: rect(100,50), holes: [] }, bends);
  check('3パネル', r.panels.length === 3, r.panels.length);
  const bb = foldedBBox(r.panels);
  check('NaNなし', !bb.nan);
  check('|z|~50', approx(bb.maxAbsZ, 50, 0.5), bb.maxAbsZ);
})();

// 4) Z曲げ: x=33 上、x=66 谷 → 3パネル・有限
(() => {
  console.log('4) Z-bend: up then down');
  const bends = [
    { p1:[33,0], p2:[33,50], angleDeg:90, dir:1 },
    { p1:[66,0], p2:[66,50], angleDeg:90, dir:-1 },
  ];
  const r = planFolds({ outline: rect(100,50), holes: [] }, bends);
  check('3パネル', r.panels.length === 3, r.panels.length);
  check('NaNなし', !foldedBBox(r.panels).nan);
})();

// 5) 穴の割当: x=50 曲げ、穴中心(25,25) は片側パネルへ
(() => {
  console.log('5) hole assignment across bend');
  const hole = [[20,20],[30,20],[30,30],[20,30]];   // 中心(25,25)
  const r = planFolds({ outline: rect(100,50), holes: [hole] }, [{ p1:[50,0], p2:[50,50], angleDeg:90, dir:1 }]);
  const total = r.panels.reduce((s,p)=> s + p.holes.length, 0);
  check('穴は合計1つ', total === 1, total);
  const withHole = r.panels.filter(p => p.holes.length).length;
  check('1パネルだけが穴を持つ', withHole === 1, withHole);
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
