// node test/logic.test.js
const assert = require('assert');
const L = require('../www/logic.js');

const sets = [
  { id: 'base1', name: 'Set de Base', serie: 'base', serieName: 'Base', releaseDate: '1999-01-09', cardCount: { official: 102 } },
  { id: 'sv01', name: 'Écarlate et Violet', serie: 'sv', serieName: 'Écarlate et Violet', releaseDate: '2023-03-31', cardCount: { official: 198 } },
  { id: 'sv10', name: 'Rivalités Destinées', serie: 'sv', serieName: 'Écarlate et Violet', releaseDate: '2025-05-30', cardCount: { official: 182 } },
  { id: 'mcd23', name: 'McDonald\'s 2023', serie: 'misc', serieName: 'Divers', releaseDate: '2023-08-01', cardCount: { official: 15 } },
];
const owned = { sv01: 198, sv10: 10, mcd23: 0 };
assert.deepStrictEqual(L.filterSets(sets, { q: 'ecarlate' }, owned, []).map(s => s.id), ['sv01', 'sv10']); // accents + série
assert.deepStrictEqual(L.filterSets(sets, { state: 'done' }, owned, []).map(s => s.id), ['sv01']);
assert.deepStrictEqual(L.filterSets(sets, { state: 'started' }, owned, []).map(s => s.id), ['sv10']);
assert.deepStrictEqual(L.filterSets(sets, { year: '2023' }, owned, []).map(s => s.id), ['sv01', 'mcd23']);
assert.deepStrictEqual(L.filterSets(sets, { q: 'mcdo' }, owned, []).map(s => s.id), ['mcd23']);
assert.deepStrictEqual(L.filterSets(sets, { q: 'mcdonald' }, owned, []).map(s => s.id), ['mcd23']);
const g = L.groupSets(sets, 'new', owned);
assert.deepStrictEqual(g.map(x => x.title), ['2025', '2023', '1999']);
assert.deepStrictEqual(g[1].sets.map(s => s.id), ['mcd23', 'sv01']);
assert.deepStrictEqual(L.groupSets(sets, 'prog', owned)[0].sets.map(s => s.id).slice(0, 2), ['sv01', 'sv10']);
assert.deepStrictEqual(L.groupSets(sets, 'serie', owned).map(x => x.title), ['Base', 'Écarlate et Violet', 'Divers']);

assert.deepStrictEqual(L.parseQuick('045/198'), { q: '', num: 45, tot: 198 });
assert.deepStrictEqual(L.parseQuick('Nuit Noire 45'), { q: 'nuit noire', num: 45, tot: null });
assert.deepStrictEqual(L.parseQuick('ecarlate 12 / 198'), { q: 'ecarlate', num: 12, tot: 198 });
assert.deepStrictEqual(L.parseQuick('Dracaufeu'), null);
assert.strictEqual(L.localNum({ localId: 'TG05' }), 5);

assert.strictEqual(L.priceChange({ trend: 12, avg7: 10 }), 0.2);
assert.strictEqual(L.priceChange({ trend: 12 }), null);
const v = L.setValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }], new Set(['a']), { a: { trend: 2 }, b: { trend: 5 } });
assert.deepStrictEqual(v, { have: 2, all: 7, missing: 5, known: 2, count: 3 });

assert.deepStrictEqual(L.diffColl([{ cardId: 'a', qty: 1 }, { cardId: 'b', qty: 2 }], [{ cardId: 'a', qty: 2 }, { cardId: 'c', qty: 1 }]),
  [{ cardId: 'a', d: 1 }, { cardId: 'b', d: -2 }, { cardId: 'c', d: 1 }]);

const T = r => L.rarityTier(r);
assert.deepStrictEqual(['Commune', 'Peu Commune', 'Rare', 'Rare Holo', 'Double rare', 'Ultra Rare', 'Illustration rare', 'Illustration spéciale rare', 'Hyper rare', 'Aucune'].map(T),
  [0, 1, 2, 3, 3, 4, 4, 5, 5, -1]);

