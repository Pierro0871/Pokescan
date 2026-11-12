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
assert(csv.split('\r\n')[1] === 'Écarlate et Violet;1;Pomdepik;normal;NM;2;;1,50;2,00;sv1-1', csv);
assert(FP.toCSV([{ ...e, note: 'a;b "c"' }], {}, FP.DEFAULT_COEF).includes('"a;b ""c"""'));
console.log('OK');
