'use strict';
// Scan : caméra, détection, reconnaissance, session, boosters réels, page de classeur, ajout rapide.

// ---------- scan automatique ----------
const A = { timer: 0, res: null, qs: null, lastTop: null, doubtSince: 0, hold: null, paused: false, frames: [], corners: null, track: null, torch: false,
  variant: 'normal', mode: 'one', session: [], booster: null, auto: false, grade: null };
let CV = null; // OpenCV, chargé en arrière-plan (13 Mo)
function cvReady() {
  if (!CV && window.cv && !cvReady.p) cvReady.p = Promise.resolve(window.cv).then(m => { CV = m; });
  return CV;
}

async function startCam() {
  const v = $('#video');
  fillScanSets();
  status(S.fpSets.length ? '' : 'Active d\'abord le scan d\'une extension dans Collection');
  if (!v.srcObject) {
    try {
      v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      await v.play();
      A.track = v.srcObject.getVideoTracks()[0];
      $('#torch').hidden = !A.track.getCapabilities?.().torch; A.torch = false; $('#torch').classList.remove('on');
    } catch (err) { return status('Caméra indisponible : ' + err.message); }
  }
  clearTimeout(A.timer); loop();
}
function stopCam() {
  clearTimeout(A.timer);
  const v = $('#video');
  v.srcObject?.getTracks().forEach(t => t.stop()); v.srcObject = null; A.track = null;
}
async function toggleTorch() {
  if (!A.track) return;
  A.torch = !A.torch;
  try { await A.track.applyConstraints({ advanced: [{ torch: A.torch }] }); } catch { A.torch = false; }
  $('#torch').classList.toggle('on', A.torch);
}
function status(t) { $('#cam-msg').textContent = t || `Pose la carte dans le rectangle · ${S.fpSets.length} extension(s) activée(s)`; }

// Retour : vibration + petit son
let audio;
function feedback(kind) {
  navigator.vibrate?.(kind === 'add' ? [30, 50, 30] : 25);
  try {
    audio ||= new AudioContext();
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.frequency.setValueAtTime(kind === 'add' ? 660 : 880, t);
    o.frequency.setValueAtTime(kind === 'add' ? 990 : 1320, t + 0.07);
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.2);
  } catch { }
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
const scanCards = () => A.only ? S.fpCards.filter(c => c.setId === A.only) : S.fpCards;
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
      const qs = FP.nearCrops().flatMap(c => [FP.fingerprint(FP.resample(img, 126, 176, c)), FP.fingerprint(FP.resample(flip, 126, 176, c))]);
      const cards = scanCards(), res = cards.length ? FP.rank(qs, cards).slice(0, 5) : [];
      let num = null;
      DIAG.ocrText = '';
      // lecture du numéro seulement si le moteur est prêt : on ne l'attend jamais (il se charge en fond)
      A.hiCache = null;
      if (DIAG.ocr === 'prête') { if (!res.length || res[0].d < FP.LOOSE_MAX) num = await readNumber(A.hiCache = VISION.warp(cv, big, bw, bh, qb, 630, 880), 630, 880); }
      else ocrWorker();
      if (!res.length) { if (num) autoDetect(num); DIAG.last = { edges: true, res, num, sure: false }; drawDebug(qv, cr); return null; }
      let dec = FP.decide(qs, res, cards, num, officialOf);
      DIAG.nameText = ''; DIAG.name = null;
      // pas sûr : on lit aussi le nom du Pokémon et on cherche avec
      if (!dec.sure && DIAG.ocr === 'prête') {
        const hi = A.hiCache || VISION.warp(cv, big, bw, bh, qb, 630, 880);
        const raw = await readName(hi, 630, 880);
        const byName = decideByName(qs, res, cards, raw, num);
        if (byName) dec = byName; else nameDetect(raw, num);
      }
      if (num && !dec.matched) autoDetect(num);
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

