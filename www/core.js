'use strict';
// Socle : utilitaires, stockage, réseau, état, collection (annuler/historique), catalogue, fiche carte.
const API = 'https://api.tcgdex.net/v2/';
const NATIVE = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const eur = n => n == null ? '–' : n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const pct = n => n == null ? '' : (n > 0 ? '+' : '') + Math.round(n * 100) + ' %';
const norm = LOGIC.norm;
const VARIANTS = { normal: 'Normale', reverse: 'Reverse', holo: 'Holo' };
const today = () => new Date().toISOString().slice(0, 10);

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
async function getJSON(path, lang = 'fr') {
  const url = API + lang + path;
  if (NATIVE) { const d = await nativeGet(url, 'json'); return typeof d === 'string' ? JSON.parse(d) : d; }
  const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
}
// Image lisible pixel par pixel (pas de canvas "tainted" : on passe par une data URL / blob)
async function getImage(url) {
  const src = url.startsWith('data:') ? url : NATIVE ? 'data:image/webp;base64,' + (await nativeGet(url, 'blob')).replace(/\s/g, '')
    : URL.createObjectURL(await (await fetch(url)).blob());
  const img = new Image(); img.src = src; await img.decode(); return img;
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}
function openExternal(url) { if (NATIVE) location.href = url; else window.open(url, '_blank'); } // Capacitor ouvre le navigateur

// ---------- état ----------
const S = {
  coll: [], prices: {}, coef: { ...FP.DEFAULT_COEF }, catalog: null, fpSets: [], fpCards: [], view: 'scan',
  meta: {},      // cardId -> { r: rareté, t: types, i: illustrateur, d: n° Pokédex }
  hist: [],      // historique des ajouts/retraits
  valhist: {},   // date -> valeur totale
  boosters: [],  // ouvertures de vrais boosters
  thumbs: {},    // cardId -> miniature (data URL) des extensions téléchargées
  thumbSets: [], ach: [], theme: 'auto', collF: { q: '', sort: 'serie', state: '', serie: '', year: '' },
};
const ownedIds = () => new Set(S.coll.map(e => e.cardId));
const allSets = () => (S.catalog || []).flatMap(s => s.sets.map(st => ({ ...st, serie: s.id, serieName: s.name })));
const setInfo = id => allSets().find(s => s.id === id);
const setName = id => id === 'perso' ? 'Cartes perso' : setInfo(id)?.name || id;
const setIdOf = c => c.set?.id || c.setId || c.id.slice(0, c.id.length - String(c.localId).length - 1);
const imgOf = (c, q = 'low') => c.photo || (q === 'low' && S.thumbs[c.id || c.cardId]) || (c.image ? `${c.image}/${q}.webp` : '');

// ---------- collection : sauvegarde, annuler/refaire, historique ----------
const undo = [], redo = [];
let lastSaved = '[]';
function save(record = true) {
  const cur = JSON.stringify(S.coll);
  if (cur !== lastSaved) {
    if (record) {
      undo.push(lastSaved); if (undo.length > 50) undo.shift(); redo.length = 0;
      const before = JSON.parse(lastSaved), byId = Object.fromEntries([...before, ...S.coll].map(e => [e.cardId, e]));
      for (const d of LOGIC.diffColl(before, S.coll)) {
        const e = byId[d.cardId];
        S.hist.push({ t: Date.now(), cardId: d.cardId, d: d.d, name: e.name, setName: e.setName, localId: e.localId, image: e.image, photo: e.photo });
      }
      if (S.hist.length > 3000) S.hist.splice(0, S.hist.length - 3000);
      kv.set('hist', S.hist);
    }
    lastSaved = cur;
    afterChange();
  }
  updateUndoUI();
  return kv.set('coll', S.coll);
}
function doUndo(back = true) {
  const from = back ? undo : redo, to = back ? redo : undo;
  if (!from.length) return;
  to.push(JSON.stringify(S.coll));
  S.coll = JSON.parse(from.pop());
  lastSaved = JSON.stringify(S.coll); kv.set('coll', S.coll);
  afterChange(); updateUndoUI();
  toast(back ? 'Annulé' : 'Rétabli');
  rerender();
}
function updateUndoUI() { $('#undo').disabled = !undo.length; $('#redo').disabled = !redo.length; $('#undobar').hidden = !undo.length && !redo.length; }
function rerender() {
  if (!$('#sheet').hidden && S.sheetCard) renderCard(S.sheetCard);
  if (S.view === 'coll') S.redrawColl?.();
  if (S.view === 'stats') renderStats();
  if (S.view === 'scan') renderSession();
}

