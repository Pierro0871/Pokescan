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
const hhmm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dayTime = t => new Date(t).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' à ' + hhmm(t);
const LANGS = { fr: 'Français', en: 'English', de: 'Deutsch', it: 'Italiano', es: 'Español', pt: 'Português', ja: '日本語' };
const FLAG = { fr: '🇫🇷', en: '🇬🇧', de: '🇩🇪', it: '🇮🇹', es: '🇪🇸', pt: '🇵🇹', ja: '🇯🇵' };
// Clé de stockage propre à la langue (le français garde les clés d'origine)
const LK = k => S.lang === 'fr' ? k : k + '@' + S.lang;
const langOf = e => e.lang || 'fr';

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
  return {
    get: k => tx('readonly', s => s.get(k)),
    del: k => tx('readwrite', s => s.delete(k)).catch(() => { }),
    // échec d'écriture (stockage plein…) : on prévient une fois au lieu d'échouer en silence
    set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(err => { if (!kv.warned) { kv.warned = true; toast('⚠️ Enregistrement impossible (' + esc(err?.name || err) + '). Fais une sauvegarde depuis Stats.'); } }),
  };
})();

// ---------- réseau ----------
async function nativeGet(url, responseType) {
  const r = await Capacitor.nativePromise('CapacitorHttp', 'request', { url, method: 'GET', responseType });
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  return r.data;
}
async function getJSON(path, lang = S.lang) {
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
  lang: 'fr', coll: [], prices: {}, coef: { ...FP.DEFAULT_COEF }, catalog: null, fpSets: [], fpCards: [], view: 'scan',
  meta: {},      // cardId -> { r: rareté, t: types, i: illustrateur, d: n° Pokédex }
  hist: [],      // historique des ajouts/retraits
  valhist: {}, phist: {},   // date -> valeur totale
  boosters: [],  // ouvertures de vrais boosters
  thumbs: {},    // cardId -> miniature (data URL) des extensions téléchargées
  thumbSets: [], ach: [], theme: 'auto', collF: { q: '', sort: 'serie', state: '', serie: '', year: '' },
};
const ownedIds = (lang = S.lang) => new Set(S.coll.filter(e => !lang || langOf(e) === lang).map(e => e.cardId));
const allSets = () => (S.catalog || []).flatMap(s => s.sets.map(st => ({ ...st, serie: s.id, serieName: s.name })));
const setInfo = id => allSets().find(s => s.id === id);
const setName = id => id === 'perso' ? 'Cartes perso' : setInfo(id)?.name || id;
const setIdOf = c => c.set?.id || c.setId || c.id.slice(0, c.id.length - String(c.localId).length - 1);
const imgOf = (c, q = 'low') => c.photo || (q === 'low' && S.thumbs[c.id || c.cardId]) || (c.image ? `${c.image}/${q}.webp` : guessImg(c, q));
// Pas d'image dans la base (promos récentes…) : on tente l'adresse habituelle, puis l'anglais et le japonais (voir imgErr)
function guessImg(c, q = 'low') {
  const sid = c.setId || (c.id && c.localId != null ? setIdOf(c) : ''), st = sid && setInfo(sid);
  return st && c.localId ? `https://assets.tcgdex.net/${S.lang}/${st.serie}/${sid}/${c.localId}/${q}.webp` : '';
}
const imgLangs = () => [...new Set([S.lang, 'en', 'fr', 'ja'])];
const imgBases = (c, sid) => { const st = setInfo(sid); return st ? imgLangs().map(l => `https://assets.tcgdex.net/${l}/${st.serie}/${sid}/${c.localId}`) : []; };
// Image introuvable : langue suivante (fr -> en -> ja), puis adresses de secours (data-alt), sinon on la masque
function imgErr(im) {
  const src = im.getAttribute('src') || '';
  if (!src || src.startsWith('data:')) return void im.classList.add('broken');
  // coupure réseau passagère : on retente une fois la même adresse avant de changer de langue
  if (!im.dataset.retry) { im.dataset.retry = '1'; setTimeout(() => { im.removeAttribute('src'); im.src = src; }, 1500); return; }
  const m = src.match(/assets\.tcgdex\.net\/([a-z-]+)\//), next = m && { fr: 'en', de: 'en', it: 'en', es: 'en', pt: 'en', en: S.lang === 'en' ? 'fr' : 'ja', ja: null }[m[1]];
  if (next) { im.dataset.retry = ''; im.src = src.replace(`/${m[1]}/`, `/${next}/`); return; }
  const alt = (im.dataset.alt || '').split('|').filter(Boolean);
  if (alt.length) { im.dataset.alt = alt.slice(1).join('|'); im.src = alt[0]; return; }
  im.classList.add('broken');
  if (im.parentElement?.classList.contains('cell') && im.alt) im.insertAdjacentHTML('afterend', `<span class="noimg">${esc(im.alt)}</span>`);
}
document.addEventListener('error', e => { if (e.target.tagName === 'IMG') imgErr(e.target); }, true);
// Logo d'une extension (symbole en secours)
function setLogo(st, cls = 'logo') {
  const logo = st.logo ? st.logo + '.png' : `https://assets.tcgdex.net/${S.lang}/${st.serie}/${st.id}/logo.png`;
  const sym = st.symbol ? st.symbol + '.png' : `https://assets.tcgdex.net/univ/${st.serie}/${st.id}/symbol.png`;
  return `<img class="${cls}" src="${esc(logo)}" data-alt="${esc(sym)}" alt="" loading="lazy">`;
}

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
  if (S.view === 'mine') { const y = scrollY; openAll(); scrollTo(0, y); }
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
  if (S.lang !== 'fr' && !e.lang) e.lang = S.lang;
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
  S.meta[d.id] = { r: d.rarity || '', t: d.types || [], i: d.illustrator || '', d: d.dexId || [], c: d.category || '', s: d.stage || '', e: d.energyType || '', l: d.legal || null, n: d.name };
  clearTimeout(rememberMeta.t); rememberMeta.t = setTimeout(() => kv.set('meta', S.meta), 1000);
}

