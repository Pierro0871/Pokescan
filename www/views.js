'use strict';
// Écrans : Collection, extension, Pokémon (recherche, Pokédex, illustrateurs), Boosters, Stats, réglages, démarrage.

function show(v) {
  S.view = v;
  $$('.view').forEach(el => el.hidden = el.id !== 'view-' + v);
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'scan') { startCam(); renderSession(); } else stopCam();
  if (v === 'coll') renderColl();
  if (v === 'poke') renderPoke();
  if (v === 'boost') renderBoost();
  if (v === 'stats') renderStats();
}
const grid = (cards, owned, label = c => c.localId) => `<div class="grid">${cards.map(c => `
  <button class="cell ${owned.has(c.id) ? '' : 'miss'}" data-id="${esc(c.id)}">
    ${imgOf(c) ? `<img src="${esc(imgOf(c))}" loading="lazy" alt="">` : `<span class="noimg">${esc(c.name)}</span>`}
    <small>${esc(label(c))}</small></button>`).join('')}</div>`;

// ---------- Collection : liste des extensions ----------
function renderColl() {
  const el = $('#view-coll'), f = S.collF;
  S.redrawColl = renderColl;
  if (!S.catalog) {
    el.innerHTML = '<p class="muted">Chargement des extensions… (connexion internet nécessaire la première fois)</p><button class="primary" id="retry">Réessayer</button>';
    $('#retry').onclick = () => loadCatalog().catch(err => toast('Erreur : ' + esc(err.message)));
    return;
  }
  const sets = allSets(), years = [...new Set(sets.map(LOGIC.year))].filter(y => y !== '—').sort().reverse();
  const persoN = S.coll.filter(e => e.setId === 'perso').reduce((a, e) => a + e.qty, 0);
  el.innerHTML = `<h1>Collection</h1>
    <input id="cf-q" type="search" placeholder="Chercher une extension (ex. Nuit, McDo, promo…)" value="${esc(f.q)}" autocomplete="off">
    <div class="row filters">
      <select id="cf-sort">${[['serie', 'Par série'], ['new', 'Plus récentes'], ['old', 'Plus anciennes'], ['name', 'Nom A→Z'], ['prog', 'Plus avancées'], ['progLow', 'Moins avancées']].map(([k, l]) => `<option value="${k}" ${f.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="cf-serie"><option value="">Toutes séries</option>${S.catalog.map(s => `<option value="${esc(s.id)}" ${f.serie === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <select id="cf-year"><option value="">Toutes années</option>${years.map(y => `<option ${f.year === y ? 'selected' : ''}>${y}</option>`).join('')}</select>
    </div>
    <div class="row">${[['', 'Toutes'], ['started', 'Commencées'], ['done', 'Complètes'], ['none', 'Pas commencées'], ['scan', 'Scan activé']].map(([k, l]) => `<button class="chip ${f.state === k ? 'on' : ''}" data-st="${k}">${l}</button>`).join('')}</div>
    <button class="setrow" id="perso"><span class="sym">✍️</span><span class="grow"><b>Mes cartes perso</b><br><span class="muted small">Cartes absentes de la base, ajoutées à la main</span></span><span class="count">${persoN}</span></button>
    <div id="cf-list"></div>
    <div class="col"><button id="dl-all" class="ghost">Tout télécharger pour le hors ligne…</button>
    <button id="refresh-cat" class="ghost">Mettre à jour la liste des extensions</button></div>
    <p id="dl-all-prog" class="muted small"></p>`;
  const list = () => {
    const owned = {};
    for (const e of S.coll) (owned[e.setId] ||= new Set()).add(e.cardId);
    const cnt = Object.fromEntries(Object.entries(owned).map(([k, v]) => [k, v.size]));
    const groups = LOGIC.groupSets(LOGIC.filterSets(sets, f, cnt, S.fpSets), f.sort, cnt);
    const noDate = (f.sort === 'new' || f.sort === 'old' || f.year) && sets.some(s => !s.releaseDate);
    $('#cf-list').innerHTML = (noDate ? '<p class="muted small">Dates de sortie en cours de chargement…</p>' : '') + (groups.map(g => `
      ${g.title ? `<h2>${esc(g.title)}</h2>` : ''}
      ${g.sets.map(st => {
        const n = cnt[st.id] || 0, tot = LOGIC.total(st), p = Math.round(LOGIC.progress(st, cnt) * 100);
        return `<button class="setrow" data-set="${esc(st.id)}">
          ${st.symbol ? `<img src="${esc(st.symbol)}.png" alt="" loading="lazy">` : '<span class="sym"></span>'}
          <span class="grow"><b>${esc(st.name)}</b>${S.fpSets.includes(st.id) ? ' <span class="ok">scan ✓</span>' : ''}${p === 100 ? ' <span class="ok">★</span>' : ''}
          <span class="muted small">${esc([st.releaseDate && st.releaseDate !== '0000' ? st.releaseDate.slice(0, 4) : '', f.sort !== 'serie' ? st.serieName : ''].filter(Boolean).join(' · '))}</span>
          <span class="bar"><i style="width:${p}%"></i></span></span>
          <span class="count">${n}/${tot}</span></button>`;
      }).join('')}`).join('') || '<p class="muted">Aucune extension ne correspond.</p>');
    $$('#cf-list .setrow').forEach(b => b.onclick = () => openSet(b.dataset.set));
  };
  list();
  $('#cf-q').oninput = e => { f.q = e.target.value; list(); };
  $('#cf-sort').onchange = e => { f.sort = e.target.value; list(); };
  $('#cf-serie').onchange = e => { f.serie = e.target.value; list(); };
  $('#cf-year').onchange = e => { f.year = e.target.value; list(); };
  $$('[data-st]').forEach(b => b.onclick = () => { f.state = b.dataset.st; $$('[data-st]').forEach(x => x.classList.toggle('on', x === b)); list(); });
  $('#perso').onclick = openPerso;
  $('#refresh-cat').onclick = () => loadCatalog().then(() => toast('Liste à jour')).catch(err => toast('Erreur : ' + esc(err.message)));
  $('#dl-all').onclick = downloadAll;
}

// Télécharge toutes les extensions (empreintes, prix, miniatures) : long, à faire en wifi
async function downloadAll() {
  if (S.dlAll) { S.dlAll.stop = true; return; }
  const todo = allSets().filter(s => !S.fpSets.includes(s.id) || !S.thumbSets.includes(s.id));
  if (!todo.length) return toast('Tout est déjà téléchargé');
  const n = todo.reduce((a, s) => a + LOGIC.total(s), 0);
  if (!confirm(`Télécharger ${todo.length} extensions (~${n} cartes, ~${Math.round(n * 9 / 1000)} Mo) ? À faire en wifi, ça peut prendre longtemps. Tu peux arrêter à tout moment.`)) return;
  S.dlAll = { stop: false };
  let i = 0;
  for (const st of todo) {
    if (S.dlAll.stop) break;
    i++;
    const msg = (d, t) => { const p = $('#dl-all-prog'); if (p) p.textContent = `Extension ${i}/${todo.length} : ${st.name} (${d}/${t})… Retouche le bouton pour arrêter.`; };
    try { await downloadSet(await getSet(st.id), msg); } catch { }
  }
  S.dlAll = null;
  const p = $('#dl-all-prog'); if (p) p.textContent = '';
  toast('Téléchargement hors ligne terminé');
  S.redrawColl?.();
}

// ---------- extension : classeur ----------
async function openSet(id, filter = 'all', mode = S.setMode || 'grid', page = 0) {
  const el = $('#view-coll');
  S.redrawColl = () => openSet(id, filter, mode, page);
  if (el.dataset.set !== id) el.innerHTML = '<p class="muted">Chargement…</p>';
  el.dataset.set = id;
  let set;
  try { set = await getSet(id); await loadThumbs(id); } catch { el.innerHTML = '<p>Extension indisponible hors ligne.</p><button class="ghost" id="back">← Retour</button>'; $('#back').onclick = backToList; return; }
  if (S.view !== 'coll') return;
  const owned = ownedIds(), fpImg = Object.fromEntries(S.fpCards.filter(c => c.setId === id).map(c => [c.id, c.image]));
  const cards = (set.cards || []).map(c => c.image || !fpImg[c.id] ? c : { ...c, image: fpImg[c.id] });
  const n = cards.filter(c => owned.has(c.id)).length;
  const shown = cards.filter(c => filter === 'all' || (filter === 'miss') !== owned.has(c.id));
  const ready = S.fpSets.includes(id), v = LOGIC.setValue(cards, owned, S.prices);
  const pages = Math.max(1, Math.ceil(shown.length / 9)); page = Math.min(page, pages - 1);
  el.innerHTML = `
    <button class="ghost" id="back">← Extensions</button>
    <h1>${esc(set.name)}</h1>
    <p class="muted">${n} / ${set.cardCount?.official ?? cards.length} cartes (${cards.length} au total avec les secrètes)${set.releaseDate ? ' · sortie ' + new Date(set.releaseDate).toLocaleDateString('fr-FR') : ''}</p>
    ${v.known ? `<div class="kpis three"><div><b>${eur(v.have)}</b><span>ma valeur</span></div><div><b>${eur(v.all)}</b><span>extension complète</span></div><div><b>${eur(v.missing)}</b><span>pour compléter</span></div></div>
      ${v.known < v.count ? `<p class="muted small">Prix connus pour ${v.known}/${v.count} cartes.</p>` : ''}` : '<p class="muted small">Active le scan pour connaître la valeur de l\'extension et le coût pour la compléter.</p>'}
    <div class="row">
      ${['all:Toutes', 'miss:Manquantes', 'own:Possédées'].map(x => { const [k, l] = x.split(':'); return `<button class="chip ${k === filter ? 'on' : ''}" data-f="${k}">${l}</button>`; }).join('')}
      <span class="grow"></span>
      <button class="chip ${mode === 'grid' ? 'on' : ''}" data-m="grid">Grille</button><button class="chip ${mode === 'pages' ? 'on' : ''}" data-m="pages">Pages</button>
    </div>
    <button class="${ready ? 'ghost' : 'primary'}" id="dl">${ready ? 'Scan prêt ✓ — mettre à jour prix et empreintes' : 'Activer le scan pour cette extension'}</button>
    <p id="dl-prog" class="muted"></p>
    ${mode === 'pages' ? `<div class="binder" id="binder">${grid(shown.slice(page * 9, page * 9 + 9), owned)}</div>
      <div class="row pager"><button class="ghost" id="pp" ${page ? '' : 'disabled'}>‹</button><span class="grow center">Page ${page + 1} / ${pages}</span><button class="ghost" id="pn" ${page < pages - 1 ? '' : 'disabled'}>›</button></div>`
      : grid(shown, owned)}`;
  $('#back').onclick = backToList;
  $$('[data-f]').forEach(b => b.onclick = () => openSet(id, b.dataset.f, mode, 0));
  $$('[data-m]').forEach(b => b.onclick = () => { S.setMode = b.dataset.m; openSet(id, filter, b.dataset.m, 0); });
  if (mode === 'pages') {
    const go = d => openSet(id, filter, mode, page + d);
    $('#pp').onclick = () => go(-1); $('#pn').onclick = () => go(1);
    let x0 = null; const bd = $('#binder');
    bd.ontouchstart = e => x0 = e.touches[0].clientX;
    bd.ontouchend = e => { const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50) { if (dx < 0 && page < pages - 1) go(1); if (dx > 0 && page) go(-1); } };
  }
  $('#dl').onclick = () => downloadSet(set, (d, t) => { const p = $('#dl-prog'); if (p) p.textContent = `Téléchargement ${d} / ${t}…`; })
    .then(noImg => { toast(`${set.name} prête pour le scan` + (noImg ? ` (${noImg} cartes sans image, à ajouter à la main)` : '')); openSet(id, filter, mode, page); })
    .catch(err => toast('Erreur : ' + esc(err.message)));
  $$('#view-coll .cell').forEach(b => b.onclick = () => {
    const c = cards.find(x => x.id === b.dataset.id);
    openCard({ ...c, setId: id, setName: set.name }, () => openSet(id, filter, mode, page));
  });
}
function backToList() { $('#view-coll').dataset.set = ''; renderColl(); }

// ---------- cartes perso ----------
function openPerso() {
  const el = $('#view-coll'), owned = ownedIds();
  S.redrawColl = openPerso;
  const cards = Object.values(Object.fromEntries(S.coll.filter(e => e.setId === 'perso').map(e => [e.cardId, { id: e.cardId, localId: e.localId, name: e.name, photo: e.photo, image: e.image, setId: 'perso', setName: 'Cartes perso' }])));
  el.innerHTML = `<button class="ghost" id="back">← Extensions</button><h1>Mes cartes perso</h1>
    <p class="muted small">Pour les cartes absentes de la base (promos rares, cartes d'événement…). Elles comptent dans tes stats avec le prix que tu indiques.</p>
    <form id="perso-form" class="col card-form">
      <input name="name" placeholder="Nom de la carte *" required>
      <div class="row"><input name="set" placeholder="Extension / origine"><input name="num" placeholder="Numéro" class="num"></div>
      <div class="row"><input name="price" type="number" min="0" step="0.5" placeholder="Prix estimé (€)"><label class="ghost filebtn">📷 Photo<input name="photo" type="file" accept="image/*" capture="environment" hidden></label></div>
      <img id="perso-prev" hidden alt="">
      <button class="primary">Ajouter</button>
    </form>
    ${cards.length ? grid(cards, owned, c => c.name) : ''}`;
  $('#back').onclick = backToList;
  let photo = null;
  $('#perso-form').photo.onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const img = await getImage(URL.createObjectURL(f)), c = document.createElement('canvas'), k = Math.min(1, 400 / img.height);
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    photo = c.toDataURL('image/jpeg', 0.8); $('#perso-prev').src = photo; $('#perso-prev').hidden = false;
  };
  $('#perso-form').onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(e.target), name = String(fd.get('name')).trim();
    if (!name) return;
    const id = 'perso-' + Date.now(), price = parseFloat(fd.get('price'));
    if (isFinite(price) && price >= 0) { S.prices[id] = { trend: price, avg: price, manual: true }; kv.set('prices', S.prices); }
    addCard({ id, localId: String(fd.get('num') || '—'), name, setId: 'perso', setName: 'Cartes perso', photo }, { note: String(fd.get('set') || '') });
    toast(`${esc(name)} ajoutée`); openPerso();
  };
  $$('#view-coll .cell').forEach(b => b.onclick = () => openCard({ ...cards.find(c => c.id === b.dataset.id) }, openPerso));
}

