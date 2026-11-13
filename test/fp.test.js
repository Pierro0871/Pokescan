// node test/fp.test.js
const assert = require('assert');
const FP = require('../www/fp.js');
const { W, H } = FP;

// Image synthétique "carte" : formes de couleur aléatoires (seed), rendue à la taille demandée avec décalage/expo
function rng(seed) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
function card(seed) { const r = rng(seed); return Array.from({ length: 14 }, () => ({ x: r(), y: r() * 0.6, w: 0.1 + r() * 0.4, h: 0.05 + r() * 0.3, c: [r() * 255, r() * 255, r() * 255] })); }
function render(shapes, { dx = 0, dy = 0, gain = 1, bias = 0, noise = 0, seed = 1 } = {}) {
  const r = rng(seed), px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W + dx, v = y / H + dy;
    let c = [230, 200, 60]; // bordure jaune commune à toutes les cartes
    if (u > 0.05 && u < 0.95 && v > 0.05 && v < 0.95) c = [240, 240, 235];
    for (const s of shapes) if (u >= s.x && u < s.x + s.w && v >= s.y && v < s.y + s.h) c = s.c;
    const i = (y * W + x) * 4;
    for (let k = 0; k < 3; k++) px[i + k] = c[k] * gain + bias + (r() - 0.5) * noise;
    px[i + 3] = 255;
  }
  return px;
}

// 1. reconnaissance : 300 cartes, photo décalée de 2 %, exposition différente, bruit
const refs = Array.from({ length: 300 }, (_, i) => ({ id: 'c' + i, fp: FP.fingerprint(render(card(i + 1))) }));
let top1 = 0, top5 = 0;
for (let i = 0; i < 300; i += 3) {
  const q = FP.fingerprint(render(card(i + 1), { dx: 0.02, dy: -0.015, gain: 0.8, bias: 25, noise: 30, seed: i }));
  const m = FP.topMatches(q, refs, 5).map(x => x.card.id);
  if (m[0] === 'c' + i) top1++;
  if (m.includes('c' + i)) top5++;
}
console.log(`reconnaissance : top1 ${top1}/100, top5 ${top5}/100`);
assert(top5 >= 95, 'top5 trop faible');

// 2. même image -> distance 0
const f = FP.fingerprint(render(card(7)));
assert.strictEqual(FP.distance(f, f), 0);

// 3. cadre -> vidéo (object-fit: cover). Vidéo 1920×1080 dans un conteneur 400×600 : échelle 600/1080
const r = FP.guideToVideo(1920, 1080, 400, 600, { x: 0, y: 0, w: 400, h: 600 });
assert(Math.abs(r.w - 720) < 1e-6 && Math.abs(r.h - 1080) < 1e-6 && Math.abs(r.x - 600) < 1e-6 && r.y === 0);

// 4. prix
const p = { avg: 10, trend: 12, 'avg-holo': 20, 'trend-holo': 30 };
assert.deepStrictEqual(FP.unitPrice(p, 'normal', 'NM', FP.DEFAULT_COEF), { trend: 12, avg: 10 });
assert.deepStrictEqual(FP.unitPrice(p, 'reverse', 'EX', FP.DEFAULT_COEF), { trend: 24, avg: 16 });
assert.deepStrictEqual(FP.unitPrice(null, 'normal', 'NM', FP.DEFAULT_COEF), { trend: null, avg: null });
assert.deepStrictEqual(FP.unitPrice({ trend: 5, avg: 4 }, 'reverse', 'NM', FP.DEFAULT_COEF), { trend: 5, avg: 4 });

