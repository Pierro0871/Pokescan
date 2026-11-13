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
let ocrP = null;
function ocrWorker() {
  if (!window.Tesseract) return null;
  const u = f => new URL('vendor/' + f, location.href).href;
  return ocrP ||= Tesseract.createWorker('eng', 1, {
    workerPath: u('worker.min.js'), corePath: u('tesseract-core-simd-lstm.wasm.js'), langPath: u(''), gzip: false, workerBlobURL: false, cacheMethod: 'none'
  }).catch(() => (ocrP = null));
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
  return run;
}
// Morceau de l'image redressée (lignes y0..y0+bh) -> canvas agrandi ×2, gris contrasté
function strip(px, w, y0, bh) {
  const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = bh;
  tmp.getContext('2d').putImageData(new ImageData(px.slice(y0 * w * 4, (y0 + bh) * w * 4), w, bh), 0, 0);
  const c = document.createElement('canvas'); c.width = w * 2; c.height = bh * 2;
  const ctx = c.getContext('2d'); ctx.filter = 'grayscale(1) contrast(1.6)'; ctx.drawImage(tmp, 0, 0, c.width, c.height);
  return c;
}
async function readNumber(hi, w, h) {
  if (!window.Tesseract) return null;
  // bande du bas de la carte (numéro à gauche sur les cartes récentes, à droite sur les anciennes)
  try { return VISION.parseNumber(await ocr(strip(hi, w, Math.round(h * 0.9), Math.round(h * 0.09)), { tessedit_char_whitelist: '0123456789/', tessedit_pageseg_mode: '11' })); } catch { return null; }
}
async function readLabel(px, w, h) {
  if (!window.Tesseract) return {};
  try { return VISION.parseGrade(await ocr(strip(px, w, 0, h), { tessedit_char_whitelist: '', tessedit_pageseg_mode: '6' })); } catch { return {}; }
}
const officialOf = id => S.catalog?.flatMap(s => s.sets).find(s => s.id === id)?.cardCount?.official ?? S.fpCards.find(c => c.setId === id)?.official;

// Boîtier gradé : la carte est la forme (parmi celles trouvées) qui ressemble le plus à une carte connue ;
// l'étiquette est la bande au-dessus de la carte.
async function passGraded(cv, v, cr) {
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
    const res = FP.rank(qs, S.fpCards).slice(0, 5);
    if (!best || res[0].d < best.res[0].d) best = { res, qs, qb, f };
  }
  drawQuads([best.f.q.map(p => ({ x: p.x * k, y: p.y * k }))], cr);
  const [tl, tr, br, bl] = best.qb, up = { x: tl.x - bl.x, y: tl.y - bl.y };
  const at = (p, t) => ({ x: p.x + up.x * t, y: p.y + up.y * t });
  const label = VISION.warp(cv, big, bw, bh, [at(tl, 0.36), at(tr, 0.36), at(tr, 0.04), at(tl, 0.04)], 600, 220);
  const g = await readLabel(label, 600, 220);
  A.grade = { ...(A.grade || {}), ...g }; // on garde ce qui a déjà été lu sur les passes précédentes
  const dec = FP.decide(best.qs, best.res, S.fpCards, null, officialOf);
  return { ...dec, plausible: best.res[0].d < FP.LOOSE_MAX };
}

// Une passe de scan. Renvoie { list, sure } ou null.
async function pass() {
  const v = $('#video');
  if (!v.videoWidth || !S.fpCards.length) return null;
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
      const res = FP.rank(qs, S.fpCards).slice(0, 5);
      let ocr = null;
      if (res[0].d < FP.LOOSE_MAX) ocr = await readNumber(VISION.warp(cv, big, bw, bh, qb, 630, 880), 630, 880);
      return { ...FP.decide(qs, res, S.fpCards, ocr, officialOf), plausible: true };
    }
  }
  // sans bords détectés : recherche sur plusieurs cadrages dans le rectangle
  drawCorners(null, cr); A.frames = []; A.corners = null;
  const M = FP.MARGIN, g = cr.guide, AW = Math.round(FP.W * 2 * (1 + 2 * M)), AH = Math.round(FP.H * 2 * (1 + 2 * M));
  const px = grab(v, g.x - g.w * M, g.y - g.h * M, g.w * (1 + 2 * M), g.h * (1 + 2 * M), AW, AH);
  const res = FP.search(c => FP.fingerprint(FP.resample(px, AW, AH, c)), S.fpCards, 5);
  return { list: res, sure: FP.isSure(res), plausible: res[0].d < FP.LOOSE_MAX };
}

async function loop() {
  if (S.view !== 'scan') return;
  if (!A.paused && $('#sheet').hidden && A.mode !== 'page') {
    let r = null;
    try { r = await pass(); } catch (err) { console.error(err); }
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
  flyToCollection(imgOf(c), (fromEl || $('#guide')).getBoundingClientRect());
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
    const res = FP.rank(qs, S.fpCards).slice(0, 3);
    let dec = { list: res, sure: FP.isSure(res) };
    if (!dec.sure && res[0].d < FP.LOOSE_MAX) dec = FP.decide(qs, res, S.fpCards, await readNumber(VISION.warp(cv, big, bw, bh, qb, 630, 880), 630, 880), officialOf);
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
  kv.get('autoadd').then(v => { A.auto = !!v; $('#auto').checked = A.auto; });
  $('#auto').onchange = e => { A.auto = e.target.checked; kv.set('autoadd', A.auto); toast(A.auto ? 'Ajout auto : les cartes reconnues avec certitude s\'ajoutent seules' : 'Ajout auto désactivé'); };
}