// Après chaque changement : valeur du jour, widget, succès (regroupés)
function afterChange() {
  clearTimeout(afterChange.t);
  afterChange.t = setTimeout(() => {
    const st = FP.stats(S.coll, S.prices, S.coef);
    S.valhist[today()] = Math.round(st.trend * 100) / 100; kv.set('valhist', S.valhist);
    pushWidget(st);
    checkAchievements(st);
  }, 600);
}

function pushWidget(st) {
  if (!NATIVE) return;
  const owned = {};
  for (const e of S.coll) (owned[e.setId] ||= new Set()).add(e.cardId);
  const best = allSets().filter(s => owned[s.id]).map(s => ({ s, p: LOGIC.progress(s, Object.fromEntries(Object.entries(owned).map(([k, v]) => [k, v.size]))) }))
    .sort((a, b) => b.p - a.p)[0];
  Capacitor.nativePromise('HomeWidget', 'update', {
    value: eur(st.trend), cards: `${st.qty} cartes · ${st.unique} différentes`,
    progress: best ? `${best.s.name} : ${Math.round(best.p * 100)} %` : '',
  }).catch(() => { });
}

// Ajoute une carte à la collection (fusion avec une ligne identique)
function addCard(c, extra = {}) {
  const e = {
    cardId: c.id, setId: c.setId || setIdOf(c), setName: c.setName || setName(c.setId || setIdOf(c)),
    localId: c.localId, name: c.name, image: c.image, variant: defaultVariant(c), cond: 'NM', qty: 1, note: '', added: Date.now(), ...extra,
  };
  if (c.photo) e.photo = c.photo;
  FP.addEntry(S.coll, e);
  rememberMeta(c);
  save();
  return e;
}
function defaultVariant(c) {
  const v = c.variants;
  return v && v.normal === false ? (v.holo ? 'holo' : v.reverse ? 'reverse' : 'normal') : 'normal';
}
function rememberMeta(d) {
  if (!d?.id || !('dexId' in d || 'illustrator' in d || 'types' in d)) return; // fiche complète de l'API seulement
  S.meta[d.id] = { r: d.rarity || '', t: d.types || [], i: d.illustrator || '', d: d.dexId || [], c: d.category || '' };
  clearTimeout(rememberMeta.t); rememberMeta.t = setTimeout(() => kv.set('meta', S.meta), 1000);
}

// Complète en fond raretés/types/illustrateurs et prix des cartes possédées (une fois en ligne)
async function backfill() {
  const ids = [...ownedIds()].filter(id => !id.startsWith('perso-') && (!S.meta[id] || !S.prices[id])).slice(0, 300);
  if (!ids.length) return;
  let ok = 0;
  await pool(ids, 4, async id => {
    try {
      const d = await getJSON('/cards/' + encodeURIComponent(id));
      rememberMeta(d);
      if (d.pricing?.cardmarket) S.prices[id] = d.pricing.cardmarket;
      ok++;
    } catch { }
  });
  if (ok) { kv.set('prices', S.prices); afterChange(); rerender(); }
}

function toast(html, onTap) {
  const t = $('#toast'); t.innerHTML = html; t.hidden = false;
  t.onclick = () => { t.hidden = true; onTap && onTap(); };
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3500);
}

// ---------- catalogue des extensions ----------
async function loadCatalog(withDates = true) {
  const series = await getJSON('/series');
  const full = [];
  await pool(series, 4, async s => { try { full.push(await getJSON('/series/' + encodeURIComponent(s.id))); } catch { } });
  const old = Object.fromEntries(allSets().map(s => [s.id, s]));
  // ordre de l'API = chronologique ; on affiche le plus récent en haut
  const order = series.map(s => s.id);
  S.catalog = full.sort((a, b) => order.indexOf(b.id) - order.indexOf(a.id))
    .map(s => ({ id: s.id, name: s.name, sets: [...(s.sets || [])].reverse().map(st => ({ ...st, releaseDate: old[st.id]?.releaseDate })) }));
  await kv.set('catalog', S.catalog);
  if (withDates) loadDates();
  S.redrawColl?.();
}
// Dates de sortie (une requête par extension, une seule fois)
async function loadDates() {
  const todo = allSets().filter(s => !s.releaseDate);
  if (!todo.length) return;
  const dates = {};
  await pool(todo, 6, async st => {
    try { const d = await getJSON('/sets/' + encodeURIComponent(st.id)); dates[st.id] = d.releaseDate || '0000'; kv.set('set:' + st.id, d); } catch { }
  });
  for (const s of S.catalog) for (const st of s.sets) if (dates[st.id]) st.releaseDate = dates[st.id];
  await kv.set('catalog', S.catalog);
  S.redrawColl?.();
}

