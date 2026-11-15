// node test/scan.test.js : scan rapide (texte d'abord) sur une petite base
const assert = require('assert');
const L = require('../www/logic.js'), V = require('../www/vision.js');
const meta = { v: 't', sets: [
  ['ex6', '', 'Power Keepers', '2007-02-02', 108, 108, '', 'EX'],
  ['xy12', 'Évolutions', 'Evolutions', '2016-11-02', 108, 113, 'EVO', 'XY'],
  ['bw5', 'Explorateurs Obscurs', 'Dark Explorers', '2012-05-09', 108, 111, 'DEX', 'NB'],
  ['swshp', 'Promos SWSH', 'SWSH Promos', '2019-11-15', 0, 300, '', 'EB'],
  ['sv03.5', '151', '151', '2023-09-22', 165, 207, 'MEW', 'EV'],
  ['mep', 'Promos Méga-Évolution', 'MEP Black Star Promos', '2025-09-26', 0, 120, '', 'ME'],
], cards: [
  ['ex6-18', '18', 0, '', 'Mightyena', 'img/a', 1],
  ['xy12-18', '18', 1, 'Rhinocorne', 'Rhyhorn', 'img/b', 1],
  ['bw5-18', '18', 2, 'Grahyèna', 'Mightyena', 'img/c', 1],
  ['bw5-30', '30', 2, 'Sorboul', 'Vanillite', 'img/d', 1],
  ['swshp-SWSH050', 'SWSH050', 3, 'Pikachu V', 'Pikachu V', 'img/e', 1],
  ['sv03.5-025', '025', 4, 'Pikachu', 'Pikachu', 'img/f', 1],
  ['sv03.5-173', '173', 4, 'Pikachu', 'Pikachu', 'img/g', 1],
  ['mep-091', '091', 5, 'Méga-Dracolosse-ex', 'Mega Dragonite ex', 'img/h', 1],
] };
const tr = en => ({ Mightyena: 'Grahyèna' })[en] || '';
const ix = L.buildIndex(meta, tr);
const id = d => d.list.map(x => ix.cards[x.i].id);
assert.strictEqual(ix.cards[0].name, 'Grahyèna'); // extension sans données FR : nom traduit
// numéro + nom : la seule carte qui a les deux
let d = L.decideText({ names: ['Grahyena'], num: { num: 18, tot: 108 } }, ix);
assert.deepStrictEqual(id(d).sort(), ['bw5-18', 'ex6-18']); assert.ok(!d.sure); // deux Grahyèna 18/108 : il faut départager
d = L.decideText({ names: ['Grahyena'], num: { num: 18, tot: 108 }, year: 2007 }, ix);
assert.deepStrictEqual(id(d), ['ex6-18']); assert.ok(d.sure); assert.ok(d.by.includes('année'));
d = L.decideText({ names: ['Grahyena'], num: { num: 18, tot: 108 } }, ix, { ids: [2, 0, 1], sc: [0.82, 0.70, 0.5] });
assert.deepStrictEqual(id(d)[0], 'bw5-18'); assert.ok(d.sure); // l'image départage
// erreur de lecture du nom tolérée
d = L.decideText({ names: ['Rhinocome'], num: { num: 18, tot: 108 } }, ix);
assert.deepStrictEqual(id(d), ['xy12-18']); assert.ok(d.sure);
// nom anglais lu
d = L.decideText({ names: ['Vanillite'], num: null }, ix);
assert.deepStrictEqual(id(d), ['bw5-30']); assert.ok(d.sure);
// promo
d = L.decideText({ names: ['Pikachu V'], num: { num: 50, promo: 'SWSH' } }, ix);
assert.deepStrictEqual(id(d), ['swshp-SWSH050']); assert.ok(d.sure);
d = L.decideText({ names: ['Méga-Dracolosse ex'], num: { num: 91, promo: 'MEP' } }, ix);
assert.deepStrictEqual(id(d), ['mep-091']); assert.ok(d.sure);
// numéro sans nom, total au-delà des cartes officielles (secrète) : total de l'extension
d = L.decideText({ names: [], num: { num: 173, tot: 165 } }, ix);
assert.deepStrictEqual(id(d), ['sv03.5-173']); assert.ok(d.sure);
// rien de lisible : l'image seule, sûre seulement avec un net écart
d = L.decideText({ names: [], num: null }, ix, { ids: [3, 1], sc: [0.9, 0.6] });
assert.deepStrictEqual(id(d)[0], 'bw5-30'); assert.ok(d.sure);
d = L.decideText({ names: [], num: null }, ix, { ids: [3, 1], sc: [0.7, 0.66] });
assert.ok(!d.sure);
// limité à une extension choisie
d = L.decideText({ names: ['Pikachu'], num: null }, ix, {}, { only: 4 });
assert.deepStrictEqual(id(d).sort(), ['sv03.5-025', 'sv03.5-173']);
// lignes natives -> lecture
const r = V.readLines([{ t: 'DRESSEUR', x: .05, y: .02, w: .2, h: .03 }, { t: 'Pikachu V', x: .1, y: .05, w: .3, h: .05 }, { t: 'PV190', x: .7, y: .05, w: .2, h: .04 }, { t: 'SWSH050', x: .05, y: .94, w: .15, h: .02 }]);
assert.deepStrictEqual(r.names, ['Pikachu V']); assert.deepStrictEqual(r.num, { num: 50, promo: 'SWSH' });
// cartes à plat : texte de la photo ramené dans chaque carte (même retournée)
const q = [{ x: .1, y: .1 }, { x: .4, y: .1 }, { x: .4, y: .5 }, { x: .1, y: .5 }];
const at = (t, u0, v0, u1, v1) => ({ t, q: [.1 + u0 * .3, .1 + v0 * .4, .1 + u1 * .3, .1 + v0 * .4, .1 + u1 * .3, .1 + v1 * .4, .1 + u0 * .3, .1 + v1 * .4] });
let lc = V.linesInCard([at('Pikachu', .1, .03, .5, .08), at('025/165', .05, .94, .2, .97), at('Autre carte', .1, 1.3, .5, 1.4)], q);
assert.deepStrictEqual(lc.read.names, ['Pikachu']); assert.deepStrictEqual(lc.read.num, { num: 25, tot: 165 }); assert.strictEqual(lc.lines.length, 2);
lc = V.linesInCard([at('Pikachu', .5, .92, .9, .97), at('025/165', .8, .03, .95, .06)], q); // carte posée à l'envers
assert.ok(lc.flipped); assert.deepStrictEqual(lc.read.num, { num: 25, tot: 165 }); assert.deepStrictEqual(lc.read.names, ['Pikachu']);
const [u, v] = V.quadMap([{ x: 10, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 10 }])(10, 10);
assert.ok(Math.abs(u - .5) < 1e-9 && Math.abs(v - .5) < 1e-9);
// grille de la collection
const cc = [
  { name: 'Pikachu', value: 2, qty: 1, first: 1, last: 5, setDate: '2023-09-22', setName: '151', num: 25, dex: 25, tier: 0, type: 'Électrique' },
  { name: 'Dracaufeu', value: 300, qty: 2, first: 3, last: 3, setDate: '1999-01-09', setName: 'Set de Base', num: 4, dex: 6, tier: 3, type: 'Feu' },
  { name: 'Professeur', value: null, qty: 3, first: 2, last: 9, setDate: '2023-09-22', setName: '151', num: 166, dex: null, tier: 1, type: '' },
];
const order = (s) => L.sortColl(cc, s).flatMap(g => g.cards.map(c => c.name)).join(',');
assert.strictEqual(order('recent'), 'Professeur,Pikachu,Dracaufeu');
assert.strictEqual(order('value'), 'Dracaufeu,Pikachu,Professeur');
assert.strictEqual(order('cheap'), 'Pikachu,Dracaufeu,Professeur');
assert.strictEqual(order('set'), 'Dracaufeu,Pikachu,Professeur');
assert.deepStrictEqual(L.sortColl(cc, 'set').map(g => g.title), ['Set de Base', '151']);
assert.strictEqual(order('dex'), 'Dracaufeu,Pikachu,Professeur');
assert.strictEqual(order('rarity'), 'Dracaufeu,Professeur,Pikachu');
assert.strictEqual(order('qty'), 'Professeur,Dracaufeu,Pikachu');
assert.strictEqual(L.sortColl(cc, 'type').at(-1).title, 'Dresseurs, énergies et autres');
console.log('OK scan rapide');
