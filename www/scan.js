'use strict';
// Scan : caméra, détection, reconnaissance, session, boosters réels, page de classeur, ajout rapide.

// ---------- scan automatique ----------
const A = { timer: 0, res: null, qs: null, lastTop: null, doubtSince: 0, hold: null, paused: false, frames: [], corners: null, track: null, torch: false,
  variant: 'ask', mode: 'one', session: [], booster: null, auto: false, grade: null, batch: { n: 0, v: 0 }, autoVar: false, sheen: null };
let CV = null; // OpenCV, chargé en arrière-plan (13 Mo)
function cvReady() {
  if (!CV && window.cv && !cvReady.p) cvReady.p = Promise.resolve(window.cv).then(m => { CV = m; });
  return CV;
}

async function startCam() {
  const v = $('#video');
  fillScanSets();
  if (fsActive()) { // moteur natif : caméra native + texte + base complète
    stopWebCam();
    try { await fsStart(); return; } catch (err) { DIAG.err = 'moteur rapide indisponible : ' + err.message; }
  } else fsStop();
  status(S.fpSets.length ? '' : 'Active d\'abord le scan d\'une extension dans Collection');
  if (!v.srcObject) {
    try {
      v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      await v.play();
      A.track = v.srcObject.getVideoTracks()[0];
      const caps = A.track.getCapabilities?.() || {};
      $('#torch').hidden = !caps.torch; A.torch = false; $('#torch').classList.remove('on');
      if (caps.focusMode?.includes('continuous')) A.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => { });
      const z = $('#zoom');
      z.hidden = !caps.zoom || caps.zoom.max <= caps.zoom.min;
      if (!z.hidden) { z.min = caps.zoom.min; z.max = caps.zoom.max; z.step = caps.zoom.step || 0.1; z.value = A.track.getSettings?.().zoom ?? caps.zoom.min; }
      A.caps = caps;
    } catch (err) { return status('Caméra indisponible : ' + err.message); }
  }
  clearTimeout(A.timer); loop();
}
function stopCam() { fsStop(); stopWebCam(); }
function stopWebCam() {
  clearTimeout(A.timer);
  const v = $('#video');
  v.srcObject?.getTracks().forEach(t => t.stop()); v.srcObject = null; A.track = null;
}
async function toggleTorch() {
  if (FS.on) { A.torch = !A.torch; nsCall('torch', { on: A.torch }).catch(() => { A.torch = false; }); $('#torch').classList.toggle('on', A.torch); return; }
  if (!A.track) return;
  A.torch = !A.torch;
  try { await A.track.applyConstraints({ advanced: [{ torch: A.torch }] }); } catch { A.torch = false; }
  $('#torch').classList.toggle('on', A.torch);
}
function status(t) { $('#cam-msg').textContent = t || (A.mode === 'flat' ? 'Pose 2 à 6 cartes à plat sur un fond uni, puis « Analyser les cartes »' : FS.on && FS.ix ? `Pose la carte dans le rectangle · ${FS.ix.cards.length.toLocaleString('fr')} cartes connues` : `Pose la carte dans le rectangle · ${S.fpSets.length} extension(s) activée(s)`); }

// Retour : vibration + petit son
let audio;
// Sons au choix, synthétisés (pas de fichier) : [type d'onde, notes en Hz, durée d'une note]
const SOUNDS = {
  bip: { label: 'Bip', found: ['sine', [880, 1320], 0.07], add: ['sine', [660, 990], 0.07] },
  coin: { label: 'Pièce', found: ['square', [988], 0.06], add: ['square', [988, 1319], 0.08] },
  pop: { label: 'Pop', found: ['triangle', [520], 0.05], add: ['triangle', [420, 840], 0.05] },
  laser: { label: 'Laser', found: ['sawtooth', [1400, 700], 0.06], add: ['sawtooth', [1800, 900, 450], 0.05] },
  arpege: { label: 'Arpège', found: ['sine', [660, 880], 0.06], add: ['sine', [523, 659, 784, 1047], 0.06] },
  none: { label: 'Aucun' },
};
function playSound(kind, name = S.sound || 'bip') {
  const snd = SOUNDS[name]?.[kind === 'add' ? 'add' : 'found'];
  if (!snd) return;
  try {
    audio ||= new AudioContext();
    const [type, notes, d] = snd, t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    notes.forEach((f, i) => o.frequency.setValueAtTime(f, t + i * d));
    const end = t + notes.length * d + 0.08;
    g.gain.setValueAtTime(type === 'sine' || type === 'triangle' ? 0.14 : 0.05, t); g.gain.exponentialRampToValueAtTime(0.001, end);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(end);
  } catch { }
}
function feedback(kind) {
  navigator.vibrate?.(kind === 'add' ? [30, 50, 30] : 25);
  playSound(kind);
}

// Géométrie : zone capturée = cadre agrandi de 35 % (la carte peut dépasser ou être penchée)
function captureRect() {
  const v = $('#video'), cam = $('#cam').getBoundingClientRect(), g = $('#guide').getBoundingClientRect();
  const r = FP.guideToVideo(v.videoWidth, v.videoHeight, cam.width, cam.height, { x: g.left - cam.left, y: g.top - cam.top, w: g.width, h: g.height });
  const m = 0.35, x = Math.max(0, r.x - r.w * m), y = Math.max(0, r.y - r.h * m);
  return { x, y, w: Math.min(v.videoWidth, r.x + r.w * (1 + m)) - x, h: Math.min(v.videoHeight, r.y + r.h * (1 + m)) - y, guide: r, cam };
}
function grab(src, sx, sy, sw, sh, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}
const rot180 = px => { const o = new Uint8ClampedArray(px.length), n = px.length / 4; for (let i = 0; i < n; i++) o.set(px.subarray(i * 4, i * 4 + 4), (n - 1 - i) * 4); return o; };

// Contours verts des cartes détectées, dessinés par-dessus la vidéo. ox/oy : origine de la zone analysée (coords vidéo)
function drawQuads(quads, org) {
  const ov = $('#overlay'), cam = $('#cam').getBoundingClientRect(), v = $('#video');
  ov.width = cam.width; ov.height = cam.height;
  const ctx = ov.getContext('2d'); ctx.clearRect(0, 0, ov.width, ov.height);
  $('#guide').classList.toggle('found', quads.length > 0 && A.mode === 'one');
  if (!quads.length || !v.videoWidth) return;
  const s = Math.max(cam.width / v.videoWidth, cam.height / v.videoHeight), ox = (cam.width - v.videoWidth * s) / 2, oy = (cam.height - v.videoHeight * s) / 2;
  ctx.lineWidth = 4; ctx.strokeStyle = '#3ecf8e'; ctx.shadowColor = '#3ecf8e'; ctx.shadowBlur = 14;
  for (const q of quads) {
    ctx.beginPath();
    q.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo']((org.x + p.x) * s + ox, (org.y + p.y) * s + oy));
    ctx.closePath(); ctx.stroke();
  }
}
const drawCorners = (q, cr) => drawQuads(q ? [q] : [], cr);

// Lecture du numéro (Tesseract, hors ligne, chargé à la première utilisation)
// Un délai maximum partout : un module qui ne répond pas ne doit jamais bloquer le scan
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('délai dépassé')), ms))]);
const DIAG = { ocr: 'pas encore utilisée', last: null };
// Cartes candidates : l'extension choisie en amont, sinon toutes les extensions activées
const scanCards = () => A.only ? S.fpCards.filter(c => c.setId === A.only)
  : A.year ? S.fpCards.filter(c => (setInfo(c.setId)?.releaseDate || '').startsWith(A.year)) : S.fpCards;
