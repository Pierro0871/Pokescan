'use strict';
// Fun : constructeur de decks, vitrine holo, échange par QR code.

// ---------- decks ----------
const saveDecks = () => kv.set('decks', S.decks);
const KIND_LABEL = { pokemon: 'Pokémon', trainer: 'Dresseurs', energy: 'Énergies' };
const ownedQty = id => S.coll.filter(e => e.cardId === id).reduce((a, e) => a + e.qty, 0);

function renderDecks() {
  const body = $('#boost-body');
  body.innerHTML = `<p class="muted small">Construis des decks de 60 cartes avec tes cartes ou toute la base : PokeScan vérifie les règles et liste ce qui te manque.</p>
    <button class="primary" id="deck-new">+ Nouveau deck</button>
    ${S.decks.map((d, i) => { const r = LOGIC.deckCheck(d.cards, d.format); const miss = d.cards.reduce((a, c) => a + Math.max(0, c.n - ownedQty(c.id)), 0);
      return `<button class="line" data-d="${i}"><span class="grow"><b>${esc(d.name)}</b><br><span class="muted small">${r.total}/60 · ${d.format === 'expanded' ? 'Étendu' : 'Standard'}${miss ? ` · ${miss} manquante(s)` : ' · complet'}</span></span><b class="${r.ok ? 'up' : 'down'}">${r.ok ? '✓ valide' : '⚠︎'}</b></button>`; }).join('')}`;
  $('#deck-new').onclick = () => { S.decks.push({ id: Date.now(), name: 'Deck ' + (S.decks.length + 1), format: 'standard', cards: [] }); saveDecks(); openDeck(S.decks.length - 1); };
  $$('[data-d]').forEach(b => b.onclick = () => openDeck(+b.dataset.d));
}

