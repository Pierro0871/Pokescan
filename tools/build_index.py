# Index complet du scan, calculé par GitHub Actions (workflow index.yml) et publié dans la release « index ».
#   meta.json.gz : toutes les extensions et cartes FR + EN (nom FR, nom EN, numéro, image)
#   emb.bin      : une empreinte d'image par carte (576 octets int8, même ordre que meta.cards)
#   model.tflite : le réseau qui calcule ces empreintes, embarqué dans l'appli pour la caméra
# Usage : python tools/build_index.py --out dist [--base URL] [--limit N] [--no-weights]
import argparse, asyncio, datetime, gzip, io, json, os, pathlib, sys
import numpy as np
import aiohttp
from PIL import Image

SIZE = 224


async def get_json(s, url, tries=4):
    for k in range(tries):
        try:
            async with s.get(url) as r:
                if r.status == 404: return None
                r.raise_for_status()
                return await r.json(content_type=None)
        except Exception as e:
            if k == tries - 1: print('échec', url, e, file=sys.stderr); return None
            await asyncio.sleep(1 + 2 * k)


async def get_bytes(s, url, tries=3):
    for k in range(tries):
        try:
            async with s.get(url) as r:
                if r.status == 404: return None
                r.raise_for_status()
                return await r.read()
        except Exception:
            if k == tries - 1: return None
            await asyncio.sleep(1 + k)


async def gather_limited(n, coros):
    sem = asyncio.Semaphore(n)
    async def run(c):
        async with sem: return await c
    return await asyncio.gather(*(run(c) for c in coros))


async def fetch_lang(s, base, lang, limit):
    brief = await get_json(s, f'{base}/{lang}/sets') or []
    if limit: brief = brief[:limit]
    full = await gather_limited(16, [get_json(s, f'{base}/{lang}/sets/{b["id"]}') for b in brief])
    return [f for f in full if f]


def merge(fr, en):
    """Extensions et cartes FR + EN fusionnées par identifiant (le même dans les deux langues)."""
    sets, cards = {}, {}
    for lang, lst in (('en', en), ('fr', fr)):  # FR en dernier : prioritaire pour les noms d'extension et images
        for st in lst:
            o = sets.setdefault(st['id'], {'id': st['id']})
            o['name_' + lang] = st.get('name', '')
            o['date'] = st.get('releaseDate') or o.get('date', '')
            cc = st.get('cardCount') or {}
            o['official'] = cc.get('official') or o.get('official', 0)
            o['total'] = cc.get('total') or o.get('total', 0)
            ab = (st.get('abbreviation') or {}).get('official')
            if ab: o['abbr'] = ab
            o['serie'] = (st.get('serie') or {}).get('name') or o.get('serie', '')
            for c in st.get('cards') or []:
                k = cards.setdefault(c['id'], {'id': c['id'], 'set': st['id'], 'localId': c.get('localId', '')})
                k['name_' + lang] = c.get('name', '')
                if c.get('image') and (lang == 'fr' or not k.get('image')): k['image'] = c['image']
    order = sorted(sets.values(), key=lambda o: (o.get('date', ''), o['id']))
    pos = {o['id']: i for i, o in enumerate(order)}
    clist = sorted(cards.values(), key=lambda c: (pos[c['set']], c['localId'].zfill(6), c['id']))
    return order, clist, pos


def card_tensor(raw):
    im = Image.open(io.BytesIO(raw)).convert('RGB').resize((SIZE, SIZE), Image.BILINEAR)
    return np.asarray(im, dtype=np.float32)  # 0..255 : le modèle fait lui-même la normalisation


def build_model(weights):
    import tensorflow as tf
    return tf.keras.applications.MobileNetV3Small(input_shape=(SIZE, SIZE, 3), include_top=False, pooling='avg',
                                                  weights='imagenet' if weights else None, include_preprocessing=True)


def to_tflite(model, out):
    import tensorflow as tf
    tmp = out / 'saved'
    model.export(str(tmp), verbose=False)
    c = tf.lite.TFLiteConverter.from_saved_model(str(tmp))
    c.optimizations = [tf.lite.Optimize.DEFAULT]
    c.target_spec.supported_types = [tf.float16]
    (out / 'model.tflite').write_bytes(c.convert())


def quantize(e):
    e = e / np.maximum(np.linalg.norm(e, axis=1, keepdims=True), 1e-6)
    return np.clip(np.round(e * 127), -127, 127).astype(np.int8)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='dist')
    ap.add_argument('--base', default='https://api.tcgdex.net/v2')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--no-weights', action='store_true')
    a = ap.parse_args()
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60), headers={'User-Agent': 'PokeScan-index'}) as s:
        fr, en = await asyncio.gather(fetch_lang(s, a.base, 'fr', a.limit), fetch_lang(s, a.base, 'en', a.limit))
        sets, cards, pos = merge(fr, en)
        print(f'{len(sets)} extensions, {len(cards)} cartes', flush=True)
        model = build_model(not a.no_weights)
        dim = model.output_shape[-1]
        emb = np.zeros((len(cards), dim), np.int8)
        done = 0
        B = 256
        for i in range(0, len(cards), B):
            chunk = cards[i:i + B]
            raws = await gather_limited(32, [get_bytes(s, c['image'] + '/low.webp') if c.get('image') else asyncio.sleep(0) for c in chunk])
            xs, rows = [], []
            for j, r in enumerate(raws):
                if not r: continue
                try: xs.append(card_tensor(r)); rows.append(i + j)
                except Exception: pass
            if xs:
                e = model.predict(np.stack(xs), batch_size=64, verbose=0)
                emb[rows] = quantize(e)
            done += len(rows)
            print(f'{i + len(chunk)}/{len(cards)} cartes, {done} images', flush=True)
    to_tflite(model, out)
    (out / 'emb.bin').write_bytes(emb.tobytes())
    meta = {
        'v': datetime.date.today().isoformat(), 'dim': int(dim), 'size': SIZE,
        # extension : [id, nom FR, nom EN, date, cartes officielles, total, abréviation, série]
        'sets': [[o['id'], o.get('name_fr', ''), o.get('name_en', ''), o.get('date', ''), o.get('official', 0), o.get('total', 0), o.get('abbr', ''), o.get('serie', '')] for o in sets],
        # carte : [id, numéro, n° d'extension, nom FR, nom EN, image (sans /low.webp), a une empreinte]
        'cards': [[c['id'], c['localId'], pos[c['set']], c.get('name_fr', ''), c.get('name_en', ''), c.get('image', ''), 1 if emb[i].any() else 0] for i, c in enumerate(cards)],
    }
    (out / 'meta.json.gz').write_bytes(gzip.compress(json.dumps(meta, ensure_ascii=False, separators=(',', ':')).encode(), 9))
    for f in ('meta.json.gz', 'emb.bin', 'model.tflite'): print(f, round((out / f).stat().st_size / 1e6, 2), 'Mo')
    ok = sum(c[6] for c in meta['cards'])
    assert len(cards) > 0 and (a.limit or ok > 0.8 * len(cards)), f'trop peu d\'images : {ok}/{len(cards)}'


if __name__ == '__main__':
    asyncio.run(main())