async function getSet(id) {
  const fresh = getJSON('/sets/' + encodeURIComponent(id)).then(s => (kv.set('set:' + id, s), s));
  const cached = await kv.get('set:' + id);
  if (cached) { fresh.catch(() => { }); return cached; } // cache d'abord, rafraîchi en fond
  return fresh;
}

// Télécharge prix, infos, empreintes et miniatures de toutes les cartes d'une extension
async function downloadSet(set, onProg) {
  const cards = set.cards || [], out = [], thumbs = {};
  let done = 0, noImg = 0;
  const canvas = document.createElement('canvas'); canvas.width = FP.W; canvas.height = FP.H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tc = document.createElement('canvas'); tc.width = 126; tc.height = 176;
  await pool(cards, 6, async c => {
    const card = { id: c.id, localId: c.localId, name: c.name, image: c.image, setId: set.id, setName: set.name, official: set.cardCount?.official };
    try {
      const d = await getJSON('/cards/' + encodeURIComponent(c.id));
      card.variants = d.variants; card.rarity = d.rarity;
      rememberMeta(d);
      if (d.pricing?.cardmarket) S.prices[c.id] = d.pricing.cardmarket;
    } catch { }
    if (!c.image) { // image FR absente (ex. promos récentes) : même illustration en anglais
      try { card.image = (await getJSON('/cards/' + encodeURIComponent(c.id), 'en')).image; } catch { }
    }
    if (card.image) {
      try {
        const img = await getImage(card.image + '/low.webp');
        ctx.drawImage(img, 0, 0, FP.W, FP.H);
        card.fp = FP.fingerprint(ctx.getImageData(0, 0, FP.W, FP.H).data);
        tc.getContext('2d').drawImage(img, 0, 0, 126, 176);
        thumbs[c.id] = tc.toDataURL('image/webp', 0.7);
      } catch { noImg++; }
    } else noImg++;
    out.push(card);
    onProg && onProg(++done, cards.length);
  });
  await kv.set('fp:' + set.id, out);
  await kv.set('thumb:' + set.id, thumbs);
  Object.assign(S.thumbs, thumbs);
  await kv.set('prices', S.prices);
  if (!S.fpSets.includes(set.id)) S.fpSets.push(set.id);
  if (!S.thumbSets.includes(set.id)) S.thumbSets.push(set.id);
  await kv.set('fpsets', S.fpSets); await kv.set('thumbsets', S.thumbSets);
  S.fpCards = S.fpCards.filter(c => c.setId !== set.id).concat(out);
  afterChange();
  return noImg;
}
async function loadThumbs(setId) { if (S.thumbSets.includes(setId)) Object.assign(S.thumbs, (await kv.get('thumb:' + setId)) || {}); }

// ---------- fiche carte ----------
async function openCard(c, onClose) {
  S.sheetClose = onClose;
  c.setId ||= setIdOf(c); c.setName ||= setName(c.setId);
  renderCard(c);
  if (c.id.startsWith('perso-')) return;
  try { // rafraîchit prix, variantes et infos si en ligne
    const d = await getJSON('/cards/' + encodeURIComponent(c.id));
    c.variants = d.variants; c.rarity = d.rarity; c.illustrator = d.illustrator;
    rememberMeta(d);
    if (d.pricing?.cardmarket) { S.prices[c.id] = d.pricing.cardmarket; kv.set('prices', S.prices); }
    if (!$('#sheet').hidden && S.sheetCard === c) renderCard(c);
  } catch { }
}