// 5. collection : fusion, stats, doublons, CSV
const coll = [];
const e = { cardId: 'sv1-1', setId: 'sv1', setName: 'Écarlate et Violet', localId: '1', name: 'Pomdepik', variant: 'normal', cond: 'NM', qty: 1, note: '' };
FP.addEntry(coll, e); FP.addEntry(coll, e); FP.addEntry(coll, { ...e, cond: 'EX' });
assert.strictEqual(coll.length, 2); assert.strictEqual(coll[0].qty, 2);
const st = FP.stats(coll, { 'sv1-1': { trend: 1, avg: 2 } }, FP.DEFAULT_COEF);
assert.strictEqual(st.qty, 3); assert.strictEqual(st.unique, 1);
assert.deepStrictEqual(st.dups, [{ id: 'sv1-1', extra: 2 }]);
assert(Math.abs(st.trend - 2.8) < 1e-9);
const csv = FP.toCSV(coll, { 'sv1-1': { trend: 1.5, avg: 2 } }, FP.DEFAULT_COEF);
assert(csv.split('\r\n')[1] === 'Écarlate et Violet;1;Pomdepik;normal;NM;2;;1,50;2,00;sv1-1;;', csv);
assert(FP.toCSV([{ ...e, note: 'a;b "c"' }], {}, FP.DEFAULT_COEF).includes('"a;b ""c"""'));
// 6. carte plus petite et décalée dans le cadre (fond bois autour) : les cadrages multiples la retrouvent
function area(shapes, cr, seed) { // zone capturée AW×AH (RGBA), carte placée dans le rectangle cr (fractions), fond bois
  const AW = 166, AH = 228, r = rng(seed), px = new Uint8ClampedArray(AW * AH * 4), cardPx = shapes && render(shapes, { gain: 0.85, bias: 15, noise: 20, seed });
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
    const u = (x / AW - cr.x) / cr.w, v = (y / AH - cr.y) / cr.h, o = (y * AW + x) * 4;
    if (shapes && u >= 0 && u < 1 && v >= 0 && v < 1) { const i = (Math.floor(v * H) * W + Math.floor(u * W)) * 4; px[o] = cardPx[i]; px[o + 1] = cardPx[i + 1]; px[o + 2] = cardPx[i + 2]; }
    else { const w = 120 + 30 * Math.sin(y / 5 + x / 40) + r() * 20; px[o] = w; px[o + 1] = w * 0.8; px[o + 2] = w * 0.6; }
    px[o + 3] = 255;
  }
  return px;
}
const cropTo = (a, c) => FP.resample(a, 166, 228, c);
let sure = 0, sureWrong = 0; const ds = []; let small1 = 0, small5 = 0, single5 = 0;
const base = 1 / (1 + 2 * FP.MARGIN);
for (let i = 0; i < 300; i += 10) {
  const s = 0.72 + (i % 30) / 100, cr = { x: 0.5 - base * s / 2 + 0.04, y: 0.5 - base * s / 2 - 0.03, w: base * s, h: base * s };
  const a = area(card(i + 1), cr, i);
  const res = FP.search(c => FP.fingerprint(cropTo(a, c)), refs, 5), m = res.map(x => x.card.id);
  if (FP.isSure(res)) { sure++; if (m[0] !== 'c' + i) sureWrong++; }
  ds.push([res[0].d.toFixed(3), (res[1].d - res[0].d).toFixed(3)].join('/'));
  if (m[0] === 'c' + i) small1++; if (m.includes('c' + i)) small5++;
  const one = FP.topMatches(FP.fingerprint(cropTo(a, { x: FP.MARGIN * base, y: FP.MARGIN * base, w: base, h: base })), refs, 5).map(x => x.card.id);
  if (one.includes('c' + i)) single5++;
}
// 7. seuils de confiance du scan auto : vraie carte vs fond vide
const noCard = FP.search(c => FP.fingerprint(cropTo(area(null, { x: 0, y: 0, w: 0, h: 0 }, 5), c)), refs, 5);
console.log('fond vide : meilleur', noCard[0].d.toFixed(3), 'écart', (noCard[1].d - noCard[0].d).toFixed(3), '-> sûr ?', FP.isSure(noCard));
assert(!FP.isSure(noCard), 'fond vide pris pour une carte');
console.log(`carte petite/décalée : top1 ${small1}/30, top5 ${small5}/30 (sans multi-cadrage : top5 ${single5}/30)`);
console.log(`auto : sûr ${sure}/30, dont faux ${sureWrong}`, ds.join(' '));
assert(small5 >= 27, 'multi-cadrage insuffisant');
assert(sureWrong === 0, 'proposition auto fausse');
console.log('OK');