// ---------- Pokémon : recherche, Pokédex, illustrateurs ----------
let DEX = null;
async function dexNames() { return DEX ||= fetch('vendor/pokedex-fr.json').then(r => r.json()).catch(() => []); }
function renderPoke(tab = S.pokeTab || 'search') {
  S.pokeTab = tab;
  const el = $('#view-poke');
  el.innerHTML = `<div class="row tabs2">${[['search', 'Recherche'], ['dex', 'Pokédex'], ['illus', 'Illustrateurs']].map(([k, l]) => `<button class="chip ${tab === k ? 'on' : ''}" data-pt="${k}">${l}</button>`).join('')}</div><div id="poke-body"></div>`;
  $$('[data-pt]').forEach(b => b.onclick = () => renderPoke(b.dataset.pt));
  ({ search: renderSearch, dex: renderDex, illus: renderIllus })[tab]();
}
function renderSearch() {
  $('#poke-body').innerHTML = `<form id="search-form" class="row"><input id="search-q" type="search" placeholder="Nom du Pokémon (ex. Dracaufeu)" autocomplete="off" value="${esc(S.lastQ || '')}"><button class="primary">OK</button></form><div id="search-res"></div>`;
  $('#search-form').onsubmit = e => { e.preventDefault(); search($('#search-q').value.trim()); };
  if (S.lastQ) search(S.lastQ);
}
async function search(q, by = 'name') {
  const el = $('#search-res');
  if (!q || !el) return;
  if (by === 'name') S.lastQ = q;
  el.innerHTML = '<p class="muted">Recherche…</p>';
  let cards;
  try { cards = await getJSON(`/cards?${by}=` + encodeURIComponent(q)); }
  catch { // hors ligne : extensions téléchargées + collection
    const n = norm(q), seen = new Set();
    cards = [...S.fpCards, ...S.coll.map(e => ({ id: e.cardId, localId: e.localId, name: e.name, image: e.image, photo: e.photo, setId: e.setId }))]
      .filter(c => (by === 'name' ? norm(c.name).includes(n) : norm(S.meta[c.id]?.i) === n) && !seen.has(c.id) && seen.add(c.id));
  }
  const owned = ownedIds();
  const n = cards.filter(c => owned.has(c.id)).length;
  el.innerHTML = `<p class="muted">${cards.length} cartes · ${n} possédées</p>${grid(cards, owned, c => setName(setIdOf(c)))}`;
  $$('#search-res .cell').forEach(b => b.onclick = () => openCard({ ...cards.find(c => c.id === b.dataset.id) }, () => search(q, by)));
}
async function renderDex() {
  const body = $('#poke-body'), names = await dexNames();
  const have = new Set(), gens = [[1, 151], [152, 251], [252, 386], [387, 493], [494, 649], [650, 721], [722, 809], [810, 905], [906, 1025]];
  for (const id of ownedIds()) for (const d of S.meta[id]?.d || []) have.add(d);
  const missingMeta = [...ownedIds()].filter(id => !S.meta[id] && !id.startsWith('perso-')).length;
  const g = S.dexGen ?? 0, [a, b] = gens[g];
  body.innerHTML = `<p><b>${have.size}</b> / 1025 Pokémon dans ta collection</p>
    ${missingMeta ? `<p class="muted small">${missingMeta} carte(s) sans infos : elles seront comptées une fois en ligne.</p>` : ''}
    <div class="row">${gens.map(([x, y], i) => { const n = [...have].filter(d => d >= x && d <= y).length; return `<button class="chip ${g === i ? 'on' : ''}" data-g="${i}">${i + 1}G ${n}/${y - x + 1}</button>`; }).join('')}</div>
    <div class="dex">${Array.from({ length: b - a + 1 }, (_, k) => a + k).map(d => `<button class="dexcell ${have.has(d) ? 'got' : ''}" data-n="${esc(names[d - 1] || '')}"><small>#${d}</small><span>${esc(names[d - 1] || '?')}</span></button>`).join('')}</div>`;
  $$('[data-g]').forEach(x => x.onclick = () => { S.dexGen = +x.dataset.g; renderDex(); });
  $$('.dexcell').forEach(x => x.onclick = () => { if (!x.dataset.n) return; S.lastQ = x.dataset.n; renderPoke('search'); });
}
function renderIllus() {
  const by = {};
  for (const e of S.coll) { const i = S.meta[e.cardId]?.i; if (i) (by[i] ||= new Set()).add(e.cardId); }
  const list = Object.entries(by).sort((a, b) => b[1].size - a[1].size);
  $('#poke-body').innerHTML = `<form id="il-form" class="row"><input id="il-q" type="search" placeholder="Nom d'un illustrateur (ex. Mitsuhiro Arita)"><button class="primary">OK</button></form>
    <h2>Dans ta collection</h2>
    ${list.map(([n, s]) => `<button class="line" data-il="${esc(n)}"><span class="grow">${esc(n)}</span><b>${s.size}</b></button>`).join('') || '<p class="muted">Les illustrateurs apparaissent une fois les infos des cartes chargées (en ligne).</p>'}
    <div id="search-res"></div>`;
  const go = n => { $('#poke-body').querySelectorAll('.line,h2').forEach(x => x.remove()); search(n, 'illustrator'); };
  $('#il-form').onsubmit = e => { e.preventDefault(); const n = $('#il-q').value.trim(); if (n) go(n); };
  $$('[data-il]').forEach(b => b.onclick = () => go(b.dataset.il));
}

