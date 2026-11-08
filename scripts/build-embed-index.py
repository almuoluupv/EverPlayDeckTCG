#!/usr/bin/env python3
"""Genera el índice int8 y el ONNX de 128 dimensiones a partir del arte de TCGdex.

No se ejecuta en el móvil. Lee data/index.json, descarga la imagen low de cada
carta que la tenga, y escribe:

  models/card-embed.onnx
  data/embed-int8.bin
  data/embed-ids.json
  data/phash-canon.json
  data/scan-manifest.json
"""
from __future__ import annotations

import io
import json
import math
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "data" / "index.json"
SRC_MODEL = Path("/tmp/models/mobilenetv3.onnx")
FEAT = "/flatten/Flatten_output_0"
OUT_MODEL = ROOT / "models" / "card-embed.onnx"
DIM = 128
POOL = 1024
CANON = (504, 704)  # ancho, alto


def build_model() -> onnx.ModelProto:
    model = onnx.load(str(SRC_MODEL))
    rng = np.random.default_rng(20261108)
    weight = rng.standard_normal((POOL, DIM)).astype(np.float32)
    weight /= np.linalg.norm(weight, axis=0, keepdims=True) + 1e-8
    model.graph.initializer.append(numpy_helper.from_array(weight, "card_proj"))
    model.graph.node.append(helper.make_node("Gemm", [FEAT, "card_proj"], ["embedding"], alpha=1.0, beta=0.0))
    while len(model.graph.output):
        model.graph.output.pop()
    model.graph.output.append(helper.make_tensor_value_info("embedding", TensorProto.FLOAT, [1, DIM]))
    onnx.checker.check_model(model)
    return model


def imagenet(im: Image.Image) -> np.ndarray:
    card = im.convert("RGB").resize(CANON, Image.Resampling.BILINEAR)
    left, top = int(CANON[0] * 0.06), int(CANON[1] * 0.06)
    right, bottom = int(CANON[0] * 0.94), int(CANON[1] * 0.94)
    crop = card.crop((left, top, right, bottom)).resize((224, 224), Image.Resampling.BILINEAR)
    arr = np.asarray(crop).astype(np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406], np.float32)
    std = np.array([0.229, 0.224, 0.225], np.float32)
    arr = (arr - mean) / std
    return np.transpose(arr, (2, 0, 1))[None]


def dct1d(sig: np.ndarray) -> np.ndarray:
    n = sig.shape[0]
    out = np.zeros(n, np.float64)
    for k in range(n):
        s = 0.0
        for i, v in enumerate(sig):
            s += float(v) * math.cos(math.pi * k * (2 * i + 1) / (2 * n))
        out[k] = s
    return out


def phash_rgb(im: Image.Image) -> str:
    card = im.convert("RGB").resize(CANON, Image.Resampling.BILINEAR)
    small = np.asarray(card.resize((32, 32), Image.Resampling.BILINEAR)).astype(np.float64)
    gray = 0.299 * small[:, :, 0] + 0.587 * small[:, :, 1] + 0.114 * small[:, :, 2]
    tmp = np.stack([dct1d(gray[r]) for r in range(32)])
    dct = np.stack([dct1d(tmp[:, c]) for c in range(32)], axis=1)
    block = dct[:8, :8].reshape(-1)
    nodc = np.sort(block[1:])
    mid = len(nodc) // 2
    median = (nodc[mid - 1] + nodc[mid]) / 2 if len(nodc) % 2 == 0 else nodc[mid]
    bits = 0
    for i, v in enumerate(block):
        if v > median:
            bits |= 1 << (63 - i)
    return f"{bits:016x}"


def fetch(card: dict, attempts: int = 1) -> tuple[str, bytes | None, str]:
    url = card.get("image") or ""
    if not url:
        return card["id"], None, "sin url"
    last = "error"
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "EverPlayDeckTCG-index"})
            with urllib.request.urlopen(req, timeout=25) as res:
                return card["id"], res.read(), ""
        except urllib.error.HTTPError as err:
            last = f"http {err.code}"
            if err.code in (404, 410):
                break
        except Exception as err:
            last = type(err).__name__
        if attempt + 1 < attempts:
            time.sleep(0.4 * (attempt + 1))
    return card["id"], None, last