// Prix reçu de l'API : gardé, et noté dans l'historique (cartes possédées ou ouvertes) pour la courbe
function setPrice(id, p, force) {
  if (!p) return;
  S.prices[id] = p;
  if (!force && !ownedIds().has(id)) return;
  const h = S.phist[id] ||= [], d = today(), row = [d, p.trend ?? null, p['trend-holo'] ?? null];
  if (h.length && h[h.length - 1][0] === d) h[h.length - 1] = row; else h.push(row);
  if (h.length > 180) h.splice(0, h.length - 180);
  clearTimeout(setPrice.t); setPrice.t = setTimeout(() => kv.set('phist', S.phist), 1500);
}
// Une fois par jour : prix à jour des cartes possédées (la courbe de chaque carte se construit ainsi)
async function refreshPrices() {
  if ((await kv.get('pricesDay')) === today()) return;
  const ids = [...ownedIds()].filter(id => !id.startsWith('perso-')).slice(0, 600);
  let ok = 0;
  await pool(ids, 4, async id => {
    try { const d = await getJSON('/cards/' + encodeURIComponent(id), srcLang(setIdOf({ id, localId: id.split('-').pop() }))); if (d.pricing?.cardmarket) { setPrice(id, d.pricing.cardmarket); ok++; } } catch { }
  });
  if (ok) { kv.set('prices', S.prices); kv.set('pricesDay', today()); afterChange(); rerender(); }
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
      setPrice(id, d.pricing?.cardmarket);
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

const allTags = () => [...new Set(S.coll.flatMap(e => e.tags || []))].sort((a, b) => a.localeCompare(b));

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
  // Extensions absentes de la base dans cette langue (ex. anciennes séries EX en français) : on les prend en anglais
  if (S.lang !== 'en') {
    try {
      const enSeries = await getJSON('/series', 'en'), have = new Set(allSets().map(s => s.id));
      await pool(enSeries, 4, async es => {
        let d; try { d = await getJSON('/series/' + encodeURIComponent(es.id), 'en'); } catch { return; }
        const extra = (d.sets || []).filter(st => !have.has(st.id)).reverse().map(st => ({ ...st, srcLang: 'en', releaseDate: old[st.id]?.releaseDate }));
        if (!extra.length) return;
        let serie = S.catalog.find(x => x.id === es.id);
        if (!serie) { serie = { id: es.id, name: es.name, sets: [] }; S.catalog.push(serie); }
        serie.sets.push(...extra);
      });
    } catch { }
  }
  await kv.set(LK('catalog'), S.catalog);
  if (withDates) loadDates();
  S.redrawColl?.();
}
// Dates de sortie (une requête par extension, une seule fois)
async function loadDates() {
  const todo = allSets().filter(s => !s.releaseDate);
  if (!todo.length) return;
  const dates = {};
  await pool(todo, 6, async st => {
    try { const d = await getJSON('/sets/' + encodeURIComponent(st.id), srcLang(st.id)); dates[st.id] = d.releaseDate || '0000'; kv.set(LK('set:' + st.id), d); } catch { }
  });
  for (const s of S.catalog) for (const st of s.sets) if (dates[st.id]) st.releaseDate = dates[st.id];
  await kv.set(LK('catalog'), S.catalog);
  S.redrawColl?.();
}

