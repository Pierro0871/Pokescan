'use strict';
const API = 'https://api.tcgdex.net/v2/fr';
const NATIVE = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const eur = n => n == null ? '–' : n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const VARIANTS = { normal: 'Normale', reverse: 'Reverse', holo: 'Holo' };

// ---------- stockage (IndexedDB, clé/valeur) ----------
const kv = (() => {
  let dbp;
  const db = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('pokescan', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('kv', mode), q = fn(t.objectStore('kv'));
      t.oncomplete = () => res(q.result); t.onerror = () => rej(t.error);
    });
  };
  return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)) };
})();

// ---------- réseau ----------
async function nativeGet(url, responseType) {
  const r = await Capacitor.nativePromise('CapacitorHttp', 'request', { url, method: 'GET', responseType });
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  return r.data;
}
async function getJSON(path) {
  const url = API + path;
  if (NATIVE) { const d = await nativeGet(url, 'json'); return typeof d === 'string' ? JSON.parse(d) : d; }
  const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
}
// Image lisible pixel par pixel (pas de canvas "tainted" : on passe par une data URL / blob)
async function getImage(url) {
  const src = NATIVE ? 'data:image/webp;base64,' + (await nativeGet(url, 'blob')).replace(/\s/g, '')
    : URL.createObjectURL(await (await fetch(url)).blob());
  const img = new Image(); img.src = src; await img.decode(); return img;
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// ---------- état ----------
const S = { coll: [], prices: {}, coef: { ...FP.DEFAULT_COEF }, catalog: null, fpSets: [], fpCards: [], view: 'scan' };
const save = () => kv.set('coll', S.coll);
const ownedIds = () => new Set(S.coll.map(e => e.cardId));
const setName = id => S.catalog?.flatMap(s => s.sets).find(s => s.id === id)?.name || id;
const setIdOf = c => c.set?.id || c.setId || c.id.slice(0, c.id.length - String(c.localId).length - 1);

async function init() {
  navigator.storage?.persist?.();
  S.coll = (await kv.get('coll')) || [];
  S.prices = (await kv.get('prices')) || {};
  S.coef = { ...FP.DEFAULT_COEF, ...((await kv.get('coef')) || {}) };
  S.catalog = await kv.get('catalog');
  S.fpSets = (await kv.get('fpsets')) || [];
  for (const id of S.fpSets) S.fpCards.push(...((await kv.get('fp:' + id)) || []));
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => show(b.dataset.view));
  $('#btn-scan').onclick = scan;
  $('#search-form').onsubmit = e => { e.preventDefault(); search($('#search-q').value.trim()); };
  $('#sheet').onclick = e => { if (e.target.id === 'sheet') closeSheet(); };
  $('#import-file').onchange = importBackup;
  show('scan');
  if (!S.catalog) loadCatalog().catch(() => {});
}

function show(v) {
  S.view = v;
  document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== 'view-' + v);
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'scan') startCam(); else stopCam();
  if (v === 'coll') renderColl();
  if (v === 'stats') renderStats();
}

function toast(html, onTap) {
  const t = $('#toast'); t.innerHTML = html; t.hidden = false;
  t.onclick = () => { t.hidden = true; onTap && onTap(); };
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3500);
}

// ---------- catalogue des extensions ----------
async function loadCatalog() {
  const series = await getJSON('/series');
  const full = [];
  await pool(series, 4, async s => { try { full.push(await getJSON('/series/' + encodeURIComponent(s.id))); } catch { } });
  // ordre de l'API = chronologique ; on affiche le plus récent en haut
  const order = series.map(s => s.id);
  S.catalog = full.sort((a, b) => order.indexOf(b.id) - order.indexOf(a.id))
    .map(s => ({ id: s.id, name: s.name, sets: [...(s.sets || [])].reverse() }));
  await kv.set('catalog', S.catalog);
  if (S.view === 'coll') renderColl();
}