let ocrP = null;
function ocrWorker() {
  if (!window.Tesseract || DIAG.ocr === 'indisponible') return null;
  const u = f => new URL('vendor/' + f, location.href).href;
  DIAG.ocr = DIAG.ocr === 'prête' ? 'prête' : 'chargement…';
  return ocrP ||= withTimeout(Tesseract.createWorker('eng', 1, {
    workerPath: u('worker.min.js'), corePath: u('tesseract-core-simd-lstm.wasm.js'), langPath: u(''), gzip: false, workerBlobURL: false, cacheMethod: 'none'
  }), 25000).then(w => { DIAG.ocr = 'prête'; return w; })
    .catch(err => { DIAG.ocr = 'indisponible'; DIAG.ocrErr = err.message; return null; });
}
// Un seul moteur OCR partagé : chaque lecture fixe ses réglages et passe à son tour
let ocrQ = Promise.resolve();
function ocr(canvas, params) {
  const run = ocrQ.then(async () => {
    const w = await ocrWorker(); if (!w) return '';
    await w.setParameters(params);
    return (await w.recognize(canvas)).data.text;
  });
  ocrQ = run.catch(() => { });
  return withTimeout(run, 4000).catch(() => ''); // shortcut: une lecture trop lente est abandonnée, l'image seule décide
}
// Morceau de l'image redressée (lignes y0..y0+bh) -> canvas agrandi ×2, gris contrasté
function strip(px, w, y0, bh, x0 = 0, x1 = w) {
  const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = bh;
  tmp.getContext('2d').putImageData(new ImageData(px.slice(y0 * w * 4, (y0 + bh) * w * 4), w, bh), 0, 0);
  const c = document.createElement('canvas'); c.width = (x1 - x0) * 2; c.height = bh * 2;
  const ctx = c.getContext('2d'); ctx.filter = 'grayscale(1) contrast(1.6)'; ctx.drawImage(tmp, x0, 0, x1 - x0, bh, 0, 0, c.width, c.height);
  return c;
}
// Nom en haut de la carte (texte brut, nettoyé ensuite)
async function readName(hi, w, h) {
  try {
    const t = await ocr(strip(hi, w, Math.round(h * 0.025), Math.round(h * 0.07), Math.round(w * 0.05), Math.round(w * 0.78)), { tessedit_char_whitelist: '', tessedit_pageseg_mode: '7' });
    DIAG.nameText = t.trim().slice(0, 40);
    return t;
  } catch { return ''; }
}
async function readNumber(hi, w, h) {
  if (!window.Tesseract) return null;
  // bande du bas de la carte (numéro à gauche sur les cartes récentes, à droite sur les anciennes)
  try {
    const t = await ocr(strip(hi, w, Math.round(h * 0.9), Math.round(h * 0.09)), { tessedit_char_whitelist: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ', tessedit_pageseg_mode: '11' });
    DIAG.ocrText = t.trim().slice(0, 30);
    return VISION.parseNumber(t);
  } catch { return null; }
}
async function readLabel(px, w, h) {
  if (!window.Tesseract) return {};
  try { return VISION.parseGrade(await ocr(strip(px, w, 0, h), { tessedit_char_whitelist: '', tessedit_pageseg_mode: '6' })); } catch { return {}; }
}
const officialOf = id => S.catalog?.flatMap(s => s.sets).find(s => s.id === id)?.cardCount?.official ?? S.fpCards.find(c => c.setId === id)?.official;

// Boîtier gradé : la carte est la forme (parmi celles trouvées) qui ressemble le plus à une carte connue ;
// l'étiquette est la bande au-dessus de la carte.
async function passGraded(cv, v, cr) {
  if (!scanCards().length) return null;
  const sw = 480, sh = Math.round(480 * cr.h / cr.w), small = grab(v, cr.x, cr.y, cr.w, cr.h, sw, sh);
  const found = VISION.findCards(cv, small, sw, sh, 0.05);
  if (!found.length) { drawQuads([], cr); return { list: [], sure: false, plausible: false }; }
  const k = cr.w / sw, bw = Math.min(1200, Math.round(cr.w)), bh = Math.round(bw * cr.h / cr.w), kb = bw / cr.w;
  const big = grab(v, cr.x, cr.y, cr.w, cr.h, bw, bh);
  let best = null;
  for (const f of found) {
    const qb = f.q.map(p => ({ x: p.x * k * kb, y: p.y * k * kb }));
    const img = VISION.warp(cv, big, bw, bh, qb, 126, 176);
    const qs = FP.nearCrops().map(c => FP.fingerprint(FP.resample(img, 126, 176, c)));
    const res = FP.rank(qs, scanCards()).slice(0, 5);
    if (!best || res[0].d < best.res[0].d) best = { res, qs, qb, f };
  }
  drawQuads([best.f.q.map(p => ({ x: p.x * k, y: p.y * k }))], cr);
  const [tl, tr, br, bl] = best.qb, up = { x: tl.x - bl.x, y: tl.y - bl.y };
  const at = (p, t) => ({ x: p.x + up.x * t, y: p.y + up.y * t });
  const label = VISION.warp(cv, big, bw, bh, [at(tl, 0.36), at(tr, 0.36), at(tr, 0.04), at(tl, 0.04)], 600, 220);
  const g = DIAG.ocr === 'prête' ? await readLabel(label, 600, 220) : (ocrWorker(), {});
  A.grade = { ...(A.grade || {}), ...g }; // on garde ce qui a déjà été lu sur les passes précédentes
  const dec = FP.decide(best.qs, best.res, scanCards(), null, officialOf);
  return { ...dec, plausible: best.res[0].d < FP.LOOSE_MAX };
}

// Une passe de scan. Renvoie { list, sure } ou null.
async function pass() {
  const v = $('#video');
  if (!v.videoWidth) return null;
  const cr = captureRect();
  const cv = cvReady();
  if (cv && A.mode === 'graded') return passGraded(cv, v, cr);
  if (cv) {
    // détection sur une petite image, redressement depuis l'image pleine résolution
    const sw = 480, sh = Math.round(480 * cr.h / cr.w), small = grab(v, cr.x, cr.y, cr.w, cr.h, sw, sh);
    let q = null;
    try { q = VISION.findCard(cv, small, sw, sh); } catch { }
    if (q) {
      const k = cr.w / sw, qv = q.map(p => ({ x: p.x * k, y: p.y * k }));
      drawCorners(qv, cr);
      const bw = Math.min(1200, Math.round(cr.w)), bh = Math.round(bw * cr.h / cr.w), kb = bw / cr.w;
      const big = grab(v, cr.x, cr.y, cr.w, cr.h, bw, bh), qb = qv.map(p => ({ x: p.x * kb, y: p.y * kb }));
      const lo = VISION.warp(cv, big, bw, bh, qb, 126, 176);
      // anti-reflet : médiane des 3 dernières images si la carte n'a pas bougé
      const moved = !A.corners || qv.some((p, i) => Math.hypot(p.x - A.corners[i].x, p.y - A.corners[i].y) > cr.w * 0.04);
      A.frames = moved ? [lo] : [...A.frames.slice(-2), lo]; A.corners = qv;
      const img = VISION.median(A.frames), flip = rot180(img);
      A.sheen = VISION.sheen(A.frames, 126, 176);
      // conseils de prise de vue : flou, sombre, reflet, carte coupée ou trop petite
      const qual = VISION.quality(lo, 126, 176), area = Math.abs((qv[1].x - qv[0].x) * (qv[3].y - qv[0].y)) / (cr.w * cr.h);
      const edge = qv.some(p => p.x < cr.w * 0.01 || p.y < cr.h * 0.01 || p.x > cr.w * 0.99 || p.y > cr.h * 0.99);
      A.tip = qual.sharp < SHARP_MIN ? '🔍 Trop flou : tiens le téléphone immobile' : qual.bright < 55 ? '🌙 Trop sombre : allume la lampe 🔦' : qual.glare > 0.04 ? '✨ Reflet sur la carte : incline un peu le téléphone'
        : edge ? '✂️ Carte coupée : recule un peu' : area < 0.2 ? '🔎 Rapproche-toi de la carte' : '';
      A.quality = qual;
      if (qual.sharp < SHARP_MIN) { DIAG.last = { edges: true, res: [], num: null, sure: false }; drawDebug(qv, cr); return { list: [], sure: false, plausible: true, blurry: true }; }
      A.lastWarp = VISION.warp(cv, big, bw, bh, qb, 315, 440); // pour les points caractéristiques
      const qs = FP.nearCrops().flatMap(c => [FP.fingerprint(FP.resample(img, 126, 176, c)), FP.fingerprint(FP.resample(flip, 126, 176, c))]);
      A.type = VISION.typeScores(img, 126, 176);
      const cards = scanCards(), res = cards.length ? withType(FP.rank(qs, cards)).slice(0, 5) : [];
      let num = null;
      DIAG.ocrText = '';
      // lecture du numéro seulement si le moteur est prêt : on ne l'attend jamais (il se charge en fond)
      A.hiCache = null;
      if (DIAG.ocr === 'prête') { if (!res.length || res[0].d < FP.LOOSE_MAX) num = await readNumber(A.hiCache = VISION.warp(cv, big, bw, bh, qb, 630, 880), 630, 880); }
      else ocrWorker();
      if (!res.length) {
        if (num) resolveSet(num, DIAG.ocr === 'prête' ? await readName(A.hiCache, 630, 880) : '', A.hiCache);
        DIAG.last = { edges: true, res, num, sure: false }; drawDebug(qv, cr); return null;
      }
      let dec = FP.decide(qs, res, cards, num, officialOf);
      DIAG.nameText = ''; DIAG.name = null;
      let raw = '';
      // pas sûr : on lit aussi le nom du Pokémon et on cherche avec
      if (!dec.sure && DIAG.ocr === 'prête') {
        const hi = A.hiCache || VISION.warp(cv, big, bw, bh, qb, 630, 880);
        raw = await readName(hi, 630, 880);
        const byName = decideByName(qs, res, cards, raw, num);
        if (byName) dec = byName;
      }
      if (num && !dec.matched) resolveSet(num, raw, A.hiCache);
      DIAG.last = { edges: true, res, num, sure: dec.sure };
      drawDebug(qv, cr);
      return { ...dec, plausible: true };
    }
  }
  // sans bords détectés : recherche sur plusieurs cadrages dans le rectangle
  drawCorners(null, cr); A.frames = []; A.corners = null;
  if (!scanCards().length) return null;
  const M = FP.MARGIN, g = cr.guide, AW = Math.round(FP.W * 2 * (1 + 2 * M)), AH = Math.round(FP.H * 2 * (1 + 2 * M));
  const px = grab(v, g.x - g.w * M, g.y - g.h * M, g.w * (1 + 2 * M), g.h * (1 + 2 * M), AW, AH);
  const res = FP.search(c => FP.fingerprint(FP.resample(px, AW, AH, c)), scanCards(), 5);
  DIAG.last = { edges: false, res, num: null, sure: FP.isSure(res) };
  drawDebug(null, cr);
  return { list: res, sure: FP.isSure(res), plausible: res[0].d < FP.LOOSE_MAX };
}

const votesFor = id => (A.votes || []).filter(x => x === id).length;
// Doute : les points caractéristiques départagent les meilleures avant de demander à l'utilisateur
async function doubtful() {
  A.paused = true;
  status('Comparaison des détails…');
  const o = await orbRerank(A.res, A.lastWarp).catch(() => null);
  if (o?.length && o[0].n >= 25 && o[0].n >= 2 * (o[1]?.n || 0)) {
    A.res = [o[0].r, ...A.res.filter(r => r !== o[0].r)];
    A.conf = confidence(A.res, { orb: true });
    A.conf.pct = Math.max(A.conf.pct, 85);
    return propose(true);
  }
  A.conf = confidence(A.res);
  propose(false);
}

async function loop() {
  if (S.view !== 'scan') return;
  if (!A.paused && !A.analyzing && !(A.flyUntil > Date.now()) && $('#sheet').hidden && A.mode !== 'page') {
    let r = null;
    const t0 = performance.now();
    try { r = await pass(); DIAG.err = ''; } catch (err) { console.error(err); DIAG.err = err.message; }
    DIAG.ms = Math.round(performance.now() - t0);
    renderDiag();
    if (r?.blurry) status(A.tip);
    if (r && r.list.length && !A.paused && S.view === 'scan') {
      A.res = r.list;
      const top = r.list[0].card.id;
      A.votes = [...(A.votes || []).slice(-3), top];
      $('#guide').classList.toggle('searching', r.plausible);
      if (A.hold) { // attend que la carte précédente sorte du cadre
        if (top !== A.hold || !r.plausible) A.hold = null; else status('Retire la carte pour scanner la suivante');
      } else if (r.sure && votesFor(top) >= (r.byNumber || r.byName ? 2 : 3)) { // vote : 3 images sur les 4 dernières (2 si numéro ou nom lus)
        A.conf = confidence(r.list, r);
        if ((A.auto && A.mode === 'one') || A.mode === 'batch') choose(r.list[0].card); else propose(true);
      }
      else if (r.plausible) {
        if (!A.analyzing) status(r.sure ? 'Presque…' : 'Recherche…');
        A.doubtSince ||= Date.now();
        // pas sûr après 1,2 s : on lit la carte (nom, numéro, année) pour trouver la bonne et son extension
        if (A.tip && !A.analyzing) status(A.tip);
        if (!A.analyzed && !A.analyzing && Date.now() - A.doubtSince > 1200) analyzeCard();
        else if (A.analyzed && !A.analyzing && !A.paused && Date.now() - A.doubtSince > 3000) doubtful();
      } else { A.doubtSince = 0; if (!A.analyzing) status(); }
      A.lastTop = top;
    }
  }
  if (S.view === 'scan') A.timer = setTimeout(loop, 150);
}

const setYear = id => (setInfo(id)?.releaseDate || FS.ix?.sets.find(s => s.id === id)?.date || '').slice(0, 4);
function resume(holdId) {
  A.rejected = null;
  fsPause(false);
  A.grade = null; A.cardYear = null; A.analyzed = false; A.votes = []; A.conf = null;
  A.hold = holdId; A.paused = false; A.doubtSince = 0; A.lastTop = null;
  clearProp(); status();
}

// ---------- couleur / type : une carte d'un autre type que la couleur vue perd des points ----------
const SHARP_MIN = 7; // shortcut: seuil de netteté calé sur une vraie carte (≈28) et des images floues, à affiner
function typeMatch(card) {
  const t = A.type, types = S.meta[card.id]?.t;
  if (!t?.sure || !types?.length) return null;
  return Math.max(...types.map(x => t.scores[VISION.typeKey(x)] ?? 0));
}
function withType(list) {
  for (const r of list) { const m = typeMatch(r.card); r.type = m; if (m != null) r.d += 0.05 * (1 - m); }
  return list.sort((a, b) => a.d - b.d);
}

// ---------- points caractéristiques : départager les meilleures candidates ----------
const ORB_CACHE = new Map();
async function orbRerank(list, query) {
  const cv = cvReady();
  if (!cv || !query || list.length < 1) return null;
  const fq = VISION.orbFeatures(cv, query, 315, 440), out = [];
  try {
    for (const r of list.slice(0, 5)) {
      let f = ORB_CACHE.get(r.card.id);
      if (!f) {
        try {
          const src = r.card.image ? `${r.card.image}/high.webp` : imgOf(r.card, 'high');
          const im = await withTimeout(getImage(src), 5000), px = grab(im, 0, 0, im.width, im.height, 315, 440);
          f = VISION.orbFeatures(cv, px, 315, 440); ORB_CACHE.set(r.card.id, f);
          if (ORB_CACHE.size > 60) { const [k, old] = ORB_CACHE.entries().next().value; VISION.freeFeatures(old); ORB_CACHE.delete(k); }
        } catch { continue; } // pas d'image (hors ligne) : cette carte n'est pas départagée
      }
      out.push({ r, n: VISION.orbInliers(cv, fq, f) });
    }
  } finally { VISION.freeFeatures(fq); }
  out.sort((a, b) => b.n - a.n);
  DIAG.orb = out.map(o => `${o.r.card.name} ${o.n}`).join(' · ');
  return out;
}

// Confiance 0..1 et ce qui a compté
function confidence(list, extra = {}) {
  const d1 = list[0]?.d ?? 1, d2 = list[1]?.d ?? d1 + 0.2, parts = [];
  let c = Math.max(0, Math.min(0.55, (d2 - d1) * 3.5)) + (d1 < 0.3 ? 0.15 : d1 < FP.LOOSE_MAX ? 0.05 : 0);
  if (d2 - d1 > 0.05) parts.push('image');
  if (extra.byNumber) { c += 0.25; parts.push('numéro'); }
  if (extra.byName) { c += 0.15; parts.push('nom'); }
  if (list[0]?.type > 0.6) { c += 0.05; parts.push('couleur'); }
  if (extra.orb) { c += 0.2; parts.push('détails'); }
  if (extra.symbol) { c += 0.1; parts.push('symbole'); }
  return { pct: Math.round(Math.max(0.05, Math.min(0.99, c)) * 100), parts };
}

// « Pas celle-là » : même nom (et même numéro lu), d'abord la même extension, puis les extensions de la même période
function otherCards(bad) {
  (A.rejected ||= new Set()).add(bad.id);
  const ix = FS.ix || fsMini();
  let list = [];
  if (ix) {
    const ids = new Set();
    for (const n of [bad.name, ix.cards.find(c => c.id === bad.id)?.nameEn]) for (const i of ix.byName.get(LOGIC.norm(n || '')) || []) ids.add(i);
    for (const t of FS.read?.names || []) for (const i of LOGIC.namesFor(ix, t)?.ids || []) ids.add(i);
    const num = FS.read?.num;
    if (num && !num.promo) for (const i of ix.byNum.get(num.num) || []) { const s = ix.sets[ix.cards[i].set]; if (s.official === num.tot || s.total === num.tot) ids.add(i); }
    const ref = ix.sets.find(s => s.id === bad.setId), y0 = ref?.year || 0;
    list = [...ids].filter(i => !A.rejected.has(ix.cards[i].id)).map(i => {
      const c = ix.cards[i], s = ix.sets[c.set];
      return { i, k: (s.id === bad.setId ? 0 : 1000) + (y0 && s.year ? Math.abs(s.year - y0) * 10 : 500) + (LOGIC.norm(c.name) === LOGIC.norm(bad.name) ? 0 : 5) };
    }).sort((a, b) => a.k - b.k).slice(0, 12).map(x => ({ card: fsCard(ix, x.i), d: 0.5 }));
  }
  if (!list.length) list = (A.res || []).filter(r => !A.rejected.has(r.card.id));
  if (!list.length) { toast('Aucune autre carte de ce nom : cherche-la par nom'); resume(bad.id); show('poke'); return; }
  A.res = list; A.conf = null;
  propose(false, `Autres « ${bad.name} » : même extension d'abord, puis même période`);
}

// Propositions affichées par-dessus l'image caméra
function clearProp() { const p = $('#camprop'); if (p) p.innerHTML = ''; }

async function choose(c, fromEl) {
  if (A.choosing) return;
  A.choosing = true; A.paused = true; fsPause(true);
  const extra = A.mode === 'graded' && A.grade?.grade ? { grade: { co: A.grade.co || '?', g: A.grade.grade, cert: A.grade.cert || '' } } : {};
  const hold = A.res?.[0]?.card.id ?? c.id;
  try {
    const info = await cardInfo(c);
    let variant = scanVariant();
    if (variant === 'ask') { // doute sur la version : on demande (sauf s'il n'en existe qu'une)
      const opts = variantOptions(info);
      variant = opts.length === 1 ? opts[0] : await askVariant(c, opts);
      if (!variant) { resume(hold); return; }
    }
    clearProp();
    feedback('add');
    flyCamera();
    A.grade = null;
    // enregistrement une fois l'animation lancée : il ne la bloque plus
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      addFromScan(c, extra, variant);
      resume(hold);
      const v = variant !== 'normal' ? ` · ${VARIANT_LABEL[variant] || variant}` : '';
      toast(`Ajouté : <b>${esc(c.name)}</b> (${esc(c.setName)} ${esc(c.localId)}${v}) — touche pour modifier`, () => openCard(c));
      celebrate(c, variant);
    }, 0)));
  } finally { A.choosing = false; }
}

