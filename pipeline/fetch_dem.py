"""Build the ground-elevation grid from GSI DEM tiles (dem5a, falling back to dem10b).

GSI zoom-15 DEM pixels are exactly 2x2 analysis-grid pixels at zoom 16, so the
mosaic is upsampled by repetition. Output: CACHE/<landmark>/ground.npy (float32, metres T.P.).

    python pipeline/fetch_dem.py
"""
import io
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

from common import CACHE, GRID_ZOOM, OUT, grid_spec

URL = "https://cyberjapandata.gsi.go.jp/xyz/{layer}/15/{x}/{y}.png"
LAYERS = ["dem5a_png", "dem5b_png", "dem10b_png"]
TILES = CACHE / "dem"


def fetch(layer, x, y):
    path = TILES / layer / f"{x}_{y}.png"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with urllib.request.urlopen(URL.format(layer=layer, x=x, y=y)) as r:
                path.write_bytes(r.read())
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            path.write_bytes(b"")  # remember that the tile does not exist
        time.sleep(0.05)
    data = path.read_bytes()
    if not data:
        return None
    rgb = np.asarray(Image.open(io.BytesIO(data)).convert("RGB")).astype(np.int64)
    v = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
    h = np.where(v < 2 ** 23, v, v - 2 ** 24) * 0.01
    return np.where(v == 2 ** 23, np.nan, h).astype(np.float32)


def main():
    assert GRID_ZOOM == 16
    g = grid_spec()
    tx0, ty0 = g["x0"] // 512, g["y0"] // 512
    tx1, ty1 = (g["x0"] + g["w"] - 1) // 512, (g["y0"] + g["h"] - 1) // 512
    mosaic = np.full(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.nan, np.float32)
    n = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
    for i, (ty, tx) in enumerate((ty, tx) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)):
        tile = np.full((256, 256), np.nan, np.float32)
        for layer in LAYERS:
            t = fetch(layer, tx, ty)
            if t is not None:
                tile = np.where(np.isnan(tile), t, tile)
            if not np.isnan(tile).any():
                break
        mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = tile
        if i % 50 == 0:
            print(f"dem tiles {i}/{n}", flush=True)
    mosaic = np.nan_to_num(mosaic, nan=0.0)  # open water / sea
    up = mosaic.repeat(2, axis=0).repeat(2, axis=1)
    ox, oy = g["x0"] - tx0 * 512, g["y0"] - ty0 * 512
    ground = np.ascontiguousarray(up[oy:oy + g["h"], ox:ox + g["w"]])
    np.save(OUT / "ground.npy", ground)
    print("ground grid", ground.shape, "min", ground.min(), "max", ground.max())


if __name__ == "__main__":
    main()
