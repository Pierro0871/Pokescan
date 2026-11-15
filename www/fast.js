'use strict';
// Scan rapide : moteur natif Android (caméra native, lecture de texte ML Kit, empreinte d'image TensorFlow Lite)
// + base complète de toutes les cartes FR/EN. Décision « texte d'abord » : numéro, nom, année ; l'image départage.
// Repli automatique sur le moteur web (scan.js) si le moteur natif est absent ou en erreur.

const FS = { ok: false, on: false, ix: null, mini: null, engine: 'auto', v: null, update: null, dl: null, listening: false };
const INDEX_URL = `https://github.com/${'Pierro0871/Pokescan'}/releases/download/index/`;
const INDEX_FILES = ['meta.json.gz', 'emb.bin', 'model.tflite'];
const nsCall = (m, o = {}) => Capacitor.nativePromise('NativeScan', m, o);
const fsActive = () => FS.ok && FS.engine !== 'web' && (A.mode === 'one' || A.mode === 'batch' || A.mode === 'flat');

async function fsInit() {
  if (!NATIVE) return;
  try { FS.info = await nsCall('info'); FS.ok = true; } catch { return; } // ancienne APK sans moteur natif
  FS.engine = (await kv.get('engine')) || 'auto';
  FS.v = await kv.get('indexV');
  // base chargée en fond : en attendant, le texte est cherché dans les extensions téléchargées
  const ready = FS.info.meta && FS.info.model && FS.info.emb ? fsLoad().catch(err => { DIAG.err = 'base illisible : ' + err.message; }) : Promise.resolve();
  ready.then(() => { fsBar(); if (FS.on && !A.paused) status(); fsCheckUpdate(); });
}

// nom anglais -> français par le Pokédex (extensions anciennes sans données françaises)
async function fsTranslator() {
  try {
    const [en, fr] = await Promise.all([dexNames('en'), dexNames('fr')]);
    const m = new Map(en.map((n, i) => [LOGIC.norm(n), fr[i]]));
    return name => {
      if (!name) return '';
      let hit = false;
      const out = name.split(' ').map(w => { const t = m.get(LOGIC.norm(w)); if (t) hit = true; return t || w; }).join(' ');
      return hit ? out : '';
    };
  } catch { return () => ''; }
}

async function fsLoad() {
  const t0 = performance.now();
  const { json } = await nsCall('readMeta');
  const meta = JSON.parse(json);
  FS.ix = LOGIC.buildIndex(meta, await fsTranslator());
  await nsCall('loadIndex', { dim: meta.dim, size: meta.size });
  FS.v = meta.v; kv.set('indexV', meta.v);
  FS.loadMs = Math.round(performance.now() - t0);
}

// Nouvelle base publiée (chaque mois) ?
async function fsCheckUpdate() {
  try {
    let rel = await nativeGet(`https://api.github.com/repos/Pierro0871/Pokescan/releases/tags/index`, 'json');
    if (typeof rel === 'string') rel = JSON.parse(rel);
    const a = rel.assets?.find(x => x.name === 'meta.json.gz');
    if (!a) return;
    FS.remote = { at: a.updated_at, size: rel.assets.filter(x => INDEX_FILES.includes(x.name)).reduce((s, x) => s + x.size, 0) };
    const mine = await kv.get('indexAt');
    FS.update = !FS.ix || (mine && mine < a.updated_at);
    fsBar();
  } catch { }
}

async function fsDownload() {
  if (FS.dl) return;
  FS.dl = { done: 0, total: FS.remote?.size || 16e6 };
  fsBar();
  const base = {};
  const cb = Capacitor.nativeCallback('NativeScan', 'addListener', { eventName: 'dl' }, d => {
    if (!d || !FS.dl) return;
    base[d.name] = d.done; FS.dl.done = Object.values(base).reduce((a, b) => a + b, 0); fsBar();
  });
  try {
    for (const f of INDEX_FILES) { const r = await nsCall('download', { url: INDEX_URL + f, name: f }); base[f] = r.size; }
    await fsLoad();
    if (FS.remote) kv.set('indexAt', FS.remote.at);
    FS.update = false;
    toast(`⚡ Scan rapide prêt : ${FS.ix.cards.length.toLocaleString('fr')} cartes reconnues`);
    if (S.view === 'scan') { stopCam(); startCam(); }
  } catch (err) { toast('Téléchargement de la base impossible : ' + esc(err.message)); }
  finally {
    FS.dl = null; fsBar();
    try { Capacitor.nativePromise('NativeScan', 'removeListener', { eventName: 'dl', callbackId: cb }); } catch { }
  }
}

