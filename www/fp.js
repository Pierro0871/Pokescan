// Empreintes d'image + calculs purs (testables sous Node).
(function (root) {
  const W = 64, H = 88; // carte normalisée (ratio 63:88)
  // Zone comparée : haut de la carte (nom + illustration), le bas (texte) se ressemble trop d'une carte à l'autre.
  const CROP = { x0: 0.06, x1: 0.94, y0: 0.06, y1: 0.55 };

  // rgba : Uint8ClampedArray d'une image W×H (carte entière, déjà redressée)
  function fingerprint(rgba) {
    const cx0 = Math.round(CROP.x0 * W), cx1 = Math.round(CROP.x1 * W);
    const cy0 = Math.round(CROP.y0 * H), cy1 = Math.round(CROP.y1 * H);
    const gw = 17, gh = 16;
    const gray = new Float32Array(gw * gh), cnt = new Float32Array(gw * gh);
    const col = new Float32Array(4 * 4 * 3), ccnt = new Float32Array(16);
    for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) {
      const i = (y * W + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const fx = (x - cx0) / (cx1 - cx0), fy = (y - cy0) / (cy1 - cy0);
      const gi = Math.floor(fy * gh) * gw + Math.floor(fx * gw);
      gray[gi] += 0.299 * r + 0.587 * g + 0.114 * b; cnt[gi]++;
      const ci = Math.floor(fy * 4) * 4 + Math.floor(fx * 4);
      col[ci * 3] += r; col[ci * 3 + 1] += g; col[ci * 3 + 2] += b; ccnt[ci]++;
    }
    for (let i = 0; i < gray.length; i++) gray[i] /= cnt[i] || 1;
    // dHash 16×16 = 256 bits -> 8 entiers 32 bits
    const h = new Array(8).fill(0);
    for (let y = 0; y < gh; y++) for (let x = 0; x < 16; x++) {
      const bit = y * 16 + x;
      if (gray[y * gw + x] > gray[y * gw + x + 1]) h[bit >> 5] |= 1 << (bit & 31);
    }
    // couleur 4×4, centrée sur la moyenne pour encaisser l'exposition de la caméra
    for (let i = 0; i < 16; i++) for (let k = 0; k < 3; k++) col[i * 3 + k] /= ccnt[i] || 1;
    const mean = col.reduce((a, v) => a + v, 0) / col.length;
    const c = Array.from(col, v => Math.round(v - mean));
    return { h: h.map(v => v >>> 0), c };
  }

  function popcount(n) { n = n - ((n >>> 1) & 0x55555555); n = (n & 0x33333333) + ((n >>> 2) & 0x33333333); return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }

  function distance(a, b) {
    let ham = 0;
    for (let i = 0; i < 8; i++) ham += popcount((a.h[i] ^ b.h[i]) >>> 0);
    let cd = 0;
    for (let i = 0; i < a.c.length; i++) cd += Math.abs(a.c[i] - b.c[i]);
    return ham / 256 + 0.5 * (cd / a.c.length / 255);
  }

  function topMatches(query, cards, n = 5) {
    return cards.filter(c => c.fp).map(c => ({ card: c, d: distance(query, c.fp) }))
      .sort((x, y) => x.d - y.d).slice(0, n);
  }

  // Rectangle du cadre (coords écran dans le conteneur) -> rectangle source dans la vidéo (object-fit: cover)
  function guideToVideo(vw, vh, cw, ch, g) {
    const s = Math.max(cw / vw, ch / vh);
    const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
    return { x: (g.x - ox) / s, y: (g.y - oy) / s, w: g.w / s, h: g.h / s };
  }

  const CONDS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
  const COND_LABEL = { MT: 'Mint', NM: 'Near Mint', EX: 'Excellent', GD: 'Good', LP: 'Light Played', PL: 'Played', PO: 'Poor' };
  // shortcut: coefficients estimés (pas de prix par état dans l'API gratuite), réglables dans Stats
  const DEFAULT_COEF = { MT: 1, NM: 1, EX: 0.8, GD: 0.65, LP: 0.5, PL: 0.35, PO: 0.2 };

  // p = pricing.cardmarket de TCGdex ; les champs "-holo" sont ceux de la version reverse
  function unitPrice(p, variant, cond, coef) {
    if (!p) return { trend: null, avg: null };
    const rev = variant === 'reverse';
    const t = rev ? (p['trend-holo'] ?? p.trend) : p.trend;
    const a = rev ? (p['avg-holo'] ?? p.avg) : p.avg;
    const k = coef[cond] ?? 1;
    return { trend: t == null ? null : t * k, avg: a == null ? null : a * k };
  }

  function entryKey(e) { return [e.cardId, e.variant, e.cond, e.note || ''].join('|'); }

  // Ajoute (ou fusionne) une entrée dans la collection, renvoie la collection
  function addEntry(coll, e) {
    const k = entryKey(e), ex = coll.find(x => entryKey(x) === k);
    if (ex) ex.qty += e.qty; else coll.push({ ...e });
    return coll;
  }

  function stats(coll, prices, coef) {
    let qty = 0, trend = 0, avg = 0;
    const unique = new Set(), byCard = {}, valued = [];
    for (const e of coll) {
      qty += e.qty; unique.add(e.cardId);
      byCard[e.cardId] = (byCard[e.cardId] || 0) + e.qty;
      const u = unitPrice(prices[e.cardId], e.variant, e.cond, coef);
      trend += (u.trend || 0) * e.qty; avg += (u.avg || 0) * e.qty;
      valued.push({ e, u });
    }
    const dups = Object.entries(byCard).filter(([, n]) => n > 1).map(([id, n]) => ({ id, extra: n - 1 }));
    valued.sort((a, b) => (b.u.trend || 0) - (a.u.trend || 0));
    return { qty, unique: unique.size, trend, avg, dups, top: valued.slice(0, 10) };
  }

  function toCSV(coll, prices, coef) {
    const esc = v => { v = v == null ? '' : String(v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const rows = [['Extension', 'Numero', 'Nom', 'Variante', 'Etat', 'Quantite', 'Note', 'Prix tendance (EUR)', 'Prix moyen (EUR)', 'ID']];
    for (const e of coll) {
      const u = unitPrice(prices[e.cardId], e.variant, e.cond, coef);
      const f = n => n == null ? '' : n.toFixed(2).replace('.', ',');
      rows.push([e.setName, e.localId, e.name, e.variant, e.cond, e.qty, e.note, f(u.trend), f(u.avg), e.cardId]);
    }
    // ";" + virgule décimale = ouverture directe dans Excel FR
    return '﻿' + rows.map(r => r.map(esc).join(';')).join('\r\n');
  }

  const api = { W, H, CROP, fingerprint, distance, topMatches, guideToVideo, CONDS, COND_LABEL, DEFAULT_COEF, unitPrice, entryKey, addEntry, stats, toCSV };
  if (typeof module !== 'undefined') module.exports = api; else root.FP = api;
})(this);
