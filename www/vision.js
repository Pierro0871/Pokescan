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

  // Texte lu en bas de carte -> { num, tot } (ex. "045/198"), ou null
  function parseNumber(text) {
    const m = String(text).replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').match(/(\d{1,3})\s*\/\s*(\d{2,3})/);
    return m ? { num: +m[1], tot: +m[2] } : null;
  }

  const api = { findCard, findCards, orderCorners, warp, median, parseNumber };
  if (typeof module !== 'undefined') module.exports = api; else root.VISION = api;
})(this);