def embed_one(sess, raw: bytes):
    im = Image.open(io.BytesIO(raw))
    im.load()
    tensor = imagenet(im)
    emb = sess.run(["embedding"], {"pixel_values": tensor})[0].reshape(-1).astype(np.float32)
    emb /= float(np.linalg.norm(emb)) + 1e-8
    return emb, phash_rgb(im)


def write_outputs(cards, with_art, ids, vecs, phashes, failed, quant=None) -> None:
    if quant is None:
        mat = np.stack(vecs).astype(np.float32)
        quant = np.clip(np.round(mat * 127), -127, 127).astype(np.int8)
    (ROOT / "data" / "embed-int8.bin").write_bytes(quant.tobytes())
    (ROOT / "data" / "embed-ids.json").write_text(json.dumps(ids, ensure_ascii=False))
    (ROOT / "data" / "phash-canon.json").write_text(json.dumps(phashes, ensure_ascii=False, separators=(",", ":")))
    manifest = {
        "modelVersion": "mobilenetv3-small-pool1024-proj128-20261108",
        "dim": DIM,
        "count": len(ids),
        "input": [224, 224],
        "canonical": [504, 704],
        "source": "catalog image",
        "cardsInCatalog": len(cards),
        "cardsWithoutImage": len(cards) - len(with_art),
        "cardsSkipped": failed,
        "modelFile": "models/card-embed.onnx",
        "indexFile": "data/embed-int8.bin",
        "idsFile": "data/embed-ids.json",
        "phashFile": "data/phash-canon.json",
    }
    (ROOT / "data" / "scan-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    q = quant.astype(np.float32)
    misses = 0
    rng = np.random.default_rng(1)
    sample = rng.choice(len(ids), size=min(8, len(ids)), replace=False)
    for i in sample:
        dots = q @ q[i]
        top = int(np.argmax(dots))
        if top != i:
            misses += 1
        print("self", ids[i], "rank", int(np.where(np.argsort(-dots) == i)[0][0]), "score", round(float(dots[i] / (127 * 127)), 3))
    print("manifest", manifest)
    if misses:
        raise SystemExit(f"el índice no se recupera a sí mismo: {misses}")


def fill_missing() -> None:
    import onnxruntime as ort

    cards = json.loads(INDEX.read_text())
    with_art = [c for c in cards if c.get("image")]
    ids = json.loads((ROOT / "data" / "embed-ids.json").read_text())
    phashes = json.loads((ROOT / "data" / "phash-canon.json").read_text())
    blob_bytes = (ROOT / "data" / "embed-int8.bin").read_bytes()
    raw = np.frombuffer(blob_bytes, dtype=np.int8).copy()
    if raw.size != len(ids) * DIM:
        raise SystemExit("índice incompleto")
    quant_old = raw.reshape(len(ids), DIM)
    have = set(ids)
    missing = [c for c in with_art if c["id"] not in have]
    print(f"faltan {len(missing)} de {len(with_art)}", flush=True)
    if not missing:
        return
    sess = ort.InferenceSession(str(OUT_MODEL), providers=["CPUExecutionProvider"])
    new_rows: list[np.ndarray] = []
    added = 0
    reasons: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(fetch, c, 3) for c in missing]
        done = 0
        for fut in as_completed(futures):
            cid, blob, reason = fut.result()
            done += 1
            if not blob:
                reasons[reason] = reasons.get(reason, 0) + 1
                continue
            try:
                emb, ph = embed_one(sess, blob)
            except Exception:
                reasons["imagen"] = reasons.get("imagen", 0) + 1
                continue
            ids.append(cid)
            new_rows.append(emb)
            phashes[cid] = ph
            added += 1
            if done % 200 == 0:
                print(f"reintento {done}/{len(missing)} nuevas {added}", flush=True)
    print(f"añadidas {added} motivos {reasons}", flush=True)
    if not added:
        print("sin cambios", reasons)
        return
    new_q = np.clip(np.round(np.stack(new_rows) * 127), -127, 127).astype(np.int8)
    quant = np.vstack([quant_old, new_q])
    failed = len(with_art) - len(ids)
    write_outputs(cards, with_art, ids, [], phashes, failed, quant=quant)


