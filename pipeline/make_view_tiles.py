"""Write compact building / bridge-deck tiles for the first-person view.

The view draws the same PLATEAU data the visibility analysis used. One JSON
file per zoom-15 tile (by footprint centroid):

    {"b": [[base_dm, height_dm, x0, y0, x1, y1, ...], ...],   # buildings
     "d": [[deck_dm, x0, y0, ...], ...]}                       # walkable/other bridge decks

x/y are offsets from the tile's north-west corner in 1e-6 degrees
(east / south positive); heights are absolute (T.P.) in decimetres.

    python pipeline/make_view_tiles.py
"""
import json
import math
import shutil
from collections import defaultdict

import numpy as np

from common import CACHE, WEB

ZOOM = 15


def tile_of(lat, lon):
    n = 1 << ZOOM
    x = int((lon + 180) / 360 * n)
    lat_r = math.radians(lat)
    y = int((1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n)
    return x, y


def tile_nw(x, y):
    n = 1 << ZOOM
    lon = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lat, lon


def encode(ring, nw):
    if np.allclose(ring[0], ring[-1]):
        ring = ring[:-1]
    xs = np.rint((ring[:, 1] - nw[1]) * 1e6).astype(int)
    ys = np.rint((nw[0] - ring[:, 0]) * 1e6).astype(int)
    return np.column_stack([xs, ys]).ravel().tolist()


def main():
    tiles = defaultdict(lambda: {"b": [], "d": []})
    nws = {}
    seen = set()

    def put(kind, ring, head):
        lat, lon = ring[:, 0].mean(), ring[:, 1].mean()
        key = tile_of(lat, lon)
        if key not in nws:
            nws[key] = tile_nw(*key)
        tiles[key][kind].append(head + encode(ring, nws[key]))

    n_b = 0
    for f in sorted((CACHE / "bldg").glob("*.npz")):
        d = np.load(f)
        off, coords, base, top = d["offsets"], d["coords"], d["base"], d["top"]
        for i in range(len(top)):
            ring = coords[off[i]:off[i + 1]]
            key = (round(float(ring[0, 0]), 7), round(float(ring[0, 1]), 7), round(float(top[i]), 1))
            if len(ring) < 3 or key in seen or top[i] - base[i] > 300:
                continue
            seen.add(key)
            put("b", ring, [int(round(base[i] * 10)), int(round((top[i] - base[i]) * 10))])
            n_b += 1
    n_d = 0
    for f in sorted((CACHE / "brid").glob("*.npz")):
        d = np.load(f)
        off, coords, z = d["deck_offsets"], d["deck_coords"], d["deck_z"]
        for k in range(len(z)):
            ring = coords[off[k]:off[k + 1]]
            if len(ring) >= 3:
                put("d", ring, [int(round(z[k] * 10))])
                n_d += 1

    out = WEB / "tiles" / "bldg3d"   # shared by all landmarks
    shutil.rmtree(out, ignore_errors=True)
    size = 0
    for (x, y), t in tiles.items():
        path = out / str(ZOOM) / str(x) / f"{y}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(t, separators=(",", ":"))
        path.write_text(text, encoding="utf-8")
        size += len(text)
    keys = sorted(f"{x}/{y}" for x, y in tiles)
    (out / "index.json").write_text(json.dumps({"zoom": ZOOM, "tiles": keys}), encoding="utf-8")
    print(f"{n_b} buildings, {n_d} deck polygons, {len(tiles)} tiles, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