// ---------- version de la carte (normale / reverse / holo) ----------
const VARIANT_LABEL = { normal: 'Normale', reverse: 'Reverse', holo: 'Holo' };
const VARS = new Map();
// Versions existantes et prix : extension téléchargée, sinon la fiche en ligne (1,5 s max)
async function cardInfo(c) {
  let v = c.variants || S.fpCards.find(x => x.id === c.id)?.variants || VARS.get(c.id);
  if ((!v || !S.prices[c.id]) && !c.id.startsWith('perso-')) {
    try {
      const d = await withTimeout(getJSON('/cards/' + encodeURIComponent(c.id), FS.ix && FS.ix.sets.find(s => s.id === c.setId)?.enOnly ? 'en' : S.lang), 1500);
      rememberMeta(d);
      if (d.variants) { v = d.variants; VARS.set(c.id, v); }
      if (d.pricing?.cardmarket) { setPrice(c.id, d.pricing.cardmarket, true); kv.set('prices', S.prices); }
    } catch { } // hors ligne : toutes les versions sont proposées
  }
  return { variants: v, price: S.prices[c.id] };
}
function variantOptions(info) {
  const v = info.variants;
  if (!v) return ['normal', 'reverse', 'holo'];
  const o = ['normal', 'reverse', 'holo'].filter(k => v[k]);
  return o.length ? o : ['normal'];
}
// Choix sur l'image caméra, avec le prix de chaque version
function askVariant(c, opts) {
  feedback('found');
  status('Quelle version ?');
  return new Promise(res => {
    const box = $('#camprop'), p = S.prices[c.id];
    const sheen = A.sheen ? `<p class="small sheen">✨ Reflets vus : plutôt ${A.sheen === 'reverse' ? 'Reverse' : 'Holo'}</p>` : '';
    box.innerHTML = `<div class="match sure varask">
        ${imgOf(c) ? `<img src="${esc(imgOf(c))}" alt="">` : ''}
        <span class="grow"><b>${esc(c.name)}</b><br><span class="muted">${esc(c.setName)} · n° ${esc(c.localId)}</span><br><b>Quelle version ?</b></span></div>
      ${sheen}<div class="row varbtns">${opts.map(k => {
        const pr = FP.unitPrice(p, k, 'NM', S.coef).trend;
        return `<button class="${A.sheen === k ? 'primary' : 'ghost'}" data-v="${k}">${{ normal: '⬜', reverse: '🔁', holo: '✨' }[k]} ${VARIANT_LABEL[k]}${pr != null ? `<br><span class="small">${eur(pr)}</span>` : ''}</button>`;
      }).join('')}</div>
      <div class="row"><button class="ghost" id="var-cancel">Annuler</button></div>`;
    box.querySelectorAll('[data-v]').forEach(b => b.onclick = () => res(b.dataset.v));
    $('#var-cancel').onclick = () => res(null);
  });
}

