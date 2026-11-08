#!/usr/bin/env python3
"""Rellena image/imageLarge de las cartas sin arte usando CDNs públicos.

Prueba TCGdex (otro idioma o high.webp), images.pokemontcg.io y, si ahí no
hay carta, images.pokemoncard.io. No descarga el binario: solo comprueba que
la URL responde con una imagen. El índice de embeddings se regenera aparte.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "data" / "index.json"
UA = "EverPlayDeckTCG-index"

# Serie de TCGdex cuando el símbolo del set no la trae.
SERIE = {
    "2022swsh": "mc", "2023sv": "mc", "2024sv": "mc",
    "smp": "sm", "sm7.5": "sm",
    "swsh4.5sv": "swsh", "swsh12.5gg": "swsh", "swsh9tg": "swsh",
    "swsh10tg": "swsh", "swsh11tg": "swsh", "swsh12tg": "swsh",
    "swshp": "swsh", "cel25": "swsh",
    "svp": "sv", "sve": "sv",
    "mep": "me", "mee": "me",
    "B2a": "tcgp", "P-A": "tcgp",
}
# Carpeta real del CDN cuando el id del catálogo lleva un punto.
SET_ALIAS = {
    "sm7.5": ["sm7.5", "sm75"],
    "swsh4.5sv": ["swsh4.5sv", "swsh45sv"],
    "swsh12.5gg": ["swsh12.5gg", "swsh12pt5gg"],
}
# images.pokemontcg.io/{carpeta}/{número}.png
PTCG = {
    "2022swsh": "mcd22",
    "sm7.5": "sm75",
    "swsh4.5sv": "swsh45sv",
    "swsh12.5gg": "swsh12pt5gg",
    "swsh9tg": "swsh9tg",
    "swsh10tg": "swsh10tg",
    "swsh11tg": "swsh11tg",
    "swsh12tg": "swsh12tg",
    "swshp": "swshp",
    "svp": "svp",
    "sve": "sve",
    "smp": "smp",
    "cel25": "cel25",
    "bw2": "bw2",
    "bw3": "bw3",
    "sm9": "sm9",
    "sm10": "sm10",
    "sm11": "sm11",
    "sv02": "sv2",
    "sv10.5b": "zsv10pt5",
    "swsh1": "swsh1",
    "xy6": "xy6",
}
# La Pokémon TCG API no publica estos sets. pokemoncard.io sí tiene el PNG.
POKEMONCARD = {
    "2023sv": "mcd23",
    "2024sv": "mcd24",
    "mee": "mee",
}


def stems(number: str) -> list[str]:
    raw = str(number).strip()
    out = [raw]
    if raw.isdigit():
        out.append(str(int(raw)))
        out.append(raw.zfill(3))
    seen = []
    for item in out:
        if item and item not in seen:
            seen.append(item)
    return seen


def candidates(card: dict) -> list[str]:
    urls: list[str] = []
    number = str(card.get("number") or "")
    set_id = card["setId"]
    current = card.get("image") or ""
    if current:
        urls.append(current)
        for src, dst in (("/low.webp", "/high.webp"), ("/high.webp", "/low.webp"), ("/es/", "/en/"), ("/en/", "/es/")):
            if src in current:
                urls.append(current.replace(src, dst, 1))
    serie = SERIE.get(set_id)
    folders = SET_ALIAS.get(set_id, [set_id])
    if serie:
        for lang in ("es", "en"):
            for folder in folders:
                for stem in stems(number):
                    urls.append(f"https://assets.tcgdex.net/{lang}/{serie}/{folder}/{stem}/low.webp")
                    urls.append(f"https://assets.tcgdex.net/{lang}/{serie}/{folder}/{stem}/high.webp")
    folder = PTCG.get(set_id)
    if folder:
        for stem in stems(number):
            urls.append(f"https://images.pokemontcg.io/{folder}/{stem}.png")
    code = POKEMONCARD.get(set_id)
    if code:
        for stem in stems(number):
            if stem.isdigit():
                urls.append(f"https://images.pokemoncard.io/images/{code}/{code}-{int(stem)}.png")
    seen = []
    for url in urls:
        if url not in seen:
            seen.append(url)
    return seen


def probe(url: str) -> bool:
    for attempt in range(4):
        req = Request(url, method="HEAD", headers={"User-Agent": UA})
        try:
            with urlopen(req, timeout=20) as res:
                kind = (res.headers.get("content-type") or "").lower()
                length = int(res.headers.get("content-length") or "0")
                return res.status == 200 and kind.startswith("image/") and (length == 0 or length > 4000)
        except HTTPError as err:
            if err.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(0.6 * (attempt + 1))
                continue
            return False
        except URLError:
            if attempt < 3:
                time.sleep(0.4 * (attempt + 1))
                continue
            return False
        except Exception:
            return False
    return False


def large_for(url: str) -> str:
    if url.endswith("/low.webp"):
        return url.replace("/low.webp", "/high.webp")
    if url.endswith(".png") and not url.endswith("_hires.png"):
        return url.replace(".png", "_hires.png")
    return url


def recover_one(card: dict) -> tuple[str, str, str, str]:
    for url in candidates(card):
        if not probe(url):
            continue
        large = large_for(url)
        if large != url and not probe(large):
            large = url
        return card["id"], url, large, "ok"
    return card["id"], "", "", "sin-imagen"


def main() -> None:
    cards = json.loads(INDEX.read_text())
    targets = [c for c in cards if not c.get("image")]
    # No revalidamos las 14.000 que ya funcionan. Solo las que sabemos que fallaron.
    known_broken = {
        "A2-038", "A3-162", "bw2-30", "bw3-43", "sm10-197", "sm11-13", "sm11-164",
        "sm9-157", "sv02-141", "sv02-265", "sv10.5b-002", "swsh1-173", "swshp-SWSH150", "xy6-51",
    }
    targets.extend(c for c in cards if c["id"] in known_broken)
    print(f"buscar {len(targets)}", flush=True)
    found: dict[str, tuple[str, str]] = {}
    missing: list[str] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(recover_one, c) for c in targets]
        done = 0
        for fut in as_completed(futures):
            cid, image, large, status = fut.result()
            done += 1
            if status == "ok":
                found[cid] = (image, large)
            else:
                missing.append(cid)
            if done % 200 == 0:
                print(f"comprobadas {done}/{len(targets)} ok {len(found)}", flush=True)
    by_id = {c["id"]: c for c in cards}
    for cid, (image, large) in found.items():
        by_id[cid]["image"] = image
        by_id[cid]["imageLarge"] = large
    INDEX.write_text(json.dumps(cards, ensure_ascii=False, separators=(",", ":")))
    touched_sets = {by_id[cid]["setId"] for cid in found}
    for set_id in touched_sets:
        path = ROOT / "data" / "cards" / f"{set_id}.json"
        if not path.exists():
            continue
        rows = json.loads(path.read_text())
        for row in rows:
            hit = found.get(row["id"])
            if hit:
                row["image"], row["imageLarge"] = hit
        path.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))
    still = [by_id[cid] for cid in missing]
    print(f"recuperadas {len(found)} siguen sin imagen {len(still)}", flush=True)
    from collections import Counter
    print("por set sin imagen", Counter(c["setId"] for c in still))
    hosts = Counter()
    for image, _large in found.values():
        host = image.split("/")[2]
        hosts[host] += 1
    print("por host", dict(hosts))
    for c in still:
        print("falta", c["id"], c["name"], c["setId"], c["number"])


if __name__ == "__main__":
    main()
