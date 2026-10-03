"""Cut the class grid into XYZ PNG tiles and write the metadata the web app reads.

Zoom 16 tiles hold the exact classes (the app reads pixels from them);
zooms 12-15 are overview tiles that keep the best visible class in each 2x2.
Classes the app must tell apart but never draws are encoded in the alpha
channel: 0 = building / outside, 1 = water, 2 = viaduct, 3 = closed to the
public (Imperial Palace), 4 = carriageway, 60 = tip hidden.
Deck tiles (zoom 16) carry the standing height on walkable bridges.

    python pipeline/make_tiles.py
"""
import datetime
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

from common import GRID_ZOOM, LANDMARK, OUT, WEB, bbox_lonlat, grid_spec

MIN_ZOOM = 12
# index = class; 0 = tip hidden, 1..7 = more of the tower visible
PALETTE = ["#6b7280", "#fef08a", "#fde047", "#facc15", "#f59e0b", "#f97316", "#ea580c", "#c2410c"]
EXTRA = {254: (len(PALETTE), 0), 255: (len(PALETTE), 0), 253: (len(PALETTE) + 1, 1), 252: (len(PALETTE) + 2, 2),
         251: (len(PALETTE) + 3, 3), 250: (len(PALETTE) + 4, 4)}
HIDDEN_ALPHA = 60  # keep "tip hidden" faint so the base map stays readable

LUT = np.zeros(256, dtype=np.uint8)
LUT[:len(PALETTE)] = np.arange(len(PALETTE))
for code, (idx, _) in EXTRA.items():
    LUT[code] = idx
ALPHA = bytes([HIDDEN_ALPHA] + [255] * (len(PALETTE) - 1) + [0, 1, 2, 3, 4])
RGB = [int(c[i:i + 2], 16) for c in PALETTE for i in (1, 3, 5)] + [0] * 15


def to_palette_image(block):
    img = Image.fromarray(LUT[block], mode="P")
    img.putpalette(RGB)
    img.info["transparency"] = ALPHA
    return img


def downsample(c):
    h, w = c.shape
    v = np.where(c >= 250, -1, c.astype(np.int16)).reshape(h // 2, 2, w // 2, 2)
    best = v.max(axis=(1, 3))
    outside = (c == 255).reshape(h // 2, 2, w // 2, 2).all(axis=(1, 3))
    return np.where(best >= 0, best, np.where(outside, 255, 254)).astype(np.uint8)


def write_tiles(classes, zoom, x0, y0, out):
    count = 0
    for ty in range(classes.shape[0] // 256):
        for tx in range(classes.shape[1] // 256):
            block = classes[ty * 256:(ty + 1) * 256, tx * 256:(tx + 1) * 256]
            if (block == 255).all():
                continue
            path = out / str(zoom) / str(x0 // 256 + tx) / f"{y0 // 256 + ty}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            to_palette_image(block).save(path, optimize=True)
            count += 1
    return count


def write_deck_tiles(deck, x0, y0, out):
    """Walkable deck height, GSI DEM encoding (0.01 m units in RGB), alpha 0 elsewhere."""
    keys = []
    for ty in range(deck.shape[0] // 256):
        for tx in range(deck.shape[1] // 256):
            block = deck[ty * 256:(ty + 1) * 256, tx * 256:(tx + 1) * 256]
            has = ~np.isnan(block)
            if not has.any():
                continue
            v = np.round(np.nan_to_num(block) * 100).astype(np.int64) & 0xFFFFFF
            rgba = np.stack([(v >> 16) & 255, (v >> 8) & 255, v & 255, np.where(has, 255, 0)], axis=-1).astype(np.uint8)
            x, y = x0 // 256 + tx, y0 // 256 + ty
            path = out / str(GRID_ZOOM) / str(x) / f"{y}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(rgba, mode="RGBA").save(path, optimize=True)
            keys.append(f"{x}/{y}")
    return keys


def main():
    g = grid_spec()
    version = f"{datetime.datetime.now():%Y%m%d%H%M}"
    classes = np.load(OUT / "classes.npy")
    out = WEB / "tiles" / LANDMARK["id"]
    shutil.rmtree(out, ignore_errors=True)

    x0, y0, z = g["x0"], g["y0"], GRID_ZOOM
    while z >= MIN_ZOOM:
        n = write_tiles(classes, z, x0, y0, out)
        print(f"z{z}: {n} tiles", flush=True)
        # pad to a whole number of parent tiles before halving
        px, py = x0 % 512, y0 % 512
        ph = (-(py + classes.shape[0])) % 512
        pw = (-(px + classes.shape[1])) % 512
        classes = np.pad(classes, ((py, ph), (px, pw)), constant_values=255)
        classes = downsample(classes)
        x0, y0, z = (x0 - px) // 2, (y0 - py) // 2, z - 1

    deck_out = WEB / "tiles" / f"{LANDMARK['id']}-deck"
    shutil.rmtree(deck_out, ignore_errors=True)
    deck_keys = write_deck_tiles(np.load(OUT / "deck.npy"), g["x0"], g["y0"], deck_out)
    print(f"deck: {len(deck_keys)} tiles")

    meta = json.loads((OUT / "visibility_meta.json").read_text(encoding="utf-8"))
    files = json.loads((OUT / "files_bldg.json").read_text(encoding="utf-8"))
    meta.update({
        "generated": datetime.date.today().isoformat(),
        # the query string makes browsers drop old tiles after a rebuild
        "tiles": f"tiles/{LANDMARK['id']}/{{z}}/{{x}}/{{y}}.png?v={version}",
        "deck_tiles": f"tiles/{LANDMARK['id']}-deck/{{z}}/{{x}}/{{y}}.png?v={version}",
        "deck_tile_keys": deck_keys,
        "data_zoom": GRID_ZOOM,
        "min_zoom": MIN_ZOOM,
        "bounds": bbox_lonlat(),
        "palette": PALETTE,
        "view_tiles": "tiles/bldg3d",
        "plateau_years": sorted({f"{f['city']}:{f['year']}" for f in files}),
    })
    data = WEB / "data"
    data.mkdir(parents=True, exist_ok=True)
    # the app outlines the areas closed to observers
    shutil.copy(Path(__file__).resolve().parent / "data" / "restricted.geojson", data / "restricted.geojson")
    (data / f"{LANDMARK['id']}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print("meta written")


if __name__ == "__main__":
    main()