async function loop() {
  if (S.view !== 'scan') return;
  if (!A.paused && $('#sheet').hidden && A.mode !== 'page') {
    let r = null;
    const t0 = performance.now();
    try { r = await pass(); DIAG.err = ''; } catch (err) { console.error(err); DIAG.err = err.message; }
    DIAG.ms = Math.round(performance.now() - t0);
    renderDiag();
    if (r && r.list.length && !A.paused && S.view === 'scan') {
      A.res = r.list;
      const top = r.list[0].card.id;
      $('#guide').classList.toggle('searching', r.plausible);
      if (A.hold) { // attend que la carte précédente sorte du cadre
        if (top !== A.hold || !r.plausible) A.hold = null; else status('Retire la carte pour scanner la suivante');
      } else if (r.sure && top === A.lastTop) { // sûr sur 2 passes de suite
        if (A.auto && A.mode === 'one') choose(r.list[0].card); else propose(true);
      }
      else if (r.plausible) {
        status(r.sure ? 'Presque…' : 'Recherche…');
        A.doubtSince ||= Date.now();
        if (Date.now() - A.doubtSince > 3000) propose(false);
      } else { A.doubtSince = 0; status(); }
      A.lastTop = top;
    }
  }
  if (S.view === 'scan') A.timer = setTimeout(loop, 150);
}

function resume(holdId) {
  A.grade = null;
  A.hold = holdId; A.paused = false; A.doubtSince = 0; A.lastTop = null;
  $('#matches').innerHTML = ''; status();
}

function choose(c, fromEl) {
  const extra = A.mode === 'graded' && A.grade?.grade ? { grade: { co: A.grade.co || '?', g: A.grade.grade, cert: A.grade.cert || '' } } : {};
  addFromScan(c, extra);
  feedback('add');
  flyCamera();
  A.grade = null;
  const cam = $('#cam'); cam.classList.remove('flash'); void cam.offsetWidth; cam.classList.add('flash');
  resume(A.res[0].card.id === c.id ? c.id : A.res[0].card.id);
  toast(`Ajouté : <b>${esc(c.name)}</b> (${esc(c.setName)} ${esc(c.localId)}) — touche pour modifier`, () => openCard(c));
}

