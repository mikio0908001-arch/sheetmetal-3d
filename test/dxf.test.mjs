// node test/dxf.test.mjs  — src/dxf.js のパーサ単体テスト（ブラウザ不要）
import { parseDxf } from '../src/dxf.js';

let pass = 0, fail = 0;
const approx = (a, b, tol) => Math.abs(a - b) <= tol;
function check(name, cond, extra = ''){
  if (cond){ pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}
function bbox(loop){
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of loop){ minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { w: maxX - minX, h: maxY - minY, minX, minY, maxX, maxY };
}
function area(loop){
  let s = 0;
  for (let i = 0; i < loop.length; i++){ const a = loop[i], b = loop[(i + 1) % loop.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s / 2);
}
const dxf = (...rows) => rows.join('\n') + '\n';
const ENT = (...body) => dxf('0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC', '0', 'EOF');

// 1) 閉じた LWPOLYLINE の長方形 100x50 + CIRCLE 穴(r=5)
(() => {
  console.log('1) LWPOLYLINE rect + CIRCLE hole');
  const t = ENT(
    '0','LWPOLYLINE','90','4','70','1',
    '10','0','20','0','10','100','20','0','10','100','20','50','10','0','20','50',
    '0','CIRCLE','10','50','20','25','40','5',
  );
  const r = parseDxf(t);
  const bb = bbox(r.outline);
  check('外形 bbox 100x50', approx(bb.w, 100, 0.01) && approx(bb.h, 50, 0.01), JSON.stringify(bb));
  check('外形 面積 ~5000', approx(area(r.outline), 5000, 1), area(r.outline));
  check('穴が1つ', r.holes.length === 1, r.holes.length);
  check('穴 面積 ~78.5', approx(area(r.holes[0]), 78.54, 1), r.holes.length ? area(r.holes[0]) : 'n/a');
})();

// 2) バラバラの 4本 LINE → 連結して長方形に閉じる
(() => {
  console.log('2) 4x LINE chaining -> closed rect');
  const L = (x1,y1,x2,y2) => ['0','LINE','10',`${x1}`,'20',`${y1}`,'11',`${x2}`,'21',`${y2}`];
  const t = ENT(...L(0,0,100,0), ...L(100,0,100,50), ...L(100,50,0,50), ...L(0,50,0,0));
  const r = parseDxf(t);
  check('1ループ', r.loops === 1, r.loops);
  check('穴なし', r.holes.length === 0, r.holes.length);
  check('面積 ~5000', approx(area(r.outline), 5000, 1), area(r.outline));
})();

// 3) bulge=1 を2つ → 直径10の真円（bulge展開の検証）
(() => {
  console.log('3) two bulge=1 segments -> full circle dia 10');
  const t = ENT(
    '0','LWPOLYLINE','90','2','70','1',
    '10','0','20','0','42','1',
    '10','10','20','0','42','1',
  );
  const r = parseDxf(t);
  const bb = bbox(r.outline);
  check('bbox ~10x10', approx(bb.w, 10, 0.3) && approx(bb.h, 10, 0.3), JSON.stringify(bb));
  check('面積 ~78.5', approx(area(r.outline), 78.54, 1.5), area(r.outline));
})();

// 4) $INSUNITS=1 (inch) → ×25.4 に換算
(() => {
  console.log('4) $INSUNITS inch scaling');
  const t = dxf(
    '0','SECTION','2','HEADER','9','$INSUNITS','70','1','0','ENDSEC',
    '0','SECTION','2','ENTITIES',
    '0','LWPOLYLINE','90','4','70','1',
    '10','0','20','0','10','4','20','0','10','4','20','2','10','0','20','2',
    '0','ENDSEC','0','EOF',
  );
  const r = parseDxf(t);
  const bb = bbox(r.outline);
  check('units=inch', r.units === 'inch', r.units);
  check('scaleToMm=25.4', r.scaleToMm === 25.4, r.scaleToMm);
  check('bbox ~101.6 x 50.8 mm', approx(bb.w, 101.6, 0.1) && approx(bb.h, 50.8, 0.1), JSON.stringify(bb));
})();

// 5) ARC + LINE で半円ディスク(D字)を閉じる
(() => {
  console.log('5) ARC + LINE -> half disk');
  const t = ENT(
    '0','LINE','10','0','20','0','11','0','21','50',
    '0','ARC','10','0','20','25','40','25','50','270','51','90',
  );
  const r = parseDxf(t);
  check('1ループ', r.loops === 1, r.loops);
  check('面積 ~981.7(半円)', approx(area(r.outline), 981.7, 6), area(r.outline));
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
