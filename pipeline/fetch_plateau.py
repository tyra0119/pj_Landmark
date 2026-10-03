"""Download PLATEAU CityGML around the landmark and keep only what the analysis needs.

    python pipeline/fetch_plateau.py [bldg] [brid] [wtr] [--workers N]

- bldg: LOD1 prism per building -> footprint ring, base and top height
- brid: per bridge -> function code, LOD1 footprint/top, LOD2 deck (OuterFloorSurface) rings
- wtr:  water surface polygons (exterior and interior rings)

Each CityGML file is streamed to a temp file, reduced to a .npz in the cache,
and deleted. Re-runs skip files that are already extracted.
"""
import argparse
import json
import math
import tempfile
import urllib.request
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from lxml import etree

from common import CACHE, LANDMARK, OUT, RADIUS_M, bbox_lonlat

API = "https://api.plateau.reearth.io/datacatalog/citygml/r:{:.5f},{:.5f},{:.5f},{:.5f}"
GML = "{http://www.opengis.net/gml}"
BLDG = "{http://www.opengis.net/citygml/building/2.0}"
BRID = "{http://www.opengis.net/citygml/bridge/2.0}"
WTR = "{http://www.opengis.net/citygml/waterbody/2.0}"


def mesh_center(code):
    """Centre of a 2nd (6-digit) or 3rd (8-digit) order regional mesh."""
    lat = int(code[0:2]) / 1.5 + int(code[4]) * (5 / 60)
    lon = int(code[2:4]) + 100 + int(code[5]) * (7.5 / 60)
    if len(code) == 8:
        return lat + int(code[6]) * (0.5 / 60) + 0.25 / 60, lon + int(code[7]) * (0.75 / 60) + 0.375 / 60, 730
    return lat + 2.5 / 60, lon + 3.75 / 60, 7300


def list_files(kind):
    url = API.format(*bbox_lonlat())
    with urllib.request.urlopen(url) as r:
        data = json.load(r)
    files = []
    for city in data["cities"]:
        for f in city["files"].get(kind, []):
            lat, lon, half_diag = mesh_center(f["code"])
            dist = math.hypot((lat - LANDMARK["lat"]) * 111000, (lon - LANDMARK["lon"]) * 90500)
            if dist < RADIUS_M + half_diag:
                files.append({"city": city["cityCode"], "year": city["year"], **f})
    return files


def rings_of(el):
    return [np.array(p.text.split(), dtype=np.float64).reshape(-1, 3) for p in el.iter(GML + "posList")]


def iter_features(path, tag):
    for _, el in etree.iterparse(str(path), tag=tag, huge_tree=True):
        yield el
        el.clear()
        while el.getprevious() is not None:
            del el.getparent()[0]


def lod1_prism(el, ns):
    solid = el.find(ns + "lod1Solid")
    rings = rings_of(solid) if solid is not None else []
    if not rings:
        return None
    floor = min(rings, key=lambda r: r[:, 2].mean())
    return floor[:, :2], min(r[:, 2].mean() for r in rings), max(r[:, 2].max() for r in rings)


def extract_bldg(path):
    offsets, coords, base, top = [0], [], [], []
    for bld in iter_features(path, BLDG + "Building"):
        prism = lod1_prism(bld, BLDG)
        if prism:
            coords.append(prism[0])
            offsets.append(offsets[-1] + len(prism[0]))
            base.append(prism[1])
            top.append(prism[2])
    return dict(offsets=np.array(offsets, dtype=np.int64),
                coords=np.concatenate(coords) if coords else np.zeros((0, 2)),
                base=np.array(base, dtype=np.float32), top=np.array(top, dtype=np.float32))


def extract_brid(path):
    """Footprints (LOD1) and decks (LOD2+ OuterFloorSurface) of every bridge."""
    func, fp_off, fp, top = [], [0], [], []
    deck_owner, deck_off, deck, deck_z = [], [0], [], []
    for i, br in enumerate(iter_features(path, BRID + "Bridge")):
        f = br.find(BRID + "function")
        func.append(int(f.text) if f is not None and f.text.strip().isdigit() else 99)
        prism = lod1_prism(br, BRID)
        if prism is None:
            rings = rings_of(br)
            prism = (min(rings, key=lambda r: r[:, 2].mean())[:, :2], 0, max(r[:, 2].max() for r in rings)) if rings else (np.zeros((0, 2)), 0, 0)
        fp.append(prism[0])
        fp_off.append(fp_off[-1] + len(prism[0]))
        top.append(prism[2])
        for surf in br.iter(BRID + "OuterFloorSurface"):
            for ring in rings_of(surf):
                deck_owner.append(i)
                deck.append(ring[:, :2])
                deck_off.append(deck_off[-1] + len(ring))
                deck_z.append(ring[:, 2].max())
    cat = lambda a: np.concatenate(a) if a else np.zeros((0, 2))
    return dict(function=np.array(func, dtype=np.int16), fp_offsets=np.array(fp_off, dtype=np.int64),
                fp_coords=cat(fp), top=np.array(top, dtype=np.float32),
                deck_owner=np.array(deck_owner, dtype=np.int32), deck_offsets=np.array(deck_off, dtype=np.int64),
                deck_coords=cat(deck), deck_z=np.array(deck_z, dtype=np.float32))


def extract_wtr(path):
    """Water surface rings; interior rings (islands) are flagged so they can be cut out."""
    offsets, coords, interior = [0], [], []
    for wb in iter_features(path, WTR + "WaterBody"):
        for ring_el in wb.iter(GML + "exterior", GML + "interior"):
            for ring in rings_of(ring_el):
                coords.append(ring[:, :2])
                offsets.append(offsets[-1] + len(ring))
                interior.append(ring_el.tag == GML + "interior")
    return dict(offsets=np.array(offsets, dtype=np.int64),
                coords=np.concatenate(coords) if coords else np.zeros((0, 2)),
                interior=np.array(interior, dtype=bool))


EXTRACT = {"bldg": extract_bldg, "brid": extract_brid, "wtr": extract_wtr}


def process(kind, f):
    out = CACHE / kind / f"{f['city']}_{f['code']}.npz"
    if out.exists():
        return out, "cached"
    with tempfile.NamedTemporaryFile(suffix=".gml", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        urllib.request.urlretrieve(f["url"], tmp_path)
        arrays = EXTRACT[kind](tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)
    tmp_out = out.with_suffix(".tmp.npz")
    np.savez_compressed(tmp_out, **arrays)
    tmp_out.replace(out)
    return out, "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kinds", nargs="*", default=list(EXTRACT))
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    for kind in args.kinds:
        (CACHE / kind).mkdir(parents=True, exist_ok=True)
        files = list_files(kind)
        print(f"{kind}: {len(files)} files, {sum(f.get('fileSize', 0) for f in files) / 1e9:.2f} GB", flush=True)
        (OUT / f"files_{kind}.json").write_text(json.dumps(files, ensure_ascii=False, indent=1), encoding="utf-8")
        with ProcessPoolExecutor(args.workers) as ex:
            futs = {ex.submit(process, kind, f): f for f in files}
            for i, fut in enumerate(as_completed(futs), 1):
                f = futs[fut]
                try:
                    out, msg = fut.result()
                    print(f"[{kind} {i}/{len(files)}] {out.name}: {msg}", flush=True)
                except Exception as e:  # keep going; a re-run retries failures
                    print(f"[{kind} {i}/{len(files)}] FAILED {f['city']} {f['code']}: {e}", flush=True)


if __name__ == "__main__":
    main()