async function getSet(id) {
  const fresh = getJSON('/sets/' + encodeURIComponent(id)).then(s => (kv.set('set:' + id, s), s));
  const cached = await kv.get('set:' + id);
  if (cached) { fresh.catch(() => {}); return cached; } // cache d'abord, rafraîchi en fond
  return fresh;
}

// ---------- vue Collection ----------
function renderColl() {
  const el = $('#view-coll');
  if (!S.catalog) { el.innerHTML = '<p class="muted">Chargement des extensions… (connexion internet nécessaire la première fois)</p><button class="primary" id="retry">Réessayer</button>'; $('#retry').onclick = () => loadCatalog().catch(err => toast('Erreur : ' + esc(err.message))); return; }
  const bySet = {};
  for (const e of S.coll) (bySet[e.setId] ||= new Set()).add(e.cardId);
  el.innerHTML = '<h1>Collection</h1>' + S.catalog.map(serie => `
    <h2>${esc(serie.name)}</h2>
    ${serie.sets.map(st => {
      const n = bySet[st.id]?.size || 0, tot = st.cardCount?.official || st.cardCount?.total || 0;
      const pct = tot ? Math.min(100, Math.round(n / tot * 100)) : 0;
      return `<button class="setrow" data-set="${esc(st.id)}">
        ${st.symbol ? `<img src="${esc(st.symbol)}.png" alt="" loading="lazy">` : '<span class="sym"></span>'}
        <span class="grow"><b>${esc(st.name)}</b>${S.fpSets.includes(st.id) ? ' <span class="ok">scan ✓</span>' : ''}
        <span class="bar"><i style="width:${pct}%"></i></span></span>
        <span class="count">${n}/${tot}</span></button>`;
    }).join('')}`).join('') + '<button id="refresh-cat" class="ghost">Mettre à jour la liste des extensions</button>';
  el.querySelectorAll('.setrow').forEach(b => b.onclick = () => openSet(b.dataset.set));
  $('#refresh-cat').onclick = () => loadCatalog().then(() => toast('Liste à jour')).catch(err => toast('Erreur : ' + esc(err.message)));
}

async function openSet(id, filter = 'all') {
  const el = $('#view-coll');
  el.innerHTML = '<p class="muted">Chargement…</p>';
  let set;
  try { set = await getSet(id); } catch { el.innerHTML = '<p>Extension indisponible hors ligne.</p><button class="ghost" id="back">← Retour</button>'; $('#back').onclick = renderColl; return; }
  const owned = ownedIds(), cards = set.cards || [];
  const n = cards.filter(c => owned.has(c.id)).length;
  const shown = cards.filter(c => filter === 'all' || (filter === 'miss') !== owned.has(c.id));
  const ready = S.fpSets.includes(id);
  el.innerHTML = `
    <button class="ghost" id="back">← Extensions</button>
    <h1>${esc(set.name)}</h1>
    <p class="muted">${n} / ${set.cardCount?.official ?? cards.length} cartes (${cards.length} au total avec les secrètes)</p>
    <div class="row">
      ${['all:Toutes', 'miss:Manquantes', 'own:Possédées'].map(x => { const [k, l] = x.split(':'); return `<button class="chip ${k === filter ? 'on' : ''}" data-f="${k}">${l}</button>`; }).join('')}
    </div>
    <button class="${ready ? 'ghost' : 'primary'}" id="dl">${ready ? 'Scan prêt ✓ — mettre à jour prix et empreintes' : 'Activer le scan pour cette extension'}</button>
    <p id="dl-prog" class="muted"></p>
    <div class="grid">${shown.map(c => `
      <button class="cell ${owned.has(c.id) ? '' : 'miss'}" data-id="${esc(c.id)}">
        ${c.image ? `<img src="${esc(c.image)}/low.webp" loading="lazy" alt="">` : `<span class="noimg">${esc(c.name)}</span>`}
        <small>${esc(c.localId)}</small></button>`).join('')}</div>`;
  $('#back').onclick = renderColl;
  el.querySelectorAll('.chip').forEach(b => b.onclick = () => openSet(id, b.dataset.f));
  $('#dl').onclick = () => downloadSet(set).then(() => openSet(id, filter)).catch(err => toast('Erreur : ' + esc(err.message)));
  el.querySelectorAll('.cell').forEach(b => b.onclick = () => {
    const c = cards.find(x => x.id === b.dataset.id);
    openCard({ ...c, setId: id, setName: set.name }, () => openSet(id, filter));
  });
}

