"""Download PLATEAU building CityGML around the landmark and keep only LOD1 prisms.

Each CityGML file is streamed to a temp file, reduced to
(footprint ring, base height, top height) per building, saved as .npz in the
cache, and deleted. Re-runs skip files that are already extracted.

    python pipeline/fetch_buildings.py
"""
import json
import math
import sys
import tempfile
import urllib.request
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from lxml import etree

from common import CACHE, LANDMARK, RADIUS_M, bbox_lonlat

API = "https://api.plateau.reearth.io/datacatalog/citygml/r:{:.5f},{:.5f},{:.5f},{:.5f}"
GML = "{http://www.opengis.net/gml}"
BLDG = "{http://www.opengis.net/citygml/building/2.0}"
OUT = CACHE / "bldg"


def mesh_center(code):
    lat = int(code[0:2]) / 1.5 + int(code[4]) * (5 / 60) + int(code[6]) * (0.5 / 60) + 0.25 / 60
    lon = int(code[2:4]) + 100 + int(code[5]) * (7.5 / 60) + int(code[7]) * (0.75 / 60) + 0.375 / 60
    return lat, lon


def list_files():
    url = API.format(*bbox_lonlat())
    with urllib.request.urlopen(url) as r:
        data = json.load(r)
    files = []
    for city in data["cities"]:
        for f in city["files"].get("bldg", []):
            lat, lon = mesh_center(f["code"])
            dist = math.hypot((lat - LANDMARK["lat"]) * 111000, (lon - LANDMARK["lon"]) * 90500)
            if dist < RADIUS_M + 800:  # mesh half-diagonal ~ 730 m
                files.append({"city": city["cityCode"], "year": city["year"], **f})
    return files


def extract(path):
    """Return (ring_offsets, coords[lat,lon], base, top) for every Building's lod1Solid."""
    offsets, coords, base, top = [0], [], [], []
    for _, bld in etree.iterparse(str(path), tag=BLDG + "Building", huge_tree=True):
        solid = bld.find(BLDG + "lod1Solid")
        if solid is not None:
            rings = [np.array(p.text.split(), dtype=np.float64).reshape(-1, 3)
                     for p in solid.iter(GML + "posList")]
            if rings:
                zmin = min(r[:, 2].mean() for r in rings)
                floor = min(rings, key=lambda r: r[:, 2].mean())
                coords.append(floor[:, :2])
                offsets.append(offsets[-1] + len(floor))
                base.append(zmin)
                top.append(max(r[:, 2].max() for r in rings))
        bld.clear()
        while bld.getprevious() is not None:
            del bld.getparent()[0]
    return (np.array(offsets, dtype=np.int64),
            np.concatenate(coords) if coords else np.zeros((0, 2)),
            np.array(base, dtype=np.float32), np.array(top, dtype=np.float32))


def process(f):
    out = OUT / f"{f['city']}_{f['code']}.npz"
    if out.exists():
        return out, "cached"
    with tempfile.NamedTemporaryFile(suffix=".gml", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        urllib.request.urlretrieve(f["url"], tmp_path)
        offsets, coords, base, top = extract(tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)
    np.savez_compressed(out.with_suffix(".tmp.npz"), offsets=offsets, coords=coords, base=base, top=top)
    out.with_suffix(".tmp.npz").replace(out)
    return out, f"{len(base)} buildings"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    files = list_files()
    total = sum(f["fileSize"] for f in files) / 1e9
    print(f"{len(files)} files, {total:.1f} GB", flush=True)
    (OUT / "files.json").write_text(json.dumps(files, ensure_ascii=False, indent=1), encoding="utf-8")
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    with ProcessPoolExecutor(workers) as ex:
        futs = {ex.submit(process, f): f for f in files}
        for i, fut in enumerate(as_completed(futs), 1):
            f = futs[fut]
            try:
                out, msg = fut.result()
                print(f"[{i}/{len(files)}] {out.name}: {msg}", flush=True)
            except Exception as e:  # keep going; a re-run retries failures
                print(f"[{i}/{len(files)}] FAILED {f['city']} {f['code']}: {e}", flush=True)


if __name__ == "__main__":
    main()
