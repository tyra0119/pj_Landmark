"""Cut the class grid into XYZ PNG tiles and write the metadata the web app reads.

Zoom 16 tiles hold the exact classes (the app reads pixels from them);
zooms 12-15 are overview tiles that keep the best visible class in each 2x2.

    python pipeline/make_tiles.py
"""
import datetime
import json
import shutil

import numpy as np
from PIL import Image

from common import CACHE, GRID_ZOOM, LANDMARK, WEB, bbox_lonlat, grid_spec

MIN_ZOOM = 12
# index = class; 0 = tip hidden, 1..7 = more of the tower visible
PALETTE = ["#6b7280", "#fef08a", "#fde047", "#facc15", "#f59e0b", "#f97316", "#ea580c", "#c2410c"]
TRANSPARENT = len(PALETTE)
HIDDEN_ALPHA = 60  # keep "tip hidden" faint so the base map stays readable


def to_palette_image(block):
    idx = np.where(block >= 254, TRANSPARENT, block).astype(np.uint8)
    img = Image.fromarray(idx, mode="P")
    pal = []
    for c in PALETTE:
        pal += [int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)]
    pal += [0, 0, 0]
    img.putpalette(pal)
    img.info["transparency"] = bytes([HIDDEN_ALPHA] + [255] * (len(PALETTE) - 1) + [0])
    return img


def downsample(c):
    h, w = c.shape
    v = np.where(c >= 254, -1, c.astype(np.int16)).reshape(h // 2, 2, w // 2, 2)
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


def main():
    g = grid_spec()
    classes = np.load(CACHE / "classes.npy")
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

    meta = json.loads((CACHE / "visibility_meta.json").read_text(encoding="utf-8"))
    files = json.loads((CACHE / "bldg" / "files.json").read_text(encoding="utf-8"))
    meta.update({
        "generated": datetime.date.today().isoformat(),
        # the query string makes browsers drop old tiles after a rebuild
        "tiles": f"tiles/{LANDMARK['id']}/{{z}}/{{x}}/{{y}}.png?v={datetime.datetime.now():%Y%m%d%H%M}",
        "data_zoom": GRID_ZOOM,
        "min_zoom": MIN_ZOOM,
        "bounds": bbox_lonlat(),
        "palette": PALETTE,
        "plateau_years": sorted({f"{f['city']}:{f['year']}" for f in files}),
    })
    data = WEB / "data"
    data.mkdir(parents=True, exist_ok=True)
    (data / f"{LANDMARK['id']}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print("meta written")


if __name__ == "__main__":
    main()