// Bandeau du scan : base à télécharger / mise à jour / progression
function fsBar() {
  const el = $('#fastbar');
  if (!el) return;
  if (!FS.ok || FS.engine === 'web') { el.hidden = true; return; }
  const mo = n => Math.round(n / 1e6) + ' Mo';
  if (FS.dl) el.innerHTML = `<span class="grow">⚡ Téléchargement de la base… ${mo(FS.dl.done)} / ${mo(FS.dl.total)}</span><span class="conf"><i style="width:${Math.min(100, FS.dl.done / FS.dl.total * 100)}%"></i></span>`;
  else if (!FS.ix) el.innerHTML = `<span class="grow">⚡ <b>Scan rapide</b> : télécharge la base de toutes les cartes (${FS.remote ? mo(FS.remote.size) : '≈ 16 Mo'}, une seule fois)</span><button class="primary small" id="fs-dl">Télécharger</button>`;
  else if (FS.update) el.innerHTML = `<span class="grow">⚡ Nouvelle base de cartes disponible</span><button class="ghost small" id="fs-dl">Mettre à jour</button>`;
  else { el.hidden = true; return; }
  el.hidden = false;
  const b = $('#fs-dl'); if (b) b.onclick = fsDownload;
}

// Mini-base : sans la base complète, le texte est cherché dans les extensions téléchargées
function fsMini() {
  if (!S.fpCards.length) return null;
  const key = S.fpCards.length + ':' + S.fpSets.join();
  if (FS.mini?.key === key) return FS.mini;
  const ids = [...new Set(S.fpCards.map(c => c.setId))], pos = new Map(ids.map((id, i) => [id, i]));
  const sets = ids.map(id => { const st = setInfo?.(id) || {}; const c = S.fpCards.find(x => x.setId === id); return [id, setName(id), setName(id), st.releaseDate || '', c.official || st.cardCount?.official || 0, st.cardCount?.total || 0, c.abbr || '', '']; });
  FS.mini = LOGIC.buildIndex({ v: 'mini', sets, cards: S.fpCards.map(c => [c.id, c.localId, pos.get(c.setId), c.name, '', c.image || '', 0]) });
  FS.mini.key = key;
  return FS.mini;
}

function fsCard(ix, i) {
  const c = ix.cards[i], st = ix.sets[c.set];
  const known = !!setInfo(st.id);
  return { id: c.id, localId: c.localId, name: S.lang === 'en' ? c.nameEn : c.name, image: c.image || undefined, setId: st.id,
    setName: known ? setName(st.id) : (S.lang === 'en' ? st.nameEn : st.name), official: st.official, abbr: st.abbr };
}

// ---------- caméra native ----------
function fsRect() {
  const r = $('#cam').getBoundingClientRect(), g = $('#guide').getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, r: 16,
    guide: { x: (g.left - r.left) / r.width, y: (g.top - r.top) / r.height, w: g.width / r.width, h: g.height / r.height } };
}
function cssHex(c) { const m = String(c).match(/\d+/g); return m && m.length >= 3 ? '#' + m.slice(0, 3).map(x => (+x).toString(16).padStart(2, '0')).join('') : '#101418'; }
let fsRaf = 0;
const fsPlace = () => { if (!FS.on || fsRaf) return; fsRaf = requestAnimationFrame(() => { fsRaf = 0; nsCall('setRect', fsRect()).catch(() => { }); }); };

async function fsStart() {
  const bg = cssHex(getComputedStyle(document.body).backgroundColor);
  document.documentElement.classList.add('native-cam');
  if (!FS.listening) {
    FS.listening = true;
    Capacitor.nativeCallback('NativeScan', 'addListener', { eventName: 'frame' }, d => { try { fsFrame(d); } catch (err) { DIAG.err = err.message; } });
    addEventListener('scroll', fsPlace, { passive: true }); addEventListener('resize', fsPlace);
  }
  try {
    const r = await nsCall('start', { ...fsRect(), bg });
    FS.on = true;
    $('#torch').hidden = !r.torch; A.torch = false; $('#torch').classList.remove('on');
    const z = $('#zoom'); z.hidden = !(r.maxZoom > r.minZoom);
    if (!z.hidden) { z.min = r.minZoom; z.max = Math.min(r.maxZoom, 8); z.step = 0.1; z.value = r.minZoom; }
    A.votes = []; A.paused = false;
    status();
  } catch (err) { document.documentElement.classList.remove('native-cam'); throw err; }
}
function fsStop() {
  if (!FS.on) return;
  FS.on = false;
  nsCall('stop').catch(() => { });
  document.documentElement.classList.remove('native-cam');
}
const fsPause = on => { if (FS.on) nsCall('pause', { on }).catch(() => { }); };