// Télécharge prix + empreintes de toutes les cartes d'une extension
async function downloadSet(set) {
  const prog = $('#dl-prog'), cards = set.cards || [], out = [];
  let done = 0, noImg = 0;
  const canvas = document.createElement('canvas'); canvas.width = FP.W; canvas.height = FP.H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await pool(cards, 6, async c => {
    const card = { id: c.id, localId: c.localId, name: c.name, image: c.image, setId: set.id, setName: set.name };
    try {
      const d = await getJSON('/cards/' + encodeURIComponent(c.id));
      card.variants = d.variants;
      if (d.pricing?.cardmarket) S.prices[c.id] = d.pricing.cardmarket;
    } catch { }
    if (c.image) {
      try {
        ctx.drawImage(await getImage(c.image + '/low.webp'), 0, 0, FP.W, FP.H);
        card.fp = FP.fingerprint(ctx.getImageData(0, 0, FP.W, FP.H).data);
      } catch { noImg++; }
    } else noImg++;
    out.push(card);
    if (prog) prog.textContent = `Téléchargement ${++done} / ${cards.length}…`;
  });
  await kv.set('fp:' + set.id, out);
  await kv.set('prices', S.prices);
  if (!S.fpSets.includes(set.id)) S.fpSets.push(set.id);
  await kv.set('fpsets', S.fpSets);
  S.fpCards = S.fpCards.filter(c => c.setId !== set.id).concat(out);
  toast(`${set.name} prête pour le scan` + (noImg ? ` (${noImg} cartes sans image, à ajouter à la main)` : ''));
}

// ---------- fiche carte ----------
async function openCard(c, onClose) {
  S.sheetClose = onClose;
  c.setId ||= setIdOf(c); c.setName ||= setName(c.setId);
  renderCard(c);
  try { // rafraîchit prix et variantes si en ligne
    const d = await getJSON('/cards/' + encodeURIComponent(c.id));
    c.variants = d.variants;
    if (d.pricing?.cardmarket) { S.prices[c.id] = d.pricing.cardmarket; kv.set('prices', S.prices); }
    if (!$('#sheet').hidden && S.sheetCard === c) renderCard(c);
  } catch { }
}

function defaultVariant(c) {
  const v = c.variants;
  return v && v.normal === false ? (v.holo ? 'holo' : v.reverse ? 'reverse' : 'normal') : 'normal';
}

function addCard(c, extra = {}) {
  FP.addEntry(S.coll, {
    cardId: c.id, setId: c.setId || setIdOf(c), setName: c.setName || setName(c.setId || setIdOf(c)),
    localId: c.localId, name: c.name, image: c.image, variant: defaultVariant(c), cond: 'NM', qty: 1, note: '', ...extra
  });
  save();
}