// booster : 10 cartes, 4 communes, 3 peu communes, 2 reverse, 1 rare ou mieux ; promo : 4 au hasard
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const cards = [...Array(60)].map((_, i) => ({ id: 'x' + i, rarity: ['Commune', 'Peu Commune', 'Rare', 'Double rare', 'Ultra Rare', 'Hyper rare'][i % 6] }));
let hits = 0;
for (let k = 0; k < 500; k++) {
  const b = L.drawBooster(cards, rnd);
  assert.strictEqual(b.length, 10);
  assert.strictEqual(b.filter(x => x.reverse).length, 2);
  assert(L.rarityTier(b[9].card.rarity) >= 2);
  if (b[9].hit) hits++;
}
assert(hits > 100 && hits < 200, 'taux de cartes rares improbable : ' + hits);
assert.strictEqual(L.drawBooster(cards.slice(0, 3).map(c => ({ ...c, rarity: 'Aucune' })), rnd).length, 3);

const ach = L.achievements({ qty: 150, unique: 120, value: 99.9, setsDone: 1, species: 80, kanto: 40, dups: 3, boosters: 0, maxCard: 12 });
assert.deepStrictEqual(ach.filter(a => a.done).map(a => a.id), ['first', 'c100', 'set1']);
console.log('OK');

// ---------- v6 ----------
{
  const mk = (name, category, n, extra = {}) => ({ id: name + n, name, category, n, ...extra });
  const ok = [mk('Pikachu', 'Pokémon', 4, { stage: 'De base' }), mk('Raichu', 'Pokémon', 4, { stage: 'Niveau 1' }), mk('Recherches Professorales', 'Dresseur', 4),
    mk('Énergie Électrique de base', 'Énergie', 48, { energyType: 'Normal' })];
  const r = L.deckCheck(ok);
  assert(r.ok, JSON.stringify(r.errors)); assert.deepStrictEqual(r.counts, { pokemon: 8, trainer: 4, energy: 48 });
  const bad = L.deckCheck([mk('Pikachu', 'Pokémon', 5, { stage: 'De base', legal: { standard: false, expanded: true } }), mk('Pikachu', 'Pokémon', 1, { stage: 'De base' })]);
  assert(!bad.ok && bad.errors.some(e => e.includes('6/60')) && bad.errors.some(e => e.includes('6 × « Pikachu »')) && bad.errors.some(e => e.includes('Standard')));
  assert(L.deckCheck(bad ? [mk('Pikachu', 'Pokémon', 4, { stage: 'De base', legal: { standard: false, expanded: true } })] : [], 'expanded').illegal.length === 0);

  const ids = ['sv01-001', 'sv01-002', 'sv01-003', 'sv01-010', 'sv01-TG05', 'base1-1', 'base1-2', 'base1-4', 'swsh12.5-GG01', 'perso-123'];
  const enc = L.encodeIds(ids);
  assert.strictEqual(enc, 'sv01:001-003,010,TG05;base1:1-2,4;swsh12.5:GG01');
  assert.deepStrictEqual(L.decodeIds(enc).sort(), ids.filter(i => !i.startsWith('perso')).sort());
  const t = L.trades({ owned: new Set(['a', 'b', 'c']), dups: ['b'] }, { owned: new Set(['c', 'd', 'e']), dups: ['c', 'd'] });
  assert.deepStrictEqual(t, { theyCanGive: ['d'], iCanGive: ['b'] });
  console.log('OK v6 logique');
}

// probabilité de tirage : le calcul colle à la simulation de drawBooster
{
  let sd = 3; const rnd2 = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const set = [...Array(100)].map((_, i) => ({ id: 'y' + i, rarity: i < 50 ? 'Commune' : i < 80 ? 'Peu Commune' : i < 90 ? 'Rare' : i < 96 ? 'Double rare' : i < 99 ? 'Ultra Rare' : 'Hyper rare' }));
  const N = 60000, hit = {};
  for (let k = 0; k < N; k++) for (const id of new Set(L.drawBooster(set, rnd2).map(x => x.card.id))) hit[id] = (hit[id] || 0) + 1;
  for (const id of ['y0', 'y60', 'y85', 'y92', 'y97', 'y99']) {
    const o = L.packOdds(set, id), sim = (hit[id] || 0) / N;
    assert(Math.abs(o.any - sim) < Math.max(0.004, sim * 0.15), `${id} calcul ${o.any} vs simulation ${sim}`);
  }
  const o = L.packOdds(set, 'y99');
  assert(o.packs50 > 30 && o.packs90 > o.packs50);
  assert.strictEqual(L.packOdds(set.slice(0, 2).map(c => ({ ...c, rarity: 'Aucune' })), 'y0', true).any, 1);
  console.log('OK probabilités');
}