const fsPct = d => Math.round(Math.min(0.99, 0.5 + (d.by.includes('numéro') ? 0.25 : 0) + (d.by.includes('nom') ? 0.15 : 0) + (d.by.includes('image') && d.list[0].s > 0.6 ? 0.08 : 0) + (d.by.includes('année') ? 0.04 : 0)) * 100);

function fsFrame(ev) {
  if (!FS.on || S.view !== 'scan' || !ev) return;
  FS.last = ev;
  if (ev.error) { DIAG.err = ev.error; return renderDiag(); }
  if (A.paused || A.mode === 'flat' || A.flyUntil > Date.now() || !$('#sheet').hidden) return;
  const r = VISION.readLines(ev.lines);
  FS.read = r;
  const ix = FS.ix || fsMini();
  if (!ix) { renderDiag(); return status('Télécharge la base du scan rapide (bandeau ci-dessus)'); }
  const only = A.only ? ix.sets.findIndex(s => s.id === A.only) : -1;
  let d = LOGIC.decideText(r, ix, FS.ix && ev.ids ? ev : {}, { only: only >= 0 ? only : undefined });
  if (A.year && d.list.length) { const k = d.list.filter(x => String(ix.sets[ix.cards[x.i].set].year) === String(A.year)); if (k.length) d = { ...d, list: k, sure: d.sure || k.length === 1 }; }
  FS.dec = d;
  renderDiag();
  const tip = ev.sharp < 12 ? 'Image floue : recule un peu ou allume la lampe 🔦' : '';
  if (!d.list.length) {
    A.votes = []; A.hold = null; A.doubtSince = 0;
    $('#guide').classList.remove('searching');
    return status(tip || undefined);
  }
  A.res = d.list.map(x => ({ card: fsCard(ix, x.i), d: Math.max(0, 1 - x.s) }));
  const top = A.res[0].card.id;
  A.votes = [...(A.votes || []).slice(-3), top];
  $('#guide').classList.add('searching');
  if (A.hold) { if (top !== A.hold) A.hold = null; else return status('Retire la carte pour scanner la suivante'); }
  const byText = d.by.includes('numéro') || d.by.includes('nom');
  if (d.sure && votesFor(top) >= (byText ? 2 : 3)) {
    A.conf = { pct: fsPct(d), parts: d.by };
    A.doubtSince = 0;
    if ((A.auto && A.mode === 'one') || A.mode === 'batch') choose(A.res[0].card); else propose(true);
    return;
  }
  A.doubtSince ||= Date.now();
  status(tip || (d.sure ? 'Presque…' : 'Recherche…'));
  // texte lu mais plusieurs cartes possibles depuis 2,5 s : on montre les meilleures
  if (!d.sure && byText && d.list.length > 1 && Date.now() - A.doubtSince > 2500) { A.conf = null; propose(false); }
}