def main() -> None:
    if "--fill" in sys.argv:
        fill_missing()
        return
    import onnxruntime as ort

    cards = json.loads(INDEX.read_text())
    with_art = [c for c in cards if c.get("image")]
    print(f"cartas {len(cards)} con arte {len(with_art)}", flush=True)
    model = build_model()
    OUT_MODEL.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(OUT_MODEL))
    sess = ort.InferenceSession(str(OUT_MODEL), providers=["CPUExecutionProvider"])

    blobs: dict[str, bytes] = {}
    with ThreadPoolExecutor(max_workers=24) as pool:
        futures = [pool.submit(fetch, c) for c in with_art]
        done = 0
        for fut in as_completed(futures):
            cid, data, _reason = fut.result()
            done += 1
            if data:
                blobs[cid] = data
            if done % 1000 == 0:
                print(f"descargadas {done}/{len(with_art)} ok {len(blobs)}", flush=True)
    print(f"descarga lista {len(blobs)}", flush=True)

    ids: list[str] = []
    vecs: list[np.ndarray] = []
    phashes: dict[str, str] = {}
    failed = 0
    for card in with_art:
        raw = blobs.get(card["id"])
        if not raw:
            failed += 1
            continue
        try:
            im = Image.open(io.BytesIO(raw))
            im.load()
        except Exception:
            failed += 1
            continue
        tensor = imagenet(im)
        emb = sess.run(["embedding"], {"pixel_values": tensor})[0].reshape(-1).astype(np.float32)
        norm = float(np.linalg.norm(emb)) + 1e-8
        emb /= norm
        ids.append(card["id"])
        vecs.append(emb)
        phashes[card["id"]] = phash_rgb(im)
        if len(ids) % 1000 == 0:
            print(f"embebid as {len(ids)}", flush=True)

    mat = np.stack(vecs).astype(np.float32)
    quant = np.clip(np.round(mat * 127), -127, 127).astype(np.int8)
    (ROOT / "data" / "embed-int8.bin").write_bytes(quant.tobytes())
    (ROOT / "data" / "embed-ids.json").write_text(json.dumps(ids, ensure_ascii=False))
    (ROOT / "data" / "phash-canon.json").write_text(json.dumps(phashes, ensure_ascii=False, separators=(",", ":")))
    manifest = {
        "modelVersion": "mobilenetv3-small-pool1024-proj128-20261108",
        "dim": DIM,
        "count": len(ids),
        "input": [224, 224],
        "canonical": [504, 704],
        "source": "catalog image",
        "cardsInCatalog": len(cards),
        "cardsWithoutImage": len(cards) - len(with_art),
        "cardsSkipped": failed,
        "modelFile": "models/card-embed.onnx",
        "indexFile": "data/embed-int8.bin",
        "idsFile": "data/embed-ids.json",
        "phashFile": "data/phash-canon.json",
    }
    (ROOT / "data" / "scan-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    # La propia ilustración debe quedar primera.
    q = quant.astype(np.float32)
    misses = 0
    rng = np.random.default_rng(1)
    sample = rng.choice(len(ids), size=min(8, len(ids)), replace=False)
    for i in sample:
        dots = q @ q[i]
        top = int(np.argmax(dots))
        if top != i:
            misses += 1
        print("self", ids[i], "rank", int(np.where(np.argsort(-dots) == i)[0][0]), "score", round(float(dots[i] / (127 * 127)), 3))
    print("manifest", manifest)
    if misses:
        raise SystemExit(f"el índice no se recupera a sí mismo: {misses}")


if __name__ == "__main__":
    main()