// ---------- Boosters : vrais (journal) et fictifs ----------
function renderBoost(tab = S.boostTab || 'sim') {
  S.boostTab = tab;
  const el = $('#view-boost');
  el.innerHTML = `<h1>Boosters</h1><div class="row tabs2">${[['sim', 'Booster fictif'], ['real', 'Mes ouvertures']].map(([k, l]) => `<button class="chip ${tab === k ? 'on' : ''}" data-bt="${k}">${l}</button>`).join('')}</div><div id="boost-body"></div>`;
  $$('[data-bt]').forEach(b => b.onclick = () => renderBoost(b.dataset.bt));
  (tab === 'sim' ? renderSim : renderReal)();
}
const setOptions = (sel, onlyReady) => allSets().filter(s => !onlyReady || S.fpSets.includes(s.id))
  .map(s => `<option value="${esc(s.id)}" ${sel === s.id ? 'selected' : ''}>${esc(s.name)}${S.fpSets.includes(s.id) ? '' : ' (non téléchargée)'}</option>`).join('');

function renderSim() {
  const body = $('#boost-body');
  body.innerHTML = `<p class="muted small">Ouvre un booster virtuel de n'importe quelle extension, promos et McDo compris. Taux de tirage estimés selon la rareté.</p>
    <div class="row"><select id="sim-set" class="grow">${setOptions(S.simSet)}</select><button class="primary" id="sim-go">Ouvrir</button></div>
    <div id="pack"></div>`;
  $('#sim-go').onclick = async () => {
    const id = S.simSet = $('#sim-set').value;
    if (!S.fpSets.includes(id)) {
      if (!confirm('Il faut d\'abord télécharger cette extension (raretés et images). Télécharger maintenant ?')) return;
      $('#pack').innerHTML = '<p class="muted" id="sim-prog">Téléchargement…</p>';
      try { await downloadSet(await getSet(id), (d, t) => { const p = $('#sim-prog'); if (p) p.textContent = `Téléchargement ${d}/${t}…`; }); } catch (err) { return toast('Erreur : ' + esc(err.message)); }
    }
    const cards = S.fpCards.filter(c => c.setId === id).map(c => ({ ...c, rarity: c.rarity ?? S.meta[c.id]?.r }));
    await loadThumbs(id);
    const st = setInfo(id), promo = /promo|mcdo|mcdonald/i.test(norm(st?.name) + ' ' + norm(st?.serieName));
    openPack(LOGIC.drawBooster(cards, Math.random, promo), st?.name || id);
  };
}
// Animation : cartes face cachée, on les retourne une par une ; la plus rare en dernier
function openPack(pack, name) {
  const box = $('#pack');
  const val = pack.reduce((a, x) => a + (FP.unitPrice(S.prices[x.card.id], x.reverse ? 'reverse' : 'normal', 'NM', S.coef).trend || 0), 0);
  box.innerHTML = `<div class="pack">${pack.map((x, i) => `<button class="pcard ${x.hit ? 'hit' : ''}" data-i="${i}" style="animation-delay:${i * 60}ms">
      <span class="back"></span><span class="front">${imgOf(x.card) ? `<img src="${esc(imgOf(x.card))}" alt="">` : `<i>${esc(x.card.name)}</i>`}${x.reverse ? '<em>Reverse</em>' : ''}</span></button>`).join('')}</div>
    <div class="row"><button class="ghost" id="flip-all">Tout retourner</button><span class="grow"></span><b id="pack-val" hidden>${eur(val)}</b></div>`;
  let left = pack.length;
  const flip = b => {
    if (b.classList.contains('open')) return openCard({ ...pack[+b.dataset.i].card }, null);
    b.classList.add('open'); left--;
    if (b.classList.contains('hit')) feedback('found');
    if (!left) { $('#pack-val').hidden = false; feedback('add'); }
  };
  box.querySelectorAll('.pcard').forEach(b => b.onclick = () => flip(b));
  $('#flip-all').onclick = () => box.querySelectorAll('.pcard:not(.open)').forEach((b, i) => setTimeout(() => flip(b), i * 120));
}