const srcLang = setId => setInfo(setId)?.srcLang || S.lang;
async function getSet(id) {
  const k = LK('set:' + id), fresh = getJSON('/sets/' + encodeURIComponent(id), srcLang(id)).then(s => (kv.set(k, s), s));
  const cached = await kv.get(k);
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
    const card = { id: c.id, localId: c.localId, name: c.name, image: c.image, setId: set.id, setName: set.name, official: set.cardCount?.official, abbr: set.abbreviation?.official };
    try {
      const d = await getJSON('/cards/' + encodeURIComponent(c.id), srcLang(set.id));
      card.variants = d.variants; card.rarity = d.rarity;
      rememberMeta(d);
      setPrice(c.id, d.pricing?.cardmarket);
    } catch { }
    if (!c.image) { // image FR absente (ex. promos récentes) : même illustration en anglais
      if (S.lang !== 'en') try { card.image = (await getJSON('/cards/' + encodeURIComponent(c.id), 'en')).image; } catch { }
    }
    // dernier recours : adresses habituelles des images (fr, en, ja)
    const bases = card.image ? [card.image] : imgBases(c, set.id);
    let img = null;
    for (const b of bases) { try { img = await getImage(b + '/low.webp'); card.image = b; break; } catch { } }
    if (img) {
      try {
        ctx.drawImage(img, 0, 0, FP.W, FP.H);
        card.fp = FP.fingerprint(ctx.getImageData(0, 0, FP.W, FP.H).data);
        tc.getContext('2d').drawImage(img, 0, 0, 126, 176);
        thumbs[c.id] = tc.toDataURL('image/webp', 0.7);
      } catch { noImg++; }
    } else noImg++;
    out.push(card);
    onProg && onProg(++done, cards.length);
  });
  await kv.set(LK('fp:' + set.id), out);
  await kv.set(LK('thumb:' + set.id), thumbs);
  Object.assign(S.thumbs, thumbs);
  await kv.set('prices', S.prices);
  if (!S.fpSets.includes(set.id)) S.fpSets.push(set.id);
  if (!S.thumbSets.includes(set.id)) S.thumbSets.push(set.id);
  await kv.set(LK('fpsets'), S.fpSets); await kv.set(LK('thumbsets'), S.thumbSets);
  S.fpCards = S.fpCards.filter(c => c.setId !== set.id).concat(out);
  afterChange();
  return noImg;
}
// Empreintes sans « couleur fine » (anciennes versions) : recalculées depuis les miniatures, sans réseau
async function upgradeFps() {
  const c = document.createElement('canvas'); c.width = FP.W; c.height = FP.H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let n = 0;
  for (const id of [...S.fpSets]) {
    const cards = (await kv.get(LK('fp:' + id))) || [];
    if (!cards.some(x => x.fp && !x.fp.k)) continue;
    const thumbs = (await kv.get(LK('thumb:' + id))) || {};
    for (const card of cards) {
      if (!card.fp || card.fp.k || !thumbs[card.id]) continue;
      try { ctx.drawImage(await getImage(thumbs[card.id]), 0, 0, FP.W, FP.H); card.fp = FP.fingerprint(ctx.getImageData(0, 0, FP.W, FP.H).data); n++; } catch { }
    }
    await kv.set(LK('fp:' + id), cards);
    S.fpCards = S.fpCards.filter(x => x.setId !== id).concat(cards);
    await new Promise(r => setTimeout(r, 50)); // laisse respirer l'appli entre deux extensions
  }
  return n;
}