function renderCard(c) {
  S.sheetCard = c;
  const p = S.prices[c.id], entries = S.coll.filter(e => e.cardId === c.id);
  const line = v => { const u = FP.unitPrice(p, v, 'NM', S.coef); return `<tr><td>${VARIANTS[v]}</td><td>${eur(u.trend)}</td><td>${eur(u.avg)}</td></tr>`; };
  $('#sheet-box').innerHTML = `
    <div class="cardhead">
      ${c.image ? `<img src="${esc(c.image)}/high.webp" alt="">` : ''}
      <div><h1>${esc(c.name)}</h1><p class="muted">${esc(c.setName)} · n° ${esc(c.localId)}</p>
      <table class="prices"><tr><th></th><th>Tendance</th><th>Moyen</th></tr>${line('normal')}${p && p['trend-holo'] != null ? line('reverse') : ''}</table>
      <p class="muted small">Cardmarket, Near Mint${p?.updated ? ' · ' + new Date(p.updated).toLocaleDateString('fr-FR') : ''}${p ? '' : ' · pas de prix connu'}</p></div>
    </div>
    <h2>Mes exemplaires (${entries.reduce((a, e) => a + e.qty, 0)})</h2>
    ${entries.map((e, i) => `
      <div class="entry" data-i="${S.coll.indexOf(e)}">
        <div class="row">
          <select data-k="variant">${Object.entries(VARIANTS).map(([k, l]) => `<option value="${k}" ${e.variant === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <select data-k="cond">${FP.CONDS.map(k => `<option value="${k}" ${e.cond === k ? 'selected' : ''}>${FP.COND_LABEL[k]}</option>`).join('')}</select>
        </div>
        <div class="row">
          <button class="qty" data-d="-1">−</button><b>${e.qty}</b><button class="qty" data-d="1">+</button>
          <input data-k="note" value="${esc(e.note)}" placeholder="1ère éd., Shadowless, tampon, PSA 9…">
          <span class="price">${eur(FP.unitPrice(p, e.variant, e.cond, S.coef).trend)}</span>
        </div>
      </div>`).join('') || '<p class="muted">Pas encore dans ta collection.</p>'}
    <div class="row"><button class="primary" id="add">+ Ajouter un exemplaire</button><button class="ghost" id="close">Fermer</button></div>`;
  $('#sheet').hidden = false;
  // nouvelle ligne séparée pour pouvoir lui donner un autre état ; les lignes identiques sont fusionnées à la fermeture
  $('#add').onclick = () => { S.coll.push({ cardId: c.id, setId: c.setId, setName: c.setName, localId: c.localId, name: c.name, image: c.image, variant: defaultVariant(c), cond: 'NM', qty: 1, note: '' }); save(); renderCard(c); };
  $('#close').onclick = closeSheet;
  document.querySelectorAll('.entry').forEach(row => {
    const e = S.coll[+row.dataset.i];
    row.querySelectorAll('[data-k]').forEach(inp => inp.onchange = () => { e[inp.dataset.k] = inp.value; save(); });
    row.querySelectorAll('.qty').forEach(b => b.onclick = () => {
      e.qty += +b.dataset.d;
      if (e.qty <= 0 && !confirm('Retirer cet exemplaire de la collection ?')) e.qty = 1;
      S.coll = S.coll.filter(x => x.qty > 0); save(); renderCard(c);
    });
  });
}

function closeSheet() {
  S.coll = S.coll.reduce((acc, e) => FP.addEntry(acc, e), []); save();
  $('#sheet').hidden = true; S.sheetCard = null; S.sheetClose && S.sheetClose(); }

// ---------- scan ----------
async function startCam() {
  const v = $('#video'), msg = $('#cam-msg');
  msg.textContent = S.fpSets.length ? 'Cadre la carte dans le rectangle' : 'Active d\'abord le scan d\'une extension dans Collection';
  if (v.srcObject) return;
  try {
    v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    await v.play();
  } catch (err) { msg.textContent = 'Caméra indisponible : ' + err.message; }
}
function stopCam() {
  const v = $('#video');
  v.srcObject?.getTracks().forEach(t => t.stop()); v.srcObject = null;
}

function scan() {
  const v = $('#video'), box = $('#matches');
  if (!v.videoWidth) return toast('Caméra pas prête');
  if (!S.fpCards.length) return toast('Active d\'abord le scan d\'une extension (onglet Collection)', () => show('coll'));
  const cam = $('#cam').getBoundingClientRect(), g = $('#guide').getBoundingClientRect();
  const r = FP.guideToVideo(v.videoWidth, v.videoHeight, cam.width, cam.height, { x: g.left - cam.left, y: g.top - cam.top, w: g.width, h: g.height });
  const canvas = document.createElement('canvas'); canvas.width = FP.W; canvas.height = FP.H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, FP.W, FP.H);
  const res = FP.topMatches(FP.fingerprint(ctx.getImageData(0, 0, FP.W, FP.H).data), S.fpCards, 5);
  box.innerHTML = '<p class="muted">Touche la bonne carte pour l\'ajouter :</p>' + res.map((m, i) => `
    <button class="match" data-i="${i}">
      ${m.card.image ? `<img src="${esc(m.card.image)}/low.webp" alt="">` : ''}
      <span class="grow"><b>${esc(m.card.name)}</b><br><span class="muted">${esc(m.card.setName)} · n° ${esc(m.card.localId)}</span></span>
    </button>`).join('');
  box.querySelectorAll('.match').forEach(b => b.onclick = () => {
    const c = res[+b.dataset.i].card;
    addCard(c);
    box.innerHTML = '';
    toast(`Ajouté : <b>${esc(c.name)}</b> (${esc(c.setName)} ${esc(c.localId)}) — touche pour modifier`, () => openCard(c));
  });
}

// ---------- recherche par Pokémon ----------
async function search(q) {
  const el = $('#search-res');
  if (!q) return;
  el.innerHTML = '<p class="muted">Recherche…</p>';
  let cards;
  try { cards = await getJSON('/cards?name=' + encodeURIComponent(q)); }
  catch { // hors ligne : extensions téléchargées + collection
    const n = norm(q), seen = new Set();
    cards = [...S.fpCards, ...S.coll.map(e => ({ id: e.cardId, localId: e.localId, name: e.name, image: e.image, setId: e.setId }))]
      .filter(c => norm(c.name).includes(n) && !seen.has(c.id) && seen.add(c.id));
  }
  const owned = ownedIds();
  const n = cards.filter(c => owned.has(c.id)).length;
  el.innerHTML = `<p class="muted">${cards.length} cartes · ${n} possédées</p><div class="grid">${cards.map(c => `
    <button class="cell ${owned.has(c.id) ? '' : 'miss'}" data-id="${esc(c.id)}">
      ${c.image ? `<img src="${esc(c.image)}/low.webp" loading="lazy" alt="">` : `<span class="noimg">${esc(c.name)}</span>`}
      <small>${esc(setName(setIdOf(c)))}</small></button>`).join('')}</div>`;
  el.querySelectorAll('.cell').forEach(b => b.onclick = () => openCard({ ...cards.find(c => c.id === b.dataset.id) }, () => search(q)));
}

// ---------- stats, export, sauvegarde ----------
function renderStats() {
  const st = FP.stats(S.coll, S.prices, S.coef), el = $('#view-stats');
  const byId = Object.fromEntries(S.coll.map(e => [e.cardId, e]));
  el.innerHTML = `
    <h1>Stats</h1>
    <div class="kpis">
      <div><b>${st.unique}</b><span>cartes différentes</span></div>
      <div><b>${st.qty}</b><span>cartes au total</span></div>
      <div><b>${eur(st.trend)}</b><span>valeur (tendance)</span></div>
      <div><b>${eur(st.avg)}</b><span>valeur (moyenne)</span></div>
    </div>
    <h2>Les plus chères</h2>
    ${st.top.filter(t => t.u.trend).map(t => `<button class="line" data-id="${esc(t.e.cardId)}"><span class="grow">${esc(t.e.name)} <span class="muted">${esc(t.e.setName)} ${esc(t.e.localId)} · ${VARIANTS[t.e.variant]} · ${t.e.cond}</span></span><b>${eur(t.u.trend)}</b></button>`).join('') || '<p class="muted">Aucun prix connu pour l\'instant.</p>'}
    <h2>Doublons (${st.dups.reduce((a, d) => a + d.extra, 0)} à échanger)</h2>
    ${st.dups.map(d => `<button class="line" data-id="${esc(d.id)}"><span class="grow">${esc(byId[d.id].name)} <span class="muted">${esc(byId[d.id].setName)} ${esc(byId[d.id].localId)}</span></span><b>+${d.extra}</b></button>`).join('') || '<p class="muted">Pas de doublon.</p>'}
    <h2>Coefficients de prix selon l'état</h2>
    <p class="muted small">Estimation appliquée au prix Near Mint de Cardmarket.</p>
    <div class="coefs">${FP.CONDS.map(k => `<label>${FP.COND_LABEL[k]}<input type="number" min="0" max="200" step="5" data-c="${k}" value="${Math.round(S.coef[k] * 100)}">%</label>`).join('')}</div>
    <h2>Export &amp; sauvegarde</h2>
    <div class="col">
      <button class="primary" id="csv">Exporter en CSV (Excel)</button>
      <button class="primary" id="bak">Sauvegarder la collection (fichier)</button>
      <button class="ghost" id="imp">Restaurer une sauvegarde</button>
    </div>`;
  el.querySelectorAll('.line').forEach(b => b.onclick = () => {
    const e = byId[b.dataset.id]; openCard({ id: e.cardId, localId: e.localId, name: e.name, image: e.image, setId: e.setId, setName: e.setName }, renderStats);
  });
  el.querySelectorAll('[data-c]').forEach(i => i.onchange = () => {
    const v = Number(i.value);
    if (!(v >= 0 && v <= 200)) return renderStats();
    S.coef[i.dataset.c] = v / 100; kv.set('coef', S.coef); renderStats();
  });
  const day = new Date().toISOString().slice(0, 10);
  $('#csv').onclick = () => saveFile(`pokescan-${day}.csv`, FP.toCSV(S.coll, S.prices, S.coef), 'text/csv');
  $('#bak').onclick = () => saveFile(`pokescan-sauvegarde-${day}.json`, JSON.stringify({ app: 'PokeScan', version: 1, date: new Date().toISOString(), coll: S.coll, coef: S.coef, prices: S.prices }), 'application/json');
  $('#imp').onclick = () => $('#import-file').click();
}

async function saveFile(name, text, mime) {
  try {
    if (NATIVE) {
      const r = await Capacitor.nativePromise('Filesystem', 'writeFile', { path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
      await Capacitor.nativePromise('Share', 'share', { title: name, files: [r.uri] });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; a.click();
    }
  } catch (err) { if (!/cancel/i.test(err.message)) toast('Erreur : ' + esc(err.message)); }
}

async function importBackup(ev) {
  const f = ev.target.files[0]; ev.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    const okEntry = e => e && typeof e.cardId === 'string' && typeof e.setId === 'string' && Number.isInteger(e.qty) && e.qty > 0
      && e.variant in VARIANTS && FP.CONDS.includes(e.cond);
    if (d.app !== 'PokeScan' || !Array.isArray(d.coll) || !d.coll.every(okEntry)) throw new Error('fichier non reconnu');
    if (!confirm(`Remplacer ta collection actuelle (${S.coll.length} lignes) par la sauvegarde du ${new Date(d.date).toLocaleDateString('fr-FR')} (${d.coll.length} lignes) ?`)) return;
    S.coll = d.coll.map(e => ({ ...e, note: String(e.note || ''), name: String(e.name || ''), localId: String(e.localId || '') }));
    if (d.coef) S.coef = { ...FP.DEFAULT_COEF, ...d.coef };
    if (d.prices && typeof d.prices === 'object') S.prices = { ...d.prices, ...S.prices };
    await Promise.all([save(), kv.set('coef', S.coef), kv.set('prices', S.prices)]);
    toast('Sauvegarde restaurée'); renderStats();
  } catch (err) { toast('Restauration impossible : ' + esc(err.message)); }
}

init();