function renderReal() {
  const body = $('#boost-body'), list = [...S.boosters].reverse();
  const paid = list.reduce((a, b) => a + (b.paid || 0), 0), val = list.reduce((a, b) => a + boosterValue(b), 0);
  body.innerHTML = `<p class="muted small">Tu ouvres un vrai booster ? Lance une ouverture puis scanne ses cartes : PokeScan calcule s'il était rentable.</p>
    <div class="row"><select id="real-set" class="grow">${setOptions(S.realSet, false)}</select></div>
    <div class="row"><input id="real-paid" type="number" min="0" step="0.1" placeholder="Prix payé (€)" class="grow"><button class="primary" id="real-go">J'ouvre un booster</button></div>
    ${list.length ? `<div class="kpis"><div><b>${list.length}</b><span>boosters notés</span></div><div><b class="${val >= paid ? 'up' : 'down'}">${eur(val - paid)}</b><span>bilan (${eur(val)} pour ${eur(paid)})</span></div></div>` : ''}
    ${list.map(b => { const v = boosterValue(b); return `<div class="line"><span class="grow"><b>${esc(setName(b.setId))}</b><br><span class="muted small">${new Date(b.t).toLocaleDateString('fr-FR')} · ${b.cards.length} cartes${b.paid ? ' · payé ' + eur(b.paid) : ''}</span></span><b class="${!b.paid || v >= b.paid ? 'up' : 'down'}">${eur(v)}</b></div>`; }).join('')}`;
  $('#real-go').onclick = () => {
    const id = S.realSet = $('#real-set').value, p = parseFloat($('#real-paid').value);
    startBooster(id, isFinite(p) && p >= 0 ? p : null);
  };
}

