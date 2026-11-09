#!/usr/bin/env python3
"""Rejilla de color del dibujo, alineada con data/embed-ids.json.

La ventana es la misma que artVector() en scanner/new-scan.js: de la carta
504×704, x 0.08–0.92 y y 0.12–0.50, reducida a 6×8 RGB, centrada y L2, int8.
"""
import io
import json
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IDS_PATH = os.path.join(ROOT, 'data', 'embed-ids.json')
INDEX_PATH = os.path.join(ROOT, 'data', 'index.json')
OUT_PATH = os.path.join(ROOT, 'data', 'art-grid.bin')
MANIFEST_PATH = os.path.join(ROOT, 'data', 'scan-manifest.json')
CACHE = os.environ.get('ART_CACHE', '/tmp/everplay-art')
ART_W, ART_H = 8, 10
ART_DIM = ART_W * ART_H * 3


def art_vector(rgb):
    h, w = rgb.shape[:2]
    x0 = 0.08 * w
    y0 = 0.12 * h
    cw = 0.84 * w
    ch = 0.38 * h
    vals = np.empty(ART_DIM, np.float64)
    p = 0
    for y in range(ART_H):
        sy = y0 + (y + 0.5) * ch / ART_H - 0.5
        ya = min(h - 1, max(0, int(np.floor(sy))))
        yb = min(h - 1, max(0, ya + 1))
        fy = min(1.0, max(0.0, sy - ya))
        for x in range(ART_W):
            sx = x0 + (x + 0.5) * cw / ART_W - 0.5
            xa = min(w - 1, max(0, int(np.floor(sx))))
            xb = min(w - 1, max(0, xa + 1))
            fx = min(1.0, max(0.0, sx - xa))
            for c in range(3):
                v = (rgb[ya, xa, c] * (1 - fx) + rgb[ya, xb, c] * fx) * (1 - fy)
                v += (rgb[yb, xa, c] * (1 - fx) + rgb[yb, xb, c] * fx) * fy
                vals[p] = v
                p += 1
    vals -= vals.mean()
    std = float(vals.std())
    if std < 1e-6:
        std = 1.0
    vals /= std
    norm = float(np.linalg.norm(vals)) or 1.0
    vals /= norm
    return np.clip(np.round(vals * 127), -127, 127).astype(np.int8)


def fetch_one(cid, url):
    dest = os.path.join(CACHE, cid.replace('/', '_') + '.bin')
    if os.path.exists(dest) and os.path.getsize(dest) > 400:
        return cid, dest, None
    last = 'sin url'
    if not url:
        return cid, None, last
    for _ in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'EverPlayDeckTCG-index'})
            with urllib.request.urlopen(req, timeout=30) as res:
                data = res.read()
            if len(data) < 400:
                last = 'corto'
                continue
            os.makedirs(CACHE, exist_ok=True)
            with open(dest, 'wb') as fh:
                fh.write(data)
            return cid, dest, None
        except Exception as err:
            last = str(err)
    return cid, None, last


def main():
    ids = json.load(open(IDS_PATH, encoding='utf-8'))
    catalog = {card['id']: card for card in json.load(open(INDEX_PATH, encoding='utf-8'))}
    os.makedirs(CACHE, exist_ok=True)
    paths = {}
    failed = []
    print(f'descargando {len(ids)}', flush=True)
    with ThreadPoolExecutor(24) as pool:
        futures = [pool.submit(fetch_one, cid, (catalog.get(cid) or {}).get('image') or '') for cid in ids]
        done = 0
        for fut in as_completed(futures):
            cid, dest, err = fut.result()
            done += 1
            if dest:
                paths[cid] = dest
            else:
                failed.append((cid, err))
            if done % 1000 == 0:
                print(f'  {done}/{len(ids)} fallos {len(failed)}', flush=True)
    print(f'descarga lista, fallos {len(failed)}', flush=True)
    grid = np.zeros((len(ids), ART_DIM), np.int8)
    bad = 0
    for i, cid in enumerate(ids):
        dest = paths.get(cid)
        if not dest:
            bad += 1
            continue
        try:
            im = Image.open(dest).convert('RGB').resize((504, 704), Image.Resampling.BILINEAR)
            grid[i] = art_vector(np.asarray(im))
        except Exception:
            bad += 1
        if (i + 1) % 2000 == 0:
            print(f'  rejilla {i + 1}/{len(ids)}', flush=True)
    grid.tofile(OUT_PATH)
    manifest = json.load(open(MANIFEST_PATH, encoding='utf-8'))
    manifest['artGridFile'] = 'data/art-grid.bin'
    manifest['artGridDim'] = ART_DIM
    manifest['artGrid'] = [ART_W, ART_H]
    with open(MANIFEST_PATH, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write('\n')
    # La fila cuantizada, leída como float y normalizada, tiene que encontrarse.
    sample = np.linspace(0, len(ids) - 1, 8, dtype=int)
    misses = []
    for i in sample:
        q = grid[i].astype(np.float32)
        q /= np.linalg.norm(q) or 1
        scores = (grid.astype(np.float32) @ q) / 127
        if int(np.argmax(scores)) != i:
            misses.append(ids[i])
    print(f'bytes {grid.nbytes} vacías {bad} autocomprobación {misses or "ok"}', flush=True)
    if failed[:8]:
        print('primeros fallos', failed[:8], flush=True)


if __name__ == '__main__':
    main()
