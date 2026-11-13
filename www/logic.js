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

  // Probabilité d'obtenir une carte dans un booster (même modèle que drawBooster)
  // -> { normal, reverse, any, tier, packs50, packs90 } ; null si la carte n'est pas dans la liste
  function packOdds(cards, id, isPromo = false) {
    const c = cards.find(x => x.id === id);
    if (!c) return null;
    const tiers = [0, 1, 2, 3, 4, 5].map(t => cards.filter(x => rarityTier(x.rarity) === t).length);
    const t = rarityTier(c.rarity);
    let normal = 0, reverse = 0;
    if (isPromo || !tiers[0] || !tiers[1]) normal = Math.min(4, cards.length) / cards.length;
    else {
      if (t === 0) normal = 1 - Math.pow(1 - 1 / tiers[0], 4);
      else if (t === 1) normal = 1 - Math.pow(1 - 1 / tiers[1], 3);
      else if (t >= 2) {
        // tirage de la case rare, avec repli vers le niveau inférieur si vide
        const slot = [0, 0, 0, 0, 0, 0];
        for (const [want, w] of [[5, 0.02], [4, 0.08], [3, 0.20], [2, 0.70]]) {
          let k = want; while (k > 2 && !tiers[k]) k--;
          if (!tiers[k]) k = [2, 3, 4, 5, 1].find(x => tiers[x]);
          slot[k] += w;
        }
        normal = slot[t] / tiers[t];
      }
      const low = tiers[0] + tiers[1] + tiers[2];
      if (t >= 0 && t <= 2) reverse = 1 - Math.pow(1 - 1 / low, 2);
    }
    const any = 1 - (1 - normal) * (1 - reverse);
    const packs = q => any > 0 ? Math.ceil(Math.log(1 - q) / Math.log(1 - Math.min(any, 0.999999))) : Infinity;
    return { normal, reverse, any, tier: t, packs50: packs(0.5), packs90: packs(0.9) };
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

  // ---------- decks ----------
  const BASIC_ENERGY = /^(energie|energy) (plante|feu|eau|electrique|psy|combat|obscurite|metal|fee|grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy)( de base)?$|^basic .* energy$/;
  const isEnergy = c => /energ/.test(norm(c.category));
  const isBasicEnergy = c => isEnergy(c) && (norm(c.energyType) === 'normal' || BASIC_ENERGY.test(norm(c.name)));
  const kind = c => isEnergy(c) ? 'energy' : /pokemon/.test(norm(c.category)) ? 'pokemon' : 'trainer';
  // cards : [{ id, name, category, energyType, stage, legal, n }] ; format : 'standard' | 'expanded'
  function deckCheck(cards, format = 'standard') {
    const counts = { pokemon: 0, trainer: 0, energy: 0 }, byName = {}, errors = [];
    let total = 0;
    for (const c of cards) {
      total += c.n; counts[kind(c)] += c.n;
      if (!isBasicEnergy(c)) byName[norm(c.name)] = (byName[norm(c.name)] || 0) + c.n;
    }
    if (total !== 60) errors.push(`${total}/60 cartes`);
    for (const [n, k] of Object.entries(byName)) if (k > 4) errors.push(`${k} × « ${cards.find(c => norm(c.name) === n).name} » (4 maximum)`);
    const illegal = cards.filter(c => c.legal && c.legal[format] === false);
    if (illegal.length) errors.push(`${illegal.length} carte(s) non autorisée(s) en ${format === 'standard' ? 'Standard' : 'Étendu'}`);
    const basics = cards.filter(c => kind(c) === 'pokemon' && /base|basic/.test(norm(c.stage)));
    if (cards.some(c => c.stage) && !basics.length) errors.push('aucun Pokémon de base');
    return { total, counts, errors, illegal: illegal.map(c => c.id), ok: !errors.length };
  }

  // ---------- échange par QR : listes d'IDs compactes ----------
  // "sv01-001,sv01-002,sv01-003,sv01-TG05" -> "sv01:001-003,TG05" (plages sur les numéros de même largeur)
  function encodeIds(ids) {
    const by = {};
    for (const id of ids) { const i = id.lastIndexOf('-'); if (i > 0 && !id.startsWith('perso-')) (by[id.slice(0, i)] ||= []).push(id.slice(i + 1)); }
    return Object.entries(by).map(([set, locs]) => {
      const num = locs.filter(l => /^\d+$/.test(l)).sort((a, b) => a - b || a.length - b.length), other = locs.filter(l => !/^\d+$/.test(l)), out = [];
      for (let i = 0; i < num.length;) {
        let j = i;
        while (j + 1 < num.length && +num[j + 1] === +num[j] + 1 && num[j + 1].length === num[i].length) j++;
        out.push(j > i ? `${num[i]}-${num[j]}` : num[i]); i = j + 1;
      }
      return set + ':' + [...out, ...other].join(',');
    }).join(';');
  }
  function decodeIds(str) {
    const ids = [];
    for (const part of String(str).split(';')) {
      const k = part.lastIndexOf(':'); if (k < 1) continue;
      const set = part.slice(0, k);
      for (const tok of part.slice(k + 1).split(',')) {
        const m = tok.match(/^(\d+)-(\d+)$/);
        if (m) for (let n = +m[1]; n <= +m[2] && n - +m[1] < 1000; n++) ids.push(set + '-' + String(n).padStart(m[1].length, '0'));
        else if (tok) ids.push(set + '-' + tok);
      }
    }
    return ids;
  }
  // Ce que chacun peut donner à l'autre : doublons de l'un absents chez l'autre
  function trades(me, friend) {
    const give = friend.dups.filter(id => !me.owned.has(id)), get = me.dups.filter(id => !friend.owned.has(id));
    return { theyCanGive: give, iCanGive: get };
  }

  const api = { packOdds, deckCheck, kind, isBasicEnergy, encodeIds, decodeIds, trades, norm, year, total, progress, filterSets, groupSets, parseQuick, localNum, priceChange, setValue, diffColl, rarityTier, drawBooster, achievements };
  if (typeof module !== 'undefined') module.exports = api; else root.LOGIC = api;
})(this);