// ---------- carte de valeur : animation et message ----------
async function celebrate(c, variant, demo) {
  const price = demo ?? FP.unitPrice(S.prices[c.id], variant, 'NM', S.coef).trend, min = demo ? 1 : S.richMin ?? 20;
  if (!min || price == null || price < min) return;
  const big = price >= Math.max(100, min * 5);
  try { navigator.vibrate?.(big ? [60, 40, 60, 40, 200] : [40, 30, 120]); } catch { }
  playJingle(big);
  const el = document.createElement('div');
  el.className = 'jackpot' + (big ? ' big' : '');
  const coins = Array.from({ length: big ? 26 : 14 }, (_, i) => {
    const a = (i / (big ? 26 : 14)) * Math.PI * 2 + Math.random() * 0.4, r = 120 + Math.random() * 140;
    return `<i style="--x:${Math.round(Math.cos(a) * r)}px;--y:${Math.round(Math.sin(a) * r)}px;--d:${(Math.random() * 0.25).toFixed(2)}s">${['💰', '✨', '🪙', '⭐'][i % 4]}</i>`;
  }).join('');
  el.innerHTML = `<div class="jk-glow"></div>${coins}<div class="jk-card">${imgOf(c) ? `<img src="${esc(imgOf(c))}" alt="">` : ''}</div>
    <div class="jk-msg"><b>${big ? '💎 JACKPOT !' : '💰 Carte de valeur !'}</b><span>${esc(c.name)}${variant !== 'normal' ? ' ' + VARIANT_LABEL[variant] : ''}</span><strong>${eur(price)}</strong></div>`;
  document.body.appendChild(el);
  el.onclick = () => el.remove();
  setTimeout(() => el.classList.add('out'), big ? 3200 : 2400);
  setTimeout(() => el.remove(), big ? 3700 : 2900);
}
function playJingle(big) {
  if ((S.sound || 'bip') === 'none') return;
  try {
    audio ||= new AudioContext();
    const t = audio.currentTime, notes = big ? [523, 659, 784, 1047, 1319, 1568] : [784, 988, 1319];
    notes.forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain(), s = t + i * 0.09;
      o.type = 'triangle'; o.frequency.setValueAtTime(f, s);
      g.gain.setValueAtTime(0.12, s); g.gain.exponentialRampToValueAtTime(0.001, s + 0.35);
      o.connect(g).connect(audio.destination); o.start(s); o.stop(s + 0.36);
    });
  } catch { }
}

// Ajout depuis le scan : variante choisie, session en cours, booster en cours
const scanVariant = () => (A.autoVar && A.sheen) || A.variant;
function addFromScan(c, extra = {}, v) {
  let variant = v || scanVariant();
  if (variant === 'ask') variant = defaultVariant(c);
  const e = addCard(c, { variant, ...extra });
  if (A.mode === 'batch') {
    A.batch.n++; A.batch.v += FP.unitPrice(S.prices[c.id], variant, 'NM', S.coef).trend || 0;
    renderBatch(true);
  }
  A.session.unshift({ c, variant, t: Date.now() });
  if (A.booster) { A.booster.cards.push(c.id); kv.set('boosters', S.boosters); }
  renderSession();
  return e;
}

// Nom lu proche d'un nom connu des extensions activées -> cette carte (le numéro, s'il est lu, départage)
function decideByName(qs, res, cards, raw, num) {
  const names = [...new Set(cards.map(c => c.name))], bn = LOGIC.bestName(raw, names);
  if (!bn) return null;
  DIAG.name = bn.name;
  let cand = cards.filter(c => c.name === bn.name && c.fp);
  if (num && !num.promo && cand.some(c => LOGIC.localNum(c) === num.num)) cand = cand.filter(c => LOGIC.localNum(c) === num.num);
  if (!cand.length) return null;
  const sc = cand.map(card => { let d = Infinity; for (const q of qs) d = Math.min(d, FP.distance(q, card.fp)); return { card, d }; }).sort((a, b) => a.d - b.d);
  const best = sc[0], numOk = !!num && LOGIC.localNum(best.card) === num.num;
  // sûr : nom + numéro d'accord, ou nom + image cohérente quand peu de versions de ce Pokémon
  const sure = (numOk && best.d < FP.LOOSE_MAX + 0.04) || (best.d < 0.40 && (sc.length === 1 || sc[1].d - best.d > 0.04));
  return { list: [best, ...res.filter(r => r.card.id !== best.card.id)].slice(0, 5), sure, matched: true, byName: true };
}

// ---------- quelle extension ? nom + numéro + année lus sur la carte ----------
// Lecture identique deux fois de suite -> candidates : extensions de ce total (084) ou promo (MEP),
// recoupées avec celles où ce Pokémon porte ce numéro, classées par l'année du © (ou l'année choisie).
// Une seule nette gagnante : téléchargée toute seule ; sinon on propose les 2 à 4 plus probables.
async function resolveSet(num, raw, hi) {
  if (A.dl || A.only || !num || A.offering || A.resolving) return;
  A.resolving = true;
  try { await resolveSetNow(num, raw, hi); } finally { A.resolving = false; }
}
async function resolveSetNow(num, raw, hi) {
  const dex = raw ? LOGIC.bestName(raw, await dexNames(), 0.75) : null;
  const key = JSON.stringify(num) + '|' + (dex?.name || '');
  if (A.lastKey !== key) { A.lastKey = key; return; }
  if (hi && DIAG.ocr === 'prête' && !A.cardYear) A.cardYear = await readYear(hi, 630, 880);
  A.tried ||= new Set();
  let sets = num.promo
    ? allSets().filter(s => s.id.toLowerCase() === num.promo.toLowerCase() || norm(s.name).split(/\W+/).includes(num.promo.toLowerCase()))
    : allSets().filter(s => s.cardCount?.official === num.tot || s.cardCount?.total === num.tot);
  if (dex) { // ce Pokémon avec ce numéro : extensions où il existe vraiment
    try {
      const ids = new Set((await getJSON('/cards?name=' + encodeURIComponent(dex.name))).filter(c => LOGIC.localNum(c) === num.num).map(c => setIdOf(c)));
      const inter = sets.filter(s => ids.has(s.id));
      if (inter.length) sets = inter; else if (!sets.length) sets = allSets().filter(s => ids.has(s.id));
    } catch { }
  }
  // une extension a pu arriver entre-temps (téléchargement terminé) : la carte est peut-être déjà connue
  if (A.dl || scanCards().some(c => LOGIC.localNum(c) === num.num && (num.promo ? c.setId.toLowerCase() === num.promo.toLowerCase() : officialOf(c.setId) === num.tot))) return;
  sets = sets.filter(s => !S.fpSets.includes(s.id) && !A.tried.has(s.id));
  const ranked = LOGIC.rankSets(sets, { tot: num.tot, cardYear: A.cardYear, pickYear: A.year });
  DIAG.guess = ranked.slice(0, 3).map(r => `${r.st.name} (${r.sc})`).join(' · ');
  if (!ranked.length) return;
  const why = [dex?.name, num.promo ? num.promo + ' ' + num.num : num.num + '/' + num.tot, A.cardYear && '©' + A.cardYear].filter(Boolean).join(', ');
  if (ranked.length === 1 || ranked[0].sc - ranked[1].sc >= 1) scanDownload(ranked[0].st, why);
  else if (ranked.length <= 4) offerSets(ranked.map(r => r.st), why);
}
async function readYear(hi, w, h) {
  try {
    const t = await ocr(strip(hi, w, Math.round(h * 0.962), Math.round(h * 0.036)), { tessedit_char_whitelist: '©0123456789 ,-', tessedit_pageseg_mode: '7' });
    DIAG.yearText = t.trim().slice(0, 30);
    return VISION.parseYear(t);
  } catch { return null; }
}
// Plusieurs extensions possibles : l'utilisateur tranche d'un geste
function offerSets(sets, why, then = st => scanDownload(st, why)) {
  A.offering = true;
  const box = $('#camprop');
  box.innerHTML = `<p class="muted">Carte lue (${esc(why)}) : de quelle extension ?</p>` + sets.map(st => `
    <button class="match" data-s="${esc(st.id)}">${setLogo(st)}<span class="grow"><b>${esc(st.name)}</b><br><span class="muted">${esc(st.serieName)}${st.releaseDate ? ' · ' + st.releaseDate.slice(0, 4) : ''} · ${LOGIC.total(st)} cartes</span></span></button>`).join('')
    + '<button class="ghost" id="off-none">Aucune de celles-ci</button>';
  box.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { A.offering = false; box.innerHTML = ''; then(setInfo(b.dataset.s)); });
  $('#off-none').onclick = () => { A.offering = false; sets.forEach(s => A.tried.add(s.id)); box.innerHTML = ''; };
}

async function scanDownload(st, why = '') {
  if (A.dl || !st) return;
  A.tried ||= new Set();
  A.tried.add(st.id); A.dl = st.id;
  toast(`Extension détectée${why ? ' (' + esc(why) + ')' : ''} : <b>${esc(st.name)}</b> — téléchargement pour le scan…`);
  try {
    await downloadSet(await getSet(st.id), (d, t) => status(`Téléchargement de ${st.name} : ${d}/${t}`));
    toast(`${esc(st.name)} est prête pour le scan`); fillScanSets();
  } catch (err) { toast('Téléchargement impossible : ' + esc(err.message)); }
  finally { A.dl = null; status(); }
}

