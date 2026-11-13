// node test/vision.test.js  (après npm install : utilise OpenCV)
const assert = require('assert');
const FP = require('../www/fp.js');
const V = require('../www/vision.js');

function rng(seed) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
// Carte synthétique w×h (RGBA) : bordure jaune, formes de couleur dans la moitié haute
function cardImg(seed, w, h) {
  const r = rng(seed), shapes = Array.from({ length: 14 }, () => ({ x: r(), y: r() * 0.6, w: 0.1 + r() * 0.4, h: 0.05 + r() * 0.3, c: [r() * 255, r() * 255, r() * 255] }));
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = y / h; let c = [230, 200, 60];
    if (u > 0.05 && u < 0.95 && v > 0.05 && v < 0.95) c = [240, 240, 235];
    for (const s of shapes) if (u >= s.x && u < s.x + s.w && v >= s.y && v < s.y + s.h) c = s.c;
    const i = (y * w + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  }
  return px;
}

Promise.resolve(require('@techstark/opencv-js')).then(cv => {
  const N = 120, refs = [];
  for (let i = 0; i < N; i++) refs.push({ id: 'c' + i, fp: FP.fingerprint(FP.resample(cardImg(i + 1, 126, 176), 126, 176, { x: 0, y: 0, w: 1, h: 1 })) });

  // Photo : bois 600×800, carte penchée de `ang` degrés avec perspective
  function photo(i, ang, persp) {
    const W = 600, H = 800, bg = new Uint8ClampedArray(W * H * 4), r = rng(i + 99);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4, w = 110 + 35 * Math.sin(y / 6 + x / 50) + r() * 25;
      bg[o] = w; bg[o + 1] = w * 0.78; bg[o + 2] = w * 0.55; bg[o + 3] = 255;
    }
    const cw = 252, ch = 352, card = cv.matFromArray(ch, cw, cv.CV_8UC4, cardImg(i + 1, cw, ch));
    const a = ang * Math.PI / 180, cx = 300, cy = 410, hw = 150, hh = 210;
    const rot = (x, y) => [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)];
    const dst = [...rot(-hw + persp, -hh), ...rot(hw - persp, -hh), ...rot(hw, hh), ...rot(-hw, hh)];
    const M = cv.getPerspectiveTransform(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, cw, 0, cw, ch, 0, ch]), cv.matFromArray(4, 1, cv.CV_32FC2, dst));
    const out = cv.matFromArray(H, W, cv.CV_8UC4, bg);
    cv.warpPerspective(card, out, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_TRANSPARENT);
    const px = new Uint8ClampedArray(out.data);
    for (let k = 0; k < px.length; k += 4) for (let c = 0; c < 3; c++) px[k + c] = px[k + c] * 0.85 + 20 + (r() - 0.5) * 20; // exposition + bruit
    // reflet holo : tache claire
    for (let y = 300; y < 360; y++) for (let x = 250; x < 330; x++) { const o = (y * W + x) * 4; px[o] = px[o + 1] = px[o + 2] = 250; }
    card.delete(); out.delete(); M.delete();
    return { px, W, H };
  }

  let found = 0, top1 = 0, top5 = 0;
  for (let i = 0; i < N; i += 4) {
    const ang = -25 + (i % 50), p = photo(i, ang, (i % 3) * 15);
    const q = V.findCard(cv, p.px, p.W, p.H);
    if (!q) continue;
    found++;
    const img = V.warp(cv, p.px, p.W, p.H, q, 126, 176);
    const qs = FP.nearCrops().map(c => FP.fingerprint(FP.resample(img, 126, 176, c)));
    const ids = FP.rank(qs, refs).slice(0, 5).map(x => x.card.id);
    if (ids[0] === 'c' + i) top1++; if (ids.includes('c' + i)) top5++;
  }
  console.log(`carte penchée ±25° + perspective + reflet : détectée ${found}/30, top1 ${top1}/30, top5 ${top5}/30`);
  assert(found >= 27 && top1 >= 25, 'détection des bords insuffisante');

  // page de classeur : 9 cartes en 3×3, pochettes plastique grises entre les cartes
  {
    const W = 900, H = 1200, px = new Uint8ClampedArray(W * H * 4).fill(255);
    for (let k = 0; k < px.length; k += 4) { px[k] = 60; px[k + 1] = 62; px[k + 2] = 70; }
    const cw = 252, ch = 352, gx = 36, gy = 40, ox = (W - 3 * cw - 2 * gx) / 2, oy = (H - 3 * ch - 2 * gy) / 2;
    for (let n = 0; n < 9; n++) {
      const img = cardImg(n + 1, cw, ch), x0 = Math.round(ox + (n % 3) * (cw + gx)), y0 = Math.round(oy + Math.floor(n / 3) * (ch + gy));
      for (let y = 0; y < ch; y++) px.set(img.subarray(y * cw * 4, (y + 1) * cw * 4), ((y0 + y) * W + x0) * 4);
    }
    const found = V.findCards(cv, px, W, H);
    let ok = 0;
    found.forEach((f, n) => {
      const img = V.warp(cv, px, W, H, f.q, 126, 176);
      const qs = FP.nearCrops().map(c => FP.fingerprint(FP.resample(img, 126, 176, c)));
      if (FP.rank(qs, refs)[0].card.id === 'c' + n) ok++;
    });
    console.log(`page de classeur : ${found.length} cartes trouvées, ${ok}/9 reconnues dans l'ordre`);
    assert(found.length === 9 && ok === 9, 'page de classeur');
  }

  // coins : carte couchée -> remise en portrait
  const q = V.orderCorners([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 280 }, { x: 0, y: 280 }]);
  assert(Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y) < Math.hypot(q[1].x - q[2].x, q[1].y - q[2].y));

  // médiane : un reflet présent sur une seule image disparaît
  const f = [new Uint8ClampedArray([10, 10]), new Uint8ClampedArray([250, 12]), new Uint8ClampedArray([12, 11])];
  assert.deepStrictEqual([...V.median(f)], [12, 11]);

  // lecture du numéro
  assert.deepStrictEqual(V.parseNumber('Illus. 5 045/198 '), { num: 45, tot: 198 });
  assert.deepStrictEqual(V.parseNumber('4 / 102'), { num: 4, tot: 102 });
  assert.strictEqual(V.parseNumber('PROMO'), null);

  // fusion numéro + image : le numéro départage deux cartes que l'image confond
  const a = { id: 'x-45', localId: '045', setId: 'x', fp: refs[0].fp }, b = { id: 'y-12', localId: '012', setId: 'y', fp: refs[0].fp };
  const res = [{ card: b, d: 0.2 }, { card: a, d: 0.2 }];
  const dec = FP.decide([refs[0].fp], res, [a, b], { num: 45, tot: 198 }, id => (id === 'x' ? 198 : 100));
  assert(dec.sure && dec.list[0].card.id === 'x-45');
  assert(!FP.decide([refs[0].fp], [{ card: b, d: 0.3 }, { card: a, d: 0.31 }], [a, b], null, () => 0).sure);
  console.log('OK');
});
{
  const V2 = require('../www/vision.js');
  const eq = (a, b) => require('assert').deepStrictEqual(a, b);
  eq(V2.parseGrade('2023 POKEMON SV\nCHARIZARD EX\nGEM MT 10\n84512345 PSA'), { co: 'PSA', grade: 10, cert: '84512345' });
  eq(V2.parseGrade('PCA  9.5  NM+ 1234567'), { co: 'PCA', grade: 9.5, cert: '1234567' });
  eq(V2.parseGrade('CGC PRISTINE 10'), { co: 'CGC', grade: 10 });
  eq(V2.parseGrade('rien de lisible'), {});
  console.log('OK étiquettes gradées');
}