// Ajout depuis le scan : variante choisie, session en cours, booster en cours
function addFromScan(c, extra = {}) {
  const e = addCard(c, { variant: A.variant, ...extra });
  A.session.unshift({ c, variant: A.variant, t: Date.now() });
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

// Nom lu mais carte absente des extensions activées : on cherche ce Pokémon dans toute la base,
// et si le numéro désigne une seule extension, on la télécharge (comme pour le numéro seul)
async function nameDetect(raw, num) {
  if (A.dl || A.only || !num) return;
  const dex = await dexNames(), bn = LOGIC.bestName(raw, dex, 0.75);
  if (!bn) return;
  const key = bn.name + '|' + num.num;
  if (A.lastName !== key) { A.lastName = key; return; } // lu deux fois de suite
  let cards = [];
  try { cards = await getJSON('/cards?name=' + encodeURIComponent(bn.name)); } catch { return; }
  A.tried ||= new Set();
  const sets = [...new Set(cards.filter(c => LOGIC.localNum(c) === num.num).map(c => setIdOf(c)))].map(setInfo)
    .filter(st => st && !S.fpSets.includes(st.id) && !A.tried.has(st.id) && (num.promo || !num.tot || LOGIC.total(st) === num.tot || st.cardCount?.total === num.tot))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  if (sets.length && sets.length <= 3) scanDownload(sets[0], `${bn.name} n° ${num.num}`);
}

// ---------- extension détectée par le numéro lu : téléchargement automatique ----------
// "005/084" lu deux fois de suite sans carte connue -> extensions de 84 cartes non téléchargées -> la plus récente
async function autoDetect(num) {
  const key = JSON.stringify(num);
  if (A.lastNum !== key) { A.lastNum = key; return; }
  if (A.dl || A.only) return;
  A.tried ||= new Set();
  let sets = num.promo
    ? allSets().filter(s => s.id.toLowerCase() === num.promo.toLowerCase() || norm(s.name).split(/\W+/).includes(num.promo.toLowerCase()))
    : allSets().filter(s => s.cardCount?.official === num.tot);
  sets = sets.filter(s => !S.fpSets.includes(s.id) && !A.tried.has(s.id)).sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  if (!sets.length || sets.length > 4) return; // trop d'extensions possibles : on ne devine pas
  scanDownload(sets[0]);
}
async function scanDownload(st, why = '') {
  if (A.dl) return;
  A.tried ||= new Set();
  A.tried.add(st.id); A.dl = st.id;
  toast(`Extension détectée${why ? ' (' + esc(why) + ')' : ''} : <b>${esc(st.name)}</b> — téléchargement pour le scan…`);
  try {
    await downloadSet(await getSet(st.id), (d, t) => status(`Téléchargement de ${st.name} : ${d}/${t}`));
    toast(`${esc(st.name)} est prête : rescanne la carte`); fillScanSets();
  } catch (err) { toast('Téléchargement impossible : ' + esc(err.message)); }
  finally { A.dl = null; status(); }
}

// Choix de l'extension en amont : le scan ne cherche que dedans (plus fiable, plus rapide)
function fillScanSets() {
  const sel = $('#scan-set'); if (!sel) return;
  const ready = allSets().filter(s => S.fpSets.includes(s.id)), rest = allSets().filter(s => !S.fpSets.includes(s.id))
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
    if (A.mode === 'graded') { const up = (u, t) => ({ x: onQuad(q, u, 0).x + (q[0].x - q[3].x) * t, y: onQuad(q, u, 0).y + (q[0].y - q[3].y) * t }); poly([up(0, .36), up(1, .36), up(1, .04), up(0, .04)], '#ffd166', 'étiquette'); }
  } else { // pas de bords : zone d'empreinte dans le rectangle jaune
    const g = cr.guide, gx = g.x - cr.x, gy = g.y - cr.y;
    poly(rect(gx + g.w * C.x0, gy + g.h * C.y0, gx + g.w * C.x1, gy + g.h * C.y1), '#4cc9f0', 'empreinte image (sans bords)');
  }
}
function renderDiag() {
  const el = $('#diag');
  if (!el || !A.debug) return;
  const v = $('#video'), L = DIAG.last, withFp = S.fpCards.filter(c => c.fp).length;
  const cvState = CV ? 'prête' : window.cv ? 'chargement…' : 'non chargée';
  el.innerHTML = `<b>Diagnostic du scan</b>
    <span>Caméra : ${v.videoWidth ? v.videoWidth + '×' + v.videoHeight : 'pas d\'image'} · passe : ${DIAG.ms ?? '–'} ms${DIAG.err ? ` · <span class="down">erreur : ${esc(DIAG.err)}</span>` : ''}</span>
    <span>Détection des bords : ${cvState} · lecture du numéro : ${DIAG.ocr}${DIAG.ocrErr ? ' (' + esc(DIAG.ocrErr) + ')' : ''}</span>
    <span>Base : ${S.fpSets.length} extension(s), ${withFp}/${S.fpCards.length} cartes avec empreinte${A.only ? ` · limité à ${esc(setName(A.only))}` : ''}${A.dl ? ` · téléchargement auto de ${esc(setName(A.dl))}` : ''}</span>
    ${L ? `<span>Bords : ${L.edges ? '<span class="up">trouvés</span>' : '<span class="down">non trouvés</span>'} · nom lu : ${DIAG.name ? '<span class="up">' + esc(DIAG.name) + '</span>' : '–'} <span class="muted">(« ${esc(DIAG.nameText || '')} »)</span> · numéro lu : ${L.num ? (L.num.promo ? L.num.promo + ' ' + L.num.num : L.num.num + '/' + L.num.tot + (L.num.code ? ' ' + L.num.code : '')) : '–'} <span class="muted">(« ${esc(DIAG.ocrText || '')} »)</span></span>
    <span>${L.res.slice(0, 3).map((r, i) => `${i + 1}. ${esc(r.card.name)} ${esc(r.card.localId)} <b>${r.d.toFixed(3)}</b>`).join(' · ')}</span>
    <span>Décision : ${L.sure ? '<span class="up">sûr</span>' : 'pas sûr'} (sûr si &lt; ${FP.SURE_MAX} et écart &gt; ${FP.SURE_GAP}, ou numéro + image d'accord)</span>` : '<span>Aucune passe pour l\'instant</span>'}
    <span class="muted">${esc(DIAG.storage || '')}</span>`;
}
// Relancer : remet le scan à zéro (et la caméra si besoin)
function retryScan() {
  Object.assign(A, { res: null, lastTop: null, doubtSince: 0, hold: null, paused: false, frames: [], corners: null, grade: null });
  $('#matches').innerHTML = '';
  if (DIAG.ocr === 'indisponible') { DIAG.ocr = 'pas encore utilisée'; DIAG.ocrErr = ''; ocrP = null; }
  const v = $('#video');
  if (!v.srcObject || v.srcObject.getVideoTracks().every(t => t.readyState === 'ended')) { stopCam(); startCam(); }
  else { clearTimeout(A.timer); loop(); }
  status('Scan relancé');
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
  if (!v.videoWidth || !tab || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cam = $('#cam').getBoundingClientRect(), to = tab.getBoundingClientRect();
  const c = document.createElement('canvas'), k = Math.min(2, devicePixelRatio || 1);
  c.width = Math.round(cam.width * k); c.height = Math.round(cam.height * k);
  const s = Math.max(c.width / v.videoWidth, c.height / v.videoHeight); // même cadrage que la vidéo (cover)
  c.getContext('2d').drawImage(v, (c.width - v.videoWidth * s) / 2, (c.height - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
  c.className = 'flycam';
  Object.assign(c.style, { left: cam.left + 'px', top: cam.top + 'px', width: cam.width + 'px', height: cam.height + 'px' });
  document.body.appendChild(c);
  const dx = to.left + to.width / 2 - (cam.left + cam.width / 2), dy = to.top + to.height / 2 - (cam.top + cam.height / 2);
  c.animate([
    { transform: 'translate(0,0) scale(1) rotate(0deg)', borderRadius: '16px', filter: 'brightness(1)', opacity: 1 },
    { transform: 'translate(0,0) scale(.94) rotate(-3deg)', borderRadius: '24px', filter: 'brightness(1.35)', opacity: 1, offset: 0.18 },
    { transform: `translate(${dx * 0.5}px,${dy * 0.42}px) scale(.38) rotate(200deg)`, borderRadius: '40%', filter: 'brightness(1.6) blur(1px)', opacity: .95, offset: 0.6 },
    { transform: `translate(${dx}px,${dy}px) scale(.02) rotate(560deg)`, borderRadius: '50%', filter: 'brightness(2) blur(3px)', opacity: .2 },
  ], { duration: 950, easing: 'cubic-bezier(.5,0,.85,.35)' }).onfinish = () => {
    c.remove(); tab.classList.remove('bump'); void tab.offsetWidth; tab.classList.add('bump');
  };
  const cm = $('#cam'); cm.classList.remove('vortex'); void cm.offsetWidth; cm.classList.add('vortex');
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
      ${A.session.map((x, i) => `<div class="line"><img src="${esc(imgOf(x.c))}" alt=""><span class="grow">${esc(x.c.name)} <span class="muted">${esc(x.c.setName)} ${esc(x.c.localId)} · ${VARIANTS[x.variant]}</span></span><button class="ghost small" data-rm="${i}">✕</button></div>`).join('')}
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
function propose(sure) {
  A.paused = true;
  if (sure) feedback('found');
  const res = A.res, box = $('#matches'), list = sure ? res.slice(0, 1) : res;
  status(sure ? 'Carte reconnue' : 'Pas sûr : choisis la bonne carte');
  const g = A.mode === 'graded' ? A.grade || {} : null;
  box.innerHTML = (sure ? '' : '<p class="muted">Touche la bonne carte pour l\'ajouter :</p>') + list.map((m, i) => `
    <button class="match ${sure ? 'sure' : ''}" data-i="${i}">
      ${imgOf(m.card) ? `<img src="${esc(imgOf(m.card))}" alt="">` : ''}
      <span class="grow"><b>${esc(m.card.name)}</b><br><span class="muted">${esc(m.card.setName)} · n° ${esc(m.card.localId)}</span>${sure ? '<br><span class="add">Toucher pour ajouter</span>' : ''}</span>
    </button>`).join('') + `
    ${g ? `<div class="row gradebox"><span>🏷️ Étiquette lue :</span>
      <select id="g-co">${['PSA', 'PCA', 'CGC', 'BGS', 'CCC', 'SGC', 'ACE', 'TAG', '?'].map(x => `<option ${x === (g.co || '?') ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <input id="g-g" type="number" min="1" max="10" step="0.5" value="${g.grade ?? ''}" placeholder="Note" class="num">
      <input id="g-cert" value="${esc(g.cert || '')}" placeholder="N° certificat" class="grow"></div>` : ''}
    <div class="row">
      ${sure ? '<button class="ghost" id="other">Pas celle-là</button>' : '<button class="ghost" id="notfound">Aucune : chercher par nom</button>'}
      <button class="ghost" id="retry">Réessayer</button>
    </div>
    <p class="muted small">Le scan ne connaît que les extensions activées : ${esc(S.fpSets.map(setName).join(', '))}.</p>`;
  if (g) {
    const upd = () => { const n = parseFloat($('#g-g').value); A.grade = { co: $('#g-co').value, grade: isFinite(n) ? n : undefined, cert: $('#g-cert').value.trim() }; };
    ['#g-co', '#g-g', '#g-cert'].forEach(sel => $(sel).onchange = upd);
  }
  box.querySelectorAll('.match').forEach(b => b.onclick = () => choose(list[+b.dataset.i].card, b.querySelector('img') || b));
  $('#retry').onclick = () => resume(res[0].card.id);
  if (sure) $('#other').onclick = () => propose(false);
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
  const render = () => {
    box.innerHTML = `<p class="muted">${items.length} carte(s) trouvée(s). Touche une image pour changer de proposition, décoche celles à ignorer.</p>`
      + items.map((it, i) => { const c = it.list[it.pick].card; return `<div class="match pageitem ${it.on ? '' : 'off'}">
        <button class="pimg" data-i="${i}"><img src="${esc(imgOf(c))}" alt=""></button>
        <span class="grow"><b>${esc(c.name)}</b><br><span class="muted">${esc(c.setName)} · n° ${esc(c.localId)}${it.sure ? ' · ✓' : ''}</span>${it.list.length > 1 ? `<br><span class="small muted">${it.pick + 1}/${it.list.length}</span>` : ''}</span>
        <input type="checkbox" data-c="${i}" ${it.on ? 'checked' : ''}></div>`; }).join('')
      + `<button class="primary big" id="page-add">Ajouter ${items.filter(x => x.on).length} carte(s)</button>`;
    box.querySelectorAll('.pimg').forEach(b => b.onclick = () => { const it = items[+b.dataset.i]; it.pick = (it.pick + 1) % it.list.length; render(); });
    box.querySelectorAll('[data-c]').forEach(c => c.onchange = () => { items[+c.dataset.c].on = c.checked; render(); });
    $('#page-add').onclick = () => {
      const sel = items.filter(x => x.on);
      sel.forEach(it => addFromScan(it.list[it.pick].card));
      feedback('add'); box.innerHTML = ''; drawQuads([], r);
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

function bindScanUI() {
  $('#btn-scan').onclick = () => { if (A.mode === 'page') return scanPage(); if (!A.res) return toast('Vise une carte d\'abord'); propose(false); };
  $('#torch').onclick = toggleTorch;
  $$('[data-var]').forEach(b => b.onclick = () => { A.variant = b.dataset.var; $$('[data-var]').forEach(x => x.classList.toggle('on', x === b)); });
  $$('[data-mode]').forEach(b => b.onclick = () => {
    A.mode = b.dataset.mode; $$('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
    $('#cam').classList.toggle('page', A.mode === 'page'); $('#matches').innerHTML = ''; drawQuads([], { x: 0, y: 0 });
    $('#btn-scan').textContent = A.mode === 'page' ? 'Analyser la page' : 'Choisir manuellement';
    $('#btn-scan').className = A.mode === 'page' ? 'primary big' : 'ghost big';
    $('#cam').classList.toggle('graded', A.mode === 'graded'); A.grade = null; A.hold = null;
    A.paused = false; status({ page: 'Cadre toute la page du classeur, puis Analyser', graded: 'Cadre le boîtier entier, étiquette en haut' }[A.mode] || '');
  });
  $('#quick-form').onsubmit = e => { e.preventDefault(); quickAdd($('#quick-q').value); };
  $('#retry-scan').onclick = retryScan;
  $('#scan-set').onchange = e => chooseScanSet(e.target.value);
  kv.get('debug').then(v => { A.debug = !!v; $('#debug').checked = A.debug; $('#diag').hidden = !A.debug; });
  $('#debug').onchange = async e => {
    A.debug = e.target.checked; kv.set('debug', A.debug); $('#diag').hidden = !A.debug;
    const est = await navigator.storage?.estimate?.(), pers = await navigator.storage?.persisted?.();
    if (est) DIAG.storage = `Stockage : ${Math.round(est.usage / 1e6)} Mo utilisés sur ${Math.round(est.quota / 1e6)} Mo · persistant : ${pers ? 'oui' : 'non'}`;
    renderDiag();
  };
  kv.get('autoadd').then(v => { A.auto = !!v; $('#auto').checked = A.auto; });
  $('#auto').onchange = e => { A.auto = e.target.checked; kv.set('autoadd', A.auto); toast(A.auto ? 'Ajout auto : les cartes reconnues avec certitude s\'ajoutent seules' : 'Ajout auto désactivé'); };
}
