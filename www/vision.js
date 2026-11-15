// Détection de la carte dans l'image (OpenCV) + redressement + lecture du numéro. Fonctions pures, testées sous Node.
(function (root) {
  const RATIO = 63 / 88;

  // rgba : pixels w×h. Renvoie les 4 coins [tl, tr, br, bl] (carte en portrait) ou null.
  // Plusieurs réglages tentés : un fond texturé (bois, tapis) peut coller ses contours à ceux de la carte
  const TRIES = [{ blur: 5, lo: 40, hi: 120, dil: true }, { blur: 9, lo: 60, hi: 180, dil: true }, { blur: 5, lo: 50, hi: 150, dil: false }];
  // Carte principale (la plus grande) ou null
  function findCard(cv, rgba, w, h) {
    const all = findCards(cv, rgba, w, h, 0.1);
    return all.length ? all.reduce((a, b) => (b.area > a.area ? b : a)).q : null;
  }

  // Toutes les cartes de l'image (page de classeur) : [{ q: coins, area }], en ordre de lecture
  function findCards(cv, rgba, w, h, minFrac = 0.02) {
    const src = cv.matFromArray(h, w, cv.CV_8UC4, rgba), gray = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      for (const t of TRIES) {
        const found = findIn(cv, gray, w, h, t, minFrac);
        if (found.length) {
          // ordre de lecture : par rangée (centre y), puis de gauche à droite
          const c = f => ({ x: f.q.reduce((a, p) => a + p.x, 0) / 4, y: f.q.reduce((a, p) => a + p.y, 0) / 4 });
          const hgt = Math.sqrt(found[0].area / RATIO);
          return found.sort((a, b) => Math.abs(c(a).y - c(b).y) > hgt / 2 ? c(a).y - c(b).y : c(a).x - c(b).x);
        }
      }
      return [];
    } finally { src.delete(); gray.delete(); }
  }

  function findIn(cv, gray, w, h, t, minFrac) {
    const g = new cv.Mat(), edges = new cv.Mat(), contours = new cv.MatVector(), hier = new cv.Mat(), k = cv.Mat.ones(3, 3, cv.CV_8U);
    const out = [];
    try {
      cv.GaussianBlur(gray, g, new cv.Size(t.blur, t.blur), 0);
      cv.Canny(g, edges, t.lo, t.hi);
      if (t.dil) cv.dilate(edges, edges, k);
      cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const area = cv.contourArea(c);
        if (area > minFrac * w * h) {
          // minAreaRect encaisse les coins arrondis de la carte et un contour un peu mangé
          const r = cv.minAreaRect(c);
          const fill = area / (r.size.width * r.size.height);
          const ar = Math.min(r.size.width, r.size.height) / Math.max(r.size.width, r.size.height);
          if (fill > 0.6 && Math.abs(ar - RATIO) < 0.12) {
            const approx = new cv.Mat();
            cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
            // Rectangle tourné (précis) sauf si la carte est vue de biais : quadrilatère nettement différent du rectangle
            let pts = cv.RotatedRect.points(r);
            if (approx.rows === 4 && Math.abs(cv.contourArea(approx) / (r.size.width * r.size.height) - 1) > 0.06)
              pts = Array.from({ length: 4 }, (_, j) => ({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] }));
            approx.delete();
            out.push({ area, q: orderCorners(pts) });
          }
        }
        c.delete();
      }
    } finally { [g, edges, contours, hier, k].forEach(m => m.delete()); }
    return out;
  }

  // Ordonne les coins tl, tr, br, bl, puis tourne d'un cran si la carte est couchée
  function orderCorners(pts) {
    const cx = pts.reduce((a, p) => a + p.x, 0) / 4, cy = pts.reduce((a, p) => a + p.y, 0) / 4;
    const s = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)); // sens horaire (y vers le bas)
    let i0 = 0;
    for (let i = 1; i < 4; i++) if (s[i].x + s[i].y < s[i0].x + s[i0].y) i0 = i;
    let q = [0, 1, 2, 3].map(i => s[(i0 + i) % 4]);
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    if (d(q[0], q[1]) > d(q[1], q[2])) q = [q[3], q[0], q[1], q[2]];
    return q;
  }

  // Redresse la carte (coins dans l'image w×h) en outW×outH RGBA
  function warp(cv, rgba, w, h, q, outW, outH) {
    const src = cv.matFromArray(h, w, cv.CV_8UC4, rgba), dst = new cv.Mat();
    const a = cv.matFromArray(4, 1, cv.CV_32FC2, q.flatMap(p => [p.x, p.y]));
    const b = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
    const M = cv.getPerspectiveTransform(a, b);
    try {
      cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_AREA, cv.BORDER_REPLICATE);
      return new Uint8ClampedArray(dst.data);
    } finally { [src, dst, a, b, M].forEach(m => m.delete()); }
  }

  // Anti-reflet : médiane pixel à pixel de plusieurs images redressées (les reflets bougent d'une image à l'autre)
  function median(frames) {
    if (frames.length === 1) return frames[0];
    const out = new Uint8ClampedArray(frames[0].length), v = new Array(frames.length);
    for (let i = 0; i < out.length; i++) {
      for (let k = 0; k < frames.length; k++) v[k] = frames[k][i];
      v.sort((x, y) => x - y); out[i] = v[v.length >> 1];
    }
    return out;
  }

  // Texte lu en bas de carte -> { num, tot, code } : "PBL 005/084" -> { num: 5, tot: 84, code: 'PBL' } ;
  // promo "MEP 012" -> { num: 12, promo: 'MEP' } ; null si rien de lisible
  function parseNumber(text) {
    const t = String(text).toUpperCase();
    const fixed = t.replace(/(?<=\d)[O]|[O](?=\d)/g, '0').replace(/(?<=\d)[IL|]|[IL|](?=\d)/g, '1');
    const m = fixed.match(/(\d{1,3})\s*\/\s*(\d{2,3})/);
    const codes = (t.match(/\b[A-Z]{3}\b/g) || []).filter(c => !/^(ILL|LUS|FRA|ENG|POK|EMO|THE)$/.test(c));
    if (m) return codes.length ? { num: +m[1], tot: +m[2], code: codes[0] } : { num: +m[1], tot: +m[2] };
    const p = t.match(/\b([A-Z]{2,4})\s?(\d{1,3})\b(?!\s*\/)/);
    return p ? { num: +p[2], promo: p[1] } : null;
  }

  // Étiquette de boîtier gradé -> { co: 'PSA', grade: 10, cert: '12345678' } (champs absents si illisibles)
  function parseGrade(text) {
    const t = String(text).toUpperCase().replace(/[|]/g, 'I');
    const co = (t.match(/\b(PSA|PCA|CGC|BGS|BECKETT|CCC|SGC|ACE|AOG|TAG)\b/) || [])[1];
    const out = {};
    if (co) out.co = co === 'BECKETT' ? 'BGS' : co;
    // note : après un libellé connu (GEM MT 10, MINT 9, PRISTINE 10…) sinon nombre isolé 1-10 (demi-points)
    const m = t.match(/(?:GEM\s*M(?:IN)?T|PRISTINE|MINT|NM-MT|NM|EX-MT|EX|VG-EX|VG|GOOD|FAIR|POOR|PERFECT|GEM)\s*\+?\s*(10|[1-9](?:[.,]5)?)\b/)
      || t.match(/(?:^|\s)(10|[1-9](?:[.,]5)?)(?=\s|$)/);
    if (m) out.grade = parseFloat(m[1].replace(',', '.'));
    const c = t.match(/\b(\d{7,12})\b/);
    if (c) out.cert = c[1];
    return out;
  }

  // Ligne de copyright en bas de carte -> année (la plus récente lue), ou null
  function parseYear(text, max = new Date().getFullYear() + 1) {
    const ys = (String(text).replace(/[Oo]/g, '0').match(/(?:19[89]\d|20[0-4]\d)/g) || []).map(Number).filter(y => y <= max);
    return ys.length ? Math.max(...ys) : null;
  }

  // Reflets : variation de luminosité d'une image à l'autre (carte redressée, téléphone qui bouge un peu).
  // Ça brille hors de l'illustration -> 'reverse' ; dans l'illustration -> 'holo' ; sinon null.
  function sheen(frames, w, h) {
    if (frames.length < 3) return null;
    let a = 0, na = 0, o = 0, no = 0;
    for (let y = Math.round(h * 0.05); y < h * 0.95; y++) for (let x = Math.round(w * 0.05); x < w * 0.95; x++) {
      const i = (y * w + x) * 4;
      let lo = 255, hi = 0;
      for (const f of frames) { const l = (f[i] * 3 + f[i + 1] * 6 + f[i + 2]) / 10; if (l < lo) lo = l; if (l > hi) hi = l; }
      if (x > w * 0.08 && x < w * 0.92 && y > h * 0.10 && y < h * 0.49) { a += hi - lo; na++; } else { o += hi - lo; no++; }
    }
    const A = a / na, O = o / no;
    if (Math.max(A, O) < 12) return null; // pas assez de reflets pour juger
    return O > A * 1.5 ? 'reverse' : A > O * 1.5 ? 'holo' : null;
  }

  // ---------- couleur / type ----------
  // Teinte (0-360), saturation et luminosité d'un pixel
  function hsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx / 255];
  }
  // Couleur de référence de chaque type (teinte, saturation mini, luminosité) : cadre et fond de la carte
  const TYPES = {
    plante: [105, .3, .6], feu: [10, .45, .7], eau: [200, .2, .65], electrique: [50, .45, .8], psy: [290, .25, .6],
    combat: [25, .4, .5], obscurite: [220, .15, .25], metal: [210, .05, .6], fee: [330, .25, .8], dragon: [45, .35, .55], incolore: [40, .05, .85],
  };
  const TYPE_KEY = { plante: 'plante', grass: 'plante', feu: 'feu', fire: 'feu', eau: 'eau', water: 'eau', electrique: 'electrique', lightning: 'electrique',
    psy: 'psy', psychic: 'psy', combat: 'combat', fighting: 'combat', obscurite: 'obscurite', darkness: 'obscurite', metal: 'metal', fee: 'fee', fairy: 'fee',
    dragon: 'dragon', incolore: 'incolore', colorless: 'incolore' };
  const typeKey = t => TYPE_KEY[String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()];
  // Carte redressée -> score 0..1 par type, d'après la couleur du fond hors illustration (bande du nom + zone d'attaques)
  function typeScores(rgba, w, h) {
    let n = 0, sx = 0, sy = 0, ss = 0, sv = 0;
    const zone = (x, y) => x > w * 0.06 && x < w * 0.94 && ((y > h * 0.03 && y < h * 0.09) || (y > h * 0.55 && y < h * 0.88));
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      if (!zone(x, y)) continue;
      const i = (y * w + x) * 4, [hh, sa, va] = hsv(rgba[i], rgba[i + 1], rgba[i + 2]);
      sx += Math.cos(hh * Math.PI / 180) * sa; sy += Math.sin(hh * Math.PI / 180) * sa; ss += sa; sv += va; n++;
    }
    const hue = (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360, sat = ss / n, val = sv / n;
    const out = {};
    for (const [k, [th, ts, tv]] of Object.entries(TYPES)) {
      const dh = Math.min(Math.abs(hue - th), 360 - Math.abs(hue - th)) / 180;
      const lowSat = ts < .2; // types peu colorés : on juge sur la saturation et la luminosité
      const d = lowSat ? Math.abs(sat - ts) * 3 + Math.abs(val - tv) : dh * 2 + Math.max(0, ts - sat) + Math.abs(val - tv) * .5;
      out[k] = Math.max(0, 1 - d);
    }
    return { scores: out, hue: Math.round(hue), sat: +sat.toFixed(2), val: +val.toFixed(2), sure: sat > .2 || val < .35 };
  }

  // ---------- qualité de l'image ----------
  // Netteté (Laplacien moyen), luminosité, reflets (pixels brûlés), en niveaux de gris
  function quality(rgba, w, h) {
    const g = new Float32Array(w * h);
    let sum = 0, burnt = 0;
    for (let i = 0; i < w * h; i++) { const v = (rgba[i * 4] * 3 + rgba[i * 4 + 1] * 6 + rgba[i * 4 + 2]) / 10; g[i] = v; sum += v; if (v > 245) burnt++; }
    let lap = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; lap += Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]); }
    return { sharp: lap / ((w - 2) * (h - 2)), bright: sum / (w * h), glare: burnt / (w * h) };
  }

  // ---------- points caractéristiques (ORB) ----------
  // Nombre de correspondances cohérentes (homographie) entre deux images en niveaux de gris
  function orbFeatures(cv, rgba, w, h) {
    const src = cv.matFromArray(h, w, cv.CV_8UC4, rgba), gray = new cv.Mat(), kp = new cv.KeyPointVector(), des = new cv.Mat(), orb = new cv.ORB(500), none = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    orb.detectAndCompute(gray, none, kp, des);
    src.delete(); gray.delete(); orb.delete(); none.delete();
    return { kp, des };
  }
  function freeFeatures(f) { f.kp.delete(); f.des.delete(); }
  function orbInliers(cv, a, b) {
    if (a.des.rows < 8 || b.des.rows < 8) return 0;
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false), knn = new cv.DMatchVectorVector();
    bf.knnMatch(a.des, b.des, knn, 2);
    const pa = [], pb = [];
    for (let i = 0; i < knn.size(); i++) {
      const m = knn.get(i);
      if (m.size() < 2) continue;
      const m0 = m.get(0), m1 = m.get(1);
      if (m0.distance < 0.75 * m1.distance) { const p = a.kp.get(m0.queryIdx).pt, q = b.kp.get(m0.trainIdx).pt; pa.push(p.x, p.y); pb.push(q.x, q.y); }
    }
    bf.delete(); knn.delete();
    if (pa.length < 16) return pa.length / 2;
    const A = cv.matFromArray(pa.length / 2, 1, cv.CV_32FC2, pa), B = cv.matFromArray(pb.length / 2, 1, cv.CV_32FC2, pb), mask = new cv.Mat();
    const H = cv.findHomography(A, B, cv.RANSAC, 5, mask);
    let n = 0; for (let i = 0; i < mask.rows; i++) n += mask.data[i] ? 1 : 0;
    [A, B, mask, H].forEach(m => m.delete());
    return n;
  }

  // ---------- symbole d'extension ----------
  // Meilleure corrélation (0..1) du symbole cherché dans la bande du bas de la carte, à plusieurs tailles
  function symbolScore(cv, stripRgba, w, h, symRgba, sw, sh) {
    const S0 = cv.matFromArray(h, w, cv.CV_8UC4, stripRgba), T0 = cv.matFromArray(sh, sw, cv.CV_8UC4, symRgba);
    const Sg = new cv.Mat(), Tg = new cv.Mat();
    cv.cvtColor(S0, Sg, cv.COLOR_RGBA2GRAY); cv.cvtColor(T0, Tg, cv.COLOR_RGBA2GRAY);
    let best = 0;
    for (const hh of [0.35, 0.45, 0.55, 0.7].map(f => Math.round(h * f))) {
      const ww = Math.round(sw * hh / sh);
      if (ww < 6 || ww >= w || hh >= h) continue;
      const T = new cv.Mat(), R = new cv.Mat();
      cv.resize(Tg, T, new cv.Size(ww, hh), 0, 0, cv.INTER_AREA);
      cv.matchTemplate(Sg, T, R, cv.TM_CCOEFF_NORMED);
      best = Math.max(best, cv.minMaxLoc(R).maxVal);
      T.delete(); R.delete();
    }
    [S0, T0, Sg, Tg].forEach(m => m.delete());
    return best;
  }


  // Lignes lues par le moteur natif (positions relatives à la carte, 0..1) -> nom, numéro, année
  const GENERIC = /^(DRESSEUR|TRAINER|SUPPORTER|SUPPORT|OBJET|ITEM|STADE|STADIUM|OUTIL|TOOL|ENERGIE|ÉNERGIE|ENERGY|POKEMON|POKÉMON|BASE|DE BASE|BASIC|NIVEAU \d|STAGE \d|STADE \d|EVOLUTION|ÉVOLUTION|ÉVOLUE DE.*|EVOLVES FROM.*|PV ?\d*|HP ?\d*|\d+ ?PV|\d+ ?HP)$/i;
  function readLines(lines) {
    const ls = (lines || []).filter(l => l && l.t && String(l.t).trim());
    const top = ls.filter(l => l.y < 0.2 && l.y > -0.06)
      .map(l => ({ ...l, t: String(l.t).replace(/\b(PV|HP)\s*\d+.*$/i, '').trim() }))
      .filter(l => l.t.length >= 3 && /[A-Za-zÀ-ÿ]{3}/.test(l.t) && !GENERIC.test(l.t))
      .sort((a, b) => b.h - a.h); // le nom est le texte le plus grand du haut
    const bottom = ls.filter(l => l.y > 0.8).sort((a, b) => a.y - b.y || a.x - b.x).map(l => l.t).join('\n');
    let num = null;
    for (const l of ls.filter(l => l.y > 0.8)) { const n = parseNumber(l.t); if (n && !n.promo) { num = n; break; } if (n && !num) num = n; }
    return { names: top.slice(0, 3).map(l => l.t), num, year: parseYear(bottom), bottom };
  }

  const api = { readLines, typeScores, typeKey, quality, orbFeatures, freeFeatures, orbInliers, symbolScore, sheen, parseYear, parseGrade, findCard, findCards, orderCorners, warp, median, parseNumber };
  if (typeof module !== 'undefined') module.exports = api; else root.VISION = api;
})(this);