function fsDiag() {
  const ev = FS.last || {}, r = FS.read, d = FS.dec, ix = FS.ix || FS.mini;
  const n = r?.num ? (r.num.promo ? r.num.promo + ' ' + r.num.num : r.num.num + '/' + r.num.tot + (r.num.code ? ' ' + r.num.code : '')) : '–';
  return `<b>Diagnostic du scan rapide (natif)</b>
    <span>Analyse : ${ev.ms ?? '–'} ms (texte ${ev.ocrMs ?? '–'} ms${ev.embMs != null ? `, image ${ev.embMs} ms` : ''}) · netteté ${ev.sharp ?? '–'}${DIAG.err ? ` · <span class="down">erreur : ${esc(DIAG.err)}</span>` : ''}</span>
    <span>Base : ${FS.ix ? `complète du ${esc(FS.v || '?')}, ${FS.ix.cards.length} cartes (chargée en ${FS.loadMs} ms)` : ix ? `extensions téléchargées seulement (${ix.cards.length} cartes)` : 'aucune'}${A.only ? ` · limité à ${esc(setName(A.only))}` : ''}</span>
    <span>Lu : nom <b>${esc(r?.names?.[0] || '–')}</b> · numéro <b>${n}</b> · année <b>${r?.year || '–'}</b> <span class="muted">(bas : « ${esc((r?.bottom || '').replace(/\n/g, ' ').slice(0, 60))} »)</span></span>
    <span>Texte brut : <span class="muted">${esc((ev.lines || []).map(l => l.t).join(' | ').slice(0, 160))}</span></span>
    <span>Décision : ${d ? `${d.sure ? '<span class="up">sûr</span>' : 'pas sûr'} par ${esc(d.by.join(' + ') || '–')} · ${d.list.slice(0, 3).map(x => `${esc(ix.cards[x.i].name)} ${esc(ix.cards[x.i].localId)} (${esc(ix.sets[ix.cards[x.i].set].id)}) <b>${x.s.toFixed(2)}</b>`).join(' · ')}` : '–'} · votes ${votesFor(A.votes?.at(-1))}/4</span>
    ${ev.ids ? `<span>Image seule : ${ev.ids.slice(0, 3).map((i, k) => `${esc(FS.ix?.cards[i]?.name || i)} ${ev.sc[k]}`).join(' · ')}</span>` : ''}`;
}

// ---------- cartes à plat : une photo, toutes les cartes posées sur la table ----------
async function scanFlat() {
  if (!FS.on) return scanPage(); // moteur classique : même analyse que la page de classeur
  const cv = cvReady(), box = $('#matches');
  if (!cv) return toast('Détection des cartes pas encore prête, réessaie dans 2 secondes');
  const ix = FS.ix || fsMini();
  if (!ix) return toast('Télécharge d\'abord la base du scan rapide');
  box.innerHTML = '<p class="muted">📸 Photo et lecture des cartes…</p>';
  feedback('found');
  let snap;
  try { snap = await nsCall('snapshot'); } catch (err) { box.innerHTML = ''; return toast('Photo impossible : ' + esc(err.message)); }
  const src = 'data:image/jpeg;base64,' + snap.jpeg, im = await getImage(src);
  const sw = 640, sh = Math.round(640 * snap.h / snap.w), px = grab(im, 0, 0, im.width, im.height, sw, sh);
  const found = VISION.findCards(cv, px, sw, sh, 0.015);
  const shot = quads => `<div class="flatshot"><img src="${src}" alt=""><svg viewBox="0 0 1 1" preserveAspectRatio="none">${quads.map(q => `<polygon points="${q.map(p => `${p.x},${p.y}`).join(' ')}"/>`).join('')}</svg>${quads.map((q, i) => `<b style="left:${(q.reduce((a, p) => a + p.x, 0) / 4 * 100).toFixed(1)}%;top:${(q.reduce((a, p) => a + p.y, 0) / 4 * 100).toFixed(1)}%">${i + 1}</b>`).join('')}</div>`;
  if (!found.length) { box.innerHTML = shot([]) + '<p class="muted">Aucune carte trouvée : pose les cartes sur un fond uni et sombre, sans qu\'elles se touchent, et recule un peu.</p>'; return; }
  const quads = found.map(f => VISION.orderCorners(f.q).map(p => ({ x: p.x / sw, y: p.y / sh })));
  // coordonnées des lignes : relatives à la photo, comme les coins des cartes
  const items = [];
  let missed = 0;
  quads.forEach((q, n) => {
    const { read } = VISION.linesInCard(snap.lines, q);
    const d = LOGIC.decideText(read, ix, {});
    if (!d.list.length) { missed++; return; }
    const num = read.num ? (read.num.promo ? read.num.promo + ' ' + read.num.num : read.num.num + '/' + read.num.tot) : '';
    items.push({ n: n + 1, list: d.list.map(x => ({ card: fsCard(ix, x.i), d: 1 - x.s })), pick: 0, on: true, sure: d.sure, why: [read.names[0], num].filter(Boolean).join(' · ') });
  });
  const head = shot(quads) + (missed ? `<p class="small muted">${missed} carte(s) illisible(s) : rapproche-toi ou ajoute-les avec le scan 1 carte.</p>` : '');
  if (!items.length) { box.innerHTML = head; return; }
  renderPageItems(items, head);
}
