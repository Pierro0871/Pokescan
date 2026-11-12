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

  // query : une empreinte ou une liste (plusieurs cadrages testés) ; on garde le meilleur cadrage par carte
  function topMatches(query, cards, n = 5) {
    const qs = Array.isArray(query) ? query : [query];
    return cards.filter(c => c.fp).map(c => {
      let d = Infinity;
      for (const q of qs) d = Math.min(d, distance(q, c.fp));
      return { card: c, d };
    }).sort((x, y) => x.d - y.d).slice(0, n);
  }

  // Cadrages candidats dans la zone capturée (cadre agrandi de MARGIN) : la carte peut être plus petite
  // ou décalée dans le rectangle. Rect en fraction de la zone capturée.
  const MARGIN = 0.15;
  function crops() {
    const out = [], base = 1 / (1 + 2 * MARGIN);
    // carte entre 70 % et 105 % du rectangle, centre à ±10 % : pas de 2 %, sous la tolérance du dHash (~3 %)
    for (let s = 0.7; s <= 1.051; s += 0.05) {
      const w = base * s;
      for (let dx = -0.08; dx <= 0.081; dx += 0.02) for (let dy = -0.08; dy <= 0.081; dy += 0.02)
        out.push({ x: 0.5 - w / 2 + dx, y: 0.5 - w / 2 + dy, w, h: w });
    }
    return out;
  }

  // Recherche grossière (grille de cadrages, toutes les cartes) puis fine autour des meilleurs cadrages
  // (40 meilleures cartes). fpOf(crop) renvoie l'empreinte d'un cadrage de la zone capturée.
  // Classement des cartes pour une liste d'empreintes de la photo : passe rapide sur le dHash,
  // puis la couleur départage les 40 meilleures. Renvoie [{ card, d, best }] (best = indice de l'empreinte gagnante).
  function rank(qs, cards, keep = 40) {
    const scored = [];
    for (const card of cards) {
      if (!card.fp) continue;
      const h = card.fp.h;
      let d = 257, bi = 0;
      for (let k = 0; k < qs.length; k++) {
        const a = qs[k].h;
        const x = popcount(a[0] ^ h[0]) + popcount(a[1] ^ h[1]) + popcount(a[2] ^ h[2]) + popcount(a[3] ^ h[3])
          + popcount(a[4] ^ h[4]) + popcount(a[5] ^ h[5]) + popcount(a[6] ^ h[6]) + popcount(a[7] ^ h[7]);
        if (x < d) { d = x; bi = k; }
      }
      scored.push({ card, d, best: bi });
    }
    scored.sort((a, b) => a.d - b.d);
    const top = scored.slice(0, keep);
    for (const s of top) { s.d = Infinity; for (const q of qs) s.d = Math.min(s.d, distance(q, s.card.fp)); }
    return top.sort((a, b) => a.d - b.d);
  }

  // Sans détection des bords : grille de cadrages (toutes les cartes), puis recherche fine autour des meilleurs.
  // fpOf(crop) renvoie l'empreinte d'un cadrage de la zone capturée.
  function search(fpOf, cards, n = 5) {
    const cs = crops(), qs = cs.map(fpOf);
    const top = rank(qs, cards);
    const fine = [], seen = new Set();
    for (const s of top.slice(0, 8)) {
      if (seen.has(s.best)) continue; seen.add(s.best);
      const b = cs[s.best];
      for (const ds of [-0.04, -0.02, 0, 0.02, 0.04]) for (const dx of [-0.03, -0.015, 0, 0.015, 0.03]) for (const dy of [-0.03, -0.015, 0, 0.015, 0.03]) {
        const w = b.w * (1 + ds), h = b.h * (1 + ds);
        fine.push(fpOf({ x: b.x + (b.w - w) / 2 + dx, y: b.y + (b.h - h) / 2 + dy, w, h }));
      }
    }
    for (const s of top) for (const f of fine) s.d = Math.min(s.d, distance(f, s.card.fp));
    return top.sort((a, b) => a.d - b.d).slice(0, n).map(({ card, d }) => ({ card, d }));
  }

  // Carte déjà redressée : petits cadrages autour de la carte entière (±3 % taille, ±2 % position)
  function nearCrops() {
    const out = [];
    for (const ds of [-0.03, 0, 0.03]) for (const dx of [-0.02, 0, 0.02]) for (const dy of [-0.02, 0, 0.02]) {
      const w = 1 + ds; out.push({ x: (1 - w) / 2 + dx, y: (1 - w) / 2 + dy, w, h: w });
    }
    return out;
  }

  // Décision finale : le numéro lu (ex. 45/198) désigne la carte si l'image ne la contredit pas.
  // officialOf(setId) = nombre officiel de cartes de l'extension.
  function decide(qs, res, cards, ocr, officialOf) {
    if (ocr) {
      const num = c => parseInt(String(c.localId).replace(/^\D+/, ''), 10);
      const cand = cards.filter(c => c.fp && num(c) === ocr.num && officialOf(c.setId) === ocr.tot);
      if (cand.length) {
        const best = cand.map(card => { let d = Infinity; for (const q of qs) d = Math.min(d, distance(q, card.fp)); return { card, d }; })
          .sort((a, b) => a.d - b.d)[0];
        const list = [best, ...res.filter(r => r.card.id !== best.card.id)].slice(0, 5);
        return { list, sure: best.d < LOOSE_MAX, byNumber: best.d < LOOSE_MAX };
      }
    }
    return { list: res, sure: isSure(res), byNumber: false };
  }

  // Scan auto : on ne propose une carte que si elle se détache nettement de la 2e
  // shortcut: seuils calés sur des cartes de synthèse, à réajuster avec de vraies photos
  const SURE_MAX = 0.36, SURE_GAP = 0.06, LOOSE_MAX = 0.42; // au-delà de LOOSE_MAX : probablement pas de carte
  function isSure(res) { return res.length > 1 && res[0].d < SURE_MAX && res[1].d - res[0].d > SURE_GAP; }

  // Zone capturée (RGBA AW×AH, comme getImageData) -> carte W×H pour un cadrage donné (moyenne par boîte)
  function resample(px, AW, AH, c) {
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const y0 = Math.floor((c.y + c.h * y / H) * AH), y1 = Math.max(y0 + 1, Math.ceil((c.y + c.h * (y + 1) / H) * AH));
      for (let x = 0; x < W; x++) {
        const x0 = Math.floor((c.x + c.w * x / W) * AW), x1 = Math.max(x0 + 1, Math.ceil((c.x + c.w * (x + 1) / W) * AW));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          const Y = yy < 0 ? 0 : yy >= AH ? AH - 1 : yy;
          for (let xx = x0; xx < x1; xx++) {
            const X = xx < 0 ? 0 : xx >= AW ? AW - 1 : xx, o = (Y * AW + X) * 4;
            r += px[o]; g += px[o + 1]; b += px[o + 2]; n++;
          }
        }
        const i = (y * W + x) * 4; out[i] = r / n; out[i + 1] = g / n; out[i + 2] = b / n; out[i + 3] = 255;
      }
    }
    return out;
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

  const api = { W, H, CROP, MARGIN, crops, search, rank, nearCrops, decide, resample, isSure, LOOSE_MAX, fingerprint, distance, topMatches, guideToVideo, CONDS, COND_LABEL, DEFAULT_COEF, unitPrice, entryKey, addEntry, stats, toCSV };
  if (typeof module !== 'undefined') module.exports = api; else root.FP = api;
})(this);