// ---------- Stats ----------
function renderStats() {
  const st = FP.stats(S.coll, S.prices, S.coef), el = $('#view-stats');
  const byId = Object.fromEntries(S.coll.map(e => [e.cardId, e]));
  const withPaid = S.coll.filter(e => e.paid != null);
  const invested = withPaid.reduce((a, e) => a + e.paid * e.qty, 0);
  const worth = withPaid.reduce((a, e) => a + (FP.unitPrice(S.prices[e.cardId], e.variant, e.cond, S.coef).trend || 0) * e.qty, 0);
  const moves = [...new Set(S.coll.map(e => e.cardId))].map(id => ({ id, ch: LOGIC.priceChange(S.prices[id]), p: S.prices[id]?.trend || 0 }))
    .filter(x => x.ch != null && x.p >= 0.5).sort((a, b) => b.ch - a.ch);
  const rar = {}, typ = {};
  for (const e of S.coll) { const m = S.meta[e.cardId]; if (!m) continue; rar[m.r || 'Inconnue'] = (rar[m.r || 'Inconnue'] || 0) + e.qty; for (const t of m.t || []) typ[t] = (typ[t] || 0) + e.qty; }
  const bars = o => { const a = Object.entries(o).sort((x, y) => y[1] - x[1]), max = a[0]?.[1] || 1; return a.map(([k, n]) => `<div class="hbar"><span>${esc(k)}</span><i style="width:${n / max * 100}%"></i><b>${n}</b></div>`).join(''); };
  const ach = LOGIC.achievements(achState(st));
  const line = (e, right) => `<button class="line" data-id="${esc(e.cardId)}"><span class="grow">${esc(e.name)} <span class="muted">${esc(e.setName)} ${esc(e.localId)}</span></span>${right}</button>`;
  el.innerHTML = `
    <h1>Stats</h1>
    <div class="kpis">
      <div><b>${st.unique}</b><span>cartes différentes</span></div>
      <div><b>${st.qty}</b><span>cartes au total</span></div>
      <div><b>${eur(st.trend)}</b><span>valeur (tendance)</span></div>
      <div><b>${eur(st.avg)}</b><span>valeur (moyenne)</span></div>
      ${withPaid.length ? `<div><b>${eur(invested)}</b><span>payé (${withPaid.length} lignes)</span></div><div><b class="${worth >= invested ? 'up' : 'down'}">${eur(worth - invested)}</b><span>plus-value</span></div>` : ''}
    </div>
    <h2>Valeur dans le temps</h2>${valueChart()}
    <div class="row"><button class="ghost" id="share-img">📤 Partager ma collection (image)</button></div>
    <h2>Les plus chères</h2>
    ${st.top.filter(t => t.u.trend).map(t => line(t.e, `<b>${eur(t.u.trend)}</b>`)).join('') || '<p class="muted">Aucun prix connu pour l\'instant.</p>'}
    <h2>Plus fortes hausses (7 jours)</h2>
    ${moves.filter(m => m.ch > 0).slice(0, 5).map(m => line(byId[m.id], `<b class="up">${pct(m.ch)}</b>`)).join('') || '<p class="muted">Rien de notable.</p>'}
    <h2>Plus fortes baisses (7 jours)</h2>
    ${moves.filter(m => m.ch < 0).slice(-5).reverse().map(m => line(byId[m.id], `<b class="down">${pct(m.ch)}</b>`)).join('') || '<p class="muted">Rien de notable.</p>'}
    <h2>Doublons (${st.dups.reduce((a, d) => a + d.extra, 0)} à échanger)</h2>
    ${st.dups.map(d => line(byId[d.id], `<b>+${d.extra}</b>`)).join('') || '<p class="muted">Pas de doublon.</p>'}
    <h2>Par rareté</h2>${bars(rar) || '<p class="muted small">Infos chargées en ligne.</p>'}
    <h2>Par type</h2>${bars(typ) || '<p class="muted small">Infos chargées en ligne.</p>'}
    <h2>Succès (${ach.filter(a => a.done).length}/${ach.length})</h2>
    <div class="ach">${ach.map(a => `<div class="${a.done ? 'done' : ''}"><b>${a.done ? '🏆' : '🔒'} ${esc(a.name)}</b><span>${esc(a.desc)}</span>${a.done ? '' : `<i style="width:${a.cur / a.goal * 100}%"></i>`}</div>`).join('')}</div>
    <h2>Historique</h2>
    ${histHTML()}
    <h2>Réglages</h2>
    <div class="row"><span class="grow">Thème</span>${[['auto', 'Auto'], ['dark', 'Sombre'], ['light', 'Clair']].map(([k, l]) => `<button class="chip ${S.theme === k ? 'on' : ''}" data-th="${k}">${l}</button>`).join('')}</div>
    <p class="muted small">Coefficients de prix selon l'état (estimation appliquée au prix Near Mint de Cardmarket) :</p>
    <div class="coefs">${FP.CONDS.map(k => `<label>${FP.COND_LABEL[k]}<input type="number" min="0" max="200" step="5" data-c="${k}" value="${Math.round(S.coef[k] * 100)}">%</label>`).join('')}</div>
    <h2>Export &amp; sauvegarde</h2>
    <div class="col">
      <button class="primary" id="csv">Exporter en CSV (Excel)</button>
      <button class="primary" id="bak">Sauvegarder la collection (fichier)</button>
      <button class="ghost" id="imp">Restaurer une sauvegarde</button>
    </div>
    <h2>Application</h2>
    <div class="row"><span class="grow muted">PokeScan v${VERSION || 'dev'}</span><button class="ghost" id="upd">Vérifier les mises à jour</button></div>`;
  $('#upd').onclick = () => checkUpdate(true);
  $$('#view-stats .line[data-id]').forEach(b => b.onclick = () => {
    const e = byId[b.dataset.id]; openCard({ id: e.cardId, localId: e.localId, name: e.name, image: e.image, photo: e.photo, setId: e.setId, setName: e.setName }, renderStats);
  });
  $$('[data-c]').forEach(i => i.onchange = () => {
    const v = Number(i.value);
    if (!(v >= 0 && v <= 200)) return renderStats();
    S.coef[i.dataset.c] = v / 100; kv.set('coef', S.coef); afterChange(); renderStats();
  });
  $$('[data-th]').forEach(b => b.onclick = () => { S.theme = b.dataset.th; kv.set('theme', S.theme); applyTheme(); renderStats(); });
  $('#share-img').onclick = shareImage;
  const day = today();
  $('#csv').onclick = () => saveFile(`pokescan-${day}.csv`, FP.toCSV(S.coll, S.prices, S.coef), 'text/csv');
  $('#bak').onclick = () => saveFile(`pokescan-sauvegarde-${day}.json`, JSON.stringify({ app: 'PokeScan', version: 2, date: new Date().toISOString(), coll: S.coll, coef: S.coef, prices: S.prices, hist: S.hist, valhist: S.valhist, boosters: S.boosters }), 'application/json');
  $('#imp').onclick = () => $('#import-file').click();
  $('#hist-more') && ($('#hist-more').onclick = () => { S.histN = (S.histN || 30) + 50; renderStats(); });
}