// Choix de l'extension en amont : le scan ne cherche que dedans (plus fiable, plus rapide)
function fillScanSets() {
  const sel = $('#scan-set'); if (!sel) return;
  $('#scan-lang') && ($('#scan-lang').value = S.lang);
  const ys = $('#scan-year'), years = [...new Set(allSets().map(LOGIC.year))].filter(y => y !== '—' && y !== '0000').sort().reverse();
  ys.innerHTML = `<option value="">Toutes années</option>${years.map(y => `<option ${A.year === y ? 'selected' : ''}>${y}</option>`).join('')}`;
  const inYear = s => !A.year || (s.releaseDate || '').startsWith(A.year);
  const ready = allSets().filter(s => S.fpSets.includes(s.id) && inYear(s)), rest = allSets().filter(s => !S.fpSets.includes(s.id) && inYear(s))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  sel.innerHTML = `<option value="">Toutes mes extensions activées (détection auto)</option>
    ${ready.length ? `<optgroup label="Activées">${ready.map(s => `<option value="${esc(s.id)}" ${A.only === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</optgroup>` : ''}
    ${rest.length ? `<optgroup label="À télécharger">${rest.map(s => `<option value="${esc(s.id)}">${esc(s.name)}${s.releaseDate ? ' (' + s.releaseDate.slice(0, 4) + ')' : ''}</option>`).join('')}</optgroup>` : ''}`;
}
async function chooseScanSet(id) {
  if (id && !S.fpSets.includes(id)) {
    const st = setInfo(id);
    status(`Téléchargement de ${st?.name || id}…`);
    try { await downloadSet(await getSet(id), (d, t) => status(`Téléchargement de ${st?.name || id} : ${d}/${t}`)); }
    catch (err) { toast('Téléchargement impossible : ' + esc(err.message)); id = ''; }
  }
  A.only = id; fillScanSets(); retryScan();
  status(id ? `Scan limité à ${setName(id)}` : '');
}


// ---------- analyse complète de la carte : lire nom, numéro, année, puis en déduire l'extension ----------
// Photo pleine résolution si possible (le petit numéro est illisible dans le flux vidéo)
async function stillFrame() {
  try {
    if (window.ImageCapture && A.track && A.track.readyState === 'live') {
      const blob = await withTimeout(new ImageCapture(A.track).takePhoto(), 4000);
      return await createImageBitmap(blob);
    }
  } catch { }
  return null;
}
// Pixels -> petite image (pour l'empreinte) via un canvas
function shrink(px, w, h, tw, th) {
  const a = document.createElement('canvas'); a.width = w; a.height = h;
  a.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
  return grab(a, 0, 0, w, h, tw, th);
}
async function analyzeCard(manual = false) {
  if (A.analyzing) return;
  A.analyzing = true;
  status('🔍 Analyse de la carte (nom, numéro, année)…');
  const R = { name: null, raw: '', num: null, year: null, src: '', edges: false };
  DIAG.analysis = R;
  try {
    const v = $('#video'), cv = cvReady();
    const still = await stillFrame();
    const src = still || v, W = still ? still.width : v.videoWidth, H = still ? still.height : v.videoHeight;
    R.src = still ? `photo ${W}×${H}` : `vidéo ${W}×${H}`;
    if (!W) return;
    // où est la carte ? bords trouvés sur l'image entière, sinon le rectangle jaune reporté sur la photo
    const sw = 640, sh = Math.round(640 * H / W), small = grab(src, 0, 0, W, H, sw, sh);
    let q = null;
    if (cv) try { q = VISION.findCard(cv, small, sw, sh); } catch { }
    let hi;
    const HW = 1260, HH = 1760;
    if (q) {
      R.edges = true;
      const bw = Math.min(W, 2600), bh = Math.round(bw * H / W), k = bw / sw;
      const big = grab(src, 0, 0, W, H, bw, bh);
      hi = VISION.warp(cv, big, bw, bh, q.map(p => ({ x: p.x * k, y: p.y * k })), HW, HH);
    } else {
      const g = captureRect().guide, vw = v.videoWidth, vh = v.videoHeight;
      const s = Math.min(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2; // la vidéo est un recadrage centré de la photo
      hi = grab(src, ox + g.x * s, oy + g.y * s, g.w * s, g.h * s, HW, HH);
    }
    still?.close?.();
    // lecture : le moteur doit être prêt (on l'attend ici, c'est une action ponctuelle)
    if (!(await ocrWorker())) { toast('Lecture du texte indisponible sur ce téléphone'); return; }
    R.raw = await ocr(strip(hi, HW, Math.round(HH * 0.02), Math.round(HH * 0.08), Math.round(HW * 0.04), Math.round(HW * 0.80)), { tessedit_char_whitelist: '', tessedit_pageseg_mode: '7' });
    const bottom = await ocr(strip(hi, HW, Math.round(HH * 0.9), Math.round(HH * 0.095)), { tessedit_char_whitelist: '', tessedit_pageseg_mode: '11' });
    R.bottom = bottom.replace(/\s+/g, ' ').trim().slice(0, 60);
    R.num = VISION.parseNumber(bottom);
    if (!R.num) R.num = VISION.parseNumber(await ocr(strip(hi, HW, Math.round(HH * 0.9), Math.round(HH * 0.095)), { tessedit_char_whitelist: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ', tessedit_pageseg_mode: '11' }));
    R.year = VISION.parseYear(bottom);
    const pool = scanCards();
    R.name = LOGIC.bestName(R.raw, [...new Set(pool.map(c => c.name))])?.name || LOGIC.bestName(R.raw, await dexNames(), 0.72)?.name || await apiName(R.raw);
    if (R.year) A.cardYear = R.year;
    renderDiag();
    R.hi = hi;
    await identify(R, shrink(hi, HW, HH, 126, 176), manual);
  } catch (err) { console.error(err); DIAG.err = err.message; }
  finally { A.analyzing = false; A.analyzed = true; if (!A.paused) status(); }
}

const shrinkTo = (px, w, h, tw, th) => shrink(px, w, h, tw, th);
const SYM = new Map();
async function symbolOf(st, band, w, h) {
  const cv = cvReady(); if (!cv) return 0;
  try {
    let sym = SYM.get(st.id);
    if (!sym) {
      const url = st.symbol ? st.symbol + '.png' : `https://assets.tcgdex.net/univ/${st.serie}/${st.id}/symbol.png`;
      const im = await withTimeout(getImage(url), 5000), sw = 64, sh = Math.max(8, Math.round(64 * im.height / im.width));
      sym = { px: grab(im, 0, 0, im.width, im.height, sw, sh), sw, sh }; SYM.set(st.id, sym);
    }
    return VISION.symbolScore(cv, band, w, h, sym.px, sym.sw, sym.sh);
  } catch { return 0; }
}

// Nom absent du Pokédex (Dresseur, Stade, Objet, Énergie…) : on cherche le mot lu le plus long dans la base
async function apiName(raw) {
  const words = LOGIC.cleanName(raw).split(' ').filter(w => w.length >= 4).sort((a, b) => b.length - a.length).slice(0, 2);
  for (const w of words) {
    try {
      const names = [...new Set((await getJSON('/cards?name=' + encodeURIComponent(w))).map(c => c.name))];
      const bn = LOGIC.bestName(raw, names, 0.7);
      if (bn) return bn.name;
    } catch { return null; }
  }
  return null;
}

// Ce qui a été lu -> la carte : d'abord dans les extensions activées, sinon dans toute la base
async function identify(R, lo, manual) {
  const qs = FP.nearCrops().map(c => FP.fingerprint(FP.resample(lo, 126, 176, c)));
  const pool = scanCards(), what = [R.name, R.num && (R.num.promo ? R.num.promo + ' ' + R.num.num : R.num.num + '/' + R.num.tot), R.year && '©' + R.year].filter(Boolean).join(' · ');
  if (pool.length) {
    const res = FP.rank(qs, pool).slice(0, 5);
    let dec = FP.decide(qs, res, pool, R.num, officialOf);
    if (!dec.matched && R.name) dec = decideByName(qs, res, pool, R.raw.includes(R.name) ? R.raw : R.name, R.num) || dec;
    if (dec.matched) { A.res = dec.list; A.conf = confidence(dec.list, dec); status(`Lu : ${what}`); return propose(true); }
    // rien de lu d'utile : les détails de l'illustration départagent les meilleures
    const o = await orbRerank(res, shrinkTo(R.hi, 1260, 1760, 315, 440)).catch(() => null);
    if (o?.length && o[0].n >= 25 && o[0].n >= 2 * (o[1]?.n || 0)) { A.res = [o[0].r, ...res.filter(r => r !== o[0].r)]; A.conf = confidence(A.res, { orb: true }); A.conf.pct = Math.max(A.conf.pct, 85); return propose(true); }
  }
  // pas dans les extensions activées : ce Pokémon + ce numéro dans toute la base
  let sets = [];
  if (R.name) { // toutes les cartes de ce Pokémon ; avec le numéro lu, seulement celles qui le portent
    try {
      const found = (await getJSON('/cards?name=' + encodeURIComponent(R.name))).filter(c => norm(c.name) === norm(R.name) && (!R.num || LOGIC.localNum(c) === R.num.num));
      sets = [...new Set(found.map(c => setIdOf(c)))].map(setInfo).filter(Boolean);
    } catch { }
  }
  if (!sets.length && R.num) sets = R.num.promo
    ? allSets().filter(s => s.id.toLowerCase() === R.num.promo.toLowerCase())
    : allSets().filter(s => s.cardCount?.official === R.num.tot || s.cardCount?.total === R.num.tot);
  if (R.num?.tot && sets.some(s => s.cardCount?.official === R.num.tot || s.cardCount?.total === R.num.tot))
    sets = sets.filter(s => s.cardCount?.official === R.num.tot || s.cardCount?.total === R.num.tot);
  const ranked = LOGIC.rankSets(sets.filter(s => !S.fpSets.includes(s.id)), { tot: R.num?.tot, cardYear: R.year, pickYear: A.year });
  // symbole d'extension imprimé en bas de la carte : départage les candidates
  if (ranked.length > 1 && ranked.length <= 6 && R.hi) {
    const band = shrinkTo(R.hi, 1260, 1760, 630, 880).slice(Math.round(880 * 0.86) * 630 * 4), bh = 880 - Math.round(880 * 0.86);
    for (const r of ranked) r.sym = await symbolOf(r.st, band, 630, bh);
    for (const r of ranked) if (r.sym > 0.55) r.sc += 2 * r.sym;
    ranked.sort((a, b) => b.sc - a.sc);
    DIAG.sym = ranked.map(r => `${r.st.name} ${(r.sym || 0).toFixed(2)}`).join(' · ');
  }
  DIAG.guess = ranked.slice(0, 3).map(r => `${r.st.name} (${r.sc})`).join(' · ');
  renderDiag();
  const after = async st => { // extension téléchargée -> on ré-identifie avec elle
    await scanDownload(st, what);
    if (S.fpSets.includes(st.id)) { A.only = ''; return identify(R, lo, manual); }
  };
  if (ranked.length === 1 || (ranked.length > 1 && ranked[0].sc - ranked[1].sc >= 1)) return after(ranked[0].st);
  if (ranked.length > 1 && ranked.length <= 6) return offerSets(ranked.map(r => r.st), what || 'carte', after);
  if (manual || !A.res?.length) toast(what ? `Lu : ${esc(what)} — extension introuvable, choisis-la dans la liste en haut` : 'Je n\'arrive pas à lire cette carte : rapproche-toi, évite les reflets');
}

