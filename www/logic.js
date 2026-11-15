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

  // ---------- nom lu en haut de la carte ----------
  // Ressemblance 0..1 entre deux noms (distance d'édition, sans accents ni casse)
  function similar(a, b) {
    a = norm(a).replace(/[^a-z0-9]/g, ''); b = norm(b).replace(/[^a-z0-9]/g, '');
    if (!a || !b) return 0;
    const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return 1 - d[m][n] / Math.max(m, n);
  }
  // Texte OCR du haut de carte -> nom probable (sans "BASE", "PV 30", niveaux…)
  function cleanName(text) {
    return String(text).replace(/\n/g, ' ').replace(/[0-9]+/g, ' ').replace(/\b(BASE|DE BASE|NIVEAU|STAGE|BASIC|PV|HP|TALENT)\b/gi, ' ')
      .replace(/[^A-Za-zÀ-ÿ' -]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Meilleur nom d'une liste pour le texte lu (null si trop différent)
  function bestName(text, names, min = 0.7) {
    const t = cleanName(text);
    if (t.length < 3) return null;
    let best = null, bs = 0;
    for (const n of names) {
      // le texte lu peut contenir des débris autour du nom : on teste aussi des morceaux de la taille du nom
      let s = similar(t, n);
      const words = t.split(' ');
      for (let i = 0; i < words.length; i++) for (let j = i + 1; j <= words.length; j++) s = Math.max(s, similar(words.slice(i, j).join(' '), n));
      if (s > bs) { bs = s; best = n; }
    }
    return bs >= min ? { name: best, score: bs } : null;
  }

  // ---------- quelle extension ? ----------
  // Classe les extensions candidates avec ce qui est lu sur la carte : total (084), année du © et année choisie
  function rankSets(sets, { tot, cardYear, pickYear } = {}) {
    return sets.filter(st => !pickYear || year(st) === String(pickYear)).map(st => {
      let sc = 0; const y = +year(st) || 0;
      if (tot) sc += st.cardCount?.official === tot ? 3 : st.cardCount?.total === tot ? 1 : 0;
      // le © imprimé vaut l'année de sortie, ou l'année d'avant pour les extensions sorties en début d'année
      if (cardYear && y) sc += y === cardYear ? 2 : y === cardYear + 1 ? 1.5 : -Math.min(3, Math.abs(y - cardYear));
      return { st, sc };
    }).sort((a, b) => b.sc - a.sc || (b.st.releaseDate || '').localeCompare(a.st.releaseDate || ''));
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


  // ---------- scan rapide : base complète + texte d'abord ----------
  // meta (release « index ») -> cartes, extensions et tables de recherche par numéro et par nom.
  // tr : nom anglais -> nom français (Pokédex) pour les extensions sans données françaises.
  function buildIndex(meta, tr = n => '') {
    const sets = meta.sets.map(([id, fr, en, date, official, total, abbr, serie]) => ({ id, name: fr || en, nameEn: en, date, year: +String(date).slice(0, 4) || 0, official, total, abbr, serie, enOnly: !fr }));
    const byNum = new Map(), byName = new Map();
    const cards = meta.cards.map(([id, localId, si, fr, en, image, emb], i) => {
      const c = { i, id, localId, set: si, name: fr || tr(en) || en, nameEn: en || fr, image, emb: !!emb };
      const n = localNum(c);
      if (isFinite(n)) (byNum.get(n) || byNum.set(n, []).get(n)).push(i);
      for (const nm of new Set([c.name, c.nameEn])) if (nm) { const k = norm(nm); (byName.get(k) || byName.set(k, []).get(k)).push(i); }
      return c;
    });
    const names = [...byName.keys()], nc = names.map(n => n.replace(/[^a-z0-9]/g, '')), big = new Map();
    nc.forEach((s, id) => { for (const g of new Set(bigrams(s))) (big.get(g) || big.set(g, []).get(g)).push(id); });
    return { v: meta.v, sets, cards, byNum, byName, names, nc, big, cnt: new Uint16Array(names.length) };
  }
  const bigrams = s => { const o = []; for (let i = 0; i < s.length - 1; i++) o.push(s.slice(i, i + 2)); return o; };
  // Noms de la base les plus proches du texte lu (tolère les erreurs de lecture)
  function namesFor(ix, text, min = 0.75) {
    const words = norm(cleanName(text)).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    let best = null, bs = 0;
    const cnt = ix.cnt;
    // morceaux du texte lu (1 à 4 mots) comparés aux noms qui partagent assez de paires de lettres
    for (let i = 0; i < words.length; i++) for (let j = i + 1; j <= Math.min(words.length, i + 4); j++) {
      const w = words.slice(i, j).join(''), m = w.length;
      if (m < 3) continue;
      const touched = [];
      for (const g of new Set(bigrams(w))) for (const id of ix.big.get(g) || []) if (cnt[id]++ === 0) touched.push(id);
      for (const id of touched) {
        const n = ix.nc[id].length, M = Math.max(m, n), k = Math.floor((1 - min) * M + 1e-9);
        if (Math.abs(m - n) <= k && cnt[id] >= Math.min(m, n) - 1 - 2 * k) {
          const s = similar(w, ix.nc[id]);
          if (s > bs || (s === bs && best && n > ix.nc[best].length)) { bs = s; best = id; }
        }
        cnt[id] = 0;
      }
    }
    return best != null && bs >= min ? { name: ix.names[best], score: bs, ids: ix.byName.get(ix.names[best]) || [] } : null;
  }
  // Décision « texte d'abord » : numéro/total + nom + année, l'image départage.
  // r = VISION.readLines(...), img = { ids, sc } (200 plus proches par l'image, peut manquer).
  // -> { list: [{ i, s }], sure, by: [...] }
  function decideText(r, ix, img = {}, opts = {}) {
    const IS = new Map(); (img.ids || []).forEach((id, k) => IS.set(id, img.sc[k]));
    const floor = img.sc?.length ? img.sc[img.sc.length - 1] - 0.02 : 0;
    const imgOf = i => IS.has(i) ? IS.get(i) : floor;
    const okSet = opts.only ? i => ix.cards[i].set === opts.only : () => true;
    const by = [];
    let C = null, N = null, nameScore = 0;
    if (r.num) {
      const raw = (ix.byNum.get(r.num.num) || []).filter(okSet);
      if (r.num.promo) {
        const p = r.num.promo.toUpperCase();
        // SWSH050 (lettres dans le numéro) ou MEP 091 (lettres = sigle de l'extension de promos)
        C = raw.filter(i => {
          const c = ix.cards[i], s = ix.sets[c.set], l = String(c.localId).toUpperCase().replace(/[^A-Z]/g, '');
          return l ? l === p : (s.id.toUpperCase().replace(/[^A-Z]/g, '') === p || (s.abbr || '').toUpperCase() === p);
        });
      } else {
        C = raw.filter(i => { const s = ix.sets[ix.cards[i].set]; return s.official === r.num.tot || s.total === r.num.tot; });
        if (r.num.code) { const k = C.filter(i => (ix.sets[ix.cards[i].set].abbr || '').toUpperCase() === r.num.code); if (k.length) C = k; }
      }
      if (!C.length) C = null;
    }
    for (const t of r.names || []) {
      const m = namesFor(ix, t);
      if (m && m.score > nameScore) { nameScore = m.score; N = m.ids.filter(okSet); }
    }
    if (N && !N.length) N = null;
    let X, sure = false;
    const rank = ids => ids.map(i => ({ i, s: imgOf(i) })).sort((a, b) => b.s - a.s);
    const yearFilter = list => {
      if (!r.year || list.length < 2) return list;
      const k = list.filter(x => { const y = ix.sets[ix.cards[x.i].set].year; return y >= r.year && y <= r.year + 1; });
      if (k.length && k.length < list.length) by.push('année');
      return k.length ? k : list;
    };
    const gap = l => l.length > 1 ? l[0].s - l[1].s : 1;
    if (C && N) {
      const both = C.filter(i => N.includes(i));
      if (both.length) {
        by.push('numéro', 'nom');
        X = yearFilter(rank(both));
        sure = X.length === 1 || gap(X) >= 0.03;
      } else { // désaccord : le numéro (plus fiable) puis le nom
        by.push('numéro');
        X = yearFilter(rank(C)).concat(rank(N).slice(0, 3));
      }
    } else if (C) {
      by.push('numéro');
      X = yearFilter(rank(C));
      const inImg = IS.has(X[0].i) || !img.ids;
      sure = inImg && (X.length === 1 ? true : gap(X) >= 0.05 && IS.has(X[0].i) && img.ids.indexOf(X[0].i) < 20);
    } else if (N) {
      by.push('nom');
      X = yearFilter(rank(N));
      sure = (X.length === 1 && (IS.has(X[0].i) || !img.ids)) || (gap(X) >= 0.05 && img.ids && img.ids.indexOf(X[0].i) < 10);
    } else if (img.ids?.length) {
      by.push('image');
      X = img.ids.slice(0, 5).filter(okSet).map((i, k) => ({ i, s: img.sc[k] }));
      sure = !!X.length && X[0].s >= 0.6 && gap(X) >= 0.08;
    } else return { list: [], sure: false, by };
    const seen = new Set();
    X = X.filter(x => !seen.has(x.i) && seen.add(x.i)).slice(0, 6);
    if (IS.size && X.length && IS.has(X[0].i)) by.push('image');
    return { list: X, sure: sure && X.length > 0, by: [...new Set(by)], nameScore };
  }

  const api = { buildIndex, namesFor, decideText, rankSets, similar, cleanName, bestName, packOdds, deckCheck, kind, isBasicEnergy, encodeIds, decodeIds, trades, norm, year, total, progress, filterSets, groupSets, parseQuick, localNum, priceChange, setValue, diffColl, rarityTier, drawBooster, achievements };
  if (typeof module !== 'undefined') module.exports = api; else root.LOGIC = api;
})(this);