function valueChart() {
  const pts = Object.entries(S.valhist).sort(([a], [b]) => a.localeCompare(b));
  if (pts.length < 2) return '<p class="muted small">La courbe se construit jour après jour (une valeur par jour d\'ouverture).</p>';
  const W = 340, H = 120, vals = pts.map(p => p[1]), min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const xy = pts.map(([, v], i) => [i / (pts.length - 1) * W, H - 8 - (v - min) / span * (H - 16)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${d} L${W},${H} L0,${H} Z" class="area"/><path d="${d}" class="stroke"/></svg>
    <div class="row small muted"><span>${new Date(pts[0][0]).toLocaleDateString('fr-FR')} · ${eur(vals[0])}</span><span class="grow"></span><span>${eur(vals[vals.length - 1])}</span></div>`;
}

function histHTML() {
  const n = S.histN || 30, items = [...S.hist].reverse().slice(0, n);
  if (!items.length) return '<p class="muted">Rien pour l\'instant.</p>';
  let day = '';
  return items.map(h => {
    const d = new Date(h.t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }), head = d !== day ? `<h3>${d}</h3>` : '';
    day = d;
    return head + `<button class="line" data-id="${esc(h.cardId)}"><span class="grow">${esc(h.name)} <span class="muted">${esc(h.setName)} ${esc(h.localId)}</span></span><b class="${h.d > 0 ? 'up' : 'down'}">${h.d > 0 ? '+' : ''}${h.d}</b></button>`;
  }).join('') + (S.hist.length > n ? '<button class="ghost" id="hist-more">Voir plus</button>' : '');
}

// Données pour les succès
function achState(st) {
  const owned = {};
  for (const e of S.coll) (owned[e.setId] ||= new Set()).add(e.cardId);
  const done = allSets().filter(s => LOGIC.total(s) && (owned[s.id]?.size || 0) >= LOGIC.total(s)).length;
  const dex = new Set();
  for (const id of ownedIds()) for (const d of S.meta[id]?.d || []) dex.add(d);
  const maxCard = Math.max(0, ...st.top.map(t => t.u.trend || 0));
  return { qty: st.qty, unique: st.unique, value: st.trend, setsDone: done, species: dex.size, kanto: [...dex].filter(d => d <= 151).length, dups: st.dups.reduce((a, d) => a + d.extra, 0), boosters: S.boosters.length, maxCard };
}
function checkAchievements(st) {
  const done = LOGIC.achievements(achState(st)).filter(a => a.done);
  const fresh = done.filter(a => !S.ach.includes(a.id));
  if (!fresh.length) return;
  S.ach.push(...fresh.map(a => a.id)); kv.set('ach', S.ach);
  if (S.achReady) { toast(`🏆 Succès débloqué : <b>${esc(fresh[0].name)}</b>`); feedback('found'); }
}

// ---------- partage : image de la collection ----------
async function shareImage() {
  const st = FP.stats(S.coll, S.prices, S.coef), top = st.top.slice(0, 9);
  const W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'), dark = document.documentElement.dataset.theme !== 'light';
  x.fillStyle = dark ? '#0f1115' : '#f6f7fb'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#ffcb05'; x.font = 'bold 64px system-ui, sans-serif'; x.fillText('Ma collection Pokémon', 60, 110);
  x.fillStyle = dark ? '#eef0f4' : '#111'; x.font = 'bold 44px system-ui, sans-serif';
  x.fillText(`${st.qty} cartes · ${st.unique} différentes`, 60, 190);
  x.fillText(`Valeur : ${eur(st.trend)}`, 60, 250);
  const cw = 300, chh = 418, gx = 30, ox = (W - 3 * cw - 2 * gx) / 2;
  for (let i = 0; i < top.length; i++) {
    const e = top[i].e, px = ox + (i % 3) * (cw + gx), py = 300 + Math.floor(i / 3) * (chh + 20);
    try { x.drawImage(await getImage(imgOf({ ...e, id: e.cardId })), px, py, cw, chh); } catch { x.strokeStyle = '#555'; x.strokeRect(px, py, cw, chh); }
  }
  x.fillStyle = '#8b92a3'; x.font = '28px system-ui, sans-serif'; x.fillText('PokeScan', W - 190, H - 30);
  const data = c.toDataURL('image/png');
  await saveFile(`ma-collection-${today()}.png`, data.split(',')[1], 'image/png', true);
}

async function saveFile(name, text, mime, base64 = false) {
  try {
    if (NATIVE) {
      const r = await Capacitor.nativePromise('Filesystem', 'writeFile', { path: name, data: text, directory: 'CACHE', ...(base64 ? {} : { encoding: 'utf8' }) });
      await Capacitor.nativePromise('Share', 'share', { title: name, files: [r.uri] });
    } else {
      const a = document.createElement('a');
      a.href = base64 ? `data:${mime};base64,${text}` : URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; a.click();
    }
  } catch (err) { if (!/cancel/i.test(err.message)) toast('Erreur : ' + esc(err.message)); }
}

async function importBackup(ev) {
  const f = ev.target.files[0]; ev.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    const okEntry = e => e && typeof e.cardId === 'string' && typeof e.setId === 'string' && Number.isInteger(e.qty) && e.qty > 0
      && e.variant in VARIANTS && FP.CONDS.includes(e.cond) && (e.paid == null || typeof e.paid === 'number') && (e.photo == null || /^data:image\//.test(e.photo));
    if (d.app !== 'PokeScan' || !Array.isArray(d.coll) || !d.coll.every(okEntry)) throw new Error('fichier non reconnu');
    if (!confirm(`Remplacer ta collection actuelle (${S.coll.length} lignes) par la sauvegarde du ${new Date(d.date).toLocaleDateString('fr-FR')} (${d.coll.length} lignes) ?`)) return;
    S.coll = d.coll.map(e => ({ ...e, note: String(e.note || ''), name: String(e.name || ''), localId: String(e.localId || '') }));
    if (d.coef) S.coef = { ...FP.DEFAULT_COEF, ...d.coef };
    if (d.prices && typeof d.prices === 'object') S.prices = { ...d.prices, ...S.prices };
    if (Array.isArray(d.hist)) S.hist = d.hist;
    if (d.valhist && typeof d.valhist === 'object') S.valhist = { ...d.valhist, ...S.valhist };
    if (Array.isArray(d.boosters)) S.boosters = d.boosters;
    await Promise.all([save(), kv.set('coef', S.coef), kv.set('prices', S.prices), kv.set('hist', S.hist), kv.set('valhist', S.valhist), kv.set('boosters', S.boosters)]);
    toast('Sauvegarde restaurée'); renderStats(); backfill();
  } catch (err) { toast('Restauration impossible : ' + esc(err.message)); }
}

// ---------- thème ----------
function applyTheme() {
  const light = S.theme === 'light' || (S.theme === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
}

// ---------- mises à jour ----------
const REPO = 'Pierro0871/Pokescan', VERSION = window.APP_VERSION || 0;
async function checkUpdate(manual) {
  try {
    const url = `https://api.github.com/repos/${REPO}/releases/latest`;
    let rel = NATIVE ? await nativeGet(url, 'json') : await (await fetch(url)).json();
    if (typeof rel === 'string') rel = JSON.parse(rel);
    const n = parseInt(String(rel.tag_name).replace(/\D/g, ''), 10), apk = rel.assets?.find(a => a.name.endsWith('.apk'));
    if (n > VERSION && apk) {
      const b = $('#update');
      b.innerHTML = `<span>Nouvelle version v${n} disponible</span><button>Installer</button>`; b.hidden = false;
      b.querySelector('button').onclick = () => installUpdate(apk.browser_download_url, b);
    } else if (manual) toast(`PokeScan est à jour (v${VERSION})`);
  } catch (err) { if (manual) toast('Vérification impossible : ' + esc(err.message)); }
}
async function installUpdate(url, b) {
  if (!NATIVE) return void (location.href = url);
  b.innerHTML = '<span>Téléchargement de la mise à jour…</span>';
  try { await Capacitor.nativePromise('ApkUpdater', 'install', { url }); b.hidden = true; }
  catch (err) { b.innerHTML = `<span>Échec : ${esc(err.message)}</span><button>Réessayer</button>`; b.querySelector('button').onclick = () => installUpdate(url, b); }
}

// ---------- démarrage ----------
async function init() {
  navigator.storage?.persist?.();
  const g = async (k, d) => (await kv.get(k)) ?? d;
  S.coll = await g('coll', []);
  lastSaved = JSON.stringify(S.coll);
  S.prices = await g('prices', {});
  S.coef = { ...FP.DEFAULT_COEF, ...(await g('coef', {})) };
  S.catalog = await kv.get('catalog');
  S.fpSets = await g('fpsets', []);
  S.thumbSets = await g('thumbsets', []);
  S.meta = await g('meta', {}); S.hist = await g('hist', []); S.valhist = await g('valhist', {});
  S.boosters = await g('boosters', []); S.ach = await g('ach', []); S.theme = await g('theme', 'auto');
  applyTheme(); matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);
  for (const id of S.fpSets) S.fpCards.push(...((await kv.get('fp:' + id)) || []));
  $$('#tabs button').forEach(b => b.onclick = () => show(b.dataset.view));
  $('#sheet').onclick = e => { if (e.target.id === 'sheet') closeSheet(); };
  $('#import-file').onchange = importBackup;
  $('#undo').onclick = () => doUndo(true); $('#redo').onclick = () => doUndo(false);
  bindScanUI();
  updateUndoUI();
  show('scan');
  if (!S.catalog) loadCatalog().catch(() => { }); else loadDates().catch(() => { });
  afterChange();
  setTimeout(() => { S.achReady = true; }, 1500); // pas de toast pour les succès déjà acquis au démarrage
  backfill().catch(() => { });
  if (NATIVE) checkUpdate(false);
}
init();