// ---------- diagnostic : zones vérifiées + état des modules ----------
// Point (u, v) de la carte (0..1) -> coordonnées vidéo, en interpolant entre les 4 coins
const onQuad = (q, u, v) => ({ x: (1 - v) * ((1 - u) * q[0].x + u * q[1].x) + v * ((1 - u) * q[3].x + u * q[2].x), y: (1 - v) * ((1 - u) * q[0].y + u * q[1].y) + v * ((1 - u) * q[3].y + u * q[2].y) });
function drawDebug(q, cr) {
  if (!A.debug) return;
  const ov = $('#overlay'), cam = $('#cam').getBoundingClientRect(), v = $('#video');
  if (!v.videoWidth) return;
  const ctx = ov.getContext('2d'), s = Math.max(cam.width / v.videoWidth, cam.height / v.videoHeight);
  const ox = (cam.width - v.videoWidth * s) / 2, oy = (cam.height - v.videoHeight * s) / 2;
  const P = p => [(cr.x + p.x) * s + ox, (cr.y + p.y) * s + oy];
  const poly = (pts, color, label, dash = []) => {
    ctx.save(); ctx.setLineDash(dash); ctx.shadowBlur = 0; ctx.lineWidth = 2; ctx.strokeStyle = color;
    ctx.beginPath(); pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...P(p))); ctx.closePath(); ctx.stroke();
    if (label) { ctx.fillStyle = color; ctx.font = 'bold 11px system-ui'; const [x, y] = P(pts[0]); ctx.fillText(label, x + 3, y - 4); }
    ctx.restore();
  };
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  poly(rect(0, 0, cr.w, cr.h), 'rgba(255,255,255,.5)', 'zone analysée', [6, 6]);
  const C = FP.CROP;
  if (q) { // carte détectée : zones lues sur la carte redressée
    const zone = (x0, y0, x1, y1) => [onQuad(q, x0, y0), onQuad(q, x1, y0), onQuad(q, x1, y1), onQuad(q, x0, y1)];
    poly(zone(C.x0, C.y0, C.x1, C.y1), '#4cc9f0', 'empreinte image');
    poly(zone(0, 0.9, 1, 0.99), '#ff4fd8', 'numéro');
    poly(zone(0.05, 0.025, 0.78, 0.095), '#ffa94d', 'nom');
    poly(zone(0, 0.962, 1, 0.998), '#b197fc', 'année ©');
    if (A.mode === 'graded') { const up = (u, t) => ({ x: onQuad(q, u, 0).x + (q[0].x - q[3].x) * t, y: onQuad(q, u, 0).y + (q[0].y - q[3].y) * t }); poly([up(0, .36), up(1, .36), up(1, .04), up(0, .04)], '#ffd166', 'étiquette'); }
  } else { // pas de bords : zone d'empreinte dans le rectangle jaune
    const g = cr.guide, gx = g.x - cr.x, gy = g.y - cr.y;
    poly(rect(gx + g.w * C.x0, gy + g.h * C.y0, gx + g.w * C.x1, gy + g.h * C.y1), '#4cc9f0', 'empreinte image (sans bords)');
  }
}
function renderDiag() {
  const el = $('#diag');
  if (!el || !A.debug) return;
  if (FS.on) { el.innerHTML = fsDiag(); return; }
  const v = $('#video'), L = DIAG.last, withFp = S.fpCards.filter(c => c.fp).length;
  const cvState = CV ? 'prête' : window.cv ? 'chargement…' : 'non chargée';
  el.innerHTML = `<b>Diagnostic du scan</b>
    <span>Caméra : ${v.videoWidth ? v.videoWidth + '×' + v.videoHeight : 'pas d\'image'} · passe : ${DIAG.ms ?? '–'} ms${DIAG.err ? ` · <span class="down">erreur : ${esc(DIAG.err)}</span>` : ''}</span>
    <span>Détection des bords : ${cvState} · lecture du numéro : ${DIAG.ocr}${DIAG.ocrErr ? ' (' + esc(DIAG.ocrErr) + ')' : ''}</span>
    <span>Base : ${S.fpSets.length} extension(s), ${withFp}/${S.fpCards.length} cartes avec empreinte${A.only ? ` · limité à ${esc(setName(A.only))}` : ''}${A.dl ? ` · téléchargement auto de ${esc(setName(A.dl))}` : ''}</span>
    ${L ? `<span>Bords : ${L.edges ? '<span class="up">trouvés</span>' : '<span class="down">non trouvés</span>'} · nom lu : ${DIAG.name ? '<span class="up">' + esc(DIAG.name) + '</span>' : '–'} <span class="muted">(« ${esc(DIAG.nameText || '')} »)</span> · numéro lu : ${L.num ? (L.num.promo ? L.num.promo + ' ' + L.num.num : L.num.num + '/' + L.num.tot + (L.num.code ? ' ' + L.num.code : '')) : '–'} <span class="muted">(« ${esc(DIAG.ocrText || '')} »)</span></span>
    <span>${L.res.slice(0, 3).map((r, i) => `${i + 1}. ${esc(r.card.name)} ${esc(r.card.localId)} <b>${r.d.toFixed(3)}</b>`).join(' · ')}</span>
    ${DIAG.analysis ? `<span>🔍 Analyse (${esc(DIAG.analysis.src || '')}${DIAG.analysis.edges ? ', bords trouvés' : ', rectangle jaune'}) : nom <b>${esc(DIAG.analysis.name || '–')}</b> <span class="muted">(« ${esc((DIAG.analysis.raw || '').trim().slice(0, 30))} »)</span> · numéro <b>${DIAG.analysis.num ? (DIAG.analysis.num.promo ? DIAG.analysis.num.promo + ' ' + DIAG.analysis.num.num : DIAG.analysis.num.num + '/' + DIAG.analysis.num.tot) : '–'}</b> · année <b>${DIAG.analysis.year || '–'}</b> <span class="muted">(bas : « ${esc(DIAG.analysis.bottom || '')} »)</span></span>` : ''}
    <span>Image : netteté ${A.quality ? A.quality.sharp.toFixed(1) : '–'} (mini ${SHARP_MIN}) · lumière ${A.quality ? Math.round(A.quality.bright) : '–'} · reflets ${A.quality ? (A.quality.glare * 100).toFixed(1) + ' %' : '–'}${A.tip ? ' · <b>' + esc(A.tip) + '</b>' : ''}</span>
    <span>Couleur : ${A.type ? `teinte ${A.type.hue}°, saturation ${A.type.sat} → ${Object.entries(A.type.scores).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => k + ' ' + v.toFixed(2)).join(', ')}` : '–'} · votes ${votesFor(A.votes?.at(-1))}/4${DIAG.orb ? ' · détails : ' + esc(DIAG.orb) : ''}${DIAG.sym ? ' · symboles : ' + esc(DIAG.sym) : ''}</span>
    <span>Reflets : ${A.sheen ? '<span class="up">' + (A.sheen === 'reverse' ? 'reverse' : 'holo') + '</span>' : 'rien de net'} (${A.frames.length}/3 images stables)</span>
    <span>Année © lue : ${A.cardYear || '–'} <span class="muted">(« ${esc(DIAG.yearText || '')} »)</span>${A.year ? ' · année choisie : ' + A.year : ''}${DIAG.guess ? ' · extensions probables : ' + esc(DIAG.guess) : ''}</span>
    <span>Décision : ${L.sure ? '<span class="up">sûr</span>' : 'pas sûr'} (sûr si &lt; ${FP.SURE_MAX} et écart &gt; ${FP.SURE_GAP}, ou numéro + image d'accord)</span>` : '<span>Aucune passe pour l\'instant</span>'}
    <span class="muted">${esc(DIAG.storage || '')}</span>`;
}
// Relancer : remet le scan à zéro (et la caméra si besoin)
function retryScan() {
  Object.assign(A, { res: null, lastTop: null, doubtSince: 0, hold: null, paused: false, frames: [], corners: null, grade: null, cardYear: null, lastKey: null, offering: false, sheen: null, analyzed: false, votes: [], conf: null });
  clearProp();
  if (FS.on) { fsPause(false); return status('Scan relancé'); }
  if (DIAG.ocr === 'indisponible') { DIAG.ocr = 'pas encore utilisée'; DIAG.ocrErr = ''; ocrP = null; }
  const v = $('#video');
  if (!v.srcObject || v.srcObject.getVideoTracks().every(t => t.readyState === 'ended')) { stopCam(); startCam(); }
  else { clearTimeout(A.timer); loop(); }
  status('Scan relancé');
}

// ---------- mode lot : compteur en direct ----------
function renderBatch(bump) {
  const el = $('#batchc');
  el.hidden = A.mode !== 'batch';
  if (el.hidden) return;
  el.innerHTML = `<span>📦 <b>${A.batch.n}</b> carte(s) · <b>${eur(A.batch.v)}</b></span><button class="primary small" id="batch-end">Terminer</button>`;
  if (bump) { el.classList.remove('bump2'); void el.offsetWidth; el.classList.add('bump2'); }
  $('#batch-end').onclick = e => {
    e.stopPropagation();
    toast(`Lot terminé : <b>${A.batch.n}</b> carte(s) ajoutée(s), ${eur(A.batch.v)}`);
    A.batch = { n: 0, v: 0 }; renderBatch();
  };
}

// Animation : la carte est aspirée vers l'onglet Collection
function flyToCollection(src, from) {
  const tab = $('#tabs [data-view=coll]');
  if (!src || !tab || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const to = tab.getBoundingClientRect(), im = document.createElement('img');
  im.src = src; im.className = 'fly';
  Object.assign(im.style, { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px' });
  document.body.appendChild(im);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const a = im.animate([
    { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1, filter: 'brightness(1)' },
    { transform: 'translate(0,-14px) scale(1.08) rotate(-6deg)', opacity: 1, filter: 'brightness(1.5)', offset: 0.2 },
    { transform: `translate(${dx * 0.55}px,${dy * 0.45}px) scale(.45) rotate(240deg)`, opacity: .9, offset: 0.65 },
    { transform: `translate(${dx}px,${dy}px) scale(.05) rotate(600deg)`, opacity: .3 },
  ], { duration: 800, easing: 'cubic-bezier(.55,0,.85,.35)' });
  a.onfinish = () => { im.remove(); tab.classList.remove('bump'); void tab.offsetWidth; tab.classList.add('bump'); };
}

// Animation : tout l'écran caméra est aspiré vers l'onglet Collection (carte reconnue et ajoutée)
function flyCamera() {
  const v = $('#video'), tab = $('#tabs [data-view=coll]');
  if (!tab || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!v.videoWidth) { // caméra native : pas d'image à capturer, juste le flash et l'onglet qui saute
    A.flyUntil = Date.now() + 500;
    const cm = $('#cam'); cm.classList.remove('flash'); void cm.offsetWidth; cm.classList.add('flash');
    tab.classList.remove('bump'); void tab.offsetWidth; tab.classList.add('bump');
    return;
  }
  const cam = $('#cam').getBoundingClientRect(), to = tab.getBoundingClientRect();
  // petite capture (480 px de large suffit pour une image qui rétrécit) : rapide à dessiner
  const c = document.createElement('canvas'), k = Math.min(1, 480 / cam.width);
  c.width = Math.round(cam.width * k); c.height = Math.round(cam.height * k);
  const s = Math.max(c.width / v.videoWidth, c.height / v.videoHeight); // même cadrage que la vidéo (cover)
  c.getContext('2d').drawImage(v, (c.width - v.videoWidth * s) / 2, (c.height - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
  c.className = 'flycam';
  Object.assign(c.style, { left: cam.left + 'px', top: cam.top + 'px', width: cam.width + 'px', height: cam.height + 'px' });
  document.body.appendChild(c);
  A.flyUntil = Date.now() + 950; // le scan se met en pause pendant l'animation
  const dx = to.left + to.width / 2 - (cam.left + cam.width / 2), dy = to.top + to.height / 2 - (cam.top + cam.height / 2);
  // seulement transform + opacity : animation gérée par le processeur graphique, fluide même si l'appli travaille
  c.animate([
    { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
    { transform: 'translate(0,0) scale(.92) rotate(-4deg)', opacity: 1, offset: 0.15 },
    { transform: `translate(${dx * 0.5}px,${dy * 0.42}px) scale(.36) rotate(220deg)`, opacity: .95, offset: 0.6 },
    { transform: `translate(${dx}px,${dy}px) scale(.02) rotate(560deg)`, opacity: .15 },
  ], { duration: 900, easing: 'cubic-bezier(.5,0,.85,.35)' }).onfinish = () => {
    c.remove(); tab.classList.remove('bump'); void tab.offsetWidth; tab.classList.add('bump');
  };
  const cm = $('#cam'); cm.classList.remove('vortex', 'flash'); void cm.offsetWidth; cm.classList.add('vortex', 'flash');
}

// ---------- session de scan ----------
function renderSession() {
  const box = $('#session');
  if (!box) return;
  const owned = ownedIds();
  A.session = A.session.filter(x => owned.has(x.c.id));
  const val = A.session.reduce((a, x) => a + (FP.unitPrice(S.prices[x.c.id], x.variant, 'NM', S.coef).trend || 0), 0);
  const b = A.booster;
  box.innerHTML = (b ? `<div class="boosterbar"><span class="grow">📦 Booster <b>${esc(setName(b.setId))}</b> en cours · ${b.cards.length} carte(s)</span><button class="primary small" id="b-end">Terminer</button></div>` : '')
    + (A.session.length ? `<details class="session" ${A.sessionOpen ? 'open' : ''}><summary>Session : <b>${A.session.length}</b> carte(s) · ${eur(val)}</summary>
      ${A.session.map((x, i) => `<div class="line"><img src="${esc(imgOf(x.c))}" alt=""><span class="grow">${esc(x.c.name)} <span class="muted">${esc(x.c.setName)} ${esc(x.c.localId)} · ${VARIANTS[x.variant]} · ${hhmm(x.t)}</span></span><button class="ghost small" data-rm="${i}">✕</button></div>`).join('')}
      <button class="ghost small" id="s-new">Nouvelle session</button></details>` : '');
  box.querySelector('details')?.addEventListener('toggle', e => A.sessionOpen = e.target.open);
  box.querySelectorAll('[data-rm]').forEach(bt => bt.onclick = () => {
    const x = A.session[+bt.dataset.rm], e = S.coll.find(e => e.cardId === x.c.id && e.variant === x.variant) || S.coll.find(e => e.cardId === x.c.id);
    if (e) { e.qty--; S.coll = S.coll.filter(y => y.qty > 0); save(); }
    if (A.booster) { const k = A.booster.cards.lastIndexOf(x.c.id); if (k >= 0) A.booster.cards.splice(k, 1); kv.set('boosters', S.boosters); }
    A.session.splice(+bt.dataset.rm, 1); renderSession();
  });
  $('#s-new') && ($('#s-new').onclick = () => { A.session = []; renderSession(); });
  $('#b-end') && ($('#b-end').onclick = endBooster);
}

// ---------- booster réel ----------
function startBooster(setId, paid) {
  A.booster = { id: Date.now(), t: Date.now(), setId, paid, cards: [] };
  S.boosters.push(A.booster); kv.set('boosters', S.boosters);
  A.session = []; show('scan'); renderSession();
  toast('Scanne les cartes du booster, puis touche Terminer');
}
function endBooster() {
  const b = A.booster; A.booster = null;
  if (!b.cards.length) { S.boosters = S.boosters.filter(x => x !== b); kv.set('boosters', S.boosters); renderSession(); return; }
  kv.set('boosters', S.boosters); renderSession();
  const v = boosterValue(b);
  toast(`Booster terminé : ${b.cards.length} cartes, ${eur(v)}${b.paid ? ` pour ${eur(b.paid)} payés (${v >= b.paid ? 'rentable' : 'perte ' + eur(b.paid - v)})` : ''}`);
}
const boosterValue = b => b.cards.reduce((a, id) => a + (S.prices[id]?.trend || 0), 0);

// sure : une seule carte à confirmer ; sinon les 5 plus probables
function propose(sure, title) {
  A.paused = true;
  fsPause(true);
  if (sure) feedback('found');
  const res = A.res, box = $('#camprop'), list = sure ? res.slice(0, 1) : res;
  status(sure ? 'Carte reconnue' : 'Pas sûr : choisis la bonne carte');
  const g = A.mode === 'graded' ? A.grade || {} : null;
  const sv = A.sheen ? `<p class="small sheen">✨ ${A.sheen === 'reverse' ? 'Reverse' : 'Holo'} détecté${A.autoVar ? ' : sera ajoutée comme ça' : ' (coche « Variante auto » pour l\'utiliser)'}</p>` : '';
  box.innerHTML = sv + (sure ? '' : `<p class="muted">${esc(title || 'Touche la bonne carte pour l\'ajouter :')}</p>`) + list.map((m, i) => `
    <button class="match ${sure ? 'sure' : ''}" data-i="${i}">
      ${imgOf(m.card) ? `<img src="${esc(imgOf(m.card))}" alt="">` : ''}
      <span class="grow"><b>${esc(m.card.name)}</b><br><span class="muted">${esc(m.card.setName)}${setYear(m.card.setId) ? ' (' + setYear(m.card.setId) + ')' : ''} · n° ${esc(m.card.localId)}</span>${sure ? '<br><span class="add">Toucher pour ajouter</span>' : ''}
        ${sure && A.conf ? `<span class="conf"><i style="width:${A.conf.pct}%"></i></span><span class="small muted">Confiance ${A.conf.pct} %${A.conf.parts.length ? ' · ' + A.conf.parts.join(', ') : ''}</span>` : ''}</span>
    </button>`).join('') + `
    ${g ? `<div class="row gradebox"><span>🏷️ Étiquette lue :</span>
      <select id="g-co">${['PSA', 'PCA', 'CGC', 'BGS', 'CCC', 'SGC', 'ACE', 'TAG', '?'].map(x => `<option ${x === (g.co || '?') ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <input id="g-g" type="number" min="1" max="10" step="0.5" value="${g.grade ?? ''}" placeholder="Note" class="num">
      <input id="g-cert" value="${esc(g.cert || '')}" placeholder="N° certificat" class="grow"></div>` : ''}
    <div class="row">
      ${sure ? '<button class="ghost" id="other">Pas celle-là</button>' : '<button class="ghost" id="notfound">Aucune : chercher par nom</button>'}
      <button class="ghost" id="retry">Réessayer</button>
    </div>
    <p class="muted small">${FS.on && FS.ix ? `Scan rapide : base complète (${FS.ix.cards.length.toLocaleString('fr')} cartes)` : `Le scan ne connaît que les extensions activées : ${esc(S.fpSets.map(setName).join(', '))}`}.</p>`;
  if (g) {
    const upd = () => { const n = parseFloat($('#g-g').value); A.grade = { co: $('#g-co').value, grade: isFinite(n) ? n : undefined, cert: $('#g-cert').value.trim() }; };
    ['#g-co', '#g-g', '#g-cert'].forEach(sel => $(sel).onchange = upd);
  }
  box.querySelectorAll('.match').forEach(b => b.onclick = () => choose(list[+b.dataset.i].card, b.querySelector('img') || b));
  $('#retry').onclick = () => resume(res[0].card.id);
  if (sure) $('#other').onclick = () => otherCards(res[0].card);
  else $('#notfound').onclick = () => { resume(res[0].card.id); show('poke'); $('#search-q')?.focus(); };
}


// ---------- page de classeur (9 cartes d'un coup) ----------
async function scanPage() {
  const cv = cvReady(), v = $('#video'), box = $('#matches');
  if (!cv) return toast('Détection pas encore prête, réessaie dans 2 secondes');
  if (!v.videoWidth || !S.fpCards.length) return toast('Active d\'abord le scan d\'une extension (onglet Collection)');
  box.innerHTML = '<p class="muted">Analyse de la page…</p>';
  const cam = $('#cam').getBoundingClientRect();
  const r = FP.guideToVideo(v.videoWidth, v.videoHeight, cam.width, cam.height, { x: 0, y: 0, w: cam.width, h: cam.height });
  r.x = Math.max(0, r.x); r.y = Math.max(0, r.y); r.w = Math.min(v.videoWidth - r.x, r.w); r.h = Math.min(v.videoHeight - r.y, r.h);
  const sw = 640, sh = Math.round(640 * r.h / r.w), small = grab(v, r.x, r.y, r.w, r.h, sw, sh);
  const found = VISION.findCards(cv, small, sw, sh, 0.02);
  if (!found.length) { drawQuads([], r); box.innerHTML = '<p class="muted">Aucune carte trouvée : cadre la page entière, bien à plat, sans reflet.</p>'; return; }
  const bw = Math.min(1800, Math.round(r.w)), bh = Math.round(bw * r.h / r.w), big = grab(v, r.x, r.y, r.w, r.h, bw, bh);
  const k = r.w / sw, kb = bw / r.w;
  drawQuads(found.map(f => f.q.map(p => ({ x: p.x * k, y: p.y * k }))), r);
  const items = [];
  for (const f of found) {
    const qb = f.q.map(p => ({ x: p.x * k * kb, y: p.y * k * kb }));
    const img = VISION.warp(cv, big, bw, bh, qb, 126, 176), flip = rot180(img);
    const qs = FP.nearCrops().flatMap(c => [FP.fingerprint(FP.resample(img, 126, 176, c)), FP.fingerprint(FP.resample(flip, 126, 176, c))]);
    const res = FP.rank(qs, scanCards()).slice(0, 3);
    let dec = { list: res, sure: FP.isSure(res) };
    if (!dec.sure && res[0].d < FP.LOOSE_MAX && DIAG.ocr === 'prête') dec = FP.decide(qs, res, scanCards(), await readNumber(VISION.warp(cv, big, bw, bh, qb, 630, 880), 630, 880), officialOf);
    items.push({ list: dec.list.slice(0, 3), pick: 0, on: dec.list[0].d < FP.LOOSE_MAX, sure: dec.sure });
  }
  renderPageItems(items, '', () => drawQuads([], r));
}

// Résultats de plusieurs cartes d'un coup (page de classeur, cartes à plat) : à vérifier puis ajouter
function renderPageItems(items, head = '', done = () => { }) {
  const box = $('#matches');
  const render = () => {
    box.innerHTML = head + `<p class="muted">${items.length} carte(s) trouvée(s). Touche une image pour changer de proposition, décoche celles à ignorer.</p>`
      + items.map((it, i) => { const c = it.list[it.pick].card; return `<div class="match pageitem ${it.on ? '' : 'off'}">
        ${it.n ? `<span class="pnum">${it.n}</span>` : ''}<button class="pimg" data-i="${i}"><img src="${esc(imgOf(c))}" alt=""></button>
        <span class="grow"><b>${esc(c.name)}</b><br><span class="muted">${esc(c.setName)} · n° ${esc(c.localId)}${it.sure ? ' · ✓' : ''}</span>${it.list.length > 1 ? `<br><span class="small muted">${it.pick + 1}/${it.list.length}</span>` : ''}${it.why ? `<br><span class="small muted">lu : ${esc(it.why)}</span>` : ''}</span>
        <input type="checkbox" data-c="${i}" ${it.on ? 'checked' : ''}></div>`; }).join('')
      + `<button class="primary big" id="page-add">Ajouter ${items.filter(x => x.on).length} carte(s)</button>`;
    box.querySelectorAll('.pimg').forEach(b => b.onclick = () => { const it = items[+b.dataset.i]; it.pick = (it.pick + 1) % it.list.length; render(); });
    box.querySelectorAll('[data-c]').forEach(c => c.onchange = () => { items[+c.dataset.c].on = c.checked; render(); });
    $('#page-add').onclick = () => {
      const sel = items.filter(x => x.on);
      sel.forEach(it => addFromScan(it.list[it.pick].card));
      feedback('add'); box.innerHTML = ''; done();
      toast(`${sel.length} carte(s) ajoutée(s)`);
    };
  };
  render();
}

// ---------- ajout rapide par numéro ----------
async function quickAdd(text) {
  const p = LOGIC.parseQuick(text), box = $('#matches');
  if (!p) return toast('Écris par exemple « 045/198 » ou « Nuit Noire 45 »');
  const sets = allSets().filter(s => (!p.tot || s.cardCount?.official === p.tot || s.cardCount?.total === p.tot) && (!p.q || norm(s.name).includes(p.q) || norm(s.id).includes(p.q)))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '')).slice(0, 10);
  if (!sets.length) return toast('Aucune extension ne correspond');
  box.innerHTML = '<p class="muted">Recherche…</p>';
  const found = [];
  await pool(sets, 4, async st => {
    try { const set = await getSet(st.id); const c = (set.cards || []).find(c => LOGIC.localNum(c) === p.num); if (c) found.push({ ...c, setId: st.id, setName: st.name }); } catch { }
  });
  if (!found.length) { box.innerHTML = '<p class="muted">Carte introuvable (hors ligne ? extension non chargée ?).</p>'; return; }
  box.innerHTML = '<p class="muted">Touche la carte pour l\'ajouter :</p>' + found.map((c, i) => `
    <button class="match" data-i="${i}">${imgOf(c) ? `<img src="${esc(imgOf(c))}" alt="">` : ''}
      <span class="grow"><b>${esc(c.name)}</b><br><span class="muted">${esc(c.setName)} · n° ${esc(c.localId)}</span></span></button>`).join('');
  box.querySelectorAll('.match').forEach(b => b.onclick = () => {
    const c = found[+b.dataset.i]; addFromScan(c); feedback('add'); box.innerHTML = ''; $('#quick-q').value = '';
    toast(`Ajouté : <b>${esc(c.name)}</b> — touche pour modifier`, () => openCard(c));
  });
}