function renderCard(c) {
  S.sheetCard = c;
  const p = S.prices[c.id], entries = S.coll.filter(e => e.cardId === c.id), m = S.meta[c.id], perso = c.id.startsWith('perso-');
  const line = v => { const u = FP.unitPrice(p, v, 'NM', S.coef); return `<tr><td>${VARIANTS[v]}</td><td>${eur(u.trend)}</td><td>${eur(u.avg)}</td></tr>`; };
  const ch = LOGIC.priceChange(p);
  const im = imgOf(c, 'high');
  $('#sheet-box').innerHTML = `
    <div class="cardhead">
      ${im ? `<img src="${esc(im)}" alt="">` : ''}
      <div><h1>${esc(c.name)}</h1><p class="muted">${esc(c.setName)} · n° ${esc(c.localId)}</p>
      ${m ? `<p class="muted small">${esc([m.r, (m.t || []).join(', '), m.i && 'Illus. ' + m.i].filter(Boolean).join(' · '))}</p>` : ''}
      ${perso ? `<label class="small">Prix estimé (€) <input id="perso-price" type="number" min="0" step="0.5" value="${p?.trend ?? ''}"></label>`
      : `<table class="prices"><tr><th></th><th>Tendance</th><th>Moyen</th></tr>${line('normal')}${p && p['trend-holo'] != null ? line('reverse') : ''}</table>
      <p class="muted small">Cardmarket, Near Mint${p?.updated ? ' · ' + new Date(p.updated).toLocaleDateString('fr-FR') : ''}${p ? '' : ' · pas de prix connu'}${ch != null ? ` · <span class="${ch >= 0 ? 'up' : 'down'}">${pct(ch)} sur 7 j</span>` : ''}</p>
      <button class="ghost small" id="cm">Voir sur Cardmarket ↗</button>`}</div>
    </div>
    <h2>Mes exemplaires (${entries.reduce((a, e) => a + e.qty, 0)})</h2>
    ${entries.map(e => `
      <div class="entry" data-i="${S.coll.indexOf(e)}">
        <div class="row">
          <select data-k="variant">${Object.entries(VARIANTS).map(([k, l]) => `<option value="${k}" ${e.variant === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <select data-k="cond">${FP.CONDS.map(k => `<option value="${k}" ${e.cond === k ? 'selected' : ''}>${FP.COND_LABEL[k]}</option>`).join('')}</select>
        </div>
        <div class="row">
          <button class="qty" data-d="-1">−</button><b>${e.qty}</b><button class="qty" data-d="1">+</button>
          <input data-k="note" value="${esc(e.note)}" placeholder="1ère éd., Shadowless, tampon, PSA 9…">
        </div>
        <div class="row small">
          <label>Payé (€/u) <input data-k="paid" type="number" min="0" step="0.1" value="${e.paid ?? ''}" class="num"></label>
          <span class="grow"></span><span class="price">${eur(FP.unitPrice(p, e.variant, e.cond, S.coef).trend)}</span>
        </div>
      </div>`).join('') || '<p class="muted">Pas encore dans ta collection.</p>'}
    <div class="row"><button class="primary" id="add">+ Ajouter un exemplaire</button><button class="ghost" id="close">Fermer</button></div>`;
  $('#sheet').hidden = false;
  $('#cm') && ($('#cm').onclick = () => openExternal(`https://www.cardmarket.com/fr/Pokemon/Products/Search?searchString=${encodeURIComponent(c.name + ' ' + c.localId)}`));
  $('#perso-price') && ($('#perso-price').onchange = e => {
    const v = parseFloat(e.target.value);
    S.prices[c.id] = isFinite(v) && v >= 0 ? { trend: v, avg: v, manual: true } : undefined;
    kv.set('prices', S.prices); afterChange();
  });
  // nouvelle ligne séparée pour pouvoir lui donner un autre état ; les lignes identiques sont fusionnées à la fermeture
  $('#add').onclick = () => { S.coll.push({ cardId: c.id, setId: c.setId, setName: c.setName, localId: c.localId, name: c.name, image: c.image, photo: c.photo, variant: defaultVariant(c), cond: 'NM', qty: 1, note: '', added: Date.now() }); save(); renderCard(c); };
  $('#close').onclick = closeSheet;
  $$('.entry').forEach(row => {
    const e = S.coll[+row.dataset.i];
    row.querySelectorAll('[data-k]').forEach(inp => inp.onchange = () => {
      if (inp.dataset.k === 'paid') { const v = parseFloat(inp.value); if (isFinite(v) && v >= 0) e.paid = v; else delete e.paid; }
      else e[inp.dataset.k] = inp.value;
      save();
    });
    row.querySelectorAll('.qty').forEach(b => b.onclick = () => {
      e.qty += +b.dataset.d;
      if (e.qty <= 0 && !confirm('Retirer cet exemplaire de la collection ?')) e.qty = 1;
      S.coll = S.coll.filter(x => x.qty > 0); save(); renderCard(c);
    });
  });
}

function closeSheet() {
  const merged = S.coll.reduce((acc, e) => FP.addEntry(acc, e), []);
  if (merged.length !== S.coll.length) { S.coll = merged; save(false); }
  $('#sheet').hidden = true; S.sheetCard = null; S.sheetClose && S.sheetClose();
}