// Miniatures seules (extension déjà téléchargée avant leur arrivée) : sans retélécharger prix et empreintes
async function addThumbs(setId, onProg) {
  const cards = (await kv.get(LK('fp:' + setId))) || [], thumbs = {}, tc = document.createElement('canvas');
  tc.width = 126; tc.height = 176;
  let done = 0;
  await pool(cards.filter(c => c.image), 6, async c => {
    try { tc.getContext('2d').drawImage(await getImage(c.image + '/low.webp'), 0, 0, 126, 176); thumbs[c.id] = tc.toDataURL('image/webp', 0.7); } catch { }
    onProg && onProg(++done, cards.length);
  });
  await kv.set(LK('thumb:' + setId), thumbs); Object.assign(S.thumbs, thumbs);
  if (!S.thumbSets.includes(setId)) { S.thumbSets.push(setId); await kv.set(LK('thumbsets'), S.thumbSets); }
}
// Supprime les données téléchargées d'extensions (empreintes, miniatures) : la collection n'est pas touchée
async function removeSetData(ids) {
  const set = new Set(ids);
  for (const id of set) { await kv.del(LK('fp:' + id)); await kv.del(LK('thumb:' + id)); }
  S.fpSets = S.fpSets.filter(id => !set.has(id)); S.thumbSets = S.thumbSets.filter(id => !set.has(id));
  S.fpCards = S.fpCards.filter(c => !set.has(c.setId));
  for (const k of Object.keys(S.thumbs)) if (set.has(setIdOf({ id: k, localId: k.split('-').pop() }))) delete S.thumbs[k];
  await kv.set(LK('fpsets'), S.fpSets); await kv.set(LK('thumbsets'), S.thumbSets);
  if (A.only && set.has(A.only)) A.only = null;
  if (typeof FS !== 'undefined') FS.mini = null;
}
async function loadThumbs(setId) { if (S.thumbSets.includes(setId)) Object.assign(S.thumbs, (await kv.get(LK('thumb:' + setId))) || {}); }

// Changement de langue : catalogue, extensions activées et empreintes de cette langue
async function loadLang(lang) {
  S.lang = LANGS[lang] ? lang : 'fr';
  const g = async (k, d) => (await kv.get(LK(k))) ?? d;
  S.catalog = (await kv.get(LK('catalog'))) || null;
  S.fpSets = await g('fpsets', []); S.thumbSets = await g('thumbsets', []);
  S.fpCards = []; S.thumbs = {};
  for (const id of S.fpSets) S.fpCards.push(...((await kv.get(LK('fp:' + id))) || []));
  document.documentElement.lang = S.lang;
}
async function switchLang(lang) {
  if (lang === S.lang) return;
  kv.set('lang', lang);
  await loadLang(lang);
  if (!S.catalog) loadCatalog().catch(err => toast('Catalogue indisponible : ' + esc(err.message))); else loadDates().catch(() => { });
  $$('.langsel').forEach(x => x.value = S.lang);
  if (S.view === 'coll') renderColl();
  if (S.view === 'scan') { fillScanSets(); retryScan(); }
  toast(`${FLAG[S.lang]} Langue : ${LANGS[S.lang]}`);
}
const langSelect = () => `<select class="langsel" aria-label="Langue des cartes">${Object.entries(LANGS).map(([k, l]) => `<option value="${k}" ${S.lang === k ? 'selected' : ''}>${FLAG[k]} ${l}</option>`).join('')}</select>`;