// Ce qui est réglé, visible même réglages repliés
function optSummary() {
  const el = $('#optsum'); if (!el) return;
  el.textContent = [{ ask: '❓ version demandée', normal: 'Normales', reverse: 'Reverse', holo: 'Holo' }[A.variant], A.only ? setName(A.only) : '', A.year || '', A.autoVar ? 'reflets auto' : ''].filter(Boolean).join(' · ');
}
// Raccourci de l'icône / tuile : scan, lot, à plat, collection
function goShortcut(v) {
  if (v === 'coll') return show('coll');
  if (S.view !== 'scan') show('scan');
  const m = { scan: 'one', batch: 'batch', flat: 'flat' }[v];
  if (m && A.mode !== m) $(`[data-mode=${m}]`)?.click();
}
function bindScanUI() {
  $('#btn-scan').onclick = () => { if (A.mode === 'page') return scanPage(); if (A.mode === 'flat') return scanFlat(); if (!A.res) return toast('Vise une carte d\'abord'); propose(false); };
  $('#torch').onclick = toggleTorch;
  const setVar = v => { A.variant = v; $$('[data-var]').forEach(x => x.classList.toggle('on', x.dataset.var === v)); optSummary(); };
  kv.get('scanvar').then(v => setVar(v || 'ask'));
  $$('[data-var]').forEach(b => b.onclick = () => { setVar(b.dataset.var); kv.set('scanvar', A.variant); });
  $$('[data-mode]').forEach(b => b.onclick = () => {
    A.mode = b.dataset.mode; $$('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
    $('#cam').classList.toggle('page', A.mode === 'page' || A.mode === 'flat'); $('#matches').innerHTML = ''; clearProp(); drawQuads([], { x: 0, y: 0 });
    $('#btn-scan').textContent = { page: '📖 Analyser la page', flat: '🃏 Analyser les cartes' }[A.mode] || '✋ Choisir manuellement';
    $('#btn-scan').className = A.mode === 'page' || A.mode === 'flat' ? 'primary big' : 'ghost';
    $('#cam').classList.toggle('graded', A.mode === 'graded'); A.grade = null; A.hold = null;
    if (A.mode === 'batch') A.batch = { n: 0, v: 0 };
    renderBatch();
    if (S.view === 'scan' && FS.ok && fsActive() !== FS.on) { stopCam(); startCam(); }
    else requestAnimationFrame(fsPlace);
    A.paused = false; status({ page: 'Cadre toute la page du classeur, puis Analyser', graded: 'Cadre le boîtier entier, étiquette en haut', flat: 'Pose 2 à 6 cartes à plat, bien éclairées, puis Analyser', batch: 'Pose les cartes une par une : chaque carte reconnue s\'ajoute toute seule' }[A.mode] || '');
  });
  $('#quick-form').onsubmit = e => { e.preventDefault(); quickAdd($('#quick-q').value); };
  $('#retry-scan').onclick = retryScan;
  $('#zoom').oninput = e => FS.on ? nsCall('zoom', { ratio: +e.target.value }).catch(() => { }) : A.track?.applyConstraints({ advanced: [{ zoom: +e.target.value }] }).catch(() => { });
  // mise au point au toucher : sur la zone touchée, puis retour à l'autofocus continu
  $('#cam').addEventListener('click', async e => {
    if (e.target.closest('button,input,select,#camprop,#batchc') || !(A.track || FS.on)) return;
    const r = $('#cam').getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (FS.on) {
      const ring = document.createElement('span'); ring.className = 'focusring'; ring.style.left = e.clientX - r.left + 'px'; ring.style.top = e.clientY - r.top + 'px';
      $('#cam').appendChild(ring); setTimeout(() => ring.remove(), 900);
      return void nsCall('focus', { x, y }).catch(() => { });
    }
    const ring = document.createElement('span'); ring.className = 'focusring'; ring.style.left = e.clientX - r.left + 'px'; ring.style.top = e.clientY - r.top + 'px';
    $('#cam').appendChild(ring); setTimeout(() => ring.remove(), 900);
    try {
      await A.track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x, y }], focusMode: A.caps?.focusMode?.includes('single-shot') ? 'single-shot' : 'continuous', exposureMode: 'continuous' }] });
      clearTimeout(A.focusT); A.focusT = setTimeout(() => A.track?.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => { }), 4000);
    } catch { status('Mise au point au toucher non disponible sur ce téléphone'); }
  });
  $('#analyze').onclick = () => { if (FS.on) return A.res ? (A.conf = null, propose(false)) : toast('Vise une carte d\'abord'); A.paused = false; clearProp(); analyzeCard(true); };
  $('#scan-set').onchange = e => { chooseScanSet(e.target.value); setTimeout(optSummary, 50); };
  $('#scan-year').onchange = e => { A.year = e.target.value; optSummary(); fillScanSets(); retryScan(); status(A.year ? `Recherche limitée à ${A.year}` : ''); };
  kv.get('debug').then(v => { A.debug = !!v; $('#debug').checked = A.debug; $('#diag').hidden = !A.debug; });
  $('#debug').onchange = async e => {
    A.debug = e.target.checked; kv.set('debug', A.debug); $('#diag').hidden = !A.debug;
    const est = await navigator.storage?.estimate?.(), pers = await navigator.storage?.persisted?.();
    if (est) DIAG.storage = `Stockage : ${Math.round(est.usage / 1e6)} Mo utilisés sur ${Math.round(est.quota / 1e6)} Mo · persistant : ${pers ? 'oui' : 'non'}`;
    renderDiag();
  };
  kv.get('autovar').then(v => { A.autoVar = !!v; $('#autovar').checked = A.autoVar; });
  $('#autovar').onchange = e => { A.autoVar = e.target.checked; kv.set('autovar', A.autoVar); optSummary(); };
  $('#scan-lang').onchange = e => switchLang(e.target.value);
  kv.get('autoadd').then(v => { A.auto = !!v; $('#auto').checked = A.auto; });
  $('#auto').onchange = e => { A.auto = e.target.checked; kv.set('autoadd', A.auto); toast(A.auto ? 'Ajout auto : les cartes reconnues avec certitude s\'ajoutent seules' : 'Ajout auto désactivé'); };
}
