// Logique pure de la collection (tri des extensions, boosters, succès…). Testée sous Node.
(function (root) {
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const year = st => (st.releaseDate || '').slice(0, 4) || '—';

  // ---------- extensions ----------
  // sets : [{ id, name, serie, serieName, releaseDate, cardCount }] ; owned : { setId: nb de cartes possédées }
  function filterSets(sets, f, owned, scanSets) {
    const q = norm(f.q);
    return sets.filter(st => {
      const n = owned[st.id] || 0, tot = total(st);
      if (q && !norm(st.name).includes(q) && !norm(st.serieName).includes(q)) return false;
      if (f.serie && st.serie !== f.serie) return false;
      if (f.year && year(st) !== f.year) return false;
      if (f.state === 'started' && !(n > 0 && n < tot)) return false;
      if (f.state === 'done' && !(tot && n >= tot)) return false;
      if (f.state === 'none' && n > 0) return false;
      if (f.state === 'scan' && !scanSets.includes(st.id)) return false;
      return true;
    });
  }
  const total = st => st.cardCount?.official || st.cardCount?.total || 0;
  const progress = (st, owned) => total(st) ? Math.min(1, (owned[st.id] || 0) / total(st)) : 0;

  // Renvoie des groupes [{ title, sets }] selon le tri choisi
  function groupSets(sets, sort, owned) {
    const by = (key, dir) => [...sets].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * dir);
    const date = st => st.releaseDate || '0000';
    const grp = (list, key) => {
      const out = [];
      for (const st of list) { const t = key(st); if (!out.length || out[out.length - 1].title !== t) out.push({ title: t, sets: [] }); out[out.length - 1].sets.push(st); }
      return out;
    };
    if (sort === 'new') return grp(by(date, -1), year);
    if (sort === 'old') return grp(by(date, 1), year);
    if (sort === 'name') return [{ title: '', sets: by(st => norm(st.name), 1) }];
    if (sort === 'prog') return [{ title: '', sets: by(st => [1 - progress(st, owned), norm(st.name)].join(), 1) }];
    if (sort === 'progLow') return [{ title: '', sets: by(st => [progress(st, owned), norm(st.name)].join(), 1) }];
    return grp(sets, st => st.serieName); // ordre du catalogue (série)
  }

  // ---------- ajout rapide par numéro ----------
  // "045/198" -> { num: 45, tot: 198 } ; "Nuit Noire 45" -> { q: 'nuit noire', num: 45 }
  function parseQuick(text) {
    const t = String(text).trim();
    let m = t.match(/^(.*?)\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*$/);
    if (m) return { q: norm(m[1]), num: +m[2], tot: +m[3] };
    m = t.match(/^(.*\S)\s+([A-Za-z]{0,3}\d{1,3})$/);
    if (m) return { q: norm(m[1]), num: +m[2].replace(/\D/g, ''), tot: null };
    return null;
  }
  const localNum = c => parseInt(String(c.localId).replace(/^\D+/, ''), 10);

  // ---------- valeur ----------
  // Variation de prix (tendance vs moyenne 7 jours de Cardmarket)
  function priceChange(p) {
    if (!p || !p.trend || !p.avg7) return null;
    return (p.trend - p.avg7) / p.avg7;
  }
  // cards : cartes d'une extension ; renvoie valeur possédée / totale / coût pour compléter (prix tendance NM)
  function setValue(cards, owned, prices) {
    let have = 0, all = 0, missing = 0, known = 0;
    for (const c of cards) {
      const t = prices[c.id]?.trend;
      if (t == null) continue;
      known++; all += t;
      if (owned.has(c.id)) have += t; else missing += t;
    }
    return { have, all, missing, known, count: cards.length };
  }

  // ---------- historique ----------
  // Différences de quantité par carte entre deux états de la collection
  function diffColl(before, after) {
    const q = list => { const m = {}; for (const e of list) m[e.cardId] = (m[e.cardId] || 0) + e.qty; return m; };
    const a = q(before), b = q(after), out = [];
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = (b[id] || 0) - (a[id] || 0);
      if (d) out.push({ cardId: id, d });
    }
    return out;
  }

  // ---------- raretés ----------
  // Niveau 0 commune … 5 secrète/spéciale (noms de raretés TCGdex FR et EN)
  function rarityTier(r) {
    const s = norm(r);
    if (!s || s === 'aucune' || s === 'none') return -1;
    if (/peu commune|uncommon/.test(s)) return 1;
    if (/commune|common/.test(s)) return 0;
    if (/speciale|special|hyper|secrete|secret|magnifique|gold|doree|ultra rare illustration|chromatique/.test(s)) return 5;
    if (/ultra|illustration|full art|arc-en-ciel|rainbow|vmax|vstar|\bex\b|\bgx\b|tag team|radieux|radiant|prism/.test(s)) return 4;
    if (/double|holo|brillante|shiny|chroma/.test(s)) return 3;
    if (/rare/.test(s)) return 2;
    return 2;
  }

  // ---------- booster fictif ----------
  // cards : cartes de l'extension avec .rarity ; rnd : générateur 0..1
  // shortcut: taux de tirage estimés (non publiés), même schéma pour toutes les époques
  function drawBooster(cards, rnd = Math.random, isPromo = false) {
    const pick = list => list[Math.floor(rnd() * list.length)];
    const tiers = [0, 1, 2, 3, 4, 5].map(t => cards.filter(c => rarityTier(c.rarity) === t));
    if (isPromo || !tiers[0].length || !tiers[1].length) { // promos, McDo… : quelques cartes au hasard
      const pool = [...cards], out = [];
      const n = Math.min(4, pool.length);
      for (let i = 0; i < n; i++) out.push({ card: pool.splice(Math.floor(rnd() * pool.length), 1)[0], reverse: false });
      return out;
    }
    const out = [];
    for (let i = 0; i < 4; i++) out.push({ card: pick(tiers[0]), reverse: false });
    for (let i = 0; i < 3; i++) out.push({ card: pick(tiers[1]), reverse: false });
    const low = [...tiers[0], ...tiers[1], ...tiers[2]];
    for (let i = 0; i < 2; i++) out.push({ card: pick(low), reverse: true });
    const r = rnd(), want = r < 0.02 ? 5 : r < 0.10 ? 4 : r < 0.30 ? 3 : 2;
    let t = want; while (t > 2 && !tiers[t].length) t--;
    if (!tiers[t].length) t = [2, 3, 4, 5, 1].find(k => tiers[k].length);
    out.push({ card: pick(tiers[t]), reverse: false, hit: t >= 3 });
    return out;
  }

  // ---------- succès ----------
  // s : { qty, unique, value, setsDone, species, dups, boosters, maxCard, scans }
  function achievements(s) {
    const A = (id, name, desc, cur, goal) => ({ id, name, desc, done: cur >= goal, cur: Math.min(cur, goal), goal });
    return [
      A('first', 'Première carte', 'Ajouter ta première carte', s.qty, 1),
      A('c100', 'Centurion', '100 cartes dans la collection', s.qty, 100),
      A('c500', 'Classeur plein', '500 cartes', s.qty, 500),
      A('c1000', 'Mille cartes', '1000 cartes', s.qty, 1000),
      A('set1', 'Extension complète', 'Compléter une extension', s.setsDone, 1),
      A('set5', 'Maître des extensions', 'Compléter 5 extensions', s.setsDone, 5),
      A('kanto', 'Pokédex de Kanto', 'Posséder les 151 premiers Pokémon', s.kanto, 151),
      A('dex500', 'Grand Pokédex', '500 espèces différentes', s.species, 500),
      A('v100', 'Petit trésor', 'Collection à 100 €', Math.floor(s.value), 100),
      A('v1000', 'Coffre-fort', 'Collection à 1 000 €', Math.floor(s.value), 1000),
      A('big', 'Grosse prise', 'Une carte à plus de 100 €', Math.floor(s.maxCard), 100),
      A('dups', 'Roi de l\'échange', '50 doublons', s.dups, 50),
      A('boost10', 'Ouvreur de boosters', 'Noter 10 ouvertures de boosters', s.boosters, 10),
    ];
  }

  const api = { norm, year, total, progress, filterSets, groupSets, parseQuick, localNum, priceChange, setValue, diffColl, rarityTier, drawBooster, achievements };
  if (typeof module !== 'undefined') module.exports = api; else root.LOGIC = api;
})(this);