// ---------- fiche carte ----------
async function openCard(c, onClose) {
  S.sheetClose = onClose; S.pchartVar = null;
  c.setId ||= setIdOf(c); c.setName ||= setName(c.setId);
  renderCard(c);
  if (c.id.startsWith('perso-')) return;
  try { // rafraîchit prix, variantes et infos si en ligne
    const d = await getJSON('/cards/' + encodeURIComponent(c.id), srcLang(c.setId));
    c.variants = d.variants; c.rarity = d.rarity; c.illustrator = d.illustrator; c.name = d.name || c.name; c.image ||= d.image;
    rememberMeta(d);
    if (d.pricing?.cardmarket) { setPrice(c.id, d.pricing.cardmarket, true); kv.set('prices', S.prices); }
    if (!$('#sheet').hidden && S.sheetCard === c) renderCard(c);
  } catch { }
}

function renderCard(c) {
  S.sheetCard = c;
  const p = S.prices[c.id], entries = S.coll.filter(e => e.cardId === c.id && (c.id.startsWith('perso-') || langOf(e) === S.lang)), m = S.meta[c.id], perso = c.id.startsWith('perso-');
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
      <button class="ghost small" id="cm">Voir sur Cardmarket ↗</button>`}
      ${perso ? '' : priceChart(c.id, S.pchartVar || (entries.some(e => e.variant === 'reverse') ? 'reverse' : 'normal'))}
      ${oddsHTML(c)}
      <div class="row"><button class="ghost small" id="v3d">🔮 Vue 3D</button>${!perso && m?.d?.length ? '<button class="ghost small" id="allof">📚 Toutes ses cartes</button>' : ''}</div></div>
    </div>
    <h2>Mes exemplaires (${entries.reduce((a, e) => a + e.qty, 0)})</h2>
    ${entries.map(e => `
      <div class="entry" data-i="${S.coll.indexOf(e)}">
        <div class="row">
          <select data-k="variant">${Object.entries(VARIANTS).map(([k, l]) => `<option value="${k}" ${e.variant === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <select data-k="cond">${FP.CONDS.map(k => `<option value="${k}" ${e.cond === k ? 'selected' : ''}>${FP.COND_LABEL[k]}</option>`).join('')}</select>
          <select data-k="lang" class="langpick">${Object.keys(LANGS).map(k => `<option value="${k}" ${langOf(e) === k ? 'selected' : ''}>${FLAG[k]}</option>`).join('')}</select>
        </div>
        <div class="row">
          <button class="qty" data-d="-1">−</button><b>${e.qty}</b><button class="qty" data-d="1">+</button>
          <input data-k="note" value="${esc(e.note)}" placeholder="1ère éd., Shadowless, tampon, PSA 9…">
        </div>
        <div class="row small">
          <label>Payé (€/u) <input data-k="paid" type="number" min="0" step="0.1" value="${e.paid ?? ''}" class="num"></label>
          <span class="grow"></span><span class="price">${eur(FP.unitPrice(p, e.variant, e.cond, S.coef).trend)}</span>
        </div>
        <div class="row small">
          <span>Gradée</span>
          <select data-g="co"><option value="">non</option>${['PSA', 'PCA', 'CGC', 'BGS', 'CCC', 'SGC', 'ACE', 'TAG', '?'].map(x => `<option ${e.grade?.co === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
          ${e.grade ? `<input data-g="g" type="number" min="1" max="10" step="0.5" value="${e.grade.g ?? ''}" placeholder="Note" class="num"><input data-g="cert" value="${esc(e.grade.cert || '')}" placeholder="N° certificat" class="grow">` : ''}
        </div>
        <div class="row small"><input data-k="tags" list="tag-list" value="${esc((e.tags || []).join(', '))}" placeholder="Étiquettes : deck, cadeau, préférée…" class="grow"></div>
      </div>`).join('') || '<p class="muted">Pas encore dans ta collection.</p>'}
    ${scansHTML(c.id)}
    <datalist id="tag-list">${allTags().map(t => `<option value="${esc(t)}">`).join('')}</datalist>
    <div class="row"><button class="primary" id="add">+ Ajouter un exemplaire</button><button class="ghost" id="close">Fermer</button></div>`;
  $('#sheet').hidden = false;
  $('#v3d').onclick = () => open3D(c);
  $$('[data-pv]').forEach(b => b.onclick = () => { S.pchartVar = b.dataset.pv; renderCard(c); });
  $('#allof') && ($('#allof').onclick = async () => {
    const no = m.d[0], names = await dexNames(); closeSheet(); openPokemon(names[no - 1] || c.name, no);
  });
  $('#cm') && ($('#cm').onclick = () => openExternal(`https://www.cardmarket.com/fr/Pokemon/Products/Search?searchString=${encodeURIComponent(c.name + ' ' + c.localId)}`));
  $('#perso-price') && ($('#perso-price').onchange = e => {
    const v = parseFloat(e.target.value);
    S.prices[c.id] = isFinite(v) && v >= 0 ? { trend: v, avg: v, manual: true } : undefined;
    kv.set('prices', S.prices); afterChange();
  });
  // nouvelle ligne séparée pour pouvoir lui donner un autre état ; les lignes identiques sont fusionnées à la fermeture
  $('#add').onclick = () => { S.coll.push({ cardId: c.id, setId: c.setId, setName: c.setName, localId: c.localId, name: c.name, image: c.image, photo: c.photo, variant: defaultVariant(c), cond: 'NM', qty: 1, note: '', added: Date.now(), ...(S.lang !== 'fr' ? { lang: S.lang } : {}) }); save(); renderCard(c); };
  $('#close').onclick = closeSheet;
  $$('.entry').forEach(row => {
    const e = S.coll[+row.dataset.i];
    row.querySelectorAll('[data-k]').forEach(inp => inp.onchange = () => {
      if (inp.dataset.k === 'paid') { const v = parseFloat(inp.value); if (isFinite(v) && v >= 0) e.paid = v; else delete e.paid; }
      else if (inp.dataset.k === 'tags') { const t = [...new Set(inp.value.split(',').map(x => x.trim()).filter(Boolean))]; if (t.length) e.tags = t; else delete e.tags; }
      else if (inp.dataset.k === 'lang') { if (inp.value === 'fr') delete e.lang; else e.lang = inp.value; save(); return renderCard(c); }
      else e[inp.dataset.k] = inp.value;
      save();
    });
    row.querySelectorAll('[data-g]').forEach(inp => inp.onchange = () => {
      const k = inp.dataset.g;
      if (k === 'co') { if (!inp.value) delete e.grade; else e.grade = { g: null, cert: '', ...e.grade, co: inp.value }; save(); return renderCard(c); }
      if (k === 'g') { const v = parseFloat(inp.value); e.grade.g = isFinite(v) ? v : null; } else e.grade.cert = inp.value.trim();
      save();
    });
    row.querySelectorAll('.qty').forEach(b => b.onclick = () => {
      e.qty += +b.dataset.d;
      if (e.qty <= 0 && !confirm('Retirer cet exemplaire de la collection ?')) e.qty = 1;
      S.coll = S.coll.filter(x => x.qty > 0); save(); renderCard(c);
    });
  });
}

// Courbe de prix : historique noté par l'appli (1 point par jour), complété au début par les moyennes Cardmarket 30 j / 7 j / 1 j
function pricePoints(id, variant = 'normal') {
  const p = S.prices[id], h = (S.phist[id] || []).map(([d, n, r]) => [Date.parse(d), variant === 'reverse' ? r ?? n : n]).filter(x => x[1] != null);
  const pts = [...h];
  if (p && pts.length < 4) {
    const now = Date.now(), DAY = 864e5, rev = variant === 'reverse';
    const est = [[30, rev ? p['avg30-holo'] ?? p.avg30 : p.avg30], [7, rev ? p['avg7-holo'] ?? p.avg7 : p.avg7], [1, rev ? p['avg1-holo'] ?? p.avg1 : p.avg1]]
      .filter(([, v]) => v != null).map(([d, v]) => [now - d * DAY, v, true]);
    const first = pts.length ? pts[0][0] : now;
    pts.unshift(...est.filter(x => x[0] < first - DAY / 2));
    if (!h.length) { const t = rev ? p['trend-holo'] ?? p.trend : p.trend; if (t != null) pts.push([now, t]); }
  }
  return pts.sort((a, b) => a[0] - b[0]);
}
function priceChart(id, variant = 'normal') {
  const pts = pricePoints(id, variant), hasRev = S.prices[id]?.['trend-holo'] != null;
  const tabs = hasRev ? `<span class="grow"></span><button class="chip small ${variant === 'normal' ? 'on' : ''}" data-pv="normal">Normale</button><button class="chip small ${variant === 'reverse' ? 'on' : ''}" data-pv="reverse">Reverse</button>` : '';
  if (pts.length < 2) return `<div id="pchart"><p class="muted small">📈 La courbe du prix se construira jour après jour.</p></div>`;
  const W = 300, H = 90, t0 = pts[0][0], t1 = pts[pts.length - 1][0], vals = pts.map(p => p[1]), min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const xy = pts.map(([t, v]) => [(t - t0) / (t1 - t0 || 1) * W, H - 8 - (v - min) / span * (H - 16)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const ch = (vals[vals.length - 1] - vals[0]) / (vals[0] || 1);
  const dots = xy.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" class="${pts[i][2] ? 'est' : 'pt'}"/>`).join('');
  return `<div id="pchart" class="pchart"><div class="row small"><b>📈 Prix ${variant === 'reverse' ? 'reverse' : ''}</b><span class="${ch >= 0 ? 'up' : 'down'}">&nbsp;${ch >= 0 ? '+' : ''}${Math.round(ch * 100)} %</span>${tabs}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${d} L${W},${H} L0,${H} Z" class="area"/><path d="${d}" class="stroke"/>${dots}</svg>
    <div class="row small muted"><span>${new Date(t0).toLocaleDateString('fr-FR')} · ${eur(vals[0])}</span><span class="grow"></span><span>min ${eur(min)} · max ${eur(max)}</span><span class="grow"></span><span>${eur(vals[vals.length - 1])}</span></div>
    ${pts.some(p => p[2]) ? '<p class="muted small">Points clairs : moyennes Cardmarket sur 30 j, 7 j et 1 j ; ensuite un point par jour.</p>' : ''}</div>`;
}
// Quand la carte a été scannée / ajoutée (jour et heure)
function scansHTML(id) {
  const h = S.hist.filter(x => x.cardId === id).slice(-12).reverse();
  if (!h.length) return '';
  return `<h2>🕒 Scans et ajouts</h2><div class="scans">${h.map(x => `<div class="row small"><span class="grow">${dayTime(x.t)}</span><b class="${x.d > 0 ? 'up' : 'down'}">${x.d > 0 ? '+' : ''}${x.d}</b></div>`).join('')}</div>`;
}

// Chance de tirer la carte dans un booster (extension téléchargée : raretés connues)
function oddsHTML(c) {
  const sid = c.setId || setIdOf(c), cards = S.fpCards.filter(x => x.setId === sid);
  if (c.id.startsWith('perso-')) return '';
  if (!cards.length) return '<p class="muted small">🎲 Active le scan de l\'extension pour voir la chance de tirer cette carte.</p>';
  const st = setInfo(sid), promo = /promo|mcdo|mcdonald/.test(norm(st?.name) + ' ' + norm(st?.serieName));
  const o = LOGIC.packOdds(cards.map(x => ({ ...x, rarity: x.rarity ?? S.meta[x.id]?.r })), c.id, promo);
  if (!o || !o.any) return '';
  const one = p => p >= 0.5 ? Math.round(p * 100) + ' %' : '1 sur ' + Math.round(1 / p);
  return `<div class="odds"><b>🎲 Chance par booster : ${one(o.any)}</b>
    <span>${o.reverse ? `normale ${one(o.normal)} · reverse ${one(o.reverse)} · ` : ''}50 % de chance en ${o.packs50} booster(s), 90 % en ${o.packs90}</span>
    <small>Estimation (taux officiels non publiés)</small></div>`;
}

function closeSheet() {
  const merged = S.coll.reduce((acc, e) => FP.addEntry(acc, e), []);
  if (merged.length !== S.coll.length) { S.coll = merged; save(false); }
  $('#sheet').hidden = true; S.sheetCard = null; S.sheetClose && S.sheetClose();
}