function openDeck(i) {
  const d = S.decks[i], body = $('#boost-body');
  if (!d) return renderDecks();
  const r = LOGIC.deckCheck(d.cards, d.format);
  const missing = d.cards.map(c => ({ c, k: Math.max(0, c.n - ownedQty(c.id)) })).filter(x => x.k);
  const cost = missing.reduce((a, x) => a + (S.prices[x.c.id]?.trend || 0) * x.k, 0);
  const sec = kind => {
    const list = d.cards.filter(c => LOGIC.kind(c) === kind);
    if (!list.length) return '';
    return `<h2>${KIND_LABEL[kind]} (${list.reduce((a, c) => a + c.n, 0)})</h2>` + list.map(c => {
      const own = ownedQty(c.id), bad = r.illegal.includes(c.id);
      return `<div class="line deckline ${bad ? 'illegal' : ''}"><img src="${esc(imgOf(c))}" alt="" data-open="${esc(c.id)}">
        <span class="grow"><b>${esc(c.name)}</b><br><span class="muted small">${esc(c.setName)} ${esc(c.localId)} · ${own >= c.n ? `<span class="up">✓ j'en ai ${own}</span>` : `<span class="down">manque ${c.n - own}</span>`}${bad ? ' · non autorisée' : ''}</span></span>
        <button class="qty" data-dq="${esc(c.id)}" data-v="-1">−</button><b>${c.n}</b><button class="qty" data-dq="${esc(c.id)}" data-v="1">+</button></div>`;
    }).join('');
  };
  body.innerHTML = `<button class="ghost" id="deck-back">← Decks</button>
    <div class="row"><input id="deck-name" value="${esc(d.name)}" class="grow">
      <select id="deck-format"><option value="standard" ${d.format === 'standard' ? 'selected' : ''}>Standard</option><option value="expanded" ${d.format === 'expanded' ? 'selected' : ''}>Étendu</option></select></div>
    <div class="kpis three"><div><b>${r.counts.pokemon}</b><span>Pokémon</span></div><div><b>${r.counts.trainer}</b><span>Dresseurs</span></div><div><b>${r.counts.energy}</b><span>Énergies</span></div></div>
    <p class="${r.ok ? 'up' : 'down'}"><b>${r.ok ? '✓ Deck valide' : '⚠︎ ' + esc(r.errors.join(' · '))}</b></p>
    ${missing.length ? `<p class="muted">Il te manque <b>${missing.reduce((a, x) => a + x.k, 0)}</b> carte(s) · environ <b>${eur(cost)}</b></p>` : d.cards.length ? '<p class="up">Tu as toutes les cartes de ce deck.</p>' : ''}
    <form id="deck-search" class="row"><input id="deck-q" placeholder="Ajouter une carte (nom)" class="grow" autocomplete="off"><button class="primary">OK</button></form>
    <label class="row small"><input type="checkbox" id="deck-mine" ${S.deckMine ? 'checked' : ''}> Seulement les cartes de ma collection</label>
    <div id="deck-res"></div>
    ${sec('pokemon')}${sec('trainer')}${sec('energy')}
    <div class="row"><button class="ghost" id="deck-copy">Copier la liste</button><span class="grow"></span><button class="ghost down" id="deck-del">Supprimer le deck</button></div>`;
  $('#deck-back').onclick = renderDecks;
  $('#deck-name').onchange = e => { d.name = e.target.value.trim() || d.name; saveDecks(); };
  $('#deck-format').onchange = e => { d.format = e.target.value; saveDecks(); openDeck(i); };
  $('#deck-mine').onchange = e => { S.deckMine = e.target.checked; };
  $('#deck-search').onsubmit = e => { e.preventDefault(); deckSearch(i, $('#deck-q').value.trim()); };
  $$('[data-dq]').forEach(b => b.onclick = () => {
    const c = d.cards.find(x => x.id === b.dataset.dq); c.n += +b.dataset.v;
    d.cards = d.cards.filter(x => x.n > 0); saveDecks(); openDeck(i);
  });
  $$('[data-open]').forEach(im => im.onclick = () => { const c = d.cards.find(x => x.id === im.dataset.open); openCard({ ...c }, () => openDeck(i)); });
  $('#deck-copy').onclick = () => {
    const txt = ['pokemon', 'trainer', 'energy'].map(k => d.cards.filter(c => LOGIC.kind(c) === k).map(c => `${c.n} ${c.name} (${c.setName} ${c.localId})`).join('\n')).filter(Boolean).join('\n\n');
    navigator.clipboard?.writeText(`${d.name}\n\n${txt}`).then(() => toast('Liste copiée'), () => toast('Copie impossible'));
  };
  $('#deck-del').onclick = () => { if (confirm(`Supprimer « ${d.name} » ?`)) { S.decks.splice(i, 1); saveDecks(); renderDecks(); } };
}

async function deckSearch(i, q) {
  const box = $('#deck-res');
  if (!q) return;
  box.innerHTML = '<p class="muted">Recherche…</p>';
  const n = norm(q);
  let cards;
  if (S.deckMine) {
    cards = Object.values(Object.fromEntries(S.coll.filter(e => norm(e.name).includes(n)).map(e => [e.cardId, { id: e.cardId, localId: e.localId, name: e.name, image: e.image, photo: e.photo, setId: e.setId }])));
  } else {
    try { cards = await getJSON('/cards?name=' + encodeURIComponent(q)); }
    catch { cards = S.fpCards.filter(c => norm(c.name).includes(n)); }
  }
  const owned = ownedIds();
  box.innerHTML = cards.length ? `<p class="muted small">Touche une carte pour l'ajouter au deck :</p>${grid(cards.slice(0, 60), owned, c => setName(setIdOf(c)))}` : '<p class="muted">Aucune carte.</p>';
  $$('#deck-res .cell').forEach(b => b.onclick = async () => {
    const c = cards.find(x => x.id === b.dataset.id), d = S.decks[i];
    const ex = d.cards.find(x => x.id === c.id);
    if (ex) { ex.n++; saveDecks(); return openDeck(i); }
    let m = S.meta[c.id];
    if (!m || !m.c) { try { rememberMeta(await getJSON('/cards/' + encodeURIComponent(c.id))); m = S.meta[c.id]; } catch { } }
    const sid = setIdOf(c);
    d.cards.push({ id: c.id, name: c.name, localId: c.localId, image: c.image, photo: c.photo, setId: sid, setName: setName(sid), category: m?.c || (m?.d?.length ? 'Pokémon' : ''), stage: m?.s || '', energyType: m?.e || '', legal: m?.l || null, n: 1 });
    saveDecks(); openDeck(i);
    if (!m?.c) toast('Hors ligne : type de carte inconnu, la vérification sera approximative');
  });
}

// ---------- vitrine (diaporama plein écran, effet holo) ----------
function renderVitrineMenu() {
  const body = $('#boost-body'), tags = allTags();
  const sets = [...new Set(S.coll.map(e => e.setId))].map(id => ({ id, name: setName(id) }));
  body.innerHTML = `<p class="muted small">Tes plus belles cartes en grand. Penche le téléphone pour faire briller l'effet holo.</p>
    <div class="col">
      <button class="primary" data-v="top">✨ Mes cartes les plus chères</button>
      <button class="ghost" data-v="all">Toute ma collection</button>
      ${tags.map(t => `<button class="ghost" data-v="tag:${esc(t)}">🏷️ ${esc(t)}</button>`).join('')}
      ${sets.length ? `<select id="vit-set"><option value="">Une extension…</option>${sets.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>` : ''}
    </div>`;
  const pick = f => {
    const es = S.coll.filter(f), byId = {};
    for (const e of es) byId[e.cardId] ||= { id: e.cardId, localId: e.localId, name: e.name, image: e.image, photo: e.photo, setId: e.setId, setName: e.setName, p: FP.unitPrice(S.prices[e.cardId], e.variant, e.cond, S.coef).trend || 0 };
    return Object.values(byId).sort((a, b) => b.p - a.p);
  };
  $$('[data-v]').forEach(b => b.onclick = () => {
    const v = b.dataset.v;
    const cards = v === 'top' ? pick(() => true).slice(0, 20) : v === 'all' ? pick(() => true) : pick(e => (e.tags || []).includes(v.slice(4)));
    openVitrine(cards);
  });
  $('#vit-set') && ($('#vit-set').onchange = e => e.target.value && openVitrine(pick(x => x.setId === e.target.value)));
}

function openVitrine(cards) {
  if (!cards.length) return toast('Aucune carte à montrer');
  const v = $('#vitrine');
  let i = 0, timer = 0;
  v.hidden = false;
  const draw = () => {
    const c = cards[i];
    v.innerHTML = `<button class="vclose" aria-label="Fermer">✕</button>
      <div class="vstage"><div class="vcard">${imgOf(c, 'high') ? `<img src="${esc(imgOf(c, 'high'))}" alt="">` : `<span class="noimg">${esc(c.name)}</span>`}<i class="holo"></i><i class="glare"></i></div></div>
      <div class="vcap"><b>${esc(c.name)}</b><span>${esc(c.setName || '')} · ${esc(c.localId)}${c.p ? ' · ' + eur(c.p) : ''}</span><small>${i + 1} / ${cards.length}</small></div>`;
    v.querySelector('.vclose').onclick = close;
    clearTimeout(timer); timer = setTimeout(() => go(1), 6000);
  };
  const go = d => { i = (i + d + cards.length) % cards.length; draw(); };
  const tilt = (x, y) => { // x, y entre -1 et 1
    v.style.setProperty('--rx', (-y * 12).toFixed(1) + 'deg'); v.style.setProperty('--ry', (x * 14).toFixed(1) + 'deg');
    v.style.setProperty('--px', (50 + x * 50).toFixed(0) + '%'); v.style.setProperty('--py', (50 + y * 50).toFixed(0) + '%');
  };
  const onOri = e => { if (e.gamma == null) return; tilt(Math.max(-1, Math.min(1, e.gamma / 30)), Math.max(-1, Math.min(1, (e.beta - 45) / 30))); };
  const onMove = e => { const r = v.getBoundingClientRect(); tilt((e.clientX - r.left) / r.width * 2 - 1, (e.clientY - r.top) / r.height * 2 - 1); };
  const onTap = e => { if (e.target.closest('.vclose')) return; go(e.clientX < innerWidth / 3 ? -1 : 1); };
  function close() { clearTimeout(timer); v.hidden = true; v.innerHTML = ''; removeEventListener('deviceorientation', onOri); v.removeEventListener('pointermove', onMove); v.removeEventListener('click', onTap); }
  addEventListener('deviceorientation', onOri);
  v.addEventListener('pointermove', onMove);
  v.addEventListener('click', onTap);
  tilt(0, 0); draw();
}

// ---------- échange par QR code ----------
const QR_CHUNK = 600; // QR moins denses = plus faciles à lire à l'écran
async function packPayload(obj) {
  const data = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(data).arrayBuffer());
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function unpackPayload(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
  const data = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const txt = await new Response(data).text();
  if (txt.length > 2e6) throw new Error('trop gros');
  return JSON.parse(txt);
}
function myTradeData() {
  const st = FP.stats(S.coll, S.prices, S.coef);
  return { owned: ownedIds(), dups: st.dups.map(d => d.id) };
}

function renderTrade() {
  const body = $('#boost-body');
  body.innerHTML = `<p class="muted small">Montre ton QR code à un ami qui a PokeScan : il le scanne et voit tout de suite les échanges possibles entre vous (et inversement).</p>
    <div class="row"><input id="pseudo" placeholder="Ton pseudo" value="${esc(S.pseudo || '')}" class="grow"></div>
    <div class="col"><button class="primary" id="qr-show">Afficher mon QR code</button><button class="ghost" id="qr-scan">📷 Scanner le QR d'un ami</button></div>
    <div id="qr-box"></div>`;
  kv.get('pseudo').then(p => { if (p && !S.pseudo) { S.pseudo = p; $('#pseudo') && ($('#pseudo').value = p); } });
  $('#pseudo').onchange = e => { S.pseudo = e.target.value.trim(); kv.set('pseudo', S.pseudo); };
  $('#qr-show').onclick = showMyQR;
  $('#qr-scan').onclick = scanFriendQR;
}

async function showMyQR() {
  stopQR();
  const me = myTradeData();
  const str = await packPayload({ v: 1, n: S.pseudo || '', o: LOGIC.encodeIds([...me.owned]), d: LOGIC.encodeIds(me.dups) });
  const parts = [];
  for (let k = 0; k < str.length; k += QR_CHUNK) parts.push(str.slice(k, k + QR_CHUNK));
  const codes = parts.map((p, k) => { const q = qrcode(0, 'L'); q.addData(`PS1|${k + 1}|${parts.length}|${p}`); q.make(); return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true }); });
  const box = $('#qr-box');
  let k = 0;
  const draw = () => { box.innerHTML = `<div class="qr">${codes[k]}</div><p class="muted small center">${parts.length > 1 ? `QR ${k + 1}/${parts.length} (défile tout seul, laisse ton ami scanner jusqu'au bout) · ` : ''}${me.owned.size} cartes, ${me.dups.length} doublons</p>`; };
  draw();
  if (parts.length > 1) S.qrTimer = setInterval(() => { k = (k + 1) % parts.length; draw(); }, 1300);
}

async function scanFriendQR() {
  stopQR();
  const box = $('#qr-box');
  box.innerHTML = `<div class="qrcam"><video id="qr-video" playsinline muted></video></div><p class="muted small center" id="qr-msg">Vise le QR code de ton ami…</p>`;
  const video = $('#qr-video');
  try {
    S.qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = S.qrStream; await video.play();
  } catch (err) { box.innerHTML = `<p class="down">Caméra indisponible : ${esc(err.message)}</p>`; return; }
  const parts = {}, c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
  let total = 0;
  const tick = async () => {
    if (!S.qrStream) return;
    if (video.videoWidth) {
      const k = Math.min(1, 720 / video.videoWidth);
      c.width = Math.round(video.videoWidth * k); c.height = Math.round(video.videoHeight * k);
      ctx.drawImage(video, 0, 0, c.width, c.height);
      const r = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' });
      const m = r && r.data.match(/^PS1\|(\d+)\|(\d+)\|([A-Za-z0-9_-]+)$/);
      if (m && +m[2] <= 50 && +m[1] <= +m[2]) {
        total = +m[2]; if (!parts[m[1]]) { parts[m[1]] = m[3]; feedback('found'); }
        const got = Object.keys(parts).length;
        $('#qr-msg').textContent = total > 1 ? `QR ${got}/${total} lus…` : 'Lu !';
        if (got === total) {
          stopQR();
          try { showTrades(await unpackPayload(Array.from({ length: total }, (_, j) => parts[j + 1]).join(''))); }
          catch (err) { box.innerHTML = `<p class="down">QR illisible : ${esc(err.message)}</p>`; }
          return;
        }
      }
    }
    S.qrRaf = requestAnimationFrame(tick);
  };
  tick();
}
function stopQR() {
  clearInterval(S.qrTimer); S.qrTimer = 0;
  cancelAnimationFrame(S.qrRaf);
  S.qrStream?.getTracks().forEach(t => t.stop()); S.qrStream = null;
}

// Données reçues d'un ami (non fiables) -> listes d'échanges
function showTrades(p) {
  if (!p || p.v !== 1 || typeof p.o !== 'string' || typeof p.d !== 'string') throw new Error('ce n\'est pas un QR PokeScan');
  const friend = { owned: new Set(LOGIC.decodeIds(p.o).slice(0, 50000)), dups: LOGIC.decodeIds(p.d).slice(0, 20000) };
  const t = LOGIC.trades(myTradeData(), friend), who = esc(String(p.n || 'Ton ami').slice(0, 40));
  const card = id => {
    const k = id.lastIndexOf('-'), sid = id.slice(0, k), loc = id.slice(k + 1), st = setInfo(sid), mine = S.coll.find(e => e.cardId === id), fp = S.fpCards.find(c => c.id === id);
    return { id, localId: loc, setId: sid, setName: setName(sid), name: mine?.name || fp?.name || `${setName(sid)} ${loc}`, image: mine?.image || fp?.image || (st ? `https://assets.tcgdex.net/fr/${st.serie}/${sid}/${loc}` : '') };
  };
  const give = t.theyCanGive.map(card), get = t.iCanGive.map(card), owned = ownedIds();
  const val = list => eur(list.reduce((a, c) => a + (S.prices[c.id]?.trend || 0), 0));
  $('#qr-box').innerHTML = `<h2>${who} peut te donner (${give.length}) · ${val(give)}</h2>${give.length ? grid(give, owned, c => c.setName) : '<p class="muted">Rien qui te manque dans ses doublons.</p>'}
    <h2>Tu peux lui donner (${get.length}) · ${val(get)}</h2>${get.length ? grid(get, new Set(get.map(c => c.id)), c => c.setName) : '<p class="muted">Aucun de tes doublons ne lui manque.</p>'}
    <p class="muted small">Prix connus seulement pour les cartes des extensions téléchargées.</p>`;
  $$('#qr-box .cell').forEach(b => b.onclick = () => openCard({ ...[...give, ...get].find(c => c.id === b.dataset.id) }, null));
}
